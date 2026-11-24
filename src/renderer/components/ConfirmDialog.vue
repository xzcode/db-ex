<script setup lang="ts">
import { t } from '../i18n'
import { ref } from 'vue'
const props = withDefaults(defineProps<{ title: string; message: string; phrase?: string; danger?: boolean; confirmLabel?: string }>(), { phrase: '', danger: false, confirmLabel: '确认' })
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const input = ref('')
</script>
<template>
  <div class="modal-backdrop" @keydown.esc="emit('cancel')">
    <section class="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-heading">
      <header class="dialog-header"><h2 id="confirm-heading">{{ title }}</h2><button class="icon-button" :aria-label="t('取消')" @click="emit('cancel')">×</button></header>
      <div class="confirm-body"><p class="pre-line">{{ message }}</p><label v-if="phrase" class="field">{{ t('输入') }} <strong>{{ phrase }}</strong> {{ t('以确认') }}<input v-model="input" autofocus autocomplete="off" @keyup.enter="input === props.phrase && emit('confirm')" /></label></div>
      <footer class="dialog-footer"><button class="btn secondary" @click="emit('cancel')">{{ t('取消') }}</button><button :class="['btn', danger ? 'danger' : 'primary']" :disabled="!!phrase && input !== phrase" @click="emit('confirm')">{{ t(confirmLabel) }}</button></footer>
    </section>
  </div>
</template>
