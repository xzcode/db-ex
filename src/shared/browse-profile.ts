import {compileMongoFilter,compileMysqlFilter,type BrowseFilter} from './browse-filter'
import {normalizeGridLayout,type GridLayout} from './grid-layout'
import type {DatabaseKind} from './types'
export interface BrowseProfileDraft{
 name:string;filterMode:'builder'|'text';visualFilter:BrowseFilter;mongo:{filter:string;projection:string;sort:string};pageSize:number;view:'grid'|'record'|'text';layout?:GridLayout
}
export interface BrowseProfile extends BrowseProfileDraft {id:string;connectionId:string;kind:DatabaseKind;database:string;entity:string;updatedAt:string}
export interface BrowseProfileScope{connectionId:string;kind:DatabaseKind;database:string;entity:string}
export function normalizeBrowseProfile(scope:BrowseProfileScope,input:unknown):BrowseProfileDraft{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('INVALID_PROFILE: 浏览配置无效')
 const v=input as BrowseProfileDraft
 if(typeof v.name!=='string'||!v.name.trim()||v.name.length>200||/[\u0000-\u001f]/.test(v.name)||!['builder','text'].includes(v.filterMode)||!Number.isInteger(v.pageSize)||v.pageSize<1||v.pageSize>500||!['grid','record','text'].includes(v.view))throw new Error('INVALID_PROFILE: 浏览配置无效')
 if(JSON.stringify(input).length>256000)throw new Error('INVALID_PROFILE: 浏览配置过大')
 if(!v.mongo||typeof v.mongo!=='object')throw new Error('INVALID_PROFILE: 浏览配置无效')
 const mongo={filter:v.mongo.filter,projection:v.mongo.projection,sort:v.mongo.sort}
 for(const value of Object.values(mongo)){
  if(typeof value!=='string'||value.length>100000)throw new Error('INVALID_PROFILE: 浏览配置无效')
  const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('INVALID_PROFILE: 浏览配置无效')
 }
 if(scope.kind==='mongodb')compileMongoFilter(v.visualFilter)
 else if(['mysql','mariadb','sqlite'].includes(scope.kind)&&v.filterMode==='builder')compileMysqlFilter(scope.database,scope.entity,v.visualFilter,scope.kind==='sqlite'?'sqlite':'mysql')
 else throw new Error('INVALID_PROFILE: 不支持此浏览配置')
 const layout=v.layout?normalizeGridLayout(v.layout,Array.isArray(v.layout.order)?v.layout.order.filter(x=>typeof x==='string'&&x.length<=200).slice(0,1000):[]):undefined
 return {name:v.name.trim(),filterMode:v.filterMode,visualFilter:JSON.parse(JSON.stringify(v.visualFilter)),mongo,pageSize:v.pageSize,view:v.view,layout}
}
