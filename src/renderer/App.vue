<script setup lang="ts">
import { t, localize, languages, languagePreference, setLanguage } from './i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import ConnectionDialog from './ConnectionDialog.vue'
import ConnectionSidebar from './components/ConnectionSidebar.vue'
import { colorStyle } from '../shared/connection-appearance'
import DatabaseWorkbench from './DatabaseWorkbench.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useConfirmation } from './composables/useConfirmation'
import type { ConnectionAppearancePatch, ConnectionDraft, ExplorerNode, SavedConnection, SessionInfo } from '../shared/types'

interface ExplorerState { roots: ExplorerNode[]; children: Record<string, ExplorerNode[]>; expanded: string[]; selected?: ExplorerNode; busy: boolean; loading: Set<string> }
const connections = ref<SavedConnection[]>([])
const sessions = ref<SessionInfo[]>([])
const explorers = reactive<Record<string, ExplorerState>>({})
const current = ref<string | null>(null)
const activeSession = computed(() => sessions.value.find(item => item.id === current.value))
const currentExplorer = computed(() => current.value ? explorers[current.value] : undefined)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const dialogOpen = ref(false)
const connectionDraft = ref<ConnectionDraft>()
const theme = ref<'dark' | 'light'>('dark')
const sidebarWidth = ref(270)
const explorerWidth = ref(220)
const { confirmation, confirm, answer } = useConfirmation()
let stopResize: (() => void) | undefined

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
async function task<T>(callback: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return undefined
  busy.value = true; error.value = ''; notice.value = ''
  try { return await callback() } catch (reason) { error.value = messageOf(reason); return undefined }
  finally { busy.value = false }
}
async function refreshConnections() {
  try { connections.value = await window.dbex.listConnections() } catch (reason) { error.value = messageOf(reason) }
}
async function refreshRoots(id: string) {
  const state = explorers[id]
  if (!state || state.busy) return
  state.busy = true
  try {
    const roots = await window.dbex.roots(id)
    if (explorers[id] !== state) return
    state.roots = roots; state.children = {}; state.expanded = []
    if (sessions.value.find(item => item.id === id)?.kind === 'redis') state.selected = roots[0]
  } catch (reason) { if (explorers[id] === state) error.value = messageOf(reason) }
  finally { if (explorers[id] === state) state.busy = false }
}
async function startSession(session: SessionInfo) {
  if (sessions.value.some(item => item.id === session.id)) { current.value = session.id; return }
  explorers[session.id] = { roots: [], children: {}, expanded: [], busy: false, loading: new Set() }
  sessions.value.push(session); current.value = session.id
  await refreshRoots(session.id)
}
function updateSession(session: SessionInfo) { sessions.value = sessions.value.map(item => item.id === session.id ? session : item) }
async function connectSaved(connection: SavedConnection) {
  const existing = sessions.value.find(item => item.connectionId === connection.id)
  if (existing) { current.value = existing.id; return }
  const session = await task(() => window.dbex.connectSaved(connection.id))
  if (session) await startSession(session)
}
async function updateAppearance(id: string, patch: ConnectionAppearancePatch) {
  await task(async () => {
    const updated = await window.dbex.updateConnectionAppearance(id, patch)
    connections.value = connections.value.map(item => item.id === id ? updated : item)
  })
}
function sessionColor(session?: SessionInfo): string | undefined {
  return connections.value.find(item => item.id === session?.connectionId)?.color
}
function newConnection() { connectionDraft.value = undefined; dialogOpen.value = true }
async function editConnection(connection: SavedConnection) {
  const draft = await task(() => window.dbex.editConnection(connection.id))
  if (draft) { connectionDraft.value = draft; dialogOpen.value = true }
}
async function deleteConnection(connection: SavedConnection) {
  if (!await confirm({ title: t('删除保存的连接'), message: t('删除“{0}”的本地连接配置，并断开其活动会话。未提交事务将回滚；数据库中已提交的数据不受影响。', [connection.name]), danger: true, confirmLabel: t('删除配置') })) return
  await task(async () => { await window.dbex.deleteConnection(connection.id); for (const session of [...sessions.value]) if (session.connectionId === connection.id) removeSession(session.id); await refreshConnections() })
}
function removeSession(id: string) {
  sessions.value = sessions.value.filter(item => item.id !== id)
  delete explorers[id]
  if (current.value === id) current.value = sessions.value[0]?.id || null
}
async function disconnect(id: string) {
  const session = sessions.value.find(item => item.id === id)
  if (!session) return
  if (session.transaction && !await confirm({ title: t('断开并回滚事务'), message: t('“{0}”仍有打开的事务。断开连接会回滚尚未提交的修改。', [session.name]), danger: true, confirmLabel: t('回滚并断开') })) return
  await task(async () => { await window.dbex.disconnect(id); removeSession(id) })
}
async function toggleRoot(node: ExplorerNode) {
  const id = current.value
  const state = id ? explorers[id] : undefined
  if (!id || !state || state.loading.has(node.id)) return
  state.selected = node
  if (node.kind === 'keyspace') return
  if (state.expanded.includes(node.id)) { state.expanded = state.expanded.filter(value => value !== node.id); return }
  state.expanded.push(node.id)
  if (state.children[node.id]) return
  state.loading.add(node.id)
  try {
    const children = await window.dbex.children(id, node.database || node.label)
    if (explorers[id] === state) state.children[node.id] = children
  } catch (reason) { if (explorers[id] === state) error.value = messageOf(reason) }
  finally { if (explorers[id] === state) state.loading.delete(node.id) }
}
function selectEntity(node: ExplorerNode) { if (currentExplorer.value) currentExplorer.value.selected = node }
async function importConnections() {
  await task(async () => { const count = await window.dbex.importConnections(); await refreshConnections(); notice.value = `已导入 ${count} 个连接配置` })
}
async function exportConnections(id?: string) {
  await task(async () => { if (await window.dbex.exportConnections(id)) notice.value = '连接备份已导出（包含加密凭据），其他 DB EX 可直接导入，请妥善保管文件。' })
}
function persistView() {
  try { localStorage.setItem('dbex.view', JSON.stringify({ theme: theme.value, sidebar: sidebarWidth.value, explorer: explorerWidth.value })) } catch { /* UI preferences are optional. */ }
}
function changeTheme() { theme.value = theme.value === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme.value; persistView() }
function resize(event: PointerEvent, pane: 'sidebar' | 'explorer') {
  event.preventDefault(); stopResize?.()
  const start = event.clientX
  const width = pane === 'sidebar' ? sidebarWidth : explorerWidth
  const initial = width.value
  const direction = document.documentElement.dir === 'rtl' ? -1 : 1
  function move(value: PointerEvent) { width.value = Math.max(170, Math.min(400, initial + direction * (value.clientX - start))) }
  function stop() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.classList.remove('resizing'); persistView(); stopResize = undefined }
  stopResize = stop
  document.body.classList.add('resizing')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true })
}
function resizeKey(event: KeyboardEvent, pane: 'sidebar' | 'explorer') {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const width = pane === 'sidebar' ? sidebarWidth : explorerWidth
  width.value = Math.max(170, Math.min(400, width.value + (event.key === 'ArrowRight' ? 10 : -10) * (document.documentElement.dir === 'rtl' ? -1 : 1))); persistView()
}
function kindIcon(kind: string) { return kind === 'mysql' ? '▤' : kind === 'mongodb' ? '◈' : '⬡' }
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('dbex.view') || '{}')
    if (saved.theme === 'light' || saved.theme === 'dark') theme.value = saved.theme
    if (Number.isFinite(saved.sidebar)) sidebarWidth.value = Math.max(170, Math.min(400, saved.sidebar))
    if (Number.isFinite(saved.explorer)) explorerWidth.value = Math.max(170, Math.min(400, saved.explorer))
  } catch { /* Ignore invalid preference data. */ }
  document.documentElement.dataset.theme = theme.value
  void refreshConnections()
})
onBeforeUnmount(() => stopResize?.())
</script>

<template>
  <main class="desktop" :style="{ '--sidebar-width': sidebarWidth + 'px', '--explorer-width': explorerWidth + 'px' }">
    <header class="topbar"><div class="brand"><span class="brand-symbol">▦</span><strong>DB EX</strong><span class="brand-subtitle">DATABASE WORKSPACE</span></div><div class="top-actions"><select class="language-select" :aria-label="t('语言')" :title="t('语言设置')" :value="languagePreference" @change="setLanguage(($event.target as HTMLSelectElement).value)"><option value="system">{{ t('跟随系统') }}</option><option v-for="language in languages" :key="language.locale" :value="language.locale" :lang="language.locale" :dir="language.direction">{{ language.label }}</option></select><span class="top-hint">{{ t('本地优先 · 内置加密') }}</span><button class="icon-button" :title="theme === 'dark' ? t('浅色主题') : t('深色主题')" @click="changeTheme">{{ theme === 'dark' ? '☼' : '◐' }}</button><button class="btn primary" :disabled="busy" @click="newConnection">{{ t('＋ 新建连接') }}</button></div></header>
    <div class="workspace"><ConnectionSidebar :connections="connections" :sessions="sessions" :current="current" :busy="busy" @refresh="refreshConnections" @create="newConnection" @connect="connectSaved" @activate="current = $event" @disconnect="disconnect" @edit="editConnection" @remove="deleteConnection" @import="importConnections" @export="exportConnections" @appearance="updateAppearance" />
      <div class="resize-handle" role="separator" :aria-label="t('调整连接列表宽度')" aria-orientation="vertical" :aria-valuenow="sidebarWidth" :aria-valuemin="170" :aria-valuemax="400" tabindex="0" @pointerdown="resize($event, 'sidebar')" @keydown="resizeKey($event, 'sidebar')"></div>
      <section class="main-panel"><div class="tabbar"><div v-if="!sessions.length" class="tab active">{{ t('欢迎') }}</div><div v-for="session in sessions" :key="session.id" :class="['session-tab', { active: current === session.id, 'has-color': !!sessionColor(session) }]" :style="colorStyle(sessionColor(session))" :data-color="sessionColor(session) || ''"><button class="tab" @click="current = session.id"><span :class="['db-small-icon', session.kind]">{{ kindIcon(session.kind) }}</span>{{ session.name }}</button><button class="tab-close" :title="t('断开 {0}', [session.name])" :disabled="busy" @click="disconnect(session.id)">×</button></div><div class="tab-filler"></div><span v-if="busy" class="tab-trailing">{{ t('正在连接 / 处理…') }}</span></div><div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div><div v-if="notice" class="inline-message notice">{{ localize(notice) }}</div>
        <div v-if="!current" class="welcome-body"><div class="welcome-mark">▦</div><span class="eyebrow">YOUR DATA, YOUR WORKSPACE</span><h1>{{ t('一个工作空间，') }}<br /><span>{{ t('连接你的数据库。') }}</span></h1><p>{{ t('MySQL 查询与事务、MongoDB 文档、Redis 数据管理。') }}<br />{{ t('SSH 多跳、代理与 TLS，按你的网络方式连接。') }}</p><button class="btn primary large" @click="newConnection">{{ t('＋ 创建数据库连接') }}</button><div class="welcome-features"><span>MySQL</span><span>MongoDB</span><span>Redis</span></div></div>
        <div v-else class="data-area"><aside :class="['explorer-pane', { 'has-color': !!sessionColor(activeSession) }]" :style="colorStyle(sessionColor(activeSession))"><div class="panel-heading"><span>{{ t('资源浏览器') }}</span><button class="ghost-icon" :title="t('刷新资源树')" :disabled="currentExplorer?.busy" @click="current && refreshRoots(current)">↻</button></div><div v-if="currentExplorer?.busy" class="compact-help">{{ t('正在加载资源…') }}</div><div class="resource-list"><template v-for="node in currentExplorer?.roots || []" :key="node.id"><button :class="['resource-node', { active: currentExplorer?.selected?.id === node.id }]" @click="toggleRoot(node)"><span class="arrow">{{ node.kind === 'keyspace' ? '⬡' : currentExplorer?.expanded.includes(node.id) ? '⌄' : '›' }}</span><span>▤</span><span class="ellipsis">{{ node.label }}</span><span v-if="currentExplorer?.loading.has(node.id)">…</span></button><template v-if="currentExplorer?.expanded.includes(node.id)"><button v-for="child in currentExplorer.children[node.id] || []" :key="child.id" :class="['resource-node', 'child-node', { active: currentExplorer.selected?.id === child.id }]" @click="selectEntity(child)"><span>▦</span><span class="ellipsis">{{ child.label }}</span></button><span v-if="!currentExplorer.loading.has(node.id) && !currentExplorer.children[node.id]?.length" class="empty-tree">{{ t('无可见对象') }}</span></template></template></div></aside><div class="resize-handle" role="separator" :aria-label="t('调整资源树宽度')" aria-orientation="vertical" :aria-valuenow="explorerWidth" :aria-valuemin="170" :aria-valuemax="400" tabindex="0" @pointerdown="resize($event, 'explorer')" @keydown="resizeKey($event, 'explorer')"></div><div class="content-pane"><DatabaseWorkbench v-for="session in sessions" v-show="session.id === current" :key="session.id" :session="session" :node="explorers[session.id]?.selected" @update-session="updateSession" @disconnect="removeSession(session.id)" @refresh-tree="refreshRoots(session.id)" /></div></div>
      </section>
    </div>
    <footer class="statusbar"><span class="status-dot"></span>{{ activeSession ? activeSession.displayHost : 'Ready' }}<span class="separator">|</span>{{ activeSession?.name || t('未连接数据库') }}<span v-if="activeSession?.transaction" class="transaction-text">{{ t('事务尚未提交') }}</span><span class="status-right">DB EX · Core Preview</span></footer>
    <ConnectionDialog v-if="dialogOpen" :draft="connectionDraft" @close="dialogOpen = false" @saved="refreshConnections" @connected="startSession" />
    <ConfirmDialog v-if="confirmation" v-bind="confirmation" @confirm="answer(true)" @cancel="answer(false)" />
  </main>
</template>
