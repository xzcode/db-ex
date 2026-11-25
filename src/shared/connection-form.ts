import { isMysqlFamily } from './relational-capabilities'
import type { ConnectionConfig, ConnectionDraft, DatabaseKind, Endpoint, SshOptions } from './types'

export type EntryMode = 'fields' | 'uri'
export type DatabaseAuthMode = 'none' | 'password'
export const defaultPorts: Record<DatabaseKind, number> = { mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379, sqlite: 0 }
export const databaseNames: Record<DatabaseKind, string> = { mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', redis: 'Redis', sqlite: 'SQLite' }

export function newSshHost(): SshOptions {
  return { enabled: true, host: '', port: 22, username: '', authMode: 'password', password: '', privateKeyPath: '', passphrase: '', agentSocket: '', hostFingerprint: '', jumps: [] }
}
export function newConnectionConfig(kind: DatabaseKind): ConnectionConfig {
  return {
    name: '', kind, host: '127.0.0.1', port: defaultPorts[kind],
    username: isMysqlFamily(kind) ? 'root' : '', password: '', database: '', filePath: '', authSource: 'admin', redisDb: 0, uri: '',
    ssh: { ...newSshHost(), enabled: false }, tls: { enabled: false, caPath: '', certPath: '', keyPath: '', servername: '' },
    proxy: { enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '' },
    redisMode: 'standalone', nodes: [], mongoReplicaSet: '', mongoDirect: false, mongoTopology: 'auto', connectTimeoutMs: 12000,
  }
}
export function initialEntry(draft?: ConnectionDraft): EntryMode {
  return draft?.config.kind === 'mongodb' && (draft.config.uri || draft.secretFields.includes('uri')) ? 'uri' : 'fields'
}
export function initialAuth(config: ConnectionConfig, draft?: ConnectionDraft): DatabaseAuthMode {
  return isMysqlFamily(config.kind) || config.username || config.password || draft?.secretFields.includes('password') ? 'password' : 'none'
}
function uriAuthority(uri: string): string | undefined {
  const authority = /^mongodb(?:\+srv)?:\/\/([^/?#\s]+)(?:[/?][^\r\n]*)?$/i.exec(uri.trim())?.[1]
  return authority?.slice(authority.lastIndexOf('@') + 1) || undefined
}
/** Preview only a strictly recognized endpoint, never a URI or userinfo. */
export function mongoUriAddress(uri: string): string | undefined {
  const address = uriAuthority(uri)
  if (!address || !address.split(',').every(host => /^(?:\[[a-f0-9:.]+\]|[a-z0-9_.-]+)(?::\d{1,5})?$/i.test(host))) return undefined
  return address
}
/** The actual displayed target follows driver routing, not an inactive host field. */
export function connectionDisplayEndpoint(config: ConnectionConfig): Endpoint {
  if (config.kind === 'sqlite') return {host:config.filePath||'SQLite',port:0}
  if (config.kind === 'mongodb' && config.uri) return { host: 'MongoDB URI', port: config.port }
  if ((config.kind === 'mongodb' || (config.kind === 'redis' && config.redisMode !== 'standalone')) && config.nodes?.length) return config.nodes[0]!
  return { host: config.host || 'MongoDB URI', port: config.port }
}
interface FormOptions { entry: EntryMode; auth: DatabaseAuthMode; draft?: ConnectionDraft; clearSecrets?: string[]; allowUnnamed?: boolean }
/** Normalize only active form inputs. Do not reattach credentials to another endpoint. */
export function prepareConnection(config: ConnectionConfig, options: FormOptions): { config: ConnectionConfig; clearSecrets: string[] } {
  // Vue reactive proxies cannot be structuredClone'd; the form is plain JSON data.
  const value = JSON.parse(JSON.stringify(config)) as ConnectionConfig
  const clear = new Set(options.clearSecrets || [])
  value.name = value.name.trim()
  if (!value.name) {
    if (!options.allowUnnamed) throw new Error('INVALID_CONNECTION: 请填写连接名称')
    value.name = databaseNames[value.kind]
  }
  if(value.kind==='sqlite'){
    if(!value.filePath?.trim())throw new Error('INVALID_CONNECTION: SQLite')
    return {config:{...newConnectionConfig('sqlite'),id:value.id,name:value.name,filePath:value.filePath.trim(),group:value.group,color:value.color},clearSecrets:[...clear]}
  }
  if (value.kind === 'mongodb' && options.entry === 'uri') {
    value.uri = value.uri?.trim() || ''
    const retain = !value.uri && options.draft?.secretFields.includes('uri') && !clear.has('uri')
    if (!value.uri && !retain) throw new Error('请输入 MongoDB URI')
    if (value.uri && !uriAuthority(value.uri)) throw new Error('MONGO_URI_INVALID: MongoDB URI 格式无效。请使用 mongodb:// 或 mongodb+srv://，并对用户名、密码中的特殊字符做 URL 编码。')
    if (retain && options.draft) {
      // Existing URI is never returned to the renderer. Keep its original
      // identity fields so the main-process credential merge can retain it.
      const old = options.draft.config
      Object.assign(value, { host: old.host, port: old.port, username: old.username, database: old.database,
        authSource: old.authSource, nodes: old.nodes, mongoReplicaSet: old.mongoReplicaSet,
        mongoTopology: old.mongoTopology, mongoDirect: old.mongoDirect })
    } else {
      Object.assign(value, { host: '', port: 27017, username: '', password: '', database: '', filePath: '', authSource: '',
        nodes: [], mongoReplicaSet: '', mongoDirect: false, mongoTopology: 'auto' })
    }
    // Field credentials are not used by URI connections.
    value.password = ''
    clear.add('password')
    clear.delete('uri')
    return { config: value, clearSecrets: [...clear] }
  }
  if (value.kind === 'mongodb') {
    value.uri = ''
    clear.add('uri')
    if (options.auth === 'password' && !value.username?.trim()) throw new Error('INVALID_CONNECTION: 请填写数据库用户名')
  }
  if (!isMysqlFamily(value.kind) && options.auth === 'none') {
    value.username = ''; value.password = ''
    clear.add('password')
  }
  if (value.kind === 'redis') {
    if (value.redisMode === 'cluster') value.redisDb = 0
    if (value.redisMode !== 'sentinel') {
      value.sentinelMaster = ''; value.sentinelUsername = ''; value.sentinelPassword = ''; value.sentinelTls = false
      clear.add('sentinelPassword')
    }
  }
  // A valid primary host is needed for old store validation. For new
  // multi-node profiles use the first configured seed as the visible target.
  if (value.nodes?.length && (value.kind === 'mongodb' || (value.kind === 'redis' && value.redisMode !== 'standalone')) && (!value.id || !value.host)) {
    value.host = value.nodes[0]!.host; value.port = value.nodes[0]!.port
  }
  return { config: value, clearSecrets: [...clear] }
}
