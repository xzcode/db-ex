import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {BSON,type Document} from 'mongodb'
import {FileTransferService} from '../src/main/file-transfer/service'
import {normalizeFileTransfer,type FileTransferRequest} from '../src/shared/file-transfer'
import {newConnectionConfig} from '../src/shared/connection-form'
import {createTransport} from '../src/main/connections/transport'
import {loadConnectionTls} from '../src/main/connections/tls-material'
import {openMysqlClient} from '../src/main/connections/mysql-client'
import {openMongoClient} from '../src/main/connections/mongo-client'
import type {ConnectionConfig,DatabaseKind} from '../src/shared/types'
const kind=process.env.DBEX_M11_ENGINE as DatabaseKind,port=Number(process.env.DBEX_M11_PORT),password=process.env.DBEX_M11_PASSWORD,tlsDir=process.env.DBEX_M11_TLS_DIR
if(!['mysql','mariadb','mongodb'].includes(kind)||!Number.isInteger(port)||port<1024||port>65535||!password||!tlsDir)throw Error('Explicit isolated TLS fixture required')
const config:ConnectionConfig={...newConnectionConfig(kind),name:'Q5 isolated file fixture',host:'127.0.0.1',port,username:kind==='mongodb'?'dbex':process.env.DBEX_M11_USERNAME||'root',password,tls:{enabled:true,servername:'localhost',caPath:join(tlsDir,'ca.pem'),certPath:join(tlsDir,'client.pem'),keyPath:join(tlsDir,'client.key')}}
const route=await createTransport({ssh:config.ssh}),proxy=await route.socks(),tls=await loadConnectionTls(config)
const source={...config,proxy:{enabled:true as const,type:'socks5' as const,...proxy}},service=new FileTransferService()
const folder=await mkdtemp(join(tmpdir(),'dbex-q-server-file-')),file=join(folder,'records.jsonl')
const database='dbex_qfile_'+randomBytes(5).toString('hex'),owner=73,signal=new AbortController().signal
const base={database,format:'jsonl' as const,delimiter:','}
async function run(request:FileTransferRequest,output?:string,profile=config){
 const id='fixture'
 const job=service.start(owner,id,normalizeFileTransfer(request,kind),output,work=>work(profile,signal))
 for(let i=0;i<1800;i++){
  const current=service.list(owner)!
  assert.equal(current.id,job.id)
  if(current.state!=='running')return current
  await new Promise(r=>setTimeout(r,50))
 }
 throw Error('File fixture timed out')
}
try{
 if(kind==='mongodb'){
  const client=await openMongoClient(config,route,tls),db=client.db(database)
  try{
   const a=await db.createCollection<Document&{_id:unknown}>('records'),b=await db.createCollection<Document&{_id:unknown}>('copy')
   const doc=BSON.EJSON.parse('{"_id":{"$oid":"64b000000000000000000001"},"wide":{"$numberLong":"9223372036854775807"},"decimal":{"$numberDecimal":"12345678901234567890.12345678"},"payload":{"$binary":{"base64":"AP8B","subType":"00"}},"nested":{"items":[null,{"$numberLong":"4"}]},"label":"中文"}',{relaxed:false})
   await a.insertOne(doc)
   await a.insertMany(Array.from({length:1000},(_,i)=>({_id:new BSON.Int32(i),label:'中文',value:new BSON.Long(i)})))
   const out=await run({...base,entity:'records',direction:'export'},file,source);assert.equal(out.state,'completed',JSON.stringify(out));assert.equal(out.committed,1001)
   const preview=await service.pick(owner,'fixture',file,'jsonl',',')
   const job=await run({...base,entity:'copy',direction:'import',token:preview.token,preserveDocuments:true});assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.committed,1001)
   const original=await a.findOne({_id:doc._id},{raw:true}),copy=await b.findOne({_id:doc._id},{raw:true})
   assert(Buffer.isBuffer(original)&&Buffer.isBuffer(copy)&&original.equals(copy))
   assert.equal(await b.countDocuments(),1001)
   const retry=await service.pick(owner,'fixture',file,'jsonl',',')
   const upsert=await run({...base,entity:'copy',direction:'import',token:retry.token,preserveDocuments:true,policy:'upsert'})
   assert.equal(upsert.state,'completed',JSON.stringify(upsert));assert.equal(upsert.committed,1001);assert.equal(await b.countDocuments(),1001)
   console.log('Q5 real MongoDB mTLS/SOCKS EJSON round trip: 1001 records, byte-exact BSON and explicit upsert')
  }finally{await db.dropDatabase().catch(()=>{});await client.close()}
 }else{
  const client=await openMysqlClient(config,route,tls),q=(name:string)=>'`'+name+'`',table=(name:string)=>q(database)+'.'+q(name)
  try{
   await client.query('CREATE DATABASE '+q(database)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
   const ddl=' (id BIGINT UNSIGNED NOT NULL PRIMARY KEY,amount DECIMAL(30,8) NOT NULL,payload VARBINARY(64),note VARCHAR(100) DEFAULT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'
   await client.query('CREATE TABLE '+table('records')+ddl);await client.query('CREATE TABLE '+table('copy')+ddl)
   for(let start=0;start<1000;start+=100){const rows=Array.from({length:100},(_,i)=>[String(start+i+1),'12345678901234567890.12345678',Buffer.from([0,255,i]),'中文']);await client.query('INSERT INTO '+table('records')+' VALUES ?', [rows])}
   await client.execute('INSERT INTO '+table('records')+' VALUES (?,?,?,?)',['18446744073709551615','12345678901234567890.12345678',Buffer.from([255,0]),null])
   const out=await run({...base,entity:'records',direction:'export'},file,source);assert.equal(out.state,'completed',JSON.stringify(out));assert.equal(out.committed,1001)
   const preview=await service.pick(owner,'fixture',file,'jsonl',',')
   const mapping=preview.fields.map(source=>({source,target:source,conversion:'auto' as const}))
   const imported=await run({...base,entity:'copy',direction:'import',token:preview.token,mapping})
   assert.equal(imported.state,'completed',JSON.stringify(imported));assert.equal(imported.committed,1001)
   const [a]=await client.query('SELECT * FROM '+table('records')+' ORDER BY id')
   const [b]=await client.query('SELECT * FROM '+table('copy')+' ORDER BY id');assert.deepEqual(a,b)
   const duplicate=await service.pick(owner,'fixture',file,'jsonl',',')
   const failed=await run({...base,entity:'copy',direction:'import',token:duplicate.token,mapping})
   assert.equal(failed.state,'failed',JSON.stringify(failed));assert.equal(failed.committed,0)
   const update=await service.pick(owner,'fixture',file,'jsonl',',')
   const replaced=await run({...base,entity:'copy',direction:'import',token:update.token,mapping,policy:'replace'})
   assert.equal(replaced.state,'completed',JSON.stringify(replaced));assert.equal(replaced.committed,1001)
   const [after]=await client.query('SELECT * FROM '+table('copy')+' ORDER BY id');assert.deepEqual(a,after)
   console.log('Q5 real '+kind+' mTLS/SOCKS JSONL round trip: 1001 rows, exact UInt64/DECIMAL/binary/NULL, rollback and replace')
  }finally{await client.query('DROP DATABASE '+q(database)).catch(()=>{});client.destroy()}
 }
}finally{await service.closeAll();await route.close();await rm(folder,{recursive:true,force:true})}
