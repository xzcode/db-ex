<script setup lang="ts">
import {computed,ref,onMounted} from 'vue'
import {t,localize} from '../i18n'
import {queryHistoryFor} from '../../shared/query-history'
import type {SessionInfo,QuerySnippet} from '../../shared/types'
const props=defineProps<{session:SessionInfo;database:string}>()
const emit=defineEmits<{close:[];load:[item:QuerySnippet]}>()
const items=ref<QuerySnippet[]>([]),selected=ref(''),search=ref(''),status=ref('all'),busy=ref(false),error=ref('')
const statusText=(s?:string)=>s==='success'?'成功':s==='failed'?'失败':s==='cancelled'?'已取消':'旧版记录'
const filtered=computed(()=>queryHistoryFor(items.value,props.session.kind,props.session.connectionId,props.database).filter(i=>(status.value==='all'||status.value==='favorite'&&i.favorite||status.value===i.execution?.status)&&(!search.value||i.text.toLowerCase().includes(search.value.toLowerCase())||i.name.toLowerCase().includes(search.value.toLowerCase()))))
const current=computed(()=>filtered.value.find(i=>i.id===selected.value))
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function reload(){items.value=await window.dbex.listSnippets();if(!filtered.value.some(i=>i.id===selected.value))selected.value=filtered.value[0]?.id||''}
async function favorite(){const item=current.value;if(item)await act(async()=>{await window.dbex.saveSnippet({...item,favorite:!item.favorite});await reload()})}
async function remove(){const item=current.value;if(item)await act(async()=>{await window.dbex.deleteSnippet(item.id);await reload()})}
async function copy(){const item=current.value;if(item)await act(()=>window.dbex.copyText(item.text))}
onMounted(()=>void act(reload))
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog query-history-dialog" role="dialog" :aria-label="t('查询执行历史')">
 <header class="dialog-header"><div><h2>{{t('查询执行历史')}}</h2><span class="muted-text">{{session.name}} / {{database}}</span></div><button class="icon-button" :disabled="busy" @click="emit('close')">×</button></header>
 <div class="history-tools"><input v-model="search" :aria-label="t('搜索查询')" :placeholder="t('搜索查询')"/><select v-model="status" :aria-label="t('执行状态')"><option value="all">{{t('全部')}}</option><option value="success">{{t('成功')}}</option><option value="failed">{{t('失败')}}</option><option value="cancelled">{{t('已取消')}}</option><option value="favorite">{{t('收藏')}}</option></select><button class="btn secondary small" :disabled="busy" @click="act(reload)">{{t('刷新')}}</button></div>
 <div class="history-list"><table class="data-table"><thead><tr><th>{{t('执行时间')}}</th><th>{{t('语句')}}</th><th>{{t('执行状态')}}</th><th>{{t('耗时')}}</th><th>{{t('返回行数')}}</th><th>{{t('受影响行数')}}</th></tr></thead><tbody>
  <tr v-for="i in filtered" :key="i.id" :class="{selected:selected===i.id}" @click="selected=i.id" @dblclick="emit('load',i)"><td>{{new Date(i.execution?.executedAt||i.updatedAt).toLocaleString()}}</td><td :title="i.text">{{i.favorite?'★ ':''}}{{i.name}}</td><td>{{t(statusText(i.execution?.status))}}<span v-if="i.execution?.errorCode"> · {{i.execution.errorCode}}</span></td><td>{{i.execution?i.execution.durationMs+' ms':'—'}}</td><td>{{i.execution?.returnedRows??'—'}}</td><td>{{i.execution?.affectedRows??'—'}}</td></tr>
 </tbody></table><p v-if="!filtered.length" class="compact-help">{{t('暂无执行历史')}}</p></div>
 <div v-if="current" class="history-preview"><pre>{{current.text}}</pre><p v-if="current.parameters" class="muted-text">{{t('参数')}}：{{current.parameters}}</p><p v-if="current.execution?.statements" class="muted-text">{{t('已完成 {0} / {1} 条语句',[current.execution.completed||0,current.execution.statements])}}</p><p v-if="current.execution?.truncated" class="muted-text">{{t('结果已截断')}}</p></div>
 <p v-if="error" class="inline-message error">{{localize(error)}}</p>
 <footer class="dialog-footer"><button class="btn secondary" :disabled="busy||!current" @click="favorite">{{t(current?.favorite?'取消收藏':'收藏')}}</button><button class="btn secondary" :disabled="busy||!current" @click="copy">{{t('复制语句')}}</button><button class="btn secondary danger-text" :disabled="busy||!current" @click="remove">{{t('删除')}}</button><span class="toolbar-spacer"/><button class="btn secondary" @click="emit('close')">{{t('关闭')}}</button><button class="btn primary" :disabled="busy||!current" @click="current&&emit('load',current)">{{t('载入到编辑器')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.query-history-dialog{width:min(1000px,94vw);height:min(690px,90vh);display:flex;flex-direction:column}.history-tools{display:flex;gap:8px;padding:8px 14px;flex:none}.history-tools input{flex:1;min-width:0}.history-list{flex:1;min-height:0;overflow:auto}.history-list table{width:100%;table-layout:fixed}.history-list th:nth-child(2){width:35%}.history-list td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-preview{border-top:1px solid var(--border);padding:8px 14px;max-height:35%;overflow:auto;overflow-wrap:anywhere;user-select:text}.history-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}</style>
