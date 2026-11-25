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
