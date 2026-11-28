import {dataFileName} from '../../shared/file-transfer'
import {checkAborted} from '../operations/common'
import {sqlFileValue} from './records'

const MAX_STATEMENT=32*1024*1024
const invalid=():never=>{throw Error('FILE_TRANSFER: SQL 文件仅支持带字段列表的 INSERT VALUES 数据语句')}
const hexBytes=(text:string)=>{if(text.length%2||!/^[0-9a-f]*$/i.test(text))return invalid();return Buffer.from(text,'hex')}
const identifier=(value:string)=>'\x60'+dataFileName(value).replaceAll('\x60','\x60\x60')+'\x60'
const hex=(value:Buffer)=>"X'"+value.toString('hex').toUpperCase()+"'"
function stringLiteral(value:string,dialect:'mysql'|'sqlite'){
 if(/[\\\x00-\x1f\x7f]/.test(value)){
  const bytes=hex(Buffer.from(value,'utf8'))
  return dialect==='sqlite'?'CAST('+bytes+' AS TEXT)':'CONVERT('+bytes+' USING utf8mb4)'
 }
 return "'"+value.replaceAll("'","''")+"'"
}
export function sqlInsertLine(database:string,entity:string,columns:string[],row:Record<string,unknown>,dialect:'mysql'|'sqlite'){
 const values=columns.map(name=>{
  if(!Object.hasOwn(row,name))return invalid()
  const raw=row[name],value=sqlFileValue(raw)
  if(value===null)return 'NULL'
  if(Buffer.isBuffer(value))return hex(value)
  if(typeof value==='bigint')return value.toString()
  if(typeof value==='number'){
   if(!Number.isFinite(value))return invalid()
   if(dialect==='sqlite'&&raw&&typeof raw==='object'&&Object.hasOwn(raw,'$dbexReal'))return "CAST('"+String(value)+"' AS REAL)"
   return String(value)
  }
  return stringLiteral(value,dialect)
 })
 return 'INSERT INTO '+identifier(database)+'.'+identifier(entity)+' ('+columns.map(identifier).join(', ')+') VALUES ('+values.join(', ')+');\n'
}

/** Never executes SQL. Parses a bounded INSERT statement into typed file rows.
 * Only one table and one column layout are accepted for an import. */
export function parseInsertStatement(text:string){
 let at=0
 const whitespace=()=>{while(/\s/.test(text[at]||' ')&&at<text.length)at++}
 function word(expected:string){
  whitespace();const match=/^[A-Za-z_][\w$]*/.exec(text.slice(at))
  if(!match||match[0].toUpperCase()!==expected)return false
  at+=match[0].length;return true
 }
 function expectWord(expected:string){if(!word(expected))invalid()}
 function take(char:string){whitespace();if(text[at]!==char)return false;at++;return true}
 function expect(char:string){if(!take(char))invalid()}
 function quoted(mark:string):string{
  if(!take(mark))return invalid()
  let value=''
  while(at<text.length){
   const c=text[at++]!
   if(c===mark){if(text[at]===mark){value+=mark;at++;continue}return value}
   // Standard doubled-quote SQL only; ambiguous MySQL backslash escapes
   // are rejected instead of silently changing a file's contents.
   if(c==='\\'||c==='\0')return invalid()
   value+=c
  }
  return invalid()
 }
 function name(){
  whitespace()
  const c=text[at]
  if(c==='\x60'||c==='"')return dataFileName(quoted(c))
  const match=/^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/.exec(text.slice(at))
  if(!match)return invalid()
  at+=match[0].length;return dataFileName(match[0])
 }
 function binary(){
  whitespace()
  if(/^0x[0-9a-f]+/i.test(text.slice(at))){const v=/^0x[0-9a-f]+/i.exec(text.slice(at))![0];at+=v.length;return hexBytes(v.slice(2))}
  expectWord('X');return hexBytes(quoted("'"))
 }
 function value():unknown{
  whitespace()
  if(text[at]==="'")return quoted("'")
  if(word('NULL'))return null
  if(word('TRUE'))return true
  if(word('FALSE'))return false
  if(word('CAST')){
   expect('(');whitespace()
   if(text[at]==="'"){
    const v=quoted("'");expectWord('AS');expectWord('REAL');expect(')')
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)||!Number.isFinite(Number(v)))return invalid()
    return {$dbexReal:v}
   }
   const bytes=binary();expectWord('AS');expectWord('TEXT');expect(')')
   return new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  }
  if(word('CONVERT')){
   expect('(');const bytes=binary();expectWord('USING');expectWord('UTF8MB4');expect(')')
   return new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  }
  if(/^x\s*'|^0x[0-9a-f]+/i.test(text.slice(at)))return {$dbexBinary:binary().toString('base64')}
  const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0]
  if(!numeric||numeric.length>128)return invalid()
  at+=numeric.length
  // Preserve exact integer and decimal source text; target schema and
  // explicit mapping decide conversion. Never round via JSON.parse.
  return /^[+-]?\d+$/.test(numeric)?{$dbexInteger:BigInt(numeric).toString()}:numeric
 }
 expectWord('INSERT');expectWord('INTO')
 const first=name(),table=take('.')?[first,name()]:[first]
 expect('(');const columns:string[]=[]
 do{columns.push(name());if(columns.length>1000)invalid()}while(take(','))
 expect(')')
 if(new Set(columns).size!==columns.length)return invalid()
 expectWord('VALUES')
 function* rows(){
  do{
   expect('(');const values:unknown[]=[]
   for(let i=0;i<columns.length;i++){if(i)expect(',');values.push(value())}
   expect(')')
   yield Object.fromEntries(columns.map((column,index)=>[column,values[index]]))
  }while(take(','))
  whitespace();if(at!==text.length)invalid()
 }
 return {table:JSON.stringify(table),columns,rows:rows()}
}

/** Stream semicolon boundaries, including quoted text and doubled quotes.
 * Ordinary line comments are accepted, executable/block comments are not. */
export async function* sqlDataRecords(chunks:AsyncIterable<string>,signal?:AbortSignal){
 let statement='',quote='',comment=false,carry='',table='',columns:string[]|undefined
 async function* scan(chunk:string,final=false):AsyncGenerator<Record<string,unknown>>{
  const text=carry+chunk,limit=final?text.length:Math.max(0,text.length-1)
  let i=0
  while(i<limit){
   const c=text[i++]!,next=text[i]
   if(comment){if(c==='\r'||c==='\n'){comment=false;statement+=' '}continue}
   if(quote){
    statement+=c
    if(c===quote){if(next===quote){statement+=next;i++}else quote=''}
   }else if(c==="'"||c==='"'||c==='\x60'){statement+=c;quote=c}
   else if(c==='-'&&next==='-'||c==='#'){if(c==='-')i++;comment=true;statement+=' '}
   else if(c==='/'&&next==='*')invalid()
   else if(c===';'){
    if(statement.trim()){
     const parsed=parseInsertStatement(statement)
     if(table&&(parsed.table!==table||JSON.stringify(parsed.columns)!==JSON.stringify(columns)))invalid()
     table=parsed.table;columns=parsed.columns
     for(const row of parsed.rows){checkAborted(signal);yield row}
    }
    statement=''
   }else statement+=c
   if(statement.length>MAX_STATEMENT)invalid()
  }
  carry=text.slice(i)
 }
 for await(const chunk of chunks){checkAborted(signal);yield*scan(chunk)}
 yield*scan('',true)
 if(quote||statement.trim()||!table)invalid()
}
