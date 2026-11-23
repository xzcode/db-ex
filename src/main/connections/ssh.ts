import { Client } from 'ssh2'
import { createServer, type Server, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import type { SshOptions } from '../../shared/types'

export interface SshTunnel {
  port: number
  close(): Promise<void>
}

export async function openSshTunnel(
  options: SshOptions,
  destinationHost: string,
  destinationPort: number,
): Promise<SshTunnel> {
  const client = new Client()
  let hostKeySeen = ''
  let server: Server | undefined
  let ready = false
  let settled = false
  const sockets = new Set<Socket>()

  const key = options.authMode === 'private-key' && options.privateKeyPath
    ? await readFile(options.privateKeyPath)
    : undefined
  const agent = options.authMode === 'agent' ? (options.agentSocket || process.env.SSH_AUTH_SOCK) : undefined
  if (options.authMode === 'agent' && !agent) throw new Error('SSH_AUTH_FAILED: 找不到 SSH Agent，请指定 Agent Socket')

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    client.end()
  }

  const port = await new Promise<number>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      for (const socket of sockets) socket.destroy()
      server?.close()
      client.end()
      if (hostKeySeen && !options.hostFingerprint) {
        reject(new Error(`SSH_HOST_KEY_UNTRUSTED: ${hostKeySeen}。请先从可信渠道核对 SHA-256 十六进制主机指纹，再在连接表单中填写。`))
      } else if (hostKeySeen && options.hostFingerprint?.toLowerCase() !== hostKeySeen) {
        reject(new Error(`SSH_HOST_KEY_MISMATCH: 主机密钥指纹变化，当前为 ${hostKeySeen}，已拒绝连接`))
      } else {
        reject(error)
      }
    }

    client.on('error', (error: Error) => { if (!ready) fail(error) })
    client.on('close', () => { if (!ready && !settled) fail(new Error('SSH 连接被关闭')) })
    client.on('ready', () => {
      ready = true
      server = createServer(socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (error, stream) => {
          if (error) { socket.destroy(); return }
          socket.pipe(stream).pipe(socket)
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.destroy())
          socket.on('close', () => stream.destroy())
        })
      })
      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        if (!address || typeof address === 'string') {
          fail(new Error('SSH 本地转发端口分配失败'))
          return
        }
        settled = true
        resolve(address.port)
      })
    })

    try {
      client.connect({
        host: options.host, port: options.port, username: options.username,
        password: options.authMode === 'password' ? options.password : undefined,
        privateKey: key, passphrase: options.passphrase, agent,
        hostHash: 'sha256',
        hostVerifier: (hash: string) => {
          hostKeySeen = String(hash).toLowerCase()
          return Boolean(options.hostFingerprint) && options.hostFingerprint!.toLowerCase() === hostKeySeen
        },
        readyTimeout: 12000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      })
    } catch (error) { fail(error as Error) }
  })

  client.on('close', () => {
    for (const socket of sockets) socket.destroy()
    server?.close()
  })
  return { port, close }
}
