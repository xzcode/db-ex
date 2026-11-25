import type {ExplorerNode} from './types'
import type {ObjectMetric} from './object-inspection'
export type CatalogColumn={key:string;label:string;kind:'name'|'text'|'number'|'boolean'}
export const collectionColumns:CatalogColumn[]=[
 {key:'name',label:'名称',kind:'name'},
 {key:'文档数',label:'文档数',kind:'number'},
 {key:'已固定',label:'已固定',kind:'boolean'},
 {key:'数据大小',label:'数据大小',kind:'number'},
 {key:'对象的平均大小',label:'对象的平均大小',kind:'number'},
 {key:'存储大小',label:'存储大小',kind:'number'}
]
export const tableColumns:CatalogColumn[]=[
 {key:'name',label:'名称',kind:'name'},
 {key:'存储引擎',label:'存储引擎',kind:'text'},
 {key:'记录数（估算）',label:'记录数（估算）',kind:'number'},
 {key:'平均记录大小',label:'平均记录大小',kind:'number'},
 {key:'数据大小',label:'数据大小',kind:'number'},
 {key:'索引的总大小',label:'索引的总大小',kind:'number'}
]
export const queryColumns:CatalogColumn[]=[{key:'name',label:'名称',kind:'name'},{key:'文件大小',label:'文件大小',kind:'number'},{key:'创建日期',label:'创建日期',kind:'text'},{key:'修改日期',label:'修改日期',kind:'text'}]
export const nameColumn:CatalogColumn={key:'name',label:'名称',kind:'name'}
export function objectMetric(node:ExplorerNode,key:string):ObjectMetric|undefined{return node.metrics?.find(metric=>metric.label===key)}
function numeric(a:string,b:string){
 if(/^-?\d+$/.test(a)&&/^-?\d+$/.test(b)){const x=BigInt(a),y=BigInt(b);return x<y?-1:x>y?1:0}
 const x=Number(a),y=Number(b);return Number.isFinite(x)&&Number.isFinite(y)?x-y:a.localeCompare(b)
}
export function sortedObjects(nodes:readonly ExplorerNode[],column:CatalogColumn,direction:1|-1,query=''):ExplorerNode[]{
 const keyword=query.trim().toLocaleLowerCase()
 return nodes.filter(node=>!keyword||node.label.toLocaleLowerCase().includes(keyword)).slice().sort((a,b)=>{
   const av=column.kind==='name'?a.label:objectMetric(a,column.key)?.value
   const bv=column.kind==='name'?b.label:objectMetric(b,column.key)?.value
   // Missing statistics always remain at the end, never count as zero.
   if(av===undefined||bv===undefined)return av===bv?a.label.localeCompare(b.label):av===undefined?1:-1
   const order=column.kind==='number'?numeric(av,bv):column.kind==='boolean'?Number(av==='true')-Number(bv==='true'):av.localeCompare(bv,undefined,{numeric:true})
   return direction*order||a.label.localeCompare(b.label)
 })
}
