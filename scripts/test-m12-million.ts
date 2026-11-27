import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,readFile,writeFile,rename} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {performance} from 'node:perf_hooks'
import {MigrationService} from '../src/main/migration/service'
import {MigrationHistory} from '../src/main/migration/history'
import {seal,openStored} from '../src/main/storage/app-cipher'
import {newConnectionConfig} from '../src/shared/connection-form'
import type {ConnectionConfig} from '../src/shared/types'
import type {MigrationJob} from '../src/shared/migration'
const directory=await mkdtemp(join(tmpdir(),'dbex-m12-million-'))
const source=join(directory,'source.db'),target=join(directory,'target.db'),journal=join(directory,'history.json')
const configs:Record<string,ConnectionConfig>={source:{...newConnectionConfig('sqlite'),name:'Million row source fixture',filePath:source},target:{...newConnectionConfig('sqlite'),name:'Million row target fixture',filePath:target}}
const historyIO={
 async load(){try{const data=JSON.parse(await readFile(journal,'utf8'));return openStored<MigrationJob[]>(data.encrypted,()=>{throw Error('Legacy format not supported in fixture')})}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}},
 async save(jobs:MigrationJob[]){const tmp=journal+'.tmp';await writeFile(tmp,JSON.stringify({encrypted:seal(jobs)}),{mode:0o600});await rename(tmp,journal)}
}
const history=new MigrationHistory(historyIO)
const service=new MigrationService(id=>configs[id]!,undefined,resolve('dist-electron/sqlite-worker.cjs'),history)
const a=new DatabaseSync(source),b=new DatabaseSync(target)
try{
 a.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT, payload BLOB); WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<1000000) INSERT INTO records SELECT i,printf('row-%d',i),x'00ff80' FROM seq;")
 await service.init()
 const request={source:{connectionId:'source',database:'main'},target:{connectionId:'target',database:'main'},mode:'structure-data',objects:['records']}
 const plan=await service.preview(1,request)
 assert.equal(plan.steps.length,1);assert(plan.steps[0]!.executable)
 const start=performance.now(),job=service.start(1,plan.id,[plan.steps[0]!.id])
 let outcome:MigrationJob|undefined
 for(let i=0;i<2400;i++){
  outcome=service.list(1).find(j=>j.id===job.id)
  if(outcome?.phase==='finished'&&outcome.state!=='running')break
  await new Promise(r=>setTimeout(r,50))
 }
 assert.equal(outcome?.state,'completed',JSON.stringify(outcome));assert.equal(outcome?.rowsCommitted,1000000)
 const check=(db:DatabaseSync)=>db.prepare('SELECT count(*) AS n,sum(id) AS sum_id,min(label) AS min_label,max(label) AS max_label,sum(length(payload)) AS bytes,sum(CASE WHEN payload=x\'00ff80\' THEN 1 ELSE 0 END) AS matched FROM records').get()
 assert.deepEqual(check(a),check(b));assert.equal(check(b)?.n,1000000)
 const elapsed=Math.round(performance.now()-start)
 await service.closeAll()
 const recovered=new MigrationHistory(historyIO);await recovered.init()
 assert.equal(recovered.list()[0]?.state,'completed');assert.equal(recovered.list()[0]?.rowsCommitted,1000000)
 const raw=await readFile(journal,'utf8');assert(!raw.includes('Million row source fixture'));assert(!raw.includes('records'))
 console.log('M12 SQLite million-row copy and encrypted persistent task metadata: '+JSON.stringify({rows:outcome.rowsCommitted,ms:elapsed,rowsPerSecond:Math.round(1000000000/elapsed),bytes:outcome.bytesRead}))
}finally{await service.closeAll();a.close();b.close();await rm(directory,{recursive:true,force:true})}
