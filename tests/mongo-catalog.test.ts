import test from 'node:test'
import assert from 'node:assert/strict'
import { mongoCategoryNodes,mongoCatalogNodes } from '../src/shared/mongo-catalog'
test('MongoDB categories distinguish real views and paired buckets',()=>{
  const entries=[{name:'users',type:'collection'},{name:'users_view',type:'view'},{name:'system.js',type:'collection'},{name:'fs.files',type:'collection'},{name:'fs.chunks',type:'collection'},{name:'unpaired.files',type:'collection'},{name:'metrics',type:'timeseries'}]
  assert.deepEqual(mongoCategoryNodes('app').map(x=>x.category),['collections','views','functions','indexes','mapReduce','pipelines','gridfs','queries'])
  assert(!mongoCatalogNodes('app',entries,'collections').some(x=>x.entity==='users_view'||x.entity==='system.js'))
  assert(mongoCatalogNodes('app',entries,'collections').some(x=>x.entity==='metrics'))
  assert.equal(mongoCatalogNodes('app',entries,'views')[0].readOnly,true)
  assert.equal(mongoCatalogNodes('app',entries,'functions')[0].entity,'system.js')
  assert(mongoCatalogNodes('app',entries,'indexes').every(x=>x.kind==='mongo-indexes'))
  assert.deepEqual(mongoCatalogNodes('app',entries,'gridfs').map(x=>[x.label,x.entity,x.readOnly]),[['fs','fs.files',true]])
  assert.notEqual(mongoCatalogNodes('app',entries,'collections')[0].id,mongoCatalogNodes('app',entries,'indexes')[0].id)
})
