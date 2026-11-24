import type { ConnectionConfig, ConnectionDraft } from '../../shared/types'
import { portableConnection, portableConnectionWithSecrets } from './credentials'
import { validateConnection } from './validation'
import { seal, unseal } from '../storage/app-cipher'

const MAX_CONNECTIONS = 200
const FORMAT = 'db-ex-connections'
interface BackupV2 { format: typeof FORMAT; version: 2; exportedAt: string; encrypted: string }
function assertCount(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) throw new Error('连接导入文件格式不正确或超过200条')
}
export function createConnectionBackup(configs: ConnectionConfig[]): BackupV2 {
  assertCount(configs)
  const portable = configs.map(config => portableConnectionWithSecrets(validateConnection(config, true)))
  return { format: FORMAT, version: 2, exportedAt: new Date().toISOString(), encrypted: seal(portable, 'connections-export') }
}
export function readConnectionBackup(input: unknown): ConnectionConfig[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('连接导入文件格式不正确')
  const value = input as { format?: unknown; version?: unknown; encrypted?: unknown; connections?: unknown }
  if (value.format !== FORMAT) throw new Error('连接导入文件格式不正确')
  if (value.version === 2) {
    if (typeof value.encrypted !== 'string') throw new Error('加密连接备份格式不正确')
    const configs = unseal<unknown>(value.encrypted, 'connections-export')
    assertCount(configs)
    return configs.map(config => portableConnectionWithSecrets(validateConnection(config, true)))
  }
  if (value.version !== 1) throw new Error('连接备份版本不兼容')
  assertCount(value.connections)
  return value.connections.map(item => {
    const draft = item as ConnectionDraft
    if (!draft || !draft.config || typeof draft.config !== 'object' || Array.isArray(draft.config) || !Array.isArray(draft.secretFields)) throw new Error('连接条目格式不正确')
    // Older templates contained no URI. A URI-only profile needs manual entry.
    const config = { ...draft.config }
    delete config.id
    if (!config.host && !config.uri) { config.host = 'localhost'; config.name += ' (需配置 URI)' }
    return portableConnection(validateConnection(config, true)).config
  })
}
