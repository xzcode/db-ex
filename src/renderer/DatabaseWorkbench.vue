<script setup lang="ts">
import {formatQuery} from '../shared/query-format'
import {gridCellSpec,fieldCellSpec,prepareGridEdits,cellDraftKey,type CellDraft} from '../shared/grid-edit'
import { canActOnColumn,changeColumnSort,mongoSortRules,mongoSortText,type ColumnAction } from '../shared/column-actions'
import { databaseCapabilities } from '../shared/database-capabilities'
import { t, localize, locale } from './i18n'
import { preferences } from './preferences'
import { validWorkbenchTab, type WorkbenchTab } from '../shared/workspace-recovery'
import { pageSizeFor } from '../shared/preferences'
import { useQueryRecovery } from './composables/useQueryRecovery'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { DatabaseOperation, ExplorerNode, OperationResult, QuerySnippet, RedisValueType, SessionInfo, SqlRow, SqlValue } from '../shared/types'
import CodeEditor from './components/CodeEditor.vue'
import MariaObjectDialog from './components/MariaObjectDialog.vue'
import ResultGrid from './components/ResultGrid.vue'
import FieldValueDialog from './components/FieldValueDialog.vue'
import DataFileWizard from './components/DataFileWizard.vue'
import {fileTransferSupported} from '../shared/file-transfer'
import BrowseProfilesDialog from './components/BrowseProfilesDialog.vue'
import type {BrowseProfile,BrowseProfileDraft} from '../shared/browse-profile'
import {parseBsonDocument} from '../shared/bson-display'
import {normalizeGridLayout,type GridLayout} from '../shared/grid-layout'
import ObjectInspector from './components/ObjectInspector.vue'
import {globalInspectorTab,openGlobalInspector,closeGlobalInspector} from './inspector-preferences'
import MongoSavedObjects from './components/MongoSavedObjects.vue'
import MongoIndexHelp from './components/MongoIndexHelp.vue'
import VisualQueryBuilder from './components/VisualQueryBuilder.vue'
import { filterSuggestions } from '../shared/filter-suggestions'
import BrowseRecordView from './components/BrowseRecordView.vue'
import { browseOffset, compileMongoFilter, compileMysqlFilter, MAX_BROWSE_OFFSET, newBrowseFilter, type BrowseFilter } from '../shared/browse-filter'
import type { ObjectInspection } from '../shared/object-inspection'
import BsonDocumentTree from './components/BsonDocumentTree.vue'
import { canSafelyEditMongoDocument, formatMongoDocument, mongoDocumentDraft, mongoFieldFilter, mongoFieldText, parseMongoDocumentEditor } from '../shared/bson-editor'
import type { BsonTypeBranch } from '../shared/bson-types'
import { csvFromRows, sqlRowsFromFile, validateSqlRow } from './data-format'

const props = defineProps<{ session: SessionInfo; node?: ExplorerNode; tableSuggestions?:string[]; initialTab?:WorkbenchTab; requestedTab?:WorkbenchTab; tabRequest?:number; active?:boolean }>()
const emit = defineEmits<{ updateSession: [session: SessionInfo]; disconnect: []; refreshTree: []; tabChange:[tab:WorkbenchTab];busyChange:[busy:boolean];dirtyChange:[dirty:boolean] }>()
const mariaObjectOpen=ref(false)
const tab = ref<WorkbenchTab>(validWorkbenchTab(props.session.kind,props.initialTab,props.node?.readOnly))
let firstSelection=true
let editorScopeKey:string|undefined
// Keep edits in memory when changing objects, even when on-disk recovery is disabled.
const editorCache=new Map<string,{sql:string;parameters:string;pipeline:string;filter:string;projection:string;sort:string}>()
const busy = ref(false)
const libraryBusy=ref(false)
watch(()=>busy.value||libraryBusy.value,value=>emit('busyChange',value),{flush:'sync'})
const error = ref('')
const notice = ref('')
const result = ref<OperationResult | null>(null)
const selectedRow = ref(-1)
const checked = ref<number[]>([])
const offset = ref(0)
const limit = ref<number>(pageSizeFor(preferences.value,props.session.kind))
const sql = ref('SELECT 1 AS result;')
const parameters = ref('[]')
const sqlEditor = ref<InstanceType<typeof CodeEditor>>()
const filter = ref('{}')
const projection = ref('{}')
const sort = ref('{}')
const showMongoFilters = ref(false)
const filterMode = ref<'builder' | 'text'>('builder')
const visualFilter = ref<BrowseFilter>(newBrowseFilter())
const appliedMysql = ref<BrowseFilter>(newBrowseFilter())
const appliedMongo = ref({ filter: '{}', projection: '{}', sort: '{}' })
const browsePageSize = ref<number>(pageSizeFor(preferences.value,props.session.kind))
const pageInput = ref(1)
const browseVisited=ref<Record<number,number>>({1:0})
const customSize=ref<number>(browsePageSize.value)
const profileDialog=ref(false)
const fileWizard=ref<'import'|'export'>()
const previousBrowseOffset=computed(()=>browseVisited.value[pageInput.value-1]??Math.max(0,offset.value-browsePageSize.value))
const totalRows = ref<string>()
const countLimited = ref(false)
const browseView = ref<'grid' | 'record' | 'text'>('grid')
const sqlQuerySummary = ref('')
const sqlQueryParameters = ref<SqlValue[]>([])
const filterError = ref('')
const mongoQuery = ref('')
const filtersActive = computed(() => (databaseCapabilities(props.session.kind).browser==='relational') ? appliedMysql.value.groups.length > 0 || appliedMysql.value.sort.length > 0 : [appliedMongo.value.filter, appliedMongo.value.projection, appliedMongo.value.sort].some(value => { try { return Object.keys(JSON.parse(value || '{}')).length > 0 } catch { return true } }))
const pipeline = ref('[\n  { "$limit": 100 }\n]')
const primaryKeys = ref<string[]>([])
const structure = ref<OperationResult | null>(null)
const snippets = ref<QuerySnippet[]>([])
const historyOpen = ref(false)
const historyOnlyFavorites = ref(false)
const snippetName = ref('')
const historyError = ref('')
const edit = ref<{ mode: 'insert' | 'update' | 'import'; text: string; original?: SqlRow; originalDocument?: string; count?: number; syntax?: 'typed' | 'ejson' } | null>(null)
const editError = ref('')
const editNotice = ref('')
const validatingEdit = ref(false)
watch(() => edit.value?.text, () => { editNotice.value = ''; editError.value = '' })
const indexDialog = ref(false)
const indexHelpOpen=ref(false)
watch(indexDialog,open=>{if(!open)indexHelpOpen.value=false})
function applyIndexExample(example:{keys:string;options:string}){indexKeys.value=example.keys;indexOptions.value=example.options;indexHelpOpen.value=false}
const inspectorTab = globalInspectorTab
const inspection = ref<ObjectInspection>()
const inspectionError = ref('')
const inspectionLoading = ref(false)
let inspectionLoadedKey = ''
let inspectionTimer: ReturnType<typeof setTimeout> | undefined
const documentView = ref<{ document: string; metadata?: BsonTypeBranch }>()
const documentViewMode = ref<'tree' | 'raw'>('tree')
const indexKeys = ref('{ "field": 1 }')
const indexOptions = ref('{ "name": "field_1" }')
const redisPattern = ref('*')
const redisKey = ref('')
const redisNode = ref('')
const redisNodes = ref<string[]>([])
const redisScanCursors = ref<string[]>(['0'])
const redisScanIndex = ref(0)
let appliedRedisScan = { pattern: '*', node: '' }
const redisDetail = ref<OperationResult | null>(null)
const redisType = ref<RedisValueType>('string')
const redisText = ref('')
const redisTtl = ref(-1)
const redisCommand = ref('["PING"]')
const redisMutation = ref('HSET')
const redisArguments = ref('["field", "value"]')
let generation = 0
let disposed = false
let pendingSelection = false
const editableRows = ref(false)
let lastQuery: { sql: string; parameters: SqlValue[]; database?: string } | undefined
const entity = computed(() => ({ database: props.node?.database || '', entity: props.node?.entity || '' }))
const hasEntity = computed(() => !!entity.value.database && !!entity.value.entity)
const capabilities=computed(()=>databaseCapabilities(props.session.kind))
const isMysql=computed(()=>capabilities.value.browser==='relational')
const isMongo=computed(()=>capabilities.value.browser==='document')
const isRedis=computed(()=>capabilities.value.browser==='keyspace')
const libraryKind = computed(() => props.node?.category === 'queries' ? 'query' : props.node?.category === 'pipelines' ? 'aggregation' : undefined)
const canWrite = computed(() => props.session.writable && !props.node?.readOnly && props.node?.kind !== 'mongo-category')
const inspectorName = computed(() => isRedis.value ? (tab.value === 'data' ? result.value?.rows[selectedRow.value]?.key || (redisDetail.value ? redisKey.value : '') : '') : entity.value.entity)
const inspectionKey = computed(() => JSON.stringify([props.session.id, props.session.kind, entity.value.database, inspectorName.value]))
const visibleSnippets = computed(() => snippets.value.filter(item => item.kind === props.session.kind && (!historyOnlyFavorites.value || item.favorite) && (!isMongo.value || !item.mongoKind || item.mongoKind === 'aggregation')))
const browseFields = computed(() => (databaseCapabilities(props.session.kind).browser==='relational') ? (structure.value?.rows || []).map(row => String(row.name || row.Field || '')).filter(Boolean) : result.value?.columns || [])
function supportsRecordMutation(operation:'insert'|'update'|'delete'|'import'){
  if(props.session.kind!=='mariadb')return true
  const support=structure.value?.objectCapabilities
  // Missing server metadata must not silently enable a mutation.
  return !!support?.[operation]&&(!props.session.transaction||support.transactional)
}
const canInsertRecord=computed(()=>canWrite.value&&supportsRecordMutation('insert'))
const canImportRecords=computed(()=>canWrite.value&&supportsRecordMutation('import'))
const canEditRow = computed(() => !props.node?.readOnly && supportsRecordMutation('update') && editableRows.value && selectedRow.value >= 0 && (isMongo.value ? !!result.value?.documents?.[selectedRow.value] : !!result.value?.rawRows?.[selectedRow.value] && primaryKeys.value.length > 0))
// Drafts are scoped to the current loaded page and never sent during typing.
const gridDrafts=ref<CellDraft[]>([])
const fieldDialog=ref<{row:number;field:string;type:string;value:string;editable:boolean;exact:boolean}>()
const gridLayout=ref<GridLayout>()
let lastGridLayout:GridLayout|undefined
function rememberGridLayout(value:GridLayout){lastGridLayout=value}
const gridLayoutScope=computed(()=>JSON.stringify([props.session.connectionId||props.session.id,props.session.kind,entity.value.database,entity.value.entity,'browse']))
const gridCanWrite=computed(()=>tab.value==='data'&&!busy.value&&!edit.value&&canWrite.value&&editableRows.value&&supportsRecordMutation('update')&&(isMysql.value||isMongo.value)&&!gridUncertain.value)
function exactCell(row:number,field:string){
 const doc=result.value?.documents?.[row]
 if(doc){const obj=parseBsonDocument(doc);if(obj&&Object.hasOwn(obj,field))return typeof obj[field]==='string'?String(obj[field]):JSON.stringify(obj[field])}
 const raw=result.value?.rawRows?.[row];if(raw&&Object.hasOwn(raw,field))return raw[field]===null?'NULL':String(raw[field])
 return undefined
}
function openField(row:number,field:string){
 if(!result.value||busy.value||!finishInline()||columnDraft.value)return
 const candidate=fieldCellSpec(result.value,structure.value,props.session.kind,primaryKeys.value,row,field)
 const raw=exactCell(row,field),draft=gridDrafts.value.find(d=>d.row===row&&d.field===field)
 // Composite BSON uses explicit canonical EJSON, including null and binary.
 const mongoDoc=result.value.documents?.[row],doc=mongoDoc?parseBsonDocument(mongoDoc):undefined
 const type=candidate?.type||result.value.columnTypes?.[result.value.columns.indexOf(field)]||'Text'
 const draftValue=draft&&isMongo.value&&draft.format!=='ejson'?(()=>{try{return JSON.stringify(JSON.parse(prepareGridEdits(result.value!,structure.value,props.session.kind,primaryKeys.value,[draft]).mongoEdits[0]!.document)[field],null,2)}catch{return draft.text}})():draft?.text
 const value=draftValue??candidate?.text??(doc&&Object.hasOwn(doc,field)?JSON.stringify(doc[field],null,2):raw??String(result.value.rows[row]?.[field]??''))
 fieldDialog.value={row,field,type,value,editable:!!candidate&&gridCanWrite.value,exact:raw!==undefined}
}
function stageField(text:string,format:'ejson'|'extended'){
 const d=fieldDialog.value;if(!d||!d.editable||!gridCanWrite.value||!result.value)return
 try{
  const draft:CellDraft={row:d.row,field:d.field,text,format}
  prepareGridEdits(result.value,structure.value,props.session.kind,primaryKeys.value,[draft])
  gridDrafts.value=[...gridDrafts.value.filter(item=>cellDraftKey(item.row,item.field)!==cellDraftKey(d.row,d.field)),draft]
  selectedRow.value=d.row;gridScope.value={kind:'row',row:d.row};fieldDialog.value=undefined
 }catch(e){setError(e)}
}
function stageCells(cells:CellDraft[]){
 if(!gridEditingEnabled.value||!result.value||columnDraft.value||!finishInline())return
 if(!cells.length){error.value='选区含不可编辑字段或超出当前页，未暂存任何修改。';return}
 try{
  prepareGridEdits(result.value,structure.value,props.session.kind,primaryKeys.value,cells)
  const incoming=new Set(cells.map(d=>cellDraftKey(d.row,d.field)))
  gridDrafts.value=[...gridDrafts.value.filter(d=>!incoming.has(cellDraftKey(d.row,d.field))),...cells.filter(d=>d.text!==spec(d.row,d.field)?.text)]
  notice.value=t('已暂存修改')+' · '+cells.length;error.value=''
 }catch(e){setError(e)}
}
const inlineCell=ref<CellDraft>()
const gridScope=ref<{kind:'row';row:number}|{kind:'column';field:string}>({kind:'row',row:-1})
const columnDraft=ref<{field:string;text:string;changed:boolean}>()
const gridUncertain=ref(false)
const gridNeedsRefresh=ref(false)
const gridDirty=computed(()=>gridDrafts.value.length>0||!!inlineCell.value||!!columnDraft.value)
const inlineDraftMap=computed(()=>Object.fromEntries(gridDrafts.value.map(d=>[cellDraftKey(d.row,d.field),d.text])))
const gridEditingEnabled=computed(()=>gridCanWrite.value&&browseView.value==='grid')
function spec(row:number,field:string){return result.value?gridCellSpec(result.value,structure.value,props.session.kind,primaryKeys.value,row,field):undefined}
function canInlineEdit(row:number,field:string){return gridEditingEnabled.value&&!!spec(row,field)}
function canEditColumn(field:string){
 if(!gridEditingEnabled.value||!result.value?.rows.length)return false
 const specs=result.value.rows.map((_,row)=>spec(row,field))
 // Do not silently skip missing/readonly or mixed-type records in a column.
 return specs.every(item=>!!item&&item.type===specs[0]?.type)
}
function stageDraft(draft:CellDraft){
 const original=spec(draft.row,draft.field)
 if(!original)throw new Error('表格编辑值与原始字段类型不匹配。')
 if(draft.text!==original.text)prepareGridEdits(result.value!,structure.value,props.session.kind,primaryKeys.value,[draft])
 const key=cellDraftKey(draft.row,draft.field)
 const rest=gridDrafts.value.filter(item=>cellDraftKey(item.row,item.field)!==key)
 if(draft.text!==original.text)rest.push({...draft})
 gridDrafts.value=rest
}
function finishInline(cancel=false):boolean{
 const draft=inlineCell.value
 if(!draft)return true
 if(cancel){inlineCell.value=undefined;return true}
 try{stageDraft(draft);inlineCell.value=undefined;error.value='';return true}catch(reason){setError(reason);return false}
}
function selectGridRow(row:number){
 if(!finishInline()||columnDraft.value)return
 selectedRow.value=row;gridScope.value={kind:'row',row}
}
function selectGridColumn(field:string){
 if(!finishInline()||columnDraft.value)return
 gridScope.value={kind:'column',field}
}
function beginInline(row:number,field:string){
 if(!canInlineEdit(row,field)||columnDraft.value||!finishInline())return
 const initial=spec(row,field)!
 selectedRow.value=row;gridScope.value={kind:'row',row}
 inlineCell.value={row,field,text:inlineDraftMap.value[cellDraftKey(row,field)]??initial.text}
}
function beginColumn(field:string){
 if(!canEditColumn(field)||!finishInline()||columnDraft.value)return
 gridScope.value={kind:'column',field}
 const first=gridDrafts.value.find(d=>d.field===field)
 columnDraft.value={field,text:first?.text??spec(0,field)!.text,changed:false}
}
function stageColumn(){
 const draft=columnDraft.value
 if(!draft)return true
 if(!draft.changed){columnDraft.value=undefined;return true}
 try{
  if(!canEditColumn(draft.field))throw new Error('表格编辑值与原始字段类型不匹配。')
  const items=result.value!.rows.map((_,row)=>({row,field:draft.field,text:draft.text}))
  prepareGridEdits(result.value!,structure.value,props.session.kind,primaryKeys.value,items)
  gridDrafts.value=[...gridDrafts.value.filter(d=>d.field!==draft.field),...items.filter(d=>d.text!==spec(d.row,d.field)!.text)]
  columnDraft.value=undefined;error.value='';return true
 }catch(reason){setError(reason);return false}
}
function currentProfile():BrowseProfileDraft{
 let layout=lastGridLayout
 if(!layout)try{layout=normalizeGridLayout(JSON.parse(localStorage.getItem('dbex.grid-layout.v1:'+gridLayoutScope.value)||'null'),result.value?.columns||[])}catch{}
 return {name:'',filterMode:isMongo.value?filterMode.value:'builder',visualFilter:JSON.parse(JSON.stringify(visualFilter.value)),mongo:{filter:filter.value,projection:projection.value,sort:sort.value},pageSize:browsePageSize.value,view:browseView.value,layout}
}
async function applyBrowseProfile(profile:BrowseProfile){
 if(!guardGridDraft()||busy.value)return
 try{
  const mongo=profile.filterMode==='builder'&&isMongo.value?{...compileMongoFilter(profile.visualFilter),projection:'{}'}:profile.mongo
  if(await loadData(0,mongo,profile.visualFilter,profile.pageSize)){
   visualFilter.value=profile.visualFilter;filterMode.value=profile.filterMode
   filter.value=mongo.filter;projection.value=mongo.projection;sort.value=mongo.sort
   browseView.value=profile.view;gridLayout.value=profile.layout;lastGridLayout=profile.layout
   if(profile.layout)try{localStorage.setItem('dbex.grid-layout.v1:'+gridLayoutScope.value,JSON.stringify(profile.layout))}catch{}
   profileDialog.value=false
  }
 }catch(e){setError(e)}
}
const previewDraftMap=computed(()=>{
 const map={...inlineDraftMap.value},draft=columnDraft.value
 if(draft?.changed&&result.value)result.value.rows.forEach((_,row)=>{map[cellDraftKey(row,draft.field)]=draft.text})
 return map
})
function inGridScope(draft:CellDraft){const scope=gridScope.value;return scope.kind==='row'?draft.row===scope.row:draft.field===scope.field}
const scopedDraftCount=computed(()=>new Set(gridDrafts.value.filter(inGridScope).map(d=>d.row)).size)
const scopeHasEdits=computed(()=>!!inlineCell.value||!!columnDraft.value||scopedDraftCount.value>0)
function discardGridScope(){
 if(busy.value)return
 inlineCell.value=undefined;columnDraft.value=undefined
 gridDrafts.value=gridDrafts.value.filter(d=>!inGridScope(d))
 error.value=''
 if(!gridDirty.value&&(gridUncertain.value||gridNeedsRefresh.value)){gridUncertain.value=false;gridNeedsRefresh.value=false;void loadData(offset.value)}
}
function discardAllGrid(){
 if(busy.value)return
 inlineCell.value=undefined;columnDraft.value=undefined;gridDrafts.value=[]
 error.value='';const uncertain=gridUncertain.value||gridNeedsRefresh.value;gridUncertain.value=false;gridNeedsRefresh.value=false
 if(uncertain)void loadData(offset.value)
}
function guardGridDraft():boolean{
 if(!gridDirty.value&&!gridUncertain.value)return true
 error.value='请先保存或取消表格修改。';return false
}
async function saveGridScope(all=false){
 if(!gridCanWrite.value||!finishInline()||!stageColumn()||!result.value)return
 const drafts=all?[...gridDrafts.value]:gridDrafts.value.filter(inGridScope)
 if(!drafts.length)return
 try{
  const snapshot=result.value,prepared=prepareGridEdits(snapshot,structure.value,props.session.kind,primaryKeys.value,drafts)
  const operation:DatabaseOperation=isMongo.value?{action:'mongo.replaceBatch',...entity.value,edits:prepared.mongoEdits,confirmed:true}:{action:'mysql.updateBatch',...entity.value,edits:prepared.sqlEdits,confirmed:true}
  const next=await execute(operation,false)
  if(!next){if(/^(?:BATCH_UNCERTAIN|TIMEOUT|SESSION_CLOSED|DATABASE_ERROR):/.test(error.value)||error.value.includes('连接已断开'))gridUncertain.value=true;return}
  const batch=next.gridBatch
  if(!batch||batch.total!==prepared.rows.length||!Number.isInteger(batch.completed)||batch.completed<0||batch.completed>prepared.rows.length){gridUncertain.value=true;error.value='BATCH_UNCERTAIN: 写入结果待核对，请重新连接。';return}
  const committed=new Set(prepared.rows.slice(0,batch.completed))
  if(batch.completed)gridNeedsRefresh.value=true
  // Preserve remaining drafts; successful snapshots are expected values until
  // the page is refreshed. Further writes still compare all original fields.
  for(let i=0;i<batch.completed;i++){
   const row=prepared.rows[i]!
   if(isMongo.value&&snapshot.documents)snapshot.documents[row]=prepared.mongoEdits[i]!.document
   else if(snapshot.rawRows)snapshot.rawRows[row]={...snapshot.rawRows[row]!,...prepared.sqlEdits[i]!.changes}
   for(const draft of drafts.filter(d=>d.row===row))snapshot.rows[row]![draft.field]=draft.text
  }
  const submittedKeys=new Set(drafts.filter(d=>committed.has(d.row)).map(d=>cellDraftKey(d.row,d.field)))
  gridDrafts.value=gridDrafts.value.filter(d=>!submittedKeys.has(cellDraftKey(d.row,d.field)))
  if(batch.failed){gridUncertain.value=!!batch.uncertain;error.value=(batch.error||'批量编辑未全部完成')+' · '+batch.completed+'/'+batch.total;return}
  if(!gridDirty.value){gridNeedsRefresh.value=false;await loadData(offset.value);notice.value=t('已保存 {0} 条记录',[batch.completed])}
  else notice.value=t('已保存 {0} 条记录；仍有未保存的修改。',[batch.completed])
 }catch(reason){setError(reason)}
}
watch(()=>!!edit.value||gridDirty.value||gridUncertain.value,value=>emit('dirtyChange',value),{flush:'sync'})

const mutationCommands: Record<RedisValueType, string[]> = {
  string: ['APPEND', 'SETRANGE', 'INCRBY'], hash: ['HSET', 'HDEL', 'HINCRBY'],
  list: ['LPUSH', 'RPUSH', 'LSET', 'LREM', 'LTRIM', 'LPOP', 'RPOP'],
  set: ['SADD', 'SREM'], zset: ['ZADD', 'ZREM', 'ZINCRBY'], stream: ['XADD', 'XDEL', 'XTRIM'],
}

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
function setError(reason: unknown) { error.value = messageOf(reason) }
function quote(name: string) { return '`' + name.replace(/`/g, '``') + '`' }
function entityTitle() { return `${entity.value.database}.${entity.value.entity}` }
async function execute(operation: DatabaseOperation, showResult = true): Promise<OperationResult | null> {
  if (busy.value || disposed) return null
  const version = generation
  const id = props.session.id
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const next = await window.dbex.execute(id, operation)
    if (disposed || version !== generation) return null
    if (showResult) { result.value = next; selectedRow.value = -1; checked.value = [] }
    if (next.transaction !== undefined) emit('updateSession', { ...props.session, transaction: next.transaction })
    notice.value = next.message || (next.affectedRows !== undefined ? `已影响 ${next.affectedRows} 条记录` : '')
    if (next.disconnected) emit('disconnect')
    return next
  } catch (reason) { if (!disposed && version === generation) setError(reason); return null }
  finally {
    if (!disposed) {
      busy.value = false
      if (pendingSelection) { pendingSelection = false; queueMicrotask(() => { void refreshSelection(generation) }) }
    }
  }
}
function openInspector(next: 'info' | 'ddl' | 'colors') { openGlobalInspector(next) }
async function refreshInspection() {
  if (busy.value || disposed || inspectionLoading.value || !inspectorName.value || (!isRedis.value && !hasEntity.value)) return
  const key = inspectionKey.value
  const version = generation
  inspectionLoadedKey = key
  inspectionLoading.value = true; inspectionError.value = ''; inspection.value = undefined
  const operation: DatabaseOperation = isRedis.value ? { action: 'redis.inspect', key: inspectorName.value } : isMysql.value ? { action: 'mysql.inspect', ...entity.value } : { action: 'mongo.inspect', ...entity.value }
  // Use the same session-busy/cancellation path as other operations; the
  // inspector does not replace the current result grid.
  const next = await execute(operation, false)
  if (!disposed && generation === version && inspectionKey.value === key) {
    inspection.value = next?.inspection
    if (!next?.inspection) inspectionError.value = error.value || '部分元数据不可用或无读取权限。'
  }
  inspectionLoading.value = false
}
watch(inspectionKey, () => { inspection.value = undefined; inspectionError.value = ''; inspectionLoadedKey = '' })
watch([inspectorTab, inspectionKey, busy, inspectionLoading,()=>props.active], () => {
  if (inspectionTimer) clearTimeout(inspectionTimer)
  if (props.active!==false&&inspectorTab.value && inspectorTab.value !== 'colors' && !busy.value && !inspectionLoading.value && inspectorName.value && inspectionLoadedKey !== inspectionKey.value) {
    inspectionTimer = setTimeout(() => { if (props.active!==false&&inspectorTab.value && inspectorTab.value !== 'colors') void refreshInspection() }, 0)
  }
}, { flush: 'post', immediate:true })
async function confirmWrite(_title: string, _details: string): Promise<boolean> {
  if (!canWrite.value) { error.value = '当前会话只读，请先点击右上角“启用写入”。'; return false }
  // A native main-process dialog confirms each database write immediately before execution.
  return true
}
async function toggleWrite() {
  if(!guardGridDraft())return
  if (busy.value) return
  busy.value=true
  try { emit('updateSession', await window.dbex.setWriteAccess(props.session.id, !props.session.writable)) }
  catch (reason) { setError(reason) }
  finally{busy.value=false}
}
async function cancel() {
  try { await window.dbex.cancel(props.session.id); emit('disconnect') }
  catch (reason) { setError(reason) }
}
async function remember(text: string,params?:string) {
  if(!preferences.value.records.recordHistory)return
  try {
    await window.dbex.saveSnippet({ name: text.trim().split('\n')[0].slice(0, 80), text, parameters:params, database: entity.value.database, kind: props.session.kind, ...(isMongo.value ? { mongoKind: 'aggregation' as const, entity: entity.value.entity, connectionId: props.session.connectionId } : {}), favorite: false })
  } catch { notice.value += ' · 查询已执行，但历史记录保存失败' }
}
async function loadData(nextOffset = 0, proposedMongo = appliedMongo.value, proposedMysql = appliedMysql.value, size = browsePageSize.value,requestedPage?:number): Promise<boolean> {
  if(!guardGridDraft())return false
  if (!hasEntity.value || busy.value || !Number.isInteger(size)||size<1||size>500||nextOffset < 0 || nextOffset > MAX_BROWSE_OFFSET) return false
  const version = generation
  const target = { ...entity.value }
  const mongo = { ...proposedMongo }
  const mysql = JSON.parse(JSON.stringify(proposedMysql)) as BrowseFilter
  const sameFilter=JSON.stringify(appliedMongo.value)===JSON.stringify(mongo)&&JSON.stringify(appliedMysql.value)===JSON.stringify(mysql)
  const nextPage=nextOffset===0?1:requestedPage??(sameFilter&&size===browsePageSize.value?(Number(Object.entries(browseVisited.value).find(([,at])=>at===nextOffset)?.[0])||(nextOffset===result.value?.nextOffset?pageInput.value+1:Math.floor(nextOffset/size)+1)):Math.floor(nextOffset/size)+1)
  if (isMysql.value) {
    const compiled = compileMysqlFilter(target.database, target.entity, mysql,props.session.kind==='sqlite'?'sqlite':'mysql')
    const next = await execute({ action: 'mysql.browse', ...target, filter: mysql, offset: nextOffset, limit: size })
    if (!next || version !== generation) return false
    appliedMysql.value = mysql
    sqlQuerySummary.value = compiled.sql + ' LIMIT ' + size + ' OFFSET ' + nextOffset
    sqlQueryParameters.value = compiled.parameters
    editableRows.value = !!next.rawRows
  } else if (isMongo.value) {
    const next = await execute({ action: 'mongo.find', ...target, ...mongo, offset: nextOffset, limit: size })
    if (!next || version !== generation) return false
    appliedMongo.value = mongo
    const find = 'db.getCollection(' + JSON.stringify(target.entity) + ').find(' + (mongo.filter.trim() || '{}') + ', ' + (mongo.projection.trim() || '{}') + ')'
    mongoQuery.value = (find + '.sort(' + (mongo.sort.trim() || '{}') + ').limit(' + size + ').skip(' + nextOffset + ')').slice(0, 3000)
    try { editableRows.value = !!next.documents && Object.keys(JSON.parse(mongo.projection || '{}')).length === 0 } catch { editableRows.value = false }
  } else return false
  if(nextOffset===0||size!==browsePageSize.value||!sameFilter)browseVisited.value={1:0}
  browseVisited.value={...browseVisited.value,[nextPage]:nextOffset}
  offset.value = nextOffset
  browsePageSize.value = size;customSize.value=size
  if (browseView.value !== 'grid' && result.value?.rows.length) selectedRow.value = 0
  pageInput.value = nextPage
  totalRows.value = undefined
  countLimited.value = false
  return true
}
const activeSortRules=computed(()=>{
  if(!isMongo.value)return appliedMysql.value.sort
  try{return mongoSortRules(appliedMongo.value.sort)}catch{return []}
})
const columnActionFields=computed(()=>tab.value==='data'&&!busy.value&&hasEntity.value&&!isRedis.value?
  (result.value?.columns||[]).filter(field=>canActOnColumn(field,isMongo.value)&&(isMongo.value||browseFields.value.includes(field))):[])
async function handleColumnAction(action:ColumnAction,field:string){
  if(!columnActionFields.value.includes(field))return
  filterError.value=''
  try{
    if(action==='filter'){
      showMongoFilters.value=true
      if(isMongo.value&&filterMode.value==='text'){
        // Preserve arbitrary typed EJSON predicates and exact numeric literals.
        // The condition is a draft, never an automatic query with a blank value.
        const raw=filter.value.trim()||'{}'
        const previous=JSON.parse(raw)
        if(!previous||typeof previous!=='object'||Array.isArray(previous))throw new Error('INVALID_FILTER: 筛选或排序条件无效')
        const condition=JSON.stringify(Object.fromEntries([[field,{$eq:''}]]))
        filter.value=Object.keys(previous).length?'{"$and":['+raw+','+condition+']}':condition
      }else{
        const draft=JSON.parse(JSON.stringify(visualFilter.value)) as BrowseFilter
        if(draft.groups.reduce((n,g)=>n+g.rules.length,0)>=50)throw new Error('INVALID_FILTER: 筛选或排序条件无效')
        const suggestions=filterSuggestions(result.value,field,isMongo.value)
        const type=suggestions.length&&suggestions.every(v=>v.type===suggestions[0]!.type)?suggestions[0]!.type:'String'
        const rule={field,operator:'eq' as const,type,value:'',enabled:true}
        if(draft.groups.length)draft.groups[0]!.rules.push(rule)
        else draft.groups.push({join:'and',rules:[rule]})
        visualFilter.value=draft
      }
      return
    }
    const rules=changeColumnSort(activeSortRules.value,field,action)
    if(isMongo.value){
      const proposed={...appliedMongo.value,sort:mongoSortText(rules)}
      if(await loadData(0,proposed)){sort.value=proposed.sort;visualFilter.value={...visualFilter.value,sort:rules}}
    }else{
      const proposed={...appliedMysql.value,sort:rules}
      if(await loadData(0,appliedMongo.value,proposed))visualFilter.value={...visualFilter.value,sort:rules}
    }
  }catch(reason){filterError.value=messageOf(reason);showMongoFilters.value=true}
}
async function applyVisualFilter() {
  filterError.value = ''
  try {
    if (isMongo.value) {
      const compiled = compileMongoFilter(visualFilter.value)
      const proposed = { ...compiled, projection: '{}' }
      if (await loadData(0, proposed)) { filter.value = proposed.filter; sort.value = proposed.sort; projection.value = proposed.projection }
    } else {
      compileMysqlFilter(entity.value.database, entity.value.entity, visualFilter.value,props.session.kind==='sqlite'?'sqlite':'mysql')
      await loadData(0, appliedMongo.value, visualFilter.value)
    }
  } catch (reason) { filterError.value = messageOf(reason) }
}
async function applyTextFilter() {
  filterError.value = ''
  try { await loadData(0, { filter: filter.value, projection: projection.value, sort: sort.value }) }
  catch (reason) { filterError.value = messageOf(reason) }
}
async function resetBrowseFilter() {
  visualFilter.value = newBrowseFilter()
  filter.value = '{}'; projection.value = '{}'; sort.value = '{}'; filterError.value = ''
  await loadData(0, { filter: '{}', projection: '{}', sort: '{}' }, newBrowseFilter())
}
async function jumpPage() {
  try {
    const next = browseVisited.value[Number(pageInput.value)]??browseOffset(Number(pageInput.value), browsePageSize.value)
    if (!await loadData(next,appliedMongo.value,appliedMysql.value,browsePageSize.value,Number(pageInput.value))) pageInput.value = Math.floor(offset.value / browsePageSize.value) + 1
  } catch (reason) { setError(reason); pageInput.value = Math.floor(offset.value / browsePageSize.value) + 1 }
}
async function changeBrowseSize(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (!Number.isSafeInteger(value)||value<1||value>500) return
  if (!await loadData(0, appliedMongo.value, appliedMysql.value, value)) (event.target as HTMLSelectElement).value = String(browsePageSize.value)
}
async function lastBrowsePage() {
  if(!guardGridDraft())return
  if (busy.value || !hasEntity.value) return
  const version = generation
  const response = await execute(isMongo.value ? { action: 'mongo.count', ...entity.value, filter: appliedMongo.value.filter } : { action: 'mysql.browse', ...entity.value, filter: appliedMysql.value, countOnly: true }, false)
  if (!response?.totalRows || generation !== version) return
  const total = Number(response.totalRows)
  if (response.countLimited || !Number.isSafeInteger(total) || total < 0) {
    totalRows.value = response.totalRows; countLimited.value = true; notice.value = '记录数超出末页跳转上限，请缩小筛选范围。'; return
  }
  const next = Math.max(0, Math.floor((total - 1) / browsePageSize.value) * browsePageSize.value)
  if (next > MAX_BROWSE_OFFSET) { notice.value = '记录数超出末页跳转上限，请缩小筛选范围。'; return }
  if (await loadData(next) && generation === version) totalRows.value = response.totalRows
}
function changeBrowseView(view: 'grid' | 'record' | 'text') {
  if(!guardGridDraft())return
  browseView.value = view
  if (selectedRow.value < 0 && result.value?.rows.length) selectedRow.value = 0
}
async function loadStructure() {
  if (!hasEntity.value) return
  const next = await execute(isMysql.value ? { action: 'mysql.structure', ...entity.value } : { action: 'mongo.indexes', ...entity.value }, false)
  if (next) { structure.value = next; primaryKeys.value = next.primaryKeys || [] }
}
async function beautifySql(){
 if(busy.value)return
 const before=sql.value
 try{const formatted=await formatQuery(before,props.session.kind,preferences.value.editor.tabSize);if(sql.value===before)sql.value=formatted}catch(reason){setError(reason)}
}
async function runQuery(nextOffset = 0) {
  if(!guardGridDraft())return
  if (busy.value) return
  try {
    const text = nextOffset && lastQuery ? lastQuery.sql : sqlEditor.value?.selection() || sql.value
    const parsed: unknown = nextOffset && lastQuery ? lastQuery.parameters : JSON.parse(parameters.value)
    if (!Array.isArray(parsed) || parsed.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('SQL 参数需要 JSON 数组，仅支持字符串、数字、布尔或 null')
    const allowed = !props.session.writable || await confirmWrite('执行 SQL', text.slice(0, 2000))
    if (!allowed) return
    offset.value = nextOffset
    editableRows.value = false
    lastQuery = { sql: text, parameters: parsed as SqlValue[], database: nextOffset && lastQuery ? lastQuery.database : entity.value.database || undefined }
    const next = await execute({ action: 'mysql.query', sql: text, database: lastQuery.database, parameters: parsed as SqlValue[], limit: limit.value, offset: nextOffset, confirmed: props.session.writable })
    if (next) await remember(text,JSON.stringify(parsed))
  } catch (reason) { setError(reason) }
}
async function runAggregation() {
  if(!guardGridDraft())return
  if (!hasEntity.value) return
  offset.value = 0
  const next = await execute({ action: 'mongo.aggregate', ...entity.value, pipeline: pipeline.value, limit: limit.value })
  if (next) await remember(pipeline.value)
}
async function transaction(action: 'mysql.begin' | 'mysql.commit' | 'mysql.rollback') {
  const label = action === 'mysql.begin' ? '开始事务' : action === 'mysql.commit' ? '提交事务' : '回滚事务'
  if (action === 'mysql.rollback' || await confirmWrite(label, action === 'mysql.commit' ? '提交当前会话中尚未提交的所有修改。' : '进入显式事务。完成后请提交或回滚。')) await execute({ action, confirmed: true }, false)
}
function viewMongoDocument(index = selectedRow.value) {
  const document = result.value?.documents?.[index]
  if (!isMongo.value || document === undefined) return
  documentViewMode.value = 'tree'
  documentView.value = { document, metadata: result.value?.bsonTypes?.[index] }
}
function openResultRow(index: number) {
  selectedRow.value = index
  if (isMongo.value) viewMongoDocument(index)
  else if (tab.value === 'data' && !isRedis.value) openEdit()
}
function openInsert() { if (!guardGridDraft()||!canInsertRecord.value) return; editError.value = ''; editNotice.value = ''; edit.value = { mode: 'insert', text: isMysql.value ? '{} ' : '{\n  "name": ""\n}', syntax: isMongo.value ? 'typed' : undefined } }
function openEdit() {
  if(!guardGridDraft())return
  if (!canEditRow.value || busy.value || !props.session.writable || tab.value !== 'data') return
  editError.value = ''; editNotice.value = ''
  if (isMysql.value) {
    const original = result.value!.rawRows![selectedRow.value]
    edit.value = { mode: 'update', text: JSON.stringify(original, null, 2), original }
  } else {
    const originalDocument = result.value!.documents![selectedRow.value]
    if (!canSafelyEditMongoDocument(originalDocument, result.value?.bsonTypes?.[selectedRow.value])) { error.value = '文档包含无法安全编辑的 BSON 类型。'; return }
    const formatted = formatMongoDocument(originalDocument, result.value?.bsonTypes?.[selectedRow.value])
    edit.value = { mode: 'update', ...formatted, originalDocument }
  }
}
function editMongoRow(index: number) {
  selectedRow.value = index
  openEdit()
}
async function mongoContextAction(action: 'add' | 'copy-value' | 'copy-document' | 'duplicate' | 'delete' | 'null' | 'empty' | 'filter', index: number, field?: string) {
  if(gridDirty.value&&!['copy-value','copy-document'].includes(action)){guardGridDraft();return}
  const document = result.value?.documents?.[index]
  if (!isMongo.value || !document || busy.value) return
  const metadata = result.value?.bsonTypes?.[index]
  try {
    if (action === 'copy-document' || action === 'copy-value') {
      const value = action === 'copy-document' ? JSON.stringify(JSON.parse(document), null, 2) : field === undefined ? undefined : mongoFieldText(document, metadata, field)
      if (value === undefined) return
      await window.dbex.copyText(value)
      notice.value = '已复制到剪贴板'
      return
    }
    if (tab.value !== 'data' || !hasEntity.value) return
    if (action === 'filter') {
      if (field === undefined) return
      const condition = mongoFieldFilter(document, metadata, field)
      if (!condition) return
      const previous = JSON.parse(appliedMongo.value.filter || '{}')
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('格式无效，请检查 JSON / BSON / SQL 输入')
      filter.value = JSON.stringify(Object.keys(previous).length ? { $and: [previous, condition] } : condition)
      projection.value = appliedMongo.value.projection; sort.value = appliedMongo.value.sort
      showMongoFilters.value = true; filterMode.value = 'text'
      await applyTextFilter()
      return
    }
    if (!canWrite.value) return
    if (action === 'add') { openInsert(); return }
    selectedRow.value = index
    if (!canEditRow.value || !canSafelyEditMongoDocument(document, metadata)) return
    if (action === 'delete') { await deleteRow(); return }
    editError.value = ''; editNotice.value = ''
    const formatted = mongoDocumentDraft(document, metadata, action, field)
    edit.value = action === 'duplicate' ? { mode: 'insert', ...formatted } : { mode: 'update', originalDocument: document, ...formatted }
  } catch (reason) { setError(reason) }
}
function mongoEditText(draft: NonNullable<typeof edit.value>): string {
  return draft.syntax === 'typed' ? parseMongoDocumentEditor(draft.text) : JSON.stringify(JSON.parse(draft.text))
}
function useRawEjson() {
  if (!edit.value || validatingEdit.value || busy.value) return
  try {
    edit.value.text = JSON.stringify(JSON.parse(mongoEditText(edit.value)), null, 2)
    edit.value.syntax = 'ejson'
    editError.value = ''; editNotice.value = ''
  } catch (reason) { editError.value = messageOf(reason) }
}
async function validateEdit() {
  const draft = edit.value
  if (!draft || !isMongo.value || draft.mode === 'import' || validatingEdit.value || busy.value) return
  const before = draft.text
  validatingEdit.value = true; editError.value = ''; editNotice.value = ''
  try {
    await window.dbex.validateMongoDocument(mongoEditText(draft), draft.originalDocument)
    if (edit.value === draft && draft.text === before) editNotice.value = '文档验证通过'
  } catch (reason) { if (edit.value === draft && draft.text === before) editError.value = messageOf(reason) }
  finally { validatingEdit.value = false }
}
function rowKey(original: SqlRow): SqlRow {
  return Object.fromEntries(primaryKeys.value.map(key => {
    if (!(key in original)) throw new Error(`结果中缺少主键 ${key}`)
    return [key, original[key]]
  }))
}
async function saveEdit() {
  const draft = edit.value
  if (!draft || busy.value || validatingEdit.value || !canWrite.value || !supportsRecordMutation(draft.mode)) return
  try {
    let operation: DatabaseOperation
    if (isMysql.value) {
      if (draft.mode === 'import') {
        const values: unknown = JSON.parse(draft.text)
        if (!Array.isArray(values)) throw new Error('导入内容需要记录数组')
        operation = { action: 'mysql.import', ...entity.value, rows: values.map(validateSqlRow), confirmed: true }
      } else {
        const values = validateSqlRow(JSON.parse(draft.text))
        operation = draft.mode === 'insert'
          ? { action: 'mysql.insert', ...entity.value, values, confirmed: true }
          : { action: 'mysql.update', ...entity.value, key: rowKey(draft.original!), original: draft.original!, changes: Object.fromEntries(Object.entries(values).filter(([key, value]) => !Object.is(value, draft.original![key]))), confirmed: true }
      }
    } else {
      if (draft.mode === 'import') {
        const documents: unknown = JSON.parse(draft.text)
        if (!Array.isArray(documents)) throw new Error('导入内容需要 EJSON 文档数组')
        operation = { action: 'mongo.insert', ...entity.value, documents: documents.map(item => JSON.stringify(item)), confirmed: true }
      } else {
        const document = mongoEditText(draft)
        const version = generation
        validatingEdit.value = true
        try { await window.dbex.validateMongoDocument(document, draft.originalDocument) }
        finally { validatingEdit.value = false }
        if (disposed || version !== generation || edit.value !== draft || !canWrite.value) return
        operation = draft.mode === 'insert'
          ? { action: 'mongo.insert', ...entity.value, documents: [document], confirmed: true }
          : { action: 'mongo.replace', ...entity.value, original: draft.originalDocument!, document, confirmed: true }
      }
    }
    if (!await confirmWrite(draft.mode === 'update' ? '保存修改' : '插入记录', `${entityTitle()}\n${draft.mode === 'import' ? `本批 ${draft.count ?? '?'} 条记录。` : '将保存编辑器中的完整记录。'}\nMySQL 修改会核对主键与原始值，MongoDB 修改会核对原始文档。`)) return
    const next = await execute(operation, false)
    if (next) { closeEdit(); await loadData(offset.value) } else editError.value = error.value
  } catch (reason) { editError.value = messageOf(reason) }
}
async function deleteRow() {
  if(!guardGridDraft())return
  if (!canEditRow.value || busy.value || tab.value !== 'data' || !props.session.writable) return
  if (isMongo.value && !canSafelyEditMongoDocument(result.value!.documents![selectedRow.value], result.value?.bsonTypes?.[selectedRow.value])) { error.value = '文档包含无法安全编辑的 BSON 类型。'; return }
  if (!await confirmWrite('删除记录', `${entityTitle()}\n将删除当前选中的 1 条记录。`)) return
  try {
    const original = result.value?.rawRows?.[selectedRow.value]
    const next = await execute(isMysql.value
      ? { action: 'mysql.delete', ...entity.value, key: rowKey(original!), original: original!, confirmed: true }
      : { action: 'mongo.delete', ...entity.value, original: result.value!.documents![selectedRow.value], confirmed: true }, false)
    if (next) await loadData(offset.value)
  } catch (reason) { setError(reason) }
}
async function importData() {
  if(!guardGridDraft())return
  if(!canImportRecords.value)return
  try {
    const file = await window.dbex.importFile()
    if (!file) return
    if (isMysql.value) {
      const rows = sqlRowsFromFile(file)
      edit.value = { mode: 'import', text: JSON.stringify(rows, null, 2), count: rows.length }
    } else {
      const raw: unknown = JSON.parse(file.text)
      const documents = Array.isArray(raw) ? raw : [raw]
      if (!documents.length || documents.length > 500) throw new Error('每批导入 1–500 条 EJSON 文档')
      edit.value = { mode: 'import', text: JSON.stringify(documents, null, 2), count: documents.length }
    }
    editError.value = ''
  } catch (reason) { setError(reason) }
}
async function exportData(format: 'csv' | 'json') {
  if (!result.value) return
  try {
    if(props.session.kind==='sqlite'&&result.value.rows.length&&!result.value.rawRows)throw new Error('SQLite 无法无损导出当前结果；请使用数据库备份。')
    const content = format === 'json'
      ? isMongo.value && result.value.documents ? '[' + result.value.documents.join(',\n') + ']' : JSON.stringify(result.value.rawRows || result.value.rows, null, 2)
      : csvFromRows(result.value.columns, result.value.rawRows || result.value.rows)
    if (await window.dbex.exportFile(`${entity.value.entity || 'query'}-page.${format}`, content, format)) notice.value = `已导出当前页 ${result.value.rows.length} 条记录`
  } catch (reason) { setError(reason) }
}
async function createIndex() {
  if (!await confirmWrite('创建索引', `${entityTitle()}\n索引定义：${indexKeys.value}\n选项：${indexOptions.value}`)) return
  const next = await execute({ action: 'mongo.createIndex', ...entity.value, keys: indexKeys.value, options: indexOptions.value, confirmed: true }, false)
  if (next) { indexDialog.value = false; await loadStructure() }
}
async function dropIndex() {
  const name = structure.value?.rows[selectedRow.value]?.name
  if (!name || name === '_id_') return
  if (!await confirmWrite('删除索引', `${entityTitle()}\n删除索引 ${name}，可能影响查询性能。`)) return
  if (await execute({ action: 'mongo.dropIndex', ...entity.value, name, confirmed: true }, false)) await loadStructure()
}
async function openHistory() {
  historyOpen.value = true; historyError.value = ''
  try { snippets.value = await window.dbex.listSnippets() } catch (reason) { historyError.value = messageOf(reason) }
}
async function favorite(item?: QuerySnippet) {
  try {
    const saved = await window.dbex.saveSnippet(item ? { ...item, favorite: !item.favorite } : { name: snippetName.value.trim() || t('未命名查询'), kind: props.session.kind, database: entity.value.database, text: isMysql.value ? sql.value : pipeline.value, ...(isMysql.value?{parameters:parameters.value}:{}), ...(isMongo.value ? { mongoKind: 'aggregation' as const, entity: entity.value.entity, connectionId: props.session.connectionId } : {}), favorite: true })
    snippets.value = [saved, ...snippets.value.filter(value => value.id !== saved.id)]
    snippetName.value = ''
  } catch (reason) { historyError.value = messageOf(reason) }
}
async function removeSnippet(item: QuerySnippet) {
  try { await window.dbex.deleteSnippet(item.id); snippets.value = snippets.value.filter(value => value.id !== item.id) }
  catch (reason) { historyError.value = messageOf(reason) }
}
function useSnippet(item: QuerySnippet) {
  if (isMongo.value && item.entity && item.entity!==entity.value.entity) { historyError.value='请选择目标集合或视图。'; return }
  if (isMysql.value) { sql.value = item.text; parameters.value=item.parameters||'[]'; tab.value = 'query' } else { pipeline.value = item.text; tab.value = 'aggregation' }
  historyOpen.value = false
}
async function scanRedis(cursor = '0', navigation: 'reset' | 'next' | 'previous' | 'first' = 'reset') {
  if (busy.value) return
  const version = generation
  const target = navigation === 'reset' ? { pattern: redisPattern.value, node: redisNode.value } : { ...appliedRedisScan }
  const next = await execute({ action: 'redis.scan', cursor, pattern: target.pattern, node: target.node || undefined })
  if (!next || version !== generation) return
  redisDetail.value = null; redisKey.value = ''
  if (navigation === 'reset') { appliedRedisScan = target; redisScanCursors.value = ['0']; redisScanIndex.value = 0 }
  else if (navigation === 'next') { redisScanCursors.value = [...redisScanCursors.value.slice(0, redisScanIndex.value + 1), cursor]; redisScanIndex.value++ }
  else if (navigation === 'previous') redisScanIndex.value = Math.max(0, redisScanIndex.value - 1)
  else redisScanIndex.value = 0
}
async function openRedis(key?: string, cursor?: string, nextOffset?: number) {
  const target = key || redisKey.value
  if (!target) return
  selectedRow.value = result.value?.rows.findIndex(row => row.key === target) ?? -1
  redisKey.value = target
  const next = await execute({ action: 'redis.get', key: target, cursor, offset: nextOffset }, false)
  if (next && redisKey.value === target) {
    redisDetail.value = next
    const type = next.redisType as RedisValueType | undefined
    if (type && mutationCommands[type]) redisType.value = type
    redisText.value = next.value || ''
    const ttl = next.ttl
    if (ttl !== undefined) redisTtl.value = ttl === -2 ? -1 : ttl
  }
}
async function saveRedisString() {
  if (redisDetail.value?.truncated) { error.value = '该 String 超过安全编辑上限，请使用其他工具处理大值。'; return }
  if (!redisKey.value || !await confirmWrite('保存 Redis String', `${redisKey.value}\nTTL：${redisTtl.value === -1 ? '永久' : redisTtl.value + ' 秒'}`)) return
  if (await execute({ action: 'redis.set', key: redisKey.value, value: redisText.value, ttl: redisTtl.value, expected: redisDetail.value?.redisType === 'string' ? redisDetail.value.value : undefined, confirmed: true }, false)) await openRedis()
}
function stringArgs(text: string): string[] {
  const args: unknown = JSON.parse(text)
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('参数需要 JSON 字符串数组，例如 ["field", "value"]')
  return args
}
async function mutateRedis() {
  try {
    const args = stringArgs(redisArguments.value)
    if (!redisKey.value || !await confirmWrite(`执行 ${redisMutation.value}`, `${redisKey.value}\n参数：${redisArguments.value}`)) return
    if (await execute({ action: 'redis.mutate', key: redisKey.value, type: redisType.value, command: redisMutation.value, args, confirmed: true }, false)) await openRedis()
  } catch (reason) { setError(reason) }
}
async function setTtl() {
  if (!redisKey.value || !await confirmWrite('修改 TTL', `${redisKey.value}\n${redisTtl.value === -1 ? '移除过期时间' : `${redisTtl.value} 秒后过期`}`)) return
  if (await execute({ action: 'redis.ttl', key: redisKey.value, ttl: redisTtl.value, confirmed: true }, false)) await openRedis()
}
async function deleteKeys() {
  const keys = checked.value.map(index => result.value?.rows[index]?.key).filter((key): key is string => typeof key === 'string')
  if (!keys.length || !await confirmWrite('批量删除 Redis Key', `将删除当前页选中的 ${keys.length} 个 Key：\n${keys.slice(0, 15).join('\n')}${keys.length > 15 ? '\n…' : ''}`)) return
  if (await execute({ action: 'redis.delete', keys, confirmed: true }, false)) await scanRedis()
}
async function runRedisCommand() {
  try {
    const args = stringArgs(redisCommand.value)
    if (props.session.writable && !await confirmWrite('执行 Redis 命令', redisCommand.value)) return
    await execute({ action: 'redis.command', args, confirmed: props.session.writable })
  } catch (reason) { setError(reason) }
}
function checkRow(index: number) {
  if (!checked.value.includes(index) && checked.value.length >= 100) { error.value = '每批最多选择 100 个明确 Key'; return }
  checked.value = checked.value.includes(index) ? checked.value.filter(value => value !== index) : [...checked.value, index]
}
function checkAll() { checked.value = checked.value.length === Math.min(100, result.value?.rows.length || 0) ? [] : (result.value?.rows.slice(0, 100).map((_, index) => index) || []) }
async function changeTab(value: WorkbenchTab) {
  if(!guardGridDraft())return
  tab.value = validWorkbenchTab(props.session.kind,value,props.node?.readOnly); selectedRow.value = -1
  if (value === 'structure') await loadStructure()
  else if (value === 'data' && hasEntity.value) await loadData()
}
watch(redisKey, () => { redisDetail.value = null; redisText.value = ''; redisTtl.value = -1; redisType.value = 'string' })
watch(redisType, type => { redisMutation.value = mutationCommands[type][0] })
async function refreshSelection(version: number) {
  if (version !== generation || disposed || busy.value) return
  if (isMysql.value && props.node?.kind === 'database-query') { tab.value='query';return }
  if (hasEntity.value) {
    if (props.node?.kind === 'mongo-indexes') { tab.value='structure';await loadStructure();return }
    if(isMysql.value||tab.value==='structure'){
      await loadStructure()
      if(version!==generation||disposed)return
    }
    if(tab.value==='data')await loadData()
  }else if(isRedis.value&&props.node&&tab.value==='data'){
    const nodes=await execute({action:'redis.nodes'},false)
    if(version!==generation||disposed)return
    redisNodes.value=(nodes?.rows||[]).map(row=>row.node||row.id||row.address).filter(Boolean)
    await scanRedis()
  }
}
watch(()=>props.node?.id,()=>{
  generation++
  const restored=firstSelection?validWorkbenchTab(props.session.kind,props.initialTab,props.node?.readOnly):'data'
  firstSelection=false;tab.value=restored
  if(isMysql.value&&props.node?.kind==='database-query')tab.value='query'
  // Never carry unsaved SQL, parameters or aggregation text into a different
  // database/object scope. The recovery watcher keeps the previous draft.
  if(editorScopeKey!==undefined){
    const draft={sql:sql.value,parameters:parameters.value,pipeline:pipeline.value,filter:filter.value,projection:projection.value,sort:sort.value}
    editorCache.delete(editorScopeKey)
    if(JSON.stringify(draft).length<=200000)editorCache.set(editorScopeKey,draft)
    if(editorCache.size>30)editorCache.delete(editorCache.keys().next().value!)
  }
  editorScopeKey=JSON.stringify([props.node?.database||'',props.node?.entity||'',props.node?.kind||''])
  const remembered=editorCache.get(editorScopeKey)
  sql.value=remembered?.sql??(hasEntity.value&&isMysql.value?'SELECT * FROM '+quote(entity.value.database)+'.'+quote(entity.value.entity)+';':'SELECT 1 AS result;')
  parameters.value=remembered?.parameters??'[]';lastQuery=undefined;pipeline.value=remembered?.pipeline??'[\n  { "$limit": 100 }\n]'
  browsePageSize.value=pageSizeFor(preferences.value,props.session.kind);customSize.value=browsePageSize.value;browseVisited.value={1:0};profileDialog.value=false;fileWizard.value=undefined
  redisScanCursors.value=['0'];redisScanIndex.value=0
  visualFilter.value=newBrowseFilter();appliedMysql.value=newBrowseFilter();appliedMongo.value={filter:'{}',projection:'{}',sort:'{}'}
  filter.value=remembered?.filter??'{}';projection.value=remembered?.projection??'{}';sort.value=remembered?.sort??'{}';filterMode.value=remembered&&(remembered.filter!=='{}'||remembered.projection!=='{}'||remembered.sort!=='{}')?'text':'builder';filterError.value=''
  totalRows.value=undefined;countLimited.value=false;pageInput.value=1;sqlQuerySummary.value='';sqlQueryParameters.value=[]
  gridDrafts.value=[];inlineCell.value=undefined;columnDraft.value=undefined;fieldDialog.value=undefined;gridLayout.value=undefined;lastGridLayout=undefined;gridUncertain.value=false;gridNeedsRefresh.value=false;gridScope.value={kind:'row',row:-1};
  edit.value=null;documentView.value=undefined;mongoQuery.value='';result.value=null;structure.value=null;primaryKeys.value=[];selectedRow.value=-1;checked.value=[];offset.value=0;editableRows.value=false
  if(busy.value){pendingSelection=true;return}
  void refreshSelection(generation)
},{immediate:true})
watch(tab,value=>emit('tabChange',value),{immediate:true})
watch(()=>props.tabRequest,()=>{if(props.requestedTab)void changeTab(validWorkbenchTab(props.session.kind,props.requestedTab,props.node?.readOnly))})
const savedScope=()=>props.session.connectionId?{connectionId:props.session.connectionId,database:entity.value.database,entity:entity.value.entity}:undefined
const recovery=useQueryRecovery(()=>{
  const scope=savedScope();return scope&&isMysql.value?{...scope,kind:props.session.kind==='sqlite'?'sqlite-query':props.session.kind==='mariadb'?'mariadb-query':'mysql-query'}:undefined
},()=>JSON.stringify({sql:sql.value,parameters:parameters.value}),text=>{
  try{const parsed=JSON.parse(text);if(typeof parsed.sql==='string'&&typeof parsed.parameters==='string'){sql.value=parsed.sql;parameters.value=parsed.parameters}}catch{}
})
const mongoRecovery=useQueryRecovery(()=>{
  const scope=savedScope();return scope&&isMongo.value&&hasEntity.value&&!libraryKind.value?{...scope,kind:'mongo-pipeline'}:undefined
},()=>pipeline.value,text=>{pipeline.value=text})
const mongoFindRecovery=useQueryRecovery(()=>{
  const scope=savedScope();return scope&&isMongo.value&&hasEntity.value&&!libraryKind.value?{...scope,kind:'mongo-query'}:undefined
},()=>JSON.stringify({filter:filter.value,projection:projection.value,sort:sort.value}),text=>{
  try{const value=JSON.parse(text);if(typeof value.filter==='string'&&typeof value.projection==='string'&&typeof value.sort==='string'){filter.value=value.filter;projection.value=value.projection;sort.value=value.sort;filterMode.value='text';showMongoFilters.value=true}}catch{}
})
const redisRecovery=useQueryRecovery(()=>{
  const scope=savedScope();return scope&&isRedis.value?{...scope,entity:'',kind:'redis-command'}:undefined
},()=>redisCommand.value,text=>{redisCommand.value=text})
const recordRecovery=useQueryRecovery(()=>{
  const scope=savedScope();return scope&&hasEntity.value&&!props.node?.readOnly&&!libraryKind.value&&(isMysql.value||isMongo.value)?{...scope,kind:'record-edit'}:undefined
},()=>edit.value?JSON.stringify(edit.value):'',text=>{
  const value=JSON.parse(text)
  if(!value||!['insert','update','import'].includes(value.mode)||typeof value.text!=='string')throw new Error('INVALID_RECOVERY: 查询草稿参数无效')
  const restored:NonNullable<typeof edit.value>={mode:value.mode,text:value.text}
  if(value.mode==='update'){
    if(isMysql.value)restored.original=validateSqlRow(value.original)
    else if(typeof value.originalDocument==='string')restored.originalDocument=value.originalDocument
    else throw new Error('INVALID_RECOVERY: 查询草稿参数无效')
  }
  if(isMongo.value)restored.syntax=value.syntax==='typed'?'typed':'ejson'
  if(value.mode==='import'&&Number.isSafeInteger(value.count)&&value.count>=1&&value.count<=500)restored.count=value.count
  editError.value='';editNotice.value='';edit.value=restored;tab.value='data'
})
function closeEdit(){edit.value=null;recordRecovery.clear()}
watch(()=>preferences.value.records,()=>{limit.value=pageSizeFor(preferences.value,props.session.kind)},{deep:true})
onBeforeUnmount(() => { disposed = true; generation++; if (inspectionTimer) clearTimeout(inspectionTimer) })
</script>

<template>
  <div class="workbench-shell"><MongoSavedObjects v-if="isMongo && libraryKind && node?.database" :key="node.id" :session="session" :database="node.database" :kind="libraryKind" :busy="busy" @busy-change="libraryBusy=$event" @disconnect="cancel" :run="async op => { const next=await execute(op,false); if(!next)throw new Error(error || '操作失败'); return next }" /><div v-else :class="['workbench', { 'mongo-workbench': isMongo }]">
    <MariaObjectDialog v-if="mariaObjectOpen&&node" :session="session" :node="node" @close="mariaObjectOpen=false" @session="emit('updateSession',$event)" @disconnect="emit('disconnect')"/><header class="workbench-header"><div><h2>{{ node?.kind === 'mongo-category' || node?.kind === 'database-query' ? t(node.label) : node?.label || session.name }}</h2></div><div class="header-tools"><span v-if="session.transaction" class="transaction-badge">{{ t('事务进行中') }}</span><span v-if="node?.readOnly" class="muted-text">{{ t('只读对象') }}</span><button v-else :class="['btn', session.writable ? 'warning' : 'secondary']" :disabled="busy" @click="toggleWrite">{{ session.writable ? t('写入已启用 · 锁定') : t('只读 · 启用写入') }}</button></div></header>
    <nav class="workbench-tabs"><button :disabled="busy" :class="{ active: tab === 'data' }" @click="changeTab('data')">{{ isRedis ? t('Key 浏览器') : t('数据') }}</button><button v-if="isMysql" :disabled="busy" :class="{ active: tab === 'query' }" @click="changeTab('query')">{{ t('SQL 编辑器') }}</button><button v-if="isMongo" :disabled="busy" :class="{ active: tab === 'aggregation' }" @click="changeTab('aggregation')">Aggregation</button><button v-if="!isRedis && !node?.readOnly" :disabled="busy" :class="{ active: tab === 'structure' }" @click="changeTab('structure')">{{ isMysql ? t('结构与索引') : t('索引') }}</button><button v-if="isRedis" :disabled="busy" :class="{ active: tab === 'console' }" @click="changeTab('console')">{{ t('命令台') }}</button><button v-if="session.kind==='mariadb'&&node?.kind==='table'" :disabled="busy" @click="mariaObjectOpen=true">{{t(node.objectType==='sequence'?'序列状态':node.objectType==='system-versioned'?'历史版本':'分区')}}…</button><div class="tab-filler"></div><button :class="{ active: inspectorTab === 'info' }" @click="openInspector('info')">{{ t('对象信息') }}</button><button :class="{ active: inspectorTab === 'ddl' }" @click="openInspector('ddl')">{{ isRedis ? t('检查命令') : 'DDL' }}</button><button :class="{ active: inspectorTab === 'colors' }" @click="openInspector('colors')">{{ isMongo ? t('BSON 类型配色') : t('数据类型配色') }}</button><button v-if="!isRedis" @click="openHistory">{{ t('历史 / 收藏') }}</button></nav>
    <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div>
    <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
    <p v-if="recordRecovery.error.value" class="compact-help">{{ t(recordRecovery.error.value) }}</p>
    <div v-if="recordRecovery.available.value" class="recovery-banner"><span>{{ t('发现未保存的记录编辑草稿') }}</span><button class="btn secondary small" :disabled="!canWrite||busy||!!edit" @click="recordRecovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" :disabled="busy||!!edit" @click="recordRecovery.dismiss">{{ t('放弃草稿') }}</button><span v-if="!canWrite" class="muted-text">{{ t('当前会话只读，请先点击右上角“启用写入”。') }}</span></div><p v-if="node?.kind === 'gridfs-bucket'" class="compact-help">{{ t('GridFS 文件元数据浏览；暂不支持文件上传、下载和删除。') }}</p><p v-if="node?.kind === 'mongo-function'" class="compact-help">{{ t('仅查看已存储的函数，不执行服务器端 JavaScript。') }}</p>
    <div v-if="busy" class="operation-progress"><span class="progress-indicator"></span> {{ t('正在执行') }} <button v-if="tab !== 'data' || isRedis || session.kind==='sqlite'" class="btn secondary small" @click="cancel">{{ t('取消并断开') }}</button></div>

    <template v-if="isMysql && tab === 'query'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy" @click="runQuery()">{{ t('运行选中 / 全部') }} <kbd>⌘ / Ctrl ↵</kbd></button><button class="btn secondary" :disabled="busy" @click="beautifySql">{{ t('美化语句') }}</button><label class="inline-field">{{ t('每页') }}<select v-model.number="limit"><option :value="100">100</option><option :value="200">200</option><option :value="500">500</option><option v-if="![100,200,500].includes(browsePageSize)" :value="browsePageSize">{{browsePageSize}}</option></select></label><span class="toolbar-spacer"></span><button v-if="capabilities.transactions" class="btn secondary" :disabled="busy || !canWrite || session.transaction" @click="transaction('mysql.begin')">{{ t('开始事务') }}</button><button v-if="capabilities.transactions" class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.commit')">{{ t('提交') }}</button><button v-if="capabilities.transactions" class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.rollback')">{{ t('回滚') }}</button></div>
      <p v-if="recovery.error.value && tab==='query'" class="compact-help">{{ t(recovery.error.value) }}</p><div v-if="recovery.available.value && tab==='query'" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="recovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="recovery.dismiss">{{ t('放弃草稿') }}</button></div><div class="query-editor"><CodeEditor ref="sqlEditor" v-model="sql" language="sql" :sql-dialect="session.kind==='mongodb'||session.kind==='redis'?undefined:session.kind" :suggestions="structure?.rows.map(row => row.Field || row.name || '') || []" :table-suggestions="tableSuggestions" @execute="runQuery()" /></div>
      <label class="parameter-line">{{ t('参数') }} <input v-model="parameters" :aria-label="t('SQL 参数 JSON 数组')" placeholder='["value", 123]' spellcheck="false" /><span>{{ t('用 ? 绑定参数；每次仅执行一条 SQL') }}</span></label>
    </template>
    <template v-if="isMongo && tab === 'aggregation'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy || !hasEntity" @click="runAggregation">{{ t('运行 Aggregation') }}</button><span class="muted-text">{{ t('EJSON 管道 · 禁止 $out / $merge · 最多') }} {{ limit }} {{ t('条') }}</span></div>
      <p v-if="mongoRecovery.error.value && tab==='aggregation'" class="compact-help">{{ t(mongoRecovery.error.value) }}</p><div v-if="mongoRecovery.available.value && tab==='aggregation'" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="mongoRecovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="mongoRecovery.dismiss">{{ t('放弃草稿') }}</button></div><div class="query-editor"><CodeEditor v-model="pipeline" language="json" completion-kind="mongodb" :suggestions="result?.columns || []" @execute="runAggregation" /></div>
    </template>
    <template v-if="isRedis && tab === 'console'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy" @click="runRedisCommand">{{ t('执行命令') }}</button><span class="muted-text">{{ t('JSON 参数数组 · 只读状态仅允许受控读取命令') }}</span></div>
      <p v-if="redisRecovery.error.value" class="compact-help">{{ t(redisRecovery.error.value) }}</p><div v-if="redisRecovery.available.value" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="redisRecovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="redisRecovery.dismiss">{{ t('放弃草稿') }}</button></div><div class="query-editor"><CodeEditor v-model="redisCommand" completion-kind="redis" language="json" @execute="runRedisCommand" /></div>
    </template>
    <template v-if="tab === 'structure'">
      <div class="editor-toolbar"><button class="btn secondary" :disabled="busy || !hasEntity" @click="loadStructure">{{ t('刷新结构') }}</button><template v-if="capabilities.graphicalIndexes"><button class="btn secondary" :disabled="busy || !hasEntity || !canWrite" @click="indexDialog = true">{{ t('新建索引') }}</button><button class="btn danger-text" :disabled="busy || !canWrite || selectedRow < 0" @click="dropIndex">{{ t('删除选中索引') }}</button></template><span v-if="isMysql" class="muted-text">{{ t('主键：') }}{{ primaryKeys.join(', ') || t('无（记录修改已禁用）') }}</span></div>
      <ResultGrid v-if="structure" :columns="structure.columns" :rows="structure.rows" :selected="selectedRow" :bson-types="isMongo ? structure.bsonTypes : undefined" :documents="isMongo ? structure.documents : undefined" @select="selectedRow = $event" />
      <div v-else class="empty-state"><strong>{{ t('选择表或集合查看结构') }}</strong><span>{{ t('从左侧资源树选择一个对象。') }}</span></div>
    </template>
    <template v-else-if="isRedis && tab === 'data'">
      <div class="editor-toolbar"><input v-model="redisPattern" :aria-label="t('Redis Key 匹配模式')" placeholder="Key pattern: user:*" @keyup.enter="scanRedis()" /><select v-if="redisNodes.length > 1" v-model="redisNode" :aria-label="t('Cluster 节点')"><option value="">{{ t('默认节点') }}</option><option v-for="nodeName in redisNodes" :key="nodeName" :value="nodeName">{{ nodeName }}</option></select><button class="btn primary" :disabled="busy" @click="scanRedis()">{{ t('扫描 Key') }}</button><button class="btn danger-text" :disabled="busy || !canWrite || !checked.length" @click="deleteKeys">{{ t('删除选中') }} {{ checked.length || '' }}</button></div>
      <div class="redis-split"><div class="redis-key-list"><ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :redis-row-types="result.redisRowTypes" :active="active!==false" :checked="checked" :selected="selectedRow" selectable @check="checkRow" @check-all="checkAll" @select="selectedRow = $event" @open="openRedis(result.rows[$event].key)" /><div class="result-footer"><span>{{ t('双击 Key 打开 · 当前页') }} {{ result?.rows.length || 0 }} {{ t('个') }}</span><div class="browse-page-buttons"><button type="button" class="browse-icon" :aria-label="t('首批')" :title="t('首批')" :disabled="busy || redisScanIndex === 0" @click="scanRedis('0', 'first')">|‹</button><button type="button" class="browse-icon" :aria-label="t('上一批')" :title="t('上一批')" :disabled="busy || redisScanIndex === 0" @click="scanRedis(redisScanCursors[redisScanIndex - 1], 'previous')">‹</button><span>{{ redisScanIndex + 1 }}</span><button type="button" class="browse-icon" :aria-label="t('下一批 →')" :title="t('下一批 →')" :disabled="busy || !result?.nextCursor" @click="result?.nextCursor && scanRedis(result.nextCursor, 'next')">›</button></div></div></div>
        <section class="redis-inspector"><div class="editor-toolbar"><input v-model="redisKey" :aria-label="t('Redis Key 名称')" :placeholder="t('输入 Key 或双击左侧列表')" @keyup.enter="openRedis()" /><button class="btn secondary" :disabled="busy || !redisKey" @click="openRedis()">{{ t('读取') }}</button></div><div class="editor-toolbar"><label class="inline-field">{{ t('类型') }}<select v-model="redisType"><option v-for="kind in Object.keys(mutationCommands)" :key="kind" :value="kind">{{ kind }}</option></select></label><label class="inline-field">{{ t('TTL（秒）') }}<input v-model.number="redisTtl" type="number" min="-1" /></label><button class="btn secondary" :disabled="busy || !canWrite || !redisKey" @click="setTtl">{{ t('保存 TTL') }}</button></div><p class="compact-help">{{ t('TTL = -1 永久，其他值须大于 0。列表与集合按页读取。') }}</p>
          <template v-if="redisType === 'string'"><div class="redis-value-editor"><CodeEditor v-model="redisText" language="plaintext" /></div><div class="editor-toolbar"><button class="btn primary" :disabled="busy || !canWrite || !redisKey || !!redisDetail?.truncated" @click="saveRedisString">{{ t('保存 String') }}</button></div></template>
          <template v-else><ResultGrid v-if="redisDetail" :columns="redisDetail.columns" :rows="redisDetail.rows" :redis-row-types="redisDetail.redisRowTypes" /><div v-if="redisDetail?.nextCursor || redisDetail?.nextOffset !== undefined" class="editor-toolbar"><button class="btn secondary" :disabled="busy" @click="openRedis(undefined, redisDetail?.nextCursor, redisDetail?.nextOffset)">{{ t('下一页元素 →') }}</button></div><div class="editor-toolbar"><select v-model="redisMutation" :aria-label="t('Redis 修改命令')"><option v-for="command in mutationCommands[redisType]" :key="command">{{ command }}</option></select><button class="btn primary" :disabled="busy || !canWrite || !redisKey" @click="mutateRedis">{{ t('执行修改') }}</button></div><label class="field mutation-arguments">{{ t('参数（不含命令与 Key）') }}<textarea v-model="redisArguments" rows="3" spellcheck="false" /></label><p class="compact-help">HSET: ["field", "value"] · LPUSH / SADD: ["value"]<br />ZADD: ["1", "member"] · XADD: ["*", "field", "value"]</p></template>
        </section>
      </div>
    </template>
    <template v-else>
      <div class="editor-toolbar browser-top-toolbar"><template v-if="tab === 'data' && !isRedis"><button v-if="fileTransferSupported(session.kind)" class="btn secondary small" :disabled="busy||!hasEntity||gridDirty||node?.readOnly" @click="fileWizard='import'">{{t('流式导入向导')}}</button><button v-if="fileTransferSupported(session.kind)" class="btn secondary small" :disabled="busy||!hasEntity||gridDirty" @click="fileWizard='export'">{{t('流式导出向导')}}</button><button v-if="session.connectionId" class="btn secondary small" :disabled="busy||!hasEntity||gridDirty" @click="profileDialog=true">{{t('浏览配置')}}</button><button class="btn secondary small" :aria-label="t('编辑')" :disabled="busy || !canEditRow || !canWrite" @click="openEdit"><span aria-hidden="true">✎</span> {{ t('编辑') }}</button><button class="btn secondary small" :aria-label="t('查询条件')" :aria-expanded="showMongoFilters" :class="{ 'active-filter': filtersActive || showMongoFilters }" @click="showMongoFilters = !showMongoFilters"><span aria-hidden="true">⌕</span> {{ t('查询条件') }} <span v-if="filtersActive" aria-hidden="true">•</span></button><button class="btn secondary small" :disabled="busy || !hasEntity || !canImportRecords" @click="importData">{{ t('导入') }} {{ isMysql ? 'CSV / JSON' : 'EJSON' }}</button></template><button v-if="isMongo && tab !== 'data'" class="btn secondary small" :disabled="selectedRow < 0 || !result?.documents?.[selectedRow]" @click="viewMongoDocument()">{{ t('查看文档') }}</button><span class="toolbar-spacer"></span><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('json')">{{ t('导出当前页 JSON') }}</button><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('csv')">CSV</button></div>
      <section v-if="tab === 'data' && !isRedis && showMongoFilters" class="browse-filter-panel">
        <header class="filter-panel-header"><span>{{ t('查询条件') }}</span><div v-if="isMongo" class="filter-mode-switch"><button type="button" :class="{ active: filterMode === 'builder' }" @click="filterMode = 'builder'">{{ t('创建工具') }}</button><button type="button" :class="{ active: filterMode === 'text' }" @click="filterMode = 'text'">{{ t('文本') }}</button></div></header>
        <div v-if="filterError" class="inline-message error" role="alert">{{ localize(filterError) }}</div><p v-if="mongoFindRecovery.error.value" class="compact-help">{{ t(mongoFindRecovery.error.value) }}</p><div v-if="mongoFindRecovery.available.value" class="recovery-banner"><span>{{ t('发现未恢复的查询草稿') }}</span><button class="btn secondary small" @click="mongoFindRecovery.restore">{{ t('恢复草稿') }}</button><button class="btn secondary small" @click="mongoFindRecovery.dismiss">{{ t('放弃草稿') }}</button></div>
        <VisualQueryBuilder v-if="isMysql || filterMode === 'builder'" v-model="visualFilter" :kind="isMysql ? 'mysql' : 'mongodb'" :key="node?.id" :fields="browseFields" :suggestions="field => filterSuggestions(result, field, isMongo)" :disabled="busy || !hasEntity" @apply="applyVisualFilter" @reset="resetBrowseFilter" />
        <div v-else class="mongo-filters"><label>Filter<textarea v-model="filter" rows="3" spellcheck="false" /></label><label>Projection<textarea v-model="projection" rows="3" spellcheck="false" /></label><label>Sort<textarea v-model="sort" rows="3" spellcheck="false" /></label><button class="btn primary" :disabled="busy || !hasEntity" @click="applyTextFilter">{{ t('查询') }}</button><button class="btn secondary" :disabled="busy || !hasEntity" @click="resetBrowseFilter">{{ t('重置筛选') }}</button></div>
      </section>
      <div v-if="columnDraft" class="editor-toolbar grid-batch-editor"><strong>{{ columnDraft.field }}</strong><span class="muted-text">{{ t('当前页') }} · {{ result?.rows.length||0 }} {{ t('条记录') }}</span><input :value="columnDraft.text" :aria-label="t('整列修改值')" spellcheck="false" @input="columnDraft.text=($event.target as HTMLInputElement).value;columnDraft.changed=true" @keydown.enter.prevent="stageColumn" @keydown.esc.prevent="columnDraft=undefined" /><button class="btn secondary small" @click="stageColumn">{{ t('暂存修改') }}</button></div>
      <BrowseRecordView v-if="result && tab === 'data' && !isRedis && browseView !== 'grid'" :result="result" :selected="selectedRow" :mongo="isMongo" :mode="browseView" :offset="offset" @select="selectedRow = $event" @open="viewMongoDocument" @field="openField" />
      <ResultGrid v-else-if="result" :workspace-tools="tab==='data'&&!isRedis" :layout-scope="tab==='data'?gridLayoutScope:undefined" :layout-value="gridLayout" :exact-cell="exactCell" :editable-cell-text="gridEditingEnabled?(row,field)=>spec(row,field)?.text:undefined" @layout-change="rememberGridLayout" @stage-cells="stageCells" @cell-view="openField" :columns="result.columns" :rows="result.rows" :column-types="isMysql ? result.columnTypes : undefined" :relational-kind="session.kind==='mariadb'?'mariadb':'mysql'" :sqlite-types="result.sqliteTypes" :null-cells="result.nullCells" :redis-row-types="isRedis ? result.redisRowTypes : undefined" :selected="selectedRow" :offset="offset" :bson-types="isMongo ? result.bsonTypes : undefined"  :documents="isMongo ? result.documents : undefined" :document-menu="isMongo && !!result.documents?.length && !busy" :can-edit-document="isMongo && tab === 'data' && editableRows && canWrite && !busy" :can-add-document="isMongo && tab === 'data' && hasEntity && canWrite && !busy" :can-filter-document="isMongo && tab === 'data' && hasEntity && !busy" :active="active!==false" :action-columns="columnActionFields" :column-sort="tab==='data'?activeSortRules:[]" @column-action="handleColumnAction" :inline-cell="inlineCell" :inline-drafts="previewDraftMap" :can-inline-edit="canInlineEdit" :can-edit-column="canEditColumn" @inline-begin="beginInline" @inline-input="text=>{if(inlineCell)inlineCell.text=text}" @inline-finish="finishInline" @column-selected="selectGridColumn" @column-edit="beginColumn" @document-action="mongoContextAction" @document-edit="editMongoRow" @document-view="viewMongoDocument" @select="selectGridRow" @open="openResultRow" />
      <div v-else class="empty-state"><span class="empty-icon">▤</span><strong>{{ hasEntity ? t('运行查询查看结果') : t('选择数据库中的表或集合') }}</strong><span>{{ isMysql ? t('可直接切换到 SQL 编辑器执行查询。') : t('使用左侧资源树选择目标。') }}</span></div>
      <footer v-if="tab === 'data' && !isRedis" class="result-footer browse-footer">
        <div class="browse-record-actions">
          <button class="browse-icon" type="button" :title="t('新增')" :aria-label="t('新增')" :disabled="busy || !hasEntity || !canInsertRecord" @click="openInsert">＋</button>
          <button class="browse-icon" type="button" :title="t('删除')" :aria-label="t('删除')" :disabled="busy || !canEditRow || !canWrite" @click="deleteRow">−</button>
          <button class="browse-icon grid-save" type="button" :aria-label="t('保存表格修改')" :title="t('保存表格修改')" :disabled="busy||!scopeHasEdits||!canWrite||gridUncertain" @click="saveGridScope()">✓</button>
          <button class="browse-icon grid-discard" type="button" :aria-label="t('取消表格修改')" :title="t('取消表格修改')" :disabled="busy||!scopeHasEdits" @click="discardGridScope">×</button>
          <button v-if="gridScope.kind==='column'" class="btn secondary small" :disabled="!canEditColumn(gridScope.field)||!!columnDraft" @click="beginColumn(gridScope.field)">{{ t('修改整列') }}</button>
          <button v-if="gridDrafts.length>0" class="btn secondary small" :disabled="busy||!gridCanWrite" @click="saveGridScope(true)">{{t('保存全部修改')}}</button><button v-if="gridDrafts.length>0||gridUncertain" class="btn secondary small" :disabled="busy" @click="discardAllGrid">{{ t('取消全部修改') }}</button>
          <button class="browse-icon" type="button" :title="t('刷新')" :aria-label="t('刷新')" :disabled="busy || !hasEntity" @click="loadData(offset)">↻</button>
          <button class="browse-icon" type="button" :title="t('取消并断开')" :aria-label="t('取消并断开')" :disabled="!busy" @click="cancel">■</button>
        </div>
        <span v-if="gridDirty" class="grid-pending-indicator" :title="t('待保存修改')">{{ t('待保存修改') }} · {{ gridDrafts.length }}<template v-if="gridScope.kind==='column'"> · {{ gridScope.field }}</template></span>
        <span v-if="isMongo && mongoQuery" class="mongo-query-summary" dir="ltr" :title="mongoQuery">{{ mongoQuery }}</span><span v-else-if="isMysql && sqlQuerySummary" class="mongo-query-summary" dir="ltr" :title="sqlQuerySummary + (sqlQueryParameters.length ? '\n' + JSON.stringify(sqlQueryParameters) : '')">{{ sqlQuerySummary }}</span><span v-else class="toolbar-spacer"></span>
        <span class="browse-count">{{ result?.rows.length || 0 }} {{ t('条记录') }}<template v-if="totalRows"> / {{ countLimited ? '≥' : '' }}{{ totalRows }}</template></span>
        <div class="browse-page-buttons">
          <button class="browse-icon" type="button" :aria-label="t('首页')" :title="t('首页')" :disabled="busy || offset === 0" @click="loadData(0)">|‹</button>
          <button class="browse-icon" type="button" :aria-label="t('上一页')" :title="t('上一页')" :disabled="busy || offset === 0" @click="loadData(previousBrowseOffset)">‹</button>
          <form class="browse-page-input" @submit.prevent="jumpPage"><input v-model.number="pageInput" :aria-label="t('页码')" type="number" min="1" :max="Math.floor(1000000 / browsePageSize) + 1" :disabled="busy || !hasEntity" /></form>
          <button class="browse-icon" type="button" :aria-label="t('下一页')" :title="t('下一页')" :disabled="busy || result?.nextOffset === undefined || result.nextOffset > 1000000" @click="result?.nextOffset !== undefined && loadData(result.nextOffset)">›</button>
          <button class="browse-icon" type="button" :aria-label="t('末页')" :title="t('末页')" :disabled="busy || !hasEntity" @click="lastBrowsePage">›|</button>
          <label class="inline-field browse-page-size" :title="t('每页')"><span aria-hidden="true">⚙</span><select :value="browsePageSize" :aria-label="t('每页')" :disabled="busy || !hasEntity" @change="changeBrowseSize"><option :value="100">100</option><option :value="200">200</option><option :value="500">500</option><option v-if="![100,200,500].includes(browsePageSize)" :value="browsePageSize">{{browsePageSize}}</option></select></label>
        </div>
        <form class="browse-page-input" @submit.prevent="loadData(0,appliedMongo,appliedMysql,customSize)"><input v-model.number="customSize" type="number" min="1" max="500" :title="t('自定义每页数量')" :aria-label="t('自定义每页数量')" :disabled="busy"/><button class="browse-icon" :disabled="busy||!Number.isInteger(customSize)||customSize<1||customSize>500" :title="t('应用')">✓</button></form>
        <div class="browse-view-buttons">
          <button class="browse-icon" type="button" :class="{ active: browseView === 'grid' }" :aria-label="t('表格视图')" :title="t('表格视图')" :aria-pressed="browseView === 'grid'" @click="changeBrowseView('grid')">▦</button>
          <button class="browse-icon" type="button" :class="{ active: browseView === 'record' }" :aria-label="t('记录视图')" :title="t('记录视图')" :aria-pressed="browseView === 'record'" @click="changeBrowseView('record')">▤</button>
          <button class="browse-icon" type="button" :class="{ active: browseView === 'text' }" :aria-label="t('文本视图')" :title="t('文本视图')" :aria-pressed="browseView === 'text'" @click="changeBrowseView('text')">{{ '{}' }}</button>
        </div>
      </footer>
      <footer v-else class="result-footer"><span>{{ result?.rows.length || 0 }} {{ t('条记录') }}<span v-if="result?.durationMs !== undefined"> · {{ result.durationMs }} ms</span><span v-if="result?.truncated"> {{ t('· 已达到单页限制') }}</span></span><div class="result-page-controls"><button v-if="offset > 0 && tab === 'query'" class="btn secondary small" :disabled="busy" @click="runQuery(Math.max(0, offset - limit))">{{ t('← 上一页') }}</button><button v-if="result?.nextOffset !== undefined && tab === 'query'" class="btn secondary small" :disabled="busy" @click="runQuery(result.nextOffset)">{{ t('下一页 →') }}</button></div><span>{{ session.writable ? t('可写会话') : t('只读会话') }}</span></footer>
    </template>

    <DataFileWizard v-if="fileWizard&&active!==false" :session="session" :database="entity.database" :entity="entity.entity" :direction="fileWizard" :fields="result?.columns" :filter="isMysql?appliedMysql:undefined" :mongo-filter="isMongo?appliedMongo.filter:undefined" @close="fileWizard=undefined" @session="emit('updateSession',$event)" @completed="fileWizard==='import'&&loadData(0)"/>
    <BrowseProfilesDialog v-if="profileDialog&&active!==false" :session-id="session.id" :database="entity.database" :entity="entity.entity" :draft="currentProfile()" @apply="applyBrowseProfile" @close="profileDialog=false"/>
    <FieldValueDialog v-if="fieldDialog&&active!==false" v-bind="fieldDialog" :mongo="isMongo" @stage="stageField" @close="fieldDialog=undefined"/>
    <div v-if="documentView" class="modal-backdrop" @keydown.esc.stop="documentView = undefined">
      <section class="dialog document-dialog bson-view-dialog" role="dialog" aria-modal="true" :aria-label="t('查看文档')">
        <header class="dialog-header"><div><span class="eyebrow">{{ entityTitle() }}</span><h2>{{ t('查看文档') }}</h2></div><button class="icon-button" :aria-label="t('关闭弹窗')" @click="documentView = undefined">×</button></header>
        <nav class="subtabs"><button type="button" :class="{ active: documentViewMode === 'tree' }" @click="documentViewMode = 'tree'">{{ t('文档树') }}</button><button type="button" :class="{ active: documentViewMode === 'raw' }" @click="documentViewMode = 'raw'">{{ t('原始 EJSON') }}</button></nav>
        <BsonDocumentTree v-if="documentViewMode === 'tree'" :document="documentView.document" :metadata="documentView.metadata" />
        <pre v-else class="bson-raw-document" dir="ltr">{{ documentView.document }}</pre>
        <footer class="dialog-footer"><span class="toolbar-spacer"></span><button class="btn secondary" type="button" @click="documentView = undefined">{{ t('关闭') }}</button></footer>
      </section>
    </div>
    <div v-if="edit" class="modal-backdrop" @keydown.esc.stop="!busy && !validatingEdit && closeEdit()">
      <section :class="['dialog document-dialog', { 'mongo-edit-dialog': isMongo && edit.mode !== 'import' }]" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <header class="dialog-header"><div><span class="eyebrow">{{ entityTitle() }}</span><h2 id="edit-title">{{ edit.mode === 'update' ? t(isMongo ? '编辑文档' : '编辑记录') : edit.mode === 'import' ? t('导入预览') : t('新增记录') }}</h2></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy || validatingEdit" @click="closeEdit">×</button></header>
        <div v-if="editError" class="inline-message error" role="alert">{{ localize(editError) }}</div>
        <div v-if="editNotice" class="inline-message notice" role="status">{{ t(editNotice) }}</div>
        <div v-if="isMongo && edit.mode !== 'import'" class="mongo-edit-mode"><span class="muted-text">{{ t(edit.syntax === 'typed' ? 'BSON 文档语法' : '原始 EJSON') }}</span><button v-if="edit.syntax === 'typed'" class="btn secondary small" type="button" :disabled="busy || validatingEdit" @click="useRawEjson">{{ t('原始 EJSON') }}</button><span class="toolbar-spacer"></span><span class="muted-text">{{ t(edit.mode === 'update' ? '修改时必须保留 _id' : '未指定 _id 时自动生成') }}</span></div>
        <p v-else class="compact-help">{{ isMysql ? t('JSON 字段值支持字符串、数字、布尔、null；BIGINT / DECIMAL 请使用字符串。省略自增字段可使用默认值。') : t('使用 Extended JSON 保留 ObjectId、Date、Decimal128 等 BSON 类型；修改时必须保留 _id。') }}</p>
        <div class="document-editor"><CodeEditor v-model="edit.text" :language="edit.syntax === 'typed' ? 'dbex-bson-document' : 'json'" :readonly="!canWrite || busy || validatingEdit" /></div>
        <footer class="dialog-footer"><button v-if="isMongo && edit.mode !== 'import'" class="btn secondary" type="button" :disabled="busy || validatingEdit" @click="validateEdit">{{ t(validatingEdit ? '处理中…' : '验证') }}</button><span v-if="isMongo && edit.mode !== 'import'" class="toolbar-spacer"></span><button class="btn secondary" :disabled="busy || validatingEdit" @click="closeEdit">{{ t('取消') }}</button><button class="btn primary" :disabled="busy || validatingEdit || !canWrite || !supportsRecordMutation(edit.mode)" @click="saveEdit">{{ t(isMongo && edit.mode === 'update' ? '更新' : isMongo && edit.mode === 'insert' ? '新增' : '审阅并保存') }}</button></footer>
      </section>
    </div>
    <div v-if="indexDialog" class="modal-backdrop">
      <section class="dialog mongo-index-dialog" role="dialog" aria-modal="true" aria-labelledby="index-title">
        <header class="dialog-header"><h2 id="index-title">{{ t('创建 MongoDB 索引') }}</h2><div class="index-dialog-actions"><button type="button" class="btn secondary small" :disabled="busy" :aria-expanded="indexHelpOpen" @click="indexHelpOpen=!indexHelpOpen"><span aria-hidden="true">ⓘ</span> {{ t('语法帮助') }}</button><button class="icon-button" :disabled="busy" :aria-label="t('关闭')" @click="indexDialog=false">×</button></div></header>
        <div v-if="error" class="inline-message error">{{ localize(error) }}</div>
        <div v-show="!indexHelpOpen" class="dialog-body index-edit-body">
          <label class="field field-wide">{{ t('索引字段 JSON') }}<textarea v-model="indexKeys" data-index-keys rows="4" :disabled="busy" spellcheck="false" dir="ltr" /></label>
          <label class="field field-wide">{{ t('索引选项') }} JSON<textarea v-model="indexOptions" data-index-options rows="4" :disabled="busy" spellcheck="false" dir="ltr" /></label>
        </div>
        <div v-if="indexHelpOpen" class="dialog-body index-help-body"><MongoIndexHelp @apply="applyIndexExample" /></div>
        <footer class="dialog-footer"><button v-if="indexHelpOpen" class="btn primary" @click="indexHelpOpen=false">{{ t('返回') }}</button><template v-else><button class="btn secondary" :disabled="busy" @click="indexDialog=false">{{ t('取消') }}</button><button class="btn primary" :disabled="busy" @click="createIndex">{{ t('审阅并创建') }}</button></template></footer>
      </section>
    </div>
    <div v-if="historyOpen" class="modal-backdrop"><section class="dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title"><header class="dialog-header"><h2 id="history-title">{{ t('查询历史与收藏') }}</h2><button class="icon-button" @click="historyOpen = false">×</button></header><div v-if="historyError" class="inline-message error">{{ localize(historyError) }}</div><div class="editor-toolbar"><input v-model="snippetName" :placeholder="t('当前编辑器内容的收藏名称')" /><button class="btn primary" @click="favorite()">{{ t('收藏当前内容') }}</button><label class="checkbox-row"><input v-model="historyOnlyFavorites" type="checkbox" /> {{ t('仅收藏') }}</label></div><div class="history-list"><article v-for="item in visibleSnippets" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.database || t('未指定数据库') }} · {{ new Date(item.updatedAt).toLocaleString(locale) }}</small><pre>{{ item.text.slice(0, 600) }}</pre></div><div class="history-actions"><button class="btn secondary small" @click="useSnippet(item)">{{ t('打开') }}</button><button class="btn secondary small" @click="favorite(item)">{{ item.favorite ? t('★ 已收藏') : t('☆ 收藏') }}</button><button class="btn danger-text small" @click="removeSnippet(item)">{{ t('删除') }}</button></div></article><div v-if="!visibleSnippets.length" class="empty-state">{{ t('暂无保存的查询') }}</div></div></section></div>
  </div><ObjectInspector v-if="props.active!==false && inspectorTab && !libraryKind && (hasEntity || isRedis && !!node || inspectorTab==='colors')" :kind="session.kind" :name="inspectorName || ''" :database="node?.database" :connection="session.name" :tab="inspectorTab" :loading="inspectionLoading" :busy="busy" :inspection="inspection" :error="inspectionError" @change="openInspector" @close="closeGlobalInspector" @refresh="refreshInspection" /></div>
</template>
