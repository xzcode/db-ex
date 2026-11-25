import type { DatabaseKind,DatabaseOperation } from '../../../shared/types'
import { mariadbAdapter } from './mariadb'
import { mysqlAdapter } from './mysql'
import { mongoAdapter } from './mongodb'
import { redisAdapter } from './redis'
import { sqliteAdapter } from './sqlite'
import type { DatabaseAdapter,OperationAction } from './types'

const registry={mysql:mysqlAdapter,mariadb:mariadbAdapter,mongodb:mongoAdapter,redis:redisAdapter,sqlite:sqliteAdapter} satisfies Record<DatabaseKind,DatabaseAdapter>
const knownActions=new Set<string>(Object.values(registry).flatMap(adapter=>adapter.actions))
export function databaseAdapter(kind:DatabaseKind):DatabaseAdapter{
  const adapter=Object.hasOwn(registry,kind)?registry[kind]:undefined
  if(!adapter)throw new Error('INVALID_OPERATION: 不支持的操作')
  return adapter
}
export function isKnownDatabaseAction(action:unknown):action is OperationAction{return typeof action==='string'&&knownActions.has(action)}
export function adapterAllowsAction(kind:DatabaseKind,action:unknown):boolean{return isKnownDatabaseAction(action)&&databaseAdapter(kind).actions.includes(action)}

/** Classify native confirmation with the actual connection adapter; no cross-engine fallback. */
export function adapterOperationWrites(kind:DatabaseKind,input:DatabaseOperation,writable:boolean):boolean{
  if(!input||typeof input!=='object'||!adapterAllowsAction(kind,input.action))throw new Error('INVALID_OPERATION: 操作与连接类型不匹配')
  return databaseAdapter(kind).writes(input,writable)
}
