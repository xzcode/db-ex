import { MongoClient,type MongoClientOptions } from 'mongodb'
import { checkServerIdentity,createSecureContext,type ConnectionOptions } from 'node:tls'
import { isIP } from 'node:net'
import { mongoDirectConnection,mongoUriTlsEnabled } from './mongo-topology'
import type {ConnectionConfig} from '../../shared/types'
import type {ConnectionTransport} from './transport'
function hostForUri(host:string):string{return isIP(host)===6?'['+host+']':host}
export async function openMongoClient(config:ConnectionConfig,transport:ConnectionTransport,tls:ConnectionOptions){
    const nodes=config.nodes?.length?config.nodes:[{host:config.host,port:config.port}]
    const uri=config.uri?.trim()||'mongodb://'+nodes.map(node=>hostForUri(node.host)+':'+node.port).join(',')+'/'
    const tlsActive=config.tls.enabled||mongoUriTlsEnabled(config.uri)
    const options:MongoClientOptions={
      ...(config.uri?{}:{auth:config.username?{username:config.username,password:config.password||''}:undefined,authSource:config.authSource||'admin',dbName:config.database||undefined}),
      serverSelectionTimeoutMS:config.connectTimeoutMs,connectTimeoutMS:config.connectTimeoutMs,socketTimeoutMS:30000,maxPoolSize:5,minPoolSize:0,waitQueueTimeoutMS:10000,
      retryWrites:false,retryReads:true,promoteValues:true,
      ...(config.mongoReplicaSet?{replicaSet:config.mongoReplicaSet}:{}),
      ...(mongoDirectConnection(config)===undefined?{}:{directConnection:mongoDirectConnection(config)}),
      // mongodb v6 rejects minVersion as a MongoClient option. A Node
      // secure context preserves CA, mTLS material and the minimum protocol.
      ...(tlsActive?{tls:true,rejectUnauthorized:true,secureContext:createSecureContext({ca:tls.ca,cert:tls.cert,key:tls.key,minVersion:'TLSv1.2'})}:{}),
      ...(tlsActive&&config.tls.servername?{...(isIP(config.tls.servername)?{}:{servername:config.tls.servername}),checkServerIdentity:(_host:string,certificate:Parameters<typeof checkServerIdentity>[1])=>checkServerIdentity(config.tls.servername!,certificate)}:{})
    }
    if(config.ssh.enabled||config.proxy?.enabled){
      const proxy=await transport.socks()
      Object.assign(options,{proxyHost:proxy.host,proxyPort:proxy.port,proxyUsername:proxy.username,proxyPassword:proxy.password})
    }
    const client=new MongoClient(uri,options)
    try{
      await client.connect()
      // Require a real authenticated operation, not just a topology handshake.
      await client.db(config.database||'admin').command({ping:1},{timeoutMS:config.connectTimeoutMs})
      return client
    }catch(error){await client.close().catch(()=>{});throw error}
}
