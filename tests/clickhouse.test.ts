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
