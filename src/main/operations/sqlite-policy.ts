import { boundedText } from './common'
/** SQLite has no MySQL USE/SHOW or server transaction syntax. Refuse multi-statements,
 * file attachment, extension loading and connection-level PRAGMA in user SQL. */
export function inspectSqliteSql(input:unknown): {sql:string;mode:'read'|'write'} {
  let sql=boundedText(input,'SQL',128*1024).trim()
  const words:string[]=[]; let separator=-1
  for(let i=0;i<sql.length;){
    const c=sql[i]!
    if(c==='\0')throw new Error('SQL_POLICY: SQL 不得包含 NUL')
    if(/\s/.test(c)){i++;continue}
    if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue}
    if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)throw new Error('SQL_POLICY: SQL 注释未闭合');i=end+2;continue}
    if(separator>=0)throw new Error('SQL_POLICY: 每次只允许执行一条语句')
    if(c===';'){separator=i;i++;continue}
    if(c==="'"||c==='"'||c==='\x60'||c==='['){
      const end=c==='['?']':c;let closed=false;i++
      while(i<sql.length){if(sql[i]===end){i++;if(end!==']'&&sql[i]===end){i++;continue}closed=true;break}i++}
      if(!closed)throw new Error('SQL_POLICY: SQL 引号未闭合')
      continue
    }
    if(/[A-Za-z_]/.test(c)){let j=i+1;while(j<sql.length&&/[A-Za-z_0-9]/.test(sql[j]!))j++;words.push(sql.slice(i,j).toUpperCase());i=j;continue}
    i++
  }
  if(separator>=0)sql=sql.slice(0,separator).trim()
  const first=words[0]
  if(!first||words.some(w=>['ATTACH','DETACH','PRAGMA','VACUUM','LOAD_EXTENSION','WRITABLE_SCHEMA'].includes(w)))throw new Error('SQL_POLICY: 不支持该 SQL 语句')
  if(words.includes('VIRTUAL')&&words.includes('TABLE')&&words.includes('CREATE'))throw new Error('SQL_POLICY: 不支持该 SQL 语句')
  const dml=['INSERT','UPDATE','DELETE','REPLACE']
  if(first==='SELECT'||first==='EXPLAIN'||(first==='WITH'&&!words.some(w=>dml.includes(w))))return {sql,mode:'read'}
  if(dml.includes(first)||first==='WITH'||['CREATE','ALTER','DROP','REINDEX'].includes(first))return {sql,mode:'write'}
  throw new Error('SQL_POLICY: 请使用事务按钮；不支持会话、管理或存储过程命令')
}
