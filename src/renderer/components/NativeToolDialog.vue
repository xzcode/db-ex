<script setup lang="ts">
import {computed,onMounted,ref} from 'vue'
import {t,localize} from '../i18n'
import type {SessionInfo,ExplorerNode} from '../../shared/types'
import type {NativeToolTask} from '../../shared/preferences'
const props=defineProps<{session:SessionInfo;database:string;initialTask?:NativeToolTask;initialEntity?:string}>()
const emit=defineEmits<{close:[];session:[SessionInfo];disconnect:[]}>()
const tasks=computed<NativeToolTask[]>(()=>props.session.kind==='mysql'?['mysql-backup','mysql-restore']:props.session.kind==='mariadb'?['mariadb-backup','mariadb-restore']:['mongo-backup','mongo-restore','mongo-export','mongo-import'])
const names:Record<NativeToolTask,string>={'mysql-backup':'mysqldump','mysql-restore':'mysql','mariadb-backup':'mariadb-dump','mariadb-restore':'mariadb','mongo-backup':'mongodump','mongo-restore':'mongorestore','mongo-export':'mongoexport','mongo-import':'mongoimport'}
const labels:Record<NativeToolTask,string>={'mysql-backup':'备份数据库','mysql-restore':'恢复数据库','mariadb-backup':'备份数据库','mariadb-restore':'恢复数据库','mongo-backup':'备份数据库','mongo-restore':'恢复数据库','mongo-export':'导出数据','mongo-import':'导入数据'}
const task=ref<NativeToolTask>(props.initialTask&&tasks.value.includes(props.initialTask)?props.initialTask:tasks.value[0]!),entity=ref(props.initialEntity||''),objects=ref<ExplorerNode[]>([]),busy=ref(false),error=ref(''),notice=ref('')
const write=computed(()=>['mysql-restore','mariadb-restore','mongo-restore','mongo-import'].includes(task.value))
const needsEntity=computed(()=>['mongo-import','mongo-export'].includes(task.value)||!!props.initialEntity&&props.session.kind==='mongodb')
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn()}catch(reason){error.value=reason instanceof Error?reason.message:String(reason)}finally{busy.value=false}}
onMounted(()=>{if(props.session.kind==='mongodb'&&!props.initialEntity)void act(async()=>{objects.value=await window.dbex.children(props.session.id,props.database,'collections')})})
async function run(){await act(async()=>{if(await window.dbex.runNativeTool(props.session.id,task.value,props.database,needsEntity.value?entity.value:undefined))notice.value='操作已完成'})}
async function unlock(){await act(async()=>emit('session',await window.dbex.setWriteAccess(props.session.id,true)))}
async function cancel(){try{await window.dbex.cancel(props.session.id);emit('disconnect')}catch(reason){error.value=reason instanceof Error?reason.message:String(reason)}}
</script>
<template>
  <div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" :aria-label="t('外部工具')">
    <header class="dialog-header"><h2>{{ t('外部工具') }} · {{ database }}</h2><button class="icon-button" :disabled="busy" @click="emit('close')">×</button></header>
    <div class="dialog-body">
      <label class="field field-wide">{{ t('操作：') }}<select v-model="task" :disabled="busy"><option v-for="item in tasks" :key="item" :value="item">{{ t(labels[item]) }} · {{ names[item] }}</option></select></label>
      <label v-if="initialEntity" class="field field-wide">{{t('目标集合或视图')}}<input :value="initialEntity" readonly/></label><label v-else-if="needsEntity" class="field field-wide">{{ t('目标集合或视图') }}<select v-model="entity" :disabled="busy"><option value="">{{ t('未选择对象') }}</option><option v-for="item in objects" :key="item.id" :value="item.entity">{{ item.label }}</option></select></label>
      <p class="helper field-wide">{{ t('外部工具支持单节点连接；MongoDB 支持隧道内验证 TLS，MySQL 系列的隧道加 TLS 暂不支持。') }}</p>
      <p v-if="write" class="helper field-wide">{{ t('导入或恢复可能写入数据库，请确认文件来源及目标。') }}</p>
      <button v-if="write&&!session.writable" class="btn secondary field-wide" :disabled="busy" @click="unlock">{{ t('启用写入') }}</button>
      <p v-if="error" role="alert" class="inline-message error field-wide">{{ localize(error) }}</p>
      <p v-if="notice" role="status" class="inline-message notice field-wide">{{ t(notice) }}</p>
      <p v-if="busy" class="helper field-wide">{{ t('正在执行') }}</p>
    </div>
    <footer class="dialog-footer"><button v-if="busy" class="btn danger-text" @click="cancel">{{ t('取消并断开') }}</button><button class="btn secondary" :disabled="busy" @click="emit('close')">{{ t('关闭') }}</button><button class="btn primary" :disabled="busy||session.transaction||(write&&!session.writable)||(needsEntity&&!entity)" @click="run">{{ t('确认执行') }}</button></footer>
  </section></div>
</template>
