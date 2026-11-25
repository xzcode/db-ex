<script setup lang="ts">
import { computed, useId } from 'vue'
import { t } from '../i18n'
import { filterOperators, filterTypes, noValue, type BrowseFilter, type FilterRule, type FilterOperator } from '../../shared/browse-filter'
const props = defineProps<{ kind: 'mysql' | 'mongodb'; fields: string[]; disabled?: boolean }>()
const model = defineModel<BrowseFilter>({ required: true })
const emit = defineEmits<{ apply: []; reset: [] }>()
const fieldListId = useId()
const operators = computed(() => filterOperators.filter(op => props.kind === 'mongodb' || !['exists','missing'].includes(op)))
const types = computed(() => filterTypes.filter(type => props.kind === 'mongodb' || !['ObjectId','ISODate'].includes(type)))
const labels: Record<FilterOperator,string> = { eq:'等于', ne:'不等于', gt:'大于', gte:'大于或等于', lt:'小于', lte:'小于或等于', contains:'包含', null:'为 NULL', notNull:'不为 NULL', exists:'字段存在', missing:'字段缺失' }
const ruleCount = computed(() => model.value.groups.reduce((sum, group) => sum + group.rules.length, 0))
function rule(): FilterRule { return { field: props.fields[0] || '', operator:'eq', type:'String', value:'' } }
function addGroup() { if (model.value.groups.length < 12 && ruleCount.value < 50) model.value.groups.push({ join:'and', rules:[rule()] }) }
function addRule(group: number) { if (ruleCount.value < 50) model.value.groups[group]?.rules.push(rule()) }
function removeRule(group: number, index: number) {
  model.value.groups[group]?.rules.splice(index,1)
  if (!model.value.groups[group]?.rules.length) model.value.groups.splice(group,1)
}
function addSort() {
  if (model.value.sort.length >= 32) return
  model.value.sort.push({ field: props.fields.find(field => !model.value.sort.some(item => item.field === field)) || '', direction:1 })
}
function operatorChanged(rule: FilterRule) { if (rule.operator === 'contains') rule.type = 'String' }
</script>
<template>
  <section class="visual-query-builder">
    <datalist :id="fieldListId"><option v-for="field in fields" :key="field" :value="field" /></datalist>
    <div class="builder-section-heading"><strong>{{ t('筛选') }}</strong><button type="button" class="btn secondary small builder-add" :disabled="disabled || ruleCount >= 50" :aria-label="t('添加筛选条件')" @click="model.groups.length ? addRule(0) : addGroup()">＋</button><button type="button" class="btn secondary small builder-add" :disabled="disabled || model.groups.length >= 12 || ruleCount >= 50" :aria-label="t('添加条件组')" @click="addGroup">()＋</button><label v-if="model.groups.length > 1" class="inline-field">{{ t('组间关系') }}<select v-model="model.join" :disabled="disabled"><option value="and">AND</option><option value="or">OR</option></select></label></div>
    <p v-if="!model.groups.length" class="builder-hint">{{ t('点击 + 添加筛选条件') }}</p>
    <div v-for="(group,gi) in model.groups" :key="gi" class="builder-group">
      <div class="builder-group-heading"><span>{{ t('条件组') }} {{ gi + 1 }}</span><select v-model="group.join" :aria-label="t('组内关系') + ' ' + (gi+1)" :disabled="disabled"><option value="and">AND</option><option value="or">OR</option></select><button type="button" class="btn secondary small" :aria-label="t('添加筛选条件') + ' ' + (gi+1)" :disabled="disabled || ruleCount >= 50" @click="addRule(gi)">＋</button><button type="button" class="btn danger-text small" :aria-label="t('移除') + ' ' + t('条件组') + ' ' + (gi+1)" :disabled="disabled" @click="model.groups.splice(gi,1)">×</button></div>
      <div v-for="(rule,ri) in group.rules" :key="ri" class="builder-rule">
        <input v-if="kind === 'mongodb'" v-model="rule.field" :list="fieldListId" :aria-label="t('字段')" :placeholder="t('字段')" :disabled="disabled" spellcheck="false" />
        <select v-else v-model="rule.field" :aria-label="t('字段')" :disabled="disabled"><option value="" disabled>{{ t('字段') }}</option><option v-for="field in fields" :key="field">{{ field }}</option></select>
        <select v-model="rule.operator" :aria-label="t('比较方式')" :disabled="disabled" @change="operatorChanged(rule)"><option v-for="operator in operators" :key="operator" :value="operator">{{ t(labels[operator]) }}</option></select>
        <select v-model="rule.type" :aria-label="t('类型')" :disabled="disabled || noValue(rule.operator) || rule.operator === 'contains'"><option v-for="type in types" :key="type">{{ type }}</option></select>
        <select v-if="rule.type === 'Boolean' && !noValue(rule.operator)" v-model="rule.value" :aria-label="t('字段值')" :disabled="disabled"><option value="" disabled>—</option><option>true</option><option>false</option></select>
        <input v-else v-model="rule.value" :aria-label="t('字段值')" :placeholder="rule.type === 'ObjectId' ? '24 hex' : rule.type === 'ISODate' ? '2026-01-01T00:00:00Z' : t('字段值')" :disabled="disabled || noValue(rule.operator)" spellcheck="false" />
        <button type="button" class="btn danger-text small" :aria-label="t('移除') + ' ' + t('筛选') + ' ' + (ri+1)" :disabled="disabled" @click="removeRule(gi,ri)">×</button>
      </div>
    </div>
    <div class="builder-section-heading sort-heading"><strong>{{ t('排序方式') }}</strong><button type="button" class="btn secondary small builder-add" :aria-label="t('添加排序条件')" :disabled="disabled || model.sort.length >= 32" @click="addSort">＋</button></div>
    <p v-if="!model.sort.length" class="builder-hint">{{ t('点击 + 添加排序条件') }}</p>
    <div v-for="(rule,index) in model.sort" :key="index" class="builder-sort-rule">
      <input v-if="kind === 'mongodb'" v-model="rule.field" :list="fieldListId" :aria-label="t('排序字段')" :disabled="disabled" spellcheck="false" />
      <select v-else v-model="rule.field" :aria-label="t('排序字段')" :disabled="disabled"><option value="" disabled>{{ t('字段') }}</option><option v-for="field in fields" :key="field">{{ field }}</option></select>
      <select v-model.number="rule.direction" :aria-label="t('排序方式')" :disabled="disabled"><option :value="1">{{ t('升序') }} ↑</option><option :value="-1">{{ t('降序') }} ↓</option></select>
      <button type="button" class="btn danger-text small" :aria-label="t('移除') + ' ' + t('排序方式') + ' ' + (index+1)" :disabled="disabled" @click="model.sort.splice(index,1)">×</button>
    </div>
    <div class="builder-actions"><button class="btn primary" type="button" :disabled="disabled" @click="emit('apply')">{{ t('应用筛选与排序') }}</button><button class="btn secondary" type="button" :disabled="disabled" @click="emit('reset')">{{ t('重置筛选') }}</button></div>
  </section>
</template>
