import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {MigrationHistory,normalizeMigrationHistory} from '../src/main/migration/history'
import {normalizeMigrationRequest,migrationPolicies} from '../src/shared/migration'
import {sqlMigrationCondition} from '../src/main/migration/condition'
import {mongoMigrationFilter} from '../src/main/migration/mongo-condition'
import {mysqlUpsertKeys,parseMysqlShape} from '../src/main/migration/mysql-schema'
import type {MigrationJob} from '../src/shared/migration'
import {BSON} from 'mongodb'
const job=():MigrationJob=>({id:randomUUID(),planId:randomUUID(),state:'running',startedAt:1,phase:'checking',total:1,completed:[],created:[],rowsRead:0,rowsCommitted:0,rowsPending:0,bytesRead:0,selectedObjects:['records'],policy:'append'})
test('migration history keeps committed object checkpoints; interrupted tasks become uncertain, never replayed',async()=>{
 let stored:MigrationJob[]=[]
 const io={async load(){return structuredClone(stored)},async save(value:MigrationJob[]){stored=structuredClone(value)}}
 const a=new MigrationHistory(io);await a.init()
 const running=job()
 await a.put(running)
 running.completed=['first'];running.rowsCommitted=12;running.current='second'
 await a.put(running)
 const b=new MigrationHistory(io);await b.init()
 const recovered=b.list()[0]!
 assert.equal(recovered.state,'uncertain');assert.equal(recovered.current,'second');assert.equal(recovered.rowsCommitted,12);assert.match(recovered.error||'',/MIGRATION_INTERRUPTED/)
 assert.equal(stored[0]?.state,'uncertain')
 await b.remove(recovered.id);assert.equal(stored.length,0)
})
test('migration history refuses writes before initialization and preserves valid records on failed storage',async()=>{
 let stored:MigrationJob[]=[];let fail=false
 const h=new MigrationHistory({async load(){return stored},async save(v){if(fail)throw Error('disk');stored=structuredClone(v)}})
 await assert.rejects(()=>h.put(job()),/MIGRATION_HISTORY/)
 await h.init();const first=job();await h.put(first)
 fail=true;await assert.rejects(()=>h.put(job()),/MIGRATION_HISTORY/)
 assert.deepEqual(h.list(),[first]);assert.equal(stored.length,1)
 assert.throws(()=>normalizeMigrationHistory([{...first,state:'fake'}]),/MIGRATION_HISTORY/)
})
test('migration policies and typed conditions are explicitly bounded; filter values remain bound',()=>{
 const source={connectionId:'s',database:'a'},target={connectionId:'t',database:'b'}
 const condition={field:'label',operator:'eq' as const,type:'String' as const,value:"quote ' OR 1=1 --"}
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'data',objects:['a','b'],condition}),/MIGRATION_CONDITION/)
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'data',objects:['a'],condition,policy:'replace'}),/MIGRATION_CONDITION/)
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'schema',policy:'upsert'}),/MIGRATION_INPUT/)
 assert.deepEqual(migrationPolicies('clickhouse'),['append'])
 const req=normalizeMigrationRequest({source,target,mode:'data',objects:['a'],condition,policy:'upsert'})
 assert.equal(req.policy,'upsert')
 const sql=sqlMigrationCondition(condition,['label'],'mysql')
 assert(!sql.where.includes(condition.value));assert.deepEqual(sql.parameters,[condition.value])
 assert.throws(()=>sqlMigrationCondition(condition,['other'],'sqlite'),/MIGRATION_CONDITION/)
 const predicate=mongoMigrationFilter({field:'_id',operator:'eq',type:'ObjectId',value:'64b000000000000000000001'})
 assert(predicate._id.$eq instanceof BSON.ObjectId)
})
test('MySQL upsert only supports an ordinary primary key without alternate unique indexes',()=>{
 const base='CREATE TABLE `items` (`id` bigint NOT NULL, `value` varchar(100) DEFAULT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
 assert.deepEqual(mysqlUpsertKeys(parseMysqlShape('items',base)),['id'])
 assert.equal(mysqlUpsertKeys(parseMysqlShape('items',base.replace('PRIMARY KEY (`id`)','PRIMARY KEY (`id`), UNIQUE KEY `unique_value` (`value`)'))),undefined)
})
