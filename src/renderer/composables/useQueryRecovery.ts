import { computed,onBeforeUnmount,ref,watch } from 'vue'
import { preferences } from '../preferences'
import { recoveryKey,type RecoveryDraft } from '../../shared/preferences'
type Scope=Omit<RecoveryDraft,'text'|'updatedAt'>
interface Snapshot {scope:Scope;key:string;enabled:boolean;baseline:string;latest:string;revision:number;blocked:boolean;existing:RecoveryDraft|null;loaded:Promise<void>;writes:Promise<void>}
export function useQueryRecovery(scope:()=>Scope|undefined,text:()=>string,apply:(text:string)=>void){
 const available=ref<RecoveryDraft|null>(null),error=ref('')
 const key=computed(()=>{const s=scope();return s?recoveryKey(s):''})
 let timer:ReturnType<typeof setInterval>|undefined,disposed=false,current:Snapshot|undefined
 const recent=new Map<string,Snapshot>()
 const report=(s:Snapshot,message:string)=>{if(current===s&&!disposed)error.value=message}
 function saveSnapshot(s=current){
  if(!s?.enabled||!s.latest||s.latest.length>100000||s.latest===s.baseline)return
  const value=s.latest,rev=s.revision
  // Serialize per scope. If a fast object switch happens before load completes,
  // retain the old snapshot and save it only after the stored-draft check.
  s.writes=s.writes.then(async()=>{
   await s.loaded
   if(s.blocked||s.existing||s.revision!==rev||value===s.baseline)return
   try{await window.dbex.saveRecovery({...s.scope,text:value});s.baseline=value;report(s,'')}
   catch{report(s,'保存恢复草稿失败')}
  })
 }
 function load(){
  const s=scope(),previous=recent.get(key.value)
  available.value=null;error.value=''
  if(!s){current=undefined;return}
  const value=text()
  const snapshot:Snapshot={scope:s,key:key.value,enabled:!!preferences.value.recoverySeconds,baseline:value,latest:value,revision:0,blocked:false,existing:null,loaded:Promise.resolve(),writes:Promise.resolve()}
  current=snapshot
  recent.delete(snapshot.key);recent.set(snapshot.key,snapshot)
  if(recent.size>40)recent.delete(recent.keys().next().value!)
  if(snapshot.enabled){
   snapshot.loaded=(async()=>{
    // Returning to the same editor while a previous write is queued must
    // not load an earlier revision. Main-process storage also serializes IPC.
    if(previous?.key===snapshot.key)await previous.writes
    try{
     const data=await window.dbex.loadRecovery({...s,text:''})
     snapshot.existing=data&&data.text!==snapshot.baseline?data:null
     if(!disposed&&current===snapshot)available.value=snapshot.existing
    }catch{snapshot.blocked=true;report(snapshot,'读取恢复草稿失败')}
   })()
  }
 }
 function restore(){
  const s=current
  if(!s?.existing||!available.value)return
  try{
   const value=s.existing.text;apply(value);s.baseline=s.latest=value;s.existing=null;available.value=null;error.value=''
  }catch{report(s,'读取恢复草稿失败')}
 }
 function clear(includeExisting=false){
  const s=current
  if(!s||(!includeExisting&&s.existing))return
  s.revision++;s.existing=null;available.value=null;s.baseline=s.latest
  if(!s.enabled)return
  s.writes=s.writes.then(async()=>{
   await s.loaded
   // A pending load could discover an older draft after the user discarded it.
   if(s.existing&&!includeExisting)return
   s.existing=null;if(current===s)available.value=null
   try{await window.dbex.deleteRecovery({...s.scope,text:''});s.blocked=false;report(s,'')}
   catch{report(s,'保存恢复草稿失败')}
  })
 }
 function dismiss(){clear(true)}
 watch(text,value=>{if(current?.key===key.value)current.latest=value},{flush:'sync'})
 watch([key,()=>preferences.value.recoverySeconds],()=>{
  if(timer)clearInterval(timer)
  if(preferences.value.recoverySeconds)saveSnapshot()
  load()
  if(preferences.value.recoverySeconds)timer=setInterval(()=>saveSnapshot(),preferences.value.recoverySeconds*1000)
 },{immediate:true,flush:'post'})
 onBeforeUnmount(()=>{if(timer)clearInterval(timer);saveSnapshot();disposed=true})
 return {available,error,restore,dismiss,clear}
}
