import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeGridLayout,visibleGridColumns,gridRange,tsvCell} from '../src/shared/grid-layout'
import {fieldCellSpec,prepareGridEdits} from '../src/shared/grid-edit'
import {BrowseProfileStore} from '../src/main/storage/browse-profiles'
import type {BrowseProfile,BrowseProfileDraft} from '../src/shared/browse-profile'
import {newBrowseFilter,browseOffset} from '../src/shared/browse-filter'
import {sqlStatements,currentSqlStatement} from '../src/shared/sql-statements'
import {inferMetadataReferences,inferCteMetadata} from '../src/renderer/metadata-completion'
import {dialectFunctions,sqlFunctionArgs} from '../src/shared/editor-completion'
import {csvRecords,mappedValue,sqlFileValue,sqlFileRow} from '../src/main/file-transfer/records'
import {normalizeFileTransfer} from '../src/shared/file-transfer'
import type {OperationResult} from '../src/shared/types'

test('Q1 grid layout retains only actual columns and protects the last visible column',()=>{
 const layout=normalizeGridLayout({order:['b','b','obsolete'],hidden:['a','b','c'],pinned:['b','obsolete'],widths:{b:9000,a:3}},['a','b','c'])
 assert.deepEqual(visibleGridColumns(layout),['b']);assert.equal(layout.widths.b,1600)
 assert.deepEqual(gridRange({row:8,column:4},{row:2,column:1}),{top:2,bottom:8,left:1,right:4})
 assert.equal(tsvCell('a\t"b"'),'"a\t""b"""')
})
test('Q2 canonical extended BSON field edits keep original identity and exact type wrappers',()=>{
 const original='{"_id":{"$oid":"0123456789abcdef01234567"},"nested":{"value":{"$numberLong":"9223372036854775807"}},"name":"Ada"}'
 const data:OperationResult={columns:['_id','nested','name'],rows:[{_id:'id',nested:'document',name:'Ada'}],documents:[original],bsonTypes:[{type:'Document',children:{_id:'ObjectId',nested:{type:'Document',children:{value:'Int64'}},name:'String'}}]}
 assert.equal(fieldCellSpec(data,null,'mongodb',[],0,'name')?.text,'"Ada"')
 assert.equal(fieldCellSpec(data,null,'mongodb',[],0,'nested')?.type,'EJSON')
 const next=prepareGridEdits(data,null,'mongodb',[],[{row:0,field:'nested',text:'{"value":{"$numberLong":"9007199254740993"}}',format:'ejson'}])
 assert.equal(next.mongoEdits[0]?.original,original)
 assert.equal(JSON.parse(next.mongoEdits[0]!.document).nested.value.$numberLong,'9007199254740993')
 assert.throws(()=>prepareGridEdits(data,null,'mongodb',[],[{row:0,field:'_id',text:'null',format:'ejson'}]))
})
test('Q3 profiles support multiple names and object-scoped update/delete',async()=>{
 let data:BrowseProfile[]=[]
 const store=new BrowseProfileStore({read:async()=>structuredClone(data),write:async next=>{data=structuredClone(next)}})
 const scope={connectionId:'saved',kind:'mysql' as const,database:'app',entity:'users'}
 const draft:BrowseProfileDraft={name:'A',filterMode:'builder',visualFilter:newBrowseFilter(),mongo:{filter:'{}',sort:'{}',projection:'{}'},pageSize:75,view:'grid'}
 const a=await store.save(scope,draft)
 await store.save(scope,{...draft,name:'B',pageSize:123})
 assert.equal((await store.list(scope)).length,2)
 assert.equal((await store.list({...scope,entity:'other'})).length,0)
 await assert.rejects(store.save({...scope,entity:'other'},draft,a.id),/INVALID_PROFILE/)
 await store.remove({...scope,entity:'other'},a.id);assert.equal((await store.list(scope)).length,2)
 await assert.rejects(store.save(scope,{...draft,name:'a'}),/INVALID_PROFILE/)
 assert.equal(browseOffset(3,75),150)
})
test('Q4 current-statement lexer respects quoted semicolons and comments; aliases retain table scope',()=>{
 const sql="SELECT ';' AS a; -- text;\nSELECT * FROM users u JOIN other.orders AS o ON o.user_id=u.id;"
 assert.equal(sqlStatements(sql).length,2);assert.match(currentSqlStatement(sql,sql.indexOf('JOIN')),/JOIN other.orders/)
 assert.deepEqual(inferMetadataReferences(sql,['users'],'app'),[{database:'app',table:'users',alias:'u'},{database:'other',table:'orders',alias:'o'}])
 assert(dialectFunctions('mysql').includes('JSON_EXTRACT'));assert.deepEqual(sqlFunctionArgs('JSON_EXTRACT'),['document','path'])
})
test('Q5 CSV parser handles chunk boundaries, CRLF, doubled quotes, delimiters and exact typed conversions',async()=>{
 async function* chunks(){yield 'id;note\r';yield '\n1;"a ';yield '""quote""\r\nb"\r\n';yield '2;end'}
 const rows:string[][]=[];for await(const row of csvRecords(chunks(),';'))rows.push(row)
 assert.deepEqual(rows,[['id','note'],['1','a "quote"\r\nb'],['2','end']])
 assert.equal(sqlFileValue(mappedValue('9223372036854775807','integer',false)),9223372036854775807n)
 assert.deepEqual(sqlFileValue(mappedValue('base64:AP8=','binary',false)),Buffer.from([0,255]))
 assert.deepEqual(sqlFileRow(['id','b'],[9223372036854775807n,Buffer.from([0,255])]),{id:{$dbexInteger:'9223372036854775807'},b:{$dbexBinary:'AP8='}})
 assert.throws(()=>normalizeFileTransfer({direction:'export',database:'app',entity:'t',format:'csv',delimiter:',',fields:[]},'mysql'))
})


test('Q4 CTE columns and aliases use local metadata, not physical table names',()=>{
 const sql='WITH RECURSIVE counts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counts WHERE n<3), totals AS (SELECT u.id, SUM(u.amount) AS total FROM users u GROUP BY u.id) SELECT c.n,t.total FROM counts c JOIN totals AS t ON t.id=c.n'
 const ctes=inferCteMetadata(sql)
 assert.deepEqual(ctes.names,['counts','totals'])
 assert.deepEqual(ctes.fields.counts,['n'])
 assert.deepEqual(ctes.fields.totals,['id','total'])
 assert.deepEqual(ctes.fields.c,['n'])
 assert.deepEqual(ctes.fields.t,['id','total'])
 assert.deepEqual(inferMetadataReferences(sql,['users','counts','totals'],'app'),[{database:'app',table:'users',alias:'u'}])
 assert.deepEqual(inferCteMetadata("SELECT 'WITH fake AS (SELECT 1)'").names,[])
 assert.deepEqual(inferCteMetadata('WITH a AS (SELECT * FROM users) SELECT * FROM a').fields.a,[])
 assert.deepEqual(inferCteMetadata('WITH "A"("x","y") AS MATERIALIZED (SELECT 1,2) SELECT * FROM "A" z').fields.z,['x','y'])
})

test('Q4 completion respects reported major/minor versions without promising optional server features',()=>{
 assert(!dialectFunctions('mysql','5.7.21').includes('ROW_NUMBER'))
 assert(!dialectFunctions('mysql','5.7.21').includes('JSON_ARRAYAGG'))
 assert(dialectFunctions('mysql','8.0.36').includes('ROW_NUMBER'))
 assert(dialectFunctions('mariadb','5.5.5-10.11.8-MariaDB').includes('JSON_TABLE'))
 assert(!dialectFunctions('mariadb','10.4.33-MariaDB').includes('JSON_TABLE'))
 assert(!dialectFunctions('sqlite','3.39.0').includes('timediff'))
 assert(dialectFunctions('sqlite','3.45.1').includes('concat_ws'))
 assert.deepEqual(sqlFunctionArgs('JSON_CONTAINS'),['document','candidate'])
})
