<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {t,locale} from '../i18n'
import type {DatabaseKind,ExplorerNode} from '../../shared/types'
import {formatBytes} from '../../shared/object-inspection'
import {collectionColumns,tableColumns,nameColumn,objectMetric,sortedObjects,type CatalogColumn} from '../../shared/object-list'
const props=defineProps<{kind:DatabaseKind;node?:ExplorerNode;nodes:ExplorerNode[];busy?:boolean}>()
const emit=defineEmits<{open:[node:ExplorerNode];refresh:[];query:[]}>()
const query=ref(''),selected=ref(''),sortKey=ref('name'),direction=ref<1|-1>(1)
const columns=computed(()=>props.node?.category==='collections'?collectionColumns:props.node?.kind==='database'&&(props.kind==='mysql'||props.kind==='mariadb')?tableColumns:[nameColumn])
const activeColumn=computed(()=>columns.value.find(c=>c.key===sortKey.value)||nameColumn)
const rows=computed(()=>sortedObjects(props.nodes,activeColumn.value,direction.value,query.value))
const selectedNode=computed(()=>rows.value.find(n=>n.id===selected.value))
const incomplete=computed(()=>columns.value.length>1&&props.nodes.some(n=>!n.metrics?.length))
watch(()=>props.node?.id,()=>{query.value='';selected.value='';sortKey.value='name';direction.value=1})
function sortBy(column:CatalogColumn){direction.value=sortKey.value===column.key&&direction.value===1?-1:1;sortKey.value=column.key}
function value(node:ExplorerNode,column:CatalogColumn){
 const item=objectMetric(node,column.key)
 if(!item)return '—'
 if(item.format==='bytes')return formatBytes(item.value,locale.value).split(' (')[0]
 if(item.format==='boolean')return t(item.value==='true'?'是':'否')
 return item.value
}
function open(node?:ExplorerNode){if(node&&!props.busy)emit('open',node)}
function title(node:ExplorerNode){return node.kind==='mongo-category'?t(node.label):node.label}
</script>
<template>
 <section class="object-list-panel">
  <div class="object-list-toolbar">
   <button class="btn secondary small" type="button" :disabled="busy||!selectedNode" @click="open(selectedNode)"><span aria-hidden="true">▱</span>{{ t('打开') }}</button>
   <button v-if="node?.database" class="btn secondary small" type="button" :disabled="busy" @click="emit('query')"><span aria-hidden="true">＋</span>{{ t('新建查询') }}</button>
   <button class="btn secondary small" type="button" :disabled="busy" @click="emit('refresh')"><span aria-hidden="true">↻</span>{{ t('刷新') }}</button>
   <span class="toolbar-spacer"></span>
   <label class="object-list-search"><span aria-hidden="true">⌕</span><input v-model="query" :placeholder="t('查找数据库对象')" :aria-label="t('查找数据库对象')" /></label>
  </div>
  <div class="object-list-scroll">
   <table class="object-list-table">
    <thead><tr><th v-for="column in columns" :key="column.key" :aria-sort="sortKey===column.key?(direction===1?'ascending':'descending'):undefined"><button type="button" @click="sortBy(column)">{{ t(column.label) }}<span v-if="sortKey===column.key" aria-hidden="true">{{ direction===1?'↑':'↓' }}</span></button></th></tr></thead>
    <tbody>
      <tr v-for="item in rows" :key="item.id" :class="{selected:selected===item.id}" tabindex="0" @click="selected=item.id" @dblclick="open(item)" @keydown.enter.prevent="open(item)">
       <td v-for="column in columns" :key="column.key" :class="{'catalog-numeric':column.kind==='number'}" :title="column.kind==='name'?title(item):objectMetric(item,column.key)?.value">
        <template v-if="column.kind==='name'"><span class="catalog-object-icon" aria-hidden="true">▦</span>{{ title(item) }}</template><template v-else>{{ value(item,column) }}</template>
       </td>
      </tr>
      <tr v-if="!rows.length"><td :colspan="columns.length" class="empty-grid">{{ busy?t('正在加载资源…'):t('无可见对象') }}</td></tr>
    </tbody>
   </table>
  </div>
  <footer class="object-list-footer"><span>{{ rows.length }} / {{ nodes.length }}</span><span v-if="incomplete">{{ t('统计信息仅对已读取的对象可用。') }}</span></footer>
 </section>
</template>
<style scoped>
.object-list-panel{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--panel)}
.object-list-toolbar{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border-soft);flex:none}
.object-list-search{display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:4px;padding-inline-start:8px;max-width:240px;min-width:100px}
.object-list-search input{border:0;background:transparent;min-width:0;width:100%}
.object-list-scroll{min-height:0;overflow:auto;flex:1}
.object-list-table{width:100%;min-width:max-content;border-collapse:separate;border-spacing:0;font-size:12px}
.object-list-table th{position:sticky;top:0;background:var(--panel-raised);text-align:start;z-index:1;border-bottom:1px solid var(--border);border-inline-end:1px solid var(--border-soft)}
.object-list-table th button{display:flex;align-items:center;gap:8px;justify-content:space-between;width:100%;background:transparent;color:var(--text);border:0;border-radius:0;padding:7px 10px;white-space:nowrap}
.object-list-table th:first-child{min-width:210px}
.object-list-table th button span{color:var(--accent)}
.object-list-table td{height:29px;padding:4px 10px;white-space:nowrap;border-bottom:1px solid var(--border-soft);color:var(--text)}
.object-list-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--panel-raised) 45%,var(--panel))}
.object-list-table tbody tr:hover,.object-list-table tbody tr.selected{background:var(--selected)}
.catalog-numeric{font-variant-numeric:tabular-nums;text-align:end}
.catalog-object-icon{display:inline-grid;place-items:center;color:var(--accent);margin-inline-end:9px;font-size:16px}
.object-list-footer{display:flex;justify-content:space-between;padding:6px 10px;font-size:11px;color:var(--muted);border-top:1px solid var(--border)}
</style>
