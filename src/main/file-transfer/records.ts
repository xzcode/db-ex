import {open,type FileHandle} from 'node:fs/promises'
import type {DataFileFormat,DataFileEncoding,FieldMapping,FileTransferRequest} from '../../shared/file-transfer'
import {dataFileName} from '../../shared/file-transfer'
import {checkAborted} from '../operations/common'
export const RECORD_BYTES=32*1024*1024 // per record, not whole-file size
export interface FileIdentity{dev:number;ino:number;size:number;mtimeMs:number}
export function identity(s:FileIdentity):FileIdentity{return {dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs}}
export function sameFile(a:FileIdentity,b:FileIdentity){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs}
const invalid=()=>new Error('FILE_TRANSFER: 文件记录格式无效')
async function* textChunks(file:FileHandle,signal?:AbortSignal,onBytes?:(n:number)=>void,encoding:DataFileEncoding='utf-8'){
 const decoder=new TextDecoder(encoding,{fatal:true})
 const buffer=Buffer.allocUnsafe(64*1024);let position=0
 while(true){checkAborted(signal);const {bytesRead}=await file.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;onBytes?.(bytesRead);yield decoder.decode(buffer.subarray(0,bytesRead),{stream:true})}
 const tail=decoder.decode();if(tail)yield tail
}
/** Strict incremental CSV parsing, including escaped quotes and CRLF within
 * quoted fields. Memory scales with the largest record, not file size. */
export async function* csvRecords(chunks:AsyncIterable<string>,delimiter:string,signal?:AbortSignal){
 let row:string[]=[],field='',quoted=false,afterQuote=false,started=false,skipLf=false,units=0
 const finishField=()=>{row.push(field);field='';quoted=false;afterQuote=false;started=false}
 const finishRow=()=>{finishField();const current=row;row=[];units=0;return current}
 for await(const chunk of chunks){
  for(const c of chunk){
   if(++units>RECORD_BYTES)throw new Error('FILE_TRANSFER: 单条文件记录过大')
   if(skipLf){skipLf=false;if(c==='\n')continue}
   if(quoted){if(c==='"'){quoted=false;afterQuote=true}else field+=c;continue}
   if(afterQuote){if(c==='"'){field+='"';quoted=true;afterQuote=false;continue}if(c===delimiter){finishField();continue}if(c==='\r'||c==='\n'){skipLf=c==='\r';yield finishRow();continue}throw invalid()}
   if(c==='"'){if(started)throw invalid();quoted=true;started=true;continue}
   if(c===delimiter){finishField();continue}
   if(c==='\r'||c==='\n'){skipLf=c==='\r';yield finishRow();continue}
   field+=c;started=true
  }
  checkAborted(signal)
 }
 if(quoted)throw invalid()
 if(row.length||started||afterQuote||field.length)yield finishRow()
}
function checkedRecord(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
 const walk=(v:unknown,depth=0)=>{if(depth>64)throw invalid();if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw new Error('FILE_TRANSFER: 大整数必须使用字符串或扩展 JSON');if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw invalid();walk(x,depth+1)}}}
 walk(value)
 return value as Record<string,unknown>
}
export async function* readFileRecords(file:FileHandle,format:DataFileFormat,delimiter:string,signal?:AbortSignal,onBytes?:(n:number)=>void,encoding:DataFileEncoding='utf-8'){
 const chunks=textChunks(file,signal,onBytes,encoding)
 if(format==='csv'){
  let headers:string[]|undefined
  for await(const row of csvRecords(chunks,delimiter,signal)){
   if(!headers){headers=row.map(dataFileName);if(!headers.length||new Set(headers).size!==headers.length)throw invalid();continue}
   if(row.length!==headers.length)throw invalid()
   // CSV has no native types. The conventional null marker is explicit.
   yield Object.fromEntries(headers.map((h,i)=>[h,row[i]==='\\N'?null:row[i]!.startsWith('\\\\')?row[i]!.slice(1):row[i]!]))
  }
  if(!headers)throw invalid()
 }else{
  let pending=''
  for await(const chunk of chunks){
   pending+=chunk
   for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(line){if(Buffer.byteLength(line)>RECORD_BYTES)throw invalid();yield checkedRecord(JSON.parse(line))}}
   if(pending.length>RECORD_BYTES)throw invalid()
  }
  if(pending.trim())yield checkedRecord(JSON.parse(pending))
 }
}
export async function inspectFile(path:string,format:DataFileFormat,delimiter:string,encoding:DataFileEncoding='utf-8'){
 const file=await open(path,'r')
 try{
  const stat=await file.stat();if(!stat.isFile()||!stat.size)throw invalid()
  const sample:Record<string,unknown>[]=[],fields=new Set<string>();let bytes=0
  for await(const row of readFileRecords(file,format,delimiter,undefined,undefined,encoding)){
   const size=Buffer.byteLength(JSON.stringify(row))
   if(size>RECORD_BYTES)throw invalid()
   for(const name of Object.keys(row))fields.add(dataFileName(name))
   if(bytes+size<=256*1024)sample.push(row)
   bytes+=size
   if(sample.length>=20||bytes>256*1024)break
  }
  if(!fields.size)throw invalid()
  const after=await file.stat();if(!sameFile(stat,after))throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
  return {identity:identity(stat),fields:[...fields],sample}
 }finally{await file.close()}
}
function canonicalBinary(value:string){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw invalid();return value}
export function mappedValue(value:unknown,conversion:FieldMapping['conversion'],mongo:boolean):unknown{
 if(value===null)return null
 if(conversion==='auto')return value
 const text=typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):JSON.stringify(value)
 switch(conversion){
 case 'string':return text
 case 'integer':if(!/^[+-]?\d+$/.test(text))throw invalid();return mongo?{$numberLong:BigInt(text).toString()}:{$dbexInteger:BigInt(text).toString()}
 case 'decimal':if(!/^[+-]?\d+(?:\.\d+)?$/.test(text))throw invalid();return mongo?{$numberDecimal:text}:text
 case 'double':if(!text.trim()||!Number.isFinite(Number(text)))throw invalid();return mongo?{$numberDouble:text}:{$dbexReal:String(Number(text))}
 case 'boolean':if(!['true','false','1','0'].includes(text.toLowerCase()))throw invalid();return text==='1'||text.toLowerCase()==='true'
 case 'ejson':return checkedValue(JSON.parse(text),mongo)
 case 'binary':return mongo?{$binary:{base64:canonicalBinary(text.replace(/^base64:/,'')),subType:'00'}}:{$dbexBinary:canonicalBinary(text.replace(/^base64:/,''))}
 }
}
function checkedValue(value:unknown,mongo:boolean){return mongo?value:JSON.stringify(value)}
export function mapRecord(row:Record<string,unknown>,request:FileTransferRequest,mongo:boolean){
 if(request.preserveDocuments&&mongo)return row
 const out:Record<string,unknown>=Object.create(null)
 for(const m of request.mapping||[]){
  if(!Object.hasOwn(row,m.source)){if(mongo)continue;throw invalid()}
  out[m.target]=mappedValue(row[m.source],m.conversion,mongo)
 }
 if(!Object.keys(out).length)throw invalid()
 return out
}
export function sqlFileValue(value:unknown):string|number|null|Buffer|bigint{
 if(value===null||typeof value==='string')return value
 if(typeof value==='boolean')return value?1:0
 if(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return value
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1){
  const v=value as Record<string,unknown>
  if(typeof v.$dbexInteger==='string'&&/^-?\d+$/.test(v.$dbexInteger))return BigInt(v.$dbexInteger)
  if(typeof v.$dbexReal==='string'&&v.$dbexReal.trim()&&Number.isFinite(Number(v.$dbexReal)))return Number(v.$dbexReal)
  if(typeof v.$dbexBinary==='string')return Buffer.from(canonicalBinary(v.$dbexBinary),'base64')
 }
 throw invalid()
}
export function sqlFileRow(columns:string[],row:unknown[]):Record<string,unknown>{
 if(row.length!==columns.length)throw invalid()
 return Object.fromEntries(columns.map((name,i)=>{const v=row[i];return [name,Buffer.isBuffer(v)||v instanceof Uint8Array?{$dbexBinary:Buffer.from(v).toString('base64')}:typeof v==='bigint'?{$dbexInteger:v.toString()}:typeof v==='number'&&Number.isFinite(v)&&Number.isInteger(v)&&!Number.isSafeInteger(v)?{$dbexReal:String(v)}:v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)?v:(()=>{throw invalid()})()]}))
}
export function csvLine(values:unknown[],delimiter:string){return values.map(v=>{
 const wrapped=v&&typeof v==='object'?v as Record<string,unknown>:undefined
 const raw=wrapped&&typeof wrapped.$dbexInteger==='string'?wrapped.$dbexInteger:wrapped&&typeof wrapped.$dbexReal==='string'?wrapped.$dbexReal:wrapped&&typeof wrapped.$dbexBinary==='string'?'base64:'+wrapped.$dbexBinary:typeof v==='string'?v:typeof v==='object'?JSON.stringify(v):String(v)
 const text=v===null?'\\N':raw.startsWith('\\')?'\\'+raw:raw
 return text.includes(delimiter)||/["\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text
 }).join(delimiter)+'\r\n'}
