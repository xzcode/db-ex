<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import type {OperationResult,DatabaseKind} from '../../shared/types'
import {resultJSON} from '../../shared/query-results'
import {mongoFieldText} from '../../shared/bson-editor'
import {csvFromRows} from '../data-format'
import ResultGrid from './ResultGrid.vue'
import BsonDocumentTree from './BsonDocumentTree.vue'
import FieldValueDialog from './FieldValueDialog.vue'
const props=defineProps<{result?:OperationResult;kind:DatabaseKind;offset:number;queryText:string;busy:boolean;active:boolean;error:string;notice:string;canBack:boolean;canFirst:boolean;canNext:boolean;canRefresh?:boolean;editable?:(index:number)=>boolean;canAdd?:boolean;runId:number;sourceLabel:string}>()
const emit=defineEmits<{page:[direction:'first'|'prev'|'next'|'refresh'];edit:[index:number];add:[];remove:[index:number];draft:[index:number,action:'duplicate'|'null'|'empty',field?:string];collapse:[]}>()
type Snapshot={id:number;data:OperationResult;offset:number;queryText:string;sourceLabel:string;time:number}
const pins=ref<Snapshot[]>([]),pinId=ref<number>(),tab=ref<'messages'|'summary'|'data'>('data'),view=ref<'grid'|'tree'|'json'>('grid')
const selected=ref(-1),colors=ref(true),cell=ref<{title:string;text:string;document?:string;index:number}>(),localError=ref('')
const binaryCell=ref<{field:string;value:string}>()
let nextId=0
const pinned=computed(()=>pins.value.find(p=>p.id===pinId.value))
const data=computed(()=>pinned.value?.data||props.result)
const currentOffset=computed(()=>pinned.value?.offset??props.offset)
const source=computed(()=>pinned.value?.sourceLabel||props.sourceLabel)
const text=computed(()=>pinned.value?.queryText||props.queryText)
const document=computed(()=>data.value?.documents?.[selected.value])
const canEdit=computed(()=>!pinned.value&&!props.busy&&selected.value>=0&&!!props.editable?.(selected.value))
const canAdd=computed(()=>!pinned.value&&!props.busy&&!!props.canAdd)
const maxPins=5
const selectedRaw=computed(()=>document.value||JSON.stringify(data.value?.rawRows?.[selected.value]||data.value?.rows[selected.value]||{},null,2))
const jsonText=computed(()=>data.value?resultJSON(data.value):'')
watch(()=>props.runId,()=>{pinId.value=undefined;tab.value=props.error?'messages':props.result?.rows.length?'data':'summary';selected.value=props.result?.rows.length?0:-1;cell.value=undefined;localError.value=''})
watch(()=>props.error,v=>{if(v&&!pinned.value)tab.value='messages'})
watch(data,v=>{selected.value=v?.rows.length?0:-1;cell.value=undefined;binaryCell.value=undefined;if(!v?.documents&&view.value==='tree')view.value='grid'})
watch(()=>props.active,active=>{if(!active){cell.value=undefined;binaryCell.value=undefined}})
function pin(){
 if(!props.result||pinned.value||pins.value.length>=maxPins)return
 pins.value.push({id:++nextId,data:JSON.parse(JSON.stringify(props.result)),offset:props.offset,queryText:props.queryText,sourceLabel:props.sourceLabel,time:Date.now()})
 pinId.value=nextId;tab.value='data'
}
function unpin(id:number){pins.value=pins.value.filter(p=>p.id!==id);if(pinId.value===id)pinId.value=undefined}
function choose(id?:number){pinId.value=id;tab.value='data';selected.value=data.value?.rows.length?0:-1}
async function action(fn:()=>Promise<unknown>){localError.value='';try{await fn()}catch(e){localError.value=e instanceof Error?e.message:String(e)}}
function copy(){if(data.value)void action(()=>window.dbex.copyText(selected.value>=0?selectedRaw.value:jsonText.value))}
function exportData(format:'csv'|'json'){
 if(!data.value)return
 const current=data.value
 void action(()=>{const rows=current.documents?.map(doc=>Object.fromEntries(Object.entries(JSON.parse(doc)).map(([key,value])=>[key,value!==null&&typeof value==='object'?JSON.stringify(value):value])))||current.rawRows||current.rows;return window.dbex.exportFile('query-result.'+format,format==='json'?resultJSON(current):csvFromRows(current.columns,rows),format)})
}
function exportRows(indices:number[]){
 const current=data.value;if(!current||!indices.length)return
 void action(async()=>{
  const rows=[...new Set(indices)].filter(i=>Number.isInteger(i)&&i>=0&&i<current.rows.length)
  if(!rows.length)return
  if(!current.documents&&!current.rawRows)throw Error('当前仅有预览值；不能据此覆盖完整字段。')
  const content=current.documents?'['+rows.map(i=>current.documents![i]!).join(',\n')+']':JSON.stringify(rows.map(i=>current.rawRows![i]),null,2)
  await window.dbex.exportFile('query-selected.json',content,'json')
 })
}
function viewRow(index:number,field?:string){
 if(!data.value?.rows[index])return
 selected.value=index
 if(field!==undefined&&data.value.binaryCells?.[index]&&Object.hasOwn(data.value.binaryCells[index]!,field)){binaryCell.value={field,value:JSON.stringify({$dbexBinary:data.value.binaryCells[index]![field]})};return}
 const raw=data.value.documents?.[index],row=data.value.rawRows?.[index]||data.value.rows[index]!
 const value=field===undefined?raw||JSON.stringify(row,null,2):raw?mongoFieldText(raw,data.value.bsonTypes?.[index],field)??String(row[field]??''):row[field]===null?'NULL':String(row[field]??'')
 cell.value={title:field||t(raw?'查看文档':'查看记录'),text:value,document:field===undefined?raw:undefined,index}
}
function documentAction(action:string,index:number,field?:string){
 if(!data.value?.documents?.[index])return
 if(action==='copy-value'&&field!==undefined){const value=mongoFieldText(data.value.documents[index]!,data.value.bsonTypes?.[index],field);if(value!==undefined)void actionCopy(value)}
 else if(action==='copy-document')void actionCopy(data.value.documents[index]!)
 else if(action==='delete'&&!pinned.value&&props.editable?.(index))emit('remove',index)
 else if(action==='add'&&canAdd.value)emit('add')
 else if(!pinned.value&&props.editable?.(index)&&(action==='duplicate'||action==='null'||action==='empty'))emit('draft',index,action,field)
}
function actionCopy(value:string){return action(()=>window.dbex.copyText(value))}
function edit(index:number){if(!pinned.value&&props.editable?.(index))emit('edit',index)}
</script>
<template>
 <section class="query-result-panel">
  <nav class="query-result-tabs">
   <button :class="{active:tab==='messages'&&!pinned}" @click="pinId=undefined;tab='messages'">{{t('消息')}}<span v-if="error" class="query-error-dot">●</span></button>
   <button :class="{active:tab==='summary'}" @click="tab='summary'">{{t('摘要')}}</button>
   <span class="result-tab" v-for="p in pins" :key="p.id" :class="{active:tab==='data'&&pinId===p.id}"><button :title="p.queryText" @click="choose(p.id)">♧ {{t('固定结果')}} {{p.id}}</button><button :aria-label="t('取消固定')+' '+p.id" @click="unpin(p.id)">×</button></span>
   <button :class="{active:tab==='data'&&!pinned}" @click="choose()">{{t('结果')}} 1</button>
   <span class="toolbar-spacer"/>
   <button :aria-label="t('收起结果集')" :title="t('收起结果集')" @click="emit('collapse')">⌄</button>
  </nav>
  <div v-if="tab==='messages'" class="query-result-text">
   <p v-if="error" class="inline-message error">{{localize(error)}}</p>
   <p v-if="notice">{{localize(notice)}}</p>
   <p v-if="!error&&!notice" class="muted-text">{{t('暂无执行消息')}}</p>
  </div>
  <div v-else-if="tab==='summary'" class="query-result-text">
   <dl><dt>{{t('连接')}}</dt><dd>{{source}}</dd><dt>{{t('记录数')}}</dt><dd>{{data?.rows.length||0}}</dd><dt>{{t('耗时')}}</dt><dd>{{data?.durationMs===undefined?'—':data.durationMs+' ms'}}</dd><dt>{{t('受影响行数')}}</dt><dd>{{data?.affectedRows??'—'}}</dd><dt>{{t('结果状态')}}</dt><dd>{{pinned?t('固定快照'):!data?t('尚未执行'):data.nextOffset!==undefined?t('还有更多记录'):data.truncated?t('结果已截断'):t('操作已完成')}}</dd></dl>
   <pre v-if="text">{{text}}</pre>
  </div>
  <template v-else>
   <div class="query-result-toolbar">
    <button class="btn secondary small" :disabled="selected<0" @click="viewRow(selected)">{{t('查看记录')}}</button>
    <button class="btn secondary small" :disabled="!canEdit" @click="edit(selected)">{{t('编辑')}}</button>
    <button class="btn secondary small" :disabled="!canAdd" @click="emit('add')">{{t('新增')}}</button>
    <button class="btn secondary small danger-text" :disabled="!canEdit" @click="emit('remove',selected)">{{t('删除')}}</button>
    <span class="toolbar-spacer"/>
    <button class="btn secondary small" :class="{selected:colors}" :aria-pressed="colors" @click="colors=!colors">{{t('类型配色')}}</button>
    <button class="btn secondary small" :disabled="!data?.rows.length" :title="t('复制当前记录')" @click="copy">{{t('复制')}}</button>
    <button class="btn secondary small" :disabled="!data?.rows.length" @click="exportData('json')">{{t('导出当前页 JSON')}}</button>
    <button class="btn secondary small" :disabled="!data?.rows.length" @click="exportData('csv')">CSV</button>
    <button class="btn secondary small" :disabled="!result||!!pinned||pins.length>=maxPins" @click="pin">{{t('固定结果')}}</button>
   </div>
   <div v-if="localError" class="inline-message error">{{localize(localError)}}</div>
   <template v-if="data">
    <ResultGrid v-if="view==='grid'" :columns="data.columns" :rows="data.rows" :documents="data.documents" :bson-types="data.bsonTypes" :column-types="data.columnTypes" :sqlite-types="data.sqliteTypes" :null-cells="data.nullCells" :relational-kind="kind==='clickhouse'?'clickhouse':kind==='mariadb'?'mariadb':'mysql'" :offset="currentOffset" :active="active" :selected="selected" :show-colors="colors" :resize-all="true" workspace-tools export-selection @export-rows="exportRows" :document-menu="!!data.documents?.length" :can-edit-document="canEdit" :can-add-document="canAdd" @select="selected=$event" @cell-view="viewRow" @open="viewRow($event)" @document-view="viewRow($event)" @document-edit="edit($event)" @document-action="documentAction"/>
    <div v-else-if="view==='tree'" class="query-result-tree">
     <div class="result-document-list"><button v-for="(row,i) in data.rows" :key="i" :class="{active:i===selected}" @click="selected=i">{{currentOffset+i+1}} · {{row._id||t('文档')}}</button></div>
     <BsonDocumentTree v-if="document" :document="document" :metadata="data.bsonTypes?.[selected]"/>
    </div>
    <pre v-else class="query-result-json">{{jsonText}}</pre>
   </template>
   <div v-else class="empty-state"><strong>{{t('运行查询查看结果')}}</strong></div>
   <footer class="result-footer query-result-footer">
    <span>{{data?.rows.length||0}} {{t('条记录')}}<template v-if="data?.rows.length"> · {{currentOffset+1}}–{{currentOffset+data.rows.length}}</template><template v-if="pinned"> · {{t('固定快照')}}</template><template v-else-if="data?.nextOffset!==undefined"> · {{t('还有更多记录')}}</template><template v-else-if="data?.truncated"> · {{t('结果已截断')}}</template></span>
    <div>
     <button class="btn secondary small" :aria-label="t('第一页')" :title="t('第一页')" :disabled="busy||!!pinned||!canFirst" @click="emit('page','first')">|‹</button>
     <button class="btn secondary small" :disabled="busy||!!pinned||!canBack" @click="emit('page','prev')">{{t('上一页')}}</button>
     <button class="btn secondary small" :disabled="busy||!!pinned||!canNext" @click="emit('page','next')">{{t('下一页')}}</button>
     <button class="btn secondary small" :disabled="busy||!!pinned||!canRefresh" @click="emit('page','refresh')">{{t('刷新')}}</button>
    </div>
    <div class="result-view-buttons">
     <button :class="{active:view==='grid'}" @click="view='grid'">{{t('表格')}}</button>
     <button :class="{active:view==='tree'}" :disabled="!data?.documents?.length" @click="view='tree'">{{t('文档树')}}</button>
     <button :class="{active:view==='json'}" @click="view='json'">JSON</button>
    </div>
   </footer>
  </template>
  <FieldValueDialog v-if="binaryCell&&active" :field="binaryCell.field" type="BINARY" :value="binaryCell.value" :editable="false" :exact="true" :mongo="false" @close="binaryCell=undefined"/>
  <Teleport to="body"><div v-if="cell&&active" class="modal-backdrop"><section class="dialog query-cell-dialog" role="dialog" :aria-label="cell.title"><header class="dialog-header"><h2>{{cell.title}}</h2><button class="icon-button" :aria-label="t('关闭')" @click="cell=undefined">×</button></header><BsonDocumentTree v-if="cell.document" :document="cell.document" :metadata="data?.bsonTypes?.[cell.index]"/><pre v-else>{{cell.text}}</pre><footer class="dialog-footer"><button class="btn secondary" @click="actionCopy(cell.text)">{{t('复制')}}</button><button class="btn primary" @click="cell=undefined">{{t('关闭')}}</button></footer></section></div></Teleport>
 </section>
</template>
<style scoped>
.query-result-panel{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;flex-direction:column;background:var(--panel)}
.query-result-tabs{display:flex;align-items:center;gap:3px;overflow-x:auto;flex:none;padding:3px 8px;background:var(--tabs-bg);border-bottom:1px solid var(--border)}
.query-result-tabs button,.result-view-buttons button{background:transparent;border:0;color:var(--muted);padding:5px 9px;white-space:nowrap;border-radius:3px}
.query-result-tabs button.active,.result-tab.active,.result-view-buttons button.active{background:var(--selected);color:var(--accent)}
.result-tab{display:flex;align-items:center;flex:none;border-radius:4px}
.result-tab button+button{padding-inline:4px}
.query-error-dot{color:var(--danger);font-size:9px;margin-inline-start:4px}
.query-result-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:5px 8px;background:var(--toolbar-bg);border-bottom:1px solid var(--border);flex:none}
.query-result-toolbar .selected{background:var(--selected)}
.query-result-text,.query-result-json{flex:1;min-height:0;overflow:auto;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.query-result-text dl{display:grid;grid-template-columns:max-content 1fr;gap:10px}
.query-result-text dd{margin:0}.query-result-text dt{color:var(--muted)}
.query-result-json{margin:0;font:12px ui-monospace,monospace;user-select:text}
.query-result-tree{display:flex;min-height:0;flex:1;overflow:hidden}
.result-document-list{width:180px;max-width:40%;overflow:auto;flex:none;border-inline-end:1px solid var(--border)}
.result-document-list button{display:block;text-align:start;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;border:0;padding:7px;color:var(--text)}
.result-document-list button.active{background:var(--selected)}
.query-result-tree :deep(.bson-document-tree){flex:1;min-width:0;overflow:auto}
.query-result-footer{flex-wrap:wrap;padding:5px 8px;gap:4px}
.query-cell-dialog{width:min(760px,90vw);height:min(600px,85vh);display:flex;flex-direction:column}
.query-cell-dialog pre{padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;min-height:0;flex:1;overflow:auto;user-select:text}
</style>
