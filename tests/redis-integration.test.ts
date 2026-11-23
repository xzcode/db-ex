import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { RedisOperations } from '../src/main/operations/redis'
import type { RedisOperation } from '../src/shared/types'

const enabled = process.env.DB_EX_INTEGRATION === '1'
const read = { writable: false, confirmed: false }
const write = { writable: true, confirmed: true }

test('Redis 7 integration: data types, write gates, CAS, TTL, bounded reads, and explicit deletion', { skip: !enabled, timeout: 60000 }, async t => {
  const client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    lazyConnect: true, enableReadyCheck: true, enableOfflineQueue: false,
    maxRetriesPerRequest: 0, retryStrategy: null, connectTimeout: 5000, commandTimeout: 5000,
  })
  client.on('error', () => {})
  const prefix = `dbex:integration:${randomUUID()}:`
  const keys = new Set<string>()
  const key = (suffix: string): string => { const name = prefix + suffix; keys.add(name); return name }
  t.after(async () => {
    try { if (client.status === 'ready' && keys.size) await client.unlink(...keys) }
    finally { client.disconnect() }
  })
  await client.connect()
  const info = await client.info('server')
  const major = Number(/redis_version:(\d+)/.exec(info)?.[1])
  assert.ok(major >= 7, 'The integration fixture requires Redis 7 or newer')
  const operations = new RedisOperations(client)
  const execute = (op: RedisOperation, context = write) => operations.execute(op, context)
  const mutate = (name: string, type: 'hash' | 'list' | 'set' | 'zset' | 'stream', command: string, args: string[]) => execute({ action: 'redis.mutate', key: name, type, command, args })

  await t.test('read-only and explicit-confirmation gates reject before changing data', async () => {
    const name = key('readonly')
    await assert.rejects(execute({ action: 'redis.set', key: name, value: 'value' }, read), /WRITE_CONFIRMATION_REQUIRED/)
    await assert.rejects(execute({ action: 'redis.set', key: name, value: 'value' }, { writable: true, confirmed: false }), /WRITE_CONFIRMATION_REQUIRED/)
    await assert.rejects(execute({ action: 'redis.command', args: ['SET', name, 'value'] }, read), /WRITE_CONFIRMATION_REQUIRED/)
    assert.equal(await client.exists(name), 0)
  })

  await t.test('String CAS detects stale writes, preserves TTL, and supports TTL changes', async () => {
    const name = key('string')
    await execute({ action: 'redis.set', key: name, value: 'first', ttl: 60 })
    const original = await execute({ action: 'redis.get', key: name }, read)
    assert.equal(original.value, 'first')
    assert.equal(original.redisType, 'string')
    assert.ok((original.ttl || 0) > 0 && original.ttl! <= 60)
    await execute({ action: 'redis.set', key: name, value: 'second', expected: 'first' })
    assert.ok(await client.ttl(name) > 0, 'omitted TTL must preserve existing expiry')
    await assert.rejects(execute({ action: 'redis.set', key: name, value: 'stale-overwrite', expected: 'first' }), /CONFLICT/)
    await assert.rejects(execute({ action: 'redis.set', key: name, value: 'new-overwrite' }), /CONFLICT/)
    assert.equal(await client.get(name), 'second')
    await execute({ action: 'redis.set', key: name, value: 'persistent', expected: 'second', ttl: -1 })
    assert.equal(await client.ttl(name), -1)
    await execute({ action: 'redis.ttl', key: name, ttl: 30 })
    assert.ok(await client.ttl(name) > 0)
    await execute({ action: 'redis.ttl', key: name, ttl: -1 })
    assert.equal(await client.ttl(name), -1)
    await assert.rejects(execute({ action: 'redis.ttl', key: name, ttl: 0 }), /TTL/)
  })

  await t.test('Hash fields can be added, changed, incremented, and removed', async () => {
    const name = key('hash')
    await mutate(name, 'hash', 'HSET', ['field', 'value', '数量', '二'])
    let data = await execute({ action: 'redis.get', key: name }, read)
    assert.equal(data.redisType, 'hash')
    assert.deepEqual(new Map(data.rows.map(row => [row.field, row.value])), new Map([['field', 'value'], ['数量', '二']]))
    await mutate(name, 'hash', 'HSET', ['field', 'changed'])
    await mutate(name, 'hash', 'HINCRBY', ['counter', '3'])
    await mutate(name, 'hash', 'HDEL', ['数量'])
    assert.equal(await client.hget(name, 'field'), 'changed')
    assert.equal(await client.hget(name, 'counter'), '3')
    assert.equal(await client.hexists(name, '数量'), 0)
    await assert.rejects(mutate(name, 'list', 'LPUSH', ['wrong-type']), /类型/)
  })

  await t.test('List pages are bounded and supported mutations use exact indices', async () => {
    const name = key('list')
    await mutate(name, 'list', 'RPUSH', Array.from({ length: 102 }, (_, index) => String(index)))
    const first = await execute({ action: 'redis.get', key: name }, read)
    assert.equal(first.redisType, 'list')
    assert.equal(first.rows.length, 100)
    assert.equal(first.nextOffset, 100)
    const second = await execute({ action: 'redis.get', key: name, offset: first.nextOffset }, read)
    assert.equal(second.rows.length, 2)
    assert.equal(second.nextOffset, undefined)
    await mutate(name, 'list', 'LSET', ['1', 'changed'])
    assert.equal(await client.lindex(name, 1), 'changed')
    await mutate(name, 'list', 'LPOP', [])
    assert.equal(await client.llen(name), 101)
  })

  await t.test('Set and sorted-set members support mutations and cursor browsing', async () => {
    const set = key('set')
    await mutate(set, 'set', 'SADD', ['alpha', 'beta'])
    let data = await execute({ action: 'redis.get', key: set }, read)
    assert.equal(data.redisType, 'set')
    assert.deepEqual(new Set(data.rows.map(row => row.member)), new Set(['alpha', 'beta']))
    await mutate(set, 'set', 'SREM', ['alpha'])
    assert.equal(await client.sismember(set, 'alpha'), 0)
    const sorted = key('zset')
    await mutate(sorted, 'zset', 'ZADD', ['1', 'one', '2.5', 'two'])
    data = await execute({ action: 'redis.get', key: sorted }, read)
    assert.equal(data.redisType, 'zset')
    assert.deepEqual(new Map(data.rows.map(row => [row.member, row.score])), new Map([['one', '1'], ['two', '2.5']]))
    await mutate(sorted, 'zset', 'ZINCRBY', ['2', 'one'])
    assert.equal(await client.zscore(sorted, 'one'), '3')
    await mutate(sorted, 'zset', 'ZREM', ['two'])
    assert.equal(await client.zcard(sorted), 1)
  })

  await t.test('Stream writes, deletes, trims and paginates without skipping IDs', async () => {
    const name = key('stream')
    await mutate(name, 'stream', 'XADD', ['*', 'field', 'first'])
    // Seed enough entries to cross the application page boundary, within this random prefix only.
    for (let index = 0; index < 100; index++) await client.xadd(name, '*', 'field', String(index))
    const first = await execute({ action: 'redis.get', key: name }, read)
    assert.equal(first.redisType, 'stream')
    assert.equal(first.rows.length, 100)
    assert.ok(first.nextCursor?.startsWith('('))
    const second = await execute({ action: 'redis.get', key: name, cursor: first.nextCursor }, read)
    assert.equal(second.rows.length, 1)
    assert.notEqual(second.rows[0].id, first.rows[99].id)
    await mutate(name, 'stream', 'XDEL', [second.rows[0].id])
    assert.equal(await client.xlen(name), 100)
    await mutate(name, 'stream', 'XTRIM', ['MAXLEN', '2'])
    assert.equal(await client.xlen(name), 2)
  })

  await t.test('String reads and console GET cap bytes; binary/truncated previews are marked', async () => {
    const large = key('large')
    await client.set(large, 'x'.repeat(128 * 1024))
    const result = await execute({ action: 'redis.get', key: large }, read)
    assert.equal(result.value?.length, 64 * 1024)
    assert.equal(result.length, 128 * 1024)
    assert.equal(result.truncated, true)
    const consoleResult = await execute({ action: 'redis.command', args: ['GET', large] }, read)
    assert.equal(consoleResult.value?.length, 64 * 1024)
    assert.equal(consoleResult.truncated, true)
    const binary = key('binary')
    await client.set(binary, Buffer.from([0xff, 0xfe, 0, 1]))
    const data = await execute({ action: 'redis.get', key: binary }, read)
    assert.equal(data.value, Buffer.from([0xff, 0xfe, 0, 1]).toString('base64'))
    assert.equal(data.truncated, true)
    await assert.rejects(execute({ action: 'redis.set', key: key('too-large'), value: 'x'.repeat(65537) }), /64|限长/)
  })

  await t.test('Console read allowlist rejects unsafe or unbounded commands and ranges', async () => {
    const name = key('string')
    const ping = await execute({ action: 'redis.command', args: ['PING'] }, read)
    assert.equal(ping.rows[0].value, 'PONG')
    const ttl = await execute({ action: 'redis.command', args: ['TTL', name] }, read)
    assert.equal(ttl.rows[0].value, '-1')
    for (const args of [['FLUSHDB'], ['KEYS', prefix + '*'], ['EVAL', 'return 1', '0'], ['CONFIG', 'GET', '*'], ['MULTI'], ['SUBSCRIBE', name], ['BLPOP', name, '0'], ['HGETALL', name], ['LRANGE', name, '0', '-1'], ['SCAN', '0', 'COUNT', '10000']]) {
      await assert.rejects(execute({ action: 'redis.command', args }, read))
    }
  })

  await t.test('SCAN is scoped by pattern and bulk deletion accepts only explicit selected keys', async () => {
    const first = key('delete:first'), second = key('delete:second'), survivor = key('delete:survivor')
    await execute({ action: 'redis.set', key: first, value: 'one' })
    await execute({ action: 'redis.set', key: second, value: 'two' })
    await execute({ action: 'redis.set', key: survivor, value: 'keep' })
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await execute({ action: 'redis.scan', cursor, pattern: `${prefix}delete:*` }, read)
      for (const row of page.rows) { assert.ok(row.key.startsWith(prefix)); seen.add(row.key) }
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(seen, new Set([first, second, survivor]))
    await assert.rejects(execute({ action: 'redis.delete', keys: [first, second] }, read), /WRITE_CONFIRMATION_REQUIRED/)
    const deletion = await execute({ action: 'redis.delete', keys: [first, second, first] })
    assert.equal(deletion.affectedRows, 2)
    assert.equal(await client.exists(first, second), 0)
    assert.equal(await client.get(survivor), 'keep')
    // A wildcard-shaped name is a literal key, never a pattern expansion.
    await execute({ action: 'redis.delete', keys: [`${prefix}delete:*`] })
    assert.equal(await client.get(survivor), 'keep')
    await assert.rejects(execute({ action: 'redis.delete', keys: Array(101).fill(first) }), /100/)
    await assert.rejects(execute({ action: 'redis.delete', keys: [] }), /100/)
  })
})
