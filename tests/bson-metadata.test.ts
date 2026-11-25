import test from 'node:test'
import assert from 'node:assert/strict'
import { BSON } from 'mongodb'
import { describeBsonDocument, newTypeBudget } from '../src/main/operations/bson-metadata'
import { childType, gridBsonType, typeName, bsonTypes } from '../src/shared/bson-types'
import { activeTypeColor, defaultBsonColors, newBsonPalette, normalizeBsonPalette, typeColor } from '../src/shared/bson-palette'

test('BSON types distinguish real wrapper values, null, absent fields and nested data', () => {
  const source = {
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'), score: new BSON.Int32(7),
    double: new BSON.Double(7), long: BSON.Long.fromString('9223372036854775807'),
    money: BSON.Decimal128.fromString('7.00'), flag: true, text: 'NULL',
    date: new Date('2025-01-01T00:00:00.000Z'), bytes: new BSON.Binary(Buffer.from([1, 2])),
    regex: new BSON.BSONRegExp('a', 'imx'), nullable: null,
    array: [new BSON.Int32(1), '1', { value: new BSON.Double(1) }],
    literal: { $numberInt: '7' }, min: new BSON.MinKey(), max: new BSON.MaxKey(),
  }
  const decoded = BSON.deserialize(BSON.serialize(source), { promoteValues: false, promoteLongs: false, bsonRegExp: true })
  const tree = describeBsonDocument(decoded, Object.keys(decoded), newTypeBudget())
  for (const [key, type] of Object.entries({ _id:'ObjectId', score:'Int32', double:'Double', long:'Int64', money:'Decimal128', flag:'Boolean', text:'String', date:'Date', bytes:'Binary', regex:'Regex', nullable:'Null', array:'Array', literal:'Document', min:'MinKey', max:'MaxKey' })) assert.equal(typeName(childType(tree, key)), type, key)
  assert.equal(typeName(childType(childType(tree, 'array'), '0')), 'Int32')
  assert.equal(typeName(childType(childType(tree, 'array'), '1')), 'String')
  assert.equal(typeName(childType(childType(childType(tree, 'array'), '2'), 'value')), 'Double')
  assert.equal(typeName(childType(childType(tree, 'literal'), '$numberInt')), 'String')
  assert.equal(gridBsonType({ text: 'NULL', nullable: 'NULL' }, tree, 'text'), 'String')
  assert.equal(gridBsonType({ text: 'NULL', nullable: 'NULL' }, tree, 'nullable'), 'Null')
  assert.equal(gridBsonType({ text: 'NULL', nullable: 'NULL' }, tree, 'absent'), 'Missing')
  assert.equal(gridBsonType({ text: 'NULL' }, undefined, 'text'), 'Unknown')
  assert.equal(gridBsonType({}, tree, 'constructor'), 'Missing')
})
test('metadata budget cannot remove displayed field types or mutate data', () => {
  const value = { x: new BSON.Int32(7), nested: { inner: new BSON.Long(1, 0) }, extra: 'hidden' }
  const canonical = BSON.EJSON.stringify(value, { relaxed: false })
  const tree = describeBsonDocument(value, ['x', 'nested'], { nodes: 0, bytes: 0 })
  assert.equal(typeName(childType(tree, 'x')), 'Int32')
  assert.equal(typeName(childType(tree, 'nested')), 'Document')
  assert.equal(tree.limited, true)
  assert.equal(childType(tree, 'extra'), undefined)
  assert.equal(BSON.EJSON.stringify(value, { relaxed: false }), canonical)
})
test('palette has a default for every type, validates custom colors, and supports no-color and reset', () => {
  assert.equal(Object.keys(defaultBsonColors).length, bsonTypes.length)
  const settings = normalizeBsonPalette({ enabled: true, showLabels: false, overrides: { String: '#ABCDEF', Null: null, ObjectId: 'url(evil)', bogus: '#123456' } })
  assert.equal(settings.showLabels, false)
  assert.equal(activeTypeColor(settings, 'String'), '#abcdef')
  assert.equal(activeTypeColor(settings, 'Null'), undefined)
  assert.equal(typeColor(settings, 'ObjectId'), defaultBsonColors.ObjectId)
  settings.enabled = false
  assert.equal(activeTypeColor(settings, 'String'), undefined)
  assert.equal(typeColor(newBsonPalette(), 'String'), defaultBsonColors.String)
})
