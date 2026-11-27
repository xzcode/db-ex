<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import {treeNodes,editBsonTree,type TreeChange} from '../../shared/bson-tree-edit'
const props=defineProps<{modelValue:string;readonly:boolean}>()
const emit=defineEmits<{'update:modelValue':[string]}>()
const expanded=ref(new Set(['[]'])),selected=ref<string[]>([])
const error=ref(''),mode=ref<'set'|'add'|'rename'>(),name=ref(''),value=ref('')
const rows=computed(()=>{try{return treeNodes(props.modelValue,expanded.value)}catch{return []}})
const current=computed(()=>rows.value.find(r=>JSON.stringify(r.path)===JSON.stringify(selected.value)))
const writable=computed(()=>!!current.value&&!props.readonly&&selected.value[0]!=='_id')
const parent=computed(()=>rows.value.find(r=>JSON.stringify(r.path)===JSON.stringify(selected.value.slice(0,-1))))
function select(path:string[]){selected.value=path;mode.value=undefined;error.value=''}
function toggle(path:string[]){const next=new Set(expanded.value),id=JSON.stringify(path);if(next.has(id))next.delete(id);else next.add(id);expanded.value=next}
function start(next:'set'|'add'|'rename'){
 if(!writable.value||!current.value)return
 mode.value=next;name.value=next==='rename'?current.value.key:'';value.value=next==='set'?JSON.stringify(current.value.value,null,2):'null';error.value=''
}
function apply(change:TreeChange){
 if(!writable.value)return
 try{const text=editBsonTree(props.modelValue,change);emit('update:modelValue',text);if(change.action==='add')expanded.value=new Set([...expanded.value,JSON.stringify(change.path)]);if(change.action==='remove'||change.action==='rename')selected.value=change.path.slice(0,-1);mode.value=undefined;error.value=''}catch(e){error.value=e instanceof Error?e.message:String(e)}
}
function save(){if(mode.value==='add')apply({action:'add',path:selected.value,name:name.value,value:value.value});else if(mode.value==='rename')apply({action:'rename',path:selected.value,name:name.value});else if(mode.value==='set')apply({action:'set',path:selected.value,value:value.value})}
watch(()=>props.readonly,()=>{if(props.readonly)mode.value=undefined})
</script>
<template>
 <section class="bson-tree-editor">
  <div class="editor-toolbar">
   <button class="btn secondary small" :disabled="!writable||!current?.container" @click="start('add')">{{t('新增节点')}}</button>
   <button class="btn secondary small" :disabled="!writable||!selected.length" @click="start('set')">{{t('修改节点值')}}</button>
   <button class="btn secondary small" :disabled="!writable||!selected.length||parent?.type==='Array'" @click="start('rename')">{{t('重命名字段')}}</button>
   <button class="btn secondary small danger-text" :disabled="!writable||!selected.length" @click="apply({action:'remove',path:selected})">{{t('删除节点')}}</button>
  </div>
  <div v-if="error" class="inline-message error">{{localize(error)}}</div>
  <div v-if="mode" class="tree-edit-form">
   <label v-if="mode==='rename'||mode==='add'&&current?.type!=='Array'" class="field">{{t('字段')}}<input v-model="name" :aria-label="t('字段名称')"/></label>
   <label v-if="mode!=='rename'" class="field">{{t('字段值')}}<textarea v-model="value" rows="5" :aria-label="t('节点值')" spellcheck="false"/></label>
   <div class="editor-toolbar"><span class="muted-text">{{t('支持 BSON 构造语法和 EJSON。修改仅暂存在编辑器中。')}}</span><button class="btn secondary small" @click="mode=undefined">{{t('取消')}}</button><button class="btn primary small" @click="save">{{t('暂存修改')}}</button></div>
  </div>
  <div class="tree-edit-grid"><table class="data-table"><thead><tr><th>{{t('字段')}}</th><th>{{t('类型')}}</th><th>{{t('字段值')}}</th></tr></thead><tbody>
   <tr v-for="row in rows" :key="JSON.stringify(row.path)" :data-tree-path="JSON.stringify(row.path)" :class="{selected:JSON.stringify(selected)===JSON.stringify(row.path)}" @click="select(row.path)" @dblclick="select(row.path);row.path.length&&start('set')">
    <td><div class="tree-edit-name" :style="{paddingInlineStart:Math.min(row.depth,24)*16+'px'}"><button v-if="row.container" class="ghost-icon" :aria-expanded="expanded.has(JSON.stringify(row.path))" :aria-label="row.key" @click.stop="toggle(row.path)">{{expanded.has(JSON.stringify(row.path))?'⌄':'›'}}</button><span v-else class="tree-edit-spacer"/>{{row.key}}</div></td><td>{{row.type}}</td><td :title="JSON.stringify(row.value)">{{row.container?'('+Object.keys(row.value as object).length+')':JSON.stringify(row.value)}}</td>
   </tr>
  </tbody></table><p v-if="!rows.length" class="compact-help">{{t('无法解析文档，请查看原始 EJSON。')}}</p></div>
 </section>
</template>
<style scoped>.bson-tree-editor{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}.tree-edit-grid{overflow:auto;flex:1;min-height:0}.tree-edit-grid table{table-layout:fixed;width:100%}.tree-edit-grid th:first-child{width:35%}.tree-edit-grid th:nth-child(2){width:120px}.tree-edit-grid td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tree-edit-name{display:flex;align-items:center;gap:6px}.tree-edit-spacer{width:24px;flex:none}.tree-edit-form{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px;flex:none}.tree-edit-form textarea{width:100%;font:12px monospace;resize:vertical;min-height:55px;max-height:180px}</style>
