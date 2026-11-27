import {openClickHouseClients} from '../clickhouse-client'
import {ClickHouseOperations} from '../../operations/clickhouse'
import {inspectClickHouseSql} from '../../operations/clickhouse-policy'
import type {ClickHouseOperation} from '../../../shared/types'
import type {DatabaseAdapter} from './types'

export const clickhouseAdapter:DatabaseAdapter={
 kind:'clickhouse',
 actions:['clickhouse.query','clickhouse.browse','clickhouse.structure','clickhouse.inspect','clickhouse.management','clickhouse.mutationPreview','clickhouse.change','clickhouse.backupStatus','clickhouse.insert'],
 writes(input){return input.action==='clickhouse.change'||input.action==='clickhouse.insert'||input.action==='clickhouse.query'&&inspectClickHouseSql(input.sql).mode==='write'},
 async connect({config,transport,tls}){
  const pool=await openClickHouseClients(config,transport,tls),make=pool.make
  const client=make(config.database||'default')
  try{
   const operations=new ClickHouseOperations(client,make)
   const version=await operations.version({writable:false,confirmed:false})
   if(!version||!/^\d+\.\d+/.test(version))throw new Error('INVALID_CONNECTION: ClickHouse')
   return {
    serverVersion:version,
    execute:(input,context)=>operations.execute(input as ClickHouseOperation,context),
    transfer:(input,path,context)=>operations.transfer(input,path,context),
    roots:context=>operations.roots(context),
    children:(database,_category,context,statistics)=>operations.children(database,context,statistics),
    close:pool.close
   }
  }catch(error){await pool.close();throw error}
 },
 preview(database,entity,offset){return {action:'clickhouse.browse',database,entity,offset,limit:100}}
}
