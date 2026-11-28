<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import type { OperationResult } from '../../shared/types'
import { formatMongoDocument } from '../../shared/bson-editor'
import BsonDocumentTree from './BsonDocumentTree.vue'
import ResultGrid from './ResultGrid.vue'
const props = defineProps<{ result: OperationResult; selected: number; mode: 'record' | 'text'; mongo: boolean; offset: number }>()
const emit = defineEmits<{ select: [index:number]; open: [index:number];field:[index:number,field:string];editTree:[index:number] }>()
const index = computed(() => Math.max(0, Math.min(props.selected, props.result.rows.length - 1)))
const document = computed(() => props.result.documents?.[index.value])
const row = computed(() => props.result.rawRows?.[index.value] || props.result.rows[index.value] || {})
const formatted = computed(() => document.value !== undefined ? formatMongoDocument(document.value, props.result.bsonTypes?.[index.value]).text : JSON.stringify(row.value, null, 2))
const recordHeaders = computed(() => [t('字段'), t('类型'), t('字段值')])
const record = computed(() => props.result.columns.map((field, i) => ({ [recordHeaders.value[0]]: field, [recordHeaders.value[1]]: props.result.nullCells?.[index.value]?.includes(i) ? 'NULL' : props.result.columnTypes?.[i] || 'UNKNOWN', [recordHeaders.value[2]]: Object.hasOwn(row.value, field) ? row.value[field] === null ? '(NULL)' : String(row.value[field]) : '—' })))
</script>
<template>
  <section class="browse-record-view">
    <div v-if="result.rows.length" class="record-view-toolbar">
      <button class="btn secondary small" type="button" :disabled="index <= 0" :aria-label="t('上一条记录')" @click="emit('select', index - 1)">←</button>
      <label class="inline-field">{{ t('记录') }} <select :value="index" @change="emit('select', Number(($event.target as HTMLSelectElement).value))"><option v-for="(_,i) in result.rows" :key="i" :value="i">{{ offset + i + 1 }}</option></select></label>
      <button class="btn secondary small" type="button" :disabled="index >= result.rows.length - 1" :aria-label="t('下一条记录')" @click="emit('select', index + 1)">→</button>
      <span class="toolbar-spacer"></span><button v-if="mongo && document !== undefined" class="btn secondary small" type="button" @click="emit('open',index)">{{ t('查看文档') }}</button>
    </div>
    <div v-if="!result.rows.length" class="empty-state">{{ t('暂无记录') }}</div>
    <template v-else-if="mode === 'record'"><BsonDocumentTree v-if="mongo && document !== undefined" :document="document" :metadata="result.bsonTypes?.[index]" @edit-path="path=>{if(path.length===1)emit('field',index,path[0]!);else emit('editTree',index)}" editable/><ResultGrid v-else :columns="recordHeaders" :rows="record" resize-all @cell-view="(row)=>emit('field',index,result.columns[row]!)" @open="row=>emit('field',index,result.columns[row]!)"/></template>
    <pre v-else class="bson-raw-document" dir="ltr">{{ formatted }}</pre>
  </section>
</template>
