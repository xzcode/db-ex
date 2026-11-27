export const catalogWidthMin=72,catalogWidthMax=1200
export function normalizeCatalogWidths(value:unknown):Record<string,Record<string,number>>{
 const result:Record<string,Record<string,number>>=Object.create(null)
 if(!value||typeof value!=='object'||Array.isArray(value))return result
 for(const [scope,raw] of Object.entries(value).slice(0,50)){
  if(scope.length>80||!raw||typeof raw!=='object'||Array.isArray(raw))continue
  const fields:Record<string,number>=Object.create(null)
  for(const [key,width] of Object.entries(raw).slice(0,40)){
   if(key.length<=100&&typeof width==='number'&&Number.isInteger(width)&&width>=catalogWidthMin&&width<=catalogWidthMax)fields[key]=width
  }
  result[scope]=fields
 }
 return result
}
