import { randomUUID } from 'node:crypto'
import type { QuerySnippet } from '../../shared/types'
import { decrypt, encrypt, readJson, SerialWrites, writeJson } from './secure-json'
import { validateId } from '../connections/validation'
import { isAppEncrypted } from './app-cipher'
export class SnippetStore {
  private readonly writes = new SerialWrites()
  list(): Promise<QuerySnippet[]> { return this.writes.run(() => this.read()) }
  private async read(): Promise<QuerySnippet[]> {
    const file = await readJson<{ version: number; encrypted: string }>('queries.secure.json')
    if (!file) return []
    if (file.version !== 1 || typeof file.encrypted !== 'string') throw new Error('查询记录格式不兼容')
    const values = decrypt<QuerySnippet[]>(file.encrypted)
    if (!Array.isArray(values) || values.length > 300) throw new Error('查询记录格式错误')
    if (!isAppEncrypted(file.encrypted)) await writeJson('queries.secure.json', { version: 1, encrypted: encrypt(values) })
    return values
  }
  save(input: Omit<QuerySnippet, 'id' | 'updatedAt'> & { id?: string }): Promise<QuerySnippet> {
    return this.writes.run(async () => {
      if (!input || typeof input.name !== 'string' || input.name.length > 100 || typeof input.text !== 'string' || input.text.length > 100000 || !['mysql', 'mongodb', 'redis'].includes(input.kind) || typeof input.favorite !== 'boolean') throw new Error('查询记录参数错误')
      if (input.database !== undefined && (typeof input.database !== 'string' || input.database.length > 200)) throw new Error('数据库名称无效')
      if (input.id) validateId(input.id)
      const entry: QuerySnippet = { id: input.id || randomUUID(), name: input.name, kind: input.kind, database: input.database, text: input.text, favorite: input.favorite, updatedAt: new Date().toISOString() }
      const old = await this.read()
      const result = [entry, ...old.filter(x => x.id !== entry.id)]
      const favorites = result.filter(x => x.favorite)
      if (favorites.length > 100) throw new Error('最多收藏100条查询')
      const entries = [...favorites, ...result.filter(x => !x.favorite).slice(0, 200)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      await writeJson('queries.secure.json', { version: 1, encrypted: encrypt(entries) })
      return entry
    })
  }
  delete(id: string): Promise<void> {
    return this.writes.run(async () => { validateId(id); const entries = (await this.read()).filter(x => x.id !== id); await writeJson('queries.secure.json', { version: 1, encrypted: encrypt(entries) }) })
  }
}
