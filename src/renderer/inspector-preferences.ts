import {computed,ref} from 'vue'
import {normalizeInspectorPreferences,type InspectorPreferences,type InspectorTab} from '../shared/inspector-preferences'
const key='dbex.inspector.v1'
function load(){try{return normalizeInspectorPreferences(JSON.parse(localStorage.getItem(key)||'null'))}catch{return normalizeInspectorPreferences(null)}}
export const inspectorPreferences=ref(load())
export function updateInspector(patch:Partial<InspectorPreferences>){
 const next=normalizeInspectorPreferences({...inspectorPreferences.value,...patch})
 inspectorPreferences.value=next
 try{localStorage.setItem(key,JSON.stringify(next))}catch{}
}
export const globalInspectorTab=computed(()=>inspectorPreferences.value.open?inspectorPreferences.value.tab:null)
export function openGlobalInspector(tab:InspectorTab){updateInspector({open:true,tab})}
export function closeGlobalInspector(){updateInspector({open:false})}
window.addEventListener('storage',event=>{
 if(event.key!==key)return
 try{inspectorPreferences.value=normalizeInspectorPreferences(JSON.parse(event.newValue||'null'))}catch{}
})
