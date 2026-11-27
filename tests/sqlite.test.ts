import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteOperations } from '../src/main/operations/sqlite'
import { inspectSqliteSql } from '../src/main/operations/sqlite-policy'
import { newBrowseFilter } from '../src/shared/browse-filter'
test('SQLite opens a real local file and preserves read/write, types, DDL and transaction guards',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dbex-sqlite-')),path=join(dir,'data.sqlite')
 const seed=new DatabaseSync(path);seed.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL); INSERT INTO users VALUES (1,'Alice',1.5),(2,'Bob',2.5); CREATE VIEW names AS SELECT name FROM users");seed.close()
 const db=new SqliteOperations(path),read={writable:false,confirmed:false},write={writable:true,confirmed:true}
 try{
  assert.deepEqual(db.children().map(x=>[x.label,x.kind]),[['names','view'],['users','table']])
  assert.equal(db.execute({action:'mysql.browse',database:'main',entity:'users',filter:newBrowseFilter(),limit:1},read).nextOffset,1)
  const result=db.execute({action:'mysql.query',sql:'SELECT * FROM users ORDER BY id',limit:2},read)
  assert.deepEqual(result.sqliteTypes?.[0],['INTEGER','TEXT','REAL'])
  assert.equal(result.rawRows?.[0]?.id,1)
  assert.match(db.execute({action:'mysql.inspect',database:'main',entity:'users'},read).inspection?.definition||'',/CREATE TABLE/)
  assert.throws(()=>db.execute({action:'mysql.query',sql:'DELETE FROM users'},read),/READ_ONLY/)
  assert.throws(()=>db.execute({action:'mysql.query',sql:'DELETE FROM users'},{writable:true,confirmed:false}),/CONFIRMATION_REQUIRED/)
  db.execute({action:'mysql.begin'},write)
  db.execute({action:'mysql.insert',database:'main',entity:'users',values:{name:'Carol',score:3}},write)
  db.execute({action:'mysql.rollback'},read)
  assert.equal(db.execute({action:'mysql.query',sql:'SELECT count(*) n FROM users'},read).rows[0]?.n,'2')
  const original=result.rawRows![0]!
  assert.equal(db.execute({action:'mysql.update',database:'main',entity:'users',key:{id:1},original,changes:{name:'Alicia'}},write).affectedRows,1)
  assert.throws(()=>db.execute({action:'mysql.delete',database:'main',entity:'users',key:{id:1},original},write),/ROW_CONFLICT/)
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
test('SQLite SQL policy blocks multi statements, connection and extension operations',()=>{
 for(const sql of ["SELECT 1; DELETE FROM users","ATTACH 'x' AS x","PRAGMA writable_schema=ON","VACUUM INTO 'copy'","SELECT load_extension('x')","BEGIN"])assert.throws(()=>inspectSqliteSql(sql))
 assert.equal(inspectSqliteSql("SELECT ';' AS text; -- safe").mode,'read')
 assert.equal(inspectSqliteSql("WITH a AS (SELECT 1) DELETE FROM users").mode,'write')
})
test('SQLite native online backup includes committed data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dbex-sqlite-backup-')),path=join(dir,'source.sqlite'),dest=join(dir,'copy.sqlite')
 const seed=new DatabaseSync(path);seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(7)");seed.close()
 const db=new SqliteOperations(path)
 try{await db.backupTo(dest);const copy=new DatabaseSync(dest,{readOnly:true});try{assert.equal(copy.prepare('SELECT id FROM t').get()?.id,7)}finally{copy.close()}}
 finally{db.close();rmSync(dir,{recursive:true,force:true})}
})

test('SQLite recognizes integer bindings, named indexes, exact Int64 and BLOB without exposing lossy edits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dbex-sqlite-types-')),path=join(dir,'types.sqlite')
 const seed=new DatabaseSync(path)
 seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value, note TEXT); CREATE INDEX idx_note ON t(note); INSERT INTO t VALUES (1,9223372036854775807,'first'),(2,X'0001FF','second')")
 seed.close()
 const db=new SqliteOperations(path),read={writable:false,confirmed:false},write={writable:true,confirmed:true}
 try{
  const result=db.execute({action:'mysql.query',sql:'SELECT * FROM t ORDER BY id'},read)
  assert.deepEqual(result.sqliteTypes?.map(row=>row[1]),['INTEGER','BLOB'])
  assert.equal(result.rows[0]?.value,'9223372036854775807')
  assert.equal(result.rows[1]?.value,'base64:AAH/')
  assert.deepEqual(JSON.parse(JSON.stringify(result.binaryCells)),[{}, {value:'AAH/'}])
  assert.equal(result.rawRows,undefined)
  const structure=db.execute({action:'mysql.structure',database:'main',entity:'t'},read)
  assert.match(structure.rows.find(row=>row.name==='note')?.indexes||'',/idx_note/)
  db.execute({action:'mysql.insert',database:'main',entity:'t',values:{id:3,value:42,note:'third'}},write)
  assert.equal(db.execute({action:'mysql.query',sql:'SELECT typeof(value) AS type FROM t WHERE id=?',parameters:[3]},read).rows[0]?.type,'integer')
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
