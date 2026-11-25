import { randomUUID } from 'node:crypto'
import type { MongoCategory } from '../../shared/mongo-catalog'
import { connectionDisplayEndpoint } from '../../shared/connection-form'
import { readFile, stat } from 'node:fs/promises'
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { ConnectionConfig, DatabaseOperation, DataPreview, ExplorerNode, OperationResult, SessionInfo } from '../../shared/types'
import { createTransport, type ConnectionTransport } from './transport'
import { validateConnection, validateId } from './validation'
import { mongoUriTlsEnabled } from './mongo-topology'
import { secretValues } from './credentials'
import type { SqliteProcessFactory } from '../operations/sqlite-client'
import { databaseError, resourceName, type OperationContext } from '../operations/common'
import { databaseAdapter, isKnownDatabaseAction, adapterAllowsAction } from './adapters'
import type { AdapterSession } from './adapters/types'

interface LiveSession {
  info: SessionInfo
  config: ConnectionConfig
  driver: AdapterSession
  transport: ConnectionTransport
  controller?: AbortController
}
async function certificate(path?: string): Promise<Buffer | undefined> {
  if (!path) return undefined
  const info = await stat(path)
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('TLS_CONFIG: 证书文件必须为不超过2 MiB的普通文件')
  return readFile(path)
}
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>()
  private pendingConnections = 0
  private generation = 0
  constructor(private readonly sqliteProcessFactory?:SqliteProcessFactory,private readonly sqliteModulePath?:string){}
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
    let driver: AdapterSession | undefined
    const adapter = databaseAdapter(config.kind)
    try {
      transport = await createTransport({ ssh: config.ssh, proxy: config.proxy, timeoutMs: config.connectTimeoutMs })
      const mongoTlsActive = config.kind === 'mongodb' && (config.tls.enabled || mongoUriTlsEnabled(config.uri))
      const loadTls = config.tls.enabled || config.sentinelTls || mongoTlsActive
      const [ca, cert, key] = loadTls ? await Promise.all([certificate(config.tls.caPath), certificate(config.tls.certPath), certificate(config.tls.keyPath)]) : []
      const tls: TlsConnectionOptions = { ca, cert, key, servername: config.tls.servername || undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
      driver=await adapter.connect({config,transport,tls,sqliteProcessFactory:this.sqliteProcessFactory,sqliteModulePath:this.sqliteModulePath})
      if (generation !== this.generation) throw new Error('SESSION_CLOSED: 窗口已关闭，本次连接已取消')
      const info: SessionInfo = { id: randomUUID(), connectionId, name: config.name, kind: config.kind,
        displayHost: connectionDisplayEndpoint(config).host, serverVersion:driver.serverVersion, writable: false, transaction: false }
      this.sessions.set(info.id, { info, driver, transport, config })
      return { ...info }
    } catch (error) {
      if (driver) await driver.close().catch(() => {})
      await transport?.close().catch(() => {})
      const original = error as { code?: string; name?: string; message?: string }
      const message = original.message || '连接失败'
      if (/^[A-Z_]+:/.test(message)) throw new Error(this.redact(message, config))
      const diagnosis=adapter.connectionError?.(error)
      if(diagnosis)throw new Error(diagnosis)
      const code = String(original.code || original.name || 'NETWORK').replace(/[^A-Za-z0-9_-]/g, '')
      throw new Error(`CONNECTION_FAILED: 连接失败（${code}），请检查认证、网络、TLS证书及拓扑配置`)
    } finally { this.pendingConnections-- }
  }
  async disconnect(id: string): Promise<void> {
    validateId(id)
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.controller?.abort()
    try { await session.driver.close() } finally { await session.transport.close() }
  }
  async cancel(id: string): Promise<void> { await this.disconnect(id) }
  async disconnectForConnection(connectionId: string): Promise<void> { await Promise.all([...this.sessions.values()].filter(x => x.info.connectionId === connectionId).map(x => this.disconnect(x.info.id))) }
  async closeAll(): Promise<void> { this.generation++; await Promise.allSettled([...this.sessions.keys()].map(id => this.disconnect(id))) }
  async setWriteAccess(id: string, enabled: boolean): Promise<SessionInfo> {
    if (typeof enabled !== 'boolean') throw new Error('权限参数无效')
    const session = this.session(id)
    if (session.controller) throw new Error('SESSION_BUSY: 请等待当前操作完成或取消')
    const rollback=databaseAdapter(session.info.kind).rollback
    if(!enabled&&rollback&&session.driver.transactionActive?.())await this.execute(id,rollback)
    session.info.writable = enabled
    return { ...session.info }
  }
  private async guard<T>(id: string, work: (session: LiveSession, context: OperationContext) => Promise<T>, confirmed = false): Promise<T> {
    const session = this.session(id)
    if (session.controller) throw new Error('SESSION_BUSY: 当前连接正在执行操作')
    const controller = new AbortController()
    session.controller = controller
    const readBudget=session.driver.beginReadBudget?.()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work(session, { writable: session.info.writable, confirmed, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); void this.disconnect(id); reject(new Error('TIMEOUT: 操作超过30秒，连接已断开；未提交事务将回滚，写入结果请重连后核对')) }, 30000) }),
      ])
    } catch (error) {
      if(session.driver.disconnected?.())await this.disconnect(id)
      const e = error as { code?: unknown; name?: string }
      if (e?.code !== undefined || e?.name?.startsWith('Mongo')) throw databaseError(error)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      readBudget?.release()
      session.controller = undefined
      if (readBudget?.exceeded()) { await this.disconnect(id); throw new Error('LIMIT_EXCEEDED: Redis回复超过8 MiB，连接已关闭；写操作可能部分完成，请重连核对') }
      session.info.transaction=session.driver.transactionActive?.()??false
    }
  }
  async backupSqlite(id:string,path:string){const driver=this.session(id).driver;if(!driver.backupTo)throw new Error('INVALID_OPERATION: 不支持的操作');return this.external(id,false,()=>driver.backupTo!(path))}
  async external<T>(id:string,write:boolean,work:(config:ConnectionConfig,signal:AbortSignal)=>Promise<T>):Promise<T>{
    const session=this.session(id)
    if(session.controller||session.info.transaction)throw new Error('SESSION_BUSY: 请等待当前操作完成或取消')
    if(write&&!session.info.writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
    const controller=new AbortController();session.controller=controller
    try{return await work(session.config,controller.signal)}finally{session.controller=undefined}
  }
  async execute(id: string, input: DatabaseOperation): Promise<OperationResult> {
    if (!input || typeof input !== 'object' || !isKnownDatabaseAction(input.action)) throw new Error('INVALID_OPERATION: 不支持的操作')
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED: 单次操作参数最多4 MiB')
    const session = this.session(id)
    if(!adapterAllowsAction(session.info.kind,input.action))throw new Error('INVALID_OPERATION: 操作与连接类型不匹配')
    const result=await this.guard(id,({driver},context)=>driver.execute(input,context),'confirmed'in input&&input.confirmed===true)
    if (result.disconnected) await this.disconnect(id)
    return result
  }
  async roots(id:string):Promise<ExplorerNode[]>{
    return this.guard(id,({driver},context)=>driver.roots(context))
  }
  async children(id:string,database:string,category?:MongoCategory,withStatistics=false):Promise<ExplorerNode[]>{
    resourceName(database,'数据库')
    if(typeof withStatistics!=='boolean')throw new Error('INVALID_OPERATION: 不支持的操作')
    return this.guard(id,({driver},context)=>driver.children(database,category,context,withStatistics))
  }
  preview(id:string,database:string,entity:string,offset=0):Promise<DataPreview>{
    resourceName(database,'数据库');resourceName(entity,'表/集合')
    const operation=databaseAdapter(this.session(id).info.kind).preview?.(database,entity,offset)
    if(!operation)throw new Error('此连接不支持表数据预览')
    return this.execute(id,operation)
  }
  redisKeys(id: string, cursor = '0', pattern = '*'): Promise<DataPreview> { return this.execute(id, { action: 'redis.scan', cursor, pattern }) }
  redisValue(id: string, key: string): Promise<DataPreview> { return this.execute(id, { action: 'redis.get', key }) }
}
