# 连接参数与网络协议

## 通用字段

`name` 显示名称；`kind` 为 mysql/mongodb/redis；`host`, `port` 为数据库所在节点；`username`, `password` 为数据库凭据；`environment` 区分 dev/test/prod。

默认端口：MySQL 3306，MongoDB 27017，Redis 6379。生产连接建议使用单独的只读数据库账号。数据库密码默认不显示到已保存连接列表。

## SSH

- SSH 地址、端口、用户名，认证为密码、OpenSSH 私钥文件或系统 SSH Agent。
- `hostFingerprint` 为 SHA-256 主机公钥指纹的十六进制摘要。第一次看到指纹时，必须与可信来源（例如服务器管理员提供的指纹）独立核对，再接受并保存。
- SSH `forwardOut` 将本地 `127.0.0.1:随机端口` 连接转发到 SSH 服务端可见的数据库内网地址。
- 断开数据库会话时必须同时关闭本地端口及 SSH Client。

## TLS

始终验证服务器 TLS 证书。CA/客户端证书/客户端密钥使用本机路径，不通过渲染端读取内容；路径权限由主进程检查。双向认证按服务端要求启用。

## MongoDB URI

支持直接使用 `mongodb://` 或 `mongodb+srv://` URI；带密码的 URI 将与其他连接信息一起加密保存。多节点连接通过 SSH 单端口隧道不在 M1 支持范围；M5 扩展拓扑感知路由。

## Redis

支持 standalone + ACL/密码。Sentinel、Cluster 和分片节点发现属于 M5，不能将其与 standalone SSH 转发等同处理。

## 连接错误类别

`SSH_HOST_KEY_UNTRUSTED`、`SSH_HOST_KEY_MISMATCH`、`SSH_AUTH_FAILED`、`TLS_ERROR`、`DB_AUTH_FAILED`、`NETWORK_TIMEOUT`、`INVALID_CONNECTION`、`SECURE_STORAGE_UNAVAILABLE`。M1 不一定完全覆盖所有厂商错误码，后续逐步精细分类。
