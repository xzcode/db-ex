import { randomUUID } from 'node:crypto'
import { isQueryId,normalizeQueryScope,normalizeQueryDraft,queryModeFor,querySummary,uniqueQueryName,type QueryScope,type QueryMode,type QuerySave,type QueryDraft,type SavedQuery,type QuerySummary } from '../../shared/saved-query'

export interface SavedQueryPersistence {read():Promise<SavedQuery[]>;write(values:SavedQuery[]):Promise<void>}
const sameScope=(entry:SavedQuery,scope:QueryScope)=>entry.connectionId===scope.connectionId&&entry.kind===scope.kind&&entry.database===scope.database

/** Independent of the 200-entry history / 100-favorite store. All updates
 * serialize and use atomic encrypted persistence, with no silent eviction. */
export class SavedQueryStore{
 private pending:Promise<unknown>=Promise.resolve()
 constructor(private readonly persistence:SavedQueryPersistence){}
 private run<T>(action:()=>Promise<T>):Promise<T>{
  const current=this.pending.then(action,action);this.pending=current.catch(()=>{});return current
 }
 private async read():Promise<SavedQuery[]>{
  const values=await this.persistence.read()
  if(!Array.isArray(values))throw new Error('查询记录格式错误')
  return values
 }
 private find(values:SavedQuery[],scope:QueryScope,id:string){
  if(!isQueryId(id))throw new Error('查询记录参数错误')
  const item=values.find(v=>v.id===id&&sameScope(v,scope))
  if(!item)throw new Error('未找到已保存的查询。')
  return item
 }
 list(raw:QueryScope,mode:QueryMode):Promise<QuerySummary[]>{
  return this.run(async()=>{const scope=normalizeQueryScope(raw);queryModeFor(scope.kind,mode)
   return (await this.read()).filter(v=>sameScope(v,scope)&&v.mode===mode).map(querySummary)
  })
 }
 get(raw:QueryScope,id:string):Promise<SavedQuery>{
  return this.run(async()=>this.find(await this.read(),normalizeQueryScope(raw),id))
 }
 save(raw:QueryScope,input:QuerySave):Promise<SavedQuery>{
  return this.run(async()=>{
   const scope=normalizeQueryScope(raw),draft=normalizeQueryDraft(scope.kind,input?.draft)
   const values=await this.read()
   const old=input.id===undefined?undefined:this.find(values,scope,input.id)
   if(old&&(old.revision!==input.revision||old.mode!==draft.mode))throw new Error('查询已被修改，请重新打开后重试。')
   if(values.some(v=>sameScope(v,scope)&&v.mode===draft.mode&&v.id!==old?.id&&v.name.toLocaleLowerCase()===draft.name.toLocaleLowerCase()))throw new Error('查询名称已存在。')
   const now=new Date().toISOString()
   const entry:SavedQuery={...scope,...draft,id:old?.id||randomUUID(),createdAt:old?.createdAt||now,updatedAt:now,revision:randomUUID()}
   await this.persistence.write([entry,...values.filter(v=>v.id!==entry.id)])
   return entry
  })
 }
 copy(raw:QueryScope,id:string):Promise<SavedQuery>{
  return this.run(async()=>{
   const scope=normalizeQueryScope(raw),values=await this.read(),old=this.find(values,scope,id)
   return this.insertCopy(scope,normalizeQueryDraft(scope.kind,old),values)
  })
 }
 import(raw:QueryScope,input:QueryDraft):Promise<SavedQuery>{
  return this.run(async()=>{const scope=normalizeQueryScope(raw);return this.insertCopy(scope,normalizeQueryDraft(scope.kind,input),await this.read())})
 }
 private async insertCopy(scope:QueryScope,draft:QueryDraft,values:SavedQuery[]):Promise<SavedQuery>{
  const now=new Date().toISOString(),name=uniqueQueryName(draft.name,values.filter(v=>sameScope(v,scope)&&v.mode===draft.mode).map(v=>v.name))
  const entry:SavedQuery={...scope,...draft,name,id:randomUUID(),createdAt:now,updatedAt:now,revision:randomUUID()}
  await this.persistence.write([entry,...values]);return entry
 }
 remove(raw:QueryScope,id:string,revision:string):Promise<void>{
  return this.run(async()=>{
   const scope=normalizeQueryScope(raw),values=await this.read(),old=this.find(values,scope,id)
   if(old.revision!==revision)throw new Error('查询已被修改，请重新打开后重试。')
   await this.persistence.write(values.filter(v=>v.id!==id))
  })
 }
}
