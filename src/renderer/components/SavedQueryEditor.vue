<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import {preferences} from '../preferences'
import {pageSizeFor} from '../../shared/preferences'
import {querySummary,type QueryMode,type QueryDraft,type SavedQuery,type QuerySummary} from '../../shared/saved-query'
import type {SessionInfo,ExplorerNode,QuerySnippet,DatabaseOperation,OperationResult,SqlValue} from '../../shared/types'
import CodeEditor from './CodeEditor.vue'
import ResultGrid from './ResultGrid.vue'
import {useQueryRecovery} from '../composables/useQueryRecovery'
const props=defineProps<{session:SessionInfo;node:ExplorerNode;active:boolean;tableSuggestions?:string[]}>()
const emit=defineEmits<{saved:[value:QuerySummary];busyChange:[value:boolean];dirtyChange:[value:boolean];updateSession:[session:SessionInfo];disconnect:[]}>()
const database=props.node.database||''
const mode:QueryMode=props.node.queryMode||'sql'
const clickhouse=props.session.kind==='clickhouse'
const currentId=ref(props.node.queryId),revision=ref('')
const name=ref(''),sql=ref(''),parameters=ref(clickhouse?'{}':'[]'),entity=ref(''),filter=ref('{}'),projection=ref('{}'),sort=ref('{}'),pipeline=ref('[\n  { "$limit": 100 }\n]')
const result=ref<OperationResult>(),offset=ref(0),limit=ref<number>(pageSizeFor(preferences.value,props.session.kind))
const busy=ref(false),running=ref(false),loaded=ref(false),error=ref(''),notice=ref('')
const targets=ref<ExplorerNode[]>([]),legacy=ref<QuerySnippet[]>([]),legacySelected=ref('')
const baseline=ref('')
const editor=ref<InstanceType<typeof CodeEditor>>()
const saveAsOpen=ref(false),copyName=ref('')
let disposed=false
let applied:DatabaseOperation|undefined
const draft=computed<QueryDraft>(()=>({name:name.value.trim(),mode,text:mode==='sql'?sql.value:mode==='mongo-aggregation'?pipeline.value:JSON.stringify({filter:filter.value,projection:projection.value,sort:sort.value}),...(mode==='sql'?{parameters:parameters.value}:{entity:entity.value})}))
const fingerprint=computed(()=>JSON.stringify(draft.value))
const dirty=computed(()=>loaded.value&&fingerprint.value!==baseline.value)
const canPersist=computed(()=>!!props.session.connectionId&&!!database)
watch(busy,value=>emit('busyChange',value),{flush:'sync'})
watch(dirty,value=>emit('dirtyChange',value),{flush:'sync'})
function fail(reason:unknown){error.value=reason instanceof Error?reason.message:String(reason)}
async function task(fn:()=>Promise<void>){if(busy.value||disposed)return;busy.value=true;error.value='';notice.value='';try{await fn()}catch(reason){if(!disposed)fail(reason)}finally{busy.value=false}}
function apply(value:QueryDraft){
 name.value=value.name
 if(mode==='sql'){sql.value=value.text;parameters.value=value.parameters||(clickhouse?'{}':'[]')}
 else{entity.value=value.entity||'';if(mode==='mongo-aggregation')pipeline.value=value.text;else{const parts=JSON.parse(value.text);filter.value=parts.filter;projection.value=parts.projection;sort.value=parts.sort}}
}
const recovery=useQueryRecovery(()=>loaded.value&&currentId.value&&props.session.connectionId?{connectionId:props.session.connectionId,database,entity:currentId.value,kind:'saved-query'}:undefined,()=>fingerprint.value,text=>{
 const value=JSON.parse(text)
 if(value.mode===mode&&typeof value.name==='string'&&typeof value.text==='string')apply(value)
})
function applySaved(item:SavedQuery){apply(item);currentId.value=item.id;revision.value=item.revision;baseline.value=fingerprint.value}
onMounted(()=>{void task(async()=>{
 if(currentId.value)applySaved(await window.dbex.getSavedQuery(props.session.id,database,currentId.value))
 if(mode!=='sql'){
  try{
   const collections=await window.dbex.children(props.session.id,database,'collections')
   const views=await window.dbex.children(props.session.id,database,'views')
   targets.value=[...collections,...views]
  }catch(reason){fail(reason)}
 }
 // Existing historical favorites remain available, but are only adopted by
 // explicit user choice and saved into the currently selected connection.
 const history=await window.dbex.listSnippets().catch(()=>[])
 legacy.value=history.filter(item=>item.kind===props.session.kind&&item.favorite&&(!item.database||item.database===database)&&(!item.connectionId||item.connectionId===props.session.connectionId)&&(mode==='sql'||(mode==='mongo-find'?item.mongoKind==='query':!item.mongoKind||item.mongoKind==='aggregation')))
 if(!currentId.value)baseline.value=fingerprint.value
 loaded.value=true
})})
function loadLegacy(){
 const item=legacy.value.find(x=>x.id===legacySelected.value)
 if(!item||busy.value)return
 try{apply({name:item.name,mode,text:item.text,entity:item.entity,parameters:item.parameters})}catch(reason){fail(reason)}
}
async function save(asCopy=false){
 if(!canPersist.value||!loaded.value||busy.value)return
 const nextName=(asCopy?copyName.value:name.value).trim()
 if(!nextName){if(!asCopy){copyName.value='';saveAsOpen.value=true}else error.value='请填写查询名称。';return}
 await task(async()=>{
  const input={draft:{...draft.value,name:nextName},...(!asCopy&&currentId.value?{id:currentId.value,revision:revision.value}:{})}
  const item=await window.dbex.saveQueryObject(props.session.id,database,input)
  if(disposed)return
  // Saving a copy keeps the original editor's recovery entry intact.
  if(!asCopy)recovery.clear(true)
  applySaved(item);saveAsOpen.value=false;notice.value='保存成功';emit('saved',querySummary(item))
 })
}
function openSaveAs(){if(canPersist.value&&!busy.value){copyName.value=name.value?name.value.slice(0,91)+' (2)':'';saveAsOpen.value=true}}
function shortcut(event:KeyboardEvent){
 if(!props.active||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='s')return
 event.preventDefault();event.stopPropagation()
 if(event.shiftKey)openSaveAs();else if(!saveAsOpen.value)void save()
}
onMounted(()=>window.addEventListener('keydown',shortcut,true))
onBeforeUnmount(()=>{disposed=true;window.removeEventListener('keydown',shortcut,true)})
async function execute(paging?:number,selection=false){
 if(!loaded.value||busy.value)return
 await task(async()=>{
  let op:DatabaseOperation
  if(paging!==undefined){
   if(!applied||!('offset'in applied))return
   op={...applied,offset:paging}
  }else if(mode==='sql'){
   const params:unknown=JSON.parse(parameters.value)
   if(!clickhouse&&(!Array.isArray(params)||params.length>1000||params.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))))throw new Error('SQL 参数需要 JSON 数组，仅支持字符串、数字、布尔或 null')
   if(clickhouse&&(!params||typeof params!=='object'||Array.isArray(params)))throw new Error('ClickHouse 参数需要 JSON 对象')
   const text=selection?editor.value?.selection()||sql.value:sql.value
   if(!text.trim())throw new Error('SQL_POLICY: SQL 不能为空')
   op=clickhouse?{action:'clickhouse.query',database,sql:text,parameters:params as Record<string,SqlValue>,limit:limit.value,confirmed:props.session.writable}:{action:'mysql.query',database,sql:text,parameters:params as SqlValue[],limit:limit.value,offset:0,confirmed:props.session.writable}
  }else{
   if(!targets.value.some(n=>n.entity===entity.value))throw new Error('请选择目标集合或视图。')
   op=mode==='mongo-find'?{action:'mongo.find',database,entity:entity.value,filter:filter.value,projection:projection.value,sort:sort.value,limit:limit.value,offset:0}:{action:'mongo.aggregate',database,entity:entity.value,pipeline:pipeline.value,limit:limit.value}
  }
  running.value=true
  let next:OperationResult
  try{next=await window.dbex.execute(props.session.id,op)}finally{running.value=false}
  if(disposed)return
  result.value=next;offset.value='offset'in op?op.offset||0:0;applied=op
  if(next.transaction!==undefined)emit('updateSession',{...props.session,transaction:next.transaction})
  if(next.disconnected){emit('disconnect');return}
  if(next.message)notice.value=next.message
  if(preferences.value.records.recordHistory&&mode==='sql'&&(op.action==='mysql.query'||op.action==='clickhouse.query')){
   await window.dbex.saveSnippet({name:op.sql.trim().split('\n')[0].slice(0,80),kind:props.session.kind,database,connectionId:props.session.connectionId,text:op.sql,parameters:JSON.stringify(op.parameters||(clickhouse?{}:[])),favorite:false}).catch(()=>{})
  }
 })
}
async function toggleWrite(){await task(async()=>emit('updateSession',await window.dbex.setWriteAccess(props.session.id,!props.session.writable)))}
async function transaction(action:'mysql.begin'|'mysql.commit'|'mysql.rollback'){await task(async()=>{const next=await window.dbex.execute(props.session.id,{action,confirmed:true});emit('updateSession',{...props.session,transaction:!!next.transaction});notice.value=next.message||''})}
async function cancel(){try{await window.dbex.cancel(props.session.id);emit('disconnect')}catch(reason){fail(reason)}}
async function exportQuery(format:'json'|'sql'){if(!currentId.value)return;await task(async()=>{if(await window.dbex.exportSavedQuery(props.session.id,database,currentId.value!,format))notice.value='操作已完成'})}
</script>
<template>
 <section :class="['workbench','saved-query-editor',{'mongo-library':mode!=='sql'}]">
  <header class="workbench-header"><div><h2>{{ name||t('未命名查询') }}</h2><span class="muted-text">{{ database }}</span></div><div class="header-tools" v-if="mode==='sql'"><span v-if="session.transaction" class="transaction-badge">{{ t('事务进行中') }}</span><button :class="['btn',session.writable?'warning':'secondary']" :disabled="busy" @click="toggleWrite">{{ session.writable?t('写入已启用 · 锁定'):t('只读 · 启用写入') }}</button></div></header>
  <div class="editor-toolbar query-object-toolbar">
   <button class="btn primary small" :disabled="busy||!loaded||!canPersist" :title="'Ctrl / ⌘ + S'" @click="save()"><span aria-hidden="true">▣</span> {{ t('保存') }}</button>
   <button class="btn secondary small" :disabled="busy||!loaded||!canPersist" @click="openSaveAs">{{ t('另存为') }}</button>
   <button class="btn secondary small" :disabled="busy||!currentId" @click="exportQuery('json')">{{ t('导出查询') }}</button>
   <button v-if="mode==='sql'" class="btn secondary small" :disabled="busy||!currentId" @click="exportQuery('sql')">{{ t('导出 SQL') }}</button>
   <span class="toolbar-spacer"></span><label class="inline-field" v-if="legacy.length">{{ t('历史 / 收藏') }}<select v-model="legacySelected" :disabled="busy"><option value="">{{ t('未选择对象') }}</option><option v-for="item in legacy" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><button v-if="legacy.length" class="btn secondary small" :disabled="busy||!legacySelected" @click="loadLegacy">{{ t('载入') }}</button>
  </div>
  <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div><div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
  <div v-if="!canPersist" class="compact-help">{{ t('请先保存数据库连接，再保存查询。') }}</div>
  <div v-if="recovery.available.value" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="recovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="recovery.dismiss">{{ t('放弃草稿') }}</button></div>
  <div class="query-object-fields">
   <label class="field"><span>{{ t('名称') }}</span><input v-model="name" :aria-label="t('名称')" maxlength="100" :disabled="busy||!loaded" :placeholder="t('未命名查询')" /></label>
   <label v-if="mode!=='sql'" class="field"><span>{{ t('目标集合或视图') }}</span><select v-model="entity" :aria-label="t('目标集合或视图')" :disabled="busy||!loaded"><option value="">{{ t('未选择对象') }}</option><option v-if="entity&&!targets.some(item=>item.entity===entity)" :value="entity" disabled>{{ entity }}</option><option v-for="item in targets" :key="item.id" :value="item.entity">{{ item.label }}</option></select></label>
   <label class="field"><span>{{ t('每页') }}</span><select v-model.number="limit" :disabled="busy"><option v-for="n in [100,200,500]" :key="n" :value="n">{{ n }}</option></select></label>
  </div>
  <div class="editor-toolbar">
   <button class="btn primary small" :disabled="busy||!loaded||(mode!=='sql'&&!entity)" @click="execute(undefined,true)">{{ mode==='sql'?t('运行选中 / 全部'):mode==='mongo-find'?t('查询'):t('运行 Aggregation') }}</button>
   <button v-if="running" class="btn secondary small" @click="cancel">{{ t('取消并断开') }}</button>
   <span class="toolbar-spacer"></span>
   <template v-if="mode==='sql'&&!clickhouse"><button class="btn secondary small" :disabled="busy||!session.writable||session.transaction" @click="transaction('mysql.begin')">{{ t('开始事务') }}</button><button class="btn secondary small" :disabled="busy||!session.transaction" @click="transaction('mysql.commit')">{{ t('提交') }}</button><button class="btn secondary small" :disabled="busy||!session.transaction" @click="transaction('mysql.rollback')">{{ t('回滚') }}</button></template>
  </div>
  <template v-if="mode==='sql'">
   <div class="query-editor"><CodeEditor ref="editor" v-model="sql" language="sql" :readonly="busy||!loaded" :table-suggestions="tableSuggestions" @execute="execute(undefined,true)" /></div>
   <label class="parameter-line">{{ t('参数') }}<input v-model="parameters" :aria-label="clickhouse?t('ClickHouse 参数 JSON 对象'):t('SQL 参数 JSON 数组')" spellcheck="false" :disabled="busy||!loaded" /></label>
  </template>
  <div v-else-if="mode==='mongo-aggregation'" class="query-editor"><CodeEditor v-model="pipeline" language="json" completion-kind="mongodb" :readonly="busy||!loaded" @execute="execute()" /></div>
  <div v-else class="library-query-parts"><label class="field">Filter<textarea v-model="filter" aria-label="Filter" :disabled="busy||!loaded" spellcheck="false" /></label><label class="field">Projection<textarea v-model="projection" aria-label="Projection" :disabled="busy||!loaded" spellcheck="false" /></label><label class="field">Sort<textarea v-model="sort" aria-label="Sort" :disabled="busy||!loaded" spellcheck="false" /></label></div>
  <ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :documents="result.documents" :bson-types="result.bsonTypes" :column-types="result.columnTypes" :sqlite-types="result.sqliteTypes" :null-cells="result.nullCells" :relational-kind="clickhouse?'clickhouse':session.kind==='mariadb'?'mariadb':'mysql'" :offset="offset" :active="active" />
  <div v-else class="empty-state"><strong>{{ t('运行查询查看结果') }}</strong></div>
  <footer class="result-footer"><span>{{ result?.rows.length||0 }} {{ t('条记录') }}<template v-if="result?.truncated"> · {{ t('结果已截断') }}</template><template v-if="result?.queryId"> · {{ result.queryId }}</template></span><div v-if="!clickhouse"><button class="btn secondary small" :disabled="busy||offset===0||!applied" @click="execute(Math.max(0,offset-limit))">{{ t('上一页') }}</button><button class="btn secondary small" :disabled="busy||result?.nextOffset===undefined" @click="execute(result?.nextOffset)">{{ t('下一页') }}</button></div></footer>
  <div v-if="saveAsOpen" class="modal-backdrop"><section class="dialog" role="dialog" :aria-label="t('另存为')"><header class="dialog-header"><h2>{{ t('另存为') }}</h2></header><div class="dialog-body"><label class="field field-wide">{{ t('名称') }}<input v-model="copyName" :aria-label="t('名称')" maxlength="100" /></label><p v-if="error" role="alert">{{ localize(error) }}</p></div><footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="saveAsOpen=false">{{ t('取消') }}</button><button class="btn primary" :disabled="busy||!copyName.trim()" @click="save(true)">{{ t('保存') }}</button></footer></section></div>
 </section>
</template>
<style scoped>
.query-object-fields{display:flex;gap:12px;align-items:end;padding:8px 12px;border-bottom:1px solid var(--border-soft);flex:none}.query-object-fields .field{flex:1;min-width:0}.query-object-fields .field:last-child{flex:0 0 86px}.query-object-toolbar{gap:6px}.saved-query-editor .workbench-header h2{margin:0}.saved-query-editor .library-query-parts{min-height:140px}.saved-query-editor .library-query-parts textarea{min-height:95px}
</style>
