import type { ConnectionConfig, DatabaseKind } from '../../shared/types'

const kinds: DatabaseKind[] = ['mysql', 'mongodb', 'redis']
const validEnv = ['development', 'testing', 'production']

function assertText(value: unknown, field: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`INVALID_CONNECTION: ${field} 不能为空或超出长度限制`)
  }
}

export function validateConnection(value: unknown): ConnectionConfig {
  if (!value || typeof value !== 'object') throw new Error('INVALID_CONNECTION: 参数错误')
  const config = value as ConnectionConfig
  assertText(config.name, '连接名称', 100)
  if (!kinds.includes(config.kind)) throw new Error('INVALID_CONNECTION: 不支持的数据库类型')
  if (!validEnv.includes(config.environment)) throw new Error('INVALID_CONNECTION: 环境无效')
  if (config.kind !== 'mongodb' || !config.uri?.trim()) {
    assertText(config.host, '数据库地址')
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('INVALID_CONNECTION: 数据库端口无效')
    }
  } else {
    if (!/^mongodb(\+srv)?:\/\//i.test(config.uri)) throw new Error('INVALID_CONNECTION: MongoDB URI 无效')
    if (config.uri.length > 4096) throw new Error('INVALID_CONNECTION: MongoDB URI 过长')
  }
  if (!config.ssh || !config.tls) throw new Error('INVALID_CONNECTION: SSH/TLS 参数缺失')
  if (config.ssh.enabled) {
    assertText(config.ssh.host, 'SSH 地址')
    assertText(config.ssh.username, 'SSH 用户名')
    if (!Number.isInteger(config.ssh.port) || config.ssh.port < 1 || config.ssh.port > 65535) {
      throw new Error('INVALID_CONNECTION: SSH 端口无效')
    }
    if (!['password', 'private-key', 'agent'].includes(config.ssh.authMode)) {
      throw new Error('INVALID_CONNECTION: SSH 认证方式无效')
    }
    if (config.ssh.authMode === 'password') assertText(config.ssh.password, 'SSH 密码', 1024)
    if (config.ssh.authMode === 'private-key') assertText(config.ssh.privateKeyPath, 'SSH 私钥路径')
    if (config.kind === 'mongodb' && config.uri?.trim()) {
      throw new Error('INVALID_CONNECTION: M1 版本不支持 MongoDB URI 与 SSH 隧道组合，请使用主机/端口模式')
    }
  }
  if (config.tls.enabled && config.tls.certPath && !config.tls.keyPath) {
    throw new Error('INVALID_CONNECTION: 客户端证书需要配套私钥')
  }
  if (config.kind === 'redis' && (config.redisDb ?? 0) !== 0) {
    if (!Number.isInteger(config.redisDb) || config.redisDb! < 0 || config.redisDb! > 15) {
      throw new Error('INVALID_CONNECTION: Redis DB 序号应为 0–15（实例实际 DB 数量以服务端为准）')
    }
  }
  return config
}

export function validateId(id: unknown): asserts id is string {
  assertText(id, '会话标识', 128)
}
