import test from 'node:test'
import assert from 'node:assert/strict'
import {BSON} from 'mongodb'
import {mappedCell} from '../src/main/migration/mapping'
import {normalizeMigrationRequest,migrationPairSupported,migrationRemaining,type MigrationTemplate} from '../src/shared/migration'
import {MigrationTemplateStore} from '../src/main/storage/migration-templates'
import {makeSchemaObject,planMysqlMigration} from '../src/main/migration/mysql-schema'
const target=(type:string)=>({name:'x',type,nullable:true})
test('mapped scalar values preserve exact signed/unsigned numbers, decimal scale and BSON types',()=>{
 assert.deepEqual(mappedCell('18446744073709551615','mysql','BIGINT UNSIGNED','mysql',target('BIGINT UNSIGNED'),'auto'),{$dbexInteger:'18446744073709551615'})
 assert.equal(mappedCell('18446744073709551615','mysql','BIGINT UNSIGNED','sqlite',target('TEXT'),'text'),'18446744073709551615')
 assert.throws(()=>mappedCell('18446744073709551615','mysql','BIGINT UNSIGNED','sqlite',target('INTEGER'),'auto'),/MIGRATION_TYPE/)
 assert.equal(mappedCell({$numberDecimal:'1.234567890123456789E+10'},'mongodb','','mysql',target('DECIMAL(30,8)'),'auto'),'12345678901.23456789')
 assert.throws(()=>mappedCell('1.2345','mysql','DECIMAL(10,4)','mysql',target('DECIMAL(10,2)'),'auto'),/MIGRATION_TYPE/)
 assert.throws(()=>mappedCell('12345678901234567890.12','mysql','DECIMAL(30,2)','sqlite',target('NUMERIC'),'auto'),/MIGRATION_TYPE/)
 assert.equal(mappedCell('12345678901234567890.12','mysql','DECIMAL(30,2)','sqlite',target('TEXT'),'text'),'12345678901234567890.12')
 assert.deepEqual(mappedCell({$dbexInteger:'9223372036854775807'},'sqlite','INTEGER','mongodb',target('BSON'),'auto'),{$numberLong:'9223372036854775807'})
 assert.equal(BSON.EJSON.parse(JSON.stringify(mappedCell('18446744073709551615','mysql','BIGINT UNSIGNED','mongodb',target('BSON'),'auto'))).toString(),'18446744073709551615')
 assert.deepEqual(mappedCell('64b000000000000000000001','sqlite','TEXT','mongodb',target('BSON'),'objectId'),{$oid:'64b000000000000000000001'})
 assert.deepEqual(mappedCell({$binary:{base64:'AP8=',subType:'00'}},'mongodb','','sqlite',target('BLOB'),'auto'),{$dbexBinary:'AP8='})
 assert.throws(()=>mappedCell({$binary:{base64:'AP8=',subType:'04'}},'mongodb','','sqlite',target('BLOB'),'auto'),/MIGRATION_TYPE/)
 assert.throws(()=>mappedCell({$dbexBinary:'AP8='},'sqlite','BLOB','mysql',target('BINARY(4)'),'auto'),/MIGRATION_TYPE/)
 assert.throws(()=>mappedCell('{"n":9007199254740993}','sqlite','TEXT','mongodb',target('BSON'),'ejson'),/MIGRATION_TYPE/)
 assert.throws(()=>mappedCell(null,'sqlite','TEXT','mysql',{...target('VARCHAR(20)'),nullable:false},'auto'),/MIGRATION_TYPE/)
})
const source={connectionId:'source',database:'main'},destination={connectionId:'target',database:'main'}
const request=normalizeMigrationRequest({source,target:destination,mode:'data',objects:['old'],mappings:[{source:'old',target:'new',fields:[{source:'id',target:'key',conversion:'integer'}],predicate:{text:'id >= ?',parameters:['1']}}]})
test('mapped plans enforce exact source/target identity, explicit data-only mapping and distinct target fields',()=>{
 assert(migrationPairSupported('mysql','sqlite','data'))
 assert(!migrationPairSupported('mysql','sqlite','schema'))
 assert(!migrationPairSupported('redis','sqlite','data'))
 assert.equal(request.mappings?.[0]?.target,'new')
 assert.throws(()=>normalizeMigrationRequest({...request,mode:'structure-data'}),/MIGRATION_MAPPING/)
 assert.throws(()=>normalizeMigrationRequest({...request,policy:'replace'}),/MIGRATION_CONDITION/)
 assert.throws(()=>normalizeMigrationRequest({...request,mappings:[{...request.mappings![0],fields:[{source:'id',target:'key',conversion:'auto'},{source:'other',target:'KEY',conversion:'text'}]}]}),/MIGRATION_MAPPING/)
 assert.throws(()=>normalizeMigrationRequest({...request,mappings:[{...request.mappings![0],predicate:{text:'id=1; DELETE FROM x',parameters:[]}}]}),/INVALID_FILTER/)
})
test('named template store serializes updates, strips unrelated secrets and reloads exact mapping configuration',async()=>{
 let stored:MigrationTemplate[]=[]
 const io={async read(){return structuredClone(stored)},async write(v:MigrationTemplate[]){stored=structuredClone(v)}}
 const store=new MigrationTemplateStore(io)
 const one=await store.save({name:'First',request:{...request,password:'do-not-store',source:{...source,password:'do-not-store'}}})
 const two=await store.save({name:'Second',request})
 assert.equal(stored.length,2);assert(!JSON.stringify(stored).includes('do-not-store'))
 await assert.rejects(store.save({name:'first',request}),/MIGRATION_TEMPLATE/)
 const update=await store.save({name:'Renamed',request},one.id)
 assert.equal(update.id,one.id)
 const reopened=new MigrationTemplateStore(io)
 assert.deepEqual((await reopened.list()).find(v=>v.id===one.id)?.request,request)
 await reopened.remove(two.id)
 assert.equal((await store.list()).length,1)
})
test('opt-in FK dependencies sort parent before child, require selected parents and reject cycles or cross-schema refs',()=>{
 const o=(name:string,body:string)=>makeSchemaObject(name,'BASE TABLE','InnoDB','CREATE TABLE '+String.fromCharCode(96)+name+String.fromCharCode(96)+' ('+body+') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',[])
 const q=(s:string)=>String.fromCharCode(96)+s+String.fromCharCode(96)
 const id=q('id')+' int NOT NULL, PRIMARY KEY ('+q('id')+')'
 const fk=(parent:string)=>', CONSTRAINT '+q('fk')+' FOREIGN KEY ('+q('id')+') REFERENCES '+q(parent)+' ('+q('id')+')'
 const parent=o('z_parent',id),child=o('a_child',id+fk('z_parent'))
 assert(child.shape?.safe)
 const snapshot={objects:[child,parent]}
 assert(!planMysqlMigration(snapshot,{objects:[]},'schema','dst','mysql','mysql').find(s=>s.name==='a_child')?.executable)
 const steps=planMysqlMigration(snapshot,{objects:[]},'structure-data','dst','mysql','mysql',true)
 assert.deepEqual(steps.map(s=>s.name),['z_parent','a_child'])
 assert(steps.every(s=>s.executable&&s.transfer));assert.deepEqual(steps[1]?.dependsOn,[steps[0]?.id])
 assert.match(steps[1]!.sql[0]!,/REFERENCES .dst.\..z_parent./)
 const cycle=planMysqlMigration({objects:[child,o('z_parent',id+fk('a_child'))]},{objects:[]},'schema','dst','mysql','mysql',true)
 assert(cycle.every(s=>!s.executable))
 assert(!planMysqlMigration({objects:[child]},{objects:[]},'schema','dst','mysql','mysql',true)[0]?.executable)
 const previous=o('records',q('id')+' int, '+q('last')+' int')
 const current=o('records',q('id')+' int, '+q('middle')+' varchar(20) DEFAULT NULL, '+q('last')+' int')
 const diff=planMysqlMigration({objects:[current]},{objects:[previous]},'structure-data','dst','mysql','mysql')[0]!
 assert(diff.executable&&diff.transfer);assert.match(diff.sql[0]!,/AFTER .id./)
})
