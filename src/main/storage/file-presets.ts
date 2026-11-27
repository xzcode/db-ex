import {randomUUID} from 'node:crypto'
import {normalizeFileTransfer,type FileTransferPreset,type FileTransferPresetDraft,type FileTransferPresetScope} from '../../shared/file-transfer'
type IO={read():Promise<FileTransferPreset[]>;write(values:FileTransferPreset[]):Promise<void>}
const matches=(a:FileTransferPreset,b:FileTransferPresetScope)=>a.connectionId===b.connectionId&&a.kind===b.kind&&a.database===b.database&&a.entity===b.entity&&a.direction===b.direction
export class FilePresetStore{
 private pending:Promise<unknown>=Promise.resolve()
 constructor(private readonly io:IO){}
 private run<T>(fn:()=>Promise<T>):Promise<T>{const next=this.pending.then(fn,fn);this.pending=next.catch(()=>{});return next}
 private async read(){const values=await this.io.read();if(!Array.isArray(values))throw new Error('FILE_TRANSFER: 配置文件无效');return values}
 list(scope:FileTransferPresetScope){return this.run(async()=>structuredClone((await this.read()).filter(v=>matches(v,scope))))}
 save(scope:FileTransferPresetScope,input:unknown,id?:string){return this.run(async()=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('FILE_TRANSFER: 配置无效')
  const raw=input as FileTransferPresetDraft
  if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>200||/[\u0000-\u001f]/.test(raw.name))throw new Error('FILE_TRANSFER: 配置名称无效')
  // Validate the same settings as execution, but never store a path, token,
  // selected rows, filter literals or an executable file reference.
  const request=normalizeFileTransfer({...raw.options,database:scope.database,entity:scope.entity,direction:scope.direction,token:'00000000-0000-0000-0000-000000000000'},scope.kind)
  const {token,database,entity,direction,filter,mongoFilter,...options}=request
  const values=await this.read(),old=id===undefined?undefined:values.find(v=>v.id===id&&matches(v,scope))
  if(id!==undefined&&!old)throw new Error('FILE_TRANSFER: 配置不存在')
  if(values.some(v=>matches(v,scope)&&v.id!==id&&v.name.toLowerCase()===raw.name.trim().toLowerCase()))throw new Error('FILE_TRANSFER: 配置名称已存在')
  const entry:FileTransferPreset={...scope,id:old?.id||randomUUID(),name:raw.name.trim(),options,useCurrentFilter:scope.direction==='export'&&raw.useCurrentFilter===true,updatedAt:new Date().toISOString()}
  await this.io.write([entry,...values.filter(v=>v.id!==entry.id)]);return entry
 })}
 remove(scope:FileTransferPresetScope,id:string){return this.run(async()=>{await this.io.write((await this.read()).filter(v=>v.id!==id||!matches(v,scope)))})}
}
