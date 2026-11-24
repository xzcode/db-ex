import { en } from './catalog-en'

export type Locale = 'zh-CN' | 'en'
export type LanguagePreference = 'system' | Locale
export const isLanguagePreference = (value: unknown): value is LanguagePreference => value === 'system' || value === 'zh-CN' || value === 'en'
export function resolveLocale(preference: LanguagePreference, systemLanguage: string): Locale {
  return preference === 'system' ? (/^zh(?:[-_]|$)/i.test(systemLanguage) ? 'zh-CN' : 'en') : preference
}
const catalogs: Record<Locale, Readonly<Record<string, string>>> = { 'zh-CN': {}, en }
export function translate(locale: Locale, key: string, values: readonly unknown[] = []): string {
  const catalog = catalogs[locale]
  const pattern = Object.hasOwn(catalog, key) ? catalog[key]! : key
  return pattern.replace(/\{(\d+)\}/g, (all, index) => Number(index) < values.length ? String(values[Number(index)]) : all)
}
const escaped = (text: string): string => text.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')
const dynamic = Object.keys(en).filter(key => /\{\d+\}/.test(key)).map(key => {
  const indexes: number[] = []
  const regex = key.split(/(\{\d+\})/).map(part => {
    if (!/^\{\d+\}$/.test(part)) return escaped(part)
    indexes.push(Number(part.slice(1, -1)))
    return '([\\s\\S]*?)'
  }).join('')
  return { key, indexes, regex: new RegExp('^' + regex + '$') }
}).sort((a, b) => b.key.length - a.key.length)
const cjk = /[\u3400-\u9fff]/
const txSuffix = '（事务尚未提交）'
const historySuffix = ' · 查询已执行，但历史记录保存失败'
/** Translate application-generated messages only. Never apply to result rows, SQL, names or input fields. */
export function localizeMessage(locale: Locale, input: string): string {
  if (locale === 'zh-CN' || !input || !cjk.test(input)) return input
  // Electron adds an IPC wrapper. Keep stable error codes and localized details.
  const text = input.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '')
  if (Object.hasOwn(en, text)) return translate(locale, text)
  for (const suffix of [historySuffix, txSuffix]) if (text.endsWith(suffix)) return localizeMessage(locale, text.slice(0, -suffix.length)) + translate(locale, suffix)
  for (const { key, indexes, regex } of dynamic) {
    const match = regex.exec(text)
    if (!match) continue
    const args: string[] = []
    indexes.forEach((index, position) => {
      const captured = match[position + 1] || ''
      // Only validation field labels are application messages; preserve
      // arbitrary user-controlled database names and other interpolated data.
      args[index] = index === 0 && /^(?:INVALID_CONNECTION|INVALID_INPUT|INVALID_EJSON):/.test(key) ? translate(locale, captured) : captured
    })
    return translate(locale, key, args)
  }
  // Preserve details from drivers or an as-yet untranslated message rather
  // than silently replacing diagnostic information with a generic error.
  return text
}
