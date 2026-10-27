import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { CodexClient } from '../bridge/codex.mjs';

function fixture() {
  let clipboard = '', selection;
  const scope = createUIContext({ PaperChatMarkdown: { render: (_, text) => text }, Zotero: { Utilities: { Internal: {
    copyTextToClipboard(text) { clipboard = text; },
  } } } });
  vm.runInContext(readFileSync(new URL('../addon/interaction.js', import.meta.url), 'utf8'), scope);
  const api = scope.PaperChatInteraction;
  const panel = { contains: node => node?.inside, ownerDocument: { defaultView: { getSelection: () => selection } } };
  const state = { panel, error: {}, messages: [{ role: 'user', text: '问题' }, { role: 'assistant', text: '**回答** [第3页]' }] };
  return { api, state, setSelection: value => { selection = value; }, clipboard: () => clipboard };
}

test('copy uses selected input range, limits DOM selections to the panel and exports clean Markdown', () => {
  const f = fixture();
  const input = { value: 'abcdef', selectionStart: 1, selectionEnd: 4 };
  assert.equal(f.api.selected(f.state, { closest: () => input }), 'bcd');
  f.setSelection({ rangeCount: 1, anchorNode: { inside: true }, focusNode: { inside: true }, toString: () => '已选原文' });
  const text = f.api.selected(f.state, {});
  f.api.copy(f.state, text); assert.equal(f.clipboard(), '已选原文');
  f.setSelection({ rangeCount: 1, anchorNode: {}, focusNode: { inside: true }, toString: () => 'outside' });
  assert.equal(f.api.selected(f.state, {}), '');
  assert.equal(f.api.transcript(f.state), '## 你\n\n问题\n\n---\n\n## AI\n\n**回答** [第3页]');
  f.api.copy(f.state, ''); assert.equal(f.clipboard(), '已选原文');
});

test('one compact icon copies the entire assistant answer from its bottom footer and keeps icon feedback', () => {
  const f = fixture(), timers = [];
  const doc = { defaultView: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} } };
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.ownerDocument = doc; this.children = []; this.attrs = {}; this.events = {}; this.textContent = text; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { this.events[k] = fn; }
  }
  doc.createElementNS = (_, tag) => new Element(tag);
  f.state.panel.ownerDocument = doc;
  const plugin = { el: (_, tag, text, className) => Object.assign(new Element(tag, text), { className }) };
  const body = new Element('div'), label = new Element('label'), wrap = new Element('article');
  body._paperChatEntry = { role: 'assistant', text: '# 标题\n\n第一段\n\n第二段' };
  wrap.append(label, body); f.api.message(plugin, f.state, body, wrap);
  assert.equal(label.children.length, 0); assert.equal(wrap.children.length, 3);
  const footer = wrap.children[2], button = footer.children[0];
  assert.equal(footer.className, 'pc-message-actions'); assert.equal(footer.children.length, 1);
  assert.equal(button.children[0].tag, 'svg'); assert.equal(button.textContent, '');
  button.events.click(); assert.equal(f.clipboard(), body._paperChatEntry.text);
  assert.equal(button.attrs['aria-label'], '已复制'); assert.equal(button.textContent, '');
  timers[0](); assert.equal(button.attrs['aria-label'], '复制完整回答'); assert.equal(button.children[0].tag, 'svg');
  const userWrap = new Element('article'); body._paperChatEntry.role = 'user';
  f.api.message(plugin, f.state, body, userWrap); assert.equal(userWrap.children.length, 0);
});

test('elapsed time and summary distinguish waiting, generation, completion and unavailable summaries', () => {
  const f = fixture(), body = { _paperChatEntry: {}, _pcActivity: { label: {}, summary: { replaceChildren(text) { this.textContent = text; } }, details: { dataset: {} } } };
  f.state.status = {};
  const start = Date.now() - 67000;
  f.api.progress({}, f.state, body, { startedAt: start, status: 'running', summary: '公开摘要' });
  assert.match(body._pcActivity.label.textContent, /正在思考 · 1 分 7 秒/);
  assert.equal(body._pcActivity.summary.textContent, '公开摘要');
  assert.equal(body._pcActivity.details.open, true);
  f.api.progress({}, f.state, body, { startedAt: start, firstTextAt: start + 12000, finishedAt: start + 68000, status: 'completed', summary: '' });
  assert.equal(body._pcActivity.label.textContent, '回答完成 · 1 分 8 秒 · 首字前 12 秒');
  assert.match(body._pcActivity.summary.textContent, /未提供/);
  assert.equal(body._pcActivity.details.open, false);
  f.api.progress({}, f.state, body);
  assert.match(body._pcActivity.label.textContent, /1 分 8 秒/);
});

test('Codex forwards only published summaries, merges streamed sections and trusts completed summary', () => {
  const client = new CodexClient();
  const summaries = [];
  client.jobs.set('t', { onSummary: summary => summaries.push(summary), messages: new Map() });
  const event = (method, params) => client.onMessage({ method, params: { threadId: 't', ...params } });
  event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Read ' });
  event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'paper' });
  event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: 'Check citations' });
  assert.equal(summaries.at(-1), 'Read paper\n\nCheck citations');
  event('item/reasoning/textDelta', { itemId: 'r', delta: 'PRIVATE RAW' });
  event('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['Published final'], content: ['PRIVATE CONTENT'] } });
  assert.equal(summaries.at(-1), 'Published final');
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/);
});

test('chrome panel handles Cmd/Ctrl+C and its real context menu, leaving unselected copy alone', () => {
  const f = fixture();
  class Element {
    constructor() { this.events = {}; this.children = []; this.attrs = {}; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, fn) { this.events[key] = fn; }
    removeEventListener(key) { delete this.events[key]; }
    replaceChildren() { this.children = []; }
    openPopupAtScreen(x, y) { this.position = [x, y]; }
    hidePopup() { this.hidden = true; }
    remove() { this.removed = true; }
    contains(node) { return node?.inside; }
    querySelectorAll() { return []; }
  }
  const panel = new Element(), root = new Element(), log = new Element(), head = new Element();
  const doc = new Element(); doc.defaultView = f.state.panel.ownerDocument.defaultView;
  doc.documentElement = root; doc.querySelector = () => null; doc.createXULElement = () => new Element();
  panel.ownerDocument = doc;
  Object.assign(f.state, { panel, log });
  f.api.mount({ el: (_, tag, text) => Object.assign(new Element(), { textContent: text }) }, f.state, head);
  const event = () => ({ target: { closest: () => null }, key: 'c', metaKey: true,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  f.setSelection({ rangeCount: 1, anchorNode: { inside: true }, focusNode: { inside: true }, toString: () => 'copy this' });
  const cmd = event(); panel.events.keydown(cmd);
  assert.equal(f.clipboard(), 'copy this'); assert.ok(cmd.prevented && cmd.stopped);
  const ctrl = { ...event(), metaKey: false, ctrlKey: true }; panel.events.keydown(ctrl); assert.ok(ctrl.prevented);
  const menu = { ...event(), screenX: 30, screenY: 40 }; panel.events.contextmenu(menu);
  const popup = root.children[0]; assert.deepEqual(popup.position, [30, 40]);
  const editable = { ...event(), target: { closest: () => ({ value: 'draft' }) } };
  panel.events.contextmenu(editable); assert.equal(editable.prevented, undefined);
  assert.equal(popup.children[0].attrs.label, '复制选中文字');
  popup.children.at(-1).events.command(); assert.match(f.clipboard(), /## 你/);
  f.setSelection(null); const empty = event(); panel.events.keydown(empty); assert.equal(empty.prevented, undefined);
  f.state.interactionCleanup(); assert.ok(popup.hidden && popup.removed); assert.equal(doc.events.selectionchange, undefined);
});

test('streaming defers DOM replacement while text is selected and retains the latest full answer for copying', () => {
  let selection = { isCollapsed: false, anchorNode: 'text' }, rendered;
  const scope = createUIContext({ PaperChatMarkdown: { render: (_, text) => { rendered = text; return text; } } });
  vm.runInContext(readFileSync(new URL('../addon/panel.js', import.meta.url), 'utf8'), scope);
  const node = { ownerDocument: { defaultView: { getSelection: () => selection } },
    contains: node => node === 'text', _paperChatEntry: { role: 'assistant', text: 'old' }, replaceChildren: () => {} };
  const state = { log: { scrollHeight: 100, scrollTop: 80, clientHeight: 20 } };
  scope.PaperChat.render(state, node, 'latest');
  assert.equal(rendered, undefined); assert.equal(node._pcPendingRender, 'latest'); assert.equal(node._paperChatEntry.text, 'latest');
  selection = { isCollapsed: true };
  scope.PaperChat.render(state, node, node._pcPendingRender);
  assert.equal(rendered, 'latest'); assert.equal(node._pcPendingRender, null);
});
