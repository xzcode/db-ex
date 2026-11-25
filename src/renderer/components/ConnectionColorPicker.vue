<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '../i18n'
import { connectionColors } from '../../shared/connection-appearance'
const props = defineProps<{ modelValue?: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()
const custom = ref(props.modelValue || '#4b88d9')
watch(() => props.modelValue, value => { if (value) custom.value = value })
</script>
<template>
  <div class="connection-color-picker">
    <div class="connection-swatches" role="group" :aria-label="t('连接颜色')">
      <button class="color-swatch no-color-swatch" type="button" :title="t('无颜色')" :aria-label="t('无颜色')" :aria-pressed="!modelValue" :disabled="disabled" @click="emit('update:modelValue', undefined)">∕</button>
      <button v-for="item in connectionColors" :key="item.color" class="color-swatch" type="button" :title="t(item.label)" :aria-label="t(item.label)" :aria-pressed="modelValue === item.color" :disabled="disabled" :style="{ backgroundColor: item.color }" @click="emit('update:modelValue', item.color)"><span v-if="modelValue === item.color" aria-hidden="true">✓</span></button>
    </div>
    <div class="custom-color-row">
      <label class="custom-color-label"><span>{{ t('自定义颜色') }}</span><input v-model="custom" type="color" :disabled="disabled" /></label>
      <button class="btn secondary small" type="button" :disabled="disabled" @click="emit('update:modelValue', custom)">{{ t('应用') }}</button>
    </div>
  </div>
</template>
