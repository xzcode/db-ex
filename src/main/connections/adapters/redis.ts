import type { RedisOperation } from '../../../shared/types'
import { createRedisClient,setRedisReadBudget } from '../redis-client'
import { RedisOperations,redisCommandWrites,validateRedisCommand } from '../../operations/redis'
import type { DatabaseAdapter,OperationAction } from './types'

const actions=['redis.scan','redis.get','redis.inspect','redis.set','redis.mutate','redis.ttl','redis.delete','redis.command','redis.nodes'] as const satisfies readonly OperationAction[]
export const redisAdapter:DatabaseAdapter={
  kind:'redis',actions,
  writes(input){return input.action==='redis.command'?redisCommandWrites(validateRedisCommand(input.args)):['redis.set','redis.mutate','redis.ttl','redis.delete'].includes(input.action)},
  async connect({config,transport,tls}){
    const client=await createRedisClient(config,transport,tls)
    const operations=new RedisOperations(client)
    return {
      execute:(input,context)=>operations.execute(input as RedisOperation,context),
      async roots(){return [{id:'db:'+(config.redisDb||0),label:config.redisMode==='cluster'?'Cluster · DB 0':'DB '+(config.redisDb||0),kind:'keyspace',database:String(config.redisDb||0)}]},
      async children(){return []},
      async close(){client.disconnect()},
      beginReadBudget(){
        const budget=setRedisReadBudget(client,8*1024*1024)
        return {release:()=>{setRedisReadBudget(client,undefined)},exceeded:()=>budget?.exceeded===true}
      }
    }
  }
}
