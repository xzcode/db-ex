import type {DatabaseKind,ExplorerNode} from './types'
import {isQueryFolder,folderQueryMode} from './saved-query'
import {protectedDatabase,validateManagedCollection} from './database-admin'
import {catalogInspection} from './catalog-inspection'
import {migrationSupported} from './migration'
import type {NativeToolTask} from './preferences'
export type ObjectMenuAction='open'|'inspect'|'ddl'|'structure'|'query'|'refresh'|'copy-name'|'copy-qualified'|'schema'|'import'|'export'|'create-collection'|'rename-collection'|'drop-collection'|'clear-collection'|'query-copy'|'query-delete'|'query-rename'|'query-import'|'query-export'|'query-export-sql'|'index-target'|'sync-structure'|'transfer-data'|NativeToolTask
export interface ObjectMenuItem {action:ObjectMenuAction;label:string;disabled?:boolean;danger?:boolean;divider?:boolean}
export function ordinaryMongoCollection(name:string){try{validateManagedCollection(name);return true}catch{return false}}
export function objectMenu(kind:DatabaseKind,node:ExplorerNode,saved:boolean,transaction=false):ObjectMenuItem[]{
 const items:ObjectMenuItem[]=[]
 const add=(action:ObjectMenuAction,label:string,options:Omit<ObjectMenuItem,'action'|'label'>={})=>items.push({action,label,...options})
 const system=protectedDatabase(kind,node.database||'')||kind==='clickhouse'&&['system','information_schema','INFORMATION_SCHEMA'].includes(node.database||'')
 const mongo=kind==='mongodb',folder=node.kind==='mongo-category'||isQueryFolder(node),queryFolder=isQueryFolder(node),query=node.kind==='saved-query'
 if(queryFolder){
  add('open',folderQueryMode(node)==='mongo-aggregation'?'打开聚合管道列表':'打开查询列表');add('query',folderQueryMode(node)==='mongo-aggregation'?'新建聚合查询':'新建查询')
  add('query-import','导入查询',{disabled:!saved,divider:true});add('refresh','刷新',{divider:true});return items
 }
 if(query){
  add('open','打开查询')
  add('query-rename','重命名',{disabled:!saved||!node.queryId});add('query-copy','复制查询',{disabled:!saved||!node.queryId});add('query-delete','删除查询',{disabled:!saved||!node.queryId,danger:true})
  add('query-export','导出查询',{disabled:!saved||!node.queryId,divider:true})
  if(node.queryMode==='sql')add('query-export-sql','导出 SQL',{disabled:!saved||!node.queryId})
  add('copy-name','复制名称',{divider:true});add('refresh','刷新');return items
 }
 if(folder&&mongo){
  const labels={collections:'打开集合列表',views:'打开视图列表',functions:'打开函数列表',indexes:'打开索引列表',gridfs:'打开存储桶列表',pipelines:'打开聚合管道列表',queries:'打开查询列表'}
  add('open',labels[node.category||'collections'])
  if(node.category==='collections'){
   add('create-collection','新建集合',{disabled:system||transaction});if(saved&&!system){add('sync-structure','结构同步…',{divider:true});add('transfer-data','数据传输…')}add('import','导入数据',{disabled:system||transaction,divider:true});add('export','导出数据');add('schema','导出结构脚本')
   add('mongo-backup','MongoDump…',{divider:true,disabled:transaction});add('mongo-restore','MongoRestore…',{disabled:system||transaction});add('mongo-import','MongoImport…',{disabled:system||transaction});add('mongo-export','MongoExport…',{disabled:transaction})
  }else if(node.category==='views'){add('schema','导出结构脚本',{divider:true});add('export','导出数据')}
  else if(node.category==='indexes'){add('index-target','选择集合并管理索引…',{divider:true})}
  // Server-side JavaScript, arbitrary view DDL and GridFS maintenance
  // are not offered as fake actions.
  add('refresh','刷新',{divider:true});return items
 }
 if(!catalogInspection(kind,node)){if(mongo&&['mongo-function','gridfs-bucket'].includes(node.kind)){add('open','打开');add('copy-name','复制名称');add('refresh','刷新',{divider:true})}return items}
 add('open',node.kind==='collection'?'打开集合':node.kind==='view'?'打开视图':node.kind==='table'?'打开表':'打开')
 if(!node.readOnly&&(node.kind==='table'||node.kind==='collection'||node.kind==='mongo-indexes'))add('structure',mongo?'查看索引':'结构与索引')
 add('inspect','对象信息');add('ddl','DDL')
 if(mongo&&node.kind==='collection'){
  const managed=!system&&!node.readOnly&&!node.maintenanceRestricted&&!node.metrics?.some(m=>m.label==='已固定'&&m.value==='true')&&ordinaryMongoCollection(node.entity||'')
  add('create-collection','新建集合',{divider:true,disabled:system||transaction})
  add('rename-collection','重命名集合',{disabled:!managed||transaction});add('clear-collection','清空集合',{disabled:!managed||transaction,danger:true});add('drop-collection','删除集合',{disabled:!managed||transaction,danger:true})
 }
 if(['table','collection','view'].includes(node.kind)){
  if(saved&&!system&&migrationSupported(kind)&&['table','collection'].includes(node.kind)&&!node.readOnly){add('sync-structure','结构同步…',{divider:true});add('transfer-data','数据传输…')}
  add('query','新建查询',{divider:true})
  if(!node.readOnly&&kind!=='clickhouse')add('import','导入数据',{disabled:system||transaction})
  if(kind!=='clickhouse'){add('export','导出数据');add('schema','导出结构脚本')}
  if(mongo&&node.kind==='collection'){
   add('mongo-backup','MongoDump…',{divider:true,disabled:transaction})
   add('mongo-restore','MongoRestore…',{disabled:system||!!node.readOnly||transaction})
   add('mongo-import','MongoImport…',{disabled:system||!!node.readOnly||transaction})
   add('mongo-export','MongoExport…',{disabled:transaction})
  }
 }
 add('copy-name','复制名称',{divider:true});add('copy-qualified','复制完整名称');add('refresh','刷新')
 return items
}
