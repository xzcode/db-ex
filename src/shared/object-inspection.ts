export interface ObjectMetric { label: string; value: string; format?: 'bytes' | 'boolean' | 'estimate' }
export interface ObjectInspection {
  kind: 'table' | 'view' | 'collection' | 'key'
  metrics: ObjectMetric[]
  definition?: string
  infoNote?: string
  definitionNote?: string
}
/** Keep integer metadata as strings, including server Long values. */
export function metric(label: string, value: unknown, format?: ObjectMetric['format']): ObjectMetric | undefined {
  if (value === null || value === undefined) return undefined
  const text = typeof value === 'object' && typeof value.toString === 'function' ? String(value) : typeof value !== 'object' ? String(value) : ''
  return !text || text === '[object Object]' ? undefined : { label, value: text, format }
}
export function metrics(...values: (ObjectMetric | undefined)[]): ObjectMetric[] { return values.filter((value): value is ObjectMetric => value !== undefined) }
export function formatBytes(text: string, locale: string): string {
  if (!/^\d+$/.test(text)) return text
  const exact = BigInt(text)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let divisor = 1n, i = 0
  while (i < units.length - 1 && exact >= divisor * 1024n) { divisor *= 1024n; i++ }
  const hundredths = (exact * 100n + divisor / 2n) / divisor
  const short = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(hundredths) / 100)
  return short + ' ' + units[i] + ' (' + new Intl.NumberFormat(locale).format(exact) + ')'
}
/** MySQL wire column type codes, not JavaScript value inference. */
export const mysqlTypes = ['TINYINT','SMALLINT','MEDIUMINT','INT','BIGINT','DECIMAL','FLOAT','DOUBLE','BIT','YEAR','DATE','TIME','DATETIME','TIMESTAMP','CHAR','VARCHAR','TEXT','BINARY','VARBINARY','BLOB','JSON','ENUM','SET','GEOMETRY','NULL','UNKNOWN'] as const
export const redisTypes = ['string','hash','list','set','zset','stream','none','unknown'] as const
export function mysqlFieldType(field: { columnType?: number; characterSet?: number; flags?: number }): string {
  const binary = field.characterSet === 63
  switch (field.columnType) {
    case 0: case 246: return 'DECIMAL'
    case 1: return 'TINYINT'
    case 2: return 'SMALLINT'
    case 3: return 'INT'
    case 4: return 'FLOAT'
    case 5: return 'DOUBLE'
    case 6: return 'NULL'
    case 7: case 17: return 'TIMESTAMP'
    case 8: return 'BIGINT'
    case 9: return 'MEDIUMINT'
    case 10: case 14: return 'DATE'
    case 11: case 19: return 'TIME'
    case 12: case 18: return 'DATETIME'
    case 13: return 'YEAR'
    case 15: case 253: return binary ? 'VARBINARY' : 'VARCHAR'
    case 16: return 'BIT'
    case 245: return 'JSON'
    case 247: return 'ENUM'
    case 248: return 'SET'
    case 249: case 250: case 251: case 252: return binary ? 'BLOB' : 'TEXT'
    case 254: return (field.flags || 0) & 256 ? 'ENUM' : (field.flags || 0) & 2048 ? 'SET' : binary ? 'BINARY' : 'CHAR'
    case 255: return 'GEOMETRY'
    default: return 'UNKNOWN'
  }
}
export function redisTypeName(value: unknown): string { return typeof value === 'string' && redisTypes.some(x => x === value) ? value : 'unknown' }
