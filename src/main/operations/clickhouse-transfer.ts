import type {ClickHouseClient,ClickHouseSettings} from '@clickhouse/client'
import type {ClickHouseTransfer} from '../../shared/types'
import {randomUUID} from 'node:crypto'
import {open,mkdtemp,rm,lstat} from 'node:fs/promises'
import {publishNewFile} from './publish-file'
import {createWriteStream} from 'node:fs'
import {dirname,join} from 'node:path'
import {Transform, type TransformCallback} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {clickHouseIdentifier} from './clickhouse-policy'
import {plainObject,boundedText,resourceName} from './common'
import type {FileIdentity} from '../file-transfer/records'

export const MAX_TRANSFER_BYTES=256*1024*1024
const formats={csv:'CSVWithNames',jsonl:'JSONEachRow',parquet:'Parquet',native:'Native'} as const
export function transferFormat(value:unknown){if(typeof value!=='string'||!Object.hasOwn(formats,value))throw new Error('INVALID_INPUT: ClickHouse transfer format');return formats[value as keyof typeof formats]}
export interface ClickHouseFileOptions {
 onBytes:(count:number)=>void
 beforeWrite:()=>void
 expected?:FileIdentity
}
export function normalizeClickHouseTransfer(value:unknown):ClickHouseTransfer{
 const v=plainObject(value,'ClickHouse transfer')
 if(v.direction!=='import'&&v.direction!=='export')throw Error('INVALID_INPUT: ClickHouse transfer direction')
 const database=resourceName(v.database,'数据库'),entity=resourceName(v.entity,'表')
 if(['system','information_schema'].includes(database.toLowerCase()))throw Error('INVALID_OPERATION: ClickHouse system database')
 clickHouseIdentifier(database);clickHouseIdentifier(entity);transferFormat(v.format)
 let fields:string[]|undefined
 if(v.fields!==undefined){
  if(!Array.isArray(v.fields)||!v.fields.length||v.fields.length>500)throw Error('INVALID_INPUT: ClickHouse transfer columns')
  fields=v.fields.map(field=>resourceName(field,'字段'))
  fields.forEach(clickHouseIdentifier)
  if(new Set(fields).size!==fields.length)throw Error('INVALID_INPUT: ClickHouse transfer columns')
 }
 let filter:ClickHouseTransfer['filter']
 if(v.filter!==undefined){
  if(v.direction!=='export')throw Error('INVALID_INPUT: ClickHouse transfer filter')
  const f=plainObject(v.filter,'ClickHouse transfer filter')
  const field=resourceName(f.field,'字段');clickHouseIdentifier(field)
  filter={field,value:boundedText(f.value,'ClickHouse filter',65536)}
 }
 return {database,entity,direction:v.direction,format:v.format as ClickHouseTransfer['format'],fields,filter}
}
const unchanged=(a:FileIdentity,b:FileIdentity)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs
export function byteBudget(limit=MAX_TRANSFER_BYTES,onBytes?:(n:number)=>void){
 let bytes=0
 const stream=new Transform({transform(chunk:Buffer,_encoding:string,callback:TransformCallback){bytes+=chunk.length;if(bytes<=limit)onBytes?.(chunk.length);callback(bytes>limit?new Error('LIMIT_EXCEEDED: ClickHouse transfer'):null,chunk)}})
 return {stream,bytes:()=>bytes}
}
export async function streamClickHouse(client:ClickHouseClient,input:ClickHouseTransfer,path:string,qualified:string,columns:string[],parent?:AbortSignal,options?:ClickHouseFileOptions){
 const format=transferFormat(input.format)
 const signal=options?(parent||new AbortController().signal):parent?AbortSignal.any([parent,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)
 if(signal.aborted)throw new Error('CANCELLED: 已取消操作')
 if(!columns.length)throw new Error('INVALID_INPUT: ClickHouse transfer columns')
 const settings:ClickHouseSettings={max_execution_time:options?0:110,max_memory_usage:String(256*1024*1024),wait_end_of_query:1,output_format_json_quote_64bit_integers:1,output_format_json_quote_decimals:1}
 const limit=options?Number.MAX_SAFE_INTEGER:MAX_TRANSFER_BYTES
 if(input.direction==='export'){
  try{await lstat(path);throw Error('OUTPUT_EXISTS: 目标文件已存在，不会覆盖')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  const tempDir=await mkdtemp(join(dirname(path),'.dbex-stream-'))
  const temp=join(tempDir,'data')
  try{
   const where=input.filter?' WHERE toString('+clickHouseIdentifier(input.filter.field)+') = {dbex_filter:String}':''
   const result=await client.exec({query:'SELECT '+columns.join(', ')+' FROM '+qualified+where+' FORMAT '+format,query_params:input.filter?{dbex_filter:input.filter.value}:undefined,query_id:randomUUID(),abort_signal:signal,clickhouse_settings:{...settings,readonly:'1',...(options?{}:{max_result_bytes:String(MAX_TRANSFER_BYTES),max_result_rows:'10000000',max_bytes_to_read:String(1024*1024*1024),max_rows_to_read:'100000000'}),result_overflow_mode:'throw',cancel_http_readonly_queries_on_client_close:1}})
   const budget=byteBudget(limit,options?.onBytes)
   await pipeline(result.stream,budget.stream,createWriteStream(temp,{flags:'wx',mode:0o600}),{signal})
   signal.throwIfAborted()
   // Atomic publication without replacing an existing file.
   await publishNewFile(temp,path,signal,input.format==='jsonl')
   return {bytes:budget.bytes()}
  }finally{await rm(tempDir,{recursive:true,force:true})}
 }
 if(input.direction!=='import')throw new Error('INVALID_INPUT: ClickHouse transfer direction')
 const file=await open(path,'r')
 try{
  const stat=await file.stat()
  if(!stat.isFile()||stat.size<1||stat.size>limit)throw new Error('LIMIT_EXCEEDED: ClickHouse transfer file')
  if(options?.expected&&!unchanged(stat,options.expected))throw Error('FILE_TRANSFER: 文件已变化，请重新预览')
  const budget=byteBudget(limit,options?.onBytes),source=file.createReadStream({autoClose:false})
  budget.stream.on('error',()=>source.destroy())
  source.on('error',error=>budget.stream.destroy(error))
  source.pipe(budget.stream)
  try{
   // exec with serialized values avoids JSONEachRow object-mode encoding and
   // JavaScript number conversion. All three formats use server-native parsing.
   options?.beforeWrite()
   const response=await client.exec({query:'INSERT INTO '+qualified+' ('+columns.join(', ')+') FORMAT '+format,values:budget.stream,query_id:randomUUID(),abort_signal:signal,clickhouse_settings:{...settings,readonly:'0',async_insert:0,input_format_skip_unknown_fields:0,input_format_defaults_for_omitted_fields:1,input_format_allow_errors_num:'0',input_format_allow_errors_ratio:0,input_format_with_names_use_header:1}})
   let responseBytes=0
   for await(const chunk of response.stream){responseBytes+=Buffer.byteLength(chunk);if(responseBytes>65536||String(chunk).trim()){response.stream.destroy();throw new Error('DATABASE_ERROR: ClickHouse import outcome uncertain')}}
   if(budget.bytes()!==stat.size||!unchanged(stat,await file.stat()))throw new Error('DATABASE_ERROR: ClickHouse import outcome uncertain')
   return {bytes:budget.bytes()}
  }finally{source.destroy();budget.stream.destroy()}
 }finally{await file.close()}
}
