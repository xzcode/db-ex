import { childType, typeName, type BsonTypeTree } from './bson-types'
import { parseBsonDocument } from './bson-display'

const MAX_TEXT = 2 * 1024 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 20000
const INT_MIN = -2147483648n, INT_MAX = 2147483647n
const LONG_MIN = -9223372036854775808n, LONG_MAX = 9223372036854775807n
const numericWrappers = { Int32: '$numberInt', Long: '$numberLong', Double: '$numberDouble', Decimal128: '$numberDecimal' } as const
const reservedKeys = new Set(['$oid', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal', '$date', '$timestamp', '$binary', '$regularExpression', '$regex', '$options', '$symbol', '$code', '$scope', '$ref', '$id', '$db', '$minKey', '$maxKey', '$undefined', '$uuid', '$type'])
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

function own(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}
const quote = (value: string): string => JSON.stringify(value)
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('UNSUPPORTED_BSON')
  return value
}
function call(name: string, ...args: string[]): string { return name + '(' + args.join(', ') + ')' }

/** Format only known types. Unknown, ambiguous or limited metadata uses raw EJSON instead. */
export function formatMongoDocument(canonical: string, metadata?: BsonTypeTree): { text: string; syntax: 'typed' | 'ejson' } {
  const raw = parseBsonDocument(canonical)
  if (!raw) return { text: canonical, syntax: 'ejson' }
  const fallback = { text: JSON.stringify(raw, null, 2), syntax: 'ejson' as const }
  if (canonical.length > MAX_TEXT || !metadata) return fallback
  let nodes = 0
  function format(value: unknown, node: BsonTypeTree | undefined, depth: number): string {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !node) throw new Error('UNSUPPORTED_BSON')
    const type = typeName(node)
    const indent = '  '.repeat(depth), next = indent + '  '
    switch (type) {
      case 'Document': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('UNSUPPORTED_BSON')
        const entries = Object.entries(value)
        if (entries.some(([key]) => reservedKeys.has(key) || forbiddenKeys.has(key))) throw new Error('UNSUPPORTED_BSON')
        if (!entries.length) return '{}'
        return '{\n' + entries.map(([key, child]) => next + quote(key) + ': ' + format(child, childType(node, key), depth + 1)).join(',\n') + '\n' + indent + '}'
      }
      case 'Array':
        if (!Array.isArray(value)) throw new Error('UNSUPPORTED_BSON')
        return value.length ? '[\n' + value.map((child, i) => next + format(child, childType(node, String(i)), depth + 1)).join(',\n') + '\n' + indent + ']' : '[]'
      case 'String': return quote(requireString(value))
      case 'Boolean': if (typeof value === 'boolean') return String(value); break
      case 'Null': if (value === null) return 'null'; break
      case 'ObjectId': return call('ObjectId', quote(requireString(own(value, '$oid'))))
      case 'Int32': return call('Int32', quote(requireString(own(value, '$numberInt'))))
      case 'Int64': return call('Long', quote(requireString(own(value, '$numberLong'))))
      case 'Double': return call('Double', quote(requireString(own(value, '$numberDouble'))))
      case 'Decimal128': return call('Decimal128', quote(requireString(own(value, '$numberDecimal'))))
      case 'Date': {
        const millis = requireString(own(own(value, '$date'), '$numberLong'))
        const ms = Number(millis)
        if (Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15) return call('ISODate', quote(new Date(ms).toISOString()))
        return call('Date', quote(millis))
      }
      case 'Timestamp': {
        const stamp = own(value, '$timestamp'), t = own(stamp, 't'), i = own(stamp, 'i')
        if (typeof t === 'number' && typeof i === 'number') return call('Timestamp', String(t), String(i))
        break
      }
      case 'Binary': {
        const binary = own(value, '$binary')
        const subtype = requireString(own(binary, 'subType'))
        if (!/^[a-f0-9]{2}$/i.test(subtype)) break
        return call('BinData', String(parseInt(subtype, 16)), quote(requireString(own(binary, 'base64'))))
      }
      case 'Regex': {
        const regex = own(value, '$regularExpression')
        return call('Regex', quote(requireString(own(regex, 'pattern'))), quote(requireString(own(regex, 'options'))))
      }
      case 'MinKey': return 'MinKey()'
      case 'MaxKey': return 'MaxKey()'
      default: break
    }
    throw new Error('UNSUPPORTED_BSON')
  }
  try {
    const text = format(raw, metadata, 0)
    if (text.length > MAX_TEXT) return fallback
    // The friendly representation must be lossless before exposing it as an editor.
    if (parseMongoDocumentEditor(text) !== JSON.stringify(raw)) return fallback
    return { text, syntax: 'typed' }
  } catch { return fallback }
}

/** A bounded data grammar; no JS evaluation, property access, or arbitrary calls. */
export function parseMongoDocumentEditor(text: string): string {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('LIMIT_EXCEEDED: 单份文档最多 512 KiB')
  let cursor = 0, nodes = 0
  const fail = (): never => {
    const lines = text.slice(0, cursor).split('\n')
    throw new Error('BSON_EDITOR_INVALID: 文档语法或类型无效（第 ' + lines.length + ' 行，第 ' + (lines.at(-1)!.length + 1) + ' 列）')
  }
  const skip = () => { while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++ }
  function eat(char: string): boolean { skip(); if (text[cursor] !== char) return false; cursor++; return true }
  function expect(char: string) { if (!eat(char)) fail() }
  function stringValue(): string {
    skip()
    if (text[cursor] !== '"') return fail()
    const start = cursor++
    while (cursor < text.length) {
      const char = text[cursor++]!
      if (char === '\\') { cursor++; continue }
      if (char === '"') {
        try { return JSON.parse(text.slice(start, cursor)) as string } catch { return fail() }
      }
      if (char.charCodeAt(0) < 32) return fail()
    }
    return fail()
  }
  function numberToken(): string {
    skip()
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor))
    if (!match) return fail()
    cursor += match[0].length
    return match[0]
  }
  function numericArg(): string { skip(); return text[cursor] === '"' ? stringValue() : numberToken() }
  function integer(value: string, min: bigint, max: bigint): string {
    if (!/^-?(?:0|[1-9]\d*)$/.test(value) || value.length > 21) return fail()
    const exact = BigInt(value)
    if (exact < min || exact > max) return fail()
    return exact.toString()
  }
  function double(value: string): string {
    if (['NaN', 'Infinity', '-Infinity'].includes(value)) return value
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) return fail()
    // Reject accidental underflow; ordinary floating-point rounding is the
    // semantics of BSON Double, not the semantics of Long or Decimal128.
    if (Number(value) === 0 && /[1-9]/.test(value.split(/[eE]/)[0]!)) return fail()
    return value
  }
  function decimal(value: string): string {
    if (['NaN', 'Infinity', '-Infinity'].includes(value)) return value
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || value.length > 128) return fail()
    return value // Decimal128 range and exactness are checked by the BSON driver.
  }
  function ctor(name: string): unknown {
    expect('(')
    let result: unknown
    switch (name) {
      case 'ObjectId': {
        const value = stringValue()
        if (!/^[a-f0-9]{24}$/i.test(value)) return fail()
        result = { $oid: value.toLowerCase() }; break
      }
      case 'Int32': case 'Long': case 'Double': case 'Decimal128': {
        const value = numericArg()
        const exact = name === 'Int32' ? integer(value, INT_MIN, INT_MAX) : name === 'Long' ? integer(value, LONG_MIN, LONG_MAX) : name === 'Double' ? double(value) : decimal(value)
        result = { [numericWrappers[name]]: exact }; break
      }
      case 'ISODate': {
        const value = stringValue()
        if (!/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return fail()
        const date = new Date(value)
        if (!Number.isFinite(date.getTime())) return fail()
        const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => '.' + (fraction || '').padEnd(3, '0') + 'Z')
        if (date.toISOString() !== expected) return fail()
        result = { $date: { $numberLong: String(date.getTime()) } }; break
      }
      case 'Date':
        result = { $date: { $numberLong: integer(numericArg(), -8640000000000000n, 8640000000000000n) } }; break
      case 'Timestamp': {
        const t = Number(integer(numericArg(), 0n, 4294967295n)); expect(',')
        const i = Number(integer(numericArg(), 0n, 4294967295n))
        result = { $timestamp: { t, i } }; break
      }
      case 'BinData': {
        const subtype = Number(integer(numericArg(), 0n, 255n)); expect(',')
        const base64 = stringValue()
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return fail()
        result = { $binary: { base64, subType: subtype.toString(16).padStart(2, '0') } }; break
      }
      case 'Regex': {
        const pattern = stringValue(); expect(','); const options = stringValue()
        if (pattern.includes('\0') || !/^[ilmsux]*$/.test(options) || new Set(options).size !== options.length) return fail()
        result = { $regularExpression: { pattern, options: [...options].sort().join('') } }; break
      }
      case 'MinKey': result = { $minKey: 1 }; break
      case 'MaxKey': result = { $maxKey: 1 }; break
      default: return fail()
    }
    expect(')')
    return result
  }
  function value(depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return fail()
    skip()
    if (eat('{')) {
      const out: Record<string, unknown> = Object.create(null)
      if (eat('}')) return out
      do {
        const key = stringValue()
        if (Object.hasOwn(out, key) || forbiddenKeys.has(key) || reservedKeys.has(key) || key.includes('\0')) return fail()
        expect(':'); out[key] = value(depth + 1)
        if (eat('}')) return out
        expect(',')
      } while (true)
    }
    if (eat('[')) {
      const out: unknown[] = []
      if (eat(']')) return out
      do { out.push(value(depth + 1)); if (eat(']')) return out; expect(',') } while (true)
    }
    const first = text[cursor]
    if (first === '"') return stringValue()
    if (first === '-' || (first && /\d/.test(first))) {
      const token = numberToken()
      if (!/[.eE]/.test(token) && token !== '-0') {
        const exact = integer(token, LONG_MIN, LONG_MAX)
        const n = BigInt(exact)
        return n >= INT_MIN && n <= INT_MAX ? { $numberInt: exact } : { $numberLong: exact }
      }
      return { $numberDouble: double(token) }
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(cursor))
    if (!ident) return fail()
    cursor += ident[0].length
    if (ident[0] === 'true') return true
    if (ident[0] === 'false') return false
    if (ident[0] === 'null') return null
    return ctor(ident[0])
  }
  skip()
  if (text[cursor] !== '{') return fail()
  const document = value(0)
  skip()
  if (cursor !== text.length) return fail()
  return JSON.stringify(document)
}
