import type { DatabaseKind } from './types'

export type RelationalDialect='mysql'|'mariadb'|'sqlite'
export interface RelationalObjectCapabilities {
  insert:boolean
  update:boolean
  delete:boolean
  import:boolean
  transactional:boolean
}
export function isMysqlFamily(kind:unknown):kind is 'mysql'|'mariadb'{return kind==='mysql'||kind==='mariadb'}
/** Conservative, server-metadata-derived support. System-versioned tables and
 * sequence objects are browse-only through the row editor in the first MariaDB release. */
export function mysqlObjectCapabilities(tableType:string,engine:string,hasPrimaryKey:boolean):RelationalObjectCapabilities{
  const table=tableType.toUpperCase()==='BASE TABLE'
  const transactional=table&&engine.toUpperCase()==='INNODB'
  return {insert:table,update:table&&hasPrimaryKey,delete:table&&hasPrimaryKey,import:transactional,transactional}
}
export function relationalDialect(kind:DatabaseKind):RelationalDialect|undefined{
  return isMysqlFamily(kind)?kind:kind==='sqlite'?'sqlite':undefined
}
