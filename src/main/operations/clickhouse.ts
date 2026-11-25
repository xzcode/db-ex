import type { ClickHouseClient } from '@clickhouse/client'
import type { ClickHouseSettings } from '@clickhouse/client'
import {randomUUID} from 'node:crypto'
import type { ClickHouseOperation,OperationResult,ExplorerNode,SqlRow } from '../../shared/types'
import { metric,metrics } from '../../shared/object-inspection'
import {boundedText,checkAborted,MAX_BYTES,MAX_VALUE_BYTES,page,plainObject,requireWrite,resourceName,sqlRow,type OperationContext} from './common'
import {clickHouseIdentifier,clickHouseParameters,inspectClickHouseSql} from './clickhouse-policy'
import {clickHouseManagementQuery} from './clickhouse-management'

const READ_SETTINGS:ClickHouseSettings={
 readonly:'1',max_execution_time:20,max_result_rows:String(501),max_result_bytes:String(MAX_BYTES),result_overflow_mode:'throw',
 max_rows_to_read:String(10000000),max_bytes_to_read:String(512*1024*1024),max_memory_usage:String(256*1024*1024),
 cancel_http_readonly_queries_on_client_close:1,output_format_json_quote_64bit_integers:1,output_format_json_quote_decimals:1,
 output_format_json_validate_utf8:1,output_format_json_quote_denormals:1,wait_end_of_query:1
}
const WRITE_SETTINGS:ClickHouseSettings={readonly:'0',max_execution_time:20,max_memory_usage:String(256*1024*1024),async_insert:0,wait_end_of_query:1}
function objectRow(columns:string[],values:(string|null)[]):Record<string,string>{
 const row:Record<string,string>=Object.create(null)
 columns.forEach((c,i)=>row[c]=values[i]===null?'NULL':values[i]!)
 return row
}
/** Split a JSON array into its original JSON tokens after syntax validation.
 * This preserves integer/decimal lexemes (including nested ones), and does
 * not confuse the literal string 'NULL' with an actual nullable cell. */
function exactCells(line:string): (string|null)[]{
 const parsed:unknown=JSON.parse(line)
 if(!Array.isArray(parsed))throw new Error('DATABASE_ERROR: ClickHouse result format')
 if(!parsed.length)return []
 const value=line.trim(),tokens:string[]=[]
 let start=1,depth=0,quoted=false
 for(let i=1;i<value.length-1;i++){
  const c=value[i]!
  if(quoted){if(c.charCodeAt(0)===92)i++;else if(c==='"')quoted=false;continue}
  if(c==='"'){quoted=true;continue}
  if(c==='['||c==='{')depth++
  else if(c===']'||c==='}')depth--
  else if(c===','&&depth===0){tokens.push(value.slice(start,i).trim());start=i+1}
 }
 tokens.push(value.slice(start,-1).trim())
 if(tokens.length!==parsed.length)throw new Error('DATABASE_ERROR: ClickHouse result format')
 return tokens.map(token=>token==='null'?null:token.startsWith('"')?JSON.parse(token) as string:token)
}
export function decodeClickHouseLines(text:string,limit:number,queryId:string):OperationResult{
 const lines=text.trimEnd().split('\n')
 if(lines.length<2)throw new Error('DATABASE_ERROR: ClickHouse result metadata unavailable')
 const names:unknown=JSON.parse(lines[0]!),types:unknown=JSON.parse(lines[1]!)
 if(!Array.isArray(names)||!Array.isArray(types)||names.length!==types.length||names.length>500||names.some(n=>typeof n!=='string'||!n.length||n.length>200)||types.some(t=>typeof t!=='string'||t.length>4096)||new Set(names).size!==names.length)throw new Error('INVALID_INPUT: ClickHouse result metadata')
 const columns=names as string[],columnTypes=types as string[],rows:Record<string,string>[]=[],nullCells:number[][]=[],rawRows:SqlRow[]=[]
 let truncated=false
 for(const line of lines.slice(2)){
  if(!line.trim())continue
  const values=exactCells(line)
  if(values.length!==columns.length)throw new Error('DATABASE_ERROR: ClickHouse result format')
  if(rows.length>=limit){truncated=true;break}
  const row=values as (string|null)[]
  if(row.some(v=>v!==null&&Buffer.byteLength(v)>MAX_VALUE_BYTES))throw new Error('LIMIT_EXCEEDED: ClickHouse cell exceeds 512 KiB')
  rows.push(objectRow(columns,row));nullCells.push(row.flatMap((v,i)=>v===null?[i]:[]))
  rawRows.push(Object.fromEntries(columns.map((c,i)=>[c,row[i]!])))
 }
 return {columns,columnTypes,rows,rawRows,nullCells,truncated,queryId}
}
export class ClickHouseOperations{
 private runningId?:string
 constructor(private readonly client:ClickHouseClient,private readonly clientForDatabase:(database:string)=>ClickHouseClient){}
 private async select(sql:string,parameters:Record<string,unknown>,context:OperationContext,limit=500,database?:string):Promise<OperationResult>{
  checkAborted(context.signal)
  const queryId=randomUUID(),start=Date.now()
  this.runningId=queryId
  const client=database?this.clientForDatabase(database):this.client
  try{
   const result=await client.exec({query:sql+'\nFORMAT JSONCompactEachRowWithNamesAndTypes',query_params:parameters,query_id:queryId,abort_signal:context.signal,clickhouse_settings:READ_SETTINGS})
   const parts:Buffer[]=[];let size=0
   for await(const chunk of result.stream){
    checkAborted(context.signal)
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)
    size+=bytes.length
    if(size>MAX_BYTES){result.stream.destroy();throw new Error('LIMIT_EXCEEDED: ClickHouse result exceeds 2 MiB')}
    parts.push(bytes)
   }
   const decoded=decodeClickHouseLines(Buffer.concat(parts).toString('utf8'),limit,queryId)
   // Server overflow can stop the result before the client sees an extra row.
   // Never assert a complete export merely from the row count.
   if(decoded.rows.length>=limit&&limit===500&&!/ LIMIT \d+ OFFSET \d+$/.test(sql))decoded.truncated=true
   return {...decoded,durationMs:Date.now()-start}
  }finally{this.runningId=undefined;if(database)await client.close().catch(()=>{})}
 }
 async version(context:OperationContext){return (await this.select('SELECT version() AS version',{},context,1)).rows[0]?.version}
 async roots(context:OperationContext):Promise<ExplorerNode[]>{
  const result=await this.select('SELECT name FROM system.databases ORDER BY name LIMIT 500',{},context)
  return result.rows.map(row=>({id:JSON.stringify(['database',row.name]),kind:'database',label:row.name!,database:row.name}))
 }
 async children(database:string,context:OperationContext,statistics=false):Promise<ExplorerNode[]>{
  const result=await this.select('SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} ORDER BY name LIMIT 500',{db:resourceName(database)},context)
  return result.rows.map(row=>{
   const engine=row.engine||'',kind=engine==='Dictionary'?'clickhouse-dictionary':engine==='MaterializedView'?'view':engine==='View'||engine==='LiveView'||engine==='WindowView'?'view':'table'
   return {id:JSON.stringify(['ch-object',database,row.name]),kind,label:row.name!,database,entity:row.name,readOnly:kind!=='table'||database==='system',metrics:statistics?metrics(metric('存储引擎',engine),metric('记录数（估算）',row.total_rows==='NULL'?undefined:row.total_rows,'estimate'),metric('数据大小',row.total_bytes==='NULL'?undefined:row.total_bytes,'bytes')):undefined}
  })
 }
 private async structure(database:string,entity:string,context:OperationContext){
  return this.select('SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE database={db:String} AND table={table:String} ORDER BY position LIMIT 500',{db:database,table:entity},context)
 }
 async execute(op:ClickHouseOperation,context:OperationContext):Promise<OperationResult>{
  if(op.action==='clickhouse.query'){
   const query=inspectClickHouseSql(op.sql),params=clickHouseParameters(op.parameters)
   const db=op.database?resourceName(op.database,'数据库'):undefined
   if(query.mode==='write'){
    requireWrite(context)
    if(db==='system'||db==='information_schema'||db==='INFORMATION_SCHEMA')throw new Error('INVALID_OPERATION: ClickHouse system database')
    const client=db?this.clientForDatabase(db):this.client
    try{const id=randomUUID();await client.command({query:query.sql,query_params:params,query_id:id,abort_signal:context.signal,clickhouse_settings:WRITE_SETTINGS});return {columns:[],rows:[],queryId:id,message:'操作已完成'}}
    finally{if(db)await client.close().catch(()=>{})}
   }
   // Query editor displays a bounded result. It does not rewrite arbitrary SQL
   // or pretend that the first 500 rows represent the complete result set.
   return this.select(query.sql,params,context,page(op).limit,db)
  }
  const database=resourceName(op.database,'数据库'),entity=resourceName(op.entity,'表')
  const qualified=clickHouseIdentifier(database)+'.'+clickHouseIdentifier(entity)
  if(op.action==='clickhouse.management'){
   const query=clickHouseManagementQuery(op.view,op)
   const result=await this.select(query.sql,{db:database,table:entity},context,query.limit)
   if(query.view!=='queries'&&result.truncated&&query.offset+query.limit<=1000000)result.nextOffset=query.offset+query.limit
   return result
  }
  if(op.action==='clickhouse.structure')return this.structure(database,entity,context)
  if(op.action==='clickhouse.inspect'){
   const result=await this.select('SELECT engine, total_rows, total_bytes, sorting_key, partition_key, primary_key, create_table_query FROM system.tables WHERE database={db:String} AND name={table:String} LIMIT 1',{db:database,table:entity},context,1)
   const row=result.rows[0]
   if(!row)throw new Error('INVALID_INPUT: ClickHouse object not found')
   return {columns:[],rows:[],inspection:{kind:row.engine?.includes('View')?'view':'table',metrics:metrics(metric('存储引擎',row.engine),metric('记录数（估算）',row.total_rows==='NULL'?undefined:row.total_rows,'estimate'),metric('数据大小',row.total_bytes==='NULL'?undefined:row.total_bytes,'bytes'),metric('排序键',row.sorting_key),metric('分区键',row.partition_key),metric('主键',row.primary_key)),definition:row.create_table_query}}
  }
  if(op.action==='clickhouse.browse'){
   const {limit,offset}=page(op),params:Record<string,unknown>={}
   let where='',sort=''
   if(op.sort!==undefined&&(!Array.isArray(op.sort)||op.sort.length>32))throw new Error('INVALID_INPUT: ClickHouse sort')
   if(op.filter||op.sort?.length){
    const structure=await this.structure(database,entity,context),fields=new Set(structure.rows.map(r=>r.name))
    if(op.filter){
     const filter=plainObject(op.filter,'ClickHouse filter')
     if(typeof filter.field!=='string'||!fields.has(filter.field))throw new Error('INVALID_INPUT: ClickHouse filter field')
     params.value=boundedText(filter.value,'ClickHouse filter',65536)
     where=' WHERE toString('+clickHouseIdentifier(filter.field)+') = {value:String}'
    }
    if(op.sort){
     if(!Array.isArray(op.sort)||op.sort.length>32||op.sort.some(v=>!v||!fields.has(v.field)||v.direction!==1&&v.direction!==-1))throw new Error('INVALID_INPUT: ClickHouse sort')
     if(op.sort.length)sort=' ORDER BY '+op.sort.map(v=>clickHouseIdentifier(v.field)+(v.direction===1?' ASC':' DESC')).join(', ')
    }
   }
   const result=await this.select('SELECT * FROM '+qualified+where+sort+' LIMIT '+(limit+1)+' OFFSET '+offset,params,context,limit)
   if(result.truncated&&offset+limit<=1000000)result.nextOffset=offset+limit
   return result
  }
  if(op.action==='clickhouse.insert'){
   requireWrite(context)
   if(['system','information_schema','INFORMATION_SCHEMA'].includes(database)||!Array.isArray(op.rows)||!op.rows.length||op.rows.length>500)throw new Error('INVALID_INPUT: ClickHouse insert')
   const metadata=await this.select('SELECT engine FROM system.tables WHERE database={db:String} AND name={table:String} LIMIT 1',{db:database,table:entity},context,1)
   // No writes into Distributed, external, materialized or dictionary engines.
   if(!/^(?:Replacing|Summing|Aggregating|Collapsing|VersionedCollapsing|Replicated|ReplicatedReplacing|ReplicatedSumming|ReplicatedAggregating|ReplicatedCollapsing|ReplicatedVersionedCollapsing)?MergeTree$/.test(metadata.rows[0]?.engine||''))throw new Error('INVALID_OPERATION: ClickHouse insert supports MergeTree tables')
   const structure=await this.structure(database,entity,context),allowed=new Set(structure.rows.filter(r=>!['MATERIALIZED','ALIAS','EPHEMERAL'].includes(r.default_kind||'')).map(r=>r.name))
   const rows=op.rows.map(v=>sqlRow(v,'ClickHouse'))
   if(rows.some(row=>!Object.keys(row).length||Object.keys(row).some(key=>!allowed.has(key)))||Buffer.byteLength(JSON.stringify(rows))>MAX_BYTES)throw new Error('INVALID_INPUT: ClickHouse insert')
   // The first batch accepts exact scalar values (large numbers as strings).
   // Do not promise complex-type JSON imports before testing those formats.
   const id=randomUUID()
   const result=await this.client.insert({table:qualified,values:rows,format:'JSONEachRow',query_id:id,abort_signal:context.signal,clickhouse_settings:{...WRITE_SETTINGS,input_format_skip_unknown_fields:0,input_format_defaults_for_omitted_fields:1}})
   if(!result.executed)throw new Error('DATABASE_ERROR: ClickHouse insert not executed')
   return {columns:[],rows:[],queryId:id,affectedRows:rows.length,message:'操作已完成'}
  }
  throw new Error('INVALID_OPERATION: 不支持的操作')
 }
}
