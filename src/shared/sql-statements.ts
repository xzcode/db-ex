/** Lexical boundaries only, not an execution policy. Every selected statement
 * still goes through the engine parser, bound parameters and confirmation. */
export interface StatementSpan {start:number;end:number;text:string}
export function sqlStatements(text:string,dialect:string='mysql'):StatementSpan[]{
 const spans:StatementSpan[]=[];let start=0,i=0,quote='',comment:'line'|'block'|''='',depth=0
 function push(end:number){const raw=text.slice(start,end);if(raw.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,'').trim())spans.push({start,end,text:raw.trim()});start=end+1}
 while(i<text.length){
  const c=text[i]!,n=text[i+1]
  if(comment==='line'){if(c==='\n')comment='';i++;continue}
  if(comment==='block'){if(c==='/'&&n==='*'&&dialect==='clickhouse'){depth++;i+=2;continue}if(c==='*'&&n==='/'){if(--depth===0)comment='';i+=2;continue}i++;continue}
  if(quote){if(c==='\\'&&dialect!=='sqlite'){i+=2;continue}if(c===quote){if(n===quote){i+=2;continue}quote=''}i++;continue}
  if(c==="'"||c==='"'||c==='`'){quote=c;i++;continue}
  if(c==='['&&dialect==='sqlite'){quote=']';i++;continue}
  if(c==='-'&&n==='-'||c==='#'&&dialect!=='sqlite'){comment='line';i++;continue}
  if(c==='/'&&n==='*'){comment='block';depth=1;i+=2;continue}
  if(c===';'){push(i);i++;continue}
  i++
 }
 if(quote||comment==='block')throw new Error('SQL_POLICY: SQL 引号或注释未闭合')
 push(text.length)
 return spans
}
export function currentSqlStatement(text:string,offset:number,dialect?:string){
 const spans=sqlStatements(text,dialect);return (spans.find(s=>offset>=s.start&&offset<=s.end)||spans.find(s=>s.start>offset)||spans.at(-1))?.text||''
}
