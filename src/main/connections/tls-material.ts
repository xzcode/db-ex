import {readFile,stat} from 'node:fs/promises'
import type {ConnectionOptions} from 'node:tls'
import type {ConnectionConfig} from '../../shared/types'
import {mongoUriTlsEnabled} from './mongo-topology'
async function certificate(path?:string){
 if(!path)return undefined
 const info=await stat(path)
 if(!info.isFile()||info.size>2*1024*1024)throw new Error('TLS_CONFIG: 证书文件必须为不超过2 MiB的普通文件')
 return readFile(path)
}
export async function loadConnectionTls(config:ConnectionConfig):Promise<ConnectionOptions>{
 const active=config.tls.enabled||config.sentinelTls||config.kind==='mongodb'&&mongoUriTlsEnabled(config.uri)
 const [ca,cert,key]=active?await Promise.all([certificate(config.tls.caPath),certificate(config.tls.certPath),certificate(config.tls.keyPath)]):[]
 return {ca,cert,key,servername:config.tls.servername||undefined,rejectUnauthorized:true,minVersion:'TLSv1.2'}
}
