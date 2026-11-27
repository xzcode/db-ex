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
  if(db===database&&!tables.includes(table))continue
  if(clean[j]?.toUpperCase()==='AS')j++
  const alias=isId(clean[j])&&!excluded.has(clean[j]!.toUpperCase())?decode(clean[j]!):table
  if(!result.some(r=>r.database===db&&r.table===table&&r.alias===alias))result.push({database:db,table,alias})
 }
 return result.slice(0,24)
}
