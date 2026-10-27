import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const context = createUIContext({ Zotero: { logError() {} } });
for (const file of ['evidence.js', 'reader-tools.js', 'panel.js']) vm.runInContext(readFileSync(new URL('../addon/' + file, import.meta.url), 'utf8'), context);
const reader = context.PaperChatReader;
const chars = (text, y) => Array.from(text, (u, index) => ({ u, rect: [index * 5, y, index * 5 + 5, y + 10], lineBreakAfter: index === text.length - 1 }));
const data = { chars: [...chars('2.1 First Method', 700), ...chars('This is the first method evidence.', 680), ...chars('2.2 Second Method', 600), ...chars('This is the second method evidence.', 580)] };
const state = () => ({ rawPageCache: new Map([[3, data]]), sections: [{ title: 'First Method', path: ['Methods', 'First Method'], page: 3, rect: [0, 710] }, { title: 'Second Method', path: ['Methods', 'Second Method'], page: 3, rect: [0, 610] }] });
test('citation section follows original quote position on a page containing two subsections', () => {
  const description = reader.describeCitation(state(), 3, { quote: 'This is the second method evidence.', section: 'fake chapter' });
  assert.match(description.label, /§2\.2 Second Method/);
  assert.doesNotMatch(description.label, /fake/);
  assert.match(description.title, /Methods › Second Method/);
});
test('missing or ambiguous source never creates guessed highlights', async () => {
  const s = state(); s.error = {}; s.status = {}; const calls = [];
  s.reader = { navigate: async location => calls.push(location), _internalReader: { _primaryView: { _iframeWindow: { document: { querySelectorAll: () => [] } } } } };
  await reader.navigate(s, 3, { quote: 'This sentence does not occur in the PDF.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pageIndex, 2);
  assert.equal(s.highlight, null);
  assert.match(s.status.textContent, /未找到唯一匹配/);
});
test('clear conversation removes selection, transcript and overlay while keeping model settings', async () => {
  const settings = { model: 'gpt-test', effort: 'high', customPrompt: 'Be brief.' };
  let cleared = false;
  const s = { busy: false, clear: {}, reset: {}, selectedSettings: settings, paperId: 'p', log: { replaceChildren() { cleared = true; } }, allowedPages: new Set([3]), messages: [{ role: 'assistant', text: 'answer' }], input: { value: 'draft' }, error: {}, selectionCard: {}, selectionText: {}, status: {}, selectedExcerpt: { text: 'source', page: 3 }, reader: { _internalReader: { _primaryView: { _iframeWindow: { document: { querySelectorAll: () => [] } } } } } };
  const plugin = context.PaperChat;
  plugin.api = async (path, method, body) => { assert.equal(path, '/reset'); assert.equal(body.paperId, 'p'); };
  plugin.setBusy = (state, value) => { state.busy = value; };
  await plugin.clearConversation(s, {});
  assert.ok(cleared); assert.equal(s.messages.length, 0); assert.equal(s.allowedPages.size, 0);
  assert.equal(s.selectedExcerpt, null); assert.equal(s.input.value, ''); assert.equal(s.highlight, null);
  assert.equal(s.selectedSettings, settings);
});

test('reader mounting waits for the inner PDF window after outer initialization', async () => {
  const view = { _iframeWindow: null };
  const r = { _internalReader: { _primaryView: view } };
  let waits = 0;
  context.Zotero.Promise = { delay: async () => {
    waits++;
    view._iframeWindow = { PDFViewerApplication: { pdfDocument: {}, eventBus: {} } };
  } };
  assert.equal(await reader.waitForReady(r), true);
  assert.equal(waits, 1);
  assert.equal(await reader.waitForReady(r), true);
  assert.equal(waits, 1, 'already-ready macOS/Windows readers do not wait');
});
test('reader readiness aborts on close and has a bounded timeout', async () => {
  assert.equal(await reader.waitForReady({ _isTabClosed: true }), false);
  await assert.rejects(reader.waitForReady({}, 0), /PDF\s*阅读窗口/);
});

for (const isWin of [true, false]) test(`bridge startup preserves argument array and Windows-only visibility flags (${isWin})`, async () => {
  const child = { init() {}, runwAsync(args, count) { this.args = Array.from(args); this.count = count; } };
  const ctx = createUIContext({
    Zotero: { isWin, Promise: { delay: async () => {} } },
    PaperChatConfig: { node: 'node-path', server: 'directory with 中文 & spaces/server.mjs' },
    Ci: { nsIFile: {}, nsIProcess: {} },
    Cc: { '@mozilla.org/file/local;1': { createInstance: () => ({ initWithPath() {}, exists: () => true }) },
      '@mozilla.org/process/util;1': { createInstance: () => child } },
  });
  vm.runInContext(readFileSync(new URL('../addon/panel.js', import.meta.url), 'utf8'), ctx);
  let calls = 0;
  ctx.PaperChat.api = async () => { if (++calls === 1) throw new Error('not yet started'); return { ready: true }; };
  assert.equal((await ctx.PaperChat.ensureBridge()).ready, true);
  assert.deepEqual(child.args, [ctx.PaperChatConfig.server]);
  assert.equal(child.count, 1);
  assert.equal(child.startHidden, isWin ? true : undefined);
  assert.equal(child.noShell, isWin ? true : undefined);
});
