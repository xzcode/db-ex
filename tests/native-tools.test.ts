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
