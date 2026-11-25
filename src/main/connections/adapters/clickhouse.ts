import {createClient,type ClickHouseClient} from '@clickhouse/client'
import {Agent as HttpAgent} from 'node:http'
import {Agent as HttpsAgent} from 'node:https'
import {connect as connectTcp,isIP} from 'node:net'
import {connect as connectTls,checkServerIdentity} from 'node:tls'
import {ClickHouseOperations} from '../../operations/clickhouse'
import {inspectClickHouseSql} from '../../operations/clickhouse-policy'
import type {ClickHouseOperation} from '../../../shared/types'
import type {DatabaseAdapter} from './types'

export const clickhouseAdapter:DatabaseAdapter={
 kind:'clickhouse',
 actions:['clickhouse.query','clickhouse.browse','clickhouse.structure','clickhouse.inspect','clickhouse.management','clickhouse.insert'],
 writes(input){return input.action==='clickhouse.insert'||input.action==='clickhouse.query'&&inspectClickHouseSql(input.sql).mode==='write'},
 async connect({config,transport,tls}){
  const forward=await transport.forward(config.host,config.port)
  const identity=config.tls.servername||config.host
  // Always use the established transport. Preserve the real HTTP Host and TLS
  // certificate identity rather than trusting the loopback forward address.
  const host=isIP(config.host)===6?'['+config.host+']':config.host
  const url=(config.tls.enabled?'https':'http')+'://'+host+':'+config.port
  const clients=new Set<ClickHouseClient>()
  function make(database:string){
   // Each client owns its agent. Closing a database-specific query client
   // must not destroy sockets belonging to the persistent session.
   const agent=config.tls.enabled?new HttpsAgent({keepAlive:false,maxSockets:2}):new HttpAgent({keepAlive:false,maxSockets:2})
   if(config.tls.enabled){
    agent.createConnection=()=>connectTls({...tls,host:forward.host,port:forward.port,servername:isIP(identity)?undefined:identity,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>checkServerIdentity(identity,cert)})
   }else agent.createConnection=()=>connectTcp(forward.port,forward.host)
   const client=createClient({url,username:config.username||'default',password:config.password||'',database,request_timeout:Math.min(config.connectTimeoutMs||12000,25000),http_agent:agent,compression:{response:false,request:false}})
   clients.add(client)
   const close=client.close.bind(client)
   client.close=async()=>{try{await close()}finally{agent.destroy();clients.delete(client)}}
   return client
  }
  const client=make(config.database||'default')
  try{
   const operations=new ClickHouseOperations(client,make)
   const version=await operations.version({writable:false,confirmed:false})
   if(!version||!/^\d+\.\d+/.test(version))throw new Error('INVALID_CONNECTION: ClickHouse')
   return {
    serverVersion:version,
    execute:(input,context)=>operations.execute(input as ClickHouseOperation,context),
    roots:context=>operations.roots(context),
    children:(database,_category,context,statistics)=>operations.children(database,context,statistics),
    async close(){await Promise.allSettled([...clients].map(c=>c.close()))}
   }
  }catch(error){await Promise.allSettled([...clients].map(c=>c.close()));throw error}
 },
 preview(database,entity,offset){return {action:'clickhouse.browse',database,entity,offset,limit:100}}
}
