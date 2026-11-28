<script setup lang="ts">
import {ref} from 'vue'
import {t,localize} from '../i18n'
import {locatorType,recordLocator} from '../../shared/browse-navigation'
import type {DatabaseKind,OperationResult} from '../../shared/types'
import type {FilterType,BrowseFilter} from '../../shared/browse-filter'
const props=defineProps<{kind:DatabaseKind;database:string;entity:string;keys:string[];structure?:OperationResult|null}>()
const emit=defineEmits<{close:[];locate:[value:ReturnType<typeof recordLocator>]}>()
const rows=ref(props.keys.map(field=>({field,type:locatorType(props.structure?.rows.find(r=>(r.name||r.Field)===field)?.type||'',props.kind),value:''})))
const types:FilterType[]=props.kind==='mongodb'?['ObjectId','String','Int32','Long','Double','Decimal128','Boolean','ISODate','Custom']:['String','Int32','Long','Double','Decimal128','Boolean']
const error=ref('')
function locate(){try{emit('locate',recordLocator(props.kind,props.database,props.entity,props.keys,rows.value))}catch(e){error.value=e instanceof Error?e.message:String(e)}}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog record-locator" role="dialog" :aria-label="t('定位记录')">
 <header class="dialog-header"><h2>{{t('定位记录')}}</h2><button class="icon-button" @click="emit('close')">×</button></header>
 <div class="dialog-body"><p class="compact-help field-wide">{{t('按完整主键查询。定位时临时替换当前筛选，可返回原筛选。')}}</p>
 <div v-for="row in rows" :key="row.field" class="locator-row field-wide"><strong>{{row.field}}</strong><select v-model="row.type" :aria-label="row.field+' '+t('类型')"><option v-for="type in types" :key="type">{{type}}</option></select><input v-model="row.value" :aria-label="row.field" spellcheck="false" @keydown.enter.prevent="locate"/></div>
 <p v-if="error" class="inline-message error field-wide" role="alert">{{localize(error)}}</p></div>
 <footer class="dialog-footer"><button class="btn secondary" @click="emit('close')">{{t('取消')}}</button><button class="btn primary" @click="locate">{{t('定位记录')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.record-locator{width:min(660px,92vw)}.locator-row{display:grid;grid-template-columns:minmax(100px,1fr) 130px minmax(140px,2fr);gap:8px;align-items:center}.locator-row input{min-width:0}</style>
