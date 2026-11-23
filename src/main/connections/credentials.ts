import type { ConnectionConfig, ConnectionDraft } from '../../shared/types'

const SECRET_NAMES = new Set(['password', 'passphrase', 'uri', 'sentinelPassword'])
function walk(value: unknown, visit: (object: Record<string, unknown>, key: string, path: string) => void, prefix = ''): void {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (SECRET_NAMES.has(key)) visit(value as Record<string, unknown>, key, path)
    else if (item && typeof item === 'object') walk(item, visit, path)
  }
}
function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value)
}
function setField(value: unknown, path: string, content: unknown): void {
  const parts = path.split('.')
  const key = parts.pop()!
  const parent = parts.reduce<unknown>((current, name) => current && typeof current === 'object' ? (current as Record<string, unknown>)[name] : undefined, value)
  if (parent && typeof parent === 'object') (parent as Record<string, unknown>)[key] = content
}
export function redactConnection(config: ConnectionConfig): ConnectionDraft {
  const copy = structuredClone(config)
  const secretFields: string[] = []
  walk(copy, (o, key, path) => { if (typeof o[key] === 'string' && o[key] !== '') secretFields.push(path); delete o[key] })
  return { config: copy, secretFields }
}
/** An empty edit retains a stored secret. Clearing is explicit and path-allowlisted. */
export function mergeConnectionSecrets(incoming: ConnectionConfig, previous?: ConnectionConfig, clear: string[] = []): ConnectionConfig {
  if (!Array.isArray(clear) || clear.length > 30 || clear.some(x => typeof x !== 'string')) throw new Error('凭据清除字段格式错误')
  const allowed = new Set(['password', 'uri', 'sentinelPassword', 'ssh.password', 'ssh.passphrase', 'proxy.password', ...Array.from({ length: 3 }, (_, i) => [`ssh.jumps.${i}.password`, `ssh.jumps.${i}.passphrase`]).flat()])
  if (clear.some(x => !allowed.has(x))) throw new Error('不支持清除此凭据字段')
  const copy = structuredClone(incoming)
  if (!previous || previous.kind !== copy.kind) return copy
  walk(previous, (_o, _key, path) => {
    if (clear.includes(path)) { setField(copy, path, undefined); return }
    const current = field(copy, path)
    // Secrets are never inherited into a different endpoint or jump host.
    const ownerPath = path.split('.').slice(0, -1).join('.')
    if (ownerPath && ownerPath !== 'proxy') {
      const oldOwner = field(previous, ownerPath) as Record<string, unknown> | undefined
      const newOwner = field(copy, ownerPath) as Record<string, unknown> | undefined
      if (!newOwner || !oldOwner || newOwner.host !== oldOwner.host || newOwner.username !== oldOwner.username || newOwner.port !== oldOwner.port) return
    }
    if (ownerPath === 'proxy' && (copy.proxy?.host !== previous.proxy?.host || copy.proxy?.port !== previous.proxy?.port || copy.proxy?.username !== previous.proxy?.username)) return
    const endpointsChanged = copy.host !== previous.host || copy.port !== previous.port || JSON.stringify(copy.nodes || []) !== JSON.stringify(previous.nodes || [])
    if (path === 'password' && (endpointsChanged || copy.username !== previous.username || copy.authSource !== previous.authSource || copy.redisMode !== previous.redisMode)) return
    if (path === 'sentinelPassword' && (endpointsChanged || copy.sentinelUsername !== previous.sentinelUsername || copy.sentinelMaster !== previous.sentinelMaster)) return
    if (path === 'uri' && (endpointsChanged || copy.username !== previous.username || copy.database !== previous.database || copy.mongoReplicaSet !== previous.mongoReplicaSet || copy.mongoDirect !== previous.mongoDirect)) return
    if (current === undefined || current === '') setField(copy, path, field(previous, path))
  })
  for (const path of clear) setField(copy, path, undefined)
  return copy
}
export function secretValues(config: ConnectionConfig): string[] {
  const values: string[] = []
  walk(config, (o, key) => { if (typeof o[key] === 'string' && o[key]) values.push(o[key] as string) })
  return values
}
