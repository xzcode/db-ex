<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import {preferences} from '../preferences'
import {pageSizeFor} from '../../shared/preferences'
import {changeColumnSort,type ColumnAction} from '../../shared/column-actions'
import type {SortRule} from '../../shared/browse-filter'
import type {ClickHouseChange,ClickHouseTransferFormat,ClickHouseManagementView,ClickHouseOperation,ExplorerNode,OperationResult,SessionInfo,SqlRow} from '../../shared/types'
import {csvFromRows,sqlRowsFromFile} from '../data-format'
import ResultGrid from './ResultGrid.vue'
import ObjectInspector from './ObjectInspector.vue'
import {globalInspectorTab,openGlobalInspector,closeGlobalInspector} from '../inspector-preferences'
import ClickHouseAdminDialog from './ClickHouseAdminDialog.vue'
import ClickHouseFileWizard from './ClickHouseFileWizard.vue'
const props=defineProps<{session:SessionInfo;node:ExplorerNode;active:boolean;initialTab?:string;requestedTab?:string;tabRequest?:number}>()
const emit=defineEmits<{busyChange:[boolean];updateSession:[SessionInfo];disconnect:[];tabChange:['data'|'structure'|'management'];dirtyChange:[boolean]}>()
const database=props.node.database||'',entity=props.node.entity||''
const tab=ref<'data'|'structure'|'management'>(props.initialTab==='structure'?'structure':props.initialTab==='management'&&!props.node.readOnly?'management':'data')
const busy=ref(false),running=ref(false),error=ref(''),notice=ref('')
const result=ref<OperationResult>(),structure=ref<OperationResult>(),inspection=ref<OperationResult['inspection']>()
const managementViews: {value:ClickHouseManagementView;label:string}[]=[
 {value:'partitions',label:'分区'},{value:'mutations',label:'变更任务'},{value:'replicas',label:'副本状态'},{value:'replicationQueue',label:'复制队列'},{value:'topology',label:'集群拓扑'},{value:'queries',label:'查询统计'}
]
const managementView=ref<ClickHouseManagementView>('partitions'),managementResult=ref<OperationResult>(),managementOffset=ref(0)
const canManage=computed(()=>props.node.kind==='table'&&!props.node.readOnly)
const inspector=globalInspectorTab
const inspected=ref(false)
const pageSize=ref<number>(pageSizeFor(preferences.value,'clickhouse')),offset=ref(0)
const sort=ref<SortRule[]>([]),filter=ref<{field:string;value:string}>(),filterDraft=ref<{field:string;value:string}>()
const importRows=ref<SqlRow[]>(),importText=ref('')
const adminDraft=ref<ClickHouseChange['kind']>(),adminBusy=ref(false),adminFields=ref<Record<string,string>[]>([])
const fileWizard=ref<'import'|'export'>(),backupId=ref(''),backupResult=ref<OperationResult>()
const backupNotice=ref('')
const canInsert=computed(()=>props.session.writable&&!props.node.readOnly&&database!=='system')
const target={database,entity}
async function openAdmin(kind:ClickHouseChange['kind']){
 if(!canManage.value||!props.session.writable)return
 await task(async()=>{
  if(!structure.value)structure.value=await execute({action:'clickhouse.structure',...target})
  adminFields.value=structure.value.rows;adminDraft.value=kind;emit('dirtyChange',true)
 })
}
function closeAdmin(){adminDraft.value=undefined;emit('dirtyChange',false)}
function adminSubmitted(value:OperationResult){notice.value=value.message||'ClickHouse 操作已提交，请刷新任务状态；取消不回滚已完成的修改。';if(value.backupId){backupId.value=value.backupId;backupResult.value=undefined;backupNotice.value=value.backupId}}
async function checkBackup(){await task(async()=>{backupResult.value=await execute({action:'clickhouse.backupStatus',...target,backupId:backupId.value.trim()})})}
function openFileWizard(direction:'import'|'export'){
 if(busy.value||adminBusy.value||direction==='import'&&!canInsert.value)return
 fileWizard.value=direction
}
function closeFileWizard(){const imported=fileWizard.value==='import';fileWizard.value=undefined;emit('busyChange',false);if(imported)void load(offset.value)}
function adminBusyChanged(value:boolean){adminBusy.value=value;emit('busyChange',value)}

let disposed=false
async function task(fn:()=>Promise<void>){if(busy.value||disposed)return;busy.value=true;emit('busyChange',true);error.value='';notice.value='';try{await fn()}catch(e){if(!disposed)error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false;emit('busyChange',false)}}
async function execute(operation:ClickHouseOperation){running.value=true;try{return await window.dbex.execute(props.session.id,operation)}finally{running.value=false}}
async function load(next=0,nextSort=sort.value,nextFilter:typeof filter.value|null=filter.value,size=pageSize.value){
 await task(async()=>{
   const value=await execute({action:'clickhouse.browse',...target,limit:size,offset:next,sort:nextSort,filter:nextFilter||undefined})
   if(disposed)return
   result.value=value;offset.value=next;sort.value=nextSort;filter.value=nextFilter||undefined;pageSize.value=size
 })
}
async function loadManagement(view=managementView.value,next=0){
 if(!canManage.value||busy.value||disposed)return
 managementView.value=view
 managementOffset.value=next
 managementResult.value=undefined
 await task(async()=>{
  const value=await execute({action:'clickhouse.management',...target,view,limit:pageSize.value,offset:next})
  if(disposed)return
  managementResult.value=value;managementOffset.value=next
 })
}
async function changeTab(value:'data'|'structure'|'management',force=false){
 if(value==='management'&&!canManage.value)return
 tab.value=value;emit('tabChange',value)
 if(value==='structure'&&(force||!structure.value))await task(async()=>{structure.value=await execute({action:'clickhouse.structure',...target})})
 if(value==='management'&&(force||!managementResult.value))await loadManagement(managementView.value,managementOffset.value)
 if(value==='data'&&!result.value)await load()
}
function openInspector(value:'info'|'ddl'|'colors'){openGlobalInspector(value)}
async function refreshInspection(){if(!props.active||busy.value||disposed)return;inspected.value=true;await task(async()=>{inspection.value=(await execute({action:'clickhouse.inspect',...target})).inspection})}
watch([inspector,()=>props.active,busy],()=>{if(props.active&&inspector.value&&inspector.value!=='colors'&&!inspected.value&&!busy.value)void refreshInspection()},{flush:'post'})
async function action(action:ColumnAction,field:string){
 if(action==='filter'){filterDraft.value={field,value:''};return}
 await load(0,changeColumnSort(sort.value,field,action))
}
async function applyFilter(){if(filterDraft.value){const next={...filterDraft.value};await load(0,sort.value,next);if(!error.value)filterDraft.value=undefined}}
async function unlock(){await task(async()=>emit('updateSession',await window.dbex.setWriteAccess(props.session.id,!props.session.writable)))}
async function importFile(){if(!canInsert.value)return;await task(async()=>{const file=await window.dbex.importFile();if(file){const rows=sqlRowsFromFile(file);importRows.value=rows;importText.value=JSON.stringify(rows,null,2);emit('dirtyChange',true)}})}
function closeImport(){importRows.value=undefined;importText.value='';emit('dirtyChange',false)}
async function insert(){
 if(!canInsert.value||!importRows.value)return
 let success=false
 await task(async()=>{
  const rows=JSON.parse(importText.value) as SqlRow[]
  const next=await execute({action:'clickhouse.insert',...target,rows,confirmed:true})
  notice.value=next.message||'操作已完成';success=true;closeImport()
 })
 if(success)await load(offset.value)
}
async function exportData(format:'csv'|'json'){await task(async()=>{
 const rows=result.value?.rawRows;if(!rows)return
 const name=entity.replace(/[^a-zA-Z0-9_.-]/g,'_')||'clickhouse'
 // This is an exact textual page representation, with server type metadata.
 const content=format==='csv'?csvFromRows(result.value!.columns,rows):JSON.stringify({columns:result.value!.columns,types:result.value!.columnTypes,rows},null,2)
 if(await window.dbex.exportFile(name+'.'+format,content,format))notice.value='操作已完成'
})}
async function cancel(){try{await window.dbex.cancel(props.session.id);emit('disconnect')}catch(e){error.value=String(e)}}
onMounted(()=>{if(props.node.kind==='clickhouse-dictionary'){tab.value='structure';if(inspector.value)void refreshInspection()}else if(tab.value!=='data')void changeTab(tab.value);else void load();if(inspector.value&&!busy.value)void refreshInspection()})
watch(()=>props.tabRequest,()=>{if(props.requestedTab==='structure'||props.requestedTab==='data'||props.requestedTab==='management')void changeTab(props.requestedTab)})
onBeforeUnmount(()=>{disposed=true})
</script>
<template>
 <div class="workbench-shell">
  <section class="workbench clickhouse-workbench">
   <header class="workbench-header"><div><h2>{{ entity }}</h2><span class="muted-text">{{ database }}</span></div><div class="header-tools"><button class="btn secondary" :disabled="busy" @click="unlock">{{ session.writable?t('写入已启用 · 锁定'):t('只读 · 启用写入') }}</button></div></header>
   <nav class="workbench-tabs"><button :class="{active:tab==='data'}" :disabled="busy||node.kind==='clickhouse-dictionary'" @click="changeTab('data')">{{ t('数据') }}</button><button :class="{active:tab==='structure'}" :disabled="busy" @click="changeTab('structure')">{{ t('结构') }}</button><button v-if="canManage" :class="{active:tab==='management'}" :disabled="busy" @click="changeTab('management')">{{ t('管理') }}</button><span class="toolbar-spacer"></span><button :disabled="busy" @click="openInspector('info')">{{ t('对象信息') }}</button><button :disabled="busy" @click="openInspector('ddl')">DDL</button><button :disabled="busy" @click="openInspector('colors')">{{ t('数据类型配色') }}</button></nav>
   <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div><div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
   <div class="editor-toolbar"><button class="btn secondary small" :disabled="busy" @click="tab==='data'?load(offset):changeTab(tab,true)">{{ t('刷新') }}</button><template v-if="tab==='data'"><button class="btn secondary small" :disabled="busy||!canInsert" @click="importFile">{{ t('导入 CSV / JSON') }}</button><button class="btn secondary small" :disabled="busy||!result?.rawRows" @click="exportData('csv')">{{ t('导出 CSV') }}</button><button class="btn secondary small" :disabled="busy||!result?.rawRows" @click="exportData('json')">{{ t('导出 JSON') }}</button><button v-if="filter" class="btn secondary small" :disabled="busy" @click="load(0,sort,null)">{{ t('清除筛选') }}</button></template><span class="toolbar-spacer"></span><button v-if="running" class="btn secondary small" @click="cancel">{{ t('取消并断开') }}</button></div>
   <div v-if="filterDraft&&tab==='data'" class="editor-toolbar"><span>{{ filterDraft.field }} · toString()</span><input v-model="filterDraft.value" :aria-label="t('筛选条件')" @keydown.enter="applyFilter" /><button class="btn primary small" :disabled="busy" @click="applyFilter">{{ t('查询') }}</button><button class="btn secondary small" @click="filterDraft=undefined">{{ t('取消') }}</button></div>
   <div v-if="tab==='management'" class="editor-toolbar" data-ch-management>
    <button v-for="view in managementViews" :key="view.value" class="btn secondary small" :class="{primary:managementView===view.value}" :aria-pressed="managementView===view.value" :disabled="busy" @click="loadManagement(view.value)">{{ t(view.label) }}</button>
    <span v-if="managementView==='queries'" class="muted-text">{{ t('本节点最近24小时已记录查询；日志可能延迟或未启用') }}</span>
    <span v-else class="muted-text">{{ t(managementView==='topology'?'服务器配置的分片与副本；不代表实时连通性':'本节点 · 只读') }}</span>
    <span class="toolbar-spacer"></span>
    <button v-if="managementView==='mutations'" class="btn secondary small" :disabled="busy||!session.writable" @click="openAdmin('update')">{{t('变更任务')}}…</button>
    <button v-if="managementView==='partitions'" class="btn secondary small" :disabled="busy||!session.writable" @click="openAdmin('detachPartition')">{{t('分区')}}…</button>
    <button class="btn secondary small" :disabled="busy||!session.writable" @click="openAdmin('backup')">{{t('备份数据库')}} / {{t('恢复数据库')}}…</button>

   </div>
   <div v-if="tab==='data'&&canManage" class="editor-toolbar">
    <button class="btn secondary small" :disabled="busy||!canInsert" @click="openFileWizard('import')">{{t('流式导入向导')}}</button>
    <button class="btn secondary small" :disabled="busy" @click="openFileWizard('export')">{{t('流式导出向导')}}</button>
   </div>
   <div v-if="tab==='management'" class="editor-toolbar">
    <input v-model="backupId" placeholder="Backup ID" maxlength="160" :disabled="busy" aria-label="Backup ID"/>
    <button class="btn secondary small" :disabled="busy||!backupId.trim()" @click="checkBackup">{{t('备份任务状态')}}</button>
    <span v-if="backupNotice" class="muted-text">{{backupNotice}}</span>
   </div>
   <div v-if="tab==='management'&&backupResult" class="inline-message notice" role="status">
    {{ backupResult.rows[0]?.status || t('未找到任务') }} · {{backupResult.rows[0]?.total_size || '0'}} bytes {{backupResult.rows[0]?.error||''}}
    <button class="btn secondary small" @click="backupResult=undefined">×</button>
   </div>
   <ResultGrid v-if="tab==='data'&&result" :columns="result.columns" :rows="result.rows" :column-types="result.columnTypes" :null-cells="result.nullCells" relational-kind="clickhouse" :offset="offset" :action-columns="busy?[]:result.columns" :column-sort="sort" :active="active" @column-action="action"/>
   <ResultGrid v-else-if="tab==='structure'&&structure" :columns="structure.columns" :rows="structure.rows" />
   <ResultGrid v-else-if="tab==='management'&&managementResult" :columns="managementResult.columns" :rows="managementResult.rows" :column-types="managementResult.columnTypes" :null-cells="managementResult.nullCells" relational-kind="clickhouse" :offset="managementOffset" :active="active" />
   <div v-else class="empty-state">{{ t(busy?'正在加载资源…':'无可见对象') }}</div>
   <footer class="result-footer"><span>{{ (tab==='data'?result:tab==='structure'?structure:managementResult)?.rows.length||0 }} {{ t('条记录') }}<template v-if="(tab==='data'?result:tab==='structure'?structure:managementResult)?.truncated"> · {{ t('结果已截断') }}</template></span><div v-if="tab==='data'"><select :value="pageSize" :disabled="busy" @change="load(0,sort,filter,Number(($event.target as HTMLSelectElement).value))"><option v-for="n in [100,200,500]" :value="n" :key="n">{{ n }}</option></select><button class="btn secondary small" :disabled="busy||offset===0" @click="load(Math.max(0,offset-pageSize))">{{ t('上一页') }}</button><button class="btn secondary small" :disabled="busy||result?.nextOffset===undefined" @click="result?.nextOffset!==undefined&&load(result.nextOffset)">{{ t('下一页') }}</button></div><div v-else-if="tab==='management'&&managementView!=='queries'"><button class="btn secondary small" :disabled="busy||managementOffset===0" @click="loadManagement(managementView,Math.max(0,managementOffset-pageSize))">{{ t('上一页') }}</button><button class="btn secondary small" :disabled="busy||managementResult?.nextOffset===undefined" @click="managementResult?.nextOffset!==undefined&&loadManagement(managementView,managementResult.nextOffset)">{{ t('下一页') }}</button></div></footer>
   <ClickHouseFileWizard v-if="fileWizard&&active" :session="session" :database="database" :entity="entity" :direction="fileWizard" :filter="filter" @busy-change="emit('busyChange',$event)" @close="closeFileWizard"/>
   <ClickHouseAdminDialog v-if="adminDraft" :session="session" :database="database" :entity="entity" :fields="adminFields" :initial-kind="adminDraft" :execute="execute" @busy-change="adminBusyChanged" @submitted="adminSubmitted" @close="closeAdmin" @cancel="cancel"/>
   <div v-if="importRows" class="modal-backdrop"><section class="dialog" role="dialog" :aria-label="t('导入预览')"><header class="dialog-header"><h2>{{ t('导入预览') }}</h2></header><div class="dialog-body"><p class="helper">{{ database }}.{{ entity }} · {{ importRows.length }} · MergeTree</p><p v-if="error" role="alert">{{ localize(error) }}</p><textarea v-model="importText" rows="12" spellcheck="false" :disabled="busy"/></div><footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="closeImport">{{ t('取消') }}</button><button class="btn primary" :disabled="busy||!canInsert" @click="insert">{{ t('审阅并保存') }}</button></footer></section></div>
  </section>
  <ObjectInspector v-if="active&&inspector" :kind="session.kind" :database="database" :connection="session.name" :busy="busy" :tab="inspector" :name="entity" :inspection="inspection" :loading="busy" :error="error" @change="openInspector" @close="closeGlobalInspector" @refresh="refreshInspection" />
 </div>
</template>
