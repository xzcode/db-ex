import ExcelJS from 'exceljs'
import * as yauzl from 'yauzl'
import {SaxesParser} from 'saxes'
import {createWriteStream} from 'node:fs'
import {mkdtemp,open,rm,type FileHandle} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,posix} from 'node:path'
import {Readable} from 'node:stream'
import {finished} from 'node:stream/promises'
import {checkAborted} from '../operations/common'
import {dataFileName} from '../../shared/file-transfer'

const invalid=():never=>{throw Error('FILE_TRANSFER: Excel 工作簿或单元格格式无效')}
const MAX_COLUMNS=16384,MAX_ROWS=1048576,MAX_CELL=32767
const validCell=(s:string)=>{if(s.length>MAX_CELL||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s))throw Error('FILE_TRANSFER: Excel 单元格超过格式容量或包含无效字符');return s}
const decodeText=(s:string)=>s.replace(/_x([0-9a-f]{4})_/gi,(_,v:string)=>String.fromCharCode(parseInt(v,16)))
const encodeText=(s:string)=>validCell(s).replace(/_x[0-9a-f]{4}_/gi,value=>'_x005F_'+value.slice(1)).replace(/\r/g,'_x000D_')
const significantDigits=(s:string)=>s.replace(/^[+-]/,'').split(/[eE]/)[0]!.replace('.','').replace(/^0+/,'').replace(/0+$/,'').length
const numericCell=(raw:string)=>{
 const value=Number(raw)
 return Number.isFinite(value)&&significantDigits(raw)<=15&&(!Number.isInteger(value)||Number.isSafeInteger(value))?value:raw
}
const textValue=(s:string)=>s==='\\N'?null:s.startsWith('\\\\')?s.slice(1):s
const local=(name:string)=>name.split(':').at(-1)!

// yauzl's fromFd owns the descriptor. A random-access reader instead borrows
// the already identity-checked FileHandle; no reopening the path or extracting ZIP entries.
class BorrowedReader extends yauzl.RandomAccessReader{
 constructor(private readonly file:FileHandle,private readonly signal?:AbortSignal,private readonly bytes?:(n:number)=>void){super()}
 _readStreamForRange(start:number,end:number){
  const {file,signal,bytes}=this
  return Readable.from((async function*(){
   while(start<end){checkAborted(signal);const buffer=Buffer.allocUnsafe(Math.min(64*1024,end-start));const {bytesRead}=await file.read(buffer,0,buffer.length,start);if(!bytesRead)invalid();start+=bytesRead;bytes?.(bytesRead);yield buffer.subarray(0,bytesRead)}
  })())
 }
 close(callback:(error:Error|null)=>void){callback(null)}
}
type XmlEvent={kind:'open'|'close';name:string;attributes:Record<string,string>}|{kind:'text';text:string}
async function* xmlEvents(zip:yauzl.ZipFile,entry:yauzl.Entry,signal?:AbortSignal){
 checkAborted(signal)
 const stream=await new Promise<Readable>((resolve,reject)=>zip.openReadStream(entry,(err,value)=>err?reject(err):resolve(value)))
 const decoder=new TextDecoder('utf-8',{fatal:true}),parser=new SaxesParser({xmlns:false}),queue:XmlEvent[]=[]
 parser.on('doctype',()=>invalid());parser.on('error',()=>invalid())
 parser.on('opentag',tag=>queue.push({kind:'open',name:local(tag.name),attributes:tag.attributes}))
 parser.on('closetag',tag=>queue.push({kind:'close',name:local(tag.name),attributes:tag.attributes}))
 parser.on('text',text=>queue.push({kind:'text',text}));parser.on('cdata',text=>queue.push({kind:'text',text}))
 const abort=()=>stream.destroy(Error('CANCELLED: 操作已取消'));signal?.addEventListener('abort',abort,{once:true})
 try{
  for await(const chunk of stream){checkAborted(signal);parser.write(decoder.decode(chunk,{stream:true}));for(const event of queue.splice(0))yield event}
  parser.write(decoder.decode()).close();for(const event of queue.splice(0))yield event
 }finally{signal?.removeEventListener('abort',abort);stream.destroy()}
}
async function readExact(handle:FileHandle,size:number,position:number){
 const buffer=Buffer.allocUnsafe(size);let offset=0
 while(offset<size){const {bytesRead}=await handle.read(buffer,offset,size-offset,position+offset);if(!bytesRead)invalid();offset+=bytesRead}
 return buffer
}
/** Small shared-string tables stay in memory; large ones spill to a private
 * indexed disk file instead of growing a main-process array without bound. */
class SharedStrings{
 private memory:string[]=[]
 private bytes=0
 private count=0
 private folder?:string
 private data?:FileHandle
 private index?:FileHandle
 private position=0
 async add(value:string){
  validCell(value);const buffer=Buffer.from(value,'utf8')
  if(!this.data&&this.bytes+buffer.length+32<=16*1024*1024){this.memory.push(value);this.bytes+=buffer.length+32;this.count++;return}
  if(!this.data){
   this.folder=await mkdtemp(join(tmpdir(),'.dbex-xlsx-strings-'))
   this.data=await open(join(this.folder,'data'),'wx+',0o600)
   this.index=await open(join(this.folder,'index'),'wx+',0o600)
   for(const previous of this.memory)await this.append(Buffer.from(previous,'utf8'))
   this.memory=[]
  }
  await this.append(buffer);this.count++
 }
 private async append(buffer:Buffer){
  const info=Buffer.allocUnsafe(12);info.writeBigUInt64LE(BigInt(this.position));info.writeUInt32LE(buffer.length,8)
  await this.index!.writeFile(info);await this.data!.writeFile(buffer);this.position+=buffer.length
 }
 async get(index:number){
  if(!Number.isSafeInteger(index)||index<0||index>=this.count)return invalid()
  if(!this.data)return this.memory[index]!
  const info=await readExact(this.index!,12,index*12),position=Number(info.readBigUInt64LE()),size=info.readUInt32LE(8)
  return (await readExact(this.data,size,position)).toString('utf8')
 }
 async close(){await this.data?.close().catch(()=>{});await this.index?.close().catch(()=>{});if(this.folder)await rm(this.folder,{recursive:true,force:true})}
}
type Sheet={name:string;path:string}
type DateKind='date'|'time'|'datetime'
const formatKind=(id:number,format?:string):DateKind|undefined=>{
 if(id>=14&&id<=17)return 'date'
 if(id>=18&&id<=21||id===45||id===47)return 'time'
 if(id===22)return 'datetime'
 if(!format||/\[[hms]+\]/i.test(format))return
 const plain=format.replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g,'').toLowerCase()
 const date=/[yd]/.test(plain),time=/[hs]|am\/pm/.test(plain)
 return date&&time?'datetime':date?'date':time?'time':undefined
}
function dateSerial(value:number,kind:DateKind,date1904:boolean){
 if(!Number.isFinite(value)||value<0)return invalid()
 let whole=Math.floor(value),ms=Math.round((value-whole)*86400000)
 if(ms>=86400000){if(kind==='datetime')whole++;ms=0}
 const time=new Date(ms).toISOString().slice(11,23).replace(/\.000$/,'')
 if(kind==='time')return time
 // Excel's 1900 date system includes the fictitious leap day. Preserve its
 // displayed text rather than silently shifting it to a different day.
 const day=!date1904&&whole===60?'1900-02-29':new Date(Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:31)+(whole-(!date1904&&whole>60?1:0))*86400000).toISOString().slice(0,10)
 return kind==='date'?day:day+' '+time
}
const colNumber=(ref:string)=>{
 const match=/^([A-Z]{1,3})[1-9]\d*$/i.exec(ref);if(!match)return invalid()
 let n=0;for(const c of match[1]!.toUpperCase())n=n*26+c.charCodeAt(0)-64
 if(n<1||n>MAX_COLUMNS)return invalid();return n-1
}
export class XlsxRecords{
 private entries=new Map<string,yauzl.Entry>()
 private sheets:Sheet[]=[]
 private sharedPath?:string
 private stylesPath?:string
 private date1904=false
 private shared=new SharedStrings()
 private styles:(DateKind|undefined)[]=[]
 private loaded=false
 private constructor(private readonly zip:yauzl.ZipFile,private readonly signal?:AbortSignal){}
 static async open(file:FileHandle,signal?:AbortSignal,onBytes?:(n:number)=>void){
  const stat=await file.stat(),reader=new BorrowedReader(file,signal,onBytes)
  const zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.fromRandomAccessReader(reader,stat.size,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true},(err,value)=>err?reject(err):resolve(value)))
  const workbook=new XlsxRecords(zip,signal)
  try{await workbook.initialize();return workbook}catch(e){await workbook.close();throw e}
 }
 private events(path:string){
  const entry=this.entries.get(path)
  if(!entry||entry.isEncrypted())return invalid()
  return xmlEvents(this.zip,entry,this.signal)
 }
 private async initialize(){
  await new Promise<void>((resolve,reject)=>{
   this.zip.on('error',reject);this.zip.once('end',resolve)
   this.zip.on('entry',(entry:yauzl.Entry)=>{
    try{checkAborted(this.signal);if(this.entries.has(entry.fileName))return invalid();this.entries.set(entry.fileName,entry);this.zip.readEntry()}catch(e){reject(e)}
   })
   this.zip.readEntry()
  })
  const relationships=new Map<string,{path:string;type:string}>()
  for await(const event of this.events('xl/_rels/workbook.xml.rels')){
   if(event.kind!=='open'||event.name!=='Relationship')continue
   const {Id,Type,Target,TargetMode}=event.attributes
   if(!Id||!Type||!Target||TargetMode==='External')continue
   const path=posix.normalize(Target.startsWith('/')?Target.slice(1):posix.join('xl',Target))
   if(path.startsWith('../')||path.includes('\\')||path.includes('\0'))return invalid()
   relationships.set(Id,{path,type:Type.split('/').at(-1)!})
  }
  for await(const event of this.events('xl/workbook.xml')){
   if(event.kind!=='open')continue
   if(event.name==='workbookPr')this.date1904=['1','true'].includes(event.attributes.date1904||'')
   if(event.name==='sheet'){
    const name=event.attributes.name,id=event.attributes['r:id']||event.attributes[Object.keys(event.attributes).find(k=>k.endsWith(':id'))||'']
    const rel=id?relationships.get(id):undefined
    if(rel?.type==='worksheet'&&name){if(name.length>31||/[\u0000-\u001f]/.test(name))return invalid();if(this.sheets.some(s=>s.name===name)||!this.entries.has(rel.path))return invalid();this.sheets.push({name,path:rel.path})}
   }
  }
  this.sharedPath=[...relationships.values()].find(r=>r.type==='sharedStrings')?.path
  this.stylesPath=[...relationships.values()].find(r=>r.type==='styles')?.path
  if(!this.sheets.length)return invalid()
 }
 selection(value?:string){
  const selected=value??this.sheets[0]!.name
  if(selected!=='*'&&!this.sheets.some(sheet=>sheet.name===selected))return invalid()
  return {worksheet:selected,worksheets:this.sheets.map(s=>s.name)}
 }
 private async loadMetadata(){
  if(this.loaded)return;this.loaded=true
  if(this.sharedPath){
   let current='',inItem=false,inText=false,phonetic=0
   for await(const event of this.events(this.sharedPath)){
    if(event.kind==='open'){
     if(event.name==='si'){inItem=true;current=''}
     if(event.name==='rPh')phonetic++
     if(event.name==='t'&&inItem&&!phonetic)inText=true
    }else if(event.kind==='text'&&inText){current+=event.text;if(current.length>MAX_CELL*8)invalid()}
    else if(event.kind==='close'){
     if(event.name==='t')inText=false
     if(event.name==='rPh')phonetic--
     if(event.name==='si'){await this.shared.add(decodeText(current));inItem=false}
    }
   }
  }
  if(this.stylesPath){
   const custom=new Map<number,string>();let inside=false
   for await(const event of this.events(this.stylesPath)){
    if(event.kind==='open'){
     if(event.name==='numFmt')custom.set(Number(event.attributes.numFmtId),event.attributes.formatCode||'')
     if(event.name==='cellXfs')inside=true
     if(inside&&event.name==='xf'){const id=Number(event.attributes.numFmtId||0);this.styles.push(formatKind(id,custom.get(id)))}
    }else if(event.kind==='close'&&event.name==='cellXfs')inside=false
   }
  }
 }
 private async *sheetRows(sheet:Sheet):AsyncGenerator<unknown[]>{
  let row:unknown[]|undefined,cell:{column:number;type:string;style:number;raw:string;inline:string;formula:boolean}|undefined,inValue=false,inText=false,phonetic=0
  for await(const event of this.events(sheet.path)){
   if(event.kind==='open'){
    if(event.name==='row'){row=[]}
    if(event.name==='c'&&row){if(cell)invalid();cell={column:event.attributes.r?colNumber(event.attributes.r):row.length,type:event.attributes.t||'n',style:Number(event.attributes.s||0),raw:'',inline:'',formula:false}}
    if(cell&&event.name==='v')inValue=true
    if(cell&&event.name==='rPh')phonetic++
    if(cell&&event.name==='t'&&!phonetic)inText=true
    if(cell&&event.name==='f')cell.formula=true
   }else if(event.kind==='text'&&cell){
    if(inValue)cell.raw+=event.text
    if(inText)cell.inline+=event.text
    if(cell.raw.length+cell.inline.length>MAX_CELL*8)invalid()
   }else if(event.kind==='close'){
    if(event.name==='v')inValue=false
    if(event.name==='t')inText=false
    if(event.name==='rPh'&&cell)phonetic--
    if(event.name==='c'&&cell&&row){
     if(cell.formula)throw Error('FILE_TRANSFER: Excel 导入不执行公式，请先将公式转换为值')
     let value:unknown=null
     if(cell.type==='s'){if(!/^\d+$/.test(cell.raw))invalid();value=textValue(await this.shared.get(Number(cell.raw)))}
     else if(cell.type==='inlineStr'||cell.type==='str')value=textValue(validCell(decodeText(cell.type==='inlineStr'?cell.inline:cell.raw)))
     else if(cell.type==='b'){if(!['0','1'].includes(cell.raw))invalid();value=cell.raw==='1'}
     else if(cell.type==='d')value=validCell(cell.raw)
     else if(cell.type==='e')throw Error('FILE_TRANSFER: Excel 导入不支持错误值单元格')
     else if(cell.type==='n'&&cell.raw){
      if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cell.raw))invalid()
      const number=Number(cell.raw),style=this.styles[cell.style]
      value=style?dateSerial(number,style,this.date1904):numericCell(cell.raw)
     }else if(cell.type!=='n')invalid()
     if(cell.column>=MAX_COLUMNS||Object.hasOwn(row,cell.column))invalid()
     row[cell.column]=value;cell=undefined;inText=false;inValue=false;phonetic=0
    }
    if(event.name==='row'&&row){yield row;row=undefined}
   }
  }
 }
 private headerFields(row:unknown[]){
  const headers=Array.from(row,v=>typeof v==='string'?dataFileName(v):invalid())
  if(new Set(headers).size!==headers.length)invalid()
  return headers
 }
 private async validateHeaders(sheets:Sheet[]){
  let expected:string[]|undefined
  for(const sheet of sheets){
   for await(const row of this.sheetRows(sheet)){
    if(!row.length||row.every(v=>v===null||v===undefined))continue
    const headers=this.headerFields(row)
    if(expected&&JSON.stringify(expected)!==JSON.stringify(headers))throw Error('FILE_TRANSFER: 所选 Excel 工作表的表头不一致')
    expected=headers;break
   }
  }
 }
 async *records(selection?:string){
  const {worksheet}=this.selection(selection)
  await this.loadMetadata()
  const sheets=this.sheets.filter(s=>worksheet==='*'||s.name===worksheet)
  if(worksheet==='*')await this.validateHeaders(sheets)
  let expected:string[]|undefined
  for(const sheet of sheets){
   let headers:string[]|undefined
   for await(const row of this.sheetRows(sheet)){
    checkAborted(this.signal)
    // Ignore physically blank rows, not rows containing exported NULL markers.
    if(!row.length||!headers&&row.every(v=>v===null||v===undefined))continue
    if(!headers){
     headers=this.headerFields(row)
     if(expected&&JSON.stringify(expected)!==JSON.stringify(headers))throw Error('FILE_TRANSFER: 所选 Excel 工作表的表头不一致')
     expected=headers;continue
    }
    if(row.slice(headers.length).some(v=>v!==null&&v!==undefined))invalid()
    yield Object.fromEntries(headers.map((h,i)=>[h,row[i]??null]))
   }
  }
 }
 async close(){this.zip.close();await this.shared.close()}
}

function excelCell(value:unknown):ExcelJS.CellValue{
 if(value===null||value===undefined)return '\\N'
 if(typeof value==='boolean')return value
 if(typeof value==='number'){
  if(!Number.isFinite(value))return invalid()
  return significantDigits(String(value))>15||Number.isInteger(value)&&Math.abs(value)>=1e15?String(value):value
 }
 if(value&&typeof value==='object'){
  const row=value as Record<string,unknown>
  if(typeof row.$dbexInteger==='string'){const number=Number(row.$dbexInteger);return Number.isSafeInteger(number)&&Math.abs(number)<1e15?number:validCell(row.$dbexInteger)}
  if(typeof row.$dbexReal==='string'){const number=Number(row.$dbexReal);if(!Number.isFinite(number))return invalid();return Math.abs(number)>=1e15||significantDigits(row.$dbexReal)>15?validCell(row.$dbexReal):number}
  if(typeof row.$dbexBinary==='string')return validCell('base64:'+row.$dbexBinary)
  value=JSON.stringify(value)
 }
 if(typeof value!=='string')return invalid()
 return encodeText(value.startsWith('\\')?'\\'+value:value)
}
export async function writeXlsxRecords(path:string,columns:string[],rows:AsyncIterable<Record<string,unknown>>,signal:AbortSignal,progress:(bytes:number)=>void){
 if(!columns.length||columns.length>MAX_COLUMNS)invalid()
 const output=createWriteStream(path,{flags:'wx',mode:0o600}),completion=finished(output)
 let streamError:unknown
 void completion.catch(e=>{streamError=e})
 const workbook=new ExcelJS.stream.xlsx.WorkbookWriter({stream:output,useSharedStrings:false,useStyles:false})
 workbook.creator='DB EX'
 const archiver=(workbook as unknown as {zip?:{abort():void}}).zip
 const abort=()=>{archiver?.abort();output.destroy(Error('CANCELLED: 操作已取消'))}
 signal.addEventListener('abort',abort,{once:true})
 let number=0,rowCount=0,committed=false
 let sheet:ExcelJS.Worksheet
 function nextSheet(){
  if(number)sheet.commit()
  sheet=workbook.addWorksheet('Data '+(++number))
  sheet.addRow(columns.map(c=>excelCell(dataFileName(c)))).commit();rowCount=1
 }
 try{
  checkAborted(signal);nextSheet()
  for await(const row of rows){
   checkAborted(signal);if(streamError)throw streamError
   if(rowCount>=MAX_ROWS)nextSheet()
   sheet!.addRow(columns.map(c=>excelCell(Object.hasOwn(row,c)?row[c]:null))).commit()
   rowCount++;progress(output.bytesWritten)
  }
  sheet!.commit()
  await Promise.race([workbook.commit(),completion]);await completion
  checkAborted(signal);committed=true
 }finally{
  signal.removeEventListener('abort',abort)
  if(!committed){archiver?.abort();output.destroy();await completion.catch(()=>{})}
 }
}
