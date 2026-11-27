import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Connection } from 'mysql2/promise'
import { MysqlOperations } from '../src/main/operations/mysql'

const read = { writable: false, confirmed: false }
const write = { writable: true, confirmed: true }

function fixture(options: { affected?: number; huge?: boolean; binary?:boolean; many?: boolean; pending?: boolean; failInsert?: number } = {}) {
  const calls: { sql: string; values: unknown[]; prepared: boolean }[] = []
  let destroyed = false
  let inserts = 0
  let onSelect!: () => void
  const selectStarted = new Promise<void>(resolve => { onSelect = resolve })
  const emit = (query: EventEmitter, columns: string[], values: unknown[][]) => {
    query.emit('fields', columns.map(name => ({ name })))
    for (const value of values) if (!destroyed) query.emit('result', value)
    query.emit('end')
  }
  const invoke = (prepared: boolean) => (input: { sql: string }, values: unknown[] = []) => {
    const query = new EventEmitter()
    calls.push({ sql: input.sql, values, prepared })
    queueMicrotask(() => {
      if (input.sql.startsWith('SHOW FULL COLUMNS')) emit(query, ['Field', 'Type', 'Null', 'Key', 'Extra'], [[ 'id', 'bigint', 'NO', 'PRI', ''], ['name', 'varchar(255)', 'YES', '', '']])
      else if (input.sql.startsWith('SHOW INDEX')) emit(query, ['Key_name', 'Column_name', 'Seq_in_index', 'Non_unique'], [['PRIMARY', 'id', 1, 0]])
      else if (input.sql.startsWith('SELECT ENGINE')) emit(query, ['ENGINE'], [['InnoDB']])
      else if (input.sql.startsWith('SELECT * FROM (')) {
        onSelect()
        if (!options.pending) emit(query, ['id', 'name'], options.many?Array.from({length:40},(_,i)=>[i+1,'a'.repeat(100*1024)]):[[1, options.huge ? 'x'.repeat(512 * 1024 + 1) : options.binary?Buffer.alloc(5000,255):'Alice']])
      } else if (input.sql.startsWith('INSERT') && ++inserts === options.failInsert) query.emit('error', Object.assign(new Error('sensitive raw SQL error'), { code: 'ER_DUP_ENTRY' }))
      else { query.emit('result', { affectedRows: options.affected ?? 1 }); query.emit('end') }
    })
    return query
  }
  const client = {
    connection: { query: invoke(false), execute: invoke(true) },
    destroy() { destroyed = true },
  } as unknown as Connection
  return { operations: new MysqlOperations(client), calls, selectStarted, destroyed: () => destroyed }
}

test('read SQL uses a server READ ONLY transaction and bounded outer SELECT', async () => {
  const { operations, calls } = fixture()
  const result = await operations.execute({ action: 'mysql.query', sql: 'SELECT * FROM users LIMIT 10000000', limit: 100, offset: 200 }, read)
  assert.equal(calls[0].sql, 'START TRANSACTION READ ONLY')
  assert.match(calls[1].sql, /LIMIT 101 OFFSET 200$/)
  assert.equal(calls[1].prepared, true)
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK')
  assert.deepEqual(result.rawRows, [{ id: 1, name: 'Alice' }])
})

test('write gate rejects both read-only and unconfirmed mutations before a database query', async () => {
  const { operations, calls } = fixture()
  const operation = { action: 'mysql.insert' as const, database: 'test', entity: 'users', values: { id: 1, name: 'x' } }
  await assert.rejects(operations.execute(operation, read), /READ_ONLY/)
  await assert.rejects(operations.execute(operation, { writable: true, confirmed: false }), /CONFIRMATION_REQUIRED/)
  assert.equal(calls.length, 0)
})

test('unsafe numeric parameters are rejected before precision loss reaches the server', async () => {
  const { operations, calls } = fixture()
  await assert.rejects(operations.execute({ action: 'mysql.query', sql: 'SELECT ?', parameters: [9007199254740992] }, read), /INVALID_INPUT/)
  assert.equal(calls.length, 0)
})

test('CRUD uses actual table primary key, full old row and bound values', async () => {
  const { operations, calls } = fixture()
  const text = "Robert'); DROP TABLE users; --"
  await operations.execute({ action: 'mysql.update', database: 'test', entity: 'users', key: { id: 1 }, original: { id: 1, name: 'Alice' }, changes: { name: text } }, write)
  const update = calls.find(call => call.sql.startsWith('UPDATE'))!
  assert.equal(update.sql, 'UPDATE `test`.`users` SET `name` = ? WHERE `id` <=> ? AND CAST(`name` AS BINARY) <=> CAST(? AS BINARY) LIMIT 1')
  assert.deepEqual(update.values, [text, 1, 'Alice'])
  assert.equal(update.prepared, true)
  assert.equal(update.sql.includes(text), false)
})

test('CRUD refuses incomplete originals and mismatching primary keys', async () => {
  const { operations, calls } = fixture()
  await assert.rejects(operations.execute({ action: 'mysql.delete', database: 'test', entity: 'users', key: { id: 1 }, original: { id: 1 } }, write), /INCOMPLETE_ROW/)
  await assert.rejects(operations.execute({ action: 'mysql.delete', database: 'test', entity: 'users', key: { id: 2 }, original: { id: 1, name: 'Alice' } }, write), /INVALID_PRIMARY_KEY/)
  assert.equal(calls.some(call => call.sql.startsWith('DELETE')), false)
})

test('a concurrent row change reports conflict instead of claiming success', async () => {
  const { operations } = fixture({ affected: 0 })
  await assert.rejects(operations.execute({ action: 'mysql.delete', database: 'test', entity: 'users', key: { id: 1 }, original: { id: 1, name: 'Alice' } }, write), /EDIT_CONFLICT/)
})

test('import rolls its own transaction back on duplicate and never leaks driver SQL', async () => {
  const { operations, calls } = fixture({ failInsert: 2 })
  await assert.rejects(operations.execute({ action: 'mysql.import', database: 'test', entity: 'users', rows: [{ id: 1, name: 'one' }, { id: 1, name: 'duplicate' }] }, write), error => {
    assert.match(String(error), /DATABASE_ERROR.*ER_DUP_ENTRY/)
    assert.doesNotMatch(String(error), /sensitive raw SQL/)
    return true
  })
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false)
})

test('active transactions prevent DDL implicit commit and rollback is always available', async () => {
  const { operations } = fixture()
  await operations.execute({ action: 'mysql.begin' }, write)
  assert.equal(operations.transactionActive, true)
  await assert.rejects(operations.execute({ action: 'mysql.query', sql: 'DROP TABLE users' }, write), /IMPLICIT_COMMIT/)
  await operations.execute({ action: 'mysql.rollback' }, read)
  assert.equal(operations.transactionActive, false)
})

test('cancellation tears down the underlying connection rather than only hiding the result', async () => {
  const { operations, selectStarted, destroyed } = fixture({ pending: true })
  const result = operations.execute({ action: 'mysql.query', sql: 'SELECT * FROM users' }, read)
  await selectStarted
  operations.cancel()
  await assert.rejects(result, /CANCELLED/)
  assert.equal(destroyed(), true)
  assert.equal(operations.disconnected, true)
})

test('oversized rows stop reading, cannot become editable partial data, and mark session closed', async () => {
  const { operations, destroyed } = fixture({ huge: true })
  const result = await operations.execute({ action: 'mysql.query', sql: 'SELECT * FROM users' }, read)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.rawRows, [])
  assert.equal(result.disconnected, true)
  assert.equal(destroyed(), true)
})

test('bounded page aggregate byte cap returns actual next offset without disconnecting',async()=>{
 const {operations,destroyed}=fixture({many:true})
 const result=await operations.execute({action:'mysql.query',sql:'SELECT * FROM users',limit:100,offset:20},read)
 assert.equal(result.truncationReason,'bytes')
 assert(result.rows.length>0&&result.rows.length<40)
 assert.equal(result.nextOffset,20+result.rows.length)
 assert.equal(destroyed(),false)
 assert.equal(operations.disconnected,false)
})

test('SQL binary preview keeps all bounded bytes separate from lossy row display and editable originals',async()=>{
 const {operations}=fixture({binary:true})
 const result=await operations.execute({action:'mysql.query',sql:'SELECT * FROM users'},read)
 assert.equal(result.rawRows,undefined)
 assert.equal(result.binaryCells?.[0]?.name,Buffer.alloc(5000,255).toString('base64'))
 assert(result.rows[0]?.name?.endsWith('…'))
})
