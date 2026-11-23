import assert from 'node:assert/strict'
import net, { type Socket } from 'node:net'
import test from 'node:test'
import { BSON, MongoClient, type Document } from 'mongodb'
import { MongoOperations } from '../src/main/operations/mongodb'

const read = { writable: false, confirmed: false }
const write = { writable: true, confirmed: true }
const canonical = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false })
const notPrimary = { ok: 0, code: 13435, codeName: 'NotPrimaryNoSecondaryOk', errmsg: 'not primary and secondaryOk=false' }

/** A bounded local wire fixture exercises the actual driver, not mocked cursors. */
async function mongoWire(handler: (command: Document) => Document) {
  const sockets = new Set<Socket>()
  const errors: Error[] = []
  let address = ''
  let responseId = 1
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      try {
        while (pending.length >= 4) {
          const length = pending.readInt32LE(0)
          if (length < 16 || length > 4 * 1024 * 1024) throw new Error('Invalid fixture request size')
          if (pending.length < length) break
          const packet = pending.subarray(0, length)
          pending = pending.subarray(length)
          const requestId = packet.readInt32LE(4)
          const opcode = packet.readInt32LE(12)
          let offset: number
          if (opcode === 2004) {
            const namespaceEnd = packet.indexOf(0, 20)
            if (namespaceEnd < 0) throw new Error('Missing OP_QUERY namespace')
            offset = namespaceEnd + 1 + 8
          } else if (opcode === 2013 && packet[20] === 0) {
            offset = 21
          } else throw new Error(`Unexpected fixture opcode ${opcode}`)
          const size = packet.readInt32LE(offset)
          const command = BSON.deserialize(packet.subarray(offset, offset + size))
          const reply = command.hello || command.ismaster || command.isMaster
            ? {
                ok: 1, isWritablePrimary: true, ismaster: true, helloOk: true,
                setName: 'dbex-wire', hosts: [address], primary: address, me: address,
                minWireVersion: 0, maxWireVersion: 21, logicalSessionTimeoutMinutes: 30,
                maxBsonObjectSize: 16 * 1024 * 1024, maxMessageSizeBytes: 48 * 1024 * 1024,
                maxWriteBatchSize: 100_000,
              }
            : handler(command)
          const bson = BSON.serialize(reply)
          const header = Buffer.alloc(opcode === 2004 ? 36 : 21)
          header.writeInt32LE(header.length + bson.length, 0)
          header.writeInt32LE(responseId++, 4)
          header.writeInt32LE(requestId, 8)
          header.writeInt32LE(opcode === 2004 ? 1 : 2013, 12)
          if (opcode === 2004) header.writeInt32LE(1, 32)
          socket.write(Buffer.concat([header, bson]))
        }
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  address = `127.0.0.1:${(server.address() as net.AddressInfo).port}`
  return {
    uri: `mongodb://${address}/?replicaSet=dbex-wire`, errors,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

test('Mongo cursor replies keep numeric protocol errors retryable and BSON document types exact', { timeout: 20_000 }, async () => {
  const attempts = new Map<string, number>()
  const source = {
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    int: new BSON.Int32(7), double: new BSON.Double(7),
    long: BSON.Long.fromString('9223372036854775807'),
    decimal: BSON.Decimal128.fromString('123456789.123456789'),
    binary: new BSON.Binary(Buffer.from([0, 255, 12])), date: new Date('2025-01-01T00:00:00Z'),
  }
  const fixture = await mongoWire(command => {
    const name = ['find', 'aggregate', 'listIndexes', 'insert'].find(key => command[key] != null)
    if (!name) return { ok: 1 }
    const count = (attempts.get(name) ?? 0) + 1
    attempts.set(name, count)
    if (name === 'insert') {
      assert.equal(command.txnNumber, undefined, 'writes must not use retryable-write transaction numbers')
      return { ok: 0, code: 10107, codeName: 'NotWritablePrimary', errmsg: 'not primary', errorLabels: ['RetryableWriteError'] }
    }
    if (count === 1) return notPrimary
    return { ok: 1, cursor: { id: BSON.Long.ZERO, ns: 'fixture.records', firstBatch: [source] } }
  })
  // Even a caller configured for wrapped values must not turn error.code into Int32.
  const client = new MongoClient(fixture.uri, {
    retryReads: true, retryWrites: false, promoteValues: false, promoteLongs: false,
    serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, heartbeatFrequencyMS: 500,
  })
  const operations = new MongoOperations(client)
  try {
    await client.connect()
    const target = { database: 'fixture', entity: 'records' }
    for (const operation of [
      { action: 'mongo.find' as const, ...target },
      { action: 'mongo.aggregate' as const, ...target, pipeline: '[]' },
      { action: 'mongo.indexes' as const, ...target },
    ]) {
      const result = await operations.execute(operation, read)
      assert.deepEqual(result.documents, [canonical(source)])
    }
    assert.equal(attempts.get('find'), 2)
    assert.equal(attempts.get('aggregate'), 2)
    assert.equal(attempts.get('listIndexes'), 2)
    await assert.rejects(operations.execute({ action: 'mongo.insert', ...target, documents: ['{"_id":"once"}'] }, write), /DATABASE_ERROR/)
    assert.equal(attempts.get('insert'), 1, 'a retryable write error must not replay the user write')
    assert.deepEqual(fixture.errors, [])
  } finally {
    await operations.close()
    await client.close()
    await fixture.close()
  }
})

test('Mongo getMore failure does not replay an already-started cursor', { timeout: 10_000 }, async () => {
  let finds = 0
  let getMores = 0
  const fixture = await mongoWire(command => {
    if (command.find) {
      finds++
      return { ok: 1, cursor: { id: BSON.Long.fromNumber(42), ns: 'fixture.records', firstBatch: [{ _id: 'first' }] } }
    }
    if (command.getMore) { getMores++; return notPrimary }
    return { ok: 1 }
  })
  const client = new MongoClient(fixture.uri, { retryReads: true, retryWrites: false, serverSelectionTimeoutMS: 3000, heartbeatFrequencyMS: 500 })
  const operations = new MongoOperations(client)
  try {
    await client.connect()
    await assert.rejects(operations.execute({ action: 'mongo.find', database: 'fixture', entity: 'records' }, read), /DATABASE_ERROR/)
    assert.equal(finds, 1)
    assert.equal(getMores, 1)
    assert.deepEqual(fixture.errors, [])
  } finally {
    await operations.close()
    await client.close()
    await fixture.close()
  }
})
