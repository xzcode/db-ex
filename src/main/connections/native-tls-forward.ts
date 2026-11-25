import {createServer,isIP,type Socket} from 'node:net'
import {connect,checkServerIdentity,type ConnectionOptions,type TLSSocket} from 'node:tls'
import type {Duplex} from 'node:stream'
import type {ConnectionTransport} from './transport'

/** MongoDB uses TLS from the first byte. Terminate only at the process-owned
 * loopback listener; authenticate the remote certificate before piping bytes.
 * MySQL/MariaDB negotiate TLS inside their wire protocol and cannot use this. */
export async function openVerifiedNativeTlsForward(transport:ConnectionTransport,host:string,port:number,tls:ConnectionOptions,signal:AbortSignal){
 if(signal.aborted)throw new Error('CANCELLED: 已取消操作')
 const identity=tls.servername||host
 const sockets=new Set<Duplex>()
 let closed=false
 const track=(socket:Duplex)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>socket.destroy())}
 const server=createServer((local:Socket)=>{
  if(closed||sockets.size>=32){local.destroy();return}
  track(local)
  local.pause()
  void (async()=>{
   let upstream:Duplex|undefined,secured:TLSSocket|undefined
   try{
    upstream=await transport.open(host,port)
    if(closed||local.destroyed){upstream.destroy();return}
    track(upstream)
    secured=connect({...tls,socket:upstream,servername:isIP(identity)?undefined:identity,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_hostname,cert)=>checkServerIdentity(identity,cert)})
    track(secured)
    const remote=secured
    local.once('close',()=>remote.destroy());remote.once('close',()=>local.destroy())
    await new Promise<void>((resolve,reject)=>{
     const timer=setTimeout(()=>{remote.destroy();reject(new Error('TLS handshake timeout'))},12000)
     remote.once('secureConnect',()=>{clearTimeout(timer);resolve()})
     remote.once('error',error=>{clearTimeout(timer);reject(error)})
     remote.once('close',()=>{clearTimeout(timer);reject(new Error('TLS connection closed'))})
    })
    if(closed||local.destroyed||!remote.authorized){remote.destroy();local.destroy();return}
    local.pipe(remote).pipe(local);local.resume()
   }catch{secured?.destroy();upstream?.destroy();local.destroy()}
  })()
 })
 const close=async()=>{
  if(closed)return
  closed=true;signal.removeEventListener('abort',abort)
  for(const socket of sockets)socket.destroy()
  await new Promise<void>(resolve=>server.close(()=>resolve()))
 }
 const abort=()=>{void close()}
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted){await close();throw new Error('CANCELLED: 已取消操作')}
  const address=server.address()
  if(!address||typeof address==='string')throw new Error('TRANSPORT_LISTEN_FAILED: 无法分配本地转发端口')
  return {route:{host:'127.0.0.1',port:address.port,tlsVerified:true as const},close}
 }catch(error){await close();throw error}
}
