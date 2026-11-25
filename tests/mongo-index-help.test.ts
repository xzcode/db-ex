import test from 'node:test'
import assert from 'node:assert/strict'
import {mongoIndexDirections,mongoIndexExamples,mongoIndexOptionHelp,mongoIndexExampleText} from '../src/shared/mongo-index-help'
import {catalogs,languages} from '../src/shared/i18n'
import {indexHelpCatalogs} from '../src/shared/i18n/catalog-index-help'
test('index help examples use only the existing supported keys, directions and options',()=>{
 const directions=new Set<unknown>([1,-1,'text','hashed','2d','2dsphere'])
 const options=new Set(['name','unique','sparse','hidden','expireAfterSeconds','partialFilterExpression'])
 assert.deepEqual(new Set(mongoIndexDirections.map(d=>JSON.parse(d.value))),directions)
 assert.deepEqual(new Set(mongoIndexOptionHelp.map(o=>o.name)),options)
 for(const example of mongoIndexExamples){
  const text=mongoIndexExampleText(example.id)!
  const keys=JSON.parse(text.keys),opts=JSON.parse(text.options)
  assert(Object.keys(keys).length>0&&Object.keys(keys).length<=32)
  assert(Object.values(keys).every(d=>directions.has(d)))
  assert(Object.keys(opts).every(k=>options.has(k)))
  assert(!(opts.sparse&&opts.partialFilterExpression))
  if(opts.expireAfterSeconds!==undefined)assert.equal(Object.keys(keys).length,1)
  if(Object.values(keys).includes('hashed'))assert.notEqual(opts.unique,true)
 }
 assert.equal(mongoIndexExampleText('unknown'),undefined)
})
test('MongoDB index help is localized for all supported languages',()=>{
 for(const {locale} of languages)if(locale!=='zh-CN')for(const key of Object.keys(indexHelpCatalogs.en))assert.ok(Object.hasOwn(catalogs[locale],key),locale+': '+key)
})
