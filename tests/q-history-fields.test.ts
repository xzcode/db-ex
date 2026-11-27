import test from 'node:test'
import assert from 'node:assert/strict'
import {queryExecution,normalizeQueryExecution,queryHistoryFor} from '../src/shared/query-history'
import {sqlTemporalParts,validateSqlTemporal} from '../src/shared/sql-temporal'
import {sqlCellValue} from '../src/shared/grid-edit'
import {appendBrowsePage} from '../src/shared/browse-navigation'
import type {QuerySnippet} from '../src/shared/types'
test('query execution metadata records preview counts, partial batch failure and stable codes without raw driver error text',()=>{
 const when='2026-11-27T08:00:00.000Z'
 const success=queryExecution(when,4.9,{columns:['id'],rows:[{id:'1'}],truncated:true})
 assert.deepEqual(normalizeQueryExecution(success),{executedAt:when,status:'success',durationMs:5,returnedRows:1,truncated:true})
 const cancelled=queryExecution(when,123,undefined,Error('Error invoking remote method: Error: CANCELLED: sensitive SQL'))
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.errorCode,'CANCELLED');assert(!JSON.stringify(cancelled).includes('sensitive'))
 const partial=queryExecution(when,100,undefined,undefined,{items:[{sql:'SELECT 1',result:{columns:['x'],rows:[{x:'1'}]}}],total:3,error:'DATABASE_ERROR: failed',failedAt:2})
 assert.equal(partial.status,'failed');assert.equal(partial.statements,3);assert.equal(partial.completed,1);assert.equal(partial.returnedRows,1)
 assert.throws(()=>normalizeQueryExecution({...partial,completed:4}))
 assert.throws(()=>normalizeQueryExecution({...partial,errorCode:'user/password'}))
 assert.equal(normalizeQueryExecution(undefined),undefined)
})
test('history filters saved connection and database; execution timestamp is independent of favorite edits',()=>{
 const base:QuerySnippet={id:'a',name:'query',kind:'mysql',database:'app',connectionId:'profile',text:'SELECT 1',favorite:true,updatedAt:'2026-11-27T10:00:00.000Z'}
 const a={...base,execution:queryExecution('2026-11-27T08:00:00.000Z',12,{columns:[],rows:[]})}
 const b={...base,id:'b',updatedAt:'2026-11-27T09:00:00.000Z'}
 assert.deepEqual(queryHistoryFor([a,b,{...base,id:'c',connectionId:'other'},{...base,id:'d',database:'other'}],'mysql','profile','app').map(i=>i.id),['b','a'])
})
test('SQL temporal edits preserve fractions, calendar and duration without JS timezone conversion',()=>{
 const value='2024-02-29 23:59:59.123456'
 assert.deepEqual(sqlTemporalParts('DATETIME(6)',value),{date:'2024-02-29',time:'23:59:59.123456'})
 assert.equal(sqlCellValue('mysql','TIMESTAMP(6)',value,'2024-01-01 00:00:00'),value)
 assert.equal(validateSqlTemporal('TIME(6)','-838:59:59.000001'),'-838:59:59.000001')
 for(const [type,text] of [['DATE','1900-02-29'],['DATETIME(3)','2024-02-29 12:00:00.1234'],['TIME','839:00:00'],['TIMESTAMP','2024-01-01T00:00:00Z']])assert.throws(()=>validateSqlTemporal(type!,text!),/INVALID_TEMPORAL/)
 assert.equal(validateSqlTemporal('DATE','2000-02-29'),'2000-02-29')
})
test('continuous browse retains exact binary metadata aligned across pages',()=>{
 const a={columns:['blob'],rows:[{blob:'x'}],nextOffset:1}
 const b={columns:['blob'],rows:[{blob:'y'}],binaryCells:[{blob:'AA=='}]}
 assert.deepEqual(appendBrowsePage(a,b,'sqlite').binaryCells,[{},{blob:'AA=='}])
})
