import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {BSON} from 'mongodb'
import {newConnectionConfig} from '../src/shared/connection-form'
import {MigrationService} from '../src/main/migration/service'
import {createTransport} from '../src/main/connections/transport'
import {loadConnectionTls} from '../src/main/connections/tls-material'
import {openMysqlClient} from '../src/main/connections/mysql-client'
import {openMongoClient} from '../src/main/connections/mongo-client'
import {openClickHouseClients} from '../src/main/connections/clickhouse-client'
import type {ConnectionConfig,DatabaseKind} from '../src/shared/types'
import type {MigrationRequest,MigrationFieldMap} from '../src/shared/migration'

const kind=process.env.DBEX_M11_ENGINE as DatabaseKind,port=Number(process.env.DBEX_M11_PORT),tlsDir=process.env.DBEX_M11_TLS_DIR
const local=process.env.DBEX_M12_LOCAL_FIXTURE==='1'
if(!['mysql','mariadb','mongodb','clickhouse'].includes(kind)||!Number.isInteger(port)||port<1024||port>65535||!local&&(!tlsDir||!process.env.DBEX_M11_PASSWORD))throw Error('Explicit disposable loopback fixture required')
const config:ConnectionConfig={...newConnectionConfig(kind),name:'M12 cross fixture',host:'127.0.0.1',port,username:process.env.DBEX_M11_USERNAME||(kind==='mongodb'||kind==='clickhouse'?(local?'':'dbex'):'root'),password:process.env.DBEX_M11_PASSWORD||'',...(tlsDir?{tls:{enabled:true,servername:'localhost',caPath:join(tlsDir,'ca.pem'),certPath:join(tlsDir,'client.pem'),keyPath:join(tlsDir,'client.key')}}:{})}
const db='dbex_cross_'+randomBytes(6).toString('hex'),folder=await mkdtemp(join(tmpdir(),'dbex-cross-')),path=join(folder,'local.sqlite')
const sqlite=new DatabaseSync(path),route=await createTransport({ssh:config.ssh}),tls=await loadConnectionTls(config)
const proxy=await route.socks()
const configs:Record<string,ConnectionConfig>={remote:{...config,proxy:{enabled:true,type:'socks5',...proxy}},sqlite:{...newConnectionConfig('sqlite'),name:'Local SQLite fixture',filePath:path}}
const owner=97,service=new MigrationService(id=>configs[id]!,undefined,resolve('dist-electron/sqlite-worker.cjs'))
const maximum='18446744073709551615',oid='64b000000000000000000001',decimal='12345678901234567890.12345678',payload=Buffer.from([0,255,128]),note='中文'
const remote={connectionId:'remote',database:db},localDb={connectionId:'sqlite',database:'main'}
let cleanup:()=>Promise<void>=async()=>{}
const fields=(items:[string,string,MigrationFieldMap['conversion']][])=>items.map(([source,target,conversion])=>({source,target,conversion}))
async function run(req:MigrationRequest){
 const plan=await service.preview(owner,req)
 assert(plan.steps.length===1&&plan.steps[0]!.executable,JSON.stringify(plan.steps))
 const job=service.start(owner,plan.id,[plan.steps[0]!.id])
 for(let i=0;i<1600;i++){const value=service.list(owner).find(j=>j.id===job.id)!;if(value.state!=='running'){assert.equal(value.state,'completed',JSON.stringify(value));assert.equal(value.rowsCommitted,1);await new Promise(r=>setTimeout(r,30));return}await new Promise(r=>setTimeout(r,25))}
 throw Error('cross-engine migration timed out')
}
try{
 sqlite.exec('CREATE TABLE local_records(k TEXT NOT NULL PRIMARY KEY, precise TEXT, bytes BLOB, memo TEXT) WITHOUT ROWID')
 const source=kind==='mongodb'?'documents':'source_rows',target=kind==='mongodb'?'documents_copy':'target_rows'
 let inbound:MigrationFieldMap[],outbound:MigrationFieldMap[],verify:()=>Promise<void>
 if(kind==='mongodb'){
  const client=await openMongoClient(config,route,tls),database=client.db(db)
  cleanup=async()=>{await database.dropDatabase().catch(()=>{});await client.close()}
  const original=await database.createCollection('documents'),dest=await database.createCollection('documents_copy')
  const doc=BSON.EJSON.parse(JSON.stringify({_id:{$oid:oid},amount:{$numberDecimal:decimal},payload:{$binary:{base64:payload.toString('base64'),subType:'00'}},note}),{relaxed:false})
  await original.insertOne(doc)
  inbound=fields([['_id','k','text'],['amount','precise','text'],['payload','bytes','auto'],['note','memo','auto']])
  outbound=fields([['k','_id','objectId'],['precise','amount','decimal'],['bytes','payload','binary'],['memo','note','auto']])
  verify=async()=>{const actual=await dest.findOne({_id:doc._id},{raw:true}),expected=await original.findOne({_id:doc._id},{raw:true});assert(Buffer.isBuffer(actual)&&Buffer.isBuffer(expected)&&actual.equals(expected))}
 }else if(kind==='clickhouse'){
  const pool=await openClickHouseClients(config,route,tls),client=pool.make('default',30000)
  cleanup=async()=>{await client.command({query:'DROP DATABASE IF EXISTS '+db+' SYNC'}).catch(()=>{});await pool.close()}
  await client.command({query:'CREATE DATABASE '+db})
  const ddl=' (id UInt64,amount Decimal(38,8),payload String,note Nullable(String)) ENGINE=MergeTree ORDER BY id'
  await client.command({query:'CREATE TABLE '+db+'.source_rows'+ddl})
  await client.command({query:'CREATE TABLE '+db+'.target_rows (key_id UInt64,precise Decimal(38,8),bytes String,memo Nullable(String)) ENGINE=MergeTree ORDER BY key_id'})
  await client.command({query:"INSERT INTO "+db+".source_rows VALUES (18446744073709551615,12345678901234567890.12345678,unhex('00ff80'),'中文')"})
  inbound=fields([['id','k','text'],['amount','precise','text'],['payload','bytes','auto'],['note','memo','text']])
  outbound=fields([['k','key_id','integer'],['precise','precise','decimal'],['bytes','bytes','auto'],['memo','memo','auto']])
  verify=async()=>{
   const result=await client.query({query:'SELECT toString(key_id) id,toString(precise) amount,hex(bytes) payload,memo note FROM '+db+'.target_rows',format:'JSONEachRow'})
   assert.deepEqual(await result.json(),[{id:maximum,amount:decimal,payload:'00FF80',note}])
  }
 }else{
  const client=await openMysqlClient(config,route,tls)
  const q=(name:string)=>String.fromCharCode(96)+name+String.fromCharCode(96),table=(name:string)=>q(db)+'.'+q(name)
  cleanup=async()=>{await client.query('DROP DATABASE IF EXISTS '+q(db)).catch(()=>{});client.destroy()}
  await client.query('CREATE DATABASE '+q(db)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
  await client.query('CREATE TABLE '+table('source_rows')+' (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(30,8) NOT NULL,payload VARBINARY(32),note VARCHAR(100)) ENGINE=InnoDB')
  await client.query('CREATE TABLE '+table('target_rows')+' (key_id BIGINT UNSIGNED PRIMARY KEY, precise DECIMAL(30,8) NOT NULL,bytes VARBINARY(32),memo VARCHAR(100)) ENGINE=InnoDB')
  await client.execute('INSERT INTO '+table('source_rows')+' VALUES (?,?,?,?)',[maximum,decimal,payload,note])
  inbound=fields([['id','k','text'],['amount','precise','text'],['payload','bytes','auto'],['note','memo','auto']])
  outbound=fields([['k','key_id','integer'],['precise','precise','decimal'],['bytes','bytes','auto'],['memo','memo','auto']])
  verify=async()=>{const [rows]=await client.query('SELECT CAST(key_id AS CHAR) AS id, CAST(precise AS CHAR) AS amount,HEX(bytes) AS payload,memo AS note FROM '+table('target_rows'));assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{id:maximum,amount:decimal,payload:'00FF80',note}])}
  // Explicit ordinary foreign-key dependency migration, parent sorts after child.
  await client.query('CREATE TABLE '+table('z_parent')+' (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await client.query('CREATE TABLE '+table('a_child')+' (id INT NOT NULL PRIMARY KEY,parent_id INT,CONSTRAINT fk_dep FOREIGN KEY(parent_id) REFERENCES '+table('z_parent')+'(id)) ENGINE=InnoDB')
  const depDb=db+'_deps'
  await client.query('CREATE DATABASE '+q(depDb)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
  const originalCleanup=cleanup;cleanup=async()=>{await client.query('DROP DATABASE IF EXISTS '+q(depDb)).catch(()=>{});await originalCleanup()}
  await client.query('INSERT INTO '+table('z_parent')+' VALUES(1)')
  await client.query('INSERT INTO '+table('a_child')+' VALUES(2,1)')
  const req:MigrationRequest={source:remote,target:{connectionId:'remote',database:depDb},mode:'structure-data',objects:['a_child','z_parent'],includeDependencies:true}
  const plan=await service.preview(owner,req)
  assert.deepEqual(plan.steps.map(s=>s.name),['z_parent','a_child'],JSON.stringify(plan.steps))
  assert(plan.steps.every(s=>s.executable&&s.transfer),JSON.stringify(plan.steps))
  assert.throws(()=>service.confirmation(owner,plan.id,[plan.steps[1]!.id]),/MIGRATION_INPUT/)
  const job=service.start(owner,plan.id,plan.steps.map(s=>s.id))
  for(let i=0;i<1600;i++){
   const value=service.list(owner).find(j=>j.id===job.id)!
   if(value.state!=='running'){assert.equal(value.state,'completed',JSON.stringify(value));assert.equal(value.rowsCommitted,2);await new Promise(r=>setTimeout(r,30));break}
   await new Promise(r=>setTimeout(r,25))
   if(i===1599)throw Error('FK migration timeout')
  }
  const [children]=await client.query('SELECT * FROM '+q(depDb)+'.'+q('a_child'))
  assert.deepEqual(JSON.parse(JSON.stringify(children)),[{id:2,parent_id:1}])
  console.log('M12 '+kind+' opt-in ordinary FK creation and parent-first data transfer passed')
 }
 await run({source:remote,target:localDb,mode:'data',objects:[source],mappings:[{source,target:'local_records',fields:inbound}]})
 const row=sqlite.prepare('SELECT * FROM local_records').get()!
 assert.equal(row.k,kind==='mongodb'?oid:maximum);assert.equal(row.precise,decimal);assert.deepEqual(Buffer.from(row.bytes as Uint8Array),payload);assert.equal(row.memo,note)
 await run({source:localDb,target:remote,mode:'data',objects:['local_records'],mappings:[{source:'local_records',target,fields:outbound}]})
 await verify()
 console.log('M12 '+kind+' ↔ SQLite: real mapped object/field names and exact typed round trip passed')
}finally{await service.closeAll();await cleanup();await route.close();sqlite.close();await rm(folder,{recursive:true,force:true})}
