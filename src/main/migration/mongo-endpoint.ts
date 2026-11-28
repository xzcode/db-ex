import {BSON,type MongoClient,type Document,type IndexDescription,type CollectionInfo} from 'mongodb'
import type {ConnectionConfig} from '../../shared/types'
import type {MigrationCatalog,MigrationMode,MigrationStep,MigrationCopyOptions} from '../../shared/migration'
import {migrationName} from '../../shared/migration'
import {validateManagedCollection,protectedDatabase} from '../../shared/database-admin'
import {validateConnection} from '../connections/validation'
import {createTransport,type ConnectionTransport} from '../connections/transport'
import {openMongoClient} from '../connections/mongo-client'
import {loadConnectionTls} from '../connections/tls-material'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import {parseEjson,validateReadDocument} from '../operations/mongodb'
import {plainObject} from '../operations/common'
import type {DataFilePolicy} from '../../shared/file-transfer'
import {mongoMigrationFilter} from './mongo-condition'
import {checkedSnapshot,limitObjectNames,requireActive,reviewStep,type MigrationEndpoint,type CopyCallbacks} from './endpoint'
type SimpleIndex={name:string;key:[string,number][];unique:boolean}
type MongoShape={safe:boolean;indexes:SimpleIndex[]}
const shape=(o:SchemaObject|undefined)=>o?.details as MongoShape|undefined
const equivalent=(a:MongoShape,b:MongoShape)=>JSON.stringify(a)===JSON.stringify(b)
function simpleIndex(index:Document):SimpleIndex|undefined{
 if(typeof index.name!=='string'||!index.key||typeof index.key!=='object'||Object.keys(index).some(k=>!['v','key','name','unique','ns'].includes(k)))return
 const key=Object.entries(index.key)
 if(!key.length||key.some(([k,v])=>k.startsWith('$')||k.includes('\0')||![1,-1].includes(v as number)))return
 return {name:migrationName(index.name),key:key as [string,number][],unique:index.unique===true||index.name==='_id_'}
}
function planPair(a:SchemaObject|undefined,b:SchemaObject|undefined,mode:MigrationMode,step:MigrationStep){
 if(!a)return {...step,action:'target-only' as const,changes:['TARGET ONLY OBJECT']}
 const x=shape(a),y=shape(b)
 if(!x?.safe||b&&!y?.safe)return {...step,changes:['SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW']}
 if(!b){
  if(mode==='data')return {...step,changes:['MISSING TARGET OBJECT']}
  return {...step,action:'create' as const,changes:['MISSING TARGET OBJECT'],executable:true,transfer:mode==='structure-data'}
 }
 if(!y)return step
 if(mode!=='schema'&&equivalent(x,y))return {...step,action:'copy' as const,changes:['APPEND DATA — STOP ON CONFLICT'],executable:true,transfer:true}
 if(mode==='data')return {...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
 if(equivalent(x,y))return {...step,action:'same' as const}
 const additions=x.indexes.filter(i=>!y.indexes.some(j=>j.name===i.name)),sameExisting=y.indexes.every(j=>x.indexes.some(i=>JSON.stringify(i)===JSON.stringify(j)))
 if(!sameExisting||additions.some(i=>i.unique))return {...step,changes:['CONSTRAINTS / SPECIAL DEFINITION']}
 return {...step,action:'alter' as const,changes:additions.map(i=>'ADD INDEX '+i.name),executable:additions.length>0,transfer:mode==='structure-data'&&additions.length>0}
}
export function planMongoMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode){
 const a=new Map(source.objects.map(o=>[o.name,o])),b=new Map(target.objects.map(o=>[o.name,o]))
 return [...new Set([...a.keys(),...b.keys()])].sort().map((name,i)=>planPair(a.get(name),b.get(name),mode,reviewStep(name,i)))
}
export class MongoMigrationEndpoint implements MigrationEndpoint{
 readonly kind='mongodb' as const
 private constructor(private client:MongoClient,private transport:ConnectionTransport,private signal:AbortSignal,readonly identity:string){
  signal.addEventListener('abort',this.stop,{once:true})
 }
 private stop=()=>{void this.client.close(true).catch(()=>{});void this.transport.close().catch(()=>{})}
 static async open(input:ConnectionConfig,signal:AbortSignal){
  const config=validateConnection(input)
  // Start with standalone servers only: alias identity is reliable, no hidden
  // writes to a shard/replica discovered outside the confirmed endpoint.
  if(config.kind!=='mongodb'||config.uri||config.nodes?.length||config.mongoReplicaSet||config.mongoTopology==='discover')throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  requireActive(signal)
  const transport=await createTransport({ssh:config.ssh,proxy:config.proxy,timeoutMs:config.connectTimeoutMs})
  let client:MongoClient|undefined
  const stop=()=>{void client?.close(true).catch(()=>{});void transport.close().catch(()=>{})}
  signal.addEventListener('abort',stop,{once:true})
  try{
   client=await openMongoClient({...config,mongoTopology:'direct'},transport,await loadConnectionTls(config))
   const hello=await client.db('admin').command({hello:1},{signal,timeoutMS:15000})
   if(hello.setName||hello.msg==='isdbgrid'||!hello.isWritablePrimary||!hello.topologyVersion?.processId)throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
   const endpoint=new MongoMigrationEndpoint(client,transport,signal,String(hello.topologyVersion.processId))
   requireActive(signal);return endpoint
  }catch(e){stop();throw e}finally{signal.removeEventListener('abort',stop)}
 }
 async close(){this.signal.removeEventListener('abort',this.stop);await this.client.close(true).catch(()=>{});await this.transport.close().catch(()=>{})}
 private options(){return {signal:this.signal,timeoutMS:30000}}
 private async databases(){const result=await this.client.db('admin').admin().listDatabases({nameOnly:true,authorizedDatabases:true,...this.options()});if(result.databases.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限');return result.databases.map(x=>x.name).filter(n=>!protectedDatabase('mongodb',n)).sort()}
 private async collections(database:string,names?:string[]){
  if(!(await this.databases()).includes(database))throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  const cursor=this.client.db(database).listCollections(names?{name:{$in:names}}:{},{...this.options(),batchSize:50,nameOnly:false})
  const out:CollectionInfo[]=[]
  try{for await(const c of cursor){if(c.name.startsWith('system.'))continue;out.push(c as CollectionInfo);if(out.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')}}finally{await cursor.close()}
  return out.sort((a,b)=>a.name.localeCompare(b.name))
 }
 async catalog(database?:string):Promise<MigrationCatalog>{const databases=await this.databases();return {kind:this.kind,databases,...(database?{objects:(await this.collections(database)).map(c=>({name:c.name,type:c.type||'collection',engine:'MongoDB'}))}:{})}}
 async schema(database:string,names?:string[]):Promise<SchemaSnapshot>{
  const list=limitObjectNames(await this.collections(database,names),names),objects:SchemaObject[]=[]
  for(const c of list){
   const indexes:SimpleIndex[]=[];let safe=c.type==='collection'&&!Object.keys(c.options||{}).length&&!c.name.endsWith('.files')&&!c.name.endsWith('.chunks')&&!c.name.includes('$')
   if(c.type==='collection'){
    const cursor=this.client.db(database).collection(c.name).listIndexes({...this.options(),batchSize:50})
    try{for await(const index of cursor){const item=simpleIndex(index);if(!item)safe=false;else indexes.push(item);if(indexes.length>100)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')}}finally{await cursor.close()}
   }
   const info:MongoShape={safe:safe&&indexes.some(i=>i.name==='_id_'),indexes:indexes.sort((a,b)=>a.name.localeCompare(b.name))}
   objects.push({name:migrationName(c.name),type:c.type||'collection',engine:'MongoDB',definition:BSON.EJSON.stringify({type:c.type,options:c.options||{},uuid:c.info?.uuid},{relaxed:false}),triggerNames:[],details:info})
  }
  return checkedSnapshot(objects)
 }
 async startSourceSnapshot(){/* Standalone MongoDB does not offer a cross-collection snapshot. */}
 async prepareTarget(){}
 async applyStep(step:MigrationStep,database:string,source:SchemaObject){
  const info=shape(source)
  if(!info?.safe)throw new Error('MIGRATION_UNSUPPORTED: 当前对象需要人工迁移')
  requireActive(this.signal)
  const db=this.client.db(database)
  if(step.action==='create')await db.createCollection(source.name,{timeoutMS:30000,writeConcern:{w:1}})
  else if(step.action!=='alter')throw new Error('MIGRATION_INPUT: 迁移参数无效')
  const coll=db.collection(source.name,{writeConcern:{w:1}})
  const existing=await coll.listIndexes(this.options()).toArray()
  const indexes:IndexDescription[]=info.indexes.filter(i=>i.name!=='_id_'&&!existing.some(j=>j.name===i.name)).map(i=>({name:i.name,key:Object.fromEntries(i.key),...(i.unique?{unique:true}:{})}))
  if(step.action==='alter'&&indexes.some(i=>i.unique))throw new Error('MIGRATION_UNSUPPORTED: 当前对象需要人工迁移')
  if(indexes.length)await coll.createIndexes(indexes,this.options())
 }
 async *fileRows(database:string,name:string,selected?:string[],filterText?:string){
  if(protectedDatabase(this.kind,database))throw new Error('FILE_TRANSFER: 不允许操作系统数据库')
  const list=await this.collections(database,[name])
  if(!list.some(c=>c.name===name))throw new Error('FILE_TRANSFER: 对象不存在')
  const filter=plainObject(parseEjson(filterText||'{}','Filter'),'Filter');validateReadDocument(filter)
  const projection=selected?Object.fromEntries([...selected.map(c=>[c,1]),...(!selected.includes('_id')?[['_id',0]]:[])]):undefined
  // Field selection in the wizard is deliberately top-level, not an
  // arbitrary expression/projection sent by the renderer.
  if(selected?.some(c=>c.startsWith('$')||c.includes('.')))throw new Error('FILE_TRANSFER: 字段映射无效')
  const cursor=this.client.db(database).collection(name).find(filter,{raw:true,batchSize:32,signal:this.signal,timeoutMS:0,projection})
  try{for await(const raw of cursor){
   requireActive(this.signal)
   if(!Buffer.isBuffer(raw))throw new Error('FILE_TRANSFER: 无法无损读取 BSON')
   const doc=BSON.deserialize(raw,{promoteValues:false,promoteLongs:false,bsonRegExp:true})
   if(!Buffer.from(BSON.serialize(doc)).equals(raw))throw new Error('FILE_TRANSFER: 无法无损读取 BSON')
   yield JSON.parse(BSON.EJSON.stringify(doc,{relaxed:false})) as Record<string,unknown>
  }}finally{await cursor.close()}
 }
 async fileWrite(database:string,name:string,policy:DataFilePolicy,records:AsyncIterable<Record<string,unknown>>,beforeCommit:()=>void,committed:(n:number)=>void,allowEmpty=false){
  validateManagedCollection(name)
  if(protectedDatabase(this.kind,database)||policy==='replace')throw new Error('FILE_TRANSFER: 不支持此数据库或操作')
  const object=(await this.schema(database,[name])).objects[0]
  if(!shape(object)?.safe)throw new Error('FILE_TRANSFER: 目标结构需要人工审核')
  const collection=this.client.db(database).collection<Document&{_id:unknown}>(name)
  let batch:Document[]=[],bytes=0,total=0
  const flush=async()=>{
   if(!batch.length)return
   requireActive(this.signal);beforeCommit()
   if(policy==='upsert'){
    const result=await collection.bulkWrite(batch.map(doc=>({replaceOne:{filter:{_id:{$eq:doc._id}},replacement:doc,upsert:true}})),{ordered:true,writeConcern:{w:1},timeoutMS:30000})
    if(result.matchedCount+result.upsertedCount!==batch.length)throw new Error('FILE_TRANSFER: 写入结果或警告与预期不一致')
   }else{
    const result=await collection.insertMany(batch as (Document&{_id:unknown})[],{ordered:true,writeConcern:{w:1},...this.options()})
    if(!result.acknowledged||result.insertedCount!==batch.length)throw new Error('FILE_TRANSFER: 写入结果或警告与预期不一致')
   }
   total+=batch.length;committed(batch.length);batch=[];bytes=0
  }
  for await(const row of records){
   requireActive(this.signal)
   const doc=plainObject(BSON.EJSON.parse(JSON.stringify(row),{relaxed:false}),'Document')
   validateReadDocument(doc)
   if(policy==='upsert'&&!Object.hasOwn(doc,'_id'))throw new Error('FILE_TRANSFER: 插入更新需要映射全部主键')
   const size=BSON.serialize(doc).length
   if(size>16*1024*1024)throw new Error('FILE_TRANSFER: 单条文件记录过大')
   if(batch.length&&(batch.length>=100||bytes+size>4*1024*1024))await flush()
   batch.push(doc);bytes+=size
  }
  await flush()
  if(!total&&!allowEmpty)throw new Error('FILE_TRANSFER: 没有可导入的记录')
 }
 async copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,...[read,pending,commitStart,committed]:CopyCallbacks){
  if(!(source instanceof MongoMigrationEndpoint))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  const actual=(await source.schema(sourceDb,[object.name])).objects[0],target=(await this.schema(targetDb,[object.name])).objects[0]
  if(!shape(actual)?.safe||!shape(target)?.safe||!equivalent(shape(actual)!,shape(target)!)||actual?.definition!==object.definition)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const cursor=source.client.db(sourceDb).collection(object.name).find(mongoMigrationFilter(options.condition), {raw:true,batchSize:32,signal:this.signal,timeoutMS:0})
  let docs:Document[]=[],bytes=0
  const flush=async()=>{if(!docs.length)return;requireActive(this.signal);pending(docs.length);commitStart()
   const coll=this.client.db(targetDb).collection<Document & {_id:unknown}>(object.name)
   if(options.policy==='upsert'){
    const result=await coll.bulkWrite(docs.map(doc=>({replaceOne:{filter:{_id:{$eq:doc._id}},replacement:doc,upsert:true}})),{ordered:true,writeConcern:{w:1},timeoutMS:30000})
    if(result.matchedCount+result.upsertedCount!==docs.length)throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')
   }else if(options.policy==='append'){
    const result=await coll.insertMany(docs as (Document & {_id:unknown})[],{ordered:true,writeConcern:{w:1},...this.options()})
    if(!result.acknowledged||result.insertedCount!==docs.length)throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')
   }else throw new Error('MIGRATION_INPUT: 迁移参数无效')
   committed(docs.length);docs=[];bytes=0
  }
  try{for await(const raw of cursor){
   requireActive(this.signal)
   if(!Buffer.isBuffer(raw)||raw.length>4*1024*1024)throw new Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
   if(docs.length&&(docs.length>=100||bytes+raw.length>4*1024*1024))await flush()
   const doc=BSON.deserialize(raw,{promoteValues:false,promoteLongs:false,bsonRegExp:true})
   if(!Object.hasOwn(doc,'_id')||!Buffer.from(BSON.serialize(doc)).equals(raw))throw new Error('MIGRATION_TYPE: 无法无损传输该字段值')
   docs.push(doc);bytes+=raw.length;read(1,raw.length)
  }await flush()}finally{await cursor.close()}
 }
}
