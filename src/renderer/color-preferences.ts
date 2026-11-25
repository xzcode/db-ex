import { ref, watch } from 'vue'
import { connectionColors } from '../shared/connection-appearance'
export function parseHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const candidate = trimmed.startsWith('#') ? trimmed : '#' + trimmed
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : undefined
}
const KEY = 'dbex.recent-colors'
function read(): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(values)) return []
    return [...new Set(values.map(parseHexColor).filter((v): v is string => Boolean(v)))].slice(0, 12)
  } catch { return [] }
}
export const recentColors = ref(read())
export function rememberColor(color: string): void {
  if (connectionColors.some(item => item.color === color)) return
  recentColors.value = [color, ...recentColors.value.filter(item => item !== color)].slice(0, 12)
}
export function removeRecentColor(color: string): void { recentColors.value = recentColors.value.filter(item => item !== color) }
watch(recentColors, value => { try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Optional preference. */ } })
