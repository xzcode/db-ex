import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {StringDecoder} from 'node:string_decoder'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {isAbsolute,join} from 'node:path'
import type {ConnectionConfig,NativeCliSnapshot} from '../../shared/types'
import {inspectSql} from './sql-policy'
import {inspectSqliteSql} from './sqlite-policy'
import {nativeToolCommand,type NativeRoute} from './native-tools'

const OUTPUT_LIMIT=256*1024
const INPUT_LIMIT=64*1024
export const cliToolFor=(kind:unknown)=>kind==='mysql'?'mysql':kind==='mariadb'?'mariadb':kind==='sqlite'?'sqlite3':undefined
export function cliStatement(kind:ConnectionConfig['kind'],value:unknown){
 if(typeof value!=='string'||Buffer.byteLength(value)>INPUT_LIMIT||/[\\\u0000\r\n]/.test(value))throw new Error('INVALID_INPUT: Native CLI SQL')
 // Fixed transaction commands on the independent CLI session; no client shell commands.
 const tx=/^(?:BEGIN(?: TRANSACTION)?|START TRANSACTION|COMMIT|ROLLBACK)\s*;?$/i.exec(value.trim())
 if(tx){
  let sql=value.trim().replace(/;$/,'').trim().toUpperCase()
  if(kind==='sqlite'&&sql==='START TRANSACTION')sql='BEGIN'
  if(kind!=='sqlite'&&sql==='BEGIN TRANSACTION')sql='START TRANSACTION'
  return {sql,mode:'write' as const}
 }
 if(kind==='sqlite')return inspectSqliteSql(value)
 if(kind==='mysql'||kind==='mariadb')return inspectSql(value,true)
 throw new Error('INVALID_OPERATION: Native CLI engine')
}
export class NativeCliProcess{
 private proc?:ChildProcessWithoutNullStreams
 private transcript=''
 private pending?:string
 private tail=''
 private decoder=new StringDecoder('utf8')
 private errDecoder=new StringDecoder('utf8')
 private timeout?:ReturnType<typeof setTimeout>
 private life?:ReturnType<typeof setTimeout>
 private killTimer?:ReturnType<typeof setTimeout>
 private closed=false
 private status='connecting'
 readonly finished:Promise<void>
 private finish!:()=>void
 constructor(private readonly kind:ConnectionConfig['kind'],private readonly redact:(text:string)=>string){
  this.finished=new Promise(resolve=>this.finish=resolve)
 }
 private append(value:string){this.transcript=(this.transcript+value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')).slice(-OUTPUT_LIMIT)}
 private receive(chunk:Buffer){
  this.tail+=this.decoder.write(chunk)
  let end=this.tail.indexOf('\n')
  while(end>=0){
   const line=this.tail.slice(0,end).replace(/\r$/,'')
   this.tail=this.tail.slice(end+1)
   if(this.pending&&line===this.pending){this.pending=undefined;clearTimeout(this.timeout);if(this.status!=='stopping')this.status='ready'}
   else this.append(this.redact(line)+'\n')
   end=this.tail.indexOf('\n')
  }
  if(this.tail.length>OUTPUT_LIMIT){this.append(this.redact(this.tail.slice(0,-512)));this.tail=this.tail.slice(-512)}
 }
 async start(path:string,args:string[],signal:AbortSignal){
  if(signal.aborted||this.closed)throw new Error('CANCELLED: 已取消操作')
  const proc=spawn(path,args,{shell:false,windowsHide:true,stdio:'pipe'})
  this.proc=proc
  const abort=()=>this.stop()
  signal.addEventListener('abort',abort,{once:true})
  this.life=setTimeout(()=>this.stop(),30*60*1000)
  proc.stdout.on('data',c=>this.receive(c))
  proc.stderr.on('data',c=>this.append(this.redact(this.errDecoder.write(c))))
  proc.stdin.on('error',()=>this.stop())
  proc.once('close',code=>{
   if(this.tail)this.append(this.redact(this.tail))
   this.append(this.redact(this.decoder.end()+this.errDecoder.end()))
   this.closed=true;this.pending=undefined;this.status=code===0?'closed':'stopped'
   clearTimeout(this.timeout);clearTimeout(this.life);clearTimeout(this.killTimer);signal.removeEventListener('abort',abort);this.finish()
  })
  await new Promise<void>((resolve,reject)=>{
   proc.once('spawn',()=>resolve())
   proc.once('error',()=>reject(new Error('NATIVE_TOOL_FAILED: 外部工具执行失败。')))
  })
  if(signal.aborted||this.closed){this.stop();throw new Error('CANCELLED: 已取消操作')}
  this.status='ready'
  this.send('SELECT 1')
  const until=Date.now()+12000
  while(this.pending&&!this.closed&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50))
  if(this.pending||this.closed){this.stop();throw new Error('NATIVE_TOOL_FAILED: 外部工具执行失败。')}
  this.transcript=''
 }
 snapshot():NativeCliSnapshot{return {output:this.transcript,status:this.status,running:!!this.pending,closed:this.closed}}
 send(input:unknown){
  if(this.closed||!this.proc||this.pending||this.status!=='ready')throw new Error('SESSION_BUSY: 当前连接正在执行操作')
  const plan=cliStatement(this.kind,input)
  const marker='dbex_done_'+randomUUID().replaceAll('-','')
  this.pending=marker;this.status='running'
  this.timeout=setTimeout(()=>{this.append('\nTIMEOUT\n');this.stop()},30000)
  this.proc.stdin.write(plan.sql+'\n;\nSELECT \''+marker+'\';\n')
 }
 stop(){
  if(this.closed||this.status==='stopping')return
  this.status='stopping'
  if(this.proc){this.proc.stdin.end();this.killTimer=setTimeout(()=>this.proc?.kill('SIGKILL'),2000)}else{this.closed=true;this.status='stopped';this.finish()}
 }
}
export async function prepareNativeCli(config:ConnectionConfig,database:string,route?:NativeRoute){
 const tool=cliToolFor(config.kind)
 if(!tool)throw new Error('INVALID_OPERATION: Native CLI engine')
 const dir=await mkdtemp(join(tmpdir(),'dbex-cli-'))
 const cleanup=()=>rm(dir,{recursive:true,force:true})
 try{
  if(config.kind==='sqlite'){
   if(!config.filePath||!isAbsolute(config.filePath)||!(await stat(config.filePath)).isFile())throw new Error('INVALID_INPUT: SQLite file')
   return {args:['-batch','-safe','-init',process.platform==='win32'?'NUL':'/dev/null','-noheader','-separator','\t',config.filePath],cleanup}
  }
  const credential=join(dir,'client.cnf')
  const spec=nativeToolCommand(config.kind==='mysql'?'mysql-restore':'mariadb-restore',config,database,undefined,credential,'',route)
  await writeFile(credential,spec.contents,{flag:'wx',mode:0o600})
  return {args:[...spec.args,'--batch','--raw','--unbuffered','--skip-column-names','--force'],cleanup}
 }catch(error){await cleanup();throw error}
}
