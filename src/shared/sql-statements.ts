/** Lexical boundaries only, not an execution policy. Every selected statement
 * still goes through the engine parser, bound parameters and confirmation. */
export interface StatementSpan {start:number;end:number;text:string;parameters:number}
export function sqlStatements(text:string,dialect:string='mysql'):StatementSpan[]{
 const spans:StatementSpan[]=[];let start=0,i=0,quote='',comment:'line'|'block'|'',depth=0,hasCode=false,parameters=0
 const mysql=dialect==='mysql'||dialect==='mariadb'
 comment=''
 function push(end:number){const raw=text.slice(start,end);if(hasCode)spans.push({start,end,text:raw.trim(),parameters});start=end+1;hasCode=false;parameters=0}
 while(i<text.length){
  const c=text[i]!,n=text[i+1]
  if(comment==='line'){if(c==='\n')comment='';i++;continue}
  if(comment==='block'){if(c==='/'&&n==='*'&&dialect==='clickhouse'){depth++;i+=2;continue}if(c==='*'&&n==='/'){if(--depth===0)comment='';i+=2;continue}i++;continue}
  if(quote){if(c==='\\'&&dialect!=='sqlite'){i+=2;continue}if(c===quote){if(n===quote&&quote!==']'){i+=2;continue}quote=''}i++;continue}
  if(c==="'"||c==='"'||c==='`'){hasCode=true;quote=c;i++;continue}
  if(c==='['&&dialect==='sqlite'){hasCode=true;quote=']';i++;continue}
  if(c==='-'&&n==='-'&&(!mysql||/\s/.test(text[i+2]??' '))||c==='#'&&dialect!=='sqlite'){comment='line';i++;continue}
  if(c==='/'&&n==='*'){if(mysql&&(text[i+2]==='!'||/^\/\*M!/i.test(text.slice(i,i+4))))hasCode=true;comment='block';depth=1;i+=2;continue}
  if(c===';'){push(i);i++;continue}
  if(c==='?'&&dialect!=='clickhouse')parameters++
  if(!/\s/.test(c))hasCode=true
  i++
 }
 if(quote||comment==='block')throw new Error('SQL_POLICY: SQL 引号或注释未闭合')
 push(text.length)
 return spans
}
export function currentSqlStatement(text:string,offset:number,dialect?:string){
 const spans=sqlStatements(text,dialect);return (spans.find(s=>offset>=s.start&&offset<=s.end)||spans.find(s=>s.start>offset)||spans.at(-1))?.text||''
}
