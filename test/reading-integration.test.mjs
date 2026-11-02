import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createBridge } from '../bridge/server.mjs';
import { estimateTokens } from '../bridge/context.mjs';

const pageNumbers = Array.from({ length: 30 }, (_, i) => i + 1);
function sourcePaper() {
  return { id: 'synthetic-reading-paper', title: 'Synthetic source only', pageCount: 45, readingScope: 'first30',
    pages: pageNumbers.map(number => {
      const label = String(number).padStart(2, '0');
      const filler = (`source${label}:`).repeat(number === 7 ? 3600 : 360);
      return { number, text: `[[PAGE_${label}_START]]\n${filler}\n[[PAGE_${label}_MIDDLE]]\n${filler}\n[[PAGE_${label}_END]]` };
    }) };
}
function sourceIn(prompt) {
  const match = prompt.match(/<untrusted_paper>\n([\s\S]*?)\n<\/untrusted_paper>/);
  return match ? JSON.parse(match[1]) : null;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function fixture(t, { saved = {}, modelCapacity, onAsk } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'paper-reading-integration-'));
  const configFile = join(directory, 'config.json');
  const config = { port: 19444, token: 'synthetic-reading-capability', model: 'gpt-reading-fixture', effort: 'low', ...saved };
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  const originalConfig = readFileSync(configFile);
  const calls = [];
  let hook = onAsk;
  const codex = {
    start: async () => {}, close() {}, release: async () => {},
    call: async method => {
      assert.equal(method, 'model/list');
      return { data: [{ model: config.model, isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        ...(modelCapacity ? { contextWindow: modelCapacity } : {}) }] };
    },
    ask: async options => {
      const kind = options.instructions.startsWith('Read every supplied source page') ? 'reading'
        : options.instructions.includes('Summarize conversation data only') ? 'compaction' : 'final';
      const entry = { options, kind, source: sourceIn(options.prompt), accepted: false };
      calls.push(entry);
      const reply = await hook?.(entry, calls);
      entry.accepted = true;
      const text = typeof reply === 'string' ? reply : kind === 'final' ? 'Synthetic final answer [依据](paperchat:1)' : 'Synthetic notes: supplied source read; preserve PDF page references.';
      options.onDelta?.(text);
      return { text, threadId: 'synthetic-thread-' + calls.length };
    },
  };
  // Invoke the request listener directly: no socket, model process or network.
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Reading integration must not access the network'); });
  const bridge = createBridge({ config, configFile, historyDir: join(directory, 'history'), codex });
  t.after(() => { bridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  async function request(method, path, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:19444', authorization: 'Bearer ' + config.token } });
    const response = {};
    await bridge.server.listeners('request')[0](req, {
      writeHead(status) { response.status = status; }, end(text) { response.body = JSON.parse(text); },
    });
    return response;
  }
  async function settle(accepted) {
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    for (let i = 0; i < 2000; i++) {
      await tick();
      const response = await request('GET', '/jobs/' + accepted.body.jobId);
      if (response.body.status !== 'running') return response.body;
    }
    assert.fail('Synthetic reading job did not settle');
  }
  const ask = (paper, conversationId, extra = {}) => request('POST', '/ask', {
    question: '请解释研究方法与证据', currentPage: 1, paper, ...(conversationId ? { conversationId } : {}), ...extra,
  });
  return { calls, ask, settle, request, setHook(value) { hook = value; },
    assertConfigUnchanged() { assert.deepEqual(readFileSync(configFile), originalConfig); },
    async record(id) { return (await request('GET', '/conversations/' + id)).body; },
    async configuredWindow() { return (await request('GET', '/settings')).body.current.contextBudget.contextWindow; } };
}

// Verify complete source text, not just presence of page numbers or a few quotes.
// In a batched run, final quotation excerpts must not conceal a missing batch.
function assertCompleteCoverage(paper, calls) {
  const successful = calls.filter(c => c.accepted && c.source);
  const reading = successful.filter(c => c.kind === 'reading');
  const sourceCalls = reading.length ? reading : successful;
  for (const original of paper.pages) {
    const chunks = sourceCalls.flatMap(c => c.source.pages).filter(p => p.number === original.number);
    assert.ok(chunks.length, `Page ${original.number} never reached the model`);
    let end = 0;
    for (const chunk of chunks) {
      const start = chunk.sourceOffset || 0;
      assert.equal(start, end, `Page ${original.number} has a gap or overlap`);
      assert.equal(chunk.text, original.text.slice(start, start + chunk.text.length));
      end = start + chunk.text.length;
    }
    assert.equal(end, original.text.length, `Page ${original.number} lost its tail`);
    const reconstructed = chunks.map(c => c.text).join('');
    assert.equal(reconstructed, original.text);
    const label = String(original.number).padStart(2, '0');
    for (const marker of ['START', 'MIDDLE', 'END']) assert.ok(reconstructed.includes(`[[PAGE_${label}_${marker}]]`));
  }
}
function assertCompleted(job) { assert.equal(job.status, 'completed', job.error || job.status); }
function assertNoCompletedReading(record) {
  assert.equal(record.turns[0].assistant, '');
  assert.equal(record.lastUsage?.readPages, undefined);
  assert.equal(record.lastUsage?.sourceCoverage?.batchRead, undefined);
}

test('default 500k sends every character from the first thirty pages to the model', async t => {
  const f = fixture(t), paper = sourcePaper();
  assert.equal(await f.configuredWindow(), 500000);
  const job = await f.settle(await f.ask(paper));
  assertCompleted(job);
  assertCompleteCoverage(paper, f.calls);
  assert.deepEqual(job.context.readPages, pageNumbers);
  assert.equal(f.calls.filter(c => c.kind === 'final').length, 1);
  f.assertConfigUnchanged();
});

test('explicit 32768 budget reads all thirty pages in sequential contiguous batches', async t => {
  const f = fixture(t, { saved: { contextBudget: { contextWindow: 32768 }, contextBudgetUserSet: true } });
  const paper = sourcePaper(), job = await f.settle(await f.ask(paper));
  assertCompleted(job);
  const reading = f.calls.filter(c => c.kind === 'reading' && c.source);
  assert.ok(reading.length > 1);
  assert.ok(reading.some(c => c.source.pages.some(p => (p.sourceOffset || 0) > 0)), 'Oversized page must be split');
  assertCompleteCoverage(paper, f.calls);
  const final = f.calls.at(-1);
  assert.equal(final.kind, 'final');
  assert.match(final.options.prompt, /<untrusted_reading_notes>/);
  assert.match(final.options.prompt, /Synthetic notes/);
  for (const page of final.source.pages) {
    const original = paper.pages.find(p => p.number === page.number);
    assert.equal(page.text, original.text.slice(page.sourceOffset || 0, (page.sourceOffset || 0) + page.text.length));
  }
  assert.equal(await f.configuredWindow(), 32768);
  f.assertConfigUnchanged();
});

test('model-list capacity batches source without an oversized initial request', async t => {
  const f = fixture(t, { modelCapacity: 32000, onAsk: entry => {
    assert.ok(estimateTokens(entry.options.prompt) + estimateTokens(entry.options.instructions) + 4096 <= 32000);
  } });
  const paper = sourcePaper(), job = await f.settle(await f.ask(paper));
  assertCompleted(job);
  assert.ok(f.calls.filter(c => c.kind === 'reading' && c.source).length > 1);
  assertCompleteCoverage(paper, f.calls);
  assert.equal(await f.configuredWindow(), 500000);
  f.assertConfigUnchanged();
});

test('unknown model context-overflow response retries at 32000 without rewriting saved budget', async t => {
  let rejected = 0;
  const f = fixture(t, { onAsk: entry => {
    if (estimateTokens(entry.options.prompt) + estimateTokens(entry.options.instructions) + 4096 > 32000) {
      rejected++;
      throw Object.assign(new Error('Synthetic provider context overflow'), { contextOverflow: true, contextCapacity: 32000 });
    }
  } });
  const paper = sourcePaper(), job = await f.settle(await f.ask(paper));
  assertCompleted(job); assert.equal(rejected, 1);
  assert.ok(f.calls.filter(c => c.accepted && c.kind === 'reading' && c.source).length > 1);
  assertCompleteCoverage(paper, f.calls);
  assert.equal(f.calls.filter(c => c.accepted && c.kind === 'final').length, 1);
  assert.equal(await f.configuredWindow(), 500000);
  f.assertConfigUnchanged();
});

for (const stop of ['cancel', 'failure']) test(`${stop} during reading sends no final answer and retries all source batches`, { timeout: 10000 }, async t => {
  const paused = deferred(); let sourceCalls = 0;
  const f = fixture(t, { saved: { contextBudget: { contextWindow: 32768 }, contextBudgetUserSet: true },
    onAsk: async entry => {
      if (entry.kind !== 'reading' || !entry.source || ++sourceCalls !== 2) return;
      paused.resolve();
      if (stop === 'failure') throw new Error('Synthetic middle-batch failure');
      await new Promise((resolve, reject) => {
        if (entry.options.signal.aborted) reject(new Error('Synthetic read cancelled'));
        else entry.options.signal.addEventListener('abort', () => reject(new Error('Synthetic read cancelled')), { once: true });
      });
    } });
  const paper = sourcePaper(), accepted = await f.ask(paper);
  assert.equal(accepted.status, 202);
  await paused.promise;
  if (stop === 'cancel') assert.equal((await f.request('POST', '/jobs/' + accepted.body.jobId + '/cancel', {})).status, 200);
  const stopped = await f.settle(accepted);
  assert.equal(stopped.status, stop === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(f.calls.filter(c => c.kind === 'final').length, 0);
  assert.equal(f.calls.filter(c => c.accepted && c.kind === 'reading' && c.source).length, 1);
  const record = await f.record(stopped.conversationId);
  assert.equal(record.turns[0].status, stopped.status);
  assertNoCompletedReading(record);
  const retryStart = f.calls.length;
  f.setHook(null);
  const retried = await f.settle(await f.ask(paper, stopped.conversationId));
  assertCompleted(retried);
  const retriedCalls = f.calls.slice(retryStart);
  assertCompleteCoverage(paper, retriedCalls);
  assert.equal(retriedCalls.filter(c => c.kind === 'final').length, 1);
  assert.deepEqual(retried.context.readPages, pageNumbers);
  f.assertConfigUnchanged();
});


for (const [field, before, after] of [
  ['selection', 'selection-A', 'selection-B'],
  ['selectionPage', 1, 2],
  ['currentPage', 1, 2],
]) test(`changing ${field} invalidates cached batch notes for the same question`, async t => {
  let focus = 'original';
  const f = fixture(t, { saved: { contextBudget: { contextWindow: 32768 }, contextBudgetUserSet: true },
    onAsk: entry => entry.kind === 'reading' ? `Synthetic notes for ${focus} focus` : undefined });
  const paper = sourcePaper();
  // Whole pages fit individually so changed history cannot accidentally change
  // segment offsets and invalidate the cache independently of the focus key.
  paper.pages[6].text = paper.pages[5].text.replaceAll('06', '07');
  const first = await f.settle(await f.ask(paper, undefined, { selection: 'selected source', selectionPage: 1, [field]: before }));
  assertCompleted(first);
  const retryStart = f.calls.length;
  focus = 'updated';
  const second = await f.settle(await f.ask(paper, first.conversationId, { selection: 'selected source', selectionPage: 1, [field]: after }));
  assertCompleted(second);
  const latest = f.calls.slice(retryStart);
  assert.ok(latest.some(c => c.kind === 'reading' && c.source), 'Changed focus must trigger source reading');
  assertCompleteCoverage(paper, latest);
  const finalNotes = latest.at(-1).options.prompt.match(/<untrusted_reading_notes>\n([^\n]*)/)[1];
  assert.match(finalNotes, /updated focus/);
  assert.doesNotMatch(finalNotes, /original focus/);
  f.assertConfigUnchanged();
});

for (const stop of ['cancel', 'failure']) test(`overflow retry clears stale coverage before ${stop} in a later batch`, { timeout: 10000 }, async t => {
  const paused = deferred(), resume = deferred(); let readingCalls = 0, overflows = 0;
  const f = fixture(t, { onAsk: async entry => {
    if (entry.kind === 'final' && !overflows) {
      overflows++;
      throw Object.assign(new Error('Synthetic initial context overflow'), { contextOverflow: true, contextCapacity: 32000 });
    }
    if (entry.kind !== 'reading' || !entry.source || ++readingCalls !== 2) return;
    paused.resolve();
    if (stop === 'failure') { await resume.promise; throw new Error('Synthetic later-batch failure'); }
    await new Promise((resolve, reject) => {
      if (entry.options.signal.aborted) reject(new Error('Synthetic retry cancelled'));
      else entry.options.signal.addEventListener('abort', () => reject(new Error('Synthetic retry cancelled')), { once: true });
    });
  } });
  const paper = sourcePaper(), accepted = await f.ask(paper);
  assert.equal(accepted.status, 202);
  await paused.promise;
  const during = (await f.request('GET', '/jobs/' + accepted.body.jobId)).body;
  if (stop === 'failure') resume.resolve();
  else await f.request('POST', '/jobs/' + accepted.body.jobId + '/cancel', {});
  const stopped = await f.settle(accepted);
  assert.equal(stopped.status, stop === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(overflows, 1);
  assert.equal(f.calls.filter(c => c.accepted && c.kind === 'final').length, 0);
  for (const job of [during, stopped]) {
    for (const key of ['readPages', 'readingBatches', 'effectiveContextWindow', 'sourcePages', 'paperTruncated']) {
      assert.equal(job.context[key], undefined, `${key} must not survive an unsuccessful attempt`);
    }
    assert.equal(job.context.sourceCoverage, null);
    assert.equal(job.context.contextPrepared, false);
  }
  assert.equal(during.context.contextWindow, 32000);
  assertNoCompletedReading(await f.record(stopped.conversationId));
  const retryStart = f.calls.length;
  f.setHook(null);
  const retried = await f.settle(await f.ask(paper, stopped.conversationId));
  assertCompleted(retried);
  assertCompleteCoverage(paper, f.calls.slice(retryStart));
  assert.deepEqual(retried.context.readPages, pageNumbers);
  assert.ok(retried.context.readingBatches > 1);
  assert.equal(retried.context.effectiveContextWindow, 32000);
  assert.equal(await f.configuredWindow(), 500000);
  f.assertConfigUnchanged();
});
