<script setup lang="ts">
import {computed,ref} from 'vue'
import {t,localize} from '../i18n'
import {sqlResultFields,prepareSqlResultEdit} from '../../shared/sql-result-edit'
import type {DatabaseKind,OperationResult,SqlGridEdit} from '../../shared/types'
const props=defineProps<{result:OperationResult;structure:OperationResult;kind:DatabaseKind;index:number;target:string;busy:boolean;error:string}>()
const emit=defineEmits<{save:[edit:SqlGridEdit];close:[]}>()
const fields=sqlResultFields(props.result,props.structure,props.kind,props.index)
const values=ref(Object.fromEntries(fields.map(f=>[f.field,f.text]))),localError=ref('')
const changed=computed(()=>fields.some(f=>values.value[f.field]!==f.text))
function save(){
 try{const edit=prepareSqlResultEdit(props.result,props.structure,props.kind,props.index,values.value);if(edit)emit('save',edit)}catch(e){localError.value=e instanceof Error?e.message:String(e)}
}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog sql-result-edit-dialog" role="dialog" :aria-label="t('编辑查询记录')">
  <header class="dialog-header"><div><h2>{{t('编辑查询记录')}}</h2><span class="muted-text">{{target}}</span></div><button class="icon-button" :disabled="busy" @click="emit('close')">×</button></header>
  <p class="compact-help">{{t('仅修改完整单表结果中的可编辑字段；保存时核对完整原始记录。')}}</p>
  <div class="sql-result-fields">
   <label v-for="field in fields" :key="field.field" class="field"><span>{{field.field}} <small>{{field.type}}</small></span><textarea v-if="field.text.length>180||/TEXT|JSON/i.test(field.type)" v-model="values[field.field]" :aria-label="field.field" rows="3" :disabled="busy" spellcheck="false"/><input v-else v-model="values[field.field]" :aria-label="field.field" :disabled="busy" spellcheck="false"/></label>
  </div>
  <p v-if="localError||error" class="inline-message error" role="alert">{{localize(localError||error)}}</p>
  <footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="emit('close')">{{t('取消')}}</button><button class="btn primary" :disabled="busy||!changed" @click="save">{{t('保存修改')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.sql-result-edit-dialog{width:min(850px,92vw);max-height:85vh;display:flex;flex-direction:column}.sql-result-fields{overflow:auto;min-height:0;flex:1;padding:12px 18px;display:flex;flex-direction:column;gap:10px}.sql-result-fields label{display:grid;grid-template-columns:minmax(120px,1fr) minmax(180px,2fr);align-items:start;gap:12px}.sql-result-fields small{display:block;color:var(--muted)}.sql-result-fields textarea,.sql-result-fields input{width:100%;min-width:0}</style>
