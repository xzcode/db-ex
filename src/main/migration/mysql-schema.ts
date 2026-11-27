import {quoteIdentifier as q} from '../operations/sql-policy'
import type {DatabaseKind} from '../../shared/types'
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
export interface TableShape {columns:{name:string;definition:string;semantic?:string}[];indexes:{name:string;definition:string}[];other:string[];options:string;safe:boolean}
export interface SchemaObject {name:string;type:string;engine?:string;definition:string;triggerNames:string[];shape?:TableShape}
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
 for(const part of parsed.parts){
  const col=idPrefix.exec(part)
  if(col){columns.push({name:unquote(col[1]!),definition:part});if(!columnPattern.test(part))safe=false;continue}
  const idx=keyPrefix.exec(part)
  if(idx||/^PRIMARY KEY\s*\(/i.test(part)){
   indexes.push({name:idx?unquote(idx[1]!):'PRIMARY',definition:part})
   if(!indexPattern.test(part))safe=false
  }else{other.push(part);safe=false}
 }
 const options=tableOptions(parsed.tail)
 if(options===undefined||!columns.length||columns.length>500||indexes.length>500||new Set(columns.map(c=>c.name)).size!==columns.length||new Set(indexes.map(c=>c.name)).size!==indexes.length)safe=false
 return {columns,indexes,other,options:options??parsed.tail,safe}
}
export function makeSchemaObject(name:string,type:string,engine:string|undefined,definition:string,triggerNames:string[]):SchemaObject{
 return {name,type,engine,definition,triggerNames,shape:type==='BASE TABLE'&&engine?.toLowerCase()==='innodb'?parseMysqlShape(name,definition):undefined}
}
export function tableTarget(database:string,name:string){return q(database)+'.'+q(name)}
function createTable(source:SchemaObject,targetDb:string){
 const shape=source.shape
 if(!shape?.safe||source.triggerNames.length)return undefined
 return 'CREATE TABLE '+tableTarget(targetDb,source.name)+' (\n  '+[...shape.columns,...shape.indexes].map(p=>p.definition).join(',\n  ')+'\n) '+shape.options
}
function sameColumn(a:TableShape['columns'][number],b:TableShape['columns'][number]){return a.name===b.name&&(a.semantic!==undefined&&b.semantic!==undefined?a.semantic===b.semantic:a.definition===b.definition)}
function sameShape(a:TableShape,b:TableShape){
 return a.columns.length===b.columns.length&&a.columns.every((c,i)=>sameColumn(c,b.columns[i]!))&&JSON.stringify(a.indexes.map(i=>[i.name,i.definition]).sort())===JSON.stringify(b.indexes.map(i=>[i.name,i.definition]).sort())&&JSON.stringify(a.other)===JSON.stringify(b.other)&&a.options===b.options
}
export function dataShape(a:TableShape,b:TableShape,cross:boolean){
 // Cross-family integer display width is presentation metadata only when
 // ZEROFILL is absent. Every other declaration must match exactly.
 const norm=(def:string)=>cross?def.replace(/^(`(?:[^`]|\`\`)+` (?:tinyint|smallint|mediumint|int|bigint))\([0-9]+\)(?![^,]*ZEROFILL)/i,'$1'):def
 return a.columns.length===b.columns.length&&a.columns.every((c,i)=>c.name===b.columns[i]?.name&&(cross?norm(c.definition)===norm(b.columns[i]!.definition):sameColumn(c,b.columns[i]!)))&&a.options===b.options
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
 const appendOnly=b.columns.every((c,i)=>a.columns[i]?.name===c.name)
 if(!appendOnly&&!extra.length&&!missing.length)changes.push('COLUMN ORDER')
 if(a.options!==b.options)changes.push('TABLE OPTIONS')
 if(JSON.stringify(a.other)!==JSON.stringify(b.other))changes.push('CONSTRAINTS / SPECIAL DEFINITION')
 const safe=a.safe&&b.safe&&appendOnly&&!extra.length&&!modified.length&&!indexRemove.length&&!indexChange.length&&a.options===b.options&&!a.other.length&&!b.other.length&&missing.every(c=>!(/\bAUTO_INCREMENT\b/i.test(c.definition))&&(!/\bNOT NULL\b/i.test(c.definition)||/\bDEFAULT\s/i.test(c.definition)))&&indexAdd.every(x=>!/^PRIMARY KEY|^UNIQUE KEY/i.test(x.definition))
 return {changes,missing,indexAdd,safe}
}
export function planMysqlMigration(source:SchemaSnapshot,target:SchemaSnapshot,mode:MigrationMode,targetDb:string,sourceKind:DatabaseKind,targetKind:DatabaseKind):MigrationStep[]{
 const cross=sourceKind!==targetKind,sm=new Map(source.objects.map(o=>[o.name,o])),tm=new Map(target.objects.map(o=>[o.name,o]))
 return [...new Set([...sm.keys(),...tm.keys()])].sort().map((name,i)=>{
  const a=sm.get(name),b=tm.get(name),step:MigrationStep={id:'step-'+i,name,action:'review',changes:[],sql:[],executable:false,transfer:false}
  if(!a){step.action='target-only';step.changes=['TARGET ONLY OBJECT'];return step}
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
  if(mode!=='schema'){
   if(!dataShape(x,y,cross))return {...step,changes:['COLUMN DEFINITION OR TABLE OPTIONS DIFFER']}
   return {...step,action:'copy',changes:['APPEND DATA — STOP ON CONFLICT'],executable:true,transfer:true}
  }
  if(sameShape(x,y))return {...step,action:'same',changes:[]}
  const diff=changesBetween(x,y)
  if(cross||!diff.safe||!diff.changes.length)return {...step,changes:diff.changes.length?diff.changes:['MANUAL REVIEW']}
  const actions=[...diff.missing.map(c=>'ADD COLUMN '+c.definition),...diff.indexAdd.map(c=>'ADD '+c.definition)]
  if(!actions.length)return {...step,changes:diff.changes}
  return {...step,action:'alter',changes:diff.changes,sql:['ALTER TABLE '+tableTarget(targetDb,name)+'\n  '+actions.join(',\n  ')],executable:true}
 })
}
