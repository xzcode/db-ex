import type { Connection } from 'mysql2/promise'
import type { Connection as CoreConnection, FieldPacket, ResultSetHeader } from 'mysql2'
import type { MysqlOperation, OperationResult, SqlRow, SqlValue } from '../../shared/types'
import { checkAborted, databaseError, displayCell, emptyResult, MAX_BYTES, MAX_ROWS, MAX_VALUE_BYTES, page, requireWrite, resourceName, sqlRow, TIMEOUT_MS, type OperationContext } from './common'
import { inspectSql, quoteIdentifier } from './sql-policy'

interface QueryData {
  columns: string[]
  values: unknown[][]
  header?: ResultSetHeader
  truncated: boolean
}
interface ColumnInfo { name: string; type: string; nullable: boolean; key: string; extra: string }
interface Structure { columns: ColumnInfo[]; primaryKeys: string[]; indexes: Record<string, unknown>[]; engine: string }

/** One instance per physical connection; transactions cannot bleed between tabs. */
export class MysqlOperations {
  private readonly core: CoreConnection
  private controller?: AbortController
  private transaction = false
  private closed = false

  constructor(private readonly client: Connection) {
    // mysql2's promise wrapper exposes its underlying streaming connection.
    this.core = (client as unknown as { connection: CoreConnection }).connection
    if (!this.core) throw new Error('DRIVER_ERROR: MySQL 连接缺少流式查询接口')
  }

  get transactionActive(): boolean { return this.transaction }
  get disconnected(): boolean { return this.closed }

  cancel(): void {
    if (!this.controller) return
    this.controller.abort(new Error('CANCELLED: 操作已取消；MySQL 会话已断开，未提交事务将由服务器回滚，请重新连接'))
    this.destroy()
  }

  async close(): Promise<void> {
    if (this.controller) { this.cancel(); return }
    if (this.transaction && !this.closed) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try { await this.query('ROLLBACK', [], controller.signal, 1, false) } catch { this.destroy() }
      finally { clearTimeout(timer); this.transaction = false }
    }
  }

  private destroy(): void {
    this.closed = true
    this.transaction = false
    this.client.destroy()
  }

  async execute(operation: MysqlOperation, context: OperationContext): Promise<OperationResult> {
    if (this.closed) throw new Error('SESSION_CLOSED: MySQL 会话已关闭，请重新连接')
    if (this.controller) throw new Error('SESSION_BUSY: 当前会话已有查询执行中')
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort(new Error('CANCELLED: 操作已取消；请重新连接 MySQL'))
    context.signal?.addEventListener('abort', onAbort, { once: true })
    this.controller = controller
    const timer = setTimeout(() => controller.abort(new Error('TIMEOUT: 操作超过 30 秒；MySQL 会话已断开，请重新连接')), TIMEOUT_MS)
    try {
      checkAborted(context.signal)
      const result = await this.run(operation, context, controller.signal)
      return { ...result, durationMs: Date.now() - started, transaction: this.transaction, disconnected: this.closed }
    } catch (error) {
      throw databaseError(error)
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      this.controller = undefined
    }
  }

  private async run(operation: MysqlOperation, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    switch (operation.action) {
      case 'mysql.query': return this.executeSql(operation, context, signal)
      case 'mysql.structure': {
        const structure = await this.structure(operation.database, operation.entity, signal)
        const rows = structure.columns.map(column => ({
          name: column.name, type: column.type, nullable: String(column.nullable), key: column.key,
          extra: column.extra, engine: structure.engine,
          indexes: structure.indexes.filter(index => index.Column_name === column.name).map(index => `${index.Key_name}${Number(index.Non_unique) === 0 ? ' (unique)' : ''}`).join(', '),
        }))
        return { columns: ['name', 'type', 'nullable', 'key', 'extra', 'engine', 'indexes'], rows, primaryKeys: structure.primaryKeys }
      }
      case 'mysql.begin': {
        requireWrite(context)
        if (this.transaction) throw new Error('TRANSACTION_ACTIVE: 当前已有未完成事务')
        await this.query('START TRANSACTION READ WRITE', [], signal, 1, false)
        this.transaction = true
        return emptyResult('事务已开始；修改需要显式提交')
      }
      case 'mysql.commit': {
        requireWrite(context)
        if (!this.transaction) throw new Error('NO_TRANSACTION: 当前没有活动事务')
        await this.query('COMMIT', [], signal, 1, false)
        this.transaction = false
        return emptyResult('事务已提交')
      }
      case 'mysql.rollback': {
        if (!this.transaction) return emptyResult('当前没有活动事务')
        await this.query('ROLLBACK', [], signal, 1, false)
        this.transaction = false
        return emptyResult('事务已回滚')
      }
      case 'mysql.insert': return this.insert(operation.database, operation.entity, operation.values, context, signal)
      case 'mysql.update': return this.change(operation, context, signal)
      case 'mysql.delete': return this.change(operation, context, signal)
      case 'mysql.import': return this.importRows(operation, context, signal)
      default: throw new Error('INVALID_OPERATION: 不支持的 MySQL 操作')
    }
  }

  private async executeSql(operation: Extract<MysqlOperation, { action: 'mysql.query' }>, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    const policy = inspectSql(operation.sql, context.writable)
    if (policy.mode === 'write') requireWrite(context)
    if (policy.ddl && this.transaction) throw new Error('IMPLICIT_COMMIT: DDL 会隐式提交，请先显式提交或回滚当前事务')
    const { limit, offset } = page(operation)
    const parameters = operation.parameters ?? []
    if (!Array.isArray(parameters) || parameters.length > 1000) throw new Error('INVALID_INPUT: SQL 参数必须是最多 1000 项的数组')
    parameters.forEach((value, index) => sqlRow({ value }, `参数 ${index + 1}`))
    if (operation.database) {
      // Use a validated, quoted identifier rather than accepting raw USE SQL from the UI.
      await this.query(`USE ${quoteIdentifier(operation.database)}`, [], signal, 1, false)
    }
    const temporaryReadTransaction = policy.mode === 'read' && !this.transaction
    if (temporaryReadTransaction) await this.query('START TRANSACTION READ ONLY', [], signal, 1, false)
    try {
      const sql = policy.select
        ? `SELECT * FROM (${policy.sql}\n) AS \`dbex_result\` LIMIT ${limit + 1} OFFSET ${offset}`
        : policy.sql
      const data = await this.query(sql, parameters, signal, policy.select ? limit + 1 : MAX_ROWS)
      if (data.header) return emptyResult(`语句已执行${this.transaction ? '（事务尚未提交）' : ''}`, data.header.affectedRows)
      const hasNext = policy.select && data.values.length > limit
      if (hasNext) data.values.pop()
      const result = this.result(data)
      result.nextOffset = hasNext ? offset + limit : undefined
      result.truncated = result.truncated || hasNext
      return result
    } finally {
      if (temporaryReadTransaction && !this.closed) await this.query('ROLLBACK', [], signal, 1, false)
    }
  }

  private async structure(database: string, entity: string, signal: AbortSignal): Promise<Structure> {
    const target = `${quoteIdentifier(database)}.${quoteIdentifier(entity)}`
    const fields = await this.query(`SHOW FULL COLUMNS FROM ${target}`, [], signal, 500)
    if (fields.truncated) throw new Error('LIMIT_EXCEEDED: 表字段过多，不能安全编辑')
    const records = this.records(fields)
    const columns = records.map(row => ({
      name: String(row.Field), type: String(row.Type), nullable: row.Null === 'YES', key: String(row.Key), extra: String(row.Extra),
    }))
    const indexData = await this.query(`SHOW INDEX FROM ${target}`, [], signal, 500)
    if (indexData.truncated) throw new Error('LIMIT_EXCEEDED: 表索引过多')
    const indexes = this.records(indexData)
    const primaryKeys = indexes.filter(row => row.Key_name === 'PRIMARY')
      .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index)).map(row => String(row.Column_name))
    const engineData = await this.query('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1', [database, entity], signal, 1)
    const engine = String(engineData.values[0]?.[0] ?? '')
    return { columns, primaryKeys, indexes, engine }
  }

  private validateColumns(row: SqlRow, structure: Structure, changes: boolean): void {
    const known = new Map(structure.columns.map(column => [column.name, column]))
    for (const name of Object.keys(row)) {
      const column = known.get(name)
      if (!column) throw new Error('INVALID_INPUT: 数据包含不属于该表的字段')
      if (changes && /\b(?:VIRTUAL|STORED) GENERATED\b/i.test(column.extra)) throw new Error('INVALID_INPUT: 不可手动修改生成列')
    }
  }

  private async insert(database: string, entity: string, value: SqlRow, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    requireWrite(context)
    const values = sqlRow(value, '新增记录')
    const structure = await this.structure(database, entity, signal)
    this.validateColumns(values, structure, true)
    const affected = await this.insertRow(database, entity, values, signal)
    return emptyResult(`已新增 ${affected} 行${this.transaction ? '（事务尚未提交）' : ''}`, affected)
  }

  private async insertRow(database: string, entity: string, values: SqlRow, signal: AbortSignal): Promise<number> {
    const columns = Object.keys(values)
    if (!columns.length) throw new Error('INVALID_INPUT: 新增记录至少需要一个字段')
    const data = await this.query(
      `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(entity)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => values[column]), signal, 1,
    )
    return data.header?.affectedRows ?? 0
  }

  private async change(operation: Extract<MysqlOperation, { action: 'mysql.update' | 'mysql.delete' }>, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    requireWrite(context)
    const key = sqlRow(operation.key, '主键')
    const original = sqlRow(operation.original, '原始记录')
    const structure = await this.structure(operation.database, operation.entity, signal)
    if (!structure.primaryKeys.length) throw new Error('NO_PRIMARY_KEY: 该表没有主键，不能安全进行单行修改或删除')
    if (Object.keys(key).length !== structure.primaryKeys.length || structure.primaryKeys.some(name => !(name in key) || key[name] === null || key[name] !== original[name])) {
      throw new Error('INVALID_PRIMARY_KEY: 必须提供完整且与原始记录相符的主键')
    }
    this.validateColumns(original, structure, false)
    if (structure.columns.some(column => !Object.hasOwn(original, column.name))) {
      throw new Error('INCOMPLETE_ROW: 编辑前请获取包含全部字段的原始记录')
    }
    const names = Object.keys(original)
    const columnTypes = new Map(structure.columns.map(column => [column.name, column.type]))
    // Text comparison must ignore the table's case/accent-insensitive collation
    // and PAD SPACE rules; otherwise an externally changed row can look equal.
    // Numeric/date columns retain typed comparison so DECIMAL formatting does
    // not produce false conflicts. Binary result rows are not editable.
    const where = names.map(name => /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set|json)\b/i.test(columnTypes.get(name) || '')
      ? `CAST(${quoteIdentifier(name)} AS BINARY) <=> CAST(? AS BINARY)`
      : `${quoteIdentifier(name)} <=> ?`).join(' AND ')
    const target = `${quoteIdentifier(operation.database)}.${quoteIdentifier(operation.entity)}`
    let sql: string
    let parameters: SqlValue[]
    if (operation.action === 'mysql.update') {
      const changes = sqlRow(operation.changes, '修改值')
      this.validateColumns(changes, structure, true)
      const changed = Object.keys(changes).filter(name => changes[name] !== original[name])
      if (!changed.length) return emptyResult('记录没有变化', 0)
      sql = `UPDATE ${target} SET ${changed.map(name => `${quoteIdentifier(name)} = ?`).join(', ')} WHERE ${where} LIMIT 1`
      parameters = [...changed.map(name => changes[name]), ...names.map(name => original[name])]
    } else {
      sql = `DELETE FROM ${target} WHERE ${where} LIMIT 1`
      parameters = names.map(name => original[name])
    }
    const result = await this.query(sql, parameters, signal, 1)
    if (result.header?.affectedRows !== 1) throw new Error('EDIT_CONFLICT: 记录已被修改或删除，请刷新后重试')
    return emptyResult(`已${operation.action === 'mysql.update' ? '修改' : '删除'} 1 行${this.transaction ? '（事务尚未提交）' : ''}`, 1)
  }

  private async importRows(operation: Extract<MysqlOperation, { action: 'mysql.import' }>, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    requireWrite(context)
    if (!Array.isArray(operation.rows) || operation.rows.length < 1 || operation.rows.length > MAX_ROWS) throw new Error('LIMIT_EXCEEDED: 每批导入 1 至 500 行')
    const rows = operation.rows.map(row => sqlRow(row, '导入行'))
    if (Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) throw new Error('LIMIT_EXCEEDED: 单批导入最大 2 MiB')
    const structure = await this.structure(operation.database, operation.entity, signal)
    if (structure.engine.toUpperCase() !== 'INNODB') throw new Error('TRANSACTION_REQUIRED: 批量导入仅支持 InnoDB 表，确保失败可以回滚')
    for (const row of rows) this.validateColumns(row, structure, true)
    const existingTransaction = this.transaction
    await this.query(existingTransaction ? 'SAVEPOINT dbex_import' : 'START TRANSACTION READ WRITE', [], signal, 1, false)
    let affected = 0
    try {
      for (const row of rows) {
        checkAborted(signal)
        affected += await this.insertRow(operation.database, operation.entity, row, signal)
      }
      await this.query(existingTransaction ? 'RELEASE SAVEPOINT dbex_import' : 'COMMIT', [], signal, 1, false)
      return emptyResult(`已导入 ${affected} 行${existingTransaction ? '（事务尚未提交）' : ''}`, affected)
    } catch (error) {
      if (!this.closed) {
        await this.query(existingTransaction ? 'ROLLBACK TO SAVEPOINT dbex_import' : 'ROLLBACK', [], signal, 1, false)
        if (existingTransaction) await this.query('RELEASE SAVEPOINT dbex_import', [], signal, 1, false)
      }
      throw error
    }
  }

  private records(data: QueryData): Record<string, unknown>[] {
    return data.values.map(values => Object.fromEntries(data.columns.map((column, index) => [column, values[index]])))
  }

  private result(data: QueryData): OperationResult {
    const records = this.records(data)
    const rows = records.map(row => Object.fromEntries(data.columns.map(column => [column, displayCell(row[column])])))
    const editable = !records.some(row => Object.values(row).some(value => Buffer.isBuffer(value)))
    const rawRows: SqlRow[] | undefined = editable ? records.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value === null || value === undefined) return [key, null]
      if (typeof value === 'bigint') return [key, value.toString()]
      if (value instanceof Date) return [key, value.toISOString()]
      if (typeof value === 'object') return [key, JSON.stringify(value)]
      return [key, value]
    })) as SqlRow) : undefined
    return {
      columns: data.columns, rows, rawRows, truncated: data.truncated,
      message: data.truncated ? '返回量达到上限；请缩小查询范围后重试' : editable ? undefined : '含二进制字段的结果仅供浏览，避免从编码预览误写数据',
    }
  }

  /** Prepared statements, event-by-event rows, strict byte cap, never buffered .toArray(). */
  private query(sql: string, parameters: SqlValue[], signal: AbortSignal, maxRows: number, prepared = true): Promise<QueryData> {
    checkAborted(signal)
    if (this.closed) return Promise.reject(new Error('SESSION_CLOSED: 请重新连接 MySQL'))
    return new Promise((resolve, reject) => {
      const data: QueryData = { columns: [], values: [], truncated: false }
      let bytes = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(data)
      }
      const abort = () => {
        this.destroy()
        finish(signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: MySQL 操作已取消，请重新连接'))
      }
      signal.addEventListener('abort', abort, { once: true })
      const options = { sql, rowsAsArray: true, timeout: TIMEOUT_MS }
      const query = prepared ? this.core.execute(options, parameters) : this.core.query(options)
      query.on('fields', (fields?: FieldPacket[]) => {
        if (!fields) return
        const counts = new Map<string, number>()
        data.columns = fields.map(field => {
          const count = (counts.get(field.name) ?? 0) + 1
          counts.set(field.name, count)
          return count === 1 ? field.name : `${field.name}#${count}`
        })
      })
      query.on('result', (value: unknown) => {
        if (settled) return
        if (!Array.isArray(value)) { data.header = value as ResultSetHeader; return }
        const rowBytes = Buffer.byteLength(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item))
        if (data.values.length >= maxRows || bytes + rowBytes > MAX_BYTES || rowBytes > MAX_VALUE_BYTES || value.length > 500) {
          data.truncated = true
          this.destroy()
          finish()
          return
        }
        data.values.push(value)
        bytes += rowBytes
      })
      query.on('error', (error: Error & { fatal?: boolean }) => {
        if (error.fatal) this.destroy()
        finish(error)
      })
      query.on('end', () => finish())
    })
  }
}
