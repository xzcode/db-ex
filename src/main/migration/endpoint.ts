import type {DatabaseKind} from '../../shared/types'
import type {MigrationCatalog,MigrationStep,MigrationCopyOptions} from '../../shared/migration'
import type {SchemaObject,SchemaSnapshot} from './mysql-schema'
export type CopyCallbacks=[(rows:number,bytes:number)=>void,(rows:number)=>void,()=>void,(rows:number)=>void]
export interface MigrationEndpoint{
 readonly kind:DatabaseKind
 readonly identity:string
 close():Promise<void>
 catalog(database?:string):Promise<MigrationCatalog>
 schema(database:string,names?:string[]):Promise<SchemaSnapshot>
 startSourceSnapshot():Promise<void>
 prepareTarget():Promise<void>
 applyStep(step:MigrationStep,database:string,source:SchemaObject):Promise<void>
 copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,...callbacks:CopyCallbacks):Promise<void>
}
export function requireActive(signal:AbortSignal){if(signal.aborted)throw new Error('CANCELLED: 已取消操作')}
export function limitObjectNames<T extends {name:string}>(items:T[],names?:string[],limit=100){
 if(items.length>500)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
 const selected=items.filter(o=>!names||names.includes(o.name)).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
 if(selected.length>limit)throw new Error('MIGRATION_LIMIT: 请选择不超过100个对象')
 return selected
}
export function checkedSnapshot(objects:SchemaObject[]):SchemaSnapshot{
 if(Buffer.byteLength(JSON.stringify(objects))>4*1024*1024)throw new Error('MIGRATION_LIMIT: 数据库对象定义超出本阶段上限')
 return {objects:objects.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}
}
export function reviewStep(name:string,i:number):MigrationStep{return {id:'step-'+i,name,action:'review',changes:[],sql:[],executable:false,transfer:false}}
