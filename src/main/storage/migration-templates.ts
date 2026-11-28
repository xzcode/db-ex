import {randomUUID} from 'node:crypto'
import {normalizeMigrationRequest,type MigrationRequest,type MigrationTemplate} from '../../shared/migration'
type IO={read():Promise<unknown>;write(values:MigrationTemplate[]):Promise<void>}
const invalid=()=>Error('MIGRATION_TEMPLATE: 迁移配置无效')
const nameOf=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>200||/[\u0000-\u001f]/.test(value))throw invalid();return value.trim()}
export class MigrationTemplateStore{
 private pending:Promise<unknown>=Promise.resolve()
 constructor(private readonly io:IO,private readonly validate?:(request:MigrationRequest)=>void){}
 private run<T>(fn:()=>Promise<T>){const next=this.pending.then(fn,fn);this.pending=next.catch(()=>{});return next}
 private async read(){
  const values=await this.io.read()
  if(!Array.isArray(values))throw invalid()
  const seen=new Set<string>()
  return values.map(raw=>{
   if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||!/^[-a-f0-9]{36}$/i.test(raw.id)||seen.has(raw.id)||typeof raw.updatedAt!=='string')throw invalid()
   seen.add(raw.id)
   return {id:raw.id,name:nameOf(raw.name),request:normalizeMigrationRequest(raw.request),updatedAt:raw.updatedAt} satisfies MigrationTemplate
  })
 }
 list(){return this.run(async()=>structuredClone(await this.read()))}
 save(input:unknown,id?:string){return this.run(async()=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid()
  const raw=input as {name:unknown;request:unknown},name=nameOf(raw.name),request=normalizeMigrationRequest(raw.request)
  this.validate?.(request)
  const values=await this.read()
  if(id!==undefined&&!values.some(t=>t.id===id))throw Error('MIGRATION_TEMPLATE: 迁移配置不存在')
  if(values.some(t=>t.id!==id&&t.name.toLowerCase()===name.toLowerCase()))throw Error('MIGRATION_TEMPLATE: 迁移配置名称已存在')
  const item={id:id||randomUUID(),name,request,updatedAt:new Date().toISOString()}
  await this.io.write([item,...values.filter(t=>t.id!==item.id)]);return structuredClone(item)
 })}
 remove(id:unknown){return this.run(async()=>{if(typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id))throw invalid();await this.io.write((await this.read()).filter(t=>t.id!==id))})}
}
