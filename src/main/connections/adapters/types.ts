import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { ConnectionConfig, DatabaseKind, DatabaseOperation, ExplorerNode, OperationResult } from '../../../shared/types'
import type { MongoCategory } from '../../../shared/mongo-catalog'
import type { OperationContext } from '../../operations/common'
import type { SqliteProcessFactory } from '../../operations/sqlite-client'
import type { ConnectionTransport } from '../transport'

export type OperationAction = DatabaseOperation['action']
export interface AdapterContext {
  config: ConnectionConfig
  transport: ConnectionTransport
  tls: TlsConnectionOptions
  sqliteProcessFactory?: SqliteProcessFactory
  sqliteModulePath?: string
}
export interface AdapterSession {
  serverVersion?:string
  execute(input:DatabaseOperation,context:OperationContext):Promise<OperationResult>
  roots(context:OperationContext):Promise<ExplorerNode[]>
  children(database:string,category:MongoCategory|undefined,context:OperationContext,withStatistics?:boolean):Promise<ExplorerNode[]>
  close():Promise<void>
  transactionActive?:()=>boolean
  disconnected?:()=>boolean
  beginReadBudget?:()=>{release:()=>void;exceeded:()=>boolean}
  backupTo?: (path:string)=>Promise<unknown>
}
export interface DatabaseAdapter {
  readonly kind:DatabaseKind
  readonly actions:readonly OperationAction[]
  readonly rollback?:DatabaseOperation
  writes(input:DatabaseOperation,writable:boolean):boolean
  connect(context:AdapterContext):Promise<AdapterSession>
  preview?(database:string,entity:string,offset:number):DatabaseOperation
  connectionError?(error:unknown):string|undefined
}
