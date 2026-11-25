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
