import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {ClickHouseTransferFormat} from '../src/shared/types'
import {createClient} from '@clickhouse/client'
import {SessionManager} from '../src/main/connections/manager'
import {createTransport} from '../src/main/connections/transport'
import {newConnectionConfig} from '../src/shared/connection-form'
import {createConnectionBackup,readConnectionBackup} from '../src/main/connections/backup'
import {adapterOperationWrites} from '../src/main/connections/adapters'
const port=Number(process.env.DBEX_CH_PORT),password=process.env.DBEX_CH_PASSWORD
if(!Number.isInteger(port)||!password)throw new Error('Missing isolated fixture')
const config={...newConnectionConfig('clickhouse'),name:'ClickHouse fixture',host:'127.0.0.1',port,username:'dbex',password}
const admin=createClient({url:'http://127.0.0.1:'+port,username:'dbex',password})
const manager=new SessionManager()
const transport=await createTransport({ssh:config.ssh})
const database='dbex_fixture_'+randomUUID().replaceAll('-',''),entity='items',target={database,entity}
const temp=await mkdtemp(join(tmpdir(),'dbex-ch-integration-'))
async function poll<T>(check:()=>Promise<T|undefined>):Promise<T>{
 const deadline=Date.now()+30000
 while(Date.now()<deadline){const value=await check();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,250))}
 throw new Error('ClickHouse isolated task did not reach expected state')
}
try{
 await admin.command({query:'CREATE DATABASE '+database})
 await admin.command({query:"CREATE TABLE "+database+".items (id UInt64, amount Decimal(38,8), note Nullable(String), tags Array(UInt64), at DateTime64(3), extra String DEFAULT '') ENGINE=MergeTree PARTITION BY id % 2 ORDER BY id"})
 await admin.command({query:"INSERT INTO "+database+".items VALUES (18446744073709551615,12345678901234567890.12345678,NULL,[18446744073709551615],'2026-01-01 12:34:56.789','a'),(2,1.23,'two',[2],'2026-01-02 00:00:00.001','b')"})
 await admin.command({query:'CREATE VIEW '+database+'.item_view AS SELECT id FROM '+database+'.items'})
 assert.equal(readConnectionBackup(createConnectionBackup([config]))[0]?.kind,'clickhouse')
 const endpoint=await transport.socks()
 const session=await manager.connect({...config,proxy:{enabled:true,type:'socks5',...endpoint}})
 console.log('ClickHouse actual server: '+session.serverVersion+' over authenticated SOCKS')
 assert.equal(session.writable,false);assert.equal(session.transaction,false)
 assert((await manager.roots(session.id)).some(n=>n.database===database))
 const nodes=await manager.children(session.id,database,undefined,true)
 assert(nodes.some(n=>n.entity===entity&&n.metrics?.some(m=>m.label==='存储引擎'&&m.value==='MergeTree')))
 assert(nodes.some(n=>n.entity==='item_view'&&n.kind==='view'&&n.readOnly))
 const structure=await manager.execute(session.id,{action:'clickhouse.structure',...target})
 assert(structure.rows.some(r=>r.name==='id'&&r.type==='UInt64'))
 const info=await manager.execute(session.id,{action:'clickhouse.inspect',...target})
 assert.match(info.inspection?.definition||'',/CREATE TABLE/)
 const query=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT id,amount,note,tags,at FROM items WHERE id={id:UInt64}',parameters:{id:'18446744073709551615'}})
 assert.equal(query.rows[0]?.id,'18446744073709551615')
 assert.equal(query.rows[0]?.amount,'12345678901234567890.12345678')
 assert.equal(query.rawRows?.[0]?.note,null)
 assert.match(query.rows[0]?.tags||'',/18446744073709551615/)
 assert.equal(query.columnTypes?.[0],'UInt64')
 assert(query.queryId)
 const first=await manager.execute(session.id,{action:'clickhouse.browse',...target,limit:1,sort:[{field:'id',direction:1}]})
 assert.equal(first.rows[0]?.id,'2');assert.equal(first.nextOffset,1)
 const second=await manager.execute(session.id,{action:'clickhouse.browse',...target,limit:1,offset:1,sort:[{field:'id',direction:1}]})
 assert.equal(second.rows[0]?.id,'18446744073709551615');assert.equal(second.nextOffset,undefined)
 const filtered=await manager.execute(session.id,{action:'clickhouse.browse',...target,filter:{field:'note',value:'two'}})
 assert.equal(filtered.rows[0]?.id,'2')
 await assert.rejects(()=>manager.execute(session.id,{action:'mysql.begin'}),/INVALID_OPERATION/)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT 1 SETTINGS readonly=0'}),/SQL_POLICY/)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.query',database,sql:'CREATE TABLE denied (id UInt64) ENGINE=MergeTree ORDER BY id',confirmed:true}),/READ_ONLY/)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.insert',...target,rows:[{id:'9'}],confirmed:true}),/READ_ONLY/)
 await manager.setWriteAccess(session.id,true)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.insert',...target,rows:[{id:'9'}]}),/CONFIRMATION_REQUIRED/)
 const ddl=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'CREATE TABLE copy_table (id UInt64, amount Decimal(38,8), note Nullable(String)) ENGINE=MergeTree ORDER BY id',confirmed:true})
 assert(ddl.queryId)
 const insert=await manager.execute(session.id,{action:'clickhouse.insert',database,entity:'copy_table',rows:[{id:'18446744073709551614',amount:'12345678901234567890.12345678',note:null}],confirmed:true})
 assert.equal(insert.affectedRows,1)
 const inserted=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT * FROM copy_table'})
 assert.equal(inserted.rows[0]?.id,'18446744073709551614');assert.equal(inserted.rows[0]?.amount,'12345678901234567890.12345678')
 assert.equal(inserted.rawRows?.[0]?.note,null)
 assert.equal(adapterOperationWrites('clickhouse',{action:'clickhouse.query',sql:'DROP TABLE copy_table'},true),true)
 const partitions=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'partitions',limit:1})
 assert.equal(partitions.rows.length,1);assert.equal(partitions.nextOffset,1)
 const partition2=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'partitions',limit:1,offset:1})
 assert.notEqual(partitions.rows[0]?.partition_id,partition2.rows[0]?.partition_id)
 assert.equal(partitions.rows[0]?.rows,'1');assert.equal(partition2.rows[0]?.rows,'1')
 assert.equal(partition2.nextOffset,undefined)
 const replicas=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'replicas'})
 assert.equal(replicas.rows.length,0)
 // Only the isolated fixture creates a mutation and flushes query logs.
 await admin.command({query:"ALTER TABLE "+database+".items UPDATE note='updated' WHERE id=2 SETTINGS mutations_sync=1"})
 const mutations=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'mutations'})
 assert(mutations.rows.some(r=>r.is_done==='1'&&r.parts_to_do==='0'&&r.command?.includes('updated')))
 const unrelated=await manager.execute(session.id,{action:'clickhouse.management',database,entity:'copy_table',view:'mutations'})
 assert.equal(unrelated.rows.length,0)
 await admin.command({query:'SYSTEM FLUSH LOGS'})
 const statistics=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'queries'})
 assert(statistics.rows.some(r=>r.outcome==='QueryFinish'&&Number(r.queries)>0))
 assert(!statistics.columns.includes('query')&&!statistics.columns.includes('user'))
 console.log('ClickHouse scoped partitions, mutation task status, local replica status and aggregate query log passed')
 const change={kind:'update',field:'id',match:'18446744073709551615',column:'note',value:'scoped update'} as const
 await manager.setWriteAccess(session.id,false)
 assert.equal((await manager.execute(session.id,{action:'clickhouse.mutationPreview',...target,change})).totalRows,'1')
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change,confirmed:true}),/READ_ONLY/)
 await manager.setWriteAccess(session.id,true)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change}),/CONFIRMATION_REQUIRED/)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change:{...change,column:'id'},confirmed:true}),/INVALID_INPUT/)
 const submitted=await manager.execute(session.id,{action:'clickhouse.change',...target,change,confirmed:true})
 assert.match(submitted.message||'',/已提交/);assert.equal(submitted.affectedRows,undefined)
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT note FROM items WHERE id={id:UInt64}',parameters:{id:change.match}});return r.rows[0]?.note==='scoped update'?true:undefined})
 const partitionId=partitions.rows[0]!.partition_id!
 await manager.execute(session.id,{action:'clickhouse.change',...target,change:{kind:'detachPartition',partitionId},confirmed:true})
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'partitions'});return !r.rows.some(p=>p.partition_id===partitionId)?true:undefined})
 await manager.execute(session.id,{action:'clickhouse.change',...target,change:{kind:'attachPartition',partitionId},confirmed:true})
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'partitions'});return r.rows.some(p=>p.partition_id===partitionId)?true:undefined})
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change:{kind:'dropPartition',partitionId:'nonexistent'},confirmed:true}),/INVALID_INPUT/)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change:{kind:'killMutation',mutationId:'nonexistent'},confirmed:true}),/INVALID_INPUT/)
 // Deterministically stuck mutation in the isolated fixture; cancel only its ID.
 await admin.command({query:"ALTER TABLE "+database+".items UPDATE note=toString(throwIf(id=2,'dbex test mutation')) WHERE id=2"})
 const stuck=await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'mutations'});return r.rows.find(x=>x.is_done==='0'&&x.command?.includes('dbex test mutation'))})
 await manager.execute(session.id,{action:'clickhouse.change',...target,change:{kind:'killMutation',mutationId:stuck.mutation_id!},confirmed:true})
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'mutations'});return !r.rows.some(x=>x.mutation_id===stuck.mutation_id&&x.is_done==='0')?true:undefined})
 const remove={kind:'delete',field:'id',match:'2'} as const
 assert.equal((await manager.execute(session.id,{action:'clickhouse.mutationPreview',...target,change:remove})).totalRows,'1')
 await manager.execute(session.id,{action:'clickhouse.change',...target,change:remove,confirmed:true})
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT count() AS n FROM items WHERE id=2'});return r.rows[0]?.n==='0'?true:undefined})
 for(const format of ['csv','jsonl','parquet'] as ClickHouseTransferFormat[]){
  const file=join(temp,'items.'+format),copy='copy_'+format
  await admin.command({query:'CREATE TABLE '+database+'.'+copy+' AS '+database+'.copy_table'})
  const exported=await manager.clickhouseTransfer(session.id,{database,entity:'copy_table',direction:'export',format},file)
  assert(exported.bytes>0)
  if(format==='parquet')assert.equal((await readFile(file)).subarray(0,4).toString(),'PAR1')
  await assert.rejects(()=>manager.clickhouseTransfer(session.id,{database,entity:'copy_table',direction:'export',format},file))
  await manager.setWriteAccess(session.id,false)
  await assert.rejects(()=>manager.clickhouseTransfer(session.id,{database,entity:copy,direction:'import',format},file),/READ_ONLY/)
  await manager.setWriteAccess(session.id,true)
  const imported=await manager.clickhouseTransfer(session.id,{database,entity:copy,direction:'import',format},file)
  assert.equal(imported.bytes,exported.bytes)
  const result=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT * FROM '+copy})
  assert.equal(result.rows[0]?.id,'18446744073709551614');assert.equal(result.rows[0]?.amount,'12345678901234567890.12345678');assert.equal(result.rawRows?.[0]?.note,null)
 }
 const backupTarget={database,entity:'copy_table'},file='m10_'+randomUUID()+'.zip'
 const backup=await manager.execute(session.id,{action:'clickhouse.change',...backupTarget,change:{kind:'backup',disk:'dbex_backups',file},confirmed:true})
 assert(backup.backupId)
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.backupStatus',...backupTarget,backupId:backup.backupId!});if(r.rows[0]?.status?.includes('FAILED'))throw new Error(r.rows[0]?.error||'Backup failed');return r.rows[0]?.status==='BACKUP_CREATED'?true:undefined})
 const restore=await manager.execute(session.id,{action:'clickhouse.change',...backupTarget,change:{kind:'restore',disk:'dbex_backups',file,newTable:'restored_m10'},confirmed:true})
 assert(restore.backupId)
 await poll(async()=>{const r=await manager.execute(session.id,{action:'clickhouse.backupStatus',...backupTarget,backupId:restore.backupId!});if(r.rows[0]?.status?.includes('FAILED'))throw new Error(r.rows[0]?.error||'Restore failed');return r.rows[0]?.status==='RESTORED'?true:undefined})
 const restored=await manager.execute(session.id,{action:'clickhouse.query',database,sql:'SELECT * FROM restored_m10'})
 assert.equal(restored.rows[0]?.id,'18446744073709551614')
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...backupTarget,change:{kind:'restore',disk:'dbex_backups',file,newTable:'restored_m10'},confirmed:true}),/INVALID_INPUT/)
 console.log('M10 ClickHouse confirmed update/delete, detach/attach, mutation cancellation, CSV/JSONL/Parquet roundtrip, async backup/restore passed')
 console.log('ClickHouse metadata, exact UInt64/Decimal, nested values, NULL, pagination, filtering, typed parameters, read-only protection and confirmed DDL/insert passed')
}finally{await manager.closeAll();await transport.close();await admin.close();await rm(temp,{recursive:true,force:true})}
