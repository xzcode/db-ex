import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,open,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import type {ConnectionConfig} from '../../shared/types'
import type {FileTransferRequest,FileTransferJob} from '../../shared/file-transfer'
import {RedisMigrationEndpoint} from '../migration/redis-endpoint'
import {checkAborted} from '../operations/common'
import {publishNewFile} from '../operations/publish-file'
import {sameFile,readFileRecords,type FileIdentity} from './records'

export const redisDumpTypes:Record<string,readonly number[]>={string:[0],list:[1,10,14,18],set:[2,11,20],zset:[3,5,12,17],hash:[4,9,13,16,22,23,24,25],stream:[15,19,21]}
export interface RedisArchiveRecord {version:1;keyBase64:string;type:string;dumpBase64:string;expiresAt:number|null}
const invalid=()=>new Error('FILE_TRANSFER: Redis Key 存档记录无效或不支持的数据类型')
function binary(text:unknown,max:number,empty=false){
 if(typeof text!=='string'||text.length>Math.ceil(max/3)*4||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)))throw invalid()
 const value=Buffer.from(text,'base64')
 if((!empty&&!value.length)||value.length>max||value.toString('base64')!==text)throw invalid()
 return value
}
export function decodeRedisArchiveRecord(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))throw invalid()
 const v=input as RedisArchiveRecord
 if(Object.keys(v).length!==5||v.version!==1||typeof v.type!=='string'||!Object.hasOwn(redisDumpTypes,v.type)||v.expiresAt!==null&&(!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=0))throw invalid()
 const key=binary(v.keyBase64,1024*1024,true),dump=binary(v.dumpBase64,4*1024*1024)
 // RDB object discriminator from Redis's documented serialized object layout.
 // Do not accept module or unknown object payloads from a data file.
 if(dump.length<11||!redisDumpTypes[v.type]!.includes(dump[0]!))throw invalid()
 return {key,dump,type:v.type,expiresAt:v.expiresAt}
}
export async function withRedisKeyLedger<T>(work:(first:(key:Buffer)=>boolean)=>Promise<T>){
 const folder=await mkdtemp(join(tmpdir(),'dbex-redis-keys-'))
 let db:DatabaseSync|undefined
 try{
  db=new DatabaseSync(join(folder,'keys.sqlite'),{allowExtension:false})
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE seen(key BLOB PRIMARY KEY) WITHOUT ROWID')
  const insert=db.prepare('INSERT OR IGNORE INTO seen VALUES (?)')
  return await work(key=>Number(insert.run(key).changes)===1)
 }finally{db?.close();await rm(folder,{recursive:true,force:true})}
}
export async function transferRedisArchive(config:ConnectionConfig,request:FileTransferRequest,path:string,stamp:FileIdentity|undefined,job:FileTransferJob,signal:AbortSignal,beforeCommit:()=>void,commit:(count:number)=>void){
 const endpoint=await RedisMigrationEndpoint.open(config,signal)
 try{
  if(request.direction==='export'){
   try{await lstat(path);throw Error('OUTPUT_EXISTS: 目标文件已存在，不会覆盖')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   const folder=await mkdtemp(join(dirname(path),'.dbex-redis-file-')),staged=join(folder,'data')
   try{
    const file=await open(staged,'wx',0o600)
    try{
     await withRedisKeyLedger(async first=>{
      for await(const key of endpoint.archiveKeys(request.database,request.redisPattern,request.redisKeys)){
       checkAborted(signal)
       if(!first(key))continue
       const row=await endpoint.archiveRead(request.database,key)
       job.read++
       if(!row){job.skipped++;continue}
       decodeRedisArchiveRecord(row)
       const line=JSON.stringify(row)+'\n'
       await file.writeFile(line);job.bytes+=Buffer.byteLength(line)
      }
     })
     await file.sync()
    }finally{await file.close()}
    await publishNewFile(staged,path,signal,true)
    job.committed=job.read-job.skipped
   }finally{await rm(folder,{recursive:true,force:true})}
  }else{
   const file=await open(path,'r')
   try{
    if(!stamp||!sameFile(await file.stat(),stamp))throw Error('FILE_TRANSFER: 文件已变化，请重新预览')
    // Validate the entire archive and duplicate identities before any write.
    // Each key is still acknowledged individually; later server errors may
    // leave earlier keys committed.
    await withRedisKeyLedger(async first=>{
     for await(const row of readFileRecords(file,'jsonl',',',signal)){
      const record=decodeRedisArchiveRecord(row)
      if(!first(record.key))throw Error('FILE_TRANSFER: Redis 存档含重复 Key')
     }
    })
    if(!sameFile(await file.stat(),stamp))throw Error('FILE_TRANSFER: 文件已变化，请重新预览')
    for await(const row of readFileRecords(file,'jsonl',',',signal,n=>{job.bytes+=n})){
     checkAborted(signal);job.read++
     const record=decodeRedisArchiveRecord(row)
     beforeCommit()
     const result=await endpoint.archiveRestore(request.database,record,request.policy==='upsert')
     if(result==='expired'){commit(0);job.skipped++;continue}
     if(result==='exists'){commit(0);throw Error('FILE_TRANSFER: Redis 目标 Key 已存在，已停止')}
     if(result==='invalid'){commit(0);throw Error('FILE_TRANSFER: Redis DUMP 校验失败或版本不兼容')}
     commit(1)
    }
    if(!sameFile(await file.stat(),stamp))throw Error('FILE_TRANSFER: 文件已变化，请重新预览')
    job.bytes=stamp.size
   }finally{await file.close()}
  }
 }finally{await endpoint.close()}
}
