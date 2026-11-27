import {randomUUID} from 'node:crypto'
import {open,mkdtemp,rm,lstat} from 'node:fs/promises'
import {basename,dirname,join} from 'node:path'
import type {ConnectionConfig} from '../../shared/types'
import type {FilePreview,FileTransferJob,FileTransferRequest,DataFileFormat} from '../../shared/file-transfer'
import {dataFileFormat,dataFileDelimiter} from '../../shared/file-transfer'
import {inspectFile,sameFile,readFileRecords,mapRecord,sqlFileValue,csvLine,RECORD_BYTES,type FileIdentity} from './records'
import {MysqlMigrationEndpoint} from '../migration/mysql-endpoint'
import {MongoMigrationEndpoint} from '../migration/mongo-endpoint'
import {SqliteMigrationEndpoint} from '../migration/sqlite-endpoint'
import type {SqliteProcessFactory} from '../operations/sqlite-client'
import {publishNewFile} from '../operations/publish-file'
import {protectedDatabase} from '../../shared/database-admin'
import {checkAborted} from '../operations/common'
import {BSON} from 'mongodb'
import {validateReadDocument} from '../operations/mongodb'
type Preview={id:string;path:string;stamp:FileIdentity;preview:FilePreview}
type Active={job:FileTransferJob;controller:AbortController;done:Promise<void>}
type Runner=(work:(config:ConnectionConfig,signal:AbortSignal)=>Promise<void>)=>Promise<void>
function safeFailure(e:unknown){
 const message=e instanceof Error?e.message:''
 if(/^(?:FILE_TRANSFER|MIGRATION_[A-Z_]+|CANCELLED|OUTPUT_EXISTS|OUTPUT_FILESYSTEM):/.test(message))return message
 return 'FILE_TRANSFER: '+String((e as {code?:unknown})?.code||'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)
}
export class FileTransferService{
 private previews=new Map<number,Preview>()
 private active=new Map<number,Active>()
 private jobs=new Map<number,FileTransferJob>()
 private closed=new Set<number>()
 constructor(private readonly factory?:SqliteProcessFactory,private readonly workerPath?:string){}
 async pick(owner:number,id:string,path:string,formatValue:unknown,delimiterValue:unknown):Promise<FilePreview>{
  if(this.active.has(owner))throw new Error('FILE_TRANSFER: 当前已有文件传输任务')
  const format=dataFileFormat(formatValue),delimiter=dataFileDelimiter(delimiterValue),info=await inspectFile(path,format,delimiter)
  const preview={token:randomUUID(),name:basename(path),size:info.identity.size,format,delimiter,fields:info.fields,sample:info.sample}
  if(this.closed.has(owner))throw new Error('CANCELLED: 已取消操作')
  this.previews.set(owner,{id,path,stamp:info.identity,preview})
  return structuredClone(preview)
 }
 importPreview(owner:number,id:string,request:FileTransferRequest){
  const stored=this.previews.get(owner)
  if(!stored||stored.id!==id||stored.preview.token!==request.token||stored.preview.format!==request.format||stored.preview.delimiter!==request.delimiter)throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
  if(request.mapping?.some(m=>!stored.preview.fields.includes(m.source)))throw new Error('FILE_TRANSFER: 字段映射无效')
  return stored
 }
 list(owner:number){const job=this.jobs.get(owner);return job?structuredClone(job):null}
 cancel(owner:number,id:string){const active=this.active.get(owner);if(active?.job.id===id)active.controller.abort()}
 async closeOwner(owner:number){this.closed.add(owner);this.previews.delete(owner);const active=this.active.get(owner);active?.controller.abort();await active?.done.catch(()=>{});this.jobs.delete(owner)}
 async closeAll(){await Promise.allSettled([...new Set([...this.previews.keys(),...this.active.keys(),...this.jobs.keys()])].map(id=>this.closeOwner(id)))}
 start(owner:number,id:string,request:FileTransferRequest,output:string|undefined,runner:Runner){
  if(this.closed.has(owner)||this.active.has(owner))throw new Error('FILE_TRANSFER: 当前已有文件传输任务')
  const preview=request.direction==='import'?this.importPreview(owner,id,request):undefined
  const path=preview?.path||output
  if(!path)throw new Error('FILE_TRANSFER: 参数无效')
  const job:FileTransferJob={id:randomUUID(),direction:request.direction,state:'running',read:0,committed:0,skipped:0,bytes:0,file:basename(path),errors:[]}
  const controller=new AbortController()
  this.previews.delete(owner);this.jobs.set(owner,job)
  let uncertain=false
  const done=Promise.resolve().then(()=>runner(async(config,parent)=>{
   const signal=AbortSignal.any([parent,controller.signal])
   checkAborted(signal)
   if(protectedDatabase(config.kind,request.database))throw new Error('FILE_TRANSFER: 不允许操作系统数据库')
   const endpoint=config.kind==='sqlite'?await SqliteMigrationEndpoint.open(config,signal,this.factory,this.workerPath):config.kind==='mongodb'?await MongoMigrationEndpoint.open(config,signal):await MysqlMigrationEndpoint.open(config,signal)
   try{
    const target=request.database,entity=request.entity
    if(request.direction==='export'){
     // Fail before a scan if the destination already exists. Final atomic
     // publication still guards a concurrent creator of the same path.
     try{await lstat(path);throw new Error('OUTPUT_EXISTS: 目标文件已存在，不会覆盖')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
     const columns=request.fields||(endpoint instanceof MongoMigrationEndpoint?undefined:await endpoint.fileFields(target,entity))
     if(request.format==='csv'&&!columns?.length)throw new Error('FILE_TRANSFER: CSV 导出需要指定字段')
     const folder=await mkdtemp(join(dirname(path),'.dbex-file-')),staged=join(folder,'data')
     try{
      const handle=await open(staged,'wx',0o600)
      try{
       if(request.format==='csv'){const header=csvLine(columns!,request.delimiter);await handle.writeFile(header);job.bytes+=Buffer.byteLength(header)}
       const rows=endpoint instanceof MongoMigrationEndpoint?endpoint.fileRows(target,entity,columns,request.mongoFilter):endpoint.fileRows(target,entity,columns,request.filter)
       for await(const row of rows){
        checkAborted(signal)
        const line=request.format==='csv'?csvLine(columns!.map(c=>Object.hasOwn(row,c)?row[c]:null),request.delimiter):JSON.stringify(row)+'\n'
        const length=Buffer.byteLength(line);if(length>RECORD_BYTES)throw new Error('FILE_TRANSFER: 单条文件记录过大')
        await handle.writeFile(line);job.bytes+=length;job.read++
       }
       await handle.sync()
      }finally{await handle.close()}
      await publishNewFile(staged,path,signal,request.format==='jsonl');job.committed=job.read
     }finally{await rm(folder,{recursive:true,force:true})}
    }else{
     const file=await open(path,'r')
     try{
      if(!sameFile(await file.stat(),preview!.stamp))throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
      const mongo=endpoint instanceof MongoMigrationEndpoint
      const records=(async function*(){
       for await(const row of readFileRecords(file,request.format,request.delimiter,signal,n=>{job.bytes+=n})){
        checkAborted(signal);job.read++
        let record:Record<string,unknown>
        try{
         record=mapRecord(row,request,mongo)
         const size=Buffer.byteLength(JSON.stringify(record));if(size>RECORD_BYTES)throw new Error('FILE_TRANSFER: 单条文件记录过大')
         if(mongo){const doc=BSON.EJSON.parse(JSON.stringify(record),{relaxed:false});validateReadDocument(doc);if(request.policy==='upsert'&&!Object.hasOwn(doc,'_id'))throw new Error('FILE_TRANSFER: 插入更新需要映射全部主键');BSON.serialize(doc)}
         else Object.values(record).forEach(sqlFileValue)
        }catch(e){if(!request.skipInvalid)throw new Error('FILE_TRANSFER: 第 '+job.read+' 条记录转换失败');job.skipped++;if(job.errors!.length<200)job.errors!.push({row:job.read,code:'INVALID_VALUE'});continue}
        yield record
       }
       if(!sameFile(await file.stat(),preview!.stamp))throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
      })()
      const beginCommit=()=>{uncertain=true},commit=(n:number)=>{job.committed+=n;uncertain=false}
      if(mongo)await endpoint.fileWrite(target,entity,request.policy||'append',records,beginCommit,commit)
      else await endpoint.fileWrite(target,entity,request.mapping!.map(m=>m.target),request.policy||'append',records,beginCommit,commit)
      job.bytes=preview!.stamp.size
     }finally{await file.close()}
    }
   }finally{await endpoint.close()}
  })).then(()=>{job.state='completed'},e=>{job.state=uncertain?'uncertain':controller.signal.aborted?'cancelled':'failed';job.error=safeFailure(e)}).finally(()=>{if(this.active.get(owner)?.controller===controller)this.active.delete(owner)})
  this.active.set(owner,{job,controller,done})
  return structuredClone(job)
 }
}
