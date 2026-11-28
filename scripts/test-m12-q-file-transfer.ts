import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {newConnectionConfig} from '../src/shared/connection-form'
import {SessionManager} from '../src/main/connections/manager'
import {FileTransferService} from '../src/main/file-transfer/service'
import {normalizeFileTransfer,type FileTransferRequest} from '../src/shared/file-transfer'

const dir=await mkdtemp(join(tmpdir(),'dbex-q5-'))
const a=join(dir,'source.sqlite'),b=join(dir,'target.sqlite')
const s=new DatabaseSync(a),t=new DatabaseSync(b)
const service=new FileTransferService(undefined,resolve('dist-electron/sqlite-worker.cjs'))
const config=(filePath:string)=>({...newConnectionConfig('sqlite'),name:'Q isolated fixture',filePath})
const owner=17,signal=new AbortController().signal
async function run(req:FileTransferRequest,path?:string,source=a){
 const id='q-fixture'
 const job=service.start(owner,id,normalizeFileTransfer(req,'sqlite'),path,work=>work(config(source),signal))
 for(let i=0;i<1800;i++){
  const x=service.list(owner)!
  assert.equal(x.id,job.id)
  if(x.state!=='running'){await new Promise(r=>setTimeout(r,50));return x}
  await new Promise(r=>setTimeout(r,50))
 }
 throw Error('File transfer timed out')
}
const sessions=new SessionManager(undefined,resolve('dist-electron/sqlite-worker.cjs'))
const base={database:'main',entity:'records',format:'jsonl' as const,delimiter:','}
const fields=['id','amount','payload','note']
const mapping=fields.map(source=>({source,target:source,conversion:'auto' as const}))
try{
 for(const db of [s,t])db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, amount, payload BLOB, note TEXT)')
 const insert=s.prepare('INSERT INTO records VALUES(?,?,?,?)')
 s.exec('BEGIN')
 for(let i=0;i<50000;i++)insert.run(i,i+.25,Buffer.from([0,255,i%256]),'中文\n"quoted" '+i)
 insert.run(9223372036854775807n,2,Buffer.from([255,0]),null)
 s.exec('COMMIT')
 // Explicit REAL in a column without affinity, to catch accidental integer conversion.
 s.exec('UPDATE records SET amount=CAST(2 AS REAL) WHERE id=9223372036854775807')
 const jsonl=join(dir,'records.jsonl')
 const start=performance.now()
 const exported=await run({...base,direction:'export'},jsonl)
 assert.equal(exported.state,'completed',JSON.stringify(exported));assert.equal(exported.committed,50001)
 const p=await service.pick(owner,'q-fixture',jsonl,'jsonl',',')
 assert.equal(p.sample.length,20);assert.deepEqual(p.fields,fields)
 const imported=await run({...base,direction:'import',token:p.token,mapping},undefined,b)
 assert.equal(imported.state,'completed',JSON.stringify(imported));assert.equal(imported.committed,50001)
 const select='SELECT id,amount,typeof(amount) AS storage,payload,note FROM records WHERE id=9223372036854775807'
 const sr=s.prepare(select),tr=t.prepare(select);sr.setReadBigInts(true);tr.setReadBigInts(true)
 assert.deepEqual(sr.get(),tr.get())
 assert.equal(t.prepare('SELECT COUNT(*) AS n FROM records').get()?.n,50001)
 console.log('Q5 SQLite JSONL round trip: 50001 rows, exact int64/BLOB/REAL/NULL, '+Math.round(performance.now()-start)+' ms; '+exported.bytes+' bytes')
 const conflict=await service.pick(owner,'q-fixture',jsonl,'jsonl',',')
 const failed=await run({...base,direction:'import',token:conflict.token,mapping},undefined,b)
 assert.equal(failed.state,'failed',JSON.stringify(failed));assert.equal(failed.committed,0)
 assert.equal(t.prepare('SELECT COUNT(*) AS n FROM records').get()?.n,50001)
 const csv=join(dir,'replace.csv')
 await writeFile(csv,'identifier;description\r\n1;"first\nline"\r\n2;"a ""quote"""\r\n')
 const preview=await service.pick(owner,'q-fixture',csv,'csv',';')
 const replaced=await run({...base,format:'csv',delimiter:';',direction:'import',token:preview.token,policy:'replace',mapping:[{source:'identifier',target:'id',conversion:'integer'},{source:'description',target:'note',conversion:'string'}]},undefined,b)
 assert.equal(replaced.state,'completed',JSON.stringify(replaced))
 assert.deepEqual(t.prepare('SELECT id,note FROM records ORDER BY id').all().map(x=>({...x})),[{id:1,note:'first\nline'},{id:2,note:'a "quote"'}])
 await writeFile(csv,'identifier;description\n1;updated\nnot-an-integer;bad\n3;new\n')
 const update=await service.pick(owner,'q-fixture',csv,'csv',';')
 const upsert=await run({...base,format:'csv',delimiter:';',direction:'import',token:update.token,policy:'upsert',skipInvalid:true,mapping:[{source:'identifier',target:'id',conversion:'integer'},{source:'description',target:'note',conversion:'string'}]},undefined,b)
 assert.equal(upsert.state,'completed',JSON.stringify(upsert));assert.equal(upsert.committed,2);assert.equal(upsert.skipped,1)
 assert.equal(t.prepare('SELECT note FROM records WHERE id=1').get()?.note,'updated')
 // A large conversion report contains all failures, not just the 200 UI rows.
 const bad=join(dir,'legacy.csv')
 const legacy='identifier;description\r\n4;中文\r\n'+Array.from({length:251},(_,i)=>'bad'+i+';invalid').join('\r\n')+'\r\n'
 await writeFile(bad,Buffer.concat([Buffer.from([255,254]),Buffer.from(legacy,'utf16le')]))
 const oldFile=await service.pick(owner,'q-fixture',bad,'csv',';','utf-16le')
 const manyErrors=await run({...base,format:'csv',delimiter:';',encoding:'utf-16le',direction:'import',token:oldFile.token,skipInvalid:true,mapping:[{source:'identifier',target:'id',conversion:'integer'},{source:'description',target:'note',conversion:'string'}]},undefined,b)
 assert.equal(manyErrors.state,'completed',JSON.stringify(manyErrors));assert.equal(manyErrors.skipped,251);assert.equal(manyErrors.committed,1);assert.equal(manyErrors.errors?.length,200);assert.equal(manyErrors.hasErrorReport,true)
 const report=join(dir,'conversion-errors.csv')
 await service.saveReport(owner,manyErrors.id,report)
 assert.equal((await readFile(report,'utf8')).trim().split(/\r?\n/).length,252)
 await assert.rejects(service.saveReport(owner+1,manyErrors.id,join(dir,'forbidden.csv')),/FILE_TRANSFER/)
 assert.equal(t.prepare('SELECT note FROM records WHERE id=4').get()?.note,'中文')
 console.log('Q5 UTF-16 CSV: 251 conversion errors, complete report exported, owner scope enforced')
 const existing=await run({...base,direction:'export'},jsonl)
 assert.equal(existing.state,'failed');assert.match(existing.error||'',/OUTPUT_EXISTS/)
 assert.equal((await readFile(jsonl,'utf8')).split('\n').length,50002)
 console.log('Q5 SQLite: conflict rollback, mapped CSV replacement, upsert with conversion-error reporting, non-clobber export passed')
 // Advanced SQL filter and SQL INSERT file export/import on disposable tables.
 for(const db of [s,t]){
  db.exec('CREATE TABLE extra_records(id INTEGER PRIMARY KEY, amount, payload BLOB, note TEXT)')
  db.exec('CREATE TABLE extra_excel(id INTEGER PRIMARY KEY, amount TEXT, payload BLOB, note TEXT)')
 }
 const extra=s.prepare('INSERT INTO extra_records VALUES(?,?,?,?)')
 extra.run(1,3,Buffer.from([0,255]),"O'Reilly 中文\\N\r\nline")
 extra.run(3,8,Buffer.from([3]),'excluded')
 extra.run(9223372036854775807n,2,Buffer.from([255,0]),null)
 s.exec('UPDATE extra_records SET amount=CAST(2 AS REAL) WHERE id=9223372036854775807')
 const sqlPath=join(dir,'extra.sql'),raw={join:'and' as const,groups:[],sort:[{field:'id',direction:-1 as const}],raw:{text:'id IN (1, 9223372036854775807) AND (note IS NULL OR note LIKE ?)',parameters:['O%']}}
 const sqlBase={...base,entity:'extra_records',format:'sql' as const}
 const sqlOut=await run({...sqlBase,direction:'export',filter:raw},sqlPath)
 assert.equal(sqlOut.state,'completed',JSON.stringify(sqlOut));assert.equal(sqlOut.committed,2)
 const sqlPreview=await service.pick(owner,'q-fixture',sqlPath,'sql',',')
 assert.deepEqual(sqlPreview.fields,fields)
 const sqlIn=await run({...sqlBase,direction:'import',token:sqlPreview.token,mapping},undefined,b)
 assert.equal(sqlIn.state,'completed',JSON.stringify(sqlIn));assert.equal(sqlIn.committed,2)
 const extraSelect='SELECT *,typeof(amount) AS storage FROM extra_records WHERE id IN (1,9223372036854775807) ORDER BY id'
 const extraSrc=s.prepare(extraSelect),extraDst=t.prepare(extraSelect);extraSrc.setReadBigInts(true);extraDst.setReadBigInts(true)
 assert.deepEqual(extraSrc.all(),extraDst.all());assert.equal(t.prepare('SELECT COUNT(*) AS n FROM extra_records').get()?.n,2)
 const badSql=join(dir,'malicious.sql')
 await writeFile(badSql,"INSERT INTO extra_records (id,amount,payload,note) VALUES (4,1,NULL,'ok');\n"+Array.from({length:20},(_,i)=>"INSERT INTO extra_records (id,amount,payload,note) VALUES ("+(10+i)+",1,NULL,'ok');").join('\n')+"\nDELETE FROM extra_records;")
 const badPreview=await service.pick(owner,'q-fixture',badSql,'sql',',')
 const badImport=await run({...sqlBase,direction:'import',token:badPreview.token,mapping},undefined,b)
 assert.equal(badImport.state,'failed',JSON.stringify(badImport));assert.equal(badImport.committed,0)
 assert.equal(t.prepare('SELECT COUNT(*) AS n FROM extra_records').get()?.n,2)
 console.log('Q3/Q5 SQLite: raw SQL predicate, exact SQL data file round trip, malicious trailing command rejected and transaction rolled back')
 const insertExcel=s.prepare('INSERT INTO extra_excel VALUES(?,?,?,?)')
 s.exec('BEGIN')
 for(let i=1;i<=1000;i++)insertExcel.run(i,'12345678901234567890.12345678',Buffer.from([i%256,255]),i===1?'=SUM(1,2)':'中文 '+i)
 insertExcel.run(9223372036854775807n,'0.000000000000000001',Buffer.from([0,255]),null)
 s.exec('COMMIT')
 const excelBase={...base,entity:'extra_excel',format:'xlsx' as const},xlsx=join(dir,'extra.xlsx')
 const excelOut=await run({...excelBase,direction:'export'},xlsx)
 assert.equal(excelOut.state,'completed',JSON.stringify(excelOut));assert.equal(excelOut.committed,1001)
 const excelPreview=await service.pick(owner,'q-fixture',xlsx,'xlsx',',')
 assert.deepEqual(excelPreview.worksheets,['Data 1']);assert.equal(excelPreview.worksheet,'Data 1')
 await assert.rejects(service.previewSheet(owner+1,'q-fixture',excelPreview.token,'Data 1'),/FILE_TRANSFER/)
 const chosen=await service.previewSheet(owner,'q-fixture',excelPreview.token,'*')
 assert.notEqual(chosen.token,excelPreview.token)
 assert.throws(()=>service.importPreview(owner,'q-fixture',{...excelBase,direction:'import',token:excelPreview.token}),/FILE_TRANSFER/)
 const excelMapping=fields.map(source=>({source,target:source,conversion:source==='id'?'integer' as const:source==='payload'?'binary' as const:'string' as const}))
 const excelIn=await run({...excelBase,direction:'import',token:chosen.token,worksheet:'*',mapping:excelMapping},undefined,b)
 assert.equal(excelIn.state,'completed',JSON.stringify(excelIn));assert.equal(excelIn.committed,1001)
 const excelSrc=s.prepare('SELECT * FROM extra_excel ORDER BY id'),excelDst=t.prepare('SELECT * FROM extra_excel ORDER BY id');excelSrc.setReadBigInts(true);excelDst.setReadBigInts(true)
 assert.deepEqual(excelSrc.all(),excelDst.all())
 console.log('Q5 SQLite: XLSX 1001-row field-mapped round trip, exact large keys/decimal text/BLOB/NULL, literal formula text, worksheet token ownership passed')
 const parquetBase={...base,format:'parquet' as const},parquet=join(dir,'records.parquet')
 const pqOut=await run({...parquetBase,direction:'export'},parquet)
 assert.equal(pqOut.state,'completed',JSON.stringify(pqOut));assert.equal(pqOut.committed,50001)
 const pqPreview=await service.pick(owner,'q-fixture',parquet,'parquet',',')
 assert.deepEqual(pqPreview.fields,fields)
 const pqIn=await run({...parquetBase,direction:'import',token:pqPreview.token,policy:'replace',mapping},undefined,b)
 assert.equal(pqIn.state,'completed',JSON.stringify(pqIn));assert.equal(pqIn.committed,50001)
 assert.deepEqual(sr.get(),tr.get())
 assert.equal(t.prepare('SELECT COUNT(*) AS n FROM records').get()?.n,50001)
 console.log('Q5 SQLite Parquet: 50001 rows, exact int64/dynamic REAL/BLOB/NULL')
 const original=await sessions.connect(config(a),'isolated-test')
 const running=sessions.executeQuery(original.id,{action:'mysql.query',database:'main',sql:'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) AS total FROM n'})
 // Install rejection observer before cancellation.
 const stopped=assert.rejects(running,/CANCELLED/)
 await new Promise(r=>setTimeout(r,200))
 assert.equal(sessions.cancelQuery(original.id),true)
 await stopped
 const next=await sessions.execute(original.id,{action:'mysql.query',database:'main',sql:'SELECT COUNT(*) AS n FROM records'})
 assert.equal(next.rows[0]?.n,'50001')
 assert.equal(sessions.info(original.id).id,original.id)
 console.log('Q4 SQLite: real read query cancelled; original session remains usable')
 const batch=await sessions.executeReadBatch(original.id,{database:'main',text:'SELECT ? AS n; SELECT COUNT(*) AS n FROM records;',parameters:['9223372036854775807'],limit:100})
 assert.equal(batch.total,2);assert.deepEqual(batch.items.map(i=>i.result.rows[0]?.n),['9223372036854775807','50001'])
 await assert.rejects(sessions.executeReadBatch(original.id,{database:'main',text:'SELECT 1; DELETE FROM records',parameters:[],limit:100}),/SQL_POLICY/)
 const partial=await sessions.executeReadBatch(original.id,{database:'main',text:'SELECT 1 AS n; SELECT * FROM no_such_q_table; SELECT 3 AS n',parameters:[],limit:100})
 assert.equal(partial.items.length,1);assert.equal(partial.failedAt,2)
 console.log('Q4 SQLite: read batch parameter binding, preflight rejection, partial result retention passed')
 s.exec('CREATE TABLE script_records(id INTEGER PRIMARY KEY, note TEXT)')
 const request={database:'main',text:'INSERT INTO script_records VALUES (?,?); SELECT * FROM script_records WHERE id=?; UPDATE script_records SET note=? WHERE id=?',parameters:[1,'original',1,'updated',1],limit:20}
 await assert.rejects(sessions.executeScriptBatch(original.id,request,true),/WRITE_CONFIRMATION_REQUIRED/)
 await sessions.setWriteAccess(original.id,true)
 await assert.rejects(sessions.executeScriptBatch(original.id,request,false),/WRITE_CONFIRMATION_REQUIRED/)
 await assert.rejects(sessions.executeScriptBatch(original.id,{...request,text:'INSERT INTO script_records VALUES(1,1); BEGIN',parameters:[]},true),/SQL_POLICY/)
 assert.equal(s.prepare('SELECT COUNT(*) n FROM script_records').get()?.n,0)
 const script=await sessions.executeScriptBatch(original.id,request,true)
 assert.equal(script.script,true);assert.equal(script.items.length,3);assert.equal(script.items[1]?.result.rows[0]?.note,'original')
 assert.equal(s.prepare('SELECT note FROM script_records WHERE id=1').get()?.note,'updated')
 const failedScript=await sessions.executeScriptBatch(original.id,{...request,text:"INSERT INTO script_records VALUES(2,'committed'); INSERT INTO script_records VALUES(2,'duplicate'); DELETE FROM script_records",parameters:[]},true)
 assert.equal(failedScript.items.length,1);assert.equal(failedScript.failedAt,2);assert.equal(failedScript.writeFailure,true)
 assert.equal(s.prepare('SELECT COUNT(*) n FROM script_records').get()?.n,2)
 const scriptRunning=sessions.executeScriptBatch(original.id,{...request,text:"INSERT INTO script_records VALUES(3,'first'); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) total FROM n; DELETE FROM script_records",parameters:[]},true)
 let observed=false
 for(let i=0;i<500;i++){
  try{if(s.prepare('SELECT id FROM script_records WHERE id=3').get()){observed=true;break}}
  catch(e){if(![5,6].includes(Number((e as {errcode?:number}).errcode)))throw e}
  await new Promise(r=>setTimeout(r,5))
 }
 assert(observed,'first statement committed')
 assert.equal(sessions.cancelQuery(original.id),true)
 const stoppedScript=await scriptRunning
 assert.match(stoppedScript.error||'',/CANCELLED/);assert(stoppedScript.items.length>=1&&stoppedScript.items.length<=2);assert.equal(stoppedScript.failedAt,stoppedScript.items.length+1)
 assert.equal(s.prepare('SELECT COUNT(*) n FROM script_records').get()?.n,3)
 assert.equal((await sessions.execute(original.id,{action:'mysql.query',database:'main',sql:'SELECT COUNT(*) n FROM script_records'})).rows[0]?.n,'3')
 console.log('Q4 SQLite mixed script: preflight/confirmation, ordered writes and reads, partial commit, stop at boundary and original-session reuse passed')


}finally{await sessions.closeAll();await service.closeAll();s.close();t.close();await rm(dir,{recursive:true,force:true})}

await import('./test-m12-final-sqlite')
