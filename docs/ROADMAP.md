# DB EX 路线图与交接

本轮将 M2–M5 的核心代码并入现有开发分支。当前交付定位是 **功能预览版**：功能实现、自动化验证、签名发行和真实部署兼容性分别记录，不能以能构建代替全部验收。

## 里程碑

| 阶段 | 当前状态 | 本轮具备的能力 |
|---|---|---|
| M0 | 已建立并更新 | 产品范围、分层架构、安全边界、连接规格、交接文档 |
| M1 | 已扩展 | Electron 桌面壳、连接新增/编辑/测试/保存/删除、三库会话与资源浏览、深浅主题、可调整侧栏、加密凭据 |
| M2 | 核心功能已实现，基本集成通过 | Monaco SQL 编辑与选区执行、参数绑定、结果分页、结构/索引查看、单行 CRUD、事务、CSV/JSON 小批量导入与当前页导出、查询历史/收藏 |
| M3 | 核心功能已实现，基本集成通过 | Canonical Extended JSON 文档读写、Filter/Projection/Sort、只读聚合、索引查看/创建/删除、EJSON 导入与当前页导出 |
| M4 | 核心功能已实现，基本集成通过 | Redis String/Hash/List/Set/ZSet/Stream 浏览与类型操作、TTL、白名单命令台、显式选择 Key 后批量删除 |
| M5 | 高级连接与加固已实现，三平台构建/启动通过 | SOCKS5、HTTP CONNECT、最多三个前置 SSH 跳板、SSH config 导入、MongoDB 拓扑路由、Redis Sentinel/Cluster、完整加密连接导入导出、安全与跨平台构建流程 |

## M2：MySQL 的具体行为

SQL 编辑器按单条语句执行，可以运行选区并传入 JSON 参数数组。SELECT 使用外层派生表限制每页行数；SHOW、DESCRIBE、EXPLAIN 等结果按流读取并限制内存。结果保留 NULL、BIGINT/DECIMAL 字符串及日期字符串，展示文本和编辑原值分开传递。

默认只读查询使用服务端 `START TRANSACTION READ ONLY`，再配合客户端语句校验。写入需解锁当前会话，并在主进程原生对话框中逐次确认。单行修改和删除要求真实表主键与完整原始记录，使用参数化条件比较旧值；并发修改会报告冲突。无主键、原始字段不完整或包含二进制字段的记录不开放表格编辑。

事务通过“开始 / 提交 / 回滚”按钮控制；断开连接回滚未提交事务。活动事务中拒绝可能隐式提交的 DDL。CSV/JSON 导入一次最多 500 行，InnoDB 表使用事务或保存点，任一行失败就回滚本批。

边界：不支持多语句脚本、存储过程、账户/服务器管理命令、自定义函数或任意会话设置。读取函数采用保守白名单。SELECT 派生表分页不兼容部分特殊语法，例如重复列别名；数据库会明确报错。分页不是快照，跨页期间数据变化可能导致重复或遗漏。二进制结果可预览，完整二进制编辑和大数据流式导入导出尚未实现。

## M3：MongoDB 的具体行为

文档编辑和 JSON 导出使用 Canonical Extended JSON，保留 ObjectId、Int64、Decimal128、Date、Binary 等 BSON 类型。Filter 接受 EJSON；Projection 目前接受字段的 0/1 映射，Sort 接受 1/-1。查找和聚合均有批次、行数、字节数与超时限制，未读完的游标会关闭。

替换/删除必须携带包含 `_id` 的完整原始文档。服务端用字面量比较完整旧文档，已有字段变化、新增字段、删除字段都会触发编辑冲突。聚合只开放读取阶段，递归拒绝 `$out`、`$merge`、`$where`、`$function`、`$accumulator`，不执行服务端 JavaScript。

索引支持常规升降序、text、hashed、2d、2dsphere 及名称、unique、sparse、hidden、TTL、partialFilterExpression 选项；不允许通过 `*` 删除全部索引或删除 `_id_` 索引。

边界：一次新增多份文档使用有序批量写入，**不是跨文档事务**；中途失败会报告已成功数量，需要刷新核对后再决定后续操作。单份可编辑文档上限 512 KiB；GridFS、大型 BSON 文档编辑、Explain 可视化和变更流不在本轮范围内。

## M4：Redis 的具体行为

Key 浏览使用 SCAN；Hash、Set、ZSet 使用对应 SCAN，List 使用范围分页，Stream 使用带 COUNT 的 XRANGE。游标保存为十进制字符串，避免 64 位游标转换为 JavaScript 数字后丢失精度。Cluster 可选择主节点逐个浏览，键操作由驱动按槽路由。

String 文本编辑使用原值比较的单键原子更新，默认可保留 TTL；过大或二进制值只预览，禁止用截断文本覆盖原值。其他类型使用显式原生命令，例如 HSET/HDEL、LPUSH/LSET、SADD/SREM、ZADD/ZREM、XADD/XDEL。TTL 更新与最多 100 个明确 Key 的逐键删除均需写入确认。

命令台校验完整命令和参数，开放有限量读取及常用数据修改；不开放 `KEYS`、`FLUSHALL`、`CONFIG`、任意脚本、阻塞命令、发布订阅或 MULTI/EXEC。String 编辑所需的固定内部 Lua 脚本不对用户开放任意执行入口。

边界：SCAN COUNT 是提示，非快照或准确分页长度；正在变化的数据可能重复或暂时返回空页。批量删除跨槽逐键执行，非跨 Key 原子事务。Redis 模块类型（如 JSON、Search、TimeSeries）、完整二进制编辑、Pub/Sub、Streams 消费者组管理尚未实现。

## M5：高级连接和发行

- 传输层支持直接 TCP、SOCKS5、HTTP CONNECT，可在首个 SSH 节点之前使用代理。
- SSH 支持密码、私钥及本地 Agent，最多三个前置跳板加最终 SSH 服务端，每一级独立验证 SHA-256 指纹。未知或变更指纹均拒绝连接。
- SSH config 导入支持明确 Host 别名、HostName/User/Port、IdentityFile、IdentityAgent、ProxyJump 和部分路径变量；不执行 ProxyCommand、Match exec、LocalCommand 或 RemoteCommand，不自动读取 Include。
- MongoDB 通过驱动的 SOCKS5 能力保留原始节点名称和副本集发现。SRV/TXT 查询仍由本机 DNS 完成；仅远端可解析的 SRV 域名不能据此保证可用。
- Redis Standalone、Sentinel、Cluster 的种子、发现节点和重定向节点经过同一传输路径；TLS 校验使用节点真实名称。Sentinel 支持独立认证和 TLS 开关。
- 连接配置支持单条/全部加密备份，保留密码、口令和 URI；导入直接恢复连接信息，SSH 主机指纹重新核验。查询历史与收藏同样使用内置 AES-256-GCM 密钥，不依赖系统钥匙串。
- macOS、Windows、Linux 使用 Electron Builder 打包；无签名证书时产物是 unsigned preview。签名、公证凭据、平台实际安装与升级验收仍需发行环境提供。

详细连接配置和限制见 [CONNECTIONS.md](CONNECTIONS.md)，安全机制见 [SECURITY.md](../SECURITY.md)。

## 容量与操作限制

| 对象 | 本轮限制 |
|---|---|
| 同时连接 / 保存连接 | 最多 20 个活动会话 / 200 个保存连接 |
| 单次数据库操作 | 最多 30 秒；取消会断开当前会话，写入结果不明确时需重连核对 |
| MySQL / MongoDB | 每页默认 100、最多 500 行；结果数据约 2 MiB；单行或文档最多 512 KiB |
| SQL / 聚合 | SQL 文本 128 KiB；聚合最多 100 个阶段，表达式嵌套最多 64 层 |
| Redis | String 预览与单个写入参数最多 64 KiB；分页建议 100 项，展示最多 500 行、2 MiB；额外网络预算 8 MiB/操作 |
| 导入 | 用户选择的文本文件最多 4 MiB；数据库单批最多 500 行/文档且负载最多 2 MiB |
| 导出 | 当前结果页；通过保存对话框选择路径，文件内容最多 8 MiB |
| 查询记录 | 200 条历史 + 100 条收藏，加密保存 |

MySQL 的单值尺寸需在驱动接收和解码之后才能判断；MongoDB 先接收网络批次，再在逐文档解码前检查原始 BSON 大小。上述结果上限不能解释为网络包或进程峰值内存的严格上限。Redis 额外使用驱动解析前的网络预算；对特别大的集合元素仍应缩小读取范围。

## 验证状态与复现

首轮 CI（提交 `898ff9c`，[运行记录](https://github.com/xzcode/db-ex/actions/runs/45169885032)）已通过57项单元/协议/真实三库集成测试、5项UI测试，以及macOS ARM64、Windows x64、Linux x64安装包构建和打包后启动。三个平台的安装包/截图上传均因账号Actions存储配额耗尽而被GitHub拒绝，不能提供该轮产物下载。

后续加固增加了连接模板信任隔离、结果虚拟滚动及第6项UI回归、真实Mongo副本集/Redis Cluster/Sentinel故障切换验收。工作流按当前提交持续执行这些强制校验，最新结果见[Actions](https://github.com/xzcode/db-ex/actions)与[PR #1](https://github.com/xzcode/db-ex/pull/1)；跳过的测试不计为通过。仅诊断截图和安装包上传可因配额受限而非阻塞，代码、集成、UI、打包、真实启动和产物哈希检查仍为强制步骤。企业代理、证书体系和长期故障场景仍需对应部署环境验收。

```bash
npm ci
npm run typecheck
node --import tsx --test tests/*.test.ts
npm run build
npm run dev
```

MySQL/MongoDB 集成测试用 `DB_EX_INTEGRATION=1` 显式开启，连接 `MYSQL_URL` 和 `MONGODB_URI` 指定的 localhost 测试服务，创建随机 `dbex_it_*` 数据库后清理。没有该开关时会明确跳过，不接触用户已有业务数据库。Redis实际集成使用本地隔离服务；协议测试使用独立本地TCP/SSH/TLS夹具。`DB_EX_TOPOLOGY=1`启用脚本创建的三成员Mongo副本集、Redis三主Cluster及Sentinel实际切换测试，读取和写入都经过认证SOCKS代理，未确认结果的写操作不会自动重放。

## 后续发行验收清单

1. 在三平台实际运行、安装、卸载并验证内置加密、跨设备导入、路径和窗口行为。
2. 使用有效/错误 CA、证书名称、客户端证书验证 TLS；逐跳验证 SSH 未知与变更主机密钥拒绝逻辑。
3. 在可控测试环境验证 MongoDB 副本切换、Redis Sentinel 切换、Cluster MOVED/ASK、节点不可达和连接清理。
4. 接入发行签名/公证凭据并验证签名产物；签名成功前保持预览版标识。
5. 进一步覆盖大型单值、特殊 SQL、复杂 BSON 与超大 Key 数据集；性能结论必须附可复现数据。

## v0.5.3 多语言基础

- 14 种语言与默认跟随系统模式；支持地区变体、阿拉伯语 RTL、英文回退；语言选择实时生效并本地保存。
- 共享语言资源覆盖桌面页面、连接选项、工作区、文件对话框、写操作确认及常用错误消息；未收录的驱动诊断保持原文。
- 后续新增语言须按 `docs/I18N.md` 补齐资源、UI 测试与插值校验。

## v0.5.4 连接管理交互

- 数据库类型先选、专用常规页、MongoDB URI 独立入口；MySQL、MongoDB、Redis 各自显示拓扑与认证选项。
- SSL/TLS、SSH、代理和高级设置分栏，支持本地证书/私钥选择器、密码可见性切换及无名称连接测试。
- 不改变内置加密、连接备份格式、SSH 主机指纹验证和数据库权限策略。新交互资源覆盖现有 14 种语言。

## v0.5.5 MongoDB 类型可视化

- BSON 实际类型元数据随每页读取结果返回，允许同列不同类型独立着色，区分 Null、Missing 与 String；稳定 100 列显示范围。
- 只读文档树及原始 EJSON 视图，嵌套类型预览有上限，不改变完整文档及写入/导出内容。
- 全局 BSON 类型配色设置：按类型自定义、无颜色、恢复默认、网格类型标签开关、重启保留；通用 36 色预设、原生拾色器、HEX 和最近 12 个自定义颜色。

## v0.5.6 连接配置简化

移除固定环境选择和标签，使用任意命名的分组及颜色管理连接。旧连接和备份继续兼容；所有会话统一保留默认只读及原生写入确认。

- MongoDB 浏览改为紧凑纯值表格：BSON 类型独立着色、文档/数组摘要、可调整列宽、默认收起查询条件、分页和已执行查询信息；原始 EJSON 留作精确查看及编辑。

- MongoDB 记录/字段右键菜单与类型构造语法编辑器，验证、更新、复制、新增、删除、字段值筛选与草稿修改；保持写入确认和完整文档冲突检测。
