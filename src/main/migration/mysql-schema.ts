import {quoteIdentifier as q} from '../operations/sql-policy'
import type {DatabaseKind} from '../../shared/types'
import {orderMigrationSteps} from './dependencies'
import type {MigrationMode,MigrationStep} from '../../shared/migration'
/** Definitions come only from SHOW CREATE on a validated source endpoint.
 * We never execute an opaque DDL blob: only a narrow, anchored grammar for
 * ordinary InnoDB tables/columns/indexes is executable. Everything else
 * remains visible as a manual-review item. */
const identifier="`(?:[^`\\\\\r\n\u0000-\u001f]|\`\`)+`"
const quoted="'(?:[^'\\\\\u0000-\u001f]|'')*'"
const word='[A-Za-z0-9_]+'
const numeric='[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?'
const timestamp='CURRENT_TIMESTAMP(?:\\([0-6]?\\))?'
const type='(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BIT|CHAR|VARCHAR|BINARY|VARBINARY|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|DATE|TIME|DATETIME|TIMESTAMP|YEAR|JSON)(?:\\([0-9]{1,5}(?:,[0-9]{1,5})?\\))?(?: UNSIGNED)?(?: ZEROFILL)?|(?:ENUM|SET)\\('+quoted+'(?:,'+quoted+')*\\)'
const columnPattern=new RegExp('^('+identifier+')\\s+(?:'+type+')(?:\\s+(?:CHARACTER SET '+word+'|COLLATE '+word+'|NOT NULL|NULL|DEFAULT (?:NULL|'+timestamp+'|'+numeric+'|'+quoted+"|[bB]'[01]+'|0x[0-9a-fA-F]+)|AUTO_INCREMENT|ON UPDATE "+timestamp+'|COMMENT '+quoted+'))*$','i')
const indexColumn=identifier+'(?:\\([0-9]{1,5}\\))?(?: ASC| DESC)?'
const indexPattern=new RegExp('^(PRIMARY KEY|(?:UNIQUE )?KEY '+identifier+')\\s*\\('+indexColumn+'(?:,\\s*'+indexColumn+')*\\)(?: USING BTREE)?$','i')
const idPrefix=new RegExp('^('+identifier+')\\s+')
const keyPrefix=new RegExp('^(?:UNIQUE )?KEY ('+identifier+')\\s*\\(','i')
const tailOption=new RegExp('^(ENGINE='+word+'|AUTO_INCREMENT=[0-9]+|(?:DEFAULT )?CHARSET='+word+'|COLLATE='+word+'|ROW_FORMAT=(?:DYNAMIC|COMPACT|REDUNDANT|COMPRESSED|DEFAULT)|COMMENT='+quoted+')(?=\\s|$)','i')
function unquote(id:string){return id.slice(1,-1).replaceAll('``','`')}
export interface MysqlForeignKey {name:string;columns:string[];parent:string;parentColumns:string[];onDelete?:string;onUpdate?:string}
const idList=identifier+'(?:,\\s*'+identifier+')*'
const foreignPattern=new RegExp('^CONSTRAINT ('+identifier+') FOREIGN KEY\\s*\\(('+idList+')\\) REFERENCES ('+identifier+')\\s*\\(('+idList+')\\)(?: ON DELETE (RESTRICT|CASCADE|SET NULL|NO ACTION))?(?: ON UPDATE (RESTRICT|CASCADE|SET NULL|NO ACTION))?$','i')
function foreignKey(part:string):MysqlForeignKey|undefined{
 const match=foreignPattern.exec(part)
 if(!match)return
 const list=(value:string)=>value.match(new RegExp(identifier,'g'))?.map(unquote)||[]
 const columns=list(match[2]!),parentColumns=list(match[4]!)
 if(!columns.length||columns.length!==parentColumns.length||new Set(columns).size!==columns.length||new Set(parentColumns).size!==parentColumns.length)return
 return {name:unquote(match[1]!),columns,parent:unquote(match[3]!),parentColumns,...(match[5]?{onDelete:match[5].toUpperCase()}:{}),...(match[6]?{onUpdate:match[6].toUpperCase()}:{})}
}
const foreignSql=(fk:MysqlForeignKey,db:string)=>'CONSTRAINT '+q(fk.name)+' FOREIGN KEY ('+fk.columns.map(q).join(', ')+') REFERENCES '+q(db)+'.'+q(fk.parent)+' ('+fk.parentColumns.map(q).join(', ')+')'+(fk.onDelete?' ON DELETE '+fk.onDelete:'')+(fk.onUpdate?' ON UPDATE '+fk.onUpdate:'')
export interface TableShape {columns:{name:string;definition:string;semantic?:string}[];indexes:{name:string;definition:string}[];other:string[];options:string;safe:boolean;foreignKeys?:MysqlForeignKey[]}
export interface SchemaObject {name:string;type:string;engine?:string;definition:string;triggerNames:string[];shape?:TableShape;details?:unknown}
export interface SchemaSnapshot {objects:SchemaObject[]}
function splitBody(ddl:string,start:number){
 let depth=1,quote='',partStart=start+1;const parts:string[]=[]
 for(let i=start+1;i<ddl.length;i++){
  const ch=ddl[i]!
  if(quote){
   if(ch==='\\'){i++;continue}
   if(ch===quote){if(ddl[i+1]===quote){i++;continue}quote=''}
   continue
  }
  if(ch==="'"||ch==='"'||ch==='`'){quote=ch;continue}
  if(ch==='(')depth++
  else if(ch===')'){
   if(--depth===0){parts.push(ddl.slice(partStart,i).trim());return {parts,tail:ddl.slice(i+1).trim()}}
  }else if(ch===','&&depth===1){parts.push(ddl.slice(partStart,i).trim());partStart=i+1}
 }
 return undefined
}
function tableOptions(tail:string){
 const options:string[]=[],seen=new Set<string>();let remaining=tail,engine=''
 while(remaining){
  const match=tailOption.exec(remaining)
  if(!match)return undefined
  const option=match[1]!
  const key=option.split('=')[0]!.toUpperCase().replace(/^DEFAULT /,'');if(seen.has(key))return undefined;seen.add(key)
  if(/^ENGINE=/i.test(option)){engine=option.slice(7);if(engine.toLowerCase()!=='innodb')return undefined}
  if(!/^AUTO_INCREMENT=/i.test(option))options.push(option)
  remaining=remaining.slice(match[0].length).trim()
 }
 return engine.toLowerCase()==='innodb'?options.join(' '):undefined
}
export function parseMysqlShape(name:string,ddl:string):TableShape|undefined{
 const prefix='CREATE TABLE '+q(name)
 if(!ddl.startsWith(prefix))return
 const rest=ddl.slice(prefix.length),leading=/^\s*\(/.exec(rest)
 if(!leading)return
 const parsed=splitBody(ddl,prefix.length+leading[0].length-1)
 if(!parsed)return
 const columns:TableShape['columns']=[],indexes:TableShape['indexes']=[],other:string[]=[]
 let safe=true
 const foreignKeys:MysqlForeignKey[]=[]
 for(const part of parsed.parts){
  const col=idPrefix.exec(part)
  if(col){columns.push({name:unquote(col[1]!),definition:part});if(!columnPattern.test(part))safe=false;continue}
  const idx=keyPrefix.exec(part)
  if(idx||/^PRIMARY KEY\s*\(/i.test(part)){
   indexes.push({name:idx?unquote(idx[1]!):'PRIMARY',definition:part})
   if(!indexPattern.test(part))safe=false
  }else{other.push(part);const fk=foreignKey(part);if(fk)foreignKeys.push(fk);else safe=false}
 }
 const options=tableOptions(parsed.tail)
 if(options===undefined||!columns.length||columns.length>500||indexes.length>500||new Set(columns.map(c=>c.name)).size!==columns.length||new Set(indexes.map(c=>c.name)).size!==indexes.length)safe=false
 if(foreignKeys.some(fk=>fk.columns.some(c=>!columns.some(col=>col.name===c)))||new Set(foreignKeys.map(f=>f.name)).size!==foreignKeys.length)safe=false
 return {columns,indexes,other,options:options??parsed.tail,safe,...(foreignKeys.length?{foreignKeys:foreignKeys.sort((a,b)=>a.name.localeCompare(b.name))}:{})}
}
export function makeSchemaObject(name:string,type:string,engine:string|undefined,definition:string,triggerNames:string[]):SchemaObject{
 return {name,type,engine,definition,triggerNames,shape:type==='BASE TABLE'&&engine?.toLowerCase()==='innodb'?parseMysqlShape(name,definition):undefined}
}
export function tableTarget(database:string,name:string){return q(database)+'.'+q(name)}
function createTable(source:SchemaObject,targetDb:string){
 const shape=source.shape
 if(!shape?.safe||source.triggerNames.length)return undefined
 return 'CREATE TABLE '+tableTarget(targetDb,source.name)+' (\n  '+[...shape.columns.map(p=>p.definition),...shape.indexes.map(p=>p.definition),...(shape.foreignKeys||[]).map(fk=>foreignSql(fk,targetDb))].join(',\n  ')+'\n) '+shape.options
}
function sameColumn(a:TableShape['columns'][number],b:TableShape['columns'][number]){return a.name===b.name&&(a.semantic!==undefined&&b.semantic!==undefined?a.semantic===b.semantic:a.definition===b.definition)}
function sameShape(a:TableShape,b:TableShape){
 return a.columns.length===b.columns.length&&a.columns.every((c,i)=>sameColumn(c,b.columns[i]!))&&JSON.stringify(a.indexes.map(i=>[i.name,i.definition]).sort())===JSON.stringify(b.indexes.map(i=>[i.name,i.definition]).sort())&&JSON.stringify(a.foreignKeys||a.other)===JSON.stringify(b.foreignKeys||b.other)&&a.options===b.options
}
export function dataShape(a:TableShape,b:TableShape,cross:boolean){
 // Cross-family integer display width is presentation metadata only when
 // ZEROFILL is absent. Every other declaration must match exactly.
 const norm=(def:string)=>cross?def.replace(/^(`(?:[^`]|\`\`)+` (?:tinyint|smallint|mediumint|int|bigint))\([0-9]+\)(?![^,]*ZEROFILL)/i,'$1'):def
 return a.columns.length===b.columns.length&&a.columns.every((c,i)=>c.name===b.columns[i]?.name&&(cross?norm(c.definition)===norm(b.columns[i]!.definition):sameColumn(c,b.columns[i]!)))&&a.options===b.options&&JSON.stringify(a.foreignKeys||a.other)===JSON.stringify(b.foreignKeys||b.other)
}
function changesBetween(a:TableShape,b:TableShape){
 const changes:string[]=[],missing=a.columns.filter(c=>!b.columns.some(x=>x.name===c.name)),extra=b.columns.filter(c=>!a.columns.some(x=>x.name===c.name))
 for(const c of missing)changes.push('ADD COLUMN '+c.name)
 for(const c of extra)changes.push('TARGET ONLY COLUMN '+c.name)
 const modified=a.columns.filter(c=>b.columns.some(x=>x.name===c.name&&!sameColumn(c,x)))
 for(const c of modified)changes.push('MODIFY COLUMN '+c.name)
 const indexAdd=a.indexes.filter(c=>!b.indexes.some(x=>x.name===c.name)),indexRemove=b.indexes.filter(c=>!a.indexes.some(x=>x.name===c.name)),indexChange=a.indexes.filter(c=>b.indexes.some(x=>x.name===c.name&&x.definition!==c.definition))
 for(const c of indexAdd)changes.push('ADD INDEX '+c.name)
 for(const c of indexRemove)changes.push('TARGET ONLY INDEX '+c.name)
 for(const c of indexChange)changes.push('MODIFY INDEX '+c.name)
 const existingOrder=a.columns.filter(c=>b.columns.some(x=>x.name===c.name)).map(c=>c.name)
 const ordered=JSON.stringify(existingOrder)===JSON.stringify(b.columns.map(c=>c.name))
 if(!ordered&&!extra.length&&!missing.length)changes.push('COLUMN ORDER')
 if(a.options!==b.options)changes.push('TABLE OPTIONS')
 if(JSON.stringify(a.foreignKeys||a.other)!==JSON.stringify(b.foreignKeys||b.other))changes.push('CONSTRAINTS / SPECIAL DEFINITION')
 const safe=a.safe&&b.safe&&ordered&&!extra.length&&!modified.length&&!indexRemove.length&&!indexChange.length&&a.options===b.options&&JSON.stringify(a.foreignKeys||a.other)===JSON.stringify(b.foreignKeys||b.other)&&missing.every(c=>!(/\bAUTO_INCREMENT\b/i.test(c.definition))&&(!/\bNOT NULL\b/i.test(c.definition)||/\bDEFAULT\s/i.test(c.definition)))&&indexAdd.every(x=>!/^PRIMARY KEY|^UNIQUE KEY/i.test(x.definition))
 const additions=missing.map(c=>{
  const i=a.columns.findIndex(f=>f.name===c.name)
  // Preserve existing relative order; add only missing fields in source order.
  return 'ADD COLUMN '+c.definition+(i===0?' FIRST':' AFTER '+q(a.columns[i-1]!.name))
 })
 return {changes,missing,indexAdd,safe,additions}
}
export function planMysqlMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode,targetDb:string,sourceKind:DatabaseKind,targetKind:DatabaseKind,includeDependencies=false):MigrationStep[]{
 const cross=sourceKind!==targetKind,sm=new Map(source.objects.map(o=>[o.name,o])),tm=new Map(target.objects.map(o=>[o.name,o]))
 const steps:MigrationStep[]=[...new Set([...sm.keys(),...tm.keys()])].sort().map((name,i)=>{
  const a=sm.get(name),b=tm.get(name),step:MigrationStep={id:'step-'+i,name,action:'review',changes:[],sql:[],executable:false,transfer:false}
  if(!a){step.action='target-only';step.changes=['TARGET ONLY OBJECT'];return step}
  if((a.shape?.foreignKeys?.length||b?.shape?.foreignKeys?.length)&&(!includeDependencies||cross))return {...step,changes:['SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW']}
  if(!b){
   step.changes=['MISSING TARGET OBJECT']
   if(mode==='data'||cross)return step
   const sql=createTable(a,targetDb)
   if(!sql)return {...step,changes:[...step.changes,'UNSUPPORTED DEFINITION — MANUAL REVIEW']}
   return {...step,action:'create',sql:[sql],executable:true,transfer:mode==='structure-data'}
  }
  if(a.type!==b.type)return {...step,changes:['OBJECT TYPE DIFFERS']}
  const x=a.shape,y=b.shape
  if(!x||!y||!x.safe||!y.safe||a.triggerNames.length||b.triggerNames.length){
   return {...step,changes:['SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW']}
  }
  if(mode==='data'&&dataShape(x,y,cross)||mode==='structure-data'&&(cross?dataShape(x,y,cross):sameShape(x,y)))return {...step,action:'copy',changes:['APPEND DATA — STOP ON CONFLICT'],executable:true,transfer:true}
  if(mode==='data')return {...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
  if(sameShape(x,y))return {...step,action:'same',changes:[]}
  const diff=changesBetween(x,y)
  if(cross||!diff.safe||!diff.changes.length)return {...step,changes:diff.changes.length?diff.changes:['MANUAL REVIEW']}
  const actions=[...diff.additions,...diff.indexAdd.map(c=>'ADD '+c.definition)]
  if(!actions.length)return {...step,changes:diff.changes}
  return {...step,action:'alter',changes:diff.changes,sql:['ALTER TABLE '+tableTarget(targetDb,name)+'\n  '+actions.join(',\n  ')],executable:true,transfer:mode==='structure-data'}
 })
 if(!includeDependencies||cross)return steps
 const byName=new Map(steps.map(s=>[s.name,s]))
 const parentKey=(shape:TableShape,columns:string[])=>shape.indexes.some(i=>{
  if(i.name!=='PRIMARY'&&!/^UNIQUE KEY/i.test(i.definition))return false
  const match=/\(([^)]+)\)/.exec(i.definition)
  return !!match&&JSON.stringify(match[1]!.split(',').map(v=>v.trim()).map(v=>/^\x60(?:[^\x60]|\x60\x60)+\x60$/.test(v)?unquote(v):''))===JSON.stringify(columns)
 })
 for(const step of steps){
  if(!step.executable)continue
  const keys=sm.get(step.name)?.shape?.foreignKeys||[]
  const deps=new Set<string>()
  for(const fk of keys){
   const parent=sm.get(fk.parent),targetParent=tm.get(fk.parent),parentStep=byName.get(fk.parent)
   if(!parent?.shape?.safe||parent.triggerNames.length||!parentKey(parent.shape,fk.parentColumns)||!parentStep||!parentStep.executable&&!(parentStep.action==='same'&&targetParent?.shape?.safe)){
    Object.assign(step,{action:'review',executable:false,transfer:false,sql:[],changes:[...step.changes,'DEPENDENCY REQUIRES MANUAL REVIEW']});break
   }
   if(parentStep.executable)deps.add(parentStep.id)
  }
  if(step.executable&&deps.size)step.dependsOn=[...deps]
 }
 return orderMigrationSteps(steps)
}


// Ordinary PRIMARY KEY declarations only. Do not allow MySQL's duplicate-key
// update to match a different row through an alternate unique constraint.
export function mysqlUpsertKeys(shape?:TableShape):string[]|undefined{
 if(!shape?.safe||shape.indexes.some(i=>i.name!=='PRIMARY'&&/^UNIQUE KEY/i.test(i.definition)))return
 const definition=shape.indexes.find(i=>i.name==='PRIMARY')?.definition
 const match=definition&&/^PRIMARY KEY\s*\(((?:`[A-Za-z_0-9]+`)(?:,\s*`[A-Za-z_0-9]+`)*)\)(?: USING BTREE)?$/i.exec(definition)
 if(!match)return
 const keys=match[1]!.split(',').map(s=>s.trim().slice(1,-1))
 if(keys.some(k=>!shape.columns.some(c=>c.name===k)))return
 return keys
}
