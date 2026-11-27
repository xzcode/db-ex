<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue'
import type {ExplorerNode,SessionInfo} from '../../shared/types'
import type {ObjectInspection} from '../../shared/object-inspection'
import {catalogInspection} from '../../shared/catalog-inspection'
import {globalInspectorTab,openGlobalInspector,closeGlobalInspector} from '../inspector-preferences'
import ObjectInspector from './ObjectInspector.vue'
const props=defineProps<{session:SessionInfo;node?:ExplorerNode;active:boolean;blocked:boolean;revision?:number}>()
const emit=defineEmits<{busyChange:[boolean];disconnect:[]}>()
const operation=computed(()=>catalogInspection(props.session.kind,props.node))
const key=computed(()=>JSON.stringify([props.session.id,operation.value,props.revision||0]))
const inspection=ref<ObjectInspection>(),loading=ref(false),error=ref('')
let loaded='',disposed=false,timer:ReturnType<typeof setTimeout>|undefined
function cancelTimer(){if(timer)clearTimeout(timer);timer=undefined}
function schedule(){
 cancelTimer()
 if(disposed||!props.active||props.blocked||loading.value||!globalInspectorTab.value||globalInspectorTab.value==='colors'||!operation.value||loaded===key.value)return
 timer=setTimeout(()=>{void refresh()},70)
}
async function refresh(force=false){
 if(disposed||!props.active||props.blocked||loading.value||!operation.value)return
 const op=operation.value,current=key.value
 if(!force&&loaded===current)return
 loaded=current;loading.value=true;error.value='';inspection.value=undefined
 emit('busyChange',true)
 try{
  const response=await window.dbex.execute(props.session.id,op)
  if(response.disconnected){emit('disconnect');return}
  if(!disposed&&key.value===current){inspection.value=response.inspection;if(!response.inspection)error.value='部分元数据不可用或无读取权限。'}
 }catch(reason){if(!disposed&&key.value===current)error.value=reason instanceof Error?reason.message:String(reason)}
 finally{loading.value=false;emit('busyChange',false);schedule()}
}
watch(key,()=>{loaded='';inspection.value=undefined;error.value=''})
watch([key,globalInspectorTab,()=>props.active,()=>props.blocked],schedule,{immediate:true,flush:'post'})
onBeforeUnmount(()=>{disposed=true;cancelTimer()})
</script>
<template>
 <ObjectInspector v-if="globalInspectorTab&&active" :kind="session.kind" :name="operation?node?.label||'':''" :database="node?.database" :connection="session.name" :tab="globalInspectorTab" :loading="loading" :busy="blocked||loading" :inspection="inspection" :error="error" @change="openGlobalInspector" @close="closeGlobalInspector" @refresh="refresh(true)"/>
</template>
