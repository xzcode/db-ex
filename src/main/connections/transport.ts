import { createConnection, createServer, isIP, type Server, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { domainToASCII } from 'node:url'
import type { SshOptions } from '../../shared/types'
import { openSshChain, type SshChain } from './ssh'

export interface ProxyOptions {
  enabled: boolean
  type: 'socks5' | 'http-connect'
  host: string
  port: number
  username?: string
  password?: string
}
export interface TransportOptions {
  ssh: SshOptions & { jumps?: SshOptions[] }
  proxy?: ProxyOptions
  timeoutMs?: number
}
export interface ForwardAddress { host: '127.0.0.1'; port: number }
export interface SocksAddress extends ForwardAddress { username: string; password: string }
export interface ConnectionTransport {
  open(host: string, port: number): Promise<Duplex>
  forward(host: string, port: number): Promise<ForwardAddress>
  socks(): Promise<SocksAddress>
  close(): Promise<void>
}

const MAX_HANDSHAKE = 64 * 1024
const MAX_SOCKETS = 256
function endpoint(host: string, port: number): string {
  if (typeof host !== 'string' || host.length < 1 || host.length > 253 || /[\s\0\r\n/@\\?#]/.test(host)) throw new Error('TRANSPORT_CONFIG_INVALID: 主机名无效')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TRANSPORT_CONFIG_INVALID: 端口无效')
  const normalized = isIP(host) ? host : domainToASCII(host)
  if (!normalized || normalized.length > 253) throw new Error('TRANSPORT_CONFIG_INVALID: 主机名无效')
  return normalized
}

/** A bounded handshake reader which preserves coalesced application bytes. */
class HandshakeReader {
  private buffer: Buffer = Buffer.alloc(0)
  private failure?: Error
  private released = false
  private waiting?: () => void
  private readonly timer: ReturnType<typeof setTimeout>
  constructor(private readonly stream: Duplex, timeoutMs: number) {
    stream.on('data', this.data)
    stream.on('error', this.error)
    stream.on('end', this.end)
    stream.on('close', this.end)
    this.timer = setTimeout(() => this.error(new Error('PROXY_TIMEOUT: 代理握手超时')), timeoutMs)
  }
  private data = (chunk: Buffer): void => {
    if (this.buffer.length + chunk.length > MAX_HANDSHAKE) { this.error(new Error('PROXY_PROTOCOL_ERROR: 代理响应过大')); return }
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wake()
  }
  private error = (error: Error): void => { this.failure ||= error; this.wake() }
  private end = (): void => this.error(new Error('PROXY_CLOSED: 代理在握手期间关闭连接'))
  private wake(): void { const waiting = this.waiting; this.waiting = undefined; waiting?.() }
  private async wait(): Promise<void> { await new Promise<void>(resolve => { this.waiting = resolve }) }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) { if (this.failure) throw this.failure; await this.wait() }
    const result = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return result
  }
  async header(): Promise<Buffer> {
    for (;;) {
      const index = this.buffer.indexOf('\r\n\r\n')
      if (index !== -1) return this.read(index + 4)
      if (this.buffer.length > 16 * 1024) throw new Error('PROXY_PROTOCOL_ERROR: HTTP CONNECT 响应头过大')
      if (this.failure) throw this.failure
      await this.wait()
    }
  }
  release(): void {
    if (this.released) return
    this.released = true
    clearTimeout(this.timer)
    this.stream.pause()
    this.stream.off('data', this.data)
    this.stream.off('error', this.error)
    this.stream.off('end', this.end)
    this.stream.off('close', this.end)
    if (this.buffer.length) this.stream.unshift(this.buffer)
    this.buffer = Buffer.alloc(0)
    // Driver constructors attach listeners in the promise continuation before this tick.
    setImmediate(() => { if (!this.stream.destroyed) this.stream.resume() })
  }
}

async function plainConnect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  endpoint(host, port)
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => fail(new Error('TRANSPORT_TIMEOUT: TCP 连接超时')), timeoutMs)
    const fail = (_error: Error): void => { clearTimeout(timer); socket.destroy(); reject(new Error('TRANSPORT_CONNECT_FAILED: 无法连接到目标主机，请检查网络和端口')) }
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', fail)
      socket.on('error', () => {})
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 10000)
      resolve(socket)
    })
  })
}

function ipv6Bytes(host: string): Buffer {
  let value = host
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number)
    value = value.slice(0, -dotted[1].length) + ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16)
  }
  const parts = value.split('::')
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts[1] ? parts[1].split(':') : []
  const groups = parts.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left
  const result = Buffer.alloc(16)
  groups.forEach((part, index) => result.writeUInt16BE(parseInt(part, 16), index * 2))
  return result
}
function addressBytes(host: string, port: number): Buffer {
  host = endpoint(host, port)
  const kind = isIP(host)
  const address = kind === 4 ? Buffer.from([1, ...host.split('.').map(Number)])
    : kind === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
      : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)])
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(port)
  return Buffer.concat([address, tail])
}
async function readAddress(reader: HandshakeReader, type: number): Promise<{ host: string; port: number }> {
  let host: string
  if (type === 1) host = [...await reader.read(4)].join('.')
  else if (type === 3) {
    const length = (await reader.read(1))[0]
    if (!length) throw new Error('PROXY_PROTOCOL_ERROR: 空目标地址')
    host = (await reader.read(length)).toString('utf8')
  } else if (type === 4) {
    const bytes = await reader.read(16)
    host = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(':')
  } else throw new Error('PROXY_PROTOCOL_ERROR: 不支持的 SOCKS 地址类型')
  const port = (await reader.read(2)).readUInt16BE(0)
  return { host, port }
}

/** Connect via a remote SOCKS5 or HTTP CONNECT proxy. No credential is placed in a URL/error. */
export async function connectProxy(proxy: ProxyOptions, host: string, port: number, timeoutMs = 12000): Promise<Duplex> {
  host = endpoint(host, port)
  endpoint(proxy.host, proxy.port)
  if (proxy.type !== 'socks5' && proxy.type !== 'http-connect') throw new Error('PROXY_CONFIG_INVALID: 不支持的代理类型')
  const socket = await plainConnect(proxy.host, proxy.port, timeoutMs)
  const reader = new HandshakeReader(socket, timeoutMs)
  try {
    if (proxy.type === 'http-connect') {
      const authority = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
      const authentication = proxy.username !== undefined && proxy.username !== ''
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n` : ''
      if (authentication.length > 8192) throw new Error('PROXY_CONFIG_INVALID: 代理认证信息过长')
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authentication}\r\n`)
      const header = (await reader.header()).toString('latin1')
      const status = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(header)?.[1]
      if (status !== '200') throw new Error(status === '407' ? 'PROXY_AUTH_FAILED: HTTP 代理认证失败' : 'PROXY_CONNECT_FAILED: HTTP 代理拒绝连接')
    } else {
      const authenticated = Boolean(proxy.username)
      socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]))
      const greeting = await reader.read(2)
      if (greeting[0] !== 5 || greeting[1] !== (authenticated ? 2 : 0)) throw new Error('PROXY_AUTH_FAILED: SOCKS5 代理不接受所选认证方式')
      if (authenticated) {
        const username = Buffer.from(proxy.username!)
        const password = Buffer.from(proxy.password || '')
        if (username.length > 255 || password.length > 255) throw new Error('PROXY_CONFIG_INVALID: SOCKS5 认证信息超过 255 字节')
        socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]))
        const auth = await reader.read(2)
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error('PROXY_AUTH_FAILED: SOCKS5 代理认证失败')
      }
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addressBytes(host, port)]))
      const response = await reader.read(4)
      if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) throw new Error('PROXY_CONNECT_FAILED: SOCKS5 代理拒绝连接')
      await readAddress(reader, response[3])
    }
    return socket
  } catch (error) { socket.destroy(); throw error }
  finally { reader.release() }
}

function sameSecret(actual: Buffer, expected: string): boolean {
  const value = Buffer.from(expected)
  return actual.length === value.length && timingSafeEqual(actual, value)
}

/** A scoped transport: preserves advertised database hostnames for TLS and topology discovery. */
export async function createTransport(options: TransportOptions): Promise<ConnectionTransport> {
  const timeoutMs = options.timeoutMs ?? 12000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new Error('TRANSPORT_CONFIG_INVALID: 连接超时必须介于 500 和 60000 毫秒')
  const sockets = new Set<Duplex>()
  const servers = new Set<Server>()
  const forwards = new Map<string, Promise<ForwardAddress>>()
  let socksAddress: Promise<SocksAddress> | undefined
  let closed = false
  let chain: SshChain | undefined
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await Promise.all([...servers].map(server => new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })))
    servers.clear()
    await chain?.close()
  }
  const track = (socket: Duplex): Duplex => {
    if (closed || sockets.size >= MAX_SOCKETS) { socket.destroy(); throw new Error(closed ? 'TRANSPORT_CLOSED: 连接已关闭' : 'TRANSPORT_LIMIT: 同时连接数量超过限制') }
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const first = async (host: string, port: number): Promise<Duplex> => {
    endpoint(host, port)
    if (closed) throw new Error('TRANSPORT_CLOSED: 连接已关闭')
    return track(options.proxy?.enabled ? await connectProxy(options.proxy, host, port, timeoutMs) : await plainConnect(host, port, timeoutMs))
  }
  try {
    if (options.ssh.enabled) {
      chain = await openSshChain([...(options.ssh.jumps || []), options.ssh], first, timeoutMs)
      chain.onClose(() => { void close() })
    }
  } catch (error) { await close(); throw error }
  const open = async (host: string, port: number): Promise<Duplex> => {
    endpoint(host, port)
    if (closed) throw new Error('TRANSPORT_CLOSED: 连接已关闭')
    return chain ? track(await chain.open(host, port)) : first(host, port)
  }
  const listen = async (handler: (socket: Socket) => void): Promise<ForwardAddress> => {
    if (closed) throw new Error('TRANSPORT_CLOSED: 连接已关闭')
    if (servers.size >= 32) throw new Error('TRANSPORT_LIMIT: 本地转发端口数量超过限制')
    const server = createServer(socket => {
      try { track(socket); handler(socket) } catch { socket.destroy() }
    })
    servers.add(server)
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => { server.off('error', fail); reject(error) }
        server.once('error', fail)
        server.listen(0, '127.0.0.1', () => { server.off('error', fail); resolve() })
      })
      if (closed) { server.close(); throw new Error('TRANSPORT_CLOSED: 连接已关闭') }
      server.on('error', () => { void close() })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('TRANSPORT_LISTEN_FAILED: 无法分配本地转发端口')
      return { host: '127.0.0.1', port: address.port }
    } catch (error) { server.close(); servers.delete(server); throw error }
  }
  const pipe = (socket: Duplex, upstream: Duplex): void => {
    if (socket.destroyed || closed) { upstream.destroy(); return }
    socket.pipe(upstream).pipe(socket)
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  }
  return {
    open,
    forward(host, port) {
      endpoint(host, port)
      const key = `${host}:${port}`
      let result = forwards.get(key)
      if (!result) {
        result = listen(socket => { void open(host, port).then(upstream => pipe(socket, upstream), () => socket.destroy()) })
        forwards.set(key, result)
        void result.catch(() => forwards.delete(key))
      }
      return result
    },
    socks() {
      if (!socksAddress) {
        const username = randomBytes(16).toString('hex')
        const password = randomBytes(32).toString('hex')
        socksAddress = listen(socket => {
          const reader = new HandshakeReader(socket, timeoutMs)
          void (async () => {
            let upstream: Duplex | undefined
            try {
              const greeting = await reader.read(2)
              if (greeting[0] !== 5 || !greeting[1]) throw new Error('Invalid SOCKS greeting')
              const methods = await reader.read(greeting[1])
              if (!methods.includes(2)) { socket.end(Buffer.from([5, 255])); return }
              socket.write(Buffer.from([5, 2]))
              const auth = await reader.read(2)
              if (auth[0] !== 1 || !auth[1]) throw new Error('Invalid SOCKS authentication')
              const actualUser = await reader.read(auth[1])
              const passwordLength = (await reader.read(1))[0]
              const actualPassword = await reader.read(passwordLength)
              if (!sameSecret(actualUser, username) || !sameSecret(actualPassword, password)) { socket.end(Buffer.from([1, 1])); return }
              socket.write(Buffer.from([1, 0]))
              const request = await reader.read(4)
              if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) { socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return }
              const address = await readAddress(reader, request[3])
              upstream = await open(address.host, address.port)
              if (socket.destroyed) { upstream.destroy(); return }
              reader.release()
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              pipe(socket, upstream)
            } catch { upstream?.destroy(); socket.destroy() }
            finally { reader.release() }
          })()
        }).then(address => ({ ...address, username, password }))
        void socksAddress.catch(() => { socksAddress = undefined })
      }
      return socksAddress
    },
    close,
  }
}
