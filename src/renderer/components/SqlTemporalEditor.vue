<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {t} from '../i18n'
import {sqlTemporalKind,sqlTemporalParts} from '../../shared/sql-temporal'
const props=defineProps<{type:string;modelValue:string;readonly:boolean}>()
const emit=defineEmits<{'update:modelValue':[string]}>()
const kind=computed(()=>sqlTemporalKind(props.type))
const date=ref(''),time=ref('')
function sync(){
 const parts=sqlTemporalParts(props.type,props.modelValue)
 if(parts){date.value=parts.date;time.value=parts.time}
 else if(kind.value==='time')time.value=props.modelValue
 else if(kind.value==='date')date.value=props.modelValue
 else{const [d,...rest]=props.modelValue.split(' ');date.value=d||'';time.value=rest.join(' ')}
}
sync()
watch(()=>props.modelValue,sync)
function change(){emit('update:modelValue',kind.value==='date'?date.value:kind.value==='time'?time.value:date.value+' '+time.value)}
const valid=computed(()=>!!sqlTemporalParts(props.type,props.modelValue))
</script>
<template>
 <div class="sql-temporal-editor">
  <label v-if="kind!=='time'" class="field">{{t('日期')}}<input v-model="date" type="date" min="0001-01-01" max="9999-12-31" :aria-label="t('日期')" :disabled="readonly" @change="change"/></label>
  <label v-if="kind!=='date'" class="field">{{t('时间')}}<input v-model="time" :aria-label="t('时间')" placeholder="HH:mm:ss.ffffff" spellcheck="false" :readonly="readonly" @input="change"/></label>
  <label class="field">{{t('原始时间值')}}<input :value="modelValue" :readonly="true"/></label>
  <p class="compact-help">{{t('按数据库原始时间字符串编辑，不自动转换时区或舍入小数秒。')}}</p>
  <p v-if="!valid" class="inline-message error">{{t('INVALID_TEMPORAL: 日期或时间格式无效')}}</p>
 </div>
</template>
<style scoped>.sql-temporal-editor{display:flex;flex-direction:column;gap:14px;padding:20px;max-width:560px}.sql-temporal-editor input{width:100%;min-width:0}</style>
