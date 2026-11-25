import test from 'node:test'
import assert from 'node:assert/strict'
import {gridCellSpec,prepareGridEdits,mongoCellValue,sqlCellValue} from '../src/shared/grid-edit'
import {SqliteOperations} from '../src/main/operations/sqlite'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {adapterOperationWrites} from '../src/main/connections/adapters'
import type {OperationResult} from '../src/shared/types'
test('grid drafts preserve Mongo BSON exact types, original document and immutable id',()=>{
 const original='{"_id":{"$oid":"0123456789abcdef01234567"},"n":{"$numberLong":"9223372036854775807"},"name":"Ada","date":{"$date":{"$numberLong":"1700000000000"}}}'
 const data:OperationResult={columns:['_id','n','name','date'],rows:[{_id:'id',n:'9223372036854775807',name:'Ada',date:'date'}],documents:[original],bsonTypes:[{type:'Document',children:{_id:'ObjectId',n:'Int64',name:'String',date:'Date'}}]}
 assert.equal(gridCellSpec(data,null,'mongodb',[],0,'_id'),undefined)
 assert.equal(gridCellSpec(data,null,'mongodb',[],0,'n')?.text,'9223372036854775807')
 const edits=prepareGridEdits(data,null,'mongodb',[],[{row:0,field:'n',text:'9223372036854775806'},{row:0,field:'name',text:'New'}])
 assert.equal(edits.mongoEdits[0]?.original,original)
 assert.deepEqual(JSON.parse(edits.mongoEdits[0]!.document),{...JSON.parse(original),n:{$numberLong:'9223372036854775806'},name:'New'})
 assert.throws(()=>mongoCellValue('Int64','9223372036854775808'))
 assert.throws(()=>mongoCellValue('Boolean','1'))
 assert.equal(sqlCellValue('mysql','DECIMAL(38,8)','12345678901234567890.12345678','0'),'12345678901234567890.12345678')
 assert.equal(sqlCellValue('sqlite','INTEGER','42',1),42)
 assert.throws(()=>sqlCellValue('sqlite','INTEGER','9223372036854775807',1))
 assert.throws(()=>prepareGridEdits(data,null,'mongodb',[],[{row:0,field:'_id',text:'bad'}]))
})
test('real SQLite batch is atomic on a conflict and retains the outer explicit transaction',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dbex-grid-batch-')),path=join(dir,'fixture.sqlite')
 const seed=new DatabaseSync(path);seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO t VALUES(1,'one'),(2,'two')");seed.close()
 const db=new SqliteOperations(path),read={writable:false,confirmed:false},write={writable:true,confirmed:true}
 const op={action:'mysql.updateBatch' as const,database:'main',entity:'t',confirmed:true,edits:[{key:{id:1},original:{id:1,name:'one'},changes:{name:'new'}},{key:{id:2},original:{id:2,name:'stale'},changes:{name:'new'}}]}
 try{
  assert.throws(()=>db.execute(op,read),/READ_ONLY/)
  assert.throws(()=>db.execute(op,write),/ROW_CONFLICT/)
  assert.equal(db.execute({action:'mysql.query',sql:'SELECT name FROM t WHERE id=1'},read).rows[0]?.name,'one')
  db.execute({action:'mysql.begin'},write)
  const result=db.execute({...op,edits:[op.edits[0]!,{...op.edits[1]!,original:{id:2,name:'two'}}]},write)
  assert.deepEqual(result.gridBatch,{total:2,completed:2,atomic:true})
  assert.equal(db.transactionActive,true)
  db.execute({action:'mysql.rollback'},read)
  assert.deepEqual(db.execute({action:'mysql.query',sql:'SELECT name FROM t ORDER BY id'},read).rows.map(r=>r.name),['one','two'])
  assert.equal(adapterOperationWrites('sqlite',op,true),true)
  assert.throws(()=>adapterOperationWrites('clickhouse',op,true))
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
