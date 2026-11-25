import { BSON, type Document } from 'mongodb'
import type { BsonType, BsonTypeBranch, BsonTypeTree } from '../../shared/bson-types'

/** Classify decoded BSON wrappers, never infer types from stringified values. */
export function bsonValueType(value: unknown): BsonType {
  if (value === null) return 'Null'
  if (value === undefined) return 'Undefined'
  if (typeof value === 'string') return 'String'
  if (typeof value === 'boolean') return 'Boolean'
  if (typeof value === 'number') return 'Number' // fallback for a non-raw driver result
  if (typeof value === 'bigint') return 'Int64'
  if (Array.isArray(value)) return 'Array'
  if (value instanceof Date) return 'Date'
  if (value instanceof RegExp) return 'Regex'
  if (value instanceof Uint8Array) return 'Binary'
  if (value instanceof BSON.BSONValue) {
    // Timestamp extends Long; _bsontype distinguishes them without value coercion.
    switch (value._bsontype) {
      case 'ObjectId': return 'ObjectId'
      case 'Int32': return 'Int32'
      case 'Long': return 'Int64'
      case 'Double': return 'Double'
      case 'Decimal128': return 'Decimal128'
      case 'Timestamp': return 'Timestamp'
      case 'Binary': return 'Binary'
      case 'BSONRegExp': return 'Regex'
      case 'BSONSymbol': return 'Symbol'
      case 'DBRef': return 'DBRef'
      case 'MinKey': return 'MinKey'
      case 'MaxKey': return 'MaxKey'
      case 'Code': return (value as BSON.Code).scope == null ? 'JavaScript' : 'JavaScriptWithScope'
      default: return 'Unknown'
    }
  }
  return value && typeof value === 'object' ? 'Document' : 'Unknown'
}
export interface TypeBudget { nodes: number; bytes: number }
export function newTypeBudget(): TypeBudget { return { nodes: 20_000, bytes: 1024 * 1024 } }
function fields(): Record<string, BsonTypeTree> { return Object.create(null) as Record<string, BsonTypeTree> }
function reserve(budget: TypeBudget, key: string): boolean {
  // Include escaped field names and conservative node overhead.
  const bytes = Buffer.byteLength(JSON.stringify(key), 'utf8') + 64
  if (budget.nodes <= 0 || budget.bytes < bytes) return false
  budget.nodes--; budget.bytes -= bytes
  return true
}
/**
 * Always describe every displayed grid field. Extra document fields and
 * nested branches use a separate bounded budget; omission is explicit.
 * Values are not copied, and metadata cannot change a document or write path.
 */
export function describeBsonDocument(document: Document, gridKeys: string[], budget: TypeBudget = newTypeBudget()): BsonTypeBranch {
  const root: BsonTypeBranch = { type: 'Document', children: fields() }
  const visible = new Set(gridKeys)
  for (const key of visible) {
    if (Object.hasOwn(document, key)) root.children[key] = bsonValueType(document[key])
  }
  const local: TypeBudget = { nodes: Math.min(2048, budget.nodes), bytes: Math.min(128 * 1024, budget.bytes) }
  const start = { ...local }
  function visit(value: unknown, depth: number): BsonTypeTree {
    const type = bsonValueType(value)
    if (type !== 'Document' && type !== 'Array') return type
    const branch: BsonTypeBranch = { type, children: fields() }
    if (depth >= 64) { branch.limited = true; return branch }
    for (const [key, child] of Object.entries(value as object)) {
      if (!reserve(local, key)) { branch.limited = true; break }
      branch.children[key] = visit(child, depth + 1)
    }
    return branch
  }
  // Shallow visible types have already been stored, even if nested metadata
  // is exhausted by previous documents. Prefer these branches next.
  for (const key of visible) {
    if (!Object.hasOwn(document, key)) continue
    const type = root.children[key]
    if (type === 'Document' || type === 'Array') {
      if (local.nodes <= 0 || local.bytes <= 0) root.limited = true
      else root.children[key] = visit(document[key], 1)
    }
  }
  for (const [key, value] of Object.entries(document)) {
    if (visible.has(key)) continue
    if (!reserve(local, key)) { root.limited = true; break }
    root.children[key] = visit(value, 1)
  }
  budget.nodes -= start.nodes - local.nodes
  budget.bytes -= start.bytes - local.bytes
  return root
}
