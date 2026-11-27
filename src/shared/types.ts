import type { BsonTypeBranch } from './bson-types'
import type { BrowseFilter } from './browse-filter'
import type { ObjectInspection } from './object-inspection'

export type DatabaseKind = 'mysql' | 'mongodb' | 'redis' | 'sqlite' | 'mariadb' | 'clickhouse'
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
  filePath?: string
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
  serverVersion?: string
  writable: boolean
  transaction: boolean
}
import type { MongoCategory } from './mongo-catalog'

export interface ExplorerNode {
  id: string
  label: string
  kind: 'database' | 'table' | 'collection' | 'keyspace' | 'view' | 'mongo-category' | 'mongo-function' | 'mongo-indexes' | 'gridfs-bucket' | 'database-query' | 'query-folder' | 'saved-query' | 'clickhouse-dictionary'
  category?: MongoCategory
  queryId?:string
  draftId?:string
  queryRevision?:string
  queryMode?:import('./saved-query').QueryMode
  readOnly?: boolean
  maintenanceRestricted?:boolean
  objectType?: 'sequence' | 'system-versioned'
  metrics?: import('./object-inspection').ObjectMetric[]
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
  sqliteTypes?: string[][]
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
  gridBatch?:{total:number;completed:number;atomic:boolean;failed?:boolean;uncertain?:boolean;error?:string}
  queryId?:string
  backupId?:string
  durationMs?: number
  truncated?: boolean
  truncationReason?: 'page'|'bytes'|'document'
  queryReadOnly?:boolean
  message?: string
  transaction?: boolean
  disconnected?: boolean
  primaryKeys?: string[]
  objectCapabilities?: import('./relational-capabilities').RelationalObjectCapabilities
}
interface Confirmed { confirmed?: boolean }
interface Entity { database: string; entity: string }
export interface SqlGridEdit {key:SqlRow;original:SqlRow;changes:SqlRow}
export interface MongoGridEdit {original:string;document:string}
export type MysqlOperation =
  | ({action:'mariadb.object';view:'sequence'|'history'|'partitions';limit?:number;offset?:number} & Entity)
  | ({action:'mariadb.sequenceRestart';value:string} & Entity & Confirmed)
  | ({ action: 'mysql.query'; database?: string; sql: string; parameters?: SqlValue[]; limit?: number; offset?: number } & Confirmed)
  | ({ action: 'mysql.structure' | 'mysql.inspect' } & Entity)
  | ({ action: 'mysql.createDatabase' | 'mysql.dropDatabase'; database: string } & Confirmed)
  | ({ action: 'mysql.browse'; filter: BrowseFilter; countOnly?: boolean; limit?: number; offset?: number } & Entity)
  | ({ action: 'mysql.insert'; values: SqlRow } & Entity & Confirmed)
  | ({ action: 'mysql.update'; key: SqlRow; original: SqlRow; changes: SqlRow } & Entity & Confirmed)
  | ({action:'mysql.updateBatch';edits:SqlGridEdit[]} & Entity & Confirmed)
  | ({ action: 'mysql.delete'; key: SqlRow; original: SqlRow } & Entity & Confirmed)
  | ({ action: 'mysql.import'; rows: SqlRow[] } & Entity & Confirmed)
  | ({ action: 'mysql.begin' | 'mysql.commit' | 'mysql.rollback' } & Confirmed)
export interface MongoFindSettings {hint?:string;collation?:string;batchSize?:number;maxTimeMS?:number}
export type MongoScriptWriteMethod='updateOne'|'updateMany'|'replaceOne'|'deleteOne'|'deleteMany'|'findOneAndUpdate'|'findOneAndReplace'|'findOneAndDelete'
export type MongoOperation =
  | ({ action: 'mongo.createDatabase'; database: string; initialCollection: string } & Confirmed)
  | ({ action: 'mongo.dropDatabase'; database: string } & Confirmed)
  | ({ action: 'mongo.createCollection' | 'mongo.dropCollection' | 'mongo.clearCollection' } & Entity & Confirmed)
  | ({ action: 'mongo.renameCollection'; newName:string } & Entity & Confirmed)
  | ({ action: 'mongo.find'; filter?: string; projection?: string; sort?: string; offset?: number; limit?: number; settings?:MongoFindSettings } & Entity)
  | ({ action: 'mongo.count'; filter?: string } & Entity)
  | ({ action: 'mongo.estimateCount' } & Entity)
  | ({action:'mongo.scriptWrite';method:MongoScriptWriteMethod;filter:string;value?:string;options?:string} & Entity & Confirmed)
  | ({ action: 'mongo.aggregate'; pipeline: string; limit?: number } & Entity)
  | ({ action: 'mongo.insert'; documents: string[] } & Entity & Confirmed)
  | ({ action: 'mongo.replace'; original: string; document: string } & Entity & Confirmed)
  | ({action:'mongo.replaceBatch';edits:MongoGridEdit[]} & Entity & Confirmed)
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
export type ClickHouseManagementView = 'partitions' | 'mutations' | 'replicas' | 'queries' | 'topology' | 'replicationQueue'
export type ClickHouseChange =
  | {kind:'update';field:string;match:string;column:string;value:string;lightweight?:boolean}
  | {kind:'delete';field:string;match:string;lightweight?:boolean}
  | {kind:'killMutation';mutationId:string}
  | {kind:'dropPartition'|'detachPartition'|'attachPartition';partitionId:string}
  | {kind:'backup';disk:string;file:string}
  | {kind:'restore';disk:string;file:string;newTable:string}
export type ClickHouseTransferFormat='csv'|'jsonl'|'parquet'
export interface ClickHouseTransfer {database:string;entity:string;direction:'import'|'export';format:ClickHouseTransferFormat}
export type ClickHouseOperation =
  | ({action:'clickhouse.query';database?:string;sql:string;parameters?:Record<string,SqlValue>;limit?:number} & Confirmed)
  | ({action:'clickhouse.browse';limit?:number;offset?:number;sort?:import('./browse-filter').SortRule[];filter?:{field:string;value:string}} & Entity)
  | ({action:'clickhouse.structure'|'clickhouse.inspect'} & Entity)
  | ({action:'clickhouse.management';view:ClickHouseManagementView;limit?:number;offset?:number} & Entity)
  | ({action:'clickhouse.mutationPreview';change:Extract<ClickHouseChange,{kind:'update'|'delete'}>} & Entity)
  | ({action:'clickhouse.change';change:ClickHouseChange} & Entity & Confirmed)
  | ({action:'clickhouse.backupStatus';backupId:string} & Entity)
  | ({action:'clickhouse.insert';rows:SqlRow[]} & Entity & Confirmed)
export type DatabaseOperation = MysqlOperation | MongoOperation | RedisOperation | ClickHouseOperation
export interface QuerySnippet {
  /** Optional fields keep existing encrypted history files compatible. */
  mongoKind?: 'query' | 'aggregation' | 'script'
  parameters?:string
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
export type ConnectionFileKind = 'certificate' | 'private-key' | 'sqlite' | 'sqlite-create'
export interface NativeCliSnapshot {output:string;status:string;running:boolean;closed:boolean}
export interface DbExAPI {
  readonly windowChrome:import('./window-chrome').WindowChrome
  readonly workspaceWindowId:string
  pickDataFile(id:string,format:import('./file-transfer').DataFileFormat,delimiter:string,encoding?:import('./file-transfer').DataFileEncoding):Promise<import('./file-transfer').FilePreview|null>
  startFileTransfer(id:string,request:import('./file-transfer').FileTransferRequest):Promise<import('./file-transfer').FileTransferJob|null>
  listFilePresets(id:string,database:string,entity:string,direction:'import'|'export'):Promise<import('./file-transfer').FileTransferPreset[]>
  saveFilePreset(id:string,database:string,entity:string,direction:'import'|'export',draft:import('./file-transfer').FileTransferPresetDraft,presetId?:string):Promise<import('./file-transfer').FileTransferPreset>
  removeFilePreset(id:string,database:string,entity:string,direction:'import'|'export',presetId:string):Promise<void>
  exportFileTransferReport(id:string):Promise<boolean>
  getFileTransferJob():Promise<import('./file-transfer').FileTransferJob|null>
  cancelFileTransfer(id:string):Promise<void>
  migrationCatalog(id:string,database?:string):Promise<import('./migration').MigrationCatalog>
  previewMigration(request:import('./migration').MigrationRequest):Promise<import('./migration').MigrationPlan>
  runMigration(planId:string,steps:string[]):Promise<import('./migration').MigrationJob>
  listMigrationJobs():Promise<import('./migration').MigrationJob[]>
  removeMigrationHistory(id:string):Promise<void>
  cancelMigration(id:string):Promise<void>
  newWorkspaceWindow():Promise<boolean>
  restoreWorkspaceWindows(restore:boolean):Promise<void>
  getNativePreferences():Promise<import('./preferences').NativePreferences>
  saveNativePreferences(value:import('./preferences').NativePreferences):Promise<import('./preferences').NativePreferences>
  pickTool(name:import('./preferences').ToolName):Promise<string|null>
  checkTool(name:import('./preferences').ToolName,path:string):Promise<boolean>
  toolVersion(name:import('./preferences').ToolName,path:string):Promise<string>
  backupSqlite(id:string):Promise<boolean>
  runNativeTool(id:string,task:import('./preferences').NativeToolTask,database:string,entity?:string):Promise<boolean>
  startNativeCli(id:string,database:string):Promise<void>
  readNativeCli(id:string):Promise<NativeCliSnapshot>
  sendNativeCli(id:string,sql:string):Promise<void>
  stopNativeCli(id:string):Promise<void>
  logPath():Promise<string>
  openLogs():Promise<void>
  saveRecovery(value:import('./preferences').RecoveryDraft):Promise<void>
  loadRecovery(value:import('./preferences').RecoveryDraft):Promise<import('./preferences').RecoveryDraft|null>
  clearRecovery():Promise<void>
  deleteRecovery(value:import('./preferences').RecoveryDraft):Promise<void>
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
  children(sessionId: string, database: string, category?: MongoCategory, withStatistics?:boolean): Promise<ExplorerNode[]>
  preview(sessionId: string, database: string, entity: string, offset?: number): Promise<DataPreview>
  redisKeys(sessionId: string, cursor?: string, pattern?: string): Promise<DataPreview>
  redisValue(sessionId: string, key: string): Promise<DataPreview>
  executeReadBatch(id:string,request:import('./query-batch').QueryBatchRequest):Promise<import('./query-batch').QueryBatchResult>
  executeQuery(id:string,operation:DatabaseOperation):Promise<OperationResult>
  cancelQuery(id:string):Promise<boolean>
  execute(sessionId: string, operation: DatabaseOperation): Promise<OperationResult>
  clickhouseTransfer(sessionId:string,input:ClickHouseTransfer):Promise<{bytes:number}|null>
  validateMongoDocument(document: string, original?: string): Promise<void>
  copyText(value: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  setWriteAccess(sessionId: string, enabled: boolean): Promise<SessionInfo>
  listBrowseProfiles(id:string,database:string,entity:string):Promise<import('./browse-profile').BrowseProfile[]>
  saveBrowseProfile(id:string,database:string,entity:string,draft:import('./browse-profile').BrowseProfileDraft,profileId?:string):Promise<import('./browse-profile').BrowseProfile>
  deleteBrowseProfile(id:string,database:string,entity:string,profileId:string):Promise<void>
  listSavedQueries(sessionId:string,database:string,mode:import('./saved-query').QueryMode):Promise<import('./saved-query').QuerySummary[]>
  getSavedQuery(sessionId:string,database:string,id:string):Promise<import('./saved-query').SavedQuery>
  saveQueryObject(sessionId:string,database:string,input:import('./saved-query').QuerySave):Promise<import('./saved-query').SavedQuery>
  copySavedQuery(sessionId:string,database:string,id:string):Promise<import('./saved-query').SavedQuery>
  deleteSavedQuery(sessionId:string,database:string,id:string,revision:string):Promise<void>
  importSavedQuery(sessionId:string,database:string,mode:import('./saved-query').QueryMode):Promise<import('./saved-query').SavedQuery|null>
  exportSavedQuery(sessionId:string,database:string,id:string,format:'json'|'sql'):Promise<boolean>
  listSnippets(): Promise<QuerySnippet[]>
  saveSnippet(snippet: Omit<QuerySnippet, 'id' | 'updatedAt'> & { id?: string }): Promise<QuerySnippet>
  deleteSnippet(id: string): Promise<void>
  importFile(): Promise<FileImport | null>
  exportFile(name: string, content: string, format: 'csv' | 'json' | 'text'): Promise<boolean>
  importConnections(): Promise<number>
  exportConnections(id?: string): Promise<boolean>
  importSshConfig(): Promise<SshImportResult | null>
}

