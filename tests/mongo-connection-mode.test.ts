import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionConfig } from '../src/shared/types'
import { validateConnection } from '../src/main/connections/validation'
import { mongoDirectConnection, mongoTopologyMode, mongoUriTlsEnabled } from '../src/main/connections/mongo-topology'
import { mergeConnectionSecrets, redactConnection } from '../src/main/connections/credentials'

const basic = (): ConnectionConfig => ({
  name: 'MongoDB One Host', kind: 'mongodb', environment: 'testing',
  host: '198.51.100.17', port: 27017, database: 'admin', username: 'admin',
  password: 'synthetic-credential', authSource: 'admin',
  ssh: { enabled: false, host: '', port: 22, username: '', authMode: 'agent' },
  tls: { enabled: false }, connectTimeoutMs: 12000,
})

test('single endpoint defaults to direct while explicit replica and multi-seed discovery are preserved', () => {
  const one = validateConnection(basic())
  assert.equal(mongoTopologyMode(one), 'auto')
  assert.equal(mongoDirectConnection(one), true)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoTopology: 'discover' })), false)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoTopology: 'direct' })), true)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoReplicaSet: 'rs0' })), undefined)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), nodes: [{ host: '198.51.100.17', port: 27017 }, { host: '198.51.100.18', port: 27017 }] })), undefined)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), nodes: [{ host: '198.51.100.17', port: 27017 }] })), true)
})

test('legacy mongoDirect settings are preserved, and URI auto mode never overwrites URI topology', () => {
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoDirect: true })), true)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoDirect: false })), true)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), uri: 'mongodb://198.51.100.17:27017/admin?directConnection=false' })), undefined)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), uri: 'mongodb://198.51.100.17:27017/admin?directConnection=true' })), undefined)
  assert.equal(mongoDirectConnection(validateConnection({ ...basic(), mongoTopology: 'discover', uri: 'mongodb://198.51.100.17:27017/admin' })), false)
})

test('reject incompatible explicit direct modes and respect URI directConnection', () => {
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'direct', nodes: [{ host: 'one', port: 27017 }, { host: 'two', port: 27017 }] }), /INVALID_CONNECTION/)
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'direct', uri: 'mongodb+srv://cluster.example.test/' }), /INVALID_CONNECTION/)
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'direct', uri: 'mongodb://one.example.test:27017,two.example.test:27017/' }), /INVALID_CONNECTION/)
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'direct', uri: 'mongodb://single.example.test/?directConnection=false' }), /INVALID_CONNECTION/)
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'discover', uri: 'mongodb://single.example.test/?directConnection=true' }), /INVALID_CONNECTION/)
  assert.throws(() => validateConnection({ ...basic(), mongoTopology: 'invalid' }), /INVALID_CONNECTION/)
})

test('switching topology does not drop saved password, but changing auth endpoint does', () => {
  const previous = validateConnection(basic())
  const redacted = redactConnection(previous).config
  assert.equal(redacted.password, undefined)
  redacted.mongoTopology = 'direct'
  const preserved = mergeConnectionSecrets(redacted, previous)
  assert.equal(preserved.password, previous.password)
  redacted.host = '198.51.100.18'
  assert.equal(mergeConnectionSecrets(redacted, previous).password, undefined)
})

test('MongoDB URI and SRV TLS settings activate certificate loading without changing validation rules', () => {
  assert.equal(mongoUriTlsEnabled('mongodb://db.example.test:27017/admin'), false)
  assert.equal(mongoUriTlsEnabled('mongodb://db.example.test:27017/admin?tls=true'), true)
  assert.equal(mongoUriTlsEnabled('mongodb://db.example.test:27017/admin?ssl=true'), true)
  assert.equal(mongoUriTlsEnabled('mongodb+srv://cluster.example.test/admin'), true)
  assert.equal(mongoUriTlsEnabled('mongodb+srv://cluster.example.test/admin?tls=false'), false)
  assert.equal(mongoUriTlsEnabled(undefined), false)
})

test('Mongo-only form state never blocks MySQL or Redis validation after changing database type', () => {
  assert.equal(validateConnection({ ...basic(), kind: 'mysql', port: 3306, mongoTopology: 'auto' }).kind, 'mysql')
  assert.equal(validateConnection({ ...basic(), kind: 'redis', port: 6379, mongoTopology: 'direct' }).kind, 'redis')
})
