import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../addon/panel.js', import.meta.url), 'utf8');
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const pageNumbers = result => Array.from(result.paper.pages, page => page.number);

function fixture({ pageCount = 80, currentPage = 45, selection = null, text = number => `Complete text of page ${number}.` } = {}) {
  const calls = { loaded: [], outlined: 0, refreshed: 0, progress: [] };
  const app = { pdfDocument: { numPages: pageCount }, pdfViewer: { currentPageNumber: currentPage } };
  const state = {
    paperId: 'fixture/paper', pageCount: 0, pageCache: new Map(), rawPageCache: new Map(),
    allowedPages: new Set(), messages: [], selectedExcerpt: selection,
    reader: { _title: 'Fixture paper', _item: { getField: () => 'Fallback title' },
      _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: app } } } },
    status: { set textContent(value) { calls.progress.push(value); } },
    log: { querySelectorAll() { calls.refreshed++; return []; } },
  };
  const scope = vm.createContext({
    PaperChatText: { t: (key, args) => args ? `${key}:${args.number}/${args.value2}` : key },
    PaperChatReader: {
      async loadOutline(actual) { assert.equal(actual, state); calls.outlined++; },
      async loadPage(actual, number) {
        assert.equal(actual, state);
        calls.loaded.push(number);
        state.pageCache.set(number, text(number));
      },
      sectionsForPage(actual, number) { assert.equal(actual, state); return [{ number }]; },
      sectionLabel(actual, entry) { assert.equal(actual, state); return `Section ${entry.number}`; },
    },
  });
  vm.runInContext(source, scope, { filename: 'addon/panel.js' });
  return {
    state, calls, app, reader: scope.PaperChatReader,
    read: question => scope.PaperChat.readPaper(state, question),
    complete(result, status = 'completed') {
      // Simulate existing ask/history state without invoking a backend.
      state.messages.push({ role: 'user', pageReferences: pageNumbers(result) },
        { role: 'assistant', activity: { status } });
      for (const number of pageNumbers(result)) state.allowedPages.add(number);
    },
  };
}

test('default reads all first 30 pages plus current page, with full text and section metadata', async () => {
  const f = fixture();
  const result = await f.read('概括主要发现');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
  assert.equal(result.paper.readingScope, 'initial');
  assert.equal(result.paper.id, 'fixture/paper');
  assert.equal(result.paper.title, 'Fixture paper');
  assert.equal(result.paper.pageCount, 80);
  assert.equal(f.state.pageCount, 80);
  assert.equal(result.currentPage, 45);
  assert.equal(result.selection, '');
  assert.equal(result.selectionPage, undefined);
  for (const page of result.paper.pages) {
    assert.equal(page.text, `Complete text of page ${page.number}.`);
    assert.deepEqual(Array.from(page.sections), [`Section ${page.number}`]);
  }
  assert.deepEqual(f.calls.loaded, pageNumbers(result));
  assert.equal(f.calls.outlined, 1);
  assert.equal(f.calls.refreshed, 1);
  assert.deepEqual(f.calls.progress, pageNumbers(result).map(number => `panel.format07:${number}/80`));
});

test('default question argument and short papers read min(30, pageCount) without duplicates', async () => {
  for (const pageCount of [1, 8, 29, 30, 31]) {
    const f = fixture({ pageCount, currentPage: 1 });
    const result = await f.read();
    assert.deepEqual(pageNumbers(result), range(1, Math.min(30, pageCount)));
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('default includes every page of a multi-page selection, deduplicated and sorted with current', async () => {
  for (const [start, end, currentPage] of [[28, 34, 32], [37, 41, 45], [50, 55, 45], [4, 8, 6]]) {
    const selection = { page: start, pages: [start, end], text: 'Selected excerpt' };
    const f = fixture({ currentPage, selection });
    const result = await f.read('解释研究方法');
    assert.deepEqual(pageNumbers(result), [...new Set([...range(1, 30), currentPage, ...range(start, end)])].sort((a, b) => a - b));
    assert.equal(result.paper.readingScope, 'initial');
    assert.equal(result.selection, selection.text);
    assert.equal(result.selectionPage, start);
  }
});

test('selection nextPageRects fallback and end beyond paper preserve valid pages only', async () => {
  for (const selection of [
    { page: 38, text: 'Cross-page excerpt', position: { nextPageRects: [[1, 2, 3, 4]] } },
    { page: 38, pages: [38, 100], text: 'Selection through end' },
  ]) {
    const f = fixture({ pageCount: 39, currentPage: 20, selection });
    assert.deepEqual(pageNumbers(await f.read()), [...range(1, 30), 38, 39]);
  }
  const f = fixture({ pageCount: 39, selection: { page: 39, text: 'Last page', position: { nextPageRects: [[1, 2, 3, 4]] } }, currentPage: 39 });
  assert.deepEqual(pageNumbers(await f.read()), [...range(1, 30), 39]);
});

test('first explicit current-page or selection request still supplies the full baseline', async () => {
  for (const question of ['解释当前页', '解释这一页', '概括本页', '解释选区', '解释选中的文本', '解释这段']) {
    const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
    const result = await f.read(question);
    assert.deepEqual(pageNumbers(result), [...range(1, 30), 45, ...range(52, 55)]);
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('cache warmup and allowed citation pages alone never count as backend delivery', async () => {
  const f = fixture();
  for (const number of range(1, 30)) {
    f.state.pageCache.set(number, `Cached full page ${number}`);
    f.state.allowedPages.add(number);
  }
  const result = await f.read('解释当前页');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
  assert.deepEqual(f.calls.loaded, [45]);
  for (const page of result.paper.pages.slice(0, 30)) assert.equal(page.text, `Cached full page ${page.number}`);
  assert.equal(result.paper.readingScope, 'initial');
});

test('repeated reads always send baseline even with all pages cached', async () => {
  const f = fixture();
  await f.read();
  const result = await f.read('当前页');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
  assert.equal(result.paper.readingScope, 'initial');
});

test('turn status never changes mandatory baseline coverage', async () => {
  for (const status of ['completed', 'failed', 'cancelled', 'running', undefined]) {
    const f = fixture();
    f.complete(await f.read(), status);
    if (status === undefined) f.state.messages.at(-1).activity = {};
    const result = await f.read('本页');
    assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('after baseline delivery explicit current-page requests still send baseline and selection', async () => {
  for (const question of ['当前页', '这一页', '本页']) {
    const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
    f.complete(await f.read());
    f.app.pdfViewer.currentPageNumber = 62;
    const result = await f.read(question);
    assert.deepEqual(pageNumbers(result), [...range(1, 30), ...range(52, 55), 62]);
    assert.equal(result.paper.readingScope, 'initial');
    assert.equal(result.currentPage, 62);
    assert.equal(result.selection, 'Excerpt');
  }
});

test('after baseline delivery explicit selection requests still send baseline and current', async () => {
  for (const question of ['解释选区', '解释选中的内容', '解释划选的文字', '解释这段', '解释这一段']) {
    const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
    f.complete(await f.read());
    const result = await f.read(question);
    assert.deepEqual(pageNumbers(result), [...range(1, 30), 45, ...range(52, 55)]);
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('combined current-page and selection focus includes baseline in the sorted union', async () => {
  const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
  f.complete(await f.read());
  assert.deepEqual(pageNumbers(await f.read('比较当前页和选区')), [...range(1, 30), 45, ...range(52, 55)]);
  f.app.pdfViewer.currentPageNumber = 53;
  assert.deepEqual(pageNumbers(await f.read('比较本页和选区')), [...range(1, 30), ...range(52, 55)]);
});

test('ordinary followups still send baseline and context with or without selection', async () => {
  const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
  f.complete(await f.read());
  let result = await f.read('研究方法是什么');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45, ...range(52, 55)]);
  assert.equal(result.paper.readingScope, 'initial');
  f.state.selectedExcerpt = null;
  result = await f.read('解释选区');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
  assert.equal(result.paper.readingScope, 'initial');
});

test('historic page references never remove the mandatory baseline', async () => {
  const f = fixture();
  f.state.messages = [
    { role: 'user', pageReferences: range(1, 29) }, { role: 'assistant', status: 'completed' },
    { role: 'user', pageReferences: [30] }, { role: 'assistant', status: 'failed' },
  ];
  assert.equal((await f.read('当前页')).paper.readingScope, 'initial');
  f.state.messages.push({ role: 'user', pageReferences: [30] }, { role: 'assistant', status: 'completed' });
  const result = await f.read('当前页');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
  assert.equal(result.paper.readingScope, 'initial');
});

test('cleared, new and restarted conversation states all resend baseline despite warm caches', async () => {
  const f = fixture();
  f.complete(await f.read());
  for (const conversationId of ['existing', 'cleared', 'new', 'restarted']) {
    f.state.conversationId = conversationId;
    if (conversationId !== 'existing') f.state.messages = [];
    if (conversationId === 'restarted') f.state.allowedPages.clear();
    const result = await f.read('当前页');
    assert.deepEqual(pageNumbers(result), [...range(1, 30), 45]);
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('explicit Chinese page references and ranges join baseline, current and selection', async () => {
  const cases = [
    ['解释第60页', [60]],
    ['比较第60页与第62页', [60, 62]],
    ['解释第60–62页', range(60, 62)],
    ['解释第60-62页', range(60, 62)],
    ['解释第60至62页', range(60, 62)],
    ['解释第60页到第62页', range(60, 62)],
    ['比较第60、62和65页', [60, 62, 65]],
    ['比较第60，62,65页', [60, 62, 65]],
    ['解释第62～60页', range(60, 62)],
    ['解释当前页、选区和第60—62页', range(60, 62)],
  ];
  for (const [question, explicit] of cases) {
    const f = fixture({ selection: { page: 52, pages: [52, 55], text: 'Excerpt' } });
    const result = await f.read(question);
    assert.deepEqual(pageNumbers(result), [...range(1, 30), 45, ...range(52, 55), ...explicit], question);
    assert.equal(result.paper.readingScope, 'initial');
  }
});

test('explicit English page references support singles, ranges and lists', async () => {
  for (const question of ['page 60 and page 62', 'pages 60,62', 'Pages 60 & 62', 'p. 60; p. 62']) {
    assert.deepEqual(pageNumbers(await fixture().read(question)), [...range(1, 30), 45, 60, 62], question);
  }
  for (const question of ['pages 60-62', 'pp. 60–62', 'pages 60 to 62']) {
    assert.deepEqual(pageNumbers(await fixture().read(question)), [...range(1, 30), 45, ...range(60, 62)], question);
  }
});

test('explicit page references are clipped to valid pages, deduplicated and sorted', async () => {
  const result = await fixture().read('比较第0页、第10页、第45页、第79–85页和第100页');
  assert.deepEqual(pageNumbers(result), [...range(1, 30), 45, 79, 80]);
});

test('full-paper wording overrides focus, selection and previous delivery', async () => {
  for (const question of ['总结全文', '分析整篇', '结合全文解释当前页和选区']) {
    const f = fixture({ selection: { page: 52, text: 'Excerpt' } });
    f.complete(await f.read());
    const result = await f.read(question);
    assert.deepEqual(pageNumbers(result), range(1, 80));
    assert.equal(result.paper.readingScope, 'full');
    assert.equal(result.selection, 'Excerpt');
  }
});

test('full requests accept exactly 1000 pages and reject 1001 with the original error', async () => {
  const f = fixture({ pageCount: 1000 });
  const result = await f.read('全文');
  assert.deepEqual(pageNumbers(result), range(1, 1000));
  assert.equal(result.paper.readingScope, 'full');
  const oversized = fixture({ pageCount: 1001 });
  await assert.rejects(oversized.read('整篇'), { message: 'panel.error04' });
  assert.deepEqual(oversized.calls.loaded, []);
  assert.equal(oversized.calls.outlined, 0);
});

test('default can include current page beyond 1000; a selection exceeding 1000 pages rejects', async () => {
  const f = fixture({ pageCount: 1500, currentPage: 1500 });
  assert.deepEqual(pageNumbers(await f.read()), [...range(1, 30), 1500]);
  const oversized = fixture({ pageCount: 1001, selection: { page: 1, pages: [1, 1001], text: 'Large selection' } });
  await assert.rejects(oversized.read(), { message: 'panel.error04' });
  assert.deepEqual(oversized.calls.loaded, []);
});

test('explicit ranges exceeding 1000 pages reject instead of silently truncating', async () => {
  const f = fixture({ pageCount: 1500 });
  await assert.rejects(f.read('解释第1至1200页'), { message: 'panel.error04' });
  assert.deepEqual(f.calls.loaded, []);
  assert.equal(f.calls.outlined, 0);
});

test('text budget accepts exactly 2 million characters without truncation, including cached pages', async () => {
  const text = '字'.repeat(1000000);
  const f = fixture({ pageCount: 2, currentPage: 1, text: () => text });
  f.state.pageCache.set(1, text);
  const result = await f.read();
  assert.equal(result.paper.pages.reduce((sum, page) => sum + page.text.length, 0), 2000000);
  assert.equal(result.paper.pages[0].text, text);
  assert.equal(result.paper.pages[1].text, text);
  assert.deepEqual(f.calls.loaded, [2]);
});

test('text budget rejects 2 million plus one with original error rather than partial output', async () => {
  for (const cached of [false, true]) {
    const text = number => 'x'.repeat(number === 1 ? 1000000 : 1000001);
    const f = fixture({ pageCount: 2, currentPage: 1, text });
    if (cached) for (const number of [1, 2]) f.state.pageCache.set(number, text(number));
    await assert.rejects(f.read('全文'), { message: 'panel.error06' });
    assert.equal(f.calls.refreshed, 0);
  }
});

test('empty scanned papers retain original error and mixed empty/text pages remain complete', async () => {
  const empty = fixture({ pageCount: 3, currentPage: 1, text: () => ' \n\t' });
  await assert.rejects(empty.read(), { message: 'panel.error07' });
  assert.equal(empty.calls.refreshed, 0);
  const mixed = fixture({ pageCount: 3, currentPage: 1, text: number => number === 2 ? 'Extracted text' : '' });
  assert.deepEqual(pageNumbers(await mixed.read()), [1, 2, 3]);
});

test('disposal, cancellation and extraction errors reject without returning partial paper', async () => {
  for (const flag of ['disposed', 'cancelRequested']) {
    const f = fixture();
    f.state[flag] = true;
    await assert.rejects(f.read(), { message: 'panel.error05' });
    assert.deepEqual(f.calls.loaded, []);
    const mid = fixture();
    const load = mid.reader.loadPage;
    mid.reader.loadPage = async (...args) => { await load(...args); mid.state[flag] = true; };
    await assert.rejects(mid.read(), { message: 'panel.error05' });
    assert.deepEqual(mid.calls.loaded, [1]);
    assert.equal(mid.calls.refreshed, 0);
  }
  const f = fixture();
  f.reader.loadPage = async () => { throw new Error('fixture extraction failure'); };
  await assert.rejects(f.read(), { message: 'fixture extraction failure' });
  assert.equal(f.calls.refreshed, 0);
});

test('title fallback and original PDF-unavailable error remain supported', async () => {
  const f = fixture();
  f.state.reader._title = '';
  assert.equal((await f.read()).paper.title, 'Fallback title');
  delete f.app.pdfDocument;
  await assert.rejects(f.read(), { message: 'panel.error03' });
});
