import { SqliteOperations } from './sqlite'
import { databaseError } from './common'
import type { MysqlOperation } from '../../shared/types'
type Request={id:number;kind:'init'|'children'|'execute'|'backup';path?:string;operation?:MysqlOperation;writable?:boolean;confirmed?:boolean}
const utilityPort=(process as NodeJS.Process&{parentPort?:{postMessage(value:unknown):void;on(event:'message',handler:(event:{data:Request})=>void):void}}).parentPort
const send=(message:object)=>utilityPort?utilityPort.postMessage(message):process.send?.(message)
let operations:SqliteOperations|undefined
let busy=false
async function receive(message:Request){
  if(busy){send({id:message.id,ok:false,error:'SESSION_BUSY: SQLite'});return}
  busy=true
  try{
    if(message.kind==='init'){
      if(operations||typeof message.path!=='string')throw new Error('INVALID_CONNECTION: SQLite')
      operations=new SqliteOperations(message.path);send({id:message.id,ok:true});return
    }
    if(!operations)throw new Error('SESSION_CLOSED: SQLite')
    const value=message.kind==='children'?operations.children():message.kind==='backup'?await operations.backupTo(message.path!):message.kind==='execute'?operations.execute(message.operation!,{writable:message.writable===true,confirmed:message.confirmed===true}):undefined
    send({id:message.id,ok:true,value,transaction:operations.transactionActive})
  }catch(error){send({id:message.id,ok:false,error:databaseError(error).message,transaction:operations?.transactionActive})}
  finally{busy=false}
}
if(utilityPort)utilityPort.on('message',event=>{void receive(event.data)})
else {process.on('message',message=>{void receive(message as Request)});process.on('disconnect',()=>process.exit(0))}
