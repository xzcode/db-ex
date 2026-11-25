import { DatabaseSync, backup, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { realpathSync, statSync } from 'node:fs'
import type { ExplorerNode, MysqlOperation, OperationResult, SqlRow, SqlValue } from '../../shared/types'
import { compileMysqlFilter } from '../../shared/browse-filter'
import { metrics, metric } from '../../shared/object-inspection'
import { boundedText, checkAborted, displayCell, emptyResult, MAX_BYTES, page, requireWrite, resourceName, sqlRow, type OperationContext } from './common'
import { inspectSqliteSql } from './sqlite-policy'

const quote=(name:string)=>'"'+resourceName(name).replaceAll('"','""')+'"'
const target=(database:string,entity:string)=>{if(database!=='main')throw new Error('INVALID_OPERATION: 不支持的操作');return 'main.'+quote(entity)}
const bind=(v:SqlValue):SQLInputValue=>typeof v==='boolean'?BigInt(Number(v)):typeof v==='number'&&Number.isSafeInteger(v)?BigInt(v):v
const storageType=(v:SQLOutputValue)=>v===null?'NULL':typeof v==='bigint'?'INTEGER':typeof v==='number'?'REAL':typeof v==='string'?'TEXT':'BLOB'
type Field={name:string;type:string;notnull:bigint;pk:bigint;hidden:bigint;dflt_value:SQLOutputValue}
export class SqliteOperations {
  private db:DatabaseSync
  private readonly path:string
  private readonly identity:{dev:number;ino:number}
  private writeHandle=false
  private transaction=false
  constructor(path:string) {
    this.path=realpathSync(path)
    const stat=statSync(this.path)
    if(!stat.isFile())throw new Error('INVALID_CONNECTION: SQLite')
    this.identity={dev:stat.dev,ino:stat.ino}
    this.db=this.open(true)
    try{this.db.prepare('SELECT name FROM main.sqlite_schema LIMIT 1').get()}catch(error){this.db.close();throw error}
  }
  private open(readOnly:boolean) {
    const stat=statSync(this.path)
    if(!stat.isFile()||stat.dev!==this.identity.dev||stat.ino!==this.identity.ino)throw new Error('CONNECTION_FAILED: SQLite')
    const db=new DatabaseSync(this.path,{readOnly,enableForeignKeyConstraints:true,allowExtension:false,enableDoubleQuotedStringLiterals:false})
    try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA query_only=ON');return db}catch(error){db.close();throw error}
  }
  private writable(){
    if(this.writeHandle)return
    const next=this.open(false);this.db.close();this.db=next;this.writeHandle=true
  }
  get transactionActive(){return this.transaction}
  close(){this.db.close();this.transaction=false}
  async backupTo(path:string){if(this.transaction)throw new Error('SESSION_BUSY: 请等待当前操作完成或取消');await backup(this.db,path)}
  private statement(sql:string){const stmt=this.db.prepare(sql);stmt.setReadBigInts(true);return stmt}
  private fields(database:string,entity:string):Field[]{
    target(database,entity)
    return this.statement('SELECT name,type,"notnull",pk,hidden,dflt_value FROM pragma_table_xinfo(?, ?) ORDER BY cid LIMIT 501').all(entity,database) as unknown as Field[]
  }
  private keys(fields:Field[]){return fields.filter(f=>f.pk>0n).sort((a,b)=>Number(a.pk-b.pk)).map(f=>f.name)}
  private object(database:string,entity:string){
    target(database,entity)
    const row=this.statement("SELECT type,sql FROM main.sqlite_schema WHERE name=? AND type IN ('table','view')").get(entity)
    if(!row)throw new Error('INVALID_INPUT: 表或视图不存在')
    return row
  }
  children():ExplorerNode[]{
    return this.statement("SELECT name,type FROM main.sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT 500").all().map(row=>({id:JSON.stringify(['sqlite','main',row.name]),label:String(row.name),entity:String(row.name),database:'main',kind:row.type==='view'?'view':'table',readOnly:row.type==='view'}))
  }
  private result(sql:string,args:SQLInputValue[],limit:number,offset=0):OperationResult {
    const stmt=this.statement(sql),columns=stmt.columns().map(c=>c.name)
    if(new Set(columns).size!==columns.length)throw new Error('INVALID_INPUT: SQL 查询请为重复字段设置别名')
    const rows:Record<string,string>[]=[],rawRows:SqlRow[]=[],sqliteTypes:string[][]=[],nullCells:number[][]=[]
    let bytes=0,exact=true,more=false
    for(const row of stmt.iterate(...args)){
      if(rows.length>=limit){more=true;break}
      const display:Record<string,string>=Object.create(null),raw:SqlRow=Object.create(null),types:string[]=[],nulls:number[]=[]
      let rowExact=true
      for(const [i,col] of columns.entries()){
        const value=row[col]??null
        display[col]=displayCell(value instanceof Uint8Array?Buffer.from(value):value)
        types.push(storageType(value));if(value===null)nulls.push(i)
        if(typeof value==='bigint'){if(value<=BigInt(Number.MAX_SAFE_INTEGER)&&value>=BigInt(Number.MIN_SAFE_INTEGER))raw[col]=Number(value);else rowExact=false}
        else if(value instanceof Uint8Array)rowExact=false
        else if(typeof value==='number'&&!Number.isFinite(value))rowExact=false
        else if(typeof value==='string'&&Buffer.byteLength(value)>512*1024)rowExact=false
        else raw[col]=value
      }
      const size=Buffer.byteLength(JSON.stringify(display))+Buffer.byteLength(JSON.stringify(raw))
      if(bytes+size>MAX_BYTES){more=true;break}
      bytes+=size;rows.push(display);rawRows.push(raw);sqliteTypes.push(types);nullCells.push(nulls);exact=exact&&rowExact
    }
    return {columns,rows,rawRows:exact?rawRows:undefined,sqliteTypes,nullCells,nextOffset:more&&rows.length?offset+rows.length:undefined,truncated:more}
  }
  private atomic<T>(fn:()=>T):T{
    this.db.exec('SAVEPOINT dbex_row')
    try{const result=fn();this.db.exec('RELEASE dbex_row');return result}
    catch(error){this.db.exec('ROLLBACK TO dbex_row; RELEASE dbex_row');throw error}
  }
  private writableFields(database:string,entity:string){
    if(this.object(database,entity).type!=='table')throw new Error('READ_ONLY: 只读对象')
    const fields=this.fields(database,entity)
    if(fields.length>500)throw new Error('LIMIT_EXCEEDED: 表字段过多，不能安全编辑')
    return fields
  }
  private insert(database:string,entity:string,values:unknown,fields:Field[]){
    const row=sqlRow(values,'新增记录'),names=Object.keys(row)
    if(!names.length)throw new Error('INVALID_INPUT: 新增记录至少需要一个字段')
    for(const name of names)if(!fields.some(f=>f.name===name&&f.hidden===0n))throw new Error('INVALID_INPUT: 数据包含不属于该表的字段')
    const result=this.statement('INSERT INTO '+target(database,entity)+' ('+names.map(quote).join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').run(...names.map(n=>bind(row[n]!)))
    return Number(result.changes)
  }
  execute(op:MysqlOperation,ctx:OperationContext):OperationResult{
    checkAborted(ctx.signal)
    const policy=op.action==='mysql.query'?inspectSqliteSql(op.sql):undefined
    const writing=policy?.mode==='write'||['mysql.begin','mysql.commit','mysql.insert','mysql.update','mysql.delete','mysql.import'].includes(op.action)
    if(writing){requireWrite(ctx);this.writable();this.db.exec('PRAGMA query_only=OFF')}
    try{
      switch(op.action){
        case 'mysql.query':{
          if(op.database&&op.database!=='main')throw new Error('INVALID_OPERATION: 不支持的操作')
          const args=op.parameters??[]
          if(!Array.isArray(args)||args.length>1000)throw new Error('INVALID_INPUT: SQL 参数必须是最多 1000 项的数组')
          const params=args.map(v=>bind(sqlRow({v},'SQL').v!))
          if(policy!.mode==='write'){const r=this.statement(policy!.sql).run(...params);return {...emptyResult('语句已执行',Number(r.changes)),transaction:this.transaction}}
          const {limit,offset}=page(op)
          if(/^EXPLAIN\b/i.test(policy!.sql))return this.result(policy!.sql,params,limit)
          return this.result('SELECT * FROM ('+policy!.sql+'\n) AS dbex_result LIMIT '+(limit+1)+' OFFSET '+offset,params,limit,offset)
        }
        case 'mysql.browse':{
          target(op.database,op.entity)
          const {limit,offset}=page(op),compiled=compileMysqlFilter(op.database,op.entity,op.filter,'sqlite')
          if(op.countOnly){const row=this.statement(compiled.countSql).get(...compiled.parameters.map(bind));const n=String(row?.total??0);return {columns:[],rows:[],totalRows:n,countLimited:BigInt(n)>=1000001n}}
          return this.result(compiled.sql+' LIMIT '+(limit+1)+' OFFSET '+offset,compiled.parameters.map(bind),limit,offset)
        }
        case 'mysql.structure':{
          const fields=this.fields(op.database,op.entity)
          const indexes=this.statement('SELECT name,"unique" AS unique_index FROM pragma_index_list(?,?) ORDER BY seq LIMIT 501').all(op.entity,op.database)
          const indexFields=new Map<string,string[]>()
          for(const index of indexes.slice(0,500)){
            const indexName=String(index.name)
            for(const column of this.statement('SELECT name FROM pragma_index_xinfo(?,?) WHERE "key"=1 LIMIT 501').all(indexName,op.database)){
              if(typeof column.name!=='string')continue
              const list=indexFields.get(column.name)||[];list.push(indexName+(index.unique_index?' (unique)':''));indexFields.set(column.name,list)
            }
          }
          return {columns:['name','type','nullable','key','extra','default','indexes'],rows:fields.slice(0,500).map(f=>({name:f.name,type:f.type,nullable:f.notnull?'NO':'YES',key:f.pk?'PRI':'',extra:f.hidden?'GENERATED/HIDDEN':'',default:displayCell(f.dflt_value),indexes:displayCell((indexFields.get(f.name)||[]).join(', '))})),primaryKeys:this.keys(fields),truncated:fields.length>500||indexes.length>500}
        }
        case 'mysql.inspect':{
          const row=this.object(op.database,op.entity),fields=this.fields(op.database,op.entity)
          const indexes=this.statement("SELECT name,sql FROM main.sqlite_schema WHERE tbl_name=? AND type='index' ORDER BY name LIMIT 501").all(op.entity)
          const definition=[row.sql,...indexes.slice(0,500).map(i=>i.sql)].filter(v=>typeof v==='string').map(v=>String(v).trimEnd().replace(/;$/,'')+';').join('\n\n')
          return {columns:[],rows:[],inspection:{kind:row.type==='view'?'view':'table',metrics:metrics(metric('字段数',fields.length),metric('索引数',indexes.length)),definition:Buffer.byteLength(definition)<=MAX_BYTES&&indexes.length<=500?definition:undefined,definitionNote:Buffer.byteLength(definition)>MAX_BYTES||indexes.length>500?'DDL 不可用或超出读取上限。':undefined}}
        }
        case 'mysql.begin':
          if(this.transaction)throw new Error('INVALID_OPERATION: 当前有未提交事务。')
          this.db.exec('BEGIN');this.transaction=true;return {...emptyResult('事务已开始'),transaction:true}
        case 'mysql.commit':
          if(this.transaction)this.db.exec('COMMIT');this.transaction=false;return {...emptyResult('事务已提交'),transaction:false}
        case 'mysql.rollback':
          if(this.transaction)this.db.exec('ROLLBACK');this.transaction=false;return {...emptyResult('事务已回滚'),transaction:false}
        case 'mysql.insert':{
          const n=this.insert(op.database,op.entity,op.values,this.writableFields(op.database,op.entity));return {...emptyResult('语句已执行',n),transaction:this.transaction}
        }
        case 'mysql.import':{
          if(!Array.isArray(op.rows)||!op.rows.length||op.rows.length>500)throw new Error('INVALID_INPUT: 每批导入 1–500 条 EJSON 文档')
          const fields=this.writableFields(op.database,op.entity),n=this.atomic(()=>op.rows.reduce((sum,row)=>sum+this.insert(op.database,op.entity,row,fields),0))
          return {...emptyResult('导入完成',n),transaction:this.transaction}
        }
        case 'mysql.update':case 'mysql.delete':{
          const fields=this.writableFields(op.database,op.entity),keys=this.keys(fields),original=sqlRow(op.original,'原始记录'),key=sqlRow(op.key,'主键')
          if(!keys.length||keys.some(k=>key[k]===null||key[k]===undefined||key[k]!==original[k])||Object.keys(key).length!==keys.length)throw new Error('NO_PRIMARY_KEY: 该表没有主键，不能安全进行单行修改或删除')
          const names=fields.filter(f=>f.hidden!==1n).map(f=>f.name)
          if(names.some(n=>!Object.hasOwn(original,n))||Object.keys(original).some(n=>!names.includes(n)))throw new Error('INCOMPLETE_ROW: 编辑前请获取包含全部字段的原始记录')
          const where=names.map(n=>quote(n)+' COLLATE BINARY IS ?').join(' AND ')
          const params=names.map(n=>bind(original[n]!))
          const changes=op.action==='mysql.update'?sqlRow(op.changes,'修改记录'):undefined
          const changed=changes?Object.keys(changes):[]
          if(changes&&changed.some(n=>!fields.some(f=>f.name===n&&f.hidden===0n)))throw new Error('INVALID_INPUT: 数据包含不属于该表的字段')
          if(changes&&!changed.length)return emptyResult('语句已执行',0)
          const n=this.atomic(()=>{
            const stmt=changes?'UPDATE '+target(op.database,op.entity)+' SET '+changed.map(n=>quote(n)+'=?').join(',')+' WHERE '+where:'DELETE FROM '+target(op.database,op.entity)+' WHERE '+where
            const res=this.statement(stmt).run(...(changes?changed.map(n=>bind(changes[n]!)):[]),...params)
            if(res.changes!==1n&&res.changes!==1)throw new Error('ROW_CONFLICT: 原始记录已变化，请刷新后重试')
            return 1
          })
          return {...emptyResult('语句已执行',n),transaction:this.transaction}
        }
        default:throw new Error('INVALID_OPERATION: 不支持的操作')
      }
    }finally{if(writing)this.db.exec('PRAGMA query_only=ON')}
  }
}
