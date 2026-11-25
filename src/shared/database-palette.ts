import { isMysqlFamily } from './relational-capabilities'
import type { DatabaseKind } from './types'
import { mysqlTypes, redisTypes } from './object-inspection'
export interface DatabasePalette { enabled: boolean; showLabels: boolean; overrides: Record<string, string | null> }
const mysqlDefaults: Record<string, string | null> = {
  TINYINT:'#4da96b', SMALLINT:'#4da96b', MEDIUMINT:'#4da96b', INT:'#4da96b', BIGINT:'#956ad9',
  DECIMAL:'#d16b9e', FLOAT:'#32a8aa', DOUBLE:'#32a8aa', BIT:'#d3b12c', YEAR:'#21858d',
  DATE:'#21858d', TIME:'#21858d', DATETIME:'#21858d', TIMESTAMP:'#21858d',
  CHAR:'#4b88d9', VARCHAR:'#4b88d9', TEXT:'#8ab6ff', BINARY:'#ae477e', VARBINARY:'#ae477e',
  BLOB:'#ae477e', JSON:'#e69a38', ENUM:'#d3b12c', SET:'#cc7424', GEOMETRY:'#687589', NULL:null, UNKNOWN:null,
}
const sqliteDefaults:Record<string,string|null>={INTEGER:'#4da96b',REAL:'#32a8aa',TEXT:'#4b88d9',BLOB:'#ae477e',NULL:null}
const redisDefaults: Record<string, string | null> = { string:'#4b88d9', hash:'#4da96b', list:'#e69a38', set:'#32a8aa', zset:'#956ad9', stream:'#d16b9e', none:null, unknown:null }
export function newDatabasePalette(): DatabasePalette { return { enabled: true, showLabels: false, overrides: Object.create(null) } }
export function databaseTypes(kind: Exclude<DatabaseKind, 'mongodb'>): readonly string[] { return kind==='sqlite'?Object.keys(sqliteDefaults):isMysqlFamily(kind) ? mysqlTypes : redisTypes }
export function defaultDatabaseColor(kind: Exclude<DatabaseKind, 'mongodb'>, type: string): string | undefined {
  const defaults = kind==='sqlite'?sqliteDefaults:isMysqlFamily(kind) ? mysqlDefaults : redisDefaults
  return Object.hasOwn(defaults, type) ? defaults[type] || undefined : undefined
}
export function normalizeDatabasePalette(kind: Exclude<DatabaseKind, 'mongodb'>, value: unknown): DatabasePalette {
  const result = newDatabasePalette()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const input = value as Partial<DatabasePalette>
  if (typeof input.enabled === 'boolean') result.enabled = input.enabled
  if (typeof input.showLabels === 'boolean') result.showLabels = input.showLabels
  if (input.overrides && typeof input.overrides === 'object' && !Array.isArray(input.overrides)) for (const key of databaseTypes(kind)) {
    if (!Object.hasOwn(input.overrides, key)) continue
    const color = input.overrides[key]
    if (color === null || typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) result.overrides[key] = typeof color === 'string' ? color.toLowerCase() : null
  }
  return result
}
export function databaseTypeColor(kind: Exclude<DatabaseKind, 'mongodb'>, palette: DatabasePalette, type: string): string | undefined {
  if (!databaseTypes(kind).includes(type)) return undefined
  return Object.hasOwn(palette.overrides, type) ? palette.overrides[type] || undefined : defaultDatabaseColor(kind, type)
}
