import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer as tlsServer} from 'node:tls'
import {createConnection} from 'node:net'
import {createTransport} from '../src/main/connections/transport'
import {openVerifiedNativeTlsForward} from '../src/main/connections/native-tls-forward'
import {NativeCliProcess,cliStatement,prepareNativeCli} from '../src/main/operations/native-cli'
import {nativeToolCommand} from '../src/main/operations/native-tools'
import {newConnectionConfig} from '../src/shared/connection-form'
import {normalizeWorkspaceWindows,workspaceStorageKey} from '../src/shared/workspace-windows'
import {normalizeRecoveryDraft,recoveryKey} from '../src/shared/preferences'
import {adapterAllowsAction,adapterOperationWrites} from '../src/main/connections/adapters'
import {mutationPlan} from '../src/main/operations/clickhouse-admin'
import {clickHouseManagementQuery} from '../src/main/operations/clickhouse-management'

test('window IDs and geometry are bounded; recovery drafts cannot share keys between windows',()=>{
 const id=randomUUID(),other=randomUUID()
 const normalized=normalizeWorkspaceWindows([{id:'primary'},{id,bounds:{x:20,y:30,width:1200,height:800}},{id},{id:'../outside'},{id:other,bounds:{x:0,y:0,width:12,height:800}}])
 assert.equal(normalized.length,3)
 assert.equal(normalized[1]?.bounds?.width,1200);assert.equal(normalized[2]?.bounds,undefined)
 assert.notEqual(workspaceStorageKey(id),workspaceStorageKey(other));assert.equal(workspaceStorageKey('primary'),'dbex.workspace.v1')
 const draft={connectionId:'db1',database:'app',entity:'t',kind:'record-edit',text:'draft'}
 assert.notEqual(recoveryKey(normalizeRecoveryDraft({...draft,windowId:id})),recoveryKey(normalizeRecoveryDraft({...draft,windowId:other})))
 assert.equal(recoveryKey(normalizeRecoveryDraft({...draft,windowId:'primary'})),recoveryKey(normalizeRecoveryDraft(draft)))
})
test('new operation policies preserve engine boundaries and lightweight predicates',()=>{
 assert.equal(adapterAllowsAction('mysql','mariadb.object'),false)
 assert.equal(adapterAllowsAction('mariadb','mariadb.object'),true)
 assert.equal(adapterOperationWrites('mariadb',{action:'mariadb.sequenceRestart',database:'app',entity:'s',value:'42'},true),true)
 const fields=[{name:'id',type:'UInt64',is_in_primary_key:'1',is_in_sorting_key:'1',is_in_partition_key:'0',is_in_sampling_key:'0'},{name:'note',type:'String',is_in_primary_key:'0',is_in_sorting_key:'0',is_in_partition_key:'0',is_in_sampling_key:'0'}]
 const change={kind:'update',field:'id',match:'1',column:'note',value:'v',lightweight:true} as const
 const update=mutationPlan(change,fields,'"app"."t"');assert.match(update.sql,/^UPDATE "app"."t" SET /);assert.equal(update.params.filter,'1')
 assert.match(mutationPlan({kind:'delete',field:'id',match:'2',lightweight:true},fields,'"app"."t"').sql,/^DELETE FROM /)
 assert.throws(()=>mutationPlan({...change,column:'id'},fields,'"app"."t"'),/INVALID_INPUT/)
 assert.match(clickHouseManagementQuery('topology',{limit:10,offset:5}).sql,/system\.clusters.*LIMIT 11 OFFSET 5/)
 assert.match(clickHouseManagementQuery('replicationQueue',{}).sql,/system\.replication_queue WHERE database=\{db:String\}/)
})
test('native CLI is single-statement SQL only and has a bounded process lifecycle',async t=>{
 assert.equal(cliStatement('mysql','SELECT 7').mode,'read')
 assert.equal(cliStatement('mariadb','COMMIT').mode,'write')
 assert.equal(cliStatement('sqlite','BEGIN').mode,'write')
 for(const sql of ['.shell echo unsafe','SELECT 1; SELECT 2','SELECT 1\n.shell echo unsafe','\\! echo unsafe','ATTACH DATABASE \'other.db\' AS ext'])assert.throws(()=>cliStatement('sqlite',sql))
 const dir=await mkdtemp(join(tmpdir(),'dbex-cli-test-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const mock=join(dir,'mock.cjs')
 // Real child process with a deterministic pipe protocol; native DB syntax itself is verified by the integration fixture.
 await writeFile(mock,"const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const marker=/SELECT '([^']+)'/.exec(line);if(marker)console.log(marker[1]);else if(/^SELECT 7/.test(line))console.log('7');});")
 const controller=new AbortController(),cli=new NativeCliProcess('sqlite',x=>x)
 t.after(()=>cli.stop())
 await cli.start(process.execPath,[mock],controller.signal)
 cli.send('SELECT 7')
 for(let i=0;i<60&&cli.snapshot().running;i++)await new Promise(r=>setTimeout(r,25))
 assert.equal(cli.snapshot().running,false);assert.match(cli.snapshot().output,/7/)
 controller.abort();await cli.finished;assert(cli.snapshot().closed)
})
test('MongoDB native TLS loopback forward verifies the remote certificate over authenticated SOCKS',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-native-tls-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const cert=join(dir,'cert.pem'),key=join(dir,'key.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=mongo.fixture','-addext','subjectAltName=DNS:mongo.fixture'],{stdio:'ignore'})
 const ca=await readFile(cert)
 const server=tlsServer({key:await readFile(key),cert:ca},socket=>socket.on('data',data=>socket.write(data)))
 server.on('tlsClientError',()=>{})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const addr=server.address();assert(addr&&typeof addr!=='string')
 const outer=await createTransport({ssh:{enabled:false,host:'',port:22,username:'',authMode:'agent'}})
 const proxy=await outer.socks()
 const transport=await createTransport({ssh:{enabled:false,host:'',port:22,username:'',authMode:'agent'},proxy:{enabled:true,type:'socks5',...proxy}})
 const controller=new AbortController()
 try{
  const forward=await openVerifiedNativeTlsForward(transport,'127.0.0.1',addr.port,{ca,servername:'mongo.fixture'},controller.signal)
  const roundTrip=(port:number)=>new Promise<string>((resolve,reject)=>{const socket=createConnection(port,'127.0.0.1');socket.setTimeout(3000,()=>socket.destroy(new Error('timeout')));socket.on('error',reject);socket.once('data',data=>{socket.destroy();resolve(String(data))});socket.once('close',()=>reject(new Error('closed')));socket.once('connect',()=>socket.write('hello'))})
  assert.equal(await roundTrip(forward.route.port),'hello')
  const config={...newConnectionConfig('mongodb'),host:'mongo.fixture',tls:{enabled:true,servername:'mongo.fixture',caPath:cert},proxy:{enabled:true,type:'socks5' as const,...proxy}}
  const cmd=nativeToolCommand('mongo-backup',config,'app',undefined,join(dir,'private.yml'),'unused',forward.route)
  assert(!cmd.args.includes('--ssl'));assert(!cmd.contents.includes('tls=true'));assert.match(cmd.contents,/127\.0\.0\.1/)
  await forward.close()
  const bad=await openVerifiedNativeTlsForward(transport,'127.0.0.1',addr.port,{ca,servername:'wrong.fixture'},controller.signal)
  await assert.rejects(()=>roundTrip(bad.route.port))
  await bad.close()
 }finally{controller.abort();await transport.close();await outer.close()}
})
