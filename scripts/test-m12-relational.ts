import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'
import {createTransport} from '../src/main/connections/transport'
import {newConnectionConfig} from '../src/shared/connection-form'
import {MigrationService} from '../src/main/migration/service'
import {openMysqlClient} from '../src/main/connections/mysql-client'
import {loadConnectionTls} from '../src/main/connections/tls-material'
import type {ConnectionConfig} from '../src/shared/types'

const kind=process.env.DBEX_M11_ENGINE
const port=Number(process.env.DBEX_M11_PORT),password=process.env.DBEX_M11_PASSWORD
if(!['mysql','mariadb'].includes(kind||'')||!Number.isInteger(port)||port<1024||port>65535||!password||!process.env.DBEX_M11_TLS_DIR)throw new Error('Explicit isolated SQL-family fixture required')
const tlsDir=process.env.DBEX_M11_TLS_DIR
const config:ConnectionConfig={...newConnectionConfig(kind as 'mysql'|'mariadb'),name:'M12 isolated',host:'127.0.0.1',port,username:process.env.DBEX_M11_USERNAME||'root',password,
 tls:{enabled:true,servername:'localhost',caPath:join(tlsDir,'ca.pem'),certPath:join(tlsDir,'client.pem'),keyPath:join(tlsDir,'client.key')}}
const suffix=randomBytes(6).toString('hex'),source='dbex_m12_src_'+suffix,target='dbex_m12_dst_'+suffix
const route=await createTransport({ssh:config.ssh}),proxy=await route.socks()
const configs:Record<string,ConnectionConfig>={source:{...config,name:'M12 source through SOCKS',proxy:{enabled:true,type:'socks5',...proxy}},target:{...config,name:'M12 destination'}}
const service=new MigrationService(id=>{const c=configs[id];if(!c)throw Error('Unknown test connection');return c})
const seed=await openMysqlClient(config,route,await loadConnectionTls(config))
const q=(name:string)=>'`'+name+'`'
const table=(db:string,name:string)=>q(db)+'.'+q(name)
const query=(sql:string,params:unknown[]=[])=>seed.query(sql,params)
const request=(mode:'schema'|'data'|'structure-data',objects?:string[])=>({source:{connectionId:'source',database:source},target:{connectionId:'target',database:target},mode,objects})
const owner=41
async function finish(id:string){
 for(let i=0;i<1200;i++){
  const job=service.list(owner).find(j=>j.id===id)!
  if(job.state!=='running')return job
  await new Promise(r=>setTimeout(r,50))
 }
 throw Error('Migration job timeout')
}
async function run(mode:'schema'|'data'|'structure-data',names?:string[]){
 const plan=await service.preview(owner,request(mode,names))
 const steps=plan.steps.filter(s=>s.executable).map(s=>s.id)
 assert(steps.length,'Expected executable plan')
 return finish(service.start(owner,plan.id,steps).id)
}
try{
 await query('CREATE DATABASE '+q(source)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
 await query('CREATE DATABASE '+q(target)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
 const definition=' (id BIGINT UNSIGNED NOT NULL, amount DECIMAL(30,8) NOT NULL, payload VARBINARY(64), note VARCHAR(100) DEFAULT NULL, stamp TIMESTAMP(6) NULL DEFAULT NULL, PRIMARY KEY(id), KEY idx_note(note)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'
 await query('CREATE TABLE '+table(source,'items')+definition)
 await query('CREATE TABLE '+table(source,'safe_append')+' (id INT NOT NULL, label VARCHAR(100) DEFAULT NULL, PRIMARY KEY(id), KEY idx_label(label)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci')
 await query('CREATE TABLE '+table(target,'safe_append')+' (id INT NOT NULL, PRIMARY KEY(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci')
 await query('CREATE TABLE '+table(source,'danger')+' (id INT NOT NULL, PRIMARY KEY(id)) ENGINE=InnoDB')
 await query('CREATE TABLE '+table(target,'danger')+' (id BIGINT NOT NULL, PRIMARY KEY(id)) ENGINE=InnoDB')
 await query('CREATE TABLE '+table(target,'keep_me')+' (id INT NOT NULL) ENGINE=InnoDB')
 await query('CREATE TABLE '+table(source,'fk_child')+' (id INT NOT NULL, parent_id BIGINT UNSIGNED, PRIMARY KEY(id), FOREIGN KEY(parent_id) REFERENCES '+table(source,'items')+'(id)) ENGINE=InnoDB')
 const catalog=await service.catalog(owner,'source',source)
 assert(catalog.databases.includes(source)&&catalog.objects?.some(o=>o.name==='items'))
 await assert.rejects(()=>service.preview(owner,{...request('schema'),target:{connectionId:'target',database:source}}),/MIGRATION_SAME_TARGET/)
 const plan=await service.preview(owner,request('schema'))
 assert.equal(plan.steps.find(s=>s.name==='items')?.action,'create')
 assert.equal(plan.steps.find(s=>s.name==='safe_append')?.action,'alter')
 assert.equal(plan.steps.find(s=>s.name==='danger')?.executable,false)
 assert.equal(plan.steps.find(s=>s.name==='fk_child')?.executable,false)
 assert.equal(plan.steps.find(s=>s.name==='keep_me')?.action,'target-only')
 const allowed=plan.steps.filter(s=>s.executable).map(s=>s.id)
 assert.throws(()=>service.confirmation(owner+1,plan.id,allowed),/MIGRATION_STALE/)
 assert.throws(()=>service.confirmation(owner,plan.id,[plan.steps.find(s=>s.name==='danger')!.id]),/MIGRATION_INPUT/)
 const structure=await finish(service.start(owner,plan.id,allowed).id)
 assert.equal(structure.state,'completed',structure.error)
 assert.deepEqual(structure.completed,['items','safe_append'])
 assert.throws(()=>service.start(owner,plan.id,allowed),/MIGRATION_STALE/)
 assert.equal((await service.preview(owner,request('schema',['items','safe_append']))).steps.every(s=>s.action==='same'),true)
 console.log('M12 real structure compare/create/add-column/add-index; destructive and foreign-key changes manual; replay/owner guards passed')

 await query("SET SESSION time_zone='+00:00'")
 const total=12000
 await seed.beginTransaction()
 for(let start=1;start<=total;start+=400){
  const rows=Array.from({length:Math.min(400,total-start+1)},(_,i)=>[String(start+i),'1234567890123456789012.12345678',Buffer.from([0,255,128,(start+i)%256]),'中文 data','2025-01-02 03:04:05.123456'])
  await seed.execute('INSERT INTO '+table(source,'items')+' (id,amount,payload,note,stamp) VALUES '+rows.map(()=>'(?,?,?,?,?)').join(','),rows.flat())
 }
 await seed.execute('INSERT INTO '+table(source,'items')+' VALUES (?,?,?,?,?)',['18446744073709551615','-1234567890123456789012.12345678',Buffer.from([255,0,1]),null,'2025-01-02 03:04:05.987654'])
 await seed.commit()
 const start=performance.now(),copied=await run('data',['items'])
 assert.equal(copied.state,'completed',copied.error)
 assert.equal(copied.rowsRead,total+1);assert.equal(copied.rowsCommitted,total+1);assert.equal(copied.rowsPending,0)
 const [values]=await query('SELECT CAST(id AS CHAR) id,CAST(amount AS CHAR) amount,HEX(payload) payload,note,stamp FROM '+table(target,'items')+' WHERE id=18446744073709551615') as [mysql.RowDataPacket[],unknown]
 assert.deepEqual({...values[0]},{id:'18446744073709551615',amount:'-1234567890123456789012.12345678',payload:'FF0001',note:null,stamp:'2025-01-02 03:04:05.987654'})
 const [count]=await query('SELECT COUNT(*) AS n FROM '+table(target,'items')) as [mysql.RowDataPacket[],unknown]
 assert.equal(Number(count[0]?.n),total+1)
 console.log('M12 real streamed data transfer '+JSON.stringify({engine:kind,rows:copied.rowsCommitted,bytes:copied.bytesRead,ms:Math.round(performance.now()-start)})+'; exact UInt64/DECIMAL/binary/NULL/microsecond timestamp preserved')

 // An existing high key must cause a failure rather than duplicate records.
 // Emptying the isolated test table here is fixture setup, never migration logic.
 await query('DELETE FROM '+table(target,'items'))
 await seed.execute('INSERT INTO '+table(target,'items')+' VALUES (?,?,?,?,?)',['18446744073709551615','1',Buffer.from([42]),'keep','2025-01-02 03:04:05'])
 const conflict=await run('data',['items'])
 assert.equal(conflict.state,'failed');assert.equal(conflict.rowsCommitted,0);assert.equal(conflict.rowsPending,0)
 const [after]=await query('SELECT COUNT(*) AS n FROM '+table(target,'items')) as [mysql.RowDataPacket[],unknown]
 assert.equal(Number(after[0]?.n),1)
 const stale=await service.preview(owner,request('data',['items']))
 await query('ALTER TABLE '+table(target,'items')+' ADD COLUMN changed INT NULL')
 const staleJob=await finish(service.start(owner,stale.id,stale.steps.filter(s=>s.executable).map(s=>s.id)).id)
 assert.equal(staleJob.state,'failed');assert.match(staleJob.error||'',/MIGRATION_STALE/);assert.equal(staleJob.rowsCommitted,0)
 await query('ALTER TABLE '+table(target,'items')+' DROP COLUMN changed')
 await query('CREATE TABLE '+table(source,'new_copy')+definition)
 await query('INSERT INTO '+table(source,'new_copy')+' SELECT * FROM '+table(source,'items')+' WHERE id=1')
 const combined=await run('structure-data',['new_copy']);assert.equal(combined.state,'completed',combined.error);assert.equal(combined.rowsCommitted,1)
 console.log('M12 rollback on duplicate, stale plan rejection and structure+data copy passed')
 // Hold a row lock on the disposable target. This forces the real copy to
 // wait in an INSERT, so cancellation is tested during actual server I/O.
 await query('DELETE FROM '+table(target,'items'))
 await query('INSERT INTO '+table(target,'items')+' (id,amount,note) VALUES (1,1,?)',['locked'])
 const blocked=await service.preview(owner,request('data',['items']))
 await seed.beginTransaction()
 try{
  await query('SELECT id FROM '+table(target,'items')+' WHERE id=1 FOR UPDATE')
  const active=service.start(owner,blocked.id,blocked.steps.filter(s=>s.executable).map(s=>s.id))
  let copying=false
  for(let i=0;i<500;i++){
   const job=service.list(owner).find(j=>j.id===active.id)!
   if(job.phase==='copying'&&job.rowsRead>=500){copying=true;break}
   if(job.state!=='running')throw Error('Copy did not reach blocked write: '+job.state+' '+job.error)
   await new Promise(r=>setTimeout(r,20))
  }
  assert(copying,'The fixture must reach an active write before cancellation')
  assert.throws(()=>service.cancel(owner+1,active.id),/MIGRATION_INPUT/)
  service.cancel(owner,active.id)
  const cancelled=await finish(active.id)
  assert.equal(cancelled.state,'cancelled',cancelled.error);assert.equal(cancelled.rowsCommitted,0);assert.equal(cancelled.rowsPending,0)
 }finally{await seed.rollback()}
 const [remaining]=await query('SELECT COUNT(*) AS n FROM '+table(target,'items')) as [mysql.RowDataPacket[],unknown]
 assert.equal(Number(remaining[0]?.n),1)
 console.log('M12 real cancellation during blocked target INSERT; current transaction rolled back, existing row preserved')

}finally{
 await service.closeAll()
 await seed.query('DROP DATABASE IF EXISTS '+q(source)).catch(()=>{})
 await seed.query('DROP DATABASE IF EXISTS '+q(target)).catch(()=>{})
 seed.destroy()
 await route.close()
}
