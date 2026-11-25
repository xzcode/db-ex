import { boundedText,plainObject,resourceName } from './common'
import type { SqlValue } from '../../shared/types'

/** Single-statement ClickHouse editor. A server-side readonly=1 setting is the
 * second boundary. SQL cannot override transport/output/resource settings. */
export function inspectClickHouseSql(input:unknown):{sql:string;mode:'read'|'write'}{
 let sql=boundedText(input,'SQL',128*1024).trim()
 const tokens:string[]=[];let separator=-1
 for(let i=0;i<sql.length;){
  const c=sql[i]!
  if(c==='\0')throw new Error('SQL_POLICY: SQL 不得包含 NUL')
  if(/\s/.test(c)){i++;continue}
  if(sql.startsWith('--',i)||c==='#'){const end=sql.indexOf('\n',i+1);i=end<0?sql.length:end+1;continue}
  if(sql.startsWith('/*',i)){let depth=1;i+=2;while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2}else if(sql.startsWith('*/',i)){depth--;i+=2}else i++}if(depth)throw new Error('SQL_POLICY: SQL 注释未闭合');continue}
  if(separator>=0)throw new Error('SQL_POLICY: 每次只允许执行一条语句')
  if(c===';'){separator=i;i++;continue}
  if(c==='$'&&/^\$[A-Za-z_0-9]*\$/.test(sql.slice(i)))throw new Error('SQL_POLICY: 不支持该 SQL 语句')
  if(c==="'"||c==='"'||c.charCodeAt(0)===96){let closed=false;i++;while(i<sql.length){if(sql[i]==='\\'){i+=2;continue}if(sql[i]===c){i++;if(sql[i]===c){i++;continue}closed=true;break}i++}if(!closed)throw new Error('SQL_POLICY: SQL 引号未闭合');continue}
  if(/[A-Za-z_]/.test(c)){let end=i+1;while(end<sql.length&&/[A-Za-z_0-9]/.test(sql[end]!))end++;tokens.push(sql.slice(i,end).toUpperCase());i=end;continue}
  i++
 }
 if(separator>=0)sql=sql.slice(0,separator).trim()
 const first=tokens[0]
 if(!first||tokens.some(t=>['SETTINGS','FORMAT','OUTFILE','INFILE','INTO','URL','FILE','S3','S3CLUSTER','HDFS','AZUREBLOBSTORAGE','REMOTE','REMOTESECURE','MYSQL','POSTGRESQL','ODBC','JDBC','EXECUTABLE','EXECUTABLEPOOL','CLUSTERALLREPLICAS','CLUSTER'].includes(t)))throw new Error('SQL_POLICY: 不支持该 SQL 语句')
 if(['SELECT','WITH','SHOW','DESCRIBE','DESC','EXPLAIN'].includes(first)&&!tokens.some(t=>['INSERT','UPDATE','DELETE','ALTER','DROP','TRUNCATE','CREATE','RENAME','ATTACH','DETACH','SYSTEM','KILL','GRANT','REVOKE','BACKUP','RESTORE'].includes(t)))return {sql,mode:'read'}
 // Initial release permits only simple CREATE TABLE / VIEW and DROP TABLE /
 // VIEW. No cluster-wide DDL, mutations, external export, or admin statements.
 if((first==='CREATE'||first==='DROP')&&['TABLE','VIEW'].includes(tokens[1]||'')&&!tokens.some(t=>['CLUSTER','AS','SELECT','POPULATE','REPLACE','ATTACH','DETACH','GRANT','REVOKE','SET','SYSTEM','KILL','BACKUP','RESTORE'].includes(t))){
  if(first==='CREATE'){
   const engine=tokens.indexOf('ENGINE')
   if(tokens[1]!=='TABLE'||engine<0||!['MERGETREE','REPLACINGMERGETREE','SUMMINGMERGETREE','AGGREGATINGMERGETREE','COLLAPSINGMERGETREE','VERSIONEDCOLLAPSINGMERGETREE'].includes(tokens[engine+1]||''))throw new Error('SQL_POLICY: ClickHouse CREATE TABLE supports local MergeTree engines')
  }
  return {sql,mode:'write'}
 }
 throw new Error('SQL_POLICY: 不支持该 SQL 语句')
}
export function clickHouseIdentifier(value:unknown):string{
 const name=resourceName(value,'ClickHouse')
 if(/[\u0000-\u001f\u007f]/.test(name))throw new Error('INVALID_INPUT: ClickHouse')
 return '"'+name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'
}
export function clickHouseParameters(input:unknown):Record<string,SqlValue>{
 if(input===undefined)return {}
 const values=plainObject(input,'ClickHouse parameters')
 if(Object.keys(values).length>100)throw new Error('LIMIT_EXCEEDED: ClickHouse parameters')
 const result:Record<string,SqlValue>=Object.create(null)
 for(const [key,v] of Object.entries(values)){
  if(!/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||v===null||!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))||typeof v==='string'&&Buffer.byteLength(v)>65536)throw new Error('INVALID_INPUT: ClickHouse parameters')
  result[key]=v as SqlValue
 }
 return result
}
