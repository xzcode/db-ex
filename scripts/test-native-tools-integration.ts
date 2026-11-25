import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { MongoClient, ObjectId, Long } from 'mongodb'
import { createTransport } from '../src/main/connections/transport'
import { SessionManager } from '../src/main/connections/manager'
import { runNativeTool } from '../src/main/operations/native-tools'
import { newConnectionConfig } from '../src/shared/connection-form'
import type { NativeToolTask, ToolName } from '../src/shared/preferences'

function env(name:string):string {const value=process.env[name];if(!value)throw new Error('Missing isolated test fixture: '+name);return value}
const fixture=env('DBEX_NATIVE_FIXTURE'),database='dbex_native_fixture'
const host='127.0.0.1'
const mysqlConfig={...newConnectionConfig('mysql'),name:'isolated MySQL',host,port:Number(env('DBEX_NATIVE_MYSQL_PORT')),username:'root',password:env('DBEX_NATIVE_MYSQL_PASSWORD')}
const mongoConfig={...newConnectionConfig('mongodb'),name:'isolated MongoDB',host,port:Number(env('DBEX_NATIVE_MONGO_PORT')),username:env('DBEX_NATIVE_MONGO_USER'),password:env('DBEX_NATIVE_MONGO_PASSWORD'),authSource:'admin'}
const mysqlClient=await mysql.createConnection({host,port:mysqlConfig.port,user:mysqlConfig.username,password:mysqlConfig.password})
const mongoClient=await new MongoClient('mongodb://'+host+':'+mongoConfig.port,{auth:{username:mongoConfig.username,password:mongoConfig.password},authSource:'admin',directConnection:true}).connect()
const signal=new AbortController().signal
const run=(tool:ToolName,task:NativeToolTask,file:string,entity?:string)=>runNativeTool(join(fixture,'bin',tool),task,task.startsWith('mysql-')?mysqlConfig:mongoConfig,database,entity,file,signal)
try{
  await mysqlClient.query('CREATE DATABASE dbex_native_fixture')
  await mysqlClient.query('CREATE TABLE dbex_native_fixture.items (id INT PRIMARY KEY, name VARCHAR(100), score DECIMAL(20,4))')
  await mysqlClient.execute('INSERT INTO dbex_native_fixture.items VALUES (?, ?, ?)',[7,'fixture SQL','1234567890123456.7890'])
  const mysqlFile=join(fixture,'fixture.sql')
  await run('mysqldump','mysql-backup',mysqlFile)
  const dump=await readFile(mysqlFile)
  assert.ok(dump.length>100)
  await assert.rejects(()=>run('mysqldump','mysql-backup',mysqlFile))
  assert.deepEqual(await readFile(mysqlFile),dump)
  await mysqlClient.query('DROP TABLE dbex_native_fixture.items')
  await run('mysql','mysql-restore',mysqlFile)
  const [sqlRows]=await mysqlClient.query('SELECT id,name,score FROM dbex_native_fixture.items') as [any[],unknown]
  assert.equal(sqlRows[0].id,7);assert.equal(sqlRows[0].name,'fixture SQL');assert.equal(sqlRows[0].score,'1234567890123456.7890')
  console.log('MySQL authenticated backup, non-overwrite, and SQL restore passed')

  const db=mongoClient.db(database)
  const id=new ObjectId()
  await db.collection('items').insertOne({_id:id,kind:'fixture BSON',value:Long.fromString('9223372036854775807')})
  const archive=join(fixture,'fixture.archive')
  await run('mongodump','mongo-backup',archive)
  assert.ok((await stat(archive)).size>0)
  await db.collection('items').drop()
  await run('mongorestore','mongo-restore',archive)
  assert.equal((await db.collection('items').findOne({_id:id}))?.value.toString(),'9223372036854775807')
  const json=join(fixture,'fixture.json')
  const exported=await (async()=>{await run('mongoexport','mongo-export',json,'items');return readFile(json,'utf8')})()
  assert.match(exported,/\$numberLong/)
  await run('mongoimport','mongo-import',json,'imported')
  assert.equal((await db.collection('imported').findOne({_id:id}))?.value.toString(),'9223372036854775807')
  console.log('MongoDB authenticated archive backup/restore and canonical EJSON export/import passed')
  const manager=new SessionManager()
  try{
    const sql=await manager.connect({...mysqlConfig,database})
    const tables=await manager.children(sql.id,database,undefined,true)
    const table=tables.find(node=>node.entity==='items')
    assert.equal(table?.metrics?.find(metric=>metric.label==='存储引擎')?.value,'InnoDB')
    assert.match(table?.metrics?.find(metric=>metric.label==='数据大小')?.value||'',/^\d+$/)
    const mongo=await manager.connect({...mongoConfig,database})
    const collections=await manager.children(mongo.id,database,'collections',true)
    for(const name of ['items','imported']){
      const node=collections.find(item=>item.entity===name)
      assert.equal(node?.metrics?.find(metric=>metric.label==='文档数')?.value,'1')
      assert.match(node?.metrics?.find(metric=>metric.label==='存储大小')?.value||'',/^\d+$/)
    }
    console.log('MySQL and MongoDB object catalogs returned real storage metadata')
    const proxy=await createTransport({ssh:mysqlConfig.ssh})
    try{
      const endpoint=await proxy.socks()
      const routedSql=await manager.connect({...mysqlConfig,database,proxy:{enabled:true,type:'socks5',...endpoint}})
      const routedMongo=await manager.connect({...mongoConfig,database,proxy:{enabled:true,type:'socks5',...endpoint}})
      for(const [id,tool,task,output] of [[routedSql.id,'mysqldump','mysql-backup','routed.sql'],[routedMongo.id,'mongodump','mongo-backup','routed.archive']] as const){
        await manager.routedExternal(id,false,(config,signal,route)=>runNativeTool(join(fixture,'bin',tool),task,config,database,undefined,join(fixture,output),signal,route))
        assert((await stat(join(fixture,output))).size>0)
      }
      console.log('MySQL and MongoDB native backup over authenticated SOCKS transport passed')
    }finally{await proxy.close()}
  }finally{await manager.closeAll()}
  assert.deepEqual((await readdir(fixture)).filter(name=>name.startsWith('dbex-tool-')||name.startsWith('.dbex-export-')),[])
  console.log('Native-tool credentials and staging directories cleaned')
}finally{
  await mysqlClient.query('DROP DATABASE IF EXISTS dbex_native_fixture').catch(()=>{})
  await mongoClient.db(database).dropDatabase().catch(()=>{})
  await mysqlClient.end()
  await mongoClient.close()
}
