# DB EX 技术架构 v0.1

## 工程架构

```text
Vue Renderer (无 Node 权限)
   ↕ typed contextBridge API
Electron main (受控 IPC / 安全校验 / 本地密文仓库)
   ↓
SessionManager (连接生命周期 / 错误清理)
   ├─ MySQL Adapter (mysql2)
   ├─ MongoDB Adapter (mongodb)
   └─ Redis Adapter (node-redis)
   ↓
Transport (TCP / SSH Tunnel / TLS)
```

Electron Main 持有连接池、SSH Client、解密凭据和磁盘读写权。Renderer 仅收发无密码的连接视图和有限量数据。所有与数据库或网络交互的 IPC 通道均由 Preload 白名单显式定义。

## 模块职责

- `src/main/index.ts`：启动、CSP/窗口安全、IPC 注册与生命周期。
- `src/main/connections/store.ts`：依赖 Electron safeStorage 的密文配置读写。
- `src/main/connections/ssh.ts`：指纹验证的本地 TCP 端口转发。
- `src/main/connections/manager.ts`：连接会话、驱动适配、资源与记录预览。
- `src/shared/types.ts`：主/渲染端共用的纯类型定义。
- `src/preload/index.ts`：安全 IPC 契约。
- `src/renderer/`：工作台、连接表单、资源树和只读数据网格。

## 进程与网络安全

- 禁用 `nodeIntegration`，启用 `contextIsolation`、`sandbox` 与严格导航策略。
- SSH 主机指纹显式核对；隧道监听 `127.0.0.1` 随机端口。
- 不将 `password`, `passphrase`, `privateKey`, 认证 URI 或密文原件传给连接列表 UI。
- 加密后原子持久化，配置文件权限 0600；Linux 基础文本加密后端被视为不安全。
- IPC 不提供通用 SQL 执行/任意文件读写等未受限功能；后续功能需单独验证权限和限制。

## 已知限制

- 首个实现目标为数据库 **单节点**。MongoDB replica set / SRV（非 SSH）由官方驱动完成发现；通过 SSH 访问 replica set 和 Redis Cluster 的拓扑路由尚属 M5。
- TLS + SSH 时必须正确处理证书主机名及 SNI；特殊部署在缺乏有效证书时不能绕过验证。
- Electron 的 Linux 安全存储依赖桌面密钥环，无法访问时可临时连接但不能保存密钥。
- Redis SCAN 是增量迭代，不保证正在修改的数据集快照一致性。
