import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeMigrationRequest} from '../src/shared/migration'
import {makeSchemaObject,parseMysqlShape,planMysqlMigration} from '../src/main/migration/mysql-schema'
const ddl=(body:string,options='ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci')=>'CREATE TABLE `items` (\n  '+body+'\n) '+options
const obj=(definition:string,triggers:string[]=[])=>makeSchemaObject('items','BASE TABLE','InnoDB',definition,triggers)
const old=ddl('`id` bigint NOT NULL, PRIMARY KEY (`id`)')
test('schema comparison preserves literal content, ignores volatile AUTO_INCREMENT, and generates only safe additive DDL',()=>{
 const current=ddl("`id` bigint NOT NULL, `label` varchar(120) DEFAULT 'a,b (c)''d', PRIMARY KEY (`id`), KEY `idx` (`label`)")
 const shape=parseMysqlShape('items',current)!
 assert(shape.safe);assert.equal(shape.columns.length,2);assert.equal(shape.indexes.length,2)
 const p=planMysqlMigration({objects:[obj(current)]},{objects:[obj(old)]},'schema','destination','mysql','mysql')[0]!
 assert.equal(p.action,'alter');assert(p.executable);assert.match(p.sql[0]!,/^ALTER TABLE `destination`.`items`/)
 assert.match(p.sql[0]!,/ADD COLUMN `label`/);assert.match(p.sql[0]!,/ADD KEY `idx`/)
 const a=ddl('`id` bigint NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)','ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4')
 const b=a.replace('AUTO_INCREMENT=10','AUTO_INCREMENT=99')
 assert.equal(planMysqlMigration({objects:[obj(a)]},{objects:[obj(b)]},'schema','destination','mysql','mysql')[0]?.action,'same')
 const missing=planMysqlMigration({objects:[obj(a)]},{objects:[]},'structure-data','destination','mysql','mysql')[0]!
 assert(missing.transfer&&missing.executable);assert(!missing.sql[0]?.includes('AUTO_INCREMENT=10'))
})
test('dangerous, opaque and engine-specific structure remains manual-only',()=>{
 for(const definition of [
  ddl('`id` bigint NOT NULL, `derived` int GENERATED ALWAYS AS (1) STORED, PRIMARY KEY (`id`)'),
  ddl('`id` bigint NOT NULL, FOREIGN KEY (`id`) REFERENCES `other`.`x` (`id`)'),
  ddl('`id` bigint NOT NULL, CHECK (`id` > 0)'),
  ddl('`id` bigint NOT NULL','ENGINE=FEDERATED CONNECTION=\'mysql://fixture.invalid/db/table\''),
  ddl('`id` bigint NOT NULL','ENGINE=InnoDB DATA DIRECTORY=\'/tmp\''),
  ddl('`id` bigint NOT NULL','ENGINE=InnoDB ENGINE=FEDERATED'),
  ddl("`id` bigint NOT NULL, `label` varchar(20) DEFAULT 'a\\\\b'"),
  ddl('`id` bigint NOT NULL, KEY `expr` ((abs(`id`)))'),
  old+'; DROP DATABASE fixture',
  old+' /*!50100 PARTITION BY HASH(id) */'
 ]){
  const step=planMysqlMigration({objects:[obj(definition)]},{objects:[]},'schema','dst','mysql','mysql')[0]!
  assert.equal(step.executable,false,definition);assert.deepEqual(step.sql,[])
 }
 const modified=ddl('`id` int NOT NULL, PRIMARY KEY (`id`)')
 assert(!planMysqlMigration({objects:[obj(modified)]},{objects:[obj(old)]},'schema','dst','mysql','mysql')[0]?.executable)
 assert(!planMysqlMigration({objects:[obj(old,['some_trigger'])]},{objects:[]},'structure-data','dst','mysql','mysql')[0]?.executable)
 const targetOnly=planMysqlMigration({objects:[]},{objects:[obj(old)]},'schema','dst','mysql','mysql')[0]!
 assert.equal(targetOnly.action,'target-only');assert(!targetOnly.executable);assert.deepEqual(targetOnly.sql,[])
 assert(!planMysqlMigration({objects:[obj(old)]},{objects:[]},'schema','dst','mysql','mariadb')[0]?.executable)
})
test('data transfer requires a compatible column shape; duplicate or incompatible table definitions are not coerced',()=>{
 assert(planMysqlMigration({objects:[obj(old)]},{objects:[obj(old)]},'data','dst','mysql','mysql')[0]?.transfer)
 assert(!planMysqlMigration({objects:[obj(old)]},{objects:[obj(ddl('`id` int NOT NULL, PRIMARY KEY (`id`)'))]},'data','dst','mysql','mysql')[0]?.executable)
 const maria=old.replace('bigint NOT','bigint(20) NOT')
 assert(planMysqlMigration({objects:[obj(old)]},{objects:[obj(maria)]},'data','dst','mysql','mariadb')[0]?.executable)
})
test('migration requests require bounded explicit objects and reject invalid endpoints and self-copy',()=>{
 const source={connectionId:'source',database:'source_db'},target={connectionId:'target',database:'target_db'}
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'data'}),/MIGRATION_INPUT/)
 assert.throws(()=>normalizeMigrationRequest({source,target:source,mode:'schema'}),/MIGRATION_SAME_TARGET/)
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'data',objects:['bad\nname']}),/MIGRATION_INPUT/)
 assert.throws(()=>normalizeMigrationRequest({source,target,mode:'data',objects:Array.from({length:101},(_,i)=>'t'+i)}),/MIGRATION_INPUT/)
 assert.deepEqual(normalizeMigrationRequest({source,target,mode:'structure-data',objects:['a','a','b']}).objects,['a','b'])
})


test('same-family metadata comparison treats redundant collation spelling and index order as equivalent',()=>{
 const a=obj(ddl('`id` bigint NOT NULL, `label` varchar(20) DEFAULT NULL, PRIMARY KEY (`id`), KEY `a_idx` (`label`), KEY `b_idx` (`id`)'))
 const b=obj(ddl('`id` bigint NOT NULL, `label` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL, PRIMARY KEY (`id`), KEY `b_idx` (`id`), KEY `a_idx` (`label`)'))
 assert(a.shape?.safe&&b.shape?.safe)
 for(const item of [a,b])for(const column of item.shape!.columns)column.semantic=column.name==='id'?'bigint:not-null':'varchar:20:utf8mb4_general_ci:nullable'
 assert.equal(planMysqlMigration({objects:[a]},{objects:[b]},'schema','dst','mysql','mysql')[0]?.action,'same')
 assert.equal(planMysqlMigration({objects:[a]},{objects:[b]},'data','dst','mysql','mysql')[0]?.transfer,true)
 b.shape!.columns[1]!.semantic='varchar:20:utf8mb4_bin:nullable'
 assert.equal(planMysqlMigration({objects:[a]},{objects:[b]},'data','dst','mysql','mysql')[0]?.executable,false)
})
