import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {stat,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {performance} from 'node:perf_hooks'
import {SessionManager} from '../src/main/connections/manager'
import {createTransport} from '../src/main/connections/transport'
import {newConnectionConfig} from '../src/shared/connection-form'
import {NativeCliProcess,prepareNativeCli} from '../src/main/operations/native-cli'
import {runNativeTool} from '../src/main/operations/native-tools'
import {createConnectionBackup,readConnectionBackup} from '../src/main/connections/backup'
import {m11SshFixture} from './m11-ssh-fixture'
import type {ConnectionConfig,DatabaseOperation,SessionInfo} from '../src/shared/types'

function required(name:string){const value=process.env[name];if(!value)throw new Error('Missing isolated M11 fixture: '+name);return value}
const kind=required('DBEX_M11_ENGINE')
if(!['mysql','mariadb','mongodb','redis','clickhouse'].includes(kind))throw new Error('Invalid engine')
const port=Number(required('DBEX_M11_PORT'))
assert(Number.isInteger(port)&&port>1024&&port<=65535)
const password=required('DBEX_M11_PASSWORD'),tlsDir=resolve(required('DBEX_M11_TLS_DIR'))
const base:ConnectionConfig={...newConnectionConfig(kind as ConnectionConfig['kind']),name:'M11 '+kind+' isolated',host:'127.0.0.1',port,username:process.env.DBEX_M11_USERNAME||(kind==='mysql'||kind==='mariadb'?'root':kind==='redis'?'default':'dbex'),password,
 tls:{enabled:true,caPath:join(tlsDir,'ca.pem'),certPath:join(tlsDir,'client.pem'),keyPath:join(tlsDir,'client.key'),servername:'localhost'},connectTimeoutMs:6500}
const database='dbex_m11_'+randomUUID().replaceAll('-','')
const manager=new SessionManager()
const outer=await createTransport({ssh:base.ssh})
const bastion=await m11SshFixture(port)
const endpoint=await outer.socks()
const routed={...base,ssh:bastion.ssh,proxy:{enabled:true,type:'socks5' as const,...endpoint}}
const dir=await mkdtemp(join(tmpdir(),'m11-engine-'))
const started=performance.now()
async function execute(session:SessionInfo,operation:DatabaseOperation){return manager.execute(session.id,operation)}
async function unlock(session:SessionInfo){await manager.setWriteAccess(session.id,true)}
const nativeBin=process.env.DBEX_M11_NATIVE_BIN
async function cliProbe(session:SessionInfo){
 if(!nativeBin||!(kind==='mysql'||kind==='mariadb'))return
 const tool=join(nativeBin,kind==='mysql'?'mysql':'mariadb')
 await unlock(session)
 await manager.routedExternal(session.id,true,async(cfg,signal,route)=>{
  const prepared=await prepareNativeCli(cfg,database,route)
  const cli=new NativeCliProcess(cfg.kind,value=>value)
  try{
   await cli.start(tool,prepared.args,signal)
   async function send(sql:string){
    cli.send(sql)
    for(let i=0;i<150&&cli.snapshot().running;i++)await new Promise(r=>setTimeout(r,50))
    assert(!cli.snapshot().running&&!cli.snapshot().closed)
   }
   await send('START TRANSACTION')
   await send("INSERT INTO items VALUES (3,1.2345,'cli-rollback')")
   await send('ROLLBACK')
   await send('SELECT COUNT(*) FROM items WHERE id=3')
   assert.match(cli.snapshot().output,/(^|\n)0(\n|$)/)
   await send('START TRANSACTION')
   await send("INSERT INTO items VALUES (4,2.3456,'cli-commit')")
   await send('COMMIT')
   await send('SELECT note FROM items WHERE id=4')
   assert.match(cli.snapshot().output,/cli-commit/)
  }finally{cli.stop();await cli.finished;await prepared.cleanup()}
 })
 const dump=join(dir,'direct-tls.sql')
 await manager.routedExternal(session.id,false,(cfg,signal,route)=>runNativeTool(join(nativeBin,kind==='mysql'?'mysqldump':'mariadb-dump'),kind==='mysql'?'mysql-backup':'mariadb-backup',cfg,database,undefined,dump,signal,route))
 assert((await stat(dump)).size>100)
 assert.match(await readFile(dump,'utf8'),/cli-commit/)
 console.log(kind+' real native CLI transactions and verified direct-TLS backup passed')
}
try{
 const imported=readConnectionBackup(createConnectionBackup([routed]))[0]!
 assert.equal(imported.kind,kind);assert.equal(imported.password,password);assert.equal(imported.tls.caPath,base.tls.caPath)
 const session=await manager.connect(routed)
 assert.equal(session.writable,false)
 await assert.rejects(()=>manager.connect({...routed,tls:{...routed.tls,servername:'wrong.fixture'}}))
 await assert.rejects(()=>manager.connect({...routed,tls:{...routed.tls,caPath:join(tlsDir,'wrong.pem')}}))
 await assert.rejects(()=>manager.connect({...routed,password:password+'wrong'}))
 await assert.rejects(()=>manager.connect({...routed,tls:{...routed.tls,certPath:undefined,keyPath:undefined}}))
 await assert.rejects(()=>manager.connect({...routed,ssh:{...routed.ssh,hostFingerprint:'0'.repeat(64)}}),/SSH_HOST_KEY_MISMATCH/)
 console.log(kind+' real authenticated SSH over SOCKS + TLS, wrong host/CA/password, missing client certificate and SSH fingerprint rejection passed')
 if(kind==='mysql'||kind==='mariadb'){
  const query=(sql:string,db?:string)=>execute(session,{action:'mysql.query',database:db,sql,confirmed:true})
  await unlock(session)
  await execute(session,{action:'mysql.createDatabase',database,confirmed:true})
  await query('CREATE TABLE items (id BIGINT PRIMARY KEY, amount DECIMAL(24,4), note VARCHAR(120)) ENGINE=InnoDB',database)
  const target={database,entity:'items'}
  await execute(session,{action:'mysql.insert',...target,values:{id:'9223372036854775807',amount:'12345678901234567890.1234',note:'exact'},confirmed:true})
  await execute(session,{action:'mysql.begin',confirmed:true})
  await execute(session,{action:'mysql.insert',...target,values:{id:2,amount:'1.2345',note:'rollback'},confirmed:true})
  await manager.setWriteAccess(session.id,false)
  const rows=await execute(session,{action:'mysql.query',database,sql:'SELECT id,amount,note FROM items ORDER BY id'})
  assert.equal(rows.rows.length,1);assert.equal(rows.rows[0]?.id,'9223372036854775807');assert.equal(rows.rows[0]?.amount,'12345678901234567890.1234')
  await assert.rejects(()=>execute(session,{action:'mysql.insert',...target,values:{id:5},confirmed:true}),/READ_ONLY/)
  assert((await manager.children(session.id,database)).some(n=>n.entity==='items'))
  const direct=await manager.connect({...base,host:'localhost',database})
  await cliProbe(direct)
  await manager.disconnect(direct.id)
  console.log(kind+' version '+session.serverVersion+' exact values, catalog, rollback and write guard passed')
 }else if(kind==='mongodb'){
  await unlock(session)
  await execute(session,{action:'mongo.createDatabase',database,initialCollection:'items',confirmed:true})
  const document='{"_id":{"$oid":"64b000000000000000000001"},"v":{"$numberLong":"9223372036854775807"},"n":null}'
  await execute(session,{action:'mongo.insert',database,entity:'items',documents:[document],confirmed:true})
  const rows=await execute(session,{action:'mongo.find',database,entity:'items',limit:1})
  assert(rows.documents?.[0]?.includes('9223372036854775807'));assert.match(rows.documents?.[0]||'',/"n":\s*null/)
  await assert.rejects(()=>execute(session,{action:'mongo.insert',database,entity:'items',documents:[document]}),/CONFIRMATION_REQUIRED/)
  if(nativeBin){
   const archive=join(dir,'tls.archive'),json=join(dir,'tls.json')
   const run=(task:import('../src/shared/preferences').NativeToolTask,tool:string,file:string,entity?:string)=>manager.routedExternal(session.id,task==='mongo-import'||task==='mongo-restore',(cfg,signal,route)=>{
    assert.equal(route?.tlsVerified,true)
    return runNativeTool(join(nativeBin,tool),task,cfg,database,entity,file,signal,route)
   })
   await run('mongo-backup','mongodump',archive)
   await run('mongo-export','mongoexport',json,'items')
   assert((await stat(archive)).size>0);assert.match(await readFile(json,'utf8'),/\$numberLong/)
   await run('mongo-import','mongoimport',json,'imported')
   assert((await execute(session,{action:'mongo.find',database,entity:'imported'})).documents?.[0]?.includes('9223372036854775807'))
   await execute(session,{action:'mongo.dropDatabase',database,confirmed:true})
   await run('mongo-restore','mongorestore',archive)
   assert((await execute(session,{action:'mongo.find',database,entity:'items'})).documents?.[0]?.includes('9223372036854775807'))
   console.log('MongoDB real native archive backup/restore and canonical EJSON over SSH/SOCKS/mTLS passed')
  }
  console.log('MongoDB exact BSON and guarded writes passed')
 }else if(kind==='redis'){
  const key=database+':value'
  await assert.rejects(()=>execute(session,{action:'redis.set',key,value:'denied',confirmed:true}))
  await unlock(session)
  await execute(session,{action:'redis.set',key,value:'TLS fixture',ttl:120,confirmed:true})
  assert.equal((await execute(session,{action:'redis.get',key})).value,'TLS fixture')
  await execute(session,{action:'redis.set',key,value:'updated',expected:'TLS fixture',confirmed:true})
  await assert.rejects(()=>execute(session,{action:'redis.set',key,value:'bad',expected:'stale',confirmed:true}),/CONFLICT/)
  assert((await execute(session,{action:'redis.get',key})).ttl!>0)
  console.log('Redis TLS/ACL, TTL and CAS verified')
  await execute(session,{action:'redis.delete',keys:[key],confirmed:true})
 }else if(kind==='clickhouse'){
  const db='dbex_m11'
  assert((await manager.roots(session.id)).some(n=>n.database===db))
  await unlock(session)
  const name='items_'+database.slice(-12),copy=name+'_copy'
  const ddl=(entity:string)=>execute(session,{action:'clickhouse.query',database:db,sql:'CREATE TABLE '+entity+' (id UInt64, amount Decimal(38,8), note Nullable(String)) ENGINE=MergeTree ORDER BY id',confirmed:true})
  await ddl(name);await ddl(copy)
  const target={database:db,entity:name}
  const count=Number(process.env.DBEX_M11_ROWS||25000)
  assert(Number.isInteger(count)&&count>=1000&&count<=100000)
  const input=join(dir,'input.jsonl'),output=join(dir,'output.parquet')
  const payload='数'.repeat(160)
  await writeFile(input,Array.from({length:count},(_,i)=>JSON.stringify({id:String(18446744073709551615n-BigInt(i)),amount:'12345678901234567890.12345678',note:i%97===0?null:payload})).join('\n')+'\n',{flag:'wx'})
  const start=performance.now(),imported=await manager.clickhouseTransfer(session.id,{...target,direction:'import',format:'jsonl'},input)
  const importMs=Math.round(performance.now()-start)
  const check=await execute(session,{action:'clickhouse.query',database:db,sql:'SELECT count() AS n, max(id) AS max_id, min(amount) AS amount, countIf(isNull(note)) AS nulls FROM '+name})
  assert.equal(check.rows[0]?.n,String(count));assert.equal(check.rows[0]?.max_id,'18446744073709551615');assert.equal(check.rows[0]?.amount,'12345678901234567890.12345678')
  const startExport=performance.now(),out=await manager.clickhouseTransfer(session.id,{...target,direction:'export',format:'parquet'},output)
  const exportMs=Math.round(performance.now()-startExport)
  await assert.rejects(()=>manager.clickhouseTransfer(session.id,{...target,direction:'export',format:'parquet'},output),/OUTPUT_EXISTS/)
  await manager.clickhouseTransfer(session.id,{database:db,entity:copy,direction:'import',format:'parquet'},output)
  const roundtrip=await execute(session,{action:'clickhouse.query',database:db,sql:'SELECT count() AS n, max(id) AS max_id, min(amount) AS amount, countIf(isNull(note)) AS nulls FROM '+copy})
  assert.deepEqual(roundtrip.rows,check.rows)
  console.log('M11 ClickHouse benchmark '+JSON.stringify({version:session.serverVersion,rows:count,inputBytes:imported.bytes,parquetBytes:out.bytes,importMs,exportMs}))
  await manager.setWriteAccess(session.id,false)
  await assert.rejects(()=>manager.clickhouseTransfer(session.id,{...target,direction:'import',format:'jsonl'},input),/READ_ONLY/)
 }
 await manager.cancel(session.id)
 assert.throws(()=>manager.info(session.id),/SESSION_CLOSED/)
 console.log('M11 fixture passed '+kind+' in '+Math.round(performance.now()-started)+'ms')
}finally{await manager.closeAll();await bastion.close();await outer.close();await rm(dir,{recursive:true,force:true})}
