import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createClient} from '@clickhouse/client'
import {SessionManager} from '../src/main/connections/manager'
import {newConnectionConfig} from '../src/shared/connection-form'
const ports=[Number(process.env.DBEX_M11_CH_PORT_A),Number(process.env.DBEX_M11_CH_PORT_B)]
const password=process.env.DBEX_M11_CH_PASSWORD
const nodeB=process.env.DBEX_M11_CH_CONTAINER_B
if(!password||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||ports[0]===ports[1])throw new Error('Two isolated ClickHouse endpoints required')
if(nodeB&&!/^dbex-m11-cluster-[a-z0-9-]+-b$/.test(nodeB))throw new Error('Invalid isolated Docker fixture name')
const clients=ports.map(port=>createClient({url:'http://127.0.0.1:'+port,username:'dbex',password}))
const [a,b]=clients
const manager=new SessionManager()
const db='dbex_m11_replica_'+randomUUID().replaceAll('-',''),path='/dbex-m11/'+db
async function poll(fn:()=>Promise<boolean>,timeout=90000){const until=Date.now()+timeout;while(Date.now()<until){try{if(await fn())return}catch{}await new Promise(r=>setTimeout(r,500))}throw new Error('Isolated cluster did not converge')}
async function command(i:number,query:string){await clients[i]!.command({query})}
function docker(...args:string[]){const result=spawnSync('docker',args,{stdio:'ignore',timeout:60000});assert.equal(result.status,0,'Fixture Docker operation failed')}
try{
 for(const i of [0,1]){
  await command(i,'CREATE DATABASE '+db)
  await command(i,"CREATE TABLE "+db+".replicated (id UInt64,note String) ENGINE=ReplicatedMergeTree('"+path+"','"+(i?'b':'a')+"') ORDER BY id")
  await command(i,'CREATE TABLE '+db+'.local_shard (id UInt64) ENGINE=MergeTree ORDER BY id')
  await command(i,'INSERT INTO '+db+'.local_shard VALUES ('+(i+1)+')')
 }
 await command(0,'CREATE TABLE '+db+'.distributed (id UInt64) ENGINE=Distributed(dbex_m11_shards,'+db+',local_shard,rand())')
 const sessions=await Promise.all(ports.map(port=>manager.connect({...newConnectionConfig('clickhouse'),name:'M11 separate server',host:'127.0.0.1',port,username:'dbex',password})))
 const query=(i:number,sql:string)=>manager.execute(sessions[i]!.id,{action:'clickhouse.query',database:db,sql})
 const report=(i:number,view:'topology'|'replicas'|'replicationQueue')=>manager.execute(sessions[i]!.id,{action:'clickhouse.management',database:db,entity:'replicated',view})
 await command(0,"INSERT INTO "+db+".replicated VALUES (1,'replicated')")
 await poll(async()=> (await query(1,'SELECT count() AS n FROM replicated')).rows[0]?.n==='1')
 const replica=await report(0,'replicas')
 assert.equal(replica.rows[0]?.total_replicas,'2');assert.equal(replica.rows[0]?.active_replicas,'2')
 const topology=await report(0,'topology')
 const cluster=topology.rows.filter(r=>r.cluster==='dbex_m11_shards')
 assert.equal(cluster.length,2);assert.equal(new Set(cluster.map(r=>r.shard_num)).size,2)
 assert.equal(new Set(cluster.map(r=>r.host_name+':'+r.port)).size,2)
 assert.equal((await query(0,'SELECT sum(id) AS total FROM distributed')).rows[0]?.total,'3')
 assert((await report(0,'replicationQueue')).columns.includes('num_tries'))
 console.log('ClickHouse two distinct server processes: Keeper replication and cross-shard Distributed query passed')
 if(nodeB){
  docker('stop','--time','15',nodeB)
  await poll(async()=> (await report(0,'replicas')).rows[0]?.active_replicas==='1')
  await command(0,"INSERT INTO "+db+".replicated VALUES (2,'after-offline')")
  docker('start',nodeB)
  await poll(async()=> (await query(1,'SELECT count() AS n FROM replicated')).rows[0]?.n==='2')
  await poll(async()=> (await report(0,'replicas')).rows[0]?.active_replicas==='2')
  console.log('ClickHouse replica outage, queued replication and catch-up after restart passed')
 }
}finally{
 await manager.closeAll()
 await Promise.allSettled(clients.map(c=>c.close()))
}
