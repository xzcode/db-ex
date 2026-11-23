export type DatabaseKind = 'mysql' | 'mongodb' | 'redis'
export type EnvironmentKind = 'development' | 'testing' | 'production'

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
  /** SHA-256 of server public key, encoded as 64 lowercase hex characters. */
  hostFingerprint?: string
}

export interface TlsOptions {
  enabled: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
  /** Override for certificate hostname verification when tunneled. */
  servername?: string
}

export interface ConnectionConfig {
  id?: string
  name: string
  kind: DatabaseKind
  environment: EnvironmentKind
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  authSource?: string
  redisDb?: number
  /** MongoDB-only URI, stored encrypted; can contain credentials. */
  uri?: string
  ssh: SshOptions
  tls: TlsOptions
}

export interface SavedConnection {
  id: string
  name: string
  kind: DatabaseKind
  environment: EnvironmentKind
  host: string
  port: number
  sshEnabled: boolean
  tlsEnabled: boolean
}

export interface SessionInfo {
  id: string
  connectionId?: string
  name: string
  kind: DatabaseKind
  environment: EnvironmentKind
  displayHost: string
}

export interface ExplorerNode {
  id: string
  label: string
  kind: 'database' | 'table' | 'collection' | 'keyspace'
  database?: string
  entity?: string
}

export interface DataPreview {
  columns: string[]
  rows: Record<string, string>[]
  nextOffset?: number
  nextCursor?: number
  value?: string
}

export interface DbExAPI {
  listConnections(): Promise<SavedConnection[]>
  saveConnection(config: ConnectionConfig): Promise<SavedConnection>
  deleteConnection(id: string): Promise<void>
  trustHostKey(id: string, fingerprint: string): Promise<void>
  connectSaved(id: string): Promise<SessionInfo>
  connectTemporary(config: ConnectionConfig): Promise<SessionInfo>
  disconnect(sessionId: string): Promise<void>
  roots(sessionId: string): Promise<ExplorerNode[]>
  children(sessionId: string, database: string): Promise<ExplorerNode[]>
  preview(sessionId: string, database: string, entity: string, offset?: number): Promise<DataPreview>
  redisKeys(sessionId: string, cursor?: number, pattern?: string): Promise<DataPreview>
  redisValue(sessionId: string, key: string): Promise<DataPreview>
}
