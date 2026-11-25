import { computed,onBeforeUnmount,ref,watch } from 'vue'
import { preferences } from '../preferences'
import { recoveryKey,type RecoveryDraft } from '../../shared/preferences'
type Scope=Omit<RecoveryDraft,'text'|'updatedAt'>
export function useQueryRecovery(scope:()=>Scope|undefined,text:()=>string,apply:(text:string)=>void){
 const available=ref<RecoveryDraft|null>(null),error=ref('')
 const key=computed(()=>{const s=scope();return s?recoveryKey(s):''})
 let timer:ReturnType<typeof setInterval>|undefined,version=0,disposed=false,ready=false
 let current:Scope|undefined,currentKey='',baseline='',latest='',enabled=false
 // Preserve the previous editor's snapshot when selection changes. Never
 // overwrite a recoverable draft until the user has made a choice.
 function saveSnapshot(){
  const s=current,value=latest,v=version
  if(!enabled||!ready||!s||available.value||value===baseline||value.length>100000)return
  baseline=value
  void window.dbex.saveRecovery({...s,text:value}).catch(()=>{if(v===version&&!disposed){baseline='';error.value='保存恢复草稿失败'}})
 }
 function load(){
  const s=scope(),v=++version
  current=s;currentKey=key.value;baseline=latest=text();enabled=!!preferences.value.recoverySeconds
  available.value=null;error.value='';ready=false
  if(!s||!enabled){ready=true;return}
  void window.dbex.loadRecovery({...s,text:''}).then(data=>{
   if(!disposed&&v===version){available.value=data&&data.text!==latest?data:null;ready=true}
  }).catch(()=>{if(!disposed&&v===version){error.value='读取恢复草稿失败';ready=true}})
 }
 function restore(){if(available.value){const value=available.value.text;apply(value);baseline=latest=value;available.value=null}}
 function dismiss(){
  const s=current,v=version
  available.value=null;baseline=latest
  if(s)void window.dbex.deleteRecovery({...s,text:''}).catch(()=>{if(v===version&&!disposed)error.value='保存恢复草稿失败'})
 }
 watch(text,value=>{if(currentKey===key.value)latest=value},{flush:'sync'})
 watch([key,()=>preferences.value.recoverySeconds],()=>{
  if(timer)clearInterval(timer)
  if(preferences.value.recoverySeconds)saveSnapshot()
  load()
  if(preferences.value.recoverySeconds)timer=setInterval(saveSnapshot,preferences.value.recoverySeconds*1000)
 },{immediate:true,flush:'post'})
 onBeforeUnmount(()=>{if(timer)clearInterval(timer);saveSnapshot();disposed=true;version++})
 return {available,error,restore,dismiss}
}
