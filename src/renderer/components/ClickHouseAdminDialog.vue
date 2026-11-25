<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import type {ClickHouseChange,ClickHouseOperation,OperationResult,SessionInfo} from '../../shared/types'
const props=defineProps<{session:SessionInfo;database:string;entity:string;fields:Record<string,string>[];initialKind:ClickHouseChange['kind'];initialId?:string;execute:(op:ClickHouseOperation)=>Promise<OperationResult>}>()
const emit=defineEmits<{close:[];submitted:[OperationResult];busyChange:[boolean];cancel:[]}>()
const kind=ref(props.initialKind),field=ref(''),match=ref(''),column=ref(''),value=ref(''),id=ref(props.initialId||''),disk=ref(''),file=ref(''),newTable=ref('')
const busy=ref(false),error=ref(''),preview=ref<string>(),reviewed=ref(false),lightweight=ref(false)
const mutation=computed(()=>kind.value==='update'||kind.value==='delete')
const backup=computed(()=>kind.value==='backup'||kind.value==='restore')
const options: {kind:ClickHouseChange['kind'];label:string}[]=[
 {kind:'update',label:'ALTER UPDATE'},{kind:'delete',label:'ALTER DELETE'},{kind:'killMutation',label:'KILL MUTATION'},
 {kind:'detachPartition',label:'DETACH PARTITION'},{kind:'attachPartition',label:'ATTACH PARTITION'},{kind:'dropPartition',label:'DROP PARTITION'},
 {kind:'backup',label:'BACKUP TABLE'},{kind:'restore',label:'RESTORE TABLE'}
]
const editable=computed(()=>props.fields.filter(r=>r.is_in_primary_key==='0'&&r.is_in_sorting_key==='0'&&r.is_in_partition_key==='0'&&r.is_in_sampling_key==='0'&&!['MATERIALIZED','ALIAS','EPHEMERAL'].includes(r.default_kind||'')))
const change=computed<ClickHouseChange>(()=>{
 if(kind.value==='update')return {kind:'update',field:field.value,match:match.value,column:column.value,value:value.value,...(lightweight.value?{lightweight:true}:{})}
 if(kind.value==='delete')return {kind:'delete',field:field.value,match:match.value,...(lightweight.value?{lightweight:true}:{})}
 if(kind.value==='killMutation')return {kind:'killMutation',mutationId:id.value}
 if(kind.value==='backup')return {kind:'backup',disk:disk.value,file:file.value}
 if(kind.value==='restore')return {kind:'restore',disk:disk.value,file:file.value,newTable:newTable.value}
 return {kind:kind.value,partitionId:id.value}
})
const valid=computed(()=>mutation.value?!!field.value&&(kind.value!=='update'||!!column.value):backup.value?!!disk.value&&!!file.value&&(kind.value!=='restore'||!!newTable.value):!!id.value)
watch(change,()=>{preview.value=undefined;reviewed.value=false})
async function task(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;emit('busyChange',true);error.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false;emit('busyChange',false)}}
async function count(){const c=change.value;if(c.kind!=='update'&&c.kind!=='delete')return;await task(async()=>{preview.value=(await props.execute({action:'clickhouse.mutationPreview',database:props.database,entity:props.entity,change:c})).totalRows;reviewed.value=preview.value!==undefined})}
async function submit(){if(!valid.value||!props.session.writable||mutation.value&&!reviewed.value)return;await task(async()=>{const result=await props.execute({action:'clickhouse.change',database:props.database,entity:props.entity,change:change.value,confirmed:true});emit('submitted',result);emit('close')})}
</script>
<template>
 <div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" :aria-label="t('管理')">
  <header class="dialog-header"><h2>ClickHouse · {{ database }}.{{ entity }}</h2></header>
  <div class="dialog-body">
   <label class="field field-wide">{{t('操作：')}}<select v-model="kind" :disabled="busy"><option v-for="item in options" :key="item.kind" :value="item.kind">{{item.label}}</option></select></label>
   <template v-if="mutation">
    <label class="field field-wide"><span><input type="checkbox" v-model="lightweight" :disabled="busy"/> {{t('轻量级变更')}}</span><small class="helper">{{t('仅使用服务器已启用的轻量级功能，不自动修改表或服务器设置。')}}</small></label>
    <label class="field field-wide">WHERE · {{t('字段')}}<select v-model="field" :disabled="busy"><option value="">—</option><option v-for="f in fields" :key="f.name" :value="f.name">{{f.name}} · {{f.type}}</option></select></label>
    <label class="field field-wide">= {{t('字段值')}}<input v-model="match" :disabled="busy" maxlength="65536"/></label>
    <template v-if="kind==='update'">
     <label class="field field-wide">SET · {{t('字段')}}<select v-model="column" :disabled="busy"><option value="">—</option><option v-for="f in editable" :key="f.name" :value="f.name">{{f.name}} · {{f.type}}</option></select></label>
     <label class="field field-wide">= {{t('字段值')}}<input v-model="value" :disabled="busy" maxlength="65536"/></label>
    </template>
    <button class="btn secondary field-wide" :disabled="busy||!valid" @click="count">{{t('预览匹配记录数')}}</button>
    <p v-if="preview!==undefined" class="helper field-wide">{{t('匹配记录数（执行时可能变化）')}}: {{preview}}</p>
   </template>
   <template v-else-if="backup">
    <label class="field field-wide">{{t('服务器备份磁盘')}}<input v-model.trim="disk" :disabled="busy" placeholder="backups" maxlength="80"/></label>
    <label class="field field-wide">{{t('服务器备份名称')}}<input v-model.trim="file" :disabled="busy" placeholder="snapshot.zip" maxlength="160"/></label>
    <label v-if="kind==='restore'" class="field field-wide">{{t('恢复到新表')}}<input v-model.trim="newTable" :disabled="busy" maxlength="200"/></label>
    <p class="helper field-wide">{{t('备份位于服务器授权磁盘，不是本地文件。')}}</p>
   </template>
   <label v-else class="field field-wide">{{kind==='killMutation'?'Mutation ID':'Partition ID'}}<input v-model.trim="id" :disabled="busy" maxlength="160"/></label>
   <p class="helper field-wide">{{t('ClickHouse 操作已提交，请刷新任务状态；取消不回滚已完成的修改。')}}</p>
   <p v-if="error" role="alert" class="inline-message error field-wide">{{localize(error)}}</p>
  </div>
  <footer class="dialog-footer"><button v-if="busy" class="btn danger-text" @click="emit('cancel')">{{t('取消并断开')}}</button><button class="btn secondary" :disabled="busy" @click="emit('close')">{{t('取消')}}</button><button class="btn primary" :disabled="busy||!valid||!session.writable||(mutation&&!reviewed)" @click="submit">{{t('确认执行')}}</button></footer>
 </section></div>
</template>
