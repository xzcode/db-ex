import type { DatabaseKind } from './types'

/** Baseline implemented capabilities, not a promise of a server's privileges
 * or of support on every object/storage engine. Main-process adapters still
 * enforce the actual operation allowlist and write/transaction policy. */
export interface DatabaseCapabilities {
  connection: 'network' | 'file'
  browser: 'relational' | 'document' | 'keyspace'
  editor: 'query' | 'aggregation' | 'console'
  transactions: boolean
  databaseAdministration: boolean
  graphicalIndexes: boolean
  backup: 'native-tools' | 'file' | 'none'
  rowEditing: 'primary-key' | 'original-document' | 'key-specific'
}
const capabilities = {
  mysql: {connection:'network',browser:'relational',editor:'query',transactions:true,databaseAdministration:true,graphicalIndexes:false,backup:'native-tools',rowEditing:'primary-key'},
  sqlite: {connection:'file',browser:'relational',editor:'query',transactions:true,databaseAdministration:false,graphicalIndexes:false,backup:'file',rowEditing:'primary-key'},
  mongodb: {connection:'network',browser:'document',editor:'aggregation',transactions:false,databaseAdministration:true,graphicalIndexes:true,backup:'native-tools',rowEditing:'original-document'},
  redis: {connection:'network',browser:'keyspace',editor:'console',transactions:false,databaseAdministration:false,graphicalIndexes:false,backup:'none',rowEditing:'key-specific'}
} as const satisfies Record<DatabaseKind,DatabaseCapabilities>
export function databaseCapabilities(kind:DatabaseKind):Readonly<DatabaseCapabilities>{return capabilities[kind]}
