<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import type { DatabaseKind } from '../../shared/types'
import { bsonLabel, bsonTypes, isBsonType, type BsonType } from '../../shared/bson-types'
import { defaultBsonColors, newBsonPalette, normalizeBsonPalette, typeColor } from '../../shared/bson-palette'
import { bsonPalette, saveBsonPalette } from '../bson-preferences'
import { databaseTypes, databaseTypeColor, defaultDatabaseColor, newDatabasePalette, normalizeDatabasePalette, type DatabasePalette } from '../../shared/database-palette'
import { databasePalettes, saveDatabasePalette } from '../database-color-preferences'
import ConnectionColorPicker from './ConnectionColorPicker.vue'
const props = defineProps<{ kind: DatabaseKind }>()
const emit = defineEmits<{ saved: [] }>()
const types = computed<readonly string[]>(() => props.kind === 'mongodb' ? bsonTypes : databaseTypes(props.kind))
const selected = ref('')
const draft = ref<DatabasePalette>(newDatabasePalette())
function load() {
  const kind = props.kind
  const value = kind === 'mongodb' ? normalizeBsonPalette(bsonPalette.value) : normalizeDatabasePalette(kind, databasePalettes.value[kind])
  draft.value = { enabled: value.enabled, showLabels: value.showLabels, overrides: { ...value.overrides } }
  selected.value = types.value.includes(selected.value) ? selected.value : types.value[0]!
}
watch(() => props.kind, load, { immediate: true })
function label(type: string) { return props.kind === 'mongodb' && isBsonType(type) ? t(bsonLabel(type)) : type }
function color(type: string): string | undefined {
  if (props.kind === 'mongodb') return isBsonType(type) ? typeColor(normalizeBsonPalette(draft.value), type) : undefined
  return databaseTypeColor(props.kind, draft.value, type)
}
function defaultColor(type: string) { return props.kind === 'mongodb' && isBsonType(type) ? defaultBsonColors[type] || undefined : props.kind !== 'mongodb' ? defaultDatabaseColor(props.kind, type) : undefined }
function reset() { draft.value = props.kind === 'mongodb' ? { ...newBsonPalette(), overrides: {} } : newDatabasePalette() }
function save() {
  if (props.kind === 'mongodb') saveBsonPalette(normalizeBsonPalette(draft.value))
  else saveDatabasePalette(props.kind, draft.value)
  emit('saved')
}
const selectedColor = computed(() => color(selected.value))
</script>
<template>
  <div class="type-color-panel">
    <label class="checkbox-row"><input v-model="draft.enabled" type="checkbox" /> {{ t('按类型着色') }}</label>
    <label class="checkbox-row"><input v-model="draft.showLabels" type="checkbox" /> {{ t('显示类型标记') }}</label>
    <div class="inspector-type-list" role="group" :aria-label="t('数据类型配色')">
      <button v-for="type in types" :key="type" type="button" :class="['bson-type-option', { selected: selected === type }]" :aria-pressed="selected === type" @click="selected = type">
        <span class="type-swatch" :style="{ background: color(type) || 'transparent' }"></span><span>{{ label(type) }}</span><small>{{ color(type)?.toUpperCase() || '—' }}</small>
      </button>
    </div>
    <h3>{{ label(selected) }}</h3>
    <div class="bson-sample" :class="{ 'has-bson-color': draft.enabled && !!selectedColor }" :style="draft.enabled && selectedColor ? { '--bson-color': selectedColor } : {}"><span v-if="draft.showLabels" class="bson-type-label">{{ label(selected) }}</span>{{ t('预览') }}</div>
    <ConnectionColorPicker :model-value="selectedColor" group-label="数据类型配色" @update:model-value="draft.overrides[selected] = $event || null" />
    <button class="btn secondary small" type="button" @click="delete draft.overrides[selected]">{{ t('恢复此类型默认颜色') }} · {{ defaultColor(selected)?.toUpperCase() || '—' }}</button>
    <p class="helper">{{ t('配色仅影响显示，不修改数据库数据。') }}</p>
    <div class="type-color-footer"><button class="btn secondary small" type="button" @click="reset">{{ t('恢复全部默认颜色') }}</button><button class="btn primary small" type="button" @click="save">{{ t('保存') }}</button></div>
  </div>
</template>
