import type { BsonType } from './bson-types'

type Translate = (key: string, values?: readonly unknown[]) => string
const literal: Translate = (key, values = []) => key.replace(/\{(\d+)\}/g, (all, index) => Number(index) < values.length ? String(values[Number(index)]) : all)
function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined
}
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : undefined
}
function numeric(value: unknown, key: string): string | undefined {
  // Canonical EJSON represents numbers as text; never convert to JS numbers.
  return scalar(field(value, key)) ?? scalar(value)
}
function dateDisplay(value: unknown): string | undefined {
  const data = field(value, '$date')
  const millis = numeric(data, '$numberLong')
  if (millis === undefined) return undefined
  if (!/^-?\d+$/.test(millis)) return millis // relaxed ISO date, if supplied
  const ms = Number(millis)
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > 8.64e15) return millis + ' ms'
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC')
}
function binaryLength(value: unknown): number | undefined {
  const encoded = field(field(value, '$binary'), 'base64')
  if (typeof encoded !== 'string') return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return undefined
  return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
}
export function parseBsonDocument(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
/**
 * Format a decoded canonical EJSON value using its separately supplied actual
 * BSON type. A literal document with a $oid or $numberLong field is NOT a
 * scalar. No formatting result is ever used for edits, predicates or exports.
 */
export function formatBsonValue(type: BsonType, value: unknown, t: Translate = literal): string {
  let text: string | undefined
  switch (type) {
    case 'Missing': return '—'
    case 'Null': return '(NULL)'
    case 'Undefined': return '(Undefined)'
    case 'ObjectId': text = scalar(field(value, '$oid')); break
    case 'Int32': text = numeric(value, '$numberInt'); break
    case 'Int64': text = numeric(value, '$numberLong'); break
    case 'Double': text = numeric(value, '$numberDouble'); break
    case 'Decimal128': text = numeric(value, '$numberDecimal'); break
    case 'String': case 'Boolean': case 'Number': text = scalar(value); break
    case 'Date': text = dateDisplay(value); break
    case 'Timestamp': {
      const timestamp = field(value, '$timestamp')
      const seconds = numeric(field(timestamp, 't'), '$numberLong')
      const increment = numeric(field(timestamp, 'i'), '$numberLong')
      if (seconds !== undefined && increment !== undefined) text = seconds + ':' + increment
      break
    }
    case 'Array':
      if (Array.isArray(value)) return t('(Array) {0} 个元素', [value.length])
      break
    case 'Document':
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return t('(Document) {0} 个字段', [Object.keys(value).length])
      break
    case 'Binary': {
      const size = binaryLength(value)
      if (size !== undefined) return t('(Binary) {0} 字节', [size])
      break
    }
    case 'Regex': {
      const regex = field(value, '$regularExpression')
      const pattern = scalar(field(regex, 'pattern'))
      if (pattern !== undefined) text = '/' + pattern + '/' + (scalar(field(regex, 'options')) ?? '')
      break
    }
    case 'Symbol': text = scalar(field(value, '$symbol')); break
    case 'JavaScript': case 'JavaScriptWithScope':
      text = scalar(field(value, '$code')); break
    case 'DBRef': text = scalar(field(value, '$ref')); break
    case 'MinKey': case 'MaxKey': return '(' + type + ')'
    case 'Unknown': text = scalar(value); break
  }
  text ??= '(' + type + ')'
  return text.length > 4096 ? text.slice(0, 4096) + '…' : text
}
