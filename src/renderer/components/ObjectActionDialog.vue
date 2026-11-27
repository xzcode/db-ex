<script setup lang="ts">
import {computed,ref} from 'vue'
import {t,localize} from '../i18n'
import type {SessionInfo,ExplorerNode,DatabaseOperation} from '../../shared/types'
import {validateManagedCollection} from '../../shared/database-admin'
export type ObjectActionMode='create-collection'|'rename-collection'|'clear-collection'|'drop-collection'|'query-rename'
const props=defineProps<{session:SessionInfo;node:ExplorerNode;mode:ObjectActionMode}>()
const emit=defineEmits<{close:[];session:[value:SessionInfo];changed:[name?:string];renameQuery:[name:string]}>()
const labels:Record<ObjectActionMode,string>={'create-collection':'新建集合','rename-collection':'重命名集合','clear-collection':'清空集合','drop-collection':'删除集合','query-rename':'重命名'}
const destructive=computed(()=>props.mode==='clear-collection'||props.mode==='drop-collection')
const name=ref(props.mode==='rename-collection'||props.mode==='query-rename'?props.node.label:'')
const busy=ref(false),error=ref(''),writable=ref(props.session.writable)
const valid=computed(()=>!busy.value&&(props.mode==='query-rename'?!!name.value.trim()&&name.value.trim()!==props.node.label:writable.value&&(destructive.value?name.value===props.node.entity:!!name.value.trim()&&name.value.trim()!==props.node.entity)))
async function unlock(){
 busy.value=true;error.value=''
 try{const s=await window.dbex.setWriteAccess(props.session.id,true);writable.value=s.writable;emit('session',s)}
 catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}
}
async function submit(){
 if(!valid.value)return
 if(props.mode==='query-rename'){emit('renameQuery',name.value.trim());return}
 busy.value=true;error.value=''
 try{
  const database=props.node.database||'',entity=props.mode==='create-collection'?validateManagedCollection(name.value):validateManagedCollection(props.node.entity)
  let operation:DatabaseOperation
  if(props.mode==='rename-collection')operation={action:'mongo.renameCollection',database,entity,newName:validateManagedCollection(name.value),confirmed:true}
  else operation={action:props.mode==='create-collection'?'mongo.createCollection':props.mode==='clear-collection'?'mongo.clearCollection':'mongo.dropCollection',database,entity,confirmed:true}
  await window.dbex.execute(props.session.id,operation)
  emit('changed',props.mode==='rename-collection'?name.value:props.mode==='create-collection'?entity:undefined)
 }catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}
}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop" @keydown.esc.stop="!busy&&emit('close')"><section class="dialog" role="dialog" aria-modal="true" :aria-label="t(labels[mode])">
  <header class="dialog-header"><div><span class="eyebrow">{{session.name}} / {{node.database}}</span><h2>{{t(labels[mode])}}</h2></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy" @click="emit('close')">×</button></header>
  <div class="dialog-body">
   <p v-if="destructive" class="inline-message error field-wide">{{t(mode==='drop-collection'?'删除集合会永久移除文档及索引。':'清空集合会永久删除其中全部文档，但保留集合及索引。')}}</p>
   <p v-if="mode==='rename-collection'" class="helper field-wide">{{t('重命名不会自动修改引用旧集合名称的查询。')}}</p>
   <label class="field field-wide">{{t(destructive?'输入集合名称以确认':'名称')}}<input v-model="name" :aria-label="t(destructive?'输入集合名称以确认':'名称')" :placeholder="destructive?node.entity:undefined" :disabled="busy" maxlength="200" @keydown.enter.prevent="submit"/></label>
   <button v-if="mode!=='query-rename'&&!writable" class="btn secondary field-wide" :disabled="busy" @click="unlock">{{t('启用写入')}}</button>
   <p v-if="error" role="alert" class="inline-message error field-wide">{{localize(error)}}</p>
  </div>
  <footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="emit('close')">{{t('取消')}}</button><button :class="['btn',destructive?'danger':'primary']" :disabled="!valid" @click="submit">{{t('确认执行')}}</button></footer>
 </section></div></Teleport>
</template>
