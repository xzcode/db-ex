import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionDisplayEndpoint, initialAuth, initialEntry, mongoUriAddress, newConnectionConfig, prepareConnection } from '../src/shared/connection-form'
import { mergeConnectionSecrets, redactConnection } from '../src/main/connections/credentials'
import { validateConnection } from '../src/main/connections/validation'
test('database chooser defaults and unnamed connection tests', () => {
  for (const [kind, port] of [['mysql', 3306], ['mongodb', 27017], ['redis', 6379]] as const) {
    const config = newConnectionConfig(kind)
    assert.equal(config.port, port)
    assert.equal(config.username, kind === 'mysql' ? 'root' : '')
    assert.throws(() => prepareConnection(config, { entry: 'fields', auth: initialAuth(config) }), /INVALID_CONNECTION/)
    assert.ok(prepareConnection(config, { entry: 'fields', auth: initialAuth(config), allowUnnamed: true }).config.name)
  }
})
test('URI entry never submits hidden field authentication or topology overrides', () => {
  const config = newConnectionConfig('mongodb')
  Object.assign(config, { name: 'URI', host: 'old.example.test', username: 'field', password: 'field-secret', database: 'old', mongoReplicaSet: 'oldrs', mongoTopology: 'discover', nodes: [{ host: 'old.example.test', port: 27017 }], uri: 'mongodb://uriuser:secret@db.example.test:27017/admin?directConnection=true' })
  const input = prepareConnection(config, { entry: 'uri', auth: 'password' })
  assert.equal(input.config.uri, config.uri)
  assert.equal(input.config.host, '')
  assert.equal(input.config.username, '')
  assert.equal(input.config.password, '')
  assert.equal(input.config.mongoTopology, 'auto')
  assert.deepEqual(input.config.nodes, [])
  assert.equal(validateConnection(input.config).uri, config.uri)
  assert.equal(mongoUriAddress(config.uri), 'db.example.test:27017')
  assert.equal(mongoUriAddress('mongodb://user:secret'), undefined)
  assert.equal(mongoUriAddress('mongodb+srv://user:secret@cluster.example.test/?retryWrites=true'), 'cluster.example.test')
  assert.equal(mongoUriAddress('mongodb://u:p@[::1]:27017,db.example.test:27018/'), '[::1]:27017,db.example.test:27018')
})
test('saved URI is retained without exposing it and host mode explicitly clears it', () => {
  const old = validateConnection({ ...newConnectionConfig('mongodb'), id: 'saved', name: 'Existing', host: 'legacy.example.test', username: 'legacy', uri: 'mongodb://u:p@db.example.test/admin', mongoTopology: 'auto' })
  const draft = redactConnection(old)
  assert.equal(initialEntry(draft), 'uri')
  assert.equal(draft.config.uri, undefined)
  const retained = prepareConnection({ ...draft.config, name: 'Renamed' }, { entry: 'uri', auth: 'none', draft })
  assert.equal(mergeConnectionSecrets(retained.config, old, retained.clearSecrets).uri, old.uri)
  const changed = prepareConnection({ ...draft.config, host: 'other.example.test', name: 'Changed' }, { entry: 'fields', auth: 'none', draft })
  const merged = mergeConnectionSecrets(changed.config, old, changed.clearSecrets)
  assert.equal(merged.uri, undefined)
  assert.equal(merged.password, undefined)
  assert.equal(merged.username, '')
  assert.throws(() => prepareConnection({ ...newConnectionConfig('mongodb'), name: 'Empty URI' }, { entry: 'uri', auth: 'none' }), /URI/)
})
test('explicit no authentication removes saved password; unchanged password mode retains it', () => {
  const old = validateConnection({ ...newConnectionConfig('redis'), id: 'saved', name: 'Redis', username: 'app', password: 'secret' })
  const draft = redactConnection(old)
  assert.equal(initialAuth(draft.config, draft), 'password')
  const retain = prepareConnection(draft.config, { entry: 'fields', auth: 'password', draft })
  assert.equal(mergeConnectionSecrets(retain.config, old, retain.clearSecrets).password, 'secret')
  const none = prepareConnection(draft.config, { entry: 'fields', auth: 'none', draft })
  assert.equal(mergeConnectionSecrets(none.config, old, none.clearSecrets).password, undefined)
})
test('multi-node profiles display the active seed and Redis cluster uses DB 0', () => {
  const config = { ...newConnectionConfig('redis'), name: 'Cluster', redisMode: 'cluster' as const, redisDb: 4, nodes: [{ host: 'seed.example.test', port: 6380 }] }
  const input = prepareConnection(config, { entry: 'fields', auth: 'none' })
  assert.equal(input.config.redisDb, 0)
  assert.deepEqual(connectionDisplayEndpoint(input.config), { host: 'seed.example.test', port: 6380 })
  assert.equal(validateConnection(input.config).redisDb, 0)
})
