import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Redis} from 'ioredis'
import {newConnectionConfig} from '../src/shared/connection-form'
import {decodeRedisArchiveRecord} from '../src/main/file-transfer/redis-records'
import {normalizeFileTransfer} from '../src/shared/file-transfer'
import {redisArchiveFixture} from '../scripts/q-redis-file-fixture'
test('Redis archive rejects unsupported RDB type, noncanonical data, implicit export and flush',()=>{
 const valid={version:1,keyBase64:'AP8=',type:'string',dumpBase64:Buffer.alloc(12).toString('base64'),expiresAt:null}
 assert.deepEqual(decodeRedisArchiveRecord(valid).key,Buffer.from([0,255]))
 assert.throws(()=>decodeRedisArchiveRecord({...valid,type:'module'}),/FILE_TRANSFER/)
 assert.throws(()=>decodeRedisArchiveRecord({...valid,keyBase64:'AP8'}),/FILE_TRANSFER/)
 assert.throws(()=>normalizeFileTransfer({direction:'export',format:'jsonl',delimiter:',',database:'0',entity:'keyspace'},'redis'),/FILE_TRANSFER/)
 assert.throws(()=>normalizeFileTransfer({direction:'import',format:'jsonl',delimiter:',',database:'0',entity:'keyspace',policy:'replace',token:'0'.repeat(36)},'redis'),/FILE_TRANSFER/)
})
test('Redis archive against disposable loopback instance',{skip:!process.env.DBEX_Q_REDIS_SERVER,timeout:40000},async()=>{
 const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()))
 const dir=await mkdtemp(join(tmpdir(),'dbex-redis-fixture-'))
 const child=spawn(process.env.DBEX_Q_REDIS_SERVER!,['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--dir',dir,'--protected-mode','yes'],{stdio:['ignore','pipe','pipe']})
 let a:Redis|undefined,b:Redis|undefined
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Redis did not start')),8000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);reject(Error('Redis exited: '+code))});child.stdout.on('data',chunk=>{if(String(chunk).includes('Ready to accept connections')){clearTimeout(timer);resolve()}})})
  a=new Redis({host:'127.0.0.1',port,db:0});b=new Redis({host:'127.0.0.1',port,db:1})
  const config={...newConnectionConfig('redis'),name:'isolated redis',host:'127.0.0.1',port}
  await redisArchiveFixture(a,b,{...config,redisDb:0},{...config,redisDb:1})
 }finally{a?.disconnect();b?.disconnect();child.kill();await new Promise<void>(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',()=>r())});await rm(dir,{recursive:true,force:true})}
})
