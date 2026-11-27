import type {OperationResult,DatabaseKind} from './types'
import {newBrowseFilter,compileMongoFilter,compileMysqlFilter,type FilterRule,type BrowseFilter, type FilterType} from './browse-filter'
export function recordLocator(kind:DatabaseKind,database:string,entity:string,keys:string[],rules:Pick<FilterRule,'field'|'type'|'value'>[]){
 if(!keys.length||rules.length!==keys.length||new Set(keys).size!==keys.length||keys.some((k,i)=>rules[i]?.field!==k))throw new Error('INVALID_FILTER: 筛选或排序条件无效')
 const filter:BrowseFilter={...newBrowseFilter(),groups:[{join:'and',rules:rules.map(rule=>({...rule,operator:'eq',enabled:true}))}]}
 if(kind==='mongodb'){if(keys.length!==1||keys[0]!=='_id')throw new Error('INVALID_FILTER: 筛选或排序条件无效');return {filter,mongo:{...compileMongoFilter(filter),projection:'{}'}}}
 compileMysqlFilter(database,entity,filter,kind==='sqlite'?'sqlite':'mysql')
 return {filter,mongo:undefined}
}
export function locatorType(type:string,kind:DatabaseKind):FilterType{
 if(kind==='mongodb')return 'ObjectId'
 if(/BIGINT.*UNSIGNED/i.test(type))return 'Decimal128'
 if(/^(?:BIGINT|INT|INTEGER|MEDIUMINT|SMALLINT|TINYINT)\b/i.test(type))return 'Long'
 if(/^(?:DECIMAL|NUMERIC|FIXED)\b/i.test(type))return 'Decimal128'
 if(/^(?:REAL|DOUBLE|FLOAT)\b/i.test(type))return 'Double'
 return 'String'
}
/** Combine contiguous preview pages only. Never manufacture raw values or
 * keep incompatible per-column metadata after a schema change. */
export function appendBrowsePage(first:OperationResult,next:OperationResult,kind:DatabaseKind):OperationResult{
 if(first.nextOffset===undefined)throw new Error('INVALID_FILTER: 没有下一页')
 const mongo=kind==='mongodb'
 if(!mongo&&JSON.stringify(first.columns)!==JSON.stringify(next.columns))throw new Error('INVALID_FILTER: 结果字段已变化，请重新加载')
 if(!mongo&&JSON.stringify(first.columnTypes)!==JSON.stringify(next.columnTypes))throw new Error('INVALID_FILTER: 结果字段已变化，请重新加载')
 const columns=mongo?[...new Set([...first.columns,...next.columns])]:first.columns
 const join=<T>(a:T[]|undefined,b:T[]|undefined)=>a&&b?[...a,...b]:undefined
 return {...next,columns,rows:[...first.rows,...next.rows],documents:join(first.documents,next.documents),bsonTypes:join(first.bsonTypes,next.bsonTypes),rawRows:join(first.rawRows,next.rawRows),binaryCells:first.binaryCells||next.binaryCells?[...(first.binaryCells||first.rows.map(()=>({}))),...(next.binaryCells||next.rows.map(()=>({})))]:undefined,sqliteTypes:join(first.sqliteTypes,next.sqliteTypes),nullCells:join(first.nullCells,next.nullCells)}
}
