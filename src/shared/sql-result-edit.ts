import type {DatabaseKind,OperationResult} from './types'
import {protectedDatabase} from './database-admin'
import {fieldCellSpec,gridCellSpec,cellDraftKey,prepareGridEdits,type CellDraft} from './grid-edit'
export interface SqlResultTarget {database:string;entity:string}
/** Only a plain SELECT * from one actual table. Conservative eligibility:
 * no aliases, derived tables, comments, set operations, or projections.
 * The main-process SQL parser and CRUD concurrency checks remain authoritative.
 */
export function sqlResultTarget(sql:string,database:string,kind:DatabaseKind):SqlResultTarget|undefined{
 if(!['mysql','mariadb','sqlite'].includes(kind)||sql.length>128*1024||/[\\#\0]|\/\*|--/.test(sql))return
 const id='(?:[A-Za-z_][A-Za-z_0-9$]*|`(?:``|[^`])+`'+(kind==='sqlite'?'|"(?:""|[^"])+"':'')+')'
 const match=new RegExp('^\\s*SELECT\\s+\\*\\s+FROM\\s+('+id+')(?:\\s*\\.\\s*('+id+'))?([\\s\\S]*)$','i').exec(sql)
 if(!match)return
 const unquote=(v:string)=>v.startsWith('`')?v.slice(1,-1).replaceAll('``','`'):kind==='sqlite'&&v.startsWith('"')?v.slice(1,-1).replaceAll('""','"'):v
 const db=match[2]?unquote(match[1]!):database,entity=unquote(match[2]||match[1]!)
 if(!db||!entity||/[\x00-\x1f\x7f]/.test(db+entity)||protectedDatabase(kind,db)||kind==='sqlite'&&(db!=='main'||/^sqlite_/i.test(entity)))return
 if(match[3]&&!/^\s|^;/.test(match[3]))return
 const tail=match[3]!.trim().replace(/;\s*$/,'').trim()
 // Queries that the session manager may route to the original session
 // rather than an isolated read are not editable (e.g. temporary tables).
 if(/\b(?:LAST_INSERT_ID|FOUND_ROWS|ROW_COUNT|CONNECTION_ID|GET_LOCK|RELEASE_LOCK|SHOW\s+SESSION|SHOW\s+WARNINGS)\b|@@|(?:^|[^@])@[a-z_]/i.test(sql))return
 if(tail){
  if(!/^(?:WHERE\b|ORDER\s+BY\b|LIMIT\b)/i.test(tail))return
  // Strip string literals and quoted identifiers, then reject anything
  // that could add a second source or transform the result into other rows.
  const lexical=tail.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`/g,' ')
  if(/[;#\\]/.test(lexical)||/\/\*|--/.test(lexical)||/\b(?:SELECT|WITH|UNION|INTERSECT|EXCEPT|JOIN|INTO|GROUP|HAVING|WINDOW|PROCEDURE|FOR|LOCK|RETURNING|QUALIFY)\b/i.test(lexical))return
 }
 return {database:db,entity}
}
export function canEditSqlRow(result:OperationResult|undefined,structure:OperationResult|undefined,index:number):boolean{
 if(!result?.queryReadOnly||result.truncationReason==='document'||!structure?.objectCapabilities?.update||!structure.objectCapabilities.transactional||structure.truncated)return false
 const keys=structure.primaryKeys||[],original=result.rawRows?.[index]
 const fields=structure.rows.map(r=>r.name||r.Field).filter(Boolean)
 return !!original&&!!keys.length&&fields.length===result.columns.length&&Object.keys(original).length===fields.length&&new Set(fields).size===fields.length&&fields.every(f=>result.columns.includes(f!)&&Object.hasOwn(original,f!))&&keys.every(k=>Object.hasOwn(original,k)&&original[k]!==null)
}
export function sqlResultFields(result:OperationResult,structure:OperationResult,kind:DatabaseKind,index:number){
 if(!canEditSqlRow(result,structure,index))return []
 return result.columns.flatMap(field=>{const spec=fieldCellSpec(result,structure,kind,structure.primaryKeys!,index,field);return spec?[{field,...spec}]:[]})
}
export function prepareSqlResultEdit(result:OperationResult,structure:OperationResult,kind:DatabaseKind,index:number,values:Record<string,string>){
 if(!canEditSqlRow(result,structure,index))throw Error('QUERY_EDIT: 查询结果无法安全编辑')
 const fields=sqlResultFields(result,structure,kind,index),drafts:CellDraft[]=[]
 for(const [field,text] of Object.entries(values)){
  const spec=fields.find(f=>f.field===field)
  if(!spec||typeof text!=='string')throw Error('QUERY_EDIT: 查询结果无法安全编辑')
  if(text!==spec.text)drafts.push({row:index,field,text,format:'extended'})
 }
 if(!drafts.length)return undefined
 return prepareGridEdits(result,structure,kind,structure.primaryKeys!,drafts).sqlEdits[0]
}


/** Validate the entire paste/replacement before publishing any local draft. */
export function stageSqlResultDrafts(result:OperationResult,structure:OperationResult,kind:DatabaseKind,current:CellDraft[],incoming:CellDraft[]){
 if(!incoming.length)throw Error('选区含不可编辑字段或超出当前页，未暂存任何修改。')
 const next=new Map(current.map(d=>[cellDraftKey(d.row,d.field),d]))
 for(const d of incoming){
  const spec=canEditSqlRow(result,structure,d.row)?gridCellSpec(result,structure,kind,structure.primaryKeys!,d.row,d.field):undefined
  if(!spec||typeof d.text!=='string'||d.format)throw Error('选区含不可编辑字段或超出当前页，未暂存任何修改。')
  const key=cellDraftKey(d.row,d.field)
  if(d.text===spec.text)next.delete(key)
  else next.set(key,{row:d.row,field:d.field,text:d.text})
 }
 const drafts=[...next.values()]
 if(drafts.length)prepareGridEdits(result,structure,kind,structure.primaryKeys!,drafts)
 return drafts
}
