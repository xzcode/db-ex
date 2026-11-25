import { BSON, type Document } from 'mongodb'
import { describeBsonDocument } from './bson-metadata'
import { formatMongoDocument } from '../../shared/bson-editor'

function expression(value: Document): string {
  const canonical = BSON.EJSON.stringify(value, { relaxed: false })
  const formatted = formatMongoDocument(canonical, describeBsonDocument(value, Object.keys(value)))
  return formatted.syntax === 'typed' ? formatted.text : 'EJSON.deserialize(' + JSON.stringify(JSON.parse(canonical), null, 2) + ', { relaxed: false })'
}
const serverIndexKeys = new Set(['v','key','name','ns','background','buildUUID','ready','head'])
const supportedOptions = new Set(['name','unique','sparse','hidden','expireAfterSeconds','partialFilterExpression','collation','wildcardProjection','storageEngine','weights','default_language','language_override','textIndexVersion','2dsphereIndexVersion','bits','min','max','bucketSize'])
/** Produce text only; no DDL is executed. Omit unrepresentable indexes explicitly. */
export function mongoDefinition(database: string, name: string, collection: Document, indexes: Document[]): { definition: string; incomplete: boolean } {
  let incomplete = false
  const db = 'db.getSiblingDB(' + JSON.stringify(database) + ')'
  const target = db + '.getCollection(' + JSON.stringify(name) + ')'
  const options = collection.options && typeof collection.options === 'object' ? collection.options as Document : {}
  const statements: string[] = [db + '.createCollection(' + JSON.stringify(name) + (Object.keys(options).length ? ', ' + expression(options) : '') + ');']
  for (const index of indexes) {
    if (index.name === '_id_') continue
    if (!index.key || typeof index.key !== 'object' || Object.hasOwn(index.key, '_fts') || Object.keys(index).some(key => !serverIndexKeys.has(key) && !supportedOptions.has(key))) { incomplete = true; continue }
    const opts = Object.fromEntries(Object.entries(index).filter(([key]) => supportedOptions.has(key)))
    statements.push(target + '.createIndex(' + expression(index.key) + (Object.keys(opts).length ? ', ' + expression(opts) : '') + ');')
  }
  const definition = statements.join('\n\n')
  return { definition, incomplete }
}
