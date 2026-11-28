import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {newConnectionConfig} from '../src/shared/connection-form'
import {MigrationService} from '../src/main/migration/service'
import {MigrationHistory} from '../src/main/migration/history'
import {migrationRemaining,type MigrationJob,type MigrationRequest} from '../src/shared/migration'
const dir=await mkdtemp(join(tmpdir(),'dbex-m12-final-')),a=join(dir,'source.sqlite'),b=join(dir,'target.sqlite')
const s=new DatabaseSync(a),t=new DatabaseSync(b),owner=88
const configs={source:{...newConnectionConfig('sqlite'),name:'Source',filePath:a},target:{...newConnectionConfig('sqlite'),name:'Target',filePath:b}}
let persisted:MigrationJob[]=[]
const io={async load(){return structuredClone(persisted)},async save(jobs:MigrationJob[]){persisted=structuredClone(jobs)}}
const make=async()=>{const h=new MigrationHistory(io),service=new MigrationService(id=>configs[id as keyof typeof configs],undefined,resolve('dist-electron/sqlite-worker.cjs'),h);await service.init();return service}
let service=await make()
async function finish(id:string){
 for(let i=0;i<1000;i++){
  const job=service.list(owner).find(j=>j.id===id)!
  if(job.state!=='running'&&persisted.find(j=>j.id===id)?.state!=='running'){await new Promise(r=>setTimeout(r,30));return job}
  await new Promise(r=>setTimeout(r,20))
 }
 throw Error('Migration timeout')
}
async function execute(request:MigrationRequest){
 const plan=await service.preview(owner,request)
 assert(plan.steps.every(s=>s.executable),JSON.stringify(plan.steps))
 return finish(service.start(owner,plan.id,plan.steps.map(s=>s.id)).id)
}
try{
 s.exec('CREATE TABLE first(id INTEGER PRIMARY KEY,amount TEXT,payload BLOB); CREATE TABLE second(id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE third(id INTEGER PRIMARY KEY,n INTEGER); CREATE TABLE append_fields(id INTEGER PRIMARY KEY, note TEXT)')
 t.exec('CREATE TABLE renamed(k TEXT PRIMARY KEY, precise TEXT, binary BLOB) WITHOUT ROWID; CREATE TABLE second_copy(k INTEGER PRIMARY KEY, description TEXT); CREATE TABLE third_copy(k INTEGER PRIMARY KEY, n INTEGER); CREATE TABLE append_fields(id INTEGER PRIMARY KEY)')
 s.prepare('INSERT INTO first VALUES(?,?,?)').run(9223372036854775807n,'12345678901234567890.12345678',Buffer.from([0,255,128]))
 s.exec("INSERT INTO second VALUES(1,'first'),(2,'second'); INSERT INTO third VALUES(3,8); INSERT INTO append_fields VALUES(1,'added field')")
 t.exec("INSERT INTO second_copy VALUES(2,'conflict')")
 const source={connectionId:'source',database:'main'},target={connectionId:'target',database:'main'}
 const req:MigrationRequest={source,target,mode:'data',objects:['first','second','third'],mappings:[
  {source:'first',target:'renamed',fields:[{source:'id',target:'k',conversion:'text'},{source:'amount',target:'precise',conversion:'auto'},{source:'payload',target:'binary',conversion:'auto'}]},
  {source:'second',target:'second_copy',fields:[{source:'id',target:'k',conversion:'auto'},{source:'note',target:'description',conversion:'auto'}],predicate:{text:'id >= ? AND note IS NOT NULL',parameters:[1]}},
  {source:'third',target:'third_copy',fields:[{source:'id',target:'k',conversion:'auto'},{source:'n',target:'n',conversion:'auto'}]}
 ]}
 const failed=await execute(req)
 assert.equal(failed.state,'failed',JSON.stringify(failed));assert.deepEqual(failed.completed,['first'])
 assert.deepEqual(migrationRemaining(failed),['second','third'])
 const actual=t.prepare('SELECT * FROM renamed').get()!
 assert.equal(actual.k,'9223372036854775807');assert.equal(actual.precise,'12345678901234567890.12345678');assert.deepEqual(Buffer.from(actual.binary as Uint8Array),Buffer.from([0,255,128]))
 assert.equal(t.prepare('SELECT count(*) n FROM second_copy').get()?.n,1)
 assert.equal(t.prepare('SELECT count(*) n FROM third_copy').get()?.n,0)
 await service.closeAll();service=await make()
 await assert.rejects(service.resumePreview(owner,failed.id,{...req,policy:'upsert'}),/MIGRATION_STALE/)
 t.exec('DELETE FROM second_copy WHERE k=2')
 const resumed=await service.resumePreview(owner,failed.id,req)
 assert.deepEqual(resumed.steps.map(s=>s.name),['second','third'])
 const done=await finish(service.start(owner,resumed.id,resumed.steps.map(s=>s.id)).id)
 assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.rowsCommitted,3)
 assert.deepEqual(migrationRemaining(service.list(owner).find(j=>j.id===failed.id)!),[])
 await assert.rejects(service.resumePreview(owner,failed.id,req),/MIGRATION_STALE/)
 assert.equal(t.prepare('SELECT count(*) n FROM renamed').get()?.n,1)
 assert.deepEqual(t.prepare('SELECT description FROM second_copy ORDER BY k').all().map(r=>r.description),['first','second'])
 assert.equal(t.prepare('SELECT n FROM third_copy WHERE k=3').get()?.n,8)
 const combined=await execute({source,target,mode:'structure-data',objects:['append_fields']})
 assert.equal(combined.state,'completed',JSON.stringify(combined));assert.deepEqual(combined.created,['append_fields']);assert.equal(t.prepare('SELECT note FROM append_fields').get()?.note,'added field')
 console.log('M12 final SQLite: renamed object/fields, exact typed mapping, bound predicate, rollback, durable checkpoint resume after service restart, additive structure+data passed')
}finally{await service.closeAll();s.close();t.close();await rm(dir,{recursive:true,force:true})}
