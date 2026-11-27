import { spawn } from 'node:child_process'
import { open, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import {publishNewFile} from './publish-file'
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
export type NativeRoute={host:string;port:number;tlsVerified?:true}
export function nativeToolCommand(task:NativeToolTask,config:ConnectionConfig,database:string,entity:string|undefined,credentials:string,input:string,route?:NativeRoute){
 const spec=nativeTasks[task]
 const routed=config.ssh.enabled||config.proxy?.enabled
 const unsupported=()=>new Error('NATIVE_TOOL_CONNECTION: 不支持此原生工具连接方式。')
 if(!spec||spec.kind!==config.kind||config.uri||config.nodes?.length||config.mongoReplicaSet||config.mongoTopology==='discover')throw unsupported()
 if(routed&&(!route||route.host!=='127.0.0.1'||!Number.isInteger(route.port)||route.port<1||route.port>65535||config.tls.enabled&&!(config.kind==='mongodb'&&route.tlsVerified))||!routed&&route)throw unsupported()
 if(route?.tlsVerified&&(!routed||!config.tls.enabled||config.kind!=='mongodb'))throw unsupported()
 const localTls=config.tls.enabled&&!route?.tlsVerified
 if(localTls&&(config.tls.servername&&config.tls.servername!==config.host||config.kind==='mongodb'&&(config.tls.certPath||config.tls.keyPath)))throw unsupported()
 const endpoint=route||config
 safeName(database)
 if(isMysqlFamily(config.kind)){
   const contents=['[client]','host='+mysqlOption(endpoint.host),'port='+endpoint.port,'protocol=TCP','user='+mysqlOption(config.username||''),'password='+mysqlOption(config.password||''),...(config.tls.enabled?[...(config.tls.caPath?['ssl-ca='+mysqlOption(config.tls.caPath)]:[]),...(config.tls.certPath?['ssl-cert='+mysqlOption(config.tls.certPath)]:[]),...(config.tls.keyPath?['ssl-key='+mysqlOption(config.tls.keyPath)]:[])]:[])].join('\n')+'\n'
   const args=['--defaults-file='+credentials,...(config.kind==='mariadb'?(config.tls.enabled?['--ssl','--ssl-verify-server-cert']:['--skip-ssl']):[config.tls.enabled?'--ssl-mode=VERIFY_IDENTITY':'--ssl-mode=DISABLED'])]
   if(task==='mysql-backup'||task==='mariadb-backup')args.push('--single-transaction','--skip-lock-tables',...(config.kind==='mysql'?['--no-tablespaces']:[]),'--hex-blob','--',database)
   else args.push('--binary-mode','--local-infile=0','--database='+database)
   return {args,contents}
 }
 const auth=config.username?encodeURIComponent(config.username)+':'+encodeURIComponent(config.password||'')+'@':''
 const host=endpoint.host.includes(':')?'['+endpoint.host+']':endpoint.host
 const uri='mongodb://'+auth+host+':'+endpoint.port+'/?directConnection=true'+(localTls?'&tls=true':'')+(config.username?'&authSource='+encodeURIComponent(config.authSource||'admin'):'')
 const contents='uri: '+JSON.stringify(uri)+'\n'
 const args=['--config='+credentials,...(localTls?['--ssl',...(config.tls.caPath?['--sslCAFile='+config.tls.caPath]:[])]:[])]
 if(task==='mongo-backup'){
   args.push('--db='+database,'--archive')
   if(entity!==undefined)args.push('--collection='+safeName(entity,true))
 }else if(task==='mongo-restore'){
   // nsInclude is a namespace pattern. Reject ambiguous glob/escape
   // characters when a single collection is explicitly selected.
   const collection=entity===undefined?'*':safeName(entity,true)
   if(entity!==undefined&&/[\\*?]/.test(collection))throw new Error('INVALID_DATABASE: 数据库名称无效')
   args.push('--archive='+input,'--nsInclude='+database+'.'+collection,'--stopOnError')
 }
 else{
   const collection=safeName(entity||'',true)
   args.push('--db='+database,'--collection='+collection)
   if(task==='mongo-export')args.push('--type=json','--jsonFormat=canonical')
   else args.push('--file='+input,'--type=json','--mode=insert','--stopOnError')
 }
 return {args,contents}
}
/**
 * MySQL 8.0 does not understand --no-login-paths (introduced in newer
 * clients). Both 8.0 and 8.4 honor MYSQL_TEST_LOGIN_FILE. Point it at a
 * nonexistent file inside the private credentials directory instead of
 * letting a user's .mylogin.cnf override the selected target.
 * Applies to the SQL-family native tools and their independent CLI.
 */
export function nativeToolEnvironment(args:readonly string[],base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv|undefined{
 const prefix='--defaults-file='
 if(!args[0]?.startsWith(prefix))return undefined
 const env={...base}
 const blocked=new Set(['MYSQL_TEST_LOGIN_FILE','MYSQL_PWD','MYSQL_HOST','MYSQL_TCP_PORT','MYSQL_UNIX_PORT','MYSQL_HOME','MYSQL_GROUP_SUFFIX','MYSQL_HISTFILE','MYSQL_PS1','LIBMYSQL_PLUGIN_DIR','MYSQL_PLUGIN_DIR'])
 for(const key of Object.keys(env))if(blocked.has(key.toUpperCase()))delete env[key]
 env.MYSQL_TEST_LOGIN_FILE=join(dirname(args[0].slice(prefix.length)),'.dbex-no-login.cnf')
 return env
}
function child(path:string,args:string[],options:{stdin?:number;stdout?:number;signal?:AbortSignal;timeout:number;capture?:boolean}):Promise<string>{
 return new Promise((resolve,reject)=>{
   if(options.signal?.aborted){reject(new Error('CANCELLED: 已取消操作'));return}
   let output='',done=false,terminalError:Error|undefined
   const proc=spawn(path,args,{shell:false,windowsHide:true,env:nativeToolEnvironment(args),stdio:[options.stdin??'ignore',options.capture?'pipe':options.stdout??'ignore',options.capture?'pipe':'ignore']})
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
export async function runNativeTool(path:string,task:NativeToolTask,config:ConnectionConfig,database:string,entity:string|undefined,file:string,signal:AbortSignal,route?:NativeRoute){
 const spec=nativeTasks[task]
 if(!spec)throw new Error('INVALID_OPERATION: 不支持的操作')
 const secretDir=await mkdtemp(join(tmpdir(),'dbex-tool-'))
 let outDir:string|undefined
 let inputHandle:Awaited<ReturnType<typeof open>>|undefined,outputHandle:Awaited<ReturnType<typeof open>>|undefined
 try{
   const credentials=join(secretDir,isMysqlFamily(config.kind)?'client.cnf':'mongo.yml')
   const command=nativeToolCommand(task,config,database,entity,credentials,file,route)
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
   if(resultPath)await publishNewFile(resultPath,file,signal,task==='mongo-export')
 }finally{
   await inputHandle?.close().catch(()=>{});await outputHandle?.close().catch(()=>{})
   await rm(secretDir,{recursive:true,force:true})
   if(outDir)await rm(outDir,{recursive:true,force:true})
 }
}
