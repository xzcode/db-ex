<script setup lang="ts">
import { t } from '../i18n'
import FilePathField from './FilePathField.vue'
import type { SshOptions } from '../../shared/types'
const model = defineModel<SshOptions>({ required: true })
withDefaults(defineProps<{ label?: string }>(), { label: 'SSH 服务器' })
</script>
<template>
  <div class="ssh-host-fields">
    <label class="field">{{ t(label) }}<input v-model.trim="model.host" placeholder="bastion.example.com" autocomplete="off" /></label>
    <label class="field">{{ t('端口') }}<input v-model.number="model.port" type="number" min="1" max="65535" /></label>
    <label class="field">{{ t('用户名') }}<input v-model.trim="model.username" autocomplete="off" /></label>
    <label class="field">{{ t('认证方式') }}<select v-model="model.authMode"><option value="password">{{ t('密码') }}</option><option value="private-key">{{ t('私钥文件') }}</option><option value="agent">SSH Agent</option></select></label>
    <label v-if="model.authMode === 'password'" class="field field-wide">{{ t('密码') }}<input v-model="model.password" type="password" autocomplete="new-password" :placeholder="t('已保存的凭据留空以保留')" /></label>
    <template v-if="model.authMode === 'private-key'"><FilePathField v-model="model.privateKeyPath" class="field-wide" label="私钥路径" kind="private-key" placeholder="/Users/you/.ssh/id_ed25519" /><label class="field field-wide">{{ t('私钥口令') }}<input v-model="model.passphrase" type="password" autocomplete="new-password" :placeholder="t('已保存的口令留空以保留')" /></label></template>
    <label v-if="model.authMode === 'agent'" class="field field-wide">Agent Socket<input v-model.trim="model.agentSocket" :placeholder="t('留空使用系统 Agent')" /></label>
    <label class="field field-wide">{{ t('主机公钥 SHA-256 指纹（64 位 hex）') }}<input v-model.trim="model.hostFingerprint" spellcheck="false" :placeholder="t('首次被拒绝后，独立核对指纹再填写')" /></label>
  </div>
</template>
