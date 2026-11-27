import type {DatabaseKind} from '../../shared/types'
import type {MigrationJob,MigrationPolicy} from '../../shared/migration'
export interface MigrationHistoryIO{
 load():Promise<unknown>
 save(value:MigrationJob[]):Promise<void>
}
const limit=100
const phases=['checking','structure','copying','committing','finished']
const states=['running','completed','failed','cancelled','uncertain']
function text(value:unknown,max=500){return typeof value==='string'&&value.length<=max?value:undefined}
function count(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0}
function names(value:unknown){return Array.isArray(value)?value.slice(0,100).filter((v):v is string=>typeof v==='string'&&v.length<=200):[]}
export function normalizeMigrationHistory(input:unknown):MigrationJob[]{
 if(!Array.isArray(input)||input.length>limit)throw new Error('MIGRATION_HISTORY: 迁移历史文件无效')
 const seen=new Set<string>()
 return input.map(raw=>{
  const v=raw as Record<string,unknown>
  if(!v||typeof v!=='object'||typeof v.id!=='string'||!/^[-a-f0-9]{36}$/i.test(v.id)||seen.has(v.id)||typeof v.planId!=='string'||!/^[-a-f0-9]{36}$/i.test(v.planId)||!states.includes(String(v.state))||!phases.includes(String(v.phase)))throw new Error('MIGRATION_HISTORY: 迁移历史文件无效')
  seen.add(v.id)
  return {
   id:v.id,planId:v.planId,state:v.state as MigrationJob['state'],phase:v.phase as MigrationJob['phase'],
   startedAt:count(v.startedAt),...(v.endedAt!==undefined?{endedAt:count(v.endedAt)}:{}),
   current:text(v.current,200),total:Math.min(100,count(v.total)),completed:names(v.completed),created:names(v.created),
   rowsRead:count(v.rowsRead),rowsCommitted:count(v.rowsCommitted),rowsPending:count(v.rowsPending),bytesRead:count(v.bytesRead),
   rowsKnown:v.rowsKnown!==false,sourceKind:['mysql','mariadb','sqlite','mongodb','redis','clickhouse'].includes(String(v.sourceKind))?v.sourceKind as DatabaseKind:undefined,sourceLabel:text(v.sourceLabel,1500),targetLabel:text(v.targetLabel,1500),
   policy:['append','upsert','replace'].includes(String(v.policy))?v.policy as MigrationPolicy:'append',selectedObjects:names(v.selectedObjects),
   requestKey:text(v.requestKey,64),sourceIdentityKey:text(v.sourceIdentityKey,64),targetIdentityKey:text(v.targetIdentityKey,64),retryable:names(v.retryable),error:text(v.error,1000)
  }
 })
}
/** Save only outcome metadata. The durable running marker means a crash
 * requires verification, never automatic write replay. */
export class MigrationHistory{
 private jobs=new Map<string,MigrationJob>()
 private serial:Promise<unknown>=Promise.resolve()
 private ready=false
 constructor(private io:MigrationHistoryIO){}
 async init(){
  const entries=normalizeMigrationHistory(await this.io.load()??[])
  let changed=false
  for(const job of entries){
   if(job.state==='running'){
    job.state='uncertain';job.phase='finished';job.endedAt=Date.now();job.retryable=[]
    job.error='MIGRATION_INTERRUPTED: 上次任务异常中断，请核对目标后重新比较'
    changed=true
   }
   this.jobs.set(job.id,job)
  }
  if(changed)await this.io.save(this.snapshot())
  this.ready=true
 }
 private snapshot(){return [...this.jobs.values()].sort((a,b)=>b.startedAt-a.startedAt)}
 list(){return structuredClone(this.snapshot())}
 put(job:MigrationJob):Promise<void>{
  const copy=structuredClone(job)
  const write=this.serial.then(async()=>{
   if(!this.ready)throw new Error('MIGRATION_HISTORY: 迁移历史不可用')
   const previous=new Map(this.jobs)
   this.jobs.set(copy.id,copy)
   while(this.jobs.size>limit){
    const victim=this.snapshot().reverse().find(j=>j.state!=='running')
    if(!victim){this.jobs=previous;throw new Error('MIGRATION_HISTORY: 迁移历史不可用')}
    this.jobs.delete(victim.id)
   }
   try{await this.io.save(this.snapshot())}catch{this.jobs=previous;throw new Error('MIGRATION_HISTORY: 迁移历史不可用')}
  })
  this.serial=write.catch(()=>{})
  return write
 }
 async remove(id:string){
  const write=this.serial.then(async()=>{
   if(!this.ready)throw new Error('MIGRATION_HISTORY: 迁移历史不可用')
   const previous=this.jobs.get(id)
   if(!previous||previous.state==='running')return
   this.jobs.delete(id)
   try{await this.io.save(this.snapshot())}catch{this.jobs.set(id,previous);throw new Error('MIGRATION_HISTORY: 迁移历史不可用')}
  })
  this.serial=write.catch(()=>{})
  return write
 }
}
