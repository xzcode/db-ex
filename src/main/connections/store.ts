import { randomUUID } from 'node:crypto'
import { connectionDisplayEndpoint } from '../../shared/connection-form'
import { applyAppearance } from '../../shared/connection-appearance'
import type { ConnectionConfig, ConnectionDraft, SavedConnection } from '../../shared/types'
import { validateConnection, validateId } from './validation'
import { mergeConnectionSecrets, redactConnection } from './credentials'
import { createConnectionBackup, readConnectionBackup } from './backup'
import { isAppEncrypted } from '../storage/app-cipher'
import { decrypt, encrypt, readJson, SerialWrites, writeJson } from '../storage/secure-json'

interface EncryptedEntry { id: string; name: string; kind: ConnectionConfig['kind']; encrypted: string }
interface StoreFile { version: 1; entries: EncryptedEntry[] }
export class ConnectionStore {
  private readonly entries = new Map<string, EncryptedEntry>()
  private readonly writes = new SerialWrites()
  private readonly legacyLocked = new Set<string>()
  async init(): Promise<void> {
    const content = await readJson<StoreFile>('connections.secure.json')
    if (!content) return
    if (content.version !== 1 || !Array.isArray(content.entries) || content.entries.length > 200) throw new Error('不兼容的连接配置格式')
    for (const entry of content.entries) {
      validateId(entry.id)
      if (typeof entry.encrypted !== 'string') throw new Error('连接配置损坏')
      this.entries.set(entry.id, entry)
    }
    // Migrate only old-format entries. Inaccessible old data remains intact
    // and does not prevent new connections or application startup.
    let migrated = false
    for (const entry of this.entries.values()) {
      if (isAppEncrypted(entry.encrypted)) continue
      try {
        const config = validateConnection(decrypt<ConnectionConfig>(entry.encrypted), true)
        this.entries.set(entry.id, { ...entry, encrypted: encrypt({ ...config, id: entry.id }) })
        migrated = true
      } catch { this.legacyLocked.add(entry.id) }
    }
    if (migrated) await this.persist()
  }
  list(): SavedConnection[] {
    return [...this.entries.values()].map(entry => this.legacyLocked.has(entry.id)
      ? { id: entry.id, name: entry.name, kind: entry.kind, environment: 'unknown', host: '旧版配置待迁移', port: 0, sshEnabled: false, tlsEnabled: false, locked: true }
      : this.summarize(entry.id, this.get(entry.id)))
  }
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
      ...connectionDisplayEndpoint(config), color: config.color, group: config.group, sshEnabled: config.ssh.enabled,
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
      this.legacyLocked.delete(id)
      return this.summarize(id, stored)
    })
  }
  updateAppearance(id: string, patch: unknown): Promise<SavedConnection> {
    return this.writes.run(async () => {
      const config = applyAppearance(this.get(id), patch)
      const old = this.entries.get(id)!
      // Write only the validated presentation metadata. All previously
      // stored credentials, endpoints, and host trust remain unchanged.
      const next = { ...old, encrypted: encrypt(config) }
      this.entries.set(id, next)
      try { await this.persist() } catch (error) { this.entries.set(id, old); throw error }
      return this.summarize(id, config)
    })
  }
  delete(id: string): Promise<void> {
    return this.writes.run(async () => {
      validateId(id)
      const old = this.entries.get(id)
      if (!old) return
      this.entries.delete(id)
      try { await this.persist() } catch (error) { this.entries.set(id, old); throw error }
      this.legacyLocked.delete(id)
    })
  }
  async trustHostKey(id: string, fingerprint: string): Promise<void> {
    if (!/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('SSH 主机指纹必须是64位 SHA-256 十六进制值')
    const config = this.get(id)
    if (!config.ssh.enabled) throw new Error('此连接未启用 SSH')
    config.ssh.hostFingerprint = fingerprint.toLowerCase()
    await this.save(config)
  }
  exportConnections(id?: string): unknown {
    const ids = id === undefined ? [...this.entries.keys()] : [id]
    return createConnectionBackup(ids.map(key => this.get(key)))
  }
  importConnections(input: unknown): Promise<number> {
    return this.writes.run(async () => {
      const configs = readConnectionBackup(input)
      if (this.entries.size + configs.length > 200) throw new Error('导入后连接数量不能超过200')
      // Validate/decrypt the complete file before changing any saved entries.
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
