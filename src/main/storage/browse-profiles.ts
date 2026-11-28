import {randomUUID} from 'node:crypto'
import {normalizeBrowseProfile,type BrowseProfile,type BrowseProfileScope} from '../../shared/browse-profile'
type Persistence={read():Promise<BrowseProfile[]>;write(values:BrowseProfile[]):Promise<void>}
const same=(a:BrowseProfile,b:BrowseProfileScope)=>a.connectionId===b.connectionId&&a.kind===b.kind&&a.database===b.database&&a.entity===b.entity
export class BrowseProfileStore{
 private pending:Promise<unknown>=Promise.resolve()
 constructor(private readonly io:Persistence){}
 private run<T>(fn:()=>Promise<T>):Promise<T>{const task=this.pending.then(fn,fn);this.pending=task.catch(()=>{});return task}
 private async read(){const values=await this.io.read();if(!Array.isArray(values))throw new Error('INVALID_PROFILE: 浏览配置文件无效');return values}
 list(scope:BrowseProfileScope){return this.run(async()=>structuredClone((await this.read()).filter(p=>same(p,scope))))}
 save(scope:BrowseProfileScope,draft:unknown,id?:string){return this.run(async()=>{
  const values=await this.read(),normalized=normalizeBrowseProfile(scope,draft)
  const old=id===undefined?undefined:values.find(v=>v.id===id&&same(v,scope))
  if(id!==undefined&&!old)throw new Error('INVALID_PROFILE: 浏览配置不存在')
  if(values.some(v=>same(v,scope)&&v.id!==id&&v.name.toLowerCase()===normalized.name.toLowerCase()))throw new Error('INVALID_PROFILE: 浏览配置名称已存在')
  const entry:BrowseProfile={...scope,...normalized,id:old?.id||randomUUID(),updatedAt:new Date().toISOString()}
  await this.io.write([entry,...values.filter(v=>v.id!==entry.id)]);return entry
 })}
 remove(scope:BrowseProfileScope,id:string){return this.run(async()=>{const values=await this.read();await this.io.write(values.filter(v=>v.id!==id||!same(v,scope)))})}
}
