import type {DatabaseKind,OperationResult} from '../shared/types'
const cache=new Map<string,{fields:string[];expires:number}>()
export const metadataKey=(session:string,database:string,table:string)=>JSON.stringify([session,database,table])
export function cachedMetadata(key:string,now=Date.now()){
 const value=cache.get(key)
 if(!value||value.expires<=now){cache.delete(key);return undefined}
 return [...value.fields]
}
export function rememberMetadata(key:string,fields:string[],now=Date.now()){
 cache.delete(key);cache.set(key,{fields:[...new Set(fields.filter(Boolean))].slice(0,500),expires:now+5*60*1000})
 if(cache.size>100)cache.delete(cache.keys().next().value!)
 return cachedMetadata(key,now)!
}
export function metadataFields(kind:DatabaseKind,result:OperationResult){
 return result.rows.map(row=>kind==='clickhouse'||kind==='sqlite'?row.name||row.Field:row.Field||row.name).filter((name):name is string=>typeof name==='string'&&!!name)
}

export function inferMetadataTable(sql:string,tables:readonly string[],database:string){
 // Only metadata suggestions, never SQL execution. Ignore comments and string
 // literals. Handle simple unqualified and same-database qualified references.
 const tokens=sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|`(?:``|[^`])*`|"(?:""|\\.|[^"])*"|[A-Za-z_][\w$]*|[.;,()]/g)||[]
 const clean=tokens.filter(x=>!x.startsWith('--')&&!x.startsWith('/*')&&!x.startsWith("'"))
 const decode=(x:string)=>x.startsWith('`')?x.slice(1,-1).replaceAll('``','`'):x.startsWith('"')?x.slice(1,-1).replaceAll('""','"').replaceAll('\\"','"'):x
 for(let i=0;i<clean.length;i++){
  if(!['FROM','JOIN','UPDATE','INTO'].includes(clean[i]!.toUpperCase()))continue
  const token=clean[i+1];if(!token||!/^[A-Za-z_`"]/.test(token))continue
  let table=decode(token)
  if(clean[i+2]==='.'){
   if(table!==database||!clean[i+3])continue
   table=decode(clean[i+3]!)
  }
  if(tables.includes(table))return table
 }
 return ''
}

export interface MetadataReference{database:string;table:string;alias:string}
export function inferMetadataReferences(sql:string,tables:readonly string[],database:string):MetadataReference[]{
 const ctes=new Set(inferCteMetadata(sql).names.map(n=>n.toLowerCase()))
 const tokens=sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|`(?:``|[^`])*`|"(?:""|\\.|[^"])*"|[A-Za-z_][\w$]*|[.;,()]/g)||[]
 const clean=tokens.filter(x=>!x.startsWith('--')&&!x.startsWith('/*')&&!x.startsWith("'"))
 const decode=(x:string)=>x.startsWith('`')?x.slice(1,-1).replaceAll('``','`'):x.startsWith('"')?x.slice(1,-1).replaceAll('""','"'):x
 const excluded=new Set(['WHERE','ON','JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','FULL','GROUP','ORDER','HAVING','LIMIT','OFFSET','UNION','SET','VALUES','USING','WINDOW','FOR','FINAL','PREWHERE','SAMPLE','FORMAT','AS','BY','INTO','SELECT'])
 const result:MetadataReference[]=[]
 const isId=(x?:string)=>!!x&&/^[A-Za-z_`"]/.test(x)
 for(let i=0;i<clean.length;i++){
  if(!['FROM','JOIN','UPDATE','INTO'].includes(clean[i]!.toUpperCase()))continue
  let j=i+1;if(!isId(clean[j]))continue
  let db=database,table=decode(clean[j++]!)
  if(clean[j]==='.'&&isId(clean[j+1])){db=table;table=decode(clean[j+1]!);j+=2}
  else if(ctes.has(table.toLowerCase()))continue
  if(db===database&&!tables.includes(table))continue
  if(clean[j]?.toUpperCase()==='AS')j++
  const alias=isId(clean[j])&&!excluded.has(clean[j]!.toUpperCase())?decode(clean[j]!):table
  if(!result.some(r=>r.database===db&&r.table===table&&r.alias===alias))result.push({database:db,table,alias})
 }
 return result.slice(0,24)
}

/** Conservative CTE metadata for completion only. Explicit output lists take
 * precedence; otherwise infer simple projected fields and AS aliases. Unknown
 * expressions and wildcard projections are deliberately not guessed. */
export function inferCteMetadata(sql:string){
 const tokens=sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|`(?:``|[^`])*`|"(?:""|\\.|[^"])*"|[A-Za-z_][\w$]*|[.;,()*+\-\/=<>?]|\d+(?:\.\d+)?/g)||[]
 const clean=tokens.filter(x=>!x.startsWith('--')&&!x.startsWith('/*'))
 const word=(i:number)=>clean[i]?.toUpperCase()
 const isId=(s?:string)=>!!s&&/^[A-Za-z_`"]/.test(s)
 const decode=(s:string)=>s.startsWith('`')?s.slice(1,-1).replaceAll('``','`'):s.startsWith('"')?s.slice(1,-1).replaceAll('""','"'):s
 function close(start:number){
  let depth=0
  for(let i=start;i<clean.length;i++){if(clean[i]==='(')depth++;else if(clean[i]===')'&&--depth===0)return i}
  return -1
 }
 const fields:Record<string,string[]>=Object.create(null),names:string[]=[]
 function projected(start:number,end:number){
  if(word(start)!=='SELECT')return []
  if(['DISTINCT','ALL'].includes(word(start+1)||''))start++
  let depth=0,begin=start+1
  const out:string[]=[]
  function column(a:number,b:number){
   if(b<=a)return
   const last=clean[b-1]
   if(b-a>=3&&word(b-2)==='AS'&&isId(last)){out.push(decode(last!));return}
   if(b-a===1&&isId(last)){out.push(decode(last!));return}
   if(b-a===3&&isId(clean[a])&&clean[a+1]==='.'&&isId(last))out.push(decode(last!))
  }
  for(let i=begin;i<end;i++){
   const token=clean[i]
   if(token==='(')depth++
   else if(token===')')depth--
   else if(!depth&&token===','){column(begin,i);begin=i+1}
   else if(!depth&&['FROM','UNION','INTERSECT','EXCEPT','WHERE','GROUP','ORDER','LIMIT','HAVING','WINDOW'].includes(word(i)||'')){column(begin,i);return [...new Set(out)]}
  }
  column(begin,end);return [...new Set(out)]
 }
 // WITH clauses at statement boundaries (including RECURSIVE and the
 // SQLite MATERIALIZED syntax). Do not mistake comments or literals for CTEs.
 for(let i=0;i<clean.length&&names.length<24;i++){
  if((i!==0&&clean[i-1]!==';')||word(i)!=='WITH')continue
  let j=i+1;if(word(j)==='RECURSIVE')j++
  while(isId(clean[j])&&names.length<24){
   const name=decode(clean[j++]!),explicit:string[]=[]
   if(clean[j]==='('){
    const end=close(j);if(end<0)break
    let valid=true
    for(let k=j+1;k<end;k++){
     if((k-j)%2===1){if(!isId(clean[k])){valid=false;break}explicit.push(decode(clean[k]!))}
     else if(clean[k]!==','){valid=false;break}
    }
    if(!valid||!explicit.length||(end-j)%2!==0)break
    j=end+1
   }
   if(word(j)!=='AS')break;j++
   if(word(j)==='NOT'&&word(j+1)==='MATERIALIZED')j+=2
   else if(word(j)==='MATERIALIZED')j++
   if(clean[j]!=='(')break
   const end=close(j);if(end<0)break
   if(!names.includes(name))names.push(name)
   fields[name]=(explicit.length?explicit:projected(j+1,end)).slice(0,500)
   j=end+1
   if(clean[j]!==',')break;j++
  }
 }
 // Aliases of CTEs in FROM/JOIN are local suggestions, never physical
 // metadata lookups. Preserve the explicit definition even if no fields
 // can be inferred yet.
 const excluded=new Set(['WHERE','ON','JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','FULL','GROUP','ORDER','HAVING','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','SET','VALUES','USING','WINDOW','FOR','FINAL','PREWHERE','SAMPLE','FORMAT','AS','BY','INTO','SELECT'])
 for(let i=0;i<clean.length;i++){
  if(!['FROM','JOIN'].includes(word(i)||'')||!isId(clean[i+1])||clean[i+2]==='.')continue
  const name=names.find(n=>n.toLowerCase()===decode(clean[i+1]!).toLowerCase())
  if(!name)continue
  let j=i+2;if(word(j)==='AS')j++
  if(isId(clean[j])&&!excluded.has(word(j)||''))fields[decode(clean[j]!)]=fields[name]||[]
 }
 return {names,fields}
}
