import test from 'node:test'
import assert from 'node:assert/strict'
import { BSON } from 'mongodb'
import { formatBytes, mysqlFieldType, redisTypeName } from '../src/shared/object-inspection'
import { databaseTypeColor, normalizeDatabasePalette } from '../src/shared/database-palette'
import { mongoDefinition } from '../src/main/operations/mongo-definition'
test('MySQL type metadata follows field packets; Redis type names are allowlisted', () => {
  assert.equal(mysqlFieldType({ columnType: 8 }), 'BIGINT')
  assert.equal(mysqlFieldType({ columnType: 246 }), 'DECIMAL')
  assert.equal(mysqlFieldType({ columnType: 252, characterSet: 63 }), 'BLOB')
  assert.equal(mysqlFieldType({ columnType: 252, characterSet: 45 }), 'TEXT')
  assert.equal(mysqlFieldType({ columnType: 254, flags: 256 }), 'ENUM')
  assert.equal(mysqlFieldType({ columnType: 245 }), 'JSON')
  assert.equal(mysqlFieldType({ columnType: 999 }), 'UNKNOWN')
  assert.equal(redisTypeName('hash'), 'hash')
  assert.equal(redisTypeName('constructor'), 'unknown')
  assert.equal(formatBytes('32768', 'en'), '32 KiB (32,768)')
})
test('palette validates user colors and keeps database engines separate', () => {
  const sql = normalizeDatabasePalette('mysql', { overrides: { BIGINT: '#AABBCC', VARCHAR: null, INT: 'evil', string: '#123456' } })
  assert.equal(databaseTypeColor('mysql', sql, 'BIGINT'), '#aabbcc')
  assert.equal(databaseTypeColor('mysql', sql, 'VARCHAR'), undefined)
  assert.equal(databaseTypeColor('mysql', sql, 'INT'), '#4da96b')
  assert.equal(databaseTypeColor('redis', sql, 'string'), '#4b88d9')
})
test('MongoDB DDL preserves supported collection and index metadata, reports omitted special indexes', () => {
  const ddl = mongoDefinition('db"x', 'collection', { options: { capped: true, size: new BSON.Int32(4096) } }, [
    { name: '_id_', key: { _id: new BSON.Int32(1) }, v: 2 },
    { name: 'pair', key: { a: new BSON.Int32(1), b: new BSON.Int32(-1) }, unique: true, v: 2 },
    { name: 'ttl', key: { ts: new BSON.Int32(1) }, expireAfterSeconds: new BSON.Int32(60) },
    { name: 'text', key: { _fts: 'text', _ftsx: new BSON.Int32(1) }, weights: { name: 1 } },
  ])
  assert.equal(ddl.incomplete, true)
  assert.match(ddl.definition, /db\.getSiblingDB\("db\\"x"\)\.createCollection\("collection"/)
  assert.match(ddl.definition, /"capped": true/)
  assert.match(ddl.definition, /"unique": true/)
  assert.match(ddl.definition, /"expireAfterSeconds": Int32\("60"\)/)
  assert.doesNotMatch(ddl.definition, /"_id_"|"_fts"/)
})
