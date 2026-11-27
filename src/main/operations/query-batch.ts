import {sqlStatements} from '../../shared/sql-statements'
import type {DatabaseKind,DatabaseOperation,MysqlOperation,SqlValue} from '../../shared/types'
import type {QueryBatchRequest} from '../../shared/query-batch'
import {inspectSql} from './sql-policy'
import {inspectSqliteSql} from './sqlite-policy'
import {inspectClickHouseSql,clickHouseParameters} from './clickhouse-policy'
import {boundedText,integer,resourceName,sqlRow} from './common'
export const sessionSensitiveSql=(text:string)=>/\b(?:LAST_INSERT_ID|FOUND_ROWS|ROW_COUNT|CONNECTION_ID|GET_LOCK|RELEASE_LOCK|SHOW\s+SESSION|SHOW\s+WARNINGS)\b|@@|(?:^|[^@])@[a-z_]/i.test(text)
interface PlannedBatchItem {operation:DatabaseOperation;write:boolean}
function planBatch(kind:DatabaseKind,input:unknown,script:boolean,writable:boolean):PlannedBatchItem[]{
 if(!input||typeof input!=='object'||Array.isArray(input)||!['mysql','mariadb','sqlite','clickhouse'].includes(kind))throw new Error('SQL_POLICY: 不支持此批量查询')
 if(script&&kind==='clickhouse')throw new Error('SQL_POLICY: 不支持此批量查询')
 const v=input as QueryBatchRequest,database=resourceName(v.database,'数据库'),text=boundedText(v.text,'SQL',512*1024),limit=integer(v.limit,100,1,500,'每页数量')
 const spans=sqlStatements(text,kind)
 if(script&&spans.length<2)throw new Error('SQL_POLICY: 批量查询至少需要两条语句')
 if(!spans.length)throw new Error('SQL_POLICY: SQL 不能为空')
 let params:SqlValue[]=[],named:Record<string,SqlValue>={}
 if(kind==='clickhouse')named=clickHouseParameters(v.parameters)
 else{
  if(!Array.isArray(v.parameters)||v.parameters.length>1000||Buffer.byteLength(JSON.stringify(v.parameters))>2*1024*1024)throw new Error('SQL_POLICY: 批量查询参数无效')
  params=v.parameters.map(value=>sqlRow({value},'SQL').value!)
  if(spans.reduce((n,s)=>n+s.parameters,0)!==params.length)throw new Error('SQL_POLICY: 批量查询参数数量与占位符不匹配')
 }
 let consumed=0
 // Preflight all lexical boundaries, supported policies and parameters before any operation.
 // This does not claim that server-side syntax or permissions are known before execution.
 return spans.map(s=>{
  if(sessionSensitiveSql(s.text)||kind==='sqlite'&&/\?\d|[:@$][A-Za-z_]/.test(s.text))throw new Error('SQL_POLICY: 批量查询不支持会话变量或编号参数')
  const policy=kind==='sqlite'?inspectSqliteSql(s.text):kind==='clickhouse'?inspectClickHouseSql(s.text):inspectSql(s.text,script&&writable)
  const write=policy.mode==='write'
  if(write&&!script)throw new Error('SQL_POLICY: 批量查询仅支持只读语句')
  if(write&&!writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
  if(kind==='clickhouse')return {operation:{action:'clickhouse.query',database,sql:policy.sql,parameters:named,limit},write}
  const bound=params.slice(consumed,consumed+s.parameters);consumed+=s.parameters
  return {operation:{action:'mysql.query',database,sql:policy.sql,parameters:bound,offset:0,limit,...(write?{confirmed:true}:{})},write}
 })
}

export function planReadBatch(kind:DatabaseKind,input:unknown):DatabaseOperation[]{
 return planBatch(kind,input,false,false).map(item=>item.operation)
}
export function planScriptBatch(kind:DatabaseKind,input:unknown,writable:boolean){
 const items=planBatch(kind,input,true,writable)
 if(!items.some(item=>item.write))throw new Error('SQL_POLICY: 只读脚本请使用批量查询')
 return items.map(item=>({operation:item.operation as Extract<MysqlOperation,{action:'mysql.query'}>,write:item.write}))
}
