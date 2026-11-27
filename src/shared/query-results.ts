import type {DatabaseOperation,OperationResult} from './types'
import {canSafelyEditMongoDocument} from './bson-editor'
/** Never use a projected document, aggregation row or pinned snapshot as the
 * original for a whole-document write. Main process also compares $$ROOT. */
export function editableMongoResult(operation:DatabaseOperation|undefined,result:OperationResult|undefined,index:number){
 if(operation?.action!=='mongo.find'||!result?.documents?.[index])return false
 try{
  const projection=JSON.parse(operation.projection||'{}')
  if(!projection||typeof projection!=='object'||Array.isArray(projection)||Object.keys(projection).length)return false
  const document=JSON.parse(result.documents[index]!)
  return !!document&&typeof document==='object'&&!Array.isArray(document)&&Object.hasOwn(document,'_id')&&canSafelyEditMongoDocument(result.documents[index]!,result.bsonTypes?.[index])
 }catch{return false}
}
export function resultJSON(result:OperationResult):string{
 if(result.documents)return '['+result.documents.join(',\n')+']'
 return JSON.stringify(result.rawRows||result.rows,null,2)
}
