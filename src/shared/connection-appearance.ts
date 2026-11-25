import type { ConnectionAppearance, ConnectionAppearancePatch, ConnectionConfig } from './types'

export const connectionColors: readonly { color: string; label: string; variant?: boolean }[] = [
  { color: '#e05252', label: '红色' },
  { color: '#e69a38', label: '橙色' },
  { color: '#d3b12c', label: '黄色' },
  { color: '#4da96b', label: '绿色' },
  { color: '#32a8aa', label: '青色' },
  { color: '#4b88d9', label: '蓝色' },
  { color: '#956ad9', label: '紫色' },
  { color: '#d16b9e', label: '粉色' },
  { color: '#8993a2', label: '灰色' },
  { color: '#ff8181', label: '红色', variant: true },
  { color: '#bc3543', label: '红色', variant: true },
  { color: '#8e2635', label: '红色', variant: true },
  { color: '#ffc37d', label: '橙色', variant: true },
  { color: '#cc7424', label: '橙色', variant: true },
  { color: '#955122', label: '橙色', variant: true },
  { color: '#f7dc73', label: '黄色', variant: true },
  { color: '#b38d1c', label: '黄色', variant: true },
  { color: '#7e6625', label: '黄色', variant: true },
  { color: '#8bd6a3', label: '绿色', variant: true },
  { color: '#2b8553', label: '绿色', variant: true },
  { color: '#246343', label: '绿色', variant: true },
  { color: '#7de2d8', label: '青色', variant: true },
  { color: '#21858d', label: '青色', variant: true },
  { color: '#22646a', label: '青色', variant: true },
  { color: '#8ab6ff', label: '蓝色', variant: true },
  { color: '#315eb7', label: '蓝色', variant: true },
  { color: '#243e83', label: '蓝色', variant: true },
  { color: '#c3a1ff', label: '紫色', variant: true },
  { color: '#7447bb', label: '紫色', variant: true },
  { color: '#50358a', label: '紫色', variant: true },
  { color: '#f3a4cd', label: '粉色', variant: true },
  { color: '#ae477e', label: '粉色', variant: true },
  { color: '#82345f', label: '粉色', variant: true },
  { color: '#c5cbd4', label: '灰色', variant: true },
  { color: '#687589', label: '灰色', variant: true },
  { color: '#454d5a', label: '灰色', variant: true },
]

export function normalizeColor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('INVALID_CONNECTION: 连接颜色无效')
  return value.toLowerCase()
}
export function normalizeGroup(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length > 80) throw new Error('INVALID_CONNECTION: 分组名称无效')
  return value.trim() || undefined
}
export function normalizeAppearance(value: { color?: unknown; group?: unknown }): ConnectionAppearance {
  return { color: normalizeColor(value.color), group: normalizeGroup(value.group) }
}
/** A metadata-only edit cannot supply or replace authentication/network fields. */
export function applyAppearance(config: ConnectionConfig, input: unknown): ConnectionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['color', 'group'].includes(key)) || !Object.keys(input).length) throw new Error('INVALID_CONNECTION: 连接外观参数无效')
  const patch = input as ConnectionAppearancePatch
  const next = { ...config }
  if (Object.hasOwn(patch, 'color')) next.color = normalizeColor(patch.color)
  if (Object.hasOwn(patch, 'group')) next.group = normalizeGroup(patch.group)
  return next
}
export function colorStyle(color?: string): Record<string, string> {
  // Never interpolate imported or unvalidated arbitrary CSS.
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { '--connection-color': color.toLowerCase() } : {}
}
