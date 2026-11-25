import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
const dir=await mkdtemp(join(tmpdir(),'dbex-sqlite-process-'))
const path=join(dir,'db.sqlite')
const seed=new DatabaseSync(path)
seed.exec('CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(7);')
seed.close()
const child=fork(resolve('dist-electron/sqlite-worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'})
let exited=false
const exit=once(child,'exit').then(()=>{exited=true})
const next=(request)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('SQLite child reply timed out')),5000)
  function onMessage(message){if(message.id!==request.id)return;clearTimeout(timer);child.off('message',onMessage);resolve(message)}
  child.on('message',onMessage);child.send(request)
})
try{
  assert.equal((await next({id:0,kind:'init',path})).ok,true)
  const query=operation=>next({id:1,kind:'execute',operation,writable:true,confirmed:true})
  assert.equal((await query({action:'mysql.begin'})).transaction,true)
  assert.equal((await query({action:'mysql.query',sql:'INSERT INTO t VALUES (8)'})).ok,true)
  // Kill during a long native synchronous query, not just an idle child.
  child.send({id:2,kind:'execute',operation:{action:'mysql.query',sql:'WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM cnt WHERE x<1000000000) SELECT sum(x) FROM cnt'},writable:true,confirmed:true})
  await new Promise(resolve=>setTimeout(resolve,100))
  const start=Date.now();child.kill('SIGKILL')
  let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SQLite cancel did not stop native process')),5000)})])}finally{clearTimeout(timer)}
  const db=new DatabaseSync(path,{readOnly:true})
  try{assert.equal(db.prepare('SELECT count(*) n FROM t').get().n,1)}finally{db.close()}
  console.log('SQLite isolated process cancellation and rollback passed in '+(Date.now()-start)+'ms')
}finally{if(!exited){child.kill('SIGKILL');await exit}await rm(dir,{recursive:true,force:true})}
