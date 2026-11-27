import {DatabaseSync,type SQLInputValue,type SQLOutputValue} from 'node:sqlite'
import {realpathSync,statSync} from 'node:fs'
import type {MigrationCatalog,MigrationPolicy,MigrationCondition} from '../../shared/migration'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import {sqliteQuote as q,safeSqliteField,sqliteShape,sqliteUpsertKeys,type SqliteField,type SqliteShape,type SqliteIndex} from './sqlite-shape'
import {sqlMigrationCondition} from './condition'
import {compileMysqlFilter,newBrowseFilter,type BrowseFilter} from '../../shared/browse-filter'
import {checkedSnapshot,limitObjectNames} from './endpoint'

export type WireCell={t:'int'|'real'|'text'|'blob'|'null';v?:string|number}
function encode(value:SQLOutputValue):WireCell{
 if(value===null)return {t:'null'}
 if(typeof value==='bigint')return {t:'int',v:value.toString()}
 if(typeof value==='number'&&Number.isFinite(value))return {t:'real',v:value}
 if(typeof value==='string')return {t:'text',v:value}
 if(value instanceof Uint8Array)return {t:'blob',v:Buffer.from(value).toString('base64')}
 throw new Error('MIGRATION_TYPE: 无法无损传输该字段值')
}
function decode(value:WireCell):SQLInputValue{
 switch(value.t){
 case 'null':return null
 case 'int':return BigInt(String(value.v))
 case 'real':if(typeof value.v==='number'&&Number.isFinite(value.v))return value.v;break
 case 'text':if(typeof value.v==='string')return value.v;break
 case 'blob':if(typeof value.v==='string')return Buffer.from(value.v,'base64');break
 }
 throw new Error('MIGRATION_TYPE: 无法无损传输该字段值')
}
// Reject SQL features not represented by the structured generator. Strip
// quoted identifiers and string literals first so names do not trigger it.
function ordinaryDdl(sql:string){
 const tokens=sql.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]/g,' Q ')
 return /^CREATE\s+TABLE\s+/i.test(tokens)&&!/(?:\b(?:CHECK|REFERENCES|FOREIGN|GENERATED|AS|AUTOINCREMENT|COLLATE|CONFLICT|DESC|CONSTRAINT|VIRTUAL)\b|--|\/\*|;)/i.test(tokens)
}
export class SqliteMigrationWorkerEngine{
 private db:DatabaseSync
 private path:string
 private stat:{dev:number;ino:number}
 private writable=false
 private iterator?:Iterator<Record<string,SQLOutputValue>>
 private held?:WireCell[]
 private readColumns:string[]=[]
 private insert?:ReturnType<DatabaseSync['prepare']>
 readonly identity:string
 constructor(path:string){
  this.path=realpathSync(path);const stat=statSync(this.path);if(!stat.isFile())throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  this.stat={dev:stat.dev,ino:stat.ino};this.identity='sqlite:'+stat.dev+':'+stat.ino
  this.db=this.open(true)
 }
 private open(readOnly:boolean){
  const s=statSync(this.path);if(s.dev!==this.stat.dev||s.ino!==this.stat.ino||!s.isFile())throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const db=new DatabaseSync(this.path,{readOnly,enableForeignKeyConstraints:true,allowExtension:false,enableDoubleQuotedStringLiterals:false})
  try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000');return db}catch(e){db.close();throw e}
 }
 private query(sql:string,...params:SQLInputValue[]){const p=this.db.prepare(sql);p.setReadBigInts(true);return p.all(...params)}
 private objects(){const r=this.query("SELECT name,type,sql FROM main.sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT 501");if(r.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限');return r}
 catalog(database?:string):MigrationCatalog{
  if(database!==undefined&&database!=='main')throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  return {kind:'sqlite',databases:['main'],...(database?{objects:this.objects().map(o=>({name:String(o.name),type:o.type==='table'?'BASE TABLE':'VIEW',engine:'SQLite'}))}:{})}
 }
 schema(database:string,names?:string[]):SchemaSnapshot{
  if(database!=='main')throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  const rows=limitObjectNames(this.objects().map(r=>({name:String(r.name),type:r.type,sql:r.sql})),names),objects:SchemaObject[]=[]
  for(const row of rows){
   const name=row.name,definition=String(row.sql||''),triggers=this.query("SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 501",name).map(x=>String(x.name))
   let details:SqliteShape|undefined
   if(row.type==='table'){
    const meta=this.query('SELECT * FROM pragma_table_list WHERE schema=? AND name=?','main',name)[0]
    const raw=this.query('SELECT name,type,"notnull",pk,hidden,dflt_value FROM pragma_table_xinfo(?,?) ORDER BY cid LIMIT 501',name,'main')
    const fields:SqliteField[]=raw.map(f=>({name:String(f.name),type:String(f.type).toUpperCase(),notnull:Number(f.notnull)!==0,pk:Number(f.pk),defaultValue:f.dflt_value===null?null:String(f.dflt_value)}))
    let safe=!!meta&&meta.type==='table'&&ordinaryDdl(definition)&&!triggers.length&&raw.length>0&&raw.length<=500&&raw.every(f=>Number(f.hidden)===0)&&fields.every(safeSqliteField)&&!this.query('SELECT * FROM pragma_foreign_key_list(?) LIMIT 1',name).length
    const indexes:SqliteIndex[]=[]
    for(const idx of this.query('SELECT * FROM pragma_index_list(?) LIMIT 501',name)){
     if(idx.origin==='pk'){const pkCols=this.query('SELECT * FROM pragma_index_xinfo(?)',String(idx.name)).filter(c=>Number(c.key)===1);if(pkCols.some(c=>Number(c.desc)!==0||String(c.coll).toUpperCase()!=='BINARY'))safe=false;continue}
     // Inline UNIQUE constraints and expression/partial/collated indexes
     // are not reconstructed as a superficially similar object.
     if(idx.origin!=='c'||Number(idx.partial)!==0){safe=false;continue}
     const cols=this.query('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno LIMIT 501',String(idx.name)).filter(c=>Number(c.key)===1)
     if(!cols.length||cols.some(c=>Number(c.cid)<0||Number(c.desc)!==0||String(c.coll).toUpperCase()!=='BINARY')){safe=false;continue}
     indexes.push({name:String(idx.name),columns:cols.map(c=>String(c.name)),unique:Number(idx.unique)!==0})
    }
    details={safe,fields,indexes:indexes.sort((a,b)=>a.name.localeCompare(b.name)),strict:Number(meta?.strict)===1,withoutRowid:Number(meta?.wr)===1}
   }
   objects.push({name,type:row.type==='table'?'BASE TABLE':'VIEW',engine:'SQLite',definition,triggerNames:triggers,details})
  }
  return checkedSnapshot(objects)
 }
 sourceSnapshot(){this.db.exec('BEGIN');this.db.prepare('SELECT name FROM main.sqlite_schema LIMIT 1').get()}
 prepareTarget(){if(!this.writable){const next=this.open(false);this.db.close();this.db=next;this.writable=true}}
 apply(sql:string[]){if(!this.writable)throw Error('READ_ONLY');this.db.exec('BEGIN IMMEDIATE');try{for(const statement of sql)this.db.exec(statement);this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}}
 beginTarget(name:string,expected:SqliteShape,policy:MigrationPolicy='append',columns?:string[]){
  if(!this.writable)throw Error('READ_ONLY')
  this.db.exec('BEGIN IMMEDIATE')
  const actual=sqliteShape(this.schema('main',[name]).objects[0])
  if(!actual?.safe||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const selected=columns||expected.fields.map(f=>f.name)
  if(!selected.length||selected.some(c=>!expected.fields.some(f=>f.name===c)))throw new Error('FILE_TRANSFER: 字段映射无效')
  let conflict=''
  if(policy!=='append'){
   for(const row of this.objects().filter(r=>r.type==='table')){
    if(this.query('SELECT "table" AS parent FROM pragma_foreign_key_list(?)',String(row.name)).some(r=>String(r.parent).toLowerCase()===name.toLowerCase()))throw new Error('MIGRATION_DEPENDENCY: 目标表存在外部外键引用')
   }
   if(policy==='replace')this.db.exec('DELETE FROM main.'+q(name))
   else if(policy==='upsert'){
    const keys=sqliteUpsertKeys(actual)
    if(!keys||keys.some(k=>!selected.includes(k)))throw new Error('MIGRATION_DEPENDENCY: 插入更新需要相同的主键')
    const fields=selected.filter(f=>!keys.includes(f))
    const updates=fields.length?fields:[keys[0]!]
    conflict=' ON CONFLICT ('+keys.map(q).join(',')+') DO UPDATE SET '+updates.map(n=>q(n)+'=excluded.'+q(n)).join(',')
   }else throw new Error('MIGRATION_INPUT: 迁移参数无效')
  }
  this.insert=this.db.prepare('INSERT INTO main.'+q(name)+' ('+selected.map(q).join(',')+') VALUES ('+selected.map(()=>'?').join(',')+')'+conflict)
 }
 beginRead(name:string,expected:SqliteShape,condition?:MigrationCondition){
  const actual=sqliteShape(this.schema('main',[name]).objects[0])
  if(!actual?.safe||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
  const filter=sqlMigrationCondition(condition,expected.fields.map(f=>f.name),'sqlite')
  const stmt=this.db.prepare('SELECT '+expected.fields.map(f=>q(f.name)).join(',')+' FROM main.'+q(name)+filter.where);stmt.setReadBigInts(true)
  this.readColumns=expected.fields.map(f=>f.name);this.iterator=stmt.iterate(...filter.parameters.map(v=>typeof v==='boolean'?BigInt(Number(v)):v))[Symbol.iterator]();this.held=undefined
 }
 beginFileRead(name:string,columns:string[],filter?:BrowseFilter){
  const meta=this.query('SELECT name,type FROM pragma_table_xinfo(?,?)',name,'main')
  if(!columns.length||columns.some(c=>!meta.some(f=>f.name===c)))throw new Error('FILE_TRANSFER: 字段映射无效')
  const compiled=compileMysqlFilter('main',name,filter||newBrowseFilter(),'sqlite')
  const stmt=this.db.prepare('SELECT '+columns.map(q).join(',')+compiled.sql.slice('SELECT *'.length));stmt.setReadBigInts(true)
  this.readColumns=columns;this.iterator=stmt.iterate(...compiled.parameters.map(v=>typeof v==='boolean'?BigInt(Number(v)):v))[Symbol.iterator]();this.held=undefined
 }
 fileColumnTypes(name:string){return this.query('SELECT name,type FROM pragma_table_xinfo(?,?) ORDER BY cid',name,'main').map(r=>({name:String(r.name),type:String(r.type)}))}
 fileFields(name:string){return this.fileColumnTypes(name).map(r=>r.name)}
 batch(){
  if(!this.iterator)return {rows:[],bytes:0,done:true}
  const rows:WireCell[][]=[];let bytes=0,done=false
  while(rows.length<500){
   let row=this.held
   if(!row){const next=this.iterator.next();if(next.done){done=true;break}row=this.readColumns.map(name=>encode(next.value[name]??null))}
   const size=Buffer.byteLength(JSON.stringify(row))
   if(size>4*1024*1024)throw new Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
   if(rows.length&&bytes+size>4*1024*1024){this.held=row;break}
   this.held=undefined;rows.push(row);bytes+=size
  }
  if(done){this.iterator=undefined;this.held=undefined}
  return {rows,bytes,done}
 }
 insertBatch(rows:WireCell[][]){if(!this.insert||!this.writable)throw Error('READ_ONLY');for(const row of rows){const result=this.insert.run(...row.map(decode));if(Number(result.changes)!==1)throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')}return rows.length}
 commit(){this.db.exec('COMMIT');this.insert=undefined}
}
