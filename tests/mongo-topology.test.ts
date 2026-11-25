import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { BSON, MongoClient, MongoNetworkError, MongoServerError } from 'mongodb'
import { SessionManager } from '../src/main/connections/manager'
import { createTransport } from '../src/main/connections/transport'
import type { ConnectionConfig, SshOptions } from '../src/shared/types'

const enabled = process.env.DB_EX_TOPOLOGY === '1'
const ports = [27018, 27019, 27020] as const
const hosts = ports.map(port => `127.0.0.1:${port}`)
const replicaUri = `mongodb://${hosts.join(',')}/?replicaSet=dbex-rs`
const noSsh: SshOptions = { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }

/** Only retry a read-only topology probe. Never retry an uncertain application write. */
async function primary(client: MongoClient, excluded?: string): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const hello = await client.db('admin').command({ hello: 1 }, { timeoutMS: 3000 })
      if (hello.isWritablePrimary && typeof hello.me === 'string' && hello.me !== excluded) {
        assert.ok(hosts.includes(hello.me), 'the primary must belong to the isolated localhost fixture')
        assert.equal(hello.setName, 'dbex-rs')
        assert.deepEqual([...hello.hosts].sort(), [...hosts].sort())
        return hello.me
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
    }
    await delay(250)
  }
  throw new Error('No expected MongoDB primary became available within 30 seconds')
}

test('real MongoDB replica discovery and primary change keep the same session on authenticated SOCKS', {
  skip: !enabled,
  timeout: 120_000,
}, async t => {
  // These fixed loopback ports belong only to scripts/start-mongo-replica.sh.
  // No production URI or externally configured endpoint is accepted here.
  const database = `dbex_topology_${Date.now()}_${randomBytes(4).toString('hex')}`
  const manager = new SessionManager()
  const outerTransport = await createTransport({ ssh: noSsh, timeoutMs: 3000 })
  const proxy = await outerTransport.socks()
  const admin = new MongoClient(replicaUri, {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
    retryWrites: false, retryReads: false, heartbeatFrequencyMS: 500,
  })
  let control: MongoClient | undefined
  let adminConnected = false
  const config: ConnectionConfig = {
    name: 'isolated MongoDB replica topology test', kind: 'mongodb', 
    host: '127.0.0.1', port: ports[0], database,
    nodes: ports.map(port => ({ host: '127.0.0.1', port })), mongoReplicaSet: 'dbex-rs',
    ssh: noSsh, tls: { enabled: false }, connectTimeoutMs: 8000,
    proxy: { enabled: true, type: 'socks5', host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
  }
  try {
    await admin.connect()
    adminConnected = true
    const before = await primary(admin)

    // If the driver silently bypassed SOCKS, this would incorrectly succeed.
    await assert.rejects(manager.connect({ ...config, proxy: { ...config.proxy!, password: `${proxy.password}-wrong` } }), /CONNECTION_FAILED|PROXY|MONGO_TOPOLOGY_FAILED|MONGO_SERVER_SELECTION_FAILED/)
    const session = await manager.connect(config)
    assert.equal(session.writable, false)
    await manager.setWriteAccess(session.id, true)
    const target = { database, entity: 'documents' }
    const first = await manager.execute(session.id, {
      action: 'mongo.insert', ...target, documents: ['{"_id":"before-stepdown","value":1}'], confirmed: true,
    })
    assert.equal(first.affectedRows, 1)
    assert.equal((await manager.execute(session.id, { action: 'mongo.find', ...target })).documents?.length, 1)
    assert.ok((await manager.children(session.id, database, 'collections')).some(node => node.entity === 'documents'))

    // A majority barrier confirms the prior application insert has replicated
    // before intentionally moving the primary; no application write is in flight.
    await admin.db(database).collection<{ _id: string }>('barrier').insertOne({ _id: 'ready' }, {
      writeConcern: { w: 'majority', wtimeoutMS: 5000 }, timeoutMS: 8000,
    })
    control = new MongoClient(`mongodb://${before}/?directConnection=true`, {
      serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 12000,
      retryReads: false, retryWrites: false,
    })
    await control.connect()
    try {
      await control.db('admin').command({ replSetStepDown: 30, secondaryCatchUpPeriodSecs: 5, force: false }, { timeoutMS: 12000 })
    } catch (error) {
      // A state change can interrupt this management reply. The assertion below
      // still requires an actually different elected primary before proceeding.
      const transition = error instanceof MongoNetworkError ||
        (error instanceof MongoServerError && [91, 189, 10107, 11600, 11602].includes(Number(error.code)))
      if (!transition) throw error
    }
    const after = await primary(admin, before)
    assert.notEqual(after, before, 'this must test a real election, not only a reconnect')
    t.diagnostic(`Replica primary changed ${before} -> ${after}; reusing the original authenticated-SOCKS session`)

    // Reuse the original SessionManager id; reconnecting it would hide a broken
    // per-node SOCKS route or driver topology update. Each write is issued once.
    const preserved = await manager.execute(session.id, { action: 'mongo.find', ...target })
    assert.equal(BSON.EJSON.parse(preserved.documents![0], { relaxed: true })._id, 'before-stepdown')
    const second = await manager.execute(session.id, {
      action: 'mongo.insert', ...target, documents: ['{"_id":"after-stepdown","value":2}'], confirmed: true,
    })
    assert.equal(second.affectedRows, 1)
    const found = await manager.execute(session.id, { action: 'mongo.find', ...target, sort: '{"_id":1}' })
    assert.deepEqual(found.documents!.map(text => BSON.EJSON.parse(text, { relaxed: true })._id).sort(), ['after-stepdown', 'before-stepdown'])
    assert.equal(manager.info(session.id).id, session.id)

    // Closing only the authenticated upstream proxy must break database access;
    // a silent direct-connection fallback would make this assertion fail.
    await outerTransport.close()
    await assert.rejects(manager.execute(session.id, { action: 'mongo.find', ...target }))
  } finally {
    await manager.closeAll()
    await control?.close().catch(() => {})
    try {
      if (adminConnected) await admin.db(database).dropDatabase({ timeoutMS: 8000, writeConcern: { w: 'majority', wtimeoutMS: 5000 } })
    } finally {
      await admin.close().catch(() => {})
      await outerTransport.close()
    }
  }
})
