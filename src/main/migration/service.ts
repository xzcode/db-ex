import {BSON} from 'mongodb'
import {createHash,randomUUID} from 'node:crypto'
import type {ConnectionConfig} from '../../shared/types'
import {migrationName,migrationSupported,normalizeMigrationRequest,type MigrationJob,type MigrationPlan,type MigrationRequest,type MigrationField} from '../../shared/migration'
import {protectedDatabase} from '../../shared/database-admin'
import {connectionDisplayEndpoint} from '../../shared/connection-form'
import {MysqlMigrationEndpoint,migrationError} from './mysql-endpoint'
import {planMysqlMigration,type SchemaSnapshot} from './mysql-schema'
import {MongoMigrationEndpoint,planMongoMigration} from './mongo-endpoint'
import {RedisMigrationEndpoint,planRedisMigration} from './redis-endpoint'
import type {MigrationEndpoint} from './endpoint'
import {migrationPairSupported,migrationMappedPairSupported,migrationNativePair,migrationPolicies,migrationConditions,migrationRemaining,type MigrationStep} from '../../shared/migration'
import {sqlMigrationCondition} from './condition'
import {mongoMigrationFilter} from './mongo-condition'
import {mysqlUpsertKeys} from './mysql-schema'
import {sqliteShape,sqliteUpsertKeys} from './sqlite-shape'
import {SqliteMigrationEndpoint} from './sqlite-endpoint'
import {planSqliteMigration} from './sqlite-shape'
import {ClickHouseMigrationEndpoint,planClickHouseMigration} from './clickhouse-endpoint'
import type {MigrationHistory} from './history'
import {mappingFields,mappedPlan,copyMapped} from './mapping'
import type {SqliteProcessFactory} from '../operations/sqlite-client'
async function openEndpoint(config:ConnectionConfig,signal:AbortSignal,factory?:SqliteProcessFactory,modulePath?:string):Promise<MigrationEndpoint>{
 switch(config.kind){
 case 'clickhouse':return ClickHouseMigrationEndpoint.open(config,signal)
 case 'sqlite':return SqliteMigrationEndpoint.open(config,signal,factory,modulePath)
 case 'mongodb':return MongoMigrationEndpoint.open(config,signal)
 case 'redis':return RedisMigrationEndpoint.open(config,signal)
 default:return MysqlMigrationEndpoint.open(config,signal)
 }
}
function buildMigrationPlan(source:SchemaSnapshot,target:SchemaSnapshot,request:MigrationRequest,s:MigrationEndpoint,t:MigrationEndpoint){
 if(request.mappings)return mappedPlan(s,t,source,target,request)
 const policy=request.policy||'append'
 let steps:MigrationStep[]
 if(s.kind==='clickhouse')steps=planClickHouseMigration(source,target,request.mode,request.target.database)
 else if(s.kind==='sqlite')steps=planSqliteMigration(source,target,request.mode)
 else if(s.kind==='mongodb')steps=planMongoMigration(source,target,request.mode)
 else if(s.kind==='redis')steps=planRedisMigration(source,target,request.mode,policy)
 else steps=planMysqlMigration(source,target,request.mode,request.target.database,s.kind,t.kind,request.includeDependencies===true)
 return steps.map(step=>{
  if(!step.transfer||!step.executable)return step
  const a=source.objects.find(o=>o.name===step.name),b=target.objects.find(o=>o.name===step.name)
  if(!a)return {...step,executable:false,transfer:false,action:'review' as const,sql:[],changes:['MISSING SOURCE OBJECT']}
  const reject=(reason:string):MigrationStep=>({...step,action:'review',sql:[],executable:false,transfer:false,changes:[reason]})
  if(policy==='upsert'&&['mysql','mariadb','sqlite'].includes(s.kind)){
   const keys=s.kind==='sqlite'?sqliteUpsertKeys(sqliteShape(a)):mysqlUpsertKeys(a.shape)
   const targetKeys=b?(s.kind==='sqlite'?sqliteUpsertKeys(sqliteShape(b)):mysqlUpsertKeys(b.shape)):keys
   if(!keys||JSON.stringify(keys)!==JSON.stringify(targetKeys))return reject('UPSERT REQUIRES MATCHING PRIMARY KEY')
  }
  if(request.condition){
   try{
    if(s.kind==='mongodb')mongoMigrationFilter(request.condition)
    else sqlMigrationCondition(request.condition,s.kind==='sqlite'?sqliteShape(a)?.fields.map(f=>f.name)||[]:a.shape?.columns.map(c=>c.name)||[],s.kind==='sqlite'?'sqlite':'mysql')
   }catch{return reject('FILTER FIELD OR TYPE UNSUPPORTED')}
  }
  const changes=step.changes.filter(c=>c!=='APPEND DATA — STOP ON CONFLICT')
  if(policy==='upsert'&&s.kind!=='redis')changes.push('UPSERT MATCHING PRIMARY KEY')
  else if(policy==='replace')changes.push('REPLACE TABLE DATA IN TRANSACTION')
  else if(policy==='append'&&s.kind!=='redis'&&s.kind!=='clickhouse')changes.push('APPEND DATA — STOP ON CONFLICT')
  if(request.condition)changes.push('FILTER SOURCE RECORDS')
  return {...step,changes}
 })
}

const PLAN_TTL=10*60_000,PREVIEW_TIMEOUT=120_000
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function snapshotKey(snapshot:SchemaSnapshot){
 // Ignore only the volatile AUTO_INCREMENT counter of recognized ordinary
 // table definitions. Other definitions remain exact.
 return fingerprint(snapshot.objects.map(o=>({...o,definition:o.shape?.safe?undefined:o.definition})))
}
type PrivatePlan={plan:MigrationPlan;sourceKey:string;targetKey:string;sourceConfig:string;targetConfig:string;sourceIdentity:string;targetIdentity:string;resumeFrom?:string;resumeKey?:string}
type Active={controller:AbortController;done:Promise<unknown>}
function label(config:ConnectionConfig,database:string){
 const endpoint=connectionDisplayEndpoint(config)
 return config.name+' · '+endpoint.host+':'+endpoint.port+' / '+database
}
function sameTarget(source:MigrationEndpoint,target:MigrationEndpoint,request:MigrationRequest){
 // Conservative when aliases resolve to the same physical server. Same
 // names with different case are rejected too; never self-append.
 if(source.identity===target.identity&&request.source.database.toLowerCase()===request.target.database.toLowerCase())throw new Error('MIGRATION_SAME_TARGET: 源与目标不能是同一数据库')
}
export class MigrationService{
 private plans=new Map<number,PrivatePlan>()
 private active=new Map<number,Active>()
 private jobs=new Map<number,MigrationJob[]>()
 private targets=new Set<string>()
 async init(){await this.history?.init()}
 private checkpoint(job:MigrationJob){return this.history?.put(job)||Promise.resolve()}
 constructor(private readonly getConfig:(id:string)=>ConnectionConfig,private readonly sqliteFactory?:SqliteProcessFactory,private readonly sqliteModulePath?:string,private readonly history?:MigrationHistory){}
 private config(id:unknown){
  const key=migrationName(id)
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  const config=this.getConfig(key)
  if(!migrationSupported(config.kind))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  return config
 }
 validateRequest(request:MigrationRequest){this.configs(request)}
 private configs(request:MigrationRequest){
  const source=this.config(request.source.connectionId),target=this.config(request.target.connectionId)
  if(!migrationPairSupported(source.kind,target.kind,request.mode)||source.kind==='redis'&&request.mode==='schema'||request.mappings&&!migrationMappedPairSupported(source.kind,target.kind)||!request.mappings&&!migrationNativePair(source.kind,target.kind))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  if(!migrationPolicies(target.kind).includes(request.policy||'append')||request.condition&&!migrationConditions(source.kind)&&!(request.mappings&&source.kind==='clickhouse'))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  if(request.includeDependencies&&(!['mysql','mariadb'].includes(source.kind)||source.kind!==target.kind))throw Error('MIGRATION_DEPENDENCY: 外键依赖迁移仅支持同类型关系型数据库')
  if(protectedDatabase(source.kind,request.source.database)||protectedDatabase(target.kind,request.target.database)||source.kind==='clickhouse'&&['system','information_schema'].includes(request.source.database.toLowerCase())||target.kind==='clickhouse'&&['system','information_schema'].includes(request.target.database.toLowerCase()))throw new Error('MIGRATION_DATABASE: 不允许操作系统数据库')
  return {source,target}
 }
 private run<T>(owner:number,timeout:number|undefined,fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.active.has(owner))throw new Error('MIGRATION_BUSY: 当前已有迁移任务')
  const controller=new AbortController(),timer=timeout===undefined?undefined:setTimeout(()=>controller.abort(),timeout)
  const done=Promise.resolve().then(()=>fn(controller.signal)).finally(()=>{
   if(timer)clearTimeout(timer)
   if(this.active.get(owner)?.controller===controller)this.active.delete(owner)
  })
  this.active.set(owner,{controller,done})
  return done
 }
 private async pair<T>(source:ConnectionConfig,target:ConnectionConfig,signal:AbortSignal,fn:(s:MigrationEndpoint,t:MigrationEndpoint)=>Promise<T>){
  let s:MigrationEndpoint|undefined,t:MigrationEndpoint|undefined
  try{s=await openEndpoint(source,signal,this.sqliteFactory,this.sqliteModulePath);t=await openEndpoint(target,signal,this.sqliteFactory,this.sqliteModulePath);return await fn(s,t)}
  finally{await Promise.allSettled([s?.close(),t?.close()])}
 }
 async catalog(owner:number,id:unknown,database?:unknown){
  const config=this.config(id),name=database===undefined?undefined:migrationName(database)
  return this.run(owner,PREVIEW_TIMEOUT,async signal=>{
   let endpoint:MigrationEndpoint|undefined
   try{endpoint=await openEndpoint(config,signal,this.sqliteFactory,this.sqliteModulePath);return await endpoint.catalog(name)}
   catch(e){throw new Error(migrationError(e))}finally{await endpoint?.close()}
  })
 }
 async fields(owner:number,id:unknown,databaseValue:unknown,nameValue:unknown):Promise<MigrationField[]>{
  const config=this.config(id),database=migrationName(databaseValue),name=migrationName(nameValue)
  if(config.kind==='redis')return []
  return this.run(owner,PREVIEW_TIMEOUT,async signal=>{
   let endpoint:MigrationEndpoint|undefined
   try{
    endpoint=await openEndpoint(config,signal,this.sqliteFactory,this.sqliteModulePath)
    const object=(await endpoint.schema(database,[name])).objects[0]
    if(!object)throw Error('MIGRATION_MAPPING: 源或目标对象不存在')
    if(endpoint instanceof MongoMigrationEndpoint){
     const found=new Map<string,MigrationField>();let count=0,bytes=0
     for await(const row of endpoint.fileRows(database,name)){
      bytes+=Buffer.byteLength(JSON.stringify(row))
      for(const [key,value] of Object.entries(row)){
       if(!key||key.length>200||key.includes('.')||key.startsWith('$')||['__proto__','constructor','prototype'].includes(key))continue
       const type=value===null?'Null':typeof value==='object'&&value&&Object.keys(value).length===1?Object.keys(value)[0]!:typeof value
       const existing=found.get(key);found.set(key,{name:key,type:existing&&existing.type!==type?'BSON':type,primary:key==='_id',nullable:true})
      }
      if(++count>=20||bytes>=256*1024||found.size>=1000)break
     }
     return [...found.values()]
    }
    return mappingFields(config.kind,object)
   }catch(e){throw Error(migrationError(e))}finally{await endpoint?.close()}
  })
 }
 async preview(owner:number,input:unknown,checkpoint?:MigrationJob):Promise<MigrationPlan>{
  const request=normalizeMigrationRequest(input),configs=this.configs(request)
  this.plans.delete(owner)
  return this.run(owner,PREVIEW_TIMEOUT,async signal=>{
   try{return await this.pair(configs.source,configs.target,signal,async(s,t)=>{
    sameTarget(s,t,request)
    if(checkpoint&&(checkpoint.sourceIdentityKey!==fingerprint(s.identity)||checkpoint.targetIdentityKey!==fingerprint(t.identity)))throw Error('MIGRATION_STALE: 续传连接身份已变化')
    const source=await s.schema(request.source.database,request.objects),target=await t.schema(request.target.database,request.mappings?.map(m=>m.target)||request.objects)
    if(request.objects?.some(name=>!source.objects.some(o=>o.name===name)&&!target.objects.some(o=>o.name===name)))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
    const steps=buildMigrationPlan(source,target,request,s,t)
    if(steps.length>200)throw new Error('MIGRATION_LIMIT: 请选择不超过100个对象')
    const plan:MigrationPlan={id:randomUUID(),request,sourceLabel:label(configs.source,request.source.database),targetLabel:label(configs.target,request.target.database),sourceKind:s.kind,targetKind:t.kind,expiresAt:Date.now()+PLAN_TTL,steps}
    if(Buffer.byteLength(JSON.stringify(plan))>4*1024*1024)throw new Error('MIGRATION_LIMIT: 数据库对象定义超出本阶段上限')
    this.plans.set(owner,{plan,sourceKey:snapshotKey(source),targetKey:snapshotKey(target),sourceConfig:fingerprint(configs.source),targetConfig:fingerprint(configs.target),sourceIdentity:s.identity,targetIdentity:t.identity,resumeFrom:checkpoint?.id,resumeKey:checkpoint?.requestKey})
    return structuredClone(plan)
   })}catch(e){throw new Error(migrationError(e))}
  })
 }
 async resumePreview(owner:number,jobId:unknown,input:unknown):Promise<MigrationPlan>{
  const job=this.list(owner).find(j=>j.id===jobId)
  const original=normalizeMigrationRequest(input)
  if(!job||!job.requestKey||job.requestKey!==fingerprint(original)||!job.sourceIdentityKey||!job.targetIdentityKey)throw Error('MIGRATION_STALE: 请选择原任务的迁移配置')
  const remaining=migrationRemaining(job)
  if(!remaining.length)throw Error('MIGRATION_STALE: 没有可安全续传的对象')
  const request={...original,objects:remaining,...(original.mappings?{mappings:original.mappings.filter(m=>remaining.includes(m.source))}:{})}
  return this.preview(owner,request,job)
 }
 selected(owner:number,planId:unknown,input:unknown){
  const item=this.plans.get(owner)
  if(!item||item.plan.id!==planId||item.plan.expiresAt<Date.now())throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  if(!Array.isArray(input)||!input.length||input.length>100||input.some(id=>typeof id!=='string'))throw new Error('MIGRATION_INPUT: 请选择1至100个对象')
  const ids=new Set(input),steps=item.plan.steps.filter(step=>ids.has(step.id))
  if(steps.length!==ids.size||steps.some(step=>!step.executable||step.dependsOn?.some(id=>!ids.has(id))))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  return {item,steps}
 }
 confirmation(owner:number,planId:unknown,input:unknown){
  const {item,steps}=this.selected(owner,planId,input)
  const ddl=steps.filter(s=>s.action==='create'||s.action==='alter').length,data=steps.filter(s=>s.transfer).length
  return {source:item.plan.sourceLabel,target:item.plan.targetLabel,names:steps.map(s=>s.targetName&&s.targetName!==s.name?s.name+' → '+s.targetName:s.name),mappings:item.plan.request.mappings?.filter(m=>steps.some(s=>s.name===m.source)),ddl,data,policy:item.plan.request.policy||'append',kind:item.plan.targetKind,condition:item.plan.request.condition}
 }
 start(owner:number,planId:unknown,input:unknown):MigrationJob{
  if(this.active.has(owner))throw new Error('MIGRATION_BUSY: 当前已有迁移任务')
  const {item,steps}=this.selected(owner,planId,input),request=item.plan.request
  const configs=this.configs(request)
  if(fingerprint(configs.source)!==item.sourceConfig||fingerprint(configs.target)!==item.targetConfig)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const checkpoint=item.resumeFrom?this.list(owner).find(j=>j.id===item.resumeFrom):undefined
  if(item.resumeFrom&&(!checkpoint||steps.some(step=>!migrationRemaining(checkpoint).includes(step.name))))throw Error('MIGRATION_STALE: 续传检查点已使用，请重新比较')
  const targetLock=item.targetIdentity+'\0'+request.target.database.toLowerCase()
  if(this.targets.has(targetLock))throw Error('MIGRATION_BUSY: 目标数据库已有迁移任务')
  this.targets.add(targetLock);this.plans.delete(owner)
  const job:MigrationJob={id:randomUUID(),planId:item.plan.id,state:'running',startedAt:Date.now(),phase:'checking',total:steps.length,completed:[],created:[],rowsRead:0,rowsCommitted:0,rowsPending:0,bytesRead:0,rowsKnown:configs.source.kind!=='clickhouse'||!!request.mappings,sourceLabel:item.plan.sourceLabel,targetLabel:item.plan.targetLabel,sourceKind:item.plan.sourceKind,policy:request.policy||'append',selectedObjects:steps.map(s=>s.name),requestKey:item.resumeKey||fingerprint(request),sourceIdentityKey:fingerprint(item.sourceIdentity),targetIdentityKey:fingerprint(item.targetIdentity),retryable:request.includeDependencies?[]:steps.map(s=>s.name)}
  const list=this.jobs.get(owner)||[];this.jobs.set(owner,[job,...list].slice(0,20))
  // Task is main-process-owned and independent from renderer and explorer.
  // The native confirmation is the exact selected, one-use plan capability.
  void this.run(owner,undefined,async signal=>{
   let uncertain=false
   try{
    if(checkpoint){
     const consumed=new Set(steps.map(step=>step.name))
     const updated={...checkpoint,retryable:migrationRemaining(checkpoint).filter(name=>!consumed.has(name))}
     try{await this.checkpoint(updated)}catch(e){job.retryable=[];throw e}
     for(const entries of this.jobs.values()){const prior=entries.find(j=>j.id===updated.id);if(prior)prior.retryable=updated.retryable}
    }
    await this.checkpoint(job)
    await this.pair(configs.source,configs.target,signal,async(s,t)=>{
     sameTarget(s,t,request)
     if(s.identity!==item.sourceIdentity||t.identity!==item.targetIdentity)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
     if(steps.some(x=>x.transfer))await s.startSourceSnapshot()
     const source=await s.schema(request.source.database,request.objects),target=await t.schema(request.target.database,request.mappings?.map(m=>m.target)||request.objects)
     if(snapshotKey(source)!==item.sourceKey||snapshotKey(target)!==item.targetKey)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
     await t.prepareTarget()
     for(const step of steps){
      if(signal.aborted)throw new Error('CANCELLED: 已取消操作')
      job.current=step.name
      job.phase='checking';await this.checkpoint(job)
      // Recheck the current table on both endpoints before starting each
      // table; an external DDL race after this check remains possible.
      const expectedSource={objects:source.objects.filter(o=>o.name===step.name)}
      const targetName=step.targetName||step.name
      const expectedTarget={objects:target.objects.filter(o=>o.name===targetName)}
      const mapping=request.mappings?.find(m=>m.source===step.name)
      if(snapshotKey(await s.schema(request.source.database,[step.name]))!==snapshotKey(expectedSource)||snapshotKey(await t.schema(request.target.database,[targetName]))!==snapshotKey(expectedTarget))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
      if(step.action==='create'||step.action==='alter'){
       job.phase='structure';uncertain=true
       job.retryable=job.retryable!.filter(n=>n!==step.name);await this.checkpoint(job)
       const object=expectedSource.objects[0]
       if(!object)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
       await t.applyStep(step,request.target.database,object)
       uncertain=false;job.created.push(step.name);if(step.transfer&&!request.includeDependencies)job.retryable!.push(step.name);await this.checkpoint(job)
      }
      if(step.transfer){
       const object=expectedSource.objects[0]
       if(!object)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
       job.phase='copying'
       // Nontransactional targets may acknowledge a subset of the current
       // object. Mark it non-retryable before its first possible write.
       const nontransactional=!['mysql','mariadb','sqlite'].includes(t.kind)
       if(nontransactional){job.retryable=job.retryable!.filter(n=>n!==step.name);await this.checkpoint(job)}
       const callbacks:import('./endpoint').CopyCallbacks=[
        (rows,bytes)=>{job.rowsRead+=rows;job.bytesRead+=bytes},
        pending=>{job.rowsPending=pending},
        ()=>{job.phase='committing';uncertain=true;job.retryable=job.retryable!.filter(n=>n!==step.name)},
        rows=>{job.rowsCommitted+=rows;job.rowsPending=0;uncertain=false}]
       if(mapping)await copyMapped(s,t,object,expectedTarget.objects[0],mapping,request,signal,...callbacks)
       else await t.copyFrom(s,request.source.database,request.target.database,object,{policy:request.policy||'append',condition:request.condition},...callbacks)
      }
      job.completed.push(step.name);job.retryable=job.retryable!.filter(n=>n!==step.name)
      await this.checkpoint(job)
     }
    })
    job.state='completed'
   }catch(error){
    job.state=uncertain?'uncertain':signal.aborted?'cancelled':'failed'
    job.error=migrationError(error)
    if(!uncertain)job.rowsPending=0
   }finally{
    this.targets.delete(targetLock)
    job.phase='finished';job.endedAt=Date.now()
    if(job.state==='completed')job.current=undefined
    try{await this.checkpoint(job)}catch{
     job.error=(job.error?job.error+'; ':'')+'MIGRATION_HISTORY: 迁移历史不可用'
    }
   }
  }).catch(error=>{this.targets.delete(targetLock);job.state='failed';job.phase='finished';job.error=migrationError(error);job.endedAt=Date.now()})
  return structuredClone(job)
 }
 list(owner:number):MigrationJob[]{
  const local=this.jobs.get(owner)||[],known=new Set(local.map(j=>j.id))
  const previous=(this.history?.list()||[]).filter(j=>j.state!=='running'&&!known.has(j.id))
  return structuredClone([...local,...previous].sort((a,b)=>b.startedAt-a.startedAt).slice(0,100))
 }
 async removeHistory(owner:number,id:unknown){
  if(typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  if([...this.jobs.values()].some(jobs=>jobs.some(j=>j.id===id&&j.state==='running')))throw new Error('MIGRATION_BUSY: 当前已有迁移任务')
  if(!this.list(owner).some(j=>j.id===id))return
  await this.history?.remove(id)
  for(const [key,jobs] of this.jobs)this.jobs.set(key,jobs.filter(j=>j.id!==id))
 }
 cancel(owner:number,id:unknown){
  const job=this.jobs.get(owner)?.find(j=>j.id===id&&j.state==='running')
  if(!job)throw new Error('MIGRATION_INPUT: 迁移参数无效')
  this.active.get(owner)?.controller.abort()
 }
 async closeOwner(owner:number){
  this.plans.delete(owner)
  const active=this.active.get(owner);active?.controller.abort()
  await active?.done.catch(()=>{})
  this.plans.delete(owner);this.jobs.delete(owner)
 }
 async closeAll(){await Promise.allSettled([...new Set([...this.active.keys(),...this.plans.keys(),...this.jobs.keys()])].map(owner=>this.closeOwner(owner)))}
}
