import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SavedQueryStore} from '../src/main/storage/saved-queries'
import {portableQuery,readPortableQuery,querySummary,type QueryScope,type SavedQuery} from '../src/shared/saved-query'
import {seal,unseal} from '../src/main/storage/app-cipher'
test('named queries persist independently, preserve parameters, and reject stale/cross-scope changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-queries-')),file=join(dir,'saved-queries.secure.json')
 const scope:QueryScope={connectionId:'one',kind:'mysql',database:'app'}
 const persistence={async read(){try{return unseal<SavedQuery[]>(JSON.parse(await readFile(file,'utf8')).encrypted)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}},async write(items:SavedQuery[]){await writeFile(file,JSON.stringify({version:1,encrypted:seal(items)}),{mode:0o600})}}
 try{
  const store=new SavedQueryStore(persistence)
  const saved=await store.save(scope,{draft:{name:'Find',mode:'sql',text:'SELECT * FROM users WHERE id = ?',parameters:'["9223372036854775807"]'}})
  assert.equal((await new SavedQueryStore(persistence).get(scope,saved.id)).parameters,'["9223372036854775807"]')
  assert.ok(!(await readFile(file,'utf8')).includes('SELECT * FROM'))
  const renamed=await store.save(scope,{id:saved.id,revision:saved.revision,draft:{...saved,name:'Renamed'}})
  assert.equal(renamed.createdAt,saved.createdAt)
  assert.notEqual(renamed.revision,saved.revision)
  await assert.rejects(()=>store.save(scope,{id:saved.id,revision:saved.revision,draft:{...saved,name:'stale'}}))
  await assert.rejects(()=>store.get({...scope,connectionId:'two'},saved.id))
  await assert.rejects(()=>store.remove({...scope,database:'other'},saved.id,renamed.revision))
  const duplicate=await store.copy(scope,saved.id)
  assert.equal(duplicate.name,'Renamed (2)');assert.notEqual(duplicate.id,saved.id)
  const imported=await store.import(scope,readPortableQuery('mysql','sql',JSON.stringify(portableQuery(renamed)),'test',false))
  assert.equal(imported.name,'Renamed (3)');assert.equal(imported.parameters,saved.parameters)
  assert(!JSON.stringify(portableQuery(saved)).includes('connectionId'))
  await store.remove(scope,duplicate.id,duplicate.revision)
  assert.equal((await store.list(scope,'sql')).length,2)
  assert.equal((await store.list({...scope,connectionId:'two'},'sql')).length,0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('saved query library exceeds old 100 favorite limit and keeps history storage independent',async()=>{
 let values:SavedQuery[]=[]
 const store=new SavedQueryStore({read:async()=>values,write:async next=>{values=next}})
 const scope:QueryScope={connectionId:'mongo',kind:'mongodb',database:'app'}
 const text=JSON.stringify({filter:'{"id":{"$numberLong":"9223372036854775807"}}',projection:'{}',sort:'{}'})
 await Promise.all(Array.from({length:105},(_,i)=>store.save(scope,{draft:{name:'Query '+i,mode:'mongo-find',text,entity:'users'}})))
 const rows=await store.list(scope,'mongo-find')
 assert.equal(rows.length,105)
 assert.equal((await store.get(scope,rows[0]!.id)).text,text)
 assert.equal(querySummary(values[0]!).bytes,new TextEncoder().encode(text).length)
 assert.equal((await store.list(scope,'mongo-aggregation')).length,0)
 assert.throws(()=>readPortableQuery('mysql','sql',JSON.stringify(portableQuery(values[0]!)),'test',false))
 const sql=readPortableQuery('sqlite','sql','SELECT ?','Imported',true)
 assert.equal(sql.text,'SELECT ?');assert.equal(sql.parameters,'[]')
})
