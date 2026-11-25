import test from 'node:test'
import assert from 'node:assert/strict'
import {compileMongoScript,mongoPageOperation,legacyMongoScript} from '../src/shared/mongo-query-script'
import {normalizeQueryDraft,portableQuery,readPortableQuery} from '../src/shared/saved-query'
import {formatQuery} from '../src/shared/query-format'
test('native Mongo shell expressions compile to guarded operations without evaluating JavaScript',()=>{
 const plan=compileMongoScript('db.users.find({score: {$gte: NumberInt(7)}, id: NumberLong("9223372036854775807"), _id: ObjectId("0123456789abcdef01234567")}, {id:1}).sort({score:-1}).skip(20).limit(103);','app',100)
 assert.deepEqual(plan,{operation:{action:'mongo.find',database:'app',entity:'users',filter:'{"score":{"$gte":{"$numberInt":"7"}},"id":{"$numberLong":"9223372036854775807"},"_id":{"$oid":"0123456789abcdef01234567"}}',projection:'{"id":1}',sort:'{"score":-1}',offset:20,limit:100},maxRows:103,baseOffset:20})
 const next=mongoPageOperation(plan,120,100)
 assert.equal(next?.action,'mongo.find')
 assert.equal(next&&'limit'in next?next.limit:0,3)
 assert.equal(mongoPageOperation(plan,123,100),undefined)
 assert.deepEqual(compileMongoScript('db.getCollection("a.b").findOne({name:/test/i})','app').operation,{action:'mongo.find',database:'app',entity:'a.b',filter:'{"name":{"$regularExpression":{"pattern":"test","options":"i"}}}',projection:'{}',sort:'{}',offset:0,limit:1})
 assert.equal(compileMongoScript('db.users.aggregate([{$match:{active:true}},{$limit:4}])','app').operation.action,'mongo.aggregate')
 assert.equal(compileMongoScript('db.users.countDocuments({})','app').operation.action,'mongo.count')
 assert.deepEqual(compileMongoScript('db.users.insertOne({name:"Ada"})','app').operation,{action:'mongo.insert',database:'app',entity:'users',documents:['{"name":"Ada"}'],confirmed:true})
 assert.equal(compileMongoScript('db.users.createIndex({score:1},{unique:true})','app').operation.action,'mongo.createIndex')
 for(const value of ['db.users.find({});db.users.drop()','db.users.find({x:process.env})','db.users.find({x:eval("1")})','db.users.find({...evil})','db.users.find({__proto__:{}})','db.users.find({x:1,x:2})','db.getSiblingDB("other").users.find({})','db.users.find({}).limit(-1)','db.users.find({x:9223372036854775807})','db.users.updateMany({},{$set:{x:1}})','db.users.insertOne()','db.users.find({x:()=>1})'])assert.throws(()=>compileMongoScript(value,'app'),/MONGO_SCRIPT_INVALID/)
})
test('saved queries preserve old filters and new raw text including incomplete drafts',()=>{
 const old=legacyMongoScript('mongo-find','a.b',JSON.stringify({filter:'{"a":{"$numberLong":"9223372036854775807"}}',projection:'{}',sort:'{"a":-1}'}))
 const plan=compileMongoScript(old,'app')
 assert.equal(plan.operation.action,'mongo.find')
 const raw=normalizeQueryDraft('mongodb',{name:'draft',mode:'mongo-find',syntax:'mongo-shell',text:'db.users.find('})
 assert.equal(raw.text,'db.users.find(')
 assert.equal(raw.syntax,'mongo-shell')
 const portable=portableQuery({...raw,kind:'mongodb',database:'app',connectionId:'one',id:'id',createdAt:'now',updatedAt:'now',revision:'r'})
 assert.deepEqual(readPortableQuery('mongodb','mongo-find',JSON.stringify(portable),'query',false),raw)
})
test('query formatting preserves supported Mongo operations and supports all SQL engines',async()=>{
 const text='db.users.find({x:NumberLong("9223372036854775807"),name:"x"}).limit(3)'
 const pretty=await formatQuery(text,'mongodb')
 assert.notEqual(pretty,text)
 assert.deepEqual(compileMongoScript(pretty,'app'),compileMongoScript(text,'app'))
 for(const engine of ['mysql','mariadb','sqlite','clickhouse'] as const){
  const sql=await formatQuery("select id from users where name = 'select 1'",engine)
  assert.match(sql,/SELECT/)
  assert.match(sql,/'select 1'/)
 }
 await assert.rejects(()=>formatQuery('db.users.find(','mongodb'))
})
