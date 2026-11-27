import {randomUUID} from 'node:crypto'
import {open,mkdtemp,rm,lstat,copyFile,type FileHandle} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,dirname,join} from 'node:path'
import type {ConnectionConfig} from '../../shared/types'
import type {FilePreview,FileTransferJob,FileTransferRequest,DataFileFormat} from '../../shared/file-transfer'
import {dataFileFormat,dataFileDelimiter,dataFileEncoding} from '../../shared/file-transfer'
import {inspectFile,sameFile,readFileRecords,mapRecord,sqlFileValue,csvLine,RECORD_BYTES,type FileIdentity} from './records'
import {sqlInsertLine} from './sql-records'
import {writeXlsxRecords} from './xlsx-records'
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
 private reports=new Map<number,{id:string;dir:string;path:string}>()
 constructor(private readonly factory?:SqliteProcessFactory,private readonly workerPath?:string){}
 async pick(owner:number,id:string,path:string,formatValue:unknown,delimiterValue:unknown,encodingValue?:unknown):Promise<FilePreview>{
  if(this.active.has(owner))throw new Error('FILE_TRANSFER: 当前已有文件传输任务')
  const format=dataFileFormat(formatValue),delimiter=dataFileDelimiter(delimiterValue),encoding=dataFileEncoding(encodingValue)
  if(format==='xlsx'&&encoding!=='utf-8')throw Error('FILE_TRANSFER: 不支持的文件编码')
  const info=await inspectFile(path,format,delimiter,encoding,undefined,true)
  const preview:FilePreview={token:randomUUID(),name:basename(path),size:info.identity.size,format,delimiter,encoding,fields:info.fields,sample:info.sample,worksheet:info.worksheet,worksheets:info.worksheets,previewError:info.previewError}
  if(this.closed.has(owner))throw new Error('CANCELLED: 已取消操作')
  this.previews.set(owner,{id,path,stamp:info.identity,preview})
  return structuredClone(preview)
 }
 async previewSheet(owner:number,id:string,token:unknown,worksheet:unknown):Promise<FilePreview>{
  const stored=this.previews.get(owner)
  if(this.active.has(owner)||this.closed.has(owner)||!stored||stored.id!==id||stored.preview.token!==token||stored.preview.format!=='xlsx'||typeof worksheet!=='string'||worksheet!=='*'&&!stored.preview.worksheets?.includes(worksheet))throw Error('FILE_TRANSFER: Excel 工作表无效')
  const info=await inspectFile(stored.path,'xlsx',stored.preview.delimiter,'utf-8',worksheet,true)
  if(!sameFile(info.identity,stored.stamp)||this.previews.get(owner)!==stored||this.closed.has(owner)||this.active.has(owner))throw Error('FILE_TRANSFER: 文件已变化，请重新预览')
  const preview:FilePreview={...stored.preview,token:randomUUID(),fields:info.fields,sample:info.sample,worksheet:info.worksheet,worksheets:info.worksheets,previewError:info.previewError}
  this.previews.set(owner,{...stored,preview})
  return structuredClone(preview)
 }
 importPreview(owner:number,id:string,request:FileTransferRequest){
  const stored=this.previews.get(owner)
  if(!stored||stored.id!==id||stored.preview.token!==request.token||stored.preview.format!==request.format||stored.preview.delimiter!==request.delimiter||dataFileEncoding(stored.preview.encoding)!==dataFileEncoding(request.encoding))throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
  if(stored.preview.previewError)throw Error(stored.preview.previewError)
  if(request.worksheet!==undefined&&request.worksheet!==stored.preview.worksheet)throw Error('FILE_TRANSFER: Excel 工作表无效')
  if(request.mapping?.some(m=>!stored.preview.fields.includes(m.source)))throw new Error('FILE_TRANSFER: 字段映射无效')
  return stored
 }
 list(owner:number){const job=this.jobs.get(owner);return job?structuredClone(job):null}
 cancel(owner:number,id:string){const active=this.active.get(owner);if(active?.job.id===id)active.controller.abort()}
 async saveReport(owner:number,id:string,output:string){
  const entry=this.reports.get(owner),job=this.jobs.get(owner)
  if(!entry||entry.id!==id||job?.id!==id||job.state==='running')throw new Error('FILE_TRANSFER: 错误报告不可用')
  const dir=await mkdtemp(join(dirname(output),'.dbex-report-')),staged=join(dir,'errors.csv')
  try{await copyFile(entry.path,staged);await publishNewFile(staged,output)}finally{await rm(dir,{recursive:true,force:true})}
 }
 private async clearReport(owner:number){const old=this.reports.get(owner);if(old){this.reports.delete(owner);await rm(old.dir,{recursive:true,force:true})}}
 async closeOwner(owner:number){this.closed.add(owner);this.previews.delete(owner);const active=this.active.get(owner);active?.controller.abort();await active?.done.catch(()=>{});await this.clearReport(owner);this.jobs.delete(owner)}
 async closeAll(){await Promise.allSettled([...new Set([...this.previews.keys(),...this.active.keys(),...this.jobs.keys(),...this.reports.keys()])].map(id=>this.closeOwner(id)))}
 start(owner:number,id:string,request:FileTransferRequest,output:string|undefined,runner:Runner){
  if(this.closed.has(owner)||this.active.has(owner))throw new Error('FILE_TRANSFER: 当前已有文件传输任务')
  const preview=request.direction==='import'?this.importPreview(owner,id,request):undefined
  const path=preview?.path||output
  if(!path)throw new Error('FILE_TRANSFER: 参数无效')
  const job:FileTransferJob={id:randomUUID(),direction:request.direction,state:'running',read:0,committed:0,skipped:0,bytes:0,file:basename(path),errors:[]}
  const controller=new AbortController()
  this.previews.delete(owner);this.jobs.set(owner,job)
  let uncertain=false,report:FileHandle|undefined
  const reportError=async(row:number,code:string)=>{
   if(!report){const dir=await mkdtemp(join(tmpdir(),'.dbex-file-report-')),path=join(dir,'errors.csv');try{report=await open(path,'wx',0o600);this.reports.set(owner,{id:job.id,dir,path});await report.writeFile('record,code\r\n')}catch(e){await report?.close().catch(()=>{});report=undefined;await rm(dir,{recursive:true,force:true});throw e}}
   await report.writeFile(String(row)+','+code+'\r\n');job.hasErrorReport=true
  }
  const done=Promise.resolve().then(async()=>{await this.clearReport(owner);return runner(async(config,parent)=>{
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
     if((request.format==='csv'||request.format==='sql'||request.format==='xlsx')&&!columns?.length)throw new Error('FILE_TRANSFER: CSV 导出需要指定字段')
     const folder=await mkdtemp(join(dirname(path),'.dbex-file-')),staged=join(folder,'data')
     try{
      const rows=endpoint instanceof MongoMigrationEndpoint?endpoint.fileRows(target,entity,columns,request.mongoFilter):endpoint.fileRows(target,entity,columns,request.filter)
      if(request.format==='xlsx'){
       await writeXlsxRecords(staged,columns!,rows,signal,bytes=>{job.read++;job.bytes=bytes})
       job.bytes=(await lstat(staged)).size
      }else{
       const handle=await open(staged,'wx',0o600)
       try{
        if(request.format==='csv'){const header=csvLine(columns!,request.delimiter);await handle.writeFile(header);job.bytes+=Buffer.byteLength(header)}
        if(request.format==='sql'){const header='-- DB EX data-only INSERT export\n';await handle.writeFile(header);job.bytes+=Buffer.byteLength(header)}
        for await(const row of rows){
         checkAborted(signal)
         const line=request.format==='csv'?csvLine(columns!.map(c=>Object.hasOwn(row,c)?row[c]:null),request.delimiter):request.format==='sql'?sqlInsertLine(target,entity,columns!,row,config.kind==='sqlite'?'sqlite':'mysql'):JSON.stringify(row)+'\n'
         const length=Buffer.byteLength(line);if(length>RECORD_BYTES)throw new Error('FILE_TRANSFER: 单条文件记录过大')
         await handle.writeFile(line);job.bytes+=length;job.read++
        }
        await handle.sync()
       }finally{await handle.close()}
      }
      await publishNewFile(staged,path,signal,request.format==='jsonl'||request.format==='sql');job.committed=job.read
     }finally{await rm(folder,{recursive:true,force:true})}
    }else{
     const file=await open(path,'r')
     try{
      if(!sameFile(await file.stat(),preview!.stamp))throw new Error('FILE_TRANSFER: 文件已变化，请重新预览')
      const mongo=endpoint instanceof MongoMigrationEndpoint
      const records=(async function*(){
       for await(const row of readFileRecords(file,request.format,request.delimiter,signal,n=>{job.bytes+=n},dataFileEncoding(request.encoding),preview!.preview.worksheet)){
        checkAborted(signal);job.read++
        let record:Record<string,unknown>
        try{
         record=mapRecord(row,request,mongo)
         const size=Buffer.byteLength(JSON.stringify(record));if(size>RECORD_BYTES)throw new Error('FILE_TRANSFER: 单条文件记录过大')
         if(mongo){const doc=BSON.EJSON.parse(JSON.stringify(record),{relaxed:false});validateReadDocument(doc);if(request.policy==='upsert'&&!Object.hasOwn(doc,'_id'))throw new Error('FILE_TRANSFER: 插入更新需要映射全部主键');BSON.serialize(doc)}
         else Object.values(record).forEach(sqlFileValue)
        }catch(e){await reportError(job.read,'INVALID_VALUE');if(job.errors!.length<200)job.errors!.push({row:job.read,code:'INVALID_VALUE'});if(!request.skipInvalid)throw new Error('FILE_TRANSFER: 第 '+job.read+' 条记录转换失败');job.skipped++;continue}
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
  })}).then(async()=>{try{await report?.sync()}catch{job.hasErrorReport=false}finally{await report?.close().catch(()=>{});report=undefined}job.state='completed'},async e=>{await report?.close().catch(()=>{});report=undefined;job.state=uncertain?'uncertain':controller.signal.aborted?'cancelled':'failed';job.error=safeFailure(e)}).catch(e=>{job.state='failed';job.error=safeFailure(e)}).finally(()=>{if(this.active.get(owner)?.controller===controller)this.active.delete(owner)})
  this.active.set(owner,{job,controller,done})
  return structuredClone(job)
 }
}
