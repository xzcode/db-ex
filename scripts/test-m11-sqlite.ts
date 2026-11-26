import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,stat,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import {SessionManager} from '../src/main/connections/manager'
import {newConnectionConfig} from '../src/shared/connection-form'
import {newBrowseFilter} from '../src/shared/browse-filter'
import {publishNewFile} from '../src/main/operations/publish-file'

const dir=await mkdtemp(join(tmpdir(),'dbex-m11-sqlite-'))
const file=join(dir,'大数据 fixture.sqlite'),staged=join(dir,'staged.sqlite'),output=join(dir,'backup.sqlite')
const manager=new SessionManager(undefined,resolve('dist-electron/sqlite-worker.cjs'))
const count=50000
try{
 const begin=performance.now(),db=new DatabaseSync(file)
 try{
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY, payload TEXT NOT NULL); BEGIN')
  const insert=db.prepare('INSERT INTO items VALUES (?,?)'),payload='数据库'+ 'x'.repeat(512)
  for(let i=1;i<=count;i++)insert.run(i,payload)
  db.exec('COMMIT')
 }finally{db.close()}
 const seedMs=Math.round(performance.now()-begin)
 const config={...newConnectionConfig('sqlite'),name:'M11 local file',filePath:file}
 const first=await manager.connect(config),second=await manager.connect(config)
 assert.notEqual(first.id,second.id)
 const target={database:'main',entity:'items'}
 const start=performance.now()
 const page=await manager.execute(first.id,{action:'mysql.browse',...target,filter:{...newBrowseFilter(),sort:[{field:'id',direction:1}]},limit:500,offset:49000})
 assert.equal(page.rows.length,500);assert.equal(page.rows[0]?.id,'49001');assert.equal(page.nextOffset,49500)
 const browseMs=Math.round(performance.now()-start)
 await assert.rejects(()=>manager.execute(first.id,{action:'mysql.insert',...target,values:{id:count+1,payload:'denied'},confirmed:true}),/READ_ONLY/)
 await manager.setWriteAccess(first.id,true)
 await manager.execute(first.id,{action:'mysql.begin',confirmed:true})
 await manager.execute(first.id,{action:'mysql.insert',...target,values:{id:count+1,payload:'uncommitted'},confirmed:true})
 const snapshot=await manager.execute(second.id,{action:'mysql.query',sql:'SELECT COUNT(*) AS n FROM items'})
 assert.equal(snapshot.rows[0]?.n,String(count))
 await assert.rejects(()=>manager.backupSqlite(first.id,staged),/SESSION_BUSY/)
 await manager.cancel(first.id)
 assert.throws(()=>manager.info(first.id),/SESSION_CLOSED/)
 assert.equal((await manager.execute(second.id,{action:'mysql.query',sql:'SELECT COUNT(*) AS n FROM items'})).rows[0]?.n,String(count))
 const backupStart=performance.now()
 await manager.backupSqlite(second.id,staged)
 await publishNewFile(staged,output)
 const backupMs=Math.round(performance.now()-backupStart)
 const restored=new DatabaseSync(output,{readOnly:true})
 try{assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM items').get()?.n,count);assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok')}finally{restored.close()}
 await assert.rejects(()=>publishNewFile(staged,output),/OUTPUT_EXISTS/)
 const versionDb=new DatabaseSync(':memory:');let sqliteVersion;try{sqliteVersion=versionDb.prepare('SELECT sqlite_version() AS v').get()?.v}finally{versionDb.close()}
 console.log('M11 SQLite benchmark '+JSON.stringify({sqliteVersion,rows:count,databaseBytes:(await stat(file)).size,backupBytes:(await stat(output)).size,seedMs,browseMs,backupMs}))
 console.log('Real SQLite: deep paging, WAL isolation, cancellation rollback, non-overwrite backup and integrity check passed')
}finally{await manager.closeAll();await rm(dir,{recursive:true,force:true})}
