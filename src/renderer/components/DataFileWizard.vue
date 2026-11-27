<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import type {SessionInfo,ExplorerNode,OperationResult} from '../../shared/types'
import {fileTransferSupported,type DataFileFormat,type DataFilePolicy,type FieldMapping,type FieldConversion,type FilePreview,type FileTransferJob,type FileTransferRequest} from '../../shared/file-transfer'
import type {BrowseFilter} from '../../shared/browse-filter'
import ResultGrid from './ResultGrid.vue'
const props=defineProps<{session:SessionInfo;database:string;entity:string;direction:'import'|'export';fields?:string[];filter?:BrowseFilter;mongoFilter?:string}>()
const emit=defineEmits<{close:[];session:[SessionInfo];completed:[]}>()
const mongo=computed(()=>props.session.kind==='mongodb')
const format=ref<DataFileFormat>('jsonl'),delimiter=ref(','),preview=ref<FilePreview>(),mapping=ref<FieldMapping[]>([]),policy=ref<DataFilePolicy>('append')
const preserve=ref(true),skipInvalid=ref(false),filterEnabled=ref(false),allFields=ref(true),exportFields=ref<string[]>([]),fieldText=ref('')
const targetFields=ref<string[]>([]),busy=ref(false),error=ref(''),job=ref<FileTransferJob>(),step=ref(1)
const writable=ref(props.session.writable)
const running=computed(()=>job.value?.state==='running')
const stateLabel:Record<string,string>={running:'正在执行',completed:'操作已完成',failed:'失败',cancelled:'已取消',uncertain:'结果不确定'}
const conversions:FieldConversion[]=['auto','string','integer','decimal','double','boolean','ejson','binary']
const autoFields=computed(()=>mongo.value&&format.value==='jsonl'&&preserve.value)
const selectedFields=computed(()=>mongo.value?fieldText.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):exportFields.value)
const effectiveMapping=computed(()=>mapping.value.filter(m=>m.target.trim()))
const canStart=computed(()=>!busy.value&&!running.value&&fileTransferSupported(props.session.kind)&&(props.direction==='import'?!!preview.value&&writable.value&&(autoFields.value||effectiveMapping.value.length>0&&new Set(effectiveMapping.value.map(m=>m.target)).size===effectiveMapping.value.length):format.value==='jsonl'&&allFields.value||selectedFields.value.length>0))
const sampleRows=computed(()=>preview.value?.sample.map(row=>Object.fromEntries(Object.entries(row).map(([key,v])=>[key,v===null?null:typeof v==='string'?v:JSON.stringify(v)])))||[])
const canFilter=computed(()=>!!props.filter||!!props.mongoFilter&&props.mongoFilter!=='{}')
async function act(fn:()=>Promise<void>){if(busy.value||running.value)return;busy.value=true;error.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function initialize(){
 if(!mongo.value){const result=await window.dbex.execute(props.session.id,{action:'mysql.structure',database:props.database,entity:props.entity});targetFields.value=result.rows.filter(r=>!/GENERATED|HIDDEN/i.test(r.extra||r.Extra||'')).map(r=>String(r.name||r.Field||'')).filter(Boolean);exportFields.value=[...targetFields.value]}
 else {targetFields.value=[...(props.fields||[])];fieldText.value=targetFields.value.join('\n')}
}
function mapFields(){if(!preview.value)return;mapping.value=preview.value.fields.map(source=>({source,target:mongo.value||targetFields.value.includes(source)?source:'',conversion:'auto'}))}
async function chooseFile(){await act(async()=>{const file=await window.dbex.pickDataFile(props.session.id,format.value,delimiter.value);if(file){preview.value=file;mapFields();step.value=2}})}
async function unlock(){await act(async()=>{const s=await window.dbex.setWriteAccess(props.session.id,true);writable.value=s.writable;emit('session',s)})}
function request():FileTransferRequest{
 const base={direction:props.direction,database:props.database,entity:props.entity,format:format.value,delimiter:delimiter.value}
 if(props.direction==='import')return {...base,token:preview.value!.token,policy:policy.value,preserveDocuments:autoFields.value,mapping:autoFields.value?undefined:effectiveMapping.value,skipInvalid:skipInvalid.value}
 return {...base,fields:allFields.value&&format.value==='jsonl'?undefined:selectedFields.value,...(filterEnabled.value?{filter:props.filter,mongoFilter:props.mongoFilter}:{})}
}
async function start(){await act(async()=>{const next=await window.dbex.startFileTransfer(props.session.id,request());if(next){job.value=next;step.value=3}})}
async function cancel(){if(job.value&&running.value)try{await window.dbex.cancelFileTransfer(job.value.id)}catch(e){error.value=e instanceof Error?e.message:String(e)}}
let timer:ReturnType<typeof setInterval>|undefined,disposed=false,polling=false,notified=false
async function poll(){
 if(disposed||polling||!job.value||!running.value)return
 polling=true
 try{const next=await window.dbex.getFileTransferJob();if(!disposed&&next?.id===job.value.id){job.value=next;if(next.state==='completed'&&!notified){notified=true;emit('completed')}}}
 catch(e){if(!disposed)error.value=e instanceof Error?e.message:String(e)}finally{polling=false}
}
function back(){step.value=1;preview.value=undefined;job.value=undefined;notified=false}
watch([format,delimiter],()=>{preview.value=undefined;mapping.value=[];if(props.direction==='import')step.value=1})
watch(policy,p=>{if(p==='replace')skipInvalid.value=false})
onMounted(async()=>{await act(initialize);timer=setInterval(()=>void poll(),500)})
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);if(running.value&&job.value)void window.dbex.cancelFileTransfer(job.value.id).catch(()=>{})})
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog data-file-wizard" role="dialog" :aria-label="t(direction==='import'?'流式导入向导':'流式导出向导')">
  <header class="dialog-header"><div><h2>{{t(direction==='import'?'流式导入向导':'流式导出向导')}}</h2><span class="muted-text">{{session.name}} / {{database}} / {{entity}}</span></div><button class="icon-button" :disabled="busy||running" @click="emit('close')">×</button></header>
  <div class="file-wizard-steps"><span :class="{active:step===1}">1 · {{t('文件与格式')}}</span><span :class="{active:step===2}">2 · {{t('预览与字段映射')}}</span><span :class="{active:step===3}">3 · {{t('执行结果')}}</span></div>
  <div v-if="error" class="inline-message error" role="alert">{{localize(error)}}</div>
  <div v-if="step!==3" class="file-wizard-body">
   <div class="file-wizard-options"><label class="field">{{t('格式')}}<select v-model="format" :disabled="busy"><option value="jsonl">JSONL / EJSON</option><option value="csv">CSV</option></select></label><label v-if="format==='csv'" class="field">{{t('分隔符')}}<select v-model="delimiter" :disabled="busy"><option value=",">,</option><option value=";">;</option><option :value="'\t'">Tab</option><option value="|">|</option></select></label><span class="muted-text">UTF-8</span><button v-if="direction==='import'" class="btn secondary" :disabled="busy" @click="chooseFile">{{t('选择数据文件')}}</button><span v-if="preview" class="muted-text">{{preview.name}} · {{(preview.size/1048576).toFixed(2)}} MiB</span></div>
   <p class="compact-help">{{t('按批次流式处理，不限制文件总行数。CSV 为文本格式，JSONL 保留扩展类型；大整数请使用字符串或扩展 JSON。')}}</p>
   <template v-if="direction==='import'&&preview">
    <section class="file-sample"><strong>{{t('文件数据预览')}} · {{preview.sample.length}}</strong><ResultGrid :columns="preview.fields" :rows="sampleRows" resize-all/></section>
    <div class="file-wizard-options"><label v-if="mongo&&format==='jsonl'" class="migration-check"><input v-model="preserve" type="checkbox"/>{{t('保留完整文档（包括未出现在样本中的字段）')}}</label><label class="field">{{t('写入模式')}}<select v-model="policy"><option value="append">{{t('追加数据，冲突时停止')}}</option><option value="upsert">{{t('按主键插入或更新')}}</option><option v-if="!mongo" value="replace">{{t('清空目标表后传输')}}</option></select></label><label v-if="policy!=='replace'"><input v-model="skipInvalid" type="checkbox"/>{{t('跳过转换失败的记录')}}</label></div>
    <p v-if="policy!=='append'" class="inline-message error">{{t(policy==='replace'?'将清空目标表，请先备份。':'将更新匹配主键的记录，请确认字段映射。')}}</p>
    <div v-if="!autoFields" class="file-mapping"><table><thead><tr><th>{{t('源字段')}}</th><th>{{t('目标字段')}}</th><th>{{t('类型转换')}}</th></tr></thead><tbody><tr v-for="item in mapping" :key="item.source"><td>{{item.source}}</td><td><input v-if="mongo" v-model="item.target"/><select v-else v-model="item.target"><option value="">{{t('不导入')}}</option><option v-for="f in targetFields" :key="f" :value="f">{{f}}</option></select></td><td><select v-model="item.conversion"><option v-for="c in conversions" :key="c" :value="c">{{c}}</option></select></td></tr></tbody></table></div>
   </template>
   <template v-else-if="direction==='export'">
    <label v-if="canFilter"><input v-model="filterEnabled" type="checkbox"/>{{t('仅导出当前筛选匹配记录')}}</label>
    <label v-if="format==='jsonl'"><input v-model="allFields" type="checkbox"/>{{t('全部字段')}}</label>
    <template v-if="!allFields||format==='csv'"><label v-if="mongo" class="field">{{t('导出字段（每行一个）')}}<textarea v-model="fieldText" rows="8" spellcheck="false"/></label><div v-else class="file-mapping"><label v-for="field in targetFields" :key="field"><input type="checkbox" v-model="exportFields" :value="field"/>{{field}}</label></div></template>
    <p class="compact-help">{{t('导出全部匹配记录，而不是当前页；完成后原子发布新文件，不覆盖已有文件。')}}</p>
   </template>
   <button v-if="direction==='import'&&!writable" class="btn secondary" :disabled="busy" @click="unlock">{{t('启用写入')}}</button>
  </div>
  <div v-else-if="job" class="file-wizard-body">
   <h3>{{t(stateLabel[job.state]||job.state)}} · {{job.file}}</h3>
   <progress v-if="running" class="file-job-progress"/>
   <div class="file-job-metrics"><div><small>{{t('已读取行数')}}</small><strong>{{job.read.toLocaleString()}}</strong></div><div><small>{{t('已提交行数')}}</small><strong>{{job.committed.toLocaleString()}}</strong></div><div><small>{{t('已跳过行数')}}</small><strong>{{job.skipped.toLocaleString()}}</strong></div><div><small>{{t('读取数据量')}}</small><strong>{{(job.bytes/1048576).toFixed(2)}} MiB</strong></div></div>
   <p v-if="job.error" class="inline-message error">{{localize(job.error)}}</p><p v-if="job.state==='uncertain'" class="inline-message error">{{t('结果不确定，请核对目标数据，不要直接重试。')}}</p>
   <table v-if="job.errors?.length"><thead><tr><th>{{t('记录')}}</th><th>{{t('错误')}}</th></tr></thead><tbody><tr v-for="item in job.errors" :key="item.row"><td>{{item.row}}</td><td>{{item.code}}</td></tr></tbody></table><p v-if="job.skipped>(job.errors?.length||0)" class="compact-help">{{t('只显示前 200 条转换错误，跳过总数如上。')}}</p>
  </div>
  <footer class="dialog-footer"><button v-if="running" class="btn secondary danger-text" @click="cancel">{{t('取消任务')}}</button><button v-else-if="step!==1" class="btn secondary" :disabled="busy" @click="back">{{t('重新配置')}}</button><span class="toolbar-spacer"/><button class="btn secondary" :disabled="busy||running" @click="emit('close')">{{t('关闭')}}</button><button v-if="step!==3" class="btn primary" :disabled="!canStart" @click="start">{{t('确认执行')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.data-file-wizard{width:min(980px,94vw);height:min(760px,92vh);display:flex;flex-direction:column}.file-wizard-steps{display:flex;gap:20px;padding:12px 16px;border-bottom:1px solid var(--border);color:var(--muted)}.file-wizard-steps .active{color:var(--accent);font-weight:600}.file-wizard-body{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}.file-wizard-options{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.file-wizard-options .field{display:flex;align-items:center;gap:7px}.file-sample{display:flex;flex-direction:column;height:210px;min-height:100px;border:1px solid var(--border);padding:6px;gap:4px}.file-mapping{overflow:auto;min-height:120px;max-height:320px;border:1px solid var(--border)}.file-mapping table{width:100%;border-collapse:collapse}.file-mapping th,.file-mapping td{padding:6px 9px;text-align:start;border-bottom:1px solid var(--border-soft)}.file-mapping th{position:sticky;top:0;background:var(--header-bg)}.file-mapping>label{display:flex;padding:5px;gap:6px}.file-job-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.file-job-metrics>div{display:flex;flex-direction:column;gap:7px;background:var(--panel-raised);padding:12px}.file-job-metrics strong{font-size:20px}.file-job-metrics small{color:var(--muted)}.file-job-progress{width:100%;height:10px;accent-color:var(--accent)}</style>
