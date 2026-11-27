import type {DatabaseKind} from './types'
export type MigrationMode='schema'|'data'|'structure-data'
export interface MigrationLocation {connectionId:string;database:string}
export interface MigrationRequest {source:MigrationLocation;target:MigrationLocation;mode:MigrationMode;objects?:string[]}
export interface MigrationObject {name:string;type:string;engine?:string}
export interface MigrationCatalog {kind:DatabaseKind;databases:string[];objects?:MigrationObject[]}
export interface MigrationStep {
 id:string;name:string;action:'create'|'alter'|'copy'|'same'|'target-only'|'review'
 changes:string[];sql:string[];executable:boolean;transfer:boolean
}
export interface MigrationPlan {
 id:string;request:MigrationRequest;sourceLabel:string;targetLabel:string;sourceKind:DatabaseKind;targetKind:DatabaseKind
 expiresAt:number;steps:MigrationStep[]
}
export interface MigrationJob {
 id:string;planId:string;state:'running'|'completed'|'failed'|'cancelled'|'uncertain'
 startedAt:number;endedAt?:number;current?:string;phase:'checking'|'structure'|'copying'|'committing'|'finished'
 total:number;completed:string[];created:string[];rowsRead:number;rowsCommitted:number;rowsPending:number;bytesRead:number;error?:string
}
export function migrationSupported(kind:DatabaseKind){return kind==='mysql'||kind==='mariadb'}
export function migrationRunning(job?:MigrationJob|null){return job?.state==='running'}
export function migrationName(value:unknown):string{
 if(typeof value!=='string'||!value.length||value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error('MIGRATION_INPUT: 迁移参数无效')
 return value
}
export function normalizeMigrationRequest(value:unknown):MigrationRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MIGRATION_INPUT: 迁移参数无效')
 const input=value as Record<string,unknown>
 const location=(raw:unknown):MigrationLocation=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  const v=raw as Record<string,unknown>,connectionId=migrationName(v.connectionId),database=migrationName(v.database)
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(connectionId))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  return {connectionId,database}
 }
 if(!['schema','data','structure-data'].includes(String(input.mode)))throw new Error('MIGRATION_INPUT: 迁移参数无效')
 const mode=input.mode as MigrationMode,source=location(input.source),target=location(input.target)
 if(source.connectionId===target.connectionId&&source.database===target.database)throw new Error('MIGRATION_SAME_TARGET: 源与目标不能是同一数据库')
 let objects:string[]|undefined
 if(input.objects!==undefined){
  if(!Array.isArray(input.objects)||!input.objects.length||input.objects.length>100)throw new Error('MIGRATION_INPUT: 请选择1至100个对象')
  objects=[...new Set(input.objects.map(migrationName))]
 }
 if(mode!=='schema'&&!objects)throw new Error('MIGRATION_INPUT: 请选择1至100个对象')
 return {source,target,mode,objects}
}
