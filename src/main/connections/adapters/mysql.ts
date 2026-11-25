import mysql from 'mysql2/promise'
import { metric,metrics } from '../../../shared/object-inspection'
import type { MysqlOperation } from '../../../shared/types'
import { MysqlOperations } from '../../operations/mysql'
import { inspectSql, quoteIdentifier } from '../../operations/sql-policy'
import type { DatabaseAdapter, OperationAction } from './types'

export const mysqlActions = ['mysql.query','mysql.createDatabase','mysql.dropDatabase','mysql.browse','mysql.structure','mysql.inspect','mysql.insert','mysql.update','mysql.updateBatch','mysql.delete','mysql.import','mysql.begin','mysql.commit','mysql.rollback'] as const satisfies readonly OperationAction[]

const writes=new Set<OperationAction>(['mysql.createDatabase','mysql.dropDatabase','mysql.insert','mysql.update','mysql.updateBatch','mysql.delete','mysql.import','mysql.begin','mysql.commit'])
export function createMysqlFamilyAdapter(kind:'mysql'|'mariadb'):DatabaseAdapter{return {
  kind,
  actions:mysqlActions,
  rollback:{action:'mysql.rollback'},
  writes(input,writable){return input.action==='mysql.query'?inspectSql(input.sql,writable).mode==='write':writes.has(input.action)},
  async connect({config,transport,tls}){
    const stream=await transport.open(config.host,config.port)
    let client:Awaited<ReturnType<typeof mysql.createConnection>>|undefined
    try{
      client=await mysql.createConnection({
        host:config.tls.servername||config.host,port:config.port,stream,
        user:config.username||undefined,password:config.password||undefined,
        database:config.database||undefined,connectTimeout:config.connectTimeoutMs,
        supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,decimalNumbers:false,jsonStrings:true,
        multipleStatements:false,flags:['-LOCAL_FILES'],
        ssl:config.tls.enabled?{ca:tls.ca,cert:tls.cert,key:tls.key,rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2'} as import('mysql2').SslOptions:undefined,
      })
      // Query one bounded server-version value for the explicit MariaDB profile.
      // Do not advertise a MariaDB profile against a different server family.
      const connected=client
      let serverVersion:string|undefined
      if(kind==='mariadb'){
        const [rows]=await connected.query({sql:'SELECT VERSION() AS server_version',timeout:config.connectTimeoutMs||12000}) as [Record<string,unknown>[],unknown]
        const version=rows[0]?.server_version
        if(typeof version!=='string'||version.length>200||!version.toLowerCase().includes('mariadb'))throw new Error('INVALID_CONNECTION: 数据库类型错误')
        serverVersion=version
      }
      const operations=new MysqlOperations(connected,kind)
      return {
        serverVersion,
        execute:(input,context)=>operations.execute(input as MysqlOperation,context),
        async roots(context){
          const data=await operations.execute({action:'mysql.query',sql:'SHOW DATABASES'},context)
          return data.rows.map(row=>{const db=Object.values(row)[0];return {id:'db:'+db,label:db,kind:'database',database:db}})
        },
        async children(database,_category,context,withStatistics){
          // Catalog metadata is bounded and permission filtered by the server.
          // No table rows or full COUNT queries are needed for the catalog.
          const detailed=kind==='mariadb'||withStatistics
          const data=await operations.execute(detailed?{action:'mysql.query',sql:'SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_ROWS,AVG_ROW_LENGTH,DATA_LENGTH,INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 500',parameters:[database],limit:500}:{action:'mysql.query',sql:'SHOW FULL TABLES FROM '+quoteIdentifier(database)},context)
          return data.rows.map((row,index)=>{
            const [entity,type]=Object.values(row)
            const special=kind==='mariadb'&&type==='SEQUENCE'?'sequence':kind==='mariadb'&&type==='SYSTEM VERSIONED'?'system-versioned':undefined
            const raw=data.rawRows?.[index]
            const value=(key:string)=>raw?raw[key]:row[key]==='NULL'?undefined:row[key]
            return {id:'table:'+database+':'+entity,label:entity,kind:type==='VIEW'?'view':'table',readOnly:type==='VIEW'||!!special,database,entity,objectType:special,
              metrics:withStatistics?metrics(metric('存储引擎',value('ENGINE')),metric('记录数（估算）',value('TABLE_ROWS'),'estimate'),metric('平均记录大小',value('AVG_ROW_LENGTH'),'bytes'),metric('数据大小',value('DATA_LENGTH'),'bytes'),metric('索引的总大小',value('INDEX_LENGTH'),'bytes')):undefined}
          })
        },
        async close(){await operations.close().catch(()=>{});connected.destroy()},
        transactionActive:()=>operations.transactionActive,
        disconnected:()=>operations.disconnected
      }
    }catch(error){client?.destroy();stream.destroy();throw error}
  },
  preview(database,entity,offset){return {action:'mysql.query',database,sql:'SELECT * FROM '+quoteIdentifier(database)+'.'+quoteIdentifier(entity),offset,limit:100}}
}}
export const mysqlAdapter=createMysqlFamilyAdapter('mysql')
