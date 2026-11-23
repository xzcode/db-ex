import type { OperationResult, SqlRow, SqlValue } from '../../shared/types'

export const MAX_ROWS = 500
export const MAX_BYTES = 2 * 1024 * 1024
export const MAX_VALUE_BYTES = 512 * 1024
export const TIMEOUT_MS = 30_000

export interface OperationContext {
  writable: boolean
  confirmed: boolean
  signal?: AbortSignal
}

export function requireWrite(context: OperationContext): void {
  if (!context.writable) throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
  if (!context.confirmed) throw new Error('CONFIRMATION_REQUIRED: 写操作需要明确确认')
}

export function resourceName(value: unknown, label = '资源'): string {
  if (typeof value !== 'string' || !value.length || value.length > 200 || value.includes('\0')) {
    throw new Error(`INVALID_INPUT: ${label}名称无效`)
  }
  return value
}

export function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`INVALID_INPUT: ${label}必须在 ${min} 至 ${max} 之间`)
  }
  return value
}

export function page(value: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: integer(value.limit, 100, 1, MAX_ROWS, '每页数量'),
    offset: integer(value.offset, 0, 0, 1_000_000, '偏移量'),
  }
}

export function boundedText(value: unknown, label: string, max = MAX_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`INVALID_INPUT: ${label}必须是小于 ${Math.floor(max / 1024)} KiB 的文本`)
  }
  return value
}

export function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`INVALID_INPUT: ${label}必须是对象`)
  }
  return value as Record<string, unknown>
}

export function sqlRow(value: unknown, label: string): SqlRow {
  const input = plainObject(value, label)
  const result: SqlRow = Object.create(null) as SqlRow
  if (Object.keys(input).length > 500) throw new Error('LIMIT_EXCEEDED: 一行最多 500 个字段')
  for (const [key, item] of Object.entries(input)) {
    resourceName(key, '字段')
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
      throw new Error(`INVALID_INPUT: ${label}只接受字符串、数字、布尔值和 null；JSON 字段请传 JSON 字符串`)
    }
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
      throw new Error('INVALID_INPUT: 数值必须有限且整数不能超过安全范围；BIGINT / DECIMAL 请使用字符串')
    }
    if (typeof item === 'string') boundedText(item, '字段值', MAX_VALUE_BYTES)
    result[key] = item as SqlValue
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('LIMIT_EXCEEDED: 单行超过 2 MiB')
  return result
}

export function displayCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  let text: string
  if (Buffer.isBuffer(value)) text = `base64:${value.subarray(0, 3072).toString('base64')}${value.length > 3072 ? '…' : ''}`
  else if (typeof value === 'bigint') text = value.toString()
  else if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object') text = JSON.stringify(value)
  else text = String(value)
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text
}

export function emptyResult(message: string, affectedRows?: number): OperationResult {
  return { columns: [], rows: [], message, affectedRows }
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('CANCELLED: 操作已取消')
}

/** Driver errors can embed SQL, documents and credentials. Keep only stable public codes. */
export function databaseError(error: unknown): Error {
  if (error instanceof Error && /^[A-Z_]+:/.test(error.message)) return error
  const input = error as { code?: unknown; codeName?: unknown }
  const code = String(input?.codeName ?? input?.code ?? 'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return new Error(`DATABASE_ERROR: 数据库操作失败（${code}）。请检查语法、权限、字段类型和约束`)
}
