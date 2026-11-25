import { ref } from 'vue'
import { newDatabasePalette, normalizeDatabasePalette, type DatabasePalette } from '../shared/database-palette'
type Kind = 'mysql' | 'redis' | 'sqlite' | 'mariadb' | 'clickhouse'
function load(kind: Kind): DatabasePalette {
  try { return normalizeDatabasePalette(kind, JSON.parse(localStorage.getItem('dbex.' + kind + '-palette.v1') || 'null')) } catch { return newDatabasePalette() }
}
export const databasePalettes = ref({ mysql: load('mysql'), mariadb:load('mariadb'), redis: load('redis'), sqlite:load('sqlite'),clickhouse:load('clickhouse') })
export function saveDatabasePalette(kind: Kind, value: DatabasePalette): void {
  databasePalettes.value[kind] = normalizeDatabasePalette(kind, value)
  try { localStorage.setItem('dbex.' + kind + '-palette.v1', JSON.stringify(databasePalettes.value[kind])) } catch { /* Optional preference. */ }
}
