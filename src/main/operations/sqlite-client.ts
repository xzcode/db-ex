import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ExplorerNode, MysqlOperation, OperationResult } from '../../shared/types'
import type { OperationContext } from './common'
export class SqliteClient {
  private worker:Worker
  private next=0
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  transactionActive=false
  disconnected=false
  private ready:Promise<void>
  constructor(path:string){
    this.worker=new Worker(join(__dirname,'sqlite-worker.cjs'),{workerData:{path}})
    this.ready=new Promise((resolve,reject)=>this.pending.set(0,{resolve,reject}))
    this.worker.on('message',message=>{
      const p=this.pending.get(message.id);if(!p)return
      this.pending.delete(message.id);if(typeof message.transaction==='boolean')this.transactionActive=message.transaction
      if(message.ok)p.resolve(message.value);else p.reject(new Error(message.error||'DATABASE_ERROR: SQLite'))
    })
    const fail=()=>{this.disconnected=true;for(const p of this.pending.values())p.reject(new Error('SESSION_CLOSED: SQLite'));this.pending.clear()}
    this.worker.on('error',fail);this.worker.on('exit',fail)
  }
  async connect(){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TIMEOUT: SQLite')),10000)})])}catch(error){await this.close();throw error}finally{if(timer)clearTimeout(timer)}}
  private async call<T>(kind:'children'|'execute'|'backup',data:object={}):Promise<T>{
    await this.ready;if(this.disconnected)throw new Error('SESSION_CLOSED: SQLite')
    const id=++this.next
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,kind,...data})})
  }
  backupTo(path:string){return this.call<void>('backup',{path})}
  children(){return this.call<ExplorerNode[]>('children')}
  execute(operation:MysqlOperation,context:OperationContext){return this.call<OperationResult>('execute',{operation,writable:context.writable,confirmed:context.confirmed})}
  async close(){await this.worker.terminate();this.transactionActive=false}
}
