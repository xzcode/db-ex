import test from 'node:test'
import assert from 'node:assert/strict'
import {protectedDatabase,validateDatabaseName,validateInitialCollection} from '../src/shared/database-admin'
test('database DDL validates names, refuses protected databases, and requires a real Mongo collection name',()=>{
  assert.equal(validateDatabaseName('mongodb','game_login'),'game_login')
  assert.equal(validateDatabaseName('mysql','game-区域'),'game-区域')
  for(const name of ['admin','CONFIG','local','a.b','a/b','a b','a\0b','x'.repeat(64)])assert.throws(()=>validateDatabaseName('mongodb',name),/INVALID_DATABASE|PROTECTED_DATABASE/)
  for(const name of ['mysql','information_schema','PERFORMANCE_SCHEMA','sys','a\x60b','a/b'])assert.throws(()=>validateDatabaseName('mysql',name),/INVALID_DATABASE|PROTECTED_DATABASE/)
  assert.equal(protectedDatabase('mongodb','app'),false)
  assert.equal(validateInitialCollection('first_collection'),'first_collection')
  for(const name of ['','system.js','$cmd','abc\0def'])assert.throws(()=>validateInitialCollection(name),/INVALID_DATABASE/)
})
