import test from 'node:test'
import assert from 'node:assert/strict'
import { describeMongoConnectionError } from '../src/main/connections/mongo-diagnostics'

test('MongoDB connection failures expose safe, actionable categories', () => {
  const credentials = 'mongodb://admin:super-secret@db.internal:27017/?authSource=admin'
  const samples: Array<[unknown, string]> = [
    [{ name: 'MongoServerError', code: 18, codeName: 'AuthenticationFailed', message: 'bad auth: ' + credentials }, 'MONGO_AUTH_FAILED'],
    [{ name: 'MongoServerSelectionError', message: 'Server selection failed', reason: { servers: new Map([['db.internal:27017', { error: { code: 'ECONNREFUSED', message: credentials } }]]) } }, 'MONGO_CONNECTION_REFUSED'],
    [{ name: 'MongoServerSelectionError', reason: { servers: new Map([['invalid', { error: { code: 'ENOTFOUND' } }]]) } }, 'MONGO_DNS_FAILED'],
    [{ name: 'MongoServerSelectionError', cause: { name: 'MongoNetworkTimeoutError', message: 'connection timed out' } }, 'MONGO_TIMEOUT'],
    [{ name: 'MongoServerSelectionError', message: 'ReplicaSetNoPrimary' }, 'MONGO_TOPOLOGY_FAILED'],
    [{ name: 'MongoNetworkError', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }, 'MONGO_TLS_FAILED'],
    [{ name: 'MongoParseError', message: 'Invalid scheme' }, 'MONGO_URI_INVALID'],
    [{ name: 'MongoServerError', code: 13, codeName: 'Unauthorized', message: 'not authorized' }, 'MONGO_PERMISSION_DENIED'],
  ]
  for (const [error, expected] of samples) {
    const result = describeMongoConnectionError(error)
    assert.match(result || '', new RegExp('^' + expected + ':'))
    assert(!result?.includes('super-secret'), 'never expose connection details in the UI')
    assert(!result?.includes('db.internal'), 'never expose endpoint details in the UI')
  }
  assert.equal(describeMongoConnectionError({ name: 'Error', message: 'unclassified failure: ' + credentials }), undefined)
  assert.equal(describeMongoConnectionError(null), undefined)
  const circular: Record<string, unknown> = { name: 'MongoServerSelectionError', reason: { servers: new Map() } }
  circular.cause = circular
  assert.match(describeMongoConnectionError(circular) || '', /^MONGO_SERVER_SELECTION_FAILED/)
})
