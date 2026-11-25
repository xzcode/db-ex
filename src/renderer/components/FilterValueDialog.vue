<script setup lang="ts">
import { computed, ref } from 'vue'
import { t, localize } from '../i18n'
import { listOperators, listValues, stringOperators, compileMongoFilter, compileMysqlFilter, type FilterRule, type FilterType, type FilterValueTypeMode } from '../../shared/browse-filter'
import { mongoValueCategories, valueCategory, categoryType, detectMongoInputType } from '../../shared/filter-value-category'
import type { FilterSuggestion } from '../../shared/filter-suggestions'
const props=defineProps<{ rule:FilterRule; kind:'mysql'|'mongodb'; types:readonly FilterType[]; suggestions:FilterSuggestion[] }>()
const emit=defineEmits<{ close:[]; save:[value:string,type:FilterType,mode?:FilterValueTypeMode] }>()
const type=ref(props.rule.type)
const mode=ref<FilterValueTypeMode|undefined>(props.rule.valueTypeMode)
const text=ref(props.rule.value)
const search=ref('')
const error=ref('')
const list= listOperators.includes(props.rule.operator)
const stringOnly=stringOperators.includes(props.rule.operator)
const category=computed(()=>valueCategory(type.value))
const options=computed(()=>props.suggestions.filter(item=>
  (!list || (props.kind==='mongodb' && type.value===categoryType(category.value) ? valueCategory(item.type)===category.value : item.type===type.value))
  && (!stringOnly||item.type==='String')
  && item.value.toLowerCase().includes(search.value.toLowerCase())))
function changeCategory(event:Event){
  const next=categoryType((event.target as HTMLSelectElement).value)
  if(valueCategory(next)===category.value)return
  type.value=next;mode.value='manual';if(list)text.value='[]';error.value=''
}
function manualInput(event:Event){
  if(props.kind==='mongodb'&&!list&&!stringOnly){
    const detected=detectMongoInputType(type.value,(event.target as HTMLInputElement).value,mode.value)
    type.value=detected.type;mode.value=detected.valueTypeMode
  }
  error.value=''
}
const selected=computed(()=>{if(!list)return [text.value];try{return listValues(text.value)}catch{return []}})
function choose(item:FilterSuggestion){
  if(list){
    const current=selected.value
    if(props.kind==='mongodb' && !current.length)type.value=item.type
    const value=item.value
    const next=current.includes(value)?current.filter(v=>v!==value):[...current,value];text.value=JSON.stringify(next)
  }
  else {type.value=item.type;mode.value='suggested';text.value=item.value}
}
function save(){
  error.value=''
  try {
    const rule={...props.rule,enabled:true,type:type.value,value:text.value}
    const draft={join:'and' as const,groups:[{join:'and' as const,rules:[rule]}],sort:[]}
    if(props.kind==='mongodb')compileMongoFilter(draft);else compileMysqlFilter('db','table',draft)
    emit('save',text.value,type.value,mode.value)
  }catch(reason){error.value=reason instanceof Error?reason.message:String(reason)}
}
</script>
<template>
  <Teleport to="body">
    <div class="modal-backdrop filter-value-backdrop" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
      <section class="dialog filter-value-dialog" role="dialog" aria-modal="true" :aria-label="t('编辑筛选值')">
        <header class="dialog-header"><h2>{{ t('编辑筛选值') }} · {{ rule.field }}</h2><button class="icon-button" type="button" :aria-label="t('关闭')" @click="emit('close')">×</button></header>
        <form @submit.prevent="save">
          <div class="filter-value-body">
            <label class="field filter-value-input">{{ t('字段值') }}<textarea v-if="list" :aria-label="t('字段值')" v-model="text" @input="manualInput" rows="3" placeholder='["value1","value2"]' /><input v-else :aria-label="t('字段值')" v-model="text" @input="manualInput" autofocus spellcheck="false" :placeholder="kind==='mongodb' && category==='datetime' ? '2026-01-01T00:00:00Z' : kind==='mongodb' && category==='objectId' ? '24 hex' : kind==='mongodb' && category==='custom' ? 'Long(&quot;123&quot;)' : ''" /></label>
            <label class="field filter-category-field">{{ t('类型') }}<select v-if="kind==='mongodb'" :aria-label="t('类型')" :value="category" :disabled="stringOnly" @change="changeCategory"><option v-for="item in mongoValueCategories" :key="item.value" :value="item.value">{{ t(item.label) }}</option></select><select v-else :aria-label="t('类型')" v-model="type" :disabled="stringOnly"><option v-for="item in types" :key="item">{{ item }}</option></select></label>
            <p v-if="kind==='mongodb' && category==='custom'" class="helper">{{ t('自定义支持 BSON 构造语法，不执行 JavaScript。') }}</p>
            <p v-if="kind==='mongodb' && category==='datetime'" class="helper">{{ t('请输入 UTC 日期时间。') }}</p>
            <p v-if="kind==='mongodb' && type!==categoryType(category)" class="helper">{{ t('当前实际类型') }}: {{ type }}</p>
            <p v-if="list" class="helper">{{ t('列表使用 JSON 字符串数组，可勾选同类型建议值。') }}</p>
            <p v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</p>
            <div class="filter-suggestion-header"><strong>{{ t('建议值') }}</strong><small>{{ t('来自当前查询页') }}</small></div>
            <div class="filter-suggestions">
              <label v-for="item in options" :key="JSON.stringify([item.type,item.value])" class="filter-suggestion"><input :type="list?'checkbox':'radio'" :checked="selected.includes(item.value) && (list && kind==='mongodb' && type===categoryType(category) ? valueCategory(item.type)===category : type===item.type)" @change="choose(item)" /><span :title="item.value">{{ item.value === '' ? t('空字符串') : item.value }}</span><small>{{ item.type }}</small></label>
              <p v-if="!options.length" class="helper">{{ t('暂无建议值') }}</p>
            </div>
            <input v-model="search" :aria-label="t('搜索建议值')" :placeholder="t('搜索建议值')" />
          </div>
          <footer class="dialog-footer"><button class="btn secondary" type="button" @click="emit('close')">{{ t('取消') }}</button><button class="btn primary" type="submit">{{ t('确认') }}</button></footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
