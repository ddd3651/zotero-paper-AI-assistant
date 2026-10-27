# Windows 安装与验证

当前状态：已实现 Windows 兼容路径和回归测试，并接入三平台 GitHub Actions 自动验证；每个提交的运行结果请在仓库 Actions 页面确认。真实 Windows Zotero 桌面已有自动冒烟验证；真实模型登录仍需独立验收。现有 macOS 功能需继续保留。目标范围为 Windows 10/11 x64、Node.js 22+、Python 3.9+ 和 Zotero 10.0.x；ARM64、WSL 和其他 Zotero 版本尚未验证。

## 安装

1. 安装 Windows 原生 Zotero、Node.js 和 Python。重新打开终端，确认 `node --version` 和 `py -3 --version` 可运行。
2. 使用 Codex 模式时，安装 Windows 原生 Codex CLI（例如 `npm install -g @openai/codex`），执行 `codex login` 并通过 ChatGPT 账号登录。只使用外部 API 时可跳过此项。WSL 中的 CLI 不能由 Windows Zotero 直接调用。
3. 将源码放在当前用户的私有目录，运行 `npm run build`。也可直接用 `py -3 scripts/build.py`。不需要 `npm install` 项目依赖。
4. 在 Zotero 的工具 → 插件 → 从文件安装插件中选择 `dist/zotero-paper-chat-0.5.2.xpi`。保留源码目录；移动后重新构建和安装。
5. 打开 PDF。自动启动失败时，双击源码根目录的“启动伴读服务.cmd”，或运行 `npm start` 查看诊断。

本机 XPI 含绝对路径和连接令牌，不能分享。分享源码请运行 `npm run pack:source`。

## Codex 路径

默认支持 PATH 上的 `codex.exe`、npm 安装和当前用户 `%APPDATA%/npm` 下的 npm 安装。自定义安装可在启动 Zotero 前设置 `PAPER_CHAT_CODEX`，指向实际的 `codex.exe`、`codex.js`，或具有相邻 npm 包的 `codex.cmd`。任意第三方 `.cmd` 包装脚本不执行，错误会明确提示。环境变量变化后需退出 Zotero 和旧本地服务，再重新启动。

企业策略禁止 PowerShell 时，可在终端使用 `npm start`；无需修改系统执行策略。Node 与 Codex 更新后若路径变化，重新打包。

## Windows 验收清单

- 在 Windows 上运行 `npm test`、`py -3 -m unittest discover -s test -p '*_test.py'`、`npm run build`、`npm run check:publish`、`npm run pack:source`。
- 源码路径分别包含空格、中文、`&`、`%`、`!`、单引号，验证自动启动和手动启动器、XPI 安装与重启。
- 用原生 exe 和 npm Codex 两种安装检查 ChatGPT 登录、模型列表、流式问答、取消、公开摘要和联网开关。禁止用 mock 结果替代这一项。
- 使用测试 PDF 验证页码跳转、唯一原句高亮、选段提问、Markdown/公式/表格、复制和 Ctrl+C/Ctrl+Enter、字体、缩放、左右面板。
- 在用户授权的测试模型上验证外部 API 设置保存、错误提示和模式切换，不修改生产数据。
- 检查服务只监听回环地址，验证错误令牌拒绝、退出重启、端口占用和源码包不含配置；确认当前用户目录的 NTFS 访问权限符合使用场景。
- 在 macOS 重复主要界面与真实模型交互，确保已有行为没有变化。

## 自动桌面冒烟的范围

`windows-zotero-smoke` 在一次性 GitHub Windows Server 2025 x64 桌面上下载官方 Zotero 10.0.6 ZIP，验证 Authenticode 签名，用独立 profile 和合成两页 PDF 安装本分支构建的原始 XPI。通过真实键盘/鼠标检查 Ctrl+Enter 发送、PDF 文本提取、自动启动 Node 桥接、模拟 CLI 回复、表格/MathML、引用页跳转/原文高亮和设置面板开关。profile/PDF/应用目录包含中文、空格与特殊字符；源码和 Node 则位于 runner 的标准安装路径。

模型是明确标注 `TEST ONLY` 的本地 JSON-RPC mock，未使用任何真实账号、凭据或个人论文。它只能证明插件到桥接及协议往返正常，不能证明 Codex 登录、真实推理、联网、外部 API 或取消交互通过。Windows 10/11 用户桌面、所有安装路径组合、手动启动器的实际执行和真实模型的 macOS GUI 回归仍需独立验收。

每次运行上传 `windows-zotero-smoke-evidence`，包含原始 `desktop.png`、`result.json`、签名/系统信息和已清除测试令牌的日志，保留 7 天。源码 ZIP 不含本机 XPI、profile 或测试产物。CI 只测试、构建和上传产物，不创建 PR、合并、发布或部署。

## macOS 回归

`macos-zotero-smoke` 在一次性 macOS runner 使用官方签名 Zotero 10.0.6、独立 profile、合成 PDF 和本地 mock。验证生成的 `.command` 手动启动器、插件自动启动、阅读器关闭重开、面板反复开关、⌘Enter、引用跳页/高亮、表格/MathML 和设置保存。使用原生鼠标/键盘事件，不改用户 profile 或全局设置；不调用真实模型。每次结果和原始截图保存在 `macos-zotero-smoke-evidence`（7 天）。运行成功表示已覆盖路径无已发现回归，不代表所有 macOS/模型组合或绝对无缺陷。
