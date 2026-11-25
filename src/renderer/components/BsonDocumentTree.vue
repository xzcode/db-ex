<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { bsonLabel, childType, typeName, type BsonType, type BsonTypeTree } from '../../shared/bson-types'
import { activeTypeColor } from '../../shared/bson-palette'
import { bsonPalette } from '../bson-preferences'
const props = defineProps<{ document: string; metadata?: BsonTypeTree }>()
const expanded = ref<string[]>([])
const parsed = computed(() => { try { return { valid: true as const, value: JSON.parse(props.document) as unknown } } catch { return { valid: false as const } } })
interface Row { key: string; path: string; type: BsonType; value: string; depth: number; expandable: boolean; open: boolean }
const preview = computed(() => {
  const rows: Row[] = []
  let limited = false
  const open = new Set(expanded.value)
  const MAX_VISIBLE = 1000
  function walk(value: unknown, metadata: BsonTypeTree | undefined, path: string[], depth: number) {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (rows.length >= MAX_VISIBLE) { limited = true; return }
      const nextPath = [...path, key]
      const identity = JSON.stringify(nextPath)
      const node = childType(metadata, key)
      const type = typeName(node)
      // Do not treat an EJSON wrapper as a document based on its keys. Only
      // BSON metadata authorizes expansion as an actual document or array.
      const expandable = (type === 'Document' || type === 'Array') && child !== null && typeof child === 'object'
      let text: string
      if (expandable) text = type === 'Array' && Array.isArray(child) ? '[' + child.length + ']' : '{' + Object.keys(child as object).length + '}'
      else { const serialized = JSON.stringify(child); text = serialized === undefined ? String(child) : serialized }
      rows.push({ key, path: identity, type, value: text.length > 4096 ? text.slice(0, 4096) + '…' : text, depth, expandable, open: open.has(identity) })
      if (expandable && open.has(identity) && depth < 64) walk(child, node, nextPath, depth + 1)
      if (expandable && open.has(identity) && depth >= 64) limited = true
    }
  }
  if (parsed.value.valid) walk(parsed.value.value, props.metadata, [], 0)
  return { rows, limited }
})
function toggle(path: string) { expanded.value = expanded.value.includes(path) ? expanded.value.filter(item => item !== path) : [...expanded.value, path] }
function color(type: BsonType) { return activeTypeColor(bsonPalette.value, type) }
watch(() => props.document, () => { expanded.value = [] })
</script>
<template>
  <div class="bson-document-tree" dir="ltr">
    <p v-if="!parsed.valid" class="compact-help">{{ t('无法解析文档，请查看原始 EJSON。') }}</p>
    <table v-else class="data-table bson-document-table">
      <thead><tr><th>{{ t('字段') }}</th><th>{{ t('类型') }}</th><th>{{ t('字段值') }}</th></tr></thead>
      <tbody>
        <tr v-for="row in preview.rows" :key="row.path" :data-bson-type="row.type" :class="{ 'has-bson-color': !!color(row.type) }" :style="color(row.type) ? { '--bson-color': color(row.type) } : {}">
          <td><div class="bson-tree-field" :style="{ paddingInlineStart: Math.min(row.depth, 24) * 16 + 'px' }"><button v-if="row.expandable" class="ghost-icon bson-expand" type="button" :aria-label="row.key" :aria-expanded="row.open" @click="toggle(row.path)">{{ row.open ? '⌄' : '›' }}</button><span v-else class="bson-expand-spacer"></span><span :title="row.key">{{ row.key }}</span></div></td>
          <td><span class="bson-type-label">{{ t(bsonLabel(row.type)) }}</span></td><td class="bson-tree-value" :title="row.value">{{ row.value }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="preview.limited || preview.rows.some(row => row.type === 'Unknown')" class="compact-help">{{ t('部分类型或字段预览受限，完整内容请查看原始 EJSON。') }}</p>
  </div>
</template>
