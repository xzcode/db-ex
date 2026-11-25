<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import type { ConnectionAppearancePatch, SavedConnection, SessionInfo } from '../../shared/types'
import { colorStyle } from '../../shared/connection-appearance'
import ConnectionColorPicker from './ConnectionColorPicker.vue'
import DatabaseIcon from './DatabaseIcon.vue'

const props = defineProps<{ connections: SavedConnection[]; sessions: SessionInfo[]; current: string | null; busy: boolean }>()
const emit = defineEmits<{
  refresh: []; create: []; connect: [connection: SavedConnection]; activate: [id: string]; disconnect: [id: string];
  edit: [connection: SavedConnection]; remove: [connection: SavedConnection]; import: []; export: [id?: string];
  appearance: [id: string, patch: ConnectionAppearancePatch]; resourceMenu:[event:MouseEvent,sessionId:string]; refreshResources:[sessionId:string]
}>()
const filter = ref('')
const selected = ref('')
const menu = ref<{ id: string; x: number; y: number }>()
const menuHost = ref<HTMLElement>()
const groupTarget = ref<string>()
const groupName = ref('')
const collapsed = ref<string[]>([])
const collapsedSessions=ref<string[]>([])
function sessionExpanded(id:string){return !collapsedSessions.value.includes(id)}
function expandSession(id:string){collapsedSessions.value=collapsedSessions.value.filter(value=>value!==id)}
function toggleSession(id:string){collapsedSessions.value=sessionExpanded(id)?[...collapsedSessions.value,id]:collapsedSessions.value.filter(value=>value!==id)}
watch(()=>props.sessions.map(item=>item.id),ids=>{collapsedSessions.value=collapsedSessions.value.filter(id=>ids.includes(id))})
const dragging = ref('')
const groupNames = computed(() => [...new Set(props.connections.map(item => item.group).filter((x): x is string => Boolean(x)))])
const filtered = computed(() => props.connections.filter(item => [item.name, item.host, item.kind, item.group || ''].some(x => x.toLowerCase().includes(filter.value.trim().toLowerCase()))))
const groups = computed(() => {
  const result = new Map<string, SavedConnection[]>()
  for (const connection of filtered.value) {
    const group = connection.group || ''
    if (!result.has(group)) result.set(group, [])
    result.get(group)!.push(connection)
  }
  return [...result.entries()].sort(([a], [b]) => a ? b ? a.localeCompare(b) : 1 : b ? -1 : 0)
})
const temporary = computed(() => props.sessions.filter(item => !item.connectionId))
const menuConnection = computed(() => props.connections.find(item => item.id === menu.value?.id))
const groupConnection = computed(() => props.connections.find(item => item.id === groupTarget.value))
function active(connection: SavedConnection) { return props.sessions.find(item => item.connectionId === connection.id && item.id === props.current) || props.sessions.find(item => item.connectionId === connection.id) }
function select(connection: SavedConnection) {
  selected.value = connection.id
  const session = active(connection)
  if (session) emit('activate', session.id)
}
function open(connection: SavedConnection) {
  if (props.busy || connection.locked) return
  selected.value = connection.id
  const session = active(connection)
  if (session) { expandSession(session.id);emit('activate', session.id) }
  else emit('connect', connection)
}
function toggleConnection(connection:SavedConnection){
 const session=active(connection)
 if(session)toggleSession(session.id)
 else open(connection)
}
function connectionTooltip(connection:SavedConnection){
 return [connection.name,connection.host,connection.sshEnabled?'SSH':'',connection.tlsEnabled?'TLS':'',connection.proxyEnabled?'PROXY':''].filter(Boolean).join(' · ')
}
function resourceAction(event:MouseEvent,action:'menu'|'refresh'){
 const connection=menuConnection.value
 const session=connection&&active(connection)
 if(!session||props.busy)return
 if(action==='menu')emit('resourceMenu',event,session.id)
 else emit('refreshResources',session.id)
 closeMenu()
}
function expanded(group: string) { return Boolean(filter.value.trim()) || !collapsed.value.includes(group) }
function toggleGroup(group: string) {
  collapsed.value = collapsed.value.includes(group) ? collapsed.value.filter(x => x !== group) : [...collapsed.value, group]
}
function closeMenu() { menu.value = undefined }
async function showMenu(event: MouseEvent, connection: SavedConnection, button = false) {
  if (props.busy) return
  selected.value = connection.id
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = button ? bounds.left : event.clientX
  const y = button ? bounds.bottom : event.clientY
  menu.value = { id: connection.id, x: Math.max(4, Math.min(x, window.innerWidth - 276)), y: Math.max(4, Math.min(y, window.innerHeight - 80)) }
  await nextTick()
  if (!menu.value || !menuHost.value) return
  const rect = menuHost.value.getBoundingClientRect()
  menu.value.y = Math.max(4, Math.min(menu.value.y, window.innerHeight - rect.height - 6))
  menuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
}
function menuAction(action: 'open' | 'disconnect' | 'edit' | 'export' | 'remove' | 'group') {
  const connection = menuConnection.value
  closeMenu()
  if (!connection || props.busy) return
  if (action === 'open') open(connection)
  else if (action === 'disconnect') { const session = active(connection); if (session) emit('disconnect', session.id) }
  else if (action === 'edit') emit('edit', connection)
  else if (action === 'export') emit('export', connection.id)
  else if (action === 'remove') emit('remove', connection)
  else { groupName.value = connection.group || ''; groupTarget.value = connection.id }
}
function setColor(value: string | undefined) {
  const connection = menuConnection.value
  if (!connection || props.busy || connection.locked) return
  closeMenu()
  emit('appearance', connection.id, { color: value || null })
}
function setGroup(value: string) {
  const connection = groupConnection.value
  if (!connection || props.busy || connection.locked) return
  const next = value.trim()
  groupTarget.value = undefined
  if (next) collapsed.value = collapsed.value.filter(x => x !== next)
  emit('appearance', connection.id, { group: next || null })
}
function startDrag(event: DragEvent, connection: SavedConnection) {
  if (props.busy || connection.locked || !event.dataTransfer) { event.preventDefault(); return }
  dragging.value = connection.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-dbex-connection', connection.id)
}
function dropGroup(event: DragEvent, group: string) {
  const id = dragging.value
  dragging.value = ''
  if (!id || props.busy || event.dataTransfer?.getData('application/x-dbex-connection') !== id) return
  const item = props.connections.find(c => c.id === id)
  if (!item || item.locked || (item.group || '') === group) return
  collapsed.value = collapsed.value.filter(x => x !== group)
  emit('appearance', id, { group: group || null })
}
function outside(event: PointerEvent) { if (menu.value && !menuHost.value?.contains(event.target as Node)) closeMenu() }
function key(event: KeyboardEvent) { if (event.key === 'Escape') { closeMenu(); groupTarget.value = undefined } }
onMounted(() => {
  try { const saved = JSON.parse(localStorage.getItem('dbex.collapsed-groups') || '[]'); if (Array.isArray(saved)) collapsed.value = saved.filter(x => typeof x === 'string').slice(0, 200) } catch { /* Optional preference. */ }
  window.addEventListener('pointerdown', outside)
  window.addEventListener('keydown', key)
  window.addEventListener('resize', closeMenu)
})
watch(collapsed, value => { try { localStorage.setItem('dbex.collapsed-groups', JSON.stringify(value)) } catch { /* Optional preference. */ } })
onBeforeUnmount(() => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('resize', closeMenu) })
</script>
<template>
  <aside class="sidebar connection-sidebar">
    <div class="sidebar-label"><span>{{ t('连接列表') }}</span><div class="sidebar-heading-actions"><button class="ghost-icon" :title="t('＋ 新建连接')" :aria-label="t('＋ 新建连接')" :disabled="busy" @click="emit('create')">+</button><button class="ghost-icon" :title="t('刷新连接')" :disabled="busy" @click="emit('refresh')">↻</button></div></div>
    <div class="sidebar-search"><input v-model="filter" :aria-label="t('筛选连接')" :placeholder="t('搜索名称 / 主机')" /></div>
    <div class="saved-list connection-tree" @scroll="closeMenu">
      <template v-for="[group, items] in groups" :key="group">
        <div v-if="group" class="connection-group" :data-group="group" @dragover.prevent @drop.prevent="dropGroup($event, group)">
          <button class="group-toggle" type="button" :aria-expanded="expanded(group)" @click="toggleGroup(group)"><span class="tree-chevron" :class="{ expanded: expanded(group) }" aria-hidden="true">›</span><span class="folder-icon" aria-hidden="true"><svg viewBox="0 0 20 16" fill="currentColor"><path d="M1 3a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z"/></svg></span><span class="ellipsis group-name">{{ group }}</span><span class="group-count">{{ items.length }}</span></button>
        </div>
        <template v-if="!group || expanded(group)">
          <template v-for="connection in items" :key="connection.id">
          <div class="connection-item" :class="{ 'has-color': !!connection.color, 'is-selected': selected === connection.id || active(connection)?.id === current, 'in-group': !!group, 'is-open': !!active(connection) }" :style="colorStyle(connection.color)" :data-connection-id="connection.id" :data-color="connection.color || ''" :title="connectionTooltip(connection)" tabindex="0" :draggable="!connection.locked && !busy" @click="select(connection)" @dblclick="open(connection)" @keydown.enter.self.prevent="open(connection)" @keydown.shift.f10.prevent="showMenu($event as unknown as MouseEvent, connection, true)" @contextmenu.prevent.stop="showMenu($event, connection)" @dragstart="startDrag($event, connection)" @dragend="dragging = ''">
            <button type="button" class="tree-chevron connection-chevron" :class="{expanded:!!active(connection)&&sessionExpanded(active(connection)!.id)}" :aria-expanded="!!active(connection)&&sessionExpanded(active(connection)!.id)" :aria-label="t(active(connection)&&sessionExpanded(active(connection)!.id)?'折叠连接':'展开连接')+' '+connection.name" :disabled="busy||connection.locked" @click.stop="toggleConnection(connection)" @dblclick.stop>›</button>
            <DatabaseIcon :kind="connection.kind" size="small" />
            <div class="connection-description"><div class="connection-title"><strong :title="connectionTooltip(connection)">{{ connection.name }}</strong><span :class="['connection-indicator',{online:!!active(connection)}]" :title="t(active(connection)?'已连接':'未连接')"></span><span v-if="connection.locked" class="tiny-badge">{{ t('待迁移') }}</span><span v-if="active(connection)?.transaction" class="tiny-badge">TX</span><span v-if="active(connection)?.writable" class="tiny-badge write">RW</span></div></div>
            <div class="connection-actions"><button class="ghost-icon row-connect" :title="t('连接')" :aria-label="t('连接')" :disabled="busy || connection.locked" @click.stop="open(connection)" @dblclick.stop>▶</button><button class="ghost-icon row-menu" :title="t('连接菜单')" :aria-label="t('连接菜单')" :aria-expanded="menu?.id === connection.id" :disabled="busy" @pointerdown.stop @click.stop="showMenu($event, connection, true)" @dblclick.stop>···</button></div>
          </div>
          <slot v-if="active(connection)&&sessionExpanded(active(connection)!.id)" name="resources" :session="active(connection)!" :grouped="!!group" />
          </template>
        </template>
      </template>
      <template v-if="temporary.length">
        <div class="sidebar-label temporary-heading"><span>{{ t('活动会话') }}</span><span>{{ temporary.length }}</span></div>
        <template v-for="session in temporary" :key="session.id">
          <div class="temporary-session-row" :class="{selected:current===session.id}">
            <button type="button" class="tree-chevron connection-chevron" :class="{expanded:sessionExpanded(session.id)}" :aria-expanded="sessionExpanded(session.id)" :aria-label="t(sessionExpanded(session.id)?'折叠连接':'展开连接')+' '+session.name" @click="toggleSession(session.id)">›</button>
            <button type="button" class="active-item" @click="emit('activate',session.id)" :title="session.name+' · '+session.displayHost"><DatabaseIcon :kind="session.kind" size="small" /><span class="ellipsis">{{ session.name }}</span><span v-if="session.transaction" class="tiny-badge">TX</span><span v-if="session.writable" class="tiny-badge write">RW</span></button>
            <button v-if="session.kind!=='redis'" type="button" class="ghost-icon" :title="t('数据库菜单')" :disabled="busy" @click="emit('resourceMenu',$event,session.id)">···</button><button class="ghost-icon" type="button" :title="t('刷新资源树')" :disabled="busy" @click="emit('refreshResources',session.id)">↻</button>
          </div>
          <slot v-if="sessionExpanded(session.id)" name="resources" :session="session" :grouped="false" />
        </template>
      </template>
      <div v-if="dragging" class="ungroup-drop" @dragover.prevent @drop.prevent="dropGroup($event, '')">{{ t('移出分组') }}</div>
      <div v-if="!filtered.length&&!temporary.length" class="sidebar-empty">{{ connections.length ? t('没有匹配的连接') : t('创建连接，或导入已有连接备份。') }}</div>
    </div>

    <div class="sidebar-bottom"><button class="btn secondary small" :disabled="busy" @click="emit('import')">{{ t('导入连接') }}</button><button class="btn secondary small" :disabled="busy || !connections.length" :title="t('导出全部连接及加密凭据')" @click="emit('export')">{{ t('导出连接') }}</button></div>
    <Teleport to="body">
      <div v-if="menu && menuConnection" ref="menuHost" class="connection-context-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @pointerdown.stop @contextmenu.prevent>
        <div class="context-title"><strong>{{ menuConnection.name }}</strong><small>{{ menuConnection.host }}</small></div>
        <button class="context-action" type="button" :disabled="menuConnection.locked" @click="menuAction('open')">{{ t('连接') }}</button>
        <button v-if="active(menuConnection)" class="context-action" type="button" @click="menuAction('disconnect')">{{ t('断开连接') }}</button>
        <button v-if="active(menuConnection)&&menuConnection.kind!=='redis'" class="context-action" type="button" @click="resourceAction($event,'menu')">{{ t('数据库菜单') }}</button>
        <button v-if="active(menuConnection)" class="context-action" type="button" @click="resourceAction($event,'refresh')">{{ t('刷新资源树') }}</button>
        <button class="context-action" type="button" :disabled="menuConnection.locked" @click="menuAction('edit')">{{ t('编辑连接') }}</button>
        <div v-if="!menuConnection.locked" class="context-color-section"><div class="context-heading">{{ t('连接颜色') }}</div><ConnectionColorPicker :model-value="menuConnection.color" :disabled="busy" @update:model-value="setColor" /></div>
        <button class="context-action" type="button" :disabled="menuConnection.locked" @click="menuAction('group')">{{ t('移动到分组') }}</button>
        <button class="context-action" type="button" :disabled="menuConnection.locked" @click="menuAction('export')">{{ t('导出此连接') }}</button>
        <button class="context-action danger" type="button" @click="menuAction('remove')">{{ t('删除配置') }}</button>
      </div>
      <div v-if="groupConnection" class="modal-backdrop connection-group-backdrop" @click.self="groupTarget = undefined">
        <section class="dialog connection-group-dialog" role="dialog" aria-modal="true" :aria-label="t('移动到分组')"><header class="dialog-header"><h2>{{ t('移动到分组') }}</h2><button class="icon-button" :aria-label="t('关闭弹窗')" @click="groupTarget = undefined">×</button></header><form @submit.prevent="setGroup(groupName)"><div class="dialog-body"><label class="field field-wide">{{ t('分组名称') }}<input v-model.trim="groupName" list="dbex-group-names" maxlength="80" :placeholder="t('选择已有分组或输入新名称')" autofocus /><datalist id="dbex-group-names"><option v-for="name in groupNames" :key="name" :value="name" /></datalist></label></div><footer class="dialog-footer"><button v-if="groupConnection.group" class="btn secondary" type="button" @click="setGroup('')">{{ t('移出分组') }}</button><span class="toolbar-spacer"></span><button class="btn secondary" type="button" @click="groupTarget = undefined">{{ t('取消') }}</button><button class="btn primary" type="submit">{{ t('确认') }}</button></footer></form></section>
      </div>
    </Teleport>
  </aside>
</template>
