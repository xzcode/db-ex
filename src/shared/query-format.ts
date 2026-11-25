import {compileMongoScript} from './mongo-query-script'
import type {DatabaseKind} from './types'
/** No evaluation. Preserve the original text on parser/formatter failure. */
export async function formatQuery(text:string,kind:DatabaseKind,tabWidth=2):Promise<string>{
 if(!text.trim())return text
 if(text.length>100000)throw new Error('LIMIT_EXCEEDED: 查询语句过长')
 if(kind==='mongodb'){
  const [{format},babel,estree]=await Promise.all([import('prettier/standalone'),import('prettier/plugins/babel'),import('prettier/plugins/estree')])
  const formatted=await format(text,{parser:'babel',plugins:[babel.default,estree.default],tabWidth,semi:true,quoteProps:'preserve',trailingComma:'none'})
  let original:ReturnType<typeof compileMongoScript>|undefined
  try{original=compileMongoScript(text,'format-check')}catch{/* Incomplete/unsupported commands may still be formatted without execution. */}
  if(original&&JSON.stringify(original)!==JSON.stringify(compileMongoScript(formatted,'format-check')))throw new Error('格式化会改变查询内容，已保留原始语句。')
  return formatted
 }
 if(kind==='redis')return text
 const {format}=await import('sql-formatter')
 return format(text,{language:kind,tabWidth,keywordCase:'upper'})
}
