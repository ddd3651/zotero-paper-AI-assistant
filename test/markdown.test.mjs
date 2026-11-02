import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const scope = createUIContext({});
for (const name of ['vendor/marked.umd.js', 'vendor/katex.min.js', 'core.js', 'math.js', 'markdown.js']) {
  vm.runInContext(readFileSync(new URL('../addon/' + name, import.meta.url), 'utf8'), scope);
}
// Minimal DOM fixture; assertions inspect the semantic output of the real parser and renderer.
class Node {
  constructor(tag = '#fragment', text = '') { this.tag = tag; this.children = []; this.value = text; this.attrs = {}; this.style = {}; this.events = {}; }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map(n => n.textContent).join(''); }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
}
const doc = { createElementNS: (_, tag) => new Node(tag), createTextNode: text => new Node('#text', text), createDocumentFragment: () => new Node() };
const all = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap(n => all(n, tag))];
const render = (text, options = {}) => scope.PaperChatMarkdown.render(doc, text, { pageCount: 5, allowedPages: new Set([3]), ...options });

test('Markdown does not inject per-paragraph copy controls or consume text width', () => {
  const pages = [];
  const result = render('# 标题\n\n段落 **粗体** [第3页]\n\n```js\nconst n = 1;\n```', {
    navigate: page => pages.push(page),
  });
  assert.equal(all(result, 'button').length, 0);
  assert.equal(all(result, 'pre')[0].textContent, 'const n = 1;');
  all(result, 'a')[0].events.click({ preventDefault() {} });
  assert.deepEqual(pages, [3]);
});

test('ATX and setext headings become heading elements, with bold and italic inline text', () => {
  const result = render('# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n**重点**和*术语*。\n\n下划线标题\n---');
  assert.equal(all(result, 'h1')[0].textContent, '一级标题');
  assert.equal(all(result, 'h2').length, 2);
  assert.equal(all(result, 'h3')[0].textContent, '三级标题');
  assert.equal(all(result, 'strong')[0].textContent, '重点');
  assert.equal(all(result, 'em')[0].textContent, '术语');
});

test('Chinese bold can end in punctuation directly before Chinese or Latin prose', () => {
  for (const [source, bold, text] of [
    ['**动态调整，就是...。**论文将继续', '动态调整，就是...。', '动态调整，就是...。论文将继续'],
    ['**本论文...。**LoRA', '本论文...。', '本论文...。LoRA'],
    ['先看**结论！**然后讨论', '结论！', '先看结论！然后讨论'],
    ['**中文.**English', '中文.', '中文.English'],
    ['**English.**中文', 'English.', 'English.中文'],
    ['中文**「关键词」**之后', '「关键词」', '中文「关键词」之后'],
    ['中文**(English)**之后', '(English)', '中文(English)之后'],
    ['中文**“结果。”**LoRA', '“结果。”', '中文“结果。”LoRA'],
  ]) {
    const result = render(source);
    assert.deepEqual(all(result, 'strong').map(node => node.textContent), [bold], source);
    assert.equal(result.textContent, text, source);
  }
});

test('Chinese punctuation compatibility keeps separate bold spans and normal inline nesting', () => {
  const result = render('**第一句。**然后**第二句！**接着 **含*术语*和`a ** b`。**结束');
  assert.deepEqual(all(result, 'strong').map(node => node.textContent), ['第一句。', '第二句！', '含术语和a ** b。']);
  assert.equal(all(result, 'em')[0].textContent, '术语');
  assert.equal(all(result, 'code')[0].textContent, 'a ** b');
  assert.equal(result.textContent, '第一句。然后第二句！接着 含术语和a ** b。结束');
  const inlineCode = render('中文**`a ** b`。**之后');
  assert.equal(all(inlineCode, 'strong')[0].textContent, 'a ** b。');
  assert.equal(all(inlineCode, 'code')[0].textContent, 'a ** b');
  const escaped = render('**\\*\\*字面量\\*\\*。**之后 **感叹号\\!**之后');
  assert.deepEqual(all(escaped, 'strong').map(node => node.textContent), ['**字面量**。', '感叹号!']);
});

test('bold compatibility leaves code blocks, code spans and escaped markers literal', () => {
  const source = '\\*\\*中文。\\*\\*随后 `**中文。**之后` ``code ` **中文。**之后``\n\n```md\n**中文。**之后\n```\n\n    **缩进代码。**之后';
  const result = render(source);
  assert.equal(all(result, 'strong').length, 0);
  assert.deepEqual(all(result, 'code').map(node => node.textContent), [
    '**中文。**之后', 'code ` **中文。**之后', '**中文。**之后', '**缩进代码。**之后',
  ]);
  assert.match(result.textContent, /^\*\*中文。\*\*随后 /);
  const mixed = render('`**不加粗。**之后` **真正加粗。**随后');
  assert.deepEqual(all(mixed, 'strong').map(node => node.textContent), ['真正加粗。']);
  assert.equal(all(mixed, 'code')[0].textContent, '**不加粗。**之后');
});

test('English delimiter rules, whitespace and unfinished Chinese bold stay predictable', () => {
  for (const source of ['**before.**after', 'a**"quoted"**b', '** 中文。**后文', '**中文。 **后文', '**未完成。', '**', 'a__word__b']) {
    const result = render(source);
    assert.equal(all(result, 'strong').length, 0, source);
    assert.equal(result.textContent, source, source);
  }
  const ordinary = render('**English** and ***both*** and __bold__');
  assert.deepEqual(all(ordinary, 'strong').map(node => node.textContent), ['English', 'both', 'bold']);
  assert.equal(all(ordinary, 'em')[0].textContent, 'both');
});

test('Chinese bold works in headings, quotes, lists and table cells', () => {
  const result = render('# **标题。**正文\n\n> **引用。**正文\n\n- **条目。**正文\n\n| 列 |\n| --- |\n| **内容。**正文 |');
  for (const [tag, expected] of [['h1', '标题。'], ['blockquote', '引用。'], ['li', '条目。'], ['td', '内容。']]) {
    assert.equal(all(all(result, tag)[0], 'strong')[0].textContent, expected);
  }
});

test('Chinese bold preserves inert HTML, link targets and citation metadata', () => {
  const navigated = [], opened = [];
  const result = render('**中文。**后文 **<img src=x onerror=alert(1)>结果。**随后 **[网页。](https://example.com/a**b "标题 ** 原样")。**后文 **[第3页 · §2](paperchat:3 "原句 ** 原样")。**随后 **[恶意。](javascript:alert(1))。**后文', {
    navigate: (page, details) => navigated.push({ page, ...details }),
    openLink: href => opened.push(href),
  });
  assert.equal(all(result, 'strong').length, 5);
  assert.equal(all(result, 'img').length, 0);
  assert.equal(all(result, 'script').length, 0);
  assert.match(result.textContent, /<img src=x onerror=alert\(1\)>/);
  const links = all(result, 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].title, '标题 ** 原样');
  links[0].events.click({ preventDefault() {} });
  links[1].events.click({ preventDefault() {} });
  assert.deepEqual(opened, ['https://example.com/a**b']);
  assert.deepEqual(navigated, [{ page: 3, quote: '原句 ** 原样', section: '2' }]);
  const label = render('**[中文。](https://example.com)。**English');
  assert.equal(all(label, 'strong')[0].textContent, '中文。。');
  assert.equal(all(label, 'a')[0].href, 'https://example.com');
  const inside = render('[**中文。**后文](https://example.com "**原样**")');
  assert.equal(all(inside, 'strong')[0].textContent, '中文。');
  assert.equal(all(inside, 'a')[0].title, '**原样**');
});

test('math remains a math token and its literal stars never close Chinese bold', () => {
  const oldRender = scope.PaperChatMath.render;
  scope.PaperChatMath.render = (_, tex) => new Node('math', tex);
  try {
    const source = '**公式 $\\text{**不是加粗。**}$ 和结论。**后文 \\(\\text{**原样。**}\\)';
    const result = render(source);
    assert.deepEqual(all(result, 'strong').map(node => node.textContent), ['公式 \\text{**不是加粗。**} 和结论。']);
    assert.deepEqual(all(result, 'math').map(node => node.textContent), ['\\text{**不是加粗。**}', '\\text{**原样。**}']);
    assert.equal(all(all(result, 'math')[0], 'strong').length, 0);
    const mathFirst = render('中文**$x$。**后文');
    assert.equal(all(mathFirst, 'strong')[0].textContent, 'x。');
    assert.equal(all(mathFirst, 'math')[0].textContent, 'x');
  } finally {
    scope.PaperChatMath.render = oldRender;
  }
});
test('nested lists, quotes, separators and GFM tables retain their structure', () => {
  const result = render('1. 第一步\n   - 子项\n2. 第二步\n\n> 引用\n\n---\n\n| 方法 | 页码 |\n| :--- | ---: |\n| **A** | [第3页] |');
  assert.equal(all(result, 'ol').length, 1);
  assert.equal(all(result, 'ul').length, 1);
  assert.equal(all(result, 'blockquote')[0].textContent, '引用');
  assert.equal(all(result, 'hr').length, 1);
  assert.equal(all(result, 'table').length, 1);
  assert.equal(all(result, 'th').length, 2);
  assert.equal(all(result, 'td')[1].style.textAlign, 'right');
});
test('page links work in headings, bold and tables but are not created in code', () => {
  const pages = [];
  const result = render('# 方法 [第3页]\n\n**结果[第3页]** [第4页]\n\n`[第3页]`\n\n```js\n[第3页]\n```', { navigate: n => pages.push(n) });
  const links = all(result, 'a');
  assert.equal(links.length, 2);
  links[0].events.click({ preventDefault() {} });
  assert.deepEqual(pages, [3]);
  assert.equal(all(result, 'code').length, 2);
  assert.equal(all(result, 'pre')[0].textContent, '[第3页]');
});
test('HTML and unsafe link schemes stay inert, and images never trigger requests', () => {
  const result = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![remote](https://example.com/a.png)\n\n[site](https://example.com)');
  assert.equal(all(result, 'script').length, 0);
  assert.equal(all(result, 'img').length, 0);
  assert.equal(all(result, 'a').length, 1);
  assert.equal(all(result, 'a')[0].href, 'https://example.com');
  assert.match(result.textContent, /<script>/);
});
test('partial streaming tokens render without throwing', () => {
  for (const text of ['#', '## 标题\n\n**未完成', '```python\nprint(1)', '| 列 |\n| --- |\n| 未完成', '结论[第']) {
    assert.doesNotThrow(() => render(text));
  }
});

test('rich citations carry decoded evidence and section to the parent callbacks', () => {
  const described = [], navigated = [];
  const result = render('[第3页 · §2.2.1 **标题**](paperchat:3 "A &amp; B &#xFB01;nd &quot;it&quot;")', {
    describeCitation(page, details) {
      described.push({ page, ...details });
      return { label: '第3页 · §2.2 核实后的标题', title: '核实后的提示' };
    },
    navigate: (page, details) => navigated.push({ page, ...details }),
    openLink() { assert.fail('citations must not open external links'); },
  });
  const links = all(result, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].className, 'pc-cite');
  assert.equal(links[0].href, '#');
  assert.equal(links[0].textContent, '第3页 · §2.2 核实后的标题');
  assert.equal(links[0].title, '核实后的提示');
  let prevented = false;
  links[0].events.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const expected = [{ page: 3, quote: 'A & B ﬁnd "it"', section: '2.2.1 标题' }];
  assert.deepEqual(described, expected);
  assert.deepEqual(navigated, expected);
});

test('default rich labels and parent descriptions are safe text', () => {
  const result = render('[第3页 · §2.2 &lt;img src=x&gt;](paperchat:3 "&lt;script&gt;")');
  const link = all(result, 'a')[0];
  assert.equal(link.textContent, '第3页 · §2.2 <img src=x>');
  assert.equal(link.title, '<script>');
  assert.equal(all(result, 'img').length, 0);
  assert.equal(all(result, 'script').length, 0);
  const described = render('[第3页](paperchat:3)', {
    describeCitation: () => ({ label: '<script>literal label</script>', title: '<img>' }),
  });
  assert.equal(all(described, 'a')[0].textContent, '<script>literal label</script>');
  assert.equal(all(described, 'script').length, 0);
});

test('legacy citations request default section labels with empty metadata', () => {
  const described = [], navigated = [];
  const result = render('正文[第3页] [第4页]', {
    describeCitation(page, details) {
      described.push({ page, ...details });
      assert.deepEqual(Object.keys(details), []);
      return { label: `第${page}页 · §1 引言` };
    },
    navigate: (page, details) => navigated.push({ page, ...details }),
  });
  const links = all(result, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, '第3页 · §1 引言');
  assert.equal(links[0].title, '跳转至本文PDF第 3 页');
  links[0].events.click({ preventDefault() {} });
  assert.deepEqual(described, [{ page: 3 }]);
  assert.deepEqual(navigated, [{ page: 3 }]);
  assert.equal(all(render('[第3页]'), 'a')[0].textContent, '第 3 页');
});

test('only an exact paperchat page target in the available range is clickable', () => {
  const targets = ['paperchat:0', 'paperchat:4', 'paperchat:6', 'paperchat:-3', 'paperchat:3.0',
    'paperchat:3e0', 'paperchat:03', 'paperchat:3/extra', 'paperchat:3?x', 'paperchat:3#x',
    'paperchat://3', 'PAPERCHAT:3', 'paperchat:9007199254740993', 'javascript:alert(1)', 'unknown:3'];
  for (const target of targets) {
    const result = render(`[第3页 · [第3页]](${target} "原句")`, {
      describeCitation() { assert.fail(`inert target described: ${target}`); },
    });
    assert.equal(all(result, 'a').length, 0, target);
    assert.match(result.textContent, /第3页/);
  }
  assert.equal(all(render('[第3页](paperchat:3)', { allowedPages: new Set() }), 'a').length, 0);
  assert.equal(all(render('[第3页](paperchat:3)', { pageCount: 0 }), 'a').length, 0);
  assert.equal(all(render('[第2页](paperchat:2)', { allowedPages: undefined }), 'a').length, 1);
  assert.equal(scope.PaperChatCore.isAllowedPage(9007199254740992, Infinity), false);
});

test('rich and legacy citations work across inline contexts while code stays literal', () => {
  const result = render('# 标题 [第3页 · §1](paperchat:3 "原句")\n\n**[第3页]**\n\n| 引用 |\n| --- |\n| [第3页 · §2](paperchat:3 "另一句") |\n\n`[第3页 · §3](paperchat:3 "句子") [第3页]`\n\n```md\n[第3页](paperchat:3 "原句") [第3页]\n```');
  assert.equal(all(result, 'a').length, 3);
  assert.equal(all(all(result, 'h1')[0], 'a').length, 1);
  assert.equal(all(all(result, 'td')[0], 'a').length, 1);
  for (const code of all(result, 'code')) {
    assert.equal(all(code, 'a').length, 0);
    assert.match(code.textContent, /paperchat:3/);
    assert.match(code.textContent, /\[第3页\]/);
  }
});

test('quote limits apply after entity decoding and oversize quotes are discarded', () => {
  const cases = [
    ['&#65;'.repeat(1500), 'A'.repeat(1500)],
    ['&#65;'.repeat(1501), ''],
    ['x'.repeat(1501), ''],
    ['', ''],
  ];
  for (const [title, expected] of cases) {
    const navigated = [];
    const result = render(`[第3页](paperchat:3 "${title}")`, {
      navigate: (page, details) => navigated.push({ page, ...details }),
    });
    all(result, 'a')[0].events.click({ preventDefault() {} });
    assert.deepEqual(navigated, [{ page: 3, quote: expected, section: '' }]);
  }
});

test('web links keep their external callback without nested citation links', () => {
  const opened = [];
  const result = render('[**网页** [第3页]](https://example.com "标题 &amp; 提示")', {
    openLink: href => opened.push(href),
    navigate() { assert.fail('web labels must not create citations'); },
  });
  const links = all(result, 'a');
  assert.equal(links.length, 1);
  assert.equal(all(links[0], 'strong')[0].textContent, '网页');
  assert.equal(links[0].title, '标题 & 提示');
  links[0].events.click({ preventDefault() {} });
  assert.deepEqual(opened, ['https://example.com']);
});
