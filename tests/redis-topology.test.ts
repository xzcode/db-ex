import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, createConnection, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { SessionManager } from '../src/main/connections/manager'
import { createTransport, type SocksAddress } from '../src/main/connections/transport'
import type { ConnectionConfig, ProxyOptions, SshOptions } from '../src/shared/types'

const enabled = process.env.DB_EX_TOPOLOGY === '1'
const ssh: SshOptions = { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }

/** Observe the destination in client handshakes; the production SOCKS server authenticates them. */
async function observedProxy(): Promise<{ proxy: ProxyOptions; destinations: Set<string>; close(): Promise<void> }> {
  const transport = await createTransport({ ssh })
  const target: SocksAddress = await transport.socks()
  const sockets = new Set<Socket>()
  const destinations = new Set<string>()
  const server = createServer(socket => {
    const upstream = createConnection(target.port, target.host)
    for (const current of [socket, upstream]) {
      sockets.add(current)
      current.on('error', () => { socket.destroy(); upstream.destroy() })
      current.once('close', () => { sockets.delete(current); socket.destroy(); upstream.destroy() })
    }
    let header = Buffer.alloc(0)
    const observe = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk])
      if (header.length > 4096) { socket.destroy(); return }
      if (header.length < 2) return
      let offset = 2 + header[1]
      if (header.length < offset + 2) return
      offset += 2 + header[offset + 1]
      if (header.length < offset + 1) return
      offset += 1 + header[offset]
      if (header.length < offset + 4) return
      const type = header[offset + 3]
      offset += 4
      let host: string
      if (type === 1) {
        if (header.length < offset + 6) return
        host = [...header.subarray(offset, offset + 4)].join('.')
        offset += 4
      } else if (type === 3) {
        if (header.length < offset + 1) return
        const length = header[offset++]
        if (header.length < offset + length + 2) return
        host = header.subarray(offset, offset + length).toString()
        offset += length
      } else if (type === 4) {
        if (header.length < offset + 18) return
        host = Array.from({ length: 8 }, (_, index) => header.readUInt16BE(offset + index * 2).toString(16)).join(':')
        offset += 16
      } else { socket.destroy(); return }
      destinations.add(`${host}:${header.readUInt16BE(offset)}`)
      socket.off('data', observe)
      header = Buffer.alloc(0)
    }
    socket.on('data', observe)
    socket.pipe(upstream).pipe(socket)
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return {
      proxy: { enabled: true, type: 'socks5', host: '127.0.0.1', port: address.port, username: target.username, password: target.password },
      destinations,
      async close() {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
        await transport.close()
      },
    }
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); await transport.close(); throw error }
}
function base(proxy: ProxyOptions): ConnectionConfig {
  return { name: 'Isolated Redis topology fixture', kind: 'redis', environment: 'testing', host: '127.0.0.1', port: 6379, ssh, tls: { enabled: false }, proxy, connectTimeoutMs: 5000 }
}
async function openAdmin(port: number, tracked: Set<Redis>): Promise<Redis> {
  // Fixed loopback fixture ports: no env override can point these admin commands at a remote database.
  const client = new Redis({ host: '127.0.0.1', port, lazyConnect: true, enableOfflineQueue: false, retryStrategy: null, maxRetriesPerRequest: 0, connectTimeout: 3000, commandTimeout: 3000 })
  tracked.add(client)
  client.on('error', () => {})
  await client.connect()
  return client
}
/** Failover may close observer sockets too. Reconnect only these read-only probes, never FAILOVER or writes. */
async function observerRead<T>(client: Redis, read: () => Promise<T>): Promise<T | undefined> {
  try {
    if (client.status === 'end') await client.connect()
    if (client.status !== 'ready') return undefined
    return await read()
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(failure.code || '') ||
        failure.message === 'Connection is closed.' ||
        failure.message?.startsWith("Stream isn't writeable")) return undefined
    throw error
  }
}
async function eventually<T>(description: string, probe: () => Promise<T | undefined>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== undefined) return result
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test('real Redis Cluster: authenticated proxy covers all masters, cross-slot CRUD, and per-node SCAN', { skip: !enabled, timeout: 45000 }, async t => {
  const proxy = await observedProxy()
  const manager = new SessionManager()
  const admins = new Set<Redis>()
  const keys = new Set<string>()
  const prefix = `dbex:topology:${randomUUID()}:`
  t.after(async () => {
    try {
      // Try each exact key against each fixture node. Only its owner can delete it.
      await Promise.all([...admins].filter(client => client.status === 'ready').flatMap(client => [...keys].map(key => client.unlink(key).catch(() => 0))))
    } finally { await manager.closeAll(); for (const client of admins) client.disconnect(); await proxy.close() }
  })
  const primary = await openAdmin(7000, admins)
  await openAdmin(7001, admins)
  await openAdmin(7002, admins)
  const slots = await primary.cluster('SLOTS')
  assert.equal(new Set(slots.map(range => range[2][1])).size, 3)
  const byNode = new Map<number, string>()
  for (let candidate = 0; candidate < 100 && byNode.size < 3; candidate++) {
    const name = `${prefix}{slot-${candidate}}`
    const slot = Number(await primary.cluster('KEYSLOT', name))
    const owner = slots.find(range => slot >= range[0] && slot <= range[1])
    assert.ok(owner)
    if (!byNode.has(owner[2][1])) { byNode.set(owner[2][1], name); keys.add(name) }
  }
  assert.equal(byNode.size, 3, 'test keys must span all three masters')
  const session = await manager.connect({ ...base(proxy.proxy), port: 7000, redisMode: 'cluster', nodes: [7000, 7001, 7002].map(port => ({ host: '127.0.0.1', port })) })
  await manager.setWriteAccess(session.id, true)
  for (const [port, key] of byNode) {
    await manager.execute(session.id, { action: 'redis.set', key, value: `owner-${port}`, confirmed: true })
    const result = await manager.execute(session.id, { action: 'redis.get', key })
    assert.equal(result.value, `owner-${port}`)
  }
  const nodes = await manager.execute(session.id, { action: 'redis.nodes' })
  assert.equal(nodes.rows.length, 3)
  const seen = new Set<string>()
  for (const node of nodes.rows) {
    let cursor: string | undefined
    const deadline = Date.now() + 10000
    do {
      assert.ok(Date.now() < deadline, 'bounded per-node SCAN')
      const result = await manager.execute(session.id, { action: 'redis.scan', node: node.id, pattern: `${prefix}*`, cursor })
      for (const row of result.rows) { assert.ok(row.key.startsWith(prefix)); seen.add(row.key) }
      cursor = result.nextCursor
    } while (cursor)
  }
  assert.deepEqual(seen, keys)
  for (const port of [7000, 7001, 7002]) assert.ok(proxy.destinations.has(`127.0.0.1:${port}`), `master ${port} must traverse the authenticated proxy`)
  const deleted = await manager.execute(session.id, { action: 'redis.delete', keys: [...keys], confirmed: true })
  assert.equal(deleted.affectedRows, 3)
  for (const key of keys) assert.equal((await manager.execute(session.id, { action: 'redis.get', key })).redisType, 'none')
})

test('real Redis Sentinel: authenticated proxy, failover rediscovery, and no replay of a submitted write', { skip: !enabled, timeout: 75000 }, async t => {
  const proxy = await observedProxy()
  const manager = new SessionManager()
  const admins = new Set<Redis>()
  const prefix = `dbex:sentinel:${randomUUID()}:`
  const before = `${prefix}before`, counter = `${prefix}counter`, after = `${prefix}after`
  const keys = [before, counter, after]
  let sentinel: Redis | undefined
  t.after(async () => {
    try { await Promise.all([...admins].filter(client => client !== sentinel && client.status === 'ready').flatMap(client => keys.map(key => client.unlink(key).catch(() => 0)))) }
    finally { await manager.closeAll(); for (const client of admins) client.disconnect(); await proxy.close() }
  })
  sentinel = await openAdmin(26379, admins)
  const dataNodes = new Map([[6380, await openAdmin(6380, admins)], [6381, await openAdmin(6381, admins)]])
  const initialAddress = await sentinel.call('SENTINEL', 'get-master-addr-by-name', 'dbex-primary') as string[]
  const initialPort = Number(initialAddress[1])
  const initialMaster = dataNodes.get(initialPort)
  assert.ok(initialMaster)
  const session = await manager.connect({ ...base(proxy.proxy), port: initialPort, redisMode: 'sentinel', sentinelMaster: 'dbex-primary', nodes: [{ host: '127.0.0.1', port: 26379 }] })
  await manager.setWriteAccess(session.id, true)
  await manager.execute(session.id, { action: 'redis.set', key: before, value: 'replicated-before-failover', confirmed: true })
  await manager.execute(session.id, { action: 'redis.set', key: counter, value: '0', confirmed: true })
  await manager.execute(session.id, { action: 'redis.mutate', key: counter, type: 'string', command: 'INCRBY', args: ['1'], confirmed: true })
  const initialReplica = [...dataNodes.entries()].find(([port]) => port !== initialPort)![1]
  await eventually('the replica to contain both application writes before failover', async () => {
    const values = await initialReplica.mget(before, counter)
    return values[0] === 'replicated-before-failover' && values[1] === '1' ? true : undefined
  }, 10000)
  await sentinel.call('SENTINEL', 'FAILOVER', 'dbex-primary')
  const promotedPort = await eventually('Sentinel to advertise a promoted master', async () => {
    const response = await sentinel!.call('SENTINEL', 'get-master-addr-by-name', 'dbex-primary') as string[]
    const port = Number(response[1])
    return port !== initialPort && dataNodes.has(port) ? port : undefined
  })
  const promoted = dataNodes.get(promotedPort)!
  await eventually('the old master to become a replica', async () => {
    const role = await observerRead(initialMaster, () => initialMaster.call('ROLE') as Promise<unknown[]>)
    return role?.[0] === 'slave' ? true : undefined
  })

  // Submit this mutation exactly once. A READONLY failure must reconnect without replaying it.
  let acknowledged = false
  try {
    await manager.execute(session.id, { action: 'redis.mutate', key: counter, type: 'string', command: 'INCRBY', args: ['1'], confirmed: true })
    acknowledged = true
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /READONLY|closed|ready|offline|writeable|writable|连接/i)
  }
  const observedCounter = await eventually('the existing session to reconnect to the promoted master', async () => {
    try {
      const result = await manager.execute(session.id, { action: 'redis.get', key: counter })
      if (!proxy.destinations.has(`127.0.0.1:${promotedPort}`)) return undefined
      return result.value
    } catch { return undefined }
  })
  assert.equal(observedCounter, acknowledged ? '2' : '1', 'the submitted mutation must never be replayed after reconnect')
  assert.equal((await manager.execute(session.id, { action: 'redis.get', key: before })).value, 'replicated-before-failover')
  await manager.execute(session.id, { action: 'redis.set', key: after, value: 'written-to-promoted-master', confirmed: true })
  const persisted = await eventually('the promoted-node observer to reconnect', () => observerRead(promoted, () => promoted.get(after)))
  assert.equal(persisted, 'written-to-promoted-master')
  const nodes = await manager.execute(session.id, { action: 'redis.nodes' })
  assert.equal(nodes.rows[0].port, String(promotedPort), 'node metadata must report the current primary')
  assert.equal((await manager.execute(session.id, { action: 'redis.get', key: after })).value, 'written-to-promoted-master')
  for (const port of [26379, initialPort, promotedPort]) assert.ok(proxy.destinations.has(`127.0.0.1:${port}`), `Sentinel/primary ${port} must traverse the authenticated proxy`)
})
