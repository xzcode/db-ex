import type {Connection,RowDataPacket,ResultSetHeader} from 'mysql2/promise'
import type {QueryOptions} from 'mysql2'
import {createHash} from 'node:crypto'
import {addAbortSignal} from 'node:stream'
import type {ConnectionConfig,DatabaseKind} from '../../shared/types'
import type {MigrationEndpoint} from './endpoint'
import type {MigrationCatalog,MigrationObject,MigrationStep,MigrationCopyOptions} from '../../shared/migration'
import {migrationName,migrationSupported} from '../../shared/migration'
import {protectedDatabase} from '../../shared/database-admin'
import {validateConnection} from '../connections/validation'
import {createTransport,type ConnectionTransport} from '../connections/transport'
import {loadConnectionTls} from '../connections/tls-material'
import {openMysqlClient} from '../connections/mysql-client'
import {sqlMigrationCondition} from './condition'
import {compileMysqlFilter,newBrowseFilter,type BrowseFilter} from '../../shared/browse-filter'
import type {DataFilePolicy} from '../../shared/file-transfer'
import {sqlFileRow,sqlFileValue} from '../file-transfer/records'
import {quoteIdentifier as q} from '../operations/sql-policy'
import {makeSchemaObject,tableTarget,dataShape,mysqlUpsertKeys,type SchemaObject,type SchemaSnapshot} from './mysql-schema'

const MAX_OBJECTS=500,MAX_DEFINITION=128*1024,MAX_SNAPSHOT=4*1024*1024
const BATCH_BYTES=4*1024*1024,BATCH_ROWS=500
type Cell=null|string|number|Buffer
function abort(signal:AbortSignal){if(signal.aborted)throw new Error('CANCELLED: 已取消操作')}
/** mysql2 destroy() can leave the pending Promise unresolved. Race with the
 * job signal and a local deadline, and destroy the actual socket on either. */
function bounded<T>(signal:AbortSignal,stop:()=>void,work:()=>Promise<T>,ms=30000):Promise<T>{
 abort(signal)
 return new Promise<T>((resolve,reject)=>{
  let settled=false
  const finish=(error:unknown,value?:T)=>{
   if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel)
   if(error)reject(error);else resolve(value as T)
  }
  const cancel=()=>{stop();finish(new Error('CANCELLED: 已取消操作'))}
  const timer=setTimeout(()=>{stop();finish(new Error('MIGRATION_TIMEOUT: 迁移操作超时，连接已断开'))},ms)
  signal.addEventListener('abort',cancel,{once:true})
  Promise.resolve().then(()=>{abort(signal);return work()}).then(value=>finish(null,value),error=>finish(error))
 })
}
export function migrationError(error:unknown){
 const msg=error instanceof Error?error.message:''
 // Only this module's fixed categories; do not relay driver SQL, rows, URI or credentials.
 if(/^(?:MIGRATION_[A-Z_]+|CANCELLED|FILE_TRANSFER):/.test(msg))return msg
 const code=String((error as {code?:unknown})?.code||'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64)
 return 'MIGRATION_DATABASE_ERROR: '+code
}
function cellBytes(value:unknown){
 if(value===null)return 8
 if(Buffer.isBuffer(value))return value.length+16
 if(typeof value==='string')return Buffer.byteLength(value,'utf8')+16
 if(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return 16
 throw new Error('MIGRATION_TYPE: 无法无损传输该字段值')
}
export class MysqlMigrationEndpoint implements MigrationEndpoint{
 private closed=false
 readonly kind:DatabaseKind
 readonly identity:string
 private constructor(private readonly client:Connection,private readonly transport:ConnectionTransport,private readonly signal:AbortSignal,kind:DatabaseKind,identity:string,private readonly version:string){
  this.kind=kind;this.identity=identity
  signal.addEventListener('abort',this.stop,{once:true})
 }
 private stop=()=>{this.client.destroy();void this.transport.close().catch(()=>{})}
 static async open(value:ConnectionConfig,signal:AbortSignal){
  const config=validateConnection(value)
  if(config.kind!=='mysql'&&config.kind!=='mariadb')throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  abort(signal)
  const transport=await createTransport({ssh:config.ssh,proxy:config.proxy,timeoutMs:config.connectTimeoutMs})
  let client:Connection|undefined
  const stop=()=>{client?.destroy();void transport.close().catch(()=>{})}
  signal.addEventListener('abort',stop,{once:true})
  try{
   abort(signal)
   // Deliberately do not select a saved default database or inherit its state.
   client=await openMysqlClient({...config,database:undefined},transport,await loadConnectionTls(config))
   abort(signal)
   const [rows]=await bounded(signal,stop,()=>client!.query<RowDataPacket[]>({sql:'SELECT @@hostname AS host,@@port AS port,@@server_id AS server_id,VERSION() AS version',timeout:15000}),15000)
   const row=rows[0]
   if(!row||typeof row.version!=='string')throw new Error('MIGRATION_DATABASE_ERROR: SERVER_IDENTITY')
   if((config.kind==='mariadb')!==row.version.toLowerCase().includes('mariadb'))throw new Error('MIGRATION_UNSUPPORTED: 连接类型与实际服务器不一致')
   const [vars]=await bounded(signal,stop,()=>client!.query<RowDataPacket[]>({sql:"SHOW VARIABLES LIKE 'server_uuid'",timeout:15000}),15000)
   const identity=createHash('sha256').update(vars[0]?.Value?String(vars[0].Value):JSON.stringify(row)).digest('hex')
   const endpoint=new MysqlMigrationEndpoint(client,transport,signal,config.kind,identity,String(row.version))
   abort(signal)
   return endpoint
  }catch(error){client?.destroy();await transport.close().catch(()=>{});throw error}
  finally{signal.removeEventListener('abort',stop)}
 }
 async close(){if(this.closed)return;this.closed=true;this.signal.removeEventListener('abort',this.stop);this.client.destroy();await this.transport.close().catch(()=>{})}
 private async query(sql:string,params:unknown[]=[]){
  abort(this.signal)
  const [rows]=await bounded(this.signal,this.stop,()=>this.client.query<RowDataPacket[]>({sql,timeout:30000},params))
  abort(this.signal);return rows
 }
 private async statement(sql:string){
  abort(this.signal);await bounded(this.signal,this.stop,()=>this.client.query({sql,timeout:30000}));abort(this.signal)
 }
 async databases(){
  const rows=await this.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 501')
  if(rows.length>MAX_OBJECTS)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
  return rows.map(row=>String(row.name)).filter(name=>!protectedDatabase(this.kind,name))
 }
 async catalog(database?:string):Promise<MigrationCatalog>{
  const databases=await this.databases()
  if(database===undefined)return {kind:this.kind,databases}
  if(!databases.includes(database))throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  return {kind:this.kind,databases,objects:await this.objects(database)}
 }
 async objects(database:string):Promise<MigrationObject[]>{
  migrationName(database)
  if(protectedDatabase(this.kind,database))throw new Error('MIGRATION_DATABASE: 不允许操作系统数据库')
  const rows=await this.query('SELECT TABLE_NAME AS name,TABLE_TYPE AS type,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME LIMIT 501',[database])
  if(rows.length>MAX_OBJECTS)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
  return rows.map(r=>({name:migrationName(r.name),type:String(r.type),engine:r.engine==null?undefined:String(r.engine)}))
 }
 async schema(database:string,names?:string[]):Promise<SchemaSnapshot>{
  if(!(await this.databases()).includes(database))throw new Error('MIGRATION_DATABASE: 数据库不存在或不可访问')
  const objects=(await this.objects(database)).filter(o=>!names||names.includes(o.name))
  if(objects.length>100)throw new Error('MIGRATION_LIMIT: 请选择不超过100个对象')
  const result:SchemaObject[]=[];let size=0
  for(const o of objects){
   abort(this.signal)
   // SHOW CREATE is metadata, not a row scan. Request array rows to avoid
   // duplicate column aliases or engine-specific CREATE result headings.
   const [rows]=await bounded(this.signal,this.stop,()=>this.client.query<RowDataPacket[][]>({sql:'SHOW CREATE TABLE '+tableTarget(database,o.name),rowsAsArray:true,timeout:30000}))
   const ddl=String(rows[0]?.[1]||'')
   if(!ddl||Buffer.byteLength(ddl)>MAX_DEFINITION)throw new Error('MIGRATION_LIMIT: 数据库对象定义超出本阶段上限')
   const triggers=await this.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_NAME LIMIT 501',[database,o.name])
   if(triggers.length>MAX_OBJECTS)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
   const item=makeSchemaObject(o.name,o.type,o.engine,ddl,triggers.map(r=>String(r.name)))
   // SHOW CREATE may spell inherited character set/collation or defaults
   // differently after ALTER. Compare actual column metadata, not that spelling.
   if(item.shape?.safe){
    const columns=await this.query('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,COLUMN_COMMENT,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 501',[database,o.name])
    if(columns.length!==item.shape.columns.length||columns.some((c,i)=>String(c.COLUMN_NAME)!==item.shape!.columns[i]?.name))throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
    for(const [i,column] of columns.entries())item.shape.columns[i]!.semantic=JSON.stringify([column.COLUMN_TYPE,column.IS_NULLABLE,column.COLUMN_DEFAULT,column.EXTRA,column.CHARACTER_SET_NAME,column.COLLATION_NAME,column.COLUMN_COMMENT,column.GENERATION_EXPRESSION])
   }

   size+=Buffer.byteLength(JSON.stringify(item))
   if(size>MAX_SNAPSHOT)throw new Error('MIGRATION_LIMIT: 数据库对象定义超出本阶段上限')
   result.push(item)
  }
  return {objects:result.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}
 }
 async startSourceSnapshot(){
  await this.statement("SET SESSION time_zone = '+00:00'")
  await this.statement('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await this.statement('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
 }
 async prepareTarget(){
  await this.statement("SET SESSION time_zone = '+00:00'")
  await this.statement('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await this.statement('SET SESSION FOREIGN_KEY_CHECKS = 1')
  const mode=(await this.query('SELECT @@SESSION.sql_mode AS mode'))[0]?.mode
  const values=String(mode||'').split(',').filter(Boolean)
  if(values.some(x=>!/^[A-Z0-9_]+$/.test(x)))throw new Error('MIGRATION_TYPE: 不支持当前 SQL 模式')
  // Strict writes and explicit zero auto-increment values; never disable FK checks.
  const next=[...new Set([...values,'STRICT_ALL_TABLES','NO_ENGINE_SUBSTITUTION','NO_AUTO_VALUE_ON_ZERO'])]
  await this.statement("SET SESSION sql_mode = '"+next.join(',')+"'")
 }
 /** Generated SQL is accepted only by the main-process job plan.
  * Not exposed through IPC or through the regular query console. */
 async applyStep(step:MigrationStep){for(const sql of step.sql)await this.statement(sql)}
 private async checkAdvancedTarget(database:string,name:string){
  // Require direct, unrestricted metadata visibility for destructive or
  // updating modes. A restricted account can hide incoming FKs/triggers.
  const grants=(await this.query('SHOW GRANTS FOR CURRENT_USER()')).flatMap(row=>Object.values(row).map(String))
  const global=grants.filter(g=>/^GRANT .* ON \*\.\* TO /i.test(g))
  const privileges=global.flatMap(g=>g.slice(6,g.toUpperCase().indexOf(' ON *.* TO ')).split(',').map(x=>x.trim().toUpperCase()))
  if(grants.some(g=>/^REVOKE /i.test(g))||!privileges.includes('ALL PRIVILEGES')&&!(privileges.includes('SELECT')&&privileges.includes('TRIGGER')))throw new Error('MIGRATION_DEPENDENCY: 高级写入需要完整元数据权限')
  const inbound=await this.query('SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? LIMIT 1',[database,name])
  if(inbound.length)throw new Error('MIGRATION_DEPENDENCY: 目标表存在外部外键引用')
 }
 async fileColumnTypes(database:string,name:string){
  if(protectedDatabase(this.kind,database))throw new Error('FILE_TRANSFER: 不允许操作系统数据库')
  const rows=await this.query('SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 1001',[database,name])
  if(!rows.length||rows.length>1000)throw new Error('FILE_TRANSFER: 无法读取目标字段')
  return rows.map(r=>({name:String(r.name),type:String(r.type)}))
 }
 async fileFields(database:string,name:string){return (await this.fileColumnTypes(database,name)).map(r=>r.name)}
 async *fileRows(database:string,name:string,selected?:string[],filter?:BrowseFilter,snapshotStarted=false){
  if(!snapshotStarted)await this.startSourceSnapshot()
  const fields=await this.fileFields(database,name),columns=selected||fields
  if(!columns.length||columns.some(c=>!fields.includes(c)))throw new Error('FILE_TRANSFER: 字段映射无效')
  const compiled=compileMysqlFilter(database,name,filter||newBrowseFilter())
  const raw=(this.client as unknown as {connection:import('mysql2').Connection}).connection
  const sql='SELECT '+columns.map(q).join(',')+compiled.sql.slice('SELECT *'.length)
  const command=compiled.parameters.length?raw.execute({sql,rowsAsArray:true},compiled.parameters):raw.query({sql,rowsAsArray:true})
  const stream=addAbortSignal(this.signal,command.stream({highWaterMark:8}))
  try{for await(const row of stream){abort(this.signal);if(!Array.isArray(row))throw new Error('FILE_TRANSFER: 文件记录格式无效');yield sqlFileRow(columns,row)}}
  finally{stream.destroy()}
 }
 async fileWrite(database:string,name:string,columns:string[],policy:DataFilePolicy,records:AsyncIterable<Record<string,unknown>>,beforeCommit:()=>void,committed:(n:number)=>void,allowEmpty=false){
  await this.prepareTarget()
  await this.statement('START TRANSACTION READ WRITE')
  let committing=false,total=0
  try{
   const target=tableTarget(database,name),all=await this.fileFields(database,name)
   if(!columns.length||columns.some(c=>!all.includes(c)))throw new Error('FILE_TRANSFER: 字段映射无效')
   await this.query('SELECT '+columns.map(q).join(',')+' FROM '+target+' LIMIT 0')
   // A normal import must be transactional and must not replay opaque
   // special-object definitions or trigger-dependent writes.
   const object=(await this.schema(database,[name])).objects[0]
   if(!object?.shape?.safe||object.triggerNames.length)throw new Error('FILE_TRANSFER: 目标结构需要人工审核')
   const shape=object.shape
   if(columns.some(c=>!shape.columns.some(f=>f.name===c)))throw new Error('FILE_TRANSFER: 字段映射无效')
   let alias='',conflict=''
   if(policy!=='append'){
    await this.checkAdvancedTarget(database,name)
    if(policy==='replace')await this.statement('DELETE FROM '+target)
    else{
     const keys=mysqlUpsertKeys(shape)
     if(!keys||keys.some(k=>!columns.includes(k)))throw new Error('FILE_TRANSFER: 插入更新需要映射全部主键')
     const changed=columns.filter(c=>!keys.includes(c)),updates=changed.length?changed:[keys[0]!]
     if(this.kind==='mariadb')conflict=' ON DUPLICATE KEY UPDATE '+updates.map(c=>q(c)+'=VALUES('+q(c)+')').join(',')
     else{
      const version=/^(\d+)\.(\d+)\.(\d+)/.exec(this.version)
      if(!version||Number(version[1])<8||Number(version[1])===8&&Number(version[2])===0&&Number(version[3])<19)throw new Error('FILE_TRANSFER: 当前版本不支持此写入模式')
      const incoming=name==='dbex_incoming'?'dbex_incoming_2':'dbex_incoming'
      alias=' AS '+q(incoming);conflict=' ON DUPLICATE KEY UPDATE '+updates.map(c=>q(c)+'='+q(incoming)+'.'+q(c)).join(',')
     }
    }
   }
   const packet=Number((await this.query('SELECT @@max_allowed_packet AS n'))[0]?.n),maxBytes=Math.min(BATCH_BYTES,Math.floor(packet/2)),maxRows=Math.min(BATCH_ROWS,Math.floor(60000/columns.length))
   if(!Number.isFinite(maxBytes)||maxBytes<32768||maxRows<1)throw new Error('FILE_TRANSFER: 目标数据包限制过小')
   let batch:Cell[][]=[],bytes=0
   const flush=async()=>{
    if(!batch.length)return
    abort(this.signal)
    const sql='INSERT INTO '+target+' ('+columns.map(q).join(',')+') VALUES '+batch.map(row=>'('+row.map(()=>'?').join(',')+')').join(',')+alias+conflict
    const [result]=await bounded(this.signal,this.stop,()=>this.client.execute<ResultSetHeader>({sql,timeout:30000},batch.flat()))
    if((policy==='upsert'?result.affectedRows>batch.length*2:result.affectedRows!==batch.length)||result.warningStatus!==0)throw new Error('FILE_TRANSFER: 写入结果或警告与预期不一致')
    total+=batch.length;batch=[];bytes=0
   }
   for await(const record of records){
    abort(this.signal)
    const row=columns.map(c=>{const v=sqlFileValue(record[c]);return typeof v==='bigint'?v.toString():v})
    const size=row.reduce<number>((n,v)=>n+cellBytes(v),0)
    if(size>maxBytes)throw new Error('FILE_TRANSFER: 单条文件记录超过目标批次容量')
    if(batch.length&&(batch.length>=maxRows||bytes+size>maxBytes))await flush()
    batch.push(row);bytes+=size
   }
   await flush()
   if(!total&&!allowEmpty)throw new Error('FILE_TRANSFER: 没有可导入的记录')
   abort(this.signal);committing=true;beforeCommit()
   await bounded(this.signal,this.stop,()=>this.client.query({sql:'COMMIT',timeout:30000}))
   committing=false;committed(total)
  }catch(e){if(!committing&&!this.signal.aborted)await bounded(this.signal,this.stop,()=>this.client.query({sql:'ROLLBACK',timeout:5000}),5000).catch(()=>{});throw e}
 }
 async copyFrom(source:MigrationEndpoint,sourceDb:string,targetDb:string,object:SchemaObject,options:MigrationCopyOptions,
  onRead:(rows:number,bytes:number)=>void,onPending:(rows:number)=>void,onCommitStart:()=>void,onCommit:(rows:number)=>void){
  if(!(source instanceof MysqlMigrationEndpoint))throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
  const shape=object.shape
  if(!shape?.safe||object.triggerNames.length)throw new Error('MIGRATION_UNSUPPORTED: 当前对象需要人工迁移')
  const columns=shape.columns.map(c=>q(c.name)).join(',')
  const packet=Number((await this.query('SELECT @@max_allowed_packet AS n'))[0]?.n)
  if(!Number.isFinite(packet)||packet<65536)throw new Error('MIGRATION_LIMIT: 目标数据包限制过小')
  const maxBytes=Math.min(BATCH_BYTES,Math.floor(packet/2))
  const maxRows=Math.min(BATCH_ROWS,Math.floor(60000/shape.columns.length))
  if(maxRows<1)throw new Error('MIGRATION_LIMIT: 数据库对象数量超出本阶段上限')
  let stream:import('node:stream').Readable|undefined,committing=false,pending=0,batch:Cell[][]=[],bytes=0
  let upsertClause='',upsertAlias=''
  const filter=sqlMigrationCondition(options.condition,shape.columns.map(c=>c.name),'mysql')
  const upsert=options.policy==='upsert'
  await this.statement('START TRANSACTION READ WRITE')
  const flush=async()=>{
   if(!batch.length)return
   abort(this.signal)
   const sql='INSERT INTO '+tableTarget(targetDb,object.name)+' ('+columns+') VALUES '+batch.map(row=>'('+row.map(()=>'?').join(',')+')').join(',')+upsertAlias+upsertClause
   const [result]=await bounded(this.signal,this.stop,()=>this.client.execute<ResultSetHeader>({sql,timeout:30000},batch.flat()))
   if((upsert?result.affectedRows<0||result.affectedRows>2*batch.length:result.affectedRows!==batch.length)||result.warningStatus!==0)throw new Error('MIGRATION_WRITE: 写入结果与预期不一致，已停止')
   pending+=batch.length;onPending(pending);batch=[];bytes=0
  }
  try{
   // The table is pinned by a real transaction-scoped metadata read before
   // rechecking the definition. Keep the locks until the copy commits.
   await source.query('SELECT '+columns+' FROM '+tableTarget(sourceDb,object.name)+' LIMIT 0')
   await this.query('SELECT '+columns+' FROM '+tableTarget(targetDb,object.name)+' LIMIT 0')
   const actualSource=(await source.schema(sourceDb,[object.name])).objects[0]
   const actualTarget=(await this.schema(targetDb,[object.name])).objects[0]
   if(!actualSource?.shape?.safe||!actualTarget?.shape?.safe||actualSource.triggerNames.length||actualTarget.triggerNames.length||
      !dataShape(shape,actualSource.shape,false)||!dataShape(shape,actualTarget.shape,source.kind!==this.kind))
     throw new Error('MIGRATION_STALE: 结构已变化，请重新比较')
   if(options.policy!=='append'){
    await this.checkAdvancedTarget(targetDb,object.name)
    if(upsert){
     const keys=mysqlUpsertKeys(actualSource.shape),targetKeys=mysqlUpsertKeys(actualTarget.shape)
     if(!keys||JSON.stringify(keys)!==JSON.stringify(targetKeys))throw new Error('MIGRATION_DEPENDENCY: 插入更新需要相同的主键')
     const fields=shape.columns.filter(c=>!keys.includes(c.name)).map(c=>c.name)
     // A primary-key-only table can use a self assignment on its key.
     const updates=fields.length?fields:[keys[0]!]
     if(this.kind==='mariadb')upsertClause=' ON DUPLICATE KEY UPDATE '+updates.map(n=>q(n)+'=VALUES('+q(n)+')').join(',')
     else{
      const version=/^(\d+)\.(\d+)\.(\d+)/.exec(this.version)
      if(!version||Number(version[1])<8||Number(version[1])===8&&Number(version[2])===0&&Number(version[3])<19)throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
      // The new row alias is a fixed identifier distinct from the table.
      const alias=object.name==='dbex_incoming'?'dbex_incoming_2':'dbex_incoming'
      upsertAlias=' AS '+q(alias)
      upsertClause=' ON DUPLICATE KEY UPDATE '+updates.map(n=>q(n)+'='+q(alias)+'.'+q(n)).join(',')
     }
    }else if(options.policy==='replace'){
     if(options.condition)throw new Error('MIGRATION_INPUT: 迁移参数无效')
     // DELETE and all inserts share one transaction, not implicit-commit
     // TRUNCATE. All target rows are locked by the delete until commit.
     await this.statement('DELETE FROM '+tableTarget(targetDb,object.name))
    }
   }
   // mysql2 PromiseConnection exposes its underlying callback connection at
   // runtime. Only this main-process adapter uses it for streaming/backpressure.
   const raw=(source.client as unknown as {connection:import('mysql2').Connection}).connection
   if(!raw)throw new Error('MIGRATION_UNSUPPORTED: 当前数据库类型尚不支持此操作')
   const query:QueryOptions={sql:'SELECT '+columns+' FROM '+tableTarget(sourceDb,object.name)+filter.where,rowsAsArray:true}
   const command=options.condition?raw.execute(query,filter.parameters):raw.query(query)
   stream=addAbortSignal(this.signal,command.stream({highWaterMark:8}))
   for await(const value of stream){
    abort(this.signal)
    if(!Array.isArray(value)||value.length!==shape.columns.length)throw new Error('MIGRATION_TYPE: 无法无损传输该字段值')
    const rowBytes=value.reduce((n:number,v:unknown)=>n+cellBytes(v),0)
    if(rowBytes>maxBytes)throw new Error('MIGRATION_LIMIT: 单行数据超过传输批次限制')
    if(batch.length&&(batch.length>=maxRows||bytes+rowBytes>maxBytes))await flush()
    batch.push(value as Cell[]);bytes+=rowBytes;onRead(1,rowBytes)
   }
   await flush()
   abort(this.signal);committing=true;onCommitStart()
   // A lost commit acknowledgement is explicitly uncertain, never retried.
   await bounded(this.signal,this.stop,()=>this.client.query({sql:'COMMIT',timeout:30000}))
   committing=false;onCommit(pending)
  }catch(error){
   if(!committing&&!this.signal.aborted)await bounded(this.signal,this.stop,()=>this.client.query({sql:'ROLLBACK',timeout:5000}),5000).catch(()=>{})
   // On failure the outer job closes both sessions, rolling back any open transaction.
   throw error
  }finally{stream?.destroy()}
 }
}
