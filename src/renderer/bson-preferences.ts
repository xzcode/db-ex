import { ref } from 'vue'
import { newBsonPalette, normalizeBsonPalette, type BsonPalette } from '../shared/bson-palette'
const KEY = 'dbex.bson-palette.v1'
function load(): BsonPalette {
  try { return normalizeBsonPalette(JSON.parse(localStorage.getItem(KEY) || 'null')) }
  catch { return newBsonPalette() }
}
export const bsonPalette = ref(load())
export function saveBsonPalette(value: BsonPalette): void {
  bsonPalette.value = normalizeBsonPalette(value)
  try { localStorage.setItem(KEY, JSON.stringify(bsonPalette.value)) } catch { /* Keep in-memory settings. */ }
}
