<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import type {ClickHouseTransferFormat,ClickHouseTransfer,SessionInfo} from '../../shared/types'
import type {FileTransferJob} from '../../shared/file-transfer'
const props=defineProps<{session:SessionInfo;database:string;entity:string;direction:'import'|'export';filter?:{field:string;value:string}}>()
const emit=defineEmits<{close:[];busyChange:[boolean];completed:[]}>()
const format=ref<ClickHouseTransferFormat>('parquet'),fields=ref<{name:string;type:string}[]>([]),selected=ref<string[]>([]),useFilter=ref(false)
const busy=ref(false),error=ref(''),job=ref<FileTransferJob>()
const running=computed(()=>job.value?.state==='running')
const stateLabel:Record<string,string>={running:'正在执行',completed:'操作已完成',failed:'失败',cancelled:'已取消',uncertain:'结果不确定'}
const canStart=computed(()=>!busy.value&&!running.value&&!job.value&&selected.value.length>0&&(props.direction==='export'||props.session.writable))
watch(()=>busy.value||running.value,value=>emit('busyChange',value),{flush:'sync'})
let timer:ReturnType<typeof setInterval>|undefined,disposed=false,polling=false
async function act(fn:()=>Promise<void>){if(busy.value||running.value)return;busy.value=true;error.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function initialize(){await act(async()=>{
 const result=await window.dbex.execute(props.session.id,{action:'clickhouse.structure',database:props.database,entity:props.entity})
 if(result.truncated)throw Error('INVALID_OPERATION: ClickHouse transfer metadata unavailable')
 fields.value=result.rows.filter(r=>r.name&&!['ALIAS','MATERIALIZED','EPHEMERAL'].includes(r.default_kind||'')).map(r=>({name:r.name!,type:r.type||''}))
 selected.value=fields.value.map(f=>f.name)
})}
function moveField(name:string,direction:number){const at=selected.value.indexOf(name),to=at+direction;if(at<0||to<0||to>=selected.value.length)return;const next=[...selected.value];[next[at],next[to]]=[next[to]!,next[at]!];selected.value=next}
function request():ClickHouseTransfer{return {database:props.database,entity:props.entity,direction:props.direction,format:format.value,fields:[...selected.value],...(props.direction==='export'&&useFilter.value&&props.filter?{filter:{...props.filter}}:{})}}
async function start(){if(!canStart.value)return;await act(async()=>{const value=await window.dbex.startClickHouseFileTransfer(props.session.id,request());if(value)job.value=value})}
async function poll(){if(disposed||polling||!job.value||!running.value)return;polling=true;try{
 const next=await window.dbex.getFileTransferJob()
 if(!disposed&&next?.id===job.value.id){job.value=next;if(next.state==='completed')emit('completed')}
}catch(e){if(!disposed)error.value=e instanceof Error?e.message:String(e)}finally{polling=false}}
async function cancel(){if(job.value&&running.value)try{await window.dbex.cancelFileTransfer(job.value.id)}catch(e){error.value=e instanceof Error?e.message:String(e)}}
function size(bytes:number){return (bytes/1048576).toFixed(2)+' MiB'}
onMounted(async()=>{await initialize();timer=setInterval(()=>void poll(),500)})
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);if(running.value&&job.value)void window.dbex.cancelFileTransfer(job.value.id).catch(()=>{});emit('busyChange',false)})
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog ch-file-wizard" role="dialog" :aria-label="t(direction==='import'?'流式导入向导':'流式导出向导')">
  <header class="dialog-header"><div><h2>{{t(direction==='import'?'流式导入向导':'流式导出向导')}}</h2><span class="muted-text">{{session.name}} / {{database}} / {{entity}}</span></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy||running" @click="emit('close')">×</button></header>
  <div class="ch-file-body">
   <p v-if="error" role="alert" class="inline-message error">{{localize(error)}}</p>
   <template v-if="!job">
    <label class="field">{{t('格式')}}<select v-model="format" :disabled="busy" :aria-label="t('格式')"><option value="parquet">Parquet</option><option value="native">Native</option><option value="csv">CSVWithNames</option><option value="jsonl">JSONEachRow</option></select></label>
    <p class="compact-help">{{t('ClickHouse 由服务端原生解析和写入文件，保留精确类型。请选择与文件匹配的字段和顺序；不会自动映射或预执行导入。')}}</p>
    <div class="editor-toolbar"><strong>{{t('字段')}}</strong><button class="btn secondary small" :disabled="busy" @click="selected=fields.map(f=>f.name)">{{t('全部字段')}}</button><button class="btn secondary small" :disabled="busy" @click="selected=[]">{{t('清除选择')}}</button><span class="muted-text">{{selected.length}} / {{fields.length}}</span></div>
    <div class="ch-file-fields"><table><thead><tr><th></th><th>{{t('字段')}}</th><th>{{t('类型')}}</th><th>#</th></tr></thead><tbody><tr v-for="field in fields" :key="field.name"><td><input type="checkbox" v-model="selected" :value="field.name" :aria-label="field.name" :disabled="busy"/></td><td>{{field.name}}</td><td>{{field.type}}</td><td v-if="selected.includes(field.name)">{{selected.indexOf(field.name)+1}} <button class="btn secondary small" :disabled="busy||selected.indexOf(field.name)===0" :aria-label="field.name+' ↑'" @click="moveField(field.name,-1)">↑</button> <button class="btn secondary small" :disabled="busy||selected.indexOf(field.name)===selected.length-1" :aria-label="field.name+' ↓'" @click="moveField(field.name,1)">↓</button></td><td v-else>—</td></tr></tbody></table></div>
    <label v-if="direction==='export'&&filter"><input v-model="useFilter" type="checkbox" :disabled="busy"/>{{t('仅导出当前筛选匹配记录')}} · {{filter.field}} = {{filter.value}}</label>
    <p v-if="direction==='import'" class="inline-message error">{{t('流式导入可能部分写入；失败或取消后请核对，不要直接重试。')}}</p>
   </template>
   <template v-else>
    <h3>{{t(stateLabel[job.state]||job.state)}} · {{job.file}}</h3>
    <progress v-if="running&&job.totalBytes" :max="job.totalBytes" :value="Math.min(job.bytes,job.totalBytes)"/><progress v-else-if="running"/>
    <div class="ch-file-metric"><span>{{t('已传输数据量')}}</span><strong>{{size(job.bytes)}}<template v-if="job.totalBytes"> / {{size(job.totalBytes)}}</template></strong></div>
    <p class="compact-help">{{t('原生数据流仅报告实际字节数，不推算记录数量。')}}</p>
    <p v-if="job.error" class="inline-message error">{{localize(job.error)}}</p>
    <p v-if="job.state==='uncertain'" class="inline-message error">{{t('结果不确定，请核对目标数据，不要直接重试。')}}</p>
   </template>
  </div>
  <footer class="dialog-footer"><button v-if="running" class="btn secondary danger-text" @click="cancel">{{t('取消任务')}}</button><span class="toolbar-spacer"/><button class="btn secondary" :disabled="busy||running" @click="emit('close')">{{t('关闭')}}</button><button v-if="!job" class="btn primary" :disabled="!canStart" @click="start">{{t('选择数据文件并执行')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>
.ch-file-wizard{width:min(820px,92vw);height:min(660px,90vh);display:flex;flex-direction:column}.ch-file-body{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}.ch-file-fields{flex:1;min-height:120px;overflow:auto;border:1px solid var(--border)}.ch-file-fields table{width:100%;border-collapse:collapse}.ch-file-fields td,.ch-file-fields th{text-align:start;padding:7px 10px;border-bottom:1px solid var(--border-soft)}.ch-file-fields th{position:sticky;top:0;background:var(--header-bg)}.ch-file-fields td:first-child,.ch-file-fields th:first-child{width:36px}.ch-file-metric{display:flex;flex-direction:column;gap:10px;background:var(--panel-raised);padding:16px}.ch-file-metric strong{font-size:20px}progress{width:100%;accent-color:var(--accent)}
</style>
