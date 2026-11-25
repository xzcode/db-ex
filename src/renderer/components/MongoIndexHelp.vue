<script setup lang="ts">
import {computed,ref} from 'vue'
import {t} from '../i18n'
import {mongoIndexDirections,mongoIndexOptionHelp,mongoIndexExamples,mongoIndexExampleText} from '../../shared/mongo-index-help'
const emit=defineEmits<{apply:[example:{keys:string;options:string}];close:[]}>()
const selected=ref('compound')
const example=computed(()=>mongoIndexExampleText(selected.value))
function apply(){if(example.value)emit('apply',example.value)}
</script>
<template>
 <div class="index-help-content" data-index-help>
  <section class="index-help-section">
   <h3>{{ t('索引字段') }} JSON</h3>
   <p class="helper">{{ t('索引字段数量为 1–32；复合索引的字段顺序有意义。') }}</p>
   <table class="index-reference-table">
    <thead><tr><th>{{ t('参数') }}</th><th>{{ t('类型') }}</th></tr></thead>
    <tbody><tr v-for="item in mongoIndexDirections" :key="item.value"><td><code dir="ltr">{{ item.value }}</code></td><td>{{ t(item.description) }}</td></tr></tbody>
   </table>
   <p class="helper">{{ t('哈希索引不支持 unique。') }}</p>
  </section>
  <section class="index-help-section">
   <h3>{{ t('索引选项') }} JSON</h3>
   <table class="index-reference-table">
    <thead><tr><th>{{ t('参数') }}</th><th>{{ t('类型') }}</th><th>{{ t('说明') }}</th></tr></thead>
    <tbody><tr v-for="item in mongoIndexOptionHelp" :key="item.name"><td><code dir="ltr">{{ item.name }}</code></td><td><code dir="ltr">{{ item.type }}</code></td><td>{{ t(item.description) }}</td></tr></tbody>
   </table>
  </section>
  <section class="index-help-section">
   <label class="field"><span>{{ t('索引示例') }}</span><select v-model="selected" :aria-label="t('索引示例')" data-index-example><option v-for="item in mongoIndexExamples" :key="item.id" :value="item.id">{{ t(item.label) }}</option></select></label>
   <div v-if="example" class="index-example-preview">
    <div><span class="muted-text">{{ t('索引字段') }} JSON</span><pre dir="ltr">{{ example.keys }}</pre></div>
    <div><span class="muted-text">{{ t('索引选项') }} JSON</span><pre dir="ltr">{{ example.options }}</pre></div>
   </div>
   <div class="index-help-apply"><p class="helper">{{ t('填入示例会替换两个 JSON 输入框，不会创建索引。') }}</p><button type="button" class="btn secondary" @click="apply">{{ t('填入示例') }}</button></div>
  </section>
 </div>
</template>
<style scoped>
.index-help-content{display:flex;flex-direction:column;gap:18px;grid-column:1/-1;min-width:0}
.index-help-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.index-help-section h3,.index-help-section p{margin:0}
.index-reference-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:auto}
.index-reference-table th,.index-reference-table td{text-align:start;border-bottom:1px solid var(--border-soft);padding:7px 8px;vertical-align:top}
.index-reference-table th{background:var(--panel-raised);color:var(--muted);font-weight:600}
.index-reference-table td:first-child{white-space:nowrap}
.index-reference-table code{color:var(--accent);font-size:11px}
.index-example-preview{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}
.index-example-preview>div{min-width:0}
.index-example-preview pre{border:1px solid var(--border);background:var(--input);border-radius:4px;min-height:100px;padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font-size:12px;text-align:left}
.index-help-apply{display:flex;align-items:center;gap:12px;justify-content:space-between}
.index-help-apply button{flex:none}
</style>
