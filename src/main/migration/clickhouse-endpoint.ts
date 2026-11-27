import {randomUUID} from 'node:crypto'
import {addAbortSignal,Readable} from 'node:stream'
import type {ClickHouseClient,ClickHouseSettings} from '@clickhouse/client'
import type {ConnectionConfig} from '../../shared/types'
import type {MigrationCatalog,MigrationMode,MigrationStep,MigrationCopyOptions} from '../../shared/migration'
import {migrationName} from '../../shared/migration'
import {validateConnection} from '../connections/validation'
import {createTransport,type ConnectionTransport} from '../connections/transport'
import {loadConnectionTls} from '../connections/tls-material'
import {openClickHouseClients} from '../connections/clickhouse-client'
import {sqlFileValue} from '../file-transfer/records'
import {byteBudget} from '../operations/clickhouse-transfer'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import {checkedSnapshot,limitObjectNames,requireActive,reviewStep,type MigrationEndpoint,type CopyCallbacks} from './endpoint'

const quote=(name:string)=>{migrationName(name);if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))throw new Error('MIGRATION_UNSUPPORTED: 当前对象需要人工迁移');return '`'+name+'`'}
const qualified=(db:string,name:string)=>quote(db)+'.'+quote(name)
type ChColumn={name:string;type:string}
type ChShape={safe:boolean;columns:ChColumn[];sorting:string[];partition:string[];primary:string[];settings:string}
const shape=(o:SchemaObject|undefined)=>o?.details as ChShape|undefined
const equal=(a:ChShape,b:ChShape)=>JSON.stringify(a)===JSON.stringify(b)
function simpleType(value:string){
 const base='(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|Bool|String|FixedString\\([1-9][0-9]{0,6}\\)|Date|Date32|DateTime(?:\\(\'UTC\'\\))?|DateTime64\\([0-9](?:, \'UTC\')?\\)|Decimal\\([0-9]{1,2}, ?[0-9]{1,2}\\)|UUID|IPv4|IPv6)'
 return new RegExp('^(?:'+base+'|Nullable\\('+base+'\\))$').test(value)
}
function simpleKeys(expression:string,columns:ChColumn[]){
 if(!expression||expression==='tuple()')return []
 const keys=expression.split(',').map(s=>s.trim().replace(/^`([A-Za-z_][A-Za-z_0-9]*)`$/,'$1'))
 return keys.every(n=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(n)&&columns.some(c=>c.name===n))?keys:undefined
}
function keySql(keys:string[]){return keys.length?'('+keys.map(quote).join(', ')+')':'tuple()'}
function createSql(db:string,name:string,x:ChShape){
 return 'CREATE TABLE '+qualified(db,name)+' ('+x.columns.map(c=>quote(c.name)+' '+c.type).join(', ')+') ENGINE = MergeTree'+(x.partition.length?' PARTITION BY '+keySql(x.partition):'')+(x.primary.length&&JSON.stringify(x.primary)!==JSON.stringify(x.sorting)?' PRIMARY KEY '+keySql(x.primary):'')+' ORDER BY '+keySql(x.sorting)+(x.settings?' SETTINGS '+x.settings:'')
}
export function planClickHouseMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode,targetDb:string):MigrationStep[]{
 const a=new Map(source.objects.map(o=>[o.name,o])),b=new Map(target.objects.map(o=>[o.name,o]))
 return [...new Set([...a.keys(),...b.keys()])].sort().map((name,i)=>{
  const step=reviewStep(name,i),s=a.get(name),d=b.get(name),x=shape(s),y=shape(d)
  if(!s)return {...step,action:'target-only',changes:['TARGET ONLY OBJECT']}
  if(!x?.safe||d&&!y?.safe)return {...step,changes:['SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW']}
  if(!d)return mode==='data'?{...step,changes:['MISSING TARGET OBJECT']}:{...step,action:'create',changes:['MISSING TARGET OBJECT'],sql:[createSql(targetDb,name,x)],executable:true,transfer:mode==='structure-data'}
  if(!y)return step
  if(mode!=='schema'&&equal(x,y))return {...step,action:'copy',changes:['APPEND DATA — NONTRANSACTIONAL'],executable:true,transfer:true}
  if(mode==='data')return {...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
  if(equal(x,y))return {...step,action:'same'}
  const appended=x.columns.slice(y.columns.length),samePrefix=y.columns.every((c,i)=>JSON.stringify(c)===JSON.stringify(x.columns[i]))
  if(!samePrefix||JSON.stringify({...x,columns:[]})!==JSON.stringify({...y,columns:[]})||appended.some(c=>!c.type.startsWith('Nullable(')))return {...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
  const sql=appended.map(c=>'ALTER TABLE '+qualified(targetDb,name)+' ADD COLUMN '+quote(c.name)+' '+c.type)
  return {...step,action:sql.length?'alter':'review',sql,executable:sql.length>0,transfer:mode==='structure-data'&&sql.length>0,changes:appended.map(c=>'ADD COLUMN '+c.name)}
 })
}
const settings:ClickHouseSettings={max_execution_time:110,max_threads:2,max_insert_threads:'1',max_memory_usage:String(256*1024*1024),wait_end_of_query:1}
export class ClickHouseMigrationEndpoint implements MigrationEndpoint{
 readonly kind='clickhouse' as const
 private constructor(private client:ClickHouseClient,private pool:Awaited<ReturnType<typeof openClickHouseClients>>,private transport:ConnectionTransport,private signal:AbortSignal,readonly identity:string){
  signal.addEventListener('abort',this.stop,{once:true})
 }
 private stop=()=>{void this.pool.close();void this.transport.close().catch(()=>{})}
 static async open(input:ConnectionConfig,signal:AbortSignal){
  const config=validateConnection(input)
  if(config.kind!=='clickhouse')throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  requireActive(signal)
  const transport=await createTransport({ssh:config.ssh,proxy:config.proxy,timeoutMs:config.connectTimeoutMs})
  let pool:Awaited<ReturnType<typeof openClickHouseClients>>|undefined
  try{
   pool=await openClickHouseClients(config,transport,await loadConnectionTls(config))
   const client=pool.make('default',0)
   // serverUUID() is stable across aliases; require it rather than guessing.
   const result=await client.query({query:'SELECT toString(serverUUID()) AS identity',format:'JSONEachRow',abort_signal:signal})
   const rows=await result.json<{identity:string}>()
   const identity=rows[0]?.identity
   if(!identity||!/^[-a-f0-9]{36}$/i.test(identity))throw new Error('MIGRATION_DATABASE_ERROR: SERVER_IDENTITY')
   return new ClickHouseMigrationEndpoint(client,pool,transport,signal,identity)
  }catch(e){await pool?.close();await transport.close().catch(()=>{});throw e}
 }
 async close(){this.signal.removeEventListener('abort',this.stop);await this.pool.close();await this.transport.close().catch(()=>{})}
 private async rows<T>(query:string,query_params?:Record<string,unknown>){
  requireActive(this.signal)
  const result=await this.client.query({query,query_params,format:'JSONEachRow',abort_signal:this.signal,clickhouse_settings:{...settings,readonly:'1',max_result_rows:'501',max_result_bytes:String(4*1024*1024),result_overflow_mode:'throw'}})
  return result.json<T>()
 }
 private async databases(){const rows=await this.rows<{name:string}>("SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name LIMIT 501");if(rows.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限');return rows.map(r=>r.name)}
 private async objects(database:string){
  quote(database)
  if(!(await this.databases()).includes(database))throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  return this.rows<{name:string;engine:string;create_table_query:string;sorting_key:string;partition_key:string;primary_key:string;sampling_key:string}>('SELECT name,engine,create_table_query,sorting_key,partition_key,primary_key,sampling_key FROM system.tables WHERE database={db:String} AND is_temporary=0 ORDER BY name LIMIT 501',{db:database})
 }
 async catalog(database?:string):Promise<MigrationCatalog>{
  const databases=await this.databases()
  const list=database?await this.objects(database):undefined
  if(list&&list.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
  return {kind:this.kind,databases,...(list?{objects:list.map(o=>({name:o.name,type:'BASE TABLE',engine:o.engine}))}:{})}
 }
 async schema(database:string,names?:string[]):Promise<SchemaSnapshot>{
  const list=limitObjectNames(await this.objects(database),names),objects:SchemaObject[]=[]
  for(const o of list){
   const fields=await this.rows<{name:string;type:string;default_kind:string;default_expression:string;comment:string;compression_codec:string}>('SELECT name,type,default_kind,default_expression,comment,compression_codec FROM system.columns WHERE database={db:String} AND table={name:String} ORDER BY position LIMIT 501',{db:database,name:o.name})
   const columns=fields.map(c=>({name:c.name,type:c.type})),sorting=simpleKeys(o.sorting_key,columns),partition=simpleKeys(o.partition_key,columns),primary=simpleKeys(o.primary_key,columns)
   // Never replay SHOW CREATE. Explicitly support a narrow, ordinary
   // MergeTree shape. All other features are review-only.
   const definition=o.create_table_query
   const rawSettings=/\sSETTINGS\s+(index_granularity\s*=\s*[1-9][0-9]*)\s*$/i.exec(definition)?.[1]||''
   const tableTail=definition.replace(/'(?:[^']|'')*'|`(?:[^`]|``)*`/g,' Q ')
   const safe=/^[A-Za-z_][A-Za-z_0-9]*$/.test(database)&&/^[A-Za-z_][A-Za-z_0-9]*$/.test(o.name)&&columns.every(c=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(c.name))&&o.engine==='MergeTree'&&!o.sampling_key&&fields.length>0&&fields.length<=500&&fields.every(f=>simpleType(f.type)&&!f.default_kind&&!f.default_expression&&!f.comment&&!f.compression_codec)&&!!sorting&&!!partition&&!!primary&&
    !/\b(TTL|PROJECTION|CONSTRAINT|INDEX|CODEC|COMMENT|ON CLUSTER|SAMPLE BY|AS SELECT|EPHEMERAL)\b/i.test(tableTail)&&(!/\bSETTINGS\b/i.test(tableTail)||!!rawSettings)
   const details:ChShape={safe,columns,sorting:sorting||[],partition:partition||[],primary:primary||[],settings:rawSettings.replace(/\s+/g,'')}
   objects.push({name:o.name,type:'BASE TABLE',engine:o.engine,definition,triggerNames:[],details})
  }
  return checkedSnapshot(objects)
 }
 async startSourceSnapshot(){}
 async prepareTarget(){}
 async applyStep(step:MigrationStep){for(const query of step.sql){requireActive(this.signal);await this.client.command({query,abort_signal:this.signal,clickhouse_settings:{...settings,readonly:'0'}})}}
 async *mappedRows(database:string,name:string,fields:string[],filter?:{field:string;value:string}){
  const info=shape((await this.schema(database,[name])).objects[0])
  if(!info?.safe||!fields.length||fields.some(f=>!info.columns.some(c=>c.name===f))||filter&&!info.columns.some(c=>c.name===filter.field))throw Error('MIGRATION_MAPPING: 字段或对象映射无效')
  const binary=(type:string)=>{const t=type.startsWith('Nullable(')?type.slice(9,-1):type;return t==='String'||/^FixedString\(\d+\)$/.test(t)}
  const expressions=fields.map(f=>(binary(info.columns.find(c=>c.name===f)!.type)?'hex(':'toString(')+quote(f)+')')
  const where=filter?' WHERE toString('+quote(filter.field)+') = {value:String}':''
  const result=await this.client.exec({query:'SELECT '+expressions.join(', ')+' FROM '+qualified(database,name)+where+' FORMAT JSONCompactEachRow',query_params:filter?{value:filter.value}:undefined,query_id:randomUUID(),abort_signal:this.signal,clickhouse_settings:{...settings,readonly:'1',max_execution_time:0,cancel_http_readonly_queries_on_client_close:1}})
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending=''
  try{
   for await(const chunk of result.stream){
    requireActive(this.signal);pending+=decoder.decode(Buffer.from(chunk),{stream:true})
    for(;;){
     const at=pending.indexOf('\n');if(at<0)break
     const line=pending.slice(0,at);pending=pending.slice(at+1)
     if(!line.trim())continue
     if(Buffer.byteLength(line)>8*1024*1024)throw Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
     const values:unknown=JSON.parse(line)
     if(!Array.isArray(values)||values.length!==fields.length||values.some(v=>v!==null&&typeof v!=='string'))throw Error('MIGRATION_TYPE: 无法无损传输该字段值')
     yield Object.fromEntries(fields.map((f,i)=>{const v=values[i];if(v===null)return [f,null];if(binary(info.columns.find(c=>c.name===f)!.type)){if(!/^(?:[a-fA-F0-9]{2})*$/.test(v))throw Error('MIGRATION_TYPE: 无法无损传输该字段值');return [f,{$dbexBinary:Buffer.from(v,'hex').toString('base64')}]}return [f,v]}))
    }
    if(Buffer.byteLength(pending)>8*1024*1024)throw Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
   }
   pending+=decoder.decode();if(pending.trim())throw Error('MIGRATION_TYPE: 无法无损传输该字段值')
  }finally{result.stream.destroy()}
 }
 async mappedWrite(database:string,name:string,fields:string[],records:AsyncIterable<Record<string,unknown>>,beforeCommit:()=>void,committed:(n:number)=>void){
  const info=shape((await this.schema(database,[name])).objects[0])
  if(!info?.safe||!fields.length||fields.some(f=>!info.columns.some(c=>c.name===f)))throw Error('MIGRATION_MAPPING: 字段或对象映射无效')
  const cols=fields.map(f=>info.columns.find(c=>c.name===f)!)
  const binary=(type:string)=>{const t=type.startsWith('Nullable(')?type.slice(9,-1):type;return t==='String'||/^FixedString\(\d+\)$/.test(t)}
  const input=cols.map((_,i)=>'c'+i+' Nullable(String)').join(', ')
  const expressions=cols.map((c,i)=>'accurateCast('+(binary(c.type)?'unhex(c'+i+')':'c'+i)+", '"+c.type.replaceAll("'","''")+"')")
  const query='INSERT INTO '+qualified(database,name)+' ('+fields.map(quote).join(', ')+') SELECT '+expressions.join(', ')+" FROM input('"+input+"') FORMAT JSONEachRow"
  let batch:string[]=[],bytes=0
  const flush=async()=>{
   if(!batch.length)return
   requireActive(this.signal);beforeCommit()
   const stream=Readable.from(batch)
   try{
    const result=await this.client.exec({query,values:stream,query_id:randomUUID(),abort_signal:this.signal,clickhouse_settings:{...settings,readonly:'0',max_execution_time:0,async_insert:0,input_format_allow_errors_num:'0',input_format_allow_errors_ratio:0}})
    for await(const chunk of result.stream){if(String(chunk).trim()){result.stream.destroy();throw Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')}}
    committed(batch.length);batch=[];bytes=0
   }finally{stream.destroy()}
  }
  for await(const row of records){
   requireActive(this.signal)
   const values=Object.fromEntries(cols.map((c,i)=>{const value=sqlFileValue(row[c.name]);return ['c'+i,value===null?null:Buffer.isBuffer(value)?value.toString('hex'):String(value)]}))
   const line=JSON.stringify(values)+'\n',size=Buffer.byteLength(line)
   if(size>8*1024*1024)throw Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
   if(batch.length&&(batch.length>=500||bytes+size>4*1024*1024))await flush()
   batch.push(line);bytes+=size
  }
  await flush()
 }
 async copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,...[read,pending,commitStart,committed]:CopyCallbacks){
  if(options.policy!=='append'||options.condition||!(source instanceof ClickHouseMigrationEndpoint))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  const x=shape(object),actual=shape((await source.schema(sourceDb,[object.name])).objects[0]),target=shape((await this.schema(targetDb,[object.name])).objects[0])
  if(!x?.safe||!actual?.safe||!target?.safe||!equal(x,actual)||!equal(x,target))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const cols=x.columns.map(c=>quote(c.name)).join(', ')
  const signal=this.signal
  const result=await source.client.exec({query:'SELECT '+cols+' FROM '+qualified(sourceDb,object.name)+' FORMAT Native',query_id:randomUUID(),abort_signal:signal,clickhouse_settings:{...settings,readonly:'1',max_execution_time:0,result_overflow_mode:'throw',cancel_http_readonly_queries_on_client_close:1}})
  const budget=byteBudget(Number.MAX_SAFE_INTEGER,bytes=>read(0,bytes))
  const stream=addAbortSignal(signal,result.stream)
  stream.on('error',error=>budget.stream.destroy(error));budget.stream.on('error',()=>stream.destroy())
  let ended=false;stream.once('end',()=>{ended=true})
  // Native format preserves binary strings, exact decimal/integer values,
  // and NULL without a JavaScript JSON round-trip. A failed insert may have
  // partially committed; do not pretend the entire stream is transactional.
  stream.pipe(budget.stream)
  try{
   pending(0);commitStart()
   const response=await this.client.exec({query:'INSERT INTO '+qualified(targetDb,object.name)+' ('+cols+') FORMAT Native',values:budget.stream,query_id:randomUUID(),abort_signal:signal,clickhouse_settings:{...settings,readonly:'0',max_execution_time:0,async_insert:0,input_format_allow_errors_num:'0',input_format_allow_errors_ratio:0}})
   for await(const chunk of response.stream){if(String(chunk).trim()){response.stream.destroy();throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')}}
   if(!ended||!budget.stream.readableEnded)throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')
   committed(0)
  }finally{stream.destroy();budget.stream.destroy()}
 }
}
