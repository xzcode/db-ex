<script setup lang="ts">
import { t } from '../i18n'
import { bsonLabel, gridBsonType, type BsonTypeBranch, type BsonType } from '../../shared/bson-types'
import { formatBsonValue, parseBsonDocument } from '../../shared/bson-display'
import { activeTypeColor } from '../../shared/bson-palette'
import { bsonPalette } from '../bson-preferences'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  columns: string[]
  rows: Record<string, unknown>[]
  selected?: number
  selectable?: boolean
  checked?: number[]
  offset?: number
  bsonTypes?: BsonTypeBranch[]
  documents?: string[]
}>(), { selected: -1, selectable: false, checked: () => [], offset: 0 })
const emit = defineEmits<{ select: [index: number]; open: [index: number]; check: [index: number]; checkAll: [] }>()
const mongo = computed(() => props.bsonTypes !== undefined)
const rowHeight = computed(() => mongo.value ? 26 : 34)
const headerHeight = computed(() => mongo.value ? 28 : 34)
const OVERSCAN = 6
const scrollHost = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(400)
const virtual = computed(() => props.rows.length > 100)
let observer: ResizeObserver | undefined
let frame = 0
let stopResize: (() => void) | undefined
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
    let width = Math.min(310, column.length * 8 + 22)
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
  if (frame) return
  frame = requestAnimationFrame(() => { frame = 0; scrollTop.value = scrollHost.value?.scrollTop || 0 })
}
onMounted(() => {
  if (!scrollHost.value) return
  observer = new ResizeObserver(() => { viewportHeight.value = scrollHost.value?.clientHeight || 0 })
  observer.observe(scrollHost.value)
  viewportHeight.value = scrollHost.value.clientHeight
})
watch(() => props.rows, () => {
  scrollTop.value = 0
  if (scrollHost.value) scrollHost.value.scrollTop = 0
})
onBeforeUnmount(() => { observer?.disconnect(); stopResize?.(); if (frame) cancelAnimationFrame(frame) })

function cellType(row: Record<string, unknown>, index: number, key: string): BsonType | undefined {
  return cellRows.value[index]?.[key]?.type ?? (props.bsonTypes ? gridBsonType(row, props.bsonTypes[index], key) : undefined)
}
function cellColor(type?: BsonType): string | undefined { return type ? activeTypeColor(bsonPalette.value, type) : undefined }
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
    <table :class="['data-table', { 'virtual-grid': virtual, 'mongo-grid': mongo }]" :style="mongo ? { width: tableWidth + 'px' } : undefined" :aria-rowcount="rows.length + 1" :dir="mongo ? 'ltr' : undefined">
      <colgroup v-if="mongo"><col style="width: 38px" /><col v-for="column in columns" :key="column" :style="{ width: columnWidth(column) + 'px' }" /></colgroup>
      <thead><tr>
        <th v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择当前页')" :checked="rows.length > 0 && checked.length === rows.length" @change="emit('checkAll')" /></th>
        <th class="number-cell">#</th><th v-for="column in columns" :key="column" :title="column"><span class="grid-column-title">{{ column }}</span><span v-if="mongo" class="grid-column-resize" role="separator" aria-orientation="vertical" :aria-label="t('调整列宽') + ': ' + column" :aria-valuemin="52" :aria-valuemax="1000" :aria-valuenow="columnWidth(column)" tabindex="0" @pointerdown.stop="resizeColumn($event, column)" @keydown.stop="resizeColumnKey($event, column)" @dblclick.stop="delete widths[column]"></span></th>
      </tr></thead>
      <tbody>
        <tr v-if="topSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: topSpace + 'px' }"></td></tr>
        <tr v-for="item in visibleRows" :key="item.index" :data-row-index="item.index" :aria-rowindex="item.index + 2" :class="{ selected: selected === item.index }" @click="emit('select', item.index)" @dblclick="emit('open', item.index)">
          <td v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择第 {0} 行', [item.index + 1])" :checked="checked.includes(item.index)" @click.stop @change="emit('check', item.index)" /></td>
          <td class="number-cell">{{ offset + item.index + 1 }}</td>
          <td v-for="column in columns" :key="column"
            :class="{ 'null-cell': item.row[column] === null || !Object.hasOwn(item.row, column) || cellType(item.row, item.index, column) === 'Null' || cellType(item.row, item.index, column) === 'Undefined', 'has-bson-color': !!cellColor(cellType(item.row, item.index, column)) }"
            :data-bson-type="cellType(item.row, item.index, column)"
            :data-bson-color="cellColor(cellType(item.row, item.index, column))"
            :style="cellColor(cellType(item.row, item.index, column)) ? { '--bson-color': cellColor(cellType(item.row, item.index, column)) } : {}"
            :title="(cellType(item.row, item.index, column) ? t(bsonLabel(cellType(item.row, item.index, column)!)) + ': ' : '') + cellText(item.row, item.index, column)">
            <span v-if="bsonTypes && bsonPalette.showLabels" class="bson-type-label">{{ t(bsonLabel(cellType(item.row, item.index, column)!)) }}</span><span class="grid-value">{{ cellText(item.row, item.index, column) }}</span>
          </td>
        </tr>
        <tr v-if="bottomSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: bottomSpace + 'px' }"></td></tr>
        <tr v-if="!rows.length"><td :colspan="columnCount" class="empty-grid">{{ t('暂无记录') }}</td></tr>
      </tbody>
    </table>
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
</style>
