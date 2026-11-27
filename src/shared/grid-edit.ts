import type {DatabaseKind,OperationResult,SqlValue,SqlRow,SqlGridEdit,MongoGridEdit} from './types'
import {parseBsonDocument} from './bson-display'
import {childType,typeName} from './bson-types'
import {parseMongoDocumentEditor,canSafelyEditMongoDocument} from './bson-editor'

export interface CellDraft {row:number;field:string;text:string;format?:'ejson'|'extended'}
export interface CellSpec {type:string;text:string}
const own=(value:unknown,key:string):unknown=>value&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined
const numericWrappers:Record<string,string>={Int32:'$numberInt',Int64:'$numberLong',Double:'$numberDouble',Decimal128:'$numberDecimal',ObjectId:'$oid'}
export const cellDraftKey=(row:number,field:string)=>JSON.stringify([row,field])
const safeField=(field:string)=>!!field&&field.length<=200&&!['__proto__','constructor','prototype'].includes(field)&&!field.includes('\0')
const inlineText=(text:string)=>text.length<=4096&&!/[\r\n\t\0]/.test(text)
export function gridCellSpec(result:OperationResult,structure:OperationResult|null,kind:DatabaseKind,keys:string[],row:number,field:string):CellSpec|undefined{
 if(!safeField(field)||!result.columns.includes(field)||!result.rows[row]||!Object.hasOwn(result.rows[row]!,field))return
 if(kind==='mongodb'){
  if(field==='_id')return
  const original=result.documents?.[row],meta=result.bsonTypes?.[row]
  if(!original||!meta||!canSafelyEditMongoDocument(original,meta))return
  const doc=parseBsonDocument(original)
  if(!doc||!Object.hasOwn(doc,'_id')||!Object.hasOwn(doc,field))return
  const type=typeName(childType(meta,field)),value=doc[field]
  let text:unknown
  if(type==='String'||type==='Boolean')text=String(value)
  else if(type==='Date'){
   const ms=Number(own(own(value,'$date'),'$numberLong'))
   if(!Number.isSafeInteger(ms)||Math.abs(ms)>8.64e15)return
   text=new Date(ms).toISOString()
  }else if(Object.hasOwn(numericWrappers,type))text=own(value,numericWrappers[type]!)
  else return
  return typeof text==='string'&&inlineText(text)?{type,text}:undefined
 }
 if(!['mysql','mariadb','sqlite'].includes(kind)||!keys.length||keys.includes(field))return
 const original=result.rawRows?.[row],column=structure?.rows.find(item=>item.name===field||item.Field===field)
 if(!original||!column||keys.some(key=>!Object.hasOwn(original,key)||original[key]===null)||!Object.hasOwn(original,field)||original[field]===null||original[field]===undefined||/GENERATED|HIDDEN/i.test(column.extra||column.Extra||''))return
 const type=kind==='sqlite'?result.sqliteTypes?.[row]?.[result.columns.indexOf(field)]:(column.type||column.Type||'').toUpperCase()
 if(!type||/BLOB|BINARY|GEOMETRY|JSON|BIT|^NULL|UNKNOWN/.test(type))return
 const text=String(original[field])
 return inlineText(text)?{type,text}:undefined
}
export function mongoCellValue(type:string,text:string):unknown{
 if(type==='String')return text
 if(type==='Boolean'){
  if(text==='true')return true
  if(text==='false')return false
  throw new Error('表格编辑值与原始字段类型不匹配。')
 }
 const ctor=type==='Int64'?'Long':type==='Date'?'ISODate':type
 if(!['Int32','Long','Double','Decimal128','ObjectId','ISODate'].includes(ctor))throw new Error('表格编辑值与原始字段类型不匹配。')
 return JSON.parse(parseMongoDocumentEditor('{"v":'+ctor+'('+JSON.stringify(text.trim())+')}')).v
}
export function sqlCellValue(kind:DatabaseKind,type:string,text:string,original:SqlValue):SqlValue{
 const value=text.trim()
 if(kind==='sqlite'){
  if(type==='TEXT')return text
  if(type==='INTEGER'){
   if(!/^-?\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error('表格编辑值与原始字段类型不匹配。')
   return Number(value)
  }
  if(type==='REAL'){
   if(!value||!Number.isFinite(Number(value))||Number.isSafeInteger(Number(value)))throw new Error('表格编辑值与原始字段类型不匹配。')
   return Number(value)
  }
  throw new Error('表格编辑值与原始字段类型不匹配。')
 }
 if(/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|YEAR)\b/i.test(type)){
  if(!/^-?\d+$/.test(value))throw new Error('表格编辑值与原始字段类型不匹配。')
  return typeof original==='number'&&Number.isSafeInteger(Number(value))?Number(value):value
 }
 if(/^(?:DECIMAL|NUMERIC|FIXED)\b/i.test(type)){
  if(!/^-?\d+(?:\.\d+)?$/.test(value))throw new Error('表格编辑值与原始字段类型不匹配。')
  return value
 }
 if(/^(?:FLOAT|DOUBLE|REAL)\b/i.test(type)){
  if(!value||!Number.isFinite(Number(value)))throw new Error('表格编辑值与原始字段类型不匹配。')
  return Number(value)
 }
 if(typeof original==='boolean'){
  if(value==='true'||value==='1')return true
  if(value==='false'||value==='0')return false
  throw new Error('表格编辑值与原始字段类型不匹配。')
 }
 return text
}
export function prepareGridEdits(result:OperationResult,structure:OperationResult|null,kind:DatabaseKind,keys:string[],drafts:CellDraft[]){
 const groups=new Map<number,CellDraft[]>()
 for(const draft of drafts){
  if(!groups.has(draft.row))groups.set(draft.row,[])
  groups.get(draft.row)!.push(draft)
 }
 const rows=[...groups.keys()].sort((a,b)=>a-b),mongoEdits:MongoGridEdit[]=[],sqlEdits:SqlGridEdit[]=[]
 for(const row of rows){
  const items=groups.get(row)!
  if(kind==='mongodb'){
   const original=result.documents?.[row]
   if(!original)throw new Error('表格编辑值与原始字段类型不匹配。')
   const doc=parseBsonDocument(original)!
   for(const draft of items){
    const spec=draft.format?fieldCellSpec(result,structure,kind,keys,row,draft.field):gridCellSpec(result,structure,kind,keys,row,draft.field)
    if(!spec)throw new Error('表格编辑值与原始字段类型不匹配。')
    doc[draft.field]=fieldDraftValue(kind,spec,draft)
   }
   mongoEdits.push({original,document:JSON.stringify(doc)})
  }else{
   const original=result.rawRows?.[row]
   if(!original)throw new Error('表格编辑值与原始字段类型不匹配。')
   const changes:SqlRow=Object.create(null)
   for(const draft of items){
    const spec=draft.format?fieldCellSpec(result,structure,kind,keys,row,draft.field):gridCellSpec(result,structure,kind,keys,row,draft.field)
    if(!spec)throw new Error('表格编辑值与原始字段类型不匹配。')
    changes[draft.field]=fieldDraftValue(kind,spec,draft,original[draft.field]!) as SqlValue
   }
   sqlEdits.push({original:{...original},key:Object.fromEntries(keys.map(key=>[key,original[key]])),changes})
  }
 }
 return {rows,mongoEdits,sqlEdits}
}

/** Extended editors stage the same optimistic-concurrency batch as inline
 * edits. Canonical BSON input is explicit; a typed value must not be inferred
 * from the appearance of a string. */
export function fieldCellSpec(result:OperationResult,structure:OperationResult|null,kind:DatabaseKind,keys:string[],row:number,field:string):CellSpec|undefined{
 const short=gridCellSpec(result,structure,kind,keys,row,field)
 if(short&&kind!=='mongodb')return short
 if(!safeField(field)||!result.columns.includes(field)||!result.rows[row])return
 if(kind==='mongodb'){
  const original=result.documents?.[row],meta=result.bsonTypes?.[row]
  if(field==='_id'||!original||!meta||!canSafelyEditMongoDocument(original,meta))return
  const doc=parseBsonDocument(original)
  if(!doc||!Object.hasOwn(doc,'_id')||!Object.hasOwn(doc,field))return
  return {type:'EJSON',text:JSON.stringify(doc[field],null,2)}
 }
 if(!['mysql','mariadb','sqlite'].includes(kind)||!keys.length||keys.includes(field))return
 const original=result.rawRows?.[row],column=structure?.rows.find(item=>item.name===field||item.Field===field)
 if(!original||!column||keys.some(key=>!Object.hasOwn(original,key)||original[key]===null)||!Object.hasOwn(original,field)||/GENERATED|HIDDEN/i.test(column.extra||column.Extra||''))return
 const type=kind==='sqlite'?result.sqliteTypes?.[row]?.[result.columns.indexOf(field)]:(column.type||column.Type||'').toUpperCase()
 if(!type||/BLOB|BINARY|GEOMETRY|BIT|UNKNOWN/.test(type)||original[field]===null||original[field]===undefined)return
 return {type,text:String(original[field])}
}
export function fieldDraftValue(kind:DatabaseKind,spec:CellSpec,draft:CellDraft,original?:SqlValue):unknown{
 if(draft.format==='ejson'){
  if(kind!=='mongodb')throw new Error('表格编辑值与原始字段类型不匹配。')
  return JSON.parse(draft.text)
 }
 if(kind==='mongodb')return mongoCellValue(spec.type,draft.text)
 if(/^JSON\b/i.test(spec.type))JSON.parse(draft.text)
 return sqlCellValue(kind,spec.type,draft.text,original!)
}
