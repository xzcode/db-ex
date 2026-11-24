# DB EX macOS RC3 — GitHub Actions 受阻时的本机构建方式

## 为什么需要备用流程

部分 GitHub-hosted Actions 作业出现 `runner_id=0`、`steps=[]`、无作业日志，并在数秒内失败。作业没有进入签名或打包步骤。GitHub 账户 Actions 额度/账单、Actions 政策或 Runner 调度均可能导致这一现象；尚未证实具体原因。

## Apple Silicon Mac 本机打包

要求 macOS ARM64、Node.js 22+、Xcode Command Line Tools；克隆仓库需要 GitHub 私有仓库访问权。

```bash
git clone -b release/dbex-approved-icon-rc3 https://github.com/xzcode/db-ex.git
cd db-ex
bash scripts/build-macos-local.sh
```

以上流程会依次执行：
- `npm ci` 安装锁定依赖；
- TypeScript 类型检查、生产前端构建；
- 受 SHA-256 固定的原始图标源和三颗彩色指示灯自动测试；
- Electron Builder 创建 Ad-hoc 签名 macOS ARM64 DMG/ZIP；
- `codesign --verify --deep --strict` 与应用 bundle 内 ICNS 检查；
- 打包应用的实际 Electron 窗口、隔离 IPC、Monaco/SQL 编辑器启动测试；
- 记录 DMG、ZIP 的 SHA-256。

生成文件：
- `release/DB-EX-icon-rc3-macos-arm64.dmg`
- `release/DB-EX-icon-rc3-macos-arm64.zip`
- `release/SHA256SUMS-Icon-RC3.txt`

默认只在本地打包，不改变 GitHub Release。若已安装且登录 GitHub CLI，可以**主动显式执行**：

```bash
bash scripts/build-macos-local.sh --publish
```

此命令会重新运行完整构建，然后新建独立的 **Draft + Prerelease**，上传三份安装包资源。不会覆盖 v0.5.0、RC1 或 RC2，也不会自动将草稿公开。公开之前请人工核对版本、安装包下载和校验值。

**注意**：Ad-hoc 签名不等于 Apple Developer ID 签名或公证。此处只是离线构建替代方法；应在实际下载机器上测试 Gatekeeper 提示。不建议关闭全局 Gatekeeper。
