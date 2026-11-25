<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { t } from '../i18n'
import FilterValueDialog from './FilterValueDialog.vue'
import { mongoValueCategories, valueCategory, categoryType, detectMongoInputType } from '../../shared/filter-value-category'
import type { FilterSuggestion } from '../../shared/filter-suggestions'
import { filterOperators, filterTypes, noValue, mongoOnlyOperators, mongoFieldTypes, stringOperators, listOperators, type BrowseFilter, type FilterRule, type FilterOperator, type FilterValueTypeMode } from '../../shared/browse-filter'
const props = defineProps<{ kind: 'mysql' | 'mongodb'; fields: string[]; disabled?: boolean; suggestions?: (field:string)=>FilterSuggestion[] }>()
const model = defineModel<BrowseFilter>({ required: true })
const emit = defineEmits<{ apply: []; reset: [] }>()
const fieldListId = useId()
const operators = computed(() => filterOperators.filter(op => props.kind === 'mongodb' || !mongoOnlyOperators.includes(op)))
const types = computed(() => filterTypes.filter(type => props.kind === 'mongodb' || !['ObjectId','ISODate','Number','Custom'].includes(type)))
const labels: Record<FilterOperator,string> = { eq:'=',ne:'!=',lt:'<',lte:'<=',gt:'>',gte:'>=',contains:'包含',notContains:'不包含',starts:'开头是',notStarts:'开头不是',ends:'结尾是',notEnds:'结尾不是',null:'为 NULL',notNull:'不为 NULL',empty:'是空的',notEmpty:'是非空的',in:'在列表',notIn:'不在列表',exists:'字段存在',missing:'字段缺失',isType:'是字段类型',notType:'不是字段类型',custom:'自定义条件' }
const editing=ref<{group:number;row:number}>()
const editingRule=computed(()=>editing.value?model.value.groups[editing.value.group]?.rules[editing.value.row]:undefined)
const selected=ref<{group:number;row:number}>()
const canMove=(delta:number)=>!!selected.value&&selected.value.row+delta>=0&&selected.value.row+delta<(model.value.groups[selected.value.group]?.rules.length||0)
function move(delta:number){if(!selected.value||!canMove(delta))return;const {group,row}=selected.value;const rules=model.value.groups[group]!.rules;const next=row+delta;[rules[row],rules[next]]=[rules[next]!,rules[row]!];selected.value={group,row:next}}
function saveValue(value:string,type:FilterRule['type'],mode?:FilterValueTypeMode){
  if(editingRule.value){editingRule.value.value=value;editingRule.value.type=type;editingRule.value.valueTypeMode=mode}
  editing.value=undefined
}
watch(()=>props.disabled,value=>{if(value)editing.value=undefined})
const ruleCount = computed(() => model.value.groups.reduce((sum, group) => sum + group.rules.length, 0))
function rule(): FilterRule { return { field: props.fields[0] || '', operator:'eq', type:'String', value:'', enabled:true } }
function addGroup() { if (model.value.groups.length < 12 && ruleCount.value < 50) model.value.groups.push({ join:'and', rules:[rule()] }) }
function addRule(group: number) { if (ruleCount.value < 50) model.value.groups[group]?.rules.push(rule()) }
function removeRule(group: number, index: number) {
  selected.value=undefined
  model.value.groups[group]?.rules.splice(index,1)
  if (!model.value.groups[group]?.rules.length) model.value.groups.splice(group,1)
}
function addSort() {
  if (model.value.sort.length >= 32) return
  model.value.sort.push({ field: props.fields.find(field => !model.value.sort.some(item => item.field === field)) || '', direction:1 })
}
function operatorChanged(rule: FilterRule) {
  if (stringOperators.includes(rule.operator)) { rule.type='String'; if(rule.valueTypeMode==='auto-object-id')rule.valueTypeMode=undefined }
  if (rule.operator==='isType'||rule.operator==='notType') rule.value='string'
  else if (listOperators.includes(rule.operator)) rule.value='[]'
  else if(rule.operator==='custom')rule.value='{"$eq":null}'
}
function removeGroup(index:number){model.value.groups.splice(index,1);selected.value=undefined}
function changeCategory(rule:FilterRule,event:Event){
  const type=categoryType((event.target as HTMLSelectElement).value)
  if (valueCategory(rule.type)!==valueCategory(type)) {
    rule.type=type; rule.valueTypeMode='manual'
    if(listOperators.includes(rule.operator))rule.value='[]'
  }
}
function manualInput(rule:FilterRule,event:Event){
  if(props.kind!=='mongodb'||listOperators.includes(rule.operator)||noValue(rule.operator)||stringOperators.includes(rule.operator))return
  // Read the current input directly so detection also works for paste and
  // does not depend on the order of Vue's v-model/input listeners.
  Object.assign(rule,detectMongoInputType(rule.type,(event.target as HTMLInputElement).value,rule.valueTypeMode))
}
function setField(rule:FilterRule){if(noValue(rule.operator)||stringOperators.includes(rule.operator)||rule.operator==='custom'||rule.operator==='isType'||rule.operator==='notType')return;const values=props.suggestions?.(rule.field)||[];if(rule.valueTypeMode==='manual'||rule.valueTypeMode==='suggested')return;if(rule.valueTypeMode==='auto-object-id')return;if(values.length&&values.every(item=>item.type===values[0]!.type))rule.type=values[0]!.type}

</script>
<template>
  <section class="visual-query-builder">
    <datalist :id="fieldListId"><option v-for="field in fields" :key="field" :value="field" /></datalist>
    <div class="builder-section-heading"><strong>{{ t('筛选') }}</strong><button type="button" class="btn secondary small" :aria-label="t('上移条件')" :disabled="disabled || !canMove(-1)" @click="move(-1)">↑</button><button type="button" class="btn secondary small" :aria-label="t('下移条件')" :disabled="disabled || !canMove(1)" @click="move(1)">↓</button><button type="button" class="btn secondary small builder-add" :disabled="disabled || ruleCount >= 50" :aria-label="t('添加筛选条件')" @click="model.groups.length ? addRule(0) : addGroup()">＋</button><button type="button" class="btn secondary small builder-add" :disabled="disabled || model.groups.length >= 12 || ruleCount >= 50" :aria-label="t('添加条件组')" @click="addGroup">()＋</button><label v-if="model.groups.length > 1" class="inline-field">{{ t('组间关系') }}<select v-model="model.join" :disabled="disabled"><option value="and">AND</option><option value="or">OR</option></select></label></div>
    <p v-if="!model.groups.length" class="builder-hint">{{ t('点击 + 添加筛选条件') }}</p>
    <div v-for="(group,gi) in model.groups" :key="gi" class="builder-group">
      <div class="builder-group-heading"><span>{{ t('条件组') }} {{ gi + 1 }}</span><select v-if="gi < model.groups.length-1" :value="group.joinNext || model.join" :aria-label="t('组间关系') + ' ' + (gi+1)" :disabled="disabled" @change="group.joinNext=($event.target as HTMLSelectElement).value as 'and'|'or'"><option value="and">AND</option><option value="or">OR</option></select><button type="button" class="btn secondary small" :aria-label="t('添加筛选条件') + ' ' + (gi+1)" :disabled="disabled || ruleCount >= 50" @click="addRule(gi)">＋</button><button type="button" class="btn danger-text small" :aria-label="t('移除') + ' ' + t('条件组') + ' ' + (gi+1)" :disabled="disabled" @click="removeGroup(gi)">×</button></div>
      <div v-for="(rule,ri) in group.rules" :key="ri" :class="['builder-rule', {'rule-disabled':rule.enabled===false,'rule-selected':selected?.group===gi&&selected?.row===ri}]" @click="selected={group:gi,row:ri}">
        <input type="checkbox" :aria-label="t('启用条件') + ' ' + (ri+1)" :checked="rule.enabled!==false" :disabled="disabled" @change="rule.enabled=($event.target as HTMLInputElement).checked" />
        <input v-if="kind === 'mongodb'" v-model="rule.field" @change="setField(rule)" :list="fieldListId" :aria-label="t('字段')" :placeholder="t('字段')" :disabled="disabled" spellcheck="false" />
        <select v-else v-model="rule.field" @change="setField(rule)" :aria-label="t('字段')" :disabled="disabled"><option value="" disabled>{{ t('字段') }}</option><option v-for="field in fields" :key="field">{{ field }}</option></select>
        <select v-model="rule.operator" :aria-label="t('比较方式')" :disabled="disabled" @change="operatorChanged(rule)"><option v-for="operator in operators" :key="operator" :value="operator">{{ t(labels[operator]) }}</option></select>
        <template v-if="rule.operator==='isType'||rule.operator==='notType'"><select v-model="rule.value" :aria-label="t('字段类型')" :disabled="disabled"><option v-for="type in mongoFieldTypes" :key="type">{{ type }}</option></select><span></span><span></span></template>
        <template v-else-if="rule.operator==='custom'"><input v-model="rule.value" class="custom-rule-value" :aria-label="t('自定义条件')" :disabled="disabled" spellcheck="false" /><span></span><span></span></template>
        <template v-else>
          <select v-if="kind==='mongodb'" :value="valueCategory(rule.type)" :aria-label="t('类型')" :disabled="disabled || noValue(rule.operator) || stringOperators.includes(rule.operator)" @change="changeCategory(rule,$event)"><option v-for="item in mongoValueCategories" :key="item.value" :value="item.value">{{ t(item.label) }}</option></select>
          <select v-else v-model="rule.type" :aria-label="t('类型')" :disabled="disabled || noValue(rule.operator) || stringOperators.includes(rule.operator)"><option v-for="type in types" :key="type">{{ type }}</option></select>
          <select v-if="kind==='mysql' && rule.type === 'Boolean' && !noValue(rule.operator) && !listOperators.includes(rule.operator)" v-model="rule.value" :aria-label="t('字段值')" :disabled="disabled"><option value="" disabled>—</option><option>true</option><option>false</option></select>
          <input v-else v-model="rule.value" @input="manualInput(rule,$event)" :aria-label="t('字段值')" :placeholder="listOperators.includes(rule.operator)?'[]':rule.type==='ObjectId'?'24 hex':rule.type==='ISODate'?'2026-01-01T00:00:00Z':t('字段值')" :disabled="disabled || noValue(rule.operator)" spellcheck="false" />
          <button type="button" class="btn secondary small" :aria-label="t('编辑筛选值') + ' ' + (ri+1)" :title="t('建议值')" :disabled="disabled || noValue(rule.operator) || !rule.field" @click="editing={group:gi,row:ri}">…</button>
        </template>
        <select v-if="ri < group.rules.length-1" :value="rule.join || group.join" :aria-label="t('下一条件关系') + ' ' + (ri+1)" :disabled="disabled" @change="rule.join=($event.target as HTMLSelectElement).value as 'and'|'or'"><option value="and">AND</option><option value="or">OR</option></select><span v-else></span>
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
    <FilterValueDialog v-if="editingRule" :rule="editingRule" :kind="kind" :types="types" :suggestions="suggestions?.(editingRule.field) || []" @close="editing=undefined" @save="saveValue" />
  </section>
</template>
