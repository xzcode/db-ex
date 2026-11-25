import {createConnection,type Socket} from 'node:net'
import {generateKeyPairSync,createHash,randomBytes} from 'node:crypto'
import ssh2,{type Connection} from 'ssh2'
import type {SshOptions} from '../src/shared/types'

/** Real SSH direct-tcpip, confined to one isolated loopback database port. */
export async function m11SshFixture(databasePort:number){
 const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey
 const parsed=ssh2.utils.parseKey(key)
 if(parsed instanceof Error||Array.isArray(parsed))throw new Error('Invalid generated SSH host key')
 const fingerprint=createHash('sha256').update(parsed.getPublicSSH()).digest('hex')
 const password=randomBytes(16).toString('hex'),clients=new Set<Connection>(),sockets=new Set<Socket>()
 const server=new ssh2.Server({hostKeys:[key]},client=>{
  clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client))
  client.on('authentication',ctx=>{if(ctx.method==='password'&&ctx.username==='dbex-fixture'&&ctx.password===password)ctx.accept();else ctx.reject()})
  client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
   if(!['127.0.0.1','localhost'].includes(info.destIP)||info.destPort!==databasePort){reject();return}
   const socket=createConnection({host:'127.0.0.1',port:databasePort});sockets.add(socket)
   socket.once('close',()=>sockets.delete(socket))
   socket.once('error',()=>{reject();socket.destroy()})
   socket.once('connect',()=>{
    const channel=accept()
    socket.on('error',()=>channel.destroy())
    channel.on('error',()=>socket.destroy())
    socket.once('close',()=>channel.destroy());channel.once('close',()=>socket.destroy())
    channel.pipe(socket).pipe(channel)
   })
  }))
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const addr=server.address();if(!addr||typeof addr==='string')throw new Error('SSH fixture address missing')
 const ssh:SshOptions={enabled:true,host:'127.0.0.1',port:addr.port,username:'dbex-fixture',authMode:'password',password,hostFingerprint:fingerprint}
 return {ssh,close:async()=>{for(const socket of sockets)socket.destroy();for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
