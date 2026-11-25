import { fork } from 'node:child_process'
import { join } from 'node:path'
import type { ExplorerNode, MysqlOperation, OperationResult } from '../../shared/types'
import type { OperationContext } from './common'

/** A separate process, rather than a Worker thread, can be terminated while
 * a synchronous SQLite call is running. Electron injects utilityProcess;
 * the Node test runner uses an ordinary fork. No file path goes in argv. */
export interface SqliteProcess {
  send(message:unknown):void
  onMessage(callback:(message:any)=>void):void
  onExit(callback:()=>void):void
  onError(callback:()=>void):void
  kill():void
}
export type SqliteProcessFactory=(modulePath:string)=>SqliteProcess
export const forkSqliteProcess:SqliteProcessFactory=modulePath=>{
  const child=fork(modulePath,[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'})
  return {send:value=>{child.send(value as object,()=>{})},onMessage:callback=>{child.on('message',callback)},onExit:callback=>{child.once('exit',callback)},onError:callback=>{child.on('error',callback)},kill:()=>{child.kill('SIGKILL')}}
}
export class SqliteClient {
  private process:SqliteProcess
  private next=0
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  transactionActive=false
  disconnected=false
  private ready:Promise<void>
  private exited:Promise<void>
  private stopping=false
  constructor(path:string,factory:SqliteProcessFactory=forkSqliteProcess,modulePath=join(__dirname,'sqlite-worker.cjs')){
    this.process=factory(modulePath)
    this.ready=new Promise((resolve,reject)=>this.pending.set(0,{resolve,reject}))
    const fail=()=>{this.disconnected=true;this.transactionActive=false;for(const p of this.pending.values())p.reject(new Error('SESSION_CLOSED: SQLite'));this.pending.clear()}
    this.exited=new Promise(resolve=>this.process.onExit(()=>{fail();resolve()}))
    this.process.onError(fail)
    this.process.onMessage(message=>{
      const p=this.pending.get(message?.id);if(!p)return
      this.pending.delete(message.id);if(typeof message.transaction==='boolean')this.transactionActive=message.transaction
      if(message.ok)p.resolve(message.value);else p.reject(new Error(message.error||'DATABASE_ERROR: SQLite'))
    })
    this.process.send({id:0,kind:'init',path})
  }
  async connect(){
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([this.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TIMEOUT: SQLite')),10000)})])}
    catch(error){await this.close();throw error}finally{if(timer)clearTimeout(timer)}
  }
  private async call<T>(kind:'children'|'execute'|'backup',data:object={}):Promise<T>{
    await this.ready;if(this.disconnected||this.stopping)throw new Error('SESSION_CLOSED: SQLite')
    const id=++this.next
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject})
      try{this.process.send({id,kind,...data})}catch{this.pending.delete(id);reject(new Error('SESSION_CLOSED: SQLite'))}
    })
  }
  backupTo(path:string){return this.call<void>('backup',{path})}
  children(){return this.call<ExplorerNode[]>('children')}
  execute(operation:MysqlOperation,context:OperationContext){return this.call<OperationResult>('execute',{operation,writable:context.writable,confirmed:context.confirmed})}
  async close(){if(!this.stopping){this.stopping=true;this.process.kill()}await this.exited;this.transactionActive=false}
}
