import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createBridge } from '../bridge/server.mjs';

const paper = (id = 'paper-a') => ({ id, title: `Title ${id}`, pageCount: 2,
  pages: [{ number: 1, text: 'original-evidence-page-one' }, { number: 2, text: 'original-evidence-page-two' }] });
const requestBody = (conversationId, question = 'Explain the evidence', id = 'paper-a', extra = {}) => ({
  conversationId, question, currentPage: 1, paper: paper(id), ...extra,
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'paper-chat-历史 space %-'));
  const configFile = join(directory, 'config.json');
  const config = { port: 19327, token: 'fixture-history-capability', model: 'gpt-test', effort: 'low',
    external: { apiKey: 'fixture-history-api-secret' } };
  writeFileSync(configFile, JSON.stringify(config));
  const calls = [];
  let bridge, behavior = 'complete', sequence = 0, beforeBodyRead;
  function boot() {
    const client = {
      account: { type: 'chatgpt', planType: 'plus' },
      start: async () => {}, close() {}, release: async () => {},
      call: async method => {
        assert.equal(method, 'model/list');
        return { data: [{ model: 'gpt-test', isDefault: true, defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      },
      ask: async options => {
        calls.push(options);
        const mode = behavior;
        behavior = 'complete';
        if (mode === 'hold') return new Promise((resolve, reject) => {
          options.onDelta?.('partial-fixture-answer');
          const abort = () => reject(new Error('fixture cancelled'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
        if (mode === 'fail') throw new Error('fixture summary failed');
        const text = `fixture-answer-${++sequence} [evidence](paperchat://page/1)`;
        options.onSummary?.('fixture reasoning');
        options.onDelta?.(text);
        return { threadId: `fixture-native-thread-${sequence}`, text };
      },
    };
    bridge = createBridge({ config, configFile, codex: client });
    assert.equal(bridge.server.listening, false);
  }
  boot();
  t.after(() => { bridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  async function request(method, path, body, headers = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = Readable.from((async function* () {
      const hook = beforeBodyRead;
      beforeBodyRead = undefined;
      hook?.();
      if (bytes) yield bytes;
    })());
    Object.assign(req, { method, url: path, headers: { host: `127.0.0.1:${config.port}`,
      authorization: `Bearer ${config.token}`, ...headers } });
    const response = {};
    await bridge.server.listeners('request')[0](req, {
      writeHead(status) { response.status = status; },
      end(value) { response.body = JSON.parse(value); },
    });
    return response;
  }
  async function finish(accepted) {
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.equal(typeof accepted.body.jobId, 'string');
    for (let i = 0; i < 200; i++) {
      await tick();
      const result = await request('GET', `/jobs/${accepted.body.jobId}`);
      assert.equal(result.status, 200);
      if (result.body.status !== 'running') return result.body;
    }
    assert.fail('Fixture job failed to settle after 200 event-loop turns');
  }
  async function create(paperId = 'paper-a', title = 'New history') {
    const result = await request('POST', '/conversations', { paperId, title, paperTitle: paper(paperId).title });
    assert.ok([200, 201].includes(result.status), JSON.stringify(result));
    const record = result.body.conversation ?? result.body;
    assert.equal(typeof record.id, 'string');
    return record;
  }
  async function get(id, paperId = 'paper-a') {
    const result = await request('GET', `/conversations/${id}?paperId=${encodeURIComponent(paperId)}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.conversation ?? result.body;
  }
  return { request, finish, create, get, calls, directory, config,
    ask: async body => finish(await request('POST', '/ask', body)),
    next(mode) { behavior = mode; },
    beforeBody(fn) { beforeBodyRead = fn; },
    async restart() { bridge.shutdown(); boot(); await bridge.ready; },
  };
}

test('durable conversations survive bridge restart and replay only their own paper and conversation', async t => {
  const f = fixture(t);
  const a = await f.create(), sibling = await f.create('paper-a', 'Sibling'), b = await f.create('paper-b');
  assert.equal((await f.ask(requestBody(a.id, 'unique-question-A'))).status, 'completed');
  assert.equal((await f.ask(requestBody(b.id, 'unique-question-B', 'paper-b'))).status, 'completed');
  const before = await f.get(a.id);
  assert.match(JSON.stringify(before), /unique-question-A|fixture-answer-1/);
  const listed = await f.request('GET', '/conversations?paperId=paper-a');
  assert.equal(listed.status, 200);
  assert.deepEqual(new Set(listed.body.conversations.map(item => item.id)), new Set([a.id, sibling.id]));
  await f.restart();
  assert.deepEqual(await f.get(a.id), before);
  assert.equal((await f.ask(requestBody(a.id, 'continue-A'))).status, 'completed');
  assert.match(f.calls.at(-1).prompt, /unique-question-A/);
  assert.doesNotMatch(f.calls.at(-1).prompt, /unique-question-B/);
  await f.ask(requestBody(sibling.id, 'fresh-sibling'));
  assert.doesNotMatch(f.calls.at(-1).prompt, /unique-question-A|continue-A|unique-question-B/);
});

test('rename, clear and delete persist and affect only the selected conversation', async t => {
  const f = fixture(t), a = await f.create(), sibling = await f.create();
  await f.ask(requestBody(a.id, 'clear-this-question'));
  await f.ask(requestBody(sibling.id, 'keep-this-question'));
  const preserved = await f.get(sibling.id);
  const renamed = await f.request('PATCH', `/conversations/${a.id}`, { paperId: 'paper-a', title: 'Renamed 对话' });
  assert.equal(renamed.status, 200);
  assert.equal((await f.get(a.id)).title, 'Renamed 对话');
  assert.equal((await f.request('POST', '/reset', { paperId: 'paper-a', conversationId: a.id })).status, 200);
  assert.deepEqual((await f.get(a.id)).turns, []);
  assert.deepEqual(await f.get(sibling.id), preserved);
  await f.restart();
  assert.deepEqual((await f.get(a.id)).turns, []);
  assert.equal((await f.request('DELETE', `/conversations/${a.id}?paperId=paper-a`)).status, 200);
  await f.restart();
  assert.equal((await f.request('GET', `/conversations/${a.id}?paperId=paper-a`)).status, 404);
  assert.deepEqual(await f.get(sibling.id), preserved);
});

test('invalid IDs, traversal and untrusted requests cannot mutate history', async t => {
  const f = fixture(t), a = await f.create();
  await f.ask(requestBody(a.id));
  const before = await f.get(a.id);
  for (const id of ['invalid', '..%2Fconfig.json', '%2e%2e%5cconfig.json', '%00', '00000000-0000-0000-0000-000000000000']) {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const result = await f.request(method, `/conversations/${id}?paperId=paper-a`, { paperId: 'paper-a', title: 'Invalid' });
      assert.ok([400, 404].includes(result.status), `${method} ${id}: ${JSON.stringify(result)}`);
    }
  }
  for (const body of [null, [], { paperId: '' }, { paperId: 1 }, { paperId: 'paper-a', title: '' }]) {
    assert.equal((await f.request('POST', '/conversations', body)).status, 400);
  }
  for (const headers of [{ origin: 'https://example.test' }, { authorization: 'Bearer wrong' }]) {
    assert.equal((await f.request('GET', '/conversations?paperId=paper-a', undefined, headers)).status, 403);
  }
  assert.deepEqual(await f.get(a.id), before);
});

test('every ID route rejects an explicitly different paper scope', async t => {
  const operations = [
    ['GET', id => `/conversations/${id}?paperId=paper-b`],
    ['PATCH', id => `/conversations/${id}`, () => ({ paperId: 'paper-b', title: 'Wrong paper' })],
    ['DELETE', id => `/conversations/${id}?paperId=paper-b`],
    ['GET context', id => `/conversations/${id}/context?paperId=paper-b`],
    ['POST compact', id => `/conversations/${id}/compact`, () => ({ paperId: 'paper-b' })],
    ['POST ask', () => '/ask', id => requestBody(id, 'Wrong paper question', 'paper-b')],
    ['POST reset', () => '/reset', id => ({ paperId: 'paper-b', conversationId: id })],
  ];
  for (const [label, path, body] of operations) await t.test(label, async t => {
    const f = fixture(t), a = await f.create();
    await f.ask(requestBody(a.id));
    const before = await f.get(a.id);
    const result = await f.request(label.split(' ')[0], path(a.id), body?.(a.id));
    assert.ok([400, 404].includes(result.status), `${label} with different paperId returned ${result.status}`);
    assert.deepEqual(await f.get(a.id), before);
  });
});

async function compactable(f, id) {
  const saved = await f.request('POST', '/settings', { contextBudget: { recentTokens: 256 } });
  assert.equal(saved.status, 200);
  for (let i = 0; i < 4; i++) {
    const job = await f.ask(requestBody(id, `original-question-${i} ` + 'evidence '.repeat(45)));
    assert.equal(job.status, 'completed', JSON.stringify(job));
  }
}

test('failed or cancelled compaction leaves every original and previous context unchanged', async t => {
  for (const mode of ['fail', 'hold']) await t.test(mode, async t => {
    const f = fixture(t), a = await f.create();
    await compactable(f, a.id);
    const first = await f.finish(await f.request('POST', `/conversations/${a.id}/compact`, { paperId: 'paper-a' }));
    assert.equal(first.status, 'completed');
    for (let i = 0; i < 2; i++) assert.equal((await f.ask(requestBody(a.id, `new-original-${i}`))).status, 'completed');
    const before = await f.get(a.id);
    assert.ok(before.context.summary, 'Failure must preserve an existing committed summary');
    const historyFile = join(f.directory, 'runtime', 'conversations', a.id + '.json');
    const bytes = readFileSync(historyFile);
    const callCount = f.calls.length;
    f.next(mode);
    const accepted = await f.request('POST', `/conversations/${a.id}/compact`, { paperId: 'paper-a' });
    assert.equal(accepted.status, 202);
    for (let i = 0; i < 200 && f.calls.length === callCount; i++) await tick();
    assert.ok(f.calls.length > callCount, 'Compaction must actually call the mock summarizer');
    if (mode === 'hold') assert.equal((await f.request('POST', `/jobs/${accepted.body.jobId}/cancel`, {})).status, 200);
    const job = await f.finish(accepted);
    assert.equal(job.status, mode === 'fail' ? 'failed' : 'cancelled');
    assert.deepEqual(readFileSync(historyFile), bytes);
    assert.deepEqual(await f.get(a.id), before);
    await f.restart();
    assert.deepEqual(await f.get(a.id), before);
  });
});

test('failed atomic rename cleans temporary files and does not alter another transcript', async t => {
  const f = fixture(t), a = await f.create(), sibling = await f.create();
  const preserved = await f.get(sibling.id);
  const directory = join(f.directory, 'runtime', 'conversations');
  const target = join(directory, a.id + '.json');
  const original = readFileSync(target);
  // Replace the target after the route loads it, while its PATCH body is read.
  // A nonempty directory forces atomic rename to fail on macOS and Windows.
  f.beforeBody(() => {
    rmSync(target);
    mkdirSync(target);
    writeFileSync(join(target, 'block-rename'), 'fixture');
  });
  try {
    const response = await f.request('PATCH', `/conversations/${a.id}`, { paperId: 'paper-a', title: 'Unsaved title' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /rename/i);
    assert.deepEqual(readdirSync(directory).sort(), [a.id + '.json', sibling.id + '.json'].sort());
    assert.deepEqual(await f.get(sibling.id), preserved);
  } finally {
    rmSync(target, { recursive: true });
    writeFileSync(target, original);
  }
  assert.equal((await f.get(a.id)).title, 'New history');
});

test('compaction commits context atomically, keeps originals and replays summary plus recent turns', async t => {
  const f = fixture(t), a = await f.create();
  await compactable(f, a.id);
  const before = await f.get(a.id);
  const result = await f.finish(await f.request('POST', `/conversations/${a.id}/compact`, { paperId: 'paper-a' }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const after = await f.get(a.id);
  assert.deepEqual(after.turns, before.turns);
  assert.ok(after.context.through > 0);
  assert.equal(after.context.revision, before.context.revision + 1);
  const context = await f.request('GET', `/conversations/${a.id}/context?paperId=paper-a`);
  assert.equal(context.status, 200);
  assert.equal(context.body.tokenCountKind, 'estimated');
  assert.equal(context.body.actualTokens, null);
  const historyDirectory = join(f.directory, 'runtime', 'conversations');
  assert.deepEqual(readdirSync(historyDirectory), [a.id + '.json']);
  const disk = JSON.parse(readFileSync(join(historyDirectory, a.id + '.json'), 'utf8'));
  assert.deepEqual(disk.context, after.context);
  if (process.platform !== 'win32') {
    assert.equal(statSync(historyDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(join(historyDirectory, a.id + '.json')).mode & 0o777, 0o600);
  }
  await f.restart();
  assert.deepEqual(await f.get(a.id), after);
  await f.ask(requestBody(a.id, 'after-successful-compaction'));
  assert.match(f.calls.at(-1).prompt, /<untrusted_summary>/);
  assert.match(f.calls.at(-1).prompt, /original-question-3/);
  assert.match(f.calls.at(-1).prompt, /original-evidence-page-one/);
});

test('one corrupt history file does not hide readable conversations', async t => {
  const f = fixture(t), a = await f.create();
  await f.ask(requestBody(a.id, 'readable-original'));
  const brokenId = '00000000-0000-4000-8000-000000000001';
  writeFileSync(join(f.directory, 'runtime', 'conversations', brokenId + '.json'), '{broken JSON');
  await f.restart();
  const result = await f.request('GET', '/conversations?paperId=paper-a');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.conversations.some(record => record.id === a.id));
  assert.match(JSON.stringify(await f.get(a.id)), /readable-original/);
  assert.equal((await f.request('GET', `/conversations/${brokenId}?paperId=paper-a`)).status, 400);
});

test('cancelled question retains completed history and survives restart', async t => {
  const f = fixture(t), a = await f.create();
  await f.ask(requestBody(a.id, 'keep-completed-answer'));
  const before = await f.get(a.id);
  f.next('hold');
  const accepted = await f.request('POST', '/ask', requestBody(a.id, 'cancelled-question'));
  await tick();
  assert.equal(accepted.status, 202);
  for (const [method, path, body] of [
    ['PATCH', `/conversations/${a.id}`, { paperId: 'paper-a', title: 'Blocked while busy' }],
    ['DELETE', `/conversations/${a.id}?paperId=paper-a`],
    ['POST', '/reset', { paperId: 'paper-a', conversationId: a.id }],
    ['POST', `/conversations/${a.id}/compact`, { paperId: 'paper-a' }],
    ['POST', '/ask', requestBody(a.id, 'concurrent-question')],
  ]) assert.equal((await f.request(method, path, body)).status, 409, `${method} ${path} must reject a busy conversation`);
  assert.equal((await f.request('POST', `/jobs/${accepted.body.jobId}/cancel`, {})).status, 200);
  assert.equal((await f.finish(accepted)).status, 'cancelled');
  await f.restart();
  const after = await f.get(a.id);
  assert.deepEqual(after.turns.filter(turn => turn.status === 'completed'), before.turns);
  const cancelled = after.turns.find(turn => turn.question === 'cancelled-question');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled.assistant, 'partial-fixture-answer');
  await f.ask(requestBody(a.id, 'after-cancellation', 'paper-a', { customPrompt: 'force-replay' }));
  assert.match(f.calls.at(-1).prompt, /keep-completed-answer/);
  const history = f.calls.at(-1).prompt.match(/<untrusted_history>\n([\s\S]*?)\n<\/untrusted_history>/)?.[1] ?? '';
  assert.doesNotMatch(history, /cancelled-question/);
});

test('history records and responses exclude saved credentials and native thread IDs', async t => {
  const f = fixture(t), a = await f.create();
  await f.ask(requestBody(a.id, `Explain ${f.config.token} and ${f.config.external.apiKey}`));
  const detail = await f.get(a.id);
  const list = await f.request('GET', '/conversations?paperId=paper-a');
  const context = await f.request('GET', `/conversations/${a.id}/context?paperId=paper-a`);
  const privatePaths = readdirSync(f.directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'config.json')
    .map(entry => join(entry.parentPath, entry.name));
  assert.ok(privatePaths.length, 'History must be stored outside the config file');
  const saved = privatePaths.map(path => readFileSync(path, 'utf8')).join('\n');
  for (const text of [saved, JSON.stringify(detail), JSON.stringify(list.body), JSON.stringify(context.body)]) {
    assert.ok(!text.includes(f.config.token));
    assert.ok(!text.includes(f.config.external.apiKey));
    assert.doesNotMatch(text, /fixture-native-thread-|"apiKey"|"authorization"/);
  }
});
