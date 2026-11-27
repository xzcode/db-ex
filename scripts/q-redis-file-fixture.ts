import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import type {RedisClient} from '../src/main/connections/redis-client'
import type {ConnectionConfig} from '../src/shared/types'
import {FileTransferService} from '../src/main/file-transfer/service'
import {normalizeFileTransfer,type FileTransferRequest} from '../src/shared/file-transfer'
export async function redisArchiveFixture(a:RedisClient,b:RedisClient,source:ConnectionConfig,target:ConnectionConfig){
 const dir=await mkdtemp(join(tmpdir(),'dbex-redis-archive-test-')),service=new FileTransferService(),owner=75,id='redis-archive-fixture',signal=new AbortController().signal
 const prefix='dbex_q5_'+randomBytes(8).toString('hex')+':',keys=['str','hash','list','set','zset','stream'].map(n=>Buffer.from(prefix+n)),binary=Buffer.concat([Buffer.from(prefix),Buffer.from([0,255,128])]),all=[...keys,binary]
 const [str,hash,list,set,zset,stream]=keys
 const base={entity:'keyspace',format:'jsonl' as const,delimiter:','}
 async function run(req:FileTransferRequest,config:ConnectionConfig,output?:string){
  const job=service.start(owner,id,normalizeFileTransfer(req,'redis'),output,work=>work(config,signal))
  for(let i=0;i<800;i++){const next=service.list(owner)!;assert.equal(next.id,job.id);if(next.state!=='running'){await new Promise(r=>setTimeout(r,30));return next}await new Promise(r=>setTimeout(r,25))}
  throw Error('Redis archive timeout')
 }
 const output=join(dir,'keys.jsonl'),exportReq={...base,direction:'export' as const,database:String(source.redisDb||0),redisPattern:prefix+'*'}
 async function restore(path:string,policy:'append'|'upsert'='append'){
  const p=await service.pick(owner,id,path,'jsonl',',')
  return run({...base,direction:'import',database:String(target.redisDb||0),policy,token:p.token},target)
 }
 try{
  await a.set(str!,Buffer.from([0,255,128]),'PX',600000)
  await a.hset(hash!,Buffer.from([255]),Buffer.from([0,128]))
  await a.rpush(list!,Buffer.from([0,255]),'text')
  await a.sadd(set!,'a','b');await a.zadd(zset!,1.25,'member')
  await a.xadd(stream!,'*','f',Buffer.from([0,255]))
  await a.set(binary,Buffer.from([0,255,1]))
  const exp=await run(exportReq,source,output)
  assert.equal(exp.state,'completed',JSON.stringify(exp));assert.equal(exp.committed,7)
  const imp=await restore(output)
  assert.equal(imp.state,'completed',JSON.stringify(imp));assert.equal(imp.committed,7)
  for(const key of all){const [x,y]=await Promise.all([a.dumpBuffer(key),b.dumpBuffer(key)]);assert(x?.equals(y),'DUMP mismatch')}
  assert(Math.abs(await a.pttl(str!)-await b.pttl(str!))<2000)
  await b.set(binary,'keep')
  const conflict=await restore(output);assert.equal(conflict.state,'failed',JSON.stringify(conflict));assert.equal(await b.get(binary),'keep')
  const overwrite=await restore(output,'upsert');assert.equal(overwrite.state,'completed',JSON.stringify(overwrite));assert.equal(overwrite.committed,7)
  assert((await b.dumpBuffer(binary)).equals(await a.dumpBuffer(binary)))
  const rows=(await readFile(output,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const expired=join(dir,'expired.jsonl');await writeFile(expired,JSON.stringify({...rows[0],expiresAt:1})+'\n')
  const skip=await restore(expired);assert.equal(skip.state,'completed');assert.equal(skip.committed,0);assert.equal(skip.skipped,1)
  const dup=join(dir,'duplicate.jsonl');await writeFile(dup,JSON.stringify(rows[0])+'\n'+JSON.stringify(rows[0])+'\n')
  const reject=await restore(dup,'upsert');assert.equal(reject.state,'failed');assert.equal(reject.committed,0);assert.match(reject.error||'',/重复/)
  console.log('Q5 Redis real archive: 7 keys, six native types, binary key/value, absolute TTL, overwrite opt-in, expired skip, duplicate preflight')
 }finally{await service.closeAll();await a.del(...all).catch(()=>{});await b.del(...all).catch(()=>{});await rm(dir,{recursive:true,force:true})}
}
