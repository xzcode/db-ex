# macOS 安装与“App 已损坏”提示

DB EX v0.5.0 是开发预览版。该版本的 macOS ARM64 DMG/ZIP **没有 Developer ID 签名或 Apple 公证**。GitHub Actions macOS 构建记录明确报告：
- "default Electron icon is used"
- "skipped macOS application code signing" (CSC_IDENTITY_AUTO_DISCOVERY=false)

这些不是已签名/已公证版本；打包后启动的 CI smoke 测试通过，并不等于 Gatekeeper 验证通过。

## 先验证下载来源和完整性

只从项目 GitHub Release 下载。当前 v0.5.0 macOS DMG 名称为 DB.EX-0.5.0-mac-arm64.dmg。

验证下载文件：

    shasum -a 256 "$HOME/Downloads/DB.EX-0.5.0-mac-arm64.dmg"

将输出与 Release 里的 SHA256SUMS-macOS-ARM64.txt 核对。**不一致就删除并重新下载，不要尝试绕过系统保护。** DMG 无法挂载或系统提示磁盘映像损坏时，也要首先检查下载完整性。

## 下载完整，但 macOS 提示“DB EX.app 已损坏，无法打开”

1. 从已校验的 DMG 将 DB EX.app 拖入 /Applications。
2. 若「系统设置 → 隐私与安全性」提供“仍要打开”，可以先尝试该系统入口。
3. 仅在确认安装包来自可信的本仓库且 SHA-256 与 Release 一致后，可对该应用移除下载隔离属性：

    xattr -dr com.apple.quarantine "/Applications/DB EX.app"
    open "/Applications/DB EX.app"

这是针对明确来源的个人开发版本的临时绕过方式。**不要**运行 spctl --master-disable、关闭整个系统的 Gatekeeper，或对不信任的 App 执行 xattr。

如果仍无法打开，保留真实报错并收集：

    ls -ld "/Applications/DB EX.app"
    xattr -lr "/Applications/DB EX.app" | head -50
    spctl --assess --type execute -vv "/Applications/DB EX.app" 2>&1

未签名应用的 spctl 评估失败属于预期情况；请提供完整错误文本，不要上传密码或敏感连接信息。

## 正式消除 Gatekeeper 拦截

必须使用有效的 Apple Developer ID Application 证书签名 macOS App，并完成 notarization、公证凭据配置及 stapling，在干净 macOS 设备上从浏览器重新下载后实测。**仅更换图标、改名或再次生成 DMG 不能实现这个目标。**

接下来的开发分支已经提供自定义应用图标（macOS ICNS、Windows ICO、Linux PNG），但它只会出现在使用该分支重新打包的后续版本，不能回溯修改 v0.5.0 已发布文件。
