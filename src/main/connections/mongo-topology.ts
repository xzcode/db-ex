import type { ConnectionConfig } from '../../shared/types'

/** The old mongoDirect flag remains readable, but new profiles use an explicit mode. */
export type MongoTopologyMode = 'auto' | 'direct' | 'discover'

export function mongoTopologyMode(config: ConnectionConfig): MongoTopologyMode {
  return config.mongoTopology || (config.mongoDirect ? 'direct' : 'auto')
}

/**
 * Navicat-style single-endpoint connections should connect to precisely the
 * designated host, even when the server advertises private replica addresses.
 * Explicit replica-set names, several seed hosts, and full URIs keep the
 * driver's normal discovery behavior unless the user selects another mode.
 *
 * No retry or fallback occurs after a failed connection: a requested replica
 * set is never silently converted into a direct connection.
 */
export function mongoDirectConnection(config: ConnectionConfig): boolean | undefined {
  const mode = mongoTopologyMode(config)
  if (mode === 'direct') return true
  if (mode === 'discover') return false
  if (config.uri?.trim()) return undefined
  if (config.mongoReplicaSet) return undefined
  const count = config.nodes?.length || 1
  return count === 1 ? true : undefined
}

/** SRV connections enable TLS unless explicitly disabled in the URI. */
export function mongoUriTlsEnabled(uri?: string): boolean {
  if (!uri?.trim()) return false
  const question = uri.indexOf('?')
  const params = new URLSearchParams(question < 0 ? '' : uri.slice(question + 1))
  const enabled = params.get('tls') ?? params.get('ssl')
  if (enabled !== null) return enabled.toLowerCase() === 'true'
  return /^mongodb\+srv:\/\//i.test(uri)
}
