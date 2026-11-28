import type {OperationResult,SqlValue} from './types'
export interface QueryBatchRequest {database:string;text:string;parameters:SqlValue[]|Record<string,SqlValue>;limit:number}
export interface QueryBatchItem {sql:string;result:OperationResult;write?:boolean;previewOmitted?:boolean}
export interface QueryBatchResult {items:QueryBatchItem[];total:number;error?:string;failedAt?:number;writeFailure?:boolean;script?:boolean}
