import type {DatabaseKind} from './types'
export type MigrationMode='schema'|'data'|'structure-data'
export type MigrationPolicy='append'|'upsert'|'replace'
export interface MigrationCondition {field:string;operator:'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'null'|'notNull';type:'String'|'Long'|'Decimal128'|'Double'|'ObjectId'|'Boolean';value:string}
export interface MigrationCopyOptions {policy:MigrationPolicy;condition?:MigrationCondition}
export function migrationPolicies(kind:DatabaseKind):MigrationPolicy[]{return ['mysql','mariadb','sqlite'].includes(kind)?['append','upsert','replace']:kind==='mongodb'||kind==='redis'?['append','upsert']:['append']}
export function migrationConditions(kind:DatabaseKind){return ['mysql','mariadb','sqlite','mongodb'].includes(kind)}
export function migrationPolicyLabel(policy:MigrationPolicy,kind?:DatabaseKind){return policy==='replace'?'清空目标表后传输':policy==='upsert'?(kind==='redis'?'覆盖同名 Key':'按主键插入或更新'):'追加数据，冲突时停止'}

export interface MigrationLocation {connectionId:string;database:string}
export interface MigrationRequest {source:MigrationLocation;target:MigrationLocation;mode:MigrationMode;objects?:string[];policy?:MigrationPolicy;condition?:MigrationCondition}
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
 total:number;completed:string[];created:string[];rowsRead:number;rowsCommitted:number;rowsPending:number;bytesRead:number;rowsKnown?:boolean;sourceKind?:DatabaseKind;sourceLabel?:string;targetLabel?:string;policy?:MigrationPolicy;selectedObjects?:string[];error?:string
}
export function migrationSupported(kind:DatabaseKind){return ['mysql','mariadb','mongodb','redis','sqlite','clickhouse'].includes(kind)}
export function migrationPairSupported(source:DatabaseKind,target:DatabaseKind){return migrationSupported(source)&&migrationSupported(target)&&(source===target||['mysql','mariadb'].includes(source)&&['mysql','mariadb'].includes(target))}
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
 const policy=input.policy===undefined?'append':input.policy
 if(policy!=='append'&&policy!=='upsert'&&policy!=='replace'||mode==='schema'&&policy!=='append')throw new Error('MIGRATION_INPUT: 迁移参数无效')
 let condition:MigrationCondition|undefined
 if(input.condition!==undefined){
  if(mode==='schema'||policy==='replace'||objects?.length!==1||!input.condition||typeof input.condition!=='object'||Array.isArray(input.condition))throw new Error('MIGRATION_CONDITION: 条件传输仅支持单个对象，不能与清空目标一起使用')
  const c=input.condition as Record<string,unknown>,field=migrationName(c.field)
  if(!['eq','ne','gt','gte','lt','lte','null','notNull'].includes(String(c.operator))||!['String','Long','Decimal128','Double','ObjectId','Boolean'].includes(String(c.type))||typeof c.value!=='string'||c.value.length>4096)throw new Error('MIGRATION_INPUT: 迁移参数无效')
  condition={field,operator:c.operator as MigrationCondition['operator'],type:c.type as MigrationCondition['type'],value:c.operator==='null'||c.operator==='notNull'?'':c.value}
 }
 return {source,target,mode,objects,...(input.policy!==undefined?{policy}:{}),...(condition?{condition}:{})}
}
