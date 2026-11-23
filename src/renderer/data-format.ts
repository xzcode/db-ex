import Papa from 'papaparse'
import type { FileImport, SqlRow, SqlValue } from '../shared/types'

export function sqlRowsFromFile(file: FileImport): SqlRow[] {
  let rows: unknown
  if (file.format === 'csv') {
    const parsed = Papa.parse<Record<string, string>>(file.text, { header: true, skipEmptyLines: 'greedy' })
    if (parsed.errors.length) throw new Error(`CSV 第 ${parsed.errors[0].row ?? 0} 行：${parsed.errors[0].message}`)
    const fields = parsed.meta.fields || []
    if (Object.keys(parsed.meta.renamedHeaders || {}).length || !fields.length || fields.some(field => !field) || new Set(fields).size !== fields.length) throw new Error('CSV 表头必须非空且不重复')
    rows = parsed.data.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === '\\N' ? null : value])))
  } else {
    rows = JSON.parse(file.text)
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('每批导入需要 1–500 条记录')
  return rows.map(validateSqlRow)
}

export function validateSqlRow(value: unknown): SqlRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('每条记录必须是 JSON 对象')
  const result: SqlRow = {}
  for (const [key, item] of Object.entries(value)) {
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('记录包含不支持的字段名')
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`字段 ${key} 需要字符串、数字、布尔或 null`)
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) throw new Error(`字段 ${key} 的数值超出安全范围，请使用字符串`)
    result[key] = item as SqlValue
  }
  return result
}

export function csvFromRows(columns: string[], rows: Record<string, unknown>[]): string {
  return '\uFEFF' + Papa.unparse({ fields: columns, data: rows.map(row => columns.map(column => row[column] === null ? '\\N' : row[column] ?? '')) }, { escapeFormulae: true })
}
