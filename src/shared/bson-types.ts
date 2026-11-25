/** BSON metadata only: this module is safe to share with the sandboxed renderer. */
export const bsonTypes = [
  'ObjectId', 'String', 'Int32', 'Int64', 'Double', 'Decimal128', 'Boolean',
  'Date', 'Timestamp', 'Array', 'Document', 'Binary', 'Regex', 'Null',
  'Undefined', 'JavaScript', 'JavaScriptWithScope', 'Symbol', 'DBRef',
  'MinKey', 'MaxKey', 'Number', 'Missing', 'Unknown',
] as const
export type BsonType = typeof bsonTypes[number]
export interface BsonTypeBranch {
  type: 'Document' | 'Array'
  children: Record<string, BsonTypeTree>
  /** Optional extra/nested metadata was omitted because of a bounded preview budget. */
  limited?: boolean
}
export type BsonTypeTree = BsonType | BsonTypeBranch
export function isBsonType(value: unknown): value is BsonType { return bsonTypes.some(type => type === value) }
export function typeName(node?: BsonTypeTree): BsonType { return typeof node === 'string' ? node : node?.type || 'Unknown' }
export function childType(node: BsonTypeTree | undefined, key: string): BsonTypeTree | undefined {
  return node && typeof node === 'object' && Object.hasOwn(node.children, key) ? node.children[key] : undefined
}
export function gridBsonType(row: Record<string, unknown>, tree: BsonTypeTree | undefined, key: string): BsonType {
  if (!Object.hasOwn(row, key)) return 'Missing'
  return typeName(childType(tree, key))
}
export function bsonLabel(type: BsonType): string {
  return type === 'Missing' ? '缺失字段' : type === 'Unknown' ? '未知类型' : type
}
