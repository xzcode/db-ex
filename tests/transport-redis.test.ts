import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { Redis, Cluster } from 'ioredis'
import { createRedisClient, setRedisReadBudget } from '../src/main/connections/redis-client'
import type { ConnectionTransport } from '../src/main/connections/transport'
import type { ConnectionConfig } from '../src/shared/types'

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { name: 'test', kind: 'redis', environment: 'testing', host: 'redis.internal', port: 6379, ssh: { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }, tls: { enabled: false }, connectTimeoutMs: 1000, ...overrides }
}
function resp(value: unknown): string {
  if (value === null) return '$-1\r\n'
  if (value instanceof Error) return `-${value.message}\r\n`
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(resp).join('')}`
  if (typeof value === 'number') return `:${value}\r\n`
  const text = String(value)
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`
}
function protocol(socket: Socket, command: (args: string[]) => unknown): void {
  let buffer = Buffer.alloc(0)
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const line = buffer.indexOf('\r\n')
      if (line < 0) return
      const count = Number(buffer.subarray(1, line).toString())
      const args: string[] = []
      let offset = line + 2
      for (let index = 0; index < count; index++) {
        const end = buffer.indexOf('\r\n', offset)
        if (end < 0) return
        const length = Number(buffer.subarray(offset + 1, end).toString())
        if (buffer.length < end + 2 + length + 2) return
        args.push(buffer.subarray(end + 2, end + 2 + length).toString())
        offset = end + 2 + length + 2
      }
      buffer = buffer.subarray(offset)
      socket.write(resp(command(args)))
    }
  })
}
function common(args: string[], role = 'master'): unknown {
  switch (args[0].toUpperCase()) {
    case 'INFO': return `redis_version:7.0.0\r\nloading:0\r\nrole:${role}\r\n`
    case 'CLIENT': case 'AUTH': case 'SELECT': case 'READONLY': case 'READWRITE': case 'ASKING': return 'OK'
    case 'PING': return 'PONG'
    case 'ROLE': return [role, 0, []]
    default: return null
  }
}
async function fixture(t: TestContext, handler: (args: string[]) => unknown, tls?: { key: Buffer; cert: Buffer }): Promise<{ port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const connection = (socket: Socket): void => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); protocol(socket, handler) }
  const server = tls ? createTlsServer(tls, connection) : createServer(connection)
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { port: address.port, sockets }
}
function routed(t: TestContext, ports: Map<string, number>): { transport: ConnectionTransport; opened: string[] } {
  const sockets = new Set<Socket>()
  const opened: string[] = []
  const transport: ConnectionTransport = {
    open: async (host, port) => {
      opened.push(`${host}:${port}`)
      const target = ports.get(host)
      assert.ok(target, `Unexpected route to ${host}`)
      const socket = createConnection(target, '127.0.0.1')
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      await once(socket, 'connect')
      return socket
    },
    close: async () => { for (const socket of sockets) socket.destroy() },
    forward: async () => { throw new Error('unused') },
    socks: async () => { throw new Error('unused') },
  }
  t.after(() => transport.close())
  return { transport, opened }
}

test('Redis standalone uses routed transport and sends commands through it', async t => {
  const server = await fixture(t, args => args[0].toUpperCase() === 'GET' ? 'routed-value' : common(args))
  const { transport, opened } = routed(t, new Map([['redis.internal', server.port]]))
  const client = await createRedisClient(config(), transport)
  t.after(() => client.disconnect())
  assert.equal(await client.get('key'), 'routed-value')
  assert.deepEqual(opened, ['redis.internal:6379'])
})

test('Sentinel discovery and failover resolve all endpoints through the same transport', async t => {
  let active = 'primary-one.internal'
  const first = await fixture(t, args => common(args, active === 'primary-one.internal' ? 'master' : 'slave'))
  const second = await fixture(t, args => args[0].toUpperCase() === 'GET' ? 'new-primary' : common(args))
  const sentinel = await fixture(t, args => args[0].toUpperCase() === 'SENTINEL' ? [active, '6379'] : common(args))
  const { transport, opened } = routed(t, new Map([['sentinel.internal', sentinel.port], ['primary-one.internal', first.port], ['primary-two.internal', second.port]]))
  const client = await createRedisClient(config({ redisMode: 'sentinel', sentinelMaster: 'mymaster', nodes: [{ host: 'sentinel.internal', port: 26379 }] }), transport)
  t.after(() => client.disconnect())
  assert.ok(client instanceof Redis)
  assert.ok(opened.includes('sentinel.internal:26379'))
  assert.ok(opened.includes('primary-one.internal:6379'))
  active = 'primary-two.internal'
  const ready = once(client, 'ready')
  for (const socket of first.sockets) socket.destroy()
  await ready
  assert.equal(await client.get('key'), 'new-primary')
  assert.ok(opened.includes('primary-two.internal:6379'))
  assert.equal(opened.filter(endpoint => endpoint === 'sentinel.internal:26379').length, 2)
})

test('Cluster discovery and MOVED targets retain hostnames and custom routing', async t => {
  let movedPort = 0
  const moved = await fixture(t, args => {
    if (args[0].toUpperCase() === 'CLUSTER' && args[1].toUpperCase() === 'SLOTS') return [[0, 16383, ['moved.internal', movedPort, 'moved-id']]]
    if (args[0].toUpperCase() === 'CLUSTER' && args[1].toUpperCase() === 'INFO') return 'cluster_state:ok\r\n'
    return args[0].toUpperCase() === 'GET' ? 'redirected' : common(args)
  })
  movedPort = moved.port
  const primary = await fixture(t, args => {
    if (args[0].toUpperCase() === 'CLUSTER' && args[1].toUpperCase() === 'SLOTS') return [[0, 16383, ['primary.internal', 6379, 'primary-id']]]
    if (args[0].toUpperCase() === 'CLUSTER' && args[1].toUpperCase() === 'INFO') return 'cluster_state:ok\r\n'
    if (args[0].toUpperCase() === 'GET') return new Error(`MOVED 12539 moved.internal:${movedPort}`)
    return common(args)
  })
  const { transport, opened } = routed(t, new Map([['seed.internal', primary.port], ['primary.internal', primary.port], ['moved.internal', moved.port]]))
  const client = await createRedisClient(config({ redisMode: 'cluster', nodes: [{ host: 'seed.internal', port: 6379 }] }), transport)
  t.after(() => client.disconnect())
  assert.ok(client instanceof Cluster)
  assert.equal(await client.get('key'), 'redirected')
  assert.ok(opened.includes('seed.internal:6379'))
  assert.ok(opened.includes('primary.internal:6379'))
  assert.ok(opened.includes(`moved.internal:${movedPort}`))
})

test('TLS over a routed socket validates the original database hostname and rejects mismatches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dbex-tls-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=redis.internal', '-addext', 'subjectAltName=DNS:redis.internal'], { stdio: 'ignore' })
  const key = await readFile(keyPath)
  const cert = await readFile(certPath)
  const server = await fixture(t, args => common(args), { key, cert })
  const { transport } = routed(t, new Map([['redis.internal', server.port], ['wrong.internal', server.port]]))
  const client = await createRedisClient(config({ tls: { enabled: true } }), transport, { ca: cert })
  t.after(() => client.disconnect())
  assert.equal(await client.ping(), 'PONG')
  await assert.rejects(createRedisClient(config({ host: 'wrong.internal', tls: { enabled: true } }), transport, { ca: cert }), /REDIS_TLS_FAILED/)
})


test('aggregate plaintext byte budget closes the session before oversized Redis replies complete', async t => {
  const server = await fixture(t, args => args[0].toUpperCase() === 'GET' ? 'x'.repeat(2 * 1024 * 1024) : common(args))
  const { transport } = routed(t, new Map([['redis.internal', server.port]]))
  const client = await createRedisClient(config(), transport)
  t.after(() => client.disconnect())
  const budget = setRedisReadBudget(client, 32 * 1024)!
  await assert.rejects(client.get('large'))
  assert.equal(budget.exceeded, true)
  assert.ok(budget.receivedBytes > budget.limitBytes)
  assert.ok(budget.receivedBytes < 2 * 1024 * 1024, 'must stop before the complete value is parsed')
  setRedisReadBudget(client, undefined)
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.equal(client.status, 'end')
})
