# DB EX

本地优先的桌面数据库工具，统一管理 **MySQL、MongoDB、Redis**。基于 Electron、Vue 3、TypeScript 与 Monaco，不依赖账号、云端服务或遥测。

当前版本：**0.5.0 开发预览版**。M2–M5 的功能实现已接入；完整范围、验收证据和限制见 [路线图](docs/ROADMAP.md)。预览安装包与最终发行签名是不同的交付项。

## 功能

| 模块 | 已实现能力 |
| --- | --- |
| 连接与工作区 | 保存/编辑连接、临时连接、测试连接、多会话、资源树、可调整布局、深浅主题 |
| MySQL | Monaco SQL、选中执行、参数绑定、结果分页、结构与索引查看、主键定位 CRUD、原值冲突检测、显式事务、CSV/JSON 批量导入与当前页导出 |
| MongoDB | Canonical EJSON/BSON 文档、Filter/Projection/Sort、单文档 CRUD、Aggregation、索引管理、EJSON 导入导出 |
| Redis | SCAN、String/Hash/List/Set/ZSet/Stream 浏览与编辑、TTL、String CAS 更新、明确选择 Key 的批量删除、受限命令台 |
| 高级连接 | 直连、SOCKS5、HTTP CONNECT、SSH 密码/私钥/Agent、最多三个前置跳板、逐级指纹、SSH config 安全导入、TLS/mTLS |
| 拓扑 | MongoDB URI/副本集/原生节点发现；Redis Standalone、Sentinel、Cluster；发现的新节点沿用代理/SSH 路由 |
| 本地持久化 | 系统安全存储加密连接、查询历史和收藏；不回显已保存密码；脱敏连接配置导入导出 |

### 写入保护

新会话默认只读。启用写入需要主进程原生确认，每次实际写入再确认目标连接、环境、资源与操作。MySQL 使用参数绑定和只读事务保护；表格修改必须携带实际主键与完整原始记录。MongoDB 使用完整原文档做原子冲突检测。数据库只读账号仍是服务端权限边界。

取消操作会断开当前会话。未提交的 MySQL 事务回滚；已自动提交或已发给服务器的写操作不能承诺撤销，重连后核对结果再决定是否重试。

## 开发运行

要求 Node.js **22.12+**、npm，以及相应平台的 Electron 桌面运行依赖。

```bash
git clone -b feature/m0-m1-core https://github.com/xzcode/db-ex.git
cd db-ex
npm ci
npm run dev
```

当前增量开发沿用 PR #1 的功能分支。合并后可使用默认分支。

```bash
npm run typecheck       # 前后端类型检查
npm test                # 安全边界与真实协议测试；无集成环境时跳过数据库测试
npm run build           # 主进程、preload、Vue/Monaco 生产构建
npm run test:ui         # Playwright 工作区测试
npm run pack            # 本机未封装应用目录
npm run dist            # 本机安装包
```

UI 测试首次需 `npx playwright install chromium`；Linux CI 使用 `--with-deps`。`npm run dev` 会启动 Renderer 热更新；修改 main/preload 后重启开发命令。

## 数据使用范围

- **MySQL SQL**：一次一条语句。事务通过专用按钮操作；不执行存储过程、用户/权限/服务器管理命令或可执行注释。SELECT 使用派生表分页，重复列名或不适合该包装的 SQL 会明确报错。表格 CRUD 需要主键，含二进制列的预览不提供文本编辑。导入的原子性依赖 InnoDB；触发器或外部副作用需要另行评估。
- **MongoDB**：编辑与导出使用 Canonical Extended JSON，保留 ObjectId、Int64、Decimal128、Date 等类型。禁止服务端 JavaScript、`$out`、`$merge`；Projection 查询不能直接用作整文档编辑。批量插入有明确的部分成功提示，不承诺跨文档事务。
- **Redis**：编辑六种基础数据类型；Redis 模块类型、Pub/Sub、阻塞命令、脚本/管理命令不在命令台开放范围。Cluster 的 Key 浏览按主节点选择，SCAN 不是一致性快照，COUNT 只是提示。二进制 String 以 Base64 预览，不允许用文本覆盖；二进制 Key 暂无专用编辑器。
- **返回量**：一般最多500行、2 MiB渲染结果；MySQL单行/Mongo单文档最多512 KiB。Redis String只读取前64 KiB，单次操作所有节点累计入站超过8 MiB立即断开。MySQL/Mongo的大字段仍需驱动接收当前行/文档后才能判断应用上限。
- **导入导出**：文件导入最多4 MiB，每批最多500条；SQL/Mongo单批内容最多2 MiB。导出当前已加载的一页，不隐式全库扫描。CSV用 `\N` 表示 null，导出会防御电子表格公式执行；类型保真优先使用 JSON/EJSON。
- **会话**：每个连接一次只执行一个操作，最长30秒；最多20个同时打开的连接。

## 高级连接说明

完整字段与组合见 [连接指南](docs/CONNECTIONS.md)。

SSH 每一级都要提供独立核验过的 SHA-256 主机指纹，不自动信任首次出现的主机。SSH config 只解析明确的 Host 和安全选项，绝不执行 `ProxyCommand`、`Match exec` 或配置中的 shell 命令。包含这些能力的配置会跳过或给出提示。

代理与 SSH 都保留数据库目标主机名进行 TLS 校验。MySQL TLS 需要证书 DNS 身份：目标可以是 IP，但应另填证书覆盖的 DNS 名称；仅 IP SAN 的 MySQL 证书会被明确拒绝，避免驱动回退验证错误主机。MongoDB 的 `mongodb+srv` 仍需本机能够解析 DNS SRV/TXT；TCP 数据路径经过所选代理/隧道。Redis Sentinel/Cluster 发布的地址必须能被最后一级网络出口访问，且 TLS 证书需覆盖对应名称。

Linux 系统密钥环不可用或回退为 `basic_text` 时，保存连接与查询历史会被拒绝，临时连接仍可使用。连接导出不包含密码、URI 凭据或私钥口令；导入后需重新补齐认证信息。详见 [安全说明](SECURITY.md)。

## 验证与发行

[Verify DB EX](.github/workflows/ci.yml) 在 PR 上执行：

1. 类型检查、安全/协议测试。
2. 临时 MySQL 8.4、MongoDB 7、Redis 7 服务上的真实集成测试，包括经认证 SOCKS 路由的 SessionManager 连接、三成员 Mongo 副本集主节点切换、Redis 三主节点 Cluster 及 Sentinel 切换。
3. Playwright 工作区交互测试。
4. macOS、Windows、Linux 生成预览安装包，并启动打包后的 Electron 应用验证 sandbox、preload IPC、Monaco 与查询界面。

测试使用随机数据库名或 Redis Key 前缀并清理，仅指向本地测试服务。真实数据库测试可通过以下环境变量启用：

```bash
DB_EX_INTEGRATION=1 \
MYSQL_URL=mysql://root:dbex-test@127.0.0.1:3306 \
MONGODB_URI=mongodb://127.0.0.1:27017 \
REDIS_URL=redis://127.0.0.1:6379 \
npm run test:integration
```

拓扑测试由 CI 中的 `scripts/start-mongo-replica.sh` 与 `scripts/start-redis-topologies.sh` 初始化独立测试进程；仅 `DB_EX_TOPOLOGY=1` 时执行 `npm run test:topology`，不会使用外部业务 URI。

安装包上传成功时可在 GitHub Actions Artifacts 下载，默认未做受信任发行签名。2026-11-23 验证发现当前账号 Actions 存储配额已满，GitHub 拒绝上传；代码构建与打包后启动验证仍独立执行，工作流摘要记录产物哈希。CI 的可选上传失败不等于产物可下载，正式发行工作流仍要求上传成功。不能把预览构建描述为完成公证或商业发行。

[Release candidates](.github/workflows/release.yml) 可手动生成发行候选包。选择签名时需要分别配置 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`、`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；macOS 公证还需要 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。缺少凭据会失败，不会悄悄退回未签名产物。工作流不自动发布 GitHub Release。

## 文档

- [产品范围](docs/PRD.md)
- [架构](docs/ARCHITECTURE.md)
- [连接与拓扑](docs/CONNECTIONS.md)
- [路线图、已知限制与交接](docs/ROADMAP.md)
- [安全约束](SECURITY.md)

## macOS installation notes

v0.5.0 was an unsigned preview; the next macOS build uses ad-hoc signing (like Shell EX), still without notarization. See [macOS install and Gatekeeper troubleshooting](docs/MAC_INSTALL.md) before bypassing the "app is damaged" warning. Native application icons for the next build are generated reproducibly with `npm run icons` (macOS ICNS, Windows ICO and Linux PNG).
