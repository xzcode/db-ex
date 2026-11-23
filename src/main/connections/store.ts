import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConnectionConfig, SavedConnection } from '../../shared/types'
import { validateConnection, validateId } from './validation'

interface EncryptedEntry {
  id: string
  name: string
  kind: ConnectionConfig['kind']
  encrypted: string
}
interface StoreFile { version: 1; entries: EncryptedEntry[] }

export class ConnectionStore {
  private get filename(): string { return join(app.getPath('userData'), 'connections.secure.json') }
  private readonly entries = new Map<string, EncryptedEntry>()

  async init(): Promise<void> {
    try {
      const content = JSON.parse(await readFile(this.filename, 'utf8')) as StoreFile
      if (content.version !== 1 || !Array.isArray(content.entries)) throw new Error('不兼容的连接配置格式')
      for (const entry of content.entries) this.entries.set(entry.id, entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private encryptionAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    // Electron Linux can report basic_text, which is not secure encryption.
    const backend = (safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    return backend !== 'basic_text'
  }

  private decrypt(entry: EncryptedEntry): ConnectionConfig {
    if (!this.encryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE: 系统安全存储不可用，无法读取已保存的连接')
    return validateConnection(JSON.parse(safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'))))
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filename)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    const data: StoreFile = { version: 1, entries: [...this.entries.values()] }
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filename)
    } catch (error) {
      const { unlink } = await import('node:fs/promises')
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  list(): SavedConnection[] {
    return [...this.entries.values()].map(entry => {
      const config = this.decrypt(entry)
      return this.summarize(entry.id, config)
    })
  }

  get(id: string): ConnectionConfig {
    validateId(id)
    const entry = this.entries.get(id)
    if (!entry) throw new Error('连接配置不存在')
    return this.decrypt(entry)
  }

  summarize(id: string, config: ConnectionConfig): SavedConnection {
    return {
      id, name: config.name, kind: config.kind, environment: config.environment,
      host: config.host || 'MongoDB URI', port: config.port,
      sshEnabled: config.ssh.enabled, tlsEnabled: config.tls.enabled,
    }
  }

  async save(value: ConnectionConfig): Promise<SavedConnection> {
    const config = validateConnection(value)
    if (!this.encryptionAvailable()) {
      throw new Error('SECURE_STORAGE_UNAVAILABLE: 无可用系统密钥环；可以临时连接，但不能保存连接信息')
    }
    const id = config.id || randomUUID()
    const stored: ConnectionConfig = { ...config, id }
    const encrypted = safeStorage.encryptString(JSON.stringify(stored)).toString('base64')
    const previous = this.entries.get(id)
    this.entries.set(id, { id, name: config.name, kind: config.kind, encrypted })
    try {
      await this.persist()
    } catch (error) {
      if (previous) this.entries.set(id, previous)
      else this.entries.delete(id)
      throw error
    }
    return this.summarize(id, stored)
  }

  async delete(id: string): Promise<void> {
    validateId(id)
    const old = this.entries.get(id)
    if (!old) return
    this.entries.delete(id)
    try { await this.persist() } catch (error) { this.entries.set(id, old); throw error }
  }

  async trustHostKey(id: string, fingerprint: string): Promise<void> {
    if (!/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('SSH 主机指纹必须是 64 位 SHA-256 十六进制值')
    const config = this.get(id)
    if (!config.ssh.enabled) throw new Error('此连接未启用 SSH')
    config.ssh.hostFingerprint = fingerprint.toLowerCase()
    await this.save(config)
  }
}
