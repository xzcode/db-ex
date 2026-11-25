<script setup lang="ts">
import { t, localize, locale } from './i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { DatabaseOperation, ExplorerNode, OperationResult, QuerySnippet, RedisValueType, SessionInfo, SqlRow, SqlValue } from '../shared/types'
import CodeEditor from './components/CodeEditor.vue'
import ResultGrid from './components/ResultGrid.vue'
import ObjectInspector from './components/ObjectInspector.vue'
import MongoSavedObjects from './components/MongoSavedObjects.vue'
import VisualQueryBuilder from './components/VisualQueryBuilder.vue'
import { filterSuggestions } from '../shared/filter-suggestions'
import BrowseRecordView from './components/BrowseRecordView.vue'
import { browseOffset, compileMongoFilter, compileMysqlFilter, MAX_BROWSE_OFFSET, newBrowseFilter, type BrowseFilter } from '../shared/browse-filter'
import type { ObjectInspection } from '../shared/object-inspection'
import BsonDocumentTree from './components/BsonDocumentTree.vue'
import { canSafelyEditMongoDocument, formatMongoDocument, mongoDocumentDraft, mongoFieldFilter, mongoFieldText, parseMongoDocumentEditor } from '../shared/bson-editor'
import type { BsonTypeBranch } from '../shared/bson-types'
import { csvFromRows, sqlRowsFromFile, validateSqlRow } from './data-format'

const props = defineProps<{ session: SessionInfo; node?: ExplorerNode }>()
const emit = defineEmits<{ updateSession: [session: SessionInfo]; disconnect: []; refreshTree: [] }>()
const tab = ref('data')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const result = ref<OperationResult | null>(null)
const selectedRow = ref(-1)
const checked = ref<number[]>([])
const offset = ref(0)
const limit = ref(props.session.kind === 'mongodb' ? 200 : 100)
const sql = ref('SELECT 1 AS result;')
let generatedSql = sql.value
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
const browsePageSize = ref(props.session.kind === 'mongodb' ? 200 : 100)
const pageInput = ref(1)
const totalRows = ref<string>()
const countLimited = ref(false)
const browseView = ref<'grid' | 'record' | 'text'>('grid')
const sqlQuerySummary = ref('')
const sqlQueryParameters = ref<SqlValue[]>([])
const filterError = ref('')
const mongoQuery = ref('')
const filtersActive = computed(() => props.session.kind === 'mysql' ? appliedMysql.value.groups.length > 0 || appliedMysql.value.sort.length > 0 : [appliedMongo.value.filter, appliedMongo.value.projection, appliedMongo.value.sort].some(value => { try { return Object.keys(JSON.parse(value || '{}')).length > 0 } catch { return true } }))
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
const inspectorTab = ref<'info' | 'ddl' | 'colors' | null>(null)
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
const isMysql = computed(() => props.session.kind === 'mysql')
const isMongo = computed(() => props.session.kind === 'mongodb')
const isRedis = computed(() => props.session.kind === 'redis')
const libraryKind = computed(() => props.node?.category === 'queries' ? 'query' : props.node?.category === 'pipelines' ? 'aggregation' : undefined)
const legacyMapReduce = computed(() => props.node?.category === 'mapReduce')
const canWrite = computed(() => props.session.writable && !props.node?.readOnly && props.node?.kind !== 'mongo-category')
const inspectorName = computed(() => isRedis.value ? (tab.value === 'data' ? result.value?.rows[selectedRow.value]?.key || (redisDetail.value ? redisKey.value : '') : '') : entity.value.entity)
const inspectionKey = computed(() => JSON.stringify([props.session.id, props.session.kind, entity.value.database, inspectorName.value]))
const visibleSnippets = computed(() => snippets.value.filter(item => item.kind === props.session.kind && (!historyOnlyFavorites.value || item.favorite) && (!isMongo.value || item.mongoKind !== 'query')))
const browseFields = computed(() => props.session.kind === 'mysql' ? (structure.value?.rows || []).map(row => String(row.name || row.Field || '')).filter(Boolean) : result.value?.columns || [])
const canEditRow = computed(() => !props.node?.readOnly && editableRows.value && selectedRow.value >= 0 && (isMongo.value ? !!result.value?.documents?.[selectedRow.value] : !!result.value?.rawRows?.[selectedRow.value] && primaryKeys.value.length > 0))
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
function openInspector(next: 'info' | 'ddl' | 'colors') { inspectorTab.value = next }
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
watch([inspectorTab, inspectionKey, busy, inspectionLoading], () => {
  if (inspectionTimer) clearTimeout(inspectionTimer)
  if (inspectorTab.value && inspectorTab.value !== 'colors' && !busy.value && !inspectionLoading.value && inspectorName.value && inspectionLoadedKey !== inspectionKey.value) {
    inspectionTimer = setTimeout(() => { if (inspectorTab.value && inspectorTab.value !== 'colors') void refreshInspection() }, 0)
  }
}, { flush: 'post' })
async function confirmWrite(_title: string, _details: string): Promise<boolean> {
  if (!canWrite.value) { error.value = '当前会话只读，请先点击右上角“启用写入”。'; return false }
  // A native main-process dialog confirms each database write immediately before execution.
  return true
}
async function toggleWrite() {
  if (busy.value) return
  try { emit('updateSession', await window.dbex.setWriteAccess(props.session.id, !props.session.writable)) }
  catch (reason) { setError(reason) }
}
async function cancel() {
  try { await window.dbex.cancel(props.session.id); emit('disconnect') }
  catch (reason) { setError(reason) }
}
async function remember(text: string) {
  try {
    await window.dbex.saveSnippet({ name: text.trim().split('\n')[0].slice(0, 80), text, database: entity.value.database, kind: props.session.kind, ...(isMongo.value ? { mongoKind: 'aggregation' as const, entity: entity.value.entity, connectionId: props.session.connectionId } : {}), favorite: false })
  } catch { notice.value += ' · 查询已执行，但历史记录保存失败' }
}
async function loadData(nextOffset = 0, proposedMongo = appliedMongo.value, proposedMysql = appliedMysql.value, size = browsePageSize.value): Promise<boolean> {
  if (!hasEntity.value || busy.value || nextOffset < 0 || nextOffset > MAX_BROWSE_OFFSET) return false
  const version = generation
  const target = { ...entity.value }
  const mongo = { ...proposedMongo }
  const mysql = JSON.parse(JSON.stringify(proposedMysql)) as BrowseFilter
  if (isMysql.value) {
    const compiled = compileMysqlFilter(target.database, target.entity, mysql)
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
  offset.value = nextOffset
  browsePageSize.value = size
  if (browseView.value !== 'grid' && result.value?.rows.length) selectedRow.value = 0
  pageInput.value = Math.floor(nextOffset / size) + 1
  totalRows.value = undefined
  countLimited.value = false
  return true
}
async function applyVisualFilter() {
  filterError.value = ''
  try {
    if (isMongo.value) {
      const compiled = compileMongoFilter(visualFilter.value)
      const proposed = { ...compiled, projection: '{}' }
      if (await loadData(0, proposed)) { filter.value = proposed.filter; sort.value = proposed.sort; projection.value = proposed.projection }
    } else {
      compileMysqlFilter(entity.value.database, entity.value.entity, visualFilter.value)
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
    const next = browseOffset(Number(pageInput.value), browsePageSize.value)
    if (!await loadData(next)) pageInput.value = Math.floor(offset.value / browsePageSize.value) + 1
  } catch (reason) { setError(reason); pageInput.value = Math.floor(offset.value / browsePageSize.value) + 1 }
}
async function changeBrowseSize(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (![100,200,500].includes(value)) return
  if (!await loadData(0, appliedMongo.value, appliedMysql.value, value)) (event.target as HTMLSelectElement).value = String(browsePageSize.value)
}
async function lastBrowsePage() {
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
  browseView.value = view
  if (selectedRow.value < 0 && result.value?.rows.length) selectedRow.value = 0
}
async function loadStructure() {
  if (!hasEntity.value) return
  const next = await execute(isMysql.value ? { action: 'mysql.structure', ...entity.value } : { action: 'mongo.indexes', ...entity.value }, false)
  if (next) { structure.value = next; primaryKeys.value = next.primaryKeys || [] }
}
async function runQuery(nextOffset = 0) {
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
    if (next) await remember(text)
  } catch (reason) { setError(reason) }
}
async function runAggregation() {
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
function openInsert() { if (!canWrite.value) return; editError.value = ''; editNotice.value = ''; edit.value = { mode: 'insert', text: isMysql.value ? '{} ' : '{\n  "name": ""\n}', syntax: isMongo.value ? 'typed' : undefined } }
function openEdit() {
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
  if (!draft || busy.value || validatingEdit.value || !canWrite.value) return
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
    if (next) { edit.value = null; await loadData(offset.value) } else editError.value = error.value
  } catch (reason) { editError.value = messageOf(reason) }
}
async function deleteRow() {
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
    const saved = await window.dbex.saveSnippet(item ? { ...item, favorite: !item.favorite } : { name: snippetName.value.trim() || t('未命名查询'), kind: props.session.kind, database: entity.value.database, text: isMysql.value ? sql.value : pipeline.value, ...(isMongo.value ? { mongoKind: 'aggregation' as const, entity: entity.value.entity, connectionId: props.session.connectionId } : {}), favorite: true })
    snippets.value = [saved, ...snippets.value.filter(value => value.id !== saved.id)]
    snippetName.value = ''
  } catch (reason) { historyError.value = messageOf(reason) }
}
async function removeSnippet(item: QuerySnippet) {
  try { await window.dbex.deleteSnippet(item.id); snippets.value = snippets.value.filter(value => value.id !== item.id) }
  catch (reason) { historyError.value = messageOf(reason) }
}
function useSnippet(item: QuerySnippet) {
  if (isMysql.value) { sql.value = item.text; tab.value = 'query' } else { pipeline.value = item.text; tab.value = 'aggregation' }
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
async function changeTab(value: string) {
  tab.value = value; selectedRow.value = -1
  if (value === 'structure') await loadStructure()
  else if (value === 'data' && hasEntity.value) await loadData()
}
watch(redisKey, () => { redisDetail.value = null; redisText.value = ''; redisTtl.value = -1; redisType.value = 'string' })
watch(redisType, type => { redisMutation.value = mutationCommands[type][0] })
async function refreshSelection(version: number) {
  if (version !== generation || disposed || busy.value) return
  if (hasEntity.value) {
    if (props.node?.kind === 'mongo-indexes') { tab.value = 'structure'; await loadStructure(); return }
    if (isMysql.value) {
      await loadStructure()
      if (version !== generation || disposed) return
      if (sql.value === generatedSql) {
        generatedSql = `SELECT * FROM ${quote(entity.value.database)}.${quote(entity.value.entity)};`
        sql.value = generatedSql
      }
    }
    await loadData()
    if (version === generation) tab.value = 'data'
  } else if (isRedis.value && props.node) {
    const nodes = await execute({ action: 'redis.nodes' }, false)
    if (version !== generation || disposed) return
    redisNodes.value = (nodes?.rows || []).map(row => row.node || row.id || row.address).filter(Boolean)
    await scanRedis()
  }
}
watch(() => props.node?.id, () => {
  generation++; tab.value = 'data'; inspectorTab.value = null; redisScanCursors.value = ['0']; redisScanIndex.value = 0; visualFilter.value = newBrowseFilter(); appliedMysql.value = newBrowseFilter(); appliedMongo.value = { filter: '{}', projection: '{}', sort: '{}' }; filter.value = '{}'; projection.value = '{}'; sort.value = '{}'; filterMode.value = 'builder'; filterError.value = ''; totalRows.value = undefined; countLimited.value = false; pageInput.value = 1; sqlQuerySummary.value = ''; sqlQueryParameters.value = []; edit.value = null; documentView.value = undefined; mongoQuery.value = ''; result.value = null; structure.value = null; primaryKeys.value = []; selectedRow.value = -1; checked.value = []; offset.value = 0; editableRows.value = false
  if (busy.value) { pendingSelection = true; return }
  void refreshSelection(generation)
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; if (inspectionTimer) clearTimeout(inspectionTimer) })
</script>

<template>
  <div class="workbench-shell"><MongoSavedObjects v-if="isMongo && libraryKind && node?.database" :key="node.id" :session="session" :database="node.database" :kind="libraryKind" :busy="busy" @disconnect="cancel" :run="async op => { const next=await execute(op,false); if(!next)throw new Error(error || '操作失败'); return next }" /><div v-else-if="legacyMapReduce" class="workbench"><header class="workbench-header"><h2>MapReduce</h2></header><div class="empty-state"><strong>{{ t('MapReduce 已弃用') }}</strong><span>{{ t('请使用聚合管道替代；DB EX 不执行服务器端 JavaScript。') }}</span></div></div><div v-else :class="['workbench', { 'mongo-workbench': isMongo }]">
    <header class="workbench-header"><div><span class="eyebrow">{{ session.kind.toUpperCase() }}</span><h2>{{ node?.kind === 'mongo-category' ? t(node.label) : node?.label || session.name }}</h2></div><div class="header-tools"><span v-if="session.transaction" class="transaction-badge">{{ t('事务进行中') }}</span><span v-if="node?.readOnly" class="muted-text">{{ t('只读对象') }}</span><button v-else :class="['btn', session.writable ? 'warning' : 'secondary']" :disabled="busy" @click="toggleWrite">{{ session.writable ? t('写入已启用 · 锁定') : t('只读 · 启用写入') }}</button></div></header>
    <nav class="workbench-tabs"><button :disabled="busy" :class="{ active: tab === 'data' }" @click="changeTab('data')">{{ isRedis ? t('Key 浏览器') : t('数据') }}</button><button v-if="isMysql" :disabled="busy" :class="{ active: tab === 'query' }" @click="changeTab('query')">{{ t('SQL 编辑器') }}</button><button v-if="isMongo" :disabled="busy" :class="{ active: tab === 'aggregation' }" @click="changeTab('aggregation')">Aggregation</button><button v-if="!isRedis && !node?.readOnly" :disabled="busy" :class="{ active: tab === 'structure' }" @click="changeTab('structure')">{{ isMysql ? t('结构与索引') : t('索引') }}</button><button v-if="isRedis" :disabled="busy" :class="{ active: tab === 'console' }" @click="changeTab('console')">{{ t('命令台') }}</button><div class="tab-filler"></div><button :class="{ active: inspectorTab === 'info' }" @click="openInspector('info')">{{ t('对象信息') }}</button><button :class="{ active: inspectorTab === 'ddl' }" @click="openInspector('ddl')">{{ isRedis ? t('检查命令') : 'DDL' }}</button><button :class="{ active: inspectorTab === 'colors' }" @click="openInspector('colors')">{{ isMongo ? t('BSON 类型配色') : t('数据类型配色') }}</button><button v-if="!isRedis" @click="openHistory">{{ t('历史 / 收藏') }}</button></nav>
    <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div>
    <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
    <div v-if="busy" class="operation-progress"><span class="progress-indicator"></span> {{ t('正在执行') }} <button v-if="tab !== 'data' || isRedis" class="btn secondary small" @click="cancel">{{ t('取消并断开') }}</button></div>

    <template v-if="isMysql && tab === 'query'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy" @click="runQuery()">{{ t('运行选中 / 全部') }} <kbd>⌘ / Ctrl ↵</kbd></button><label class="inline-field">{{ t('每页') }}<select v-model.number="limit"><option :value="100">100</option><option :value="500">500</option></select></label><span class="toolbar-spacer"></span><button class="btn secondary" :disabled="busy || !canWrite || session.transaction" @click="transaction('mysql.begin')">{{ t('开始事务') }}</button><button class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.commit')">{{ t('提交') }}</button><button class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.rollback')">{{ t('回滚') }}</button></div>
      <div class="query-editor"><CodeEditor ref="sqlEditor" v-model="sql" language="sql" :suggestions="structure?.rows.map(row => row.Field || row.name || '') || []" @execute="runQuery()" /></div>
      <label class="parameter-line">{{ t('参数') }} <input v-model="parameters" :aria-label="t('SQL 参数 JSON 数组')" placeholder='["value", 123]' spellcheck="false" /><span>{{ t('用 ? 绑定参数；每次仅执行一条 SQL') }}</span></label>
    </template>
    <template v-if="isMongo && tab === 'aggregation'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy || !hasEntity" @click="runAggregation">{{ t('运行 Aggregation') }}</button><span class="muted-text">{{ t('EJSON 管道 · 禁止 $out / $merge · 最多') }} {{ limit }} {{ t('条') }}</span></div>
      <div class="query-editor"><CodeEditor v-model="pipeline" language="json" @execute="runAggregation" /></div>
    </template>
    <template v-if="isRedis && tab === 'console'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy" @click="runRedisCommand">{{ t('执行命令') }}</button><span class="muted-text">{{ t('JSON 参数数组 · 只读状态仅允许受控读取命令') }}</span></div>
      <div class="query-editor"><CodeEditor v-model="redisCommand" language="json" @execute="runRedisCommand" /></div>
    </template>
    <template v-if="tab === 'structure'">
      <div class="editor-toolbar"><button class="btn secondary" :disabled="busy || !hasEntity" @click="loadStructure">{{ t('刷新结构') }}</button><template v-if="isMongo"><button class="btn secondary" :disabled="busy || !hasEntity || !canWrite" @click="indexDialog = true">{{ t('新建索引') }}</button><button class="btn danger-text" :disabled="busy || !canWrite || selectedRow < 0" @click="dropIndex">{{ t('删除选中索引') }}</button></template><span v-if="isMysql" class="muted-text">{{ t('主键：') }}{{ primaryKeys.join(', ') || t('无（记录修改已禁用）') }}</span></div>
      <ResultGrid v-if="structure" :columns="structure.columns" :rows="structure.rows" :selected="selectedRow" :bson-types="isMongo ? structure.bsonTypes : undefined" :documents="isMongo ? structure.documents : undefined" @select="selectedRow = $event" />
      <div v-else class="empty-state"><strong>{{ t('选择表或集合查看结构') }}</strong><span>{{ t('从左侧资源树选择一个对象。') }}</span></div>
    </template>
    <template v-else-if="isRedis && tab === 'data'">
      <div class="editor-toolbar"><input v-model="redisPattern" :aria-label="t('Redis Key 匹配模式')" placeholder="Key pattern: user:*" @keyup.enter="scanRedis()" /><select v-if="redisNodes.length > 1" v-model="redisNode" :aria-label="t('Cluster 节点')"><option value="">{{ t('默认节点') }}</option><option v-for="nodeName in redisNodes" :key="nodeName" :value="nodeName">{{ nodeName }}</option></select><button class="btn primary" :disabled="busy" @click="scanRedis()">{{ t('扫描 Key') }}</button><button class="btn danger-text" :disabled="busy || !canWrite || !checked.length" @click="deleteKeys">{{ t('删除选中') }} {{ checked.length || '' }}</button></div>
      <div class="redis-split"><div class="redis-key-list"><ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :redis-row-types="result.redisRowTypes" :checked="checked" :selected="selectedRow" selectable @check="checkRow" @check-all="checkAll" @select="selectedRow = $event" @open="openRedis(result.rows[$event].key)" /><div class="result-footer"><span>{{ t('双击 Key 打开 · 当前页') }} {{ result?.rows.length || 0 }} {{ t('个') }}</span><div class="browse-page-buttons"><button type="button" class="browse-icon" :aria-label="t('首批')" :title="t('首批')" :disabled="busy || redisScanIndex === 0" @click="scanRedis('0', 'first')">|‹</button><button type="button" class="browse-icon" :aria-label="t('上一批')" :title="t('上一批')" :disabled="busy || redisScanIndex === 0" @click="scanRedis(redisScanCursors[redisScanIndex - 1], 'previous')">‹</button><span>{{ redisScanIndex + 1 }}</span><button type="button" class="browse-icon" :aria-label="t('下一批 →')" :title="t('下一批 →')" :disabled="busy || !result?.nextCursor" @click="result?.nextCursor && scanRedis(result.nextCursor, 'next')">›</button></div></div></div>
        <section class="redis-inspector"><div class="editor-toolbar"><input v-model="redisKey" :aria-label="t('Redis Key 名称')" :placeholder="t('输入 Key 或双击左侧列表')" @keyup.enter="openRedis()" /><button class="btn secondary" :disabled="busy || !redisKey" @click="openRedis()">{{ t('读取') }}</button></div><div class="editor-toolbar"><label class="inline-field">{{ t('类型') }}<select v-model="redisType"><option v-for="kind in Object.keys(mutationCommands)" :key="kind" :value="kind">{{ kind }}</option></select></label><label class="inline-field">{{ t('TTL（秒）') }}<input v-model.number="redisTtl" type="number" min="-1" /></label><button class="btn secondary" :disabled="busy || !canWrite || !redisKey" @click="setTtl">{{ t('保存 TTL') }}</button></div><p class="compact-help">{{ t('TTL = -1 永久，其他值须大于 0。列表与集合按页读取。') }}</p>
          <template v-if="redisType === 'string'"><div class="redis-value-editor"><CodeEditor v-model="redisText" language="plaintext" /></div><div class="editor-toolbar"><button class="btn primary" :disabled="busy || !canWrite || !redisKey || !!redisDetail?.truncated" @click="saveRedisString">{{ t('保存 String') }}</button></div></template>
          <template v-else><ResultGrid v-if="redisDetail" :columns="redisDetail.columns" :rows="redisDetail.rows" :redis-row-types="redisDetail.redisRowTypes" /><div v-if="redisDetail?.nextCursor || redisDetail?.nextOffset !== undefined" class="editor-toolbar"><button class="btn secondary" :disabled="busy" @click="openRedis(undefined, redisDetail?.nextCursor, redisDetail?.nextOffset)">{{ t('下一页元素 →') }}</button></div><div class="editor-toolbar"><select v-model="redisMutation" :aria-label="t('Redis 修改命令')"><option v-for="command in mutationCommands[redisType]" :key="command">{{ command }}</option></select><button class="btn primary" :disabled="busy || !canWrite || !redisKey" @click="mutateRedis">{{ t('执行修改') }}</button></div><label class="field mutation-arguments">{{ t('参数（不含命令与 Key）') }}<textarea v-model="redisArguments" rows="3" spellcheck="false" /></label><p class="compact-help">HSET: ["field", "value"] · LPUSH / SADD: ["value"]<br />ZADD: ["1", "member"] · XADD: ["*", "field", "value"]</p></template>
        </section>
      </div>
    </template>
    <template v-else>
      <div class="editor-toolbar browser-top-toolbar"><template v-if="tab === 'data' && !isRedis"><button class="btn secondary small" :aria-label="t('编辑')" :disabled="busy || !canEditRow || !canWrite" @click="openEdit"><span aria-hidden="true">✎</span> {{ t('编辑') }}</button><button class="btn secondary small" :aria-label="t('查询条件')" :aria-expanded="showMongoFilters" :class="{ 'active-filter': filtersActive || showMongoFilters }" @click="showMongoFilters = !showMongoFilters"><span aria-hidden="true">⌕</span> {{ t('查询条件') }} <span v-if="filtersActive" aria-hidden="true">•</span></button><button class="btn secondary small" :disabled="busy || !hasEntity || !canWrite" @click="importData">{{ t('导入') }} {{ isMysql ? 'CSV / JSON' : 'EJSON' }}</button></template><button v-if="isMongo && tab !== 'data'" class="btn secondary small" :disabled="selectedRow < 0 || !result?.documents?.[selectedRow]" @click="viewMongoDocument()">{{ t('查看文档') }}</button><span class="toolbar-spacer"></span><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('json')">{{ t('导出当前页 JSON') }}</button><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('csv')">CSV</button></div>
      <section v-if="tab === 'data' && !isRedis && showMongoFilters" class="browse-filter-panel">
        <header class="filter-panel-header"><span>{{ t('查询条件') }}</span><div v-if="isMongo" class="filter-mode-switch"><button type="button" :class="{ active: filterMode === 'builder' }" @click="filterMode = 'builder'">{{ t('创建工具') }}</button><button type="button" :class="{ active: filterMode === 'text' }" @click="filterMode = 'text'">{{ t('文本') }}</button></div></header>
        <div v-if="filterError" class="inline-message error" role="alert">{{ localize(filterError) }}</div>
        <VisualQueryBuilder v-if="isMysql || filterMode === 'builder'" v-model="visualFilter" :kind="isMysql ? 'mysql' : 'mongodb'" :key="node?.id" :fields="browseFields" :suggestions="field => filterSuggestions(result, field, isMongo)" :disabled="busy || !hasEntity" @apply="applyVisualFilter" @reset="resetBrowseFilter" />
        <div v-else class="mongo-filters"><label>Filter<textarea v-model="filter" rows="3" spellcheck="false" /></label><label>Projection<textarea v-model="projection" rows="3" spellcheck="false" /></label><label>Sort<textarea v-model="sort" rows="3" spellcheck="false" /></label><button class="btn primary" :disabled="busy || !hasEntity" @click="applyTextFilter">{{ t('查询') }}</button><button class="btn secondary" :disabled="busy || !hasEntity" @click="resetBrowseFilter">{{ t('重置筛选') }}</button></div>
      </section>
      <BrowseRecordView v-if="result && tab === 'data' && !isRedis && browseView !== 'grid'" :result="result" :selected="selectedRow" :mongo="isMongo" :mode="browseView" :offset="offset" @select="selectedRow = $event" @open="viewMongoDocument" />
      <ResultGrid v-else-if="result" :columns="result.columns" :rows="result.rows" :column-types="isMysql ? result.columnTypes : undefined" :null-cells="result.nullCells" :redis-row-types="isRedis ? result.redisRowTypes : undefined" :selected="selectedRow" :offset="offset" :bson-types="isMongo ? result.bsonTypes : undefined"  :documents="isMongo ? result.documents : undefined" :document-menu="isMongo && !!result.documents?.length && !busy" :can-edit-document="isMongo && tab === 'data' && editableRows && canWrite && !busy" :can-add-document="isMongo && tab === 'data' && hasEntity && canWrite && !busy" :can-filter-document="isMongo && tab === 'data' && hasEntity && !busy" @document-action="mongoContextAction" @document-edit="editMongoRow" @document-view="viewMongoDocument" @select="selectedRow = $event" @open="openResultRow" />
      <div v-else class="empty-state"><span class="empty-icon">▤</span><strong>{{ hasEntity ? t('运行查询查看结果') : t('选择数据库中的表或集合') }}</strong><span>{{ isMysql ? t('可直接切换到 SQL 编辑器执行查询。') : t('使用左侧资源树选择目标。') }}</span></div>
      <footer v-if="tab === 'data' && !isRedis" class="result-footer browse-footer">
        <div class="browse-record-actions">
          <button class="browse-icon" type="button" :title="t('新增')" :aria-label="t('新增')" :disabled="busy || !hasEntity || !canWrite" @click="openInsert">＋</button>
          <button class="browse-icon" type="button" :title="t('删除')" :aria-label="t('删除')" :disabled="busy || !canEditRow || !canWrite" @click="deleteRow">−</button>
          <button class="browse-icon" type="button" :title="t('刷新')" :aria-label="t('刷新')" :disabled="busy || !hasEntity" @click="loadData(offset)">↻</button>
          <button class="browse-icon" type="button" :title="t('取消并断开')" :aria-label="t('取消并断开')" :disabled="!busy" @click="cancel">■</button>
        </div>
        <span v-if="isMongo && mongoQuery" class="mongo-query-summary" dir="ltr" :title="mongoQuery">{{ mongoQuery }}</span><span v-else-if="isMysql && sqlQuerySummary" class="mongo-query-summary" dir="ltr" :title="sqlQuerySummary + (sqlQueryParameters.length ? '\n' + JSON.stringify(sqlQueryParameters) : '')">{{ sqlQuerySummary }}</span><span v-else class="toolbar-spacer"></span>
        <span class="browse-count">{{ result?.rows.length || 0 }} {{ t('条记录') }}<template v-if="totalRows"> / {{ countLimited ? '≥' : '' }}{{ totalRows }}</template></span>
        <div class="browse-page-buttons">
          <button class="browse-icon" type="button" :aria-label="t('首页')" :title="t('首页')" :disabled="busy || offset === 0" @click="loadData(0)">|‹</button>
          <button class="browse-icon" type="button" :aria-label="t('上一页')" :title="t('上一页')" :disabled="busy || offset === 0" @click="loadData(Math.max(0, offset - browsePageSize))">‹</button>
          <form class="browse-page-input" @submit.prevent="jumpPage"><input v-model.number="pageInput" :aria-label="t('页码')" type="number" min="1" :max="Math.floor(1000000 / browsePageSize) + 1" :disabled="busy || !hasEntity" /></form>
          <button class="browse-icon" type="button" :aria-label="t('下一页')" :title="t('下一页')" :disabled="busy || result?.nextOffset === undefined || result.nextOffset > 1000000" @click="result?.nextOffset !== undefined && loadData(result.nextOffset)">›</button>
          <button class="browse-icon" type="button" :aria-label="t('末页')" :title="t('末页')" :disabled="busy || !hasEntity" @click="lastBrowsePage">›|</button>
          <label class="inline-field browse-page-size" :title="t('每页')"><span aria-hidden="true">⚙</span><select :value="browsePageSize" :aria-label="t('每页')" :disabled="busy || !hasEntity" @change="changeBrowseSize"><option :value="100">100</option><option :value="200">200</option><option :value="500">500</option></select></label>
        </div>
        <div class="browse-view-buttons">
          <button class="browse-icon" type="button" :class="{ active: browseView === 'grid' }" :aria-label="t('表格视图')" :title="t('表格视图')" :aria-pressed="browseView === 'grid'" @click="changeBrowseView('grid')">▦</button>
          <button class="browse-icon" type="button" :class="{ active: browseView === 'record' }" :aria-label="t('记录视图')" :title="t('记录视图')" :aria-pressed="browseView === 'record'" @click="changeBrowseView('record')">▤</button>
          <button class="browse-icon" type="button" :class="{ active: browseView === 'text' }" :aria-label="t('文本视图')" :title="t('文本视图')" :aria-pressed="browseView === 'text'" @click="changeBrowseView('text')">{{ '{}' }}</button>
        </div>
      </footer>
      <footer v-else class="result-footer"><span>{{ result?.rows.length || 0 }} {{ t('条记录') }}<span v-if="result?.durationMs !== undefined"> · {{ result.durationMs }} ms</span><span v-if="result?.truncated"> {{ t('· 已达到单页限制') }}</span></span><div class="result-page-controls"><button v-if="offset > 0 && tab === 'query'" class="btn secondary small" :disabled="busy" @click="runQuery(Math.max(0, offset - limit))">{{ t('← 上一页') }}</button><button v-if="result?.nextOffset !== undefined && tab === 'query'" class="btn secondary small" :disabled="busy" @click="runQuery(result.nextOffset)">{{ t('下一页 →') }}</button></div><span>{{ session.writable ? t('可写会话') : t('只读会话') }}</span></footer>
    </template>

    <div v-if="documentView" class="modal-backdrop" @keydown.esc.stop="documentView = undefined">
      <section class="dialog document-dialog bson-view-dialog" role="dialog" aria-modal="true" :aria-label="t('查看文档')">
        <header class="dialog-header"><div><span class="eyebrow">{{ entityTitle() }}</span><h2>{{ t('查看文档') }}</h2></div><button class="icon-button" :aria-label="t('关闭弹窗')" @click="documentView = undefined">×</button></header>
        <nav class="subtabs"><button type="button" :class="{ active: documentViewMode === 'tree' }" @click="documentViewMode = 'tree'">{{ t('文档树') }}</button><button type="button" :class="{ active: documentViewMode === 'raw' }" @click="documentViewMode = 'raw'">{{ t('原始 EJSON') }}</button></nav>
        <BsonDocumentTree v-if="documentViewMode === 'tree'" :document="documentView.document" :metadata="documentView.metadata" />
        <pre v-else class="bson-raw-document" dir="ltr">{{ documentView.document }}</pre>
        <footer class="dialog-footer"><span class="toolbar-spacer"></span><button class="btn secondary" type="button" @click="documentView = undefined">{{ t('关闭') }}</button></footer>
      </section>
    </div>
    <div v-if="edit" class="modal-backdrop" @keydown.esc.stop="!busy && !validatingEdit && (edit = null)">
      <section :class="['dialog document-dialog', { 'mongo-edit-dialog': isMongo && edit.mode !== 'import' }]" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <header class="dialog-header"><div><span class="eyebrow">{{ entityTitle() }}</span><h2 id="edit-title">{{ edit.mode === 'update' ? t(isMongo ? '编辑文档' : '编辑记录') : edit.mode === 'import' ? t('导入预览') : t('新增记录') }}</h2></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy || validatingEdit" @click="edit = null">×</button></header>
        <div v-if="editError" class="inline-message error" role="alert">{{ localize(editError) }}</div>
        <div v-if="editNotice" class="inline-message notice" role="status">{{ t(editNotice) }}</div>
        <div v-if="isMongo && edit.mode !== 'import'" class="mongo-edit-mode"><span class="muted-text">{{ t(edit.syntax === 'typed' ? 'BSON 文档语法' : '原始 EJSON') }}</span><button v-if="edit.syntax === 'typed'" class="btn secondary small" type="button" :disabled="busy || validatingEdit" @click="useRawEjson">{{ t('原始 EJSON') }}</button><span class="toolbar-spacer"></span><span class="muted-text">{{ t(edit.mode === 'update' ? '修改时必须保留 _id' : '未指定 _id 时自动生成') }}</span></div>
        <p v-else class="compact-help">{{ isMysql ? t('JSON 字段值支持字符串、数字、布尔、null；BIGINT / DECIMAL 请使用字符串。省略自增字段可使用默认值。') : t('使用 Extended JSON 保留 ObjectId、Date、Decimal128 等 BSON 类型；修改时必须保留 _id。') }}</p>
        <div class="document-editor"><CodeEditor v-model="edit.text" :language="edit.syntax === 'typed' ? 'dbex-bson-document' : 'json'" :readonly="!canWrite || busy || validatingEdit" /></div>
        <footer class="dialog-footer"><button v-if="isMongo && edit.mode !== 'import'" class="btn secondary" type="button" :disabled="busy || validatingEdit" @click="validateEdit">{{ t(validatingEdit ? '处理中…' : '验证') }}</button><span v-if="isMongo && edit.mode !== 'import'" class="toolbar-spacer"></span><button class="btn secondary" :disabled="busy || validatingEdit" @click="edit = null">{{ t('取消') }}</button><button class="btn primary" :disabled="busy || validatingEdit || !canWrite" @click="saveEdit">{{ t(isMongo && edit.mode === 'update' ? '更新' : isMongo && edit.mode === 'insert' ? '新增' : '审阅并保存') }}</button></footer>
      </section>
    </div>
    <div v-if="indexDialog" class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="index-title"><header class="dialog-header"><h2 id="index-title">{{ t('创建 MongoDB 索引') }}</h2><button class="icon-button" @click="indexDialog = false">×</button></header><div v-if="error" class="inline-message error">{{ localize(error) }}</div><div class="dialog-body"><label class="field field-wide">{{ t('索引字段 JSON') }}<textarea v-model="indexKeys" rows="4" /></label><label class="field field-wide">{{ t('选项 JSON（name / unique / sparse / expireAfterSeconds）') }}<textarea v-model="indexOptions" rows="4" /></label></div><footer class="dialog-footer"><button class="btn secondary" @click="indexDialog = false">{{ t('取消') }}</button><button class="btn primary" :disabled="busy" @click="createIndex">{{ t('审阅并创建') }}</button></footer></section></div>
    <div v-if="historyOpen" class="modal-backdrop"><section class="dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title"><header class="dialog-header"><h2 id="history-title">{{ t('查询历史与收藏') }}</h2><button class="icon-button" @click="historyOpen = false">×</button></header><div v-if="historyError" class="inline-message error">{{ localize(historyError) }}</div><div class="editor-toolbar"><input v-model="snippetName" :placeholder="t('当前编辑器内容的收藏名称')" /><button class="btn primary" @click="favorite()">{{ t('收藏当前内容') }}</button><label class="checkbox-row"><input v-model="historyOnlyFavorites" type="checkbox" /> {{ t('仅收藏') }}</label></div><div class="history-list"><article v-for="item in visibleSnippets" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.database || t('未指定数据库') }} · {{ new Date(item.updatedAt).toLocaleString(locale) }}</small><pre>{{ item.text.slice(0, 600) }}</pre></div><div class="history-actions"><button class="btn secondary small" @click="useSnippet(item)">{{ t('打开') }}</button><button class="btn secondary small" @click="favorite(item)">{{ item.favorite ? t('★ 已收藏') : t('☆ 收藏') }}</button><button class="btn danger-text small" @click="removeSnippet(item)">{{ t('删除') }}</button></div></article><div v-if="!visibleSnippets.length" class="empty-state">{{ t('暂无保存的查询') }}</div></div></section></div>
  </div><ObjectInspector v-if="inspectorTab && !libraryKind && !legacyMapReduce" :kind="session.kind" :name="inspectorName || ''" :database="node?.database" :connection="session.name" :tab="inspectorTab" :loading="inspectionLoading" :busy="busy" :inspection="inspection" :error="inspectionError" @change="openInspector" @close="inspectorTab = null" @refresh="refreshInspection" /></div>
</template>
