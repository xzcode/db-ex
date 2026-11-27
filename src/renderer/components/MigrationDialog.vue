<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {t,localize} from '../i18n'
import {migrationSupported,migrationPairSupported,migrationPolicies,migrationConditions,migrationPolicyLabel,type MigrationCondition,type MigrationPolicy,type MigrationCatalog,type MigrationJob,type MigrationMode,type MigrationPlan,type MigrationRequest} from '../../shared/migration'
import type {SavedConnection} from '../../shared/types'
const props=defineProps<{connections:SavedConnection[];initialMode:MigrationMode;sourceId?:string;database?:string;initialObjects?:string[]}>()
const emit=defineEmits<{close:[]}>()
const profiles=computed(()=>props.connections.filter(c=>!c.locked&&migrationSupported(c.kind)))
const sourceId=ref(props.sourceId&&profiles.value.some(c=>c.id===props.sourceId)?props.sourceId:'')
const targetId=ref(''),sourceDb=ref(props.database||''),targetDb=ref('')
const mode=ref<MigrationMode>(props.initialMode)
const policy=ref<MigrationPolicy>('append'),conditionEnabled=ref(false)
const condition=ref<MigrationCondition>({field:'',operator:'eq',type:'String',value:''})
const historyId=ref('')
const conditionOperators: {value:MigrationCondition['operator'];label:string}[]=[{value:'eq',label:'='},{value:'ne',label:'≠'},{value:'gt',label:'>'},{value:'gte',label:'≥'},{value:'lt',label:'<'},{value:'lte',label:'≤'},{value:'null',label:'IS NULL'},{value:'notNull',label:'IS NOT NULL'}]

const sourceKind=computed(()=>profiles.value.find(c=>c.id===sourceId.value)?.kind)
const targetProfiles=computed(()=>profiles.value.filter(c=>!sourceKind.value||migrationPairSupported(sourceKind.value,c.kind)))
const sourceProfiles=computed(()=>profiles.value.filter(c=>mode.value!=='schema'||c.kind!=='redis'))
const policies=computed(()=>sourceKind.value?migrationPolicies(sourceKind.value):['append'] as MigrationPolicy[])
const conditionTypes=computed<MigrationCondition['type'][]>(()=>sourceKind.value==='mongodb'?['String','Long','Decimal128','Double','Boolean','ObjectId']:['String','Long','Decimal128','Double','Boolean'])
const transactional=computed(()=>['mysql','mariadb','sqlite'].includes(sourceKind.value||''))
const nonSql=computed(()=>sourceKind.value==='mongodb'||sourceKind.value==='redis')
const sourceCatalog=ref<MigrationCatalog>(),targetCatalog=ref<MigrationCatalog>()
if(sourceKind.value==='redis')mode.value='data'
const allSchema=ref(mode.value==='schema'&&!props.initialObjects?.length),objects=ref<string[]>(props.initialObjects?.slice(0,100)||[])
const conditionAllowed=computed(()=>!!sourceKind.value&&migrationConditions(sourceKind.value)&&policy.value!=='replace'&&mode.value!=='schema'&&objects.value.length===1)
const plan=ref<MigrationPlan>(),selected=ref<string[]>([]),detail=ref('')
const busy=ref(false),error=ref(''),jobs=ref<MigrationJob[]>([]),history=ref(false)
const active=computed(()=>jobs.value.find(j=>j.state==='running'))
const displayedJob=computed(()=>active.value||jobs.value.find(j=>j.id===historyId.value)||jobs.value[0])
const same=computed(()=>sourceId.value===targetId.value&&sourceDb.value===targetDb.value)
const available=computed(()=>sourceCatalog.value?.objects||[])
const eligible=computed(()=>available.value.filter(o=>mode.value==='schema'||sourceKind.value==='redis'||sourceKind.value==='mongodb'&&o.type==='collection'||sourceKind.value==='sqlite'&&o.type==='BASE TABLE'||sourceKind.value==='clickhouse'&&o.engine==='MergeTree'||o.type==='BASE TABLE'&&o.engine?.toLowerCase()==='innodb'))
const allSteps=computed(()=>plan.value?.steps.filter(s=>s.executable)||[])
const sqlPreview=computed(()=>plan.value?.steps.filter(s=>s.executable&&selected.value.includes(s.id)).flatMap(s=>s.sql).map(sql=>sql+';').join('\n\n')||'')
const canCompare=computed(()=>!!sourceKind.value&&targetProfiles.value.some(p=>p.id===targetId.value)&&!busy.value&&!active.value&&!!sourceId.value&&!!targetId.value&&!!sourceDb.value&&!!targetDb.value&&!same.value&&(!conditionEnabled.value||conditionAllowed.value&&!!condition.value.field.trim())&&(mode.value==='schema'&&allSchema.value||objects.value.length>0))
const modeLabels:Record<MigrationMode,string>={schema:'仅结构',data:'仅数据','structure-data':'结构和数据'}
const actionLabels:Record<string,string>={create:'创建',alter:'修改',copy:'复制数据',same:'相同','target-only':'仅目标存在',review:'人工审核'}
function changeLabel(value:string){
 const prefixes:Record<string,string>={'ADD COLUMN ':'新增字段 {0}','TARGET ONLY COLUMN ':'仅目标存在字段 {0}','MODIFY COLUMN ':'修改字段 {0}','ADD INDEX ':'新增索引 {0}','TARGET ONLY INDEX ':'仅目标存在索引 {0}','MODIFY INDEX ':'修改索引 {0}'}
 for(const [prefix,key] of Object.entries(prefixes))if(value.startsWith(prefix))return t(key,[value.slice(prefix.length)])
 const exact:Record<string,string>={'COLUMN ORDER':'字段顺序变化','TABLE OPTIONS':'表属性变化','CONSTRAINTS / SPECIAL DEFINITION':'约束或特殊定义变化','TARGET ONLY OBJECT':'仅目标存在','MISSING TARGET OBJECT':'目标对象不存在','UNSUPPORTED DEFINITION — MANUAL REVIEW':'复杂结构需要人工审核','OBJECT TYPE DIFFERS':'对象类型不同','SPECIAL OBJECT / CONSTRAINT / TRIGGER — MANUAL REVIEW':'复杂结构需要人工审核','COLUMN DEFINITION OR TABLE OPTIONS DIFFER':'字段定义或表属性不同','APPEND DATA — STOP ON CONFLICT':'追加数据，冲突时停止','MANUAL REVIEW':'人工审核','UPSERT MATCHING PRIMARY KEY':'按主键插入或更新','REPLACE TABLE DATA IN TRANSACTION':'清空目标表后传输','FILTER SOURCE RECORDS':'仅传输符合条件的源记录','UPSERT REQUIRES MATCHING PRIMARY KEY':'插入更新需要相同且受支持的主键','FILTER FIELD OR TYPE UNSUPPORTED':'筛选字段或类型不受支持','COPY KEY WITH TTL — REPLACE':'覆盖同名 Key 并保留 TTL','APPEND DATA — NONTRANSACTIONAL':'追加数据，非事务写入','TARGET KEY EXISTS — MANUAL REVIEW':'目标 Key 已存在','COPY KEY WITH TTL — NO REPLACE':'复制 Key 和 TTL，不覆盖'}
 return t(exact[value]||value)
}
const phaseLabels:Record<string,string>={checking:'检查结构',structure:'结构变更',copying:'正在传输',committing:'提交事务',finished:'已结束'}
const stateLabels:Record<string,string>={running:'正在执行',completed:'操作已完成',failed:'失败',cancelled:'已取消',uncertain:'结果不确定'}
function invalidate(){plan.value=undefined;selected.value=[];detail.value=''}
watch([sourceId,targetId,sourceDb,targetDb,mode,allSchema,objects,policy,conditionEnabled,condition],invalidate,{deep:true})
watch([sourceKind,mode],()=>{if(!policies.value.includes(policy.value)||mode.value==='schema')policy.value='append';if(!conditionTypes.value.includes(condition.value.type))condition.value.type='String'})
watch(conditionAllowed,allowed=>{if(!allowed)conditionEnabled.value=false})
watch(policy,()=>{if(policy.value==='replace')conditionEnabled.value=false})

async function act(fn:()=>Promise<void>){
 if(busy.value||active.value)return
 busy.value=true;error.value=''
 try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}
}
async function catalog(which:'source'|'target',database?:string){
 const id=which==='source'?sourceId.value:targetId.value
 if(!id)return
 const result=await window.dbex.migrationCatalog(id,database||undefined)
 if(which==='source'){
  sourceCatalog.value=result
  if(database){objects.value=objects.value.filter(name=>result.objects?.some(o=>o.name===name))}
  else{sourceDb.value=result.databases.includes(sourceDb.value)?sourceDb.value:'';if(sourceDb.value)await catalog('source',sourceDb.value)}
 }else{
  targetCatalog.value=result;targetDb.value=result.databases.includes(targetDb.value)?targetDb.value:''
 }
}
function changeProfile(which:'source'|'target'){
 if(which==='source'){sourceDb.value='';sourceCatalog.value=undefined;objects.value=[];if(sourceKind.value==='redis')mode.value='data';if(!targetProfiles.value.some(p=>p.id===targetId.value)){targetId.value='';targetDb.value='';targetCatalog.value=undefined}}
 else{targetDb.value='';targetCatalog.value=undefined}
 invalidate();void act(()=>catalog(which))
}
function changeSourceDatabase(){objects.value=[];invalidate();void act(()=>catalog('source',sourceDb.value))}
function toggleObjects(all:boolean){objects.value=all?eligible.value.slice(0,100).map(o=>o.name):[]}
function toggleSteps(all:boolean){selected.value=all?allSteps.value.map(s=>s.id):[]}
async function compare(){
 await act(async()=>{
  invalidate()
  const request:MigrationRequest={source:{connectionId:sourceId.value,database:sourceDb.value},target:{connectionId:targetId.value,database:targetDb.value},mode:mode.value,...(mode.value==='schema'&&allSchema.value?{}:{objects:[...objects.value]}),...(mode.value!=='schema'&&policy.value!=='append'?{policy:policy.value}:{}),...(conditionEnabled.value&&conditionAllowed.value?{condition:{...condition.value}}:{})}
  plan.value=await window.dbex.previewMigration(request)
  selected.value=policy.value==='append'?plan.value.steps.filter(s=>s.executable).map(s=>s.id):[]
 })
}
async function execute(){
 await act(async()=>{
  if(!plan.value||!selected.value.length)return
  const job=await window.dbex.runMigration(plan.value.id,selected.value)
  jobs.value=[job,...jobs.value.filter(j=>j.id!==job.id)].slice(0,20)
  historyId.value=job.id;history.value=true;invalidate()
 })
}
async function exportSql(){await act(async()=>{if(sqlPreview.value)await window.dbex.exportFile('db-ex-structure-sync.sql',sqlPreview.value,'text')})}
async function removeHistory(){if(!displayedJob.value||displayedJob.value.state==='running')return;await act(async()=>{await window.dbex.removeMigrationHistory(displayedJob.value!.id);await poll()})}
async function cancel(){if(!active.value)return;try{await window.dbex.cancelMigration(active.value.id)}catch(e){error.value=e instanceof Error?e.message:String(e)}}
let polling=false,timer:ReturnType<typeof setInterval>|undefined,closed=false
async function poll(){
 if(polling||closed)return
 polling=true
 try{const result=await window.dbex.listMigrationJobs();if(!closed)jobs.value=result}
 catch(e){if(!closed)error.value=e instanceof Error?e.message:String(e)}
 finally{polling=false}
}
onMounted(async()=>{
 await poll()
 if(active.value){history.value=true}
 else if(sourceId.value)await act(()=>catalog('source'))
 if(!closed)timer=setInterval(()=>{void poll()},700)
})
onBeforeUnmount(()=>{closed=true;if(timer)clearInterval(timer)})
function setMode(value:MigrationMode){mode.value=sourceKind.value==='redis'&&value!=='schema'?'data':value;allSchema.value=value==='schema';objects.value=[];if(value==='schema'&&sourceKind.value==='redis'){sourceId.value='';sourceDb.value='';sourceCatalog.value=undefined;targetId.value='';targetDb.value='';targetCatalog.value=undefined}}
function saveTemplate(){
 try{localStorage.setItem('dbex.migration.last-template.v1',JSON.stringify({source:{connectionId:sourceId.value,database:sourceDb.value},target:{connectionId:targetId.value,database:targetDb.value},mode:mode.value,objects:objects.value,allSchema:allSchema.value,policy:policy.value}))}
 catch{error.value='MIGRATION_INPUT: 迁移参数无效'}
}
async function loadTemplate(){
 await act(async()=>{
  const saved=JSON.parse(localStorage.getItem('dbex.migration.last-template.v1')||'null')
  if(!saved||!profiles.value.some(c=>c.id===saved.source?.connectionId)||!profiles.value.some(c=>c.id===saved.target?.connectionId)||!['schema','data','structure-data'].includes(saved.mode))throw new Error('MIGRATION_INPUT: 迁移参数无效')
  sourceId.value=saved.source.connectionId;sourceDb.value=saved.source.database
  targetId.value=saved.target.connectionId;targetDb.value=saved.target.database
  mode.value=saved.mode;allSchema.value=mode.value==='schema'&&saved.allSchema===true
  policy.value=policies.value.includes(saved.policy)?saved.policy:'append';conditionEnabled.value=false
  sourceCatalog.value=undefined;targetCatalog.value=undefined;objects.value=[]
  await catalog('source');await catalog('target')
  objects.value=Array.isArray(saved.objects)?saved.objects.filter((name:unknown)=>typeof name==='string'&&eligible.value.some(o=>o.name===name)).slice(0,100):[]
 })
}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog migration-dialog" role="dialog" aria-modal="true" :aria-label="t('数据库同步与迁移')">
  <header class="dialog-header"><h2>{{ t('数据库同步与迁移') }}</h2><button class="icon-button" :aria-label="t('关闭')" :disabled="busy" @click="emit('close')">×</button></header>
  <nav class="migration-tabs">
   <button :class="{active:!history&&mode==='schema'}" :disabled="busy||!!active" @click="history=false;setMode('schema')">{{t('结构同步')}}</button>
   <button :class="{active:!history&&mode!=='schema'}" :disabled="busy||!!active" @click="history=false;setMode('structure-data')">{{t('数据传输')}}</button>
   <button :class="{active:history}" @click="history=true">{{t('任务记录')}}<span v-if="active"> · {{t('正在执行')}}</span></button>
  </nav>
  <div v-if="!history" class="migration-body">
   <div class="migration-endpoints">
    <section v-for="which in (['source','target'] as const)" :key="which" class="migration-endpoint">
     <h3>{{t(which==='source'?'源数据库':'目标数据库')}}</h3>
     <label class="field">{{t('连接名称')}}
      <select v-if="which==='source'" v-model="sourceId" :disabled="busy" @change="changeProfile('source')"><option value="">{{t('请选择连接')}}</option><option v-for="item in sourceProfiles" :key="item.id" :value="item.id">{{item.name}} · {{item.kind}} · {{item.host}}:{{item.port}}</option></select>
      <select v-else v-model="targetId" :disabled="busy" @change="changeProfile('target')"><option value="">{{t('请选择连接')}}</option><option v-for="item in targetProfiles" :key="item.id" :value="item.id">{{item.name}} · {{item.kind}} · {{item.host}}:{{item.port}}</option></select>
     </label>
     <div class="migration-database-row">
      <label class="field">{{t('数据库')}}
       <select v-if="which==='source'" v-model="sourceDb" :disabled="busy||!sourceCatalog" @change="changeSourceDatabase"><option value="">{{t('请选择数据库')}}</option><option v-for="db in sourceCatalog?.databases||[]" :key="db" :value="db">{{db}}</option></select>
       <select v-else v-model="targetDb" :disabled="busy||!targetCatalog"><option value="">{{t('请选择数据库')}}</option><option v-for="db in targetCatalog?.databases||[]" :key="db" :value="db">{{db}}</option></select>
      </label>
      <button class="btn secondary" :disabled="busy||!(which==='source'?sourceId:targetId)" @click="act(()=>catalog(which))">{{t('刷新')}}</button>
     </div>
    </section>
   </div>
   <div class="migration-options">
    <label v-if="mode!=='schema'" class="field">{{t('传输模式')}}<select v-model="mode" :disabled="busy"><option v-if="sourceKind!=='redis'" value="structure-data">{{t(modeLabels['structure-data'])}}</option><option value="data">{{t(modeLabels.data)}}</option></select></label>
    <label v-else class="migration-check"><input v-model="allSchema" type="checkbox" :disabled="busy"/>{{t('比较全部对象（包含仅目标存在的对象）')}}</label>
    <label v-if="mode!=='schema'" class="field">{{t('写入模式')}}<select v-model="policy" :disabled="busy" :aria-label="t('写入模式')"><option v-for="p in policies" :key="p" :value="p">{{t(migrationPolicyLabel(p,sourceKind))}}</option></select></label>
    <span class="migration-hint">{{t('支持六种数据库的基础迁移；复杂对象需要人工审核。')}}</span>
   </div>
   <div v-if="mode!=='schema'||!allSchema" class="migration-object-picker">
    <div class="migration-section-heading"><strong>{{t('选择源对象')}} · {{objects.length}} / {{eligible.length}}</strong><button class="btn secondary" :disabled="busy||!eligible.length" @click="toggleObjects(objects.length===0)">{{t(objects.length?'取消全选':'全选')}}</button></div>
    <div class="migration-object-list">
     <label v-for="object in eligible" :key="object.name" class="migration-check"><input v-model="objects" :value="object.name" type="checkbox" :disabled="busy||(!objects.includes(object.name)&&objects.length>=100)"/><span>{{object.name}}</span><small>{{object.engine||object.type}}</small></label>
     <span v-if="!eligible.length" class="migration-hint">{{t('未选择对象')}}</span>
    </div>
   </div>
   <div v-if="conditionAllowed" class="migration-condition">
    <label class="migration-check"><input v-model="conditionEnabled" type="checkbox" :disabled="busy"/>{{t('源记录条件')}}</label>
    <template v-if="conditionEnabled"><input v-model="condition.field" :disabled="busy" :aria-label="t('筛选字段')" :placeholder="t('筛选字段')" maxlength="200"/>
    <select v-model="condition.operator" :disabled="busy" :aria-label="t('比较运算符')"><option v-for="op in conditionOperators" :key="op.value" :value="op.value">{{op.label}}</option></select>
    <select v-model="condition.type" :disabled="busy" :aria-label="t('数据类型')"><option v-for="type in conditionTypes" :key="type" :value="type">{{type}}</option></select>
    <input v-if="condition.operator!=='null'&&condition.operator!=='notNull'" v-model="condition.value" :disabled="busy" :aria-label="t('筛选值')" :placeholder="t('筛选值')" maxlength="4096"/></template>
   </div>
   <p v-if="mode!=='schema'&&policy!=='append'" class="inline-message error">{{t(policy==='replace'?'将清空已选目标表的数据。请先备份，比较后手动勾选要执行的对象。':'将覆盖匹配主键或同名 Key 的数据。比较后手动勾选要执行的对象。')}}</p>
   <p v-if="same&&sourceDb" class="inline-message error">{{t('MIGRATION_SAME_TARGET: 源与目标不能是同一数据库')}}</p>
   <div class="migration-section-heading"><strong>{{t('结构差异与传输计划')}}</strong><span class="migration-hint">{{plan?plan.steps.length+' · '+selected.length+' '+t('已选择'):''}}</span><button class="btn secondary" :disabled="!canCompare" @click="compare">{{t('比较 / 生成计划')}}</button></div>
   <template v-if="plan">
    <div class="migration-plan-list">
     <table><thead><tr><th><input type="checkbox" :checked="allSteps.length>0&&selected.length===allSteps.length" :disabled="!allSteps.length||busy" :aria-label="t('全选')" @change="toggleSteps(($event.target as HTMLInputElement).checked)"/></th><th>{{t('对象')}}</th><th>{{t('操作：')}}</th><th>{{t('差异')}}</th></tr></thead>
      <tbody><tr v-for="step in plan.steps" :key="step.id" :class="{selected:detail===step.id}" @click="detail=step.id"><td><input v-model="selected" type="checkbox" :value="step.id" :disabled="!step.executable||busy" @click.stop/></td><td>{{step.name}}</td><td :class="step.action==='review'||step.action==='target-only'?'migration-warning':''">{{t(actionLabels[step.action]||step.action)}}</td><td>{{step.changes.map(changeLabel).join('; ')||'—'}}</td></tr></tbody>
     </table>
    </div>
    <label v-if="!nonSql" class="field migration-script">{{t('部署脚本预览')}}<textarea readonly :value="sqlPreview" spellcheck="false"/></label>
   </template>
   <div v-else class="migration-empty">{{t('先选择源数据库和目标数据库，再生成计划。')}}</div>
   <p v-if="mode!=='schema'" class="migration-hint">{{t(policy==='append'?(transactional?'追加写入，冲突时停止并回滚当前表；已提交的表不会自动回滚。':'追加写入，不覆盖已有数据；已确认或部分写入的数据不会自动回滚。'):(transactional?'当前表的写入在事务中完成；已提交的表不会自动回滚。':'已确认或部分写入的数据不会自动回滚。'))}}</p>
  </div>
  <div v-else class="migration-body migration-history">
   <template v-if="displayedJob">
    <section class="migration-progress">
     <div class="migration-section-heading"><strong>{{t(stateLabels[displayedJob.state]||displayedJob.state)}}</strong><span>{{displayedJob.completed.length}} / {{displayedJob.total}} {{t('对象')}}</span></div>
     <progress :value="displayedJob.completed.length" :max="displayedJob.total"/>
     <p>{{t(phaseLabels[displayedJob.phase]||displayedJob.phase)}} · {{displayedJob.current||'—'}}</p>
     <p v-if="displayedJob.sourceLabel">{{displayedJob.sourceLabel}} → {{displayedJob.targetLabel}}</p>
     <p v-if="displayedJob.policy">{{t('写入模式')}}：{{t(migrationPolicyLabel(displayedJob.policy,displayedJob.sourceKind))}}</p>
     <div class="migration-metrics"><div><small>{{t('已读取行数')}}</small><strong>{{displayedJob.rowsKnown===false?'—':displayedJob.rowsRead.toLocaleString()}}</strong></div><div><small>{{t('已提交行数')}}</small><strong>{{displayedJob.rowsKnown===false?'—':displayedJob.rowsCommitted.toLocaleString()}}</strong></div><div><small>{{t('未提交行数')}}</small><strong>{{displayedJob.rowsKnown===false?'—':displayedJob.rowsPending.toLocaleString()}}</strong></div><div><small>{{t('读取数据量')}}</small><strong>{{(displayedJob.bytesRead/1048576).toFixed(2)}} MiB</strong></div></div>
     <p v-if="displayedJob.error" class="inline-message error">{{localize(displayedJob.error)}}</p>
     <p v-if="displayedJob.created.length">{{t('已执行结构变更')}}：{{displayedJob.created.join(', ')}}</p>
     <p>{{t('已完成对象')}}：{{displayedJob.completed.join(', ')||'—'}}</p>
    </section>
    <table class="migration-history-table"><thead><tr><th>{{t('时间')}}</th><th>{{t('状态')}}</th><th>{{t('对象')}}</th><th>{{t('已提交行数')}}</th></tr></thead><tbody><tr v-for="job in jobs" :key="job.id" :class="{selected:displayedJob?.id===job.id}" tabindex="0" @click="historyId=job.id" @keydown.enter="historyId=job.id"><td>{{new Date(job.startedAt).toLocaleString()}}</td><td>{{t(stateLabels[job.state]||job.state)}}</td><td>{{job.completed.length}} / {{job.total}}</td><td>{{job.rowsKnown===false?'—':job.rowsCommitted.toLocaleString()}}</td></tr></tbody></table>
   </template>
   <div v-else class="migration-empty">{{t('暂无迁移任务')}}</div>
  </div>
  <p v-if="error" role="alert" class="inline-message error migration-error">{{localize(error)}}</p>
  <footer class="dialog-footer migration-footer">
   <template v-if="!history"><button class="btn secondary" :disabled="busy||!sourceDb||!targetDb" @click="saveTemplate">{{t('保存配置')}}</button><button class="btn secondary" :disabled="busy" @click="loadTemplate">{{t('载入配置')}}</button><button class="btn secondary" :disabled="busy||!sqlPreview" @click="exportSql">{{t('导出结构脚本')}}</button></template>
   <button v-if="history&&!active&&displayedJob" class="btn secondary" :disabled="busy" @click="removeHistory">{{t('删除任务记录')}}</button>
   <button v-if="history&&active" class="btn danger-text" @click="cancel">{{t('取消任务')}}</button>
   <span class="migration-spacer"/>
   <button class="btn secondary" :disabled="busy" @click="emit('close')">{{t(active?'收起':'关闭')}}</button>
   <button v-if="!history" class="btn primary" :disabled="busy||!selected.length||!plan" @click="execute">{{t('确认执行')}}</button>
   <button v-else-if="!active" class="btn primary" @click="history=false">{{t('新建迁移')}}</button>
  </footer>
 </section></div></Teleport>
</template>
<style scoped>
.migration-dialog{width:min(1120px,calc(100vw - 36px));max-width:none;height:min(790px,calc(100vh - 36px));display:flex;flex-direction:column}
.migration-tabs{display:flex;gap:0;padding:0 16px;border-bottom:1px solid var(--border);flex:none}
.migration-tabs button{border:0;border-bottom:2px solid transparent;background:none;padding:12px 20px;color:var(--muted);border-radius:0}
.migration-tabs button.active{color:var(--text);border-bottom-color:var(--accent)}
.migration-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.migration-endpoints{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.migration-endpoint{border:1px solid var(--border);padding:12px;background:var(--panel-raised);min-width:0}
.migration-endpoint h3{font-size:13px;margin:0 0 10px;font-weight:600}
.migration-endpoint .field{display:flex;flex-direction:column;gap:5px;margin-bottom:8px;min-width:0}
.migration-database-row{display:flex;gap:8px;align-items:flex-end}
.migration-database-row .field{flex:1;margin:0}
.migration-options{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.migration-options .field{display:flex;align-items:center;gap:8px;white-space:nowrap}
.migration-check{display:flex;align-items:center;gap:7px;min-width:0}
.migration-check input{flex:none}
.migration-hint{font-size:12px;color:var(--muted)}
.migration-section-heading{display:flex;align-items:center;gap:10px;flex:none}
.migration-section-heading strong{flex:1}
.migration-condition{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none}.migration-condition input:not([type=checkbox]){min-width:110px;flex:1}.migration-condition select{min-width:72px}
.migration-object-picker{border:1px solid var(--border);padding:9px;flex:none}
.migration-object-list{max-height:120px;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:5px 18px;padding-top:8px}
.migration-object-list .migration-check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.migration-object-list small{margin-inline-start:auto;color:var(--muted)}
.migration-plan-list{border:1px solid var(--border);overflow:auto;min-height:90px;max-height:240px;flex:1}
table{width:100%;border-collapse:collapse;font-size:12px;text-align:start}
th,td{padding:7px 10px;border-bottom:1px solid var(--border-soft);text-align:start;overflow-wrap:anywhere}
th{position:sticky;top:0;background:var(--panel-raised);font-weight:600}
.migration-plan-list td:first-child{width:30px}
tr.selected{background:var(--selected)}
.migration-warning{color:var(--warning)}
.migration-script{display:flex;flex-direction:column;gap:6px;flex:1;min-height:100px}
.migration-script textarea{flex:1;min-height:90px;resize:vertical;font:12px ui-monospace,monospace;background:var(--input);color:var(--text);border:1px solid var(--border);padding:9px}
.migration-empty{flex:1;min-height:100px;display:grid;place-content:center;color:var(--muted);font-size:12px;border:1px dashed var(--border)}
.migration-progress{border:1px solid var(--border);padding:16px;display:flex;flex-direction:column;gap:12px}
.migration-progress p{margin:0}
progress{width:100%;height:10px;accent-color:var(--accent-button)}
.migration-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.migration-metrics div{display:flex;flex-direction:column;gap:6px;padding:10px;background:var(--panel-raised)}
.migration-metrics small{color:var(--muted)}
.migration-metrics strong{font-size:20px;font-variant-numeric:tabular-nums}
.migration-footer{display:flex;gap:8px;flex:none;align-items:center}
.migration-spacer{flex:1}
.migration-error{margin:0 16px 12px}
</style>
