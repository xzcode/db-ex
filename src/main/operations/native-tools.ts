import { spawn } from 'node:child_process'
import { open, mkdtemp, rm, copyFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { isMysqlFamily } from '../../shared/relational-capabilities'
import type { ConnectionConfig } from '../../shared/types'
import type { ToolName, NativeToolTask } from '../../shared/preferences'

export const nativeTasks={
 'mysql-backup':{kind:'mysql',tool:'mysqldump',write:false,extension:'sql'},
 'mysql-restore':{kind:'mysql',tool:'mysql',write:true,extension:'sql'},
 'mariadb-backup':{kind:'mariadb',tool:'mariadb-dump',write:false,extension:'sql'},
 'mariadb-restore':{kind:'mariadb',tool:'mariadb',write:true,extension:'sql'},
 'mongo-backup':{kind:'mongodb',tool:'mongodump',write:false,extension:'archive'},
 'mongo-restore':{kind:'mongodb',tool:'mongorestore',write:true,extension:'archive'},
 'mongo-export':{kind:'mongodb',tool:'mongoexport',write:false,extension:'json'},
 'mongo-import':{kind:'mongodb',tool:'mongoimport',write:true,extension:'json'},
} as const
function safeName(value:string, collection=false){
 if(typeof value!=='string'||!value||value.length>200||value.startsWith('-')||/[\u0000-\u001f\u007f]/.test(value)||(!collection&&!/^[\p{L}\p{N}_-]+$/u.test(value))|| (collection&&/[*?]/.test(value)))throw new Error('INVALID_DATABASE: 数据库名称无效')
 return value
}
function mysqlOption(value:string){if(/[\u0000-\u001f]/.test(value))throw new Error('INVALID_CONNECTION: 数据库类型错误');return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'}
export function nativeToolCommand(task:NativeToolTask,config:ConnectionConfig,database:string,entity:string|undefined,credentials:string,input:string){
 const spec=nativeTasks[task]
 if(!spec||spec.kind!==config.kind||config.ssh.enabled||config.tls.enabled||config.proxy?.enabled||config.uri||config.nodes?.length||config.mongoReplicaSet||config.mongoTopology==='discover')throw new Error('NATIVE_TOOL_CONNECTION: 外部工具当前仅支持普通直连。')
 safeName(database)
 if(isMysqlFamily(config.kind)){
   const contents=['[client]','host='+mysqlOption(config.host),'port='+config.port,'protocol=TCP','user='+mysqlOption(config.username||''),'password='+mysqlOption(config.password||'')].join('\n')+'\n'
   const args=['--defaults-file='+credentials,...(config.kind==='mariadb'?['--skip-ssl']:['--no-login-paths','--ssl-mode=DISABLED'])]
   if(task==='mysql-backup'||task==='mariadb-backup')args.push('--single-transaction','--skip-lock-tables',...(config.kind==='mysql'?['--no-tablespaces']:[]),'--hex-blob','--',database)
   else args.push('--binary-mode','--local-infile=0','--database='+database)
   return {args,contents}
 }
 const auth=config.username?encodeURIComponent(config.username)+':'+encodeURIComponent(config.password||'')+'@':''
 const host=config.host.includes(':')?'['+config.host+']':config.host
 const uri='mongodb://'+auth+host+':'+config.port+'/?directConnection=true'+(config.username?'&authSource='+encodeURIComponent(config.authSource||'admin'):'')
 const contents='uri: '+JSON.stringify(uri)+'\n'
 const args=['--config='+credentials]
 if(task==='mongo-backup')args.push('--db='+database,'--archive')
 else if(task==='mongo-restore')args.push('--archive='+input,'--nsInclude='+database+'.*','--stopOnError')
 else{
   const collection=safeName(entity||'',true)
   args.push('--db='+database,'--collection='+collection)
   if(task==='mongo-export')args.push('--type=json','--jsonFormat=canonical')
   else args.push('--file='+input,'--type=json','--mode=insert','--stopOnError')
 }
 return {args,contents}
}
function child(path:string,args:string[],options:{stdin?:number;stdout?:number;signal?:AbortSignal;timeout:number;capture?:boolean}):Promise<string>{
 return new Promise((resolve,reject)=>{
   if(options.signal?.aborted){reject(new Error('CANCELLED: 已取消操作'));return}
   let output='',done=false,terminalError:Error|undefined
   const proc=spawn(path,args,{shell:false,windowsHide:true,stdio:[options.stdin??'ignore',options.capture?'pipe':options.stdout??'ignore',options.capture?'pipe':'ignore']})
   const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(output.trim().slice(0,1000))}
   const stop=(error:Error)=>{if(!terminalError){terminalError=error;proc.kill('SIGKILL')}}
   const abort=()=>stop(new Error('CANCELLED: 已取消操作'))
   const timer=setTimeout(()=>stop(new Error('TIMEOUT: 操作超时')),options.timeout)
   options.signal?.addEventListener('abort',abort,{once:true})
   const collect=(chunk:Buffer)=>{if(terminalError)return;output+=chunk.toString('utf8');if(output.length>32768)stop(new Error('LIMIT_EXCEEDED: 外部工具'))}
   proc.stdout?.on('data',collect);proc.stderr?.on('data',collect)
   proc.on('error',()=>{terminalError ||= new Error('NATIVE_TOOL_FAILED: 外部工具执行失败。')})
   // Wait for the child to exit before closing handles or removing credentials.
   proc.on('close',code=>finish(terminalError || (code===0?undefined:new Error('NATIVE_TOOL_FAILED: 外部工具执行失败。'))))
 })
}
export async function toolVersion(path:string){return child(path,['--version'],{capture:true,timeout:8000})}
export async function runNativeTool(path:string,task:NativeToolTask,config:ConnectionConfig,database:string,entity:string|undefined,file:string,signal:AbortSignal){
 const spec=nativeTasks[task]
 if(!spec)throw new Error('INVALID_OPERATION: 不支持的操作')
 const secretDir=await mkdtemp(join(tmpdir(),'dbex-tool-'))
 let outDir:string|undefined
 let inputHandle:Awaited<ReturnType<typeof open>>|undefined,outputHandle:Awaited<ReturnType<typeof open>>|undefined
 try{
   const credentials=join(secretDir,isMysqlFamily(config.kind)?'client.cnf':'mongo.yml')
   const command=nativeToolCommand(task,config,database,entity,credentials,file)
   await writeFile(credentials,command.contents,{mode:0o600,flag:'wx'})
   let resultPath:string|undefined
   if(spec.write){
     if(!(await stat(file)).isFile())throw new Error('INVALID_INPUT: 数据文件')
     if(task==='mysql-restore'||task==='mariadb-restore')inputHandle=await open(file,'r')
   }else{
     // Native tools stream into a private temporary file. Do not truncate an
     // existing backup, and never publish output when the command failed.
     outDir=await mkdtemp(join(dirname(file),'.dbex-export-'))
     resultPath=join(outDir,'output');outputHandle=await open(resultPath,'wx',0o600)
   }
   await child(path,command.args,{stdin:inputHandle?.fd,stdout:outputHandle?.fd,signal,timeout:30*60*1000})
   if(signal.aborted)throw new Error('CANCELLED: 已取消操作')
   await outputHandle?.close();outputHandle=undefined
   if(resultPath)await copyFile(resultPath,file,constants.COPYFILE_EXCL)
 }finally{
   await inputHandle?.close().catch(()=>{});await outputHandle?.close().catch(()=>{})
   await rm(secretDir,{recursive:true,force:true})
   if(outDir)await rm(outDir,{recursive:true,force:true})
 }
}
