import {createHash,randomUUID} from 'node:crypto'
import type {ConnectionConfig} from '../../shared/types'
import {migrationName,migrationSupported,normalizeMigrationRequest,type MigrationJob,type MigrationPlan,type MigrationRequest} from '../../shared/migration'
import {protectedDatabase} from '../../shared/database-admin'
import {connectionDisplayEndpoint} from '../../shared/connection-form'
import {MysqlMigrationEndpoint,migrationError} from './mysql-endpoint'
import {planMysqlMigration,type SchemaSnapshot} from './mysql-schema'

const PLAN_TTL=10*60_000,JOB_TIMEOUT=30*60_000,PREVIEW_TIMEOUT=120_000
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function snapshotKey(snapshot:SchemaSnapshot){
 // Ignore only the volatile AUTO_INCREMENT counter of recognized ordinary
 // table definitions. Other definitions remain exact.
 return fingerprint(snapshot.objects.map(o=>({...o,definition:o.shape?.safe?undefined:o.definition})))
}
type PrivatePlan={plan:MigrationPlan;sourceKey:string;targetKey:string;sourceConfig:string;targetConfig:string;sourceIdentity:string;targetIdentity:string}
type Active={controller:AbortController;done:Promise<unknown>}
function label(config:ConnectionConfig,database:string){
 const endpoint=connectionDisplayEndpoint(config)
 return config.name+' · '+endpoint.host+':'+endpoint.port+' / '+database
}
function sameTarget(source:MysqlMigrationEndpoint,target:MysqlMigrationEndpoint,request:MigrationRequest){
 // Conservative when aliases resolve to the same physical server. Same
 // names with different case are rejected too; never self-append.
 if(source.identity===target.identity&&request.source.database.toLowerCase()===request.target.database.toLowerCase())throw new Error('MIGRATION_SAME_TARGET: 源与目标不能是同一数据库')
}
export class MigrationService{
 private plans=new Map<number,PrivatePlan>()
 private active=new Map<number,Active>()
 private jobs=new Map<number,MigrationJob[]>()
 constructor(private readonly getConfig:(id:string)=>ConnectionConfig){}
 private config(id:unknown){
  const key=migrationName(id)
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  const config=this.getConfig(key)
  if(!migrationSupported(config.kind))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  return config
 }
 private configs(request:MigrationRequest){
  const source=this.config(request.source.connectionId),target=this.config(request.target.connectionId)
  if(protectedDatabase(source.kind,request.source.database)||protectedDatabase(target.kind,request.target.database))throw new Error('MIGRATION_DATABASE: 不允许操作系统数据库')
  return {source,target}
 }
 private run<T>(owner:number,timeout:number,fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.active.has(owner)||this.active.size>=4)throw new Error('MIGRATION_BUSY: 当前已有迁移任务')
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout)
  const done=Promise.resolve().then(()=>fn(controller.signal)).finally(()=>{
   clearTimeout(timer)
   if(this.active.get(owner)?.controller===controller)this.active.delete(owner)
  })
  this.active.set(owner,{controller,done})
  return done
 }
 private async pair<T>(source:ConnectionConfig,target:ConnectionConfig,signal:AbortSignal,fn:(s:MysqlMigrationEndpoint,t:MysqlMigrationEndpoint)=>Promise<T>){
  let s:MysqlMigrationEndpoint|undefined,t:MysqlMigrationEndpoint|undefined
  try{s=await MysqlMigrationEndpoint.open(source,signal);t=await MysqlMigrationEndpoint.open(target,signal);return await fn(s,t)}
  finally{await Promise.allSettled([s?.close(),t?.close()])}
 }
 async catalog(owner:number,id:unknown,database?:unknown){
  const config=this.config(id),name=database===undefined?undefined:migrationName(database)
  return this.run(owner,PREVIEW_TIMEOUT,async signal=>{
   let endpoint:MysqlMigrationEndpoint|undefined
   try{endpoint=await MysqlMigrationEndpoint.open(config,signal);return await endpoint.catalog(name)}
   catch(e){throw new Error(migrationError(e))}finally{await endpoint?.close()}
  })
 }
 async preview(owner:number,input:unknown):Promise<MigrationPlan>{
  const request=normalizeMigrationRequest(input),configs=this.configs(request)
  this.plans.delete(owner)
  return this.run(owner,PREVIEW_TIMEOUT,async signal=>{
   try{return await this.pair(configs.source,configs.target,signal,async(s,t)=>{
    sameTarget(s,t,request)
    const source=await s.schema(request.source.database,request.objects),target=await t.schema(request.target.database,request.objects)
    if(request.objects?.some(name=>!source.objects.some(o=>o.name===name)&&!target.objects.some(o=>o.name===name)))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
    const steps=planMysqlMigration(source,target,request.mode,request.target.database,s.kind,t.kind)
    if(steps.length>200)throw new Error('MIGRATION_LIMIT: 请选择不超过100个对象')
    const plan:MigrationPlan={id:randomUUID(),request,sourceLabel:label(configs.source,request.source.database),targetLabel:label(configs.target,request.target.database),sourceKind:s.kind,targetKind:t.kind,expiresAt:Date.now()+PLAN_TTL,steps}
    if(Buffer.byteLength(JSON.stringify(plan))>4*1024*1024)throw new Error('MIGRATION_LIMIT: 数据库对象定义超出本阶段上限')
    this.plans.set(owner,{plan,sourceKey:snapshotKey(source),targetKey:snapshotKey(target),sourceConfig:fingerprint(configs.source),targetConfig:fingerprint(configs.target),sourceIdentity:s.identity,targetIdentity:t.identity})
    return structuredClone(plan)
   })}catch(e){throw new Error(migrationError(e))}
  })
 }
 selected(owner:number,planId:unknown,input:unknown){
  const item=this.plans.get(owner)
  if(!item||item.plan.id!==planId||item.plan.expiresAt<Date.now())throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  if(!Array.isArray(input)||!input.length||input.length>100||input.some(id=>typeof id!=='string'))throw new Error('MIGRATION_INPUT: 请选择1至100个对象')
  const ids=new Set(input),steps=item.plan.steps.filter(step=>ids.has(step.id))
  if(steps.length!==ids.size||steps.some(step=>!step.executable))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  return {item,steps}
 }
 confirmation(owner:number,planId:unknown,input:unknown){
  const {item,steps}=this.selected(owner,planId,input)
  const ddl=steps.flatMap(s=>s.sql).length,data=steps.filter(s=>s.transfer).length
  return {source:item.plan.sourceLabel,target:item.plan.targetLabel,names:steps.map(s=>s.name),ddl,data}
 }
 start(owner:number,planId:unknown,input:unknown):MigrationJob{
  if(this.active.has(owner)||this.active.size>=4)throw new Error('MIGRATION_BUSY: 当前已有迁移任务')
  const {item,steps}=this.selected(owner,planId,input),request=item.plan.request
  const configs=this.configs(request)
  if(fingerprint(configs.source)!==item.sourceConfig||fingerprint(configs.target)!==item.targetConfig)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  this.plans.delete(owner)
  const job:MigrationJob={id:randomUUID(),planId:item.plan.id,state:'running',startedAt:Date.now(),phase:'checking',total:steps.length,completed:[],created:[],rowsRead:0,rowsCommitted:0,rowsPending:0,bytesRead:0}
  const list=this.jobs.get(owner)||[];this.jobs.set(owner,[job,...list].slice(0,20))
  // Task is main-process-owned and independent from renderer and explorer.
  // The native confirmation is the exact selected, one-use plan capability.
  void this.run(owner,JOB_TIMEOUT,async signal=>{
   let uncertain=false
   try{
    await this.pair(configs.source,configs.target,signal,async(s,t)=>{
     sameTarget(s,t,request)
     if(s.identity!==item.sourceIdentity||t.identity!==item.targetIdentity)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
     if(steps.some(x=>x.transfer))await s.startSourceSnapshot()
     const source=await s.schema(request.source.database,request.objects),target=await t.schema(request.target.database,request.objects)
     if(snapshotKey(source)!==item.sourceKey||snapshotKey(target)!==item.targetKey)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
     await t.prepareTarget()
     for(const step of steps){
      if(signal.aborted)throw new Error('CANCELLED: 已取消操作')
      job.current=step.name
      // Recheck the current table on both endpoints before starting each
      // table; an external DDL race after this check remains possible.
      const expectedSource={objects:source.objects.filter(o=>o.name===step.name)}
      const expectedTarget={objects:target.objects.filter(o=>o.name===step.name)}
      if(snapshotKey(await s.schema(request.source.database,[step.name]))!==snapshotKey(expectedSource)||snapshotKey(await t.schema(request.target.database,[step.name]))!==snapshotKey(expectedTarget))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
      for(const sql of step.sql){
       job.phase='structure';uncertain=true
       await t.apply(sql)
       uncertain=false;job.created.push(step.name)
      }
      if(step.transfer){
       const object=expectedSource.objects[0]
       if(!object)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
       job.phase='copying'
       await t.copyFrom(s,request.source.database,request.target.database,object,
        (rows,bytes)=>{job.rowsRead+=rows;job.bytesRead+=bytes},
        pending=>{job.rowsPending=pending},
        ()=>{job.phase='committing';uncertain=true},
        rows=>{job.rowsCommitted+=rows;job.rowsPending=0;uncertain=false})
      }
      job.completed.push(step.name)
     }
    })
    job.state='completed'
   }catch(error){
    job.state=uncertain?'uncertain':signal.aborted?'cancelled':'failed'
    job.error=migrationError(error)
    if(!uncertain)job.rowsPending=0
   }finally{job.phase='finished';job.endedAt=Date.now();job.current=undefined}
  }).catch(error=>{job.state='failed';job.phase='finished';job.error=migrationError(error);job.endedAt=Date.now()})
  return structuredClone(job)
 }
 list(owner:number):MigrationJob[]{return structuredClone(this.jobs.get(owner)||[])}
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
