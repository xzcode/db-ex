import {Redis} from 'ioredis'
import {performance} from 'node:perf_hooks'
import type {ConnectionConfig} from '../../shared/types'
import type {MigrationCatalog,MigrationMode,MigrationStep,MigrationCopyOptions,MigrationPolicy} from '../../shared/migration'
import {migrationName} from '../../shared/migration'
import {validateConnection} from '../connections/validation'
import {createTransport,type ConnectionTransport} from '../connections/transport'
import {loadConnectionTls} from '../connections/tls-material'
import {createRedisClient,setRedisReadBudget} from '../connections/redis-client'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import type {RedisArchiveRecord} from '../file-transfer/redis-records'
import {checkedSnapshot,requireActive,reviewStep,type MigrationEndpoint,type CopyCallbacks} from './endpoint'

const TYPES=new Set(['string','hash','list','set','zset','stream'])
export function planRedisMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode,policy:MigrationPolicy='append'):MigrationStep[]{
 if(mode==='schema')throw new Error('MIGRATION_UNSUPPORTED: Redis 没有表结构，请使用数据传输')
 const a=new Map(source.objects.map(o=>[o.name,o])),b=new Map(target.objects.map(o=>[o.name,o]))
 return [...new Set([...a.keys(),...b.keys()])].sort().map((name,i)=>{
  const step=reviewStep(name,i),x=a.get(name),y=b.get(name)
  if(!x)return {...step,action:'target-only',changes:['TARGET ONLY OBJECT']}
  if(!TYPES.has(x.type)||y&&(policy!=='upsert'||!TYPES.has(y.type)))return {...step,changes:[y?'TARGET KEY EXISTS — MANUAL REVIEW':'UNSUPPORTED DEFINITION — MANUAL REVIEW']}
  return {...step,action:'copy',changes:[policy==='upsert'?'COPY KEY WITH TTL — REPLACE':'COPY KEY WITH TTL — NO REPLACE'],executable:true,transfer:true}
 })
}
export class RedisMigrationEndpoint implements MigrationEndpoint{
 readonly kind='redis' as const
 private constructor(private client:Redis,private transport:ConnectionTransport,private signal:AbortSignal,readonly identity:string,private database:string){
  signal.addEventListener('abort',this.stop,{once:true})
 }
 private stop=()=>{this.client.disconnect(false);void this.transport.close().catch(()=>{})}
 static async open(input:ConnectionConfig,signal:AbortSignal){
  const config=validateConnection(input)
  if(config.kind!=='redis'||config.redisMode&&config.redisMode!=='standalone')throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  requireActive(signal)
  const transport=await createTransport({ssh:config.ssh,proxy:config.proxy,timeoutMs:config.connectTimeoutMs})
  let client:Redis|undefined
  const stop=()=>{client?.disconnect(false);void transport.close().catch(()=>{})}
  signal.addEventListener('abort',stop,{once:true})
  try{
   const c=await createRedisClient(config,transport,await loadConnectionTls(config))
   if(!(c instanceof Redis)){c.disconnect();throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')}
   client=c
   setRedisReadBudget(c,8*1024*1024)
   const info=await c.info('server'),identity=/^run_id:([a-f0-9]{40})\r?$/m.exec(info)?.[1]
   const role=await c.role()
   if(!identity||!Array.isArray(role)||role[0]!=='master')throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
   const endpoint=new RedisMigrationEndpoint(c,transport,signal,identity,String(config.redisDb||0))
   requireActive(signal);return endpoint
  }catch(e){stop();throw e}finally{signal.removeEventListener('abort',stop)}
 }
 async close(){this.signal.removeEventListener('abort',this.stop);this.client.disconnect(false);await this.transport.close().catch(()=>{})}
 private check(database:string){requireActive(this.signal);if(database!==this.database)throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')}
 private async budget<T>(fn:()=>Promise<T>){
  requireActive(this.signal)
  const budget=setRedisReadBudget(this.client,8*1024*1024)
  try{const value=await fn();requireActive(this.signal);if(budget?.exceeded)throw new Error('MIGRATION_LIMIT: 单行数据超过传输批次限制');return value}
  finally{setRedisReadBudget(this.client,undefined)}
 }
 async catalog(database?:string):Promise<MigrationCatalog>{
  if(database===undefined)return {kind:this.kind,databases:[this.database]}
  this.check(database)
  const keys=new Set<string>();let cursor='0',iterations=0
  do{
   if(++iterations>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
   const [next,values]=await this.budget(()=>this.client.scanBuffer(cursor,'COUNT',100))
   cursor=String(next)
   for(const raw of values){
    const name=raw.toString('utf8')
    if(!Buffer.from(name).equals(raw)||name.length>200||/[\u0000-\u001f\u007f]/.test(name))continue
    keys.add(name)
    if(keys.size>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
   }
  }while(cursor!=='0')
  return {kind:this.kind,databases:[this.database],objects:[...keys].sort().map(name=>({name,type:'key',engine:'Redis'}))}
 }
 async schema(database:string,names?:string[]):Promise<SchemaSnapshot>{
  this.check(database)
  if(!names||names.length>100)throw new Error('MIGRATION_INPUT: 请选择1至100个对象')
  const objects:SchemaObject[]=[]
  for(const name of names){
   const type=await this.budget(()=>this.client.type(migrationName(name)))
   if(type!=='none')objects.push({name,type,engine:'Redis',definition:type,triggerNames:[]})
  }
  return checkedSnapshot(objects)
 }
 async *archiveKeys(database:string,pattern?:string,selected?:string[]){
  this.check(database)
  if(selected){for(const key of selected){requireActive(this.signal);yield Buffer.from(key,'utf8')}return}
  if(typeof pattern!=='string'||!pattern.length||pattern.length>1024)throw Error('FILE_TRANSFER: Redis 匹配模式无效')
  let cursor='0'
  do{
   const [next,keys]=await this.budget(()=>this.client.scanBuffer(cursor,'MATCH',pattern,'COUNT',100))
   cursor=String(next)
   for(const key of keys){requireActive(this.signal);yield key}
  }while(cursor!=='0')
 }
 async archiveRead(database:string,key:Buffer):Promise<RedisArchiveRecord|undefined>{
  this.check(database)
  if(key.length>1024*1024)throw Error('FILE_TRANSFER: Redis Key 超过单条记录容量')
  const result=await this.budget(()=>this.client.callBuffer('EVAL',"local t=redis.call('TYPE',KEYS[1]).ok; if t=='none' then return {} end; local d=redis.call('DUMP',KEYS[1]); local ttl=redis.call('PTTL',KEYS[1]); local now=redis.call('TIME'); return {t,d,ttl,now[1],now[2]}",1,key)) as [Buffer,Buffer|null,number,Buffer,Buffer]|[]
  if(!result.length)return undefined
  const [type,dump,ttl,seconds,micros]=result
  if(ttl===-2||!dump)return undefined
  if(!TYPES.has(String(type))||!Buffer.isBuffer(dump)||dump.length>4*1024*1024||!Number.isSafeInteger(ttl)||ttl< -1)throw Error('FILE_TRANSFER: Redis Key 存档记录无效或不支持的数据类型')
  const expiresAt=ttl===-1?null:Number(seconds)*1000+Math.floor(Number(micros)/1000)+ttl
  if(expiresAt!==null&&!Number.isSafeInteger(expiresAt))throw Error('FILE_TRANSFER: Redis Key 存档记录无效或不支持的数据类型')
  return {version:1,keyBase64:key.toString('base64'),type:String(type),dumpBase64:dump.toString('base64'),expiresAt}
 }
 async archiveRestore(database:string,record:{key:Buffer;dump:Buffer;expiresAt:number|null},replace:boolean):Promise<'restored'|'expired'|'exists'|'invalid'>{
  this.check(database)
  // The only script is fixed application code. Compare against target server
  // time and use ABSTTL to avoid extending an expiring key's lifetime.
  const script="local expiry=tonumber(ARGV[2]); if expiry>0 then local t=redis.call('TIME'); if expiry<=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000) then return 0 end end; local args={KEYS[1],ARGV[2],ARGV[1]}; if expiry>0 then table.insert(args,'ABSTTL') end; if ARGV[3]=='1' then table.insert(args,'REPLACE') end; local r=redis.pcall('RESTORE',unpack(args)); if type(r)=='table' and r.err then if string.find(r.err,'BUSYKEY',1,true) then return -1 end; if string.find(r.err,'DUMP payload',1,true) or string.find(r.err,'Bad data format',1,true) then return -2 end; return -3 end; return 1"
  const result=await this.budget(()=>this.client.eval(script,1,record.key,record.dump,String(record.expiresAt??0),replace?'1':'0'))
  if(result===1)return 'restored'
  if(result===0)return 'expired'
  if(result===-1)return 'exists'
  if(result===-2)return 'invalid'
  throw Error('FILE_TRANSFER: Redis 写入结果不确定，请核对目标数据')
 }
 async startSourceSnapshot(){}
 async prepareTarget(){}
 async applyStep(){throw new Error('MIGRATION_UNSUPPORTED: Redis 没有表结构，请使用数据传输')}
 async copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,...[read,pending,commitStart,committed]:CopyCallbacks){
  if(!(source instanceof RedisMigrationEndpoint))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  source.check(sourceDb);this.check(targetDb)
  if(!TYPES.has(object.type)||options.policy==='append'&&await this.budget(()=>this.client.exists(object.name)))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  // One atomic server-side read of type, binary RDB payload and TTL; no
  // user-supplied script. REPLACE is only used by the explicitly confirmed
  // same-key overwrite policy.
  const begin=performance.now()
  const result=await source.budget(()=>source.client.callBuffer("EVAL","local t=redis.call('TYPE',KEYS[1]).ok; local v=redis.call('DUMP',KEYS[1]); local ttl=redis.call('PTTL',KEYS[1]); return {t,v,ttl}",1,object.name)) as [Buffer,Buffer|null,number]
  const [type,dump,ttl]=result
  if(String(type)!==object.type||!Buffer.isBuffer(dump)||dump.length>4*1024*1024||!Number.isSafeInteger(ttl)||ttl< -1)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const remaining=ttl===-1?0:Math.floor(ttl-(performance.now()-begin))
  if(ttl!==-1&&remaining<=0)throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  read(1,dump.length);pending(1);commitStart()
  const response=await this.budget(()=>options.policy==='upsert'?this.client.restore(object.name,remaining,dump,'REPLACE'):this.client.restore(object.name,remaining,dump))
  if(response!=='OK')throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')
  committed(1)
 }
}
