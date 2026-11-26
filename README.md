# 番茄时钟 · Pomodoro Timer

Windows 桌面番茄钟，支持专注和休息计时、可调快捷时长、悬浮小窗和到时提醒。使用记录、设置和导入的声音保存在本机。

## 开发

需要 Windows 10 或 11、WebView2、Visual Studio Build Tools 的 C++ 桌面开发组件、Node.js 24 LTS 和 Rust stable（MSVC，至少 1.90）。

```powershell
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 检查 TypeScript 类型与 Rust 格式 |
| `npm test` | 构建前端并运行 Rust 单元测试 |
| `npm run build` | 构建 Windows 可执行文件，输出到 `src-tauri/target/release/` |
| `npm run test:desktop` | 对已构建的可执行文件运行本机 Windows 桌面验收 |

`frontend/` 为 React 界面，`src-tauri/` 为 Rust 原生应用，`packaging/windows/` 包含 Windows 安装辅助脚本。

## 许可证

项目自有代码和文档采用 [MIT](LICENSE)。随仓库保留的 React Bits、字体和其他第三方材料适用各自许可证，见 [第三方许可](THIRD_PARTY_NOTICES.md)。

[贡献指南](CONTRIBUTING.md) · [安全问题报告](SECURITY.md)
