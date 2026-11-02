import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedContextWindow, contextFailure, effectiveContextBudget } from '../bridge/provider-capacity.mjs';
import { contextBudget } from '../bridge/context.mjs';
import { askExternal } from '../bridge/external.mjs';

test('context capacity uses explicit metadata and bounded provider limit hints, never model-name guesses', () => {
  assert.equal(reportedContextWindow({ model: 'model-1m' }), null);
  assert.equal(reportedContextWindow({ context_window: 128000 }), 128000);
  assert.equal(reportedContextWindow({ contextWindow: -1 }), null);
  assert.deepEqual(contextFailure(new Error('maximum context length is 128,000 tokens')), { overflow: true, capacity: 128000 });
  assert.deepEqual(contextFailure(new Error('context_window_exceeded')), { overflow: true, capacity: null });
  assert.equal(contextFailure(new Error('network connection closed')).overflow, false);
  const saved = contextBudget(), effective = effectiveContextBudget(saved, 8192);
  assert.equal(saved.contextWindow, 500000); assert.equal(effective.contextWindow, 8192);
  assert.ok(effective.outputReserve + effective.summaryTokens + effective.recentTokens + 1024 < 8192);
});

test('external capacity refusal exposes only a numeric limit, without the response body or credentials', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: {
    message: 'maximum context length is 128000 tokens; fixture-provider-secret private source', code: 'context_length_exceeded',
  } }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(askExternal({ baseUrl: 'https://provider.invalid', model: 'custom', apiKey: 'fixture-provider-secret',
    messages: [{ role: 'user', content: 'synthetic paper' }], fetchImpl }), error => {
    assert.equal(error.contextOverflow, true); assert.equal(error.contextCapacity, 128000);
    assert.doesNotMatch(error.message, /fixture-provider-secret|private source/); return true;
  });
});
