import test from 'node:test'
import assert from 'node:assert/strict'
import { BSON } from 'mongodb'
import { describeBsonDocument } from '../src/main/operations/bson-metadata'
import { validateMongoDocumentEdit } from '../src/main/operations/mongodb'
import { formatMongoDocument, parseMongoDocumentEditor } from '../src/shared/bson-editor'

test('typed document editor round-trips actual BSON data and exact numeric types', () => {
  const source = {
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    control_port: new BSON.Int32(19107),
    version: BSON.Long.fromString('9223372036854775807'),
    decimal: BSON.Decimal128.fromString('12345678901234567890.1234567890'),
    double: new BSON.Double(-0), date: new Date('2026-11-25T03:43:08.123Z'),
    nested: { name: 'ObjectId("literal")', values: [new BSON.Int32(1), '1', null, true] },
    binary: new BSON.Binary(Buffer.from([0, 255, 12])),
    regex: new BSON.BSONRegExp('a+', 'im'), min: new BSON.MinKey(), max: new BSON.MaxKey(),
  }
  const canonical = BSON.EJSON.stringify(source, { relaxed: false })
  const formatted = formatMongoDocument(canonical, describeBsonDocument(source, Object.keys(source)))
  assert.equal(formatted.syntax, 'typed')
  assert.match(formatted.text, /ObjectId\("507f1f77bcf86cd799439011"\)/)
  assert.match(formatted.text, /Int32\("19107"\)/)
  assert.match(formatted.text, /Long\("9223372036854775807"\)/)
  const restored = parseMongoDocumentEditor(formatted.text)
  assert.equal(restored, canonical)
  validateMongoDocumentEdit(restored, canonical)
})
test('typed editor cannot execute expressions, accept duplicate keys or silently lose integer precision', () => {
  for (const input of [
    '{"x":eval("1")}', '{"x":ObjectId("bad")}', '{"x":Long("9223372036854775808")}',
    '{"x":Int32("2147483648")}', '{"x":Double("1e999")}', '{"x":Double("1e-999")}',
    '{"x":ISODate("2026-02-31T00:00:00Z")}', '{"x":ObjectId("507f1f77bcf86cd799439011").toString()}',
    '{"x":1,"x":2}', '{"__proto__":{}}', '{"x":{"$oid":"literal"}}', '{"x":1}; db.dropDatabase()',
    '{"x":9223372036854775808}', '{"x":BinData(0,"%%%")}', '{"x":Timestamp(-1,0)}',
  ]) assert.throws(() => parseMongoDocumentEditor(input), /BSON_EDITOR_INVALID/, input)
  assert.deepEqual(JSON.parse(parseMongoDocumentEditor('{"a":9007199254740993,"b":1,"c":1.5}')), { a: { $numberLong: '9007199254740993' }, b: { $numberInt: '1' }, c: { $numberDouble: '1.5' } })
  const a = parseMongoDocumentEditor('{"_id":Int32("1")}')
  const b = parseMongoDocumentEditor('{"_id":Long("1")}')
  assert.throws(() => validateMongoDocumentEdit(b, a), /IMMUTABLE_ID/)
  assert.throws(() => validateMongoDocumentEdit('{"x":true}', a), /IMMUTABLE_ID/)
})
test('unknown and literal EJSON-looking document shapes fall back without rewriting original data', () => {
  const raw = '{"x":{"$oid":"507f1f77bcf86cd799439011"}}'
  assert.equal(formatMongoDocument(raw).syntax, 'ejson')
  const metadata = describeBsonDocument({ x: { $oid: '507f1f77bcf86cd799439011' } }, ['x'])
  assert.equal(formatMongoDocument(raw, metadata).syntax, 'ejson')
})
