import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MongoClient, BSON } from 'mongodb'
import mysql, { type Connection as MysqlConnection } from 'mysql2/promise'
import { createClient } from 'redis'
import type { ConnectionConfig, DataPreview, ExplorerNode, SessionInfo } from '../../shared/types'
import { openSshTunnel, type SshTunnel } from './ssh'
import { validateConnection, validateId } from './validation'

type RedisConnection = ReturnType<typeof createClient>
type DriverSession =
  | { kind: 'mysql'; client: MysqlConnection }
  | { kind: 'mongodb'; client: MongoClient }
  | { kind: 'redis'; client: RedisConnection }

interface LiveSession {
  info: SessionInfo
  driver: DriverSession
  tunnel?: SshTunnel
  database: string
  redisDb: number
}

function textCell(input: unknown): string {
  if (input === null || input === undefined) return 'NULL'
  if (Buffer.isBuffer(input)) return `base64:${input.toString('base64')}`
  if (typeof input === 'string') return input.slice(0, 4096)
  if (typeof input === 'bigint') return String(input)
  if (typeof input === 'object') {
    try { return BSON.EJSON.stringify(input).slice(0, 4096) } catch { return '[complex value]' }
  }
  return String(input)
}

function grid(rows: Record<string, unknown>[], nextOffset?: number): DataPreview {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 60)
  return {
    columns, rows: rows.map(row => Object.fromEntries(columns.map(key => [key, textCell(row[key])]))),
    nextOffset,
  }
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>()

  private session(id: string): LiveSession {
    validateId(id)
    const session = this.sessions.get(id)
    if (!session) throw new Error('会话已关闭，请重新连接')
    return session
  }

  async connect(value: ConnectionConfig, connectionId?: string): Promise<SessionInfo> {
    const config = validateConnection(value)
    let tunnel: SshTunnel | undefined
    let driver: DriverSession | undefined
    try {
      let host = config.host
      let port = config.port
      if (config.ssh.enabled) {
        tunnel = await openSshTunnel(config.ssh, host, port)
        host = '127.0.0.1'
        port = tunnel.port
      }
      const tlsEnabled = config.tls.enabled
      const ca = tlsEnabled && config.tls.caPath ? await readFile(config.tls.caPath) : undefined
      const cert = tlsEnabled && config.tls.certPath ? await readFile(config.tls.certPath) : undefined
      const key = tlsEnabled && config.tls.keyPath ? await readFile(config.tls.keyPath) : undefined
      const servername = config.tls.servername || config.host

      switch (config.kind) {
        case 'mysql': {
          const client = await mysql.createConnection({
            host, port, user: config.username || undefined, password: config.password || undefined,
            database: config.database || undefined, connectTimeout: 12000,
            supportBigNumbers: true, bigNumberStrings: true,
            ssl: tlsEnabled ? { ca, cert, key, rejectUnauthorized: true } : undefined,
          })
          driver = { kind: 'mysql', client }
          break
        }
        case 'mongodb': {
          // SRV/replica discovery remains native when connecting directly. SSH is single-node only.
          const uri = config.uri?.trim() || `mongodb://${host}:${port}/`
          const client = new MongoClient(uri, {
            ...(config.uri?.trim() ? {} : {
              auth: config.username ? { username: config.username, password: config.password || '' } : undefined,
              authSource: config.authSource || 'admin',
            }),
            directConnection: config.ssh.enabled ? true : undefined,
            serverSelectionTimeoutMS: 12000, connectTimeoutMS: 12000,
            maxPoolSize: 5,
            tls: tlsEnabled ? true : undefined,
            tlsCAFile: tlsEnabled ? config.tls.caPath || undefined : undefined,
            tlsCertificateKeyFile: tlsEnabled && config.tls.certPath && config.tls.keyPath
              ? config.tls.certPath : undefined,
            // A separate key path is not supported by the MongoDB driver's TLS PEM option.
          })
          if (tlsEnabled && cert && key && config.tls.certPath !== config.tls.keyPath) {
            throw new Error('TLS_ERROR: MongoDB 客户端证书与私钥需放在同一个 PEM 文件中')
          }
          await client.connect()
          driver = { kind: 'mongodb', client }
          break
        }
        case 'redis': {
          const client = createClient({
            username: config.username || undefined,
            password: config.password || undefined,
            database: config.redisDb ?? 0,
            socket: {
              host, port, connectTimeout: 12000,
              tls: tlsEnabled ? true : undefined,
              ca, cert, key,
              servername: tlsEnabled ? servername : undefined,
              reconnectStrategy: false,
            },
          })
          // node-redis emits errors on the EventEmitter even if connect() rejects.
          client.on('error', () => {})
          await client.connect()
          driver = { kind: 'redis', client }
          break
        }
      }
      const id = randomUUID()
      const info: SessionInfo = {
        id, connectionId, name: config.name, kind: config.kind,
        environment: config.environment, displayHost: config.host || 'MongoDB URI',
      }
      this.sessions.set(id, {
        info, driver, tunnel, database: config.database || '', redisDb: config.redisDb ?? 0,
      })
      return info
    } catch (error) {
      if (driver) await this.closeDriver(driver)
      if (tunnel) await tunnel.close()
      throw error
    }
  }

  private async closeDriver(driver: DriverSession): Promise<void> {
    try {
      if (driver.kind === 'mysql') await driver.client.end()
      else if (driver.kind === 'mongodb') await driver.client.close()
      else if (driver.client.isOpen) await driver.client.quit()
    } catch { /* Prefer closing tunnel and clearing session even on driver shutdown failure. */ }
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await this.closeDriver(session.driver)
    await session.tunnel?.close()
  }

  async disconnectForConnection(connectionId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.info.connectionId === connectionId) await this.disconnect(id)
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.disconnect(id)
  }

  async roots(id: string): Promise<ExplorerNode[]> {
    const { driver, database, redisDb } = this.session(id)
    if (driver.kind === 'mysql') {
      const [rows] = await driver.client.query('SHOW DATABASES')
      return (rows as Record<string, string>[]).map(row => {
        const db = Object.values(row)[0]
        return { id: `db:${db}`, label: db, kind: 'database', database: db }
      })
    }
    if (driver.kind === 'mongodb') {
      try {
        const data = await driver.client.db().admin().listDatabases()
        return data.databases.map(db => ({ id: `db:${db.name}`, label: db.name, kind: 'database', database: db.name }))
      } catch {
        const db = database || 'test'
        return [{ id: `db:${db}`, label: db, kind: 'database', database: db }]
      }
    }
    return [{ id: `db:${redisDb}`, label: `DB ${redisDb}`, kind: 'keyspace', database: String(redisDb) }]
  }

  async children(id: string, database: string): Promise<ExplorerNode[]> {
    const { driver } = this.session(id)
    if (!database || database.length > 200) throw new Error('数据库名称无效')
    if (driver.kind === 'mysql') {
      const [rows] = await driver.client.query(`SHOW FULL TABLES FROM ${quoteIdentifier(database)}`)
      return (rows as Record<string, string>[]).map(row => {
        const label = String(Object.values(row)[0])
        return { id: `table:${database}:${label}`, label, kind: 'table', database, entity: label }
      })
    }
    if (driver.kind === 'mongodb') {
      const collections = await driver.client.db(database).listCollections({}, { nameOnly: true }).toArray()
      return collections.map(item => ({
        id: `collection:${database}:${item.name}`, label: item.name,
        kind: 'collection', database, entity: item.name,
      }))
    }
    return []
  }

  async preview(id: string, database: string, entity: string, offset = 0): Promise<DataPreview> {
    const { driver } = this.session(id)
    if (driver.kind === 'redis') throw new Error('请使用 Redis Key 浏览器')
    if (!database || !entity || database.length > 200 || entity.length > 200) throw new Error('资源名称无效')
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('分页参数无效')
    const batchSize = 100
    if (driver.kind === 'mysql') {
      const [rows] = await driver.client.query(
        `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(entity)} LIMIT ? OFFSET ?`,
        [batchSize, offset],
      )
      const result = rows as Record<string, unknown>[]
      return grid(result, result.length === batchSize ? offset + batchSize : undefined)
    }
    const documents = await driver.client.db(database).collection(entity)
      .find({}).skip(offset).limit(batchSize).toArray()
    return grid(documents, documents.length === batchSize ? offset + batchSize : undefined)
  }

  async redisKeys(id: string, cursor = 0, pattern = '*'): Promise<DataPreview> {
    const { driver } = this.session(id)
    if (driver.kind !== 'redis') throw new Error('不是 Redis 会话')
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Redis 游标无效')
    if (typeof pattern !== 'string' || pattern.length > 256) throw new Error('Key 匹配模式无效')
    const scanned = await driver.client.scan(cursor, { MATCH: pattern || '*', COUNT: 50 })
    const rows: Record<string, string>[] = []
    for (const key of scanned.keys) {
      const [kind, ttl] = await Promise.all([driver.client.type(key), driver.client.ttl(key)])
      rows.push({ key, type: kind, ttl: String(ttl) })
    }
    return { columns: ['key', 'type', 'ttl'], rows, nextCursor: scanned.cursor === 0 ? undefined : scanned.cursor }
  }

  async redisValue(id: string, key: string): Promise<DataPreview> {
    const { driver } = this.session(id)
    if (driver.kind !== 'redis') throw new Error('不是 Redis 会话')
    if (!key || key.length > 2048) throw new Error('Key 无效')
    const type = await driver.client.type(key)
    const ttl = await driver.client.ttl(key)
    let value: unknown
    switch (type) {
      case 'string': value = await driver.client.get(key); break
      case 'hash': value = await driver.client.hGetAll(key); break
      case 'list': value = await driver.client.lRange(key, 0, 99); break
      case 'set': {
        const response = await driver.client.sScan(key, 0, { COUNT: 100 })
        value = { members: response.members, nextCursor: response.cursor }
        break
      }
      case 'zset': value = await driver.client.zRangeWithScores(key, 0, 99); break
      case 'stream': value = await driver.client.xRange(key, '-', '+', { COUNT: 100 }); break
      case 'none': value = '(key does not exist)'; break
      default: value = `(unsupported type: ${type})`
    }
    const content = JSON.stringify({ key, type, ttl, value }, null, 2)
    return { columns: ['value'], rows: [{ value: content.slice(0, 65536) }], value: content.slice(0, 65536) }
  }
}
