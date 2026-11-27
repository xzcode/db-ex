import {openMongoClient} from '../mongo-client'
import { metric,metrics } from '../../../shared/object-inspection'
import type { MongoOperation } from '../../../shared/types'
import { mongoCategory,mongoCategoryNodes,mongoCatalogNodes,type MongoCatalogEntry } from '../../../shared/mongo-catalog'
import { MongoOperations } from '../../operations/mongodb'
import { describeMongoConnectionError } from '../mongo-diagnostics'
import type { DatabaseAdapter,OperationAction } from './types'

const actions=['mongo.find','mongo.createDatabase','mongo.dropDatabase','mongo.createCollection','mongo.renameCollection','mongo.dropCollection','mongo.clearCollection','mongo.count','mongo.estimateCount','mongo.scriptWrite','mongo.aggregate','mongo.insert','mongo.replace','mongo.replaceBatch','mongo.delete','mongo.indexes','mongo.inspect','mongo.createIndex','mongo.dropIndex'] as const satisfies readonly OperationAction[]
export const mongoAdapter:DatabaseAdapter={
  kind:'mongodb',actions,connectionError:describeMongoConnectionError,
  writes(input){return ['mongo.createDatabase','mongo.dropDatabase','mongo.createCollection','mongo.renameCollection','mongo.dropCollection','mongo.clearCollection','mongo.scriptWrite','mongo.insert','mongo.replace','mongo.replaceBatch','mongo.delete','mongo.createIndex','mongo.dropIndex'].includes(input.action)},
  async connect({config,transport,tls}){
    const client=await openMongoClient(config,transport,tls)
    try{
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
        async children(database,category,context,withStatistics){
          if(category===undefined)return mongoCategoryNodes(database)
          const group=mongoCategory(category)
          if(!group)throw new Error('INVALID_OPERATION: 不支持的操作')
          if(!group.expandable)return []
          const filter=category==='functions'?{name:'system.js'}:category==='views'?{type:'view'}:category==='gridfs'?{name:/\.(files|chunks)$/}:{}
          const cursor=client.db(database).listCollections(filter,{nameOnly:true,authorizedCollections:true,batchSize:100,maxTimeMS:10000})
          const entries:MongoCatalogEntry[]=[]
          try{for await(const item of cursor){entries.push({name:item.name,type:item.type});if(entries.length>=500||context.signal?.aborted)break}}
          finally{await cursor.close()}
          const nodes=mongoCatalogNodes(database,entries,category)
        if(withStatistics&&category==='collections'){
          // Metadata only, bounded per request. A denied or unavailable collStats
          // must not hide a collection or manufacture a zero count.
          const targets=nodes.slice(0,50),deadline=Date.now()+4500
          let cursor=0
          await Promise.all(Array.from({length:Math.min(3,targets.length)},async()=>{
            while(cursor<targets.length&&!context.signal?.aborted&&Date.now()<deadline){
              const node=targets[cursor++]!
              try{
                const stats=await client.db(database).command({collStats:node.entity,scale:1},{signal:context.signal,timeoutMS:Math.min(1200,Math.max(1,deadline-Date.now())),raw:false,promoteValues:true,promoteLongs:false})
                node.metrics=metrics(metric('文档数',stats.count),metric('已固定',stats.capped,'boolean'),metric('数据大小',stats.size,'bytes'),metric('对象的平均大小',stats.avgObjSize,'bytes'),metric('存储大小',stats.storageSize,'bytes'))
              }catch{/* unavailable metadata is represented by an empty cell */}
            }
          }))
        }
        return nodes
        },
        async close(){operations.cancel();await client.close().catch(()=>{})}
      }
    }catch(error){await client.close().catch(()=>{});throw error}
  },
  preview(database,entity,offset){return {action:'mongo.find',database,entity,offset,limit:100}}
}
