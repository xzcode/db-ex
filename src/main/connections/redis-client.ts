import { Redis, Cluster, AbstractConnector, type RedisOptions } from 'ioredis'
import { connect as tlsConnect, checkServerIdentity, type ConnectionOptions as TlsConnectionOptions, type TLSSocket } from 'node:tls'
import { isIP, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ConnectionConfig, Endpoint } from '../../shared/types'
import type { ConnectionTransport } from './transport'

type NetStream = Socket | TLSSocket
export type RedisClient = Redis | Cluster
export interface RedisReadBudget { limitBytes: number; receivedBytes: number; exceeded: boolean }
interface BudgetState { current?: RedisReadBudget }
const readBudgets = new WeakMap<RedisClient, BudgetState>()
/** Shared across every Cluster/Sentinel socket; callers retain the returned object to inspect failures. */
export function setRedisReadBudget(client: RedisClient, bytes: number | undefined): RedisReadBudget | undefined {
  const state = readBudgets.get(client)
  if (!state) throw new Error('REDIS_BUDGET_UNAVAILABLE: Redis 客户端未启用传输预算')
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 64 * 1024 * 1024)) throw new Error('REDIS_BUDGET_INVALID: Redis 读取预算无效')
  state.current = bytes === undefined ? undefined : { limitBytes: bytes, receivedBytes: 0, exceeded: false }
  return state.current
}

/** ioredis expects Socket helpers; SSH channels already have SSH keepalive and transport timeouts. */
function socketLike(stream: Duplex): NetStream {
  const result = stream as NetStream
  if (typeof result.setNoDelay !== 'function') result.setNoDelay = () => result
  if (typeof result.setKeepAlive !== 'function') result.setKeepAlive = () => result
  if (typeof result.setTimeout !== 'function') {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let duration = 0
    const refresh = (): void => {
      if (timeout) clearTimeout(timeout)
      if (duration > 0 && !stream.destroyed) timeout = setTimeout(() => stream.emit('timeout'), duration)
    }
    stream.on('data', refresh)
    stream.once('close', () => { if (timeout) clearTimeout(timeout) })
    result.setTimeout = (milliseconds: number, listener?: () => void) => {
      duration = milliseconds
      if (listener) result.once('timeout', listener)
      refresh()
      return result
    }
  }
  return result
}

async function secureStream(raw: Duplex, host: string, options: TlsConnectionOptions, timeoutMs: number): Promise<TLSSocket> {
  const identity = options.servername || host
  const stream = tlsConnect({
    ...options, socket: raw,
    servername: isIP(identity) ? undefined : identity,
    rejectUnauthorized: true,
    checkServerIdentity: (_name, certificate) => checkServerIdentity(identity, certificate),
    minVersion: options.minVersion || 'TLSv1.2',
  })
  stream.on('error', () => {})
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('REDIS_TLS_TIMEOUT: Redis TLS 握手超时')), timeoutMs)
    const fail = (): void => finish(new Error('REDIS_TLS_FAILED: Redis TLS 证书或主机名校验失败'))
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      stream.off('error', fail)
      stream.off('close', fail)
      if (error) { stream.destroy(); raw.destroy(); reject(error) } else resolve(stream)
    }
    stream.once('error', fail)
    stream.once('close', fail)
    stream.once('secureConnect', () => finish())
  })
}

function validEndpoint(value: unknown): Endpoint {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') throw new Error('REDIS_SENTINEL_INVALID: Sentinel 未返回有效主节点地址')
  const host = value[0]
  const port = Number(value[1])
  if (!host || host.length > 253 || /[\s\0/@\\?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REDIS_SENTINEL_INVALID: Sentinel 返回无效主节点地址')
  return { host, port }
}

/** Every connection, including discovery and MOVED/ASK targets, uses the same scoped transport. */
export async function createRedisClient(
  config: ConnectionConfig,
  transport: ConnectionTransport,
  tlsOptions: TlsConnectionOptions = {},
): Promise<RedisClient> {
  const timeoutMs = config.connectTimeoutMs || 12000
  const seeds = config.nodes?.length ? config.nodes : [{ host: config.host, port: config.port }]
  const mode = config.redisMode || 'standalone'
  const initialBudget: RedisReadBudget = { limitBytes: 8 * 1024 * 1024, receivedBytes: 0, exceeded: false }
  const budgetState: BudgetState = { current: initialBudget }
  let client: RedisClient | undefined
  const meter = (stream: NetStream): void => {
    stream.prependListener('data', (chunk: Buffer | string) => {
      const budget = budgetState.current
      if (!budget) return
      budget.receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (budget.exceeded || budget.receivedBytes > budget.limitBytes) {
        budget.exceeded = true
        stream.destroy(new Error('REDIS_RESULT_LIMIT: Redis 响应超过入站字节预算，连接已断开；写入结果可能部分完成，请重连核对'))
        client?.disconnect()
      }
    })
  }
  const dataTls = config.tls.enabled ? tlsOptions : undefined
  const sentinelTls = config.sentinelTls ? tlsOptions : undefined
  const retryStrategy = (attempt: number): number | null => attempt <= 3 ? Math.min(250 * attempt, 1000) : null

  class RoutedConnector extends AbstractConnector {
    private readonly options: RedisOptions
    private readonly pending = new Set<Redis>()
    constructor(options: unknown) {
      const typed = options as RedisOptions
      super(typed.disconnectTimeout || 500)
      this.options = typed
    }
    override disconnect(): void {
      this.connecting = false
      for (const client of this.pending) client.disconnect()
      this.pending.clear()
      super.disconnect()
    }
    override check(info: { role?: string }): boolean {
      return this.options.name ? info.role === 'master' : true
    }
    private async resolveMaster(): Promise<Endpoint> {
      if (!config.sentinelMaster) throw new Error('REDIS_SENTINEL_INVALID: 请输入 Sentinel 主节点组名')
      for (const seed of seeds) {
        if (!this.connecting) throw new Error('REDIS_CLOSED: Redis 连接已关闭')
        const sentinel = new Redis({
          host: seed.host, port: seed.port,
          username: config.sentinelUsername || undefined, password: config.sentinelPassword || undefined,
          Connector: RoutedConnector, tls: sentinelTls,
          lazyConnect: true, enableReadyCheck: false, enableOfflineQueue: false,
          connectTimeout: timeoutMs, commandTimeout: timeoutMs,
          disconnectTimeout: 500, retryStrategy: null, maxRetriesPerRequest: 0,
          autoResendUnfulfilledCommands: false, autoResubscribe: false,
        })
        sentinel.on('error', () => {})
        this.pending.add(sentinel)
        try {
          await sentinel.connect()
          const response = await sentinel.call('SENTINEL', 'get-master-addr-by-name', config.sentinelMaster)
          return validEndpoint(response)
        } catch {
          if (!this.connecting) throw new Error('REDIS_CLOSED: Redis 连接已关闭')
        } finally { this.pending.delete(sentinel); sentinel.disconnect() }
      }
      throw new Error('REDIS_SENTINEL_UNREACHABLE: 无法通过配置的 Sentinel 发现主节点，请检查地址、认证和主节点组名')
    }
    async connect(): Promise<NetStream> {
      this.connecting = true
      try {
        const address = this.options.name ? await this.resolveMaster() : { host: this.options.host || config.host, port: this.options.port || config.port }
        const raw = await transport.open(address.host, address.port)
        if (!this.connecting) { raw.destroy(); throw new Error('REDIS_CLOSED: Redis 连接已关闭') }
        this.stream = socketLike(raw)
        const tls = this.options.tls
        if (tls) this.stream = await secureStream(raw, address.host, tls, timeoutMs)
        if (!this.connecting) { this.stream.destroy(); throw new Error('REDIS_CLOSED: Redis 连接已关闭') }
        meter(this.stream)
        this.stream.once('error', error => { this.firstError = error })
        return this.stream
      } catch (error) {
        this.firstError = error instanceof Error ? error : new Error('REDIS_CONNECT_FAILED: Redis 连接失败')
        throw this.firstError
      }
    }
  }

  const common: RedisOptions = {
    username: config.username || undefined, password: config.password || undefined,
    db: config.redisDb || 0, tls: dataTls, Connector: RoutedConnector,
    lazyConnect: true, enableReadyCheck: true, enableOfflineQueue: false,
    connectTimeout: timeoutMs, commandTimeout: 15000, disconnectTimeout: 500,
    retryStrategy, maxRetriesPerRequest: 1,
    autoResendUnfulfilledCommands: false, autoResubscribe: false,
    // Retry the connection after failover; the command itself is never replayed.
    reconnectOnError: error => error.message.startsWith('READONLY ') ? 1 : false,
  }
  if (mode === 'cluster') {
    if (config.redisDb) throw new Error('REDIS_CLUSTER_INVALID: Redis Cluster 仅支持 DB 0')
    client = new Cluster(seeds, {
      lazyConnect: true, enableOfflineQueue: false, enableReadyCheck: true,
      redisOptions: common,
      clusterRetryStrategy: retryStrategy, clusterNodeRetryStrategy: retryStrategy,
      maxRedirections: 8, slotsRefreshTimeout: timeoutMs, slotsRefreshInterval: 10000,
      scaleReads: 'master', retryDelayOnFailover: 250,
      // Do not resolve remote-only names locally or substitute IPs before TLS verification.
      dnsLookup: (hostname, callback) => callback(null, hostname),
    })
  } else {
    client = new Redis({
      ...common, host: config.host, port: config.port,
      ...(mode === 'sentinel' ? { name: config.sentinelMaster } : {}),
    })
  }
  readBudgets.set(client, budgetState)
  client.on('error', () => {})
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_resolve, reject) => {
        connectTimer = setTimeout(() => { client!.disconnect(); reject(new Error('REDIS_CONNECT_TIMEOUT: Redis 连接或拓扑发现超时')) }, timeoutMs * (mode === 'sentinel' ? Math.min(seeds.length, 3) + 1 : 2))
      }),
    ])
    if (mode === 'sentinel' && client instanceof Redis) {
      const primary = client
      let checking = false
      const timer = setInterval(() => {
        if (checking || primary.status !== 'ready') return
        checking = true
        void primary.call('ROLE').then(role => {
          if (Array.isArray(role) && role[0] !== 'master') primary.disconnect(true)
        }, () => {}).finally(() => { checking = false })
      }, 5000)
      timer.unref()
      primary.once('end', () => clearInterval(timer))
    }
    budgetState.current = undefined
    return client
  } catch (error) {
    client.disconnect()
    if (initialBudget.exceeded) throw new Error('REDIS_RESULT_LIMIT: Redis 握手或拓扑响应超过8 MiB，连接已断开')
    throw error
  }
  finally { if (connectTimer) clearTimeout(connectTimer) }
}
