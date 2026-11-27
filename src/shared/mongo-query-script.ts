import {parse} from 'acorn'
import type {MongoOperation,MongoFindSettings,MongoScriptWriteMethod} from './types'
import {parseMongoDocumentEditor} from './bson-editor'

/** Parse one native-shell-style expression. Never evaluate JavaScript.
 * The resulting operation uses the existing main-process BSON, read and write
 * policies, so UI text cannot introduce an unrestricted script execution path.
 */
interface Ast {
 type:string;start:number;end:number;body?:Ast[];expression?:Ast;callee?:Ast;object?:Ast;property?:Ast;computed?:boolean;optional?:boolean;name?:string;value?:unknown;regex?:{pattern:string;flags:string};bigint?:string;arguments?:Ast[];properties?:Ast[];elements?:(Ast|null)[];key?:Ast;kind?:string;method?:boolean;shorthand?:boolean;operator?:string;argument?:Ast
}
const forbidden=new Set(['__proto__','prototype','constructor'])
const invalid=():never=>{throw new Error('MONGO_SCRIPT_INVALID: 请输入受支持的单条 MongoDB 查询语句。')}
const nameOf=(node?:Ast):string=>{
 if(node?.type==='Identifier'&&node.name&&!forbidden.has(node.name))return node.name
 if(node?.type==='Literal'&&typeof node.value==='string'&&!forbidden.has(node.value))return node.value
 return invalid()
}
function member(node:Ast):{object:Ast;name:string}{
 if(node.type!=='MemberExpression'||node.optional||!node.object||!node.property||node.computed&&node.property.type!=='Literal')return invalid()
 return {object:node.object,name:nameOf(node.property)}
}
function call(node:Ast){
 if(node.type!=='CallExpression'||node.optional||!node.callee||!node.arguments)return invalid()
 const target=member(node.callee)
 return {...target,args:node.arguments}
}
function integer(node:Ast|undefined,maximum:number):number{
 if(node?.type!=='Literal'||typeof node.value!=='number'||!Number.isSafeInteger(node.value)||node.value<0||node.value>maximum)return invalid()
 return node.value
}
export type MongoScriptPlan={operation:MongoOperation;maxRows?:number;baseOffset:number}
export const mongoScriptMethods=['find','findOne','aggregate','count','countDocuments','estimatedDocumentCount','getIndexes','insertOne','insertMany','updateOne','updateMany','replaceOne','deleteOne','deleteMany','findOneAndUpdate','findOneAndReplace','findOneAndDelete','createIndex','dropIndex'] as const
export const mongoCursorMethods=['sort','skip','limit','project','hint','collation','batchSize','maxTimeMS','pretty','toArray'] as const
export const mongoConstructors=['ObjectId','NumberInt','NumberLong','NumberDecimal','Int32','Long','Double','Decimal128','ISODate','Date','Timestamp','BinData','Regex','MinKey','MaxKey'] as const
const ctorAliases:Record<string,string>={NumberInt:'Int32',NumberLong:'Long',NumberDecimal:'Decimal128'}

export function compileMongoScript(source:string,database:string,pageSize=100):MongoScriptPlan{
 if(typeof source!=='string'||source.length>100000||!source.trim()||!database||database.length>200||database.includes('\0')||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>500)return invalid()
 let program:Ast
 try{program=parse(source,{ecmaVersion:2022,sourceType:'script'}) as unknown as Ast}catch{return invalid()}
 if(program.body?.length!==1||program.body[0]?.type!=='ExpressionStatement'||!program.body[0].expression)return invalid()
 let nodes=0
 function numeric(node:Ast):string{
  const token=source.slice(node.start,node.end)
  if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)||!Number.isFinite(Number(token)))return invalid()
  return token
 }
 function literalString(node?:Ast):string{
  if(node?.type!=='Literal'||typeof node.value!=='string'||node.value.includes('\0'))return invalid()
  return node.value
 }
 function data(node:Ast,depth=0):string{
  if(++nodes>20000||depth>64)return invalid()
  if(node.type==='ObjectExpression'){
   const keys=new Set<string>()
   return '{'+(node.properties||[]).map(p=>{
    if(p.type!=='Property'||p.kind!=='init'||p.method||p.shorthand||p.computed||!p.key||!p.value)return invalid()
    const key=nameOf(p.key)
    if(keys.has(key)||key.includes('\0'))return invalid()
    keys.add(key)
    return JSON.stringify(key)+':'+data(p.value as Ast,depth+1)
   }).join(',')+'}'
  }
  if(node.type==='ArrayExpression')return '['+(node.elements||[]).map(n=>n?data(n,depth+1):invalid()).join(',')+']'
  if(node.type==='Literal'||node.type==='UnaryExpression'&&node.operator==='-'&&node.argument?.type==='Literal'&&typeof node.argument.value==='number'){
   if(node.regex){
    if(!/^[imsux]*$/.test(node.regex.flags))return invalid()
    return JSON.stringify({$regularExpression:{pattern:node.regex.pattern,options:[...node.regex.flags].sort().join('')}})
   }
   if(node.type==='Literal'&&(typeof node.value==='string'||typeof node.value==='boolean'||node.value===null))return JSON.stringify(node.value)
   const token=numeric(node)
   if(Number.isInteger(Number(token))&&!Number.isSafeInteger(Number(token)))throw new Error('MONGO_SCRIPT_INVALID: 大整数请使用 NumberLong("...") 或 NumberDecimal("...")。')
   return token
  }
  if(node.type==='CallExpression'||node.type==='NewExpression'){
   if(!node.callee||node.callee.type!=='Identifier')return invalid()
   const name=nameOf(node.callee)
   if(!mongoConstructors.includes(name as typeof mongoConstructors[number])||node.type==='NewExpression'&&name!=='Date')return invalid()
   const args=(node.arguments||[]).map(a=>{
    if(a.type==='Literal'&&typeof a.value==='string')return JSON.stringify(a.value)
    if(a.type==='Literal'&&typeof a.value==='number'||a.type==='UnaryExpression'&&a.operator==='-'&&a.argument?.type==='Literal'&&typeof a.argument.value==='number')return numeric(a)
    return invalid()
   })
   const actual=name==='Date'&&args[0]?.startsWith('"')?'ISODate':ctorAliases[name]||name
   return JSON.stringify(JSON.parse(parseMongoDocumentEditor('{"v":'+actual+'('+args.join(',')+')}')).v)
  }
  return invalid()
 }
 function object(node:Ast|undefined):string{
  if(!node)return '{}'
  if(node.type!=='ObjectExpression')return invalid()
  return data(node)
 }
 function optionsObject(node:Ast|undefined):Record<string,Ast>{
  if(!node)return {}
  if(node.type!=='ObjectExpression')return invalid()
  const values:Record<string,Ast>=Object.create(null)
  for(const p of node.properties||[]){
   if(p.type!=='Property'||p.kind!=='init'||p.method||p.shorthand||p.computed||!p.key||!p.value)return invalid()
   const key=nameOf(p.key)
   if(Object.hasOwn(values,key))return invalid()
   values[key]=p.value as Ast
  }
  return values
 }
 function collection(node:Ast):string{
  if(node.type==='CallExpression'){
   const item=call(node)
   if(item.name!=='getCollection'||item.args.length!==1||item.object.type!=='Identifier'||item.object.name!=='db')return invalid()
   return literalString(item.args[0])
  }
  const item=member(node)
  if(item.object.type!=='Identifier'||item.object.name!=='db')return invalid()
  return item.name
 }
 let current=program.body[0].expression
 const modifiers:{name:string;args:Ast[]}[]=[]
 while(current.type==='CallExpression'){
  const item=call(current)
  if(!mongoCursorMethods.includes(item.name as typeof mongoCursorMethods[number]))break
  if(modifiers.some(m=>m.name===item.name)||item.args.length!==(['pretty','toArray'].includes(item.name)?0:1))return invalid()
  modifiers.unshift({name:item.name,args:item.args});current=item.object
 }
 const root=call(current),entity=collection(root.object),args=root.args
 if(!entity||entity.length>200||entity.includes('\0'))return invalid()
 const target={database,entity}
 if(root.name==='find'||root.name==='findOne'){
  if(args.length>3||root.name==='findOne'&&modifiers.length)return invalid()
  const settings:MongoFindSettings={}
  let filter=object(args[0]),projection=object(args[1]),sort='{}',baseOffset=0,maxRows=root.name==='findOne'?1:undefined
  const opts=optionsObject(args[2])
  const supported=['sort','skip','limit','hint','collation','batchSize','maxTimeMS']
  if(Object.keys(opts).some(k=>!supported.includes(k)||root.name==='findOne'&&k==='limit'))return invalid()
  function option(name:string,value:Ast|undefined){
   if(name==='sort')sort=object(value)
   else if(name==='project'){if(args.length>=2)return invalid();projection=object(value)}
   else if(name==='skip')baseOffset=integer(value,1000000)
   else if(name==='limit'){const n=integer(value,1000000);maxRows=n||undefined}
   else if(name==='hint'){settings.hint=value?.type==='Literal'&&typeof value.value==='string'?JSON.stringify(literalString(value)):object(value)}
   else if(name==='collation')settings.collation=object(value)
   else if(name==='batchSize'){const n=integer(value,500);if(n<1)return invalid();settings.batchSize=n}
   else if(name==='maxTimeMS'){const n=integer(value,30000);if(n<1)return invalid();settings.maxTimeMS=n}
  }
  for(const [key,value] of Object.entries(opts))option(key,value)
  for(const modifier of modifiers){
   if(Object.hasOwn(opts,modifier.name))return invalid()
   option(modifier.name,modifier.args[0])
  }
  return {operation:{action:'mongo.find',...target,filter,projection,sort,offset:baseOffset,limit:Math.min(pageSize,maxRows??pageSize),...(Object.keys(settings).length?{settings}:{})},maxRows,baseOffset}
 }
 if(modifiers.length)return invalid()
 if(root.name==='aggregate'){
  if(args.length!==1||args[0]?.type!=='ArrayExpression')return invalid()
  return {operation:{action:'mongo.aggregate',...target,pipeline:data(args[0]),limit:pageSize},baseOffset:0}
 }
 if(root.name==='countDocuments'||root.name==='count'){
  if(args.length>1)return invalid()
  return {operation:{action:'mongo.count',...target,filter:object(args[0])},baseOffset:0}
 }
 if(root.name==='estimatedDocumentCount'){
  if(args.length)return invalid()
  return {operation:{action:'mongo.estimateCount',...target},baseOffset:0}
 }
 if(root.name==='getIndexes'){
  if(args.length)return invalid()
  return {operation:{action:'mongo.indexes',...target},baseOffset:0}
 }
 const writes=['updateOne','updateMany','replaceOne','deleteOne','deleteMany','findOneAndUpdate','findOneAndReplace','findOneAndDelete']
 if(writes.includes(root.name)){
  const method=root.name as MongoScriptWriteMethod
  const deleting=['deleteOne','deleteMany','findOneAndDelete'].includes(method)
  if(args.length<(deleting?1:2)||args.length>(deleting?2:3))return invalid()
  const filter=object(args[0])
  if(!Object.keys(JSON.parse(filter)).length)return invalid() // no implicit unfiltered mutation
  const opts=optionsObject(args[deleting?1:2])
  const find=method.startsWith('findOneAnd')
  const allowed=deleting?(find?['sort']:[]):find?['upsert','returnDocument','sort']:['upsert']
  if(Object.keys(opts).some(k=>!allowed.includes(k)))return invalid()
  return {operation:{action:'mongo.scriptWrite',...target,method,filter,...(!deleting?{value:object(args[1])}:{}),options:object(args[deleting?1:2]),confirmed:true},baseOffset:0}
 }
 if(root.name==='insertOne'||root.name==='insertMany'){
  if(args.length!==1)return invalid()
  const documents=root.name==='insertOne'?[object(args[0])]:args[0]?.type==='ArrayExpression'?(args[0].elements||[]).map(n=>n?object(n):invalid()):invalid()
  if(!documents.length||documents.length>500)return invalid()
  return {operation:{action:'mongo.insert',...target,documents,confirmed:true},baseOffset:0}
 }
 if(root.name==='createIndex'){
  if(!args.length||args.length>2)return invalid()
  return {operation:{action:'mongo.createIndex',...target,keys:object(args[0]),options:object(args[1]),confirmed:true},baseOffset:0}
 }
 if(root.name==='dropIndex'){
  if(args.length!==1)return invalid()
  return {operation:{action:'mongo.dropIndex',...target,name:literalString(args[0]),confirmed:true},baseOffset:0}
 }
 return invalid()
}

export function mongoPageOperation(plan:MongoScriptPlan,offset:number,pageSize:number):MongoOperation|undefined{
 if(plan.operation.action!=='mongo.find')return offset===0?plan.operation:undefined
 if(!Number.isSafeInteger(offset)||offset<plan.baseOffset||offset>1000000)return undefined
 const remaining=plan.maxRows===undefined?pageSize:plan.maxRows-(offset-plan.baseOffset)
 if(remaining<=0)return undefined
 return {...plan.operation,offset,limit:Math.min(pageSize,remaining)}
}

/** Existing saved filter/pipeline records are converted only in the editor,
 * then persisted on explicit Save, without changing the record's ID/mode. */
export function legacyMongoScript(mode:'mongo-find'|'mongo-aggregation',entity:string|undefined,text:string):string{
 const target='db.getCollection('+JSON.stringify(entity||'')+')'
 if(mode==='mongo-aggregation')return target+'.aggregate('+text+');'
 const parts=JSON.parse(text)
 return target+'.find('+(parts.filter||'{}')+', '+(parts.projection||'{}')+').sort('+(parts.sort||'{}')+');'
}
