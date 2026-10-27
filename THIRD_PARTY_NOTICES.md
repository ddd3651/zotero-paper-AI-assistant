# 第三方开源组件说明

本插件使用了下面两个开源组件，帮助显示回答中的Markdown格式和数学公式。它们的代码和原始许可证都保存在`addon/vendor/`目录中。

## Marked 17.0.5

- **用途**：识别Markdown中的标题、列表、表格等格式。
- **来源**：[Marked官方项目](https://github.com/markedjs/marked)
- **许可证**：MIT，原文见[marked-LICENSE.md](addon/vendor/marked-LICENSE.md)。

插件用Marked识别格式，再按允许的内容生成界面，不直接插入它生成的HTML。

## KaTeX 0.16.22

- **用途**：把LaTeX公式转换成可在阅读面板中显示的数学公式。
- **来源**：[KaTeX官方项目](https://github.com/KaTeX/KaTeX)
- **许可证**：MIT，原文见[katex-LICENSE](addon/vendor/katex-LICENSE)。

公式在本机转换。插件关闭了KaTeX的受信任模式（`trust: false`），并且只保留允许的数学显示元素和属性。
