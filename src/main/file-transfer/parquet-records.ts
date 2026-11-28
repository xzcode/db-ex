import type {FileHandle} from 'node:fs/promises'
import {open} from 'node:fs/promises'
import * as zlib from 'node:zlib'
import type {AsyncBuffer,SchemaElement,FileMetaData,Compressors} from 'hyparquet'
import {dataFileName} from '../../shared/file-transfer'
import type {DatabaseKind} from '../../shared/types'
import {checkAborted} from '../operations/common'
import {sqlFileValue} from './records'

const GROUP_BYTES=64*1024*1024,WRITE_GROUP_BYTES=4*1024*1024
const invalid=()=>new Error('FILE_TRANSFER: Parquet 文件或字段类型无效')
const tooLarge=()=>new Error('FILE_TRANSFER: Parquet 单个行组超过解码容量，请重新分组导出')
const modes=['integer','unsigned','decimal','double','boolean','binary','text','typed-json','ejson'] as const
type Mode=typeof modes[number]
export type FileColumn={name:string;type:string}
type Column={mode:Mode;schema:SchemaElement}
const codecMetadata='dbex.parquet.column-modes.v1'
const signedMin=-(1n<<63n),signedMax=(1n<<63n)-1n,unsignedMax=(1n<<64n)-1n
function planColumn(name:string,kind:DatabaseKind,type:string):Column{
 const schema:SchemaElement={name:dataFileName(name),repetition_type:'OPTIONAL',type:'BYTE_ARRAY',converted_type:'UTF8'}
 const t=type.trim().toUpperCase()
 const scalar=(mode:Mode,extra:Partial<SchemaElement>):Column=>({mode,schema:{name:schema.name,repetition_type:'OPTIONAL',...extra}})
 if(kind==='mongodb')return {mode:'ejson',schema}
 if(kind==='sqlite'){
  if(/^(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT)(?:\(\d+\))?$/.test(t))return scalar('integer',{type:'INT64'})
  if(/^(?:REAL|DOUBLE(?: PRECISION)?|FLOAT)$/.test(t))return scalar('double',{type:'DOUBLE'})
  if(t==='BLOB')return scalar('binary',{type:'BYTE_ARRAY'})
  if(/^(?:TEXT|CHAR|VARCHAR|CLOB)(?:\(\d+\))?$/.test(t))return {mode:'text',schema}
  // SQLite untyped/NUMERIC cells can have different storage classes.
  // Encode those cells as exact typed JSON, rather than guessing a type.
  return {mode:'typed-json',schema}
 }
 if(/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|YEAR)\b/.test(t)){
  if(/\bUNSIGNED\b/.test(t))return scalar('unsigned',{type:'INT64',converted_type:'UINT_64',logical_type:{type:'INTEGER',bitWidth:64,isSigned:false}})
  return scalar('integer',{type:'INT64'})
 }
 const decimal=/^(?:DECIMAL|NUMERIC)\((\d+),\s*(\d+)\)/.exec(t)
 if(decimal){
  const precision=Number(decimal[1]),scale=Number(decimal[2])
  if(precision<1||precision>76||scale<0||scale>precision)throw invalid()
  const type_length=Math.ceil(((10n**BigInt(precision)-1n).toString(2).length+1)/8)
  return scalar('decimal',{type:'FIXED_LEN_BYTE_ARRAY',type_length,converted_type:'DECIMAL',scale,precision,logical_type:{type:'DECIMAL',scale,precision}})
 }
 if(/^(?:FLOAT|DOUBLE|REAL)\b/.test(t))return scalar('double',{type:'DOUBLE'})
 if(/BLOB|BINARY|^BIT\b|GEOMETRY|^POINT\b|^LINESTRING\b|^POLYGON\b/.test(t))return scalar('binary',{type:'BYTE_ARRAY'})
 return {mode:'text',schema}
}
function decimalInteger(value:unknown,scale:number,precision:number){
 const s=typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='bigint'?String(value):''
 const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
 if(!match||((match[3]||'').length>scale))throw invalid()
 const n=BigInt(match[1]+match[2]+(match[3]||'').padEnd(scale,'0'))
 if((n<0n?-n:n)>=10n**BigInt(precision))throw invalid()
 return n
}
function encodeCell(value:unknown,column:Column,kind:DatabaseKind):unknown{
 if(value===null||value===undefined)return null
 if(column.mode==='ejson'||column.mode==='typed-json')return JSON.stringify(value)
 const actual=sqlFileValue(value)
 if(column.mode==='integer'||column.mode==='unsigned'){
  if(kind==='sqlite'&&typeof actual!=='bigint')throw invalid()
  const s=typeof actual==='bigint'||typeof actual==='string'||typeof actual==='number'&&Number.isSafeInteger(actual)?String(actual):''
  if(!/^-?\d+$/.test(s))throw invalid()
  const n=BigInt(s)
  if(column.mode==='unsigned'){if(n<0n||n>unsignedMax)throw invalid();return n}
  if(n<signedMin||n>signedMax)throw invalid();return n
 }
 if(column.mode==='decimal')return decimalInteger(actual,column.schema.scale!,column.schema.precision!)
 if(column.mode==='double'){
  if(typeof actual!=='number'||!Number.isFinite(actual))throw invalid()
  return actual
 }
 if(column.mode==='binary'){if(!Buffer.isBuffer(actual))throw invalid();return actual}
 if(column.mode==='boolean'){if(typeof actual!=='number'||!['0','1'].includes(String(actual)))throw invalid();return !!actual}
 if(typeof actual!=='string')throw invalid()
 return actual
}
export async function writeParquetRecords(path:string,fields:string[],kind:DatabaseKind,types:FileColumn[],rows:AsyncIterable<Record<string,unknown>>,signal:AbortSignal,progress:(count:number,bytes:number)=>void){
 const {ByteWriter,ParquetWriter}=await import('hyparquet-writer')
 const names=fields.map(dataFileName)
 if(!names.length||names.length>1000||new Set(names).size!==names.length)throw invalid()
 const columns=names.map(name=>planColumn(name,kind,types.find(t=>t.name===name)?.type||''))
 const file=await open(path,'wx',0o600)
 try{
  const writer=new ByteWriter()
  const flush=async()=>{checkAborted(signal);if(writer.index){await file.writeFile(writer.getBytes());writer.index=0}}
  Object.assign(writer,{flush,finish:flush})
  const pq=new ParquetWriter({writer,schema:[{name:'schema',num_children:names.length},...columns.map(c=>c.schema)],codec:'SNAPPY',statistics:false,createdBy:'DB EX',kvMetadata:[{key:codecMetadata,value:JSON.stringify(columns.map(c=>c.mode))}]})
  let data:unknown[][]=names.map(()=>[]),size=0,count=0
  const write=async()=>{
   if(!count)return
   await pq.write({columnData:names.map((name,i)=>({name,data:data[i]!,encoding:'PLAIN',offsetIndex:false})),rowGroupSize:count,pageSize:1024*1024})
   progress(count,writer.offset);data=names.map(()=>[]);size=0;count=0
  }
  for await(const row of rows){
   checkAborted(signal)
   const bytes=Buffer.byteLength(JSON.stringify(row))
   if(bytes>32*1024*1024)throw tooLarge()
   if(count&&(count>=1000||size+bytes>WRITE_GROUP_BYTES))await write()
   for(let i=0;i<names.length;i++)data[i]!.push(encodeCell(Object.hasOwn(row,names[i]!)?row[names[i]!]:null,columns[i]!,kind))
   count++;size+=bytes
  }
  await write();await pq.finish();checkAborted(signal);await file.sync()
  progress(0,writer.offset)
 }catch(e){if(e instanceof Error&&/^(FILE_TRANSFER|CANCELLED):/.test(e.message))throw e;throw invalid()}
 finally{await file.close()}
}
function asInt(value:unknown):bigint{
 if(typeof value==='bigint')return value
 if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value)
 if(value instanceof Uint8Array&&value.length>0&&value.length<=64){
  let n=0n;for(const b of value)n=n*256n+BigInt(b)
  return BigInt.asIntN(value.length*8,n)
 }
 throw invalid()
}
function decimalText(n:bigint,scale:number){
 if(!Number.isInteger(scale)||scale<0||scale>1000)throw invalid()
 const digits=(n<0n?-n:n).toString().padStart(scale+1,'0')
 return (n<0n?'-':'')+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits)
}
function timestamp(n:bigint,unit:number){
 const factor=10n**BigInt(unit),seconds=n/factor-(n<0n&&n%factor!==0n?1n:0n)
 const fraction=n-seconds*factor
 const date=new Date(Number(seconds)*1000)
 if(!Number.isFinite(date.getTime()))throw invalid()
 return date.toISOString().slice(0,19).replace('T',' ')+'.'+fraction.toString().padStart(unit,'0')
}
function isDecimal(c:SchemaElement){return c.converted_type==='DECIMAL'||c.logical_type?.type==='DECIMAL'}
function isUnsigned64(c:SchemaElement){return c.converted_type==='UINT_64'||c.logical_type?.type==='INTEGER'&&c.logical_type.bitWidth===64&&!c.logical_type.isSigned}
function normalizedValue(value:unknown,schema:SchemaElement,mode?:Mode):unknown{
 if(value===null||value===undefined)return null
 if(mode==='typed-json'||mode==='ejson'){
  if(typeof value!=='string')throw invalid()
  return JSON.parse(value)
 }
 if(isDecimal(schema))return decimalText(asInt(value),schema.scale??(schema.logical_type?.type==='DECIMAL'?schema.logical_type.scale:0))
 if(isUnsigned64(schema))return {$dbexInteger:BigInt.asUintN(64,asInt(value)).toString()}
 if(typeof value==='bigint')return {$dbexInteger:value.toString()}
 if(value instanceof Uint8Array)return {$dbexBinary:Buffer.from(value).toString('base64')}
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw invalid()
  return schema.type==='FLOAT'||schema.type==='DOUBLE'?{$dbexReal:String(value)}:value
 }
 if(typeof value==='string'||typeof value==='boolean')return value
 throw invalid()
}
function metadataMode(meta:FileMetaData){
 const value=meta.key_value_metadata?.find(k=>k.key===codecMetadata)?.value
 if(value===undefined)return undefined
 const parsed:unknown=JSON.parse(value)
 if(!Array.isArray(parsed)||parsed.length!==meta.schema.length-1||parsed.some(v=>!modes.includes(v as Mode)))throw invalid()
 return parsed as Mode[]
}
export class ParquetRecords{
 private constructor(private file:AsyncBuffer,private metadata:FileMetaData,private original:SchemaElement[],private signal?:AbortSignal,private modes?:Mode[]){}
 static async open(handle:FileHandle,signal?:AbortSignal,onBytes?:(n:number)=>void){
  const stat=await handle.stat()
  if(!stat.isFile()||stat.size<12)throw invalid()
  const read=async(start:number,end:number)=>{
   checkAborted(signal)
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>stat.size||end-start>GROUP_BYTES)throw tooLarge()
   const bytes=Buffer.allocUnsafe(end-start);let offset=0
   while(offset<bytes.length){checkAborted(signal);const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,start+offset);if(!bytesRead)throw invalid();offset+=bytesRead;onBytes?.(bytesRead)}
   return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer
  }
  const footer=Buffer.from(await read(stat.size-8,stat.size))
  if(footer.subarray(4).toString()!=='PAR1'||Buffer.from(await read(0,4)).toString()!=='PAR1'||footer.readUInt32LE(0)>32*1024*1024||footer.readUInt32LE(0)>stat.size-12)throw invalid()
  const file:AsyncBuffer={byteLength:stat.size,slice:(start,end)=>read(start,end??stat.size)}
  const {parquetMetadataAsync}=await import('hyparquet')
  const metadata=await parquetMetadataAsync(file,{geoparquet:false})
  const original=metadata.schema.slice(1),names=original.map(c=>dataFileName(c.name))
  if(!names.length||names.length>1000||new Set(names).size!==names.length||metadata.schema[0]?.num_children!==names.length||original.some(c=>c.num_children||!c.type||c.repetition_type==='REPEATED'))throw invalid()
  if(original.some(c=>c.logical_type&&['MAP','LIST','VARIANT','FILE','GEOMETRY','GEOGRAPHY','BSON','INTERVAL'].includes(c.logical_type.type)||['MAP','LIST','BSON','INTERVAL'].includes(c.converted_type||'')))throw invalid()
  if(metadata.num_rows<0n||metadata.num_rows>BigInt(Number.MAX_SAFE_INTEGER))throw invalid()
  let total=0n
  for(const g of metadata.row_groups){
   if(g.num_rows<0n||g.num_rows>1000000n||g.total_byte_size<0n||g.total_byte_size>BigInt(GROUP_BYTES))throw tooLarge()
   total+=g.num_rows
   let uncompressed=0n
   for(const col of g.columns){
    const m=col.meta_data
    if(col.file_path||col.crypto_metadata||col.encrypted_column_metadata||!m||m.path_in_schema.length!==1||!names.includes(m.path_in_schema[0]!)||m.total_uncompressed_size<0n||m.total_compressed_size<0n||m.total_compressed_size>BigInt(GROUP_BYTES))throw invalid()
    uncompressed+=m.total_uncompressed_size
   }
   if(uncompressed>BigInt(GROUP_BYTES))throw tooLarge()
  }
  if(total!==metadata.num_rows)throw invalid()
  // Decode exact DECIMAL/unsigned physical bytes ourselves. The library's
  // default DECIMAL conversion goes through Number and loses precision.
  const decoded={...metadata,schema:metadata.schema.map(c=>isDecimal(c)||isUnsigned64(c)?{...c,converted_type:undefined,logical_type:undefined}:c)}
  return new ParquetRecords(file,decoded,original,signal,metadataMode(metadata))
 }
 fields(){return this.original.map(c=>c.name)}
 async *records(){
  const {parquetReadObjects}=await import('hyparquet')
  const decompress=(fn:(input:Uint8Array,options:{maxOutputLength:number})=>Uint8Array)=>(input:Uint8Array,length:number)=>{
   if(length<0||length>GROUP_BYTES)throw tooLarge()
   return fn(input,{maxOutputLength:Math.max(length,1)})
  }
  const compressors:Compressors={GZIP:decompress(zlib.gunzipSync),BROTLI:decompress(zlib.brotliDecompressSync)}
  if(typeof zlib.zstdDecompressSync==='function')compressors.ZSTD=decompress(zlib.zstdDecompressSync)
  let start=0
  for(const group of this.metadata.row_groups){
   checkAborted(this.signal)
   const end=start+Number(group.num_rows)
   if(end===start)continue
   const values=await parquetReadObjects({file:this.file,metadata:this.metadata,rowStart:start,rowEnd:end,utf8:false,compressors,geoparquet:false,parsers:{
    stringFromBytes:bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),
    jsonFromBytes:bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes),
    dateFromDays:days=>new Date(days*86400000).toISOString().slice(0,10),
    timestampFromMilliseconds:n=>timestamp(n,3),timestampFromMicroseconds:n=>timestamp(n,6),timestampFromNanoseconds:n=>timestamp(n,9)
   }})
   if(values.length!==end-start)throw invalid()
   for(const value of values){checkAborted(this.signal);yield Object.fromEntries(this.original.map((c,i)=>[c.name,normalizedValue(value[c.name],c,this.modes?.[i])]))}
   start=end
  }
 }
}
