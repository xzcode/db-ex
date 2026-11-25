<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t, localize } from '../i18n'
import { preferences } from '../preferences'
import { useQueryRecovery } from '../composables/useQueryRecovery'
import type { SessionInfo, QuerySnippet, MongoOperation, OperationResult, ExplorerNode } from '../../shared/types'
import CodeEditor from './CodeEditor.vue'
import ResultGrid from './ResultGrid.vue'
const props=defineProps<{session:SessionInfo;database:string;kind:'query'|'aggregation';busy:boolean;run:(op:MongoOperation)=>Promise<OperationResult>}>()
const emit=defineEmits<{disconnect:[]}>()
const entries=ref<QuerySnippet[]>([]), targets=ref<ExplorerNode[]>([])
const selected=ref(''), name=ref(''), entity=ref('')
const filter=ref('{}'),projection=ref('{}'),sort=ref('{}'),pipeline=ref('[\n  { "$limit": 100 }\n]')
const limit=ref<number>(preferences.value.records.mongoPageSize),offset=ref(0),result=ref<OperationResult>()
const loading=ref(false),error=ref(''),notice=ref('')
let disposed=false
const applied=ref<Extract<MongoOperation,{action:'mongo.find'}>>()
const busyAll=computed(()=>props.busy||loading.value)
const saved=computed(()=>entries.value.filter(item=>item.kind==='mongodb' && item.database===props.database && item.favorite && (item.mongoKind||'aggregation')===props.kind && (!item.connectionId||item.connectionId===props.session.connectionId)))
function fail(reason:unknown){error.value=reason instanceof Error?reason.message:String(reason)}
async function refresh(){
  if(busyAll.value)return
  loading.value=true;error.value=''
  try{
    entries.value=await window.dbex.listSnippets()
    const collections=await window.dbex.children(props.session.id,props.database,'collections')
    if(disposed)return
    const views=await window.dbex.children(props.session.id,props.database,'views')
    if(disposed)return
    targets.value=[...collections,...views]
  }catch(reason){if(!disposed)fail(reason)}
  finally{loading.value=false}
}
function reset(){
  selected.value='';name.value='';entity.value='';filter.value='{}';projection.value='{}';sort.value='{}';pipeline.value='[\n  { "$limit": 100 }\n]';result.value=undefined;applied.value=undefined;offset.value=0;error.value='';notice.value=''
}
function jsonObject(text:string):Record<string,unknown>{
  const value:unknown=JSON.parse(text||'{}')
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('格式无效，请检查 JSON / BSON / SQL 输入')
  return value as Record<string,unknown>
}
function validateDraft(){
  if(!targets.value.some(item=>item.entity===entity.value))throw new Error('请选择目标集合或视图。')
  if(props.kind==='aggregation'){
    const stages:unknown=JSON.parse(pipeline.value)
    if(!Array.isArray(stages)||stages.length>100)throw new Error('INVALID_PIPELINE: 管线必须是最多 100 个阶段的数组')
    return pipeline.value
  }
  jsonObject(filter.value);jsonObject(projection.value);jsonObject(sort.value)
  return JSON.stringify({filter:filter.value,projection:projection.value,sort:sort.value})
}
function openSaved(){
  const item=saved.value.find(x=>x.id===selected.value)
  if(!item){reset();return}
  error.value='';notice.value='';result.value=undefined;applied.value=undefined
  try{
    name.value=item.name
    entity.value=targets.value.some(x=>x.entity===item.entity)?item.entity!:''
    if(props.kind==='aggregation')pipeline.value=item.text
    else {
      const query=jsonObject(item.text)
      if(typeof query.filter!=='string'||typeof query.projection!=='string'||typeof query.sort!=='string')throw new Error('格式无效，请检查 JSON / BSON / SQL 输入')
      filter.value=query.filter;projection.value=query.projection;sort.value=query.sort
    }
  }catch(reason){fail(reason)}
}
async function save(){
  if(busyAll.value)return
  loading.value=true;error.value='';notice.value=''
  try{
    const text=validateDraft()
    const item=await window.dbex.saveSnippet({id:selected.value||undefined,name:name.value.trim()||t('未命名查询'),kind:'mongodb',database:props.database,mongoKind:props.kind,entity:entity.value,connectionId:props.session.connectionId,text,favorite:true})
    if(disposed)return
    entries.value=[item,...entries.value.filter(x=>x.id!==item.id)]
    selected.value=item.id;name.value=item.name;notice.value='保存成功'
  }catch(reason){if(!disposed)fail(reason)}
  finally{loading.value=false}
}
async function remove(){
  if(busyAll.value||!selected.value)return
  const id=selected.value;loading.value=true;error.value=''
  try{await window.dbex.deleteSnippet(id);if(!disposed){entries.value=entries.value.filter(x=>x.id!==id);reset()}}
  catch(reason){if(!disposed)fail(reason)}finally{loading.value=false}
}
async function runQuery(nextOffset=0,paging=false){
  if(busyAll.value)return
  error.value='';notice.value=''
  try{
    let op:MongoOperation
    if(paging){
      if(!applied.value)return
      op={...applied.value,offset:nextOffset}
    }else{
      validateDraft()
      op=props.kind==='aggregation'?{action:'mongo.aggregate',database:props.database,entity:entity.value,pipeline:pipeline.value,limit:limit.value}:{action:'mongo.find',database:props.database,entity:entity.value,filter:filter.value,projection:projection.value,sort:sort.value,limit:limit.value,offset:0}
    }
    const next=await props.run(op)
    if(disposed)return
    result.value=next;applied.value=op.action==='mongo.find'?op:undefined;offset.value=op.action==='mongo.find'?op.offset||0:0
  }catch(reason){if(!disposed)fail(reason)}
}
const recovery=useQueryRecovery(()=>props.session.connectionId?{connectionId:props.session.connectionId,database:props.database,entity:'',kind:props.kind==='query'?'mongo-query':'mongo-pipeline'}:undefined,()=>JSON.stringify({name:name.value,entity:entity.value,filter:filter.value,projection:projection.value,sort:sort.value,pipeline:pipeline.value}),text=>{
 try{const value=JSON.parse(text);for(const [key,state] of Object.entries({name,entity,filter,projection,sort,pipeline}))if(typeof value[key]==='string')state.value=value[key];selected.value='';result.value=undefined;applied.value=undefined}catch{}
})
let initialized=false
watch(()=>props.busy,value=>{if(!value&&!initialized){initialized=true;void refresh()}},{immediate:true})
onBeforeUnmount(()=>{disposed=true})
</script>
<template>
  <section class="workbench mongo-library">
    <header class="workbench-header"><div><span class="eyebrow">MongoDB · {{ database }}</span><h2>{{ t(kind==='query'?'查询':'聚合管道') }}</h2></div><span class="muted-text">{{ t('只读对象') }}</span></header>
    <div class="editor-toolbar"><button class="btn secondary small" type="button" :disabled="busyAll" @click="reset">{{ t('新增') }}</button><button class="btn secondary small" type="button" :disabled="busyAll" @click="refresh">{{ t('刷新') }}</button><button class="btn secondary small" type="button" :disabled="busyAll||!entity" @click="save">{{ t('保存') }}</button><button class="btn danger-text small" type="button" :disabled="busyAll||!selected" @click="remove">{{ t('删除') }}</button><span class="toolbar-spacer"></span><button class="btn primary" type="button" :disabled="busyAll||!entity" @click="runQuery()">{{ t(kind==='query'?'查询':'运行 Aggregation') }}</button><button v-if="busy" class="btn secondary small" @click="emit('disconnect')">{{ t('取消并断开') }}</button></div>
    <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div>
    <div v-if="notice" class="inline-message notice" role="status">{{ t(notice) }}</div>
    <div v-if="recovery.available.value" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="recovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="recovery.dismiss">{{ t('放弃草稿') }}</button></div><div class="library-fields">
      <label class="field">{{ t('已保存对象') }}<select v-model="selected" :aria-label="t('已保存对象')" :disabled="busyAll" @change="openSaved"><option value="">{{ t('未选择对象') }}</option><option v-for="item in saved" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label class="field">{{ t('名称') }}<input v-model="name" :aria-label="t('名称')" :disabled="busyAll" maxlength="100" /></label>
      <label class="field">{{ t('目标集合或视图') }}<select v-model="entity" :aria-label="t('目标集合或视图')" :disabled="busyAll"><option value="">{{ t('未选择对象') }}</option><option v-for="item in targets" :key="item.id" :value="item.entity">{{ item.label }}</option></select></label>
      <label class="field">{{ t('每页') }}<select v-model.number="limit" :disabled="busyAll"><option :value="100">100</option><option :value="200">200</option><option :value="500">500</option></select></label>
    </div>
    <div v-if="kind==='aggregation'" class="query-editor"><CodeEditor v-model="pipeline" language="json" :readonly="busyAll" @execute="runQuery()" /></div>
    <div v-else class="library-query-parts"><label class="field">Filter<textarea v-model="filter" aria-label="Filter" :disabled="busyAll" spellcheck="false" /></label><label class="field">Projection<textarea v-model="projection" aria-label="Projection" :disabled="busyAll" spellcheck="false" /></label><label class="field">Sort<textarea v-model="sort" aria-label="Sort" :disabled="busyAll" spellcheck="false" /></label></div>
    <ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :documents="result.documents" :bson-types="result.bsonTypes" :offset="offset" />
    <div v-else class="empty-state"><strong>{{ t('运行查询查看结果') }}</strong><span>{{ t('请选择目标集合或视图。') }}</span></div>
    <footer class="result-footer"><span>{{ result?.rows.length||0 }} {{ t('条记录') }}</span><div><button v-if="kind==='query'" class="btn secondary small" :disabled="busyAll||offset===0||!applied" @click="applied && runQuery(Math.max(0,offset-(applied.limit||100)),true)">{{ t('上一页') }}</button><button v-if="kind==='query'" class="btn secondary small" :disabled="busyAll||result?.nextOffset===undefined||result.nextOffset>1000000" @click="result?.nextOffset!==undefined&&runQuery(result.nextOffset,true)">{{ t('下一页') }}</button></div></footer>
  </section>
</template>
