import { ref, watch } from 'vue'
import { defaultPreferences,normalizePreferences,type AppPreferences } from '../shared/preferences'
import { languagePreference,setLanguage } from './i18n'
const KEY='dbex.preferences.v1'
function load(){
 try{
  const raw=localStorage.getItem(KEY)
  if(raw)return normalizePreferences(JSON.parse(raw))
  const old=JSON.parse(localStorage.getItem('dbex.view')||'{}')
  return normalizePreferences({...defaultPreferences(),theme:old.theme,language:languagePreference.value})
 }catch{return normalizePreferences({language:languagePreference.value})}
}
export const preferences=ref(load())
const media=window.matchMedia('(prefers-color-scheme: dark)')
const systemDark=ref(media.matches)
function persist(){try{localStorage.setItem(KEY,JSON.stringify(preferences.value))}catch{}}
export function resolvedTheme(theme=preferences.value.theme):'dark'|'light'{return theme==='system'?(systemDark.value?'dark':'light'):theme}
function applyTheme(){document.documentElement.dataset.theme=resolvedTheme()}
media.addEventListener('change',event=>{systemDark.value=event.matches;applyTheme()})
export function savePreferences(value:AppPreferences){preferences.value=normalizePreferences(value);setLanguage(preferences.value.language);persist();applyTheme()}
export function setTheme(value:AppPreferences['theme']){savePreferences({...preferences.value,theme:value})}
watch(languagePreference,language=>{if(preferences.value.language!==language){preferences.value.language=language;persist()}})
watch(()=>preferences.value.theme,applyTheme,{immediate:true})
// Existing language selector remains the authoritative compatibility value
// until preferences are explicitly saved, including upgrades.
preferences.value.language=languagePreference.value
