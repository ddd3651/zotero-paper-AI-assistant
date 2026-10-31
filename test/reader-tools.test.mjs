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
test('missing source never creates guessed highlights', async () => {
  const s = state(); s.error = {}; s.status = {}; const calls = [];
  s.reader = { navigate: async location => calls.push(location), _internalReader: { _primaryView: { _iframeWindow: { document: { querySelectorAll: () => [] } } } } };
  await reader.navigate(s, 3, { quote: 'This sentence does not occur in the PDF.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pageIndex, 2);
  assert.equal(s.highlight, null);
  assert.match(s.status.textContent, /未匹配到引用原句/);
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

// Synthetic, public text only. These mocks exercise asynchronous PDF rendering and
// native split-view routing without opening a user's PDFs, chats or Zotero profile.
function pdfFixture() {
  const scope = createUIContext({ Zotero: { logError(error) { scope.errors.push(error); } },
    Components: { utils: { cloneInto: value => value } } });
  scope.errors = [];
  for (const file of ['evidence.js', 'reader-tools.js']) vm.runInContext(readFileSync(new URL('../addon/' + file, import.meta.url), 'utf8'), scope);
  const makeView = () => {
    const nodes = [], calls = [], events = new Map();
    const div = { append(node) { nodes.push(node); node.isConnected = true; } };
    const document = {
      querySelectorAll: () => nodes.slice(),
      createElementNS(namespace, name) {
        assert.equal(namespace, 'http://www.w3.org/1999/xhtml');
        assert.equal(name, 'div');
        return { children: [], attributes: {}, style: {},
          setAttribute(key, value) { this.attributes[key] = value; },
          append(node) { this.children.push(node); },
          remove() { const index = nodes.indexOf(this); if (index >= 0) nodes.splice(index, 1); this.isConnected = false; } };
      },
    };
    const viewport = { width: 600, height: 800, viewBox: [0, 0, 600, 800], convertToViewportRectangle: rect => [rect[0], 800 - rect[3], rect[2], 800 - rect[1]] };
    const eventBus = {
      on(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); },
      off(name, listener) { events.get(name)?.delete(listener); },
      emit(name) { for (const listener of events.get(name) || []) listener({ pageNumber: 3 }); },
    };
    const view = { nodes, calls, events, div, viewport, ready: true, eventBus,
      navigate: async location => { calls.push(location); },
      _iframeWindow: { document, PDFViewerApplication: { eventBus,
        pdfViewer: { getPageView: () => view.ready ? { div, viewport } : null } } },
    };
    return view;
  };
  const primary = makeView(), secondary = makeView();
  const internal = { _primaryView: primary, _secondaryView: secondary, _lastView: primary };
  const s = { rawPageCache: new Map(), pageCache: new Map(), error: {}, status: {},
    reader: { _internalReader: internal, navigate: async () => assert.fail('should navigate the chosen PDF view directly') } };
  const reader = scope.PaperChatReader;
  reader.bindHighlight(s);
  return { scope, reader, s, primary, secondary, internal };
}

test('normalizes literal link-title newlines and typographic quotes without decoding other escapes', () => {
  const f = pdfFixture();
  const sentence = 'PERSONA-BASE extracts orthogonal trait vectors via contrastive activation analysis.';
  const glyphs = chars(sentence, 680);
  for (const separator of ['\\n', '\\r\\n', '\n', '\r\n']) {
    assert.ok(f.reader.matchQuote(glyphs, sentence.replace('contrastive activation', 'contrastive' + separator + 'activation')));
  }
  assert.ok(f.reader.matchQuote(chars('The “trait vector” uses a stable method.', 680), 'The "trait vector" uses a stable method.'));
  assert.equal(f.reader.matchQuote(chars('The path\\new remains a string.', 680), 'The path\\new remains a string.').start, 0);
  assert.equal(f.reader.matchQuote(chars('The path\\new remains a string.', 680), 'The path\new remains a string.'), null);
  assert.equal(f.reader.matchQuote(chars('The method uses x² for the score.', 680), 'The method uses x2 for the score.'), null);
  assert.equal(f.reader.matchQuote(chars('The value is \\alpha plus one.', 680), 'The value is alpha plus one.'), null);
  assert.equal(f.reader.matchQuote(chars('The method is not effective.', 680), 'The method is effective.'), null);
});

test('CJK soft line wraps match continuous sentences while paragraph boundaries stay intact', () => {
  const f = pdfFixture();
  const first = chars('这个方法能有效识别', 680), second = chars('所有测试中的人格特征。', 660);
  assert.ok(f.reader.matchQuote([...first, ...second], '这个方法能有效识别所有测试中的人格特征。'));
  assert.ok(f.reader.matchQuote([...first, ...second], '这个方法能有效识别\n所有测试中的人格特征。'));
  first.at(-1).paragraphBreakAfter = true;
  assert.equal(f.reader.matchQuote([...first, ...second], '这个方法能有效识别所有测试中的人格特征。'), null);
});

test('duplicate normalized sentences highlight every occurrence and report the count', async () => {
  const f = pdfFixture();
  const first = chars('PERSONA-BASE extracts orthogonal trait vectors via contrastive', 680);
  const second = chars('activation analysis.', 660);
  const third = chars('PERSONA-BASE extracts orthogonal trait vectors via con-', 580);
  const fourth = chars('trastive activation analysis.', 560);
  const quote = 'PERSONA-BASE extracts orthogonal trait vectors via contrastive\\nactivation analysis.';
  const glyphs = [...first, ...second, ...third, ...fourth];
  f.s.rawPageCache.set(3, { chars: glyphs });
  assert.equal(f.reader.matchQuote(glyphs, quote), null);
  await f.reader.navigate(f.s, 3, { quote });
  assert.equal(f.s.highlight.count, 2);
  assert.equal(f.primary.nodes.length, 1);
  const marks = f.primary.nodes[0].children;
  assert.equal(marks.length, 4, 'only the four sentence lines, not their page-spanning bounding box');
  assert.equal(f.primary.calls[1].position.rects.length, 2, 'scroll target is one concrete occurrence');
  assert.match(f.s.status.textContent, /2处相同原句/);
  assert.equal(f.scope.errors.length, 0);
  f.reader.clearHighlight(f.s);
  assert.equal(f.primary.nodes.length, 0);
});

test('duplicate typographic variants never become a false unique section assignment', () => {
  const f = pdfFixture();
  const quote = 'The "trait vector" uses stable evidence.';
  const glyphs = [...chars(quote, 680), ...chars('The “trait vector” uses stable evidence.', 580)];
  assert.equal(f.reader.matchQuote(glyphs, quote), null);
  assert.equal(f.reader.findQuoteMatches(glyphs, quote).length, 2);
});

test('highlight navigation and overlay use the active secondary PDF, then clear both panes', async () => {
  const f = pdfFixture();
  f.internal._lastView = f.secondary;
  f.s.rawPageCache.set(3, { chars: chars('This is the exact source sentence.', 680) });
  await f.reader.navigate(f.s, 3, { quote: 'This is the exact source sentence.' });
  assert.equal(f.primary.calls.length, 0);
  assert.equal(f.secondary.calls.length, 2);
  assert.equal(f.secondary.nodes.length, 1);
  assert.equal(f.primary.nodes.length, 0);
  assert.match(f.s.status.textContent, /已高亮/);
  f.internal._lastView = f.primary;
  await f.reader.navigate(f.s, 3, {});
  assert.equal(f.secondary.nodes.length, 0);
  assert.match(f.s.status.textContent, /未附可定位原文/);
});

test('late page rendering repaints with visible success only after a layer is attached', async () => {
  const f = pdfFixture();
  f.primary.ready = false;
  f.s.rawPageCache.set(3, { chars: chars('This is the exact source sentence.', 680) });
  await f.reader.navigate(f.s, 3, { quote: 'This is the exact source sentence.' });
  assert.equal(f.primary.nodes.length, 0);
  assert.doesNotMatch(f.s.status.textContent, /已高亮/);
  f.primary.ready = true;
  f.primary.eventBus.emit('textlayerrendered');
  assert.equal(f.primary.nodes.length, 1);
  assert.match(f.s.status.textContent, /已高亮/);
  for (const event of ['pagerendered', 'scalechanging', 'rotationchanging']) {
    f.primary.eventBus.emit(event);
    assert.equal(f.primary.nodes.length, 1, 'redraw replaces rather than duplicates the overlay');
  }
  f.reader.bindHighlight(f.s);
  for (const handlers of f.primary.events.values()) assert.equal(handlers.size, 1);
  f.s.highlightCleanup();
  assert.equal(f.primary.nodes.length, 0);
  for (const handlers of f.primary.events.values()) assert.equal(handlers.size, 0);
  for (const handlers of f.secondary.events.values()) assert.equal(handlers.size, 0);
});

test('a split opened after mount subscribes to delayed rendering too', async () => {
  const f = pdfFixture();
  f.s.highlightCleanup();
  f.internal._secondaryView = null;
  f.reader.bindHighlight(f.s);
  f.internal._secondaryView = f.secondary;
  f.internal._lastView = f.secondary;
  f.secondary.ready = false;
  f.s.rawPageCache.set(3, { chars: chars('This is the exact source sentence.', 680) });
  await f.reader.navigate(f.s, 3, { quote: 'This is the exact source sentence.' });
  f.secondary.ready = true;
  f.secondary.eventBus.emit('pagerendered');
  assert.equal(f.secondary.nodes.length, 1);
  f.s.highlightCleanup();
});

test('invalid or whole-page geometry never produces an overlay or a success message', async () => {
  for (const rect of [[0, 0, 600, 800], [0, 0, Infinity, 10]]) {
    const f = pdfFixture();
    f.s.rawPageCache.set(3, { chars: [{ u: 'This is the exact source sentence.', rect }] });
    await f.reader.navigate(f.s, 3, { quote: 'This is the exact source sentence.' });
    assert.equal(f.primary.nodes.length, 0);
    assert.doesNotMatch(f.s.status.textContent, /已高亮/);
    assert.equal(f.primary.calls.length, 1, 'invalid geometry never reaches Zotero native transient highlighting');
  }
});

test('a newer citation click supersedes an older slow page load', async () => {
  const f = pdfFixture();
  let release;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  f.reader.loadPage = async () => new Promise(resolve => { release = resolve; signalStarted(); });
  const first = f.reader.navigate(f.s, 3, { quote: 'This is the exact source sentence.' });
  await started;
  await f.reader.navigate(f.s, 4, {});
  release({ chars: chars('This is the exact source sentence.', 680) });
  await first;
  assert.equal(f.primary.nodes.length, 0);
  assert.equal(f.s.highlight, null);
  assert.equal(f.primary.calls.length, 2);
  assert.match(f.s.status.textContent, /未附可定位原文/);
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
