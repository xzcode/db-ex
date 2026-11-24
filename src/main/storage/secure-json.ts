import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openStored, seal } from './app-cipher'

// New writes and reads never call Electron safeStorage. It remains solely
// for a one-time upgrade of entries written by DB EX <= 0.5.1.
export function encrypt(value: unknown): string { return seal(value) }
export function decrypt<T>(value: string): T {
  return openStored<T>(value, legacy => {
    try {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('legacy unavailable')
      return JSON.parse(safeStorage.decryptString(Buffer.from(legacy, 'base64'))) as T
    } catch {
      throw new Error('LEGACY_STORAGE_UNAVAILABLE: 旧版连接或查询记录需要原系统授权才能迁移。原文件已保留；新建连接不需要系统密钥。')
    }
  })
}
export async function readJson<T>(name: string): Promise<T | undefined> {
  const filename = join(app.getPath('userData'), name)
  try {
    if ((await stat(filename)).size > 16 * 1024 * 1024) throw new Error('本地配置文件超出大小限制')
    return JSON.parse(await readFile(filename, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // JSON parse messages can contain the file contents; don't expose them.
    if (error instanceof SyntaxError) throw new Error('本地配置损坏：JSON 格式无效')
    throw error
  }
}
export async function writeJson(name: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('本地配置已达到16 MiB上限，请清理历史或旧连接后重试')
  const filename = join(app.getPath('userData'), name)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' })
    await rename(temporary, filename)
  } finally { await unlink(temporary).catch(() => {}) }
}
export class SerialWrites {
  private pending: Promise<unknown> = Promise.resolve()
  run<T>(action: () => Promise<T>): Promise<T> {
    const current = this.pending.then(action, action)
    this.pending = current.catch(() => {})
    return current
  }
}
