import mysql from 'mysql2/promise'
import type {ConnectionOptions as TlsConnectionOptions} from 'node:tls'
import type {ConnectionConfig} from '../../shared/types'
import type {ConnectionTransport} from './transport'
/** Shared driver construction for explorer and isolated migration jobs. */
export async function openMysqlClient(config:ConnectionConfig,transport:ConnectionTransport,tls:TlsConnectionOptions){
 const stream=await transport.open(config.host,config.port)
 try{
  return await mysql.createConnection({
   host:config.tls.servername||config.host,port:config.port,stream,
   user:config.username||undefined,password:config.password||undefined,
   database:config.database||undefined,connectTimeout:config.connectTimeoutMs,
   supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,decimalNumbers:false,jsonStrings:true,
   multipleStatements:false,flags:['-LOCAL_FILES'],
   ssl:config.tls.enabled?{ca:tls.ca,cert:tls.cert,key:tls.key,rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2'} as import('mysql2').SslOptions:undefined,
  })
 }catch(error){stream.destroy();throw error}
}
