<script setup lang="ts">
import { computed, ref } from 'vue'
import { t, localize } from '../i18n'
import { listOperators, listValues, stringOperators, compileMongoFilter, compileMysqlFilter, type FilterRule, type FilterType } from '../../shared/browse-filter'
import type { FilterSuggestion } from '../../shared/filter-suggestions'
const props=defineProps<{ rule:FilterRule; kind:'mysql'|'mongodb'; types:readonly FilterType[]; suggestions:FilterSuggestion[] }>()
const emit=defineEmits<{ close:[]; save:[value:string,type:FilterType] }>()
const type=ref(props.rule.type)
const text=ref(props.rule.value)
const search=ref('')
const error=ref('')
const list= listOperators.includes(props.rule.operator)
const stringOnly=stringOperators.includes(props.rule.operator)
const options=computed(()=>props.suggestions.filter(item=>(!list||item.type===type.value)&&(!stringOnly||item.type==='String')&&item.value.toLowerCase().includes(search.value.toLowerCase())))
const selected=computed(()=>{if(!list)return [text.value];try{return listValues(text.value)}catch{return []}})
function choose(item:FilterSuggestion){
  if(list){const current=selected.value;const next=current.includes(item.value)?current.filter(value=>value!==item.value):[...current,item.value];text.value=JSON.stringify(next)}
  else {type.value=item.type;text.value=item.value}
}
function save(){
  error.value=''
  try {
    const rule={...props.rule,enabled:true,type:type.value,value:text.value}
    const draft={join:'and' as const,groups:[{join:'and' as const,rules:[rule]}],sort:[]}
    if(props.kind==='mongodb')compileMongoFilter(draft);else compileMysqlFilter('db','table',draft)
    emit('save',text.value,type.value)
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
            <label class="field">{{ t('类型') }}<select v-model="type" :disabled="stringOnly"><option v-for="item in types" :key="item">{{ item }}</option></select></label>
            <label class="field">{{ t('字段值') }}<textarea v-if="list" v-model="text" rows="3" placeholder='["value1","value2"]' /><input v-else v-model="text" autofocus spellcheck="false" /></label>
            <p v-if="list" class="helper">{{ t('列表使用 JSON 字符串数组，可勾选同类型建议值。') }}</p>
            <p v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</p>
            <div class="filter-suggestion-header"><strong>{{ t('建议值') }}</strong><small>{{ t('来自当前查询页') }}</small></div>
            <div class="filter-suggestions">
              <label v-for="item in options" :key="JSON.stringify([item.type,item.value])" class="filter-suggestion"><input :type="list?'checkbox':'radio'" :checked="selected.includes(item.value) && type===item.type" @change="choose(item)" /><span :title="item.value">{{ item.value === '' ? t('空字符串') : item.value }}</span><small>{{ item.type }}</small></label>
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
