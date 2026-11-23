import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ConnectionDraft, SavedConnection } from '../../shared/types'
import { validateConnection, validateId } from './validation'
import { mergeConnectionSecrets, redactConnection } from './credentials'
import { decrypt, encrypt, readJson, SerialWrites, writeJson } from '../storage/secure-json'

interface EncryptedEntry { id: string; name: string; kind: ConnectionConfig['kind']; encrypted: string }
interface StoreFile { version: 1; entries: EncryptedEntry[] }
export class ConnectionStore {
  private readonly entries = new Map<string, EncryptedEntry>()
  private readonly writes = new SerialWrites()
  async init(): Promise<void> {
    const content = await readJson<StoreFile>('connections.secure.json')
    if (!content) return
    if (content.version !== 1 || !Array.isArray(content.entries) || content.entries.length > 200) throw new Error('不兼容的连接配置格式')
    for (const entry of content.entries) {
      validateId(entry.id)
      if (typeof entry.encrypted !== 'string') throw new Error('连接配置损坏')
      this.entries.set(entry.id, entry)
    }
  }
  list(): SavedConnection[] { return [...this.entries.values()].map(entry => this.summarize(entry.id, this.get(entry.id))) }
  get(id: string): ConnectionConfig {
    validateId(id)
    const entry = this.entries.get(id)
    if (!entry) throw new Error('连接配置不存在')
    return validateConnection(decrypt<ConnectionConfig>(entry.encrypted), true)
  }
  edit(id: string): ConnectionDraft { return redactConnection(this.get(id)) }
  resolve(incoming: ConnectionConfig, clear: string[] = []): ConnectionConfig {
    const previous = incoming.id ? this.get(incoming.id) : undefined
    return validateConnection(mergeConnectionSecrets(incoming, previous, clear), true)
  }
  summarize(id: string, config: ConnectionConfig): SavedConnection {
    return { id, name: config.name, kind: config.kind, environment: config.environment,
      host: config.host || 'MongoDB URI', port: config.port, sshEnabled: config.ssh.enabled,
      tlsEnabled: config.tls.enabled, proxyEnabled: Boolean(config.proxy?.enabled) }
  }
  private async persist(): Promise<void> { await writeJson('connections.secure.json', { version: 1, entries: [...this.entries.values()] }) }
  save(incoming: ConnectionConfig, clear: string[] = []): Promise<SavedConnection> {
    return this.writes.run(async () => {
      const config = this.resolve(incoming, clear)
      const id = config.id || randomUUID()
      if (!this.entries.has(id) && this.entries.size >= 200) throw new Error('连接数量上限为200')
      const stored = { ...config, id }
      const encrypted = encrypt(stored)
      const previous = this.entries.get(id)
      this.entries.set(id, { id, name: config.name, kind: config.kind, encrypted })
      try { await this.persist() } catch (error) { if (previous) this.entries.set(id, previous); else this.entries.delete(id); throw error }
      return this.summarize(id, stored)
    })
  }
  delete(id: string): Promise<void> {
    return this.writes.run(async () => {
      validateId(id)
      const old = this.entries.get(id)
      if (!old) return
      this.entries.delete(id)
      try { await this.persist() } catch (error) { this.entries.set(id, old); throw error }
    })
  }
  async trustHostKey(id: string, fingerprint: string): Promise<void> {
    if (!/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('SSH 主机指纹必须是64位 SHA-256 十六进制值')
    const config = this.get(id)
    if (!config.ssh.enabled) throw new Error('此连接未启用 SSH')
    config.ssh.hostFingerprint = fingerprint.toLowerCase()
    await this.save(config)
  }
  exportPublic(): unknown {
    return { format: 'db-ex-connections', version: 1, exportedAt: new Date().toISOString(),
      connections: [...this.entries.keys()].map(id => { const result = this.edit(id); delete result.config.id; return result }) }
  }
  importPublic(input: unknown): Promise<number> {
    return this.writes.run(async () => {
      const value = input as { format?: unknown; version?: unknown; connections?: unknown[] }
      if (!value || value.format !== 'db-ex-connections' || value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 200) throw new Error('连接导入文件格式不正确')
      if (this.entries.size + value.connections.length > 200) throw new Error('导入后连接数量不能超过200')
      // Redacted templates preserve authentication mode; connection validation requires missing secrets again.
      const configs = value.connections.map(item => {
        const draft = item as ConnectionDraft
        if (!draft || !draft.config || !Array.isArray(draft.secretFields)) throw new Error('连接条目格式不正确')
        const copy = redactConnection(draft.config).config
        delete copy.id
        if (!copy.host && !copy.uri) { copy.host = 'localhost'; copy.name += ' (需配置 URI)' }
        return validateConnection(copy, true)
      })
      const prepared = configs.map(config => {
        const id = randomUUID()
        return { id, name: config.name, kind: config.kind, encrypted: encrypt({ ...config, id }) }
      })
      const added = prepared.map(entry => entry.id)
      for (const entry of prepared) this.entries.set(entry.id, entry)
      try { await this.persist() } catch (error) { for (const id of added) this.entries.delete(id); throw error }
      return added.length
    })
  }
}
