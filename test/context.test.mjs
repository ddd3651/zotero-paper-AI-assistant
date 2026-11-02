import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_WINDOW, contextBudget, budgetPaper, estimateTokens } from '../bridge/context.mjs';
import { planPaperReading, PaperReadingError, capacityFromMetadata, requestsWholePaper } from '../bridge/reading.mjs';

const paperOf = (count, text = n => `page ${n} source.`) => ({ id: 'synthetic', title: 'Fixture', pageCount: count,
  pages: Array.from({ length: count }, (_, i) => ({ number: i + 1, text: text(i + 1) })) });
function verifyPlan(paper, plan, budget) {
  const pieces = new Map();
  for (const batch of plan.batches) {
    assert.ok(estimateTokens(JSON.stringify(batch)) <= budget);
    assert.equal(batch.sourceCoverage.segments.length, batch.pages.length);
    for (const page of batch.pages) {
      const original = paper.pages.find(p => p.number === page.number);
      const start = page.sourceOffset || 0, end = page.sourceEnd ?? page.text.length;
      assert.equal(page.text, original.text.slice(start, end));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text));
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
      const list = pieces.get(page.number) || []; list.push({ start, end, text: page.text }); pieces.set(page.number, list);
    }
  }
  for (const n of plan.requiredPages) {
    const original = paper.pages.find(p => p.number === n);
    const list = pieces.get(n); let offset = 0;
    assert.ok(list, `Page ${n} must be present`);
    for (const p of list) { assert.equal(p.start, offset); offset = p.end; }
    assert.equal(offset, original.text.length);
    assert.equal(list.map(p => p.text).join(''), original.text);
  }
}

test('500k default applies only when no explicit window was saved', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 500000);
  assert.equal(contextBudget().contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextBudget({ recentTokens: 2048 }).contextWindow, DEFAULT_CONTEXT_WINDOW);
  for (const contextWindow of [32768, 48000, 1000000]) {
    assert.equal(contextBudget({ contextWindow }).contextWindow, contextWindow);
    assert.equal(contextBudget({ summaryTokens: 1024 }, { contextWindow }).contextWindow, contextWindow);
  }
  assert.equal(contextBudget({}, {}).contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.throws(() => contextBudget({ contextWindow: null }));
  assert.throws(() => contextBudget({ contextWindow: 0 }));
});

test('short paper is read entirely and single-batch API preserves original wording', () => {
  const p = paperOf(7), b = budgetPaper(p, { question: '总结' }, 500000);
  assert.deepEqual(b.pages, p.pages);
  assert.equal(b.sourceCoverage.partial, false);
  assert.deepEqual(b.sourceCoverage.requiredPages, [1,2,3,4,5,6,7]);
  verifyPlan(p, planPaperReading(p, {}, 500000), 500000);
});

test('current-page relevance cannot displace the first thirty complete pages', () => {
  const p = paperOf(40, n => `page${n}:` + '正文'.repeat(100));
  const plan = planPaperReading(p, { question: 'page40', currentPage: 40, selectionPage: 35 }, 26000);
  assert.deepEqual(plan.requiredPages, [...Array.from({ length: 30 }, (_, i) => i + 1), 35, 40]);
  verifyPlan(p, plan, 26000);
  assert.ok(plan.batches[0].pages.some(p => p.number === 30));
});

test('all supplied pages are kept when the whole payload fits', () => {
  const p = paperOf(90), plan = planPaperReading(p, {}, 500000);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].pages.length, 90);
  assert.equal(plan.sourceCoverage.partial, false);
});

test('whole-paper requests always cover beyond page thirty across every batch', () => {
  const p = paperOf(45, n => `page ${n} ` + '文'.repeat(300));
  for (const question of ['总结全文', '分析整篇论文', 'read the entire document', 'summarize full paper']) {
    const plan = planPaperReading(p, { question }, 5000);
    assert.equal(plan.scope, 'all'); assert.equal(plan.requiredPages.length, 45);
    assert.equal(plan.requiresBatching, true);
    assert.equal(plan.sourceCoverage.partial, false);
    verifyPlan(p, plan, 5000);
  }
  assert.equal(requestsWholePaper({ readingScope: 'all' }), true);
  assert.equal(requestsWholePaper({ question: '总结全文', paper: { readingScope: 'first30' } }), false);
});

test('no requested page may silently disappear from an incomplete extraction', () => {
  const p = paperOf(40); p.pages = p.pages.filter(p => p.number !== 7);
  assert.throws(() => planPaperReading(p, {}, 500000), e => e instanceof PaperReadingError && e.code === 'missingPages' && e.missingPages[0] === 7);
  const q = paperOf(40); q.pages = q.pages.slice(0, 30);
  assert.equal(planPaperReading(q, {}, 500000).sourceCoverage.partial, true);
  assert.throws(() => planPaperReading(q, { question: '总结全文' }, 500000), e => e.code === 'missingPages' && e.missingPages.length === 10);
  q.pages[0].truncated = true;
  assert.throws(() => planPaperReading(q, {}, 500000), e => e.code === 'missingPages' && e.incompletePages[0] === 1);
});

test('oversized mandatory paper exposes a complete batch plan instead of a relevance excerpt', () => {
  const p = paperOf(30, n => `${n}:` + '中文🧪\n"\\'.repeat(200));
  let error;
  try { budgetPaper(p, {}, 3500); } catch (e) { error = e; }
  assert.equal(error.code, 'batchRequired');
  assert.equal(error.messageKey, 'errors.reading.batchRequired');
  assert.equal(error.plan.requiredPages.length, 30);
  verifyPlan(p, error.plan, 3500);
});

test('one large page is split contiguously at Unicode-safe offsets without loss or overlap', () => {
  for (const text of ['中文证据'.repeat(700), '😀🧪\n"\\\t'.repeat(1000), '\\"\n'.repeat(1500)]) {
    const p = paperOf(1, () => text), plan = planPaperReading(p, {}, 1200);
    assert.ok(plan.batches.length > 1); verifyPlan(p, plan, 1200);
    assert.equal(plan.sourceCoverage.partial, false);
    assert.equal(plan.batches[0].sourceCoverage.partial, true);
    assert.ok(plan.batches.every(b => b.pages[0].truncated));
  }
});

test('blank physical pages retain page and coverage provenance', () => {
  const p = paperOf(3, n => n === 2 ? '' : 'evidence');
  const plan = planPaperReading(p, {}, 500000);
  verifyPlan(p, plan, 500000); assert.equal(plan.batches[0].pages[1].text, '');
});

test('tiny or invalid allowances fail explicitly and never loop on an unfit code point', () => {
  for (const tokens of [0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => planPaperReading(paperOf(1), {}, tokens), e => e.code === 'invalidBudget');
  }
  assert.throws(() => planPaperReading(paperOf(1, () => '🧪'), {}, 1), e => e.code === 'budgetTooSmall');
});

test('planner is pure and retains sections and physical page numbers', () => {
  const p = paperOf(3, () => 'a'.repeat(4000)); p.pages[0].sections = ['1 Introduction'];
  const before = structuredClone(p), body = { question: 'read', currentPage: 3 };
  const plan = planPaperReading(p, Object.freeze(body), 1200);
  assert.deepEqual(p, before); verifyPlan(p, plan, 1200);
  assert.deepEqual(plan.batches[0].pages[0].sections, ['1 Introduction']);
});

test('capacity comes only from explicit metadata, never guessed from identifiers or output limits', () => {
  assert.equal(capacityFromMetadata({ id: 'famous-model-500k', max_output_tokens: 8192 }), null);
  assert.equal(capacityFromMetadata(null), null);
  assert.equal(capacityFromMetadata({ context_window: '128000' }), null);
  assert.equal(capacityFromMetadata({ context_length: 128000 }), 128000);
  assert.equal(capacityFromMetadata({ capabilities: { contextWindow: 64000 } }), 64000);
  assert.equal(capacityFromMetadata({ context_window: 500000, limits: { context_length: 128000 } }), 128000);
  assert.equal(capacityFromMetadata({ context_window: -1, limits: { max_context_tokens: 96000 } }), 96000);
});


test('full scope comes from the current request, never an old merged paper scope', () => {
  const p = paperOf(40, n => `page ${n} ` + 'source'.repeat(200));
  p.readingScope = 'full';
  const body = { question: '请解释', paper: { readingScope: 'first30', pages: [...p.pages.slice(0, 30), p.pages[39]] } };
  const ordinary = planPaperReading(p, body, 6000);
  assert.equal(ordinary.scope, 'first30'); assert.equal(ordinary.requiredPages.length, 31);
  assert.ok(ordinary.requiredPages.includes(40)); verifyPlan(p, ordinary, 6000);
  const full = planPaperReading(p, { ...body, paper: { ...body.paper, readingScope: 'full' } }, 6000);
  assert.equal(full.scope, 'all'); assert.equal(full.requiredPages.length, 40); verifyPlan(p, full, 6000);
});

test('ten thousand small pages do not require quadratic optional fit checks', () => {
  const p = paperOf(10000, n => 'p' + n + 'x'.repeat(160));
  const plan = planPaperReading(p, {}, 500000);
  assert.equal(plan.requiresBatching, false);
  assert.ok(plan.selectedPages.length >= 30 && plan.selectedPages.length < 10000);
  assert.ok(plan.estimatedBatchTokens.every(n => n <= 500000));
});
