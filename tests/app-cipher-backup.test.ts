import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionConfig } from '../src/shared/types'
import { isAppEncrypted, openStored, seal, unseal } from '../src/main/storage/app-cipher'
import { createConnectionBackup, readConnectionBackup } from '../src/main/connections/backup'
import { portableConnection } from '../src/main/connections/credentials'
const sample = (): ConnectionConfig => ({
  id: 'original-id', name: '测试连接', kind: 'mongodb', 
  host: '', port: 27017, uri: 'mongodb://test:synthetic-uri@db.example.test/admin',
  username: 'test', password: 'synthetic-db-password',
  ssh: { enabled: true, host: 'jump.example.test', port: 22, username: 'ssh-user', authMode: 'password',
    password: 'synthetic-ssh-password', hostFingerprint: 'a'.repeat(64),
    jumps: [{ enabled: true, host: 'hop.example.test', port: 22, username: 'hop', authMode: 'private-key',
      privateKeyPath: '/test/key', passphrase: 'synthetic-key-passphrase', hostFingerprint: 'b'.repeat(64) }] },
  tls: { enabled: false },
  proxy: { enabled: true, type: 'socks5', host: 'proxy.example.test', port: 1080, username: 'proxy', password: 'synthetic-proxy-password' },
})
test('built-in AES-GCM requires no OS key or user secret, and uses a new nonce every time', () => {
  const value = sample()
  const first = seal(value)
  const second = seal(value)
  assert(isAppEncrypted(first))
  assert.notEqual(first, second)
  assert(!first.includes('synthetic'))
  assert.deepEqual(unseal(first), value)
  let legacyCalls = 0
  assert.deepEqual(openStored(first, () => { legacyCalls++; throw new Error('keyring forbidden') }), value)
  assert.equal(legacyCalls, 0)
  assert.deepEqual(openStored('old-opaque-data', legacy => { legacyCalls++; assert.equal(legacy, 'old-opaque-data'); return value }), value)
  assert.equal(legacyCalls, 1)
  assert.throws(() => openStored('dbex:v99:invalid', () => { legacyCalls++; return value }), /DBEX_DECRYPT_ERROR/)
  assert.equal(legacyCalls, 1)
})
test('tampering and cross-purpose decryption are rejected', () => {
  const data = seal(sample(), 'connections-export')
  const fields = data.split(':')
  const bytes = Buffer.from(fields[4]!, 'base64url')
  bytes[0] = bytes[0]! ^ 1
  fields[4] = bytes.toString('base64url')
  assert.throws(() => unseal(fields.join(':'), 'connections-export'), /DBEX_DECRYPT_ERROR/)
  assert.throws(() => unseal(data), /DBEX_DECRYPT_ERROR/)
  assert.throws(() => unseal(data.slice(0, -5), 'connections-export'), /DBEX_DECRYPT_ERROR/)
})
test('portable backup restores full credentials, URI-only profiles and SSH paths, without importing trust or IDs', () => {
  const config = sample()
  const redis: ConnectionConfig = { ...sample(), kind: 'redis', host: 'redis.example.test', port: 6379, uri: undefined,
    redisMode: 'sentinel', sentinelMaster: 'primary', sentinelUsername: 'sentinel', sentinelPassword: 'synthetic-sentinel',
    nodes: [{ host: 'sentinel.example.test', port: 26379 }] }
  const backup = createConnectionBackup([config, redis])
  const text = JSON.stringify(backup)
  assert(!text.includes('synthetic'))
  assert(!text.includes('jump.example.test'))
  const [mongo, restoredRedis] = readConnectionBackup(JSON.parse(text))
  assert.equal(mongo!.id, undefined)
  assert.equal(mongo!.host, '')
  assert.equal(mongo!.uri, config.uri)
  assert.equal(mongo!.password, config.password)
  assert.equal(mongo!.ssh.password, config.ssh.password)
  assert.equal(mongo!.ssh.jumps![0]!.passphrase, config.ssh.jumps![0]!.passphrase)
  assert.equal(mongo!.ssh.jumps![0]!.privateKeyPath, '/test/key')
  assert.equal(mongo!.proxy!.password, config.proxy!.password)
  assert.equal(mongo!.ssh.hostFingerprint, undefined)
  assert.equal(mongo!.ssh.jumps![0]!.hostFingerprint, undefined)
  assert.equal(restoredRedis!.sentinelPassword, redis.sentinelPassword)
})
test('legacy templates still import, but never gain credentials or trust', () => {
  const template = portableConnection(sample())
  const [config] = readConnectionBackup({ format: 'db-ex-connections', version: 1, connections: [template] })
  assert.equal(config!.host, 'localhost')
  assert.equal(config!.uri, undefined)
  assert.equal(config!.password, undefined)
  assert.equal(config!.ssh.password, undefined)
  assert.equal(config!.ssh.hostFingerprint, undefined)
  assert.throws(() => readConnectionBackup({ format: 'db-ex-connections', version: 3 }), /版本/)
  assert.throws(() => readConnectionBackup({ format: 'db-ex-connections', version: 2, encrypted: seal(Array(201).fill(sample()), 'connections-export') }), /200/)
  assert.throws(() => readConnectionBackup({ format: 'db-ex-connections', version: 2, encrypted: seal([sample(), { kind: 'invalid' }], 'connections-export') }), /INVALID_CONNECTION/)
})

test('legacy environment metadata is ignored without losing profile data or secrets', () => {
  const original = { ...sample(), color: '#123abc', group: 'Project / Region 42' }
  const { environment: _discard, ...expected } = { ...original, environment: 'production' }
  for (const legacy of ['development', 'testing', 'production', 'custom-environment-100', undefined]) {
    const old = { ...original, environment: legacy }
    const [restored] = readConnectionBackup({ format: 'db-ex-connections', version: 2, encrypted: seal([old], 'connections-export') })
    assert.equal(Object.hasOwn(restored!, 'environment'), false)
    assert.equal(restored!.name, expected.name)
    assert.equal(restored!.uri, expected.uri)
    assert.equal(restored!.password, expected.password)
    assert.equal(restored!.ssh.password, expected.ssh.password)
    assert.equal(restored!.proxy!.password, expected.proxy!.password)
    assert.equal(restored!.color, expected.color)
    assert.equal(restored!.group, expected.group)
    const exported = createConnectionBackup([restored!])
    assert.equal(Object.hasOwn(unseal<Record<string, unknown>[]>(exported.encrypted, 'connections-export')[0]!, 'environment'), false)
  }
  const legacyTemplate = portableConnection({ ...original, environment: 'production' } as ConnectionConfig)
  const [fromV1] = readConnectionBackup({ format: 'db-ex-connections', version: 1, connections: [legacyTemplate] })
  assert.equal(Object.hasOwn(fromV1!, 'environment'), false)
  assert.equal(fromV1!.group, original.group)
  assert.equal(fromV1!.color, original.color)
})
