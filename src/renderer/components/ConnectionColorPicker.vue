<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { connectionColors } from '../../shared/connection-appearance'
import { parseHexColor, recentColors, rememberColor, removeRecentColor } from '../color-preferences'
const props = withDefaults(defineProps<{ modelValue?: string; disabled?: boolean; groupLabel?: string }>(), { groupLabel: '连接颜色' })
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()
const custom = ref(props.modelValue || '#4b88d9')
const hex = ref(custom.value)
const validHex = computed(() => parseHexColor(hex.value))
watch(() => props.modelValue, value => { if (value) { custom.value = value; hex.value = value } })
watch(custom, value => { hex.value = value })
watch(validHex, value => { if (value && value !== custom.value) custom.value = value })
function applyCustom() {
  if (!validHex.value || props.disabled) return
  rememberColor(validHex.value)
  emit('update:modelValue', validHex.value)
}
function label(item: typeof connectionColors[number]) { return t(item.label) + (item.variant ? ' · ' + item.color.toUpperCase() : '') }
</script>
<template>
  <div class="connection-color-picker">
    <div class="connection-swatches extended-swatches" role="group" :aria-label="t(groupLabel)">
      <button class="color-swatch no-color-swatch" type="button" :title="t('无颜色')" :aria-label="t('无颜色')" :aria-pressed="!modelValue" :disabled="disabled" @click="emit('update:modelValue', undefined)">∕</button>
      <button v-for="item in connectionColors" :key="item.color" class="color-swatch" type="button" :title="label(item)" :aria-label="label(item)" :aria-pressed="modelValue === item.color" :disabled="disabled" :style="{ backgroundColor: item.color }" @click="emit('update:modelValue', item.color)"><span v-if="modelValue === item.color" aria-hidden="true">✓</span></button>
    </div>
    <div v-if="recentColors.length" class="recent-colors">
      <span class="muted-text">{{ t('最近使用的颜色') }}</span>
      <div class="connection-swatches">
        <button v-for="color in recentColors" :key="color" class="color-swatch" type="button" :title="color.toUpperCase()" :aria-label="color.toUpperCase()" :aria-pressed="modelValue === color" :disabled="disabled" :style="{ backgroundColor: color }" @click="emit('update:modelValue', color)" @contextmenu.prevent.stop="!disabled && removeRecentColor(color)"><span v-if="modelValue === color" aria-hidden="true">✓</span></button>
      </div>
    </div>
    <div class="custom-color-row extended-custom-color">
      <label class="custom-color-label"><span>{{ t('自定义颜色') }}</span><input v-model="custom" type="color" :disabled="disabled" /></label>
      <input v-model="hex" class="hex-color-input" maxlength="7" aria-label="HEX" placeholder="#RRGGBB" spellcheck="false" :disabled="disabled" :aria-invalid="!validHex" />
      <button class="btn secondary small" type="button" :disabled="disabled || !validHex" @click="applyCustom">{{ t('应用') }}</button>
    </div>
  </div>
</template>
