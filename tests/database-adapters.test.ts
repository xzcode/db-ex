import test from 'node:test'
import assert from 'node:assert/strict'
import { databaseAdapter, adapterAllowsAction, isKnownDatabaseAction } from '../src/main/connections/adapters'
import { databaseCapabilities } from '../src/shared/database-capabilities'
import type { DatabaseKind } from '../src/shared/types'
const kinds:DatabaseKind[]=['mysql','sqlite','mongodb','redis']
test('adapter registry matches implemented capabilities and rejects cross-engine actions',()=>{
  for(const kind of kinds){
    const adapter=databaseAdapter(kind),cap=databaseCapabilities(kind)
    assert.equal(adapter.kind,kind)
    assert.equal(Boolean(adapter.rollback),cap.transactions)
    assert.equal(new Set(adapter.actions).size,adapter.actions.length)
    for(const action of adapter.actions)assert.equal(adapterAllowsAction(kind,action),true)
  }
  assert.equal(adapterAllowsAction('sqlite','mysql.createDatabase'),false)
  assert.equal(adapterAllowsAction('sqlite','mysql.dropDatabase'),false)
  assert.equal(adapterAllowsAction('sqlite','mysql.query'),true)
  assert.equal(adapterAllowsAction('mysql','mongo.find'),false)
  assert.equal(adapterAllowsAction('mongodb','redis.command'),false)
  assert.equal(adapterAllowsAction('redis','mysql.rollback'),false)
  assert.equal(isKnownDatabaseAction('mysql.fake'),false)
  assert.equal(isKnownDatabaseAction('toString'),false)
  assert.throws(()=>databaseAdapter('__proto__' as DatabaseKind),/INVALID_OPERATION/)
})
test('preview operations preserve the existing dialect-specific IPC contract',()=>{
  assert.deepEqual(databaseAdapter('mysql').preview?.('app','users',100),{action:'mysql.query',database:'app',sql:'SELECT * FROM '+String.fromCharCode(96)+'app'+String.fromCharCode(96)+'.'+String.fromCharCode(96)+'users'+String.fromCharCode(96),offset:100,limit:100})
  assert.deepEqual(databaseAdapter('sqlite').preview?.('main','users',200),{action:'mysql.browse',database:'main',entity:'users',filter:{join:'and',groups:[],sort:[]},offset:200,limit:100})
  assert.deepEqual(databaseAdapter('mongodb').preview?.('app','users',50),{action:'mongo.find',database:'app',entity:'users',offset:50,limit:100})
  assert.equal(databaseAdapter('redis').preview,undefined)
})
