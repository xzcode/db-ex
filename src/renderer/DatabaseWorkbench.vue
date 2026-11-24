<script setup lang="ts">
import { t, localize, locale } from './i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { DatabaseOperation, ExplorerNode, OperationResult, QuerySnippet, RedisValueType, SessionInfo, SqlRow, SqlValue } from '../shared/types'
import CodeEditor from './components/CodeEditor.vue'
import ResultGrid from './components/ResultGrid.vue'
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
const limit = ref(100)
const sql = ref('SELECT 1 AS result;')
let generatedSql = sql.value
const parameters = ref('[]')
const sqlEditor = ref<InstanceType<typeof CodeEditor>>()
const filter = ref('{}')
const projection = ref('{}')
const sort = ref('{}')
const pipeline = ref('[\n  { "$limit": 100 }\n]')
const primaryKeys = ref<string[]>([])
const structure = ref<OperationResult | null>(null)
const snippets = ref<QuerySnippet[]>([])
const historyOpen = ref(false)
const historyOnlyFavorites = ref(false)
const snippetName = ref('')
const historyError = ref('')
const edit = ref<{ mode: 'insert' | 'update' | 'import'; text: string; original?: SqlRow; originalDocument?: string; count?: number } | null>(null)
const editError = ref('')
const indexDialog = ref(false)
const indexKeys = ref('{ "field": 1 }')
const indexOptions = ref('{ "name": "field_1" }')
const redisPattern = ref('*')
const redisKey = ref('')
const redisNode = ref('')
const redisNodes = ref<string[]>([])
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
const visibleSnippets = computed(() => snippets.value.filter(item => item.kind === props.session.kind && (!historyOnlyFavorites.value || item.favorite)))
const canEditRow = computed(() => editableRows.value && selectedRow.value >= 0 && (isMongo.value ? !!result.value?.documents?.[selectedRow.value] : !!result.value?.rawRows?.[selectedRow.value] && primaryKeys.value.length > 0))
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
async function confirmWrite(_title: string, _details: string): Promise<boolean> {
  if (!props.session.writable) { error.value = '当前会话只读，请先点击右上角“启用写入”。'; return false }
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
    await window.dbex.saveSnippet({ name: text.trim().split('\n')[0].slice(0, 80), text, database: entity.value.database, kind: props.session.kind, favorite: false })
  } catch { notice.value += ' · 查询已执行，但历史记录保存失败' }
}
async function loadData(nextOffset = 0) {
  if (!hasEntity.value || busy.value) return
  offset.value = nextOffset
  editableRows.value = false
  if (isMysql.value) {
    const next = await execute({ action: 'mysql.query', database: entity.value.database, sql: `SELECT * FROM ${quote(entity.value.database)}.${quote(entity.value.entity)}`, offset: nextOffset, limit: limit.value })
    editableRows.value = !!next?.rawRows
  } else if (isMongo.value) {
    const projectionText = projection.value
    const next = await execute({ action: 'mongo.find', ...entity.value, filter: filter.value, projection: projectionText, sort: sort.value, offset: nextOffset, limit: limit.value })
    try { editableRows.value = !!next?.documents && Object.keys(JSON.parse(projectionText || '{}')).length === 0 } catch { editableRows.value = false }
  }
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
function openInsert() { editError.value = ''; edit.value = { mode: 'insert', text: isMysql.value ? '{} ' : '{\n  "name": ""\n}' } }
function openEdit() {
  if (!canEditRow.value) return
  editError.value = ''
  if (isMysql.value) {
    const original = result.value!.rawRows![selectedRow.value]
    edit.value = { mode: 'update', text: JSON.stringify(original, null, 2), original }
  } else {
    const originalDocument = result.value!.documents![selectedRow.value]
    edit.value = { mode: 'update', text: originalDocument, originalDocument }
  }
}
function rowKey(original: SqlRow): SqlRow {
  return Object.fromEntries(primaryKeys.value.map(key => {
    if (!(key in original)) throw new Error(`结果中缺少主键 ${key}`)
    return [key, original[key]]
  }))
}
async function saveEdit() {
  const draft = edit.value
  if (!draft || busy.value) return
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
        JSON.parse(draft.text)
        operation = draft.mode === 'insert'
          ? { action: 'mongo.insert', ...entity.value, documents: [draft.text], confirmed: true }
          : { action: 'mongo.replace', ...entity.value, original: draft.originalDocument!, document: draft.text, confirmed: true }
      }
    }
    if (!await confirmWrite(draft.mode === 'update' ? '保存修改' : '插入记录', `${entityTitle()}\n${draft.mode === 'import' ? `本批 ${draft.count ?? '?'} 条记录。` : '将保存编辑器中的完整记录。'}\nMySQL 修改会核对主键与原始值，MongoDB 修改会核对原始文档。`)) return
    const next = await execute(operation, false)
    if (next) { edit.value = null; await loadData(offset.value) } else editError.value = error.value
  } catch (reason) { editError.value = messageOf(reason) }
}
async function deleteRow() {
  if (!canEditRow.value) return
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
    const saved = await window.dbex.saveSnippet(item ? { ...item, favorite: !item.favorite } : { name: snippetName.value.trim() || t('未命名查询'), kind: props.session.kind, database: entity.value.database, text: isMysql.value ? sql.value : pipeline.value, favorite: true })
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
async function scanRedis(cursor = '0') {
  redisDetail.value = null; redisKey.value = ''
  await execute({ action: 'redis.scan', cursor, pattern: redisPattern.value, node: redisNode.value || undefined })
}
async function openRedis(key?: string, cursor?: string, nextOffset?: number) {
  const target = key || redisKey.value
  if (!target) return
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
  generation++; result.value = null; structure.value = null; primaryKeys.value = []; selectedRow.value = -1; checked.value = []; offset.value = 0; editableRows.value = false
  if (busy.value) { pendingSelection = true; return }
  void refreshSelection(generation)
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++ })
</script>

<template>
  <div class="workbench">
    <header class="workbench-header"><div><span class="eyebrow">{{ session.kind.toUpperCase() }} / {{ session.environment === 'production' ? 'PRODUCTION' : session.environment.toUpperCase() }}</span><h2>{{ node?.label || session.name }}</h2></div><div class="header-tools"><span v-if="session.transaction" class="transaction-badge">{{ t('事务进行中') }}</span><button :class="['btn', session.writable ? 'warning' : 'secondary']" :disabled="busy" @click="toggleWrite">{{ session.writable ? t('写入已启用 · 锁定') : t('只读 · 启用写入') }}</button></div></header>
    <nav class="workbench-tabs"><button :disabled="busy" :class="{ active: tab === 'data' }" @click="changeTab('data')">{{ isRedis ? t('Key 浏览器') : t('数据') }}</button><button v-if="isMysql" :disabled="busy" :class="{ active: tab === 'query' }" @click="changeTab('query')">{{ t('SQL 编辑器') }}</button><button v-if="isMongo" :disabled="busy" :class="{ active: tab === 'aggregation' }" @click="changeTab('aggregation')">Aggregation</button><button v-if="!isRedis" :disabled="busy" :class="{ active: tab === 'structure' }" @click="changeTab('structure')">{{ isMysql ? t('结构与索引') : t('索引') }}</button><button v-if="isRedis" :disabled="busy" :class="{ active: tab === 'console' }" @click="changeTab('console')">{{ t('命令台') }}</button><div class="tab-filler"></div><button v-if="!isRedis" @click="openHistory">{{ t('历史 / 收藏') }}</button></nav>
    <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div>
    <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
    <div v-if="busy" class="operation-progress"><span class="progress-indicator"></span> {{ t('正在执行') }} <button class="btn secondary small" @click="cancel">{{ t('取消并断开') }}</button></div>

    <template v-if="isMysql && tab === 'query'">
      <div class="editor-toolbar"><button class="btn primary" :disabled="busy" @click="runQuery()">{{ t('运行选中 / 全部') }} <kbd>⌘ / Ctrl ↵</kbd></button><label class="inline-field">{{ t('每页') }}<select v-model.number="limit"><option :value="100">100</option><option :value="500">500</option></select></label><span class="toolbar-spacer"></span><button class="btn secondary" :disabled="busy || !session.writable || session.transaction" @click="transaction('mysql.begin')">{{ t('开始事务') }}</button><button class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.commit')">{{ t('提交') }}</button><button class="btn secondary" :disabled="busy || !session.transaction" @click="transaction('mysql.rollback')">{{ t('回滚') }}</button></div>
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
      <div class="editor-toolbar"><button class="btn secondary" :disabled="busy || !hasEntity" @click="loadStructure">{{ t('刷新结构') }}</button><template v-if="isMongo"><button class="btn secondary" :disabled="busy || !hasEntity || !session.writable" @click="indexDialog = true">{{ t('新建索引') }}</button><button class="btn danger-text" :disabled="busy || !session.writable || selectedRow < 0" @click="dropIndex">{{ t('删除选中索引') }}</button></template><span v-if="isMysql" class="muted-text">{{ t('主键：') }}{{ primaryKeys.join(', ') || t('无（记录修改已禁用）') }}</span></div>
      <ResultGrid v-if="structure" :columns="structure.columns" :rows="structure.rows" :selected="selectedRow" @select="selectedRow = $event" />
      <div v-else class="empty-state"><strong>{{ t('选择表或集合查看结构') }}</strong><span>{{ t('从左侧资源树选择一个对象。') }}</span></div>
    </template>
    <template v-else-if="isRedis && tab === 'data'">
      <div class="editor-toolbar"><input v-model="redisPattern" :aria-label="t('Redis Key 匹配模式')" placeholder="Key pattern: user:*" @keyup.enter="scanRedis()" /><select v-if="redisNodes.length > 1" v-model="redisNode" :aria-label="t('Cluster 节点')"><option value="">{{ t('默认节点') }}</option><option v-for="nodeName in redisNodes" :key="nodeName" :value="nodeName">{{ nodeName }}</option></select><button class="btn primary" :disabled="busy" @click="scanRedis()">{{ t('扫描 Key') }}</button><button class="btn danger-text" :disabled="busy || !session.writable || !checked.length" @click="deleteKeys">{{ t('删除选中') }} {{ checked.length || '' }}</button></div>
      <div class="redis-split"><div class="redis-key-list"><ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :checked="checked" :selected="selectedRow" selectable @check="checkRow" @check-all="checkAll" @select="selectedRow = $event" @open="openRedis(result.rows[$event].key)" /><div class="result-footer"><span>{{ t('双击 Key 打开 · 当前页') }} {{ result?.rows.length || 0 }} {{ t('个') }}</span><button v-if="result?.nextCursor" class="btn secondary small" :disabled="busy" @click="scanRedis(result.nextCursor)">{{ t('下一批 →') }}</button></div></div>
        <section class="redis-inspector"><div class="editor-toolbar"><input v-model="redisKey" :aria-label="t('Redis Key 名称')" :placeholder="t('输入 Key 或双击左侧列表')" @keyup.enter="openRedis()" /><button class="btn secondary" :disabled="busy || !redisKey" @click="openRedis()">{{ t('读取') }}</button></div><div class="editor-toolbar"><label class="inline-field">{{ t('类型') }}<select v-model="redisType"><option v-for="kind in Object.keys(mutationCommands)" :key="kind" :value="kind">{{ kind }}</option></select></label><label class="inline-field">{{ t('TTL（秒）') }}<input v-model.number="redisTtl" type="number" min="-1" /></label><button class="btn secondary" :disabled="busy || !session.writable || !redisKey" @click="setTtl">{{ t('保存 TTL') }}</button></div><p class="compact-help">{{ t('TTL = -1 永久，其他值须大于 0。列表与集合按页读取。') }}</p>
          <template v-if="redisType === 'string'"><div class="redis-value-editor"><CodeEditor v-model="redisText" language="plaintext" /></div><div class="editor-toolbar"><button class="btn primary" :disabled="busy || !session.writable || !redisKey || !!redisDetail?.truncated" @click="saveRedisString">{{ t('保存 String') }}</button></div></template>
          <template v-else><ResultGrid v-if="redisDetail" :columns="redisDetail.columns" :rows="redisDetail.rows" /><div v-if="redisDetail?.nextCursor || redisDetail?.nextOffset !== undefined" class="editor-toolbar"><button class="btn secondary" :disabled="busy" @click="openRedis(undefined, redisDetail?.nextCursor, redisDetail?.nextOffset)">{{ t('下一页元素 →') }}</button></div><div class="editor-toolbar"><select v-model="redisMutation" :aria-label="t('Redis 修改命令')"><option v-for="command in mutationCommands[redisType]" :key="command">{{ command }}</option></select><button class="btn primary" :disabled="busy || !session.writable || !redisKey" @click="mutateRedis">{{ t('执行修改') }}</button></div><label class="field mutation-arguments">{{ t('参数（不含命令与 Key）') }}<textarea v-model="redisArguments" rows="3" spellcheck="false" /></label><p class="compact-help">HSET: ["field", "value"] · LPUSH / SADD: ["value"]<br />ZADD: ["1", "member"] · XADD: ["*", "field", "value"]</p></template>
        </section>
      </div>
    </template>
    <template v-else>
      <div v-if="tab === 'data' && isMongo" class="mongo-filters"><label>Filter<textarea v-model="filter" rows="2" spellcheck="false" /></label><label>Projection<textarea v-model="projection" rows="2" spellcheck="false" /></label><label>Sort<textarea v-model="sort" rows="2" spellcheck="false" /></label><button class="btn primary" :disabled="busy || !hasEntity" @click="loadData()">{{ t('查询') }}</button></div>
      <div class="editor-toolbar"><template v-if="tab === 'data' && !isRedis"><button class="btn secondary" :disabled="busy || !hasEntity" @click="loadData(offset)">{{ t('刷新') }}</button><button class="btn secondary" :disabled="busy || !hasEntity || !session.writable" @click="openInsert">{{ t('新增') }}</button><button class="btn secondary" :disabled="busy || !canEditRow || !session.writable" @click="openEdit">{{ t('编辑') }}</button><button class="btn danger-text" :disabled="busy || !canEditRow || !session.writable" @click="deleteRow">{{ t('删除') }}</button><button class="btn secondary" :disabled="busy || !hasEntity || !session.writable" @click="importData">{{ t('导入') }} {{ isMysql ? 'CSV / JSON' : 'EJSON' }}</button></template><span class="toolbar-spacer"></span><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('json')">{{ t('导出当前页 JSON') }}</button><button class="btn secondary small" :disabled="!result?.rows.length" @click="exportData('csv')">CSV</button></div>
      <ResultGrid v-if="result" :columns="result.columns" :rows="result.rows" :selected="selectedRow" :offset="offset" @select="selectedRow = $event" @open="selectedRow = $event; tab === 'data' && !isRedis && openEdit()" />
      <div v-else class="empty-state"><span class="empty-icon">▤</span><strong>{{ hasEntity ? t('运行查询查看结果') : t('选择数据库中的表或集合') }}</strong><span>{{ isMysql ? t('可直接切换到 SQL 编辑器执行查询。') : t('使用左侧资源树选择目标。') }}</span></div>
      <footer class="result-footer"><span>{{ result?.rows.length || 0 }} {{ t('条记录') }}<span v-if="result?.durationMs !== undefined"> · {{ result.durationMs }} ms</span><span v-if="result?.truncated"> {{ t('· 已达到单页限制') }}</span></span><div><button v-if="offset > 0 && tab !== 'aggregation'" class="btn secondary small" :disabled="busy" @click="tab === 'query' ? runQuery(Math.max(0, offset - limit)) : loadData(Math.max(0, offset - limit))">{{ t('← 上一页') }}</button><button v-if="result?.nextOffset !== undefined && tab !== 'aggregation'" class="btn secondary small" :disabled="busy" @click="tab === 'query' ? runQuery(result.nextOffset) : loadData(result.nextOffset)">{{ t('下一页 →') }}</button></div><span>{{ session.writable ? t('可写会话') : t('只读会话') }}</span></footer>
    </template>

    <div v-if="edit" class="modal-backdrop"><section class="dialog document-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title"><header class="dialog-header"><div><span class="eyebrow">{{ entityTitle() }}</span><h2 id="edit-title">{{ edit.mode === 'update' ? t('编辑记录') : edit.mode === 'import' ? t('导入预览') : t('新增记录') }}</h2></div><button class="icon-button" :aria-label="t('关闭')" :disabled="busy" @click="edit = null">×</button></header><div v-if="editError" class="inline-message error" role="alert">{{ localize(editError) }}</div><p class="compact-help">{{ isMysql ? t('JSON 字段值支持字符串、数字、布尔、null；BIGINT / DECIMAL 请使用字符串。省略自增字段可使用默认值。') : t('使用 Extended JSON 保留 ObjectId、Date、Decimal128 等 BSON 类型；修改时必须保留 _id。') }}</p><div class="document-editor"><CodeEditor v-model="edit.text" language="json" :readonly="!session.writable" /></div><footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="edit = null">{{ t('取消') }}</button><button class="btn primary" :disabled="busy || !session.writable" @click="saveEdit">{{ t('审阅并保存') }}</button></footer></section></div>
    <div v-if="indexDialog" class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="index-title"><header class="dialog-header"><h2 id="index-title">{{ t('创建 MongoDB 索引') }}</h2><button class="icon-button" @click="indexDialog = false">×</button></header><div v-if="error" class="inline-message error">{{ localize(error) }}</div><div class="dialog-body"><label class="field field-wide">{{ t('索引字段 JSON') }}<textarea v-model="indexKeys" rows="4" /></label><label class="field field-wide">{{ t('选项 JSON（name / unique / sparse / expireAfterSeconds）') }}<textarea v-model="indexOptions" rows="4" /></label></div><footer class="dialog-footer"><button class="btn secondary" @click="indexDialog = false">{{ t('取消') }}</button><button class="btn primary" :disabled="busy" @click="createIndex">{{ t('审阅并创建') }}</button></footer></section></div>
    <div v-if="historyOpen" class="modal-backdrop"><section class="dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title"><header class="dialog-header"><h2 id="history-title">{{ t('查询历史与收藏') }}</h2><button class="icon-button" @click="historyOpen = false">×</button></header><div v-if="historyError" class="inline-message error">{{ localize(historyError) }}</div><div class="editor-toolbar"><input v-model="snippetName" :placeholder="t('当前编辑器内容的收藏名称')" /><button class="btn primary" @click="favorite()">{{ t('收藏当前内容') }}</button><label class="checkbox-row"><input v-model="historyOnlyFavorites" type="checkbox" /> {{ t('仅收藏') }}</label></div><div class="history-list"><article v-for="item in visibleSnippets" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.database || t('未指定数据库') }} · {{ new Date(item.updatedAt).toLocaleString(locale) }}</small><pre>{{ item.text.slice(0, 600) }}</pre></div><div class="history-actions"><button class="btn secondary small" @click="useSnippet(item)">{{ t('打开') }}</button><button class="btn secondary small" @click="favorite(item)">{{ item.favorite ? t('★ 已收藏') : t('☆ 收藏') }}</button><button class="btn danger-text small" @click="removeSnippet(item)">{{ t('删除') }}</button></div></article><div v-if="!visibleSnippets.length" class="empty-state">{{ t('暂无保存的查询') }}</div></div></section></div>
  </div>
</template>
