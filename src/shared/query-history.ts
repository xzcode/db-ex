import type {OperationResult,QuerySnippet} from './types'
import type {QueryBatchResult} from './query-batch'
export interface QueryExecution {
 executedAt:string;status:'success'|'failed'|'cancelled';durationMs:number;returnedRows?:number;affectedRows?:number;truncated?:boolean;statements?:number;completed?:number;errorCode?:string
}
const metric=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined
export function queryErrorCode(error:unknown):string {
 const text=error instanceof Error?error.message:typeof error==='string'?error:''
 return /(?:^|\s)([A-Z][A-Z_]{2,60}):/.exec(text)?.[1]||'DATABASE_ERROR'
}
export function normalizeQueryExecution(input:unknown):QueryExecution|undefined {
 if(input===undefined)return
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_QUERY_HISTORY: 执行记录无效')
 const v=input as QueryExecution,duration=metric(v.durationMs)
 if(typeof v.executedAt!=='string'||!Number.isFinite(Date.parse(v.executedAt))||!['success','failed','cancelled'].includes(v.status)||duration===undefined)throw Error('INVALID_QUERY_HISTORY: 执行记录无效')
 const out:QueryExecution={executedAt:new Date(v.executedAt).toISOString(),status:v.status,durationMs:duration}
 for(const key of ['returnedRows','affectedRows','statements','completed'] as const){const n=metric(v[key]);if(v[key]!==undefined&&n===undefined)throw Error('INVALID_QUERY_HISTORY: 执行记录无效');if(n!==undefined)out[key]=n}
 if(out.completed!==undefined&&(out.statements===undefined||out.completed>out.statements))throw Error('INVALID_QUERY_HISTORY: 执行记录无效')
 if(typeof v.truncated==='boolean')out.truncated=v.truncated
 if(v.errorCode!==undefined){if(typeof v.errorCode!=='string'||!(/^[A-Z][A-Z_0-9]{2,60}$/.test(v.errorCode)))throw Error('INVALID_QUERY_HISTORY: 执行记录无效');out.errorCode=v.errorCode}
 return out
}
export function queryExecution(start:string,elapsed:number,result?:OperationResult,error?:unknown,batch?:QueryBatchResult):QueryExecution{
 const failure=error!==undefined?queryErrorCode(error):batch?.error?queryErrorCode(batch.error):undefined
 const execution:QueryExecution={executedAt:start,durationMs:Math.max(0,Math.round(elapsed)),status:failure==='CANCELLED'?'cancelled':failure?'failed':'success'}
 if(failure)execution.errorCode=failure
 if(result){execution.returnedRows=result.rows.length;execution.affectedRows=result.affectedRows;execution.truncated=!!result.truncated}
 if(batch){execution.statements=batch.total;execution.completed=batch.items.length;execution.returnedRows=batch.items.reduce((n,item)=>n+item.result.rows.length,0);execution.truncated=batch.items.some(item=>item.result.truncated);if(batch.script)execution.affectedRows=batch.items.reduce((n,item)=>n+(item.result.affectedRows||0),0)}
 return execution
}
export function queryHistoryFor(items:QuerySnippet[],kind:QuerySnippet['kind'],connectionId:string|undefined,database:string){
 return items.filter(item=>item.kind===kind&&(!item.connectionId||item.connectionId===connectionId)&&(!item.database||item.database===database)).sort((a,b)=>(b.execution?.executedAt||b.updatedAt).localeCompare(a.execution?.executedAt||a.updatedAt))
}
