<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch,shallowRef} from 'vue'
import {t,localize} from '../i18n'
import {preferences} from '../preferences'
import {pageSizeFor} from '../../shared/preferences'
import {querySummary,type QueryMode,type QueryDraft,type SavedQuery,type QuerySummary} from '../../shared/saved-query'
import type {SessionInfo,ExplorerNode,QuerySnippet,DatabaseOperation,OperationResult,SqlValue} from '../../shared/types'
import CodeEditor from './CodeEditor.vue'
import QuerySplit,{type QueryLayout} from './QuerySplit.vue'
import QueryResultPanel from './QueryResultPanel.vue'
import {editableMongoResult} from '../../shared/query-results'
import {ordinaryMongoCollection} from '../../shared/object-menu'
import {protectedDatabase} from '../../shared/database-admin'
import {formatMongoDocument,parseMongoDocumentEditor,mongoDocumentDraft} from '../../shared/bson-editor'
import {parseBsonDocument} from '../../shared/bson-display'
import {compileMongoScript,mongoPageOperation,legacyMongoScript,type MongoScriptPlan} from '../../shared/mongo-query-script'
import {formatQuery} from '../../shared/query-format'
import QueryParameterDialog from './QueryParameterDialog.vue'
import type {QueryBatchResult} from '../../shared/query-batch'
import {sqlStatements} from '../../shared/sql-statements'
import {useQueryRecovery} from '../composables/useQueryRecovery'
import {cachedMetadata,rememberMetadata,metadataFields,metadataKey,inferMetadataTable,inferMetadataReferences} from '../metadata-completion'
const props=defineProps<{session:SessionInfo;node:ExplorerNode;active:boolean;tableSuggestions?:string[]}>()
const emit=defineEmits<{saved:[value:QuerySummary];busyChange:[value:boolean];dirtyChange:[value:boolean];updateSession:[session:SessionInfo];disconnect:[]}>()
const database=props.node.database||''
const mode:QueryMode=props.node.queryMode||'sql'
const clickhouse=props.session.kind==='clickhouse'
const currentId=ref(props.node.queryId),revision=ref('')
const name=ref(''),sql=ref(''),parameters=ref(clickhouse?'{}':'[]'),script=ref('')
const layout=ref<QueryLayout>('bottom')
const executedQuery=ref(''),runId=ref(0),visited=ref<number[]>([])
const resultEdit=ref<{mode:'insert'|'update';original?:string;index:number;entity:string;text:string;syntax:'typed'|'ejson';error:string}>()
const batchResults=ref<QueryBatchResult>(),batchIndex=ref(0)
const result=ref<OperationResult>(),offset=ref(0),limit=ref<number>(pageSizeFor(preferences.value,props.session.kind))
const disconnectRequired=ref(false)
const busy=ref(false),running=ref(false),loaded=ref(false),error=ref(''),notice=ref('')
const targets=ref<ExplorerNode[]>([]),legacy=ref<QuerySnippet[]>([]),legacySelected=ref('')
const baseline=ref('')
const editor=ref<InstanceType<typeof CodeEditor>>()
const parameterDialog=ref(false)
const saveAsOpen=ref(false),copyName=ref('')
let disposed=false
const applied=shallowRef<DatabaseOperation>()
const appliedMongoPlan=shallowRef<MongoScriptPlan>()
const appliedPageSize=ref(100)
const metadataColumns=ref<string[]>([]),metadataTables=ref<string[]>([])
const sqlTables=computed(()=>[...new Set([...metadataTables.value,...(props.tableSuggestions||[])])])
const metadataReferences=computed(()=>inferMetadataReferences(sql.value,sqlTables.value,database))
const selectedMetadataTable=computed(()=>inferMetadataTable(sql.value,sqlTables.value,database)||metadataReferences.value[0]?.table||'')
const qualifiedFields=ref<Record<string,string[]>>({})
const metadataScope=computed(()=>JSON.stringify(metadataReferences.value))
let metadataTimer:ReturnType<typeof setTimeout>|undefined
async function refreshMetadataTables(){
 if(mode!=='sql'||props.session.kind==='redis')return
 const objects=await window.dbex.children(props.session.id,database)
 metadataTables.value=objects.filter(n=>n.kind==='table'||n.kind==='view').map(n=>n.entity||n.label)
}
async function loadMetadata(force=false){
 if(!metadataReferences.value.length||mode!=='sql'||busy.value||!loaded.value||!props.active)return
 await task(async()=>{
  const refs=[...metadataReferences.value],key=metadataScope.value,fields:Record<string,string[]>=Object.create(null)
  if(force)await refreshMetadataTables()
  for(const ref of refs){
   if(disposed||metadataScope.value!==key)break
   const id=metadataKey(props.session.id,ref.database,ref.table)
   let columns=force?undefined:cachedMetadata(id)
   if(!columns){
    try{const response=await window.dbex.execute(props.session.id,{action:clickhouse?'clickhouse.structure':'mysql.structure',database:ref.database,entity:ref.table});columns=rememberMetadata(id,metadataFields(props.session.kind,response))}
    catch{continue}
   }
   fields[ref.alias]=columns;fields[ref.table]=columns
  }
  if(metadataScope.value===key){qualifiedFields.value=fields;metadataColumns.value=[...new Set(Object.values(fields).flat())]}
 })
}
const sqlFields=computed(()=>[...new Set([...metadataColumns.value,...(result.value?.columns||[])])])
watch([metadataScope,loaded,()=>props.active],()=>{
 if(metadataTimer)clearTimeout(metadataTimer)
 qualifiedFields.value=Object.fromEntries(metadataReferences.value.flatMap(ref=>{const fields=cachedMetadata(metadataKey(props.session.id,ref.database,ref.table));return fields?[[ref.alias,fields],[ref.table,fields]]:[]}));metadataColumns.value=[...new Set(Object.values(qualifiedFields.value).flat())]
 if(selectedMetadataTable.value&&preferences.value.completion&&props.active&&loaded.value&&metadataReferences.value.some(ref=>!cachedMetadata(metadataKey(props.session.id,ref.database,ref.table))))metadataTimer=setTimeout(()=>{void loadMetadata()},700)
})
const mongoFields=ref<string[]>([])
function collectMongoFields(result:OperationResult){
 const found=new Set(result.columns||[])
 function walk(value:unknown,prefix='',depth=0){
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>5||found.size>=500)return
  for(const [key,child] of Object.entries(value)){
   if(key.startsWith('$'))continue
   const field=prefix?prefix+'.'+key:key;found.add(field)
   if(found.size>=500)break
   walk(child,field,depth+1)
  }
 }
 for(const text of result.documents||[])try{walk(JSON.parse(text))}catch{}
 return [...found]
}
async function sampleMongoFields(){
 if(mode==='sql'||busy.value)return
 await task(async()=>{
  const plan=compileMongoScript(script.value,database),entity='entity'in plan.operation?plan.operation.entity:undefined
  if(!entity||!targets.value.some(n=>(n.entity||n.label)===entity))throw Error('请先选择查询集合')
  const result=await window.dbex.executeQuery(props.session.id,{action:'mongo.find',database,entity,filter:'{}',projection:'{}',sort:'{}',limit:20,offset:0})
  mongoCollection.value=entity;mongoFields.value=collectMongoFields(result)
 })
}
const mongoCollection=ref('')
const fieldSuggestions=computed(()=>{
 if(mode==='sql')return result.value?.columns||[]
 try{const plan=compileMongoScript(script.value,database);return 'entity'in plan.operation&&plan.operation.entity===mongoCollection.value?mongoFields.value:[]}
 catch{return mongoFields.value}
})
const previousOffset=computed(()=>visited.value.filter(v=>v<offset.value).at(-1)??(appliedMongoPlan.value?.baseOffset||0))
const canPageBack=computed(()=>offset.value>(appliedMongoPlan.value?.baseOffset||0))
const sourceLabel=computed(()=>props.session.name+' / '+database)
const safeMongoCollection=computed(()=>applied.value?.action==='mongo.find'&&!protectedDatabase('mongodb',database)&&ordinaryMongoCollection(applied.value.entity)&&targets.value.some(n=>n.kind==='collection'&&!n.readOnly&&!n.maintenanceRestricted&&(n.entity||n.label)===(applied.value as {entity:string}).entity))
function canEditResult(index:number){
 if(batchResults.value)return false
 if(!props.session.writable||busy.value||!safeMongoCollection.value||!editableMongoResult(applied.value,result.value,index))return false
 const doc=parseBsonDocument(result.value!.documents![index]!)
 return !!doc&&Object.hasOwn(doc,'_id')
}
const canAddResult=computed(()=>!batchResults.value&&!!props.session.writable&&!busy.value&&safeMongoCollection.value&&applied.value?.action==='mongo.find'&&(()=>{try{return !Object.keys(JSON.parse(applied.value.projection||'{}')).length}catch{return false}})())
function setLayout(value:QueryLayout){layout.value=value;try{if(value==='bottom'||value==='right')localStorage.setItem('dbex.query-layout',value)}catch{}}
try{if(localStorage.getItem('dbex.query-layout')==='right')layout.value='right'}catch{}
function showResults(){if(layout.value==='editor'){let next:QueryLayout='bottom';try{if(localStorage.getItem('dbex.query-layout')==='right')next='right'}catch{}setLayout(next)}}
function editResult(index:number){
 if(!canEditResult(index)||applied.value?.action!=='mongo.find')return
 const original=result.value!.documents![index]!
 resultEdit.value={mode:'update',index,original,entity:applied.value.entity,...formatMongoDocument(original,result.value?.bsonTypes?.[index]),error:''}
}
function draftResult(index:number,action:'duplicate'|'null'|'empty',field?:string){
 if(!canEditResult(index)||applied.value?.action!=='mongo.find')return
 const original=result.value!.documents![index]!
 try{
  const formatted=mongoDocumentDraft(original,result.value?.bsonTypes?.[index],action,field)
  resultEdit.value={mode:action==='duplicate'?'insert':'update',index,entity:applied.value.entity,...formatted,...(action!=='duplicate'?{original}:{}),error:''}
 }catch(e){fail(e)}
}
function addResult(){
 if(!canAddResult.value||applied.value?.action!=='mongo.find')return
 resultEdit.value={mode:'insert',index:-1,entity:applied.value.entity,text:'{\n  "name": ""\n}',syntax:'typed',error:''}
}
async function refreshMongoResult(){
 if(applied.value?.action!=='mongo.find')return
 const next=await window.dbex.executeQuery(props.session.id,applied.value)
 if(next.disconnected){emit('disconnect');return}
 result.value=capMongoPage(next,appliedMongoPlan.value,applied.value);runId.value++;notice.value=next.message||'操作已完成'
}
async function saveResultEdit(){
 const d=resultEdit.value
 if(!d||busy.value||!props.session.writable||applied.value?.action!=='mongo.find'||applied.value.entity!==d.entity)return
 if(d.mode==='update'&&(!canEditResult(d.index)||result.value?.documents?.[d.index]!==d.original)||d.mode==='insert'&&!canAddResult.value)return
 await task(async()=>{
  try{
   const document=d.syntax==='typed'?parseMongoDocumentEditor(d.text):JSON.stringify(JSON.parse(d.text))
   await window.dbex.validateMongoDocument(document,d.original)
   const op:DatabaseOperation=d.mode==='update'?{action:'mongo.replace',database,entity:d.entity,original:d.original!,document,confirmed:true}:{action:'mongo.insert',database,entity:d.entity,documents:[document],confirmed:true}
   const response=await window.dbex.executeQuery(props.session.id,op)
   if(response.disconnected){emit('disconnect');return}
   resultEdit.value=undefined;result.value=undefined;notice.value='操作已完成';try{await refreshMongoResult()}catch(e){fail(e)}
  }catch(e){d.error=e instanceof Error?e.message:String(e)}
 })
}
async function removeResult(index:number){
 if(!canEditResult(index)||applied.value?.action!=='mongo.find')return
 const entity=applied.value.entity,original=result.value!.documents![index]!
 await task(async()=>{const next=await window.dbex.execute(props.session.id,{action:'mongo.delete',database,entity,original,confirmed:true});if(next.disconnected){emit('disconnect');return}result.value=undefined;await refreshMongoResult()})
}
function capMongoPage(next:OperationResult,plan:MongoScriptPlan|undefined,op:DatabaseOperation){
 if(op.action==='mongo.count'&&next.totalRows!==undefined)return {...next,columns:['count'],rows:[{count:(next.countLimited?'≥ ':'')+next.totalRows}]}
 if(op.action==='mongo.find'&&plan?.maxRows!==undefined&&next.nextOffset!==undefined&&next.nextOffset>=plan.baseOffset+plan.maxRows)return {...next,nextOffset:undefined,truncated:next.truncationReason!=='page'}
 return next
}
const canRefresh=computed(()=>!!applied.value&&result.value?.queryReadOnly===true)
function page(direction:'first'|'prev'|'next'|'refresh'){
 if(busy.value||resultEdit.value)return
 if(direction==='first')void execute(appliedMongoPlan.value?.baseOffset||0)
 else if(direction==='prev')void execute(previousOffset.value)
 else if(direction==='next'&&result.value?.nextOffset!==undefined)void execute(result.value.nextOffset)
 else if(direction==='refresh'&&canRefresh.value){
  const op=applied.value!
  void task(async()=>{
   const response=await window.dbex.executeQuery(props.session.id,op)
   if(response.disconnected){emit('disconnect');return}
   result.value=capMongoPage(response,appliedMongoPlan.value,op);runId.value++;notice.value=response.message||''
  })
 }
}


const draft=computed<QueryDraft>(()=>({name:name.value.trim(),mode,text:mode==='sql'?sql.value:script.value,...(mode==='sql'?{parameters:parameters.value}:{syntax:'mongo-shell' as const})}))
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
 else script.value=value.syntax==='mongo-shell'?value.text:legacyMongoScript(mode,value.entity,value.text)
}
const recovery=useQueryRecovery(()=>loaded.value&&(currentId.value||props.node.draftId)&&props.session.connectionId?{connectionId:props.session.connectionId,database,entity:(currentId.value||props.node.draftId)!,kind:'saved-query'}:undefined,()=>fingerprint.value,text=>{
 const value=JSON.parse(text)
 if(value.mode===mode&&typeof value.name==='string'&&typeof value.text==='string')apply(value)
})
function applySaved(item:SavedQuery){apply(item);currentId.value=item.id;revision.value=item.revision;baseline.value=fingerprint.value}
onMounted(()=>{void task(async()=>{
 if(currentId.value)applySaved(await window.dbex.getSavedQuery(props.session.id,database,currentId.value))
 if(mode==='sql'){try{await refreshMetadataTables()}catch{ /* Existing query editing remains available. */ }}
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
 legacy.value=history.filter(item=>item.kind===props.session.kind&&item.favorite&&(!item.database||item.database===database)&&(!item.connectionId||item.connectionId===props.session.connectionId)&&(mode==='sql'||item.mongoKind==='script'||(mode==='mongo-find'?item.mongoKind==='query':!item.mongoKind||item.mongoKind==='aggregation')))
 if(!currentId.value)baseline.value=fingerprint.value
 loaded.value=true
})})
function loadLegacy(){
 const item=legacy.value.find(x=>x.id===legacySelected.value)
 if(!item||busy.value)return
 try{apply({name:item.name,mode,text:item.text,entity:item.entity,parameters:item.parameters,...(item.mongoKind==='script'?{syntax:'mongo-shell' as const}:{})})}catch(reason){fail(reason)}
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
  if(!asCopy||!currentId.value)recovery.clear(true)
  applySaved(item);saveAsOpen.value=false;notice.value='保存成功';emit('saved',querySummary(item))
 })
}
function openSaveAs(){if(canPersist.value&&!busy.value){copyName.value=name.value?name.value.slice(0,91)+' (2)':'';saveAsOpen.value=true}}
function shortcut(event:KeyboardEvent){
 if(!props.active||resultEdit.value||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='s')return
 event.preventDefault();event.stopPropagation()
 if(event.shiftKey)openSaveAs();else if(!saveAsOpen.value)void save()
}
onMounted(()=>window.addEventListener('keydown',shortcut,true))
onBeforeUnmount(()=>{disposed=true;if(metadataTimer)clearTimeout(metadataTimer);window.removeEventListener('keydown',shortcut,true)})
function selectBatch(index:number){
 const item=batchResults.value?.items[index];if(!item)return
 batchIndex.value=index;result.value=item.result;executedQuery.value=item.sql;offset.value=0;runId.value++
}
async function executeBatch(){
 if(mode!=='sql'||busy.value||!loaded.value||props.session.transaction||resultEdit.value)return
 if(!Number.isInteger(limit.value)||limit.value<1||limit.value>500){fail('INVALID_INPUT: 每页数量必须在 1 至 500 之间');return}
 showResults()
 await task(async()=>{
  const source=editor.value?.selection()||sql.value,params=JSON.parse(parameters.value)
  if(sqlStatements(source,props.session.kind).length<2)throw new Error('SQL_POLICY: 批量查询至少需要两条语句')
  running.value=true;disconnectRequired.value=false;batchResults.value=undefined
  try{
   const batch=await window.dbex.executeReadBatch(props.session.id,{database,text:source,parameters:params,limit:limit.value})
   if(disposed)return
   applied.value=undefined;appliedMongoPlan.value=undefined;visited.value=[];result.value=undefined;offset.value=0
   batchResults.value=batch;batchIndex.value=0
   if(batch.items.length)selectBatch(0);else runId.value++
   notice.value=t('已完成 {0} / {1} 条语句',[batch.items.length,batch.total])
   if(batch.error)error.value=batch.error
  }finally{running.value=false;disconnectRequired.value=false}
 })
}
async function execute(paging?:number,selection=false,current=false){
 if(!loaded.value||busy.value||resultEdit.value)return
 if(!Number.isInteger(limit.value)||limit.value<1||limit.value>500){fail('INVALID_INPUT: 每页数量必须在 1 至 500 之间');return}
 showResults()
 if(paging===undefined)batchResults.value=undefined
 await task(async()=>{
  let op:DatabaseOperation
  let nextPlan=appliedMongoPlan.value
  let executedText=''
  if(paging!==undefined){
   if(appliedMongoPlan.value){const next=mongoPageOperation(appliedMongoPlan.value,paging,appliedPageSize.value);if(!next)return;op=next}
   else{if(!applied.value||!('offset'in applied.value))return;op={...applied.value,offset:paging}}
  }else if(mode==='sql'){
   const params:unknown=JSON.parse(parameters.value)
   if(!clickhouse&&(!Array.isArray(params)||params.length>1000||params.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))))throw new Error('SQL 参数需要 JSON 数组，仅支持字符串、数字、布尔或 null')
   if(clickhouse&&(!params||typeof params!=='object'||Array.isArray(params)))throw new Error('ClickHouse 参数需要 JSON 对象')
   const text=current?editor.value?.currentStatement()||sql.value:selection?editor.value?.selection()||sql.value:sql.value
   executedText=text
   if(!text.trim())throw new Error('SQL_POLICY: SQL 不能为空')
   op=clickhouse?{action:'clickhouse.query',database,sql:text,parameters:params as Record<string,SqlValue>,limit:limit.value,confirmed:props.session.writable}:{action:'mysql.query',database,sql:text,parameters:params as SqlValue[],limit:limit.value,offset:0,confirmed:props.session.writable}
  }else{
   executedText=selection?editor.value?.selection()||script.value:script.value
   nextPlan=compileMongoScript(executedText,database,limit.value)
   op=nextPlan.operation
   if('confirmed'in op&&!props.session.writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
  }
  running.value=true;disconnectRequired.value=false
  let next:OperationResult
  try{next=await window.dbex.executeQuery(props.session.id,op)}finally{running.value=false;disconnectRequired.value=false}
  if(disposed)return
  appliedMongoPlan.value=nextPlan
  if(paging===undefined)appliedPageSize.value=limit.value
  next=capMongoPage(next,appliedMongoPlan.value,op)
  if(op.action==='mongo.find'||op.action==='mongo.aggregate'){mongoFields.value=collectMongoFields(next);mongoCollection.value=op.entity}
  const nextOffset='offset'in op?op.offset||0:0
  if(paging===undefined){visited.value=[nextOffset];executedQuery.value=executedText}
  else visited.value=[...new Set([...visited.value,nextOffset])].sort((a,b)=>a-b)
  result.value=next;offset.value=nextOffset;applied.value=op;runId.value++
  if(next.transaction!==undefined)emit('updateSession',{...props.session,transaction:next.transaction})
  if(next.disconnected){emit('disconnect');return}
  if(next.message)notice.value=next.message
  if(preferences.value.records.recordHistory&&mode==='sql'&&(op.action==='mysql.query'||op.action==='clickhouse.query')){
   await window.dbex.saveSnippet({name:op.sql.trim().split('\n')[0].slice(0,80),kind:props.session.kind,database,connectionId:props.session.connectionId,text:op.sql,parameters:JSON.stringify(op.parameters||(clickhouse?{}:[])),favorite:false}).catch(()=>{})
  }else if(preferences.value.records.recordHistory&&mode!=='sql'&&paging===undefined){await window.dbex.saveSnippet({name:executedText.trim().split('\n')[0].slice(0,80),kind:props.session.kind,database,connectionId:props.session.connectionId,text:executedText,mongoKind:'script',favorite:false}).catch(()=>{})}
 })
}
async function beautify(){
 if(busy.value||!loaded.value)return
 const before=mode==='sql'?sql.value:script.value
 await task(async()=>{const formatted=await formatQuery(before,props.session.kind,preferences.value.editor.tabSize);if((mode==='sql'?sql.value:script.value)===before){if(mode==='sql')sql.value=formatted;else script.value=formatted}})
}
async function toggleWrite(){await task(async()=>emit('updateSession',await window.dbex.setWriteAccess(props.session.id,!props.session.writable)))}
async function transaction(action:'mysql.begin'|'mysql.commit'|'mysql.rollback'){await task(async()=>{const next=await window.dbex.execute(props.session.id,{action,confirmed:true});emit('updateSession',{...props.session,transaction:!!next.transaction});notice.value=next.message||''})}
async function cancel(){
 try{if(disconnectRequired.value){await window.dbex.cancel(props.session.id);emit('disconnect');return}if(!await window.dbex.cancelQuery(props.session.id)){disconnectRequired.value=true;notice.value='当前操作无法独立停止；再次选择取消并断开将关闭会话。'}}catch(reason){fail(reason)}
}
async function exportQuery(format:'json'|'sql'){if(!currentId.value)return;await task(async()=>{if(await window.dbex.exportSavedQuery(props.session.id,database,currentId.value!,format))notice.value='操作已完成'})}
</script>
<template>
 <section :class="['workbench','saved-query-editor',{'mongo-library':mode!=='sql'}]">
  <header class="workbench-header query-context-header"><div class="query-context-label"><strong>{{session.name}}</strong><span> / </span><strong>{{database}}</strong></div><div class="header-tools"><span v-if="session.transaction" class="transaction-badge">{{ t('事务进行中') }}</span><button :class="['btn',session.writable?'warning':'secondary']" :disabled="busy" @click="toggleWrite">{{ session.writable?t('写入已启用 · 锁定'):t('只读 · 启用写入') }}</button></div></header>
  <div class="editor-toolbar query-object-toolbar">
   <button class="btn primary small" :disabled="busy||!loaded||!canPersist" :title="'Ctrl / ⌘ + S'" @click="save()"><span aria-hidden="true">▣</span> {{ t('保存') }}</button>
   <button class="btn secondary small" :disabled="busy||!loaded" @click="beautify">{{ t('美化语句') }}</button>
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

   <label class="field"><span>{{ t('每页') }}</span><input v-model.number="limit" type="number" min="1" max="500" :aria-label="t('每页')" :disabled="busy"/></label>
  </div>
  <div class="editor-toolbar">
   <button class="btn primary small" :disabled="busy||!loaded" @click="execute(undefined,true)">{{ t('运行选中 / 全部') }}</button>
   <button v-if="mode==='sql'" class="btn secondary small" :disabled="busy||!loaded" @click="execute(undefined,false,true)">{{t('运行当前语句')}}</button><button v-if="mode==='sql'" class="btn secondary small" :disabled="busy||!loaded||session.transaction" @click="executeBatch">{{t('批量查询（只读）')}}</button><button v-if="running" class="btn secondary small" @click="cancel">{{t(disconnectRequired?'取消并断开':'停止查询')}}</button>
   <span class="toolbar-spacer"></span>
   <template v-if="mode==='sql'&&!clickhouse"><button class="btn secondary small" :disabled="busy||!session.writable||session.transaction" @click="transaction('mysql.begin')">{{ t('开始事务') }}</button><button class="btn secondary small" :disabled="busy||!session.transaction" @click="transaction('mysql.commit')">{{ t('提交') }}</button><button class="btn secondary small" :disabled="busy||!session.transaction" @click="transaction('mysql.rollback')">{{ t('回滚') }}</button></template>
   <span class="query-layout-buttons">
   <span v-if="mode==='sql'&&selectedMetadataTable" class="muted-text">{{t('字段补全来源')}}: {{selectedMetadataTable}}</span>
   <button v-if="mode==='sql'" class="btn secondary small" :disabled="busy||!selectedMetadataTable" @click="loadMetadata(true)">{{t('刷新补全')}}</button><button v-else class="btn secondary small" :disabled="busy||!loaded" @click="sampleMongoFields">{{t('刷新字段样本')}}</button>

   <button v-for="item in [{id:'bottom',label:'结果在下方',symbol:'⊟'},{id:'right',label:'结果在右侧',symbol:'◧'},{id:'editor',label:'仅编辑器',symbol:'□'},{id:'result',label:'仅结果集',symbol:'▣'}]" :key="item.id" type="button" :class="['btn','secondary','small',{selected:layout===item.id}]" :aria-label="t(item.label)" :title="t(item.label)" @click="setLayout(item.id as QueryLayout)">{{item.symbol}}</button></span>
  </div>

  <QuerySplit v-model:layout="layout" :active="active">
   <template #editor>
    <template v-if="mode==='sql'">
     <div class="query-editor"><CodeEditor ref="editor" v-model="sql" language="sql" :sql-dialect="session.kind==='mongodb'||session.kind==='redis'?undefined:session.kind" :readonly="running||!loaded" :suggestions="sqlFields" :qualified-suggestions="qualifiedFields" :server-version="session.serverVersion" :table-suggestions="sqlTables" @execute="execute(undefined,true)" /></div>
     <label class="parameter-line">{{ t('参数') }}<input v-model="parameters" :aria-label="clickhouse?t('ClickHouse 参数 JSON 对象'):t('SQL 参数 JSON 数组')" spellcheck="false" :disabled="busy||!loaded" /><button class="btn secondary small" :disabled="busy||!loaded" @click="parameterDialog=true">{{t('参数编辑器')}}</button></label>
    </template>
    <div v-else class="query-editor native-mongo-editor"><CodeEditor ref="editor" v-model="script" language="dbex-mongo-script" completion-kind="mongodb" :readonly="busy||!loaded" :table-suggestions="targets.map(item=>item.entity||item.label)" :suggestions="fieldSuggestions" @execute="execute(undefined,true)" /></div>
   </template>
   <template #result><div v-if="batchResults" class="batch-results-strip"><button v-for="(item,i) in batchResults.items" :key="i" :title="item.sql" :class="['btn','secondary','small',{selected:batchIndex===i}]" @click="selectBatch(i)">{{t('语句结果')}} {{i+1}}</button><span class="muted-text">{{batchResults.items.length}} / {{batchResults.total}}</span><span v-if="batchResults.failedAt" class="danger-text">{{t('停止于语句')}} {{batchResults.failedAt}}</span></div><QueryResultPanel :result="result" :kind="session.kind" :offset="offset" :query-text="executedQuery" :busy="busy" :active="active" :error="error" :notice="notice" :can-back="!batchResults&&!clickhouse&&canPageBack" :can-first="!batchResults&&!clickhouse&&canPageBack" :can-next="!batchResults&&!clickhouse&&result?.nextOffset!==undefined" :can-refresh="!batchResults&&canRefresh" :editable="canEditResult" :can-add="canAddResult" :run-id="runId" :source-label="sourceLabel" @page="page" @edit="editResult" @add="addResult" @remove="removeResult" @draft="draftResult" @collapse="setLayout('editor')"/></template>
  </QuerySplit>
  <QueryParameterDialog v-if="parameterDialog&&active" :model-value="parameters" :named="clickhouse" @close="parameterDialog=false" @apply="value=>{parameters=value;parameterDialog=false}"/>
  <Teleport to="body"><div v-if="resultEdit&&active" class="modal-backdrop"><section class="dialog query-result-edit" role="dialog" :aria-label="t(resultEdit.mode==='insert'?'新增文档':'编辑文档')">
   <header class="dialog-header"><div><span class="eyebrow">{{sourceLabel}} / {{resultEdit.entity}}</span><h2>{{t(resultEdit.mode==='insert'?'新增文档':'编辑文档')}}</h2></div><button class="icon-button" :disabled="busy" @click="resultEdit=undefined">×</button></header>
   <p v-if="resultEdit.error" class="inline-message error">{{localize(resultEdit.error)}}</p>
   <div class="query-result-edit-code"><CodeEditor v-model="resultEdit.text" :language="resultEdit.syntax==='typed'?'dbex-bson-document':'json'" :readonly="busy"/></div>
   <footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="resultEdit=undefined">{{t('取消')}}</button><button class="btn primary" :disabled="busy||!session.writable" @click="saveResultEdit">{{t('保存修改')}}</button></footer>
  </section></div></Teleport>
  <div v-if="saveAsOpen" class="modal-backdrop"><section class="dialog" role="dialog" :aria-label="t('另存为')"><header class="dialog-header"><h2>{{ t('另存为') }}</h2></header><div class="dialog-body"><label class="field field-wide">{{ t('名称') }}<input v-model="copyName" :aria-label="t('名称')" maxlength="100" /></label><p v-if="error" role="alert">{{ localize(error) }}</p></div><footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="saveAsOpen=false">{{ t('取消') }}</button><button class="btn primary" :disabled="busy||!copyName.trim()" @click="save(true)">{{ t('保存') }}</button></footer></section></div>
 </section>
</template>
<style scoped>
.query-object-fields{display:flex;gap:12px;align-items:end;padding:8px 12px;border-bottom:1px solid var(--border-soft);flex:none}.query-object-fields .field{flex:1;min-width:0}.query-object-fields .field:last-child{flex:0 0 86px}.query-object-toolbar{gap:6px}.saved-query-editor .workbench-header h2{margin:0} .query-context-header{padding:5px 10px;min-height:34px;border-bottom:1px solid var(--border-soft)}.query-context-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text)}.query-context-label span{color:var(--muted)}.query-layout-buttons{display:flex;align-items:center;gap:4px;padding:3px 8px;background:var(--toolbar-bg);border-bottom:1px solid var(--border);flex:none}.query-layout-buttons .selected{background:var(--selected)}.query-result-edit{width:min(900px,90vw);height:min(620px,85vh);display:flex;flex-direction:column}.query-result-edit-code{flex:1;min-height:0}.query-object-fields{padding:5px 10px}.query-object-fields .field{display:flex;flex-direction:row;align-items:center;gap:6px}.query-object-fields .field span{flex:none}.query-object-fields .field:last-child{flex:0 0 120px}
.batch-results-strip{display:flex;align-items:center;gap:5px;padding:4px 8px;overflow-x:auto;flex:none;background:var(--toolbar-bg);border-bottom:1px solid var(--border)}.batch-results-strip .selected{background:var(--selected)}
</style>
