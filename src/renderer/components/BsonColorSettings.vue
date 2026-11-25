<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { bsonLabel, bsonTypes, type BsonType } from '../../shared/bson-types'
import { defaultBsonColors, newBsonPalette, normalizeBsonPalette, typeColor } from '../../shared/bson-palette'
import { bsonPalette, saveBsonPalette } from '../bson-preferences'
import ConnectionColorPicker from './ConnectionColorPicker.vue'
const emit = defineEmits<{ close: [] }>()
const draft = ref(normalizeBsonPalette(bsonPalette.value))
const selected = ref<BsonType>('String')
const selectedColor = computed(() => typeColor(draft.value, selected.value))
function changeColor(color?: string) { draft.value.overrides[selected.value] = color || null }
function resetType() { delete draft.value.overrides[selected.value] }
function save() { saveBsonPalette(draft.value); emit('close') }
</script>
<template>
  <div class="modal-backdrop" @keydown.esc.stop="emit('close')">
    <section class="dialog bson-palette-dialog" role="dialog" aria-modal="true" :aria-label="t('BSON 类型配色')">
      <header class="dialog-header"><h2>{{ t('BSON 类型配色') }}</h2><button class="icon-button" :aria-label="t('关闭弹窗')" @click="emit('close')">×</button></header>
      <div class="bson-settings-controls"><label class="checkbox-row"><input v-model="draft.enabled" type="checkbox" /> {{ t('按类型着色') }}</label><label class="checkbox-row"><input v-model="draft.showLabels" type="checkbox" /> {{ t('显示类型标记') }}</label></div>
      <div class="bson-settings-body">
        <div class="bson-type-list" role="group" :aria-label="t('BSON 数据类型')">
          <button v-for="type in bsonTypes" :key="type" type="button" class="bson-type-option" :class="{ selected: type === selected }" :aria-pressed="type === selected" @click="selected = type">
            <span class="type-swatch" :style="{ background: typeColor(draft, type) || 'transparent' }"></span><span>{{ t(bsonLabel(type)) }}</span><small>{{ typeColor(draft, type)?.toUpperCase() || '—' }}</small>
          </button>
        </div>
        <div class="bson-settings-editor">
          <h3>{{ t(bsonLabel(selected)) }}</h3>
          <div class="bson-sample" :class="{ 'has-bson-color': draft.enabled && !!selectedColor }" :style="draft.enabled && selectedColor ? { '--bson-color': selectedColor } : {}"><span v-if="draft.showLabels" class="bson-type-label">{{ t(bsonLabel(selected)) }}</span><span class="bson-sample-text">{{ t('预览') }}</span></div>
          <ConnectionColorPicker :model-value="selectedColor" group-label="BSON 数据类型" @update:model-value="changeColor" />
          <button class="btn secondary small" type="button" @click="resetType">{{ t('恢复此类型默认颜色') }} · {{ defaultBsonColors[selected]?.toUpperCase() || '—' }}</button>
          <p class="helper">{{ t('配色仅影响显示，不修改数据库数据。') }}</p>
        </div>
      </div>
      <footer class="dialog-footer"><button class="btn secondary" type="button" @click="draft = newBsonPalette()">{{ t('恢复全部默认颜色') }}</button><span class="toolbar-spacer"></span><button class="btn secondary" type="button" @click="emit('close')">{{ t('取消') }}</button><button class="btn primary" type="button" @click="save">{{ t('保存') }}</button></footer>
    </section>
  </div>
</template>
