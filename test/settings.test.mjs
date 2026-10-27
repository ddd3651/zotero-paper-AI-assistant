import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createBridge } from '../bridge/server.mjs';
import { CodexClient } from '../bridge/codex.mjs';
import { INSTRUCTIONS } from '../bridge/paper.mjs';

const paperRequest = (question = '总结', extra = {}) => ({
  question, currentPage: 1,
  paper: { id: 'paper', title: '测试论文', pageCount: 2, pages: [{ number: 1, text: 'unique-paper-source' }] },
  ...extra,
});

function fixture(t, saved = {}, { offline = false, start, summary = '', search = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'paper-chat-settings-'));
  const configFile = join(directory, 'config.json');
  const config = { port: 19327, token: 'test-only-token', model: 'gpt-b', effort: 'high', extra: 'preserved', ...saved };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o644 });
  const client = new CodexClient({ cwd: directory });
  const calls = [];
  let account = { type: 'chatgpt', planType: 'plus' };
  let threads = 0;
  let turns = 0;
  let failNext = false;
  client.start = async () => { if (start) await start(); if (offline) throw new Error('mock CLI unavailable'); client.account = account; return account; };
  client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account };
    if (method === 'model/list') return { data: ['gpt-a', 'gpt-b'].map((model, i) => ({
      model, isDefault: i === 0, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })),
    })) };
    if (method === 'thread/start') return { thread: { id: `thread-${++threads}` } };
    if (method === 'thread/unsubscribe') return {};
    if (method === 'turn/start') {
      const text = `answer-${++turns}`;
      const fail = failNext;
      failNext = false;
      setImmediate(() => {
        if (search) for (const method of ['item/started', 'item/completed']) client.onMessage({ method, params: {
          threadId: params.threadId, item: { id: 'web-1', type: 'webSearch', query: 'Zotero official download', action: { type: 'search', query: 'Zotero official download' } },
        } });
        if (summary) client.onMessage({ method: 'item/reasoning/summaryTextDelta', params: {
          threadId: params.threadId, itemId: 'r', summaryIndex: 0, delta: summary,
        } });
        if (!fail) client.onMessage({ method: 'item/completed', params: {
          threadId: params.threadId, item: { id: text, type: 'agentMessage', text },
        } });
        client.onMessage({ method: 'turn/completed', params: {
          threadId: params.threadId, turn: { status: fail ? 'failed' : 'completed', error: { message: 'test failure' } },
        } });
      });
      return { turn: { id: `turn-${turns}` } };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const bridge = createBridge({ config, codex: client, configFile });
  assert.equal(bridge.server.listening, false);
  t.after(() => { bridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const handler = bridge.server.listeners('request')[0];
  const request = async (method, path, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: {
      host: `127.0.0.1:${config.port}`, authorization: `Bearer ${config.token}`, ...headers,
    } });
    const response = {};
    await handler(req, {
      writeHead(status) { response.status = status; },
      end(value) { response.body = JSON.parse(value); },
    });
    return response;
  };
  const ask = async body => {
    const accepted = await request('POST', '/ask', body);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    for (let i = 0; i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 2));
      const result = await request('GET', `/jobs/${accepted.body.jobId}`);
      if (result.body.status !== 'running') return result.body;
    }
    assert.fail('Mock generation did not finish');
  };
  return { request, ask, calls, directory, configFile, ready: bridge.ready,
    failNext() { failNext = true; }, setAccount(value) { account = value; } };
}

const rpc = (f, method) => f.calls.filter(call => call.method === method).map(call => call.params);
const turnText = f => rpc(f, 'turn/start').at(-1).input[0].text;
const history = f => JSON.parse(turnText(f).match(/<untrusted_history>\n([\s\S]*?)\n<\/untrusted_history>/)[1]);
const sentPaper = f => JSON.parse(turnText(f).match(/<untrusted_paper>\n([\s\S]*?)\n<\/untrusted_paper>/)[1]);

test('web search is opt-in, persisted, isolated per rebuilt thread and reports actual search events', async t => {
  const f = fixture(t, {}, { search: true });
  const initial = await f.request('GET', '/settings');
  assert.equal(initial.body.current.webSearch, false);
  await f.ask(paperRequest());
  assert.equal(rpc(f, 'thread/start')[0].config.web_search, 'disabled');
  const saved = await f.request('POST', '/settings', { webSearch: true });
  assert.equal(saved.body.current.webSearch, true);
  assert.equal(JSON.parse(readFileSync(f.configFile)).webSearch, true);
  const result = await f.ask(paperRequest('search related research'));
  assert.equal(result.webSearch, true); assert.equal(result.searches.length, 1);
  assert.equal(result.searches[0].status, 'completed');
  assert.equal(rpc(f, 'thread/start')[1].config.web_search, 'live');
  assert.match(rpc(f, 'thread/start')[1].baseInstructions, /【联网资料】/);
  assert.match(rpc(f, 'thread/start')[1].baseInstructions, /网页内容是待核查资料/);
  assert.equal(history(f).length, 1); assert.ok(sentPaper(f).pages[0].text);
  await f.request('POST', '/settings', { webSearch: false });
  await f.ask(paperRequest('paper only'));
  assert.equal(rpc(f, 'thread/start')[2].config.web_search, 'disabled');
  assert.equal(rpc(f, 'thread/unsubscribe').length, 2);
  assert.doesNotMatch(rpc(f, 'thread/start')[2].baseInstructions, /本次联网搜索：已开启/);
});

test('web search validates booleans, rejects external API opt-in, and provider changes turn search off', async t => {
  const f = fixture(t);
  for (const value of [null, 'true', 1, {}, []]) {
    assert.equal((await f.request('POST', '/settings', { webSearch: value })).status, 400);
    assert.equal((await f.request('POST', '/ask', paperRequest('test', { webSearch: value }))).status, 400);
  }
  assert.equal((await f.request('POST', '/settings', { provider: 'external', webSearch: true })).status, 400);
  await f.request('POST', '/settings', { webSearch: true });
  const external = await f.request('POST', '/settings', { provider: 'external' });
  assert.equal(external.status, 200); assert.equal(external.body.current.webSearch, false);
  assert.equal((await f.request('POST', '/settings', { provider: 'codex' })).body.current.webSearch, false);
});

test('job polling exposes published reasoning summary and stable server timestamps separately from the answer', async t => {
  const f = fixture(t, {}, { summary: 'Check original evidence' });
  const answer = await f.ask(paperRequest());
  assert.equal(answer.summary, 'Check original evidence');
  assert.equal(answer.text, 'answer-1');
  assert.equal(answer.status, 'completed');
  assert.ok(answer.startedAt <= answer.firstTextAt && answer.firstTextAt <= answer.finishedAt);
  assert.equal(rpc(f, 'turn/start')[0].summary, 'detailed');
});

test('a question reconnects after transient Codex discovery failure without changing providers', async t => {
  let starts = 0;
  const f = fixture(t, {}, { start: () => { if (++starts === 1) throw Error('workspace routing discovery timed out'); } });
  await f.ready;
  assert.match((await f.request('GET', '/status')).body.codexError, /timed out/);
  const answer = await f.ask(paperRequest());
  assert.equal(answer.status, 'completed'); assert.equal(starts, 2);
  assert.equal((await f.request('GET', '/settings')).body.current.provider, 'codex');
});

test('/settings defaults customPrompt and partial updates preserve current model, effort and prompt', async t => {
  const f = fixture(t);
  const initial = { provider: 'codex', webSearch: false, external: { baseUrl: '', model: '', hasApiKey: false }, model: 'gpt-b', effort: 'high', customPrompt: '' };
  assert.deepEqual((await f.request('GET', '/settings')).body.current, initial);
  const prompt = '  请以导师的口吻逐段解释\n保留公式。  ';
  assert.deepEqual((await f.request('POST', '/settings', { customPrompt: prompt })).body.current, { ...initial, customPrompt: prompt });
  assert.deepEqual((await f.request('POST', '/settings', { effort: 'low' })).body.current, { ...initial, effort: 'low', customPrompt: prompt });
  assert.deepEqual((await f.request('POST', '/settings', { model: 'gpt-a' })).body.current, { ...initial, model: 'gpt-a', effort: 'low', customPrompt: prompt });
  assert.equal((await f.request('POST', '/settings', {})).body.current.customPrompt, prompt);
  assert.equal((await f.request('POST', '/settings', { customPrompt: ' \n\t ' })).body.current.customPrompt, '');
  assert.equal((await f.request('POST', '/settings', { customPrompt: '' })).body.current.customPrompt, '');
  const saved = JSON.parse(readFileSync(f.configFile, 'utf8'));
  assert.equal(saved.extra, 'preserved');
  assert.equal(saved.token, 'test-only-token');
  assert.equal(saved.customPrompt, '');
  if (process.platform !== 'win32') assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), ['config.json']);
});

test('/settings rejects invalid prompts without changing memory or disk, and accepts 12000 characters', async t => {
  const f = fixture(t, { customPrompt: 'saved-prompt' });
  const before = readFileSync(f.configFile, 'utf8');
  for (const customPrompt of [null, true, 123, {}, [], '中'.repeat(12001)]) {
    const result = await f.request('POST', '/settings', { customPrompt });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /自定义提示词/);
    assert.equal(readFileSync(f.configFile, 'utf8'), before);
    assert.equal((await f.request('GET', '/settings')).body.current.customPrompt, 'saved-prompt');
  }
  for (const invalid of [null, [], 'bad-settings']) assert.equal((await f.request('POST', '/settings', invalid)).status, 400);
  const maximum = '中'.repeat(12000);
  assert.equal((await f.request('POST', '/settings', { customPrompt: maximum })).body.current.customPrompt, maximum);
});

test('failed atomic save leaves settings unchanged and cleans up temporary files', async t => {
  const f = fixture(t, { customPrompt: 'saved-prompt' });
  rmSync(f.configFile);
  mkdirSync(f.configFile);
  writeFileSync(join(f.configFile, 'block-rename'), 'fixture');
  const result = await f.request('POST', '/settings', { customPrompt: 'unsaved' });
  assert.equal(result.status, 400);
  assert.equal((await f.request('GET', '/settings')).body.current.customPrompt, 'saved-prompt');
  assert.deepEqual(readdirSync(f.directory), ['config.json']);
});

test('/ask sends saved custom prompt as high-level instructions and retains source/tool boundaries', async t => {
  const customPrompt = '独特风格提示：作为导师，用英文连续段落回答。';
  const f = fixture(t, { customPrompt });
  assert.equal((await f.ask(paperRequest('解释研究方法'))).status, 'completed');
  const start = rpc(f, 'thread/start')[0];
  assert.ok(start.baseInstructions.startsWith(INSTRUCTIONS));
  assert.ok(start.baseInstructions.includes(customPrompt));
  assert.match(start.baseInstructions, /优先于上述基础提示/);
  assert.match(start.baseInstructions, /根据提供的论文原文/);
  assert.match(start.baseInstructions, /不调用工具、命令或外部服务/);
  assert.equal(start.modelProvider, 'openai');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(start.config.features, { shell_tool: false, apps: false, plugins: false });
  assert.equal(start.config.web_search, 'disabled');
  assert.equal(rpc(f, 'turn/start')[0].model, 'gpt-b');
  assert.equal(rpc(f, 'turn/start')[0].effort, 'high');
  assert.ok(!turnText(f).includes(customPrompt));
});

test('prompt changes rebuild the thread with full paper and the latest six completed turns', async t => {
  const f = fixture(t, { customPrompt: 'initial-style' });
  for (let i = 1; i <= 8; i++) {
    const extra = i === 8 ? { selection: 'selected-example', selectionPage: 1 } : {};
    assert.equal((await f.ask(paperRequest(`question-${i}`, extra))).status, 'completed');
  }
  assert.equal(rpc(f, 'thread/start').length, 1);
  assert.doesNotMatch(turnText(f), /unique-paper-source/);
  await f.request('POST', '/settings', { customPrompt: 'new-style' });
  assert.equal((await f.ask(paperRequest('question-9'))).status, 'completed');
  assert.equal(rpc(f, 'thread/start').length, 2);
  assert.deepEqual(rpc(f, 'thread/unsubscribe'), [{ threadId: 'thread-1' }]);
  assert.match(rpc(f, 'thread/start')[1].baseInstructions, /new-style/);
  assert.doesNotMatch(rpc(f, 'thread/start')[1].baseInstructions, /initial-style/);
  assert.match(turnText(f), /unique-paper-source/);
  const replay = history(f);
  assert.equal(replay.length, 6);
  replay.forEach((entry, i) => {
    assert.ok(entry.user.includes(`question-${i + 3}`));
    assert.equal(entry.assistant, `answer-${i + 3}`);
  });
  assert.match(replay[5].user, /selected-example/);
  assert.match(replay[5].user, /第 1 页/);
});

test('rebuild after a selection-only question retains earlier original pages and updates duplicate pages', async t => {
  const f = fixture(t);
  const paper = { id: 'paper', title: '全文', pageCount: 4, pages: [
    { number: 1, text: 'original-page-one', sections: ['1 Introduction'] },
    { number: 2, text: 'original-page-two' },
    { number: 3, text: 'original-page-three' },
  ] };
  await f.ask(paperRequest('read-full-paper', { paper }));
  await f.ask(paperRequest('selection-question', {
    customPrompt: 'new-style', selection: 'updated-page-two', selectionPage: 2, currentPage: undefined,
    paper: { ...paper, pages: [{ number: 2, text: 'updated-page-two' }] },
  }));
  const rebuilt = sentPaper(f);
  assert.deepEqual(rebuilt.pages, [paper.pages[0], { number: 2, text: 'updated-page-two' }, paper.pages[2]]);
  assert.equal(history(f).length, 1);
  assert.match(turnText(f), /当前阅读位置：PDF 第 2 页/);
  assert.match(turnText(f), /起始 PDF 第 2 页/);
  await f.ask(paperRequest('read-new-page', {
    customPrompt: 'new-style', paper: { ...paper, pages: [{ number: 4, text: 'original-page-four' }] },
  }));
  await f.ask(paperRequest('rebuild-again', {
    customPrompt: 'third-style', paper: { ...paper, pages: [{ number: 4, text: 'original-page-four' }] },
  }));
  assert.deepEqual(sentPaper(f).pages.map(page => page.number), [1, 2, 3, 4]);
  assert.equal(sentPaper(f).pages[1].text, 'updated-page-two');
  assert.equal(history(f).length, 3);
});

test('accumulated original text stays within 400k characters and retains current and recently used pages', async t => {
  const f = fixture(t);
  const paper = { id: 'paper', pageCount: 3, pages: [
    { number: 1, text: 'a'.repeat(200000) },
    { number: 2, text: 'b'.repeat(200000) },
  ] };
  await f.ask(paperRequest('full-budget', { paper }));
  await f.ask(paperRequest('touch-first-page', {
    customPrompt: 'style-two', paper: { ...paper, pages: [paper.pages[0]] },
  }));
  assert.equal(sentPaper(f).pages.reduce((sum, page) => sum + page.text.length, 0), 400000);
  await f.ask(paperRequest('add-third-page', {
    customPrompt: 'style-three', paper: { ...paper, pages: [{ number: 3, text: 'c'.repeat(50000) }] },
  }));
  const cached = sentPaper(f).pages;
  assert.deepEqual(cached.map(page => page.number), [1, 3]);
  assert.equal(cached.reduce((sum, page) => sum + page.text.length, 0), 250000);
  assert.equal(cached[0].text, paper.pages[0].text);
  assert.equal(cached[1].text, 'c'.repeat(50000));
});

test('per-request overrides and whitespace clearing take effect without persisting to settings', async t => {
  const f = fixture(t, { customPrompt: 'saved-style' });
  await f.ask(paperRequest('first'));
  await f.ask(paperRequest('second', { customPrompt: 'request-style' }));
  assert.match(rpc(f, 'thread/start')[1].baseInstructions, /request-style/);
  assert.equal(history(f)[0].assistant, 'answer-1');
  await f.ask(paperRequest('third', { customPrompt: '\n \t' }));
  assert.equal(rpc(f, 'thread/start')[2].baseInstructions, INSTRUCTIONS);
  assert.equal(history(f).length, 2);
  await f.ask(paperRequest('fourth'));
  assert.match(rpc(f, 'thread/start')[3].baseInstructions, /saved-style/);
  assert.equal((await f.request('GET', '/settings')).body.current.customPrompt, 'saved-style');
  assert.equal(JSON.parse(readFileSync(f.configFile, 'utf8')).customPrompt, 'saved-style');
});

test('/ask rejects invalid prompts before starting a turn and still blocks API-key accounts', async t => {
  const f = fixture(t);
  for (const customPrompt of [null, 123, true, {}, [], 'x'.repeat(12001)]) {
    const result = await f.request('POST', '/ask', paperRequest('bad', { customPrompt }));
    assert.equal(result.status, 400);
    assert.match(result.body.error, /自定义提示词/);
  }
  assert.equal(rpc(f, 'thread/start').length, 0);
  for (const account of [{ type: 'apiKey' }, null]) {
    f.setAccount(account);
    const result = await f.ask(paperRequest('blocked', { customPrompt: 'test-style' }));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /不会使用\s*API Key/);
  }
  assert.equal(rpc(f, 'thread/start').length, 0);
  assert.equal(rpc(f, 'turn/start').length, 0);
});

test('failed turns are excluded from replay and reset clears both thread and history', async t => {
  const f = fixture(t);
  await f.ask(paperRequest('successful-question'));
  f.failNext();
  assert.equal((await f.ask(paperRequest('failed-question'))).status, 'failed');
  await f.ask(paperRequest('retry-question', { customPrompt: 'changed-style' }));
  assert.equal(history(f).length, 1);
  assert.match(history(f)[0].user, /successful-question/);
  assert.doesNotMatch(turnText(f), /failed-question/);
  assert.match(turnText(f), /unique-paper-source/);
  assert.equal((await f.request('POST', '/reset', { paperId: 'paper' })).status, 200);
  await f.ask(paperRequest('after-reset'));
  assert.doesNotMatch(turnText(f), /untrusted_history|successful-question|retry-question/);
  assert.match(turnText(f), /unique-paper-source/);
});

test('/status reports API v4 and local authorization still rejects untrusted requests', async t => {
  const f = fixture(t);
  const result = await f.request('GET', '/status');
  assert.equal(result.body.apiVersion, 4);
  assert.equal(result.body.version, '0.5.2');
  assert.equal(result.body.billing, 'chatgpt');
  for (const headers of [{ origin: 'https://example.test' }, { authorization: 'Bearer wrong' }, { host: 'localhost:19327' }]) {
    assert.equal((await f.request('POST', '/settings', { customPrompt: 'blocked' }, headers)).status, 403);
  }
});

test('external settings work without CLI and never expose keys; omission retains and empty clears atomically', async t => {
  const f = fixture(t, {}, { offline: true });
  const desired = { provider: 'external', external: { baseUrl: 'https://example.test/v1/', model: 'custom', apiKey: 'secret-one' }, customPrompt: 'shared' };
  const saved = await f.request('POST', '/settings', desired);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.current.external, { baseUrl: 'https://example.test/v1', model: 'custom', hasApiKey: true });
  assert.doesNotMatch(JSON.stringify(saved.body), /secret-one|"apiKey"/);
  assert.equal(saved.body.current.model, 'gpt-b');
  assert.equal(saved.body.current.effort, 'high');
  await f.request('POST', '/settings', { external: { model: 'changed', hasApiKey: false } });
  assert.equal(JSON.parse(readFileSync(f.configFile)).external.apiKey, 'secret-one');
  assert.equal((await f.request('GET', '/settings')).body.current.external.hasApiKey, true);
  assert.equal((await f.request('GET', '/status')).status, 200);
  assert.equal((await f.request('GET', '/status')).body.billing, 'external');
  await f.request('POST', '/settings', { external: { apiKey: 'secret-two' } });
  assert.equal(JSON.parse(readFileSync(f.configFile)).external.apiKey, 'secret-two');
  const clear = await f.request('POST', '/settings', { external: { apiKey: '' } });
  assert.equal(clear.body.current.external.hasApiKey, false);
  assert.equal(JSON.parse(readFileSync(f.configFile)).external.apiKey, '');
  if (process.platform !== 'win32') assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  const rejected = await f.request('POST', '/ask', paperRequest('no-key', { provider: 'external', external: { hasApiKey: true, apiKey: 'injected' } }));
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /API Key/);
  assert.equal((await f.request('POST', '/settings', { provider: 'codex' })).body.current.customPrompt, 'shared');
  assert.equal((await f.request('POST', '/ask', paperRequest())).status, 400);
});

test('invalid external settings leave disk and current untouched', async t => {
  const f = fixture(t);
  const before = readFileSync(f.configFile, 'utf8');
  for (const external of [null, [], 'x', { baseUrl: 'http://remote.test' }, { apiKey: true }, { model: 12 }]) {
    assert.equal((await f.request('POST', '/settings', { external })).status, 400);
    assert.equal(readFileSync(f.configFile, 'utf8'), before);
  }
  assert.equal((await f.request('POST', '/settings', { provider: 'bad' })).status, 400);
});

async function mockExternal(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ ...JSON.parse(text), key: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `external-answer-${requests.length}` } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, external: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'custom-model', apiKey: 'stored-test-key' } };
}

test('CLI failure status is HTTP200 and API settings remain reachable without changing the default provider', async t => {
  const f = fixture(t, {}, { offline: true });
  await f.ready;
  const status = await f.request('GET', '/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, false);
  assert.match(status.body.codexError, /mock CLI unavailable/);
  assert.equal(status.body.settingsAvailable, true);
  assert.equal(status.body.current.provider, 'codex');
  assert.equal((await f.request('GET', '/settings')).status, 200);
});

test('external /ask works without CLI, uses stored key and replays six completed turns with full sources', async t => {
  const mock = await mockExternal(t);
  const f = fixture(t, { provider: 'external', external: mock.external, customPrompt: 'shared-system-style' }, { offline: true });
  const current = (await f.request('GET', '/settings')).body.current;
  assert.equal(current.external.hasApiKey, true);
  assert.equal(Object.hasOwn(current.external, 'apiKey'), false);
  for (let i = 1; i <= 8; i++) {
    const extra = i === 8 ? { selection: 'selected-text', selectionPage: 2, currentPage: 2,
      paper: { id: 'paper', pageCount: 2, pages: [{ number: 2, text: 'second-page-source' }] } } : {};
    const result = await f.ask(paperRequest(`question-${i}`, { ...current, ...extra,
      external: { ...current.external, apiKey: 'injected-key', hasApiKey: false } }));
    assert.equal(result.status, 'completed');
  }
  assert.equal(rpc(f, 'thread/start').length, 0);
  assert.ok(mock.requests.every(request => request.key === 'Bearer stored-test-key'));
  const last = mock.requests.at(-1);
  assert.match(last.messages[0].content, /shared-system-style/);
  assert.ok(last.messages[0].content.startsWith(INSTRUCTIONS));
  assert.match(last.messages[1].content, /unique-paper-source/);
  assert.match(last.messages[1].content, /second-page-source|selected-text|PDF 第 2 页/);
  const replay = JSON.parse(last.messages[1].content.match(/<untrusted_history>\n([\s\S]*?)\n<\/untrusted_history>/)[1]);
  assert.equal(replay.length, 6);
  assert.match(replay[0].user, /question-2/);
  assert.equal(replay.at(-1).assistant, 'external-answer-7');
  assert.equal((await f.request('GET', '/settings')).body.current.external.hasApiKey, true);
  assert.equal(JSON.parse(readFileSync(f.configFile)).external.apiKey, 'stored-test-key');
});

test('switching providers releases the old thread and isolates source cache and history in both directions', async t => {
  const mock = await mockExternal(t);
  const f = fixture(t, { external: mock.external });
  const paper = (number, text) => ({ id: 'paper', pageCount: 3, pages: [{ number, text }] });
  await f.ask(paperRequest('codex-question', { paper: paper(1, 'codex-only-source') }));
  const selected = (await f.request('POST', '/settings', { provider: 'external' })).body.current;
  assert.equal((await f.ask(paperRequest('external-question', { ...selected, paper: paper(2, 'external-only-source') }))).status, 'completed');
  assert.deepEqual(rpc(f, 'thread/unsubscribe'), [{ threadId: 'thread-1' }]);
  const externalPrompt = mock.requests[0].messages[1].content;
  assert.match(externalPrompt, /external-only-source/);
  assert.doesNotMatch(externalPrompt, /codex-only-source|codex-question|untrusted_history/);
  await f.request('POST', '/settings', { provider: 'codex' });
  await f.ask(paperRequest('codex-return', { paper: paper(3, 'fresh-codex-source') }));
  assert.equal(rpc(f, 'thread/start').length, 2);
  assert.match(turnText(f), /fresh-codex-source/);
  assert.doesNotMatch(turnText(f), /external-only-source|codex-only-source|untrusted_history/);
});

test('provider-only external save accepts an empty draft; /ask validates completeness and hasApiKey cannot create a key', async t => {
  const f = fixture(t, {}, { offline: true });
  const saved = await f.request('POST', '/settings', { provider: 'external' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.current.external, { baseUrl: '', model: '', hasApiKey: false });
  assert.equal(saved.body.current.model, 'gpt-b');
  assert.equal(saved.body.current.effort, 'high');
  assert.equal((await f.request('POST', '/ask', paperRequest('incomplete', saved.body.current))).status, 400);
  const flagOnly = await f.request('POST', '/settings', { external: { hasApiKey: true } });
  assert.equal(flagOnly.status, 200);
  assert.equal(flagOnly.body.current.external.hasApiKey, false);
  assert.equal(JSON.parse(readFileSync(f.configFile)).external.apiKey, '');
  assert.equal((await f.request('GET', '/status')).body.ok, true);
});

test('pending CLI never blocks status, settings or external ask', { timeout: 3000 }, async t => {
  const mock = await mockExternal(t);
  const f = fixture(t, {}, { start: () => new Promise(() => {}) });
  const initial = await f.request('GET', '/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.codexConnecting, true);
  assert.equal(initial.body.ok, false);
  assert.equal(initial.body.settingsAvailable, true);
  const initialSettings = await f.request('GET', '/settings');
  assert.equal(initialSettings.body.codexConnecting, true);
  assert.deepEqual(initialSettings.body.models, []);
  const switched = await f.request('POST', '/settings', { provider: 'external' });
  assert.equal(switched.status, 200);
  const selected = await f.request('POST', '/settings', { external: mock.external, customPrompt: 'pending-cli-style' });
  assert.equal(selected.status, 200);
  const answer = await f.ask(paperRequest('without-cli', selected.body.current));
  assert.equal(answer.status, 'completed');
  assert.equal(mock.requests[0].key, 'Bearer stored-test-key');
  const status = await f.request('GET', '/status');
  assert.equal(status.body.codexConnecting, true);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.current.provider, 'external');
  assert.equal(rpc(f, 'thread/start').length, 0);
});

test('late CLI readiness uses latest saved config and does not overwrite API settings', { timeout: 3000 }, async t => {
  let resolveStart;
  const pending = new Promise(resolve => { resolveStart = resolve; });
  const f = fixture(t, {}, { start: () => pending });
  const desired = { provider: 'external', customPrompt: 'latest-style', external: { baseUrl: 'https://example.test/v1', model: 'latest-model', apiKey: 'latest-key' } };
  const saved = await f.request('POST', '/settings', desired);
  assert.equal(saved.status, 200);
  resolveStart();
  await f.ready;
  const result = await f.request('GET', '/settings');
  assert.equal(result.body.codexConnecting, false);
  assert.equal(result.body.models.length, 2);
  assert.deepEqual(result.body.current, saved.body.current);
  assert.doesNotMatch(JSON.stringify(result.body), /latest-key|"apiKey"/);
});
