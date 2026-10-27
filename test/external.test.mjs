import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { askExternal, normalizeExternal } from '../bridge/external.mjs';

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const options = baseUrl => ({ baseUrl, model: 'custom-model', apiKey: 'test-secret', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'paper' }] });

test('external URL policy rejects credentials, insecure remote hosts, queries and invalid values', () => {
  for (const baseUrl of ['http://example.test/v1', 'file:///tmp/key', 'https://user:key@example.test', 'https://example.test/?key=secret', 'https://example.test/#x', 'http://localhost.evil.test', 'garbage']) {
    assert.throws(() => normalizeExternal({ baseUrl }));
  }
  for (const baseUrl of ['https://example.test/v1', 'http://localhost:123/v1', 'http://127.0.0.1:123', 'http://[::1]:123']) assert.equal(normalizeExternal({ baseUrl }).baseUrl, baseUrl);
  assert.throws(() => normalizeExternal({ apiKey: 'abc\r\nx' }));
  assert.equal(normalizeExternal({ hasApiKey: true }).apiKey, '');
});

test('nonstreaming Chat Completions response with a streaming request and explicit nonstreaming mode', async t => {
  const requests = [];
  const baseUrl = await endpoint(t, async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(data) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '中文答案' } }] }));
  });
  const deltas = [];
  assert.equal((await askExternal({ ...options(baseUrl), onDelta: d => deltas.push(d) })).text, '中文答案');
  await askExternal({ ...options(baseUrl), stream: false });
  assert.deepEqual(deltas, ['中文答案']);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer test-secret');
  assert.deepEqual(requests[0].body, { model: 'custom-model', messages: options(baseUrl).messages, stream: true });
  assert.equal(requests[1].body.stream, false);
});

test('SSE handles split UTF8, CRLF, comments, multiline data and DONE without waiting for EOF', async t => {
  const baseUrl = await endpoint(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(': ping\r\ndata: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: {"choices":\n' +
      'data: [{"delta":{"content":"答案"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    let i = 0;
    const next = () => { if (i < bytes.length && !res.destroyed) { res.write(bytes.subarray(i, ++i)); setImmediate(next); } };
    next(); // Keep connection open after DONE to exercise reader cancellation.
  });
  const deltas = [];
  assert.equal((await askExternal({ ...options(baseUrl), onDelta: d => deltas.push(d), timeoutMs: 2000 })).text, '中文答案');
  assert.deepEqual(deltas, ['中文', '答案']);
});

test('redirects never send the key to another host or endpoint', async t => {
  let targetCalls = 0;
  const target = await endpoint(t, (req, res) => { targetCalls++; res.end('{}'); });
  const baseUrl = await endpoint(t, (req, res) => { res.writeHead(307, { Location: target.replace('127.0.0.1', 'localhost') }); res.end(); });
  await assert.rejects(askExternal(options(baseUrl)), /外部\s*API\s*请求失败/);
  assert.equal(targetCalls, 0);
});

test('HTTP and protocol errors redact upstream secrets and do not become successful answers', async t => {
  for (const variant of ['http', 'json', 'sse', 'truncated', 'malformed']) {
    const baseUrl = await endpoint(t, (req, res) => {
      if (variant === 'http') { res.writeHead(401); res.end('Bearer test-secret private data'); }
      if (variant === 'json') res.end(JSON.stringify({ error: { message: 'test-secret' } }));
      if (variant === 'malformed') res.end('test-secret');
      if (variant === 'sse' || variant === 'truncated') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(variant === 'sse' ? 'data: {"error":{"message":"test-secret"}}\n\n' : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      }
    });
    await assert.rejects(askExternal(options(baseUrl)), error => !error.message.includes('test-secret') && /外部\s*API/.test(error.message));
  }
});

test('timeout and cancellation abort pending headers and SSE reads', async t => {
  const baseUrl = await endpoint(t, (req, res) => {
    if (req.headers['x-unused']) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting\n\n');
  });
  await assert.rejects(askExternal({ ...options(baseUrl), timeoutMs: 30 }), /超时/);
  const controller = new AbortController();
  const pending = askExternal({ ...options(baseUrl), signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /取消/);
  await assert.rejects(askExternal({ ...options(baseUrl), signal: AbortSignal.abort() }), /取消/);
  const hanging = await endpoint(t, () => {});
  await assert.rejects(askExternal({ ...options(hanging), timeoutMs: 30 }), /超时/);
});
