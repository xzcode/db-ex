<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {DatabaseKind} from '../../shared/types'
import {migrationConversions,type MigrationObjectMap,type MigrationField} from '../../shared/migration'
import {compileSqlBrowsePredicate} from '../../shared/sql-browse-predicate'
import {t,localize} from '../i18n'
const props=defineProps<{sourceId:string;sourceDb:string;targetId:string;targetDb:string;sourceKind:DatabaseKind;targetKind:DatabaseKind;targetObjects:string[];busy:boolean;allowFilters:boolean}>()
const maps=defineModel<MigrationObjectMap[]>({required:true})
const emit=defineEmits<{ready:[boolean];busyChange:[boolean]}>()
const selected=ref(''),sourceFields=ref<MigrationField[]>([]),targetFields=ref<MigrationField[]>([]),loading=ref(false),error=ref('')
const paramsDraft=ref('{}'),paramsValid=ref(true)
const current=computed(()=>maps.value.find(m=>m.source===selected.value))
const relational=computed(()=>['mysql','mariadb','sqlite'].includes(props.sourceKind))
const redis=computed(()=>props.sourceKind==='redis')
const valid=computed(()=>!loading.value&&paramsValid.value&&maps.value.length>0&&maps.value.every(m=>{
 if(!m.target||!redis.value&&!props.targetObjects.includes(m.target)||!redis.value&&(!m.fields.length||m.fields.some(f=>!f.source||!f.target)))return false
 if(m.predicate){try{compileSqlBrowsePredicate(m.predicate,props.sourceKind==='sqlite'?'sqlite':'mysql')}catch{return false}}
 if(m.mongoFilter){try{const value=JSON.parse(m.mongoFilter);if(!value||typeof value!=='object'||Array.isArray(value))return false}catch{return false}}
 return true
})&&new Set(maps.value.map(m=>m.target.toLowerCase())).size===maps.value.length)
watch(valid,v=>emit('ready',v),{immediate:true})
watch(loading,v=>emit('busyChange',v))
watch(()=>maps.value.map(m=>m.source).join('\0'),()=>{if(!maps.value.some(m=>m.source===selected.value))selected.value=maps.value[0]?.source||''},{immediate:true})
watch([selected,()=>current.value?.target,()=>props.sourceId,()=>props.targetId,()=>props.sourceDb,()=>props.targetDb],()=>{
 sourceFields.value=[];targetFields.value=[];paramsDraft.value=JSON.stringify(current.value?.predicate?.parameters||[]);paramsValid.value=true;error.value=''
},{immediate:true})
watch(()=>props.allowFilters,value=>{if(!value){for(const m of maps.value){delete m.predicate;delete m.mongoFilter}paramsDraft.value='[]';paramsValid.value=true}})
async function loadFields(auto=false){
 const m=current.value;if(!m||loading.value||props.busy||redis.value)return
 if(!m.target){error.value=t('请选择目标对象');return}
 const identity=[props.sourceId,props.sourceDb,props.targetId,props.targetDb,m.source,m.target].join('\0')
 loading.value=true;error.value=''
 try{
  const from=await window.dbex.migrationFields(props.sourceId,props.sourceDb,m.source)
  const to=await window.dbex.migrationFields(props.targetId,props.targetDb,m.target)
  if(identity!==[props.sourceId,props.sourceDb,props.targetId,props.targetDb,current.value?.source,current.value?.target].join('\0'))return
  sourceFields.value=from;targetFields.value=to
  if(auto||!m.fields.length)m.fields=from.filter(f=>props.targetKind==='mongodb'||to.some(c=>c.name===f.name)).map(f=>({source:f.name,target:f.name,conversion:'auto'}))
 }catch(e){error.value=e instanceof Error?e.message:String(e)}finally{loading.value=false}
}
function changeTarget(value:string){const m=current.value;if(m&&m.target!==value){m.target=value;m.fields=[]}}
function setPredicate(text:string){
 const m=current.value;if(!m)return
 if(!text.trim()){delete m.predicate;paramsValid.value=true;return}
 let parameters=m.predicate?.parameters||[]
 try{const v=JSON.parse(paramsDraft.value);if(!Array.isArray(v))throw Error();parameters=v;paramsValid.value=true}catch{paramsValid.value=false}
 m.predicate={text,parameters}
}
function setParams(text:string){
 paramsDraft.value=text
 try{const value=JSON.parse(text);if(!Array.isArray(value))throw Error();paramsValid.value=true;if(current.value?.predicate)current.value.predicate.parameters=value}
 catch{paramsValid.value=false}
}
function setMongoFilter(value:string){if(current.value){if(value.trim())current.value.mongoFilter=value;else delete current.value.mongoFilter}}
const conversionLabels:Record<string,string>={auto:'自动（保留类型）',text:'文本',integer:'整数',decimal:'精确小数',double:'浮点数',boolean:'布尔值',binary:'二进制',ejson:'JSON / EJSON',objectId:'ObjectId'}
</script>
<template>
 <section class="migration-mapping">
  <div class="migration-map-head"><strong>{{t('对象及字段映射')}}</strong><span class="muted-text">{{maps.length}} {{t('对象')}}</span></div>
  <div v-if="current" class="migration-map-controls">
   <label class="field">{{t('源对象')}}<select v-model="selected" :disabled="busy||loading||!paramsValid" :aria-label="t('源对象')"><option v-for="m in maps" :key="m.source" :value="m.source">{{m.source}}{{m.target&&m.target!==m.source?' → '+m.target:''}}</option></select></label>
   <label class="field">{{t('目标对象')}}<input v-if="redis" :value="current.target" :disabled="busy||loading" :aria-label="t('目标对象')" @input="changeTarget(($event.target as HTMLInputElement).value)"/><select v-else :value="current.target" :disabled="busy||loading" :aria-label="t('目标对象')" @change="changeTarget(($event.target as HTMLSelectElement).value)"><option value="">{{t('请选择目标对象')}}</option><option v-for="name in targetObjects" :key="name" :value="name">{{name}}</option></select></label>
   <template v-if="!redis"><button class="btn secondary small" :disabled="busy||loading||!current.target" @click="loadFields()">{{t('加载字段')}}</button><button class="btn secondary small" :disabled="busy||loading||!current.target" @click="loadFields(true)">{{t('按同名字段匹配')}}</button><button class="btn secondary small" :disabled="busy||loading" @click="current.fields.push({source:'',target:'',conversion:'auto'})">{{t('添加字段映射')}}</button></template>
  </div>
  <p v-if="error" class="inline-message error" role="alert">{{localize(error)}}</p>
  <div v-if="current&&!redis" class="migration-map-table">
   <datalist id="migration-source-fields"><option v-for="f in sourceFields" :key="f.name" :value="f.name">{{f.type}}</option></datalist><datalist id="migration-target-fields"><option v-for="f in targetFields" :key="f.name" :value="f.name">{{f.type}}</option></datalist>
   <table><thead><tr><th>{{t('源字段')}}</th><th>{{t('目标字段')}}</th><th>{{t('类型转换')}}</th><th></th></tr></thead><tbody><tr v-for="(f,i) in current.fields" :key="i"><td><input v-model="f.source" list="migration-source-fields" :aria-label="t('源字段')+' '+(i+1)" :disabled="busy||loading"/><small>{{sourceFields.find(c=>c.name===f.source)?.type||''}}</small></td><td><input v-model="f.target" list="migration-target-fields" :aria-label="t('目标字段')+' '+(i+1)" :disabled="busy||loading"/><small>{{targetFields.find(c=>c.name===f.target)?.type||''}}</small></td><td><select v-model="f.conversion" :aria-label="t('类型转换')+' '+(i+1)" :disabled="busy||loading"><option v-for="c in migrationConversions" :key="c" :value="c">{{t(conversionLabels[c]||c)}}</option></select></td><td><button class="btn secondary small" :disabled="busy||loading" :aria-label="t('删除')+' '+(i+1)" @click="current.fields.splice(i,1)">×</button></td></tr></tbody></table>
  </div>
  <template v-if="current&&!redis&&allowFilters">
   <div v-if="relational" class="migration-map-filters"><label class="field">{{t('SQL 条件')}}<textarea :value="current.predicate?.text||''" :disabled="busy||loading" :aria-label="t('SQL 条件')" placeholder="id >= ? AND status = 'active'" rows="2" @input="setPredicate(($event.target as HTMLTextAreaElement).value)"/></label><label class="field">{{t('SQL 参数 JSON 数组')}}<textarea :value="paramsDraft" :disabled="busy||loading" :aria-label="t('SQL 参数 JSON 数组')" rows="2" @input="setParams(($event.target as HTMLTextAreaElement).value)"/></label></div>
   <label v-else-if="sourceKind==='mongodb'" class="field">{{t('MongoDB EJSON 筛选')}}<textarea :value="current.mongoFilter||''" :disabled="busy||loading" :aria-label="t('MongoDB EJSON 筛选')" rows="2" placeholder='{"status":"active"}' @input="setMongoFilter(($event.target as HTMLTextAreaElement).value)"/></label>
  </template>
  <p class="compact-help">{{t(redis?'映射 Key 名称，不修改原始数据类型和绝对过期时间。':'仅映射现有目标对象。自动模式不做可能丢失精度的转换；显式类型转换失败时停止当前对象。')}}</p>
 </section>
</template>
<style scoped>
.migration-mapping{border:1px solid var(--border);padding:10px;display:flex;flex-direction:column;gap:9px;flex:none}.migration-map-head,.migration-map-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.migration-map-head strong{flex:1}.migration-map-controls .field{display:flex;gap:6px;align-items:center}.migration-map-controls select{max-width:180px}.migration-map-table{max-height:240px;overflow:auto;border:1px solid var(--border)}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:5px 8px;text-align:start;border-bottom:1px solid var(--border-soft)}th{position:sticky;top:0;background:var(--panel-raised)}td input{width:100%;min-width:90px}td small{display:block;color:var(--muted);margin-top:3px}.migration-map-filters{display:grid;grid-template-columns:2fr 1fr;gap:8px}.migration-map-filters label,.migration-mapping>label{display:flex;flex-direction:column;gap:4px}.migration-mapping textarea{resize:vertical;font:12px ui-monospace,monospace}
</style>
