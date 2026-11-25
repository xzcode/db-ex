import { MongoClient,type MongoClientOptions } from 'mongodb'
import { checkServerIdentity } from 'node:tls'
import { isIP } from 'node:net'
import type { MongoOperation } from '../../../shared/types'
import { mongoCategory,mongoCategoryNodes,mongoCatalogNodes,type MongoCatalogEntry } from '../../../shared/mongo-catalog'
import { MongoOperations } from '../../operations/mongodb'
import { describeMongoConnectionError } from '../mongo-diagnostics'
import { mongoDirectConnection,mongoUriTlsEnabled } from '../mongo-topology'
import type { DatabaseAdapter,OperationAction } from './types'

const actions=['mongo.find','mongo.createDatabase','mongo.dropDatabase','mongo.count','mongo.aggregate','mongo.insert','mongo.replace','mongo.delete','mongo.indexes','mongo.inspect','mongo.createIndex','mongo.dropIndex'] as const satisfies readonly OperationAction[]
function hostForUri(host:string):string{return isIP(host)===6?'['+host+']':host}
export const mongoAdapter:DatabaseAdapter={
  kind:'mongodb',actions,connectionError:describeMongoConnectionError,
  writes(input){return ['mongo.createDatabase','mongo.dropDatabase','mongo.insert','mongo.replace','mongo.delete','mongo.createIndex','mongo.dropIndex'].includes(input.action)},
  async connect({config,transport,tls}){
    const nodes=config.nodes?.length?config.nodes:[{host:config.host,port:config.port}]
    const uri=config.uri?.trim()||'mongodb://'+nodes.map(node=>hostForUri(node.host)+':'+node.port).join(',')+'/'
    const tlsActive=config.tls.enabled||mongoUriTlsEnabled(config.uri)
    const options:MongoClientOptions={
      ...(config.uri?{}:{auth:config.username?{username:config.username,password:config.password||''}:undefined,authSource:config.authSource||'admin',dbName:config.database||undefined}),
      serverSelectionTimeoutMS:config.connectTimeoutMs,connectTimeoutMS:config.connectTimeoutMs,socketTimeoutMS:30000,maxPoolSize:5,minPoolSize:0,waitQueueTimeoutMS:10000,
      retryWrites:false,retryReads:true,promoteValues:true,
      ...(config.mongoReplicaSet?{replicaSet:config.mongoReplicaSet}:{}),
      ...(mongoDirectConnection(config)===undefined?{}:{directConnection:mongoDirectConnection(config)}),
      ...(tlsActive?{tls:true,ca:tls.ca,cert:tls.cert,key:tls.key,minVersion:'TLSv1.2' as const}:{}),
      ...(tlsActive&&config.tls.servername?{servername:config.tls.servername,checkServerIdentity:(_host:string,certificate:Parameters<typeof checkServerIdentity>[1])=>checkServerIdentity(config.tls.servername!,certificate)}:{})
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
      const operations=new MongoOperations(client)
      return {
        execute:(input,context)=>operations.execute(input as MongoOperation,context),
        async roots(){
          try{
            const data=await client.db().admin().listDatabases({nameOnly:true,authorizedDatabases:true,maxTimeMS:10000})
            return data.databases.slice(0,500).map(db=>({id:'db:'+db.name,label:db.name,kind:'database',database:db.name}))
          }catch(error){
            if((error as {code?:number}).code!==13)throw error
            const db=config.database||client.db().databaseName
            return [{id:'db:'+db,label:db,kind:'database',database:db}]
          }
        },
        async children(database,category,context){
          if(category===undefined)return mongoCategoryNodes(database)
          const group=mongoCategory(category)
          if(!group)throw new Error('INVALID_OPERATION: 不支持的操作')
          if(!group.expandable)return []
          const filter=category==='functions'?{name:'system.js'}:category==='views'?{type:'view'}:category==='gridfs'?{name:/\.(files|chunks)$/}:{}
          const cursor=client.db(database).listCollections(filter,{nameOnly:true,authorizedCollections:true,batchSize:100,maxTimeMS:10000})
          const entries:MongoCatalogEntry[]=[]
          try{for await(const item of cursor){entries.push({name:item.name,type:item.type});if(entries.length>=500||context.signal?.aborted)break}}
          finally{await cursor.close()}
          return mongoCatalogNodes(database,entries,category)
        },
        async close(){operations.cancel();await client.close().catch(()=>{})}
      }
    }catch(error){await client.close().catch(()=>{});throw error}
  },
  preview(database,entity,offset){return {action:'mongo.find',database,entity,offset,limit:100}}
}
