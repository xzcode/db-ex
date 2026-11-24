<script setup lang="ts">
import { t, localize } from './i18n'
import { reactive, ref, computed } from 'vue'
import type { ConnectionConfig, ConnectionDraft, DatabaseKind, SavedConnection, SessionInfo, SshImportResult, SshOptions } from '../shared/types'
import SshHostFields from './components/SshHostFields.vue'
const props = defineProps<{ draft?: ConnectionDraft }>()
const emit = defineEmits<{ close: []; saved: [connection: SavedConnection]; connected: [session: SessionInfo] }>()
const pages = [{ key: 'basic', label: '基本设置' }, { key: 'ssh', label: 'SSH / 多跳' }, { key: 'tls', label: 'TLS / SSL' }, { key: 'proxy', label: '代理' }, { key: 'topology', label: '拓扑' }]
const page = ref('basic')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const clearSecrets = ref<string[]>([])
const sshImport = ref<SshImportResult | null>(null)
const importedAlias = ref('')
function newSsh(): SshOptions { return { enabled: true, host: '', port: 22, username: '', authMode: 'agent', password: '', privateKeyPath: '', passphrase: '', agentSocket: '', hostFingerprint: '', jumps: [] } }
const config = reactive<ConnectionConfig>(props.draft ? JSON.parse(JSON.stringify(props.draft.config)) : {
  name: '', kind: 'mysql', environment: 'development', host: '127.0.0.1', port: 3306,
  username: '', password: '', database: '', authSource: 'admin', redisDb: 0, uri: '',
  ssh: { ...newSsh(), enabled: false }, tls: { enabled: false, caPath: '', certPath: '', keyPath: '', servername: '' },
  proxy: { enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '' },
  redisMode: 'standalone', nodes: [], mongoReplicaSet: '', mongoDirect: false, mongoTopology: 'auto', connectTimeoutMs: 12000,
})
config.proxy ||= { enabled: false, type: 'socks5', host: '', port: 1080 }
config.ssh.jumps ||= []
config.nodes ||= []
config.mongoTopology ||= config.mongoDirect ? 'direct' : 'auto'
const mongoUriActive = computed(() => config.kind === 'mongodb' && (Boolean(config.uri?.trim()) || (Boolean(props.draft?.secretFields.includes('uri')) && !clearSecrets.value.includes('uri'))))
const kinds: DatabaseKind[] = ['mysql', 'mongodb', 'redis']
const defaults: Record<DatabaseKind, number> = { mysql: 3306, mongodb: 27017, redis: 6379 }
function changeKind(kind: DatabaseKind) {
  if (config.kind === kind) return
  config.kind = kind
  config.port = defaults[kind]
  config.nodes = []
  // Credentials and URI from a different engine must not silently carry over.
  config.username = ''
  config.password = ''
  config.uri = ''
  if (kind === 'mongodb') {
    config.authSource ||= 'admin'
    config.mongoTopology ||= 'auto'
  } else {
    config.mongoReplicaSet = ''
    config.mongoDirect = false
  }
}
function snapshot(): ConnectionConfig { return JSON.parse(JSON.stringify(config)) as ConnectionConfig }
function failure(reason: unknown) { error.value = reason instanceof Error ? reason.message : String(reason) }
async function test() {
  busy.value = true; error.value = ''; notice.value = ''
  try { notice.value = await window.dbex.testConnection(snapshot(), [...clearSecrets.value]) }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
async function save(connect = false) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const saved = await window.dbex.saveConnection(snapshot(), [...clearSecrets.value])
    emit('saved', saved); config.id = saved.id
    if (connect) emit('connected', await window.dbex.connectSaved(saved.id))
    emit('close')
  } catch (reason) { failure(reason) } finally { busy.value = false }
}
async function temporary() {
  busy.value = true; error.value = ''; notice.value = ''
  try { emit('connected', await window.dbex.connectTemporary(snapshot(), [...clearSecrets.value])); emit('close') }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
async function importSsh() {
  busy.value = true; error.value = ''
  try { sshImport.value = await window.dbex.importSshConfig() }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
function applySshAlias() {
  const value = sshImport.value?.hosts.find(item => item.name === importedAlias.value)
  if (value) config.ssh = { ...JSON.parse(JSON.stringify(value.ssh)), jumps: JSON.parse(JSON.stringify(value.ssh.jumps || [])) }
}
function toggleClear(path: string) { clearSecrets.value = clearSecrets.value.includes(path) ? clearSecrets.value.filter(item => item !== path) : [...clearSecrets.value, path] }
function secretLabel(path: string) {
  const names: Record<string, string> = { password: '数据库密码', uri: 'MongoDB URI', 'ssh.password': 'SSH 密码', 'ssh.passphrase': 'SSH 私钥口令', 'proxy.password': '代理密码', sentinelPassword: 'Sentinel 密码' }
  return names[path] ? t(names[path]) : path.replace('ssh.jumps.', t('跳板机') + ' ').replace('.password', ' ' + t('密码')).replace('.passphrase', ' ' + t('私钥口令'))
}
</script>
<template>
  <div class="modal-backdrop" @keydown.esc="!busy && emit('close')">
    <section class="dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby="conn-title">
      <header class="dialog-header"><div><div class="eyebrow">CONNECTION</div><h2 id="conn-title">{{ props.draft ? t('编辑数据库连接') : t('创建数据库连接') }}</h2></div><button class="icon-button" :aria-label="t('关闭弹窗')" :disabled="busy" @click="emit('close')">×</button></header>
      <nav class="subtabs"><button v-for="item in pages" :key="item.key" :class="{ active: page === item.key }" @click="page = item.key">{{ t(item.label) }}</button></nav>
      <div v-if="error" class="inline-message error connection-error" role="alert">{{ localize(error) }}<p v-if="error.includes('SSH_HOST_KEY')">{{ t('请独立核对提示中的服务器公钥指纹，再在对应 SSH 主机配置中填写；工具不会自动信任未知主机。') }}</p></div>
      <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
      <form @submit.prevent="save()">
        <div class="dialog-body">
          <template v-if="page === 'basic'">
            <label class="field field-wide">{{ t('连接名称') }}<input v-model.trim="config.name" required maxlength="100" :placeholder="t('例如：MySQL Development')" autofocus /></label>
            <div class="field field-wide"><span>{{ t('数据库类型') }}</span><div class="type-picker"><button v-for="kind in kinds" :key="kind" type="button" :class="['type-option', { chosen: config.kind === kind }]" @click="changeKind(kind)">{{ kind === 'mongodb' ? 'MongoDB' : kind === 'mysql' ? 'MySQL' : 'Redis' }}</button></div></div>
            <label class="field">{{ t('环境') }}<select v-model="config.environment"><option value="development">{{ t('开发环境') }}</option><option value="testing">{{ t('测试环境') }}</option><option value="production">{{ t('生产环境') }}</option></select></label><label class="field">{{ t('主机') }}<input  :disabled="mongoUriActive"v-model.trim="config.host" placeholder="127.0.0.1" /></label><label class="field">{{ t('端口') }}<input  :disabled="mongoUriActive"v-model.number="config.port" type="number" min="1" max="65535" /></label>
            <label v-if="config.kind !== 'redis'" class="field">{{ t('默认数据库') }}<input  :disabled="mongoUriActive"v-model.trim="config.database" :placeholder="t('可留空')" /></label><label v-else class="field">Redis DB<input v-model.number="config.redisDb" type="number" min="0" max="1023" :disabled="config.redisMode === 'cluster'" /></label>
            <label class="field">{{ t('用户名') }}<input  :disabled="mongoUriActive"v-model.trim="config.username" autocomplete="off" :placeholder="t('可留空')" /></label><label class="field">{{ t('密码') }}<input  :disabled="mongoUriActive"v-model="config.password" type="password" autocomplete="new-password" :placeholder="props.draft?.secretFields.includes('password') ? t('已保存 · 留空保留') : t('可留空')" /></label>
            <label v-if="config.kind === 'mongodb'" class="field">{{ t('认证库 (authSource)') }}<input  :disabled="mongoUriActive"v-model.trim="config.authSource" placeholder="admin" /></label><label class="field">{{ t('连接超时（毫秒）') }}<input v-model.number="config.connectTimeoutMs" type="number" min="1000" max="60000" /></label><label v-if="config.kind === 'mongodb'" class="field field-wide">{{ t('MongoDB URI（优先于主机设置）') }}<input v-model.trim="config.uri" type="password" autocomplete="new-password" :placeholder="props.draft?.secretFields.includes('uri') ? t('已保存 URI · 留空保留') : t('mongodb:// 或 mongodb+srv://')" /></label>
            <p v-if="config.kind === 'mongodb'" class="compact-help field-wide">{{ t('填写或保留加密保存的 URI 时，URI 的地址与认证参数优先于基本设置，其他字段会锁定。要改用基本设置，请清空 URI 或勾选下方“清除 MongoDB URI”。副本集经 SSH 连接时，发现的成员也必须可从 SSH 出口访问。') }}</p>
            <p v-if="config.kind === 'mongodb' && config.nodes?.length && !mongoUriActive" class="compact-help field-wide">{{ t('注意：拓扑页配置了') }} {{ config.nodes.length }} {{ t('个种子节点，连接时将优先使用这些节点，而非上方的主机地址。') }}</p>
            <section v-if="props.draft?.secretFields.length" class="secret-settings field-wide"><strong>{{ t('已保存的凭据') }}</strong><p class="compact-help">{{ t('凭据不会回传到界面。输入新值可替换，留空保留；勾选下方项目会在测试与保存时使用清除后的配置。') }}</p><label v-for="path in props.draft.secretFields" :key="path" class="checkbox-row"><input type="checkbox" :checked="clearSecrets.includes(path)" @change="toggleClear(path)" /> {{ t('清除') }} {{ secretLabel(path) }}</label></section>
          </template>
          <template v-else-if="page === 'ssh'">
            <div class="field-wide row-between"><label class="checkbox-row"><input v-model="config.ssh.enabled" type="checkbox" /> {{ t('启用 SSH 隧道') }}</label><button class="btn secondary small" type="button" :disabled="busy" @click="importSsh">{{ t('导入 SSH config') }}</button></div>
            <template v-if="sshImport"><label class="field field-wide">{{ t('导入主机') }}<select v-model="importedAlias" @change="applySshAlias"><option value="">{{ t('选择主机别名') }}</option><option v-for="host in sshImport.hosts" :key="host.name">{{ host.name }}</option></select></label><p v-for="warning in sshImport.warnings" :key="warning" class="inline-message warning field-wide">{{ localize(warning) }}</p></template>
            <template v-if="config.ssh.enabled"><p class="helper field-wide">{{ t('连接顺序：代理（若启用）→ 前置跳板机 → 最终 SSH 服务器 → 数据库。每一级主机都需要独立核验指纹。') }}</p><section v-for="(hop, index) in config.ssh.jumps" :key="index" class="ssh-hop field-wide"><div class="row-between"><h3>{{ t('前置跳板机') }} {{ index + 1 }}</h3><button class="btn danger-text small" type="button" @click="config.ssh.jumps!.splice(index, 1)">{{ t('移除') }}</button></div><SshHostFields v-model="config.ssh.jumps![index]" :label="t('跳板机 {0} 主机', [index + 1])" /></section><button class="btn secondary field-wide" type="button" :disabled="(config.ssh.jumps?.length || 0) >= 3" @click="config.ssh.jumps!.push(newSsh())">{{ t('＋ 添加前置跳板机（最多 3 级）') }}</button><section class="ssh-hop field-wide"><h3>{{ t('最终 SSH 服务器') }}</h3><SshHostFields v-model="config.ssh" /></section></template>
          </template>
          <template v-else-if="page === 'tls'">
            <label class="checkbox-row field-wide"><input v-model="config.tls.enabled" type="checkbox" /> {{ t('启用 TLS / SSL') }}</label><template v-if="config.tls.enabled || config.sentinelTls"><label class="field field-wide">{{ t('CA 证书路径') }}<input v-model.trim="config.tls.caPath" :placeholder="t('留空使用系统信任的 CA')" /></label><label class="field field-wide">{{ t('客户端证书 PEM 路径') }}<input v-model.trim="config.tls.certPath" placeholder="/path/to/client.pem" /></label><label class="field field-wide">{{ t('客户端私钥路径') }}<input v-model.trim="config.tls.keyPath" placeholder="/path/to/client-key.pem" /></label><label class="field field-wide">{{ t('证书主机名 / SNI') }}<input v-model.trim="config.tls.servername" :placeholder="t('默认验证真实数据库主机名')" /></label><p class="helper field-wide">{{ t('启用 TLS 时校验证书与主机名；客户端证书与私钥须配对。CA 与客户端证书设置也用于已启用 TLS 的 Sentinel。集群节点需使用匹配各节点主机名的证书。') }}</p></template>
          </template>
          <template v-else-if="page === 'proxy'">
            <label class="checkbox-row field-wide"><input v-model="config.proxy!.enabled" type="checkbox" /> {{ t('启用网络代理') }}</label><template v-if="config.proxy!.enabled"><label class="field">{{ t('代理协议') }}<select v-model="config.proxy!.type"><option value="socks5">SOCKS5</option><option value="http-connect">HTTP CONNECT</option></select></label><label class="field">{{ t('代理主机') }}<input v-model.trim="config.proxy!.host" /></label><label class="field">{{ t('代理端口') }}<input v-model.number="config.proxy!.port" type="number" min="1" max="65535" /></label><label class="field">{{ t('用户名') }}<input v-model="config.proxy!.username" autocomplete="off" /></label><label class="field field-wide">{{ t('密码') }}<input v-model="config.proxy!.password" type="password" autocomplete="new-password" :placeholder="t('已保存的凭据留空保留')" /></label><p class="helper field-wide">{{ t('代理会承载数据库连接；同时启用 SSH 时，代理用于到达第一级 SSH 服务器。') }}</p></template>
          </template>
          <template v-else>
            <template v-if="config.kind === 'redis'"><label class="field field-wide">{{ t('Redis 拓扑') }}<select v-model="config.redisMode"><option value="standalone">Standalone</option><option value="sentinel">Sentinel</option><option value="cluster">Cluster</option></select></label><template v-if="config.redisMode === 'sentinel'"><label class="field">{{ t('Master 名称') }}<input v-model.trim="config.sentinelMaster" placeholder="mymaster" /></label><label class="field">{{ t('Sentinel 用户名') }}<input v-model.trim="config.sentinelUsername" /></label><label class="field">{{ t('Sentinel 密码') }}<input v-model="config.sentinelPassword" type="password" autocomplete="new-password" /></label><label class="checkbox-row"><input v-model="config.sentinelTls" type="checkbox" /> {{ t('Sentinel 使用 TLS') }}</label></template><p v-if="config.redisMode === 'cluster'" class="helper field-wide">{{ t('Cluster 使用 DB 0；Key 扫描按主节点进行，可在浏览器中切换节点。') }}</p></template>
            <template v-if="config.kind === 'mongodb'"><label class="field">{{ t('Replica Set 名称') }}<input v-model.trim="config.mongoReplicaSet" :placeholder="t('例如 rs0')" /></label><label class="field">{{ t('连接拓扑') }}<select v-model="config.mongoTopology"><option value="auto">{{ t('自动（单地址直连，副本集自动发现）') }}</option><option value="direct">{{ t('直连指定节点') }}</option><option value="discover">{{ t('副本集发现（连接各成员）') }}</option></select></label><p class="helper field-wide">{{ t('使用单个主机、无 Replica Set 名称时，“自动”将直连指定地址，适合公网端口映射；填写 Replica Set 名称或多个种子节点则自动发现。使用 URI 时保留 URI 的拓扑设置。SRV 查询使用本机 DNS。需要自动故障转移时请选择副本集发现，成员地址需可达。') }}</p></template>
            <template v-if="config.kind !== 'mysql'"><div class="field-wide row-between"><h3>{{ config.kind === 'redis' && config.redisMode === 'sentinel' ? t('Sentinel 节点') : t('种子节点') }}</h3><button class="btn secondary small" type="button" :disabled="config.nodes!.length >= 20" @click="config.nodes!.push({ host: '', port: config.kind === 'mongodb' ? 27017 : config.redisMode === 'sentinel' ? 26379 : 6379 })">{{ t('＋ 添加节点') }}</button></div><div v-for="(node, index) in config.nodes" :key="index" class="node-row field-wide"><input v-model.trim="node.host" :aria-label="t('节点 {0} 主机', [index + 1])" placeholder="node.example.com" /><input v-model.number="node.port" :aria-label="t('节点 {0} 端口', [index + 1])" type="number" min="1" max="65535" /><button class="btn danger-text small" type="button" @click="config.nodes!.splice(index, 1)">{{ t('移除') }}</button></div><p class="helper field-wide">{{ t('MongoDB节点列表为空时使用基本设置；Redis Sentinel / Cluster 必须填写种子节点。') }}</p></template><p v-else class="helper field-wide">{{ t('MySQL 使用基本设置中的主机。可配合 SSH 多跳、代理和 TLS 连接。') }}</p>
          </template>
        </div>
        <footer class="dialog-footer"><button class="btn secondary" type="button" :disabled="busy" @click="test">{{ busy ? t('处理中…') : t('测试连接') }}</button><span class="toolbar-spacer"></span><button v-if="!props.draft" class="btn secondary" type="button" :disabled="busy || !config.name.trim()" @click="temporary">{{ t('临时连接') }}</button><button class="btn secondary" type="submit" :disabled="busy || !config.name.trim()">{{ t('保存') }}</button><button class="btn primary" type="button" :disabled="busy || !config.name.trim()" @click="save(true)">{{ t('保存并连接') }}</button></footer>
      </form>
    </section>
  </div>
</template>
