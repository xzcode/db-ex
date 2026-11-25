import { parentPort, workerData } from 'node:worker_threads'
import { SqliteOperations } from './sqlite'
import { databaseError } from './common'
import type { MysqlOperation } from '../../shared/types'
const port=parentPort!
let operations:SqliteOperations
try{operations=new SqliteOperations(workerData.path);port.postMessage({id:0,ok:true})}
catch(error){port.postMessage({id:0,ok:false,error:databaseError(error).message});throw error}
port.on('message',async(message:{id:number;kind:'children'|'execute'|'close'|'backup';path?:string;operation?:MysqlOperation;writable?:boolean;confirmed?:boolean})=>{
  try{
    const value=message.kind==='children'?operations.children():message.kind==='close'?operations.close():message.kind==='backup'?await operations.backupTo(message.path!):operations.execute(message.operation!,{writable:message.writable===true,confirmed:message.confirmed===true})
    port.postMessage({id:message.id,ok:true,value,transaction:operations.transactionActive})
    if(message.kind==='close')port.close()
  }catch(error){port.postMessage({id:message.id,ok:false,error:databaseError(error).message,transaction:operations.transactionActive})}
})
