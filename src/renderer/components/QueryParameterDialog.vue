<script setup lang="ts">
import {ref} from 'vue'
import {t,localize} from '../i18n'
type Parameter={name:string;type:'string'|'number'|'boolean'|'null';value:string}
const props=defineProps<{modelValue:string;named:boolean}>()
const emit=defineEmits<{close:[];apply:[value:string]}>()
const rows=ref<Parameter[]>([]),error=ref('')
try{
 const value=JSON.parse(props.modelValue|| (props.named?'{}':'[]'))
 if(props.named?(!value||typeof value!=='object'||Array.isArray(value)):!Array.isArray(value))throw Error('参数格式无效')
 rows.value=Object.entries(value).map(([name,value])=>{
  if(value!==null&&!['string','number','boolean'].includes(typeof value))throw Error('参数格式无效')
  return {name,type:value===null?'null':typeof value as Parameter['type'],value:value===null?'':String(value)}
 })
}catch{error.value='参数格式无效'}
function add(){rows.value.push({name:props.named?'param'+(rows.value.length+1):String(rows.value.length),type:'string',value:''})}
function move(i:number,d:number){const next=i+d;if(next<0||next>=rows.value.length)return;const [item]=rows.value.splice(i,1);rows.value.splice(next,0,item!)}
function apply(){
 try{
  const values=rows.value.map(row=>{
   if(row.type==='null')return null
   if(row.type==='string')return row.value
   if(row.type==='boolean'){if(!['true','false'].includes(row.value))throw Error('布尔参数必须为 true 或 false');return row.value==='true'}
   const value=Number(row.value)
   if(!row.value.trim()||!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))throw Error('超出安全数字范围，请将精确大整数作为字符串参数')
   return value
  })
  if(props.named&&(new Set(rows.value.map(r=>r.name)).size!==rows.value.length||rows.value.some(r=>!r.name||['__proto__','constructor','prototype'].includes(r.name))))throw Error('参数名称无效或重复')
  emit('apply',JSON.stringify(props.named?Object.fromEntries(rows.value.map((r,i)=>[r.name,values[i]])):values))
 }catch(e){error.value=e instanceof Error?e.message:String(e)}
}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog parameter-dialog" role="dialog" :aria-label="t('参数编辑器')">
 <header class="dialog-header"><h2>{{t('参数编辑器')}}</h2><button class="icon-button" @click="emit('close')">×</button></header>
 <div class="parameter-body"><p class="muted-text">{{t('精确大整数与 DECIMAL 请使用字符串类型，避免 JavaScript 数值精度损失。')}}</p>
 <div class="parameter-row" v-for="(row,i) in rows" :key="i"><input v-if="named" v-model="row.name" :aria-label="t('参数名称')"/><span v-else>#{{i+1}}</span><select v-model="row.type" :aria-label="t('类型')"><option v-for="kind in ['string','number','boolean','null']" :key="kind">{{kind}}</option></select><input v-model="row.value" :disabled="row.type==='null'" :aria-label="t('参数值')"/><button class="btn secondary small" :disabled="i===0" @click="move(i,-1)">↑</button><button class="btn secondary small" :disabled="i===rows.length-1" @click="move(i,1)">↓</button><button class="btn secondary small" @click="rows.splice(i,1)">×</button></div>
 <button class="btn secondary" @click="add">{{t('添加参数')}}</button><p v-if="error" class="inline-message error" role="alert">{{localize(error)}}</p></div>
 <footer class="dialog-footer"><button class="btn secondary" @click="emit('close')">{{t('取消')}}</button><button class="btn primary" @click="apply">{{t('应用')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.parameter-dialog{width:min(750px,92vw);max-height:85vh;display:flex;flex-direction:column}.parameter-body{padding:12px 16px;overflow:auto;min-height:0}.parameter-row{display:flex;align-items:center;gap:7px;margin:8px 0}.parameter-row input{flex:1;min-width:0}.parameter-row span{min-width:32px}</style>
