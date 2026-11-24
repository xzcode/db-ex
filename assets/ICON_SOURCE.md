# DB EX 官方应用图标（用户确认版）

唯一来源：`assets/approved-icon-source.000.txt` 至 `003.txt`，四段拼接后是一个 Base64 编码的 384×384 带透明通道 PNG。

这是此前确认“这个可以”的 **深蓝圆角底板、青蓝色细线数据库圆柱、右侧青／紫／青三颗状态点** 原图经居中裁切、去掉预览棋盘背景和保色缩小得到的资源，**不是旧脚本凭几何重新绘制**。由于 GitHub 文本 API 写入限制，二进制源分成四个短 Base64 文件；不可任意修改。

原图源文件 SHA-256：

```text
068ee4c0ae1c9f59da28b337c3e58508b9e437bcb59fe6413aee913e5a5d750f
```

运行 `npm run icons` 从这份受校验的源文件生成：
- `build/icon.png`（1024×1024 RGBA，Linux）
- `build/icon.ico`（Windows 多尺寸）
- `build/icon.icns`（macOS 多尺寸）

`npm run build` 已自动调用此生成器。该 PNG 源不是透明棋盘截图：仅保留实际深色应用图标，透明角被单独处理。`tests/icon-generator.test.ts` 校验源 SHA、图标色彩／三颗指示点／边缘透明度，以及 ICO/ICNS 容器格式。安装包必须在对应平台构建检查通过后发布。

**发布版本不会自动更新**：旧 Release 的 DMG/EXE/AppImage 仍含旧图标；必须重新构建并创建新的 Release，不能改写旧文件冒充更新。
