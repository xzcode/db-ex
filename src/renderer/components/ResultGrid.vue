<script setup lang="ts">
withDefaults(defineProps<{
  columns: string[]
  rows: Record<string, unknown>[]
  selected?: number
  selectable?: boolean
  checked?: number[]
  offset?: number
}>(), { selected: -1, selectable: false, checked: () => [], offset: 0 })
const emit = defineEmits<{ select: [index: number]; open: [index: number]; check: [index: number]; checkAll: [] }>()
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
  <div class="grid-scroll" tabindex="0" aria-label="结果表格">
    <table class="data-table">
      <thead><tr>
        <th v-if="selectable" class="number-cell"><input type="checkbox" aria-label="选择当前页" :checked="rows.length > 0 && checked.length === rows.length" @change="emit('checkAll')" /></th>
        <th class="number-cell">#</th><th v-for="column in columns" :key="column">{{ column }}</th>
      </tr></thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="index" :class="{ selected: selected === index }" @click="emit('select', index)" @dblclick="emit('open', index)">
          <td v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="`选择第 ${index + 1} 行`" :checked="checked.includes(index)" @click.stop @change="emit('check', index)" /></td>
          <td class="number-cell">{{ offset + index + 1 }}</td>
          <td v-for="column in columns" :key="column" :class="{ 'null-cell': row[column] === null || row[column] === undefined }" :title="display(row[column])">{{ display(row[column]) }}</td>
        </tr>
        <tr v-if="!rows.length"><td :colspan="columns.length + (selectable ? 2 : 1)" class="empty-grid">暂无记录</td></tr>
      </tbody>
    </table>
  </div>
</template>
