# Zotero Paper Chat - AI阅读助手

在Zotero里一边看论文，一边向AI提问。可以让它总结全文、解释公式、梳理方法，也可以选中一段原文追问。回答中的页码和章节链接可以直接点击，跳回PDF查看；引用附有准确原句时，还会临时高亮那句话。问答面板可以放在阅读器左侧或右侧。

插件可以使用本机Codex的ChatGPT登录和额度，也可以接入自己的模型API。模型、推理强度和自定义提示词都在面板底部的菜单中设置。Codex模式需要账号有使用权限和剩余额度；外部API按供应商计费，目前支持OpenAI兼容的Chat Completions接口，原生Anthropic Messages接口暂不支持。

## Windows安装

先安装Zotero 10.0.x、Node.js 22或更新版本，以及Python 3.9或更新版本。安装后重新打开PowerShell，运行下面两条命令，确认能显示版本号。

```powershell
node --version
py -3 --version
```

使用Codex模式时，还需要安装Windows原生Codex CLI，并通过ChatGPT账号登录。只用外部API可以跳过这一步。

```powershell
npm.cmd install -g @openai/codex
codex.cmd login
```

在仓库页面点击 **Code → Download ZIP**，把源码解压到准备长期保留的文件夹。在解压后的项目文件夹中打开PowerShell，运行打包命令。项目没有需要额外安装的npm运行依赖。

```powershell
py -3 scripts/build.py
```

打包完成后，在Zotero中打开 **工具 → 插件 → 齿轮菜单 → 从文件安装插件**，选择项目目录下的`dist/zotero-paper-chat-0.5.2.xpi`。打开PDF后会显示“AI论文助手”面板。

插件会自动启动本地服务。启动失败时，双击项目目录中的“启动伴读服务.cmd”查看错误。Codex路径设置见[Windows安装与验证](docs/WINDOWS.md)。

## macOS安装

先安装Zotero 10.0.x、Node.js 22或更新版本，以及Python 3.9或更新版本。使用Codex模式时，先确认本机Codex能正常运行，并已通过ChatGPT账号登录。

下载源码后，在项目文件夹中打开终端，运行`npm run build`。也可以用下面的命令下载并打包。

```sh
git clone https://github.com/ddd3651/zotero-paper-chat-clean.git
cd zotero-paper-chat-clean
npm run build
```

如果本机没有npm，可以直接运行`python3 scripts/build.py`。打包完成后，在Zotero中打开 **工具 → 插件 → 齿轮菜单 → 从文件安装插件**，选择`dist/zotero-paper-chat-0.5.2.xpi`，再打开PDF使用。

安装包会记录本机的Node.js和服务路径，请保留整个项目文件夹。移动文件夹、换电脑或分享给别人时，需要在目标电脑上重新打包、安装。

## 阅读和提问

打开论文后，直接在面板中输入问题，例如“总结全文，告诉我核心方法在哪几页”。想问某句话时，在PDF中选中文字，点击弹出的“向AI提问”，再输入问题并发送。选中的原文会加入这次提问的上下文，发送时才请求模型。

回答中的引用可以点击。页码从PDF第一页开始数，可能与论文印刷页码不同。高亮需要引用附有准确原句，并且能在该页唯一匹配；缺少原句、重复匹配或PDF文字提取不完整时，会跳到对应页。引用内容请对照原文查看。

点击面板底部的模型名称，可以选择Codex模型和推理强度，也可以填写外部API地址、模型名称和API Key。地址填到`/v1`这一层，例如`https://api.example.com/v1`，插件会追加`/chat/completions`。API Key留空保存会保留已有密钥，需要删除时勾选菜单中的清除选项并保存。

需要查网上资料时，在模型菜单中打开“联网搜索”。设置自动保存，下一次提问生效。搜索目前用于Codex模式，切换到外部API会关闭搜索。联网生成的查询词会用于检索，网页内容作为补充资料，论文依据仍需回到原文核对。

有些Codex回答会附带公开的推理摘要，插件收到后会显示这部分内容。当前外部API通道暂不显示摘要。

扫描版PDF需要先做OCR。插件目前主要读取文字，图表图片内部的细节需要自行查看。重启后也无法完整恢复聊天记录，重要回答请复制保存。

## 连接失败时

使用Codex模式时，先确认本机Codex能运行，并已通过ChatGPT账号登录。双击项目目录中的启动器可以查看服务错误：Windows使用“启动伴读服务.cmd”，macOS使用“启动伴读服务.command”。

代理地址变化后可以重新打包，构建时会自动记录不带账号密码的本机HTTP(S)代理。

## 配置和数据

本地服务只监听`127.0.0.1`，使用随机生成的本机连接密钥。外部API地址和密钥保存在`bridge/config.json`，不会提交到GitHub。Codex登录由Codex自己处理。

发送问题时，问题和读取到的论文文字会交给选定的模型服务。选中文字、点击“向AI提问”和打开设置都在本机完成。

## 修改提示词和界面文字

模型菜单中的自定义提示词可以用来调整回答方式。项目共用的默认提示词放在[bridge/prompts/default.md](bridge/prompts/default.md)，Codex和外部API都使用这个文件。直接编辑后，重启本地服务或Zotero，再开启新对话即可生效，无需重新打包。

按钮、输入框提示、状态、错误信息和插件名称都放在[addon/ui-text.json](addon/ui-text.json)。搜索界面上看到的文字就能找到对应位置。例如，把`"send": "发送"`改成`"send": "提问"`，发送按钮就会显示“提问”。编辑时保留键名、JSON引号和逗号，以及`{page}`、`{value1}`等占位符。

修改界面文字后，运行`npm run build`，重新安装XPI并重启Zotero。服务端错误文案在本地服务重启后生效。模型回答、论文原文和供应商返回的模型名称由运行时生成，界面文案文件只管理固定文字。

## 打包和分享源码

下面三条命令分别用于生成本机安装包、分享源码和检查发布文件。

```sh
npm run build          # 生成本机安装包
npm run pack:source    # 生成源码ZIP
npm run check:publish  # 检查发布文件
```

源码ZIP保存在`dist/`中，不包含本机配置、API Key、PDF、聊天记录或本机生成的XPI。GitHub Actions上传的源码包也使用这个范围。

## 升级到0.5.2

0.5.2改用了项目统一的插件标识。已安装旧版时，先在Zotero插件管理中移除旧插件，再安装新版XPI，避免两个版本同时运行。项目目录中的API配置和界面设置可以继续使用。

## 开发和兼容情况

项目使用Node.js 24做开发验证。三平台自动测试，以及Windows、macOS的真实Zotero桌面冒烟测试已通过。桌面测试使用本地模拟模型，Windows的真实Codex登录和模型请求仍需单独验证，具体范围见[Windows安装与验证](docs/WINDOWS.md)。

代码按下面的目录组织：

```text
addon/      Zotero面板、选区、排版和原文定位
bridge/     本地服务、Codex和外部API接入
scripts/    打包及发布检查
test/       自动测试
docs/       开发说明
```

本地测试使用模拟服务，无需真实模型密钥。

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

开发说明见[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，第三方组件和许可证见[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
