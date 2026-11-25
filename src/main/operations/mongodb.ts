import { BSON, MongoBulkWriteError, type AbstractCursor, type CreateIndexesOptions, type Document, type IndexDirection, type MongoClient, type Sort } from 'mongodb'
import type { MongoOperation, OperationResult } from '../../shared/types'
import type { BsonTypeBranch } from '../../shared/bson-types'
import { describeBsonDocument, newTypeBudget } from './bson-metadata'
import { metric, metrics, type ObjectInspection } from '../../shared/object-inspection'
import { validateDatabaseName, validateInitialCollection } from '../../shared/database-admin'
import { mongoDefinition } from './mongo-definition'
import { boundedText, checkAborted, databaseError, displayCell, emptyResult, MAX_BYTES, MAX_ROWS, MAX_VALUE_BYTES, page, plainObject, requireWrite, resourceName, TIMEOUT_MS, type OperationContext } from './common'

const FORBIDDEN_OPERATORS = new Set(['$where', '$function', '$accumulator', '$out', '$merge'])
const READ_STAGES = new Set(['$addFields', '$bucket', '$bucketAuto', '$collStats', '$count', '$densify', '$documents', '$facet', '$fill', '$geoNear', '$graphLookup', '$group', '$indexStats', '$limit', '$lookup', '$match', '$project', '$redact', '$replaceRoot', '$replaceWith', '$sample', '$search', '$searchMeta', '$set', '$setWindowFields', '$skip', '$sort', '$sortByCount', '$unionWith', '$unset', '$unwind', '$vectorSearch'])

export function parseEjson(text: unknown, label: string): unknown {
  const source = boundedText(text, label)
  try { return BSON.EJSON.parse(source, { relaxed: false }) }
  catch { throw new Error(`INVALID_EJSON: ${label}不是有效的 Extended JSON`) }
}

/** Block server-side JavaScript, write stages and prototype keys at every depth. */
export function validateReadDocument(value: unknown): void {
  let nodes = 0
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 64) throw new Error('LIMIT_EXCEEDED: MongoDB 表达式过大或嵌套超过 64 层')
    if (item instanceof BSON.Code) throw new Error('MONGO_POLICY: 不执行服务端 JavaScript')
    if (item === null || typeof item !== 'object') return
    if (Array.isArray(item)) { item.forEach(child => walk(child, depth + 1)); return }
    if (item instanceof BSON.BSONValue || item instanceof Date || item instanceof RegExp || Buffer.isBuffer(item)) return
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_OPERATORS.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new Error('MONGO_POLICY: 读取操作不支持写入阶段、服务端 JavaScript 或原型字段')
      }
      walk(child, depth + 1)
    }
  }
  walk(value, 0)
}

export function parsePipeline(text: unknown): Document[] {
  const value = parseEjson(text, '聚合管线')
  if (!Array.isArray(value) || value.length > 100) throw new Error('INVALID_PIPELINE: 管线必须是最多 100 个阶段的数组')
  for (const stage of value) {
    const keys = Object.keys(plainObject(stage, '聚合阶段'))
    if (keys.length !== 1 || !READ_STAGES.has(keys[0])) throw new Error('MONGO_POLICY: 只接受受支持的读取聚合阶段；不允许 $out / $merge')
  }
  validateReadDocument(value)
  return value as Document[]
}

function objectEjson(text: string | undefined, label: string): Document {
  const result = plainObject(parseEjson(text?.trim() || '{}', label), label)
  validateReadDocument(result)
  return result
}

function scalarNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (value instanceof BSON.Int32 || value instanceof BSON.Double || value instanceof BSON.Long) return Number(value.valueOf())
  return undefined
}

function projectionEjson(text?: string): Document {
  const result = objectEjson(text, 'Projection')
  for (const [key, value] of Object.entries(result)) {
    const number = scalarNumber(value)
    if (number !== 0 && number !== 1) throw new Error('INVALID_PROJECTION: Projection 的字段值必须为 0 或 1')
    result[key] = number
  }
  return result
}

function sortEjson(text?: string): Sort {
  const result = objectEjson(text, 'Sort')
  if (Object.keys(result).length > 32) throw new Error('LIMIT_EXCEEDED: 最多 32 个排序字段')
  for (const [key, value] of Object.entries(result)) {
    const number = scalarNumber(value)
    if (number !== -1 && number !== 1) throw new Error('INVALID_SORT: Sort 的字段值必须为 1 或 -1')
    result[key] = number
  }
  return result as Sort
}

function documentEjson(text: string, label: string): Document {
  const document = plainObject(parseEjson(text, label), label)
  if (Buffer.byteLength(BSON.EJSON.stringify(document, { relaxed: false })) > MAX_VALUE_BYTES) throw new Error('LIMIT_EXCEEDED: 单份文档最多 512 KiB')
  // Documents may contain literal $ fields; they are never executed as filters.
  for (const key of Object.keys(document)) if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('INVALID_DOCUMENT: 不支持原型字段')
  return document
}

/** Shared by the read-only validation command and the actual replacement. */
function checkedReplacement(originalText: string, replacementText: string): { original: Document; replacement: Document } {
  const original = documentEjson(originalText, '原始文档')
  const replacement = documentEjson(replacementText, '替换文档')
  if (!Object.hasOwn(original, '_id') || !Object.hasOwn(replacement, '_id') || BSON.EJSON.stringify(replacement._id, { relaxed: false }) !== BSON.EJSON.stringify(original._id, { relaxed: false })) {
    throw new Error('IMMUTABLE_ID: 替换文档必须保留原来的 _id')
  }
  return { original, replacement }
}
/** Validate without connecting to a database or changing its state. */
export function validateMongoDocumentEdit(text: string, original?: string): void {
  const document = original === undefined ? documentEjson(text, '新增文档') : checkedReplacement(original, text).replacement
  try { BSON.serialize(document) } catch { throw new Error('INVALID_DOCUMENT: 文档 BSON 类型无效') }
}

/** Compare the complete old document as a literal, so missing/new fields cause a conflict. */
export function optimisticFilter(original: Document): Document {
  if (!Object.hasOwn(original, '_id')) throw new Error('MISSING_ID: 修改或删除前必须读取包含 _id 的完整文档')
  return { _id: { $eq: original._id }, $expr: { $eq: ['$$ROOT', { $literal: original }] } }
}

export class MongoOperations {
  private controller?: AbortController
  private cursor?: AbstractCursor

  constructor(private readonly client: MongoClient) {}

  cancel(): void { this.controller?.abort(new Error('CANCELLED: MongoDB 操作已取消')) }
  async close(): Promise<void> {
    this.cancel()
    try { await this.cursor?.close() } catch { /* Parent closes the client next. */ }
  }

  async execute(operation: MongoOperation, context: OperationContext): Promise<OperationResult> {
    if (this.controller) throw new Error('SESSION_BUSY: 当前会话已有操作执行中')
    const controller = new AbortController()
    this.controller = controller
    const started = Date.now()
    const onAbort = () => controller.abort(new Error('CANCELLED: MongoDB 操作已取消'))
    context.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('TIMEOUT: MongoDB 操作超过 30 秒')), TIMEOUT_MS)
    try {
      checkAborted(context.signal)
      const result = await this.run(operation, context, controller.signal)
      return { ...result, durationMs: Date.now() - started }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw databaseError(error)
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      this.controller = undefined
      this.cursor = undefined
    }
  }

  private async run(operation: MongoOperation, context: OperationContext, signal: AbortSignal): Promise<OperationResult> {
    const database = resourceName(operation.database, '数据库')
    if (operation.action === 'mongo.createDatabase' || operation.action === 'mongo.dropDatabase') {
      requireWrite(context)
      validateDatabaseName('mongodb', database)
      const db = this.client.db(database)
      if (operation.action === 'mongo.createDatabase') {
        const initial = validateInitialCollection(operation.initialCollection)
        await db.createCollection(initial, { timeoutMS: TIMEOUT_MS })
        return emptyResult('数据库已创建')
      }
      await db.dropDatabase({ timeoutMS: TIMEOUT_MS })
      return emptyResult('数据库已删除')
    }
    const entity = resourceName(operation.entity, '集合')
    const collection = this.client.db(database).collection(entity)
    // Protocol metadata (especially error.code) must remain JavaScript numbers:
    // the driver uses their numeric identity for SDAM and retryable-read checks.
    // Decode only raw user documents with BSON wrappers below, not whole replies.
    const options = { maxTimeMS: TIMEOUT_MS, timeoutMS: TIMEOUT_MS, signal, promoteValues: true, promoteLongs: true }
    switch (operation.action) {
      case 'mongo.inspect': {
        const db = this.client.db(database)
        const inspection: ObjectInspection = { kind: 'collection', metrics: [] }
        let collectionInfo: Document | undefined
        try {
          const cursor = db.listCollections({ name: entity }, { ...options, nameOnly: false, batchSize: 1, raw: true })
          const data = await this.readCursor(cursor, 1, signal)
          if (data.documents?.[0]) collectionInfo = BSON.EJSON.parse(data.documents[0], { relaxed: false }) as Document
          if (collectionInfo?.type === 'view') inspection.kind = 'view'
        } catch { checkAborted(signal) }
        if (inspection.kind !== 'view') {
          try {
            const stats = await db.command({ collStats: entity, scale: 1 }, { signal, timeoutMS: TIMEOUT_MS, raw: false, promoteValues: true, promoteLongs: false })
            inspection.metrics = metrics(metric('文档数', stats.count), metric('已固定', stats.capped ?? (collectionInfo ? collectionInfo.options?.capped === true : undefined), 'boolean'), metric('数据大小', stats.size, 'bytes'), metric('对象的平均大小', stats.avgObjSize, 'bytes'), metric('存储大小', stats.storageSize, 'bytes'), metric('索引数', stats.nindexes), metric('索引的总大小', stats.totalIndexSize))
          } catch {
            checkAborted(signal)
            inspection.infoNote = '部分元数据不可用或无读取权限。'
            try { inspection.metrics.push(...metrics(metric('文档数', await collection.estimatedDocumentCount({ timeoutMS: TIMEOUT_MS })))) } catch { checkAborted(signal) }
          }
        }
        if (!collectionInfo) inspection.definitionNote = 'DDL 不可用或超出读取上限。'
        else {
          try {
            let indexes: Document[] = []
            let limited = false
            if (inspection.kind !== 'view') {
              const data = await this.readCursor(collection.listIndexes({ ...options, batchSize: 50, raw: true }), MAX_ROWS, signal)
              indexes = (data.documents || []).map(value => BSON.EJSON.parse(value, { relaxed: false }) as Document)
              limited = Boolean(data.truncated)
              if (!limited && !inspection.metrics.some(item => item.label === '索引数')) inspection.metrics.push(...metrics(metric('索引数', indexes.length)))
            }
            const generated = mongoDefinition(database, entity, collectionInfo, indexes)
            if (Buffer.byteLength(generated.definition, 'utf8') > MAX_BYTES) inspection.definitionNote = 'DDL 不可用或超出读取上限。'
            else {
              inspection.definition = generated.definition
              if (limited || generated.incomplete) inspection.definitionNote = '部分索引无法完整生成，请核对索引列表。'
            }
          } catch { checkAborted(signal); inspection.definitionNote = 'DDL 不可用或超出读取上限。' }
        }
        return { columns: [], rows: [], inspection }
      }
      case 'mongo.count': {
        const count = await collection.countDocuments(objectEjson(operation.filter, 'Filter'), { ...options, limit: 1000001 })
        return { columns: [], rows: [], totalRows: String(count), countLimited: count >= 1000001 }
      }
      case 'mongo.find': {
        const { limit, offset } = page(operation)
        const cursor = collection.find(objectEjson(operation.filter, 'Filter'), {
          ...options, projection: projectionEjson(operation.projection), sort: sortEjson(operation.sort),
          skip: offset, limit: limit + 1, batchSize: Math.min(limit + 1, 50), raw: true,
        })
        const result = await this.readCursor(cursor, limit, signal)
        if (result.truncated && result.documents?.length === limit) result.nextOffset = offset + limit
        return result
      }
      case 'mongo.aggregate': {
        const { limit } = page(operation)
        const pipeline = parsePipeline(operation.pipeline)
        const cursor = collection.aggregate([...pipeline, { $limit: limit + 1 }], {
          ...options, batchSize: Math.min(limit + 1, 50), allowDiskUse: false, raw: true,
        })
        return this.readCursor(cursor, limit, signal)
      }
      case 'mongo.insert': {
        requireWrite(context)
        if (!Array.isArray(operation.documents) || operation.documents.length < 1 || operation.documents.length > MAX_ROWS) throw new Error('LIMIT_EXCEEDED: 每次新增 1 至 500 份文档')
        const documents = operation.documents.map(text => documentEjson(text, '新增文档'))
        if (Buffer.byteLength(BSON.EJSON.stringify(documents, { relaxed: false })) > MAX_BYTES) throw new Error('LIMIT_EXCEEDED: 单批文档最多 2 MiB')
        try {
          const result = await collection.insertMany(documents, { ...options, ordered: true })
          return emptyResult(`已新增 ${result.insertedCount} 份文档`, result.insertedCount)
        } catch (error) {
          if (error instanceof MongoBulkWriteError && error.insertedCount > 0) {
            throw new Error(`PARTIAL_WRITE: 本批已有 ${error.insertedCount} 份文档写入，其余文档失败；请刷新检查，勿直接重试整批`)
          }
          throw error
        }
      }
      case 'mongo.replace': {
        requireWrite(context)
        const { original, replacement } = checkedReplacement(operation.original, operation.document)
        const result = await collection.replaceOne(optimisticFilter(original), replacement, { ...options, upsert: false })
        if (result.matchedCount !== 1) throw new Error('EDIT_CONFLICT: 文档已被修改、删除或原始文档不完整，请刷新后重试')
        return emptyResult(`已替换 ${result.modifiedCount} 份文档`, result.modifiedCount)
      }
      case 'mongo.delete': {
        requireWrite(context)
        const original = documentEjson(operation.original, '原始文档')
        const result = await collection.deleteOne(optimisticFilter(original), options)
        if (result.deletedCount !== 1) throw new Error('EDIT_CONFLICT: 文档已被修改或删除，请刷新后重试')
        return emptyResult('已删除 1 份文档', 1)
      }
      case 'mongo.indexes': {
        const cursor = collection.listIndexes({ ...options, batchSize: 50, raw: true })
        return this.readCursor(cursor, MAX_ROWS, signal)
      }
      case 'mongo.createIndex': {
        requireWrite(context)
        const keys = objectEjson(operation.keys, '索引字段')
        if (Object.keys(keys).length < 1 || Object.keys(keys).length > 32) throw new Error('INVALID_INDEX: 索引需要 1 至 32 个字段')
        const index: Record<string, IndexDirection> = Object.create(null) as Record<string, IndexDirection>
        for (const [name, direction] of Object.entries(keys)) {
          resourceName(name, '索引字段')
          const numeric = scalarNumber(direction)
          if (numeric === 1 || numeric === -1) index[name] = numeric
          else if (direction === 'text' || direction === 'hashed' || direction === '2d' || direction === '2dsphere') index[name] = direction
          else throw new Error('INVALID_INDEX: 索引方向必须是 1、-1、text、hashed、2d 或 2dsphere')
        }
        const rawOptions = objectEjson(operation.options, '索引选项')
        const indexOptions: CreateIndexesOptions = { ...options }
        for (const [key, value] of Object.entries(rawOptions)) {
          if (key === 'name') indexOptions.name = resourceName(value, '索引')
          else if (['unique', 'sparse', 'hidden'].includes(key)) {
            if (typeof value !== 'boolean') throw new Error('INVALID_INDEX: 索引布尔选项无效')
            Object.assign(indexOptions, { [key]: value })
          } else if (key === 'expireAfterSeconds') {
            const seconds = scalarNumber(value)
            if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 2147483647) throw new Error('INVALID_INDEX: TTL 秒数无效')
            indexOptions.expireAfterSeconds = seconds
          } else if (key === 'partialFilterExpression') indexOptions.partialFilterExpression = plainObject(value, '部分索引条件')
          else throw new Error('INVALID_INDEX: 不支持的索引选项')
        }
        const name = await collection.createIndex(index, indexOptions)
        return emptyResult(`索引已创建：${name}`, 1)
      }
      case 'mongo.dropIndex': {
        requireWrite(context)
        const name = resourceName(operation.name, '索引')
        if (name === '*' || name === '_id_') throw new Error('MONGO_POLICY: 不允许批量删除索引或删除 _id 索引')
        await collection.dropIndex(name, options)
        return emptyResult('索引已删除', 1)
      }
      default: throw new Error('INVALID_OPERATION: 不支持的 MongoDB 操作')
    }
  }

  private async readCursor(cursor: AbstractCursor<Document>, limit: number, signal: AbortSignal): Promise<OperationResult> {
    this.cursor = cursor
    const documents: string[] = []
    const rows: Record<string, string>[] = []
    const columns = new Set<string>()
    const bsonTypes: BsonTypeBranch[] = []
    const typeBudget = newTypeBudget()
    let bytes = 0
    let truncated = false
    try {
      for await (const rawDocument of cursor) {
        checkAborted(signal)
        if (documents.length >= limit) { truncated = true; break }
        if (rawDocument instanceof Uint8Array && rawDocument.byteLength > MAX_VALUE_BYTES) { truncated = true; break }
        const document: Document = rawDocument instanceof Uint8Array
          ? BSON.deserialize(rawDocument, { promoteValues: false, promoteLongs: false, bsonRegExp: true })
          : rawDocument
        const canonical = BSON.EJSON.stringify(document, { relaxed: false })
        const size = Buffer.byteLength(canonical, 'utf8')
        if (size > MAX_VALUE_BYTES || bytes + size > MAX_BYTES) { truncated = true; break }
        const row: Record<string, string> = Object.create(null) as Record<string, string>
        for (const [key, value] of Object.entries(document)) {
          // Keep a stable 100-column window. Fields already displayed in the
          // grid must not disappear merely because their order differs in a row.
          if (!columns.has(key) && columns.size >= 100) continue
          columns.add(key)
          row[key] = value && typeof value === 'object' ? displayCell(BSON.EJSON.serialize(value, { relaxed: false })) : displayCell(value)
        }
        documents.push(canonical)
        rows.push(row)
        bsonTypes.push(describeBsonDocument(document, Object.keys(row), typeBudget))
        bytes += size
      }
    } finally {
      await cursor.close()
      if (this.cursor === cursor) this.cursor = undefined
    }
    return {
      columns: [...columns], rows, documents, bsonTypes, truncated,
      message: truncated ? '已达到行数或 2 MiB 返回上限（单文档最大 512 KiB），请缩小筛选范围' : undefined,
    }
  }
}
