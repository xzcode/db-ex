import {parseBsonDocument} from './bson-display'
import {parseMongoDocumentEditor} from './bson-editor'
import {typeName,type BsonTypeTree} from './bson-types'
const forbidden=new Set(['__proto__','constructor','prototype'])
const wrapperTypes:Record<string,string>={$oid:'ObjectId',$numberInt:'Int32',$numberLong:'Int64',$numberDouble:'Double',$numberDecimal:'Decimal128',$date:'Date',$binary:'Binary',$timestamp:'Timestamp',$regularExpression:'Regex',$minKey:'MinKey',$maxKey:'MaxKey',$undefined:'Undefined',$symbol:'Symbol',$code:'JavaScript',$dbPointer:'DBRef'}
const bad=()=>new Error('BSON_EDITOR_INVALID: 无法编辑此文档节点')
function keyName(key:string){if(!key||key.includes('\0')||key.startsWith('$')||forbidden.has(key))throw bad();return key}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function leafType(value:unknown):string{
 if(value===null)return 'Null'
 if(Array.isArray(value))return 'Array'
 if(object(value)){const keys=Object.keys(value);if(keys.length===1&&Object.hasOwn(wrapperTypes,keys[0]!))return wrapperTypes[keys[0]!]!;if(keys.includes('$code')&&keys.includes('$scope'))return 'JavaScriptWithScope';return 'Document'}
 return typeof value==='string'?'String':typeof value==='boolean'?'Boolean':'Number'
}
export type TreeNode={path:string[];type:string;value:unknown;depth:number;key:string;container:boolean}
export function treeNodes(text:string,expanded:ReadonlySet<string>):TreeNode[]{
 const doc=parseBsonDocument(text);if(!doc)throw bad()
 const nodes:TreeNode[]=[]
 function walk(value:unknown,path:string[],depth:number){
  const type=path.length?leafType(value):'Document',container=type==='Document'||type==='Array'
  nodes.push({path,type,value,depth,key:path.at(-1)||'$',container})
  if(container&&expanded.has(JSON.stringify(path))){if(depth>=64)throw bad();for(const [k,v] of Object.entries(value as object))walk(v,[...path,k],depth+1)}
 }
 walk(doc,[],0);return nodes
}
export function treeValue(text:string,path:string[]):unknown{
 let node:unknown=parseBsonDocument(text);if(!node)throw bad()
 for(const key of path){
  if(!node||typeof node!=='object'||!['Document','Array'].includes(leafType(node))||forbidden.has(key)||!Object.hasOwn(node,key))throw bad()
  node=(node as Record<string,unknown>)[key]
 }
 return node
}
export type TreeChange={action:'set';path:string[];value:string}|{action:'rename';path:string[];name:string}|{action:'remove';path:string[]}|{action:'add';path:string[];name:string;value:string}
function parseValue(text:string){
 // Friendly scalar/constructor syntax and canonical Extended JSON both
 // supported. The canonical branch rejects ambiguous unsafe bare integers.
 let value:unknown
 try{value=JSON.parse(text)}catch{value=JSON.parse(parseMongoDocumentEditor('{"value":'+text+'}')).value}
 function check(v:unknown,depth=0){
  if(depth>64||typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw bad()
  if(v&&typeof v==='object')for(const [k,child] of Object.entries(v)){if(forbidden.has(k)||k.includes('\0'))throw bad();check(child,depth+1)}
 }
 check(value);return value
}
export function editBsonTree(text:string,change:TreeChange):string{
 const doc=parseBsonDocument(text);if(!doc)throw bad()
 const path=change.path
 if(path[0]==='_id'||path.some(k=>forbidden.has(k))||path.length>64)throw bad()
 if(change.action==='add'){
  const parent=treeValue(text,path)
  // Work with the parsed draft, not the separate parsed lookup value.
  let target:unknown=doc
  for(const k of path)target=(target as Record<string,unknown>)[k]
  const value=parseValue(change.value)
  if(Array.isArray(parent)&&Array.isArray(target))target.push(value)
  else if(object(parent)&&object(target)&&leafType(parent)==='Document'){
   const key=keyName(change.name);if(Object.hasOwn(target,key)||path.length===0&&key==='_id')throw bad();target[key]=value
  }else throw bad()
 }else{
  if(!path.length)throw bad()
  treeValue(text,path)
  let parent:unknown=doc
  for(const k of path.slice(0,-1))parent=(parent as Record<string,unknown>)[k]
  const key=path.at(-1)!
  if(change.action==='set')(parent as Record<string,unknown>)[key]=parseValue(change.value)
  else if(change.action==='remove'){if(Array.isArray(parent))parent.splice(Number(key),1);else delete (parent as Record<string,unknown>)[key]}
  else{
   if(!object(parent))throw bad()
   const name=keyName(change.name);if(Object.hasOwn(parent,name)||path.length===1&&name==='_id')throw bad()
   // Preserve object order. Reconstruct only the renamed object in place.
   const entries=Object.entries(parent).map(([k,v])=>[k===key?name:k,v] as const)
   for(const k of Object.keys(parent))delete parent[k]
   for(const [k,v] of entries)parent[k]=v
  }
 }
 return JSON.stringify(doc,null,2)
}
