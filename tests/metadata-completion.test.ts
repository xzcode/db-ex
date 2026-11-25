import test from 'node:test'
import assert from 'node:assert/strict'
import {inferMetadataTable,metadataKey,metadataFields,cachedMetadata,rememberMetadata} from '../src/renderer/metadata-completion'
test('metadata inference is restricted to visible table names and current database',()=>{
 const tables=['events','orders','odd name']
 assert.equal(inferMetadataTable('SELECT * FROM events',tables,'app'),'events')
 assert.equal(inferMetadataTable('SELECT * FROM app."odd name"',tables,'app'),'odd name')
 assert.equal(inferMetadataTable('SELECT * FROM other.events',tables,'app'),'')
 assert.equal(inferMetadataTable("SELECT 'FROM orders' FROM events",tables,'app'),'events')
 assert.equal(inferMetadataTable('/* FROM orders */ SELECT * FROM unknown',tables,'app'),'')
})
test('metadata caches preserve session and database isolation, explicit refresh and expiry',()=>{
 const a=metadataKey('one','app','events'),b=metadataKey('two','app','events'),c=metadataKey('one','other','events')
 assert.deepEqual(rememberMetadata(a,['id','id','note'],1),['id','note'])
 assert.equal(cachedMetadata(b,2),undefined);assert.equal(cachedMetadata(c,2),undefined)
 assert.deepEqual(rememberMetadata(a,['new'],2),['new'])
 assert.equal(cachedMetadata(a,302000),undefined)
 assert.deepEqual(metadataFields('clickhouse',{columns:['name'],rows:[{name:'id'}]}),['id'])
})
