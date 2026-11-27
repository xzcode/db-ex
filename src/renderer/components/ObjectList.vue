<script setup lang="ts">
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {t,locale} from '../i18n'
import {catalogWidths,setCatalogWidth} from '../catalog-widths'
import {catalogWidthMin,catalogWidthMax} from '../../shared/catalog-widths'
import {globalInspectorTab,openGlobalInspector} from '../inspector-preferences'
import type {DatabaseKind,ExplorerNode} from '../../shared/types'
import {formatBytes} from '../../shared/object-inspection'
import {isQueryFolder,folderQueryMode} from '../../shared/saved-query'
import {collectionColumns,tableColumns,queryColumns,nameColumn,objectMetric,sortedObjects,type CatalogColumn} from '../../shared/object-list'
const props=defineProps<{kind:DatabaseKind;node?:ExplorerNode;nodes:ExplorerNode[];busy?:boolean;canSaveQueries?:boolean;selectedId?:string;inspectorAvailable?:boolean}>()
const emit=defineEmits<{select:[node?:ExplorerNode];menu:[event:MouseEvent|KeyboardEvent,node:ExplorerNode];open:[node:ExplorerNode];refresh:[];query:[];queryAction:[action:'copy'|'delete'|'export'|'export-sql'|'import'|'rename',node?:ExplorerNode,name?:string]}>()
const query=ref(''),selected=computed(()=>props.selectedId||''),sortKey=ref('name'),direction=ref<1|-1>(1)
const scope=computed(()=>[props.kind,props.node?.category||props.node?.kind||'root'].join(':'))
const scrollHost=ref<HTMLElement>(),viewport=ref(0),draftWidth=ref<{key:string;width:number}>()
let observer:ResizeObserver|undefined,stopResize:(()=>void)|undefined
onMounted(()=>{if(scrollHost.value){viewport.value=scrollHost.value.clientWidth;observer=new ResizeObserver(()=>{viewport.value=scrollHost.value?.clientWidth||0});observer.observe(scrollHost.value)}})
onBeforeUnmount(()=>{observer?.disconnect();stopResize?.()})
function defaultWidth(column:CatalogColumn){return column.kind==='name'?230:column.kind==='boolean'?100:Math.max(125,Math.min(220,t(column.label).length*14+30))}
function baseWidth(column:CatalogColumn){return draftWidth.value?.key===column.key?draftWidth.value.width:catalogWidths.value[scope.value]?.[column.key]||defaultWidth(column)}
function columnWidth(column:CatalogColumn){const base=baseWidth(column);return column.kind==='name'&&!catalogWidths.value[scope.value]?.[column.key]&&draftWidth.value?.key!==column.key?Math.max(base,viewport.value-columns.value.filter(c=>c.key!==column.key).reduce((n,c)=>n+baseWidth(c),0)):base}
const tableWidth=computed(()=>columns.value.reduce((n,c)=>n+columnWidth(c),0))
function resize(event:PointerEvent,column:CatalogColumn){
 event.preventDefault();event.stopPropagation();stopResize?.()
 const start=(event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width,x=event.clientX,key=column.key,rtl=document.documentElement.dir==='rtl',scopeKey=scope.value
 document.body.classList.add('resizing')
 const move=(e:PointerEvent)=>{draftWidth.value={key,width:Math.max(catalogWidthMin,Math.min(catalogWidthMax,start+(rtl?x-e.clientX:e.clientX-x)))}}
 function end(){if(draftWidth.value?.key===key)setCatalogWidth(scopeKey,key,draftWidth.value.width);draftWidth.value=undefined;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);document.body.classList.remove('resizing');stopResize=undefined}
 stopResize=end;window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end)
}
function resizeKey(event:KeyboardEvent,column:CatalogColumn){if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.key==='Home')setCatalogWidth(scope.value,column.key);else setCatalogWidth(scope.value,column.key,columnWidth(column)+(event.key==='ArrowRight'?12:-12)*(document.documentElement.dir==='rtl'?-1:1))}
function autoFit(column:CatalogColumn){
 const width=Math.max(t(column.label).length*14+38,...rows.value.slice(0,500).map(n=>[...(column.kind==='name'?title(n):value(n,column)).slice(0,160)].reduce((sum,c)=>sum+(c.charCodeAt(0)>255?14:7.5),0)+32))
 setCatalogWidth(scope.value,column.key,width)
}
function select(node:ExplorerNode){emit('select',node)}
function menu(event:MouseEvent|KeyboardEvent,node:ExplorerNode){event.preventDefault();event.stopPropagation();emit('select',node);emit('menu',event,node)}
const queryCatalog=computed(()=>isQueryFolder(props.node))
const renameOpen=ref(false),renameValue=ref('')
const columns=computed(()=>queryCatalog.value?queryColumns:props.node?.category==='collections'?collectionColumns:props.node?.kind==='database'&&(props.kind==='mysql'||props.kind==='mariadb'||props.kind==='clickhouse')?tableColumns:[nameColumn])
const activeColumn=computed(()=>columns.value.find(c=>c.key===sortKey.value)||nameColumn)
const rows=computed(()=>sortedObjects(props.nodes,activeColumn.value,direction.value,query.value))
const selectedNode=computed(()=>rows.value.find(n=>n.id===selected.value))
const incomplete=computed(()=>columns.value.length>1&&props.nodes.some(n=>!n.metrics?.length))
watch(()=>props.node?.id,()=>{query.value='';sortKey.value='name';direction.value=1})
function sortBy(column:CatalogColumn){direction.value=sortKey.value===column.key&&direction.value===1?-1:1;sortKey.value=column.key}
function value(node:ExplorerNode,column:CatalogColumn){
 const item=objectMetric(node,column.key)
 if(!item)return '—'
 if(item.format==='bytes')return formatBytes(item.value,locale.value).split(' (')[0]
 if(item.format==='boolean')return t(item.value==='true'?'是':'否')
 if(column.key==='创建日期'||column.key==='修改日期'){const date=new Date(item.value);return Number.isNaN(date.getTime())?item.value:date.toLocaleString(locale.value)}
 return item.value
}
function open(node?:ExplorerNode){if(node&&!props.busy)emit('open',node)}
function title(node:ExplorerNode){return node.kind==='mongo-category'||node.kind==='query-folder'?t(node.label):node.label}
function rename(){if(!selectedNode.value)return;renameValue.value=selectedNode.value.label;renameOpen.value=true}
function applyRename(){if(!selectedNode.value||!renameValue.value.trim())return;emit('queryAction','rename',selectedNode.value,renameValue.value);renameOpen.value=false}
</script>
<template>
 <section class="object-list-panel">
  <div class="object-list-toolbar">
   <button class="btn secondary small" type="button" :disabled="busy||!selectedNode" @click="open(selectedNode)"><span aria-hidden="true">▱</span>{{ t('打开') }}</button>
   <button v-if="node?.database" class="btn secondary small" type="button" :disabled="busy" @click="emit('query')"><span aria-hidden="true">＋</span>{{ t('新建查询') }}</button>
   <template v-if="queryCatalog">
    <button class="btn secondary small" type="button" :disabled="busy||!selectedNode||!canSaveQueries" @click="rename">{{ t('重命名') }}</button>
    <button class="btn secondary small" type="button" :disabled="busy||!selectedNode||!canSaveQueries" @click="emit('queryAction','copy',selectedNode)">{{ t('复制') }}</button>
    <button class="btn danger-text small" type="button" :disabled="busy||!selectedNode||!canSaveQueries" @click="emit('queryAction','delete',selectedNode)">{{ t('删除') }}</button>
    <button class="btn secondary small" type="button" :disabled="busy||!canSaveQueries" @click="emit('queryAction','import')">{{ t('导入查询') }}</button>
    <button class="btn secondary small" type="button" :disabled="busy||!selectedNode||!canSaveQueries" @click="emit('queryAction','export',selectedNode)">{{ t('导出查询') }}</button>
    <button v-if="node&&folderQueryMode(node)==='sql'" class="btn secondary small" type="button" :disabled="busy||!selectedNode||!canSaveQueries" @click="emit('queryAction','export-sql',selectedNode)">{{ t('导出 SQL') }}</button>
   </template>
   <button class="btn secondary small" type="button" :disabled="busy" @click="emit('refresh')"><span aria-hidden="true">↻</span>{{ t('刷新') }}</button>
   <span class="toolbar-spacer"></span><template v-if="inspectorAvailable&&!globalInspectorTab"><button class="btn secondary small" @click="openGlobalInspector('info')">{{t('对象信息')}}</button><button class="btn secondary small" @click="openGlobalInspector('ddl')">DDL</button></template>
   <label class="object-list-search"><span aria-hidden="true">⌕</span><input v-model="query" :placeholder="t('查找数据库对象')" :aria-label="t('查找数据库对象')" /></label>
  </div>
  <div ref="scrollHost" class="object-list-scroll">
   <table class="object-list-table" :style="{width:tableWidth+'px'}">
    <colgroup><col v-for="column in columns" :key="column.key" :style="{width:columnWidth(column)+'px'}"/></colgroup>
    <thead><tr><th v-for="column in columns" :key="column.key" :aria-sort="sortKey===column.key?(direction===1?'ascending':'descending'):undefined"><button type="button" @click="sortBy(column)">{{ t(column.label) }}<span v-if="sortKey===column.key" aria-hidden="true">{{ direction===1?'↑':'↓' }}</span></button><span class="catalog-column-resize" role="separator" aria-orientation="vertical" :aria-label="t('调整列宽')+': '+t(column.label)" :aria-valuemin="catalogWidthMin" :aria-valuemax="catalogWidthMax" :aria-valuenow="columnWidth(column)" tabindex="0" @pointerdown.stop="resize($event,column)" @keydown.stop="resizeKey($event,column)" @dblclick.stop="autoFit(column)"/></th></tr></thead>
    <tbody>
      <tr v-for="item in rows" :key="item.id" :class="{selected:selected===item.id}" tabindex="0" @click="select(item)" @contextmenu="menu($event,item)" @keydown.shift.f10.prevent="menu($event,item)" @dblclick="open(item)" @keydown.enter.prevent="open(item)">
       <td v-for="column in columns" :key="column.key" :class="{'catalog-numeric':column.kind==='number'}" :title="column.kind==='name'?title(item):objectMetric(item,column.key)?.value">
        <template v-if="column.kind==='name'"><span class="catalog-object-icon" aria-hidden="true">▦</span>{{ title(item) }}</template><template v-else>{{ value(item,column) }}</template>
       </td>
      </tr>
      <tr v-if="!rows.length"><td :colspan="columns.length" class="empty-grid">{{ busy?t('正在加载资源…'):t('无可见对象') }}</td></tr>
    </tbody>
   </table>
  </div>
  <footer class="object-list-footer"><span>{{ rows.length }} / {{ nodes.length }}</span><span v-if="incomplete">{{ t('统计信息仅对已读取的对象可用。') }}</span></footer>
  <div v-if="renameOpen" class="modal-backdrop"><section class="dialog" role="dialog" :aria-label="t('重命名')"><header class="dialog-header"><h2>{{ t('重命名') }}</h2></header><div class="dialog-body"><label class="field field-wide">{{ t('名称') }}<input v-model="renameValue" :aria-label="t('名称')" maxlength="100" @keydown.enter.prevent="applyRename" /></label></div><footer class="dialog-footer"><button class="btn secondary" @click="renameOpen=false">{{ t('取消') }}</button><button class="btn primary" :disabled="!renameValue.trim()" @click="applyRename">{{ t('确认') }}</button></footer></section></div>
 </section>
</template>
<style scoped>
.object-list-panel{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--panel)}
.object-list-toolbar{display:flex;gap:8px;align-items:center;padding:7px 10px;flex-wrap:wrap;border-bottom:1px solid var(--border-soft);flex:none}
.object-list-search{display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:4px;padding-inline-start:8px;max-width:240px;min-width:100px}
.object-list-search input{border:0;background:transparent;min-width:0;width:100%}
.object-list-scroll{min-height:0;overflow:auto;flex:1}
.object-list-table{table-layout:fixed;min-width:0;border-collapse:separate;border-spacing:0;font-size:12px}
.object-list-table th{position:sticky;top:0;background:var(--header-bg);text-align:start;z-index:1;border-bottom:1px solid var(--border);border-inline-end:1px solid var(--border-soft)}
.object-list-table th button{display:flex;align-items:center;gap:8px;justify-content:space-between;width:100%;background:transparent;color:var(--text);border:0;border-radius:0;padding:7px 10px;white-space:nowrap}
.object-list-table th button{padding-inline-end:14px;overflow:hidden;text-overflow:ellipsis}
.catalog-column-resize{position:absolute;inset-block:0;inset-inline-end:0;width:7px;cursor:col-resize;touch-action:none;z-index:2}.catalog-column-resize:hover,.catalog-column-resize:focus-visible{background:var(--accent)}
.object-list-table th button span{color:var(--accent)}
.object-list-table td{height:29px;padding:4px 10px;white-space:nowrap;border-bottom:1px solid var(--border-soft);color:var(--text);overflow:hidden;text-overflow:ellipsis}
.object-list-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--panel-raised) 45%,var(--panel))}
.object-list-table tbody tr:hover,.object-list-table tbody tr.selected{background:var(--selected)}
.catalog-numeric{font-variant-numeric:tabular-nums;text-align:end}
.catalog-object-icon{display:inline-grid;place-items:center;color:var(--accent);margin-inline-end:9px;font-size:16px}
.object-list-footer{display:flex;justify-content:space-between;padding:6px 10px;font-size:11px;color:var(--muted);border-top:1px solid var(--border)}
</style>
