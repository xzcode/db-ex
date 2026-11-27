import {qRefinementTraditional,qFollowupTraditional} from './catalog-q-refinement'
import {queryRefinementCatalogs} from './catalog-query-refinement'
import { migrationCatalogs } from './catalog-migration'
import {uiRefinementCatalogs} from './catalog-ui-refinement'
import { clickHouseManagementCatalogs } from './catalog-clickhouse-management'
import { gridEditCatalogs } from './catalog-grid-edit'
import { queryEditorCatalogs } from './catalog-query-editor'
import { navigationCatalogs } from './catalog-navigation'
import { indexHelpCatalogs } from './catalog-index-help'
import { en } from './catalog-en'
import { connectionCatalogs } from './catalog-connection'
import zh_TW from './catalog-zh-TW.json'
import ja from './catalog-ja.json'
import ko from './catalog-ko.json'
import de from './catalog-de.json'
import fr from './catalog-fr.json'
import es from './catalog-es.json'
import pt_BR from './catalog-pt-BR.json'
import ru from './catalog-ru.json'
import it from './catalog-it.json'
import ar from './catalog-ar.json'
import hi from './catalog-hi.json'
import id from './catalog-id.json'

/** Single source of truth for locale options, validation and text direction. */
export const languages = [
  {
    "locale": "zh-CN",
    "label": "简体中文",
    "direction": "ltr"
  },
  {
    "locale": "zh-TW",
    "label": "繁體中文",
    "direction": "ltr"
  },
  {
    "locale": "en",
    "label": "English",
    "direction": "ltr"
  },
  {
    "locale": "ja",
    "label": "日本語",
    "direction": "ltr"
  },
  {
    "locale": "ko",
    "label": "한국어",
    "direction": "ltr"
  },
  {
    "locale": "de",
    "label": "Deutsch",
    "direction": "ltr"
  },
  {
    "locale": "fr",
    "label": "Français",
    "direction": "ltr"
  },
  {
    "locale": "es",
    "label": "Español",
    "direction": "ltr"
  },
  {
    "locale": "pt-BR",
    "label": "Português",
    "direction": "ltr"
  },
  {
    "locale": "ru",
    "label": "Русский",
    "direction": "ltr"
  },
  {
    "locale": "it",
    "label": "Italiano",
    "direction": "ltr"
  },
  {
    "locale": "ar",
    "label": "العربية",
    "direction": "rtl"
  },
  {
    "locale": "hi",
    "label": "हिन्दी",
    "direction": "ltr"
  },
  {
    "locale": "id",
    "label": "Bahasa Indonesia",
    "direction": "ltr"
  }
] as const
export type Locale = typeof languages[number]['locale']
export type LanguagePreference = 'system' | Locale
export const isLocale = (value: unknown): value is Locale => languages.some(language => language.locale === value)
export const isLanguagePreference = (value: unknown): value is LanguagePreference => value === 'system' || isLocale(value)
export function directionFor(locale: Locale): 'ltr' | 'rtl' {
  return languages.find(language => language.locale === locale)?.direction ?? 'ltr'
}
export function resolveLocale(preference: LanguagePreference, systemLanguage: string): Locale {
  if (preference !== 'system') return preference
  const tag = systemLanguage.trim().replace(/_/g, '-').toLowerCase()
  if (tag === 'zh' || tag.startsWith('zh-')) {
    const subtags = tag.split('-').slice(1)
    if (subtags.includes('hant')) return 'zh-TW'
    if (subtags.includes('hans')) return 'zh-CN'
    return subtags.some(x => ['tw', 'hk', 'mo'].includes(x)) ? 'zh-TW' : 'zh-CN'
  }
  const base = tag.split('-')[0]
  if (base === 'pt') return 'pt-BR'
  if (base === 'in') return 'id'
  return isLocale(base) ? base : 'en'
}
export const catalogs: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  'zh-CN': {}, en,
  'zh-TW': { ...zh_TW, ...connectionCatalogs['zh-TW'], ...indexHelpCatalogs['zh-TW'], ...navigationCatalogs['zh-TW'], ...queryEditorCatalogs['zh-TW'], ...gridEditCatalogs['zh-TW'], ...clickHouseManagementCatalogs['zh-TW'], ...migrationCatalogs['zh-TW'], ...uiRefinementCatalogs['zh-TW'], ...queryRefinementCatalogs['zh-TW'], ...qRefinementTraditional, ...qFollowupTraditional },
  'ja': { ...ja, ...connectionCatalogs['ja'], ...indexHelpCatalogs['ja'], ...navigationCatalogs['ja'], ...queryEditorCatalogs['ja'], ...gridEditCatalogs['ja'], ...clickHouseManagementCatalogs['ja'], ...migrationCatalogs['ja'], ...uiRefinementCatalogs['ja'] },
  'ko': { ...ko, ...connectionCatalogs['ko'], ...indexHelpCatalogs['ko'], ...navigationCatalogs['ko'], ...queryEditorCatalogs['ko'], ...gridEditCatalogs['ko'], ...clickHouseManagementCatalogs['ko'], ...migrationCatalogs['ko'], ...uiRefinementCatalogs['ko'] },
  'de': { ...de, ...connectionCatalogs['de'], ...indexHelpCatalogs['de'], ...navigationCatalogs['de'], ...queryEditorCatalogs['de'], ...gridEditCatalogs['de'], ...clickHouseManagementCatalogs['de'], ...migrationCatalogs['de'], ...uiRefinementCatalogs['de'] },
  'fr': { ...fr, ...connectionCatalogs['fr'], ...indexHelpCatalogs['fr'], ...navigationCatalogs['fr'], ...queryEditorCatalogs['fr'], ...gridEditCatalogs['fr'], ...clickHouseManagementCatalogs['fr'], ...migrationCatalogs['fr'], ...uiRefinementCatalogs['fr'] },
  'es': { ...es, ...connectionCatalogs['es'], ...indexHelpCatalogs['es'], ...navigationCatalogs['es'], ...queryEditorCatalogs['es'], ...gridEditCatalogs['es'], ...clickHouseManagementCatalogs['es'], ...migrationCatalogs['es'], ...uiRefinementCatalogs['es'] },
  'pt-BR': { ...pt_BR, ...connectionCatalogs['pt-BR'], ...indexHelpCatalogs['pt-BR'], ...navigationCatalogs['pt-BR'], ...queryEditorCatalogs['pt-BR'], ...gridEditCatalogs['pt-BR'], ...clickHouseManagementCatalogs['pt-BR'], ...migrationCatalogs['pt-BR'], ...uiRefinementCatalogs['pt-BR'] },
  'ru': { ...ru, ...connectionCatalogs['ru'], ...indexHelpCatalogs['ru'], ...navigationCatalogs['ru'], ...queryEditorCatalogs['ru'], ...gridEditCatalogs['ru'], ...clickHouseManagementCatalogs['ru'], ...migrationCatalogs['ru'], ...uiRefinementCatalogs['ru'] },
  'it': { ...it, ...connectionCatalogs['it'], ...indexHelpCatalogs['it'], ...navigationCatalogs['it'], ...queryEditorCatalogs['it'], ...gridEditCatalogs['it'], ...clickHouseManagementCatalogs['it'], ...migrationCatalogs['it'], ...uiRefinementCatalogs['it'] },
  'ar': { ...ar, ...connectionCatalogs['ar'], ...indexHelpCatalogs['ar'], ...navigationCatalogs['ar'], ...queryEditorCatalogs['ar'], ...gridEditCatalogs['ar'], ...clickHouseManagementCatalogs['ar'], ...migrationCatalogs['ar'], ...uiRefinementCatalogs['ar'] },
  'hi': { ...hi, ...connectionCatalogs['hi'], ...indexHelpCatalogs['hi'], ...navigationCatalogs['hi'], ...queryEditorCatalogs['hi'], ...gridEditCatalogs['hi'], ...clickHouseManagementCatalogs['hi'], ...migrationCatalogs['hi'], ...uiRefinementCatalogs['hi'] },
  'id': { ...id, ...connectionCatalogs['id'], ...indexHelpCatalogs['id'], ...navigationCatalogs['id'], ...queryEditorCatalogs['id'], ...gridEditCatalogs['id'], ...clickHouseManagementCatalogs['id'], ...migrationCatalogs['id'], ...uiRefinementCatalogs['id'] }
}
export function translate(locale: Locale, key: string, values: readonly unknown[] = []): string {
  const catalog = catalogs[locale]
  // English is the international fallback for uncommon, not-yet-localized
  // diagnostics. Simplified Chinese uses the original source message.
  const pattern = locale === 'zh-CN' ? key : Object.hasOwn(catalog, key) ? catalog[key]! : Object.hasOwn(en, key) ? en[key]! : key
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
