import type { OperationResult } from './types'
import type { FilterType } from './browse-filter'
import { childType, typeName, type BsonTypeTree } from './bson-types'
import { parseBsonDocument } from './bson-display'
export interface FilterSuggestion { value:string; type:FilterType }
const sqlType=(type:string|undefined):FilterType=>['TINYINT','SMALLINT','MEDIUMINT','INT'].includes(type||'')?'Int32':type==='BIGINT'?'Long':type==='DECIMAL'?'Decimal128':type==='DOUBLE'||type==='FLOAT'?'Double':'String'
function own(value:unknown,key:string):unknown {return value&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined}
export function filterSuggestions(result:OperationResult|null|undefined, field:string, mongo:boolean):FilterSuggestion[] {
  if(!result||!field) return []
  const seen=new Set<string>(), items:FilterSuggestion[]=[]
  const add=(value:unknown,type:FilterType)=>{
    if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')return
    const text=String(value)
    if(text.length>4096)return
    const key=JSON.stringify([type,text])
    if(!seen.has(key)){seen.add(key);items.push({type,value:text})}
  }
  const index=result.columns.indexOf(field)
  for(let i=0;i<result.rows.length&&items.length<100;i++){
    if(mongo){
      const raw=result.documents?.[i]
      if(!raw)continue
      const doc=parseBsonDocument(raw)
      if(!doc)continue
      let value:unknown=doc, node:BsonTypeTree|undefined=result.bsonTypes?.[i]
      for(const part of field.split('.')){value=own(value,part);node=childType(node,part)}
      const type=typeName(node)
      switch(type){
        case 'String':case 'Boolean':add(value,type);break
        case 'Int32':add(own(value,'$numberInt'),'Int32');break
        case 'Int64':add(own(value,'$numberLong'),'Long');break
        case 'Double':add(own(value,'$numberDouble'),'Double');break
        case 'Decimal128':add(own(value,'$numberDecimal'),'Decimal128');break
        case 'ObjectId':add(own(value,'$oid'),'ObjectId');break
        case 'Date':{
          const rawMillis=own(own(value,'$date'),'$numberLong')
          if(typeof rawMillis!=='string')break
          const millis=Number(rawMillis)
          if(Number.isSafeInteger(millis)&&Math.abs(millis)<=8.64e15)add(new Date(millis).toISOString(),'ISODate')
          break
        }
      }
    } else {
      if(index<0||result.nullCells?.[i]?.includes(index))continue
      const raw=result.rawRows?.[i]||result.rows[i]
      const value=own(raw,field)
      if(value===null||value===undefined)continue
      let type=sqlType(result.columnTypes?.[index])
      // Unsigned BIGINT and INT may exceed signed BSON ranges. Keep their exact
      // text rather than automatically selecting a constructor that rejects it.
      if((type==='Long'||type==='Int32')&&/^-?\d+$/.test(String(value))){
        const n=BigInt(String(value))
        if(type==='Int32'&&(n>2147483647n||n< -2147483648n))type='Long'
        if(n>9223372036854775807n||n< -9223372036854775808n)type='Decimal128'
      }
      add(value,type)
    }
  }
  return items
}
