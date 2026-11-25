import { isQueryId,type QueryMode } from './saved-query'
import { databaseCapabilities } from './database-capabilities'
import { mongoCategory, type MongoCategory } from './mongo-catalog'
import type { DatabaseKind, ExplorerNode } from './types'
export const workbenchTabs=['data','query','aggregation','structure','console'] as const
export type WorkbenchTab=typeof workbenchTabs[number]
type SelectedNode={kind:ExplorerNode['kind'];database:string;entity?:string;category?:MongoCategory;queryId?:string;queryMode?:QueryMode}
export interface WorkspacePosition {tab:WorkbenchTab;node?:SelectedNode}
export interface WorkspaceSnapshot {ids:string[];active?:string;positions:Record<string,WorkspacePosition>}
const nodeKinds=['database','table','collection','keyspace','view','mongo-category','mongo-function','mongo-indexes','gridfs-bucket','database-query','query-folder','saved-query'] as const
const isId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!v.includes('\0')
function object(v:unknown):Record<string,unknown>{return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}}
export function validWorkbenchTab(kind:DatabaseKind,tab:unknown,readOnly=false):WorkbenchTab{
  const capabilities=databaseCapabilities(kind)
  if(tab===capabilities.editor)return capabilities.editor
  if(tab==='structure'&&capabilities.browser!=='keyspace'&&!readOnly)return 'structure'
  return 'data'
}
export function workspacePosition(node:ExplorerNode|undefined,tab:unknown):WorkspacePosition{
  const selected=node&&name(node.database)&&nodeKinds.includes(node.kind)?{
    kind:node.kind,database:node.database,entity:name(node.entity)?node.entity:undefined,category:mongoCategory(node.category)?.key,...(isQueryId(node.queryId)?{queryId:node.queryId}:{}),...(node.queryMode?{queryMode:node.queryMode}:{})
  }:undefined
  return {tab:workbenchTabs.includes(tab as WorkbenchTab)?tab as WorkbenchTab:'data',node:selected}
}
export function normalizeWorkspace(input:unknown):WorkspaceSnapshot{
  const raw=object(input),positions=Object.create(null) as WorkspaceSnapshot['positions']
  const ids=Array.isArray(raw.ids)?[...new Set(raw.ids.filter(isId))].slice(0,20):[]
  const values=object(raw.positions)
  for(const id of ids){
    if(!Object.hasOwn(values,id))continue
    const v=object(values[id]),n=object(v.node)
    const kind=nodeKinds.find(k=>k===n.kind)
    const node=kind&&name(n.database)?{kind,database:n.database,entity:name(n.entity)?n.entity:undefined,category:mongoCategory(n.category)?.key,...(isQueryId(n.queryId)?{queryId:n.queryId}:{}),...(['sql','mongo-find','mongo-aggregation'].includes(String(n.queryMode))?{queryMode:n.queryMode as QueryMode}:{})}:undefined
    positions[id]={tab:workbenchTabs.includes(v.tab as WorkbenchTab)?v.tab as WorkbenchTab:'data',node}
  }
  return {ids,active:isId(raw.active)&&ids.includes(raw.active)?raw.active:undefined,positions}
}
export function categoryForNode(node:SelectedNode):MongoCategory|undefined{
  if(node.kind==='mongo-category')return node.category
  return ({collection:'collections',view:'views','mongo-indexes':'indexes','mongo-function':'functions','gridfs-bucket':'gridfs'} as Partial<Record<ExplorerNode['kind'],MongoCategory>>)[node.kind]
}
export function matchWorkspaceNode(nodes:ExplorerNode[],desired:SelectedNode):ExplorerNode|undefined{
  return nodes.find(n=>n.kind===desired.kind&&n.database===desired.database&&
    (desired.kind==='mongo-category'?n.category===desired.category:n.entity===desired.entity))
}
