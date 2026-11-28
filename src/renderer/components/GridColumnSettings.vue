<script setup lang="ts">
import {computed} from 'vue'
import {t} from '../i18n'
import {normalizeGridLayout,type GridLayout} from '../../shared/grid-layout'
const props=defineProps<{fields:string[];modelValue:GridLayout;details?:Record<string,{type?:string;comment?:string}>}>()
const emit=defineEmits<{'update:modelValue':[GridLayout];close:[]}>()
const value=computed(()=>normalizeGridLayout(props.modelValue,props.fields))
function patch(p:Partial<GridLayout>){emit('update:modelValue',normalizeGridLayout({...value.value,...p},props.fields))}
function toggle(key:'hidden'|'pinned',name:string){const old=value.value[key];patch({[key]:old.includes(name)?old.filter(v=>v!==name):[...old,name]})}
function move(name:string,delta:number){const order=[...value.value.order],i=order.indexOf(name),j=i+delta;if(j<0||j>=order.length)return;[order[i],order[j]]=[order[j]!,order[i]!];patch({order})}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog grid-column-settings" role="dialog" :aria-label="t('列管理')">
  <header class="dialog-header"><h2>{{t('列管理')}}</h2><button class="icon-button" @click="emit('close')">×</button></header>
  <div class="grid-column-settings-list"><table><thead><tr><th>{{t('显示')}}</th><th>{{t('字段')}}</th><th>{{t('类型')}}</th><th>{{t('注释')}}</th><th>{{t('固定列')}}</th><th>{{t('顺序')}}</th></tr></thead><tbody>
   <tr v-for="(field,i) in value.order" :key="field"><td><input type="checkbox" :aria-label="t('显示')+' '+field" :checked="!value.hidden.includes(field)" :disabled="!value.hidden.includes(field)&&value.hidden.length===fields.length-1" @change="toggle('hidden',field)"/></td><td>{{field}}</td><td>{{details?.[field]?.type||'—'}}</td><td :title="details?.[field]?.comment">{{details?.[field]?.comment||'—'}}</td><td><input type="checkbox" :aria-label="t('固定列')+' '+field" :checked="value.pinned.includes(field)" @change="toggle('pinned',field)"/></td><td><button class="btn secondary small" :disabled="i===0" @click="move(field,-1)">↑</button><button class="btn secondary small" :disabled="i===value.order.length-1" @click="move(field,1)">↓</button></td></tr>
  </tbody></table></div>
  <footer class="dialog-footer"><button class="btn secondary" @click="emit('update:modelValue',normalizeGridLayout(null,fields))">{{t('恢复默认')}}</button><button class="btn primary" @click="emit('close')">{{t('关闭')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.grid-column-settings{width:min(960px,94vw);max-height:80vh;display:flex;flex-direction:column}.grid-column-settings-list{flex:1;min-height:0;overflow:auto;padding:8px 16px}.grid-column-settings-list table{width:100%;border-collapse:collapse;text-align:start}.grid-column-settings-list td,.grid-column-settings-list th{padding:7px;border-bottom:1px solid var(--border-soft);text-align:start}.grid-column-settings-list th{position:sticky;top:0;background:var(--header-bg)}.grid-column-settings-list td:last-child{white-space:nowrap}.grid-column-settings-list td{max-width:240px;overflow-wrap:anywhere}</style>
