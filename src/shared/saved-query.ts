import type { DatabaseKind, ExplorerNode } from './types'

export type QueryEngine=Exclude<DatabaseKind,'redis'>
export type QueryMode='sql'|'mongo-find'|'mongo-aggregation'
export interface QueryScope {connectionId:string;kind:QueryEngine;database:string}
export interface QueryDraft {name:string;mode:QueryMode;text:string;parameters?:string;entity?:string;syntax?:'mongo-shell'}
export interface SavedQuery extends QueryDraft,QueryScope {id:string;createdAt:string;updatedAt:string;revision:string}
export interface QuerySummary extends QueryScope {id:string;name:string;mode:QueryMode;createdAt:string;updatedAt:string;revision:string;bytes:number}
export interface QuerySave {draft:QueryDraft;id?:string;revision?:string}
export const isQueryId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
const validKind=(v:unknown):v is QueryEngine=>v==='mysql'||v==='mariadb'||v==='sqlite'||v==='mongodb'||v==='clickhouse'
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('查询记录参数错误');return v as Record<string,unknown>}
export function queryModeFor(kind:QueryEngine,mode?:unknown):QueryMode{
 if(kind==='mongodb'){
  if(mode==='mongo-find'||mode==='mongo-aggregation')return mode
 }else if(mode==='sql')return mode
 throw new Error('查询记录参数错误')
}
function bounded(v:unknown,max:number,required=false):string{
 if(typeof v!=='string'||v.length>max||v.includes('\0')||(required&&!v.trim()))throw new Error('查询记录参数错误')
 return v
}
export function normalizeQueryScope(input:unknown):QueryScope{
 const v=obj(input)
 if(!isQueryId(v.connectionId)||!validKind(v.kind))throw new Error('请先保存数据库连接，再保存查询。')
 const database=bounded(v.database,200,true)
 if(/[\u0000-\u001f]/.test(database))throw new Error('数据库名称无效')
 return {connectionId:v.connectionId,kind:v.kind,database}
}
export function normalizeQueryDraft(kind:QueryEngine,input:unknown):QueryDraft{
 const v=obj(input),mode=queryModeFor(kind,v.mode)
 const name=bounded(v.name,100,true).trim()
 if(/[\u0000-\u001f]/.test(name))throw new Error('查询记录参数错误')
 const text=bounded(v.text,100000)
 // A saved draft may be incomplete. Query execution still passes the engine
 // policy and native write confirmation; saving/importing never executes.
 if(mode==='sql')return {name,mode,text,parameters:bounded(v.parameters??(kind==='clickhouse'?'{}':'[]'),100000)}
 if(v.syntax==='mongo-shell')return {name,mode,text,syntax:'mongo-shell'}
 const entity=bounded(v.entity??'',200)
 if(/[\u0000-\u001f]/.test(entity))throw new Error('查询记录参数错误')
 if(mode==='mongo-find'){
  const parts=obj(JSON.parse(text))
  for(const key of ['filter','projection','sort'])bounded(parts[key],100000)
  return {name,mode,text:JSON.stringify({filter:parts.filter,projection:parts.projection,sort:parts.sort}),entity}
 }
 return {name,mode,text,entity}
}
export function querySummary(value:SavedQuery):QuerySummary{
 const {id,connectionId,kind,database,name,mode,createdAt,updatedAt,revision}=value
 return {id,connectionId,kind,database,name,mode,createdAt,updatedAt,revision,bytes:new TextEncoder().encode(value.text+(value.parameters||'')).length}
}
export function queryFolder(database:string,kind:QueryEngine,mode:QueryMode=kind==='mongodb'?'mongo-find':'sql'):ExplorerNode{
 const label=mode==='mongo-aggregation'?'聚合管道':'查询'
 if(kind==='mongodb'){const category=mode==='mongo-aggregation'?'pipelines':'queries';return {id:JSON.stringify(['mongo-category',database,category]),label,kind:'mongo-category',database,category,queryMode:mode}}
 return {id:JSON.stringify(['query-folder',database,mode]),label,kind:'query-folder',database,queryMode:mode}
}
export function isQueryFolder(node?:ExplorerNode):boolean{return !!node&&(node.kind==='query-folder'||node.kind==='mongo-category'&&(node.category==='queries'||node.category==='pipelines'))}
export function folderQueryMode(node:ExplorerNode):QueryMode{return node.queryMode||(node.category==='pipelines'?'mongo-aggregation':'mongo-find')}
export function savedQueryNode(query:QuerySummary):ExplorerNode{
 return {id:'saved-query:'+query.id,kind:'saved-query',label:query.name,database:query.database,queryId:query.id,queryRevision:query.revision,queryMode:query.mode,metrics:[
  {label:'文件大小',value:String(query.bytes),format:'bytes'},
  {label:'创建日期',value:query.createdAt},
  {label:'修改日期',value:query.updatedAt}
 ]}
}
export function portableQuery(value:SavedQuery){
 const draft:QueryDraft=normalizeQueryDraft(value.kind,value)
 return {format:'db-ex-query',version:1,kind:value.kind,...draft}
}
export function readPortableQuery(kind:QueryEngine,mode:QueryMode,text:string,name:string,isSql:boolean):QueryDraft{
 if(isSql){if(mode!=='sql')throw new Error('查询记录参数错误');return normalizeQueryDraft(kind,{name,mode,text,parameters:kind==='clickhouse'?'{}':'[]'})}
 const v=obj(JSON.parse(text))
 if(v.format!=='db-ex-query'||v.version!==1||v.kind!==kind||v.mode!==mode)throw new Error('查询文件与当前数据库类型不匹配。')
 return normalizeQueryDraft(kind,v)
}
export function uniqueQueryName(name:string,existing:readonly string[]):string{
 const used=new Set(existing.map(s=>s.toLocaleLowerCase()))
 if(!used.has(name.toLocaleLowerCase()))return name
 for(let i=2;;i++){const suffix=' ('+i+')',candidate=name.slice(0,100-suffix.length)+suffix;if(!used.has(candidate.toLocaleLowerCase()))return candidate}
}
