import type { DatabaseKind } from '../../../shared/types'
import { mysqlAdapter } from './mysql'
import { mongoAdapter } from './mongodb'
import { redisAdapter } from './redis'
import { sqliteAdapter } from './sqlite'
import type { DatabaseAdapter,OperationAction } from './types'

const registry={mysql:mysqlAdapter,mongodb:mongoAdapter,redis:redisAdapter,sqlite:sqliteAdapter} satisfies Record<DatabaseKind,DatabaseAdapter>
const knownActions=new Set<string>(Object.values(registry).flatMap(adapter=>adapter.actions))
export function databaseAdapter(kind:DatabaseKind):DatabaseAdapter{
  const adapter=Object.hasOwn(registry,kind)?registry[kind]:undefined
  if(!adapter)throw new Error('INVALID_OPERATION: 不支持的操作')
  return adapter
}
export function isKnownDatabaseAction(action:unknown):action is OperationAction{return typeof action==='string'&&knownActions.has(action)}
export function adapterAllowsAction(kind:DatabaseKind,action:unknown):boolean{return isKnownDatabaseAction(action)&&databaseAdapter(kind).actions.includes(action)}
