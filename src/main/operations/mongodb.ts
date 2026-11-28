import { BSON, MongoBulkWriteError, type AbstractCursor, type CreateIndexesOptions, type Document, type FindOptions, type UpdateFilter, type IndexDirection, type MongoClient, type Sort } from 'mongodb'
import type { MongoOperation, OperationResult,MongoFindSettings } from '../../shared/types'
import type { BsonTypeBranch } from '../../shared/bson-types'
import { describeBsonDocument, newTypeBudget } from './bson-metadata'
import { metric, metrics, type ObjectInspection } from '../../shared/object-inspection'
import { validateDatabaseName, validateInitialCollection,validateManagedCollection } from '../../shared/database-admin'
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

export function mongoFindSettings(value:MongoFindSettings|undefined):FindOptions{
 if(value===undefined)return {}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['hint','collation','batchSize','maxTimeMS'].includes(k)))throw new Error('MONGO_POLICY: 不支持的查询选项')
 const out:FindOptions={}
 if(value.hint!==undefined){
  const hint=parseEjson(value.hint,'Hint')
  if(typeof hint==='string')out.hint=resourceName(hint,'索引名称')
  else{
   const pattern=plainObject(hint,'Hint')
   validateReadDocument(pattern)
   if(!Object.keys(pattern).length||Object.keys(pattern).length>32)throw new Error('MONGO_POLICY: 不支持的查询选项')
   out.hint=Object.fromEntries(Object.entries(pattern).map(([k,v])=>{const n=scalarNumber(v);if(n!==1&&n!==-1)throw new Error('MONGO_POLICY: 不支持的查询选项');return [resourceName(k,'索引字段'),n]}))
  }
 }
 if(value.collation!==undefined){
  const c=objectEjson(value.collation,'Collation')
  const allowed=['locale','strength','caseLevel','caseFirst','numericOrdering','alternate','maxVariable','backwards','normalization']
  if(typeof c.locale!=='string'||!c.locale||c.locale.length>80||Object.keys(c).some(k=>!allowed.includes(k)))throw new Error('MONGO_POLICY: 不支持的查询选项')
  const normalized:Record<string,unknown>={}
  for(const [k,v] of Object.entries(c)){
   if(k==='strength'){const n=scalarNumber(v);if(!Number.isInteger(n)||n!<1||n!>5)throw new Error('MONGO_POLICY: 不支持的查询选项');normalized[k]=n}
   else if(['caseLevel','numericOrdering','backwards','normalization'].includes(k)){if(typeof v!=='boolean')throw new Error('MONGO_POLICY: 不支持的查询选项');normalized[k]=v}
   else {if(typeof v!=='string'||v.length>80)throw new Error('MONGO_POLICY: 不支持的查询选项');normalized[k]=v}
  }
  out.collation=normalized as unknown as NonNullable<FindOptions['collation']>
 }
 for(const key of ['batchSize','maxTimeMS'] as const){
  if(value[key]===undefined)continue
  if(!Number.isSafeInteger(value[key])||value[key]!<1||value[key]!>(key==='batchSize'?500:TIMEOUT_MS))throw new Error('MONGO_POLICY: 不支持的查询选项')
  out[key]=value[key]
 }
 return out
}
const scriptUpdates=new Set(['$set','$unset','$inc','$mul','$min','$max','$rename','$setOnInsert','$push','$addToSet','$pull','$pullAll','$pop','$currentDate','$bit'])
export function validateMongoScriptWrite(operation:Extract<MongoOperation,{action:'mongo.scriptWrite'}>){
 const methods=['updateOne','updateMany','replaceOne','deleteOne','deleteMany','findOneAndUpdate','findOneAndReplace','findOneAndDelete']
 if(!methods.includes(operation.method))throw new Error('MONGO_POLICY: 不支持的查询写入方法')
 const filter=objectEjson(operation.filter,'Filter')
 if(!Object.keys(filter).length)throw new Error('MONGO_POLICY: 查询写入需要非空筛选条件')
 const deleting=['deleteOne','deleteMany','findOneAndDelete'].includes(operation.method),replacing=['replaceOne','findOneAndReplace'].includes(operation.method),find=operation.method.startsWith('findOneAnd')
 const input=objectEjson(operation.options,'Options')
 const allowed=deleting?(find?['sort']:[]):find?['upsert','returnDocument','sort']:['upsert']
 if(Object.keys(input).some(k=>!allowed.includes(k))||input.upsert!==undefined&&typeof input.upsert!=='boolean'||input.returnDocument!==undefined&&!['before','after'].includes(input.returnDocument))throw new Error('MONGO_POLICY: 不支持的查询写入选项')
 const opts={...(input.upsert!==undefined?{upsert:input.upsert as boolean}:{}),...(input.returnDocument!==undefined?{returnDocument:input.returnDocument as 'before'|'after'}:{}),...(input.sort!==undefined?{sort:sortEjson(BSON.EJSON.stringify(input.sort,{relaxed:false}))}:{})}
 let value:Document|undefined
 if(deleting){if(operation.value!==undefined)throw new Error('MONGO_POLICY: 不支持的查询写入选项')}
 else if(replacing){value=documentEjson(operation.value!,'替换文档');validateReadDocument(value);if(Object.keys(value).some(k=>k.startsWith('$')))throw new Error('MONGO_POLICY: 不支持的查询写入选项')}
 else{
  value=objectEjson(operation.value,'Update')
  if(!Object.keys(value).length||Object.keys(value).some(k=>!scriptUpdates.has(k)))throw new Error('MONGO_POLICY: 更新仅支持明确列出的更新运算符')
  for(const op of Object.values(value))plainObject(op,'Update')
 }
 return {filter,value,opts}
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
    if(operation.action==='mongo.createCollection'||operation.action==='mongo.renameCollection'||operation.action==='mongo.dropCollection'||operation.action==='mongo.clearCollection'){
      requireWrite(context)
      validateDatabaseName('mongodb',database)
      const entity=validateManagedCollection(operation.entity),db=this.client.db(database)
      const current=(await db.listCollections({name:entity},{nameOnly:false,batchSize:1,timeoutMS:TIMEOUT_MS,signal}).toArray())[0]
      checkAborted(signal)
      if(operation.action==='mongo.createCollection'){
        if(current)throw new Error('INVALID_INPUT: 集合名称已存在')
        await db.createCollection(entity,{timeoutMS:TIMEOUT_MS})
        return emptyResult('集合已创建')
      }
      if(!current||current.type!=='collection'||current.options?.capped===true||current.options?.timeseries||current.options?.clusteredIndex)throw new Error('INVALID_DATABASE: 不支持此集合的通用维护')
      const collection=db.collection(entity)
      if(operation.action==='mongo.renameCollection'){
        const next=validateManagedCollection(operation.newName)
        if(next===entity||(await db.listCollections({name:next},{nameOnly:true,timeoutMS:TIMEOUT_MS,signal}).toArray()).length)throw new Error('INVALID_INPUT: 集合名称已存在')
        checkAborted(signal)
        await collection.rename(next,{dropTarget:false,timeoutMS:TIMEOUT_MS})
        return emptyResult('集合已重命名')
      }
      if(operation.action==='mongo.dropCollection'){
        await collection.drop({timeoutMS:TIMEOUT_MS})
        return emptyResult('集合已删除')
      }
      const result=await collection.deleteMany({}, {timeoutMS:TIMEOUT_MS})
      if(!result.acknowledged)throw new Error('DATABASE_ERROR: MongoDB')
      return emptyResult('集合已清空',result.deletedCount)
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
      case 'mongo.estimateCount': {
        const count=await collection.estimatedDocumentCount(options)
        return {columns:['count'],rows:[{count:String(count)}],totalRows:String(count),queryReadOnly:true}
      }
      case 'mongo.count': {
        const count = await collection.countDocuments(objectEjson(operation.filter, 'Filter'), { ...options, limit: 1000001 })
        return { columns: [], rows: [], totalRows: String(count), countLimited: count >= 1000001,queryReadOnly:true }
      }
      case 'mongo.find': {
        const { limit, offset } = page(operation)
        const settings=mongoFindSettings(operation.settings)
        const cursor = collection.find(objectEjson(operation.filter, 'Filter'), {
          ...options, ...settings, projection: projectionEjson(operation.projection), sort: sortEjson(operation.sort),
          skip: offset, limit: limit + 1, batchSize: Math.min(limit + 1, settings.batchSize||50), raw: true,
        })
        const result = await this.readCursor(cursor, limit, signal)
        if (result.truncated && result.documents?.length && result.truncationReason!=='document') result.nextOffset = offset + result.documents.length
        return {...result,queryReadOnly:true}
      }
      case 'mongo.aggregate': {
        const { limit } = page(operation)
        const pipeline = parsePipeline(operation.pipeline)
        const cursor = collection.aggregate([...pipeline, { $limit: limit + 1 }], {
          ...options, batchSize: Math.min(limit + 1, 50), allowDiskUse: false, raw: true,
        })
        return {...await this.readCursor(cursor, limit, signal),queryReadOnly:true}
      }
      case 'mongo.scriptWrite': {
        requireWrite(context)
        validateDatabaseName('mongodb',database)
        validateManagedCollection(entity)
        const {filter,value,opts}=validateMongoScriptWrite(operation)
        const method=operation.method
        if(method==='deleteOne'||method==='deleteMany'){const r=method==='deleteOne'?await collection.deleteOne(filter,options):await collection.deleteMany(filter,options);return emptyResult('操作已完成',r.deletedCount)}
        if(method==='updateOne'||method==='updateMany'){const r=method==='updateOne'?await collection.updateOne(filter,value as UpdateFilter<Document>,{...options,...opts}):await collection.updateMany(filter,value as UpdateFilter<Document>,{...options,...opts});return emptyResult('操作已完成',r.modifiedCount+r.upsertedCount)}
        if(method==='replaceOne'){const r=await collection.replaceOne(filter,value!,{...options,...opts});return emptyResult('操作已完成',r.modifiedCount+r.upsertedCount)}
        // Find-and-write results are never editable snapshots. Use raw BSON
        // output so Int64, Decimal128 and all other native types retain their identity.
        const findOpts={...options,...opts,raw:true as const,includeResultMetadata:false as const}
        const doc=method==='findOneAndDelete'?await collection.findOneAndDelete(filter,findOpts):method==='findOneAndUpdate'?await collection.findOneAndUpdate(filter,value as UpdateFilter<Document>,findOpts):await collection.findOneAndReplace(filter,value!,findOpts)
        if(!doc)return emptyResult('操作已完成')
        return this.singleDocument(doc)
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
      case 'mongo.replaceBatch': {
        requireWrite(context)
        if(!Array.isArray(operation.edits)||!operation.edits.length||operation.edits.length>MAX_ROWS||Buffer.byteLength(JSON.stringify(operation.edits))>MAX_BYTES)throw new Error('LIMIT_EXCEEDED: 单批编辑最多 500 行和 2 MiB')
        const identities=new Set<string>()
        const edits=operation.edits.map(item=>{
          const pair=checkedReplacement(item.original,item.document),identity=BSON.EJSON.stringify(pair.original._id,{relaxed:false})
          if(identities.has(identity))throw new Error('INVALID_INPUT: 重复记录')
          identities.add(identity)
          BSON.serialize(pair.replacement)
          return pair
        })
        let completed=0
        for(const {original,replacement} of edits){
          checkAborted(signal)
          try{
            const result=await collection.replaceOne(optimisticFilter(original),replacement,{...options,upsert:false})
            if(result.matchedCount!==1)throw new Error('EDIT_CONFLICT: 文档已被修改、删除或原始文档不完整，请刷新后重试')
            completed++
          }catch(error){
            const failure=databaseError(error)
            return {...emptyResult('批量编辑未全部完成',completed),gridBatch:{total:edits.length,completed,atomic:false,failed:true,uncertain:!failure.message.startsWith('EDIT_CONFLICT:'),error:failure.message}}
          }
        }
        return {...emptyResult('操作已完成',completed),gridBatch:{total:edits.length,completed,atomic:false}}
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
        return {...await this.readCursor(cursor, MAX_ROWS, signal),queryReadOnly:true}
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

  private singleDocument(raw:Document|Uint8Array):OperationResult{
    if(raw instanceof Uint8Array&&raw.byteLength>MAX_VALUE_BYTES)return {...emptyResult('操作已完成'),truncated:true,truncationReason:'document'}
    // Require raw data for a typed BSON result. Do not reconstruct a
    // potentially promoted numeric document returned by an older driver.
    if(!(raw instanceof Uint8Array))return emptyResult('操作已完成；返回文档无法无损显示，请重新查询')
    const doc=BSON.deserialize(raw,{promoteValues:false,promoteLongs:false,bsonRegExp:true})
    const canonical=BSON.EJSON.stringify(doc,{relaxed:false})
    if(Buffer.byteLength(canonical)>MAX_VALUE_BYTES)return {...emptyResult('操作已完成'),truncated:true,truncationReason:'document'}
    const columns=Object.keys(doc).slice(0,100)
    const row=Object.fromEntries(columns.map(k=>[k,displayCell(doc[k]&&typeof doc[k]==='object'?BSON.EJSON.serialize(doc[k],{relaxed:false}):doc[k])]))
    return {columns,rows:[row],documents:[canonical],bsonTypes:[describeBsonDocument(doc,columns,newTypeBudget())],message:'操作已完成'}
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
    let truncationReason:OperationResult['truncationReason']
    try {
      for await (const rawDocument of cursor) {
        checkAborted(signal)
        if (documents.length >= limit) { truncated = true; truncationReason='page'; break }
        if (rawDocument instanceof Uint8Array && rawDocument.byteLength > MAX_VALUE_BYTES) { truncated = true; truncationReason='document'; break }
        const document: Document = rawDocument instanceof Uint8Array
          ? BSON.deserialize(rawDocument, { promoteValues: false, promoteLongs: false, bsonRegExp: true })
          : rawDocument
        const canonical = BSON.EJSON.stringify(document, { relaxed: false })
        const size = Buffer.byteLength(canonical, 'utf8')
        if (size > MAX_VALUE_BYTES || bytes + size > MAX_BYTES) { truncated = true; truncationReason=size>MAX_VALUE_BYTES?'document':'bytes'; break }
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
      ...(truncationReason?{truncationReason}:{}),
      message: truncated && truncationReason!=='page' ? '已达到行数或 2 MiB 返回上限（单文档最大 512 KiB），请缩小筛选范围' : undefined,
    }
  }
}
