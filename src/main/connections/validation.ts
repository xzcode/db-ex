import { isMysqlFamily } from '../../shared/relational-capabilities'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { normalizeAppearance } from '../../shared/connection-appearance'
import type { ConnectionConfig, Endpoint, ProxyOptions, SshOptions, TlsOptions } from '../../shared/types'

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`INVALID_CONNECTION: ${label}格式错误`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 512, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`INVALID_CONNECTION: 请填写${label}`)
    return undefined
  }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`INVALID_CONNECTION: ${label}格式错误`)
  return value
}
function bool(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`INVALID_CONNECTION: ${label}必须是布尔值`)
  return value
}
function integer(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`INVALID_CONNECTION: ${label}必须在 ${min}–${max} 之间`)
  return value as number
}
function endpoint(value: unknown): Endpoint {
  const v = object(value, '节点')
  const host = text(v.host, '主机', 253, true)!
  if (/[\s/@?#\\]/.test(host)) throw new Error('INVALID_CONNECTION: 主机只填写 DNS 名称或 IP 地址')
  return { host, port: integer(v.port, '端口', 1, 65535) }
}
function ssh(value: unknown, nested = false, allowMissingSecrets = false): SshOptions {
  const v = object(value, 'SSH')
  const enabled = bool(v.enabled, 'SSH')
  if (!enabled) return { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }
  const target = endpoint(v)
  const username = text(v.username, 'SSH 用户名', 256, true)!
  if (!['password', 'private-key', 'agent'].includes(String(v.authMode))) throw new Error('INVALID_CONNECTION: SSH 认证方式错误')
  const password = text(v.password, 'SSH 密码', 8192)
  const privateKeyPath = text(v.privateKeyPath, 'SSH 私钥路径', 4096)
  if (v.authMode === 'password' && password === undefined && !allowMissingSecrets) throw new Error('INVALID_CONNECTION: 请填写 SSH 密码')
  if (v.authMode === 'private-key' && !privateKeyPath) throw new Error('INVALID_CONNECTION: 请填写私钥路径')
  const fingerprint = text(v.hostFingerprint, 'SSH 指纹', 64)
  if (fingerprint && !/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('INVALID_CONNECTION: SSH 指纹应为64位 SHA-256 十六进制')
  let jumps: SshOptions[] | undefined
  if (v.jumps !== undefined) {
    if (!Array.isArray(v.jumps) || v.jumps.length > 3 || (nested && v.jumps.length)) throw new Error('INVALID_CONNECTION: 最多支持三个前置跳板，不能嵌套跳板')
    jumps = v.jumps.map(j => {
      const result = ssh(j, true, allowMissingSecrets)
      if (!result.enabled) throw new Error('INVALID_CONNECTION: 前置跳板必须启用')
      return result
    })
  }
  return { enabled, ...target, username, authMode: v.authMode as SshOptions['authMode'], password, privateKeyPath,
    passphrase: text(v.passphrase, '私钥密码', 8192), agentSocket: text(v.agentSocket, 'Agent 路径', 4096),
    hostFingerprint: fingerprint?.toLowerCase(), jumps }
}
function tls(value: unknown): TlsOptions {
  const v = object(value, 'TLS')
  const enabled = bool(v.enabled, 'TLS')
  const caPath = text(v.caPath, 'CA 路径', 4096)
  const certPath = text(v.certPath, '客户端证书', 4096)
  const keyPath = text(v.keyPath, '客户端密钥', 4096)
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('INVALID_CONNECTION: 客户端证书与私钥必须同时配置')
  const servername = text(v.servername, 'TLS 服务器名称', 253)
  if (servername && /[\s/@?#\\]/.test(servername)) throw new Error('INVALID_CONNECTION: TLS 服务器名称无效')
  return { enabled, caPath, certPath, keyPath, servername }
}
function proxy(value: unknown): ProxyOptions | undefined {
  if (value === undefined) return undefined
  const v = object(value, '代理')
  const enabled = bool(v.enabled, '代理')
  if (!enabled) return { enabled: false, type: 'socks5', host: '', port: 1080 }
  if (!['socks5', 'http-connect'].includes(String(v.type))) throw new Error('INVALID_CONNECTION: 不支持此代理类型')
  return { enabled, type: v.type as ProxyOptions['type'], ...endpoint(v), username: text(v.username, '代理用户名', 255), password: text(v.password, '代理密码', 255) }
}
export function validateConnection(value: unknown, allowMissingSecrets = false): ConnectionConfig {
  const v = object(value, '连接')
  const name = text(v.name, '连接名称', 100, true)!
  if (!['mysql', 'mongodb', 'redis', 'sqlite','mariadb'].includes(String(v.kind))) throw new Error('INVALID_CONNECTION: 数据库类型错误')
  // Legacy profiles may contain an environment field; it is no longer used.
  const kind = v.kind as ConnectionConfig['kind']
  if(kind==='sqlite'){
    const filePath=text(v.filePath,'SQLite',4096,true)!
    if(!isAbsolute(filePath)||/[\u0000-\u001f]/.test(filePath))throw new Error('INVALID_CONNECTION: SQLite')
    return {id:text(v.id,'连接 ID',128),name,kind,host:'',port:0,filePath,...normalizeAppearance(v),ssh:{enabled:false,host:'',port:22,username:'',authMode:'password'},tls:{enabled:false},connectTimeoutMs:12000}
  }
  const uri = text(v.uri, 'MongoDB URI', 8192)
  if (uri) {
    if (kind !== 'mongodb' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) throw new Error('INVALID_CONNECTION: URI 仅支持 mongodb:// 或 mongodb+srv://')
    const query = new URLSearchParams(uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '')
    for (const [key, val] of query) {
      const k = key.toLowerCase()
      if ((['tlsinsecure', 'tlsallowinvalidcertificates', 'tlsallowinvalidhostnames'].includes(k) && val.toLowerCase() !== 'false') || k.startsWith('proxy')) throw new Error('INVALID_CONNECTION: URI 不允许跳过 TLS 校验或覆盖代理配置')
      if (['tlscafile', 'tlscertificatekeyfile', 'tlscrlfile'].includes(k)) throw new Error('INVALID_CONNECTION: 请在 TLS 页配置证书路径')
      if (v.tls && (v.tls as TlsOptions).enabled && ['ssl', 'tls'].includes(k) && val.toLowerCase() === 'false') throw new Error('INVALID_CONNECTION: URI 与 TLS 配置冲突')
    }
  }
  // ConnectionDialog keeps inactive per-engine form state when users switch DB types.
  // Ignore Mongo topology inputs for MySQL/Redis instead of rejecting those profiles.
  const mongoTopology = kind !== 'mongodb' || v.mongoTopology === undefined ? undefined : text(v.mongoTopology, 'MongoDB 拓扑模式', 16)
  if (mongoTopology && !['auto', 'direct', 'discover'].includes(mongoTopology)) throw new Error('INVALID_CONNECTION: MongoDB 拓扑模式只能是自动、直连或副本集发现')
  if (uri && mongoTopology && mongoTopology !== 'auto') {
    const options = new URLSearchParams(uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '')
    const queryDirect = options.get('directConnection')
    if ((mongoTopology === 'direct' && queryDirect?.toLowerCase() === 'false') ||
        (mongoTopology === 'discover' && queryDirect?.toLowerCase() === 'true')) {
      throw new Error('INVALID_CONNECTION: MongoDB URI 的 directConnection 与所选拓扑模式冲突')
    }
  }
  const target = uri && !v.host ? { host: '', port: integer(v.port, '端口', 1, 65535, 27017) } : endpoint(v)
  const redisMode = v.redisMode === undefined ? 'standalone' : v.redisMode
  if (!['standalone', 'sentinel', 'cluster'].includes(String(redisMode))) throw new Error('INVALID_CONNECTION: Redis 拓扑模式无效')
  let nodes: Endpoint[] | undefined
  if (v.nodes !== undefined) {
    if (!Array.isArray(v.nodes) || v.nodes.length > 20) throw new Error('INVALID_CONNECTION: 种子节点最多20个')
    nodes = v.nodes.map(endpoint)
  }
  const directRequested = mongoTopology === 'direct' || (!mongoTopology && v.mongoDirect === true)
  if (kind === 'mongodb' && directRequested && (nodes?.length || 0) > 1) {
    throw new Error('INVALID_CONNECTION: MongoDB 直连只能指定一个种子节点；请改用副本集发现模式')
  }
  if (kind === 'mongodb' && directRequested && uri) {
    if (/^mongodb\+srv:\/\//i.test(uri)) throw new Error('INVALID_CONNECTION: SRV URI 不支持 MongoDB 直连模式')
    const authority = uri.replace(/^mongodb:\/\//i, '').split('/')[0]!.split('@').pop()!
    if (authority.includes(',')) throw new Error('INVALID_CONNECTION: 多节点 MongoDB URI 不支持直连；请改用副本集发现模式')
  }
  if (kind === 'redis' && redisMode !== 'standalone' && !nodes?.length) throw new Error('INVALID_CONNECTION: 集群或 Sentinel 至少需要一个种子节点')
  const redisDb = integer(v.redisDb, 'Redis DB', 0, 1023, 0)
  if (kind === 'redis' && redisMode === 'cluster' && redisDb !== 0) throw new Error('INVALID_CONNECTION: Redis Cluster 只能使用 DB 0')
  const sentinelMaster = text(v.sentinelMaster, 'Sentinel master 名称', 128)
  if (kind === 'redis' && redisMode === 'sentinel' && !sentinelMaster) throw new Error('INVALID_CONNECTION: 请填写 Sentinel master 名称')
  const id = text(v.id, '连接 ID', 128)
  const tlsOptions = tls(v.tls)
  if (!allowMissingSecrets && isMysqlFamily(kind) && tlsOptions.enabled && isIP(tlsOptions.servername || target.host)) {
    throw new Error('TLS_IDENTITY_REQUIRED: MySQL TLS 连接请填写证书中的 DNS 名称（TLS / SSL → 证书主机名）；当前驱动不支持可靠校验仅有 IP 身份的证书')
  }
  return { id, name, kind, ...target, ...normalizeAppearance(v),
    username: text(v.username, '数据库用户名', 512), password: text(v.password, '数据库密码', 8192),
    database: text(v.database, '数据库名称', 200), authSource: text(v.authSource, '认证数据库', 200), redisDb, uri,
    ssh: ssh(v.ssh, false, allowMissingSecrets), tls: tlsOptions, proxy: proxy(v.proxy), redisMode: redisMode as ConnectionConfig['redisMode'], nodes,
    sentinelMaster, sentinelUsername: text(v.sentinelUsername, 'Sentinel 用户名', 512), sentinelPassword: text(v.sentinelPassword, 'Sentinel 密码', 8192),
    sentinelTls: bool(v.sentinelTls, 'Sentinel TLS'), mongoReplicaSet: text(v.mongoReplicaSet, '副本集名称', 200), mongoDirect: bool(v.mongoDirect, 'MongoDB 直连'), mongoTopology: mongoTopology as ConnectionConfig['mongoTopology'],
    connectTimeoutMs: integer(v.connectTimeoutMs, '连接超时毫秒', 1000, 60000, 12000) }
}
export function validateId(value: unknown): asserts value is string { text(value, 'ID', 128, true) }
