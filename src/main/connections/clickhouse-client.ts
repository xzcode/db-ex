import {createClient,type ClickHouseClient} from '@clickhouse/client'
import {Agent as HttpAgent} from 'node:http'
import {Agent as HttpsAgent} from 'node:https'
import {connect as connectTcp,isIP} from 'node:net'
import {connect as connectTls,checkServerIdentity,type ConnectionOptions} from 'node:tls'
import type {ConnectionConfig} from '../../shared/types'
import type {ConnectionTransport} from './transport'
export async function openClickHouseClients(config:ConnectionConfig,transport:ConnectionTransport,tls:ConnectionOptions){
  const forward=await transport.forward(config.host,config.port)
  const identity=config.tls.servername||config.host
  // Always use the established transport. Preserve the real HTTP Host and TLS
  // certificate identity rather than trusting the loopback forward address.
  const host=isIP(config.host)===6?'['+config.host+']':config.host
  const url=(config.tls.enabled?'https':'http')+'://'+host+':'+config.port
  const clients=new Set<ClickHouseClient>()
  function make(database:string,timeout?:number){
   // Each client owns its agent. Closing a database-specific query client
   // must not destroy sockets belonging to the persistent session.
   const agent=config.tls.enabled?new HttpsAgent({keepAlive:false,maxSockets:2}):new HttpAgent({keepAlive:false,maxSockets:2})
   if(config.tls.enabled){
    agent.createConnection=()=>connectTls({...tls,host:forward.host,port:forward.port,servername:isIP(identity)?undefined:identity,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>checkServerIdentity(identity,cert)})
   }else agent.createConnection=()=>connectTcp(forward.port,forward.host)
   const client=createClient({url,username:config.username||'default',password:config.password||'',database,request_timeout:timeout??Math.min(config.connectTimeoutMs||12000,25000),http_agent:agent,compression:{response:false,request:false}})
   clients.add(client)
   const close=client.close.bind(client)
   client.close=async()=>{try{await close()}finally{agent.destroy();clients.delete(client)}}
   return client
  }
  return {make,close:async()=>{await Promise.allSettled([...clients].map(c=>c.close()))}}
}
