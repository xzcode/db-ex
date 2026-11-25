<script setup lang="ts">
import { isMysqlFamily } from '../shared/relational-capabilities'
import { t, localize } from './i18n'
import { ref, computed, watch } from 'vue'
import type { ConnectionConfig, ConnectionDraft, DatabaseKind, SavedConnection, SessionInfo, SshImportResult } from '../shared/types'
import { databaseNames, defaultPorts, initialAuth, initialEntry, mongoUriAddress, newConnectionConfig, newSshHost, prepareConnection, type DatabaseAuthMode, type EntryMode } from '../shared/connection-form'
import SshHostFields from './components/SshHostFields.vue'
import FilePathField from './components/FilePathField.vue'
import ConnectionColorPicker from './components/ConnectionColorPicker.vue'
import DatabaseIcon from './components/DatabaseIcon.vue'
const props = defineProps<{ draft?: ConnectionDraft }>()
const emit = defineEmits<{ close: []; saved: [connection: SavedConnection]; connected: [session: SessionInfo] }>()
const allPages = [{ key: 'basic', label: '基本设置' }, { key: 'tls', label: 'TLS / SSL' }, { key: 'ssh', label: 'SSH / 多跳' }, { key: 'proxy', label: '代理' }, { key: 'advanced', label: '高级设置' }]
const page = ref('basic')
const stage = ref<'choose' | 'form'>(props.draft ? 'form' : 'choose')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const clearSecrets = ref<string[]>([])
const sshImport = ref<SshImportResult | null>(null)
const importedAlias = ref('')
const config = ref<ConnectionConfig>(props.draft ? JSON.parse(JSON.stringify(props.draft.config)) : newConnectionConfig('mysql'))
config.value.proxy ||= { enabled: false, type: 'socks5', host: '', port: 1080 }
config.value.ssh.jumps ||= []
config.value.nodes ||= []
config.value.mongoTopology ||= config.value.mongoDirect ? 'direct' : 'auto'
config.value.redisMode ||= 'standalone'
const entry = ref<EntryMode>(initialEntry(props.draft))
const authMode = ref<DatabaseAuthMode>(initialAuth(config.value, props.draft))
const revealPassword = ref(false)
const revealUri = ref(false)
const pages=computed(()=>config.value.kind==='sqlite'?allPages.filter(p=>p.key==='basic'||p.key==='advanced'):allPages)
const kinds: DatabaseKind[] = ['mysql','mariadb','mongodb','redis','sqlite','clickhouse']
watch(()=>config.value.tls.enabled,(enabled,previous)=>{if(config.value.kind==='clickhouse'&&enabled!==previous){if(enabled&&config.value.port===8123)config.value.port=8443;else if(!enabled&&config.value.port===8443)config.value.port=8123}})
const mongoUriActive = computed(() => config.value.kind === 'mongodb' && entry.value === 'uri')
const usesSeeds = computed(() => config.value.kind === 'mongodb' ? !mongoUriActive.value && Boolean(config.value.nodes?.length) : config.value.kind === 'redis' && config.value.redisMode !== 'standalone')
const showSeedEditor = computed(() => config.value.kind === 'mongodb' && !mongoUriActive.value && (config.value.mongoTopology !== 'direct' || Boolean(config.value.nodes?.length)) || config.value.kind === 'redis' && config.value.redisMode !== 'standalone')
const uriAddress = computed(() => mongoUriAddress(config.value.uri || ''))
const savedFields = computed(() => (props.draft?.secretFields || []).filter(path => path !== 'uri'))
function chooseKind(kind: DatabaseKind, mode: EntryMode = 'fields') {
  if (busy.value) return
  if (config.value.kind !== kind) {
    config.value = newConnectionConfig(kind)
    authMode.value = initialAuth(config.value)
    clearSecrets.value = []
    sshImport.value = null
    importedAlias.value = ''
  }
  setEntry(mode)
  page.value = 'basic'; stage.value = 'form'; error.value = ''; notice.value = ''
}
function setEntry(mode: EntryMode) {
  if (entry.value === 'uri' && mode === 'fields') config.value.uri = ''
  entry.value = mode
  if (mode === 'fields' && !config.value.host) config.value.host = '127.0.0.1'
  revealUri.value = false
}
function back() { if (!busy.value && !config.value.id) { stage.value = 'choose'; error.value = ''; notice.value = '' } }
function changeRedisMode() {
  if (config.value.redisMode === 'standalone') { config.value.nodes = []; config.value.port = 6379 }
  else {
    config.value.nodes = [{ host: config.value.host || '127.0.0.1', port: config.value.redisMode === 'sentinel' ? 26379 : 6379 }]
    if (config.value.redisMode === 'cluster') config.value.redisDb = 0
  }
}
function addSeed() {
  const port = config.value.kind === 'mongodb' ? 27017 : config.value.redisMode === 'sentinel' ? 26379 : 6379
  config.value.nodes!.push({ host: '', port })
}
function snapshot(allowUnnamed = false) { return prepareConnection(config.value, { entry: entry.value, auth: authMode.value, draft: props.draft, clearSecrets: clearSecrets.value, allowUnnamed }) }
function failure(reason: unknown) { error.value = reason instanceof Error ? reason.message : String(reason) }
async function chooseSqlite(create=false){try{const path=await window.dbex.pickConnectionFile(create?'sqlite-create':'sqlite');if(path)config.value.filePath=path}catch(reason){failure(reason)}}
async function test() {
  busy.value = true; error.value = ''; notice.value = ''
  try { const input = snapshot(true); notice.value = await window.dbex.testConnection(input.config, input.clearSecrets) }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
async function save(connect = false) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const input = snapshot()
    const saved = await window.dbex.saveConnection(input.config, input.clearSecrets)
    emit('saved', saved); config.value.id = saved.id
    if (connect) emit('connected', await window.dbex.connectSaved(saved.id))
    emit('close')
  } catch (reason) { failure(reason) } finally { busy.value = false }
}
async function temporary() {
  busy.value = true; error.value = ''; notice.value = ''
  try { const input = snapshot(true); emit('connected', await window.dbex.connectTemporary(input.config, input.clearSecrets)); emit('close') }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
async function importSsh() {
  busy.value = true; error.value = ''
  try { sshImport.value = await window.dbex.importSshConfig() }
  catch (reason) { failure(reason) } finally { busy.value = false }
}
function applySshAlias() {
  const value = sshImport.value?.hosts.find(item => item.name === importedAlias.value)
  if (value) config.value.ssh = { ...JSON.parse(JSON.stringify(value.ssh)), jumps: JSON.parse(JSON.stringify(value.ssh.jumps || [])) }
}
function toggleClear(path: string) { clearSecrets.value = clearSecrets.value.includes(path) ? clearSecrets.value.filter(item => item !== path) : [...clearSecrets.value, path] }
function secretLabel(path: string) {
  const names: Record<string, string> = { password: '数据库密码', 'ssh.password': 'SSH 密码', 'ssh.passphrase': 'SSH 私钥口令', 'proxy.password': '代理密码', sentinelPassword: 'Sentinel 密码' }
  return names[path] ? t(names[path]) : path.replace('ssh.jumps.', t('跳板机') + ' ').replace('.password', ' ' + t('密码')).replace('.passphrase', ' ' + t('私钥口令'))
}
</script>
<template>
  <div class="modal-backdrop" @keydown.esc="!busy && emit('close')">
    <section v-if="stage === 'choose'" class="dialog connection-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <header class="dialog-header"><h2 id="picker-title">{{ t('选择数据库类型') }}</h2><button class="icon-button" :aria-label="t('关闭弹窗')" @click="emit('close')">×</button></header>
      <div class="connection-picker-body">
        <button v-for="kind in kinds" :key="kind" class="connection-choice" type="button" :aria-label="databaseNames[kind]" @click="chooseKind(kind)">
          <DatabaseIcon :kind="kind" size="large" /><span class="choice-name">{{ databaseNames[kind] }}</span><span class="choice-port">{{ kind==='sqlite'?'Local':defaultPorts[kind] }}</span><span class="choice-arrow">›</span>
        </button>
        <div class="connection-picker-divider"></div>
        <button class="connection-choice uri-choice" type="button" :aria-label="t('使用 MongoDB URI')" @click="chooseKind('mongodb', 'uri')"><DatabaseIcon kind="mongodb" size="large" /><span class="choice-name">{{ t('使用 MongoDB URI') }}</span><span class="choice-arrow">›</span></button>
      </div>
      <footer class="dialog-footer"><button class="btn secondary" type="button" @click="emit('close')">{{ t('取消') }}</button></footer>
    </section>
    <section v-else class="dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby="conn-title">
      <header class="dialog-header"><div class="connection-dialog-title"><DatabaseIcon :kind="config.kind" size="large" /><div><div class="eyebrow">{{ databaseNames[config.kind] }}</div><h2 id="conn-title">{{ props.draft ? t('编辑数据库连接') : t('创建数据库连接') }}</h2></div></div><button class="icon-button" :aria-label="t('关闭弹窗')" :disabled="busy" @click="emit('close')">×</button></header>
      <nav class="subtabs"><button v-for="item in pages" :key="item.key" type="button" :class="{ active: page === item.key }" :disabled="busy" @click="page = item.key">{{ t(item.label) }}<span v-if="(item.key === 'ssh' && config.ssh.enabled) || (item.key === 'tls' && config.tls.enabled) || (item.key === 'proxy' && config.proxy?.enabled)" class="enabled-dot"></span></button></nav>
      <div v-if="error" class="inline-message error connection-error" role="alert">{{ localize(error) }}<p v-if="error.includes('SSH_HOST_KEY')">{{ t('请独立核对提示中的服务器公钥指纹，再在对应 SSH 主机配置中填写；工具不会自动信任未知主机。') }}</p></div>
      <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
      <form @submit.prevent="save()">
        <div :class="['dialog-body', { 'general-connection-body': page === 'basic' }]">
          <template v-if="page === 'basic'">
            <div class="general-connection-fields field-wide">
              <label class="connection-row"><span>{{ t('连接名称') }}</span><input v-model.trim="config.name" required maxlength="100" :placeholder="databaseNames[config.kind]" autofocus /></label>
              <template v-if="config.kind==='sqlite'"><div class="connection-row"><span>SQLite {{ t('数据文件') }}</span><div class="pref-inline"><input v-model="config.filePath" aria-label="SQLite" spellcheck="false" /><button type="button" class="btn secondary small" @click="chooseSqlite()">{{ t('选择数据文件') }}</button><button type="button" class="btn secondary small" @click="chooseSqlite(true)">{{ t('新建') }}</button></div></div></template><template v-if="config.kind === 'mongodb'">
                <div class="connection-row"><span>{{ t('连接方式') }}</span><div class="connection-mode-buttons"><button type="button" :class="['mode-button', { selected: entry === 'fields' }]" :aria-pressed="entry === 'fields'" @click="setEntry('fields')">{{ t('主机和端口') }}</button><button type="button" :class="['mode-button', { selected: entry === 'uri' }]" :aria-pressed="entry === 'uri'" @click="setEntry('uri')">MongoDB URI</button></div></div>
                <template v-if="mongoUriActive">
                  <div class="connection-row align-start"><label for="mongo-uri">{{ t('MongoDB URI（优先于主机设置）') }}</label><div class="password-input"><input id="mongo-uri" v-model.trim="config.uri" :type="revealUri ? 'text' : 'password'" autocomplete="new-password" spellcheck="false" :placeholder="props.draft?.secretFields.includes('uri') ? t('已保存 URI · 留空保留') : t('mongodb:// 或 mongodb+srv://')" /><button type="button" class="btn secondary small" :aria-label="t(revealUri ? '隐藏密码' : '显示密码')" @click="revealUri = !revealUri">{{ t(revealUri ? '隐藏' : '显示') }}</button></div></div>
                  <p v-if="uriAddress" class="helper connection-indent uri-address"><strong>{{ t('连接地址') }}：</strong> <bdi>{{ uriAddress }}</bdi></p>
                  <p class="helper connection-indent">{{ t('URI 中的认证与拓扑设置优先；SSH、TLS 和代理仍可单独设置。') }}</p>
                </template>
                <label v-else class="connection-row"><span>{{ t('连接拓扑') }}</span><select v-model="config.mongoTopology"><option value="auto">{{ t('自动（单地址直连，副本集自动发现）') }}</option><option value="direct">{{ t('直连指定节点') }}</option><option value="discover">{{ t('副本集 / 分片集群（自动发现）') }}</option></select></label>
              </template>
              <label v-if="config.kind === 'redis'" class="connection-row"><span>{{ t('Redis 拓扑') }}</span><select v-model="config.redisMode" @change="changeRedisMode"><option value="standalone">{{ t('单机') }}</option><option value="cluster">{{ t('集群') }}</option><option value="sentinel">Sentinel</option></select></label>
              <template v-if="!mongoUriActive && config.kind!=='sqlite'">
                <p v-if="config.kind==='clickhouse'" class="helper connection-indent">HTTP 8123 / HTTPS 8443</p>
                <template v-if="!usesSeeds">
                  <label class="connection-row"><span>{{ t('主机') }}</span><input v-model.trim="config.host" placeholder="127.0.0.1" spellcheck="false" /></label>
                  <label class="connection-row"><span>{{ t('端口') }}</span><input v-model.number="config.port" class="connection-port" type="number" min="1" max="65535" /></label>
                </template>
                <template v-if="showSeedEditor">
                  <div class="connection-row align-start"><span>{{ config.kind === 'redis' && config.redisMode === 'sentinel' ? t('Sentinel 节点') : t('种子节点') }}</span><div class="connection-seeds"><div v-for="(node, index) in config.nodes" :key="index" class="node-row"><input v-model.trim="node.host" :aria-label="t('节点 {0} 主机', [index + 1])" placeholder="node.example.com" spellcheck="false" /><input v-model.number="node.port" :aria-label="t('节点 {0} 端口', [index + 1])" type="number" min="1" max="65535" /><button class="btn danger-text small" type="button" @click="config.nodes!.splice(index, 1)">{{ t('移除') }}</button></div><button class="btn secondary small" type="button" :disabled="config.nodes!.length >= 20 || (config.kind === 'mongodb' && config.mongoTopology === 'direct' && config.nodes!.length >= 1)" @click="addSeed">{{ t('＋ 添加节点') }}</button></div></div>
                  <p v-if="usesSeeds" class="helper connection-indent">{{ t('使用种子节点连接，不再使用单独的主机和端口。') }}</p>
                </template>
                <label v-if="config.kind === 'mongodb' && (config.mongoTopology === 'discover' || config.mongoReplicaSet)" class="connection-row"><span>{{ t('Replica Set 名称') }}</span><input v-model.trim="config.mongoReplicaSet" :placeholder="t('例如 rs0')" /></label>
                <label v-if="config.kind === 'redis' && config.redisMode === 'sentinel'" class="connection-row"><span>{{ t('Master 名称') }}</span><input v-model.trim="config.sentinelMaster" placeholder="mymaster" /></label>
                <div class="connection-field-divider"></div>
                <label v-if="!isMysqlFamily(config.kind)" class="connection-row"><span>{{ t('认证方式') }}</span><select v-model="authMode"><option value="none">{{ t('无认证') }}</option><option value="password">{{ t('密码认证') }}</option></select></label>
                <template v-if="isMysqlFamily(config.kind) || authMode === 'password'">
                  <label v-if="config.kind === 'mongodb'" class="connection-row"><span>{{ t('认证库 (authSource)') }}</span><input v-model.trim="config.authSource" placeholder="admin" /></label>
                  <label class="connection-row"><span>{{ t('用户名') }}</span><input v-model.trim="config.username" autocomplete="off" :placeholder="config.kind === 'redis' ? t('可留空') : ''" /></label>
                  <div class="connection-row"><label for="db-password">{{ t('密码') }}</label><div class="password-input"><input id="db-password" v-model="config.password" :type="revealPassword ? 'text' : 'password'" autocomplete="new-password" :placeholder="props.draft?.secretFields.includes('password') ? t('已保存 · 留空保留') : t('可留空')" /><button class="btn secondary small" type="button" :aria-label="t(revealPassword ? '隐藏密码' : '显示密码')" @click="revealPassword = !revealPassword">{{ t(revealPassword ? '隐藏' : '显示') }}</button></div></div>
                </template>
                <template v-if="config.kind === 'redis' && config.redisMode === 'sentinel'">
                  <div class="connection-field-divider"></div>
                  <label class="connection-row"><span>{{ t('Sentinel 用户名') }}</span><input v-model.trim="config.sentinelUsername" :placeholder="t('可留空')" /></label>
                  <label class="connection-row"><span>{{ t('Sentinel 密码') }}</span><input v-model="config.sentinelPassword" type="password" autocomplete="new-password" :placeholder="props.draft?.secretFields.includes('sentinelPassword') ? t('已保存 · 留空保留') : t('可留空')" /></label>
                  <label class="checkbox-row connection-indent"><input v-model="config.sentinelTls" type="checkbox" /> {{ t('Sentinel 使用 TLS') }}</label>
                </template>
              </template>
              <p v-if="mongoUriActive || isMysqlFamily(config.kind) || authMode === 'password'" class="helper connection-indent">{{ t('密码自动加密保存') }}</p>
              <p v-if="config.kind === 'mongodb' && !mongoUriActive" class="helper connection-indent">{{ t('使用单个主机、无 Replica Set 名称时，“自动”将直连指定地址，适合公网端口映射；填写 Replica Set 名称或多个种子节点则自动发现。使用 URI 时保留 URI 的拓扑设置。SRV 查询使用本机 DNS。需要自动故障转移时请选择副本集发现，成员地址需可达。') }}</p>
            </div>
          </template>
          <template v-else-if="page === 'ssh'">
            <div class="field-wide row-between"><label class="checkbox-row"><input v-model="config.ssh.enabled" type="checkbox" /> {{ t('启用 SSH 隧道') }}</label><button class="btn secondary small" type="button" :disabled="busy" @click="importSsh">{{ t('导入 SSH config') }}</button></div>
            <template v-if="sshImport"><label class="field field-wide">{{ t('导入主机') }}<select v-model="importedAlias" @change="applySshAlias"><option value="">{{ t('选择主机别名') }}</option><option v-for="host in sshImport.hosts" :key="host.name">{{ host.name }}</option></select></label><p v-for="warning in sshImport.warnings" :key="warning" class="inline-message warning field-wide">{{ localize(warning) }}</p></template>
            <template v-if="config.ssh.enabled"><p class="helper field-wide">{{ t('连接顺序：代理（若启用）→ 前置跳板机 → 最终 SSH 服务器 → 数据库。每一级主机都需要独立核验指纹。') }}</p><section v-for="(hop, index) in config.ssh.jumps" :key="index" class="ssh-hop field-wide"><div class="row-between"><h3>{{ t('前置跳板机') }} {{ index + 1 }}</h3><button class="btn danger-text small" type="button" @click="config.ssh.jumps!.splice(index, 1)">{{ t('移除') }}</button></div><SshHostFields v-model="config.ssh.jumps![index]" :label="t('跳板机 {0} 主机', [index + 1])" /></section><button class="btn secondary field-wide" type="button" :disabled="(config.ssh.jumps?.length || 0) >= 3" @click="config.ssh.jumps!.push(newSshHost())">{{ t('＋ 添加前置跳板机（最多 3 级）') }}</button><section class="ssh-hop field-wide"><h3>{{ t('最终 SSH 服务器') }}</h3><SshHostFields v-model="config.ssh" /></section></template>
          </template>
          <template v-else-if="page === 'tls'">
            <label class="checkbox-row field-wide"><input v-model="config.tls.enabled" type="checkbox" /> {{ t('启用 TLS / SSL') }}</label><template v-if="config.tls.enabled || config.sentinelTls"><FilePathField v-model="config.tls.caPath" class="field-wide" label="CA 证书路径" kind="certificate" :placeholder="t('留空使用系统信任的 CA')" /><FilePathField v-model="config.tls.certPath" class="field-wide" label="客户端证书 PEM 路径" kind="certificate" placeholder="/path/to/client.pem" /><FilePathField v-model="config.tls.keyPath" class="field-wide" label="客户端私钥路径" kind="private-key" placeholder="/path/to/client-key.pem" /><label class="field field-wide">{{ t('证书主机名 / SNI') }}<input v-model.trim="config.tls.servername" :placeholder="t('默认验证真实数据库主机名')" /></label><p class="helper field-wide">{{ t('启用 TLS 时校验证书与主机名；客户端证书与私钥须配对。CA 与客户端证书设置也用于已启用 TLS 的 Sentinel。集群节点需使用匹配各节点主机名的证书。') }}</p></template>
          </template>
          <template v-else-if="page === 'proxy'">
            <label class="checkbox-row field-wide"><input v-model="config.proxy!.enabled" type="checkbox" /> {{ t('启用网络代理') }}</label><template v-if="config.proxy!.enabled"><label class="field">{{ t('代理协议') }}<select v-model="config.proxy!.type"><option value="socks5">SOCKS5</option><option value="http-connect">HTTP CONNECT</option></select></label><label class="field">{{ t('代理主机') }}<input v-model.trim="config.proxy!.host" /></label><label class="field">{{ t('代理端口') }}<input v-model.number="config.proxy!.port" type="number" min="1" max="65535" /></label><label class="field">{{ t('用户名') }}<input v-model="config.proxy!.username" autocomplete="off" /></label><label class="field field-wide">{{ t('密码') }}<input v-model="config.proxy!.password" type="password" autocomplete="new-password" :placeholder="t('已保存的凭据留空保留')" /></label><p class="helper field-wide">{{ t('代理会承载数据库连接；同时启用 SSH 时，代理用于到达第一级 SSH 服务器。') }}</p></template>
          </template>
          <template v-else>
            <label v-if="config.kind!=='sqlite'" class="field">{{ t('连接超时（毫秒）') }}<input v-model.number="config.connectTimeoutMs" type="number" min="1000" max="60000" /></label>
            <label v-if="config.kind !== 'redis' && config.kind!=='sqlite' && !mongoUriActive" class="field field-wide">{{ t('默认数据库') }}<input v-model.trim="config.database" :placeholder="t('可留空')" /></label>
            <label v-if="config.kind === 'redis'" class="field">Redis DB<input v-model.number="config.redisDb" type="number" min="0" max="1023" :disabled="config.redisMode === 'cluster'" /></label>
            <p v-if="config.kind === 'redis' && config.redisMode === 'cluster'" class="helper field-wide">{{ t('Cluster 使用 DB 0；Key 扫描按主节点进行，可在浏览器中切换节点。') }}</p>
            <label class="field field-wide">{{ t('分组名称') }}<input v-model.trim="config.group" maxlength="80" :placeholder="t('可留空')" /></label>
            <div class="field field-wide"><span>{{ t('连接颜色') }}</span><ConnectionColorPicker v-model="config.color" :disabled="busy" /></div>
            <section v-if="savedFields.length" class="secret-settings field-wide"><strong>{{ t('已保存的凭据') }}</strong><p class="compact-help">{{ t('凭据不会回传到界面。输入新值可替换，留空保留；勾选下方项目会在测试与保存时使用清除后的配置。') }}</p><label v-for="path in savedFields" :key="path" class="checkbox-row"><input type="checkbox" :checked="clearSecrets.includes(path)" @change="toggleClear(path)" /> {{ t('清除') }} {{ secretLabel(path) }}</label></section>
          </template>
        </div>
        <footer class="dialog-footer connection-dialog-footer"><button v-if="!props.draft && !config.id" class="btn secondary" type="button" :disabled="busy" @click="back">{{ t('返回') }}</button><button class="btn secondary" type="button" :disabled="busy" @click="test">{{ busy ? t('处理中…') : t('测试连接') }}</button><span class="toolbar-spacer"></span><button class="btn secondary" type="button" :disabled="busy" @click="emit('close')">{{ t('取消') }}</button><button v-if="!props.draft" class="btn secondary" type="button" :disabled="busy" @click="temporary">{{ t('临时连接') }}</button><button class="btn secondary" type="submit" :disabled="busy || !config.name.trim()">{{ t('保存') }}</button><button class="btn primary" type="button" :disabled="busy || !config.name.trim()" @click="save(true)">{{ t('保存并连接') }}</button></footer>
      </form>
    </section>
  </div>
</template>
