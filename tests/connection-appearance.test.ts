import test from 'node:test'
import assert from 'node:assert/strict'
import { newConnectionConfig } from '../src/shared/connection-form'
import { applyAppearance, colorStyle, normalizeAppearance, connectionColors } from '../src/shared/connection-appearance'
import { validateConnection } from '../src/main/connections/validation'
import { createConnectionBackup, readConnectionBackup } from '../src/main/connections/backup'
test('appearance patch is independent of connection identity and credentials', () => {
  const original = validateConnection({ ...newConnectionConfig('mongodb'), name: 'Example', uri: 'mongodb://test:synthetic@localhost/admin' })
  const updated = applyAppearance(original, { color: '#A1B2C3', group: ' Project A ' })
  assert.equal(updated.color, '#a1b2c3')
  assert.equal(updated.group, 'Project A')
  assert.equal(updated.uri, original.uri)
  assert.equal(updated.host, original.host)
  assert.deepEqual(updated.ssh, original.ssh)
  assert.equal(applyAppearance(updated, { color: null }).group, 'Project A')
  assert.equal(applyAppearance(updated, { group: null }).color, '#a1b2c3')
  assert.throws(() => applyAppearance(original, { password: 'bad' }), /INVALID_CONNECTION/)
  assert.throws(() => applyAppearance(original, JSON.parse('{"__proto__":{"password":"bad"}}')), /INVALID_CONNECTION/)
})
test('connection colors and groups round-trip through encrypted backups and reject invalid data', () => {
  const config = validateConnection({ ...newConnectionConfig('mysql'), name: 'Test', password: 'synthetic-secret', color: '#e05252', group: 'Production' })
  const backup = createConnectionBackup([config])
  const [restored] = readConnectionBackup(backup)
  assert.equal(restored!.color, '#e05252')
  assert.equal(restored!.group, 'Production')
  assert.equal(restored!.password, config.password)
  assert(!JSON.stringify(backup).includes('synthetic-secret'))
  assert.throws(() => validateConnection({ ...config, color: 'red; background: url(evil)' }), /INVALID_CONNECTION/)
  assert.throws(() => normalizeAppearance({ group: 'a'.repeat(81) }), /INVALID_CONNECTION/)
  assert.throws(() => normalizeAppearance({ group: 'a\nb' }), /INVALID_CONNECTION/)
  assert.deepEqual(colorStyle('bad'), {})
  assert.deepEqual(colorStyle('#e05252'), { '--connection-color': '#e05252' })
  assert.equal(new Set(connectionColors.map(x => x.color)).size, 36)
})
