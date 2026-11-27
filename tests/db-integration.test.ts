import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import mysql from 'mysql2/promise'
import { BSON, MongoClient } from 'mongodb'
import { MysqlOperations } from '../src/main/operations/mysql'
import { MongoOperations } from '../src/main/operations/mongodb'
import {prepareGridEdits} from '../src/shared/grid-edit'
import {newBrowseFilter} from '../src/shared/browse-filter'
import {compileMongoScript} from '../src/shared/mongo-query-script'

const enabled = process.env.DB_EX_INTEGRATION === '1'
const read = { writable: false, confirmed: false }
const write = { writable: true, confirmed: true }
const name = () => `dbex_it_${Date.now()}_${randomBytes(4).toString('hex')}`
function localUrl(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('Integration fixtures only connect to localhost test services')
  return value
}

test('MySQL real database: pagination, prepared CRUD, conflicts, transactions and atomic import', { skip: !enabled, timeout: 90_000 }, async () => {
  const client = await mysql.createConnection({
    uri: localUrl('MYSQL_URL', 'mysql://root:dbex-test@127.0.0.1:3306'),
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, jsonStrings: true,
    multipleStatements: false,
  })
  const database = name()
  const operations = new MysqlOperations(client)
  try {
    await assert.rejects(operations.execute({action:'mysql.createDatabase',database},read),/READ_ONLY/)
    await operations.execute({action:'mysql.createDatabase',database},write)
    await assert.rejects(operations.execute({action:'mysql.dropDatabase',database:'mysql'},write),/PROTECTED_DATABASE/)
    await client.query(`CREATE TABLE \`${database}\`.records (id BIGINT PRIMARY KEY, name VARCHAR(255) COLLATE utf8mb4_general_ci NULL, amount DECIMAL(20,5) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    const target = { database, entity: 'records' }
    await operations.execute({ action: 'mysql.insert', ...target, values: { id: '9007199254740993', name: 'original', amount: '123456789012345.12345' } }, write)
    const result = await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records' }, read)
    assert.equal(result.rawRows?.[0].id, '9007199254740993')
    assert.equal(result.rawRows?.[0].amount, '123456789012345.12345')
    assert.equal(result.columnTypes?.[result.columns.indexOf('id')], 'BIGINT')
    assert.equal(result.columnTypes?.[result.columns.indexOf('amount')], 'DECIMAL')
    const inspected = (await operations.execute({ action: 'mysql.inspect', ...target }, read)).inspection!
    assert.equal(inspected.kind, 'table')
    assert.equal(inspected.metrics.find(item => item.label === '存储引擎')?.value, 'InnoDB')
    assert.equal(inspected.metrics.find(item => item.label === '字段数')?.value, '3')
    assert.match(inspected.definition || '', /CREATE TABLE.*records/s)
    const browse = { join: 'and' as const, groups: [{ join: 'and' as const, rules: [{ field: 'id', operator: 'eq' as const, type: 'Long' as const, value: '9007199254740993' }] }], sort: [{ field: 'id', direction: -1 as const }] }
    const filtered = await operations.execute({ action: 'mysql.browse', ...target, filter: browse, limit: 100 }, read)
    assert.equal(filtered.rawRows?.[0]?.id, '9007199254740993')
    assert.equal((await operations.execute({ action: 'mysql.browse', ...target, filter: browse, countOnly: true }, read)).totalRows, '1')
    const original = result.rawRows![0]
    const schema = await operations.execute({ action: 'mysql.structure', ...target }, read)
    assert.deepEqual(schema.primaryKeys, ['id'])
    await client.execute(`UPDATE \`${database}\`.records SET name = ? WHERE id = ?`, ['ORIGINAL', original.id])
    await assert.rejects(operations.execute({ action: 'mysql.update', ...target, key: { id: original.id }, original, changes: { name: 'must conflict' } }, write), /EDIT_CONFLICT/)
    await client.execute(`UPDATE \`${database}\`.records SET name = ? WHERE id = ?`, ['original ', original.id])
    await assert.rejects(operations.execute({ action: 'mysql.delete', ...target, key: { id: original.id }, original }, write), /EDIT_CONFLICT/)
    await client.execute(`UPDATE \`${database}\`.records SET name = ? WHERE id = ?`, ['original', original.id])
    const injection = "x'); DROP TABLE records; --"
    await operations.execute({ action: 'mysql.update', ...target, key: { id: original.id }, original, changes: { name: injection } }, write)
    await assert.rejects(operations.execute({ action: 'mysql.delete', ...target, key: { id: original.id }, original }, write), /EDIT_CONFLICT/)
    const updated = await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records WHERE name = ?', parameters: [injection] }, read)
    assert.equal(updated.rawRows?.[0].name, injection)
    await operations.execute({ action: 'mysql.begin' }, write)
    await operations.execute({ action: 'mysql.insert', ...target, values: { id: 2, name: 'rollback', amount: '1' } }, write)
    await operations.execute({ action: 'mysql.rollback' }, read)
    assert.equal((await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records WHERE id = 2' }, read)).rows.length, 0)
    await operations.execute({ action: 'mysql.begin' }, write)
    await operations.execute({ action: 'mysql.insert', ...target, values: { id: 2, name: 'commit', amount: '1' } }, write)
    await operations.execute({ action: 'mysql.commit' }, write)
    assert.equal((await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records WHERE id = 2' }, read)).rows.length, 1)
    await client.query(`DELETE FROM \`${database}\`.records WHERE id = 2`)
    // Binary prepared parameters remain safe even when SQL escaping rules change.
    const [modes] = await client.query('SELECT @@SESSION.sql_mode AS mode')
    const mode = String((modes as { mode: string }[])[0].mode)
    await client.execute('SET SESSION sql_mode = ?', [mode.includes('NO_BACKSLASH_ESCAPES') ? mode : `${mode},NO_BACKSLASH_ESCAPES`])
    const quoteValue = "quote\\' OR '1'='1"
    const bound = await operations.execute({ action: 'mysql.query', database, sql: 'SELECT ? AS bound_value', parameters: [quoteValue] }, read)
    assert.equal(bound.rawRows?.[0].bound_value, quoteValue)
    await client.execute('SET SESSION sql_mode = ?', [mode])
    await operations.execute({ action: 'mysql.import', ...target, rows: [{ id: 10, name: 'a', amount: '1' }, { id: 11, name: 'b', amount: '2' }, { id: 12, name: 'c', amount: '3' }] }, write)
    await assert.rejects(operations.execute({ action: 'mysql.import', ...target, rows: [{ id: 13, name: 'should rollback', amount: '1' }, { id: 10, name: 'duplicate', amount: '1' }] }, write), /DATABASE_ERROR/)
    assert.equal((await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records WHERE id = 13' }, read)).rows.length, 0)
    const paged = await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records ORDER BY id', limit: 2 }, read)
    assert.equal(paged.rows.length, 2)
    assert.equal(paged.nextOffset, 2)
    assert.equal((await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records ORDER BY id', limit: 2, offset: 2 }, read)).rows.length, 2)
    await assert.rejects(operations.execute({ action: 'mysql.query', database, sql: 'SELECT user_defined_function()' }, read), /SQL_POLICY/)
    // Derived tables reject duplicate aliases; no silent overwriting of result columns.
    await assert.rejects(operations.execute({ action: 'mysql.query', database, sql: 'SELECT 1 AS x, 2 AS x' }, read), /DATABASE_ERROR/)
    await operations.execute({ action: 'mysql.delete', ...target, key: { id: updated.rawRows![0].id }, original: updated.rawRows![0] }, write)
    assert.equal((await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM records WHERE id = ?', parameters: [original.id] }, read)).rows.length, 0)
    // JSON is fetched as server text; no JavaScript JSON.parse precision loss.
    // The optimistic binary predicate must also accept unchanged JSON text.
    await client.query(`CREATE TABLE \`${database}\`.json_records (id INT PRIMARY KEY, payload JSON, created_at DATETIME(6)) ENGINE=InnoDB`)
    const jsonTarget = { database, entity: 'json_records' }
    await operations.execute({ action: 'mysql.insert', ...jsonTarget, values: { id: 1, payload: '{"huge":9007199254740993,"nested":{"b":2,"a":1}}', created_at: '2025-01-01 10:00:00.123456' } }, write)
    const jsonRow = (await operations.execute({ action: 'mysql.query', database, sql: 'SELECT * FROM json_records' }, read)).rawRows![0]
    assert.match(String(jsonRow.payload), /9007199254740993/)
    assert.equal(jsonRow.created_at, '2025-01-01 10:00:00.123456')
    await operations.execute({ action: 'mysql.update', ...jsonTarget, key: { id: 1 }, original: jsonRow, changes: { payload: '{"huge":9007199254740995}' } }, write)
    await assert.rejects(operations.execute({ action: 'mysql.delete', ...jsonTarget, key: { id: 1 }, original: jsonRow }, write), /EDIT_CONFLICT/)
    // Regression: apply only staged records, preserve exact types, and roll
    // back the whole batch on a stale original. Existing fixtures remain isolated.
    const batchTarget={database,entity:'batch_records'}
    await client.query('CREATE TABLE '+database+'.batch_records (id BIGINT PRIMARY KEY, name VARCHAR(50) NOT NULL, amount DECIMAL(20,5) NOT NULL) ENGINE=InnoDB')
    await operations.execute({action:'mysql.import',...batchTarget,rows:[
      {id:'9007199254740993',name:'one',amount:'123456789012345.12345'},
      {id:'9007199254740994',name:'two',amount:'9.87654'},
      {id:'9007199254740995',name:'three',amount:'1.23456'}
    ]},write)
    const batchStructure=await operations.execute({action:'mysql.structure',...batchTarget},read)
    const batchBrowse=()=>operations.execute({action:'mysql.browse',...batchTarget,filter:{...newBrowseFilter(),sort:[{field:'id',direction:1}]}},read)
    let snapshot=await batchBrowse()
    const plan=(value:string)=>prepareGridEdits(snapshot,batchStructure,'mysql',['id'],[{row:0,field:'name',text:value},{row:1,field:'name',text:value}]).sqlEdits
    const batch={action:'mysql.updateBatch' as const,...batchTarget,edits:plan('updated')}
    await assert.rejects(operations.execute(batch,read),/READ_ONLY/)
    await assert.rejects(operations.execute(batch,{writable:true,confirmed:false}),/CONFIRMATION_REQUIRED/)
    assert.deepEqual((await operations.execute(batch,write)).gridBatch,{total:2,completed:2,atomic:true})
    snapshot=await batchBrowse()
    assert.deepEqual(snapshot.rawRows!.map(r=>r.name),['updated','updated','three'])
    assert.equal(snapshot.rawRows![0]!.id,'9007199254740993')
    assert.equal(snapshot.rawRows![0]!.amount,'123456789012345.12345')
    const stale=plan('rollback')
    await client.query('UPDATE '+database+'.batch_records SET name="external" WHERE id=9007199254740994')
    await assert.rejects(operations.execute({...batch,edits:stale},write),/EDIT_CONFLICT/)
    assert.deepEqual((await batchBrowse()).rawRows!.map(r=>r.name),['updated','external','three'])
    snapshot=await batchBrowse()
    await operations.execute({action:'mysql.begin'},write)
    assert.equal((await operations.execute({...batch,edits:plan('pending')},write)).transaction,true)
    await operations.execute({action:'mysql.rollback'},read)
    assert.deepEqual((await batchBrowse()).rawRows!.map(r=>r.name),['updated','external','three'])
    const nonAtomic={database,entity:'batch_nonatomic'}
    await client.query('CREATE TABLE '+database+'.batch_nonatomic (id INT PRIMARY KEY,name VARCHAR(40)) ENGINE=MyISAM')
    await client.query('INSERT INTO '+database+'.batch_nonatomic VALUES (1,"one"),(2,"two")')
    const partial=await operations.execute({action:'mysql.updateBatch',...nonAtomic,edits:[
      {key:{id:1},original:{id:1,name:'one'},changes:{name:'saved'}},
      {key:{id:2},original:{id:2,name:'stale'},changes:{name:'not saved'}}
    ]},write)
    assert.deepEqual([partial.gridBatch?.completed,partial.gridBatch?.atomic,partial.gridBatch?.failed,partial.gridBatch?.uncertain],[1,false,true,false])
    const [remaining]=await client.query('SELECT name FROM '+database+'.batch_nonatomic ORDER BY id')
    assert.deepEqual((remaining as {name:string}[]).map(r=>r.name),['saved','two'])

  } finally {
    await operations.close()
    const cleanup = operations.disconnected ? await mysql.createConnection(localUrl('MYSQL_URL', 'mysql://root:dbex-test@127.0.0.1:3306')) : client
    try { await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``) } finally { await cleanup.end() }
  }
})

test('MongoDB real database: BSON exactness, filter, aggregation, indexes and optimistic CRUD', { skip: !enabled, timeout: 90_000 }, async () => {
  const client = await new MongoClient(localUrl('MONGODB_URI', 'mongodb://127.0.0.1:27017'), { serverSelectionTimeoutMS: 10_000 }).connect()
  const database = name()
  const target = { database, entity: 'records' }
  const operations = new MongoOperations(client)
  const canonical = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false })
  try {
    await assert.rejects(operations.execute({action:'mongo.createDatabase',database,initialCollection:'records'},read),/READ_ONLY/)
    await assert.rejects(operations.execute({action:'mongo.dropDatabase',database:'admin'},write),/PROTECTED_DATABASE/)
    await operations.execute({action:'mongo.createDatabase',database,initialCollection:'records'},write)
    assert((await client.db(database).listCollections({name:'records'}).toArray()).length===1)
    const document = { _id: new BSON.ObjectId(), score: new BSON.Int32(5), big: BSON.Long.fromString('9223372036854775807'), money: BSON.Decimal128.fromString('123456789.123456789'), date: new Date('2025-01-01T00:00:00.000Z') }
    await operations.execute({ action: 'mongo.insert', ...target, documents: [canonical(document)] }, write)
    const first = await operations.execute({ action: 'mongo.find', ...target, filter: '{"score":{"$gte":5}}', sort: '{"score":-1}' }, read)
    assert.equal(first.documents?.length, 1)
    assert.equal((await operations.execute({ action: 'mongo.count', ...target, filter: '{"score":{"$numberInt":"5"}}' }, read)).totalRows, '1')
    const parsed = BSON.EJSON.parse(first.documents![0], { relaxed: false })
    assert.equal(parsed.big.toString(), '9223372036854775807')
    assert.equal(parsed.money.toString(), '123456789.123456789')
    await operations.execute({ action: 'mongo.replace', ...target, original: first.documents![0], document: canonical({ ...parsed, score: new BSON.Int32(7) }) }, write)
    await assert.rejects(operations.execute({ action: 'mongo.delete', ...target, original: first.documents![0] }, write), /EDIT_CONFLICT/)
    const aggregate = await operations.execute({ action: 'mongo.aggregate', ...target, pipeline: '[{"$group":{"_id":null,"total":{"$sum":"$score"}}}]' }, read)
    assert.equal(BSON.EJSON.parse(aggregate.documents![0], { relaxed: true }).total, 7)
    await assert.rejects(operations.execute({ action: 'mongo.aggregate', ...target, pipeline: '[{"$out":"forbidden"}]' }, read), /MONGO_POLICY/)
    await operations.execute({ action: 'mongo.createIndex', ...target, keys: '{"score":1}', options: '{"name":"score_index","unique":true}' }, write)
    const indexes = await operations.execute({ action: 'mongo.indexes', ...target }, read)
    assert.equal(indexes.documents!.some(text => BSON.EJSON.parse(text).name === 'score_index'), true)
    const inspected = (await operations.execute({ action: 'mongo.inspect', ...target }, read)).inspection!
    assert.equal(inspected.kind, 'collection')
    assert.equal(inspected.metrics.find(item => item.label === '文档数')?.value, '1')
    assert.equal(inspected.metrics.find(item => item.label === '索引数')?.value, '2')
    assert.match(inspected.definition || '', /createCollection\("records"/)
    assert.match(inspected.definition || '', /createIndex/)
    assert.match(inspected.definition || '', /score_index/)
    assert.match(inspected.definition || '', /unique/)
    await operations.execute({ action: 'mongo.dropIndex', ...target, name: 'score_index' }, write)
    const latest = await operations.execute({ action: 'mongo.find', ...target, filter: '{}' }, read)
    const projected = await operations.execute({ action: 'mongo.find', ...target, projection: '{"_id":1}' }, read)
    await assert.rejects(operations.execute({ action: 'mongo.delete', ...target, original: projected.documents![0] }, write), /EDIT_CONFLICT/)
    await operations.execute({ action: 'mongo.delete', ...target, original: latest.documents![0] }, write)
    assert.equal((await operations.execute({ action: 'mongo.find', ...target }, read)).documents?.length, 0)
    await assert.rejects(operations.execute({ action: 'mongo.insert', ...target, documents: ['{}'] }, read), /READ_ONLY/)
    await assert.rejects(operations.execute({ action: 'mongo.insert', database, entity: 'bulk', documents: ['{"_id":"same","value":1}', '{"_id":"same","value":2}'] }, write), /PARTIAL_WRITE:.*1/)
    assert.equal(await client.db(database).collection('bulk').countDocuments(), 1)
    const batchTarget={database,entity:'batch_records'}
    const batchDoc=(id:number,name:string)=>canonical({_id:new BSON.ObjectId(String(id).padStart(24,'0')),name,big:BSON.Long.fromString('9223372036854775807'),money:BSON.Decimal128.fromString('123456789.123456789'),score:new BSON.Int32(7),date:new Date('2025-01-01T00:00:00Z')})
    await operations.execute({action:'mongo.insert',...batchTarget,documents:[batchDoc(1,'one'),batchDoc(2,'two'),batchDoc(3,'three')]},write)
    const batchFind=()=>operations.execute({action:'mongo.find',...batchTarget,sort:'{"_id":1}'},read)
    let snapshot=await batchFind()
    const batch={action:'mongo.replaceBatch' as const,...batchTarget,edits:prepareGridEdits(snapshot,null,'mongodb',[],[
      {row:0,field:'name',text:'updated'},{row:1,field:'name',text:'updated'},{row:0,field:'big',text:'9223372036854775806'}
    ]).mongoEdits}
    await assert.rejects(operations.execute(batch,read),/READ_ONLY/)
    await assert.rejects(operations.execute(batch,{writable:true,confirmed:false}),/CONFIRMATION_REQUIRED/)
    assert.deepEqual((await operations.execute(batch,write)).gridBatch,{total:2,completed:2,atomic:false})
    snapshot=await batchFind()
    const docs=snapshot.documents!.map(text=>JSON.parse(text))
    assert.deepEqual(docs.map(x=>x.name),['updated','updated','three'])
    assert.equal(docs[0].big.$numberLong,'9223372036854775806')
    assert.equal(docs[0].money.$numberDecimal,'123456789.123456789')
    assert.deepEqual(docs[0].score,{$numberInt:'7'})
    assert.equal(docs[0].date.$date.$numberLong,'1735689600000')
    const edits=prepareGridEdits(snapshot,null,'mongodb',[],[{row:0,field:'name',text:'partial'},{row:1,field:'name',text:'not saved'}]).mongoEdits
    await client.db(database).collection(batchTarget.entity).updateOne({_id:new BSON.ObjectId('000000000000000000000002')},{$set:{name:'external'}})
    const partial=await operations.execute({...batch,edits},write)
    assert.deepEqual([partial.gridBatch?.completed,partial.gridBatch?.failed,partial.gridBatch?.uncertain],[1,true,false])
    assert.deepEqual((await batchFind()).documents!.map(text=>JSON.parse(text).name),['partial','external','three'])
    const script=compileMongoScript('db.batch_records.find({big:NumberLong("9223372036854775806")}).limit(1)',database).operation
    assert.equal((await operations.execute(script,read)).documents?.length,1)

    await operations.execute({action:'mongo.dropDatabase',database},write)
    assert.equal((await client.db(database).listCollections().toArray()).length,0)
  } finally {
    await operations.close()
    await client.db(database).dropDatabase()
    await client.close()
  }
})


test('MongoDB real collection maintenance: explicit create, rename, empty and drop; protected targets rejected',{skip:!enabled,timeout:90000},async()=>{
 const client=await new MongoClient(localUrl('MONGODB_URI','mongodb://127.0.0.1:27017'),{serverSelectionTimeoutMS:10000}).connect()
 const database=name(),db=client.db(database),ops=new MongoOperations(client)
 try{
  const target={database,entity:'items'}
  await assert.rejects(ops.execute({action:'mongo.createCollection',...target},read),/READ_ONLY/)
  await assert.rejects(ops.execute({action:'mongo.createCollection',...target},{writable:true,confirmed:false}),/CONFIRMATION_REQUIRED/)
  await assert.rejects(ops.execute({action:'mongo.createCollection',database:'admin',entity:'dbex_rejected'},write),/PROTECTED_DATABASE/)
  await ops.execute({action:'mongo.createCollection',...target},write)
  await db.collection('items').insertMany([{n:1},{n:2}])
  await db.collection('items').createIndex({n:1})
  await db.createCollection('existing')
  await assert.rejects(ops.execute({action:'mongo.renameCollection',...target,newName:'existing'},write),/集合名称已存在/)
  await assert.rejects(ops.execute({action:'mongo.clearCollection',...target},read),/READ_ONLY/)
  await ops.execute({action:'mongo.renameCollection',...target,newName:'renamed'},write)
  assert.equal(await db.collection('renamed').countDocuments(),2)
  assert.equal((await db.listCollections({name:'items'}).toArray()).length,0)
  await ops.execute({action:'mongo.clearCollection',database,entity:'renamed'},write)
  assert.equal(await db.collection('renamed').countDocuments(),0)
  assert.equal((await db.collection('renamed').listIndexes().toArray()).length,2)
  await db.createCollection('capped',{capped:true,size:4096})
  await assert.rejects(ops.execute({action:'mongo.clearCollection',database,entity:'capped'},write),/不支持此集合/)
  await assert.rejects(ops.execute({action:'mongo.dropCollection',database,entity:'fs.files'},write),/不支持此集合/)
  await ops.execute({action:'mongo.dropCollection',database,entity:'renamed'},write)
  assert.equal((await db.listCollections({name:'renamed'}).toArray()).length,0)
  assert.equal((await db.listCollections({name:'existing'}).toArray()).length,1)
 }finally{await ops.close();await db.dropDatabase();await client.close()}
})
