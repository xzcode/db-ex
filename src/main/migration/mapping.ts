import {BSON} from 'mongodb'
import type {DatabaseKind} from '../../shared/types'
import type {MigrationField,MigrationFieldMap,MigrationObjectMap,MigrationRequest,MigrationStep} from '../../shared/migration'
import {dataFileName} from '../../shared/file-transfer'
import {compileSqlBrowsePredicate} from '../../shared/sql-browse-predicate'
import {compileMysqlFilter,newBrowseFilter,type BrowseFilter} from '../../shared/browse-filter'
import {sqlFileValue} from '../file-transfer/records'
import {validateReadDocument} from '../operations/mongodb'
import {sqlMigrationCondition,migrationBrowseFilter} from './condition'
import {mongoMigrationFilter} from './mongo-condition'
import {mysqlUpsertKeys,type SchemaObject,type SchemaSnapshot} from './mysql-schema'
import {sqliteShape,sqliteUpsertKeys} from './sqlite-shape'
import {MysqlMigrationEndpoint} from './mysql-endpoint'
import {SqliteMigrationEndpoint} from './sqlite-endpoint'
import {MongoMigrationEndpoint} from './mongo-endpoint'
import {ClickHouseMigrationEndpoint} from './clickhouse-endpoint'
import {RedisMigrationEndpoint} from './redis-endpoint'
import type {MigrationEndpoint,CopyCallbacks} from './endpoint'
import {requireActive,reviewStep} from './endpoint'

const invalid=()=>new Error('MIGRATION_TYPE: 无法无损传输该字段值')
const mappingError=(message='字段或对象映射无效')=>new Error('MIGRATION_MAPPING: '+message)
const ordinary=(object?:SchemaObject)=>!!object&&!object.triggerNames.length&&!object.shape?.foreignKeys?.length&&(object.shape?.safe===true||(object.details as {safe?:boolean}|undefined)?.safe===true)
const relational=(kind:DatabaseKind)=>['mysql','mariadb','sqlite'].includes(kind)
const bsonName=(s:string)=>{dataFileName(s);if(s.includes('.')||s.startsWith('$'))throw mappingError();return s}
export function mappingFields(kind:DatabaseKind,object:SchemaObject):MigrationField[]{
 if(kind==='sqlite'){
  const shape=sqliteShape(object)
  return (shape?.fields||[]).map(f=>({name:f.name,type:f.type,nullable:!f.notnull&&!f.pk,required:!!f.pk||f.notnull&&f.defaultValue===null,primary:!!f.pk}))
 }
 if(kind==='mysql'||kind==='mariadb'){
  const keys=mysqlUpsertKeys(object.shape)||[]
  return (object.shape?.columns||[]).map(c=>{
   let meta:unknown[]|undefined
   try{if(c.semantic)meta=JSON.parse(c.semantic)}catch{}
   const type=typeof meta?.[0]==='string'?meta[0]:c.definition.replace(/^\x60(?:[^\x60]|\x60\x60)+\x60\s+/,'').split(/\s+(?:NOT NULL|NULL|DEFAULT|AUTO_INCREMENT|COMMENT|COLLATE|CHARACTER SET)/i)[0]!
   const nullable=meta?meta[1]==='YES':!/\bNOT NULL\b/i.test(c.definition)
   return {name:c.name,type,nullable,required:keys.includes(c.name)||!nullable&&(meta?meta[2]==null&&!String(meta[3]).includes('auto_increment'):!/\bDEFAULT\b|\bAUTO_INCREMENT\b/i.test(c.definition)),primary:keys.includes(c.name)}
  })
 }
 if(kind==='clickhouse')return ((object.details as {columns?:{name:string;type:string}[]}|undefined)?.columns||[]).map(f=>({...f,nullable:f.type.startsWith('Nullable('),required:!f.type.startsWith('Nullable(')}))
 return []
}

type Atom={kind:'null'}|{kind:'integer';value:bigint}|{kind:'decimal'|'text'|'oid'|'date';value:string}|{kind:'double';value:number}|{kind:'boolean';value:boolean}|{kind:'binary';value:Buffer;subtype?:string}|{kind:'ejson';value:unknown}
const signed64=(n:bigint)=>n>=-(1n<<63n)&&n<(1n<<63n)
const finite=(v:unknown)=>{const n=typeof v==='number'?v:typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)?Number(v):NaN;if(!Number.isFinite(n))throw invalid();return n}
const integer=(v:string)=>{if(v.length>200||!/^[-+]?\d+$/.test(v))throw invalid();return BigInt(v)}
const decimal=(v:string)=>{
 const m=/^([-+]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v)
 if(!m||v.length>500)throw invalid()
 const shift=Number(m[4]||0),digits=m[2]!+(m[3]||''),point=m[2]!.length+shift
 if(!Number.isSafeInteger(shift)||Math.abs(shift)>500||digits.length>500||point>500||point< -500)throw invalid()
 const sign=m[1]==='-'?'-':''
 if(point<=0)return sign+'0.'+'0'.repeat(-point)+digits
 if(point>=digits.length)return sign+digits+'0'.repeat(point-digits.length)
 return sign+digits.slice(0,point)+'.'+digits.slice(point)
}
const binary=(v:string)=>{if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))throw invalid();const b=Buffer.from(v,'base64');if(b.toString('base64')!==v)throw invalid();return b}
const utf8=(v:Buffer)=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(v)}catch{throw invalid()}}
const bareType=(value:string)=>value.replace(/^Nullable\((.*)\)$/i,'$1').trim().toUpperCase()
const intType=(type:string)=>/^(?:U?INT(?:8|16|32|64|128|256)?|INTEGER|TINYINT|SMALLINT|MEDIUMINT|BIGINT|YEAR)(?:\(\d+\))?(?: UNSIGNED)?(?: ZEROFILL)?$/i.test(type)
const decimalType=(type:string)=>/^(?:DECIMAL|NUMERIC)(?:\(|$)/i.test(type)
const doubleType=(type:string)=>/^(?:FLOAT(?:32|64)?|DOUBLE(?: PRECISION)?|REAL)(?:\([^)]*\))?(?: UNSIGNED)?$/i.test(type)
const binaryType=(type:string)=>/^(?:BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY(?:\(\d+\))?|VARBINARY\(\d+\)|BIT(?:\(\d+\))?|FIXEDSTRING\(\d+\))$/i.test(type)
const textType=(type:string)=>/^(?:TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CLOB|CHAR(?:\(\d+\))?|VARCHAR(?:\(\d+\))?|STRING|JSON|ENUM\(|SET\()/i.test(type)
const temporalType=(type:string)=>/^(?:DATE(?:32)?|DATETIME(?:64)?|TIMESTAMP|TIME)(?:\([^)]*\))?$/i.test(type)
function atom(value:unknown,kind:DatabaseKind,fieldType:string):Atom{
 if(value===null)return {kind:'null'}
 if(kind==='mongodb'){
  if(typeof value==='string')return {kind:'text',value}
  if(typeof value==='boolean')return {kind:'boolean',value}
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   const v=value as Record<string,unknown>
   if(Object.keys(v).length===1){
    if(typeof v.$numberInt==='string'||typeof v.$numberLong==='string')return {kind:'integer',value:integer(String(v.$numberInt??v.$numberLong))}
    if(typeof v.$numberDecimal==='string')return {kind:'decimal',value:decimal(v.$numberDecimal)}
    if(typeof v.$numberDouble==='string')return {kind:'double',value:finite(v.$numberDouble)}
    if(typeof v.$oid==='string')return {kind:'oid',value:v.$oid}
    if(v.$date&&typeof v.$date==='object'&&typeof (v.$date as {$numberLong?:unknown}).$numberLong==='string'){
     const millis=integer((v.$date as {$numberLong:string}).$numberLong),date=new Date(Number(millis))
     if(!Number.isSafeInteger(Number(millis))||!Number.isFinite(date.getTime()))throw invalid()
     return {kind:'date',value:date.toISOString()}
    }
    if(v.$binary&&typeof v.$binary==='object'){
     const b=v.$binary as {base64?:string;subType?:string}
     if(typeof b.base64!=='string'||typeof b.subType!=='string'||!/^[0-9a-f]{2}$/i.test(b.subType))throw invalid()
     return {kind:'binary',value:binary(b.base64),subtype:b.subType}
    }
   }
  }
  return {kind:'ejson',value}
 }
 const type=bareType(fieldType),v=sqlFileValue(value)
 if(v===null)return {kind:'null'}
 if(Buffer.isBuffer(v))return {kind:'binary',value:v}
 if(typeof v==='bigint')return {kind:'integer',value:v}
 if(typeof value==='boolean')return {kind:'boolean',value}
 if(kind!=='sqlite'&&intType(type))return {kind:'integer',value:integer(String(v))}
 if(kind!=='sqlite'&&decimalType(type))return {kind:'decimal',value:decimal(String(v))}
 if(kind!=='sqlite'&&type==='BOOL'||kind!=='sqlite'&&type==='BOOLEAN')return {kind:'boolean',value:String(v)==='1'||String(v)==='true'}
 if(typeof v==='number'||kind!=='sqlite'&&doubleType(type))return {kind:'double',value:finite(v)}
 return {kind:'text',value:String(v)}
}
function atomText(a:Atom):string{
 switch(a.kind){case 'integer':case 'decimal':case 'text':case 'oid':case 'date':return String(a.value)
 case 'double':return String(a.value);case 'boolean':return a.value?'true':'false';case 'binary':return utf8(a.value)
 default:throw invalid()}
}
function asEjson(a:Atom):unknown{
 switch(a.kind){
 case 'null':return null
 case 'integer':return signed64(a.value)?{$numberLong:a.value.toString()}:BSON.EJSON.serialize(BSON.Decimal128.fromString(a.value.toString()),{relaxed:false})
 case 'decimal':return BSON.EJSON.serialize(BSON.Decimal128.fromString(a.value),{relaxed:false})
 case 'double':return {$numberDouble:Object.is(a.value,-0)?'-0.0':String(a.value)}
 case 'text':case 'boolean':return a.value
 case 'oid':return {$oid:a.value}
 case 'date':return {$date:{$numberLong:String(new Date(a.value).getTime())}}
 case 'binary':return {$binary:{base64:a.value.toString('base64'),subType:a.subtype||'00'}}
 case 'ejson':return a.value
 }
}
function convert(a:Atom,conversion:MigrationFieldMap['conversion']):Atom{
 if(a.kind==='null'||conversion==='auto')return a
 if(conversion==='ejson'){
  if(a.kind!=='text')return {kind:'ejson',value:asEjson(a)}
  const parsed=JSON.parse(a.value)
  const validate=(v:unknown,depth=0):void=>{if(depth>64||typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw invalid();if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw invalid();validate(x,depth+1)}}
  validate(parsed);return {kind:'ejson',value:parsed}
 }
 const text=()=>atomText(a)
 switch(conversion){
 case 'text':return {kind:'text',value:text()}
 case 'integer':return {kind:'integer',value:a.kind==='boolean'?(a.value?1n:0n):integer(text())}
 case 'decimal':return {kind:'decimal',value:a.kind==='boolean'?(a.value?'1':'0'):decimal(text())}
 case 'double':return {kind:'double',value:a.kind==='boolean'?(a.value?1:0):finite(text())}
 case 'boolean':{const value=text().toLowerCase();if(!['0','1','true','false'].includes(value))throw invalid();return {kind:'boolean',value:value==='1'||value==='true'}}
 case 'binary':return a.kind==='binary'?a:{kind:'binary',value:a.kind==='text'&&a.value.startsWith('base64:')?binary(a.value.slice(7)):Buffer.from(text(),'utf8')}
 case 'objectId':{const value=text();if(!/^[0-9a-f]{24}$/i.test(value))throw invalid();return {kind:'oid',value:value.toLowerCase()}}
 }
}
function intRange(type:string,kind:DatabaseKind,n:bigint){
 let bits=64,unsigned=false
 if(kind==='clickhouse'){const match=/^(U?)INT(8|16|32|64|128|256)$/.exec(type);if(!match)throw invalid();unsigned=!!match[1];bits=Number(match[2])}
 else if(kind!=='sqlite'){
  bits=/^TINYINT/.test(type)?8:/^SMALLINT/.test(type)?16:/^MEDIUMINT/.test(type)?24:/^BIGINT/.test(type)?64:32
  unsigned=/\bUNSIGNED\b/.test(type)
 }
 const min=unsigned?0n:-(1n<<BigInt(bits-1)),max=(1n<<BigInt(unsigned?bits:bits-1))-1n
 if(n<min||n>max)throw invalid()
}
function checkDecimal(type:string,value:string){
 const match=/^(?:DECIMAL|NUMERIC)\((\d+),\s*(\d+)\)/.exec(type)
 if(!match)throw invalid()
 const [whole,fraction='']=value.replace(/^[-+]/,'').split('.')
 const precision=Number(match[1]),scale=Number(match[2])
 if(whole!.replace(/^0+/,'').length>precision-scale||fraction.replace(/0+$/,'').length>scale||type.includes('UNSIGNED')&&value.startsWith('-'))throw invalid()
}
function sqlTarget(a:Atom,field:MigrationField,kind:DatabaseKind,conversion:MigrationFieldMap['conversion']):unknown{
 if(a.kind==='null'){if(field.nullable===false)throw invalid();return null}
 const type=bareType(field.type)
 if(kind==='sqlite'&&(type===''||type==='BLOB')){
  if(a.kind==='binary'&&(a.subtype===undefined||a.subtype==='00'))return {$dbexBinary:a.value.toString('base64')}
  if(type==='BLOB')throw invalid()
  if(a.kind==='integer'){intRange('INTEGER',kind,a.value);return {$dbexInteger:a.value.toString()}}
  if(a.kind==='double')return {$dbexReal:String(a.value)}
  if(a.kind==='text')return a.value
  if(a.kind==='boolean')return {$dbexInteger:a.value?'1':'0'}
  throw invalid()
 }
 if(intType(type)||type==='BOOL'||type==='BOOLEAN'){
  const n=a.kind==='integer'?a.value:a.kind==='boolean'?(a.value?1n:0n):undefined
  if(n===undefined)throw invalid()
  if(type==='BOOL'||type==='BOOLEAN'){if(n!==0n&&n!==1n)throw invalid()}
  else intRange(type,kind,n)
  return {$dbexInteger:n.toString()}
 }
 if(decimalType(type)){
  // SQLite NUMERIC affinity stores non-integer decimal values as binary64.
  // Use an explicit text column for an exact decimal migration to SQLite.
  if(kind==='sqlite')throw invalid()
  const value=a.kind==='decimal'?a.value:a.kind==='integer'?a.value.toString():undefined
  if(value===undefined)throw invalid()
  checkDecimal(type,value);return value
 }
 if(doubleType(type)){
  if(a.kind!=='double')throw invalid()
  if(conversion!=='double'&&(/^(FLOAT32|FLOAT$|FLOAT\()/.test(type))&&Math.fround(a.value)!==a.value)throw invalid()
  if(/UNSIGNED/.test(type)&&a.value<0)throw invalid()
  return {$dbexReal:String(a.value)}
 }
 if(binaryType(type)||kind==='clickhouse'&&type==='STRING'){
  if(a.kind==='binary'&&(a.subtype===undefined||a.subtype==='00')){
   const fixed=/^(?:BINARY|FIXEDSTRING)\((\d+)\)$/.exec(type),variable=/^VARBINARY\((\d+)\)$/.exec(type)
   if(fixed&&a.value.length!==Number(fixed[1])||variable&&a.value.length>Number(variable[1]))throw invalid()
   return {$dbexBinary:a.value.toString('base64')}
  }
  if(kind==='clickhouse'&&type==='STRING'&&a.kind==='text')return {$dbexBinary:Buffer.from(a.value,'utf8').toString('base64')}
  throw invalid()
 }
 if(temporalType(type)){
  if(a.kind!=='text'&&a.kind!=='date')throw invalid()
  const value=a.kind==='date'?a.value.replace('T',' ').replace(/Z$/,''):a.value
  const fraction=/\.(\d+)$/.exec(value)?.[1]||'',scale=Number(/\((\d+)/.exec(type)?.[1]||0)
  if(fraction.replace(/0+$/,'').length>scale)throw invalid()
  if(kind==='sqlite')throw invalid() // use TEXT rather than affinity conversion
  return value
 }
 if(textType(type)||kind==='clickhouse'&&['UUID','IPV4','IPV6'].includes(type)){
  if(a.kind==='ejson'&&(conversion==='ejson'||type==='JSON'))return JSON.stringify(a.value)
  if(a.kind!=='text'&&a.kind!=='oid')throw invalid()
  if(type==='JSON'){JSON.parse(a.value)}
  if(kind!=='sqlite'&&/^CHAR\(/.test(type)&&a.value.endsWith(' '))throw invalid()
  const size=/^(?:CHAR|VARCHAR)\((\d+)\)$/.exec(type)
  if(size&&kind!=='sqlite'&&[...a.value].length>Number(size[1]))throw invalid()
  return a.value
 }
 throw invalid()
}
export function mappedCell(value:unknown,sourceKind:DatabaseKind,sourceType:string,targetKind:DatabaseKind,target:MigrationField,conversion:MigrationFieldMap['conversion']):unknown{
 // Preserve an unchanged canonical BSON value byte-for-byte, including
 // types that have no scalar equivalent; the write endpoint validates EJSON.
 if(sourceKind==='mongodb'&&targetKind==='mongodb'&&conversion==='auto')return value
 const a=convert(atom(value,sourceKind,sourceType),conversion)
 if(targetKind==='mongodb')return asEjson(a)
 return sqlTarget(a,target,targetKind,conversion)
}

function filterFor(mapping:MigrationObjectMap,request:MigrationRequest,sourceKind:DatabaseKind,sourceFields:MigrationField[]){
 if(mapping.predicate){
  if(!relational(sourceKind))throw mappingError('SQL 条件仅支持关系型源')
  compileSqlBrowsePredicate(mapping.predicate,sourceKind==='sqlite'?'sqlite':'mysql')
  const filter={...newBrowseFilter(),raw:mapping.predicate}
  compileMysqlFilter(request.source.database,mapping.source,filter,sourceKind==='sqlite'?'sqlite':'mysql')
  return filter
 }
 if(mapping.mongoFilter!==undefined){
  if(sourceKind!=='mongodb')throw mappingError('EJSON 条件仅支持 MongoDB 源')
  const filter=BSON.EJSON.parse(mapping.mongoFilter,{relaxed:false})
  if(!filter||typeof filter!=='object'||Array.isArray(filter))throw mappingError()
  validateReadDocument(filter)
  return mapping.mongoFilter
 }
 if(request.condition){
  if(sourceKind==='mongodb')return BSON.EJSON.stringify(mongoMigrationFilter(request.condition),{relaxed:false})
  if(sourceKind==='clickhouse'){
   if(request.condition.operator!=='eq'||!sourceFields.some(f=>f.name===request.condition!.field))throw mappingError('ClickHouse 源仅支持等值筛选')
   return {field:request.condition.field,value:request.condition.value}
  }
  sqlMigrationCondition(request.condition,sourceFields.map(f=>f.name),sourceKind==='sqlite'?'sqlite':'mysql')
  return migrationBrowseFilter(request.condition)
 }
}
function checkMapping(s:MigrationEndpoint,t:MigrationEndpoint,source:SchemaObject|undefined,target:SchemaObject|undefined,map:MigrationObjectMap,request:MigrationRequest){
 if(s.kind==='redis'||t.kind==='redis'){
  if(s.kind!=='redis'||t.kind!=='redis'||map.fields.length||map.predicate||map.mongoFilter||request.condition||!source||!['string','hash','list','set','zset','stream'].includes(source.type)||target&&(request.policy!=='upsert'||!['string','hash','list','set','zset','stream'].includes(target.type)))throw mappingError('Redis 仅支持原生 Key 映射')
  return {sourceFields:[],targetFields:[],filter:undefined}
 }
 if(!ordinary(source)||!ordinary(target))throw mappingError('目标或源结构需要人工审核')
 const sourceFields=mappingFields(s.kind,source!),targetFields=mappingFields(t.kind,target!)
 if(!map.fields.length)throw mappingError()
 for(const f of map.fields){
  if(s.kind==='mongodb')bsonName(f.source);else if(!sourceFields.some(c=>c.name===f.source))throw mappingError('源字段不存在')
  if(t.kind==='mongodb')bsonName(f.target);else if(!targetFields.some(c=>c.name===f.target))throw mappingError('目标字段不存在')
 }
 const fields=new Set(map.fields.map(f=>f.target))
 if(t.kind==='mongodb'){
  if(request.policy==='upsert'&&!fields.has('_id'))throw mappingError('插入更新需要映射全部主键')
 }else{
  if(targetFields.some(c=>c.required&&!fields.has(c.name)))throw mappingError('目标必填字段缺少映射')
  if(request.policy==='upsert'){
   const keys=t.kind==='sqlite'?sqliteUpsertKeys(sqliteShape(target)):mysqlUpsertKeys(target!.shape)
   if(!keys||keys.some(k=>!fields.has(k)))throw mappingError('插入更新需要映射全部主键')
  }
 }
 const filter=filterFor(map,request,s.kind,sourceFields)
 return {sourceFields,targetFields,filter}
}
export function mappedPlan(s:MigrationEndpoint,t:MigrationEndpoint,source:SchemaSnapshot,target:SchemaSnapshot,request:MigrationRequest):MigrationStep[]{
 return request.mappings!.map((map,i)=>{
  const step={...reviewStep(map.source,i),targetName:map.target}
  try{
   checkMapping(s,t,source.objects.find(o=>o.name===map.source),target.objects.find(o=>o.name===map.target),map,request)
   return {...step,action:'copy',executable:true,transfer:true,changes:['MAPPED DATA TRANSFER',...map.fields.map(f=>f.source+' → '+f.target+' ('+f.conversion+')'),...(map.predicate||map.mongoFilter||request.condition?['FILTER SOURCE RECORDS']:[])]}
  }catch(e){return {...step,changes:[e instanceof Error&&/^MIGRATION_(MAPPING|CONDITION|TYPE):/.test(e.message)?e.message:'MIGRATION_MAPPING: 字段或对象映射无效']}}
 })
}
export async function copyMapped(s:MigrationEndpoint,t:MigrationEndpoint,source:SchemaObject,target:SchemaObject|undefined,map:MigrationObjectMap,request:MigrationRequest,signal:AbortSignal,...[read,pending,beforeCommit,committed]:CopyCallbacks){
 const {sourceFields,targetFields,filter}=checkMapping(s,t,source,target,map,request)
 const policy=request.policy||'append'
 if(s instanceof RedisMigrationEndpoint&&t instanceof RedisMigrationEndpoint){
  const record=await s.archiveRead(request.source.database,Buffer.from(map.source))
  if(!record)throw mappingError('源 Key 已不存在')
  const value=Buffer.from(record.dumpBase64,'base64')
  read(1,value.length);pending(1);beforeCommit()
  const result=await t.archiveRestore(request.target.database,{key:Buffer.from(map.target),dump:value,expiresAt:record.expiresAt},policy==='upsert')
  if(result!=='restored'){committed(0);throw mappingError(result==='expired'?'源 Key 已过期':'目标 Key 写入被拒绝')}
  committed(1);return
 }
 const from=[...new Set(map.fields.map(f=>f.source))],to=map.fields.map(f=>f.target)
 let rows:AsyncIterable<Record<string,unknown>>
 if(s instanceof MongoMigrationEndpoint)rows=s.fileRows(request.source.database,map.source,from,filter as string|undefined)
 else if(s instanceof MysqlMigrationEndpoint||s instanceof SqliteMigrationEndpoint)rows=s.fileRows(request.source.database,map.source,from,filter as BrowseFilter|undefined,true)
 else if(s instanceof ClickHouseMigrationEndpoint)rows=s.mappedRows(request.source.database,map.source,from,filter as {field:string;value:string}|undefined)
 else throw mappingError()
 let count=0,ack=0
 async function* records(){
  for await(const row of rows){
   requireActive(signal)
   const bytes=Buffer.byteLength(JSON.stringify(row))
   read(1,bytes);count++
   const out:Record<string,unknown>=Object.create(null)
   try{
    for(const f of map.fields){
     if(!Object.hasOwn(row,f.source)){
      if(s.kind==='mongodb'&&t.kind==='mongodb'&&f.conversion==='auto'&&f.target!=='_id')continue
      throw mappingError('源记录缺少已映射字段')
     }
     const field=targetFields.find(c=>c.name===f.target)||{name:f.target,type:'BSON',nullable:true}
     out[f.target]=mappedCell(row[f.source],s.kind,sourceFields.find(c=>c.name===f.source)?.type||'',t.kind,field,f.conversion)
    }
    if(!Object.keys(out).length||t.kind==='mongodb'&&policy==='upsert'&&!Object.hasOwn(out,'_id'))throw mappingError()
    if(t.kind==='mongodb'){const document=BSON.EJSON.parse(JSON.stringify(out),{relaxed:false});validateReadDocument(document);BSON.serialize(document)}
    else Object.values(out).forEach(sqlFileValue)
   }catch{throw Error('MIGRATION_TYPE: 第 '+count+' 条源记录转换失败；请检查字段映射和目标类型')}
   pending(count-ack);yield out
  }
 }
 const commit=(n:number)=>{ack+=n;committed(n);pending(count-ack)}
 const allowEmpty=policy!=='replace'
 if(t instanceof MongoMigrationEndpoint)await t.fileWrite(request.target.database,map.target,policy,records(),beforeCommit,commit,allowEmpty)
 else if(t instanceof MysqlMigrationEndpoint||t instanceof SqliteMigrationEndpoint)await t.fileWrite(request.target.database,map.target,to,policy,records(),beforeCommit,commit,allowEmpty)
 else if(t instanceof ClickHouseMigrationEndpoint)await t.mappedWrite(request.target.database,map.target,to,records(),beforeCommit,commit)
 else throw mappingError()
 pending(0)
}
