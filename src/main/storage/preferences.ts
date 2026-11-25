import { app } from 'electron'
import { access,stat,mkdir,appendFile,rename,unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute,join } from 'node:path'
import { normalizeNativePreferences, normalizeRecoveryDraft, recoveryKey, toolNames,type NativePreferences,type RecoveryDraft,type ToolName } from '../../shared/preferences'
import { readJson,writeJson,encrypt,decrypt,SerialWrites } from './secure-json'
const writes=new SerialWrites()
let current:NativePreferences={tools:{},diagnostics:false}
export async function initNativePreferences(){current=normalizeNativePreferences(await readJson('preferences.json'))}
export function getNativePreferences(){return structuredClone(current)}
export async function saveNativePreferences(value:unknown){
 const next=normalizeNativePreferences(value)
 for(const path of Object.values(next.tools))if(!isAbsolute(path))throw new Error('INVALID_TOOL_PATH: 请输入可执行文件的绝对路径')
 await writes.run(async()=>{await writeJson('preferences.json',next);current=next})
 return getNativePreferences()
}
export async function checkTool(name:ToolName,path:unknown):Promise<boolean>{
 if(!toolNames.includes(name)||typeof path!=='string'||!isAbsolute(path)||path.length>4096||/[\u0000-\u001f]/.test(path))return false
 try{if(!(await stat(path)).isFile())return false;await access(path,process.platform==='win32'?constants.R_OK:constants.X_OK);return process.platform!=='win32'||/\.exe$/i.test(path)}catch{return false}
}
export function diagnosticDirectory(){return join(app.getPath('userData'),'logs')}
const logs=new SerialWrites()
/** Never record SQL, documents, connection names, addresses, paths or secrets. */
export function diagnostic(action:string,outcome:'ok'|'error',durationMs:number){
 if(!current.diagnostics||!(/^[a-z]+\.[a-zA-Z]+$/.test(action)))return
 const record=JSON.stringify({at:new Date().toISOString(),action,outcome,durationMs:Math.max(0,Math.round(durationMs))})+'\n'
 void logs.run(async()=>{
   const dir=diagnosticDirectory(),file=join(dir,'operations.jsonl')
   await mkdir(dir,{recursive:true,mode:0o700})
   try{if((await stat(file)).size>1024*1024){await unlink(file+'.1').catch(()=>{});await rename(file,file+'.1')}}catch{}
   await appendFile(file,record,{encoding:'utf8',mode:0o600})
 }).catch(()=>{})
}
const recoveryWrites=new SerialWrites()
async function readDrafts():Promise<RecoveryDraft[]>{
 const raw=await readJson<{version:number;encrypted:string}>('recovery.secure.json')
 if(!raw)return []
 if(raw.version!==1||typeof raw.encrypted!=='string')throw new Error('INVALID_RECOVERY: 查询草稿参数无效')
 const values=decrypt<unknown>(raw.encrypted)
 if(!Array.isArray(values)||values.length>40)throw new Error('INVALID_RECOVERY: 查询草稿参数无效')
 return values.map(v=>({...normalizeRecoveryDraft(v),updatedAt:typeof v.updatedAt==='string'?v.updatedAt:undefined}))
}
export function saveRecovery(input:unknown){
 const value={...normalizeRecoveryDraft(input),updatedAt:new Date().toISOString()}
 return recoveryWrites.run(async()=>{
  const old=await readDrafts()
  const next=[value,...old.filter(x=>recoveryKey(x)!==recoveryKey(value))].slice(0,40)
  await writeJson('recovery.secure.json',{version:1,encrypted:encrypt(next)})
 })
}
export function loadRecovery(input:unknown){
 const value=normalizeRecoveryDraft(input)
 return recoveryWrites.run(async()=> (await readDrafts()).find(x=>recoveryKey(x)===recoveryKey(value))||null)
}
export function clearRecovery(){return recoveryWrites.run(()=>writeJson('recovery.secure.json',{version:1,encrypted:encrypt([])}))}
