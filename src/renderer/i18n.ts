import { computed, ref, watch } from 'vue'
import { directionFor, isLanguagePreference, languages, resolveLocale, translate, localizeMessage, type LanguagePreference } from '../shared/i18n'
export { languages }
const STORAGE_KEY = 'dbex.language'
function initialPreference(): LanguagePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLanguagePreference(saved)) return saved
  } catch { /* Storage is optional. */ }
  return 'system'
}
export const languagePreference = ref<LanguagePreference>(initialPreference())
const systemLanguage = ref(navigator.language)
export const locale = computed(() => resolveLocale(languagePreference.value, systemLanguage.value))
async function refreshSystemLanguage(): Promise<void> {
  systemLanguage.value = navigator.language
  try {
    const preferred = await window.dbex?.getSystemLanguage?.()
    if (typeof preferred === 'string' && preferred) systemLanguage.value = preferred
  } catch { /* Browser preview or unavailable native preference. */ }
}
window.addEventListener('languagechange', () => { void refreshSystemLanguage() })
void refreshSystemLanguage()
watch(locale, value => {
  document.documentElement.lang = value
  document.documentElement.dir = directionFor(value)
  void window.dbex?.setLocale?.(value).catch(() => { /* Bridge may not be ready in preview. */ })
}, { immediate: true })
export function setLanguage(value: unknown): void {
  if (!isLanguagePreference(value)) return
  languagePreference.value = value
  if (value === 'system') void refreshSystemLanguage()
  try { localStorage.setItem(STORAGE_KEY, value) } catch { /* Keep in-memory preference. */ }
}
export function t(key: string, values: readonly unknown[] = []): string {
  return translate(locale.value, key, values)
}
export function localize(value: string): string { return localizeMessage(locale.value, value) }
