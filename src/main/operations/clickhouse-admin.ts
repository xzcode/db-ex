import type {ClickHouseChange} from '../../shared/types'
import {boundedText,resourceName} from './common'
import {clickHouseIdentifier} from './clickhouse-policy'

export const mergeTreeEngine=(engine:unknown)=>typeof engine==='string'&&/^(?:Replacing|Summing|Aggregating|Collapsing|VersionedCollapsing|Replicated|ReplicatedReplacing|ReplicatedSumming|ReplicatedAggregating|ReplicatedCollapsing|ReplicatedVersionedCollapsing)?MergeTree$/.test(engine)
export function userDatabase(value:unknown){const name=resourceName(value,'数据库');if(['system','information_schema'].includes(name.toLowerCase()))throw new Error('INVALID_OPERATION: ClickHouse system database');return name}
export function exactId(value:unknown){if(typeof value!=='string'||!/^[a-zA-Z0-9_.-]{1,160}$/.test(value)||value==='.'||value==='..'||value.includes('..'))throw new Error('INVALID_INPUT: ClickHouse object ID');return value}
export function backupDisk(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))throw new Error('INVALID_INPUT: ClickHouse backup disk');return value}
export function backupFile(value:unknown){const name=exactId(value);if(name.startsWith('.')||name.startsWith('-'))throw new Error('INVALID_INPUT: ClickHouse backup name');return name}
export function stringLiteral(value:string){return "'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'"}
const scalar=/^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Bool|String|FixedString\([1-9]\d{0,5}\)|Decimal\(\d{1,2},\s*\d{1,2}\)|Decimal(?:32|64|128|256)\(\d{1,2}\)|Date(?:32)?|DateTime(?:64\(\d\))?|UUID|IPv4|IPv6)$/
function scalarType(type:string){return scalar.test(type)||type.startsWith('Nullable(')&&type.endsWith(')')&&scalar.test(type.slice(9,-1))}
type Fields=Record<string,string>[]
export function mutationPlan(change:ClickHouseChange,fields:Fields,qualified:string){
 if(change.kind!=='update'&&change.kind!=='delete')throw new Error('INVALID_INPUT: ClickHouse mutation')
 const filter=fields.find(r=>r.name===change.field)
 if(!filter||!scalarType(filter.type||''))throw new Error('INVALID_INPUT: ClickHouse filter field')
 const params:Record<string,string>={filter:boundedText(change.match,'ClickHouse filter',65536),filterType:filter.type!}
 // Use server conversion and equality (not arbitrary user-supplied SQL).
 const where=clickHouseIdentifier(filter.name)+' = accurateCast({filter:String}, {filterType:String})'
 let sql='ALTER TABLE '+qualified+' DELETE WHERE '+where
 if(change.kind==='update'){
  const field=fields.find(r=>r.name===change.column)
  if(!field||!scalarType(field.type||'')||field.is_in_primary_key!=='0'||field.is_in_sorting_key!=='0'||field.is_in_partition_key!=='0'||field.is_in_sampling_key!=='0'||['MATERIALIZED','ALIAS','EPHEMERAL'].includes(field.default_kind||''))throw new Error('INVALID_INPUT: ClickHouse update column')
  params.value=boundedText(change.value,'ClickHouse value',65536);params.valueType=field.type!
  sql='ALTER TABLE '+qualified+' UPDATE '+clickHouseIdentifier(field.name)+' = accurateCast({value:String}, {valueType:String}) WHERE '+where
 }
 return {sql,where,params}
}
export function backupPlan(database:string,entity:string,change:Extract<ClickHouseChange,{kind:'backup'|'restore'}>,id:string){
 const disk=backupDisk(change.disk),file=backupFile(change.file),qualified=clickHouseIdentifier(userDatabase(database))+'.'+clickHouseIdentifier(entity)
 const location='Disk('+stringLiteral(disk)+', '+stringLiteral(file)+')'
 const renamed=change.kind==='restore'?clickHouseIdentifier(database)+'.'+clickHouseIdentifier(resourceName(change.newTable,'表')):undefined
 if(renamed===qualified)throw new Error('INVALID_INPUT: ClickHouse restore requires a new table')
 const sql=change.kind==='backup'?'BACKUP TABLE '+qualified+' TO '+location:'RESTORE TABLE '+qualified+' AS '+renamed+' FROM '+location
 return {disk,file,sql:sql+' SETTINGS id='+stringLiteral(exactId(id))+(change.kind==='restore'?', allow_non_empty_tables=0':'')+' ASYNC',location}
}
