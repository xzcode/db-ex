<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { ConnectionConfig, DatabaseKind } from '../shared/types'

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save', config: ConnectionConfig): void
  (event: 'temporary', config: ConnectionConfig): void
}>()
const page = ref<'basic' | 'ssh' | 'tls'>('basic')
const config = reactive<ConnectionConfig>({
  name: '', kind: 'mysql', environment: 'development', host: '127.0.0.1', port: 3306,
  username: '', password: '', database: '', authSource: 'admin', redisDb: 0, uri: '',
  ssh: { enabled: false, host: '', port: 22, username: '', authMode: 'password', password: '', privateKeyPath: '', passphrase: '', agentSocket: '', hostFingerprint: '' },
  tls: { enabled: false, caPath: '', certPath: '', keyPath: '', servername: '' },
})
const kinds: DatabaseKind[] = ['mysql', 'mongodb', 'redis']
const defaults: Record<DatabaseKind, number> = { mysql: 3306, mongodb: 27017, redis: 6379 }
function changeKind(kind: DatabaseKind) {
  config.kind = kind
  config.port = defaults[kind]
}
function snapshot(): ConnectionConfig { return JSON.parse(JSON.stringify(config)) as ConnectionConfig }
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="conn-title">
      <header class="dialog-header">
        <div><div class="eyebrow">CONNECTION</div><h2 id="conn-title">创建数据库连接</h2></div>
        <button class="icon-button" aria-label="关闭弹窗" @click="emit('close')">✕</button>
      </header>
      <nav class="subtabs">
        <button :class="{ active: page === 'basic' }" @click="page = 'basic'">基本设置</button>
        <button :class="{ active: page === 'ssh' }" @click="page = 'ssh'">SSH 隧道</button>
        <button :class="{ active: page === 'tls' }" @click="page = 'tls'">TLS / SSL</button>
      </nav>
      <form @submit.prevent="emit('save', snapshot())">
        <div class="dialog-body">
          <template v-if="page === 'basic'">
            <label class="field field-wide">连接名称 <input v-model.trim="config.name" required maxlength="100" placeholder="例如：MySQL Dev" autofocus /></label>
            <div class="field field-wide"><span>数据库类型</span>
              <div class="type-picker">
                <button v-for="kind in kinds" :key="kind" type="button" :class="['type-option', { chosen: config.kind === kind }]" @click="changeKind(kind)">{{ kind === 'mongodb' ? 'MongoDB' : kind === 'mysql' ? 'MySQL' : 'Redis' }}</button>
              </div>
            </div>
            <label class="field">环境 <select v-model="config.environment"><option value="development">开发环境</option><option value="testing">测试环境</option><option value="production">生产环境</option></select></label>
            <label class="field">主机 <input v-model.trim="config.host" placeholder="127.0.0.1" /></label>
            <label class="field">端口 <input v-model.number="config.port" type="number" min="1" max="65535" /></label>
            <label v-if="config.kind !== 'redis'" class="field">默认数据库 <input v-model.trim="config.database" placeholder="可留空" /></label>
            <label v-if="config.kind === 'redis'" class="field">Redis DB <input v-model.number="config.redisDb" type="number" min="0" max="15" /></label>
            <label class="field">用户名 <input v-model.trim="config.username" autocomplete="off" placeholder="可留空" /></label>
            <label class="field">密码 <input v-model="config.password" type="password" autocomplete="new-password" placeholder="可留空" /></label>
            <label v-if="config.kind === 'mongodb'" class="field field-wide">认证库 (authSource) <input v-model.trim="config.authSource" placeholder="admin" /></label>
            <label v-if="config.kind === 'mongodb'" class="field field-wide">MongoDB URI（可选，优先使用） <textarea v-model.trim="config.uri" rows="2" placeholder="mongodb:// 或 mongodb+srv://" /></label>
            <p v-if="config.kind === 'mongodb'" class="helper field-wide">通过 SSH 单节点隧道时请使用主机/端口连接，不要填写 URI。</p>
          </template>
          <template v-else-if="page === 'ssh'">
            <label class="checkbox-row field-wide"><input v-model="config.ssh.enabled" type="checkbox" /> 启用 SSH 隧道</label>
            <template v-if="config.ssh.enabled">
              <label class="field">SSH 主机 <input v-model.trim="config.ssh.host" placeholder="bastion.example.com" /></label>
              <label class="field">SSH 端口 <input v-model.number="config.ssh.port" type="number" min="1" max="65535" /></label>
              <label class="field">SSH 用户名 <input v-model.trim="config.ssh.username" /></label>
              <label class="field">认证类型 <select v-model="config.ssh.authMode"><option value="password">密码</option><option value="private-key">私钥文件</option><option value="agent">SSH Agent</option></select></label>
              <label v-if="config.ssh.authMode === 'password'" class="field field-wide">SSH 密码 <input v-model="config.ssh.password" type="password" autocomplete="new-password" /></label>
              <template v-if="config.ssh.authMode === 'private-key'">
                <label class="field field-wide">私钥路径 <input v-model.trim="config.ssh.privateKeyPath" placeholder="~/.ssh/id_ed25519（请填写绝对路径）" /></label>
                <label class="field field-wide">私钥口令 <input v-model="config.ssh.passphrase" type="password" autocomplete="new-password" /></label>
              </template>
              <label v-if="config.ssh.authMode === 'agent'" class="field field-wide">Agent Socket（可留空使用默认） <input v-model.trim="config.ssh.agentSocket" /></label>
              <label class="field field-wide">服务器公钥 SHA-256 指纹（hex） <input v-model.trim="config.ssh.hostFingerprint" placeholder="64 位十六进制，可首次失败后核对填写" spellcheck="false" /></label>
              <p class="helper field-wide">首次连接若没有指纹，将拒绝连接并提示指纹。请先在可信渠道独立核实，再手动信任。不会自动接受未知主机。</p>
            </template>
            <p v-else class="helper field-wide">无需开放数据库公网端口，启用后通过 SSH 跳板机访问数据库。</p>
          </template>
          <template v-else>
            <label class="checkbox-row field-wide"><input v-model="config.tls.enabled" type="checkbox" /> 启用 TLS / SSL 加密</label>
            <template v-if="config.tls.enabled">
              <label class="field field-wide">CA 证书路径 <input v-model.trim="config.tls.caPath" placeholder="/path/to/ca.pem" /></label>
              <label class="field field-wide">客户端证书 PEM 路径 <input v-model.trim="config.tls.certPath" placeholder="/path/to/client.pem" /></label>
              <label class="field field-wide">客户端私钥路径 <input v-model.trim="config.tls.keyPath" placeholder="/path/to/client-key.pem" /></label>
              <label class="field field-wide">证书主机名 / SNI <input v-model.trim="config.tls.servername" placeholder="默认使用数据库主机名" /></label>
              <p class="helper field-wide">始终校验证书。MongoDB 使用同一 PEM 文件包含客户端证书与私钥；其他数据库可分别指定路径。</p>
            </template>
            <p v-else class="helper field-wide">使用可信 CA 验证服务器身份，不提供跳过证书验证的快捷选项。</p>
          </template>
        </div>
        <footer class="dialog-footer">
          <button class="btn muted" type="button" @click="emit('close')">取消</button>
          <button class="btn secondary" type="button" :disabled="!config.name.trim()" @click="emit('temporary', snapshot())">临时连接</button>
          <button class="btn primary" type="submit" :disabled="!config.name.trim()">保存连接</button>
        </footer>
      </form>
    </section>
  </div>
</template>
