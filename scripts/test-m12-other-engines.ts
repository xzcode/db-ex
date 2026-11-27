import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {BSON,type Document} from 'mongodb'
import {MigrationService} from '../src/main/migration/service'
import {newConnectionConfig} from '../src/shared/connection-form'
import {createTransport} from '../src/main/connections/transport'
import {loadConnectionTls} from '../src/main/connections/tls-material'
import {openMongoClient} from '../src/main/connections/mongo-client'
import {createRedisClient,setRedisReadBudget} from '../src/main/connections/redis-client'
import {openClickHouseClients} from '../src/main/connections/clickhouse-client'
import type {ConnectionConfig} from '../src/shared/types'
import type {MigrationMode,MigrationJob,MigrationPolicy,MigrationCondition} from '../src/shared/migration'
const kind=process.env.DBEX_M12_ENGINE||process.env.DBEX_M11_ENGINE||'sqlite'
const configs:Record<string,ConnectionConfig>={}
const owner=37
const service=new MigrationService(id=>{const c=configs[id];if(!c)throw Error('Unknown isolated fixture');return c},undefined,resolve('dist-electron/sqlite-worker.cjs'))
const suffix=randomBytes(5).toString('hex')
let source='dbex_m12_src_'+suffix,target='dbex_m12_dst_'+suffix
const request=(mode:MigrationMode,objects?:string[],policy?:MigrationPolicy,condition?:MigrationCondition)=>({source:{connectionId:'source',database:source},target:{connectionId:'target',database:target},mode,objects,policy,condition})
async function finish(id:string):Promise<MigrationJob>{
 for(let i=0;i<1800;i++){const job=service.list(owner).find(j=>j.id===id)!;if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,50))}
 throw Error('Migration job timeout')
}
async function run(mode:MigrationMode,names?:string[],expected?:string,policy?:MigrationPolicy,condition?:MigrationCondition){
 const plan=await service.preview(owner,request(mode,names,policy,condition)),steps=plan.steps.filter(s=>s.executable)
 assert(steps.length,JSON.stringify(plan.steps))
 const job=await finish(service.start(owner,plan.id,steps.map(s=>s.id)).id)
 if(expected)assert.equal(job.state,expected,JSON.stringify(job));else assert.equal(job.state,'completed',JSON.stringify(job))
 return job
}
function exactPlan(plan:Awaited<ReturnType<MigrationService['preview']>>){
 assert(plan.steps.every(s=>s.action==='same'),JSON.stringify(plan.steps.map(s=>({name:s.name,action:s.action,changes:s.changes}))))
}
if(kind==='sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'dbex-m12-sqlite-')),a=join(dir,'源.sqlite'),b=join(dir,'target.sqlite')
 source=target='main'
 const s=new DatabaseSync(a),t=new DatabaseSync(b)
 configs.source={...newConnectionConfig('sqlite'),name:'Source fixture',filePath:a}
 configs.target={...newConnectionConfig('sqlite'),name:'Target fixture',filePath:b}
 try{
  s.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, amount REAL, payload BLOB, note TEXT); CREATE INDEX idx_note ON items(note); CREATE TABLE append_only(id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE guarded(id INTEGER PRIMARY KEY, n INTEGER CHECK(n>0));')
  t.exec('CREATE TABLE append_only(id INTEGER PRIMARY KEY); CREATE TABLE keep_me(id INTEGER PRIMARY KEY)')
  const put=s.prepare('INSERT INTO items VALUES(?,?,?,?)')
  s.exec('BEGIN')
  for(let i=0;i<12000;i++)put.run(BigInt(i),i+0.25,Buffer.from([0,255,i%256]),'中文 data')
  put.run(9223372036854775807n,0.125,Buffer.from([255,0]),null)
  s.exec('COMMIT')
  const plan=await service.preview(owner,request('schema'))
  assert.equal(plan.steps.find(x=>x.name==='guarded')?.executable,false)
  assert.equal(plan.steps.find(x=>x.name==='keep_me')?.action,'target-only')
  assert.equal(plan.steps.find(x=>x.name==='append_only')?.action,'alter')
  assert.equal(plan.steps.find(x=>x.name==='items')?.action,'create')
  await run('schema')
  exactPlan(await service.preview(owner,request('schema',['items','append_only'])))
  const copy=await run('data',['items']);assert.equal(copy.rowsCommitted,12001)
  const record=t.prepare('SELECT * FROM items WHERE id=9223372036854775807');record.setReadBigInts(true)
  const row=record.get()!
  assert.equal(row.id,9223372036854775807n);assert.equal(row.amount,0.125);assert.deepEqual(Buffer.from(row.payload as Uint8Array),Buffer.from([255,0]));assert.equal(row.note,null)
  assert.equal(t.prepare('SELECT COUNT(*) AS n FROM items').get()?.n,12001)
  t.exec('DELETE FROM items; INSERT INTO items(id,note) VALUES(9223372036854775807,\'keep\')')
  const conflict=await run('data',['items'],'failed');assert.equal(conflict.rowsCommitted,0);assert.equal(t.prepare('SELECT COUNT(*) AS n FROM items').get()?.n,1)
  configs.alias={...configs.source,name:'Alias'}
  await assert.rejects(()=>service.preview(owner,{...request('schema'),target:{connectionId:'alias',database:'main'}}),/MIGRATION_SAME_TARGET/)
  s.exec('CREATE TABLE combined(id INTEGER PRIMARY KEY,payload BLOB); INSERT INTO combined VALUES(1,x\'00ff\')')
  assert.equal((await run('structure-data',['combined'])).rowsCommitted,1)
  s.exec("CREATE TABLE advanced(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO advanced VALUES (1,'one'),(2,'two'),(3,'three')")
  t.exec("CREATE TABLE advanced(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO advanced VALUES (1,'old'),(9,'keep')")
  const up=await run('data',['advanced'],undefined,'upsert',{field:'id',operator:'lte',type:'Long',value:'2'})
  assert.equal(up.rowsCommitted,2)
  assert.deepEqual(t.prepare('SELECT note FROM advanced ORDER BY id').all().map(r=>r.note),['one','two','keep'])
  const replaced=await run('data',['advanced'],undefined,'replace');assert.equal(replaced.rowsCommitted,3)
  assert.deepEqual(t.prepare('SELECT note FROM advanced ORDER BY id').all().map(r=>r.note),['one','two','three'])
  t.exec('CREATE TABLE inbound(id INTEGER PRIMARY KEY,p INTEGER REFERENCES advanced(id) ON DELETE CASCADE); INSERT INTO inbound VALUES(1,1)')
  const guarded=await run('data',['advanced'],'failed','replace');assert.match(guarded.error||'',/MIGRATION_DEPENDENCY/)
  assert.equal(t.prepare('SELECT COUNT(*) AS n FROM inbound').get()?.n,1)
  console.log('M12 SQLite filtered upsert, transactional replace, inbound FK protection passed')
  console.log('M12 SQLite actual files/workers: schema create/add-column/index, 12001 rows, Int64/BLOB/REAL/NULL, duplicate rollback, file alias guard, structure+data passed')
 }finally{await service.closeAll();s.close();t.close();await rm(dir,{recursive:true,force:true})}
}else{
 if(!['mongodb','redis','clickhouse'].includes(kind))throw Error('Explicit supported fixture engine required')
 const port=Number(process.env.DBEX_M11_PORT),password=process.env.DBEX_M11_PASSWORD,tlsDir=process.env.DBEX_M11_TLS_DIR
 if(!Number.isInteger(port)||port<1024||port>65535||!password||!tlsDir)throw Error('Explicit isolated TLS fixture required')
 const config:ConnectionConfig={...newConnectionConfig(kind as 'mongodb'|'redis'|'clickhouse'),name:'M12 isolated fixture',host:'127.0.0.1',port,username:kind==='redis'?'default':'dbex',password,tls:{enabled:true,servername:'localhost',caPath:join(tlsDir,'ca.pem'),certPath:join(tlsDir,'client.pem'),keyPath:join(tlsDir,'client.key')}}
 const route=await createTransport({ssh:config.ssh}),proxy=await route.socks(),tls=await loadConnectionTls(config)
 configs.source={...config,name:'Source via SOCKS',proxy:{enabled:true,type:'socks5',...proxy}}
 configs.target={...config,name:'Target direct'}
 try{
 if(kind==='mongodb'){
  const client=await openMongoClient(config,route,tls)
  try{
   const a=client.db(source),b=client.db(target)
   const items=await a.createCollection<Document & {_id:unknown}>('items');await b.createCollection('keep_me')
   await items.createIndex({label:1},{name:'label_idx'})
   const append=await a.createCollection('append_only');await append.createIndex({a:1},{name:'a_idx'});await b.createCollection('append_only')
   await a.createCollection('guarded',{validator:{n:{$gt:0}}})
   const sample=BSON.EJSON.parse('{"_id":{"$oid":"64b000000000000000000001"},"wide":{"$numberLong":"9223372036854775807"},"decimal":{"$numberDecimal":"12345678901234567890.12345678"},"int":{"$numberInt":"2"},"double":{"$numberDouble":"2.0"},"date":{"$date":{"$numberLong":"1700000000000"}},"payload":{"$binary":{"base64":"AP8B","subType":"00"}},"nested":{"a":[null,{"$numberLong":"4"}]}}',{relaxed:false})
   await items.insertOne(sample)
   const docs=Array.from({length:1000},(_,i)=>({_id:new BSON.Int32(i),label:'中文',n:new BSON.Long(i)}))
   await items.insertMany(docs)
   const initial=await service.preview(owner,request('schema'))
   assert(!initial.steps.find(s=>s.name==='guarded')?.executable)
   assert.equal(initial.steps.find(s=>s.name==='append_only')?.action,'alter')
   await run('schema')
   exactPlan(await service.preview(owner,request('schema',['items','append_only'])))
   const result=await run('data',['items']);assert.equal(result.rowsCommitted,1001)
   const old=await items.findOne({_id:sample._id},{raw:true}),copied=await b.collection('items').findOne({_id:sample._id},{raw:true})
   assert(Buffer.isBuffer(old)&&Buffer.isBuffer(copied)&&old.equals(copied),'BSON byte fidelity')
   assert.equal(await b.collection('items').countDocuments(),1001)
   const conflict=await run('data',['items'],'uncertain');assert.equal(conflict.rowsCommitted,0);assert.equal(await b.collection('items').countDocuments(),1001)
   await a.createCollection('combined');await a.collection<Document & {_id:unknown}>('combined').insertOne({_id:1,n:'value'})
   assert.equal((await run('structure-data',['combined'])).rowsCommitted,1)
   await b.collection('items').updateOne({_id:sample._id},{$set:{wide:0}})
   const up=await run('data',['items'],undefined,'upsert',{field:'_id',operator:'eq',type:'ObjectId',value:String(sample._id)})
   assert.equal(up.rowsCommitted,1)
   const exact=await b.collection('items').findOne({_id:sample._id},{raw:true})
   assert(Buffer.isBuffer(exact)&&Buffer.isBuffer(old)&&exact.equals(old))
   assert.equal(await b.collection('items').countDocuments(),1001)
   console.log('M12 MongoDB typed ObjectId filter and upsert replaced only matched document')
   console.log('M12 MongoDB actual standalone TLS: schema/index creation, 1001 BSON documents byte-exact, duplicate stop, combined copy passed')
  }finally{await service.closeAll();await client.db(source).dropDatabase().catch(()=>{});await client.db(target).dropDatabase().catch(()=>{});await client.close()}
 }else if(kind==='redis'){
  source='0';target='1';configs.source.redisDb=0;configs.target.redisDb=1
  const a=await createRedisClient(configs.source,route,tls),b=await createRedisClient(configs.target,route,tls)
  const names=['str','hash','list','set','zset','stream','keep'].map(n=>'dbex_m12_'+suffix+':'+n)
  const [str,hash,list,set,zset,stream,keep]=names
  try{
   await a.set(str!,Buffer.from([0,255,128]),'PX',600000)
   await a.hset(hash!,'f',Buffer.from([255,1]))
   await a.rpush(list!,Buffer.from([0,255]),'text')
   await a.sadd(set!,'a','b');await a.zadd(zset!,1.25,'member')
   await a.xadd(stream!,'*','f',Buffer.from([0,255]))
   await a.set(keep!,'source');await b.set(keep!,'target')
   const catalog=await service.catalog(owner,'source','0');assert(catalog.objects?.some(o=>o.name===str))
   const plan=await service.preview(owner,request('data',names));assert.equal(plan.steps.filter(s=>s.executable).length,6)
   assert(!plan.steps.find(s=>s.name===keep)?.executable)
   const copied=await finish(service.start(owner,plan.id,plan.steps.filter(s=>s.executable).map(s=>s.id)).id)
   assert.equal(copied.state,'completed',JSON.stringify(copied));assert.equal(copied.rowsCommitted,6)
   for(const key of names.slice(0,6)){
    const [x,y]=await Promise.all([a.dumpBuffer(key),b.dumpBuffer(key)]);assert(x.equals(y),'RDB payload mismatch '+key)
   }
   const ttl=await b.pttl(str!);assert(ttl>0&&ttl<=600000);assert.equal(await b.get(keep!),'target')
   await a.set(keep!,'changed','PX',600000)
   const overwrite=await run('data',[keep!],undefined,'upsert')
   assert.equal(overwrite.rowsCommitted,1);assert.equal(await b.get(keep!),'changed')
   assert(await b.pttl(keep!)>0)
   console.log('M12 Redis explicit same-key overwrite with TTL passed')
   console.log('M12 Redis actual two logical DBs: six native types, binary DUMP/RESTORE and TTL preserved, no replacement')
  }finally{await service.closeAll();await a.del(...names).catch(()=>{});await b.del(...names).catch(()=>{});a.disconnect();b.disconnect()}
 }else{
  const pool=await openClickHouseClients(config,route,tls),client=pool.make('default',30000)
  const command=(query:string)=>client.command({query})
  try{
   await command('CREATE DATABASE '+source);await command('CREATE DATABASE '+target)
   const definition=' (id UInt64, amount Decimal(38,8), payload String, note Nullable(String)) ENGINE=MergeTree ORDER BY id'
   await command('CREATE TABLE '+source+'.items'+definition)
   await command('CREATE TABLE '+source+'.append_only (id UInt64, note Nullable(String)) ENGINE=MergeTree ORDER BY id')
   await command('CREATE TABLE '+target+'.append_only (id UInt64) ENGINE=MergeTree ORDER BY id')
   await command('CREATE TABLE '+source+'.guarded (id UInt64, next UInt64 DEFAULT id+1) ENGINE=MergeTree ORDER BY id')
   await command('INSERT INTO '+source+'.items SELECT number, toDecimal128(1,8), unhex(\'00ff80\'), NULL FROM numbers(12000)')
   await command("INSERT INTO "+source+".items VALUES (18446744073709551615,12345678901234567890.12345678,unhex('ff00'),NULL)")
   const initial=await service.preview(owner,request('schema'))
   assert(!initial.steps.find(s=>s.name==='guarded')?.executable)
   assert.equal(initial.steps.find(s=>s.name==='items')?.action,'create',JSON.stringify(initial.steps))
   await run('schema')
   exactPlan(await service.preview(owner,request('schema',['items','append_only'])))
   const copy=await run('data',['items']);assert(copy.bytesRead>0&&copy.rowsKnown===false)
   const summary=async(db:string)=>(await (await client.query({query:'SELECT count() AS n, max(id) AS id, max(amount) AS amount, sum(cityHash64(payload)) AS payload, countIf(isNull(note)) AS nulls FROM '+db+'.items',format:'JSONEachRow',clickhouse_settings:{output_format_json_quote_64bit_integers:1,output_format_json_quote_decimals:1}})).json())[0]
   assert.deepEqual(await summary(source),await summary(target))
   await command('CREATE TABLE '+source+'.combined'+definition);await command('INSERT INTO '+source+'.combined SELECT * FROM '+source+'.items LIMIT 10')
   await run('structure-data',['combined'])
   console.log('M12 ClickHouse actual HTTPS: create table/add nullable column, native stream binary/UInt64/decimal/NULL fidelity, combined copy passed')
  }finally{await service.closeAll();await command('DROP DATABASE IF EXISTS '+source+' SYNC').catch(()=>{});await command('DROP DATABASE IF EXISTS '+target+' SYNC').catch(()=>{});await pool.close()}
 }
 }finally{await service.closeAll();await route.close()}
}
