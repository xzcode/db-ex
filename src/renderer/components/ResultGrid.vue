<script setup lang="ts">
import { t } from '../i18n'
import { bsonLabel, gridBsonType, type BsonTypeBranch, type BsonType } from '../../shared/bson-types'
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
}>(), { selected: -1, selectable: false, checked: () => [], offset: 0 })
const emit = defineEmits<{ select: [index: number]; open: [index: number]; check: [index: number]; checkAll: [] }>()
const ROW_HEIGHT = 34
const HEADER_HEIGHT = 34
const OVERSCAN = 6
const scrollHost = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(400)
const virtual = computed(() => props.rows.length > 100)
let observer: ResizeObserver | undefined
let frame = 0
const windowRange = computed(() => {
  if (!virtual.value) return { start: 0, end: props.rows.length }
  const first = Math.max(0, Math.floor((scrollTop.value - HEADER_HEIGHT) / ROW_HEIGHT))
  const start = Math.min(Math.max(0, first - OVERSCAN), Math.max(0, props.rows.length - 1))
  const count = Math.ceil(Math.max(ROW_HEIGHT, viewportHeight.value - HEADER_HEIGHT) / ROW_HEIGHT)
  return { start, end: Math.min(props.rows.length, first + count + OVERSCAN) }
})
const visibleRows = computed(() => props.rows.slice(windowRange.value.start, windowRange.value.end).map((row, index) => ({ row, index: windowRange.value.start + index })))
const topSpace = computed(() => windowRange.value.start * ROW_HEIGHT)
const bottomSpace = computed(() => (props.rows.length - windowRange.value.end) * ROW_HEIGHT)
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
onBeforeUnmount(() => { observer?.disconnect(); if (frame) cancelAnimationFrame(frame) })

function cellType(row: Record<string, unknown>, index: number, key: string): BsonType | undefined {
  return props.bsonTypes ? gridBsonType(row, props.bsonTypes[index], key) : undefined
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
    <table :class="['data-table', { 'virtual-grid': virtual }]" :aria-rowcount="rows.length + 1">
      <thead><tr>
        <th v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择当前页')" :checked="rows.length > 0 && checked.length === rows.length" @change="emit('checkAll')" /></th>
        <th class="number-cell">#</th><th v-for="column in columns" :key="column">{{ column }}</th>
      </tr></thead>
      <tbody>
        <tr v-if="topSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: topSpace + 'px' }"></td></tr>
        <tr v-for="item in visibleRows" :key="item.index" :data-row-index="item.index" :aria-rowindex="item.index + 2" :class="{ selected: selected === item.index }" @click="emit('select', item.index)" @dblclick="emit('open', item.index)">
          <td v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择第 {0} 行', [item.index + 1])" :checked="checked.includes(item.index)" @click.stop @change="emit('check', item.index)" /></td>
          <td class="number-cell">{{ offset + item.index + 1 }}</td>
          <td v-for="column in columns" :key="column"
            :class="{ 'null-cell': item.row[column] === null || !Object.hasOwn(item.row, column), 'has-bson-color': !!cellColor(cellType(item.row, item.index, column)) }"
            :data-bson-type="cellType(item.row, item.index, column)"
            :data-bson-color="cellColor(cellType(item.row, item.index, column))"
            :style="cellColor(cellType(item.row, item.index, column)) ? { '--bson-color': cellColor(cellType(item.row, item.index, column)) } : {}"
            :title="(cellType(item.row, item.index, column) ? t(bsonLabel(cellType(item.row, item.index, column)!)) + ': ' : '') + display(Object.hasOwn(item.row, column) ? item.row[column] : undefined)">
            <span v-if="bsonTypes && bsonPalette.showLabels" class="bson-type-label">{{ t(bsonLabel(cellType(item.row, item.index, column)!)) }}</span><span>{{ display(Object.hasOwn(item.row, column) ? item.row[column] : undefined) }}</span>
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
</style>
