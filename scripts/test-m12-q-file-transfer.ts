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

}finally{await sessions.closeAll();await service.closeAll();s.close();t.close();await rm(dir,{recursive:true,force:true})}
