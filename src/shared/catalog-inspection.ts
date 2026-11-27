import type {DatabaseKind,DatabaseOperation,ExplorerNode} from './types'
/** Only real objects with a supported read-only inspector may be inspected. */
export function catalogInspection(kind:DatabaseKind,node?:ExplorerNode):DatabaseOperation|undefined{
 if(!node?.database||!node.entity)return
 const target={database:node.database,entity:node.entity}
 if(kind==='mongodb'&&['collection','view','mongo-indexes'].includes(node.kind))return {action:'mongo.inspect',...target}
 if(kind==='clickhouse'&&['table','view','clickhouse-dictionary'].includes(node.kind))return {action:'clickhouse.inspect',...target}
 if(['mysql','mariadb','sqlite'].includes(kind)&&['table','view'].includes(node.kind))return {action:'mysql.inspect',...target}
}
