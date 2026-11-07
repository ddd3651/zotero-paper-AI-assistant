import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createUIContext } from '../scripts/test-ui-context.mjs';

const scope = createUIContext();
vm.runInContext(readFileSync(new URL('../addon/export.js', import.meta.url), 'utf8'), scope);
const api = scope.PaperChatExport;
const measure = { measureText: text => ({ width: Array.from(text).length * 14 }) };

test('only bounded, typed chart inputs reach the renderer', () => {
  for (const data of [
    { type: 'flow', title: 'invalid', steps: ['one'] },
    { type: 'bar', title: 'invalid', items: [{ label: 'A', value: '42' }] },
    { type: 'bar', title: 'invalid', items: [{ label: 'A', value: 1e20 }] },
    { type: 'flow', title: 'invalid', steps: Array(11).fill('step') },
    { type: 'html', title: 'invalid', html: '<script />' },
  ]) assert.equal(api.parseChart(JSON.stringify(data)), null);
  const parsed = api.parseChart(JSON.stringify({
    type: 'bar', title: '<script>alert(1)</script> 🧪', unit: '%',
    items: [{ label: 'A & B', value: -13 }, { label: '<image href="https://fixture.invalid"/>', value: 10 }],
  }));
  const drawing = api.diagram(parsed, measure);
  const svg = api.svg(drawing.width, drawing.height, drawing.body);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt; 🧪/);
  assert.match(svg, /A &amp; B/);
  assert.match(svg, />-13 %<\/text>/);
  assert.doesNotMatch(svg, /<script|<image|\bwidth="-|NaN/);
});

test('SVG output retains headings, table cells, and local paper citation labels', () => {
  const text = nodeValue => ({ nodeType: 3, nodeValue });
  const tag = (localName, ...childNodes) => ({ localName, childNodes, children: childNodes });
  const table = tag('table');
  table.querySelectorAll = () => [tag('tr', tag('th', text('方法')), tag('td', text('样本')))];
  const content = tag('article', tag('h1', text('方法概述')), tag('p', text('参见第3页')), table);
  const graphic = api.graphic({ content, charts: new WeakMap(), context: measure });
  assert.match(graphic.source, /font-size="25" font-weight="700">方法概述/);
  assert.match(graphic.source, /参见第3页/);
  assert.match(graphic.source, /方法  \|  样本/);
  assert.ok(graphic.height > 110);
});

test('save writes UTF-8 or binary bytes to the selected path and leaves cancelled exports alone', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pc-export-'));
  const constants = { modeSave: 1, returnOK: 0, returnCancel: 1, returnReplace: 2 };
  let cancelled = false;
  scope.Ci = { nsIFilePicker: constants };
  scope.Cc = { '@mozilla.org/filepicker;1': { createInstance: () => ({
    init() {}, appendFilter() {},
    open(callback) {
      this.file = { path: join(dir, this.defaultString) };
      callback(cancelled ? constants.returnCancel : constants.returnOK);
    },
  }) } };
  scope.IOUtils = { write: writeFile, writeUTF8: writeFile };
  try {
    const html = api.html({ outerHTML: '<article>中文报告</article>' });
    const svg = api.svg(200, 80, api.text(20, 30, '中文图'));
    const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const [format, payload] of [['html', html], ['svg', svg], ['png', new Blob([pngSignature])]]) {
      await api.save({ browsingContext: {} }, format, payload);
      const result = await readFile(join(dir, 'paper-chat-answer.' + format));
      assert.deepEqual(result, typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(pngSignature));
    }
    cancelled = true;
    await api.save({ browsingContext: {} }, 'html', 'unexpected overwrite');
    assert.equal(await readFile(join(dir, 'paper-chat-answer.html'), 'utf8'), html);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTML opens an owner-only local file with the default browser handler after writing', async () => {
  const calls = [];
  const local = createUIContext({
    Services: { dirsvc: { get: () => ({ clone: () => ({
      path: '/tmp/fixture.html', append: name => calls.push(['name', name]),
      createUnique: (type, mode) => calls.push(['create', type, mode]),
    }) }) }, io: { newFileURI: file => ({ spec: 'file://' + file.path }) } },
    Ci: { nsIFile: { NORMAL_FILE_TYPE: 0 }, nsIHandlerInfo: { useSystemDefault: 2 } },
    Cc: { '@mozilla.org/uriloader/external-protocol-service;1': { getService: () => ({
      getProtocolHandlerInfo: scheme => {
        calls.push(['handler', scheme]);
        return { launchWithURI(uri) { calls.push(['open', uri.spec, this.preferredAction]); } };
      },
    }) } },
    IOUtils: { writeUTF8: async (path, text) => calls.push(['write', path, text]) },
  });
  vm.runInContext(readFileSync(new URL('../addon/export.js', import.meta.url), 'utf8'), local);
  await local.PaperChatExport.openHTML({ outerHTML: '<article>示例</article>' });
  assert.deepEqual(calls[1], ['create', 0, 0o600]);
  assert.equal(calls[2][0], 'write');
  assert.match(calls[2][2], /<article>示例<\/article>/);
  assert.deepEqual(calls[3], ['handler', 'http']);
  assert.deepEqual(calls[4], ['open', 'file:///tmp/fixture.html', 2]);
});

test('image stays in its answer, zoom closes independently, and both views export the same payload', async () => {
  const local = createUIContext();
  vm.runInContext(readFileSync(new URL('../addon/export.js', import.meta.url), 'utf8'), local);
  const exp = local.PaperChatExport;
  class Element {
    constructor(tag, text, className) { Object.assign(this, { tag, textContent: text, className, children: [], events: {}, isConnected: true }); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    remove() { this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.isConnected = false; }
    querySelector(cls) { return this.children.find(x => x.className === cls.slice(1)); }
    setAttribute() {}
    focus() {}
    addEventListener(type, fn) { this.events[type] = fn; }
    async decode() {}
  }
  const doc = { defaultView: {} };
  const plugin = { el: (_, ...args) => new Element(...args) };
  const panel = new Element('div'); panel.ownerDocument = doc;
  const host = new Element('article'), footer = new Element('div'), anchor = new Element('button');
  panel.append(host); host.append(footer); footer.append(anchor);
  const state = { panel, error: {} }, saves = [];
  exp.graphic = () => ({ source: '<svg/>', width: 100, height: 50 });
  exp.save = async (_, format, payload) => saves.push([format, payload]);
  await exp.inlineImage(plugin, state, anchor, 'svg', {});
  const figure = host.querySelector('.pc-inline-export');
  assert.ok(figure); assert.equal(footer.children[0], anchor);
  await figure.children[1].events.click();
  figure.children[0].events.click();
  const overlay = panel.querySelector('.pc-export-dialog');
  assert.ok(overlay); assert.equal(overlay.children[1].children[0].src, figure.children[0].children[0].src);
  await overlay.children[0].children[0].events.click();
  overlay.events.keydown({ key: 'Escape', stopPropagation() {}, preventDefault() {} });
  assert.equal(panel.querySelector('.pc-export-dialog'), undefined);
  assert.equal(host.querySelector('.pc-inline-export'), figure);
  assert.deepEqual(saves, [['svg', '<svg/>'], ['svg', '<svg/>']]);
  await exp.inlineImage(plugin, state, anchor, 'svg', {});
  assert.equal(host.children.filter(x => x.className === 'pc-inline-export').length, 1);
});

test('HTML answers extract fenced documents instead of escaping them; ordinary answers keep static export', () => {
  vm.runInContext(readFileSync(new URL('../addon/vendor/marked.umd.js', import.meta.url), 'utf8'), scope);
  const source = '<!doctype html><button onclick="this.textContent=2">1</button><script>window.ready=true;</script>';
  assert.equal(api.htmlSource('说明\n\n```html\n' + source + '\n```\n引用'), source);
  assert.equal(api.htmlSource('~~~~HTML\n' + source + '\n~~~~'), source);
  assert.equal(api.htmlSource(source), source);
  assert.equal(api.htmlSource('## 普通回答\n```js\nconsole.log(1)\n```'), null);
  const result = api.answerHTML(null, { text: '```html\n' + source + '\n```' }, {});
  assert.match(result, /sandbox="allow-scripts"/);
  assert.doesNotMatch(result, /allow-same-origin|allow-top-navigation/);
  assert.match(result, /onclick=&quot;this.textContent=2&quot;/);
  assert.match(result, /connect-src &amp;#39;none/);
  const original = api.document;
  api.document = () => ({ content: { outerHTML: '<article>普通正文</article>' } });
  try { assert.match(api.answerHTML(null, { text: '普通正文' }, {}), /<article>普通正文<\/article>/); }
  finally { api.document = original; }
});

test('play control sits above each HTML code block and opens that block, preserving code as text', async () => {
  const local = createUIContext();
  vm.runInContext(readFileSync(new URL('../addon/export.js', import.meta.url), 'utf8'), local);
  const exp = local.PaperChatExport, opened = [];
  const doc = { createElementNS: (_, tag) => new Element(tag) };
  class Element {
    constructor(tag, text) { this.tag = tag; this.textContent = text; this.ownerDocument = doc; this.children = []; this.events = {}; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    addEventListener(type, fn) { this.events[type] = fn; }
  }
  const plugin = { el: (_, tag, text) => new Element(tag, text) };
  const body = new Element('div'); body._paperChatEntry = { text: 'answer', activity: { status: 'completed' } };
  const state = { error: {} };
  exp.openHTML = async html => opened.push(html);
  for (const title of ['first', 'second']) {
    const source = `<html><button onclick="this.textContent='clicked'">${title}</button></html>`;
    const block = exp.htmlBlock(plugin, state, body, 'html', source);
    assert.equal(block.children[1].tag, 'pre');
    assert.equal(block.children[1].children[0].textContent, source);
    assert.equal(block.children[0].children[1].textContent, 'HTML演示');
    assert.equal(block.children[0].hidden, false);
    assert.equal(block.children[1].hidden, true);
    body._paperChatEntry.activity.status = 'running';
    body.querySelectorAll = () => [block];
    exp.refreshHTMLCards(body);
    assert.equal(block.children[0].hidden, true);
    assert.equal(block.children[1].hidden, false);
    body._paperChatEntry.activity.status = 'completed';
    exp.refreshHTMLCards(body);
    assert.equal(block.children[1].hidden, true);
    await block.children[0].events.click();
    assert.equal(opened.at(-1), exp.interactiveHTML(source));
  }
  assert.equal(opened.length, 2);
  assert.equal(exp.htmlBlock(plugin, state, body, 'js', 'anything'), null);
});
