<script setup lang="ts">
import { t } from '../i18n'
import type { ColumnAction } from '../../shared/column-actions'
import type { SortRule } from '../../shared/browse-filter'
import { preferences } from '../preferences'
import { gridRowHeight } from '../../shared/preferences'
import { bsonLabel, gridBsonType, type BsonTypeBranch, type BsonType } from '../../shared/bson-types'
import { canSafelyEditMongoDocument, mongoFieldFilter } from '../../shared/bson-editor'
import { formatBsonValue, parseBsonDocument } from '../../shared/bson-display'
import { activeTypeColor } from '../../shared/bson-palette'
import { bsonPalette } from '../bson-preferences'
import { databasePalettes } from '../database-color-preferences'
import { databaseTypeColor } from '../../shared/database-palette'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  columns: string[]
  rows: Record<string, unknown>[]
  selected?: number
  selectable?: boolean
  checked?: number[]
  offset?: number
  bsonTypes?: BsonTypeBranch[]
  columnTypes?: string[]
  relationalKind?: 'mysql'|'mariadb'|'clickhouse'
  sqliteTypes?: string[][]
  nullCells?: number[][]
  redisRowTypes?: string[]
  documents?: string[]
  documentMenu?: boolean
  canEditDocument?: boolean
  canAddDocument?: boolean
  canFilterDocument?: boolean
  active?:boolean
  actionColumns?: string[]
  columnSort?: SortRule[]
}>(), { selected: -1, selectable: false, checked: () => [], offset: 0 })
const emit = defineEmits<{ columnAction:[action:ColumnAction,field:string]; select: [index: number]; open: [index: number]; check: [index: number]; checkAll: []; documentEdit: [index: number]; documentView: [index: number]; documentAction: [action: 'add' | 'copy-value' | 'copy-document' | 'duplicate' | 'delete' | 'null' | 'empty' | 'filter', index: number, field?: string] }>()
const mongo = computed(() => props.bsonTypes !== undefined)
const rowHeight = computed(() => gridRowHeight(preferences.value,mongo.value))
const headerHeight = computed(() => Math.max(mongo.value?28:34,preferences.value.records.fontSize+12))
const gridStyle=computed(()=>({'--record-height':rowHeight.value+'px','--record-header-height':headerHeight.value+'px','--record-font-size':preferences.value.records.fontSize+'px','--record-font':preferences.value.records.fontFamily==='default'?(mongo.value?'inherit':'"SFMono-Regular", Consolas, monospace'):'"'+preferences.value.records.fontFamily+'", sans-serif',...(mongo.value?{width:tableWidth.value+'px'}:{})}))
const OVERSCAN = 6
const scrollHost = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(400)
const virtual = computed(() => props.rows.length > 100)
let observer: ResizeObserver | undefined
let frame = 0
let stopResize: (() => void) | undefined
const rowMenu = ref<{ index: number; x: number; y: number; field?: string }>()
const menuHost = ref<HTMLElement>()
const columnMenu=ref<{field:string;x:number;y:number}>()
const columnMenuHost=ref<HTMLElement>()
const selectedColumn=ref('')
const canUseColumn=(field:string)=>props.actionColumns?.includes(field)===true
function directionFor(field:string){return props.columnSort?.find(rule=>rule.field===field)?.direction}
function closeColumnMenu(){columnMenu.value=undefined}
async function openColumnMenu(event:MouseEvent|KeyboardEvent,field:string){
  if(!canUseColumn(field))return
  event.preventDefault();event.stopPropagation();closeRowMenu();selectedColumn.value=field
  const rect=(event.currentTarget as HTMLElement).getBoundingClientRect()
  columnMenu.value={field,x:Math.max(4,Math.min(rect.right-195,window.innerWidth-212)),y:Math.max(4,rect.bottom+3)}
  await nextTick()
  if(columnMenu.value&&columnMenuHost.value){
    columnMenu.value.y=Math.max(4,Math.min(columnMenu.value.y,window.innerHeight-columnMenuHost.value.getBoundingClientRect().height-4))
    columnMenuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true})
  }
}
function columnAction(action:ColumnAction){
  const field=columnMenu.value?.field
  if(!field||!canUseColumn(field))return
  closeColumnMenu();emit('columnAction',action,field)
}
watch(()=>props.columns.join('\u0000'),()=>{if(!props.columns.includes(selectedColumn.value))selectedColumn.value='';closeColumnMenu()})
watch(()=>props.actionColumns,()=>{if(columnMenu.value&&!canUseColumn(columnMenu.value.field))closeColumnMenu()})
watch(()=>props.active,value=>{if(value===false){closeColumnMenu();closeRowMenu()}})
const menuDocument = computed(() => rowMenu.value ? props.documents?.[rowMenu.value.index] : undefined)
const menuMetadata = computed(() => rowMenu.value ? props.bsonTypes?.[rowMenu.value.index] : undefined)
const menuRaw = computed(() => menuDocument.value ? parseBsonDocument(menuDocument.value) : undefined)
const menuHasField = computed(() => !!menuRaw.value && rowMenu.value?.field !== undefined && Object.hasOwn(menuRaw.value, rowMenu.value.field))
const menuCanEdit = computed(() => !!props.canEditDocument && !!menuDocument.value && !!menuRaw.value && Object.hasOwn(menuRaw.value, '_id') && canSafelyEditMongoDocument(menuDocument.value, menuMetadata.value))
const menuCanSetField = computed(() => menuCanEdit.value && menuHasField.value && rowMenu.value?.field !== '_id')
const menuCanFilter = computed(() => !!props.canFilterDocument && !!menuDocument.value && menuHasField.value && !!mongoFieldFilter(menuDocument.value, menuMetadata.value, rowMenu.value!.field!))
function closeRowMenu() { rowMenu.value = undefined }
async function openRowMenu(event: MouseEvent | KeyboardEvent, index: number) {
  if (!props.documentMenu || !props.documents?.[index]) return
  event.preventDefault(); event.stopPropagation()
  closeColumnMenu()
  emit('select', index)
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const mouse = 'clientX' in event
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('td[data-mongo-field]') : null
  rowMenu.value = { index, field: target?.dataset.mongoField, x: Math.max(4, Math.min(mouse ? event.clientX : rect.left + 20, window.innerWidth - 260)), y: Math.max(4, Math.min(mouse ? event.clientY : rect.bottom, window.innerHeight - 100)) }
  await nextTick()
  if (!rowMenu.value || !menuHost.value) return
  rowMenu.value.y = Math.max(4, Math.min(rowMenu.value.y, window.innerHeight - menuHost.value.getBoundingClientRect().height - 4))
  menuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
}
function menuAction(action: 'view' | 'edit' | 'add' | 'copy-value' | 'copy-document' | 'duplicate' | 'delete' | 'null' | 'empty' | 'filter') {
  const menu = rowMenu.value
  if (!menu || !props.documents?.[menu.index]) { closeRowMenu(); return }
  if (['edit','duplicate','delete'].includes(action) && !menuCanEdit.value) return
  if (action === 'add' && !props.canAddDocument) return
  if (['null','empty'].includes(action) && !menuCanSetField.value) return
  if (action === 'copy-value' && !menuHasField.value) return
  if (action === 'filter' && !menuCanFilter.value) return
  closeRowMenu()
  if (action === 'edit') emit('documentEdit', menu.index)
  else if (action === 'view') emit('documentView', menu.index)
  else emit('documentAction', action, menu.index, menu.field)
}
function outside(event: PointerEvent) { if (rowMenu.value && !menuHost.value?.contains(event.target as Node)) closeRowMenu();if(columnMenu.value&&!columnMenuHost.value?.contains(event.target as Node))closeColumnMenu() }
function escapeMenu(event: KeyboardEvent) { if (event.key === 'Escape'){closeRowMenu();closeColumnMenu()} }
watch(() => props.rows,()=>{closeRowMenu();closeColumnMenu()})
watch(() => props.documentMenu, closeRowMenu)
const parsed = computed(() => props.documents?.map(parseBsonDocument) || [])
const widths = ref<Record<string, number>>(Object.create(null))
const cellRows = computed(() => {
  if (!mongo.value) return []
  return props.rows.map((row, index) => {
    const doc = parsed.value[index]
    const cells: Record<string, { type: BsonType; text: string }> = Object.create(null)
    for (const column of props.columns) {
      const type = gridBsonType(row, props.bsonTypes?.[index], column)
      // Canonical EJSON + actual BSON metadata are separate from the legacy
      // string rows used by CSV and from the original document for editing.
      const value = doc && Object.hasOwn(doc, column) ? doc[column] : row[column]
      cells[column] = { type, text: formatBsonValue(type, value, t).replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, '⇥') }
    }
    return cells
  })
})
function cellText(row: Record<string, unknown>, index: number, key: string): string {
  return cellRows.value[index]?.[key]?.text ?? display(Object.hasOwn(row, key) ? row[key] : undefined)
}
const autoWidths = computed(() => {
  const out: Record<string, number> = Object.create(null)
  for (const column of props.columns) {
    let width = Math.min(310, column.length * 8 + (props.actionColumns?.includes(column)?52:22))
    for (const row of cellRows.value.slice(0, 60)) {
      const cell = row[column]
      if (!cell) continue
      const valueWidth = Math.min(310, [...cell.text.slice(0, 90)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 13 : 7.4), 0) + 20)
      width = Math.max(width, valueWidth + (bsonPalette.value.showLabels ? 74 : 0))
    }
    out[column] = Math.max(66, Math.min(400, Math.ceil(width)))
  }
  return out
})
function columnWidth(key: string): number { return widths.value[key] || autoWidths.value[key] || 100 }
const tableWidth = computed(() => 38 + props.columns.reduce((sum, column) => sum + columnWidth(column), 0))
function resizeColumn(event: PointerEvent, key: string) {
  event.preventDefault()
  stopResize?.()
  const x = event.clientX, start = columnWidth(key)
  function move(next: PointerEvent) { widths.value[key] = Math.max(52, Math.min(1000, start + next.clientX - x)) }
  function stop() {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop)
    document.body.classList.remove('resizing'); stopResize = undefined
  }
  stopResize = stop; document.body.classList.add('resizing')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
}
function resizeColumnKey(event: KeyboardEvent, key: string) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') delete widths.value[key]
  else widths.value[key] = Math.max(52, Math.min(1000, columnWidth(key) + (event.key === 'ArrowRight' ? 12 : -12)))
}
watch(() => props.columns.join('\u0000'), () => { widths.value = Object.create(null) })
const windowRange = computed(() => {
  if (!virtual.value) return { start: 0, end: props.rows.length }
  const first = Math.max(0, Math.floor((scrollTop.value - headerHeight.value) / rowHeight.value))
  const start = Math.min(Math.max(0, first - OVERSCAN), Math.max(0, props.rows.length - 1))
  const count = Math.ceil(Math.max(rowHeight.value, viewportHeight.value - headerHeight.value) / rowHeight.value)
  return { start, end: Math.min(props.rows.length, first + count + OVERSCAN) }
})
const visibleRows = computed(() => props.rows.slice(windowRange.value.start, windowRange.value.end).map((row, index) => ({ row, index: windowRange.value.start + index })))
const topSpace = computed(() => windowRange.value.start * rowHeight.value)
const bottomSpace = computed(() => (props.rows.length - windowRange.value.end) * rowHeight.value)
const columnCount = computed(() => props.columns.length + (props.selectable ? 2 : 1))

function onScroll() {
  closeRowMenu();closeColumnMenu()
  if (frame) return
  frame = requestAnimationFrame(() => { frame = 0; scrollTop.value = scrollHost.value?.scrollTop || 0 })
}
onMounted(() => {
  window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escapeMenu); window.addEventListener('resize', closeRowMenu);window.addEventListener('resize',closeColumnMenu)
  if (!scrollHost.value) return
  observer = new ResizeObserver(() => { viewportHeight.value = scrollHost.value?.clientHeight || 0 })
  observer.observe(scrollHost.value)
  viewportHeight.value = scrollHost.value.clientHeight
})
watch(() => props.rows, () => {
  scrollTop.value = 0
  if (scrollHost.value) scrollHost.value.scrollTop = 0
})
onBeforeUnmount(() => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escapeMenu); window.removeEventListener('resize', closeRowMenu);window.removeEventListener('resize',closeColumnMenu); observer?.disconnect(); stopResize?.(); if (frame) cancelAnimationFrame(frame) })

function cellType(row: Record<string, unknown>, index: number, key: string): BsonType | undefined {
  return cellRows.value[index]?.[key]?.type ?? (props.bsonTypes ? gridBsonType(row, props.bsonTypes[index], key) : undefined)
}
function genericType(index: number, column: number): string | undefined {
  if(props.sqliteTypes)return props.sqliteTypes[index]?.[column]||'NULL'
  if (props.columnTypes) return props.nullCells?.[index]?.includes(column) ? 'NULL' : props.columnTypes[column] || 'UNKNOWN'
  if (props.redisRowTypes) return props.redisRowTypes[index] || 'unknown'
  return undefined
}
function gridType(row: Record<string, unknown>, index: number, key: string, column: number): string | undefined { return cellType(row, index, key) || genericType(index, column) }
function gridColor(row: Record<string, unknown>, index: number, key: string, column: number): string | undefined {
  const bson = cellType(row, index, key)
  if (bson) return activeTypeColor(bsonPalette.value, bson)
  const kind = props.sqliteTypes?'sqlite':props.columnTypes ? (props.relationalKind||'mysql') : props.redisRowTypes ? 'redis' : undefined
  const type = genericType(index, column)
  return kind && type && databasePalettes.value[kind].enabled ? databaseTypeColor(kind, databasePalettes.value[kind], type) : undefined
}
function gridLabel(row: Record<string, unknown>, index: number, key: string, column: number): string {
  const bson = cellType(row, index, key)
  return bson ? t(bsonLabel(bson)) : genericType(index, column) || ''
}
const showTypeLabels = computed(() => mongo.value ? bsonPalette.value.showLabels : props.sqliteTypes?databasePalettes.value.sqlite.showLabels:props.columnTypes ? databasePalettes.value[props.relationalKind||'mysql'].showLabels : props.redisRowTypes ? databasePalettes.value.redis.showLabels : false)
function display(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return '—'
  if (typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, 4096) } catch { return '[Object]' }
  }
  return String(value).slice(0, 4096)
}
</script>

<template>
  <div ref="scrollHost" class="grid-scroll" tabindex="0" :aria-label="t('结果表格')" @scroll.passive="onScroll">
    <table :class="['data-table', 'configured-grid', { 'virtual-grid': virtual, 'mongo-grid': mongo, 'typed-grid': !!columnTypes || !!redisRowTypes || !!sqliteTypes }]" :style="gridStyle" :aria-rowcount="rows.length + 1" :dir="mongo ? 'ltr' : undefined">
      <colgroup v-if="mongo"><col style="width: 38px" /><col v-for="column in columns" :key="column" :style="{ width: columnWidth(column) + 'px' }" /></colgroup>
      <thead><tr>
        <th v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择当前页')" :checked="rows.length > 0 && checked.length === rows.length" @change="emit('checkAll')" /></th>
        <th class="number-cell">#</th><th v-for="column in columns" :key="column" :title="column" :class="{'column-active':selectedColumn===column,'column-actionable':canUseColumn(column)}" :aria-sort="columnSort?.[0]?.field===column?(directionFor(column)===1?'ascending':'descending'):undefined" @click="canUseColumn(column)&&(selectedColumn=column)" @contextmenu="openColumnMenu($event,column)">
          <div class="grid-heading-content"><span class="grid-column-title">{{ column }}</span><span v-if="directionFor(column)" class="column-sort-indicator" aria-hidden="true">{{ directionFor(column)===1?'↑':'↓' }}<small v-if="(columnSort?.length||0)>1">{{ (columnSort?.findIndex(rule=>rule.field===column)??0)+1 }}</small></span><button v-if="canUseColumn(column)" type="button" class="column-menu-trigger" :title="t('列操作')+': '+column" :aria-label="t('列操作')+': '+column" aria-haspopup="menu" :aria-expanded="columnMenu?.field===column" @click.stop="openColumnMenu($event,column)" @keydown.shift.f10.stop="openColumnMenu($event,column)">···</button></div><span v-if="mongo" class="grid-column-resize" role="separator" aria-orientation="vertical" :aria-label="t('调整列宽') + ': ' + column" :aria-valuemin="52" :aria-valuemax="1000" :aria-valuenow="columnWidth(column)" tabindex="0" @pointerdown.stop="resizeColumn($event, column)" @keydown.stop="resizeColumnKey($event, column)" @dblclick.stop="delete widths[column]"></span></th>
      </tr></thead>
      <tbody>
        <tr v-if="topSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: topSpace + 'px' }"></td></tr>
        <tr v-for="item in visibleRows" :key="item.index" :data-row-index="item.index" :aria-rowindex="item.index + 2" :class="{ selected: selected === item.index, 'record-stripe': preferences.records.stripes > 0 && (offset + item.index + 1) % preferences.records.stripes === 0 }" @click="emit('select', item.index)" @dblclick="emit('open', item.index)" :tabindex="documentMenu ? 0 : undefined" @contextmenu="openRowMenu($event, item.index)" @keydown.shift.f10="openRowMenu($event, item.index)">
          <td v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择第 {0} 行', [item.index + 1])" :checked="checked.includes(item.index)" @click.stop @change="emit('check', item.index)" /></td>
          <td class="number-cell">{{ offset + item.index + 1 }}</td>
          <td v-for="(column, columnIndex) in columns" :key="column"
            :class="{ 'column-active':selectedColumn===column&&canUseColumn(column), 'null-cell': item.row[column] === null || !Object.hasOwn(item.row, column) || cellType(item.row, item.index, column) === 'Null' || cellType(item.row, item.index, column) === 'Undefined' || genericType(item.index, columnIndex) === 'NULL', 'has-bson-color': !!gridColor(item.row, item.index, column, columnIndex) }"
            :data-mongo-field="documentMenu ? column : undefined"
            :data-bson-type="cellType(item.row, item.index, column)"
            :data-value-type="gridType(item.row, item.index, column, columnIndex)"
            :data-type-color="gridColor(item.row, item.index, column, columnIndex)"
            :data-bson-color="mongo ? gridColor(item.row, item.index, column, columnIndex) : undefined"
            :style="gridColor(item.row, item.index, column, columnIndex) ? { '--bson-color': gridColor(item.row, item.index, column, columnIndex) } : {}"
            :title="(gridLabel(item.row, item.index, column, columnIndex) ? gridLabel(item.row, item.index, column, columnIndex) + ': ' : '') + cellText(item.row, item.index, column)">
            <span v-if="showTypeLabels && gridType(item.row, item.index, column, columnIndex)" class="bson-type-label">{{ gridLabel(item.row, item.index, column, columnIndex) }}</span><span class="grid-value">{{ cellText(item.row, item.index, column) }}</span>
          </td>
        </tr>
        <tr v-if="bottomSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: bottomSpace + 'px' }"></td></tr>
        <tr v-if="!rows.length"><td :colspan="columnCount" class="empty-grid">{{ t('暂无记录') }}</td></tr>
      </tbody>
    </table>
    <Teleport to="body">
      <div v-if="columnMenu" ref="columnMenuHost" class="connection-context-menu grid-column-menu" role="menu" :style="{left:columnMenu.x+'px',top:columnMenu.y+'px'}" @contextmenu.prevent @pointerdown.stop>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('asc')"><span class="column-menu-symbol" aria-hidden="true">↑</span>{{ t('升序排序') }}</button>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('desc')"><span class="column-menu-symbol" aria-hidden="true">↓</span>{{ t('降序排序') }}</button>
        <button class="context-action" type="button" role="menuitem" :disabled="!columnSort?.length" @click="columnAction('clear')"><span class="column-menu-symbol clear-sort" aria-hidden="true">⊖</span>{{ t('移除所有排序') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('filter')"><span class="column-menu-symbol"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg></span>{{ t('添加筛选') }}</button>
      </div>
      <div v-if="rowMenu" ref="menuHost" class="connection-context-menu mongo-row-menu" :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }" @contextmenu.prevent @pointerdown.stop>
        <button class="context-action" type="button" @click="menuAction('view')">{{ t('查看文档') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanEdit" @click="menuAction('edit')">{{ t('编辑文档') }}…</button>
        <button class="context-action" type="button" :disabled="!canAddDocument" @click="menuAction('add')">{{ t('新增文档') }}…</button>
        <button class="context-action" type="button" :disabled="!menuCanEdit" @click="menuAction('duplicate')">{{ t('复制为新文档') }}…</button>
        <button class="context-action danger" type="button" :disabled="!menuCanEdit" @click="menuAction('delete')">{{ t('删除文档') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" :disabled="!menuHasField" @click="menuAction('copy-value')">{{ t('复制字段值') }}</button>
        <button class="context-action" type="button" @click="menuAction('copy-document')">{{ t('复制完整文档') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" :disabled="!menuCanSetField" @click="menuAction('null')">{{ t('设为 NULL') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanSetField" @click="menuAction('empty')">{{ t('设为空字符串') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanFilter" @click="menuAction('filter')">{{ t('按此值筛选') }}</button>
        <p v-if="!menuCanEdit" class="context-edit-help">{{ t('编辑需要完整文档和写入权限。') }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.grid-scroll { overflow-anchor: none; }
.virtual-grid thead tr, .virtual-grid tbody tr:not(.virtual-spacer), .virtual-grid tbody tr:not(.virtual-spacer) td { height: 34px; }
.virtual-grid tbody tr:not(.virtual-spacer) td { line-height: 17px; padding-top: 8px; padding-bottom: 8px; }
.virtual-grid .virtual-spacer, .virtual-grid .virtual-spacer td { padding: 0; border: 0; line-height: 0; pointer-events: none; }

.mongo-grid { table-layout: fixed; min-width: 0; }
.mongo-grid th, .mongo-grid td { box-sizing: border-box; min-width: 0; max-width: none; height: 26px; padding: 3px 7px; line-height: 19px; font-family: inherit; font-size: 12px; }
.mongo-grid th { height: 28px; font-weight: 600; color: var(--text); padding-inline-end: 12px; }
.mongo-grid .number-cell { width: 38px; min-width: 0; padding: 2px 4px; }
.mongo-grid .grid-value { white-space: pre; }
.mongo-grid .grid-column-title { display: block; overflow: hidden; text-overflow: ellipsis; }
.grid-column-resize { position: absolute; top: 0; bottom: 0; right: 0; width: 7px; cursor: col-resize; }
.grid-column-resize:hover, .grid-column-resize:focus-visible { background: var(--accent); }
.mongo-grid.virtual-grid thead tr { height: 28px; }
.mongo-grid.virtual-grid tbody tr:not(.virtual-spacer), .mongo-grid.virtual-grid tbody tr:not(.virtual-spacer) td { height: 26px; }
.mongo-grid.virtual-grid tbody tr:not(.virtual-spacer) td { line-height: 19px; padding: 3px 7px; }

.configured-grid.data-table th { height:var(--record-header-height);font-size:var(--record-font-size); }
.configured-grid.data-table tbody tr:not(.virtual-spacer),.configured-grid.data-table tbody tr:not(.virtual-spacer) td { height:var(--record-height);box-sizing:border-box; }
.configured-grid.data-table tbody tr:not(.virtual-spacer) td { font-size:var(--record-font-size);font-family:var(--record-font);padding-top:3px;padding-bottom:3px;line-height:calc(var(--record-font-size) + 4px); }
.configured-grid.data-table tbody tr.record-stripe:not(.selected):not(:hover) td:not(.has-bson-color) { background:color-mix(in srgb,var(--panel-raised) 70%,var(--panel)); }
</style>

<style>
.grid-heading-content{display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}.grid-heading-content .grid-column-title{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:1}.column-menu-trigger{width:23px;height:22px;flex:none;padding:0;border:0;border-radius:3px;background:transparent;color:var(--accent);font-size:17px;line-height:18px;font-weight:700;opacity:0;cursor:pointer}.column-actionable:hover .column-menu-trigger,.column-active .column-menu-trigger,.column-menu-trigger:focus-visible,.column-menu-trigger[aria-expanded=true]{opacity:1}.column-sort-indicator{flex:none;color:var(--accent);font-size:12px;font-weight:700}.column-sort-indicator small{font-size:9px}.data-table th.column-active{background:var(--selected);color:var(--text);box-shadow:inset 0 -2px var(--accent)}.data-table tbody td.column-active{background:color-mix(in srgb,var(--accent) 18%,var(--panel));}.data-table tbody tr.selected td.column-active{background:color-mix(in srgb,var(--accent) 28%,var(--panel));}.grid-column-menu{width:208px;z-index:85}.grid-column-menu .context-action{display:flex;align-items:center;gap:9px;padding:8px 10px}.column-menu-symbol{display:inline-flex;width:18px;justify-content:center;align-items:center;font-size:16px;color:var(--muted)}.column-menu-symbol.clear-sort{color:var(--danger)}
</style>
