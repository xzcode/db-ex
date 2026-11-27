import type {BrowseFilter} from './browse-filter'
import type {DatabaseKind} from './types'
export type DataFileFormat='csv'|'jsonl'|'sql'|'xlsx'|'parquet'
export const dataFileEncodings=['utf-8','utf-16le','utf-16be','gb18030','windows-1252'] as const
export type DataFileEncoding=typeof dataFileEncodings[number]
export function dataFileEncoding(value:unknown):DataFileEncoding{if(value===undefined)return 'utf-8';if(typeof value!=='string'||!dataFileEncodings.includes(value as DataFileEncoding))throw new Error('FILE_TRANSFER: 不支持的文件编码');return value as DataFileEncoding}
export type DataFilePolicy='append'|'upsert'|'replace'
export type FieldConversion='auto'|'string'|'integer'|'decimal'|'double'|'boolean'|'ejson'|'binary'
export interface FieldMapping {source:string;target:string;conversion:FieldConversion}
export interface FilePreview {token:string;name:string;size:number;format:DataFileFormat;delimiter:string;encoding?:DataFileEncoding;fields:string[];sample:Record<string,unknown>[];worksheet?:string;worksheets?:string[];previewError?:string}
export interface FileTransferRequest {
 direction:'import'|'export';database:string;entity:string;format:DataFileFormat;delimiter:string;encoding?:DataFileEncoding
 token?:string;worksheet?:string;redisPattern?:string;redisKeys?:string[];fields?:string[];mapping?:FieldMapping[];preserveDocuments?:boolean;policy?:DataFilePolicy
 filter?:BrowseFilter;mongoFilter?:string;skipInvalid?:boolean
}
export interface FileTransferJob {id:string;direction:'import'|'export';state:'running'|'completed'|'failed'|'cancelled'|'uncertain';read:number;committed:number;skipped:number;bytes:number;file:string;error?:string;hasErrorReport?:boolean;rowsKnown?:boolean;totalBytes?:number;errors?:{row:number;code:string}[]}
export const fileTransferSupported=(kind:DatabaseKind)=>['mysql','mariadb','sqlite','mongodb','redis'].includes(kind)
export function dataFileFormat(value:unknown):DataFileFormat{if(value!=='csv'&&value!=='jsonl'&&value!=='sql'&&value!=='xlsx'&&value!=='parquet')throw new Error('FILE_TRANSFER: 不支持的文件格式');return value}
export function dataFileDelimiter(value:unknown){if(typeof value!=='string'||![',',';','\t','|'].includes(value))throw new Error('FILE_TRANSFER: 不支持的分隔符');return value}
export function dataFileName(value:unknown){if(typeof value!=='string'||!value||value.length>200||/[\u0000-\u001f\u007f]/.test(value)||['__proto__','prototype','constructor'].includes(value))throw new Error('FILE_TRANSFER: 字段或对象名称无效');return value}
export function normalizeFileTransfer(input:unknown,kind:DatabaseKind):FileTransferRequest{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('FILE_TRANSFER: 参数无效')
 const v=input as FileTransferRequest,format=dataFileFormat(v.format),delimiter=dataFileDelimiter(v.delimiter),encoding=dataFileEncoding(v.encoding),database=dataFileName(v.database),entity=dataFileName(v.entity)
 if(!fileTransferSupported(kind)||!['import','export'].includes(v.direction))throw new Error('FILE_TRANSFER: 不支持此数据库或操作')
 if(kind==='redis'){
  if(format!=='jsonl'||encoding!=='utf-8'||delimiter!==','||entity!=='keyspace'||!/^\d+$/.test(database)||JSON.stringify(input).length>512000)throw Error('FILE_TRANSFER: Redis Key 存档参数无效')
  if(v.direction==='export'){
   if(v.redisKeys!==undefined){
    if(v.redisPattern!==undefined||!Array.isArray(v.redisKeys)||!v.redisKeys.length||v.redisKeys.some(k=>typeof k!=='string'||!k.length||k.length>1024*1024||k.includes('\0')))throw Error('FILE_TRANSFER: Redis Key 存档参数无效')
    return {direction:v.direction,database,entity,format,delimiter,encoding,redisKeys:[...new Set(v.redisKeys)]}
   }
   if(typeof v.redisPattern!=='string'||!v.redisPattern.length||v.redisPattern.length>1024||v.redisPattern.includes('\0'))throw Error('FILE_TRANSFER: Redis 匹配模式无效')
   return {direction:v.direction,database,entity,format,delimiter,encoding,redisPattern:v.redisPattern}
  }
  const policy=v.policy||'append'
  if(!['append','upsert'].includes(policy)||typeof v.token!=='string'||!/^[-a-f0-9]{36}$/i.test(v.token))throw Error('FILE_TRANSFER: Redis Key 存档参数无效')
  return {direction:v.direction,database,entity,format,delimiter,encoding,policy,token:v.token}
 }
 if(kind==='mongodb'&&format==='sql')throw new Error('FILE_TRANSFER: 不支持此数据库或操作')
 if((format==='xlsx'||format==='parquet')&&encoding!=='utf-8')throw new Error('FILE_TRANSFER: 不支持的文件编码')
 if(JSON.stringify(input).length>512000)throw new Error('FILE_TRANSFER: 参数过大')
 if(v.fields!==undefined&&(!Array.isArray(v.fields)||!v.fields.length))throw new Error('FILE_TRANSFER: 字段映射无效')
 const fields=v.fields===undefined?undefined:[...new Set(v.fields.map(dataFileName))]
 if(v.direction==='export'){if(encoding!=='utf-8')throw new Error('FILE_TRANSFER: 导出编码仅支持 UTF-8');return {direction:v.direction,database,entity,format,delimiter,encoding,fields,...(v.filter?{filter:v.filter}:{}),...(typeof v.mongoFilter==='string'?{mongoFilter:v.mongoFilter}:{})}}
 const policy=v.policy||'append'
 if(!['append','upsert','replace'].includes(policy)||kind==='mongodb'&&policy==='replace'||typeof v.token!=='string'||!/^[-a-f0-9]{36}$/i.test(v.token))throw new Error('FILE_TRANSFER: 参数无效')
 const worksheet=v.worksheet
 if(worksheet!==undefined&&(format!=='xlsx'||typeof worksheet!=='string'||!worksheet||worksheet.length>31||/[\u0000-\u001f]/.test(worksheet)))throw new Error('FILE_TRANSFER: Excel 工作表无效')
 const preserveDocuments=kind==='mongodb'&&format==='jsonl'&&v.preserveDocuments===true
 const conversions=['auto','string','integer','decimal','double','boolean','ejson','binary']
 const mapping=preserveDocuments?undefined:(Array.isArray(v.mapping)?v.mapping.map(m=>{
  if(!m||!conversions.includes(m.conversion))throw new Error('FILE_TRANSFER: 字段映射无效')
  return {source:dataFileName(m.source),target:dataFileName(m.target),conversion:m.conversion}
 }):[])
 if(!preserveDocuments&&(!mapping?.length||new Set(mapping.map(m=>m.target)).size!==mapping.length))throw new Error('FILE_TRANSFER: 字段映射无效')
 if(policy==='replace'&&v.skipInvalid)throw new Error('FILE_TRANSFER: 清空模式不能跳过无效记录')
 return {direction:v.direction,database,entity,format,delimiter,encoding,token:v.token,...(worksheet?{worksheet}:{}),mapping,preserveDocuments,policy,skipInvalid:v.skipInvalid===true}
}

export interface FileTransferPresetScope {connectionId:string;kind:DatabaseKind;database:string;entity:string;direction:'import'|'export'}
export interface FileTransferPresetDraft {
 name:string
 options:Omit<FileTransferRequest,'token'|'database'|'entity'|'direction'|'filter'|'mongoFilter'|'redisPattern'|'redisKeys'>
 useCurrentFilter:boolean
}
export interface FileTransferPreset extends FileTransferPresetScope,FileTransferPresetDraft {id:string;updatedAt:string}
