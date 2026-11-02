# 开发与测试

## 项目结构

这是一个 Zotero 插件加本地 Node.js 服务。插件负责界面和 PDF 读取，服务负责连接 Codex 或外部 API。没有前端构建器，也没有需要下载的 npm 运行依赖；Marked 和 KaTeX 的发行文件及许可证已放在 `addon/vendor/`。

## 本地运行

1. 运行 `npm run build`，生成本机配置和 XPI。
2. 在 Zotero 的插件页面安装 XPI。
3. 插件会自动启动服务。需要看服务输出时，运行 `npm start` 或双击生成的启动脚本。

修改 `addon/` 后需要重新构建并安装。修改 `bridge/` 后需要重启本地服务。配置和历史保存在固定用户目录，位置与备份方式见下面的数据存放说明。

## 数据存放与迁移

macOS使用`~/Library/Application Support/Zotero Paper Chat/`，Windows使用`%APPDATA%\Zotero Paper Chat\`，Linux使用`$XDG_DATA_HOME/Zotero Paper Chat/`，未设置XDG时使用`~/.local/share/Zotero Paper Chat/`。`PAPER_CHAT_DATA_DIR`可覆盖默认位置，测试和CI应指向临时目录。

`config.json`保存配置，`conversations/`保存完整对话与摘要，`runtime/`作为Codex工作目录，`backups/`保存原始旧配置。迁移只复制文件：先核对完整备份，再导入旧配置和历史；已有目标文件优先，旧文件保留。`migrations/`记录完成状态，避免用户删除的旧会话在每次启动时重新出现。失败时停止并保留原文件，完成之前不会写入成功标记，修复后可以重试。

`bridge/paths.mjs`导出`resolveRuntimePaths(legacyConfigFile, {dataDir})`，返回`{dataDir, configFile, historyDir, runtimeDir, legacyHistoryDir}`。`dataDir`显式参数优先于环境变量。构建脚本通过它的CLI完成同一迁移：`node bridge/paths.mjs --resolve legacy-config-file --data-dir directory`。CLI只输出路径，不输出配置内容。迁移模块不会修改上下文容量或其他配置字段。

服务只在main入口解析`--data-dir`、调用迁移函数，随后读取返回的`configFile`，将`historyDir`传入`createBridge`，将`runtimeDir`用于Codex工作目录。导入模块和直接调用测试用`createBridge({configFile: 临时路径, ...})`时，不进行全局目录迁移。安装包的`PaperChatConfig.dataDir`及生成启动器的`--data-dir`保持路径一致。

迁移测试只使用临时目录与合成配置，不访问Zotero profile。POSIX中新建目录为0700、配置与备份文件为0600；Windows使用当前用户的APPDATA目录，文件权限仍受NTFS ACL控制。原子迁移通过临时文件与不覆盖目标的硬链接完成；数据目录所在文件系统需支持硬链接，例如NTFS。文件系统不支持时会停止迁移并保留原文件。

源码打包与发布检查会排除当前固定数据目录，即使临时覆盖路径位于项目内，也会从扫描范围中移除。发布检查同时核对旧配置和固定配置中的已知连接令牌/API密钥，只报告命中的源码文件名。生成的XPI只包含连接所需的本机路径和令牌，不包含配置文件、API密钥、历史或备份。

## 默认提示词

直接编辑 `bridge/prompts/default.md`。`bridge/paper.mjs` 在服务启动时按 UTF-8 读取它，Codex 的高层指令和外部 API 的 system 消息共用这份内容。提示词会包含在源码包中。

修改后重启本地服务并开启新对话，不需要重新构建 XPI。界面里的自定义提示词仍会叠加在这份默认提示词上，按原有优先级处理。

## 测试

- `npm test`：Node.js 内置测试，无需安装测试框架。
- `python3 -m unittest discover -s test -p '*_test.py'`：验证打包、源码导出和隐私文件排除。
- `npm run check:publish`：检查可发布清单中是否含个人绝对路径或当前配置里的真实凭据。

部分测试会监听本地随机端口；运行环境需要允许本机回环连接。测试不会调用真实模型。

改 UI 后，仍需在真实 Zotero 阅读窗口中检查交互。只通过服务健康检查不能证明真实问答或按钮工作正常。

## 发布

`npm run pack:source` 使用显式文件清单生成确定性的源码 ZIP。不会打包 `tmp/`、`dist/`、`bridge/runtime/`中的历史对话和摘要、本机配置、开发验证记录、PDF 或生成的启动脚本。GitHub Actions 执行测试后，将这个 ZIP 保存为构建产物。

本机 XPI 包含本地服务路径和本机连接密钥，不能作为通用 Release 附件。要给另一台电脑使用，请分享源码，让使用者在目标电脑上构建。

## 开发边界

- PDF、选区和历史回答是模型的资料，不是执行命令的指令。
- 保留 Codex 登录模式和外部 API 模式的明确区分，不静默更换供应商。
- Codex 只接公开推理摘要，不把原始内部推理转给界面。
- 本机配置和密钥不进入 Git，不在错误输出中打印它们。

## 联网搜索

`webSearch` 默认为 false；Codex 线程分别使用 `web_search: "live"` 或 `"disabled"`。开关变化会重建线程并重放已有论文上下文，避免关闭后继续使用旧线程的搜索能力。本机命令、Apps 和插件工具仍关闭。

默认提示词保持论文页码规则；联网开启时，服务额外添加网页来源规则，网络结论使用普通 Markdown URL，不伪装成 PDF 证据。界面展示真实 `webSearch` 工具事件的查询状态和次数。当前通用 Chat Completions 通道没有统一搜索协议，因此禁用此开关并拒绝 API 层的强制开启。

配置依据：[官方 Codex 搜索文档](https://learn.chatgpt.com/docs/web-search)。

## Windows 适配与验证边界

`npm` 脚本通过 `scripts/python.mjs` 探测 Python 3.9+；Windows 优先使用 `py -3`。Node 测试通过内置发现机制运行，避免依赖 shell 展开通配符。

Windows Codex 查找依次使用显式 `PAPER_CHAT_CODEX`、PATH 各目录以及 `%APPDATA%/npm`。原生 `codex.exe` 直接启动；npm 安装使用 Node 执行相邻 `node_modules/@openai/codex/bin/codex.js`，不通过命令 shell 拼接参数。macOS 原有 Codex 应用和 Homebrew 路径保持原有顺序。

Windows 启动器用 PowerShell 的 UTF-16LE 编码命令传递单引号转义后的路径，支持空格、中文及 shell 特殊字符。没有设置 ExecutionPolicy bypass。自动启动由 Zotero `nsIProcess.runwAsync` 向 Node 传递独立参数；Windows 设置 `startHidden/noShell` 避免弹出控制台抢焦点。挂载面板前等待内部 PDF 窗口就绪，已就绪的阅读器不额外等待。Windows 自定义工具栏按钮显式设为 `-moz-window-dragging: no-drag`，避免继承 Zotero 工具栏的窗口拖动区域而吞掉点击；macOS 样式保持原样。

CI 包含 Linux/macOS/Windows 三平台测试、当地构建和源码打包，以及真实 Windows/macOS Zotero 桌面冒烟。macOS 额外执行生成的 `.command` 启动器，再停掉测试服务，验证插件自动启动。两个桌面都检查阅读器重开、面板反复开关、模拟问答和设置保存。桌面使用官方签名程序、隔离 profile、合成 PDF 和本地 mock 模型，上传原始截图与结果；运行结果以相应提交的 Actions 为准。Windows 分支单元测试和 macOS 子进程测试不等于 Windows 实机验证；本项目没有执行交叉构建。具体覆盖与真实模型未验项见 [WINDOWS.md](WINDOWS.md)。

配置在 POSIX 系统继续使用 0600。Windows 的 chmod 不能证明 NTFS ACL 只允许当前用户访问；请放在当前用户的私有目录。测试只在 POSIX 断言 0600，所有平台仍检查配置内容、原子保存和发布排除。不会自动更改系统 ACL。
