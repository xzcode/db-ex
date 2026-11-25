<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { t, localize } from '../i18n'
import type { DatabaseOperation, ExplorerNode, OperationResult, SessionInfo, SqlRow } from '../../shared/types'
import { validateDatabaseName, validateInitialCollection } from '../../shared/database-admin'
import { newBrowseFilter } from '../../shared/browse-filter'
import { sqlRowsFromFile, csvFromRows } from '../data-format'
type DatabaseActionMode = 'create'|'drop'|'search'|'import'|'export'|'schema'
const props=defineProps<{session:SessionInfo;database:string;mode:DatabaseActionMode;existing:string[]}>()
const emit=defineEmits<{close:[];changed:[database:string];select:[node:ExplorerNode];session:[session:SessionInfo]}>()
const mongo=computed(()=>props.session.kind==='mongodb')
const name=ref(''), initial=ref(''), confirmation=ref('')
const objects=ref<ExplorerNode[]>([]), search=ref(''), entity=ref('')
const busy=ref(false), error=ref(''), notice=ref('')
const writable=ref(props.session.writable)
const format=ref<'json'|'csv'>('json')
const fileName=ref('')
const importDocuments=ref<string[]>([])
const importRows=ref<SqlRow[]>([])
const needsWrite=computed(()=>['create','drop','import'].includes(props.mode))
const labels={create:'新建数据库',drop:'删除数据库',search:'查找数据库对象',import:'导入数据',export:'导出数据',schema:'导出结构脚本'} as const
const visibleObjects=computed(()=>objects.value.filter(item=>item.label.toLowerCase().includes(search.value.toLowerCase())))
const target=computed(()=>objects.value.find(item=>item.id===entity.value))
const importCount=computed(()=>mongo.value?importDocuments.value.length:importRows.value.length)
const canSubmit=computed(()=>!busy.value&&(!needsWrite.value||writable.value)&&(
 props.mode==='create'?!!name.value.trim()&&(!mongo.value||!!initial.value.trim()):
 props.mode==='drop'?confirmation.value===props.database:
 props.mode==='import'?!!target.value&&!target.value.readOnly&&importCount.value>0:!!target.value))
let disposed=false
function fail(reason:unknown){error.value=reason instanceof Error?reason.message:String(reason)}
async function action<T>(callback:()=>Promise<T>):Promise<T|undefined>{
 if(busy.value)return
 busy.value=true;error.value='';notice.value=''
 try{return await callback()}catch(reason){if(!disposed)fail(reason)}
 finally{busy.value=false}
}
async function loadObjects(){
 await action(async()=>{
   const values=mongo.value?await window.dbex.children(props.session.id,props.database,'collections'):await window.dbex.children(props.session.id,props.database)
   if(disposed)return
   const views=mongo.value&&props.mode!=='import'?await window.dbex.children(props.session.id,props.database,'views'):[]
   if(disposed)return
   objects.value=[...values,...views].filter(item=>item.entity&&(props.mode!=='import'||!item.readOnly))
 })
}
async function unlock(){
 await action(async()=>{const session=await window.dbex.setWriteAccess(props.session.id,true);writable.value=session.writable;emit('session',session)})
}
async function execute(operation:DatabaseOperation):Promise<OperationResult>{
 return window.dbex.execute(props.session.id,operation)
}
function cleanFile(value:string){return value.replace(/[^\p{L}\p{N}_.-]/gu,'_').slice(0,90)||'database'}
function safeDocuments(text:string):string[]{
 const raw:unknown=JSON.parse(text)
 const rows=Array.isArray(raw)?raw:[raw]
 if(!rows.length||rows.length>500)throw new Error('每批导入 1–500 条 EJSON 文档')
 function check(value:unknown,depth=0){
   if(depth>64)throw new Error('格式无效，请检查 JSON / BSON / SQL 输入')
   if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw new Error('数值超出安全范围，请使用 Extended JSON')
   if(value&&typeof value==='object')for(const child of Object.values(value))check(child,depth+1)
 }
 return rows.map(row=>{
   if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('格式无效，请检查 JSON / BSON / SQL 输入')
   check(row);return JSON.stringify(row)
 })
}
async function chooseFile(){
 await action(async()=>{
   const file=await window.dbex.importFile()
   if(!file||disposed)return
   importRows.value=[];importDocuments.value=[];fileName.value=''
   if(mongo.value)importDocuments.value=safeDocuments(file.text)
   else importRows.value=sqlRowsFromFile(file)
   fileName.value=file.name
 })
}
async function submit(){
 if(!canSubmit.value)return
 await action(async()=>{
   const kind=mongo.value?'mongodb':props.session.kind==='mariadb'?'mariadb':'mysql'
   const database=props.database
   if(props.mode==='create'){
     const db=validateDatabaseName(kind,name.value)
     if(props.existing.includes(db))throw new Error('数据库名称已存在')
     if(mongo.value)await execute({action:'mongo.createDatabase',database:db,initialCollection:validateInitialCollection(initial.value),confirmed:true})
     else await execute({action:'mysql.createDatabase',database:db,confirmed:true})
     if(!disposed)emit('changed',db)
     return
   }
   if(props.mode==='drop'){
     validateDatabaseName(kind,database)
     if(confirmation.value!==database)return
     await execute(mongo.value?{action:'mongo.dropDatabase',database,confirmed:true}:{action:'mysql.dropDatabase',database,confirmed:true})
     if(!disposed)emit('changed',database)
     return
   }
   if(!target.value?.entity)return
   const object=target.value, targetEntity={database,entity:object.entity!}
   if(props.mode==='import'){
     const response=await execute(mongo.value?{action:'mongo.insert',...targetEntity,documents:importDocuments.value,confirmed:true}:{action:'mysql.import',...targetEntity,rows:importRows.value,confirmed:true})
     if(!disposed){notice.value=response.message||'导入完成';importDocuments.value=[];importRows.value=[];fileName.value=''}
   }else if(props.mode==='export'){
     const response=await execute(mongo.value?{action:'mongo.find',...targetEntity,limit:500,sort:'{"_id":1}'}:{action:'mysql.browse',...targetEntity,filter:newBrowseFilter(),limit:500})
     if(disposed)return
     if(props.session.kind==='sqlite'&&response.rows.length&&!response.rawRows)throw new Error('SQLite 无法无损导出当前结果；请使用数据库备份。')
     if(response.truncated||response.nextOffset!==undefined||(mongo.value&&response.documents?.length!==response.rows.length))throw new Error('对象数据超出完整导出上限，请使用分页导出或专用数据库工具。')
     const content=format.value==='json'?(mongo.value?'['+(response.documents||[]).join(',\n')+']':JSON.stringify(response.rawRows||response.rows,null,2)):csvFromRows(response.columns,response.rawRows||response.rows)
     if(await window.dbex.exportFile(cleanFile(database)+'-'+cleanFile(object.entity!)+'.'+format.value,content,format.value))notice.value='导出完成'
   }else if(props.mode==='schema'){
     const response=await execute(mongo.value?{action:'mongo.inspect',...targetEntity}:{action:'mysql.inspect',...targetEntity})
     if(disposed)return
     const definition=response.inspection?.definition
     if(!definition)throw new Error('DDL 不可用或超出读取上限。')
     const note=response.inspection?.definitionNote
     // The file is a single selected object's structure script, never a
     // claim of a full database backup. Preserve any incompleteness notice.
     const prefix=mongo.value?'// ': '-- '
     const text=(note?prefix+t(note).replace(/[\r\n]+/g,' ')+'\n\n':'')+definition
     if(await window.dbex.exportFile(cleanFile(database)+'-'+cleanFile(object.entity!)+(mongo.value?'.js':'.sql'),text,'text'))notice.value=note||'语句已导出'
   }
 })
}
onMounted(()=>{if(!['create','drop'].includes(props.mode))void loadObjects()})
onBeforeUnmount(()=>{disposed=true})
</script>
<template>
  <div class="modal-backdrop" @keydown.esc.stop="!busy&&emit('close')">
    <section class="dialog database-action-dialog" role="dialog" aria-modal="true" :aria-label="t(labels[mode])">
      <header class="dialog-header"><div><span class="eyebrow">{{ session.name }}<template v-if="mode!=='create'"> / {{ database }}</template></span><h2>{{ t(labels[mode]) }}</h2></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy" @click="emit('close')">×</button></header>
      <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div><div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
      <div v-if="needsWrite&&!writable" class="editor-toolbar"><span class="muted-text">{{ t('当前会话只读，请先点击右上角“启用写入”。') }}</span><button class="btn secondary small" :disabled="busy" @click="unlock">{{ t('解锁此会话') }}</button></div>
      <div class="database-action-body">
        <template v-if="mode==='create'">
          <label class="field">{{ t('数据库名称') }}<input v-model="name" :aria-label="t('数据库名称')" :disabled="busy" maxlength="64" autofocus /></label>
          <label v-if="mongo" class="field">{{ t('初始集合') }}<input v-model="initial" :aria-label="t('初始集合')" :disabled="busy" maxlength="200" placeholder="items" /></label>
          <p v-if="mongo" class="helper">{{ t('MongoDB 需要创建至少一个集合才能持久化数据库。') }}</p>
        </template>
        <template v-else-if="mode==='drop'">
          <p class="inline-message error">{{ t('删除数据库会永久移除其中的全部数据及对象。') }}</p>
          <label class="field">{{ t('输入数据库名称以确认删除') }}<input v-model="confirmation" :aria-label="t('输入数据库名称以确认删除')" :placeholder="database" :disabled="busy" spellcheck="false" /></label>
        </template>
        <template v-else-if="mode==='search'">
          <input v-model="search" :aria-label="t('查找数据库对象')" :placeholder="t('查找数据库对象')" autofocus />
          <p class="helper">{{ t('仅查找可见对象名称，不扫描记录内容。') }}</p>
          <div class="database-object-results"><button v-for="item in visibleObjects" :key="item.id" type="button" class="resource-node" :disabled="busy" @click="emit('select',item)"><span>{{ item.kind==='view'?'◉':'▦' }}</span><span class="ellipsis">{{ item.label }}</span><span class="toolbar-spacer"></span><small>{{ t(item.kind==='view'?'视图':mongo?'集合':'表') }}</small></button><p v-if="!visibleObjects.length&&!busy" class="helper">{{ t('无可见对象') }}</p></div>
        </template>
        <template v-else>
          <label class="field">{{ t(mongo?'目标集合或视图':'目标表或视图') }}<select v-model="entity" :aria-label="t(mongo?'目标集合或视图':'目标表或视图')" :disabled="busy"><option value="">{{ t('未选择对象') }}</option><option v-for="item in objects" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
          <template v-if="mode==='import'"><div class="row-between"><button class="btn secondary" :disabled="busy" @click="chooseFile">{{ t('选择数据文件') }}</button><span class="ellipsis">{{ fileName }}</span></div><p class="helper">{{ t(mongo?'每批导入 1–500 条 EJSON 文档':'每批导入需要 1–500 条记录') }}</p><p v-if="importCount">{{ importCount }} {{ t('条记录') }}</p></template>
          <template v-else-if="mode==='export'"><label class="field">{{ t('格式') }}<select v-model="format" :disabled="busy"><option value="json">{{ mongo?'Extended JSON':'JSON' }}</option><option value="csv">CSV</option></select></label><p class="helper">{{ t('完整导出限单个对象 500 条及现有读取大小上限，超限时不会保存不完整文件。') }}</p></template>
          <p v-else class="helper">{{ t('导出选中对象的结构语句，不包含数据，也不会执行语句。') }}</p>
        </template>
        <p v-if="busy" class="compact-help">{{ t('正在执行') }}</p>
      </div>
      <footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="emit('close')">{{ t(mode==='search'?'关闭':'取消') }}</button><button v-if="mode!=='search'" :class="['btn',mode==='drop'?'danger':'primary']" :disabled="!canSubmit" @click="submit">{{ t(mode==='create'?'新建':mode==='drop'?'删除':mode==='import'?'导入':'导出') }}</button></footer>
    </section>
  </div>
</template>
