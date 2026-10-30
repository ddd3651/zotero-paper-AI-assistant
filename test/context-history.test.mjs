import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createBridge } from '../bridge/server.mjs';
import { contextBudget, estimateTokens, budgetPaper, excerptWithin, retrieveHistory, compactionEnd } from '../bridge/context.mjs';
import { buildPrompt, INSTRUCTIONS } from '../bridge/paper.mjs';

function fixture(t, saved = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'paper-context-'));
  const calls = [], released = [];
  const config = { port: 19444, token: 'fixture-capability-secret', model: 'gpt-fixture', effort: 'low',
    external: { baseUrl: 'https://fixture.invalid/v1', model: 'unknown-model', apiKey: 'fixture-provider-secret' }, ...saved };
  let bridge, reply = '回答 [原文](paperchat:2 "实验依据")', failSummary = false, releaseGate;
  const codex = { start: async () => {}, close() {}, release: async id => { released.push(id); const gate = releaseGate; releaseGate = null; if (gate) await gate; },
    call: async () => ({ data: [{ model: 'gpt-fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }),
    ask: async options => {
      calls.push(options);
      if (options.instructions.includes('Summarize conversation data only')) {
        if (failSummary) throw new Error('summary fixture failed');
        return { text: '更正：样本为42；待解决问题：长期影响。', threadId: 'summary-' + calls.length };
      }
      options.onSummary?.('公开思考摘要'); options.onDelta?.(reply);
      return { text: reply, threadId: options.threadId || 'native-' + calls.length };
    } };
  const boot = () => { bridge = createBridge({ config, configFile: join(directory, 'config.json'), historyDir: join(directory, 'private-history'), codex }); };
  boot();
  t.after(() => { bridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  async function request(method, path, body, options = {}) {
    const req = Readable.from((async function* () {
      options.onRead?.();
      if (options.gate) await options.gate;
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    })());
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:19444', authorization: 'Bearer ' + config.token } });
    const response = {};
    await bridge.server.listeners('request')[0](req, { writeHead(status) { response.status = status; }, end(text) { response.body = JSON.parse(text); } });
    return response;
  }
  async function finish(accepted) {
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    for (let i = 0; i < 500; i++) {
      await tick();
      const { body } = await request('GET', '/jobs/' + accepted.body.jobId);
      if (body.status !== 'running') return body;
    }
    assert.fail('Job did not settle');
  }
  return { config, directory, calls, released, request, finish,
    async ask(question, extra = {}) { return finish(await request('POST', '/ask', { question,
      paper: { id: 'p', title: '论文', pageCount: 2, pages: [{ number: 2, text: '实验依据，样本42。' }] }, currentPage: 2, ...extra })); },
    setReply(value) { reply = value; }, holdRelease(gate) { releaseGate = gate; }, failSummary() { failSummary = true; },
    async restart() { bridge.shutdown(); boot(); await bridge.ready; } };
}

test('UTF8 and JSON-aware excerpts fit Chinese, emoji and escaped evidence budgets exactly', () => {
  for (const text of ['中文证据'.repeat(20000), '研究🧪😀\n"\\\t'.repeat(20000), '\\"\n'.repeat(20000)]) {
    const result = excerptWithin(text, 1, 1100);
    assert.ok(estimateTokens(JSON.stringify(result.text)) <= 1100);
    assert.equal(result.text, text.slice(result.sourceOffset, result.sourceOffset + result.text.length));
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(result.text));
    const paper = { id: 'p', pageCount: 9, pages: [{ number: 6, text }] };
    const selected = budgetPaper(paper, { question: '研究证据', currentPage: 6 }, 1800);
    assert.ok(estimateTokens(JSON.stringify(selected)) <= 1800);
    assert.equal(selected.pages[0].number, 6);
    assert.ok(selected.pages[0].text.length > 50);
    assert.equal(selected.sourceCoverage.partial, true);
    assert.match(buildPrompt({ paper: selected, question: '总结全文' }, true), /不代表全文/);
  }
});

test('huge Chinese/emoji paper is excerpted successfully and usage includes its source budget', async t => {
  const f = fixture(t);
  const text = '中文研究证据🧪\n"\\'.repeat(15000);
  const job = await f.ask('总结全文，说明证据', { paper: { id: 'p', pageCount: 4, pages: [{ number: 2, text }] } });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const call = f.calls.at(-1);
  assert.ok(estimateTokens(call.prompt) + estimateTokens(call.instructions) + 4096 < 32768);
  assert.match(call.prompt, /不代表全文/);
  const sources = JSON.parse(call.prompt.match(/<untrusted_paper>\n([\s\S]*?)\n<\/untrusted_paper>/)[1]);
  assert.ok(sources.pages[0].text.length < text.length);
  assert.ok(text.includes(sources.pages[0].text));
  assert.ok(job.context.estimatedInputTokens > job.context.historyEstimatedTokens + 1000);
  const context = (await f.request('GET', '/conversations/' + job.conversationId + '/context')).body;
  assert.equal(context.estimatedTokens, job.context.estimatedInputTokens);
  assert.equal(context.sourceCoverage.partial, true);
  await f.restart();
  const reopened = (await f.request('GET', '/conversations/' + job.conversationId + '/context')).body;
  assert.equal(reopened.estimatedTokens, context.estimatedTokens);
  const record = (await f.request('GET', '/conversations/' + job.conversationId)).body;
  assert.equal(record.turns[0].paper.pages[0].text, text);
});

test('one oversized previous Chinese answer is compressible; pending question stays in exact context', async t => {
  const f = fixture(t);
  f.setReply('很长的历史回答🧪'.repeat(6000));
  const first = await f.ask('旧问题：样本是否42？');
  assert.equal(first.status, 'completed');
  f.setReply('新的简短回答');
  const next = await f.ask('新的简短问题：样本是多少？', { conversationId: first.conversationId });
  assert.equal(next.status, 'completed', JSON.stringify(next));
  assert.equal(next.compacted, true);
  const record = (await f.request('GET', '/conversations/' + first.conversationId)).body;
  assert.equal(record.turns[0].assistant.length, '很长的历史回答🧪'.repeat(6000).length);
  assert.equal(record.context.through, 1, 'Pending/new turn must not be skipped by the summary boundary');
  assert.match(f.calls.at(-1).prompt, /<untrusted_summary>/);
  assert.match(f.calls.at(-1).prompt, /新的简短问题/);
  assert.ok(f.calls.filter(c => c.instructions.includes('Summarize conversation data only')).length > 1);
  for (const call of f.calls) assert.ok(estimateTokens(call.prompt) + estimateTokens(call.instructions) < 32768);
});

test('manual small-history compaction explicitly returns a no-op', async t => {
  const f = fixture(t), first = await f.ask('短问题');
  const before = f.calls.length;
  const result = await f.finish(await f.request('POST', '/conversations/' + first.conversationId + '/compact', {}));
  assert.equal(result.status, 'completed');
  assert.equal(result.noOp, true); assert.equal(result.compacted, false);
  assert.equal(f.calls.length, before);
});

test('term retrieval returns bounded original wording and source targets from compacted turns', () => {
  const turn = { id: 'old', status: 'completed', startedAt: 1, user: '请更正 neuroplasticity 的样本：42。未解决问题：长期影响？',
    assistant: 'neuroplasticity 原文 [依据](paperchat:7 "原文证据") ' + '🧪中文'.repeat(4000), pageReferences: [7], citations: ['paperchat:7'] };
  const record = { turns: [turn], context: { through: 1 } };
  const retrieved = retrieveHistory(record, 'neuroplasticity 样本', 1400);
  assert.equal(retrieved.length, 1); assert.equal(retrieved[0].turnId, 'old');
  assert.match(retrieved[0].excerpt, /42/); assert.match(retrieved[0].excerpt, /未解决问题/);
  assert.deepEqual(retrieved[0].citations, ['paperchat:7']);
  assert.ok(estimateTokens(JSON.stringify(retrieved)) <= 1400);
  assert.deepEqual(retrieveHistory(record, 'unrelatedidentifier', 1400), []);
});

test('rolling summary retains citation targets and retrieves archived exact wording on next turn', async t => {
  const f = fixture(t, { contextBudget: { recentTokens: 256 } });
  f.setReply('引用 [原文](paperchat:2 "实验依据")，更正后样本为42，开放问题是长期影响。');
  const first = await f.ask('neuroplasticity 原始问题');
  await f.ask('后续问题', { conversationId: first.conversationId });
  const compacted = await f.finish(await f.request('POST', '/conversations/' + first.conversationId + '/compact', {}));
  assert.equal(compacted.status, 'completed'); assert.equal(compacted.compacted, true);
  const summaryCalls = f.calls.filter(c => c.instructions.includes('Summarize conversation data only'));
  assert.ok(summaryCalls.length);
  assert.match(summaryCalls[0].prompt, /neuroplasticity/);
  assert.match(summaryCalls[0].prompt, /更正后样本为42/);
  assert.match(summaryCalls[0].instructions, /corrections/);
  assert.match(compacted.context.summary, /paperchat:2/);
  const next = await f.ask('neuroplasticity 原始措辞是什么？', { conversationId: first.conversationId });
  assert.equal(next.status, 'completed');
  assert.match(f.calls.at(-1).prompt, /<untrusted_retrieved_history>/);
  assert.ok(next.context.retrievedTurnIds.length);
});

test('snapshot import is validated, private, metadata-preserving and idempotent across restart', async t => {
  const f = fixture(t);
  const snapshot = { paperId: 'p', title: '迁移对话', paperTitle: '论文', pageCount: 4, allowedPages: [2, 4], importKey: 'legacy-snapshot',
    messages: [{ role: 'user', text: '旧问题 ' + f.config.token },
      { role: 'assistant', text: '旧回答 [引用](paperchat:4 "证据")', activity: { startedAt: 100, firstTextAt: 110, finishedAt: 200, summary: '已发布思考摘要' } }] };
  const first = await f.request('POST', '/conversations', snapshot);
  assert.equal(first.status, 201);
  assert.equal(first.body.conversation.messages.length, 2);
  assert.equal(first.body.conversation.messages[1].summary, '已发布思考摘要');
  assert.equal(first.body.conversation.messages[1].firstTextAt, 110);
  assert.ok(!JSON.stringify(first.body).includes(f.config.token));
  await f.restart();
  const retry = await f.request('POST', '/conversations', snapshot);
  assert.equal(retry.status, 200); assert.equal(retry.body.conversationId, first.body.conversationId);
  assert.equal((await f.request('GET', '/conversations?paperId=p')).body.conversations.length, 1);
  const bad = await f.request('POST', '/conversations', { ...snapshot, messages: [{ role: 'system', text: 'secret instruction' }] });
  assert.equal(bad.status, 400);
  assert.equal((await f.request('POST', '/conversations', { ...snapshot, messages: [{ role: 'user', text: 'changed' }] })).status, 400);
  const files = readdirSync(join(f.directory, 'private-history'));
  assert.equal(files.length, 1);
  const file = join(f.directory, 'private-history', files[0]);
  assert.ok(!readFileSync(file, 'utf8').includes(f.config.token));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const next = await f.ask('继续旧问题', { conversationId: first.body.conversationId });
  assert.equal(next.status, 'completed'); assert.match(f.calls.at(-1).prompt, /旧回答/);
});

test('unknown-model budgets are explicit estimates, validated and never copied into conversation records', async t => {
  const f = fixture(t);
  const saved = await f.request('POST', '/settings', { contextBudget: { contextWindow: 48000, recentTokens: 2000 } });
  assert.equal(saved.status, 200); assert.equal(saved.body.current.contextBudget.contextWindow, 48000);
  const invalid = await f.request('POST', '/settings', { contextBudget: { contextWindow: 1024 } });
  assert.equal(invalid.status, 400);
  const job = await f.ask('配置核验'); assert.equal(job.status, 'completed');
  assert.equal(job.context.tokenCountKind, 'estimated'); assert.equal(job.context.actualTokens, null);
  assert.equal(job.context.providerWindowVerified, false);
  assert.ok(estimateTokens(INSTRUCTIONS) > 1000);
  const record = (await f.request('GET', '/conversations/' + job.conversationId)).body;
  assert.ok(!JSON.stringify(record).includes('contextWindow'));
  assert.equal(compactionEnd({ context: { through: 0 }, turns: [{ status: 'completed', user: '字'.repeat(20000), assistant: '答' }, { status: 'running' }] }, contextBudget()), 1);
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const askBody = id => ({ conversationId: id, question: 'concurrent question', paper: { id: 'p', pageCount: 2, pages: [{ number: 2, text: 'evidence' }] } });

test('delayed PATCH body holds the mutation lock and cannot overwrite an accepted answer', async t => {
  const f = fixture(t), first = await f.ask('preserved original');
  const reading = deferred(), gate = deferred();
  const patch = f.request('PATCH', '/conversations/' + first.conversationId, { title: 'renamed' }, { gate: gate.promise, onRead: reading.resolve });
  await reading.promise;
  assert.equal((await f.request('POST', '/ask', askBody(first.conversationId))).status, 409);
  assert.equal((await f.request('POST', '/conversations/' + first.conversationId + '/compact', {})).status, 409);
  gate.resolve(); assert.equal((await patch).status, 200);
  const next = await f.ask('accepted after rename', { conversationId: first.conversationId });
  assert.equal(next.status, 'completed');
  const record = (await f.request('GET', '/conversations/' + first.conversationId)).body;
  assert.equal(record.turns.length, 2); assert.equal(record.title, 'renamed');
});

for (const operation of ['delete', 'reset', 'compact']) test(`${operation} holds mutation lock during awaited native release and rejects concurrent asks`, async t => {
  const f = fixture(t, operation === 'compact' ? { contextBudget: { recentTokens: 256 } } : {});
  const first = await f.ask('preserved original');
  if (operation === 'compact') await f.ask('second original', { conversationId: first.conversationId });
  const gate = deferred(), released = deferred();
  f.holdRelease(gate.promise);
  const count = f.released.length;
  const mutation = operation === 'delete' ? f.request('DELETE', '/conversations/' + first.conversationId)
    : operation === 'reset' ? f.request('POST', '/reset', { conversationId: first.conversationId })
    : f.request('POST', '/conversations/' + first.conversationId + '/compact', {});
  for (let i = 0; i < 100 && f.released.length === count; i++) await tick();
  assert.ok(f.released.length > count, 'Operation must be waiting at a real native release boundary');
  assert.equal((await f.request('POST', '/ask', askBody(first.conversationId))).status, 409);
  gate.resolve();
  const response = await mutation;
  if (operation === 'compact') assert.equal((await f.finish(response)).status, 'completed');
  else assert.equal(response.status, 200);
  const result = await f.request('GET', '/conversations/' + first.conversationId);
  if (operation === 'delete') assert.equal(result.status, 404);
  else assert.equal(result.body.turns.length, operation === 'reset' ? 0 : 2);
});

test('large citation ledger remains durable without exceeding the active summary budget', async t => {
  const f = fixture(t, { contextBudget: { recentTokens: 256, summaryTokens: 512 } });
  const urls = Array.from({ length: 120 }, (_, i) => 'https://evidence.invalid/source/' + i + '/' + 'x'.repeat(50));
  f.setReply(urls.join(' '));
  const first = await f.ask('citation inventory');
  f.setReply('short followup');
  const result = await f.finish(await f.request('POST', '/conversations/' + first.conversationId + '/compact', {}));
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.compacted, true);
  assert.ok(estimateTokens(result.context.summary) <= 512);
  const record = (await f.request('GET', '/conversations/' + first.conversationId)).body;
  assert.deepEqual(record.context.provenance[0].citations, urls);
  const next = await f.ask('continue', { conversationId: first.conversationId });
  assert.equal(next.status, 'completed');
  assert.ok(estimateTokens(f.calls.at(-1).prompt) < 32768);
});

test('atomic history replacement fsyncs a writable file descriptor for Windows FlushFileBuffers', () => {
  // POSIX permits fsync(read-only), so that platform cannot exercise the Windows
  // failure directly. Guard the shared open flags, plus real replacement in all
  // persistence tests above; native Windows integration remains required.
  const source = readFileSync(new URL('../bridge/history.mjs', import.meta.url), 'utf8');
  assert.match(source, /openSync\(temporary, 'r\+'\)/);
  assert.ok(!source.includes("openSync(temporary, 'r')"));
});

test('manual compaction uses the current external provider and requests its output reserve', async t => {
  const f = fixture(t, { provider: 'external', contextBudget: { recentTokens: 256, summaryTokens: 512 } });
  const requests = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const summary = body.messages[0].content.includes('Summarize conversation data only');
    if (summary && fail) return new Response('private upstream failure', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: summary
      ? 'External rolling summary ' + f.config.external.apiKey
      : 'external original '.repeat(200) + '[source](paperchat:2)' } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const first = await f.ask('external provider question');
  assert.equal(first.status, 'completed'); assert.equal(first.context.outputLimitEnforced, true);
  const compact = await f.finish(await f.request('POST', '/conversations/' + first.conversationId + '/compact', {}));
  assert.equal(compact.status, 'completed', JSON.stringify(compact)); assert.equal(compact.compacted, true);
  assert.match(compact.context.summary, /External rolling summary/);
  assert.ok(!compact.context.summary.includes(f.config.external.apiKey));
  assert.equal(requests.filter(r => r.messages[0].content.includes('Summarize conversation data only')).length, 1);
  assert.equal(requests.at(-1).model, 'unknown-model'); assert.equal(requests.at(-1).max_tokens, 512);
  assert.equal(f.calls.length, 0, 'Codex must not be used to summarize an external conversation');
  await f.ask('new external evidence', { conversationId: first.conversationId });
  fail = true;
  const recordFile = join(f.directory, 'private-history', first.conversationId + '.json');
  const before = readFileSync(recordFile);
  const failed = await f.finish(await f.request('POST', '/conversations/' + first.conversationId + '/compact', {}));
  assert.equal(failed.status, 'failed'); assert.deepEqual(readFileSync(recordFile), before);
});
