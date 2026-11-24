/**
 * Map MongoDB connection failures to actionable, credential-safe UI messages.
 * A MongoServerSelectionError often wraps its real network cause in a topology's
 * server description, rather than exposing it as the top-level error code.
 * Never interpolate raw driver messages: they can contain usernames, hosts, or URIs.
 */
function errorSignals(error: unknown): string {
  const visited = new Set<object>()
  const fragments: string[] = []
  function inspect(value: unknown, depth: number): void {
    if (depth > 5 || fragments.length > 70 || value === null || typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)
    if (value instanceof Map) {
      for (const entry of value.values()) inspect(entry, depth + 1)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) inspect(item, depth + 1)
      return
    }
    const item = value as Record<string, unknown>
    for (const key of ['name', 'code', 'codeName', 'message', 'type']) {
      if (typeof item[key] === 'string' || typeof item[key] === 'number') fragments.push(String(item[key]).slice(0, 2000))
    }
    for (const key of ['cause', 'reason', 'servers', 'error', 'errors']) {
      inspect(item[key], depth + 1)
    }
  }
  inspect(error, 0)
  return fragments.join('\n')
}

export function describeMongoConnectionError(error: unknown): string | undefined {
  const signals = errorSignals(error)
  if (!signals) return undefined
  if (/(AuthenticationFailed|auth failed|bad auth|sasl|SCRAM|MongoServerError[\s\S]*\b18\b|\b18\b[\s\S]*Authentication)/i.test(signals)) {
    return 'MONGO_AUTH_FAILED: MongoDB 认证失败。请检查用户名、密码以及 authSource（admin 或账号创建所在的数据库）；使用 URI 时，请在 URI 内填写认证信息。'
  }
  if (/(not authorized|Unauthorized|\b13\b[\s\S]*not authorized)/i.test(signals)) {
    return 'MONGO_PERMISSION_DENIED: MongoDB 账户权限不足。请检查账号对目标数据库的访问权限。'
  }
  if (/(ENOTFOUND|EAI_AGAIN|ENODATA|querySrv|queryTxt|DNSHostNotFound|DNS error|getaddrinfo)/i.test(signals)) {
    return 'MONGO_DNS_FAILED: MongoDB 地址无法解析。请检查主机名、本机 DNS；mongodb+srv 需要本机能够查询 SRV/TXT 记录。'
  }
  if (/(ECONNREFUSED|connection refused|connection closed on connect)/i.test(signals)) {
    return 'MONGO_CONNECTION_REFUSED: MongoDB 端口拒绝连接。请确认地址、端口、mongod 监听地址和防火墙；未开启 SSH 时 127.0.0.1 指向本机；启用 SSH 时则指向最终 SSH 出口主机。'
  }
  if (/(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS|SSL routines|SSLHandshake|certificate verify|certificate has expired|Hostname\/IP does not match|tlsv1 alert)/i.test(signals)) {
    return 'MONGO_TLS_FAILED: MongoDB TLS 握手或证书校验失败。请检查服务器是否要求 TLS，以及 CA、证书主机名与证书有效期。'
  }
  if (/(MongoCompatibilityError|maximum wire version|minimum wire version|this version of the Node\.js Driver requires at least|server version.*not supported)/i.test(signals)) {
    return 'MONGO_VERSION_UNSUPPORTED: MongoDB 服务端版本可能太旧，当前 DB EX 的 MongoDB 驱动要求 MongoDB 4.2 或更新版本。请核对服务端版本（不用修改服务器即可先用 Navicat 查看）。'
  }
  if (/(MongoParseError|MongoInvalidArgumentError|ERR_INVALID_URL|URI malformed|Invalid scheme|password must be URL encoded)/i.test(signals)) {
    return 'MONGO_URI_INVALID: MongoDB URI 格式无效。请使用 mongodb:// 或 mongodb+srv://，并对用户名、密码中的特殊字符做 URL 编码。'
  }
  if (/(ReplicaSetNoPrimary|ReplicaSetWithPrimary|setName.*does not match|replica set name|not primary|ServerSelectionError.*replica)/i.test(signals)) {
    return 'MONGO_TOPOLOGY_FAILED: 无法选择 MongoDB 副本集节点。请核对副本集名称及成员对当前网络/SSH 出口的可达性；单节点管理可尝试“直连”模式。'
  }
  if (/(ETIMEDOUT|ESOCKETTIMEDOUT|MongoNetworkTimeoutError|Server selection timed out|connection timed out|timed out)/i.test(signals)) {
    return 'MONGO_TIMEOUT: MongoDB 连接超时。请检查目标端口、网络/SSH/代理、防火墙及副本集节点可达性；必要时适当提高连接超时。'
  }
  if (/MongoServerSelectionError/i.test(signals)) {
    return 'MONGO_SERVER_SELECTION_FAILED: MongoDB 无法选择可用服务器。请检查主机端口、SSH/代理、TLS 和副本集宣告的成员地址；单实例可尝试直连模式。'
  }
  return undefined
}
