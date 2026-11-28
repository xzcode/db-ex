import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeInspectorPreferences} from '../src/shared/inspector-preferences'
import {normalizeCatalogWidths} from '../src/shared/catalog-widths'
import {normalizePreferences,isLightTheme} from '../src/shared/preferences'
import {catalogInspection} from '../src/shared/catalog-inspection'
import {objectMenu} from '../src/shared/object-menu'
import {mongoCategoryNodes} from '../src/shared/mongo-catalog'
import {validateManagedCollection} from '../src/shared/database-admin'
import {nativeToolCommand} from '../src/main/operations/native-tools'
import {newConnectionConfig} from '../src/shared/connection-form'
import {adapterOperationWrites} from '../src/main/connections/adapters'
import type {ExplorerNode} from '../src/shared/types'
test('global inspector default and persisted layout, catalog widths and themes normalize safely',()=>{
 assert.deepEqual(normalizeInspectorPreferences(null),{open:true,tab:'info',expanded:false,width:310})
 assert.deepEqual(normalizeInspectorPreferences({open:false,tab:'ddl',expanded:true,width:440}),{open:false,tab:'ddl',expanded:true,width:440})
 assert.equal(normalizeInspectorPreferences({width:10000,tab:'bad'}).width,310)
 const widths=normalizeCatalogWidths(JSON.parse('{"mongodb:collections":{"name":240,"数据大小":180,"bad":1}}'))
 assert.equal(widths['mongodb:collections']?.name,240);assert.equal(widths['mongodb:collections']?.bad,undefined)
 for(const theme of ['gray','black','soft-light'])assert.equal(normalizePreferences({theme}).theme,theme)
 assert.equal(isLightTheme('soft-light'),true);assert.equal(isLightTheme('black'),false)
})
test('object menus distinguish all categories and read-only object scope',()=>{
 for(const node of mongoCategoryNodes('app')){
  const menu=objectMenu('mongodb',node,true)
  assert(menu.length&&menu.some(item=>item.action==='refresh'),node.category)
  assert.equal(menu.some(item=>item.action==='create-collection'),node.category==='collections')
 }
 const node:ExplorerNode={id:'collection',kind:'collection',database:'app',entity:'items',label:'items'}
 const menu=objectMenu('mongodb',node,true)
 assert(menu.some(m=>m.action==='drop-collection'&&!m.disabled))
 assert(objectMenu('mongodb',{...node,database:'admin'},true).find(m=>m.action==='drop-collection')?.disabled)
 assert(objectMenu('mongodb',{...node,entity:'fs.files'},true).find(m=>m.action==='clear-collection')?.disabled)
 assert.deepEqual(catalogInspection('mongodb',node),{action:'mongo.inspect',database:'app',entity:'items'})
 assert.equal(catalogInspection('mongodb',{...node,kind:'mongo-category'}),undefined)
 assert.equal(catalogInspection('mongodb',{...node,kind:'gridfs-bucket'}),undefined)
 assert(objectMenu('mysql',{...node,kind:'table'},true).some(m=>m.action==='structure'))
 assert.throws(()=>validateManagedCollection('system.js'))
 assert.throws(()=>validateManagedCollection('fs.chunks'))
 assert.throws(()=>validateManagedCollection('foo\\bar'))
 for(const action of ['mongo.createCollection','mongo.renameCollection','mongo.dropCollection','mongo.clearCollection'] as const)assert(adapterOperationWrites('mongodb',{action,database:'app',entity:'items',newName:'next',confirmed:true},true))
})
test('collection native dump and restore never broaden to the whole database',()=>{
 const config=newConnectionConfig('mongodb')
 const backup=nativeToolCommand('mongo-backup',config,'app','items','/tmp/credentials','/tmp/archive')
 assert(backup.args.includes('--collection=items'))
 const restore=nativeToolCommand('mongo-restore',config,'app','items','/tmp/credentials','/tmp/archive')
 assert(restore.args.includes('--nsInclude=app.items'));assert(!restore.args.includes('--nsInclude=app.*'));assert(!restore.args.includes('--drop'))
 for(const entity of ['*','a?b','a\\b'])assert.throws(()=>nativeToolCommand('mongo-restore',config,'app',entity,'/tmp/credentials','/tmp/archive'))
})
