<script setup lang="ts">
import { ref } from 'vue'
import { t, localize } from '../i18n'
import type { ConnectionFileKind } from '../../shared/types'
const model = defineModel<string | undefined>({ required: true })
const props = defineProps<{ label: string; kind: ConnectionFileKind; placeholder?: string }>()
const busy = ref(false)
const error = ref('')
async function browse() {
  busy.value = true; error.value = ''
  try { const path = await window.dbex.pickConnectionFile(props.kind); if (path !== null) model.value = path }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
</script>
<template>
  <div class="field file-path-field">
    <div class="file-path-row">
      <label class="field"><span>{{ t(label) }}</span><input v-model.trim="model" :placeholder="placeholder" spellcheck="false" /></label>
      <button class="btn secondary" type="button" :aria-label="t('浏览…') + ' ' + t(label)" :disabled="busy" @click="browse">{{ t('浏览…') }}</button>
    </div>
    <p v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</p>
  </div>
</template>
