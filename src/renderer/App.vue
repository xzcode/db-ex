<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ConnectionDialog from './ConnectionDialog.vue'
import type { ConnectionConfig, DataPreview, ExplorerNode, SavedConnection, SessionInfo } from '../shared/types'

const connections = ref<SavedConnection[]>([])
const sessions = ref<SessionInfo[]>([])
const current = ref<string | null>(null)
const roots = ref<ExplorerNode[]>([])
const childNodes = ref<Record<string, ExplorerNode[]>>({})
const expanded = ref<string[]>([])
const selected = ref<ExplorerNode | null>(null)
const preview = ref<DataPreview | null>(null)
const busy = ref(false)
const message = ref('')
const dialogOpen = ref(false)
const trustCandidate = ref<{ id: string; fingerprint: string } | null>(null)
const redisPattern = ref('*')
const theme = ref<'dark' | 'light'>('dark')
const activeSession = () => sessions.value.find(item => item.id === current.value)

function setError(error: unknown, connectionId?: string) {
  message.value = error instanceof Error ? error.message : String(error)
  const match = /SSH_HOST_KEY_UNTRUSTED:\s*([a-f\d]{64})/i.exec(message.value)
  trustCandidate.value = match && connectionId ? { id: connectionId, fingerprint: match[1].toLowerCase() } : null
}
async function refreshConnections() {
  try { connections.value = await window.dbex.listConnections() }
  catch (error) { setError(error) }
}
async function run<T>(callback: () => Promise<T>): Promise<T | undefined> {
  busy.value = true
  message.value = ''
  trustCandidate.value = null
  try { return await callback() }
  catch (error) { setError(error); return undefined }
  finally { busy.value = false }
}
async function startSession(info: SessionInfo) {
  sessions.value = [...sessions.value, info]
  await switchSession(info.id)
}
async function connectSaved(config: SavedConnection) {
  busy.value = true
  message.value = ''
  trustCandidate.value = null
  try { await startSession(await window.dbex.connectSaved(config.id)) }
  catch (error) { setError(error, config.id) }
  finally { busy.value = false }
}
async function trustHost() {
  const candidate = trustCandidate.value
  if (!candidate) return
  const config = connections.value.find(item => item.id === candidate.id)
  if (!config) return
  const done = await run(async () => {
    await window.dbex.trustHostKey(candidate.id, candidate.fingerprint)
    await refreshConnections()
    return true
  })
  if (done) await connectSaved(config)
}
async function saveConfig(config: ConnectionConfig) {
  const saved = await run(async () => window.dbex.saveConnection(config))
  if (!saved) return
  dialogOpen.value = false
  await refreshConnections()
  await connectSaved(saved)
}
async function temporaryConfig(config: ConnectionConfig) {
  const session = await run(() => window.dbex.connectTemporary(config))
  if (session) { dialogOpen.value = false; await startSession(session) }
}
async function deleteSaved(config: SavedConnection) {
  if (!window.confirm(`删除已保存连接“${config.name}”？这不会删除数据库中的数据。`)) return
  const result = await run(async () => {
    await window.dbex.deleteConnection(config.id)
    sessions.value = sessions.value.filter(item => item.connectionId !== config.id)
    if (!sessions.value.some(item => item.id === current.value)) current.value = null
    await refreshConnections()
    return true
  })
  if (result && current.value === null && sessions.value.length) await switchSession(sessions.value[0].id)
}
async function disconnect(id: string) {
  await run(() => window.dbex.disconnect(id))
  sessions.value = sessions.value.filter(item => item.id !== id)
  if (current.value === id) {
    const next = sessions.value[0]
    if (next) await switchSession(next.id)
    else { current.value = null; roots.value = []; selected.value = null; preview.value = null }
  }
}
async function switchSession(id: string) {
  current.value = id
  selected.value = null
  preview.value = null
  childNodes.value = {}
  expanded.value = []
  await run(async () => { roots.value = await window.dbex.roots(id) })
}
async function toggleRoot(node: ExplorerNode) {
  if (!current.value) return
  selected.value = node
  if (node.kind === 'keyspace') { await searchRedis(); return }
  if (expanded.value.includes(node.id)) {
    expanded.value = expanded.value.filter(id => id !== node.id)
    return
  }
  expanded.value.push(node.id)
  await run(async () => { childNodes.value[node.id] = await window.dbex.children(current.value!, node.database!) })
}
async function selectEntity(node: ExplorerNode) {
  if (!current.value || !node.database || !node.entity) return
  selected.value = node
  preview.value = null
  await run(async () => { preview.value = await window.dbex.preview(current.value!, node.database!, node.entity!) })
}
async function loadMore() {
  if (!current.value || !preview.value || !selected.value) return
  const previous = preview.value
  const node = selected.value
  const next = await run(() => node.kind === 'keyspace'
    ? window.dbex.redisKeys(current.value!, previous.nextCursor, redisPattern.value)
    : window.dbex.preview(current.value!, node.database!, node.entity!, previous.nextOffset))
  if (next) preview.value = {
    ...next,
    columns: [...new Set([...previous.columns, ...next.columns])],
    rows: [...previous.rows, ...next.rows],
  }
}
async function searchRedis() {
  if (!current.value) return
  const node = roots.value[0]
  if (!node) return
  selected.value = node
  const result = await run(() => window.dbex.redisKeys(current.value!, 0, redisPattern.value))
  if (result) preview.value = result
}
async function showRedisValue(key: string) {
  if (!current.value) return
  const result = await run(() => window.dbex.redisValue(current.value!, key))
  if (result) {
    selected.value = { id: `key:${key}`, label: key, kind: 'collection', entity: key }
    preview.value = result
  }
}
function changeTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
}
function kindIcon(kind: string) { return kind === 'mysql' ? '▤' : kind === 'mongodb' ? '◈' : '⬡' }
function kindLabel(kind: string) { return kind === 'mysql' ? 'MySQL' : kind === 'mongodb' ? 'MongoDB' : 'Redis' }
function environmentLabel(kind: string) { return kind === 'production' ? 'PROD' : kind === 'testing' ? 'TEST' : 'DEV' }
onMounted(refreshConnections)
</script>

<template>
  <main class="desktop">
    <header class="topbar">
      <div class="brand"><span class="brand-symbol">▦</span><strong>DB EX</strong><span class="brand-subtitle">DATABASE EXPLORER</span></div>
      <div class="top-actions">
        <span class="top-hint">Local-first · Private workspace</span>
        <button class="icon-button" :title="theme === 'dark' ? '浅色主题' : '深色主题'" @click="changeTheme">{{ theme === 'dark' ? '☼' : '◐' }}</button>
        <button class="btn primary" @click="dialogOpen = true"><span>＋</span> 新建连接</button>
      </div>
    </header>
    <div class="workspace">
      <aside class="sidebar">
        <div class="sidebar-label"><span>CONNECTIONS</span><button class="ghost-icon" title="刷新" @click="refreshConnections">↻</button></div>
        <div v-if="!connections.length" class="sidebar-empty">尚无已保存连接。<br />点击右上角创建第一个连接。</div>
        <div class="saved-list">
          <div v-for="item in connections" :key="item.id" class="connection-item" :class="{ production: item.environment === 'production' }" @dblclick="connectSaved(item)">
            <div class="db-icon" :class="item.kind">{{ kindIcon(item.kind) }}</div>
            <div class="connection-description"><strong :title="item.name">{{ item.name }}</strong><small>{{ item.host }} · {{ kindLabel(item.kind) }}</small></div>
            <span :class="['env-tag', item.environment]">{{ environmentLabel(item.environment) }}</span>
            <button class="ghost-icon connect-action" title="连接" :disabled="busy" @click="connectSaved(item)">⏵</button>
            <button class="ghost-icon delete-action" title="删除配置" :disabled="busy" @click="deleteSaved(item)">×</button>
          </div>
        </div>
        <div class="sidebar-label section-gap"><span>ACTIVE SESSIONS</span><span class="small-count">{{ sessions.length }}</span></div>
        <div v-for="session in sessions" :key="session.id" :class="['active-item', { selected: session.id === current }]" @click="switchSession(session.id)">
          <span class="status-dot"></span><span class="ellipsis">{{ session.name }}</span>
          <button class="ghost-icon" title="断开" @click.stop="disconnect(session.id)">×</button>
        </div>
        <div class="sidebar-bottom"><span class="status-dot"></span> 本地工作空间 <span class="sidebar-version">v0.1</span></div>
      </aside>
      <section class="main-panel">
        <div class="tabbar">
          <div v-if="!sessions.length" class="tab welcome-tab">◈ &nbsp; 欢迎</div>
          <button v-for="session in sessions" :key="session.id" :class="['tab', { active: session.id === current }]" @click="switchSession(session.id)">
            <span class="db-small-icon">{{ kindIcon(session.kind) }}</span>{{ session.name }}<span class="tab-close" @click.stop="disconnect(session.id)">×</span>
          </button>
          <div class="tab-filler"></div><span class="tab-trailing">DB EX CORE</span>
        </div>
        <div v-if="message" class="error-message" role="alert">
          <span>⚠</span><div class="error-text">{{ message }}
            <div v-if="trustCandidate" class="trust-panel"><strong>需要核验 SSH 服务器身份</strong><p>请先通过服务器管理员或可信命令独立核对这段 SHA-256 指纹，确认一致后才接受：</p><code>{{ trustCandidate.fingerprint }}</code><button class="btn secondary" :disabled="busy" @click="trustHost">已独立核对，信任并重连</button></div>
          </div><button class="ghost-icon" title="关闭提示" @click="message = ''; trustCandidate = null">×</button>
        </div>
        <div v-if="!current" class="welcome-body">
          <div class="welcome-illustration">▤</div><span class="eyebrow">YOUR DATA, YOUR WORKSPACE</span>
          <h1>连接你的数据库，<br /><span>专注于真正重要的工作。</span></h1>
          <p>统一管理 MySQL、MongoDB 和 Redis。安全的 SSH 隧道、TLS 连接与只读数据预览。</p>
          <button class="btn primary large" @click="dialogOpen = true">＋ &nbsp; 创建第一个连接</button>
          <div class="welcome-features"><span>◉ 本地优先</span><span>◇ 安全隧道</span><span>▤ 多数据库</span></div>
        </div>
        <div v-else class="data-area">
          <div class="explorer-pane">
            <div class="panel-heading"><span>EXPLORER</span><button class="ghost-icon" title="刷新资源列表" @click="current && switchSession(current)">↻</button></div>
            <div class="resource-list">
              <template v-for="node in roots" :key="node.id">
                <button :class="['resource-node', { active: selected?.id === node.id }]" @click="toggleRoot(node)">
                  <span class="arrow">{{ node.kind === 'keyspace' ? '⬡' : expanded.includes(node.id) ? '⌄' : '›' }}</span><span>▤</span><span class="ellipsis">{{ node.label }}</span>
                </button>
                <template v-if="expanded.includes(node.id)">
                  <button v-for="child in childNodes[node.id] || []" :key="child.id" :class="['resource-node', 'child-node', { active: selected?.id === child.id }]" @click="selectEntity(child)">
                    <span>▦</span><span class="ellipsis">{{ child.label }}</span>
                  </button>
                </template>
              </template>
            </div>
          </div>
          <div class="content-pane">
            <div class="content-head">
              <div><span class="eyebrow">{{ activeSession()?.kind.toUpperCase() }} / DATA BROWSER</span><h2>{{ selected?.label || activeSession()?.name || 'Database Explorer' }}</h2></div>
              <span :class="['env-badge', activeSession()?.environment]">{{ environmentLabel(activeSession()?.environment || '') }}</span>
            </div>
            <div v-if="activeSession()?.kind === 'redis'" class="content-toolbar">
              <input v-model="redisPattern" aria-label="Redis Key 匹配表达式" placeholder="Key pattern, e.g. session:*" @keyup.enter="searchRedis" />
              <button class="btn secondary" :disabled="busy" @click="searchRedis">搜索 Key</button>
            </div>
            <div v-else class="content-toolbar"><span class="readonly-pill">◎ 只读预览</span><span class="toolbar-info">首批版本 · 每页最多 100 条 · 写入工具将在 M2–M4 提供</span></div>
            <div class="preview-container">
              <div v-if="!selected" class="no-selection"><span>▤</span><strong>选择一个数据库或集合</strong><p>从左侧资源浏览器展开数据库并查看记录。</p></div>
              <div v-else-if="!preview" class="no-selection"><span>▦</span><strong>资源已选择</strong><p>{{ busy ? '正在加载…' : '展开数据库或选择表/集合以预览数据。' }}</p></div>
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead><tr><th class="number-cell">#</th><th v-for="column in preview.columns" :key="column">{{ column }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, index) in preview.rows" :key="index" :class="{ 'clickable-row': activeSession()?.kind === 'redis' && selected?.kind === 'keyspace' }" @click="activeSession()?.kind === 'redis' && selected?.kind === 'keyspace' && showRedisValue(row.key)">
                      <td class="number-cell">{{ index + 1 }}</td><td v-for="column in preview.columns" :key="column" :title="row[column]">{{ row[column] ?? '—' }}</td>
                    </tr>
                    <tr v-if="preview.rows.length === 0"><td :colspan="preview.columns.length + 1" class="no-data">暂无记录</td></tr>
                  </tbody>
                </table>
                <div v-if="preview.value" class="value-preview"><pre>{{ preview.value }}</pre></div>
              </div>
            </div>
            <div class="result-footer"><span>记录 {{ preview?.rows.length ?? 0 }} 条{{ busy ? ' · 加载中…' : '' }}</span><button v-if="preview && (preview.nextOffset !== undefined || preview.nextCursor !== undefined)" class="btn secondary small" :disabled="busy" @click="loadMore">加载下一页 →</button><span v-else>READ ONLY</span></div>
          </div>
        </div>
      </section>
    </div>
    <footer class="statusbar"><span class="status-dot"></span> Ready <span class="separator">|</span> {{ activeSession()?.name || 'No active connection' }} <span class="status-right">Electron · Vue 3 · DB EX 0.1</span></footer>
    <ConnectionDialog v-if="dialogOpen" @close="dialogOpen = false" @save="saveConfig" @temporary="temporaryConfig" />
  </main>
</template>
