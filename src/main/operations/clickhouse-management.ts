import type {ClickHouseManagementView} from '../../shared/types'
import {page} from './common'

const scoped = ' WHERE database={db:String} AND table={table:String}'
// All identifiers, projections and predicates are fixed by the application.
// Object names are supplied as typed query parameters, never interpolated.
const views:Record<ClickHouseManagementView,string> = {
 partitions: 'SELECT partition_id, any(partition) AS partition, count() AS active_parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes_on_disk, sum(data_compressed_bytes) AS compressed_bytes, sum(data_uncompressed_bytes) AS uncompressed_bytes, round(sum(data_uncompressed_bytes)/nullIf(sum(data_compressed_bytes),0),2) AS compression_ratio FROM system.parts'+scoped+' AND active=1 GROUP BY partition_id ORDER BY partition_id',
 mutations: 'SELECT mutation_id, create_time, substring(command,1,4096) AS command, is_done, parts_to_do, latest_failed_part, latest_fail_time, substring(latest_fail_reason,1,4096) AS latest_fail_reason FROM system.mutations'+scoped+' ORDER BY create_time DESC, mutation_id DESC',
 replicas: 'SELECT replica_name, is_readonly, is_session_expired, queue_size, inserts_in_queue, merges_in_queue, part_mutations_in_queue, absolute_delay, total_replicas, active_replicas FROM system.replicas'+scoped+' ORDER BY replica_name',
 queries: "SELECT type AS outcome, count() AS queries, round(avg(query_duration_ms),2) AS avg_ms, quantile(0.95)(query_duration_ms) AS p95_ms, max(query_duration_ms) AS max_ms, sum(read_rows) AS read_rows, sum(read_bytes) AS read_bytes FROM system.query_log WHERE event_date >= today()-1 AND event_time >= now()-INTERVAL 24 HOUR AND type IN ('QueryFinish','ExceptionWhileProcessing','ExceptionBeforeStart') AND has(tables, concat({db:String}, '.', {table:String})) GROUP BY type ORDER BY type"
}
export function clickHouseManagementQuery(view:unknown,paging:{limit?:number;offset?:number}){
 if(typeof view!=='string'||!Object.hasOwn(views,view))throw new Error('INVALID_INPUT: ClickHouse management view')
 const kind=view as ClickHouseManagementView
 const {limit,offset}=page(paging)
 // The query log report has at most three grouped outcomes; it is local,
 // bounded, non-flushing and does not expose raw query text or user names.
 if(kind==='queries')return {view:kind,sql:views[kind],limit:3,offset:0}
 return {view:kind,sql:views[kind]+' LIMIT '+(limit+1)+' OFFSET '+offset,limit,offset}
}
