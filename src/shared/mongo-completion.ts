/** Native-style signatures, not arbitrary JavaScript execution. The executable
 * entries correspond to compiler operations; documentation-only suggestions
 * are explicitly marked and sort after the implemented methods. */
export interface MongoSignature {name:string;parameters:string[];snippet:string;note:string;reference?:boolean}
const escapeSnippet=(value:string)=>value.replaceAll('\\','\\\\').replaceAll('$','\\$').replaceAll('}','\\}')
function placeholder(i:number,value:string){return '$'+'{'+i+':'+escapeSnippet(value)+'}'}
function sig(name:string,parameters:string[],_legacy:string,note:string,reference=false):MongoSignature{
 const example=(p:string):string=>{
  if(p==='filter')return /^(findOneAnd|update|delete|replace)/.test(name)?'{ _id: ObjectId("") }':'{}'
  if(p==='update')return '{ $set: {} }'
  if(p==='pipeline'||p==='documents')return '[]'
  if(p==='count')return '100'
  if(p==='offset')return '0'
  if(p==='size')return '50'
  if(p==='milliseconds')return '30000'
  if(p==='sort'||p==='index'||p==='keys')return '{ _id: 1 }'
  if(p==='name')return '"index_name"'
  return '{}'
 }
 return {name,parameters,snippet:name+'('+parameters.map((p,i)=>placeholder(i+1,example(p))).join(', ')+')$0',note,reference}
}
export const mongoCollectionSignatures:MongoSignature[]=[
 sig('find',[],'','Read documents'),
 sig('find',['filter'],'','Read matching documents'),
 sig('find',['filter','projection'],'${1:{}} , ${2:{}}','Read with projection'),
 sig('find',['filter','projection','options'],'${1:{}} , ${2:{}} , ${3:{}}','Options: sort, skip, limit, hint, collation, batchSize, maxTimeMS'),
 sig('findOne',['filter'],'${1:{}}','Read at most one document'),
 sig('findOne',['filter','projection'],'${1:{}} , ${2:{}}','Read one with projection'),
 sig('findOne',['filter','projection','options'],'${1:{}} , ${2:{}} , ${3:{}}','Read one with supported options'),
 sig('findOneAndDelete',['filter','options'],'${1:{_id: ObjectId("")}} , ${2:{}}','Delete matching document; requires explicit write access'),
 sig('findOneAndUpdate',['filter','update','options'],'${1:{_id: ObjectId("")}} , ${2:{$set: {}}} , ${3:{}}','Update matching document; requires explicit write access'),
 sig('findOneAndReplace',['filter','replacement','options'],'${1:{_id: ObjectId("")}} , ${2:{}} , ${3:{}}','Replace matching document; requires explicit write access'),
 sig('findAndModify',['document'],'${1:{}}','Legacy mongosh reference; use findOneAndUpdate, findOneAndReplace or findOneAndDelete',true),
 sig('aggregate',['pipeline'],'${1:[]}','Read-only aggregation pipeline'),
 sig('countDocuments',['filter'],'${1:{}}','Count matching documents (bounded)'),
 sig('count',['filter'],'${1:{}}','Legacy count alias'),
 sig('estimatedDocumentCount',[],'','Estimated collection count'),
 sig('getIndexes',[],'','Read index definitions'),
 sig('insertOne',['document'],'${1:{}}','Insert document; requires write access'),
 sig('insertMany',['documents'],'${1:[]}','Insert documents; bounded batch'),
 sig('updateOne',['filter','update','options'],'${1:{_id: ObjectId("")}} , ${2:{$set: {}}} , ${3:{}}','Update one; nonempty filter required'),
 sig('updateMany',['filter','update','options'],'${1:{}} , ${2:{$set: {}}} , ${3:{}}','Update matching documents; nonempty filter required'),
 sig('replaceOne',['filter','replacement','options'],'${1:{_id: ObjectId("")}} , ${2:{}} , ${3:{}}','Replace one; nonempty filter required'),
 sig('deleteOne',['filter'],'${1:{_id: ObjectId("")}}','Delete one; nonempty filter required'),
 sig('deleteMany',['filter'],'${1:{}}','Delete matching documents; nonempty filter required'),
 sig('createIndex',['keys','options'],'${1:{field: 1}} , ${2:{}}','Create an index; requires write access'),
 sig('dropIndex',['name'],'"${1:index_name}"','Drop one named index'),
 ...['distinct','bulkWrite','watch','stats','validate','renameCollection','drop','createIndexes'].map(n=>sig(n,['...arguments'],'${1:}', 'mongosh reference only — not executable in the DB EX query editor',true))
]
export const mongoCursorSignatures:MongoSignature[]=[
 sig('sort',['sort'],'${1:{_id: 1}}','Set result ordering'),
 sig('skip',['offset'],'${1:0}','Skip records'),
 sig('limit',['count'],'${1:100}','Limit total results'),
 sig('project',['projection'],'${1:{}}','Select result fields'),
 sig('hint',['index'],'${1:{_id: 1}}','Use a named index or key pattern'),
 sig('collation',['options'],'${1:{locale: "simple"}}','Specify collation'),
 sig('batchSize',['size'],'${1:50}','Set server batch size (bounded)'),
 sig('maxTimeMS',['milliseconds'],'${1:30000}','Set server execution deadline (max 30s)'),
 sig('pretty',[],'','Format preview; still bounded'),
 sig('toArray',[],'','Display bounded preview, not an unlimited array'),
 ...['explain','allowDiskUse','forEach','map','hasNext','next','close','count','readConcern','readPref'].map(n=>sig(n,['...arguments'],'${1:}','mongosh reference only — not executable in the DB EX query editor',true))
]
