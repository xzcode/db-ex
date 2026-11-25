import { parseMongoDocumentEditor } from './bson-editor'
import type { SqlValue } from './types'

export const filterOperators = ['eq','ne','gt','gte','lt','lte','contains','null','notNull','exists','missing'] as const
export type FilterOperator = typeof filterOperators[number]
export const filterTypes = ['String','Int32','Long','Double','Decimal128','ObjectId','ISODate','Boolean'] as const
export type FilterType = typeof filterTypes[number]
export interface FilterRule { field: string; operator: FilterOperator; type: FilterType; value: string }
export interface FilterGroup { join: 'and' | 'or'; rules: FilterRule[] }
export interface SortRule { field: string; direction: 1 | -1 }
export interface BrowseFilter { join: 'and' | 'or'; groups: FilterGroup[]; sort: SortRule[] }
export function newBrowseFilter(): BrowseFilter { return { join: 'and', groups: [], sort: [] } }
export const noValue = (operator: FilterOperator) => ['null','notNull','exists','missing'].includes(operator)
const fail = (): never => { throw new Error('INVALID_FILTER: 筛选或排序条件无效') }
function fieldName(value: unknown, mongo: boolean): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) return fail()
  if (mongo && value.split('.').some(part => !part || part.startsWith('$') || ['__proto__','constructor','prototype'].includes(part))) return fail()
  // Backslashes in quoted SQL identifiers are deliberately refused; names are
  // never interpreted as fragments of SQL, even when supplied over IPC.
  if (!mongo && value.includes('\\')) return fail()
  return value
}
function join(value: unknown): 'and' | 'or' { if (value === 'and' || value === 'or') return value; return fail() }
function checked(input: unknown, mongo: boolean): BrowseFilter {
  if (!input || typeof input !== 'object') return fail()
  const value = input as BrowseFilter
  if (!Array.isArray(value.groups) || value.groups.length > 12 || !Array.isArray(value.sort) || value.sort.length > 32) return fail()
  let total = 0
  const groups = value.groups.map(group => {
    if (!group || !Array.isArray(group.rules) || !group.rules.length || (total += group.rules.length) > 50) return fail()
    return { join: join(group.join), rules: group.rules.map(rule => {
      if (!rule || !filterOperators.includes(rule.operator) || (!mongo && ['exists','missing'].includes(rule.operator)) || !filterTypes.includes(rule.type) || typeof rule.value !== 'string' || rule.value.length > 4096) return fail()
      if (!mongo && ['ObjectId','ISODate'].includes(rule.type)) return fail()
      if (rule.operator === 'contains' && rule.type !== 'String') return fail()
      return { field: fieldName(rule.field, mongo), operator: rule.operator, type: rule.type, value: rule.value }
    }) }
  })
  const seen = new Set<string>()
  const sort = value.sort.map(rule => {
    if (!rule || (rule.direction !== 1 && rule.direction !== -1)) return fail()
    const field = fieldName(rule.field, mongo)
    if (seen.has(field)) return fail()
    seen.add(field)
    return { field, direction: rule.direction }
  })
  return { join: join(value.join), groups, sort }
}
function typedValue(rule: FilterRule): unknown {
  if (rule.type === 'String') return rule.value
  if (rule.type === 'Boolean') {
    if (rule.value !== 'true' && rule.value !== 'false') return fail()
    return rule.value === 'true'
  }
  // Reuse the non-executable BSON grammar for exact int64 and decimal text.
  return JSON.parse(parseMongoDocumentEditor('{"v":' + rule.type + '(' + JSON.stringify(rule.value) + ')}')).v
}
function combineMongo(values: Record<string, unknown>[], mode: 'and' | 'or'): Record<string, unknown> {
  return values.length === 0 ? {} : values.length === 1 ? values[0] : { ['$' + mode]: values }
}
export function compileMongoFilter(input: unknown): { filter: string; sort: string } {
  const value = checked(input, true)
  const groups = value.groups.map(group => combineMongo(group.rules.map(rule => {
    if (rule.operator === 'null') return { [rule.field]: { $eq: null, $exists: true } }
    if (rule.operator === 'notNull') return { [rule.field]: { $ne: null, $exists: true } }
    if (rule.operator === 'exists' || rule.operator === 'missing') return { [rule.field]: { $exists: rule.operator === 'exists' } }
    if (rule.operator === 'contains') return { [rule.field]: { $regex: rule.value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') } }
    return { [rule.field]: { ['$' + rule.operator]: typedValue(rule) } }
  }), group.join))
  return { filter: JSON.stringify(combineMongo(groups, value.join)), sort: JSON.stringify(Object.fromEntries(value.sort.map(rule => [rule.field, rule.direction]))) }
}
export function quoteBrowseIdentifier(value: unknown): string { return '\x60' + fieldName(value, false).replace(/\x60/g, '\x60\x60') + '\x60' }
export function compileMysqlFilter(database: string, entity: string, input: unknown): { sql: string; countSql: string; parameters: SqlValue[] } {
  const value = checked(input, false)
  const parameters: SqlValue[] = []
  const groups = value.groups.map(group => '(' + group.rules.map(rule => {
    const field = quoteBrowseIdentifier(rule.field)
    if (rule.operator === 'null' || rule.operator === 'notNull') return field + (rule.operator === 'null' ? ' IS NULL' : ' IS NOT NULL')
    if (rule.operator === 'contains') {
      parameters.push('%' + rule.value.replace(/[!%_]/g, char => '!' + char) + '%')
      return field + " LIKE ? ESCAPE '!'"
    }
    // Numeric inputs remain exact decimal text sent as bound values; SQL
    // column types control coercion. Never interpolate user values into SQL.
    if (rule.type === 'Decimal128') {
      const decimal = /^-?(\d+)(?:\.(\d+))?$/.exec(rule.value)
      if (!decimal || decimal[1].replace(/^0+/, '').length > 35 || (decimal[2] || '').length > 30) return fail()
    }
    const typed = typedValue(rule)
    const bound = typeof typed === 'object' && typed !== null ? Object.values(typed)[0] : typed
    if (typeof bound !== 'string' && typeof bound !== 'boolean') return fail()
    parameters.push(bound)
    const operators: Record<string, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
    const placeholder = rule.type === 'Int32' || rule.type === 'Long' ? 'CAST(? AS SIGNED)' : rule.type === 'Decimal128' ? 'CAST(? AS DECIMAL(65,30))' : '?'
    return field + ' ' + operators[rule.operator] + ' ' + placeholder
  }).join(group.join === 'and' ? ' AND ' : ' OR ') + ')')
  const from = ' FROM ' + quoteBrowseIdentifier(database) + '.' + quoteBrowseIdentifier(entity) + (groups.length ? ' WHERE ' + groups.join(value.join === 'and' ? ' AND ' : ' OR ') : '')
  const order = value.sort.length ? ' ORDER BY ' + value.sort.map(rule => quoteBrowseIdentifier(rule.field) + (rule.direction === 1 ? ' ASC' : ' DESC')).join(', ') : ''
  return { sql: 'SELECT *' + from + order, countSql: 'SELECT COUNT(*) AS total FROM (SELECT 1' + from + ' LIMIT 1000001) AS dbex_count', parameters }
}
export const MAX_BROWSE_OFFSET = 1000000
export function browseOffset(page: number, size: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || ![100,200,500].includes(size) || (page - 1) * size > MAX_BROWSE_OFFSET) return fail()
  return (page - 1) * size
}
