# 连接参数与高级网络

## 建立连接

新建连接选择数据库类型、连接名称、环境标签和数据库地址。可先“测试连接”，再临时连接或保存。每次建立的会话默认只读；需要修改数据时解锁当前会话，再逐次确认写操作。

| 参数 | 含义 |
|---|---|
| `kind` | `mysql` / `mongodb` / `redis` |
| `host`, `port` | 数据库逻辑地址；默认端口分别为 3306、27017、6379 |
| `username`, `password` | 数据库账号；Redis username 对应 ACL 用户 |
| `database` / `authSource` | 默认数据库 / MongoDB 认证数据库 |
| `redisDb` | Redis 逻辑库，0–1023 范围内还必须被服务端支持；Cluster 固定为 0 |
| `environment` | development / testing / production，用于标识与写入提示 |
| `connectTimeoutMs` | 单阶段连接超时，默认 12000 ms，可设 1000–60000 ms；多节点过程可能经历多个阶段 |
| `nodes` | MongoDB / Redis 的种子节点，最多 20 个 |

保存配置使用系统密钥环加密；密钥环不可用时只能使用临时连接。编辑已保存配置不会把保存的密码或完整 MongoDB URI 返还界面；空白表示保留同一端点的已有凭据，清除必须显式指定。

## 传输路径

支持直接 TCP、SOCKS5 和 HTTP CONNECT，可与 SSH 链组合。组合路径是：本机 → 可选代理 → 第一个 SSH 节点 → 后续 SSH 节点 → 数据库。未启用 SSH 时，代理直接连接数据库及其发现节点。

代理支持无认证或用户名/密码认证。HTTP CONNECT 使用 HTTP/1.x CONNECT 和可选 Basic 认证；本轮不提供到 HTTP 代理本身的 HTTPS 包装或 NTLM/Kerberos 协商。数据库 TLS 是独立配置。SOCKS5 使用 CONNECT，不开放 UDP ASSOCIATE 或 BIND。

## SSH 多跳

最终 SSH 节点可附加最多三个有序前置跳板，总计最多四级 SSH。各级分别配置地址、端口、用户名及以下认证之一：

- 密码。
- 本地 OpenSSH 私钥路径及可选私钥口令；私钥内容由主进程读取。
- 本机 SSH Agent，使用指定 Agent Socket 或 `SSH_AUTH_SOCK`。不将 Agent 转发到远端。

每一级都需要独立核对 `hostFingerprint`。格式是主机公钥 SHA-256 的 **64 位十六进制摘要**，不同于 OpenSSH 默认显示的 `SHA256:<base64>` 字符串。未知主机错误会显示当前指纹与跳数，必须与管理员或其他可信渠道核对后填写；指纹变更不会被自动接受。

这里使用 SSH `forwardOut` 建立 TCP channel，不执行远程 shell。下一跳必须能从上一跳访问，数据库及集群宣告地址必须能从最终 SSH 节点访问。任一级连接断开会关闭整个传输作用域和所有下游 socket。

### 导入 SSH config

支持明确 Host 别名及匹配这些别名的通配配置，遵循先得到的值优先的子集行为。支持 HostName、User、Port、首个 IdentityFile、IdentityAgent、ProxyJump，以及 `~/` 和有限的 `%` 路径变量。可识别多个 ProxyJump，并在展开后检查环和层数。

不执行 ProxyCommand、Match exec、LocalCommand、RemoteCommand；不读取 Include 目标文件。含不支持内容的条目会跳过或给出警告，不能把导入结果当成完整 OpenSSH 配置等价物。导入不会自动信任主机密钥，仍须填写各级指纹。

## TLS

启用后支持 CA、客户端证书和私钥路径；客户端证书与私钥必须成对配置，可使用分离 PEM。证书文件须为普通文件且单个不超过 2 MiB。本轮要求 TLS 1.2 或更高，始终校验证书链和主机名，不提供“不安全连接”开关。

传输层保留数据库真实地址，因此通过代理/SSH 时仍按逻辑节点名称验证证书。`tls.servername` 是显式的证书名称覆盖，仅在证书与部署拓扑确实需要时使用；集群节点证书身份不同的部署不应给所有节点套用同一错误名称。证书不匹配应修正 CA、名称或部署，不能绕过校验。

## MongoDB

可使用字段配置或 `mongodb://` / `mongodb+srv://` URI。完整 URI 加密保存，连接列表及编辑回读均不返回其内容。URI 和字段配置不要混用不同认证信息；使用 URI 时驱动采用 URI 内认证配置。

副本集可填写 `mongoReplicaSet` 或在 URI 中提供 `replicaSet`；单节点/专门的单节点管理可启用 `mongoDirect`。启用 SSH/代理时，应用建立一个带随机会话认证的 loopback SOCKS5 入口，驱动发现的成员继续经过相同传输路径。发现成员的 DNS 名称与端口必须对最终出口可达；本轮没有任意 NAT 地址映射表。

SRV/TXT 发现由本机 DNS 执行。仅在跳板机内部可解析的 SRV 名称，需要改用显式种子列表或配置本机可用的 DNS；代理不会自动代理 SRV 查询。

URI 禁止 `tlsInsecure`、无效证书/主机名放行、代理覆盖以及绕过表单的证书文件路径。TLS 表单启用时拒绝 URI 的 `tls=false` / `ssl=false` 冲突。驱动自动读写重试关闭，连接失败或取消后不擅自重放写操作。

## Redis

| 模式 | 配置与行为 |
|---|---|
| Standalone | 数据库 host/port、ACL username/password、redisDb；直接或代理/SSH |
| Sentinel | 填写 Sentinel 种子列表和 master 名称；Sentinel 可使用独立账号、密码、TLS 开关；发现的主节点使用数据库凭据和数据库 TLS |
| Cluster | 填写一个或多个种子节点；仅 DB 0；支持节点发现和 MOVED/ASK 路由；每个节点使用相同传输作用域 |

Sentinel 重连会重新向配置的 Sentinel 查询主节点，同时周期检查连接角色；本轮重试次数有限，不能把它视为无限自动恢复。Cluster 保留原始节点名称，避免在本机预先解析成 IP 后破坏远端 DNS 或 TLS 身份验证。集群宣告地址必须从最终网络出口可达。

Key 浏览在 Cluster 中按主节点进行 SCAN，不承诺全局排序或一致快照。跨槽删除逐 Key 路由，因此可能部分完成。连接恢复不自动重放尚未得到响应的写命令；发生超时、断线或切换后，应刷新核对写入结果。

## 配置导入导出

导出格式包含版本与非敏感配置，移除数据库/SSH/代理/Sentinel 密码、私钥口令和完整 MongoDB URI。它仍包含主机、用户名、证书/私钥路径和已信任的指纹，分享前应核对这些内容。

导入后重新填写被移除的凭据；缺少 SSH 密码的配置会改为 Agent，URI-only 配置会标记需重新配置 URI。导入不会执行连接或命令，也不会把导出文件作为完整的密钥备份。最大保存连接数为 200。

## 错误与排查

`SSH_HOST_KEY_UNTRUSTED` / `SSH_HOST_KEY_MISMATCH` 表示指纹待核对或已变化；`PROXY_AUTH_FAILED` 表示代理认证失败；`SSH_FORWARD_FAILED` 表示最终出口无法连接目标或禁用了 TCP 转发。TLS 失败须检查信任链、有效期及名称，不能禁用校验绕过。

`SESSION_BUSY` 表示当前会话已有操作；`TIMEOUT` / `CANCELLED` 后会话会断开；`EDIT_CONFLICT` / `CONFLICT` 表示数据已变化。数据库错误只公开稳定代码和经过脱敏的提示，不回传可能包含凭据或记录内容的原始驱动异常。
