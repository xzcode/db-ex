import { isMysqlFamily } from './relational-capabilities'
import type { DatabaseKind } from './types'
const mysqlSystem = new Set(['information_schema','performance_schema','mysql','sys'])
const mongoSystem = new Set(['admin','config','local'])
export function protectedDatabase(kind:DatabaseKind,name:string):boolean {
  return (kind==='mongodb'?mongoSystem:isMysqlFamily(kind)?mysqlSystem:new Set<string>()).has(name.toLowerCase())
}
/** A conservative, portable naming subset for creating user databases.
 * Existing object names are quoted separately by the engine's driver. */
export function validateDatabaseName(kind:'mysql'|'mariadb'|'mongodb',value:unknown):string {
  if(typeof value!=='string'||!value||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw new Error('INVALID_DATABASE: 数据库名称无效')
  const bytes=new TextEncoder().encode(value).length
  if(kind==='mongodb' ? bytes>63||/[\s./\\ "$*<>:|?]/.test(value) : [...value].length>64||/[./\\\x60]/.test(value)||value.endsWith(' '))throw new Error('INVALID_DATABASE: 数据库名称无效')
  if(protectedDatabase(kind,value))throw new Error('PROTECTED_DATABASE: 不允许新建或删除系统数据库')
  return value
}
export function validateInitialCollection(value:unknown):string{
  if(typeof value!=='string'||!value||value!==value.trim()||new TextEncoder().encode(value).length>200||value.startsWith('system.')||value.includes('$')||/[\u0000-\u001f\u007f]/.test(value))throw new Error('INVALID_DATABASE: 初始集合名称无效')
  return value
}
