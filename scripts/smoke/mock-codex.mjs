// TEST ONLY: deterministic local JSON-RPC peer, never a real Codex login/model.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  let result = {};
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', planType: 'TEST MOCK ONLY' } };
  if (request.method === 'model/list') result = { data: [{ model: 'gpt-smoke-mock', displayName: 'gpt-smoke-mock (TEST ONLY)', isDefault: true,
    defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
  if (request.method === 'thread/start') result = { thread: { id: 'smoke-thread' } };
  if (request.method === 'turn/start') {
    const input = JSON.stringify(request.params.input);
    if (!input.includes('Synthetic paper page')) {
      send({ id: request.id, error: { message: 'Synthetic PDF text was not received' } }); return;
    }
    result = { turn: { id: 'smoke-turn' } };
    setTimeout(() => {
      const text = 'MOCK RESPONSE — local test, no real model.\n\n[Page two](paperchat:2 "Synthetic paper page two.")\n\n| Item | Value |\n|---|---|\n| Test | Pass |\n\n$x^2$';
      send({ method: 'item/agentMessage/delta', params: { threadId: 'smoke-thread', delta: text } });
      send({ method: 'item/completed', params: { threadId: 'smoke-thread', item: { type: 'agentMessage', id: 'reply', text } } });
      send({ method: 'turn/completed', params: { threadId: 'smoke-thread', turn: { status: 'completed' } } });
    }, 300);
  }
  send({ id: request.id, result });
});
