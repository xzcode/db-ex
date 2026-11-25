import test from 'node:test'
import assert from 'node:assert/strict'
import { sqlContext,mongoSuggestions,redisSuggestions } from '../src/shared/editor-completion'
import { normalizePreferences } from '../src/shared/preferences'
test('completion distinguishes known table/field positions and provides engine vocabulary',()=>{
 assert.equal(sqlContext('SELECT * FROM us'),'table');assert.equal(sqlContext('SELECT na'),'field')
 assert.ok(mongoSuggestions.includes('$match'));assert.ok(redisSuggestions.includes('HGET'))
 assert.equal(normalizePreferences({startup:'workspace',records:{sqlitePageSize:500}}).startup,'workspace')
 assert.equal(normalizePreferences({records:{sqlitePageSize:500}}).records.sqlitePageSize,500)
})
