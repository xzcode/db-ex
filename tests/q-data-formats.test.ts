import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,open,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import ExcelJS from 'exceljs'
import {compileSqlBrowsePredicate} from '../src/shared/sql-browse-predicate'
import {compileMysqlFilter,compileMongoFilter,newBrowseFilter} from '../src/shared/browse-filter'
import {normalizeBrowseProfile} from '../src/shared/browse-profile'
import {parseInsertStatement,sqlDataRecords,sqlInsertLine} from '../src/main/file-transfer/sql-records'
import {inspectFile,readFileRecords,sqlFileValue} from '../src/main/file-transfer/records'
import {writeXlsxRecords} from '../src/main/file-transfer/xlsx-records'
import {FileTransferService} from '../src/main/file-transfer/service'
import {normalizeFileTransfer} from '../src/shared/file-transfer'

test('Q3 SQL text predicate binds literals, handles nested comparisons and shares browse/count semantics',()=>{
 const raw={text:"LOWER(name) LIKE ? AND (score BETWEEN 10 AND 20 OR note IS NULL) AND id IN (9223372036854775807, 2)",parameters:['a%']}
 const filter={...newBrowseFilter(),raw,sort:[{field:'id',direction:-1 as const}]}
 const compiled=compileMysqlFilter('main','records',filter,'sqlite')
 assert.deepEqual(compiled.parameters,['a%'])
 const db=new DatabaseSync(':memory:')
 try{
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT, score INTEGER, note TEXT); INSERT INTO records VALUES(9223372036854775807,'Ada',15,'x'),(2,'Alice',5,NULL),(3,'Bob',15,NULL)")
  const stmt=db.prepare(compiled.sql);stmt.setReadBigInts(true)
  assert.deepEqual(stmt.all(...compiled.parameters.map(v=>typeof v==='boolean'?Number(v):v)).map(r=>r.id),[9223372036854775807n,2n])
  assert.equal(db.prepare(compiled.countSql).get(...compiled.parameters.map(v=>typeof v==='boolean'?Number(v):v))?.total,2)
 }finally{db.close()}
 const literal=compileSqlBrowsePredicate({text:"name = 'O''Reilly' OR name LIKE '%a%' ESCAPE '!'",parameters:[]})
 assert.deepEqual(literal.parameters,["O'Reilly",'%a%','!'])
 assert.throws(()=>compileMongoFilter(filter),/INVALID_FILTER/)
 const profile=normalizeBrowseProfile({connectionId:'saved',database:'main',entity:'records',kind:'sqlite'},{name:'Advanced',filterMode:'text',visualFilter:filter,mongo:{filter:'{}',projection:'{}',sort:'{}'},pageSize:100,view:'grid'})
 assert.deepEqual(profile.visualFilter.raw,raw)
})

test('Q3 SQL predicate rejects SQL commands, subqueries, unknown functions and malformed binding',()=>{
 for(const text of ['id = 1; DELETE FROM users','id IN (SELECT id FROM other)','id = sleep(2)','id = 1 -- comment','id=1 /* comment */','id = 1 UNION SELECT 2','id = @variable','id = 1 ORDER BY id','id = 1 OR','name = ?', 'id = 1 # comment','id = 1 AND id = 2;']){
  assert.throws(()=>compileSqlBrowsePredicate({text,parameters:[]}),/INVALID_FILTER/,text)
 }
 assert.throws(()=>compileSqlBrowsePredicate({text:'id=?',parameters:[9007199254740992]}),/INVALID_FILTER/)
 assert.throws(()=>compileSqlBrowsePredicate({text:'id=1',parameters:[1]}),/INVALID_FILTER/)
})

test('Q5 SQL data format streams exact integer, real, binary, NULL and escaped strings without SQL execution',async()=>{
 const row={id:{$dbexInteger:'9223372036854775807'},amount:{$dbexReal:'2'},payload:{$dbexBinary:'AP8='},note:"O'Reilly 中文\n\\N",missing:null}
 const columns=Object.keys(row)
 const sql=sqlInsertLine('main','records',columns,row,'sqlite')
 async function* chunks(){yield '-- data header\r\n';for(let i=0;i<sql.length;i+=3)yield sql.slice(i,i+3)}
 const decoded=[]
 for await(const record of sqlDataRecords(chunks()))decoded.push(record)
 assert.deepEqual(decoded,[row])
 const db=new DatabaseSync(':memory:')
 try{
  db.exec('CREATE TABLE records(id INTEGER,amount,payload,note,missing)')
  db.exec(sql)
  const stmt=db.prepare('SELECT *,typeof(amount) AS storage FROM records');stmt.setReadBigInts(true)
  const actual=stmt.get()!
  assert.equal(actual.id,9223372036854775807n);assert.equal(actual.storage,'real');assert.equal(actual.note,row.note)
  assert.deepEqual(Buffer.from(actual.payload as Uint8Array),Buffer.from([0,255]))
 }finally{db.close()}
 const multi=parseInsertStatement("INSERT INTO users (id,name) VALUES (1,'A'),(2,'B')")
 assert.deepEqual([...multi.rows].map(r=>[sqlFileValue(r.id),r.name]),[[1n,'A'],[2n,'B']])
 for(const text of ['DROP TABLE users;', 'INSERT INTO users (id) SELECT id FROM other;', "INSERT INTO users (id) VALUES (1); DELETE FROM users;", 'INSERT INTO users (id) VALUES (1); INSERT INTO other (id) VALUES (2);', 'INSERT INTO users VALUES (1);', 'INSERT INTO users (id) VALUES (NOW());', '/*!40101 SET x=1 */;']){
  await assert.rejects(async()=>{async function* source(){yield text}for await(const _ of sqlDataRecords(source())){}},/FILE_TRANSFER/,text)
 }
 assert.throws(()=>normalizeFileTransfer({direction:'export',database:'app',entity:'users',format:'sql',delimiter:','},'mongodb'),/FILE_TRANSFER/)
})

test('Q5 XLSX streaming export keeps wide numbers and literal formula-like text; sheet preview uses existing file identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-xlsx-test-'))
 try{
  const file=join(dir,'export.xlsx'),columns=['id','amount','payload','note','empty','marker','literal']
  const source={id:{$dbexInteger:'9223372036854775807'},amount:'12345678901234567890.12345678',payload:{$dbexBinary:'AP8='},note:'=SUM(1,2)',empty:null,marker:'\\N',literal:'_x0041_'}
  async function* rows(){yield source}
  await writeXlsxRecords(file,columns,rows(),new AbortController().signal,()=>{})
  const p=await inspectFile(file,'xlsx',',')
  assert.deepEqual(p.fields,columns);assert.equal(p.worksheet,'Data 1');assert.deepEqual(p.worksheets,['Data 1'])
  assert.deepEqual(p.sample,[{id:'9223372036854775807',amount:source.amount,payload:'base64:AP8=',note:source.note,empty:null,marker:'\\N',literal:'_x0041_'}])
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(file)
  assert.equal(workbook.getWorksheet(1)!.getCell('D2').type,ExcelJS.ValueType.String)
  assert.equal(workbook.getWorksheet(1)!.getCell('D2').value,'=SUM(1,2)')
  const imported=join(dir,'multi.xlsx'),external=new ExcelJS.Workbook()
  const one=external.addWorksheet('Customers'),two=external.addWorksheet('Second'),formula=external.addWorksheet('Formula')
  one.addRow(['id','name','date']);one.addRow([1,'Ada',new Date('2024-02-29T00:00:00Z')]);one.getCell('C2').numFmt='yyyy-mm-dd'
  two.addRow(['id','name','date']);two.addRow([2,'中文',new Date('2025-01-02T12:34:56Z')]);two.getCell('C2').numFmt='yyyy-mm-dd hh:mm:ss'
  formula.addRow(['id','name','date']);formula.addRow([3,{formula:'1+1',result:2},null])
  await external.xlsx.writeFile(imported)
  const preview=await inspectFile(imported,'xlsx',',','utf-8','Second')
  assert.deepEqual(preview.worksheets,['Customers','Second','Formula'])
  assert.deepEqual(preview.sample,[{id:2,name:'中文',date:'2025-01-02 12:34:56'}])
  await assert.rejects(inspectFile(imported,'xlsx',',','utf-8','Formula'),/公式/)
  const handle=await open(imported,'r')
  try{
   const all=[]
   await assert.rejects(async()=>{for await(const record of readFileRecords(handle,'xlsx',',',undefined,undefined,'utf-8','*'))all.push(record)},/公式/)
   assert.deepEqual(all,[{id:1,name:'Ada',date:'2024-02-29'},{id:2,name:'中文',date:'2025-01-02 12:34:56'}])
  }finally{await handle.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})


test('Q5 XLSX preview can move off an invalid first sheet and rejects incompatible all-sheet headers before yielding records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-xlsx-preview-')),service=new FileTransferService()
 try{
  const file=join(dir,'mixed.xlsx'),workbook=new ExcelJS.Workbook()
  const bad=workbook.addWorksheet('Summary'),good=workbook.addWorksheet('Records'),other=workbook.addWorksheet('Other')
  bad.addRow(['name']);bad.addRow([{formula:'1+1',result:2}])
  good.addRow(['name']);good.addRow(['Ada'])
  other.addRow(['different']);other.addRow(['Grace'])
  await workbook.xlsx.writeFile(file)
  const preview=await service.pick(1,'session',file,'xlsx',',')
  assert.match(preview.previewError||'',/公式/);assert.deepEqual(preview.fields,[])
  assert.throws(()=>service.importPreview(1,'session',{direction:'import',database:'main',entity:'records',format:'xlsx',delimiter:',',token:preview.token}),/公式/)
  const selected=await service.previewSheet(1,'session',preview.token,'Records')
  assert.equal(selected.previewError,undefined);assert.deepEqual(selected.sample,[{name:'Ada'}])
  const all=await service.previewSheet(1,'session',selected.token,'*')
  assert.match(all.previewError||'',/表头不一致/);assert.deepEqual(all.fields,[])
  assert.throws(()=>service.importPreview(1,'session',{direction:'import',database:'main',entity:'records',format:'xlsx',delimiter:',',token:all.token}),/表头不一致/)
 }finally{await service.closeAll();await rm(dir,{recursive:true,force:true})}
})
