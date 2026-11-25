import type { ExplorerNode } from './types'

export const mongoCategories = [
  { key: 'collections', label: '集合', icon: '▦', expandable: true },
  { key: 'views', label: '视图', icon: '◉', expandable: true },
  { key: 'functions', label: '函数', icon: 'ƒ', expandable: true },
  { key: 'indexes', label: '索引', icon: 'A–Z', expandable: true },
  { key: 'mapReduce', label: 'MapReduce', icon: '⤨', expandable: false },
  { key: 'pipelines', label: '聚合管道', icon: '≡', expandable: false },
  { key: 'gridfs', label: 'GridFS 存储桶', icon: '▣', expandable: true },
  { key: 'queries', label: '查询', icon: '▤', expandable: false },
] as const
export type MongoCategory = typeof mongoCategories[number]['key']
export function mongoCategory(value: unknown) { return mongoCategories.find(item => item.key === value) }
export function mongoCategoryNodes(database: string): ExplorerNode[] {
  return mongoCategories.map(item => ({ id: JSON.stringify(['mongo-category',database,item.key]), kind: 'mongo-category', database, label:item.label, category:item.key }))
}
export interface MongoCatalogEntry { name: string; type?: string }
export function mongoCatalogNodes(database: string, entries: readonly MongoCatalogEntry[], category: MongoCategory): ExplorerNode[] {
  const node = (kind: ExplorerNode['kind'], label: string, entity: string, readOnly = false): ExplorerNode =>
    ({ id: JSON.stringify([kind,database,entity]), label, database, entity, kind, readOnly })
  const physical = entries.filter(item => item.type === 'collection' || item.type === 'timeseries')
  const names = new Set(physical.map(item => item.name))
  let nodes: ExplorerNode[]
  switch (category) {
    case 'collections': nodes = physical.filter(item=>item.name!=='system.js').map(item=>node('collection',item.name,item.name)); break
    case 'views': nodes = entries.filter(item=>item.type==='view').map(item=>node('view',item.name,item.name,true)); break
    case 'functions': nodes = names.has('system.js') ? [node('mongo-function','system.js','system.js',true)] : []; break
    case 'indexes': nodes = physical.filter(item=>item.name!=='system.js').map(item=>node('mongo-indexes',item.name,item.name)); break
    case 'gridfs':
      // A bucket is identified by its conventional paired physical collections.
      // Do not treat a lone *.files collection as a verified bucket.
      nodes = physical.filter(item=>item.name.endsWith('.files')&&names.has(item.name.slice(0,-6)+'.chunks')).map(item=>node('gridfs-bucket',item.name.slice(0,-6),item.name,true))
      break
    default: nodes = []
  }
  return nodes.sort((a,b)=>a.label.localeCompare(b.label))
}
