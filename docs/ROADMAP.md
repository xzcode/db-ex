# DB EX 路线图与交接

| 阶段 | 状态 | 内容 |
|---|---|---|
| M0 | 已建立 | PRD / 技术架构 / 安全基线 / 连接规格 / repo 规范 |
| M1 | 首批开发 | 跨平台桌面壳、保存连接、SSH、TLS、MySQL/MongoDB/Redis 单节点连接、有限量只读浏览 |
| M2 | 待开发 | MySQL SQL/CRUD/事务/结构浏览/导入导出 |
| M3 | 待开发 | MongoDB JSON/BSON 文档编辑、Filter、Aggregation、索引 |
| M4 | 待开发 | Redis 全数据类型编辑、命令台、TTL、批量删除确认 |
| M5 | 待开发 | SOCKS5、多级 SSH、集群拓扑、安全加固、发行测试 |

## 交接原则

每次开发批次应更新此文件并记录具体已实现、未实现、限制及可复现的运行方法。不要把只读数据浏览写成具备完整 CRUD 的数据库客户端。

## 首批运行方法

`npm install && npm run dev`。需要已安装 Electron 所需桌面依赖；CI 至少运行 `npm run typecheck` 和 `npm run build`。无可用 OS 密钥环的环境无法保存敏感连接配置。
