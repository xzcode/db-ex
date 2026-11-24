import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import Redis from 'ioredis'
import { SessionManager } from '../src/main/connections/manager'
import { createTransport } from '../src/main/connections/transport'
import type { ConnectionConfig } from '../src/shared/types'
const enabled = process.env.DB_EX_INTEGRATION === '1'
const ssh = { enabled: false, host: '', port: 22, username: '', authMode: 'agent' as const }
const base = (kind: ConnectionConfig['kind'], port: number): ConnectionConfig => ({ name: `integration-${kind}`, kind, environment: 'testing', host: '127.0.0.1', port, ssh, tls: { enabled: false }, connectTimeoutMs: 8000 })

test('SessionManager routes real MySQL, MongoDB and Redis through authenticated SOCKS and cleans up', { skip: !enabled, timeout: 90000 }, async () => {
  const database = `dbex_session_${randomBytes(6).toString('hex')}`
  const managers = new SessionManager()
  const proxyTransport = await createTransport({ ssh })
  const endpoint = await proxyTransport.socks()
  const proxy = { enabled: true, type: 'socks5' as const, ...endpoint }
  const mysqlAdmin = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'dbex-test' })
  const mongoAdmin = await new MongoClient('mongodb://127.0.0.1:27017').connect()
  const redisAdmin = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true, retryStrategy: null })
  const redisKey = `${database}:key`
  await redisAdmin.connect()
  try {
    await mysqlAdmin.query(`CREATE DATABASE \`${database}\``)
    await mysqlAdmin.query(`CREATE TABLE \`${database}\`.items (id INT PRIMARY KEY, value VARCHAR(100))`)
    await mysqlAdmin.query(`INSERT INTO \`${database}\`.items VALUES (1,'mysql-route')`)
    await mongoAdmin.db(database).collection('items').insertOne({ value: 'mongo-route' })
    await redisAdmin.set(redisKey, 'redis-route')
    const sql = await managers.connect({ ...base('mysql', 3306), proxy, username: 'root', password: 'dbex-test', database })
    assert.equal(sql.writable, false)
    assert((await managers.children(sql.id, database)).some(x => x.entity === 'items'))
    assert.equal((await managers.preview(sql.id, database, 'items')).rows[0].value, 'mysql-route')
    await assert.rejects(managers.execute(sql.id, { action: 'mysql.delete', database, entity: 'items', key: { id: 1 }, original: { id: 1, value: 'mysql-route' }, confirmed: true }), /READ_ONLY/)
    await managers.setWriteAccess(sql.id, true)
    await managers.execute(sql.id, { action: 'mysql.begin', confirmed: true })
    await managers.execute(sql.id, { action: 'mysql.insert', database, entity: 'items', values: { id: 2, value: 'rolled-back' }, confirmed: true })
    await managers.setWriteAccess(sql.id, false)
    assert.equal(managers.info(sql.id).transaction, false)
    assert.equal((await managers.preview(sql.id, database, 'items')).rows.length, 1)
    const mongo = await managers.connect({ ...base('mongodb', 27017), proxy, database })
    assert((await managers.children(mongo.id, database)).some(x => x.entity === 'items'))
    assert.equal((await managers.preview(mongo.id, database, 'items')).rows[0].value, 'mongo-route')
    const redis = await managers.connect({ ...base('redis', 6379), proxy })
    assert.equal((await managers.execute(redis.id, { action: 'redis.get', key: redisKey })).value, 'redis-route')
    await managers.cancel(redis.id)
    assert.throws(() => managers.info(redis.id), /SESSION_CLOSED/)
  } finally {
    await managers.closeAll()
    await proxyTransport.close()
    await mysqlAdmin.query(`DROP DATABASE IF EXISTS \`${database}\``); await mysqlAdmin.end()
    await mongoAdmin.db(database).dropDatabase(); await mongoAdmin.close()
    await redisAdmin.del(redisKey); redisAdmin.disconnect()
  }
})

test('MongoDB saved-field credentials authenticate against the intended authSource and reject invalid passwords', { skip: !enabled, timeout: 40_000 }, async () => {
  const admin = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 8000 })
  const name = 'dbex_auth_' + randomBytes(6).toString('hex')
  const password = randomBytes(24).toString('hex')
  const manager = new SessionManager()
  let created = false
  try {
    await admin.connect()
    await admin.db('admin').command({ createUser: name, pwd: password, roles: [{ role: 'read', db: 'admin' }] })
    created = true
    const original: ConnectionConfig = {
      ...base('mongodb', 27017), name: 'authSource test',
      username: name, password, database: 'admin', authSource: 'admin',
    }
    // A locally redacted edit must restore encrypted-secret-shaped values
    // without exposing the password in the renderer.
    const { redactConnection, mergeConnectionSecrets } = await import('../src/main/connections/credentials')
    const redacted = redactConnection(original)
    assert(!JSON.stringify(redacted.config).includes(password))
    const restored = mergeConnectionSecrets(redacted.config, original)
    assert.equal(restored.password, password)
    const connected = await manager.connect(restored)
    try {
      assert.equal(connected.kind, 'mongodb')
      assert((await manager.roots(connected.id)).some(item => item.database === 'admin'))
    } finally { await manager.disconnect(connected.id) }
    await assert.rejects(manager.connect({ ...original, password: password + 'wrong' }), /MONGO_AUTH_FAILED/)
    await assert.rejects(manager.connect({ ...original, authSource: 'wrong_auth_source' }), /MONGO_AUTH_FAILED/)
  } finally {
    await manager.closeAll()
    if (created) await admin.db('admin').command({ dropUser: name }).catch(() => {})
    await admin.close()
  }
})
