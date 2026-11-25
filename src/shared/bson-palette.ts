import { bsonTypes, isBsonType, type BsonType } from './bson-types'
export interface BsonPalette {
  enabled: boolean
  showLabels: boolean
  overrides: Partial<Record<BsonType, string | null>>
}
export const defaultBsonColors: Readonly<Record<BsonType, string | null>> = {
  ObjectId: '#e69a38', String: '#4b88d9', Int32: '#4da96b', Int64: '#956ad9',
  Double: '#32a8aa', Decimal128: '#d16b9e', Boolean: '#d3b12c', Date: '#21858d',
  Timestamp: '#21858d', Array: '#cc7424', Document: '#687589', Binary: '#ae477e',
  Regex: '#7447bb', Null: null, Undefined: '#c5cbd4', JavaScript: '#bc3543',
  JavaScriptWithScope: '#8e2635', Symbol: '#a87b53', DBRef: '#7b9c46',
  MinKey: '#454d5a', MaxKey: '#c49d55', Number: '#8ab6ff', Missing: null, Unknown: null,
}
export function newBsonPalette(): BsonPalette { return { enabled: true, showLabels: false, overrides: {} } }
export function normalizeBsonPalette(value: unknown): BsonPalette {
  const result = newBsonPalette()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const input = value as Partial<BsonPalette>
  if (typeof input.enabled === 'boolean') result.enabled = input.enabled
  if (typeof input.showLabels === 'boolean') result.showLabels = input.showLabels
  if (input.overrides && typeof input.overrides === 'object' && !Array.isArray(input.overrides)) {
    for (const type of bsonTypes) {
      if (!Object.hasOwn(input.overrides, type)) continue
      const color = input.overrides[type]
      if (color === null) result.overrides[type] = null
      else if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) result.overrides[type] = color.toLowerCase()
    }
  }
  return result
}
export function typeColor(palette: BsonPalette, type: BsonType): string | undefined {
  if (!isBsonType(type)) return undefined
  const selected = Object.hasOwn(palette.overrides, type) ? palette.overrides[type] : undefined
  return selected === null ? undefined : selected || defaultBsonColors[type] || undefined
}
export function activeTypeColor(palette: BsonPalette, type: BsonType): string | undefined {
  return palette.enabled ? typeColor(palette, type) : undefined
}
