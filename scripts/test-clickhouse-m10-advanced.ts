import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createClient} from '@clickhouse/client'
import {SessionManager} from '../src/main/connections/manager'
import {createTransport} from '../src/main/connections/transport'
import {newConnectionConfig} from '../src/shared/connection-form'
import type {ClickHouseChange} from '../src/shared/types'
const port=Number(process.env.DBEX_CH_PORT),password=process.env.DBEX_CH_PASSWORD
if(!Number.isInteger(port)||!password)throw new Error('Missing isolated fixture')
const config={...newConnectionConfig('clickhouse'),name:'ClickHouse M10 advanced fixture',host:'127.0.0.1',port,username:'dbex',password}
const admin=createClient({url:'http://127.0.0.1:'+port,username:'dbex',password})
const manager=new SessionManager(),transport=await createTransport({ssh:config.ssh})
const database='dbex_m10_advanced_'+randomUUID().replaceAll('-','')
const target={database,entity:'lightweight'}
const select=async(id:string,sql:string)=>manager.execute(id,{action:'clickhouse.query',database,sql})
async function poll(fn:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,250))}throw new Error('Isolated task timed out')}
try{
 await admin.command({query:'CREATE DATABASE '+database})
 await admin.command({query:'CREATE TABLE '+database+'.lightweight (id UInt64, note String) ENGINE=MergeTree ORDER BY id SETTINGS enable_block_number_column=1,enable_block_offset_column=1'})
 await admin.command({query:"INSERT INTO "+database+".lightweight VALUES (1,'one'),(2,'two')"})
 await admin.command({query:'CREATE TABLE '+database+'.plain (id UInt64,note String) ENGINE=MergeTree ORDER BY id'})
 const endpoint=await transport.socks()
 const session=await manager.connect({...config,proxy:{enabled:true,type:'socks5',...endpoint}})
 const change:ClickHouseChange={kind:'update',field:'id',match:'1',column:'note',value:'new',lightweight:true}
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change,confirmed:true}),/READ_ONLY/)
 const preview=await manager.execute(session.id,{action:'clickhouse.mutationPreview',...target,change})
 assert.equal(preview.totalRows,'1')
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.mutationPreview',database,entity:'plain',change}),/block number and offset/)
 await manager.setWriteAccess(session.id,true)
 await assert.rejects(()=>manager.execute(session.id,{action:'clickhouse.change',...target,change}),/CONFIRMATION_REQUIRED/)
 const submitted=await manager.execute(session.id,{action:'clickhouse.change',...target,change,confirmed:true})
 assert(submitted.queryId);assert.equal(submitted.affectedRows,undefined)
 await poll(async()=> (await select(session.id,'SELECT note FROM lightweight WHERE id=1')).rows[0]?.note==='new')
 const remove:ClickHouseChange={kind:'delete',field:'id',match:'2',lightweight:true}
 assert.equal((await manager.execute(session.id,{action:'clickhouse.mutationPreview',...target,change:remove})).totalRows,'1')
 await manager.execute(session.id,{action:'clickhouse.change',...target,change:remove,confirmed:true})
 await poll(async()=> (await select(session.id,'SELECT count() AS n FROM lightweight WHERE id=2')).rows[0]?.n==='0')
 assert.equal((await select(session.id,'SELECT count() AS n FROM lightweight')).rows[0]?.n,'1')
 const topology=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'topology'})
 assert(topology.columns.includes('cluster'));assert(topology.columns.includes('shard_num'))
 assert(!topology.columns.includes('user'))
 const queue=await manager.execute(session.id,{action:'clickhouse.management',...target,view:'replicationQueue'})
 assert.equal(queue.rows.length,0)
 assert(queue.columns.includes('new_part_name'))
 if(process.env.DBEX_CH_REPLICATION==='1'){
  const zpath='/dbex-m10/'+database+'/replicas'
  await admin.command({query:"CREATE TABLE "+database+".replica_a (id UInt64) ENGINE=ReplicatedMergeTree('"+zpath+"','a') ORDER BY id"})
  await admin.command({query:"CREATE TABLE "+database+".replica_b (id UInt64) ENGINE=ReplicatedMergeTree('"+zpath+"','b') ORDER BY id"})
  await admin.command({query:'INSERT INTO '+database+'.replica_a VALUES (7)'})
  await poll(async()=> (await select(session.id,'SELECT count() AS n FROM replica_b')).rows[0]?.n==='1')
  const reports=await manager.execute(session.id,{action:'clickhouse.management',database,entity:'replica_a',view:'replicas'})
  assert.equal(reports.rows[0]?.total_replicas,'2');assert.equal(reports.rows[0]?.active_replicas,'2')
  const repQueue=await manager.execute(session.id,{action:'clickhouse.management',database,entity:'replica_a',view:'replicationQueue'})
  assert(repQueue.columns.includes('num_tries'))
  assert(topology.rows.some(row=>row.cluster==='dbex_m10_cluster'))
  console.log('Keeper-backed two replica identities and configured cluster metadata passed (single server fixture)')
 }
 console.log('ClickHouse lightweight update/delete, typed scope, read-only protection, topology and replication queue passed')
}finally{await manager.closeAll();await transport.close();await admin.close()}
