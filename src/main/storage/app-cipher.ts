import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Intentional built-in key for an offline, self-use application. It is public,
// not an OS keyring or a secret from anyone with the app/source. Never rotate
// this v2 constant without preserving a decoder for existing files.
const APP_KEY = createHash('sha256').update('DB EX | offline portable storage | v2 | 8d6917ef-dda1-491c-b65f-3f6803df92b8').digest()
const PREFIX = 'dbex:v2:'
type Purpose = 'local' | 'connections-export'
const aad = (purpose: Purpose): Buffer => Buffer.from('DB EX/v2/' + purpose, 'utf8')
export const isAppEncrypted = (value: string): boolean => value.startsWith(PREFIX)
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('invalid encoding')
  return bytes
}
export function seal(value: unknown, purpose: Purpose = 'local'): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', APP_KEY, iv)
  cipher.setAAD(aad(purpose))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return PREFIX + [iv, cipher.getAuthTag(), encrypted].map(bytes => bytes.toString('base64url')).join(':')
}
export function unseal<T>(value: string, purpose: Purpose = 'local'): T {
  try {
    if (typeof value !== 'string' || !isAppEncrypted(value)) throw new Error('unknown format')
    const parts = value.slice(PREFIX.length).split(':')
    if (parts.length !== 3) throw new Error('invalid envelope')
    const [iv, tag, encrypted] = parts.map(decode)
    if (iv!.length !== 12 || tag!.length !== 16) throw new Error('invalid nonce or tag')
    const decipher = createDecipheriv('aes-256-gcm', APP_KEY, iv!)
    decipher.setAAD(aad(purpose))
    decipher.setAuthTag(tag!)
    return JSON.parse(Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8')) as T
  } catch {
    throw new Error('DBEX_DECRYPT_ERROR: 加密配置损坏或版本不兼容')
  }
}
/** Only unversioned legacy data may request the old OS keyring. */
export function openStored<T>(value: string, readLegacy: (value: string) => T): T {
  return value.startsWith('dbex:') ? unseal<T>(value) : readLegacy(value)
}
