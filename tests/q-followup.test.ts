import test from 'node:test'
import assert from 'node:assert/strict'
import {editBsonTree,treeNodes} from '../src/shared/bson-tree-edit'
import {recordLocator,appendBrowsePage} from '../src/shared/browse-navigation'
import {planReadBatch} from '../src/main/operations/query-batch'
import {FilePresetStore} from '../src/main/storage/file-presets'
import type {FileTransferPreset} from '../src/shared/file-transfer'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {inspectFile} from '../src/main/file-transfer/records'

test('nested document mutations keep typed values and protect _id and BSON wrappers',()=>{
 const before='{"_id":{"$oid":"64b000000000000000000001"},"nested":{"wide":{"$numberLong":"9223372036854775807"},"items":[1,"two"]}}'
 const a=editBsonTree(before,{action:'rename',path:['nested','wide'],name:'renamed'})
 const b=editBsonTree(a,{action:'add',path:['nested','items'],name:'',value:'Long("9007199254740993")'})
 const c=editBsonTree(b,{action:'remove',path:['nested','items','0']})
 assert.deepEqual(JSON.parse(c).nested,{renamed:{$numberLong:'9223372036854775807'},items:['two',{$numberLong:'9007199254740993'}]})
 assert.throws(()=>editBsonTree(c,{action:'remove',path:['_id']}))
 assert.throws(()=>editBsonTree(c,{action:'set',path:['nested','renamed','$numberLong'],value:'"0"'}))
 assert.throws(()=>editBsonTree(c,{action:'add',path:['nested'],name:'__proto__',value:'{}'}))
 assert.throws(()=>editBsonTree(c,{action:'set',path:['nested','renamed'],value:'9007199254740993'}))
 assert(treeNodes(c,new Set(['[]','["nested"]'])).some(n=>n.type==='Int64'))
})
test('locator uses complete primary-key tuple and typed Mongo ObjectId; appended metadata stays aligned',()=>{
 const mongo=recordLocator('mongodb','app','items',['_id'],[{field:'_id',type:'ObjectId',value:'64b000000000000000000001'}])
 assert.deepEqual(JSON.parse(mongo.mongo!.filter),{_id:{$eq:{$oid:'64b000000000000000000001'}}})
 assert.throws(()=>recordLocator('mysql','app','items',['id','part'],[{field:'id',type:'Long',value:'1'}]))
 const a={columns:['a'],rows:[{a:'1'}],nextOffset:1,documents:['{"a":"1"}']}
 const b={columns:['b'],rows:[{b:'2'}],documents:['{"b":"2"}']}
 const next=appendBrowsePage(a,b,'mongodb');assert.deepEqual(next.columns,['a','b']);assert.equal(next.documents?.length,2)
 assert.throws(()=>appendBrowsePage(a,b,'mysql'))
})
test('read batch validates all statements before execution and distributes bound parameters',()=>{
 const plan=planReadBatch('sqlite',{database:'main',text:"SELECT '?' AS q; SELECT ? AS n; -- ignored",parameters:['9223372036854775807'],limit:100})
 assert.equal(plan.length,2);assert.deepEqual((plan[1] as any).parameters,['9223372036854775807'])
 assert.throws(()=>planReadBatch('sqlite',{database:'main',text:'SELECT 1; DELETE FROM records',parameters:[],limit:100}),/SQL_POLICY/)
 assert.throws(()=>planReadBatch('mysql',{database:'app',text:'SELECT ?; SELECT ?',parameters:[1],limit:100}),/SQL_POLICY/)
})
test('file presets are object scoped and do not persist file tokens or filter literals',async()=>{
 let rows:FileTransferPreset[]=[]
 const store=new FilePresetStore({read:async()=>structuredClone(rows),write:async values=>{rows=structuredClone(values)}})
 const scope={connectionId:'saved',kind:'mysql' as const,database:'app',entity:'users',direction:'import' as const}
 const draft={name:'A',options:{format:'csv' as const,delimiter:';',encoding:'gb18030' as const,mapping:[{source:'id',target:'id',conversion:'integer' as const}],token:'not saved',filter:{secret:'not saved'}},useCurrentFilter:true}
 const item=await store.save(scope,draft)
 assert(!JSON.stringify(item).includes('not saved'));assert.equal(item.options.encoding,'gb18030');assert.equal(item.useCurrentFilter,false)
 assert.equal((await store.list({...scope,entity:'other'})).length,0)
 await store.remove({...scope,entity:'other'},item.id);assert.equal((await store.list(scope)).length,1)
})
test('streaming file preview decodes UTF-16 and GB18030 without changing content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-encoding-'))
 try{
  const a=join(dir,'utf16.csv'),b=join(dir,'gb.csv')
  await writeFile(a,Buffer.concat([Buffer.from([255,254]),Buffer.from('id,name\r\n1,中文\r\n','utf16le')]))
  await writeFile(b,Buffer.concat([Buffer.from('id,name\r\n1,'),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('\r\n')]))
  assert.equal((await inspectFile(a,'csv',',','utf-16le')).sample[0]?.name,'中文')
  assert.equal((await inspectFile(b,'csv',',','gb18030')).sample[0]?.name,'中文')
 }finally{await rm(dir,{recursive:true,force:true})}
})
