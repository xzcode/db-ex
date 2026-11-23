# DB EX

**Database Explorer — One client, multiple databases.**

DB EX 是一款本地优先的跨平台数据库桌面客户端，初期面向 **MySQL / MongoDB / Redis**，目标是覆盖 Navicat 日常使用中最关键的连接、导航和数据浏览能力。

## 开发进度

- **M0**：产品需求、技术架构、连接协议和安全基线。
- **M1（首批实现）**：Electron + Vue 桌面框架、连接管理、系统安全存储、SSH 隧道、TLS、三库连接与只读数据浏览。
- **M2**：MySQL SQL 编辑器、修改记录、事务、分页和导入导出。
- **M3**：MongoDB BSON 文档编辑、过滤、聚合、索引管理。
- **M4**：Redis Key 编辑、命令控制台、TTL 和类型操作。
- **M5**：多跳 SSH、SOCKS5、Redis Cluster / Sentinel、MongoDB Replica Set 路由、跨平台发行与质量加固。

> 当前是开发预览版本，不建议在生产数据库上执行写操作。UI 只读限制并不能替代数据库自身的只读权限。

## 本地运行

需要 Node.js 22+、npm 和 macOS/Windows/Linux 桌面环境。

```bash
npm install
npm run dev
```

构建：

```bash
npm run typecheck
npm run build
npm run pack
```

`npm run build` 生成应用静态资源；`npm run pack` 生成未签名的桌面应用目录。正式发行安装包需要进一步配置各平台代码签名。

## 安全约定

- 数据库密码和 SSH 登录信息只保存在 Electron 主进程，磁盘上通过系统级安全存储加密；不存在明文回退。
- SSH 隧道使用本地回环地址和动态随机端口，且首次连接需要核对并信任主机指纹。
- Electron 渲染进程禁止 Node 集成，启用上下文隔离与沙箱；所有数据库操作经有限 IPC 接口执行。
- 如果系统安全加密不可用，允许不保存的临时连接，但**拒绝保存连接密钥**。

更多设计资料见 [docs/PRD.md](docs/PRD.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/CONNECTIONS.md](docs/CONNECTIONS.md) 和 [docs/ROADMAP.md](docs/ROADMAP.md)。
