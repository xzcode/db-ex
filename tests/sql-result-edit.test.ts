import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {SqliteOperations} from '../src/main/operations/sqlite'
import {sqlResultTarget,canEditSqlRow,prepareSqlResultEdit,sqlResultFields} from '../src/shared/sql-result-edit'
import type {OperationResult} from '../src/shared/types'

test('query editing only binds an ordinary single-table SELECT * to its executed target',()=>{
 assert.deepEqual(sqlResultTarget('SELECT * FROM users WHERE id=? ORDER BY id LIMIT 2;','app','mysql'),{database:'app',entity:'users'})
 assert.deepEqual(sqlResultTarget('SELECT * FROM `other`.`user data` WHERE id=1','app','mariadb'),{database:'other',entity:'user data'})
 assert.deepEqual(sqlResultTarget('SELECT * FROM main."user data"','main','sqlite'),{database:'main',entity:'user data'})
 for(const sql of [
  'SELECT id,name FROM users','SELECT * FROM users u','SELECT * FROM users JOIN accounts ON 1=1','SELECT * FROM users,accounts',
  'SELECT * FROM users WHERE id IN (SELECT id FROM accounts)','SELECT * FROM users UNION SELECT * FROM accounts',
  'SELECT * FROM users GROUP BY id','SELECT * FROM users; SELECT * FROM accounts','SELECT * FROM users /* hint */',
  'SELECT * FROM users WHERE name="abc" -- comment','SELECT * FROM mysql.user','SELECT * FROM usersWHERE id=1',
  'SELECT * FROM users WHERE id=1 FOR UPDATE','SELECT * FROM users WHERE id=1 UNION ALL SELECT * FROM other',
 ])assert.equal(sqlResultTarget(sql,'app','mysql'),undefined,sql)
 assert.equal(sqlResultTarget('SELECT * FROM temp.users','main','sqlite'),undefined)
 assert.equal(sqlResultTarget('SELECT * FROM sqlite_master','main','sqlite'),undefined)
 assert.equal(sqlResultTarget('SELECT * FROM users','app','clickhouse'),undefined)
})

test('result editing requires exact originals and complete primary keys, excludes generated and primary fields',()=>{
 const structure:OperationResult={columns:['name','type','extra'],rows:[{name:'id',type:'BIGINT',extra:''},{name:'name',type:'VARCHAR(50)',extra:''},{name:'computed',type:'VARCHAR(50)',extra:'VIRTUAL GENERATED'}],primaryKeys:['id'],objectCapabilities:{insert:true,update:true,delete:true,transactional:true,import:true}}
 const result:OperationResult={columns:['id','name','computed'],rows:[{id:'1',name:'Ada',computed:'ADA'}],rawRows:[{id:'1',name:'Ada',computed:'ADA'}],queryReadOnly:true}
 assert.equal(canEditSqlRow(result,structure,0),true)
 assert.deepEqual(sqlResultFields(result,structure,'mysql',0).map(f=>f.field),['name'])
 assert.deepEqual(JSON.parse(JSON.stringify(prepareSqlResultEdit(result,structure,'mysql',0,{name:'Grace'}))),{key:{id:'1'},original:{id:'1',name:'Ada',computed:'ADA'},changes:{name:'Grace'}})
 assert.throws(()=>prepareSqlResultEdit(result,structure,'mysql',0,{id:'2'}),/QUERY_EDIT/)
 for(const unsafe of [{...result,rawRows:undefined},{...result,queryReadOnly:false},{...result,rawRows:[{id:'1',name:'Ada'}]},{...result,rawRows:[{id:null,name:'Ada',computed:'ADA'}]},{...result,truncationReason:'document' as const}])assert.equal(canEditSqlRow(unsafe,structure,0),false)
 assert.equal(canEditSqlRow(result,{...structure,objectCapabilities:{...structure.objectCapabilities!,transactional:false}},0),false)
})

test('SQLite query-result write uses real table identity, full-row conflict detection and read-only guards',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dbex-sql-result-edit-')),path=join(dir,'db.sqlite')
 const seed=new DatabaseSync(path)
 seed.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO users VALUES(1,'Ada'); CREATE VIEW user_view AS SELECT * FROM users; CREATE TABLE no_key(name TEXT)")
 seed.close()
 const db=new SqliteOperations(path),read={writable:false,confirmed:false},write={writable:true,confirmed:true}
 try{
  const target={database:'main',entity:'users'},query={action:'mysql.query' as const,database:'main',sql:'SELECT * FROM users WHERE id=?',parameters:[1]}
  const result=db.execute(query,read),structure=db.execute({action:'mysql.structure',...target},read)
  assert.equal(canEditSqlRow(result,structure,0),true)
  assert.equal(db.execute({action:'mysql.structure',database:'main',entity:'user_view'},read).objectCapabilities?.update,false)
  assert.equal(db.execute({action:'mysql.structure',database:'main',entity:'no_key'},read).objectCapabilities?.update,false)
  const edit=prepareSqlResultEdit(result,structure,'sqlite',0,{name:'Grace'})!
  const op={action:'mysql.updateBatch' as const,...target,edits:[edit],confirmed:true,queryResult:true as const}
  assert.throws(()=>db.execute(op,read),/READ_ONLY/)
  db.execute({action:'mysql.begin'},write)
  assert.throws(()=>db.execute(op,write),/QUERY_EDIT/)
  db.execute({action:'mysql.rollback'},read)
  assert.equal(db.execute(op,write).gridBatch?.completed,1)
  assert.equal(db.execute(query,read).rawRows?.[0]?.name,'Grace')
  assert.throws(()=>db.execute(op,write),/ROW_CONFLICT/)
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
