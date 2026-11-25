import test from 'node:test'
import assert from 'node:assert/strict'
import { newConnectionConfig } from '../src/shared/connection-form'
import { nativeToolCommand, toolVersion } from '../src/main/operations/native-tools'
test('native tools use structured args and private credential files rather than argv secrets',()=>{
 const cfg={...newConnectionConfig('mysql'),name:'local',password:'secret"\\pw'}
 const cmd=nativeToolCommand('mysql-backup',cfg,'app',undefined,'/tmp/private.cnf','/tmp/dump.sql')
 assert.ok(cmd.args.includes('--defaults-file=/tmp/private.cnf'));assert.ok(!cmd.args.join(' ').includes('secret'))
 assert.match(cmd.contents,/password=/);assert.throws(()=>nativeToolCommand('mysql-backup',{...cfg,ssh:{...cfg.ssh,enabled:true}},'app',undefined,'/tmp/private.cnf','/tmp/dump.sql'),/NATIVE_TOOL_CONNECTION/)
 const mongo={...newConnectionConfig('mongodb'),name:'local',username:'user',password:'a&b'}
 const archive=nativeToolCommand('mongo-restore',mongo,'app',undefined,'/tmp/private.yml','/tmp/dump.archive')
 assert.ok(archive.args.includes('--nsInclude=app.*'));assert.ok(!archive.args.join(' ').includes('a&b'));assert.ok(archive.contents.includes('a%26b'))
 assert.ok(!archive.args.includes('--drop'))
})
test('native tool version performs a real shell-free executable invocation',async()=>{
 assert.match(await toolVersion(process.execPath),/^v\d+\./)
})

test('native tools allow verified single-host TLS and explicitly routed non-TLS endpoints without downgrading security',()=>{
 const mysql=newConnectionConfig('mysql'),maria=newConnectionConfig('mariadb'),mongo=newConnectionConfig('mongodb')
 const tls={...mysql.tls,enabled:true,caPath:'/tmp/ca.pem'}
 const direct=nativeToolCommand('mysql-backup',{...mysql,tls},'app',undefined,'/tmp/client.cnf','/tmp/dump.sql')
 assert(direct.args.includes('--ssl-mode=VERIFY_IDENTITY'));assert.match(direct.contents,/ssl-ca=/)
 const mariadb=nativeToolCommand('mariadb-backup',{...maria,tls},'app',undefined,'/tmp/client.cnf','/tmp/dump.sql')
 assert(mariadb.args.includes('--ssl-verify-server-cert'))
 const routed={...mysql,ssh:{...mysql.ssh,enabled:true}}
 const via=nativeToolCommand('mysql-backup',routed,'app',undefined,'/tmp/client.cnf','/tmp/dump.sql',{host:'127.0.0.1',port:51234})
 assert.match(via.contents,/port=51234/);assert.match(via.contents,/host="127.0.0.1"/)
 assert.throws(()=>nativeToolCommand('mysql-backup',{...routed,tls},'app',undefined,'/tmp/client.cnf','/tmp/dump.sql',{host:'127.0.0.1',port:51234}),/NATIVE_TOOL_CONNECTION/)
 assert.throws(()=>nativeToolCommand('mysql-backup',routed,'app',undefined,'/tmp/client.cnf','/tmp/dump.sql',{host:'remote',port:51234}),/NATIVE_TOOL_CONNECTION/)
 const m=nativeToolCommand('mongo-backup',{...mongo,tls},'app',undefined,'/tmp/client.yml','/tmp/dump.archive')
 assert(m.args.includes('--sslCAFile=/tmp/ca.pem'));assert.match(m.contents,/tls=true/)
 assert.throws(()=>nativeToolCommand('mongo-backup',{...mongo,tls:{...tls,certPath:'/tmp/cert.pem'}},'app',undefined,'/tmp/client.yml','/tmp/dump.archive'),/NATIVE_TOOL_CONNECTION/)
})
