import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { MongoClient, type MongoClientOptions } from 'mongodb'
import mysql, { type Connection as MysqlConnection } from 'mysql2/promise'
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import { checkServerIdentity } from 'node:tls'
import { isIP } from 'node:net'
import type { ConnectionConfig, DatabaseOperation, DataPreview, ExplorerNode, MongoOperation, MysqlOperation, OperationResult, RedisOperation, SessionInfo } from '../../shared/types'
import { createTransport, type ConnectionTransport } from './transport'
import { createRedisClient, setRedisReadBudget, type RedisClient } from './redis-client'
import { validateConnection, validateId } from './validation'
import { describeMongoConnectionError } from './mongo-diagnostics'
import { mongoDirectConnection, mongoUriTlsEnabled } from './mongo-topology'
import { secretValues } from './credentials'
import { MysqlOperations } from '../operations/mysql'
import { MongoOperations } from '../operations/mongodb'
import { RedisOperations } from '../operations/redis'
import { databaseError, resourceName, type OperationContext } from '../operations/common'
import { quoteIdentifier } from '../operations/sql-policy'

type DriverSession =
  | { kind: 'mysql'; client: MysqlConnection; operations: MysqlOperations }
  | { kind: 'mongodb'; client: MongoClient; operations: MongoOperations }
  | { kind: 'redis'; client: RedisClient; operations: RedisOperations }
interface LiveSession {
  info: SessionInfo
  config: ConnectionConfig
  driver: DriverSession
  transport: ConnectionTransport
  controller?: AbortController
}
const ACTIONS = new Set(['mysql.query', 'mysql.structure', 'mysql.insert', 'mysql.update', 'mysql.delete', 'mysql.import', 'mysql.begin', 'mysql.commit', 'mysql.rollback', 'mongo.find', 'mongo.aggregate', 'mongo.insert', 'mongo.replace', 'mongo.delete', 'mongo.indexes', 'mongo.createIndex', 'mongo.dropIndex', 'redis.scan', 'redis.get', 'redis.set', 'redis.mutate', 'redis.ttl', 'redis.delete', 'redis.command', 'redis.nodes'])
async function certificate(path?: string): Promise<Buffer | undefined> {
  if (!path) return undefined
  const info = await stat(path)
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('TLS_CONFIG: 证书文件必须为不超过2 MiB的普通文件')
  return readFile(path)
}
function hostForUri(host: string): string { return isIP(host) === 6 ? `[${host}]` : host }
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>()
  private pendingConnections = 0
  private generation = 0
  private session(id: string): LiveSession {
    validateId(id)
    const result = this.sessions.get(id)
    if (!result) throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接')
    return result
  }
  info(id: string): SessionInfo { return { ...this.session(id).info } }
  redact(message: string, extra?: ConnectionConfig): string {
    const values = [...this.sessions.values()].flatMap(session => secretValues(session.config))
    if (extra) values.push(...secretValues(extra))
    for (const value of values.sort((a, b) => b.length - a.length)) if (value) message = message.split(value).join('[redacted]')
    return message.replace(/(?:mongodb(?:\+srv)?|redis|rediss|mysql):\/\/[^\s]+/gi, '[redacted URI]')
      .replace(/((?:password|passphrase|pwd|proxyPassword)\s*[:=]\s*)[^\s&;,]+/gi, '$1[redacted]').slice(0, 1500)
  }
  async connect(value: ConnectionConfig, connectionId?: string): Promise<SessionInfo> {
    if (this.sessions.size + this.pendingConnections >= 20) throw new Error('SESSION_LIMIT: 最多同时打开20个连接')
    const config = validateConnection(value)
    const generation = this.generation
    this.pendingConnections++
    let transport: ConnectionTransport | undefined
    let driver: DriverSession | undefined
    let mongoPending: MongoClient | undefined
    try {
      transport = await createTransport({ ssh: config.ssh, proxy: config.proxy, timeoutMs: config.connectTimeoutMs })
      const mongoTlsActive = config.kind === 'mongodb' && (config.tls.enabled || mongoUriTlsEnabled(config.uri))
      const loadTls = config.tls.enabled || config.sentinelTls || mongoTlsActive
      const [ca, cert, key] = loadTls ? await Promise.all([certificate(config.tls.caPath), certificate(config.tls.certPath), certificate(config.tls.keyPath)]) : []
      const tls: TlsConnectionOptions = { ca, cert, key, servername: config.tls.servername || undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
      switch (config.kind) {
        case 'mysql': {
          const stream = await transport.open(config.host, config.port)
          try {
            const client = await mysql.createConnection({
              host: config.tls.servername || config.host, port: config.port, stream,
              user: config.username || undefined, password: config.password || undefined,
              database: config.database || undefined, connectTimeout: config.connectTimeoutMs,
              supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, decimalNumbers: false, jsonStrings: true,
              multipleStatements: false, flags: ['-LOCAL_FILES'],
              ssl: config.tls.enabled ? { ca, cert, key, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } : undefined,
            })
            driver = { kind: 'mysql', client, operations: new MysqlOperations(client) }
          } catch (error) { stream.destroy(); throw error }
          break
        }
        case 'mongodb': {
          const nodes = config.nodes?.length ? config.nodes : [{ host: config.host, port: config.port }]
          const uri = config.uri?.trim() || `mongodb://${nodes.map(node => `${hostForUri(node.host)}:${node.port}`).join(',')}/`
          const options: MongoClientOptions = {
            ...(config.uri ? {} : {
              auth: config.username ? { username: config.username, password: config.password || '' } : undefined,
              authSource: config.authSource || 'admin', dbName: config.database || undefined,
            }),
            serverSelectionTimeoutMS: config.connectTimeoutMs, connectTimeoutMS: config.connectTimeoutMs,
            socketTimeoutMS: 30000, maxPoolSize: 5, minPoolSize: 0, waitQueueTimeoutMS: 10000,
            // Only retry driver-classified reads after topology changes; never replay writes.
            retryWrites: false, retryReads: true,
            // Command error codes must stay native numbers for SDAM/read retry classification.
            // MongoOperations decodes only raw result documents with exact BSON types.
            promoteValues: true,
            ...(config.mongoReplicaSet ? { replicaSet: config.mongoReplicaSet } : {}),
            ...(mongoDirectConnection(config) === undefined ? {} : { directConnection: mongoDirectConnection(config) }),
            ...(mongoTlsActive ? { tls: true, ca, cert, key, minVersion: 'TLSv1.2' } : {}),
            ...(mongoTlsActive && config.tls.servername ? { servername: config.tls.servername, checkServerIdentity: (_host, certificate) => checkServerIdentity(config.tls.servername!, certificate) } : {}),
          }
          if (config.ssh.enabled || config.proxy?.enabled) {
            const proxy = await transport.socks()
            Object.assign(options, { proxyHost: proxy.host, proxyPort: proxy.port, proxyUsername: proxy.username, proxyPassword: proxy.password })
          }
          mongoPending = new MongoClient(uri, options)
          await mongoPending.connect()
          // A successful topology handshake is not enough: require a real authenticated
          // command before the UI reports success, especially for lazy authentication.
          await mongoPending.db(config.database || 'admin').command({ ping: 1 }, { timeoutMS: config.connectTimeoutMs })
          driver = { kind: 'mongodb', client: mongoPending, operations: new MongoOperations(mongoPending) }
          mongoPending = undefined
          break
        }
        case 'redis': {
          const client = await createRedisClient(config, transport, tls)
          driver = { kind: 'redis', client, operations: new RedisOperations(client) }
          break
        }
      }
      if (generation !== this.generation) throw new Error('SESSION_CLOSED: 窗口已关闭，本次连接已取消')
      const info: SessionInfo = { id: randomUUID(), connectionId, name: config.name, kind: config.kind, environment: config.environment,
        displayHost: config.host || 'MongoDB URI', writable: false, transaction: false }
      this.sessions.set(info.id, { info, driver, transport, config })
      return { ...info }
    } catch (error) {
      if (driver) await this.closeDriver(driver)
      await mongoPending?.close().catch(() => {})
      await transport?.close().catch(() => {})
      const original = error as { code?: string; name?: string; message?: string }
      const message = original.message || '连接失败'
      if (/^[A-Z_]+:/.test(message)) throw new Error(this.redact(message, config))
      if (config.kind === 'mongodb') {
        const diagnosis = describeMongoConnectionError(error)
        if (diagnosis) throw new Error(diagnosis)
      }
      const code = String(original.code || original.name || 'NETWORK').replace(/[^A-Za-z0-9_-]/g, '')
      throw new Error(`CONNECTION_FAILED: 连接失败（${code}），请检查认证、网络、TLS证书及拓扑配置`)
    } finally { this.pendingConnections-- }
  }
  private async closeDriver(driver: DriverSession): Promise<void> {
    if (driver.kind === 'mysql') { await driver.operations.close().catch(() => {}); driver.client.destroy() }
    else if (driver.kind === 'mongodb') { driver.operations.cancel(); await driver.client.close().catch(() => {}) }
    else driver.client.disconnect()
  }
  async disconnect(id: string): Promise<void> {
    validateId(id)
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.controller?.abort()
    try { await this.closeDriver(session.driver) } finally { await session.transport.close() }
  }
  async cancel(id: string): Promise<void> { await this.disconnect(id) }
  async disconnectForConnection(connectionId: string): Promise<void> { await Promise.all([...this.sessions.values()].filter(x => x.info.connectionId === connectionId).map(x => this.disconnect(x.info.id))) }
  async closeAll(): Promise<void> { this.generation++; await Promise.allSettled([...this.sessions.keys()].map(id => this.disconnect(id))) }
  async setWriteAccess(id: string, enabled: boolean): Promise<SessionInfo> {
    if (typeof enabled !== 'boolean') throw new Error('权限参数无效')
    const session = this.session(id)
    if (session.controller) throw new Error('SESSION_BUSY: 请等待当前操作完成或取消')
    if (!enabled && session.driver.kind === 'mysql' && session.driver.operations.transactionActive) await this.execute(id, { action: 'mysql.rollback' })
    session.info.writable = enabled
    return { ...session.info }
  }
  private async guard<T>(id: string, work: (session: LiveSession, context: OperationContext) => Promise<T>, confirmed = false): Promise<T> {
    const session = this.session(id)
    if (session.controller) throw new Error('SESSION_BUSY: 当前连接正在执行操作')
    const controller = new AbortController()
    session.controller = controller
    const redisBudget = session.driver.kind === 'redis' ? setRedisReadBudget(session.driver.client, 8 * 1024 * 1024) : undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work(session, { writable: session.info.writable, confirmed, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); void this.disconnect(id); reject(new Error('TIMEOUT: 操作超过30秒，连接已断开；未提交事务将回滚，写入结果请重连后核对')) }, 30000) }),
      ])
    } catch (error) {
      if (session.driver.kind === 'mysql' && session.driver.operations.disconnected) await this.disconnect(id)
      const e = error as { code?: unknown; name?: string }
      if (e?.code !== undefined || e?.name?.startsWith('Mongo')) throw databaseError(error)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      if (session.driver.kind === 'redis') setRedisReadBudget(session.driver.client, undefined)
      session.controller = undefined
      if (redisBudget?.exceeded) { await this.disconnect(id); throw new Error('LIMIT_EXCEEDED: Redis回复超过8 MiB，连接已关闭；写操作可能部分完成，请重连核对') }
      if (session.driver.kind === 'mysql') session.info.transaction = session.driver.operations.transactionActive
    }
  }
  async execute(id: string, input: DatabaseOperation): Promise<OperationResult> {
    if (!input || typeof input !== 'object' || !ACTIONS.has(input.action)) throw new Error('INVALID_OPERATION: 不支持的操作')
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED: 单次操作参数最多4 MiB')
    const session = this.session(id)
    const prefix = session.info.kind === 'mongodb' ? 'mongo.' : `${session.info.kind}.`
    if (!input.action.startsWith(prefix)) throw new Error('INVALID_OPERATION: 操作与连接类型不匹配')
    const result = await this.guard(id, async ({ driver }, context) => {
      if (driver.kind === 'mysql') return driver.operations.execute(input as MysqlOperation, context)
      if (driver.kind === 'mongodb') return driver.operations.execute(input as MongoOperation, context)
      return driver.operations.execute(input as RedisOperation, context)
    }, 'confirmed' in input && input.confirmed === true)
    if (result.disconnected) await this.disconnect(id)
    return result
  }
  async roots(id: string): Promise<ExplorerNode[]> {
    return this.guard(id, async (session, context) => {
      const { driver, config } = session
      if (driver.kind === 'mysql') {
        const data = await driver.operations.execute({ action: 'mysql.query', sql: 'SHOW DATABASES' }, context)
        return data.rows.map(row => { const db = Object.values(row)[0]; return { id: `db:${db}`, label: db, kind: 'database', database: db } })
      }
      if (driver.kind === 'mongodb') {
        try {
          const data = await driver.client.db().admin().listDatabases({ nameOnly: true, authorizedDatabases: true, maxTimeMS: 10000 })
          return data.databases.slice(0, 500).map(db => ({ id: `db:${db.name}`, label: db.name, kind: 'database', database: db.name }))
        } catch (error) {
          if ((error as { code?: number }).code !== 13) throw error
          const db = config.database || driver.client.db().databaseName
          return [{ id: `db:${db}`, label: db, kind: 'database', database: db }]
        }
      }
      return [{ id: `db:${config.redisDb || 0}`, label: config.redisMode === 'cluster' ? 'Cluster · DB 0' : `DB ${config.redisDb || 0}`, kind: 'keyspace', database: String(config.redisDb || 0) }]
    })
  }
  async children(id: string, database: string): Promise<ExplorerNode[]> {
    resourceName(database, '数据库')
    return this.guard(id, async ({ driver }, context) => {
      if (driver.kind === 'mysql') {
        const data = await driver.operations.execute({ action: 'mysql.query', sql: `SHOW FULL TABLES FROM ${quoteIdentifier(database)}` }, context)
        return data.rows.map(row => { const entity = Object.values(row)[0]; return { id: `table:${database}:${entity}`, label: entity, kind: 'table', database, entity } })
      }
      if (driver.kind === 'mongodb') {
        const cursor = driver.client.db(database).listCollections({}, { nameOnly: true, authorizedCollections: true, batchSize: 100, maxTimeMS: 10000 })
        const nodes: ExplorerNode[] = []
        try { for await (const item of cursor) { nodes.push({ id: `collection:${database}:${item.name}`, label: item.name, kind: 'collection', database, entity: item.name }); if (nodes.length >= 500 || context.signal?.aborted) break } }
        finally { await cursor.close() }
        return nodes
      }
      return []
    })
  }
  preview(id: string, database: string, entity: string, offset = 0): Promise<DataPreview> {
    resourceName(database, '数据库'); resourceName(entity, '表/集合')
    const kind = this.session(id).info.kind
    if (kind === 'mysql') return this.execute(id, { action: 'mysql.query', database, sql: `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(entity)}`, offset, limit: 100 })
    if (kind === 'mongodb') return this.execute(id, { action: 'mongo.find', database, entity, offset, limit: 100 })
    throw new Error('此连接不支持表数据预览')
  }
  redisKeys(id: string, cursor = '0', pattern = '*'): Promise<DataPreview> { return this.execute(id, { action: 'redis.scan', cursor, pattern }) }
  redisValue(id: string, key: string): Promise<DataPreview> { return this.execute(id, { action: 'redis.get', key }) }
}
