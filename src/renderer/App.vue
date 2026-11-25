<script setup lang="ts">
import { databaseCapabilities } from '../shared/database-capabilities'
import { t, localize } from './i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ConnectionDialog from './ConnectionDialog.vue'
import ConnectionSidebar from './components/ConnectionSidebar.vue'
import { colorStyle } from '../shared/connection-appearance'
import DatabaseWorkbench from './DatabaseWorkbench.vue'
import { mongoCategory, mongoCategoryNodes } from '../shared/mongo-catalog'
import { protectedDatabase } from '../shared/database-admin'
import PreferencesDialog from './components/PreferencesDialog.vue'
import { normalizeWorkspace, workspacePosition, categoryForNode, matchWorkspaceNode, validWorkbenchTab, type WorkspacePosition, type WorkbenchTab } from '../shared/workspace-recovery'
import { preferences, resolvedTheme } from './preferences'
import NativeToolDialog from './components/NativeToolDialog.vue'
import DatabaseActionsDialog from './components/DatabaseActionsDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useConfirmation } from './composables/useConfirmation'
import type { ConnectionAppearancePatch, ConnectionDraft, ExplorerNode, SavedConnection, SessionInfo } from '../shared/types'

interface ExplorerState { roots: ExplorerNode[]; children: Record<string, ExplorerNode[]>; expanded: string[]; selected?: ExplorerNode; tab?:WorkbenchTab; busy: boolean; loading: Set<string> }
const connections = ref<SavedConnection[]>([])
const sessions = ref<SessionInfo[]>([])
const explorers = reactive<Record<string, ExplorerState>>({})
const current = ref<string | null>(null)
const activeSession = computed(() => sessions.value.find(item => item.id === current.value))
const currentExplorer = computed(() => current.value ? explorers[current.value] : undefined)
function expandable(node:ExplorerNode) { return node.kind==='database' || node.kind==='mongo-category' && !!mongoCategory(node.category)?.expandable }
function nodeIcon(node:ExplorerNode) {
  if(node.kind==='mongo-category')return mongoCategory(node.category)?.icon||'▦'
  return node.kind==='database'?'▤':node.kind==='view'?'◉':node.kind==='mongo-indexes'?'A–Z':node.kind==='mongo-function'?'ƒ':node.kind==='gridfs-bucket'?'▣':node.kind==='keyspace'?'⬡':'▦'
}
const visibleTree = computed(() => {
  const state=currentExplorer.value
  const rows:{node:ExplorerNode;depth:number;empty?:boolean}[]=[]
  if(!state)return rows
  function visit(node:ExplorerNode,depth:number) {
    rows.push({node,depth})
    if(!state!.expanded.includes(node.id))return
    const children=state!.children[node.id]
    if(children) {
      if(!children.length&&!state!.loading.has(node.id)) rows.push({node,depth:depth+1,empty:true})
      else for(const child of children)visit(child,depth+1)
    }
  }
  for(const node of state.roots)visit(node,0)
  return rows
})
type DatabaseMode='create'|'drop'|'search'|'import'|'export'|'schema'
const dbMenu=ref<{sessionId:string;node?:ExplorerNode;x:number;y:number}>()
const dbMenuHost=ref<HTMLElement>()
const nativeDialog=ref<{sessionId:string;database:string}>()
const nativeSession=computed(()=>sessions.value.find(item=>item.id===nativeDialog.value?.sessionId))
const dbDialog=ref<{sessionId:string;database:string;mode:DatabaseMode}>()
const dbDialogSession=computed(()=>sessions.value.find(item=>item.id===dbDialog.value?.sessionId))
const dbMenuSession=computed(()=>sessions.value.find(item=>item.id===dbMenu.value?.sessionId))
const busy = ref(false)
const error = ref('')
const notice = ref('')
const dialogOpen = ref(false)
const connectionDraft = ref<ConnectionDraft>()
const theme = computed(()=>resolvedTheme(preferences.value.theme))
const preferencesOpen=ref(false)
function settingsKey(event:KeyboardEvent){if((event.metaKey||event.ctrlKey)&&event.key===','){event.preventDefault();if(!dialogOpen.value)preferencesOpen.value=true}}
const sidebarWidth = ref(270)
const explorerWidth = ref(220)
const { confirmation, confirm, answer } = useConfirmation()
let stopResize: (() => void) | undefined
let restoringWorkspace=true
const workspaceReady=ref(false)
function workspaceSnapshot(){
  const positions:Record<string,WorkspacePosition>=Object.create(null)
  const ids:string[]=[]
  for(const s of sessions.value){
    if(!s.connectionId||ids.includes(s.connectionId))continue
    ids.push(s.connectionId)
    const state=explorers[s.id]
    positions[s.connectionId]=workspacePosition(state?.selected,state?.tab)
  }
  return normalizeWorkspace({ids,active:activeSession.value?.connectionId,positions})
}
function persistWorkspace(){if(restoringWorkspace)return;try{localStorage.setItem('dbex.workspace.v1',JSON.stringify(workspaceSnapshot()))}catch{}}
watch(workspaceSnapshot,persistWorkspace,{deep:true})
function workbenchTabChanged(id:string,tab:WorkbenchTab){const state=explorers[id];if(state)state.tab=tab}
async function restorePosition(session:SessionInfo,position:WorkspacePosition|undefined){
  const state=explorers[session.id]
  if(!state||!position)return
  state.tab=validWorkbenchTab(session.kind,position.tab)
  const desired=position.node
  if(!desired)return
  const root=state.roots.find(n=>n.database===desired.database)
  if(!root)return
  if(desired.kind==='database'||desired.kind==='keyspace'){state.selected=root;return}
  if(desired.kind==='database-query'&&databaseCapabilities(session.kind).editor==='query'){
    state.selected={id:JSON.stringify(['restored-query',desired.database]),kind:'database-query',label:'新建查询',database:desired.database};return
  }
  const children=await window.dbex.children(session.id,root.database||root.label)
  state.children[root.id]=children;state.expanded=[root.id]
  let found=matchWorkspaceNode(children,desired)
  if(session.kind==='mongodb'&&!found){
    const category=categoryForNode(desired)
    const folder=children.find(n=>n.kind==='mongo-category'&&n.category===category)
    if(folder&&expandable(folder)){
      const objects=await window.dbex.children(session.id,root.database||root.label,category)
      state.children[folder.id]=objects;state.expanded.push(folder.id)
      found=matchWorkspaceNode(objects,desired)
    }
  }
  state.selected=found||root;state.tab=validWorkbenchTab(session.kind,position.tab,state.selected.readOnly)
}

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
    if (state.selected?.database && !roots.some(root=>root.database===state.selected?.database)) state.selected=undefined
    if (sessions.value.find(item => item.id === id)?.kind === 'redis') state.selected = roots[0]
  } catch (reason) { if (explorers[id] === state) error.value = messageOf(reason) }
  finally { if (explorers[id] === state) state.busy = false }
}
async function startSession(session: SessionInfo) {
  if (sessions.value.some(item => item.id === session.id)) { current.value = session.id; return }
  explorers[session.id] = { roots: [], children: {}, expanded: [], busy: false, loading: new Set() }
  sessions.value.push(session); current.value = session.id
  if(session.connectionId){try{localStorage.setItem('dbex.last-connection',session.connectionId)}catch{}}
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
function closeDbMenu(){dbMenu.value=undefined}
function outsideMenu(event:PointerEvent){if(dbMenu.value&&!dbMenuHost.value?.contains(event.target as Node))closeDbMenu()}
function menuKey(event:KeyboardEvent){if(event.key==='Escape')closeDbMenu()}
async function showDbMenu(event:MouseEvent|KeyboardEvent,node?:ExplorerNode){
  if(!activeSession.value||databaseCapabilities(activeSession.value.kind).browser==='keyspace'||busy.value||currentExplorer.value?.busy||dbDialog.value)return
  if(node&&node.kind!=='database')return
  event.preventDefault();event.stopPropagation()
  const rect=(event.currentTarget as HTMLElement).getBoundingClientRect()
  const mouse='clientX' in event
  dbMenu.value={sessionId:activeSession.value.id,node,x:Math.max(4,Math.min(mouse?event.clientX:rect.left,window.innerWidth-254)),y:Math.max(4,Math.min(mouse?event.clientY:rect.bottom,window.innerHeight-60))}
  await nextTick()
  if(dbMenu.value&&dbMenuHost.value){
    dbMenu.value.y=Math.max(4,Math.min(dbMenu.value.y,window.innerHeight-dbMenuHost.value.getBoundingClientRect().height-4))
    dbMenuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true})
  }
}
let querySerial=0
function clearDatabase(state:ExplorerState,database:string){
  for(const key of Object.keys(state.children)){
    const root=state.roots.find(item=>item.id===key)
    if(root?.database===database||state.children[key]?.some(item=>item.database===database)){
      delete state.children[key];state.expanded=state.expanded.filter(id=>id!==key)
    }
  }
  if(state.selected?.database===database)state.selected=undefined
}
function dbMenuAction(action:DatabaseMode|'close'|'query'|'refresh'|'native'|'sqlite-backup'){
  const menu=dbMenu.value, session=dbMenuSession.value
  closeDbMenu()
  if(!menu||!session||current.value!==session.id)return
  const state=explorers[session.id],database=menu.node?.database||''
  if(!state)return
  if(action==='sqlite-backup'){if(databaseCapabilities(session.kind).backup==='file')void task(async()=>{if(await window.dbex.backupSqlite(session.id))notice.value='操作已完成'});return}
  if(action==='native'){if(database&&databaseCapabilities(session.kind).backup==='native-tools')nativeDialog.value={sessionId:session.id,database};return}
  if(action==='refresh'){void refreshRoots(session.id);return}
  if(action==='close'){clearDatabase(state,database);return}
  if(action==='query'){
    if(!database)return
    state.selected=session.kind==='mongodb'?{...mongoCategoryNodes(database).find(item=>item.category==='queries')!,id:JSON.stringify(['new-query',database,++querySerial])}:{id:JSON.stringify(['new-query',database,++querySerial]),label:'新建查询',database,kind:'database-query'}
    return
  }
  if(!databaseCapabilities(session.kind).databaseAdministration&&(action==='create'||action==='drop'))return
  if(action!=='create'&&!database)return
  if(action==='drop'&&(protectedDatabase(session.kind,database)||session.transaction))return
  dbDialog.value={sessionId:session.id,database,mode:action}
}
async function databaseChanged(database:string){
  const dialog=dbDialog.value
  if(!dialog)return
  dbDialog.value=undefined
  const state=explorers[dialog.sessionId]
  if(state)clearDatabase(state,database)
  notice.value=dialog.mode==='drop'?'数据库已删除':'数据库已创建'
  await refreshRoots(dialog.sessionId)
}
function databaseObjectSelected(node:ExplorerNode){
  const dialog=dbDialog.value
  if(!dialog)return
  dbDialog.value=undefined
  const state=explorers[dialog.sessionId]
  if(state)state.selected=node
}
watch(current,()=>{closeDbMenu();const id=activeSession.value?.connectionId;if(id){try{localStorage.setItem('dbex.last-connection',id)}catch{}}})
async function toggleRoot(node: ExplorerNode) {
  const id = current.value
  const state = id ? explorers[id] : undefined
  if (!id || !state || state.loading.has(node.id)) return
  state.selected = node
  if (!expandable(node)) return
  if (state.expanded.includes(node.id)) { state.expanded = state.expanded.filter(value => value !== node.id); return }
  state.expanded.push(node.id)
  if (state.children[node.id]) return
  state.loading.add(node.id)
  try {
    const children = await window.dbex.children(id, node.database || node.label, node.category)
    if (explorers[id] === state) state.children[node.id] = children
  } catch (reason) { if (explorers[id] === state) { error.value = messageOf(reason); state.expanded=state.expanded.filter(value=>value!==node.id) } }
  finally { if (explorers[id] === state) state.loading.delete(node.id) }
}
async function importConnections() {
  await task(async () => { const count = await window.dbex.importConnections(); await refreshConnections(); notice.value = `已导入 ${count} 个连接配置` })
}
async function exportConnections(id?: string) {
  await task(async () => { if (await window.dbex.exportConnections(id)) notice.value = '连接备份已导出（包含加密凭据），其他 DB EX 可直接导入，请妥善保管文件。' })
}
function persistView() {
  try { localStorage.setItem('dbex.view', JSON.stringify({ theme: theme.value, sidebar: sidebarWidth.value, explorer: explorerWidth.value })) } catch { /* UI preferences are optional. */ }
}
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
function kindIcon(kind: string) { return kind==='mariadb'?'▥':kind === 'sqlite'?'▧':kind === 'mysql' ? '▤' : kind === 'mongodb' ? '◈' : '⬡' }
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('dbex.view') || '{}')
    if (Number.isFinite(saved.sidebar)) sidebarWidth.value = Math.max(170, Math.min(400, saved.sidebar))
    if (Number.isFinite(saved.explorer)) explorerWidth.value = Math.max(170, Math.min(400, saved.explorer))
  } catch { /* Ignore invalid preference data. */ }
  document.documentElement.dataset.theme = theme.value
  window.addEventListener('pointerdown',outsideMenu); window.addEventListener('keydown',menuKey); window.addEventListener('keydown',settingsKey); window.addEventListener('resize',closeDbMenu)
  void (async()=>{
    try{
      await refreshConnections()
      if(preferences.value.startup==='lastConnection'){
        const id=localStorage.getItem('dbex.last-connection');const item=connections.value.find(value=>value.id===id&&!value.locked)
        if(item&&!sessions.value.length)await connectSaved(item)
      }else if(preferences.value.startup==='workspace'){
        const saved=normalizeWorkspace(JSON.parse(localStorage.getItem('dbex.workspace.v1')||'{}'))
        for(const id of saved.ids){const item=connections.value.find(value=>value.id===id&&!value.locked);if(item){await connectSaved(item);const session=sessions.value.find(s=>s.connectionId===id);if(session)try{await restorePosition(session,saved.positions[id])}catch(reason){error.value=messageOf(reason)}}}
        const active=sessions.value.find(s=>s.connectionId===saved.active);if(active)current.value=active.id
      }
    }catch{}finally{restoringWorkspace=false;workspaceReady.value=true;persistWorkspace()}
  })()
})
onBeforeUnmount(() => { stopResize?.(); window.removeEventListener('pointerdown',outsideMenu); window.removeEventListener('keydown',menuKey); window.removeEventListener('keydown',settingsKey); window.removeEventListener('resize',closeDbMenu) })
</script>

<template>
  <main class="desktop" :style="{ '--sidebar-width': sidebarWidth + 'px', '--explorer-width': explorerWidth + 'px' }">
    <header class="topbar"><div class="brand"><span class="brand-symbol">▦</span><strong>DB EX</strong><span class="brand-subtitle">DATABASE WORKSPACE</span></div><div class="top-actions"><button class="icon-button preferences-button" :aria-label="t('偏好设置')" :title="t('偏好设置')" @click="preferencesOpen=true">⚙</button></div></header>
    <div class="workspace"><ConnectionSidebar :connections="connections" :sessions="sessions" :current="current" :busy="busy" @refresh="refreshConnections" @create="newConnection" @connect="connectSaved" @activate="current = $event" @disconnect="disconnect" @edit="editConnection" @remove="deleteConnection" @import="importConnections" @export="exportConnections" @appearance="updateAppearance" />
      <div class="resize-handle" role="separator" :aria-label="t('调整连接列表宽度')" aria-orientation="vertical" :aria-valuenow="sidebarWidth" :aria-valuemin="170" :aria-valuemax="400" tabindex="0" @pointerdown="resize($event, 'sidebar')" @keydown="resizeKey($event, 'sidebar')"></div>
      <section class="main-panel"><div v-show="preferences.alwaysShowTabs || sessions.length > 1" class="tabbar"><div v-if="!sessions.length" class="tab active">{{ t('欢迎') }}</div><div v-for="session in sessions" :key="session.id" :class="['session-tab', { active: current === session.id, 'has-color': !!sessionColor(session) }]" :style="colorStyle(sessionColor(session))" :data-color="sessionColor(session) || ''"><button class="tab" @click="current = session.id"><span :class="['db-small-icon', session.kind]">{{ kindIcon(session.kind) }}</span>{{ session.name }}</button><button class="tab-close" :title="t('断开 {0}', [session.name])" :disabled="busy" @click="disconnect(session.id)">×</button></div><div class="tab-filler"></div><span v-if="busy" class="tab-trailing">{{ t('正在连接 / 处理…') }}</span></div><div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div><div v-if="notice" class="inline-message notice">{{ localize(notice) }}</div>
        <div v-if="!current" class="welcome-body"><div class="welcome-mark">▦</div><span class="eyebrow">YOUR DATA, YOUR WORKSPACE</span><h1>{{ t('一个工作空间，') }}<br /><span>{{ t('连接你的数据库。') }}</span></h1><p>{{ t('MySQL 查询与事务、MongoDB 文档、Redis 数据管理。') }}<br />{{ t('SSH 多跳、代理与 TLS，按你的网络方式连接。') }}</p><button class="btn primary large" @click="newConnection">{{ t('＋ 创建数据库连接') }}</button><div class="welcome-features"><span>MySQL</span><span>MariaDB</span><span>MongoDB</span><span>Redis</span><span>SQLite</span></div></div>
        <div v-else class="data-area"><aside :class="['explorer-pane', { 'has-color': !!sessionColor(activeSession) }]" :style="colorStyle(sessionColor(activeSession))"><div class="panel-heading"><span>{{ t('资源浏览器') }}</span><button v-if="activeSession?.kind !== 'redis'" class="ghost-icon" :title="t('数据库菜单')" :aria-label="t('数据库菜单')" :disabled="currentExplorer?.busy" @click="showDbMenu($event)">···</button><button class="ghost-icon" :title="t('刷新资源树')" :disabled="currentExplorer?.busy" @click="current && refreshRoots(current)">↻</button></div><div v-if="currentExplorer?.busy" class="compact-help">{{ t('正在加载资源…') }}</div><div class="resource-list" @scroll="closeDbMenu" @contextmenu.self="showDbMenu($event)"><template v-for="item in visibleTree" :key="item.node.id + (item.empty ? ':empty' : '')"><span v-if="item.empty" class="empty-tree" :style="{ paddingInlineStart: (10 + item.depth * 17) + 'px' }">{{ t('无可见对象') }}</span><button v-else :class="['resource-node', { 'child-node': item.depth > 0, 'mongo-folder': item.node.kind === 'mongo-category', active: currentExplorer?.selected?.id === item.node.id }]" :style="{ paddingInlineStart: (10 + item.depth * 17) + 'px' }" :data-object-kind="item.node.kind" :data-object-type="item.node.objectType" :data-object-category="item.node.category" :aria-expanded="expandable(item.node) ? currentExplorer?.expanded.includes(item.node.id) : undefined" @click="toggleRoot(item.node)" @contextmenu="showDbMenu($event,item.node)" @keydown.shift.f10="showDbMenu($event,item.node)"><span class="arrow">{{ expandable(item.node) ? currentExplorer?.expanded.includes(item.node.id) ? '⌄' : '›' : '' }}</span><span :class="['object-tree-icon', item.node.kind]">{{ nodeIcon(item.node) }}</span><span class="ellipsis">{{ item.node.kind === 'mongo-category' ? t(item.node.label) : item.node.label }}</span><small v-if="item.node.objectType" class="muted-text" :title="item.node.objectType">{{ item.node.objectType==='sequence'?'SEQ':'SV' }}</small><span v-if="currentExplorer?.loading.has(item.node.id)">…</span></button></template></div></aside><div class="resize-handle" role="separator" :aria-label="t('调整资源树宽度')" aria-orientation="vertical" :aria-valuenow="explorerWidth" :aria-valuemin="170" :aria-valuemax="400" tabindex="0" @pointerdown="resize($event, 'explorer')" @keydown="resizeKey($event, 'explorer')"></div><div class="content-pane"><template v-if="workspaceReady"><DatabaseWorkbench v-for="session in sessions" v-show="session.id === current" :key="session.id" :session="session" :node="explorers[session.id]?.selected" :initial-tab="explorers[session.id]?.tab" @tab-change="workbenchTabChanged(session.id,$event)" :table-suggestions="Object.values(explorers[session.id]?.children || {}).flat().filter(n=>n.kind==='table'||n.kind==='view').map(n=>n.label)" @update-session="updateSession" @disconnect="removeSession(session.id)" @refresh-tree="refreshRoots(session.id)" /></template></div></div>
      </section>
    </div>
    <footer class="statusbar"><span class="status-dot"></span>{{ activeSession ? activeSession.displayHost : 'Ready' }}<span class="separator">|</span>{{ activeSession?.name || t('未连接数据库') }}<span v-if="activeSession?.transaction" class="transaction-text">{{ t('事务尚未提交') }}</span><span class="status-right">DB EX · Core Preview</span></footer>
    <Teleport to="body"><div v-if="dbMenu" ref="dbMenuHost" class="connection-context-menu database-context-menu" :style="{left:dbMenu.x+'px',top:dbMenu.y+'px'}" @contextmenu.prevent @pointerdown.stop>
      <div class="context-title"><strong>{{ dbMenu.node?.label || dbMenuSession?.name }}</strong></div>
      <button v-if="dbMenu.node" class="context-action" @click="dbMenuAction('close')">{{ t('关闭数据库') }}</button>
      <button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).databaseAdministration" class="context-action" :disabled="dbMenuSession?.transaction" @click="dbMenuAction('create')">{{ t('新建数据库') }}…</button>
      <button v-if="dbMenu.node && dbMenuSession && databaseCapabilities(dbMenuSession.kind).databaseAdministration" class="context-action danger" :disabled="protectedDatabase(dbMenuSession?.kind || 'mongodb',dbMenu.node.database || '') || dbMenuSession?.transaction" @click="dbMenuAction('drop')">{{ t('删除数据库') }}…</button>
      <template v-if="dbMenu.node"><div class="context-menu-divider"></div><button class="context-action" @click="dbMenuAction('query')">{{ t('新建查询') }}</button><button class="context-action" @click="dbMenuAction('search')">{{ t('查找数据库对象') }}…</button><div class="context-menu-divider"></div><button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).backup==='file'" class="context-action" :disabled="dbMenuSession.transaction" @click="dbMenuAction('sqlite-backup')">{{ t('备份数据库') }}…</button><button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).backup==='native-tools'" class="context-action" @click="dbMenuAction('native')">{{ t('外部工具') }}…</button><button class="context-action" @click="dbMenuAction('schema')">{{ t('导出结构脚本') }}…</button><button class="context-action" @click="dbMenuAction('import')">{{ t('导入数据') }}…</button><button class="context-action" @click="dbMenuAction('export')">{{ t('导出数据') }}…</button></template>
      <div class="context-menu-divider"></div><button class="context-action" @click="dbMenuAction('refresh')">{{ t('刷新') }}</button>
    </div></Teleport>
    <NativeToolDialog v-if="nativeDialog&&nativeSession" :session="nativeSession" :database="nativeDialog.database" @close="nativeDialog=undefined" @session="updateSession" @disconnect="removeSession(nativeSession.id);nativeDialog=undefined" />
    <DatabaseActionsDialog v-if="dbDialog && dbDialogSession" :session="dbDialogSession" :database="dbDialog.database" :mode="dbDialog.mode" :existing="explorers[dbDialog.sessionId]?.roots.map(item=>item.database || item.label) || []" @close="dbDialog=undefined" @changed="databaseChanged" @select="databaseObjectSelected" @session="updateSession" />
    <PreferencesDialog v-if="preferencesOpen" v-show="!dialogOpen" :connection-busy="busy" @create-connection="newConnection" @close="preferencesOpen=false" />
    <ConnectionDialog v-if="dialogOpen" :draft="connectionDraft" @close="dialogOpen = false" @saved="refreshConnections" @connected="startSession" />
    <ConfirmDialog v-if="confirmation" v-bind="confirmation" @confirm="answer(true)" @cancel="answer(false)" />
  </main>
</template>
