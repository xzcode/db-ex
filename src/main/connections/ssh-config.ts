import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { SshImportResult, SshOptions } from '../../shared/types'

interface Directive { key: string; values: string[]; line: number }
interface Block { patterns: string[]; directives: Directive[] }

/** Tokenizes configuration, never a shell command. Quotes/comments follow the useful ssh_config subset. */
function words(input: string): string[] {
  const result: string[] = []
  let token = ''
  let quote = ''
  let started = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '\\' && index + 1 < input.length && ['"', "'", '\\', '#', ' '].includes(input[index + 1])) { token += input[++index]; started = true; continue }
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; continue }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (char === '#') break
    if (/\s/.test(char) || (char === '=' && result.length === 0)) {
      if (started) { result.push(token); token = ''; started = false }
      continue
    }
    token += char
    started = true
  }
  if (quote) throw new Error('SSH_CONFIG_INVALID: SSH 配置含有未闭合的引号')
  if (started) result.push(token)
  return result
}
function match(pattern: string, host: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${regex}$`, 'i').test(host)
}
function matches(patterns: string[], host: string): boolean {
  return !patterns.some(p => p.startsWith('!') && match(p.slice(1), host)) && patterns.some(p => !p.startsWith('!') && match(p, host))
}

/** Import explicit Host aliases; unsupported executable/include/conditional directives are never run. */
export function parseSshConfig(text: string, defaults: { home?: string; username?: string } = {}): SshImportResult {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0')) throw new Error('SSH_CONFIG_INVALID: SSH 配置必须是 1 MiB 以内的文本')
  const warnings = new Set<string>()
  const blocks: Block[] = [{ patterns: ['*'], directives: [] }]
  let block: Block | undefined = blocks[0]
  const names = new Set<string>()
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > 8192) throw new Error(`SSH_CONFIG_INVALID: 第 ${index + 1} 行过长`)
    const tokens = words(line.replace(/^(\s*[A-Za-z][A-Za-z0-9]*)\s*=\s*/, '$1 '))
    if (!tokens.length) return
    const [name, ...values] = tokens
    const key = name.toLowerCase()
    if (!values.length) throw new Error(`SSH_CONFIG_INVALID: 第 ${index + 1} 行缺少参数`)
    if (key === 'host') {
      block = { patterns: values, directives: [] }
      blocks.push(block)
      for (const alias of values) if (!/[!*?%]/.test(alias)) names.add(alias)
    } else if (key === 'match') {
      warnings.add('Match 条件区块未导入；不会执行 Match exec，请手动核对连接。')
      block = undefined
    } else if (key === 'include') {
      warnings.add('Include 文件未读取；需要时请单独选择该文件导入。')
    } else if (block) block.directives.push({ key, values, line: index + 1 })
  })
  if (names.size > 128) throw new Error('SSH_CONFIG_INVALID: 单次最多导入 128 个 Host 别名')
  let localUsername = defaults.username
  if (!localUsername) { try { localUsername = userInfo().username } catch { localUsername = '' } }
  const home = defaults.home || homedir()
  const get = (alias: string): Map<string, Directive> => {
    const result = new Map<string, Directive>()
    for (const entry of blocks) if (matches(entry.patterns, alias)) for (const directive of entry.directives) {
      if (!result.has(directive.key)) result.set(directive.key, directive)
      else if (directive.key === 'identityfile') warnings.add(`${alias}：多个 IdentityFile 仅导入第一个，请核对。`)
    }
    return result
  }
  const resolve = (alias: string, stack: string[] = [], override: { username?: string; port?: number } = {}): SshOptions => {
    if (stack.length >= 4 || stack.includes(alias)) throw new Error('ProxyJump 循环或超过三层跳板')
    const values = get(alias)
    const first = (key: string): string | undefined => values.get(key)?.values[0]
    for (const name of ['hostname', 'user', 'port', 'identityfile', 'identityagent', 'proxyjump']) {
      const entry = values.get(name)
      if (entry && entry.values.length !== 1) throw new Error(`${name} 需要单一参数；含空格的路径请加引号`)
    }
    if (first('proxycommand') && first('proxycommand') !== 'none') throw new Error('ProxyCommand 不会执行，请改用 ProxyJump 或手动填写跳板')
    if (first('localcommand') || first('remotecommand')) warnings.add(`${alias}：LocalCommand / RemoteCommand 不会执行。`)
    const host = (first('hostname') || alias).replace(/%h/g, alias)
    const username = override.username || first('user') || localUsername || ''
    const port = override.port || Number(first('port') || 22)
    if (!host || /[\s\0/@\\?#%]/.test(host) || !username || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HostName、User 或 Port 无效')
    const expand = (value: string): string => {
      let path = value.replace(/%([%dhprn])/g, (_all, token: string) => ({ '%': '%', d: home, h: host, p: String(port), r: username, n: alias })[token]!)
      if (/%[A-Za-z]|\$\{/.test(path)) throw new Error('不支持该路径展开变量，请手动填写路径')
      if (path.startsWith('~/')) path = join(home, path.slice(2))
      else if (path.startsWith('~')) throw new Error('不支持其他用户的主目录展开')
      return path
    }
    const identity = first('identityfile')
    const agent = first('identityagent')
    const ssh: SshOptions = {
      enabled: true, host, port, username,
      authMode: identity && identity !== 'none' ? 'private-key' : agent === 'none' ? 'password' : 'agent',
      ...(identity && identity !== 'none' ? { privateKeyPath: expand(identity) } : {}),
      ...(agent && agent !== 'none' && agent !== 'SSH_AUTH_SOCK' ? { agentSocket: expand(agent) } : {}),
    }
    const jumps = first('proxyjump')
    if (jumps && jumps !== 'none') {
      const entries = jumps.split(',')
      if (entries.length > 3) throw new Error('最多支持三层前置跳板')
      ssh.jumps = []
      for (const spec of entries) {
        const parsed = /^(?:([^@\s]+)@)?(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?$/.exec(spec)
        if (!parsed) throw new Error('ProxyJump 格式无效')
        const jump = resolve(parsed[2] || parsed[3], [...stack, alias], { username: parsed[1], port: parsed[4] ? Number(parsed[4]) : undefined })
        if (jump.port < 1 || jump.port > 65535) throw new Error('ProxyJump 端口无效')
        if (jump.jumps) ssh.jumps.push(...jump.jumps)
        delete jump.jumps
        ssh.jumps.push(jump)
      }
      if (ssh.jumps.length > 3) throw new Error('展开后超过三层前置跳板')
    }
    return ssh
  }
  const hosts: SshImportResult['hosts'] = []
  for (const name of names) {
    try { hosts.push({ name, ssh: resolve(name) }) }
    catch (error) { warnings.add(`${name}：未导入，${error instanceof Error ? error.message : '配置无效'}。`) }
  }
  if (!hosts.length) warnings.add('没有可导入的明确 Host 别名；仅包含通配符的 Host 不会创建连接。')
  if (hosts.length) warnings.add('导入未自动信任主机密钥；连接前请独立核对并填写每一级 SSH 主机的 SHA-256 指纹。')
  return { hosts, warnings: [...warnings] }
}
