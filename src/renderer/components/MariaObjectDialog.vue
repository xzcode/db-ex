<script setup lang="ts">
import {computed,onMounted,ref} from 'vue'
import {t,localize} from '../i18n'
import type {DatabaseOperation,ExplorerNode,OperationResult,SessionInfo} from '../../shared/types'
import ResultGrid from './ResultGrid.vue'
const props=defineProps<{session:SessionInfo;node:ExplorerNode}>()
const emit=defineEmits<{close:[];session:[SessionInfo];disconnect:[]}>()
const view=computed(()=>props.node.objectType==='sequence'?'sequence':props.node.objectType==='system-versioned'?'history':'partitions')
const title=computed(()=>view.value==='sequence'?'序列状态':view.value==='history'?'历史版本':'分区')
const result=ref<OperationResult>(),busy=ref(false),error=ref(''),notice=ref(''),offset=ref(0),restart=ref('')
const target={database:props.node.database||'',entity:props.node.entity||''}
async function task(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function load(next=0){await task(async()=>{result.value=await window.dbex.execute(props.session.id,{action:'mariadb.object',...target,view:view.value,limit:100,offset:next});offset.value=next})}
async function reset(){let ok=false;await task(async()=>{const r=await window.dbex.execute(props.session.id,{action:'mariadb.sequenceRestart',...target,value:restart.value,confirmed:true});notice.value=r.message||'操作已完成';ok=true});if(ok)await load()}
async function unlock(){await task(async()=>emit('session',await window.dbex.setWriteAccess(props.session.id,true)))}
async function cancel(){try{await window.dbex.cancel(props.session.id);emit('disconnect')}catch(e){error.value=String(e)}}
onMounted(()=>void load())
</script>
<template>
 <div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" :aria-label="t(title)" style="width:min(1000px,94vw)">
  <header class="dialog-header"><h2>{{t(title)}} · {{target.database}}.{{target.entity}}</h2></header>
  <div class="dialog-body" style="display:flex;flex-direction:column;gap:10px">
   <p class="helper">{{t(view==='sequence'?'读取序列状态不会消耗序列值。':'此视图仅供查看，不允许直接编辑。')}}</p>
   <div v-if="error" role="alert" class="inline-message error">{{localize(error)}}</div><div v-if="notice" role="status">{{localize(notice)}}</div>
   <div style="height:280px;overflow:auto"><ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :column-types="result.columnTypes" :null-cells="result.nullCells"/></div>
   <div class="editor-toolbar"><button class="btn secondary" :disabled="busy||offset===0" @click="load(Math.max(0,offset-100))">{{t('上一页')}}</button><button class="btn secondary" :disabled="busy||result?.nextOffset===undefined" @click="result?.nextOffset!==undefined&&load(result.nextOffset)">{{t('下一页')}}</button><button class="btn secondary" :disabled="busy" @click="load(offset)">{{t('刷新')}}</button></div>
   <template v-if="view==='sequence'"><label class="field">{{t('重设序列起始值')}}<input v-model="restart" :disabled="busy" maxlength="20"/></label><button v-if="!session.writable" class="btn secondary" :disabled="busy" @click="unlock">{{t('启用写入')}}</button><button v-else class="btn secondary" :disabled="busy||session.transaction||! /^-?\d+$/.test(restart)" @click="reset">{{t('重设序列起始值')}}</button></template>
  </div>
  <footer class="dialog-footer"><button v-if="busy" class="btn danger-text" @click="cancel">{{t('取消并断开')}}</button><button class="btn secondary" :disabled="busy" @click="emit('close')">{{t('关闭')}}</button></footer>
 </section></div>
</template>
