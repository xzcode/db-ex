import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectClickHouseSql,clickHouseIdentifier,clickHouseParameters} from '../src/main/operations/clickhouse-policy'
import {decodeClickHouseLines} from '../src/main/operations/clickhouse'
import {adapterAllowsAction,adapterOperationWrites} from '../src/main/connections/adapters'
import {databaseCapabilities} from '../src/shared/database-capabilities'
import {normalizeDatabasePalette,databaseTypeColor} from '../src/shared/database-palette'
import {newConnectionConfig} from '../src/shared/connection-form'
import {normalizePreferences,pageSizeFor} from '../src/shared/preferences'
import {normalizeQueryDraft} from '../src/shared/saved-query'
test('ClickHouse has an analytical capability set and independent parameters and palette',()=>{
 assert.equal(databaseCapabilities('clickhouse').transactions,false)
 assert.equal(databaseCapabilities('clickhouse').rowEditing,'none')
 assert.equal(adapterAllowsAction('clickhouse','mysql.update'),false)
 assert.equal(adapterAllowsAction('mysql','clickhouse.insert'),false)
 assert.equal(adapterOperationWrites('clickhouse',{action:'clickhouse.query',sql:'SELECT 1'},false),false)
 assert.equal(newConnectionConfig('clickhouse').port,8123)
 assert.equal(pageSizeFor(normalizePreferences({records:{clickhousePageSize:500}}),'clickhouse'),500)
 const palette=normalizeDatabasePalette('clickhouse',{overrides:{UInt:'#123456'}})
 assert.equal(databaseTypeColor('clickhouse',palette,'Nullable(LowCardinality(UInt64))'),'#123456')
 assert.equal(normalizeQueryDraft('clickhouse',{name:'Read',mode:'sql',text:'SELECT {id:UInt64}'}).parameters,'{}')
})
test('ClickHouse policy rejects stacked statements, arbitrary settings and external table functions',()=>{
 assert.equal(inspectClickHouseSql("SELECT ';', {id:UInt64}; -- end").mode,'read')
 assert.equal(inspectClickHouseSql('CREATE TABLE t(id UInt64) ENGINE=MergeTree ORDER BY id').mode,'write')
 for(const sql of ['SELECT 1; DROP TABLE t','SELECT 1 SETTINGS readonly=0','SELECT 1 FORMAT CSV','SELECT * FROM url(\'https://example.test\')','ALTER TABLE t DELETE WHERE id=1','INSERT INTO t VALUES (1)','CREATE TABLE t (id UInt64) ENGINE=URL(\'https://example.test\')','DROP TABLE t ON CLUSTER c','SELECT /* unfinished'])assert.throws(()=>inspectClickHouseSql(sql),/SQL_POLICY/)
 assert.equal(clickHouseIdentifier('a"b'),'\"a\\"b\"')
 assert.equal(clickHouseParameters({id:'18446744073709551615'}).id,'18446744073709551615')
 assert.throws(()=>clickHouseParameters({id:9007199254740992}),/INVALID_INPUT/)
})
test('ClickHouse grid preserves numeric tokens, strings, nested values and nulls',()=>{
 const value=decodeClickHouseLines('["id","decimal","tags","nil","text"]\n["UInt128","Decimal(38,8)","Array(UInt64)","Nullable(String)","String"]\n[340282366920938463463374607431768211455,12345678901234567890.12345678,[18446744073709551615],null,"NULL"]\n',100,'fixture')
 assert.equal(value.rows[0]?.id,'340282366920938463463374607431768211455')
 assert.equal(value.rows[0]?.decimal,'12345678901234567890.12345678')
 assert.equal(value.rows[0]?.tags,'[18446744073709551615]')
 assert.equal(value.rawRows?.[0]?.nil,null)
 assert.equal(value.rawRows?.[0]?.text,'NULL')
 assert.deepEqual(value.nullCells,[[3]])
 const escaped=decodeClickHouseLines(JSON.stringify(['s','n'])+'\n'+JSON.stringify(['String','UInt64'])+'\n'+JSON.stringify(['a"b\\c,',7]),100,'fixture')
 assert.equal(escaped.rows[0]?.s,'a"b\\c,')
})

import {clickHouseManagementQuery} from '../src/main/operations/clickhouse-management'
import {ClickHouseOperations} from '../src/main/operations/clickhouse'
import {Readable} from 'node:stream'
import type {ClickHouseClient} from '@clickhouse/client'
import {validWorkbenchTab,normalizeWorkspace} from '../src/shared/workspace-recovery'
import {languages,translate} from '../src/shared/i18n'

test('ClickHouse management uses fixed object-scoped read-only SQL and bounded pages',async()=>{
 const names=['partitions','mutations','replicas','queries'] as const
 for(const view of names){
  const plan=clickHouseManagementQuery(view,{limit:10,offset:20})
  assert.match(plan.sql,/\{db:String\}/);assert.match(plan.sql,/\{table:String\}/)
  assert.match(plan.sql,/^SELECT /)
  if(view!=='queries')assert.match(plan.sql,/ LIMIT 11 OFFSET 20$/)
  assert.equal(adapterOperationWrites('clickhouse',{action:'clickhouse.management',database:'app',entity:'events',view},true),false)
 }
 assert.equal(clickHouseManagementQuery('queries',{limit:1,offset:200}).limit,3)
 for(const invalid of ['constructor','__proto__','DROP TABLE','',null,{}])assert.throws(()=>clickHouseManagementQuery(invalid,{}),/INVALID_INPUT/)
 assert.throws(()=>clickHouseManagementQuery('partitions',{limit:501}),/INVALID_INPUT/)
 assert.throws(()=>clickHouseManagementQuery('mutations',{offset:-1}),/INVALID_INPUT/)
 assert.equal(adapterAllowsAction('mysql','clickhouse.management'),false)
 const requests:any[]=[]
 const client={exec:async(input:any)=>{
  requests.push(input)
  return {stream:Readable.from(['["partition_id","rows"]\n["String","UInt64"]\n["p1",18446744073709551615]\n["p2",2]\n'])}
 }} as unknown as ClickHouseClient
 const ops=new ClickHouseOperations(client,()=>client)
 const value=await ops.execute({action:'clickhouse.management',database:"db'--",entity:'x"; DROP TABLE t',view:'partitions',limit:1},{writable:false,confirmed:false})
 assert.deepEqual(requests[0].query_params,{db:"db'--",table:'x"; DROP TABLE t'})
 assert.equal(requests[0].clickhouse_settings.readonly,'1')
 assert.equal(requests[0].query.includes('DROP TABLE'),false)
 assert.equal(value.rows[0]?.rows,'18446744073709551615')
 assert.equal(value.nextOffset,1)
 assert.equal(value.truncated,true)
})
test('ClickHouse management tab restores only on eligible tables and is localized',()=>{
 assert.equal(validWorkbenchTab('clickhouse','management'),'management')
 assert.equal(validWorkbenchTab('clickhouse','management',true),'data')
 assert.equal(validWorkbenchTab('mysql','management'),'data')
 assert.equal(normalizeWorkspace({ids:['ch'],positions:{ch:{tab:'management',node:{kind:'table',database:'app',entity:'events'}}}}).positions.ch?.tab,'management')
 for(const {locale} of languages)for(const key of ['管理','分区','变更任务','副本状态','查询统计','本节点 · 只读']){
  const label=translate(locale,key)
  assert(label.length>0)
  if(!locale.startsWith('zh')&&locale!=='ja')assert.notEqual(label,key)
 }
})

import {backupPlan,exactId,mergeTreeEngine,mutationPlan,userDatabase} from '../src/main/operations/clickhouse-admin'
import {byteBudget,streamClickHouse,transferFormat} from '../src/main/operations/clickhouse-transfer'
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {Writable} from 'node:stream'
test('ClickHouse advanced writes are separately classified and strictly scoped',()=>{
 const metadata=[{name:'id',type:'UInt64',is_in_primary_key:'1',is_in_sorting_key:'1',is_in_partition_key:'1',is_in_sampling_key:'0'},{name:'note',type:'Nullable(String)',is_in_primary_key:'0',is_in_sorting_key:'0',is_in_partition_key:'0',is_in_sampling_key:'0',default_kind:''}]
 const change={kind:'update',field:'id',match:'18446744073709551615',column:'note',value:"x'; DROP TABLE users"} as const
 const plan=mutationPlan(change,metadata,'"app"."events"')
 assert.match(plan.sql,/^ALTER TABLE "app"."events" UPDATE "note" = accurateCast\(\{value:String\}, \{valueType:String\}\) WHERE "id" = accurateCast/)
 assert.equal(plan.params.value,change.value);assert(!plan.sql.includes('DROP TABLE'))
 assert.throws(()=>mutationPlan({...change,column:'id'},metadata,'"app"."events"'),/INVALID_INPUT/)
 assert.throws(()=>mutationPlan({...change,field:'1=1'},metadata,'"app"."events"'),/INVALID_INPUT/)
 assert.throws(()=>exactId('../p'),/INVALID_INPUT/)
 assert.throws(()=>userDatabase('SYSTEM'),/INVALID_OPERATION/)
 assert.equal(mergeTreeEngine('ReplicatedReplacingMergeTree'),true)
 assert.equal(mergeTreeEngine('Distributed'),false)
 const backup=backupPlan('app','events',{kind:'backup',disk:'backups',file:'snapshot.zip'},'dbex-id')
 assert.match(backup.sql,/BACKUP TABLE "app"."events" TO Disk\('backups', 'snapshot.zip'\) SETTINGS id='dbex-id' ASYNC$/)
 const restore=backupPlan('app','events',{kind:'restore',disk:'backups',file:'snapshot.zip',newTable:'events_copy'},'dbex-id')
 assert.match(restore.sql,/RESTORE TABLE "app"."events" AS "app"."events_copy"/)
 for(const bad of ['../bad','/tmp/x','x/y',"x' OR 1=1",'..','https://example.test'])assert.throws(()=>backupPlan('app','events',{kind:'backup',disk:'backups',file:bad},'id'),/INVALID_INPUT/)
 assert.throws(()=>backupPlan('app','events',{kind:'restore',disk:'backups',file:'a',newTable:'events'},'id'),/INVALID_INPUT/)
 assert.equal(adapterOperationWrites('clickhouse',{action:'clickhouse.change',database:'app',entity:'events',change},false),true)
 assert.equal(adapterOperationWrites('clickhouse',{action:'clickhouse.mutationPreview',database:'app',entity:'events',change},true),false)
})
test('ClickHouse file transfer streams formats without overwriting, rejects oversize and cleans failed files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-ch-unit-'))
 const target={database:'app',entity:'events',direction:'export' as const,format:'parquet' as const}
 const content=Buffer.from([0x50,0x41,0x52,0x31,0x00,0xff,0x50,0x41,0x52,0x31])
 const calls:any[]=[]
 const client={exec:async(input:any)=>{calls.push(input);if(input.values){let bytes=0;for await(const c of input.values)bytes+=c.length;assert.equal(bytes,content.length);return {stream:Readable.from([])}}return {stream:Readable.from([content.subarray(0,4),content.subarray(4)])}}} as unknown as ClickHouseClient
 try{
  assert.equal(transferFormat('csv'),'CSVWithNames');assert.equal(transferFormat('jsonl'),'JSONEachRow');assert.throws(()=>transferFormat('constructor'),/INVALID_INPUT/)
  const file=join(dir,'fixture.parquet')
  assert.equal((await streamClickHouse(client,target,file,'"app"."events"',['"id"'])).bytes,content.length)
  assert.deepEqual(await readFile(file),content)
  assert.equal(calls[0].clickhouse_settings.readonly,'1')
  await assert.rejects(()=>streamClickHouse(client,target,file,'"app"."events"',['"id"']),/OUTPUT_EXISTS/)
  assert.deepEqual(await readFile(file),content)
  assert.equal((await streamClickHouse(client,{...target,direction:'import'},file,'"app"."events"',['"id"'])).bytes,content.length)
  assert.match(calls.at(-1).query,/FORMAT Parquet$/)
  const bad=byteBudget(3);await assert.rejects(()=>pipeline(Readable.from([Buffer.from('abcd')]),bad.stream,new Writable({write(_c,_e,cb){cb()}})),/LIMIT_EXCEEDED/)
  const abort=new AbortController();abort.abort();await assert.rejects(()=>streamClickHouse(client,target,join(dir,'cancelled.parquet'),'"app"."events"',['"id"'],abort.signal),/CANCELLED/)
  assert.deepEqual(await readdir(dir),['fixture.parquet'])
 }finally{await rm(dir,{recursive:true,force:true})}
})
