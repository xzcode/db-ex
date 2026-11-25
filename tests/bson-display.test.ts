import test from 'node:test'
import assert from 'node:assert/strict'
import { BSON } from 'mongodb'
import { formatBsonValue, parseBsonDocument } from '../src/shared/bson-display'
import { describeBsonDocument } from '../src/main/operations/bson-metadata'
import { childType, typeName } from '../src/shared/bson-types'
import { activeTypeColor, newBsonPalette } from '../src/shared/bson-palette'

test('MongoDB browser shows values rather than EJSON wrappers without precision loss', () => {
  const input = {
    id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    i32: new BSON.Int32(9001), i64: BSON.Long.fromString('9223372036854775807'),
    double: new BSON.Double(-0), decimal: BSON.Decimal128.fromString('12345678901234567890.1234567890'),
    date: new Date('2026-11-25T03:43:08.123Z'), flag: false, text: 'NULL',
    nil: null, array: [1, 2], doc: { $oid: 'not-a-real-id' },
    binary: new BSON.Binary(Buffer.from([0, 1, 2, 3, 4])), regex: new BSON.BSONRegExp('a+', 'im'),
  }
  const original = BSON.EJSON.stringify(input, { relaxed: false })
  const canonical = parseBsonDocument(original)!
  const types = describeBsonDocument(input, Object.keys(input))
  const display = (key: string) => formatBsonValue(typeName(childType(types, key)), canonical[key])
  const expected = { id: '507f1f77bcf86cd799439011', i32: '9001', i64: '9223372036854775807', double: '-0.0', decimal: '12345678901234567890.1234567890', date: '2026-11-25 03:43:08.123 UTC', flag: 'false', text: 'NULL', nil: '(NULL)', array: '(Array) 2 个元素', doc: '(Document) 1 个字段', binary: '(Binary) 5 字节', regex: '/a+/im' }
  for (const [key, value] of Object.entries(expected)) assert.equal(display(key), value, key)
  assert.equal(BSON.EJSON.stringify(input, { relaxed: false }), original)
  assert.equal(formatBsonValue('Missing', undefined), '—')
  assert.equal(formatBsonValue('String', '{"$oid":"literal"}'), '{"$oid":"literal"}')
  assert.equal(formatBsonValue('Date', { $date: { $numberLong: '9223372036854775807' } }), '9223372036854775807 ms')
  assert.equal(formatBsonValue('Double', { $numberDouble: 'Infinity' }), 'Infinity')
  assert.equal(formatBsonValue('Unknown', { $oid: 'foo' }), '(Unknown)')
  assert.equal(newBsonPalette().showLabels, false)
  assert.equal(activeTypeColor(newBsonPalette(), 'Null'), undefined)
  assert.equal(activeTypeColor(newBsonPalette(), 'Missing'), undefined)
})
