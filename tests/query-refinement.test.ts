import test from 'node:test'
import assert from 'node:assert/strict'
import {compileMongoScript,mongoPageOperation,mongoScriptMethods,mongoCursorMethods} from '../src/shared/mongo-query-script'
import {mongoCollectionSignatures,mongoCursorSignatures} from '../src/shared/mongo-completion'
import {mongoFindSettings,validateMongoScriptWrite} from '../src/main/operations/mongodb'
import {adapterOperationWrites} from '../src/main/connections/adapters'
import {editableMongoResult,resultJSON} from '../src/shared/query-results'
import type {MongoOperation,OperationResult} from '../src/shared/types'
test('Mongo completion signatures correspond to supported parser methods and retain snippet placeholders',()=>{
 for(const s of mongoCollectionSignatures.filter(s=>!s.reference))assert(mongoScriptMethods.includes(s.name as typeof mongoScriptMethods[number]),s.name)
 for(const s of mongoCursorSignatures.filter(s=>!s.reference))assert(mongoCursorMethods.includes(s.name as typeof mongoCursorMethods[number]),s.name)
 assert.equal(mongoCollectionSignatures.filter(s=>s.name==='find').length,4)
 assert(mongoCollectionSignatures.some(s=>s.name==='findOneAndUpdate'&&!s.reference))
 assert(mongoCollectionSignatures.some(s=>s.name==='findAndModify'&&s.reference))
})
test('Mongo find options and cursor modifiers stay typed and preserve pagination bounds',()=>{
 const plan=compileMongoScript('db.items.find({n:1},{n:1},{sort:{n:1},skip:10,limit:23,hint:"n_1",collation:{locale:"en",strength:2},batchSize:50,maxTimeMS:1200})','app',10)
 assert.equal(plan.operation.action,'mongo.find')
 if(plan.operation.action!=='mongo.find')throw Error('unexpected operation')
 assert.deepEqual(plan.operation.settings,{hint:'"n_1"',collation:'{"locale":"en","strength":2}',batchSize:50,maxTimeMS:1200})
 assert.equal(plan.baseOffset,10);assert.equal(plan.maxRows,23)
 const next=mongoPageOperation(plan,30,10)
 assert.equal(next?.action,'mongo.find')
 if(next?.action==='mongo.find')assert.equal(next.limit,3)
 const parsed=mongoFindSettings(plan.operation.settings)
 assert.equal(parsed.hint,'n_1');assert.equal(parsed.collation?.strength,2)
 assert.equal(compileMongoScript('db.items.find().hint({_id:1}).batchSize(10).pretty().toArray()','app').operation.action,'mongo.find')
 assert.equal(compileMongoScript('db.items.getIndexes()','app').operation.action,'mongo.indexes')
 assert.equal(compileMongoScript('db.items.estimatedDocumentCount()','app').operation.action,'mongo.estimateCount')
 for(const bad of ['db.items.find({},{},{readPreference:"secondary"})','db.items.find({},{},{limit:5}).limit(6)','db.items.find().maxTimeMS(31000)','db.items.find().batchSize(0)'])assert.throws(()=>compileMongoScript(bad,'app'),/MONGO_SCRIPT_INVALID/)
 assert.throws(()=>mongoFindSettings({maxTimeMS:30001}),/MONGO_POLICY/)
 assert.throws(()=>mongoFindSettings({hint:'{"x":0}'}),/MONGO_POLICY/)
 assert.throws(()=>mongoFindSettings({collation:'{"locale":"en","unexpected":1}'}),/MONGO_POLICY/)
})
test('new shell-style mutations are typed and always require write confirmation; no empty filters or JavaScript',()=>{
 const op=compileMongoScript('db.items.findOneAndUpdate({_id:NumberLong("9223372036854775807")},{$set:{value:"new"}},{returnDocument:"after"})','app').operation
 assert.equal(op.action,'mongo.scriptWrite')
 if(op.action!=='mongo.scriptWrite')throw Error('unexpected')
 assert.equal(op.method,'findOneAndUpdate');assert.equal(op.confirmed,true)
 assert(adapterOperationWrites('mongodb',op,true))
 const checked=validateMongoScriptWrite(op)
 assert.equal(String(checked.filter._id),'9223372036854775807');assert.equal(checked.opts.returnDocument,'after')
 for(const text of ['db.items.deleteMany({})','db.items.updateOne({n:1},{$set:{x:2}},{arrayFilters:[]})','db.items.findOneAndDelete({x:process.env})','db.items.updateMany({n:1},[{$set:{n:2}}])'])assert.throws(()=>compileMongoScript(text,'app'),/MONGO_SCRIPT_INVALID/)
 assert.throws(()=>validateMongoScriptWrite({...op,filter:'{}'}),/MONGO_POLICY/)
 assert.throws(()=>validateMongoScriptWrite({...op,value:'{"$set":{"x":{"$function":{}}}}'}),/MONGO_POLICY/)
 assert.throws(()=>validateMongoScriptWrite({...op,value:'{"$bad":{"x":1}}'}),/MONGO_POLICY/)
})
test('only complete current Mongo find results may become record drafts; canonical EJSON export retains exact data',()=>{
 const doc='{"_id":{"$oid":"64b000000000000000000001"},"wide":{"$numberLong":"9223372036854775807"}}'
 const result:OperationResult={columns:['_id','wide'],rows:[{_id:'64b000000000000000000001',wide:'9223372036854775807'}],documents:[doc],bsonTypes:[{type:'Document',children:{_id:{type:'ObjectId'},wide:{type:'Int64'}}}]}
 const find={action:'mongo.find',database:'app',entity:'items',projection:'{}'} as const
 assert(editableMongoResult(find,result,0))
 assert(!editableMongoResult({...find,projection:'{"wide":1}'},result,0))
 assert(!editableMongoResult({action:'mongo.aggregate',database:'app',entity:'items',pipeline:'[]'},result,0))
 assert.equal(resultJSON(result),'['+doc+']')
})
