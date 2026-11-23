import ssh2 from 'ssh2'
import type { Client, ClientChannel } from 'ssh2'
import { createServer, type Socket } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { SshOptions } from '../../shared/types'

export interface SshTunnel {
  port: number
  close(): Promise<void>
}

export interface SshChain {
  open(host: string, port: number): Promise<Duplex>
  close(): Promise<void>
  onClose(listener: () => void): void
}

function matchesFingerprint(expected: string | undefined, actual: string): boolean {
  if (!expected || !/^[a-fA-F0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

/** Build a chain without a shell, agent forwarding, or implicit host-key trust. */
export async function openSshChain(
  hops: SshOptions[],
  openFirst?: (host: string, port: number) => Promise<Duplex>,
  timeoutMs = 12000,
): Promise<SshChain> {
  if (!hops.length || hops.length > 4) throw new Error('SSH_CONFIG_INVALID: SSH 链必须包含 1 至 4 个节点')
  const clients: Client[] = []
  const streams = new Set<Duplex>()
  const listeners = new Set<() => void>()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const stream of streams) stream.destroy()
    streams.clear()
    for (const client of [...clients].reverse()) client.destroy()
    for (const listener of listeners) listener()
    listeners.clear()
  }
  const track = (stream: Duplex): Duplex => {
    if (closed) { stream.destroy(); throw new Error('SSH_CLOSED: SSH 连接已关闭') }
    streams.add(stream)
    stream.on('error', () => {})
    stream.once('close', () => streams.delete(stream))
    return stream
  }
  const forward = (client: Client, host: string, port: number): Promise<Duplex> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('SSH_CLOSED: SSH 连接已关闭')); return }
    let settled = false
    const finish = (error?: Error, stream?: ClientChannel): void => {
      if (settled) { stream?.destroy(); return }
      settled = true
      clearTimeout(timer)
      client.off('close', ended)
      if (error) reject(error)
      else if (stream) { try { resolve(track(stream)) } catch (failure) { reject(failure) } }
    }
    const ended = (): void => finish(new Error('SSH_CLOSED: SSH 连接已关闭'))
    const timer = setTimeout(() => finish(new Error('SSH_FORWARD_TIMEOUT: SSH 转发超时')), timeoutMs)
    client.once('close', ended)
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) finish(new Error('SSH_FORWARD_FAILED: 跳板机无法访问目标地址或不允许 TCP 转发'))
        else finish(undefined, stream)
      })
    } catch { finish(new Error('SSH_FORWARD_FAILED: SSH 转发无法建立')) }
  })

  try {
    for (const [index, options] of hops.entries()) {
      let key: Buffer | undefined
      if (options.authMode === 'private-key') {
        if (!options.privateKeyPath) throw new Error('SSH_CONFIG_INVALID: 请选择 SSH 私钥')
        const size = (await stat(options.privateKeyPath)).size
        if (size > 1024 * 1024) throw new Error('SSH_CONFIG_INVALID: SSH 私钥文件过大')
        key = await readFile(options.privateKeyPath)
      }
      const agent = options.authMode === 'agent' ? options.agentSocket || process.env.SSH_AUTH_SOCK : undefined
      if (options.authMode === 'agent' && !agent) throw new Error('SSH_AUTH_FAILED: 找不到 SSH Agent，请指定 Agent Socket')
      const socket = index > 0
        ? await forward(clients[index - 1], options.host, options.port)
        : openFirst ? track(await openFirst(options.host, options.port)) : undefined
      const client = new ssh2.Client()
      clients.push(client)
      let seen = ''
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          client.off('close', earlyClose)
          if (error) {
            if (seen && !options.hostFingerprint) reject(new Error(`SSH_HOST_KEY_UNTRUSTED: ${seen}。第 ${index + 1} 跳 ${options.host}:${options.port}，请从可信渠道核对并填写指纹。`))
            else if (seen && !matchesFingerprint(options.hostFingerprint, seen)) reject(new Error(`SSH_HOST_KEY_MISMATCH: 第 ${index + 1} 跳 ${options.host}:${options.port} 当前指纹 ${seen}，已拒绝连接`))
            else reject(error)
          } else resolve()
        }
        const earlyClose = (): void => finish(new Error('SSH_CLOSED: SSH 握手期间连接关闭'))
        const timer = setTimeout(() => finish(new Error('SSH_CONNECT_TIMEOUT: SSH 握手超时')), timeoutMs)
        client.on('error', () => { finish(new Error('SSH_AUTH_FAILED: SSH 连接或身份验证失败')); if (settled) void close() })
        client.once('close', earlyClose)
        client.once('ready', () => {
          if (closed) { finish(new Error('SSH_CLOSED: SSH 连接已关闭')); return }
          finish()
          client.once('close', () => { void close() })
        })
        try {
          client.connect({
            host: options.host, port: options.port, username: options.username,
            sock: socket,
            password: options.authMode === 'password' ? options.password : undefined,
            privateKey: key, passphrase: options.passphrase, agent,
            hostHash: 'sha256',
            hostVerifier: (hash: string) => { seen = hash.toLowerCase(); return matchesFingerprint(options.hostFingerprint, seen) },
            readyTimeout: timeoutMs, keepaliveInterval: 10000, keepaliveCountMax: 3,
            agentForward: false,
          })
        } catch { finish(new Error('SSH_CONFIG_INVALID: SSH 连接配置无效')) }
      })
    }
    return {
      open: (host, port) => forward(clients[clients.length - 1], host, port),
      close,
      onClose(listener) { if (closed) listener(); else listeners.add(listener) },
    }
  } catch (error) { await close(); throw error }
}

/** Compatibility wrapper for a fixed one-hop forward. New callers should use createTransport. */
export async function openSshTunnel(options: SshOptions, destinationHost: string, destinationPort: number): Promise<SshTunnel> {
  const chain = await openSshChain([options])
  const sockets = new Set<Socket>()
  let closing = false
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    void chain.open(destinationHost, destinationPort).then(stream => {
      if (socket.destroyed) { stream.destroy(); return }
      socket.pipe(stream).pipe(socket)
      socket.once('close', () => stream.destroy())
      stream.once('close', () => socket.destroy())
      stream.on('error', () => socket.destroy())
    }, () => socket.destroy())
  })
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
    await chain.close()
  }
  chain.onClose(() => { void close() })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    server.on('error', () => { void close() })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SSH_FORWARD_FAILED: 无法分配本地转发端口')
    return { port: address.port, close }
  } catch (error) { await close(); throw error }
}
