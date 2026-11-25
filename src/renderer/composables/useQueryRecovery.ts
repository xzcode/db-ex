import { computed,onBeforeUnmount,ref,watch } from 'vue'
import { preferences } from '../preferences'
import { recoveryKey,type RecoveryDraft } from '../../shared/preferences'
export function useQueryRecovery(scope:()=>Omit<RecoveryDraft,'text'|'updatedAt'>|undefined, text:()=>string, apply:(text:string)=>void){
 const available=ref<RecoveryDraft|null>(null)
 const error=ref('')
 const key=computed(()=>{const s=scope();return s?recoveryKey(s):''})
 let timer:ReturnType<typeof setInterval>|undefined
 let last='',version=0,disposed=false
 let ready=false
 async function load(){
  const s=scope(),v=++version
  available.value=null;error.value='';ready=false;last=text()
  if(!s||!preferences.value.recoverySeconds){ready=true;return}
  try{
    const data=await window.dbex.loadRecovery({...s,text:''})
    if(!disposed&&v===version){available.value=data&&data.text!==text()?data:null;ready=true}
  }catch{if(!disposed&&v===version){error.value='读取恢复草稿失败';ready=true}}
 }
 async function save(){
  const s=scope(),value=text(),v=version
  // Do not silently overwrite an existing recoverable draft before the
  // user chooses whether to restore it or discard it.
  if(!ready||!s||!preferences.value.recoverySeconds||available.value||value===last||value.length>100000)return
  try{await window.dbex.saveRecovery({...s,text:value});if(v===version){last=value;error.value=''}}
  catch{if(v===version)error.value='保存恢复草稿失败'}
 }
 function restore(){if(available.value){apply(available.value.text);last=available.value.text;available.value=null}}
 function dismiss(){available.value=null;last='';void save()}
 watch([key,()=>preferences.value.recoverySeconds],()=>{
  if(timer)clearInterval(timer)
  void load()
  if(preferences.value.recoverySeconds)timer=setInterval(()=>void save(),preferences.value.recoverySeconds*1000)
 },{immediate:true})
 onBeforeUnmount(()=>{if(timer)clearInterval(timer);void save();disposed=true;version++})
 return {available,error,restore,dismiss}
}
