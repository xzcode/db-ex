import assert from 'node:assert/strict'
import test from 'node:test'
import { BSON } from 'mongodb'
import { optimisticFilter, parseEjson, parsePipeline, validateReadDocument } from '../src/main/operations/mongodb'

test('canonical EJSON keeps BSON values exact', () => {
  const source = {
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    big: BSON.Long.fromString('9223372036854775807'),
    money: BSON.Decimal128.fromString('1234567890.123456789'),
    date: new Date('2025-01-01T00:00:00.000Z'),
    bytes: new BSON.Binary(Buffer.from([0, 255, 12])),
  }
  const text = BSON.EJSON.stringify(source, { relaxed: false })
  const parsed = parseEjson(text, '文档') as typeof source
  assert.equal(parsed.big.toString(), '9223372036854775807')
  assert.equal(parsed.money.toString(), '1234567890.123456789')
  assert.equal(BSON.EJSON.stringify(parsed, { relaxed: false }), text)
})

test('aggregation rejects writes and JavaScript even inside nested pipelines', () => {
  assert.equal(parsePipeline('[{"$match":{"active":true}},{"$limit":5}]').length, 2)
  for (const text of [
    '[{"$out":"other"}]', '[{"$merge":"other"}]',
    '[{"$lookup":{"from":"other","pipeline":[{"$merge":"target"}],"as":"items"}}]',
    '[{"$project":{"value":{"$function":{"body":"return 1","args":[],"lang":"js"}}}}]',
    '[{"$match":{"$where":"return true"}}]',
    '[{"$match":{},"$limit":2}]',
  ]) assert.throws(() => parsePipeline(text), /MONGO_POLICY/)
  assert.throws(() => validateReadDocument({ value: new BSON.Code('return true') }), /MONGO_POLICY/)
})

test('Mongo expression validation has bounded depth and rejects prototype properties', () => {
  assert.throws(() => validateReadDocument(JSON.parse('{"__proto__":{"polluted":true}}')), /MONGO_POLICY/)
  let value: Record<string, unknown> = { ok: true }
  for (let i = 0; i < 65; i++) value = { child: value }
  assert.throws(() => validateReadDocument(value), /LIMIT_EXCEEDED/)
})

test('optimistic filters compare the complete original as a literal, not executable operators', () => {
  const original = { _id: { $ne: null }, value: { $where: 'evil' }, nested: [1, 2] }
  assert.deepEqual(optimisticFilter(original), {
    _id: { $eq: original._id }, $expr: { $eq: ['$$ROOT', { $literal: original }] },
  })
  assert.throws(() => optimisticFilter({ name: 'no id' }), /MISSING_ID/)
})
