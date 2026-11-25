<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t, locale, localize } from '../i18n'
import type { DatabaseKind } from '../../shared/types'
import { formatBytes, type ObjectInspection, type ObjectMetric } from '../../shared/object-inspection'
import TypeColorPanel from './TypeColorPanel.vue'
import CodeEditor from './CodeEditor.vue'

const props = defineProps<{ kind: DatabaseKind; name: string; database?: string; connection: string; tab: 'info' | 'ddl' | 'colors'; loading: boolean; busy: boolean; inspection?: ObjectInspection; error?: string }>()
const emit = defineEmits<{ change: [tab: 'info' | 'ddl' | 'colors']; close: []; refresh: [] }>()
const copyNotice = ref('')
const expanded = ref(false)
const ddl = computed(() => props.inspection?.definition || '')
const objectLabel = computed(() => t(props.inspection?.kind === 'view' ? '视图' : (props.kind === 'mysql'||props.kind==='sqlite') ? '表' : props.kind === 'mongodb' ? '集合' : 'Key'))
function display(metric: ObjectMetric) {
  if (metric.format === 'bytes') return formatBytes(metric.value, locale.value)
  if (metric.format === 'boolean') return metric.value === 'true' ? t('是') : metric.value === 'false' ? t('否') : metric.value
  if (/^\d+$/.test(metric.value) && metric.label !== '自增值') {
    try { return new Intl.NumberFormat(locale.value).format(BigInt(metric.value)) } catch { /* Preserve original. */ }
  }
  return metric.value
}
async function copy() {
  copyNotice.value = ''
  if (!ddl.value) return
  try { await window.dbex.copyText(ddl.value); copyNotice.value = '已复制到剪贴板' }
  catch (error) { copyNotice.value = error instanceof Error ? error.message : String(error) }
}
async function exportDefinition() {
  copyNotice.value = ''
  if (!ddl.value) return
  const suffix = (props.kind === 'mysql'||props.kind==='sqlite') ? '.sql' : props.kind === 'mongodb' ? '.js' : '.txt'
  const safe = props.name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'object'
  try { if (await window.dbex.exportFile(safe + suffix, ddl.value, 'text')) copyNotice.value = '语句已导出' }
  catch (error) { copyNotice.value = error instanceof Error ? error.message : String(error) }
}
watch([() => props.name, () => props.tab], () => { copyNotice.value = '' })
</script>
<template>
  <aside :class="['object-inspector', { 'inspector-expanded': expanded }]" :aria-label="t('对象详情')">
    <nav class="inspector-tabs">
      <button type="button" :title="t('对象信息')" :aria-label="t('对象信息')" :aria-pressed="tab === 'info'" :class="{ active: tab === 'info' }" @click="emit('change', 'info')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6m0-10v1.4"/></svg></button>
      <button type="button" :title="kind === 'redis' ? t('检查命令') : 'DDL'" :aria-label="kind === 'redis' ? t('检查命令') : 'DDL'" :aria-pressed="tab === 'ddl'" :class="{ active: tab === 'ddl' }" @click="emit('change', 'ddl')"><span class="ddl-glyph">{{ kind === 'redis' ? 'CLI' : 'DDL' }}</span></button>
      <button type="button" :title="t('数据类型配色')" :aria-label="t('数据类型配色')" :aria-pressed="tab === 'colors'" :class="{ active: tab === 'colors' }" @click="emit('change', 'colors')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="7.5" r="5"/><circle cx="7.5" cy="14.5" r="5"/><circle cx="16.5" cy="14.5" r="5"/></svg></button>
      <span class="toolbar-spacer"></span><button type="button" :title="t('展开面板')" :aria-label="t('展开面板')" :aria-pressed="expanded" @click="expanded = !expanded">⛶</button><button type="button" :title="t('关闭')" :aria-label="t('关闭')" @click="emit('close')">×</button>
    </nav>
    <template v-if="tab === 'colors'"><div class="inspector-scroll"><TypeColorPanel :kind="kind" /></div></template>
    <template v-else>
      <div class="inspector-object-header"><span class="inspector-object-icon">▦</span><div><strong :title="name">{{ name || t('未选择对象') }}</strong><span>{{ objectLabel }}</span></div><button class="ghost-icon" :aria-label="t('刷新')" :title="t('刷新')" :disabled="busy || !name" @click="emit('refresh')">↻</button></div>
      <div class="inspector-source"><span :title="connection">{{ connection }}</span><span v-if="database" :title="database">{{ database }}</span></div>
      <div v-if="!name" class="compact-help">{{ t('未选择对象') }}</div>
      <div v-else-if="loading" class="compact-help">{{ t('正在加载资源…') }}</div>
      <div v-else-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div>
      <template v-else-if="tab === 'info'">
        <div class="inspector-scroll">
          <dl class="object-metrics"><template v-for="item in inspection?.metrics || []" :key="item.label"><dt>{{ t(item.label) }}</dt><dd>{{ display(item) }}</dd></template></dl>
          <p v-if="inspection?.infoNote" class="compact-help">{{ t(inspection.infoNote) }}</p>
          <p v-else-if="inspection && !inspection.metrics.length" class="compact-help">{{ t('部分元数据不可用或无读取权限。') }}</p>
        </div>
      </template>
      <template v-else>
        <div class="inspector-definition-toolbar"><button class="btn secondary small" type="button" :disabled="!ddl" @click="copy">{{ t('复制语句') }}</button><button class="btn secondary small" type="button" :disabled="!ddl" @click="exportDefinition">{{ t('导出语句') }}</button></div>
        <div v-if="copyNotice" class="compact-help">{{ localize(copyNotice) }}</div>
        <p v-if="inspection?.definitionNote" class="compact-help">{{ t(inspection.definitionNote) }}</p>
        <div v-if="ddl" class="inspector-definition"><CodeEditor :model-value="ddl" :language="(kind === 'mysql'||kind==='sqlite') ? 'sql' : kind === 'mongodb' ? 'dbex-mongo-ddl' : 'plaintext'" readonly /></div>
      </template>
    </template>
  </aside>
</template>
