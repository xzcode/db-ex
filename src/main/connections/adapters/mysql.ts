import mysql from 'mysql2/promise'
import type { MysqlOperation } from '../../../shared/types'
import { MysqlOperations } from '../../operations/mysql'
import { quoteIdentifier } from '../../operations/sql-policy'
import type { DatabaseAdapter, OperationAction } from './types'

export const mysqlActions = ['mysql.query','mysql.createDatabase','mysql.dropDatabase','mysql.browse','mysql.structure','mysql.inspect','mysql.insert','mysql.update','mysql.delete','mysql.import','mysql.begin','mysql.commit','mysql.rollback'] as const satisfies readonly OperationAction[]

export const mysqlAdapter:DatabaseAdapter = {
  kind:'mysql',
  actions:mysqlActions,
  rollback:{action:'mysql.rollback'},
  async connect({config,transport,tls}){
    const stream=await transport.open(config.host,config.port)
    try{
      const client=await mysql.createConnection({
        host:config.tls.servername||config.host,port:config.port,stream,
        user:config.username||undefined,password:config.password||undefined,
        database:config.database||undefined,connectTimeout:config.connectTimeoutMs,
        supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,decimalNumbers:false,jsonStrings:true,
        multipleStatements:false,flags:['-LOCAL_FILES'],
        ssl:config.tls.enabled?{ca:tls.ca,cert:tls.cert,key:tls.key,rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2'} as import('mysql2').SslOptions:undefined,
      })
      const operations=new MysqlOperations(client)
      return {
        execute:(input,context)=>operations.execute(input as MysqlOperation,context),
        async roots(context){
          const data=await operations.execute({action:'mysql.query',sql:'SHOW DATABASES'},context)
          return data.rows.map(row=>{const db=Object.values(row)[0];return {id:'db:'+db,label:db,kind:'database',database:db}})
        },
        async children(database,_category,context){
          const data=await operations.execute({action:'mysql.query',sql:'SHOW FULL TABLES FROM '+quoteIdentifier(database)},context)
          return data.rows.map(row=>{const [entity,type]=Object.values(row);return {id:'table:'+database+':'+entity,label:entity,kind:type==='VIEW'?'view':'table',readOnly:type==='VIEW',database,entity}})
        },
        async close(){await operations.close().catch(()=>{});client.destroy()},
        transactionActive:()=>operations.transactionActive,
        disconnected:()=>operations.disconnected
      }
    }catch(error){stream.destroy();throw error}
  },
  preview(database,entity,offset){return {action:'mysql.query',database,sql:'SELECT * FROM '+quoteIdentifier(database)+'.'+quoteIdentifier(entity),offset,limit:100}}
}
