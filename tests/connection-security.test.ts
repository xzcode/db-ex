import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionConfig } from '../src/shared/types'
import { validateConnection } from '../src/main/connections/validation'
import { mergeConnectionSecrets, portableConnection, redactConnection } from '../src/main/connections/credentials'
const connection = (): ConnectionConfig => ({
  id: 'test-connection', name: 'Test', kind: 'redis', environment: 'testing', host: 'db.internal', port: 6379,
  username: 'app', password: 'synthetic-test-secret', redisMode: 'sentinel', sentinelMaster: 'primary',
  sentinelUsername: 'sentinel-user', sentinelPassword: 'synthetic-sentinel-secret', nodes: [{ host: 'sentinel.internal', port: 26379 }],
  ssh: { enabled: true, host: 'jump.internal', port: 22, username: 'ssh-user', authMode: 'password', password: 'synthetic-ssh-secret',
    jumps: [{ enabled: true, host: 'first.internal', port: 22, username: 'first', authMode: 'private-key', privateKeyPath: '/test/key', passphrase: 'synthetic-passphrase' }] },
  tls: { enabled: true, caPath: '/test/ca.pem' }, proxy: { enabled: true, host: 'proxy.internal', port: 1080, type: 'socks5', username: 'proxy', password: 'synthetic-proxy-secret' },
})
test('redaction removes every credential including nested jumps and URI', () => {
  const config = connection(); config.uri = 'mongodb://test:synthetic@localhost/test'
  const draft = redactConnection(config)
  assert.deepEqual(new Set(draft.secretFields), new Set(['password', 'sentinelPassword', 'ssh.password', 'ssh.jumps.0.passphrase', 'proxy.password', 'uri']))
  assert(!JSON.stringify(draft.config).includes('synthetic'))
  assert.equal(config.password, 'synthetic-test-secret')
})
test('blank redacted edit keeps secrets only on the same endpoint and auth identity', () => {
  const original = connection(); const draft = redactConnection(original).config
  assert.equal(mergeConnectionSecrets(draft, original).password, original.password)
  draft.nodes![0].host = 'other.internal'
  const changed = mergeConnectionSecrets(draft, original)
  assert.equal(changed.password, undefined)
  assert.equal(changed.sentinelPassword, undefined)
  assert.equal(changed.ssh.password, original.ssh.password)
  draft.ssh.jumps![0].username = 'other-user'
  assert.equal(mergeConnectionSecrets(draft, original).ssh.jumps![0].passphrase, undefined)
})
test('explicit secret clearing is allowlisted and does not pollute prototypes', () => {
  const original = connection(); const draft = redactConnection(original).config
  assert.equal(mergeConnectionSecrets(draft, original, ['password']).password, undefined)
  assert.throws(() => mergeConnectionSecrets(draft, original, ['__proto__.polluted']))
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})
test('URI credentials cannot silently carry over to a different Mongo endpoint', () => {
  const original = connection(); original.kind = 'mongodb'; original.uri = 'mongodb://test:synthetic@localhost/test'
  const draft = redactConnection(original).config; draft.host = 'other.internal'
  assert.equal(mergeConnectionSecrets(draft, original).uri, undefined)
})
test('TLS files remain available when only Sentinel uses TLS', () => {
  const config = connection(); config.tls.enabled = false; config.sentinelTls = true
  const validated = validateConnection(config)
  assert.equal(validated.tls.caPath, '/test/ca.pem')
  assert.equal(validated.tls.enabled, false)
})
test('Mongo URI cannot disable hostname/CA validation or bypass network routing', () => {
  for (const option of ['tlsInsecure=true', 'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true', 'proxyHost=evil', 'tlsCAFile=/test/alternate']) {
    const config = connection(); config.kind = 'mongodb'; config.uri = `mongodb://db.internal/test?${option}`
    assert.throws(() => validateConnection(config))
  }
})
test('runtime validation rejects wrong boolean types, nested jumps, and cluster DB selection', () => {
  const config = connection()
  assert.throws(() => validateConnection({ ...config, tls: { enabled: 'false' } }))
  assert.throws(() => validateConnection({ ...config, redisMode: 'cluster', redisDb: 1 }))
  config.ssh.jumps![0].jumps = [config.ssh.jumps![0]]
  assert.throws(() => validateConnection(config))
})

test('portable configuration cannot import or export an unverified SSH trust decision', () => {
  const config = connection()
  config.ssh.hostFingerprint = 'a'.repeat(64)
  config.ssh.jumps![0].hostFingerprint = 'b'.repeat(64)
  const portable = portableConnection(config)
  assert.equal(portable.config.ssh.hostFingerprint, undefined)
  assert.equal(portable.config.ssh.jumps![0].hostFingerprint, undefined)
  assert.equal(portable.config.id, undefined)
  assert.equal(redactConnection(config).config.ssh.hostFingerprint, 'a'.repeat(64))
})

test('MySQL TLS refuses ambiguous IP identity and accepts an explicit certificate DNS name', () => {
  const config = connection(); config.kind = 'mysql'; config.host = '127.0.0.1'; config.port = 3306
  assert.throws(() => validateConnection(config), /TLS_IDENTITY_REQUIRED/)
  config.tls.servername = 'db.internal'
  assert.equal(validateConnection(config).tls.servername, 'db.internal')
  config.tls.servername = '192.0.2.10'
  assert.throws(() => validateConnection(config), /TLS_IDENTITY_REQUIRED/)
})
