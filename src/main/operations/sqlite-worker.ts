import { SqliteOperations } from './sqlite'
import {SqliteMigrationWorkerEngine} from '../migration/sqlite-worker-engine'
import { databaseError } from './common'
import type { MysqlOperation } from '../../shared/types'
type Request={id:number;kind:'init'|'children'|'execute'|'backup'|'migration-init'|'migration';method?:string;args?:unknown[];path?:string;operation?:MysqlOperation;writable?:boolean;confirmed?:boolean}
const utilityPort=(process as NodeJS.Process&{parentPort?:{postMessage(value:unknown):void;on(event:'message',handler:(event:{data:Request})=>void):void}}).parentPort
const send=(message:object)=>utilityPort?utilityPort.postMessage(message):process.send?.(message)
let operations:SqliteOperations|undefined
let migration:SqliteMigrationWorkerEngine|undefined
let busy=false
async function receive(message:Request){
  if(busy){send({id:message.id,ok:false,error:'SESSION_BUSY: SQLite'});return}
  busy=true
  try{
    if(message.kind==='migration-init'){
      if(operations||migration||typeof message.path!=='string')throw new Error('INVALID_CONNECTION: SQLite')
      migration=new SqliteMigrationWorkerEngine(message.path);send({id:message.id,ok:true,value:migration.identity});return
    }
    if(message.kind==='migration'){
      if(!migration||!message.method||!['catalog','schema','sourceSnapshot','prepareTarget','apply','beginTarget','beginRead','beginFileRead','fileFields','batch','insertBatch','commit'].includes(message.method))throw new Error('INVALID_OPERATION: SQLite migration')
      const fn=migration[message.method as keyof SqliteMigrationWorkerEngine]
      if(typeof fn!=='function')throw new Error('INVALID_OPERATION: SQLite migration')
      const value=await (fn as (...args:unknown[])=>unknown).apply(migration,message.args||[])
      send({id:message.id,ok:true,value});return
    }
    if(message.kind==='init'){
      if(operations||migration||typeof message.path!=='string')throw new Error('INVALID_CONNECTION: SQLite')
      operations=new SqliteOperations(message.path);send({id:message.id,ok:true});return
    }
    if(!operations)throw new Error('SESSION_CLOSED: SQLite')
    const value=message.kind==='children'?operations.children():message.kind==='backup'?await operations.backupTo(message.path!):message.kind==='execute'?operations.execute(message.operation!,{writable:message.writable===true,confirmed:message.confirmed===true}):undefined
    send({id:message.id,ok:true,value,transaction:operations.transactionActive})
  }catch(error){send({id:message.id,ok:false,error:error instanceof Error&&/^(?:MIGRATION_[A-Z_]+|FILE_TRANSFER):/.test(error.message)?error.message:databaseError(error).message,transaction:operations?.transactionActive})}
  finally{busy=false}
}
if(utilityPort)utilityPort.on('message',event=>{void receive(event.data)})
else {process.on('message',message=>{void receive(message as Request)});process.on('disconnect',()=>process.exit(0))}
