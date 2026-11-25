<script setup lang="ts">
import {computed} from 'vue'
import {t} from '../i18n'
import {mongoCategory} from '../../shared/mongo-catalog'
import {isQueryFolder} from '../../shared/saved-query'
import type {ExplorerNode,SessionInfo} from '../../shared/types'
import {colorStyle} from '../../shared/connection-appearance'

interface TreeState {
 roots:ExplorerNode[]
 children:Record<string,ExplorerNode[]>
 expanded:string[]
 selected?:ExplorerNode
 loading:Set<string>
 busy:boolean
}
const props=defineProps<{session:SessionInfo;state?:TreeState;active:boolean;busy:boolean;color?:string;grouped?:boolean}>()
const emit=defineEmits<{select:[node:ExplorerNode];menu:[event:MouseEvent|KeyboardEvent,node?:ExplorerNode]}>()
function expandable(node:ExplorerNode){return isQueryFolder(node)||node.kind==='database'||node.kind==='mongo-category'&&!!mongoCategory(node.category)?.expandable}
function nodeIcon(node:ExplorerNode){
 if(node.kind==='saved-query'||node.kind==='query-folder')return '▤'
 if(node.kind==='mongo-category')return mongoCategory(node.category)?.icon||'▦'
 return node.kind==='view'?'◉':node.kind==='mongo-indexes'?'A–Z':node.kind==='mongo-function'?'ƒ':node.kind==='gridfs-bucket'?'▣':node.kind==='keyspace'?'⬡':'▦'
}
function isSelected(node:ExplorerNode){return props.active&&(props.state?.selected?.id===node.id||!!node.queryId&&props.state?.selected?.queryId===node.queryId)}
function label(node:ExplorerNode){return node.kind==='mongo-category'||node.kind==='query-folder'?t(node.label):node.label}
const rows=computed(()=>{
 const state=props.state,result:{node:ExplorerNode;depth:number;empty?:boolean}[]=[]
 if(!state)return result
 function visit(node:ExplorerNode,depth:number){
  result.push({node,depth})
  if(!state!.expanded.includes(node.id))return
  const children=state!.children[node.id]
  if(children){
   if(!children.length&&!state!.loading.has(node.id))result.push({node,depth:depth+1,empty:true})
   else for(const child of children)visit(child,depth+1)
  }
 }
 for(const root of state.roots)visit(root,0)
 return result
})
</script>
<template>
 <div :class="['resource-list','connection-resources',{'has-color':!!color,'in-group':grouped}]" :style="colorStyle(color)" :data-resource-session="session.id" :data-active-session="active" @contextmenu.self="emit('menu',$event)">
  <span v-if="state?.busy" class="empty-tree">{{ t('正在加载资源…') }}</span>
  <span v-else-if="!rows.length" class="empty-tree">{{ t('无可见对象') }}</span>
  <template v-for="item in rows" :key="item.node.id+(item.empty?':empty':'')">
   <span v-if="item.empty" class="empty-tree" :style="{paddingInlineStart:(42+item.depth*16)+'px'}">{{ t('无可见对象') }}</span>
   <button v-else :class="['resource-node',{'child-node':item.depth>0,'mongo-folder':item.node.kind==='mongo-category',active:isSelected(item.node)}]" type="button"
     :style="{paddingInlineStart:(18+item.depth*16)+'px'}" :title="label(item.node)" :data-object-kind="item.node.kind" :data-object-type="item.node.objectType" :data-object-category="item.node.category"
     :aria-expanded="expandable(item.node)?state?.expanded.includes(item.node.id):undefined" :disabled="busy"
     @click="emit('select',item.node)" @contextmenu.stop="emit('menu',$event,item.node)" @keydown.shift.f10.prevent.stop="emit('menu',$event,item.node)">
     <span class="arrow" aria-hidden="true">{{ expandable(item.node)?state?.expanded.includes(item.node.id)?'⌄':'›':'' }}</span>
     <span :class="['object-tree-icon',item.node.kind]" aria-hidden="true">
       <svg v-if="item.node.kind==='database'" viewBox="0 0 16 16" width="15" height="15" fill="none"><path d="M2 4v8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V4" fill="currentColor" opacity=".7"/><ellipse cx="8" cy="4" rx="6" ry="2.5" fill="currentColor"/><path d="M2 8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" stroke="var(--panel)" stroke-width=".7" opacity=".65"/></svg>
       <template v-else>{{ nodeIcon(item.node) }}</template>
     </span>
     <span class="ellipsis">{{ label(item.node) }}</span><small v-if="item.node.objectType" class="muted-text" :title="item.node.objectType">{{ item.node.objectType==='sequence'?'SEQ':'SV' }}</small><span v-if="state?.loading.has(item.node.id)">…</span>
   </button>
  </template>
 </div>
</template>
<style scoped>
.connection-resources{overflow:visible;min-width:0;padding:0 0 3px;background:transparent;margin-inline-start:0;border-inline-start:2px solid transparent}
.connection-resources.in-group{margin-inline-start:12px}
.connection-resources.has-color{border-inline-start-color:var(--connection-color);background:color-mix(in srgb,var(--connection-color) 9%,var(--panel))}
.connection-resources .resource-node{min-height:29px;padding-block:4px;padding-inline-end:6px;gap:5px;color:var(--text);font-size:12px}
.connection-resources .resource-node .ellipsis{flex:1;min-width:0}
.connection-resources .resource-node.active{background:var(--selected);color:var(--text)}
.connection-resources.has-color .resource-node.active{background:color-mix(in srgb,var(--connection-color) 26%,var(--panel))}
.connection-resources .object-tree-icon.database{color:var(--muted)}
.connection-resources .resource-node.active .object-tree-icon.database{color:var(--success)}
.connection-resources .empty-tree{padding:5px 10px 6px 32px}
</style>
