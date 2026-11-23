import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRedisCommand, redisCommandWrites } from '../src/main/operations/redis'

test('Redis command console denies admin/scripts/bulk/blocking/transaction bypasses', () => {
  for (const input of [['KEYS','*'], ['FLUSHALL'], ['CONFIG','SET','dir','/tmp'], ['EVAL','return 1','0'], ['MULTI'], ['EXEC'], ['BLPOP','key','0'], ['SUBSCRIBE','*'], ['HGETALL','key'], ['SMEMBERS','key'], ['DEBUG','SLEEP','1']]) assert.throws(() => validateRedisCommand(input), input[0])
})
test('range reads have enforced nonnegative bounded pages', () => {
  assert.throws(() => validateRedisCommand(['LRANGE','key','0','-1']))
  assert.throws(() => validateRedisCommand(['GETRANGE','key','0','65536']))
  assert.throws(() => validateRedisCommand(['ZRANGE','key','0','100']))
  assert.deepEqual(validateRedisCommand(['lrange','key','10','19']), ['LRANGE','key','10','19'])
})
test('SCAN cursors preserve unsigned 64-bit precision; COUNT is bounded and cannot repeat', () => {
  assert.deepEqual(validateRedisCommand(['SCAN','18446744073709551615']), ['SCAN','18446744073709551615','COUNT','100'])
  assert.throws(() => validateRedisCommand(['SCAN','18446744073709551616']))
  assert.throws(() => validateRedisCommand(['SCAN','0','COUNT','10000']))
  assert.throws(() => validateRedisCommand(['SCAN','0','COUNT','10','COUNT','20']))
  assert.deepEqual(validateRedisCommand(['HSCAN','key','0','MATCH','field*']), ['HSCAN','key','0','MATCH','field*','COUNT','100'])
})
test('stream range commands cannot omit the enforced count or use dangerous variants', () => {
  assert.deepEqual(validateRedisCommand(['XRANGE','key','-','+']), ['XRANGE','key','-','+','COUNT','100'])
  assert.throws(() => validateRedisCommand(['XRANGE','key','-','+','COUNT','50000']))
  assert.throws(() => validateRedisCommand(['XADD','key','MAXLEN','0','*','field','value']))
  assert.throws(() => validateRedisCommand(['SET','key','v','EX','0']))
})
test('write commands are classified independently of argument casing', () => {
  assert.equal(redisCommandWrites(['ttl','key']), false)
  assert.equal(redisCommandWrites(['hset','key','field','value']), true)
  assert.equal(redisCommandWrites(['unknown']), true)
})
