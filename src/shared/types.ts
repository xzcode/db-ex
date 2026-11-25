import type { BsonTypeBranch } from './bson-types'
import type { BrowseFilter } from './browse-filter'
import type { ObjectInspection } from './object-inspection'

export type DatabaseKind = 'mysql' | 'mongodb' | 'redis'
export type SqlValue = string | number | boolean | null
export type SqlRow = Record<string, SqlValue>

export interface SshOptions {
  enabled: boolean
  host: string
  port: number
  username: string
  authMode: 'password' | 'private-key' | 'agent'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  agentSocket?: string
  /** SHA-256 of the host public key, 64 lowercase hexadecimal characters. */
  hostFingerprint?: string
  /** Ordered jump hosts preceding this final SSH server. Maximum three. */
  jumps?: SshOptions[]
}
export interface ProxyOptions {
  enabled: boolean
  type: 'socks5' | 'http-connect'
  host: string
  port: number
  username?: string
  password?: string
}
export interface TlsOptions {
  enabled: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
  servername?: string
}
export interface Endpoint { host: string; port: number }
export interface ConnectionAppearance { color?: string; group?: string }
export interface ConnectionAppearancePatch { color?: string | null; group?: string | null }
export interface ConnectionConfig extends ConnectionAppearance {
  id?: string
  name: string
  kind: DatabaseKind
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  authSource?: string
  redisDb?: number
  uri?: string
  ssh: SshOptions
  tls: TlsOptions
  proxy?: ProxyOptions
  redisMode?: 'standalone' | 'sentinel' | 'cluster'
  nodes?: Endpoint[]
  sentinelMaster?: string
  sentinelUsername?: string
  sentinelPassword?: string
  sentinelTls?: boolean
  mongoReplicaSet?: string
  mongoDirect?: boolean
  /** auto: direct for one field-based endpoint, discovery for replica/URI */
  mongoTopology?: 'auto' | 'direct' | 'discover'
  connectTimeoutMs?: number
}
export interface SavedConnection extends ConnectionAppearance {
  id: string
  name: string
  kind: DatabaseKind
  locked?: boolean
  host: string
  port: number
  sshEnabled: boolean
  tlsEnabled: boolean
  proxyEnabled?: boolean
}
export interface ConnectionDraft { config: ConnectionConfig; secretFields: string[] }
export interface SessionInfo {
  id: string
  connectionId?: string
  name: string
  kind: DatabaseKind
  displayHost: string
  writable: boolean
  transaction: boolean
}
import type { MongoCategory } from './mongo-catalog'

export interface ExplorerNode {
  id: string
  label: string
  kind: 'database' | 'table' | 'collection' | 'keyspace' | 'view' | 'mongo-category' | 'mongo-function' | 'mongo-indexes' | 'gridfs-bucket' | 'database-query'
  category?: MongoCategory
  readOnly?: boolean
  database?: string
  entity?: string
}
export interface DataPreview {
  columns: string[]
  rows: Record<string, string>[]
  nextOffset?: number
  nextCursor?: string
  value?: string
}
export interface OperationResult extends DataPreview {
  inspection?: ObjectInspection
  totalRows?: string
  countLimited?: boolean
  columnTypes?: string[]
  nullCells?: number[][]
  redisRowTypes?: string[]
  redisType?: string
  ttl?: number
  length?: number
  rawRows?: SqlRow[]
  documents?: string[]
  /** Per-document metadata aligned with rows and canonical Extended JSON. */
  bsonTypes?: BsonTypeBranch[]
  affectedRows?: number
  durationMs?: number
  truncated?: boolean
  message?: string
  transaction?: boolean
  disconnected?: boolean
  primaryKeys?: string[]
}
interface Confirmed { confirmed?: boolean }
interface Entity { database: string; entity: string }
export type MysqlOperation =
  | ({ action: 'mysql.query'; database?: string; sql: string; parameters?: SqlValue[]; limit?: number; offset?: number } & Confirmed)
  | ({ action: 'mysql.structure' | 'mysql.inspect' } & Entity)
  | ({ action: 'mysql.createDatabase' | 'mysql.dropDatabase'; database: string } & Confirmed)
  | ({ action: 'mysql.browse'; filter: BrowseFilter; countOnly?: boolean; limit?: number; offset?: number } & Entity)
  | ({ action: 'mysql.insert'; values: SqlRow } & Entity & Confirmed)
  | ({ action: 'mysql.update'; key: SqlRow; original: SqlRow; changes: SqlRow } & Entity & Confirmed)
  | ({ action: 'mysql.delete'; key: SqlRow; original: SqlRow } & Entity & Confirmed)
  | ({ action: 'mysql.import'; rows: SqlRow[] } & Entity & Confirmed)
  | ({ action: 'mysql.begin' | 'mysql.commit' | 'mysql.rollback' } & Confirmed)
export type MongoOperation =
  | ({ action: 'mongo.createDatabase'; database: string; initialCollection: string } & Confirmed)
  | ({ action: 'mongo.dropDatabase'; database: string } & Confirmed)
  | ({ action: 'mongo.find'; filter?: string; projection?: string; sort?: string; offset?: number; limit?: number } & Entity)
  | ({ action: 'mongo.count'; filter?: string } & Entity)
  | ({ action: 'mongo.aggregate'; pipeline: string; limit?: number } & Entity)
  | ({ action: 'mongo.insert'; documents: string[] } & Entity & Confirmed)
  | ({ action: 'mongo.replace'; original: string; document: string } & Entity & Confirmed)
  | ({ action: 'mongo.delete'; original: string } & Entity & Confirmed)
  | ({ action: 'mongo.indexes' | 'mongo.inspect' } & Entity)
  | ({ action: 'mongo.createIndex'; keys: string; options?: string } & Entity & Confirmed)
  | ({ action: 'mongo.dropIndex'; name: string } & Entity & Confirmed)
export type RedisValueType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
export type RedisOperation =
  | { action: 'redis.scan'; cursor?: string; pattern?: string; node?: string }
  | { action: 'redis.get'; key: string; cursor?: string; offset?: number }
  | { action: 'redis.inspect'; key: string }
  | ({ action: 'redis.set'; key: string; value: string; ttl?: number; expected?: string } & Confirmed)
  | ({ action: 'redis.mutate'; key: string; type: RedisValueType; command: string; args: string[] } & Confirmed)
  | ({ action: 'redis.ttl'; key: string; ttl: number } & Confirmed)
  | ({ action: 'redis.delete'; keys: string[] } & Confirmed)
  | ({ action: 'redis.command'; args: string[] } & Confirmed)
  | { action: 'redis.nodes' }
export type DatabaseOperation = MysqlOperation | MongoOperation | RedisOperation
export interface QuerySnippet {
  /** Optional fields keep existing encrypted history files compatible. */
  mongoKind?: 'query' | 'aggregation'
  entity?: string
  connectionId?: string
  id: string
  name: string
  kind: DatabaseKind
  database?: string
  text: string
  favorite: boolean
  updatedAt: string
}
export interface FileImport { name: string; text: string; format: 'csv' | 'json' | 'text' }
export interface SshImportResult { hosts: { name: string; ssh: SshOptions }[]; warnings: string[] }
export type ConnectionFileKind = 'certificate' | 'private-key'
export interface DbExAPI {
  getNativePreferences():Promise<import('./preferences').NativePreferences>
  saveNativePreferences(value:import('./preferences').NativePreferences):Promise<import('./preferences').NativePreferences>
  pickTool(name:import('./preferences').ToolName):Promise<string|null>
  checkTool(name:import('./preferences').ToolName,path:string):Promise<boolean>
  logPath():Promise<string>
  openLogs():Promise<void>
  saveRecovery(value:import('./preferences').RecoveryDraft):Promise<void>
  loadRecovery(value:import('./preferences').RecoveryDraft):Promise<import('./preferences').RecoveryDraft|null>
  clearRecovery():Promise<void>
  pickConnectionFile(kind: ConnectionFileKind): Promise<string | null>
  getSystemLanguage(): Promise<string>
  setLocale(locale: import('./i18n').Locale): Promise<void>
  listConnections(): Promise<SavedConnection[]>
  updateConnectionAppearance(id: string, patch: ConnectionAppearancePatch): Promise<SavedConnection>
  saveConnection(config: ConnectionConfig, clearSecrets?: string[]): Promise<SavedConnection>
  editConnection(id: string): Promise<ConnectionDraft>
  deleteConnection(id: string): Promise<void>
  trustHostKey(id: string, fingerprint: string): Promise<void>
  connectSaved(id: string): Promise<SessionInfo>
  connectTemporary(config: ConnectionConfig, clearSecrets?: string[]): Promise<SessionInfo>
  testConnection(config: ConnectionConfig, clearSecrets?: string[]): Promise<string>
  disconnect(sessionId: string): Promise<void>
  roots(sessionId: string): Promise<ExplorerNode[]>
  children(sessionId: string, database: string, category?: MongoCategory): Promise<ExplorerNode[]>
  preview(sessionId: string, database: string, entity: string, offset?: number): Promise<DataPreview>
  redisKeys(sessionId: string, cursor?: string, pattern?: string): Promise<DataPreview>
  redisValue(sessionId: string, key: string): Promise<DataPreview>
  execute(sessionId: string, operation: DatabaseOperation): Promise<OperationResult>
  validateMongoDocument(document: string, original?: string): Promise<void>
  copyText(value: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  setWriteAccess(sessionId: string, enabled: boolean): Promise<SessionInfo>
  listSnippets(): Promise<QuerySnippet[]>
  saveSnippet(snippet: Omit<QuerySnippet, 'id' | 'updatedAt'> & { id?: string }): Promise<QuerySnippet>
  deleteSnippet(id: string): Promise<void>
  importFile(): Promise<FileImport | null>
  exportFile(name: string, content: string, format: 'csv' | 'json' | 'text'): Promise<boolean>
  importConnections(): Promise<number>
  exportConnections(id?: string): Promise<boolean>
  importSshConfig(): Promise<SshImportResult | null>
}

