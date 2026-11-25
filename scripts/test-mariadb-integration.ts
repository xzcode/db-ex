import assert from 'node:assert/strict'
import {join} from 'node:path'
import {readFile,readdir} from 'node:fs/promises'
import mysql from 'mysql2/promise'
import {SessionManager} from '../src/main/connections/manager'
import {createTransport} from '../src/main/connections/transport'
import {newConnectionConfig} from '../src/shared/connection-form'
import {newBrowseFilter} from '../src/shared/browse-filter'
import {runNativeTool} from '../src/main/operations/native-tools'
import {createConnectionBackup,readConnectionBackup} from '../src/main/connections/backup'
import {redactConnection,mergeConnectionSecrets} from '../src/main/connections/credentials'

const fixture=process.env.DBEX_MARIA_FIXTURE
const port=Number(process.env.DBEX_MARIA_PORT),password=process.env.DBEX_MARIA_PASSWORD
if(!fixture||!Number.isInteger(port)||!password)throw new Error('Missing isolated MariaDB fixture')
const database='dbex_maria_fixture'
const config={...newConnectionConfig('mariadb'),name:'MariaDB fixture',host:'127.0.0.1',port,username:'root',password,database}
const admin=await mysql.createConnection({host:config.host,port,user:'root',password})
const manager=new SessionManager()
const direct=new AbortController().signal
const proxyTransport=await createTransport({ssh:config.ssh})
try{
 await admin.query('CREATE DATABASE '+database)
 await admin.query("CREATE TABLE "+database+".items (id BIGINT PRIMARY KEY, amount DECIMAL(24,4), payload JSON, note VARCHAR(80), generated_note VARCHAR(90) AS (CONCAT(note,'!')) PERSISTENT) ENGINE=InnoDB")
 await admin.query("INSERT INTO "+database+".items(id,amount,payload,note) VALUES (9223372036854775807,12345678901234567890.1234,'{\"ok\":true}','original')")
 await admin.query('CREATE TABLE '+database+'.nontransactional (id INT PRIMARY KEY) ENGINE=MyISAM')
 await admin.query('CREATE VIEW '+database+'.item_view AS SELECT id,note FROM '+database+'.items')
 await admin.query('CREATE SEQUENCE '+database+'.item_seq START WITH 7')
 await admin.query('CREATE TABLE '+database+'.historical (id INT PRIMARY KEY, note VARCHAR(80)) WITH SYSTEM VERSIONING')
 const redacted=redactConnection(config)
 assert(!JSON.stringify(redacted.config).includes(password))
 assert.equal(mergeConnectionSecrets(redacted.config,config).password,password)
 const backup=readConnectionBackup(createConnectionBackup([config]))
 assert.equal(backup[0]?.kind,'mariadb')
 const endpoint=await proxyTransport.socks()
 const session=await manager.connect({...config,proxy:{enabled:true,type:'socks5',...endpoint}})
 console.log('MariaDB connected through authenticated SOCKS: '+session.serverVersion)
 assert.equal(session.kind,'mariadb');assert.equal(session.writable,false)
 assert.match(session.serverVersion||'',/MariaDB/i)
 const roots=await manager.roots(session.id);assert(roots.some(n=>n.database===database))
 const nodes=await manager.children(session.id,database)
 assert(nodes.some(n=>n.entity==='items'&&n.kind==='table'))
 assert(nodes.some(n=>n.entity==='item_view'&&n.readOnly))
 assert(nodes.some(n=>n.entity==='item_seq'&&n.objectType==='sequence'&&n.readOnly))
 assert(nodes.some(n=>n.entity==='historical'&&n.objectType==='system-versioned'&&n.readOnly))
 const target={database,entity:'items'}
 const structure=await manager.execute(session.id,{action:'mysql.structure',...target})
 assert.deepEqual(structure.primaryKeys,['id'])
 assert.equal(structure.objectCapabilities?.transactional,true)
 assert.match(structure.rows.find(x=>x.name==='payload')?.type||'',/longtext/i)
 const inspected=await manager.execute(session.id,{action:'mysql.inspect',...target})
 assert.match(inspected.inspection?.definition||'',/CREATE TABLE/i)
 const seq=await manager.execute(session.id,{action:'mysql.inspect',database,entity:'item_seq'})
 assert.match(seq.inspection?.definition||'',/CREATE SEQUENCE/i)
 const browse=await manager.execute(session.id,{action:'mysql.browse',...target,filter:newBrowseFilter(),limit:100})
 const original=browse.rawRows?.[0]
 assert(original)
 assert.equal(original.id,'9223372036854775807')
 assert.equal(original.amount,'12345678901234567890.1234')
 assert.equal(browse.columnTypes?.[2],'TEXT')
 await assert.rejects(manager.execute(session.id,{action:'mysql.insert',...target,values:{id:1,note:'denied'},confirmed:true}),/READ_ONLY/)
 await manager.setWriteAccess(session.id,true)
 const changed=await manager.execute(session.id,{action:'mysql.update',...target,key:{id:original.id},original,changes:{note:'updated'},confirmed:true})
 assert.equal(changed.affectedRows,1)
 await assert.rejects(manager.execute(session.id,{action:'mysql.update',...target,key:{id:original.id},original,changes:{note:'stale'},confirmed:true}),/EDIT_CONFLICT/)
 await assert.rejects(manager.execute(session.id,{action:'mysql.insert',...target,values:{id:1,generated_note:'bad'},confirmed:true}),/生成列/)
 await manager.execute(session.id,{action:'mysql.begin',confirmed:true})
 await manager.execute(session.id,{action:'mysql.insert',...target,values:{id:2,note:'rollback'},confirmed:true})
 await assert.rejects(manager.execute(session.id,{action:'mysql.insert',database,entity:'nontransactional',values:{id:2},confirmed:true}),/TRANSACTION_REQUIRED/)
 await manager.setWriteAccess(session.id,false)
 assert.equal((await manager.preview(session.id,database,'items')).rows.length,1)
 await manager.setWriteAccess(session.id,true)
 await assert.rejects(manager.execute(session.id,{action:'mysql.insert',database,entity:'historical',values:{id:1,note:'not through grid'},confirmed:true}),/READ_ONLY/)
 await assert.rejects(manager.execute(session.id,{action:'mysql.import',database,entity:'nontransactional',rows:[{id:1}],confirmed:true}),/TRANSACTION_REQUIRED/)
 await manager.execute(session.id,{action:'mysql.import',...target,rows:[{id:3,note:'import'}],confirmed:true})
 const query=await manager.execute(session.id,{action:'mysql.query',sql:'SELECT note FROM items WHERE id=?',database,parameters:[3]})
 assert.equal(query.rows[0]?.note,'import')
 console.log('MariaDB metadata, sequence/system-versioned objects, exact data types, CRUD, conflict checks, rollback and parameter binding passed')
 await manager.closeAll()
 const file=join(fixture,'dump.sql')
 await runNativeTool(join(fixture,'bin','mariadb-dump'),'mariadb-backup',config,database,undefined,file,direct)
 const dump=await readFile(file)
 assert(dump.length>100)
 await assert.rejects(runNativeTool(join(fixture,'bin','mariadb-dump'),'mariadb-backup',config,database,undefined,file,direct))
 assert.deepEqual(await readFile(file),dump)
 // Restore into an empty, dedicated fixture database; keep special objects in the dump.
 await admin.query('DROP DATABASE '+database)
 await admin.query('CREATE DATABASE '+database)
 await runNativeTool(join(fixture,'bin','mariadb'),'mariadb-restore',config,database,undefined,file,direct)
 const [rows]=await admin.query('SELECT note FROM '+database+'.items ORDER BY id') as [Record<string,unknown>[],unknown]
 assert.deepEqual(rows.map(x=>x.note),['import','updated'])
 assert.deepEqual((await readdir(fixture)).filter(x=>x.startsWith('dbex-tool-')||x.startsWith('.dbex-export-')),[])
 console.log('MariaDB native backup/restore and no-overwrite checks passed')
}finally{
 await manager.closeAll();await proxyTransport.close();await admin.end()
}
