import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
const { Server: SshServer, utils } = ssh2
import { SocksClient } from 'socks'
import { createTransport, connectProxy } from '../src/main/connections/transport'
import { parseSshConfig } from '../src/main/connections/ssh-config'
import type { SshOptions } from '../src/shared/types'

const disabledSsh: SshOptions = { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }
async function startServer(t: TestContext, handler: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); handler(socket) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}
function readBytes(stream: Duplex, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let result = Buffer.alloc(0)
    const timeout = setTimeout(() => finish(new Error('read timeout')), 3000)
    const data = (chunk: Buffer): void => { result = Buffer.concat([result, chunk]); if (result.length >= count) finish() }
    const fail = (): void => finish(new Error('stream closed'))
    const finish = (error?: Error): void => {
      clearTimeout(timeout); stream.off('data', data); stream.off('error', fail); stream.off('close', fail)
      if (error) reject(error); else resolve(result)
    }
    stream.on('data', data); stream.once('error', fail); stream.once('close', fail)
  })
}
async function echo(stream: Duplex, value = 'db-ex-transport'): Promise<void> {
  const result = readBytes(stream, Buffer.byteLength(value))
  stream.write(value)
  assert.equal((await result).toString(), value)
  stream.destroy()
}
async function sshFixture(t: TestContext): Promise<SshOptions> {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  const parsed = utils.parseKey(key)
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed))
  const fingerprint = createHash('sha256').update(parsed.getPublicSSH()).digest('hex')
  const password = randomBytes(16).toString('hex')
  const clients = new Set<Connection>()
  const sockets = new Set<Socket>()
  const server = new SshServer({ hostKeys: [key] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', context => { if (context.method === 'password' && context.username === 'fixture' && context.password === password) context.accept(); else context.reject() })
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      const socket = createConnection({ host: '127.0.0.1', port: info.destPort })
      sockets.add(socket)
      socket.on('error', () => { reject(); socket.destroy() })
      socket.once('close', () => sockets.delete(socket))
      socket.once('connect', () => {
        const channel = accept()
        channel.on('error', () => socket.destroy())
        socket.once('close', () => channel.destroy())
        channel.once('close', () => socket.destroy())
        channel.pipe(socket).pipe(channel)
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { enabled: true, host: '127.0.0.1', port: address.port, username: 'fixture', authMode: 'password', password, hostFingerprint: fingerprint }
}

test('direct forwarding echoes data and closes listeners idempotently', async t => {
  const port = await startServer(t, socket => socket.pipe(socket))
  const transport = await createTransport({ ssh: disabledSsh })
  t.after(() => transport.close())
  await echo(await transport.open('127.0.0.1', port))
  const forward = await transport.forward('127.0.0.1', port)
  assert.deepEqual(await transport.forward('127.0.0.1', port), forward)
  await echo(createConnection(forward.port, forward.host))
  await transport.close(); await transport.close()
  await assert.rejects(transport.open('127.0.0.1', port), /TRANSPORT_CLOSED/)
})

test('local SOCKS requires random authentication and supports an independent SOCKS client', async t => {
  const port = await startServer(t, socket => socket.pipe(socket))
  const transport = await createTransport({ ssh: disabledSsh })
  t.after(() => transport.close())
  const address = await transport.socks()
  const result = await SocksClient.createConnection({ proxy: { host: address.host, port: address.port, type: 5, userId: address.username, password: address.password }, destination: { host: '127.0.0.1', port }, command: 'connect', timeout: 3000 })
  await echo(result.socket)
  await assert.rejects(SocksClient.createConnection({ proxy: { host: address.host, port: address.port, type: 5, userId: address.username, password: 'incorrect' }, destination: { host: '127.0.0.1', port }, command: 'connect', timeout: 3000 }))
  const unauthenticated = createConnection(address.port, address.host)
  const reply = readBytes(unauthenticated, 2)
  unauthenticated.write(Buffer.from([5, 1, 0]))
  assert.deepEqual(await reply, Buffer.from([5, 255]))
  unauthenticated.destroy()
})

test('remote SOCKS5 client supports authentication and leaves application bytes intact', async t => {
  const port = await startServer(t, socket => socket.pipe(socket))
  const proxy = await createTransport({ ssh: disabledSsh })
  t.after(() => proxy.close())
  const address = await proxy.socks()
  const transport = await createTransport({ ssh: disabledSsh, proxy: { ...address, type: 'socks5', enabled: true } })
  t.after(() => transport.close())
  await echo(await transport.open('127.0.0.1', port))
})

test('HTTP CONNECT authenticates, preserves coalesced bytes, and rejects failures without leaking credentials', async t => {
  const user = randomBytes(8).toString('hex')
  const password = randomBytes(16).toString('hex')
  const port = await startServer(t, socket => {
    let input = ''
    const receive = (chunk: Buffer): void => {
      input += chunk.toString()
      if (!input.includes('\r\n\r\n')) return
      socket.off('data', receive)
      assert.ok(input.includes(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`))
      assert.ok(input.startsWith('CONNECT example.internal:6379 HTTP/1.1\r\n'))
      socket.write('HTTP/1.1 200 Connection established\r\n\r\nhello')
      socket.pipe(socket)
    }
    socket.on('data', receive)
  })
  const socket = await connectProxy({ enabled: true, type: 'http-connect', host: '127.0.0.1', port, username: user, password }, 'example.internal', 6379)
  assert.equal((await readBytes(socket, 5)).toString(), 'hello')
  await echo(socket)
  const rejected = await startServer(t, connection => connection.once('data', () => connection.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')))
  await assert.rejects(connectProxy({ enabled: true, type: 'http-connect', host: '127.0.0.1', port: rejected, username: user, password }, 'example.internal', 6379), error => error instanceof Error && /PROXY_AUTH_FAILED/.test(error.message) && !error.message.includes(password))
})

test('two SSH hops route database traffic, validate every key, and clean up', async t => {
  const port = await startServer(t, socket => socket.pipe(socket))
  const first = await sshFixture(t)
  const last = await sshFixture(t)
  const transport = await createTransport({ ssh: { ...last, host: 'second-hop.internal', jumps: [first] } })
  t.after(() => transport.close())
  await echo(await transport.open('database.internal', port))
  await transport.close()
  await assert.rejects(createTransport({ ssh: { ...last, jumps: [{ ...first, hostFingerprint: undefined }] } }), /SSH_HOST_KEY_UNTRUSTED/)
  await assert.rejects(createTransport({ ssh: { ...last, hostFingerprint: '0'.repeat(64), jumps: [first] } }), /SSH_HOST_KEY_MISMATCH/)
})

test('SSH can reach its first hop through an authenticated SOCKS proxy', async t => {
  const port = await startServer(t, socket => socket.pipe(socket))
  const ssh = await sshFixture(t)
  const proxy = await createTransport({ ssh: disabledSsh })
  t.after(() => proxy.close())
  const address = await proxy.socks()
  const transport = await createTransport({ ssh, proxy: { enabled: true, type: 'socks5', ...address } })
  t.after(() => transport.close())
  await echo(await transport.open('database.internal', port))
})

test('ssh_config imports explicit hosts and ordered ProxyJump without executing configuration', () => {
  const result = parseSshConfig(`Host bastion\n HostName bastion.internal\n User jump\n IdentityFile "~/.ssh/jump key"\nHost database\n HostName = db.internal\n ProxyJump bastion\n Port 2222\n IdentityFile "~/.ssh/db key"\nHost blocked\n ProxyCommand touch /tmp/never-execute\nHost *\n User default\n Include other.conf\nMatch exec "touch /tmp/never-execute"\n User ignored\n`, { home: '/home/fixture', username: 'local' })
  const entry = result.hosts.find(host => host.name === 'database')!
  assert.equal(entry.ssh.host, 'db.internal')
  assert.equal(entry.ssh.port, 2222)
  assert.equal(entry.ssh.username, 'default')
  assert.equal(entry.ssh.privateKeyPath, join('/home/fixture', '.ssh/db key'))
  assert.equal(entry.ssh.jumps?.[0].host, 'bastion.internal')
  assert.equal(entry.ssh.jumps?.[0].username, 'jump')
  assert.equal(entry.ssh.hostFingerprint, undefined)
  assert.equal(result.hosts.some(host => host.name === 'blocked'), false)
  assert.ok(result.warnings.some(warning => warning.includes('ProxyCommand')))
  assert.ok(result.warnings.some(warning => warning.includes('Include')))
  assert.ok(result.warnings.some(warning => warning.includes('Match')))
})

test('ssh_config respects first-value wins, negation, and rejects ProxyJump cycles', () => {
  const result = parseSshConfig('Host one\n User first\nHost one\n User second\nHost two\n ProxyJump three\nHost three\n ProxyJump two\nHost * !one\n Port 2200\n', { username: 'local' })
  assert.equal(result.hosts.find(host => host.name === 'one')!.ssh.username, 'first')
  assert.equal(result.hosts.find(host => host.name === 'one')!.ssh.port, 22)
  assert.equal(result.hosts.some(host => host.name === 'two'), false)
  assert.ok(result.warnings.some(warning => warning.includes('循环')))
})
