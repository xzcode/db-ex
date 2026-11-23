import type Redis from 'ioredis'
import type { Cluster } from 'ioredis'
import { TextDecoder } from 'node:util'
import type { OperationResult, RedisOperation } from '../../shared/types'

type Client = Redis | Cluster
interface Context { writable: boolean; confirmed: boolean; signal?: AbortSignal }
const MAX_BYTES = 2 * 1024 * 1024
const MAX_STRING = 64 * 1024
const PAGE = 100
const READ_COMMANDS = new Set(['PING', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'STRLEN', 'HLEN', 'LLEN', 'SCARD', 'ZCARD', 'XLEN', 'GET', 'GETRANGE', 'LRANGE', 'ZRANGE', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'XRANGE'])
const MUTATIONS: Record<string, Set<string>> = {
  string: new Set(['APPEND', 'INCRBY', 'DECRBY', 'SETRANGE']),
  hash: new Set(['HSET', 'HDEL', 'HINCRBY']),
  list: new Set(['LPUSH', 'RPUSH', 'LSET', 'LREM', 'LTRIM', 'LPOP', 'RPOP']),
  set: new Set(['SADD', 'SREM']),
  zset: new Set(['ZADD', 'ZREM', 'ZINCRBY']),
  stream: new Set(['XADD', 'XDEL', 'XTRIM']),
}
const WRITE_COMMANDS = new Set(['SET', 'DEL', 'UNLINK', 'EXPIRE', 'PERSIST', ...Object.values(MUTATIONS).flatMap(x => [...x])])
export function redisCommandWrites(args: string[]): boolean { return !READ_COMMANDS.has(String(args?.[0] || '').toUpperCase()) }
function string(value: unknown, label: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || value.includes('\0')) throw new Error(`${label}必须是限长 UTF-8 字符串`)
  return value
}
function key(value: unknown): string { return string(value, 'Key', 4096) }
function number(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`${label}超出允许范围 ${min}–${max}`)
  return n as number
}
function cursor(value: unknown): string {
  const result = value === undefined ? '0' : String(value)
  if (!/^\d{1,20}$/.test(result) || BigInt(result) > 18446744073709551615n) throw new Error('SCAN 游标无效')
  return result
}
function result(rows: Record<string, string>[] = [], extra: Partial<OperationResult> = {}): OperationResult {
  let bytes = 0
  let truncated = Boolean(extra.truncated)
  const limited: Record<string, string>[] = []
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row))
    if (limited.length >= 500 || bytes + size > MAX_BYTES) { truncated = true; break }
    bytes += size; limited.push(row)
  }
  return { columns: [...new Set(limited.flatMap(r => Object.keys(r)))], rows: limited, ...extra, truncated }
}
function display(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return (s || 'null').slice(0, MAX_STRING)
}
function writable(ctx: Context): void {
  if (!ctx.writable || !ctx.confirmed) throw new Error('WRITE_CONFIRMATION_REQUIRED: 请先解锁写入并确认本次操作')
}
function args(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 202 || input.some(x => typeof x !== 'string' || Buffer.byteLength(x) > MAX_STRING)) throw new Error('命令参数最多202项，每项不超过64 KiB')
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new Error('命令参数总量不能超过1 MiB')
  return input
}
function fields(values: string[], start: number): void { if (values.length < start + 2 || (values.length - start) % 2 !== 0) throw new Error('需要完整的字段/值参数对') }
/** Validate the complete command, not just the verb; prohibit server/admin/script/blocking commands. */
export function validateRedisCommand(input: unknown): string[] {
  const parts = args(input)
  if (!parts.length) throw new Error('请输入 Redis 命令')
  const command = parts[0].toUpperCase()
  if (!READ_COMMANDS.has(command) && !WRITE_COMMANDS.has(command)) throw new Error('命令未开放：不支持管理、脚本、订阅、阻塞、多命令事务或全量读取命令')
  const p = parts.slice(1)
  if (command === 'PING') { if (p.length > 1) throw new Error('PING 参数错误'); return [command, ...p] }
  if (['SCAN', 'HSCAN', 'SSCAN', 'ZSCAN'].includes(command)) {
    if (command !== 'SCAN') key(p[0])
    const index = command === 'SCAN' ? 0 : 1
    cursor(p[index])
    const options = p.slice(index + 1)
    if (options.length % 2) throw new Error('SCAN 参数错误')
    const seen = new Set<string>()
    for (let i = 0; i < options.length; i += 2) {
      const name = options[i].toUpperCase()
      if (!['MATCH', 'COUNT'].includes(name) || seen.has(name)) throw new Error('SCAN 仅支持单个 MATCH / COUNT')
      seen.add(name)
      if (name === 'COUNT') number(options[i + 1], 'COUNT', 1, PAGE)
      else string(options[i + 1], 'MATCH', 1024)
    }
    return [command, ...p, ...(seen.has('COUNT') ? [] : ['COUNT', String(PAGE)])]
  }
  key(p[0])
  if (['TYPE', 'TTL', 'PTTL', 'STRLEN', 'HLEN', 'LLEN', 'SCARD', 'ZCARD', 'XLEN', 'GET', 'PERSIST'].includes(command) && p.length !== 1) throw new Error('命令只接收一个 Key')
  if (['EXISTS', 'DEL', 'UNLINK'].includes(command)) { if (p.length < 1 || p.length > 100) throw new Error('最多操作100个明确 Key'); p.forEach(key) }
  if (['GETRANGE', 'LRANGE', 'ZRANGE'].includes(command)) {
    if (p.length !== 3 && !(command === 'ZRANGE' && p.length === 4 && p[3].toUpperCase() === 'WITHSCORES')) throw new Error('范围命令参数错误')
    const start = number(p[1], '起始位置', 0, 1000000000)
    const end = number(p[2], '结束位置', start, start + (command === 'GETRANGE' ? MAX_STRING : PAGE) - 1)
    if (end < start) throw new Error('范围无效')
  }
  if (command === 'XRANGE') {
    if (p.length < 3 || p.length > 5 || (p.length === 5 && p[3].toUpperCase() !== 'COUNT')) throw new Error('XRANGE 格式为 key start end [COUNT n]')
    if (p.length === 4) throw new Error('XRANGE 参数错误')
    if (p.length === 5) number(p[4], 'COUNT', 1, PAGE)
    else return [command, ...p, 'COUNT', String(PAGE)]
  }
  if (command === 'SET') {
    if (p.length !== 2) throw new Error('命令台 SET 仅支持 key value；TTL 请使用专用面板')
    string(p[1], 'Value')
  }
  if (command === 'EXPIRE') { if (p.length !== 2) throw new Error('EXPIRE 参数错误'); number(p[1], 'TTL', 1, 2147483647) }
  if (['APPEND', 'INCRBY', 'DECRBY', 'HDEL', 'LPUSH', 'RPUSH', 'SADD', 'SREM', 'ZREM', 'XDEL'].includes(command) && p.length < 2) throw new Error('命令缺少参数')
  if (['INCRBY', 'DECRBY'].includes(command)) { if (p.length !== 2) throw new Error('整数变更参数错误'); if (!/^-?\d{1,19}$/.test(p[1])) throw new Error('请输入64位整数文本') }
  if (command === 'HSET') fields(p, 1)
  if (command === 'ZADD') { fields(p, 1); for (let i = 1; i < p.length; i += 2) if (!Number.isFinite(Number(p[i]))) throw new Error('ZADD score必须是数值') }
  if (command === 'XADD') { if (p[1] !== '*' && !/^\d+-\d+$/.test(p[1])) throw new Error('XADD 需要消息 ID 或 *'); fields(p, 2) }
  if (['HINCRBY', 'LSET', 'LREM', 'LTRIM', 'ZINCRBY', 'SETRANGE'].includes(command) && p.length !== 3) throw new Error('命令参数数量错误')
  if (command === 'SETRANGE') number(p[1], '偏移', 0, MAX_STRING)
  if (command === 'LSET') number(p[1], '索引', -1000000000, 1000000000)
  if (command === 'LREM') number(p[1], '数量', -1000, 1000)
  if (command === 'LTRIM') { number(p[1], '起始', -1000000000, 1000000000); number(p[2], '结束', -1000000000, 1000000000) }
  if (command === 'XTRIM' && (p.length !== 3 || p[1].toUpperCase() !== 'MAXLEN')) throw new Error('XTRIM仅支持 key MAXLEN n')
  if (command === 'XTRIM') number(p[2], 'MAXLEN', 0, 1000000000)
  if (['LPOP', 'RPOP'].includes(command)) { if (p.length > 2) throw new Error('POP参数错误'); if (p.length === 2) number(p[1], 'COUNT', 1, PAGE) }
  return [command, ...p]
}
export class RedisOperations {
  constructor(private readonly client: Client) {}
  private nodes(): Redis[] { return 'nodes' in this.client ? this.client.nodes('master') : [this.client] }
  private node(id?: string): Redis {
    const nodes = this.nodes()
    const selected = id ? nodes.find(x => `${x.options.host}:${x.options.port}` === id) : nodes[0]
    if (!selected) throw new Error('Redis节点不可用，请刷新拓扑')
    return selected
  }
  async execute(operation: RedisOperation, ctx: Context): Promise<OperationResult> {
    if (ctx.signal?.aborted) throw new Error('操作已取消')
    const started = performance.now()
    const output = await this.run(operation, ctx)
    return { ...output, durationMs: Math.round(performance.now() - started) }
  }
  private async run(op: RedisOperation, ctx: Context): Promise<OperationResult> {
    switch (op.action) {
      case 'redis.nodes': return result(this.nodes().map(x => ({ id: `${x.options.host}:${x.options.port}`, host: x.options.host || '', port: String(x.options.port), role: 'master', status: x.status })))
      case 'redis.scan': {
        const client = this.node(op.node)
        const pattern = op.pattern === undefined ? '*' : string(op.pattern, 'Key匹配', 1024)
        const [nextBuffer, encodedKeys] = await client.scanBuffer(cursor(op.cursor), 'MATCH', pattern, 'COUNT', PAGE)
        const next = nextBuffer.toString('ascii')
        const keys: string[] = []
        let skippedKeys = 0
        for (const bytes of encodedKeys) {
          try {
            const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
            key(decoded)
            keys.push(decoded)
          } catch { skippedKeys++ }
        }
        const unique = [...new Set(keys)]
        // SCAN COUNT is a hint. A large compact result is shown in a bounded page.
        const visible = unique.slice(0, 500)
        const rows: Record<string, string>[] = []
        for (let i = 0; i < visible.length; i += 20) {
          const chunk = await Promise.all(visible.slice(i, i + 20).map(async item => {
            const [type, ttl] = await Promise.all([client.type(item), client.ttl(item)])
            return { key: item, type, ttl: String(ttl) }
          }))
          rows.push(...chunk)
        }
        return result(rows, { nextCursor: next === '0' ? undefined : next, truncated: unique.length > 500, message: `${unique.length > 500 ? 'SCAN 单次返回超过500项，已截断；请缩小匹配条件后重查' : `节点 ${client.options.host}:${client.options.port}；SCAN 可能重复或暂时返回空页`}${skippedKeys ? `；跳过 ${skippedKeys} 个非UTF-8、含NUL或超长Key，防止错误解码后操作另一Key` : ''}` })
      }
      case 'redis.get': return this.get(key(op.key), op.cursor, op.offset)
      case 'redis.set': {
        writable(ctx)
        const name = key(op.key); const value = string(op.value, 'Value')
        const ttl = op.ttl === undefined ? -1 : number(op.ttl, 'TTL', -1, 2147483647)
        if (ttl === 0) throw new Error('TTL必须大于0或为-1（永久）')
        if (op.expected !== undefined) string(op.expected, '原Value')
        const script = `local old=redis.call('GET',KEYS[1]); if ARGV[1]=='new' then if old~=false then return 0 end else if old~=ARGV[2] then return 0 end end; redis.call('SET',KEYS[1],ARGV[3],'KEEPTTL'); if ARGV[4]=='clear' then redis.call('PERSIST',KEYS[1]) elseif ARGV[4]~='keep' then redis.call('EXPIRE',KEYS[1],tonumber(ARGV[4])) end; return 1`
        const expiry = op.ttl === undefined ? 'keep' : ttl === -1 ? 'clear' : String(ttl)
        const changed = await this.client.eval(script, 1, name, op.expected === undefined ? 'new' : 'update', op.expected || '', value, expiry)
        if (changed !== 1) throw new Error('CONFLICT: Key已存在、已删除或值已被修改，请刷新后重试')
        return result([], { affectedRows: 1, message: 'String 已保存' })
      }
      case 'redis.mutate': {
        writable(ctx)
        const name = key(op.key)
        const command = string(op.command, '命令', 24).toUpperCase()
        if (!MUTATIONS[op.type]?.has(command)) throw new Error('此数据类型不支持该变更命令')
        const input = validateRedisCommand([command, name, ...args(op.args)])
        const actual = await this.client.type(name)
        if (actual !== 'none' && actual !== op.type) throw new Error('Key类型已改变，请刷新')
        return this.reply(await this.call(input), true)
      }
      case 'redis.ttl': {
        writable(ctx); const name = key(op.key); const ttl = number(op.ttl, 'TTL', -1, 2147483647)
        if (ttl === 0) throw new Error('删除Key请使用删除操作；TTL必须大于0或为-1')
        const changed = ttl === -1 ? await this.client.persist(name) : await this.client.expire(name, ttl)
        return result([], { affectedRows: changed, message: changed ? 'TTL已更新' : 'Key不存在或TTL未变化' })
      }
      case 'redis.delete': {
        writable(ctx)
        if (!Array.isArray(op.keys) || !op.keys.length || op.keys.length > 100) throw new Error('每次最多删除100个明确选择的Key')
        const keys = [...new Set(op.keys.map(key))]
        // Per-key routing works across Redis Cluster slots; never issue cross-slot DEL.
        let count = 0
        try { for (const item of keys) { if (ctx.signal?.aborted) throw new Error('cancelled'); count += await this.client.unlink(item) } }
        catch { throw new Error(`PARTIAL_WRITE: 已确认删除 ${count} 个Key；后续操作失败或结果未知，请刷新核对。批量删除不是跨Key事务`) }
        return result([], { affectedRows: count, message: `已删除 ${count} 个Key` })
      }
      case 'redis.command': {
        const input = validateRedisCommand(op.args)
        if (redisCommandWrites(input)) writable(ctx)
        if (input[0] === 'GET') return this.get(input[1])
        if (input[0] === 'SCAN') {
          const p = input.slice(2); const at = p.findIndex(x => x.toUpperCase() === 'MATCH')
          return this.run({ action: 'redis.scan', cursor: input[1], pattern: at >= 0 ? p[at + 1] : '*' }, ctx)
        }
        if (['DEL', 'UNLINK', 'EXISTS'].includes(input[0])) {
          let count = 0
          try { for (const item of input.slice(1)) { if (ctx.signal?.aborted) throw new Error('cancelled'); count += Number(await this.client.call(input[0], item)) } }
          catch { if (input[0] === 'EXISTS') throw new Error('DATABASE_ERROR: Key存在性查询失败'); throw new Error(`PARTIAL_WRITE: 已确认删除 ${count} 个Key，后续结果未知，请刷新核对`) }
          return this.reply(count, redisCommandWrites(input))
        }
        return this.reply(await this.call(input), redisCommandWrites(input))
      }
      default: throw new Error('未知 Redis 操作')
    }
  }
  private call(parts: string[]): Promise<unknown> { return this.client.call(parts[0], ...parts.slice(1)) }
  private reply(value: unknown, write = false): OperationResult {
    const values = Array.isArray(value) ? value : [value]
    return result(values.slice(0, 500).map((item, index) => ({ index: String(index), value: display(item) })), { truncated: values.length > 500 || values.some(x => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x) || '') > MAX_STRING), message: write ? '命令已执行' : undefined })
  }
  private async get(name: string, scanCursor?: string, offset = 0): Promise<OperationResult> {
    const [type, ttl] = await Promise.all([this.client.type(name), this.client.ttl(name)])
    const meta = { redisType: type, ttl }
    if (type === 'none') return result([], { ...meta, message: 'Key不存在或已过期' })
    if (type === 'string') {
      const length = await this.client.strlen(name)
      const buffer = await this.client.getrangeBuffer(name, 0, MAX_STRING - 1)
      let value: string; let binary = false
      try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) } catch { value = buffer.toString('base64'); binary = true }
      return result([{ key: name, type, ttl: String(ttl), bytes: String(length) }], { ...meta, length, value, truncated: length > MAX_STRING || binary, message: binary ? '二进制内容以Base64预览，文本编辑已禁用' : length > MAX_STRING ? '仅预览前64 KiB；禁止用截断值覆盖原值' : undefined })
    }
    let rows: Record<string, string>[] = []; let nextCursor: string | undefined; let nextOffset: number | undefined; let length: number | undefined
    if (['hash', 'set', 'zset'].includes(type)) {
      const [next, values] = await this.client.call(`${type === 'hash' ? 'H' : type === 'set' ? 'S' : 'Z'}SCAN`, name, cursor(scanCursor), 'COUNT', PAGE) as [string, string[]]
      nextCursor = next === '0' ? undefined : next
      if (type === 'set') rows = values.map(value => ({ member: display(value) }))
      else for (let i = 0; i < values.length; i += 2) rows.push(type === 'hash' ? { field: display(values[i]), value: display(values[i + 1]) } : { member: display(values[i]), score: values[i + 1] })
      length = type === 'hash' ? await this.client.hlen(name) : type === 'set' ? await this.client.scard(name) : await this.client.zcard(name)
      return result(rows, { ...meta, nextCursor, length, truncated: values.some(v => Buffer.byteLength(v) > MAX_STRING) || rows.length > 500, message: rows.length > 500 ? '紧凑编码本次返回超限，已截断；请使用命令台 MATCH 缩小范围' : undefined })
    }
    if (type === 'list') {
      const start = number(offset, '偏移', 0, 1000000000)
      const values = await this.client.lrange(name, start, start + PAGE - 1)
      length = await this.client.llen(name)
      rows = values.map((value, i) => ({ index: String(start + i), value: display(value) }))
      nextOffset = start + values.length < length ? start + values.length : undefined
      return result(rows, { ...meta, length, nextOffset, truncated: values.some(v => Buffer.byteLength(v) > MAX_STRING) })
    }
    if (type === 'stream') {
      const start = scanCursor ? string(scanCursor, 'Stream ID', 64) : '-'
      if (start !== '-' && !/^\(\d+-\d+$/.test(start)) throw new Error('Stream游标无效')
      const entries = await this.client.xrange(name, start, '+', 'COUNT', PAGE + 1)
      const page = entries.slice(0, PAGE)
      rows = page.map(([id, values]) => ({ id, fields: display(values) }))
      length = await this.client.xlen(name)
      nextCursor = entries.length > PAGE ? `(${page[page.length - 1][0]}` : undefined
      return result(rows, { ...meta, length, nextCursor, truncated: page.some(([, value]) => Buffer.byteLength(JSON.stringify(value)) > MAX_STRING) })
    }
    return result([], { ...meta, message: '此Redis模块数据类型暂不支持编辑' })
  }
}
