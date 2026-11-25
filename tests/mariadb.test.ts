import test from 'node:test'
import assert from 'node:assert/strict'
import {newConnectionConfig,prepareConnection,initialAuth} from '../src/shared/connection-form'
import {validateConnection} from '../src/main/connections/validation'
import {createConnectionBackup,readConnectionBackup} from '../src/main/connections/backup'
import {nativeToolCommand} from '../src/main/operations/native-tools'
import {mysqlObjectCapabilities,relationalDialect} from '../src/shared/relational-capabilities'
import {normalizePreferences,pageSizeFor,normalizeRecoveryDraft} from '../src/shared/preferences'
import {normalizeDatabasePalette,databaseTypeColor} from '../src/shared/database-palette'
import {protectedDatabase} from '../src/shared/database-admin'
test('MariaDB profiles and independent preferences are persisted without changing MySQL defaults',()=>{
 const base={...newConnectionConfig('mariadb'),name:'fixture',password:'fixture-only'}
 assert.equal(base.port,3306);assert.equal(base.username,'root');assert.equal(initialAuth(base),'password')
 const config=validateConnection(prepareConnection(base,{entry:'fields',auth:'password'}).config)
 assert.equal(config.kind,'mariadb');assert.equal(readConnectionBackup(createConnectionBackup([config]))[0].kind,'mariadb')
 const p=normalizePreferences({records:{mariadbPageSize:500,mysqlPageSize:200}})
 assert.equal(pageSizeFor(p,'mariadb'),500);assert.equal(pageSizeFor(p,'mysql'),200)
 const palette=normalizeDatabasePalette('mariadb',{enabled:true,showLabels:true,overrides:{BIGINT:'#ABCDEF'}})
 assert.equal(databaseTypeColor('mariadb',palette,'BIGINT'),'#abcdef')
 assert.equal(normalizeRecoveryDraft({connectionId:'fixture',database:'app',entity:'users',kind:'mariadb-query',text:'SELECT 1'}).kind,'mariadb-query')
 assert.equal(relationalDialect('mariadb'),'mariadb')
 assert.equal(protectedDatabase('mariadb','information_schema'),true)
})
test('MariaDB object capability checks are conservative for special and nontransactional tables',()=>{
 assert.deepEqual(mysqlObjectCapabilities('BASE TABLE','InnoDB',true),{insert:true,update:true,delete:true,import:true,transactional:true})
 assert.deepEqual(mysqlObjectCapabilities('BASE TABLE','MyISAM',false),{insert:true,update:false,delete:false,import:false,transactional:false})
 for(const kind of ['VIEW','SEQUENCE','SYSTEM VERSIONED',''])assert.deepEqual(mysqlObjectCapabilities(kind,'InnoDB',true),{insert:false,update:false,delete:false,import:false,transactional:false})
})
test('MariaDB native CLI uses MariaDB flags, validates the connection type and keeps secrets out of argv',()=>{
 const config={...newConnectionConfig('mariadb'),name:'fixture',password:'fixture-secret'}
 const dump=nativeToolCommand('mariadb-backup',config,'app',undefined,'/tmp/private.cnf','/tmp/app.sql')
 assert.ok(dump.args.includes('--skip-ssl'))
 assert.ok(!dump.args.includes('--ssl-mode=DISABLED'))
 assert.ok(!dump.args.includes('--no-login-paths'))
 assert.ok(!dump.args.join(' ').includes(config.password))
 assert.ok(dump.contents.includes(config.password))
 assert.throws(()=>nativeToolCommand('mysql-backup',config,'app',undefined,'/tmp/private.cnf','/tmp/app.sql'))
})
