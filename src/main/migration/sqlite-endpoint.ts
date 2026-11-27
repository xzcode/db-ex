import {join} from 'node:path'
import type {ConnectionConfig} from '../../shared/types'
import type {MigrationCatalog,MigrationStep,MigrationCopyOptions} from '../../shared/migration'
import {forkSqliteProcess,type SqliteProcess,type SqliteProcessFactory} from '../operations/sqlite-client'
import {validateConnection} from '../connections/validation'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import {sqliteShape} from './sqlite-shape'
import {requireActive,type MigrationEndpoint,type CopyCallbacks} from './endpoint'
import type {WireCell} from './sqlite-worker-engine'
class Worker{
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
 private next=0
 private closed=false
 readonly exited:Promise<void>
 constructor(private process:SqliteProcess,private signal:AbortSignal){
  this.exited=new Promise(resolve=>process.onExit(()=>{this.fail();resolve()}))
  process.onError(()=>this.fail())
  process.onMessage(message=>{
   const p=this.pending.get(message?.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer)
   if(message.ok)p.resolve(message.value);else p.reject(new Error(message.error||'MIGRATION_DATABASE_ERROR: SQLite'))
  })
  signal.addEventListener('abort',this.stop,{once:true})
 }
 private fail(){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(this.signal.aborted?'CANCELLED: 已取消操作':'MIGRATION_DATABASE_ERROR: SQLite'))}this.pending.clear()}
 private stop=()=>{this.fail();this.process.kill()}
 call<T>(method:string,args:unknown[]=[],initPath?:string):Promise<T>{
  requireActive(this.signal);if(this.closed)throw new Error('MIGRATION_DATABASE_ERROR: SQLite')
  const id=++this.next
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.stop();reject(new Error('MIGRATION_TIMEOUT: 迁移操作超时，连接已断开'))},30000)
   this.pending.set(id,{resolve,reject,timer})
   try{this.process.send(initPath?{id,kind:'migration-init',path:initPath}:{id,kind:'migration',method,args})}catch{this.stop()}
  })
 }
 async close(){this.signal.removeEventListener('abort',this.stop);if(!this.closed)this.stop();await this.exited}
}
export class SqliteMigrationEndpoint implements MigrationEndpoint{
 readonly kind='sqlite' as const
 private constructor(private worker:Worker,private signal:AbortSignal,readonly identity:string){}
 static async open(input:ConnectionConfig,signal:AbortSignal,factory:SqliteProcessFactory=forkSqliteProcess,modulePath=join(__dirname,'sqlite-worker.cjs')){
  const config=validateConnection(input);if(config.kind!=='sqlite'||!config.filePath)throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  requireActive(signal)
  const worker=new Worker(factory(modulePath),signal)
  try{return new SqliteMigrationEndpoint(worker,signal,await worker.call<string>('',[],config.filePath))}catch(e){await worker.close();throw e}
 }
 close(){return this.worker.close()}
 catalog(database?:string){return this.worker.call<MigrationCatalog>('catalog',[database])}
 schema(database:string,names?:string[]){return this.worker.call<SchemaSnapshot>('schema',[database,names])}
 startSourceSnapshot(){return this.worker.call<void>('sourceSnapshot')}
 prepareTarget(){return this.worker.call<void>('prepareTarget')}
 applyStep(step:MigrationStep){return this.worker.call<void>('apply',[step.sql])}
 async copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,...[read,pending,commitStart,committed]:CopyCallbacks){
  const info=sqliteShape(object)
  if(!(source instanceof SqliteMigrationEndpoint)||sourceDb!=='main'||targetDb!=='main'||!info?.safe)throw new Error('MIGRATION_UNSUPPORTED: 当前对象需要人工迁移')
  await source.worker.call('beginRead',[object.name,info,options.condition]);await this.worker.call('beginTarget',[object.name,info,options.policy])
  let count=0
  for(;;){
   requireActive(this.signal)
   const batch=await source.worker.call<{rows:WireCell[][];bytes:number;done:boolean}>('batch')
   read(batch.rows.length,batch.bytes)
   if(batch.rows.length){count+=await this.worker.call<number>('insertBatch',[batch.rows]);pending(count)}
   if(batch.done)break
  }
  commitStart();await this.worker.call('commit');committed(count)
 }
}
