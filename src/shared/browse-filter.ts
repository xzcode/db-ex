import { parseMongoDocumentEditor } from './bson-editor'
import type { SqlValue } from './types'

export const filterOperators = ['eq','ne','lt','lte','gt','gte','contains','notContains','starts','notStarts','ends','notEnds','null','notNull','empty','notEmpty','in','notIn','exists','missing','isType','notType','custom'] as const
export type FilterOperator = typeof filterOperators[number]
export const filterTypes = ['String','Int32','Long','Double','Decimal128','ObjectId','ISODate','Boolean','Number','Custom'] as const
export type FilterType = typeof filterTypes[number]
export const mongoFieldTypes = ['double','string','object','array','binData','undefined','objectId','bool','date','null','regex','dbPointer','javascript','symbol','javascriptWithScope','int','timestamp','long','decimal','minKey','maxKey','number'] as const
export const mongoOnlyOperators: readonly FilterOperator[] = ['exists','missing','isType','notType','custom']
export const stringOperators: readonly FilterOperator[] = ['contains','notContains','starts','notStarts','ends','notEnds']
export const listOperators: readonly FilterOperator[] = ['in','notIn']
/** Presentation-only preference; the compiler still uses the explicit BSON type. */
export type FilterValueTypeMode = 'manual' | 'suggested' | 'auto-object-id'
export interface FilterRule { field: string; operator: FilterOperator; type: FilterType; value: string; enabled?: boolean; join?: 'and' | 'or'; valueTypeMode?: FilterValueTypeMode }
export interface FilterGroup { join: 'and' | 'or'; rules: FilterRule[]; joinNext?: 'and' | 'or'; enabled?: boolean }
export interface SortRule { field: string; direction: 1 | -1 }
export interface BrowseFilter { join: 'and' | 'or'; groups: FilterGroup[]; sort: SortRule[] }
export function newBrowseFilter(): BrowseFilter { return { join: 'and', groups: [], sort: [] } }
export const noValue = (operator: FilterOperator) => ['null','notNull','exists','missing','empty','notEmpty'].includes(operator)
const fail = (): never => { throw new Error('INVALID_FILTER: 筛选或排序条件无效') }
function fieldName(value: unknown, mongo: boolean): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) return fail()
  if (mongo && value.split('.').some(part => !part || part.startsWith('$') || ['__proto__','constructor','prototype'].includes(part))) return fail()
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
    if (!group || !Array.isArray(group.rules) || !group.rules.length || (total += group.rules.length) > 50 || (group.enabled !== undefined && typeof group.enabled !== 'boolean')) return fail()
    const fallback = join(group.join)
    const rules = group.rules.map(rule => {
      if (!rule || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')) return fail()
      const next = rule.join === undefined ? fallback : join(rule.join)
      if (rule.enabled === false || group.enabled === false) return { ...rule, join: next, enabled: false }
      if (!filterOperators.includes(rule.operator) || (!mongo && mongoOnlyOperators.includes(rule.operator)) || !filterTypes.includes(rule.type) || typeof rule.value !== 'string' || rule.value.length > 16384) return fail()
      if (!mongo && ['ObjectId','ISODate','Number','Custom'].includes(rule.type)) return fail()
      if (stringOperators.includes(rule.operator) && rule.type !== 'String') return fail()
      return { field: fieldName(rule.field, mongo), operator: rule.operator, type: rule.type, value: rule.value, enabled: true, join: next }
    }).filter(rule => rule.enabled !== false)
    return { join: fallback, joinNext: group.joinNext === undefined ? join(value.join) : join(group.joinNext), rules }
  }).filter(group => group.rules.length)
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
function typedValue(rule: FilterRule, value = rule.value): unknown {
  if (value.length > 4096) return fail()
  if (rule.type === 'String') return value
  if (rule.type === 'Custom') {
    const document = JSON.parse(parseMongoDocumentEditor('{"v":' + value + '}'))
    if (Object.keys(document).length !== 1 || !Object.hasOwn(document,'v')) return fail()
    return document.v
  }
  if (rule.type === 'Number') {
    const input = value.trim()
    // Numeric literals never pass through JSON.parse as JavaScript numbers.
    // Signed integral values use Int32 or Long; fractional literals use
    // Double at ordinary precision and Decimal128 when greater precision is
    // required. Explicit BSON constructors remain available under Custom.
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input) || input.length > 128) return fail()
    let constructor: 'Int32'|'Long'|'Double'|'Decimal128'
    if (/^-?\d+$/.test(input) && input !== '-0') {
      const n = BigInt(input)
      constructor = n >= -2147483648n && n <= 2147483647n ? 'Int32'
        : n >= -9223372036854775808n && n <= 9223372036854775807n ? 'Long' : 'Decimal128'
    } else {
      const significant = input.split(/[eE]/)[0]!.replace(/[-.]/g,'').replace(/^0+/,'').replace(/0+$/,'').length
      const numeric = Number(input)
      constructor = significant <= 15 && Number.isFinite(numeric) && (numeric !== 0 || !/[1-9]/.test(input.split(/[eE]/)[0]!)) ? 'Double' : 'Decimal128'
    }
    if (constructor === 'Decimal128') {
      const mantissa = input.split(/[eE]/)[0]!
      if (mantissa.replace(/[-.]/g,'').replace(/^0+/,'').replace(/0+$/,'').length > 34) return fail()
    }
    return JSON.parse(parseMongoDocumentEditor('{"v":'+constructor+'('+JSON.stringify(input)+')}')).v
  }
  if (rule.type === 'Boolean') {
    if (value !== 'true' && value !== 'false') return fail()
    return value === 'true'
  }
  return JSON.parse(parseMongoDocumentEditor('{"v":' + rule.type + '(' + JSON.stringify(value) + ')}')).v
}
export function listValues(text: string): string[] {
  let input: unknown
  try { input = JSON.parse(text) } catch { return fail() }
  if (!Array.isArray(input) || !input.length || input.length > 100 || input.some(v => typeof v !== 'string' || v.length > 4096)) return fail()
  return input
}
type Predicate = Record<string, unknown>
/** AND binds more tightly than OR; explicit groups supply parentheses. */
function combine<T>(values: T[], links: ('and' | 'or')[], merge: (items:T[], mode:'and'|'or')=>T): T | undefined {
  if (!values.length) return undefined
  const chunks: T[][] = [[values[0]!]]
  for (let i=1;i<values.length;i++) {
    if (links[i-1] === 'or') chunks.push([])
    chunks.at(-1)!.push(values[i]!)
  }
  return merge(chunks.map(chunk => merge(chunk,'and')),'or')
}
function mongoJoin(values: Predicate[], mode: 'and'|'or'): Predicate { return values.length === 1 ? values[0]! : { ['$'+mode]: values } }
function mongoRule(rule: FilterRule): Predicate {
  const field = rule.field, op = rule.operator
  if (op === 'null') return { [field]: { $eq:null, $exists:true } }
  if (op === 'notNull') return { [field]: { $ne:null, $exists:true } }
  if (op === 'exists' || op === 'missing') return { [field]: { $exists: op === 'exists' } }
  if (op === 'empty' || op === 'notEmpty') {
    const empty = [{ [field]: { $eq:'' } }, { [field]: { $size:0 } }, { [field]: { $eq:{} } }]
    return op === 'empty' ? { $or:empty } : { $and:[{ [field]:{$exists:true,$ne:null} },{$nor:empty}] }
  }
  if (op === 'isType' || op === 'notType') {
    if (!(mongoFieldTypes as readonly string[]).includes(rule.value)) return fail()
    return { [field]: op === 'isType' ? {$type:rule.value} : {$exists:true,$not:{$type:rule.value}} }
  }
  if (listOperators.includes(op)) return { [field]: { [op === 'in' ? '$in' : '$nin']:listValues(rule.value).map(value=>typedValue(rule,value)), ...(op === 'notIn' ? {$exists:true} : {}) } }
  if (stringOperators.includes(op)) {
    const literal = rule.value.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')
    const regex = (op === 'starts' || op === 'notStarts' ? '^' : '') + literal + (op === 'ends' || op === 'notEnds' ? '$' : '')
    return { [field]:op.startsWith('not') ? {$type:'string',$not:{$regex:regex}} : {$regex:regex} }
  }
  if (op === 'custom') {
    let input: unknown
    try { input = JSON.parse(rule.value) } catch { return fail() }
    const permitted = new Set(['$eq','$ne','$gt','$gte','$lt','$lte','$in','$nin','$exists','$type','$not','$regex','$options','$size','$all','$elemMatch','$mod'])
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key=>!permitted.has(key))) return fail()
    return { [field]: input }
  }
  return { [field]: { ['$'+op]:typedValue(rule) } }
}
export function compileMongoFilter(input: unknown): { filter: string; sort: string } {
  const value = checked(input,true)
  const groups = value.groups.map(group=>combine(group.rules.map(mongoRule),group.rules.map(rule=>rule.join || group.join),mongoJoin)!)
  const filter = combine(groups,value.groups.map(group=>group.joinNext || value.join),mongoJoin) || {}
  return { filter:JSON.stringify(filter), sort:JSON.stringify(Object.fromEntries(value.sort.map(rule=>[rule.field,rule.direction]))) }
}
export function quoteBrowseIdentifier(value: unknown): string { return '\x60'+fieldName(value,false).replace(/\x60/g,'\x60\x60')+'\x60' }
function mysqlBound(rule: FilterRule, value: string, dialect:'mysql'|'sqlite'='mysql'): { value: SqlValue; placeholder: string } {
  if (rule.type === 'Decimal128') {
    const decimal = /^-?(\d+)(?:\.(\d+))?$/.exec(value)
    if (!decimal || decimal[1].replace(/^0+/,'').length>35 || (decimal[2]||'').length>30) return fail()
  }
  const typed = typedValue(rule,value)
  const bound = typeof typed === 'object' && typed !== null ? Object.values(typed)[0] : typed
  if (typeof bound !== 'string' && typeof bound !== 'boolean') return fail()
  if (rule.type === 'Double' && typeof bound === 'string' && !Number.isFinite(Number(bound))) return fail()
  if(dialect==='sqlite')return {value:bound,placeholder:rule.type==='Int32'||rule.type==='Long'?'CAST(? AS INTEGER)':rule.type==='Decimal128'||rule.type==='Double'?'CAST(? AS REAL)':'?'}
  return { value:bound, placeholder:rule.type === 'Int32' || rule.type === 'Long' ? 'CAST(? AS SIGNED)' : rule.type === 'Decimal128' ? 'CAST(? AS DECIMAL(65,30))' : '?' }
}
export function compileMysqlFilter(database:string, entity:string,input:unknown,dialect:'mysql'|'sqlite'='mysql'): { sql:string; countSql:string; parameters:SqlValue[] } {
  const value=checked(input,false), parameters:SqlValue[]=[]
  const sqlJoin=(items:string[],mode:'and'|'or')=>items.length===1?items[0]!: '('+items.join(mode==='and'?' AND ':' OR ')+')'
  function sqlRule(rule:FilterRule):string {
    const field=quoteBrowseIdentifier(rule.field), op=rule.operator
    if (op==='null'||op==='notNull') return field+(op==='null'?' IS NULL':' IS NOT NULL')
    if (op==='empty'||op==='notEmpty') return '('+field+' IS NOT NULL AND '+(dialect==='sqlite'?'LENGTH':'CHAR_LENGTH')+'('+field+') '+(op==='empty'?'=':'>')+' 0)'
    if (stringOperators.includes(op)) {
      const literal=rule.value.replace(/[!%_]/g,char=>'!'+char)
      parameters.push((op==='starts'||op==='notStarts'?'':'%')+literal+(op==='ends'||op==='notEnds'?'':'%'))
      return field+(op.startsWith('not')?' NOT LIKE ?':' LIKE ?')+" ESCAPE '!'"
    }
    if (listOperators.includes(op)) {
      const placeholders=listValues(rule.value).map(item=>{const bound=mysqlBound(rule,item,dialect);parameters.push(bound.value);return bound.placeholder})
      return field+(op==='in'?' IN (':' NOT IN (')+placeholders.join(', ')+')'
    }
    const bound=mysqlBound(rule,rule.value,dialect); parameters.push(bound.value)
    const operators:Record<string,string>={eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}
    return field+' '+operators[op]+' '+bound.placeholder
  }
  const groups=value.groups.map(group=>combine(group.rules.map(sqlRule),group.rules.map(rule=>rule.join||group.join),sqlJoin)!)
  const where=combine(groups,value.groups.map(group=>group.joinNext||value.join),sqlJoin)
  const from=' FROM '+quoteBrowseIdentifier(database)+'.'+quoteBrowseIdentifier(entity)+(where?' WHERE '+where:'')
  const order=value.sort.length?' ORDER BY '+value.sort.map(rule=>quoteBrowseIdentifier(rule.field)+(rule.direction===1?' ASC':' DESC')).join(', '):''
  return {sql:'SELECT *'+from+order,countSql:'SELECT COUNT(*) AS total FROM (SELECT 1'+from+' LIMIT 1000001) AS dbex_count',parameters}
}
export const MAX_BROWSE_OFFSET=1000000
export function browseOffset(page:number,size:number):number {
  if (!Number.isSafeInteger(page)||page<1||![100,200,500].includes(size)||(page-1)*size>MAX_BROWSE_OFFSET) return fail()
  return (page-1)*size
}
