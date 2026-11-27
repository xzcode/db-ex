import type {MigrationMode,MigrationStep} from '../../shared/migration'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
import {reviewStep} from './endpoint'
export const sqliteQuote=(name:string)=>'"'+name.replaceAll('"','""')+'"'
export type SqliteField={name:string;type:string;notnull:boolean;pk:number;defaultValue:string|null}
export type SqliteIndex={name:string;columns:string[];unique:boolean}
export type SqliteShape={safe:boolean;fields:SqliteField[];indexes:SqliteIndex[];strict:boolean;withoutRowid:boolean}
export const sqliteShape=(o:SchemaObject|undefined)=>o?.details as SqliteShape|undefined
const allowedType=/^(?:INTEGER|INT|BIGINT|SMALLINT|TINYINT|TEXT|CLOB|REAL|DOUBLE|FLOAT|BLOB|NUMERIC|DECIMAL(?:\(\d{1,5}(?:,\s*\d{1,5})?\))?|VARCHAR(?:\(\d{1,5}\))?|CHAR(?:\(\d{1,5}\))?|BOOLEAN|DATE|DATETIME|ANY)?$/i
const literal=/^(?:NULL|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|'(?:[^'\x00-\x1f]|'')*'|[xX]'(?:[0-9a-fA-F]{2})*')$/i
export function safeSqliteField(field:SqliteField){return allowedType.test(field.type)&&(field.defaultValue===null||literal.test(field.defaultValue))}
const col=(f:SqliteField)=>sqliteQuote(f.name)+(f.type?' '+f.type:'')+(f.notnull?' NOT NULL':'')+(f.defaultValue!==null?' DEFAULT '+f.defaultValue:'')
const indexSql=(table:string,index:SqliteIndex)=>'CREATE '+(index.unique?'UNIQUE ':'')+'INDEX main.'+sqliteQuote(index.name)+' ON '+sqliteQuote(table)+' ('+index.columns.map(sqliteQuote).join(', ')+')'
function create(o:SchemaObject){
 const x=sqliteShape(o)!
 const pk=x.fields.filter(f=>f.pk).sort((a,b)=>a.pk-b.pk)
 return ['CREATE TABLE main.'+sqliteQuote(o.name)+' ('+[...x.fields.map(col),...(pk.length?['PRIMARY KEY ('+pk.map(f=>sqliteQuote(f.name)).join(', ')+')']:[])].join(', ')+')'+(x.withoutRowid?' WITHOUT ROWID':'')+(x.strict?(x.withoutRowid?', STRICT':' STRICT'):''),...x.indexes.map(i=>indexSql(o.name,i))]
}
export function sameSqliteShape(a:SqliteShape,b:SqliteShape){return JSON.stringify(a)===JSON.stringify(b)}
export function planSqliteMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode):MigrationStep[]{
 const a=new Map(source.objects.map(o=>[o.name,o])),b=new Map(target.objects.map(o=>[o.name,o]))
 return [...new Set([...a.keys(),...b.keys()])].sort().map((name,i)=>{
  const step=reviewStep(name,i),s=a.get(name),d=b.get(name),x=sqliteShape(s),y=sqliteShape(d)
  if(!s)return {...step,action:'target-only',changes:['TARGET ONLY OBJECT']}
  if(!x?.safe||d&&!y?.safe)return {...step,changes:['SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW']}
  if(!d)return mode==='data'?{...step,changes:['MISSING TARGET OBJECT']}:{...step,action:'create',changes:['MISSING TARGET OBJECT'],sql:create(s),executable:true,transfer:mode==='structure-data'}
  if(!y)return step
  if(mode!=='schema')return sameSqliteShape(x,y)?{...step,action:'copy',changes:['APPEND DATA — STOP ON CONFLICT'],executable:true,transfer:true}:{...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
  if(sameSqliteShape(x,y))return {...step,action:'same'}
  const additions=x.fields.slice(y.fields.length),prefix=y.fields.every((f,i)=>JSON.stringify(f)===JSON.stringify(x.fields[i]))
  const idx=x.indexes.filter(v=>!y.indexes.some(w=>w.name===v.name)),sameIdx=y.indexes.every(v=>x.indexes.some(w=>JSON.stringify(v)===JSON.stringify(w)))
  if(!prefix||!sameIdx||x.strict!==y.strict||x.withoutRowid!==y.withoutRowid||additions.some(f=>f.pk||f.notnull&&f.defaultValue===null)||idx.some(v=>v.unique))return {...step,changes:['CONSTRAINTS / SPECIAL DEFINITION']}
  const sql=[...additions.map(f=>'ALTER TABLE main.'+sqliteQuote(name)+' ADD COLUMN '+col(f)),...idx.map(v=>indexSql(name,v))]
  return {...step,action:sql.length?'alter':'review',sql,executable:sql.length>0,changes:[...additions.map(f=>'ADD COLUMN '+f.name),...idx.map(v=>'ADD INDEX '+v.name)]}
 })
}

export function sqliteUpsertKeys(x?:SqliteShape):string[]|undefined{
 if(!x?.safe)return
 const keys=x.fields.filter(f=>f.pk).sort((a,b)=>a.pk-b.pk)
 if(!keys.length||keys.some(f=>!f.notnull&&!x.withoutRowid&&!x.strict&&!(keys.length===1&&f.type==='INTEGER')))return
 return keys.map(f=>f.name)
}
