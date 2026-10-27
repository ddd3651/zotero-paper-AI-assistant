import test from 'node:test';
import assert from 'node:assert/strict';
import { readModels, selectSettings } from '../bridge/models.mjs';
import { CodexClient, codexLaunchOptions, CHATGPT_CODEX_URL } from '../bridge/codex.mjs';
import { INSTRUCTIONS } from '../bridge/paper.mjs';

const defaults = { provider: 'codex', webSearch: false, external: { baseUrl: '', model: '', hasApiKey: false } };
const model = (name, efforts, isDefault = false) => ({ model: name, displayName: name,
  isDefault, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: 'test' })),
  defaultReasoningEffort: efforts[0] });

test('ChatGPT mode overrides a global gateway only for the child process and keeps the network proxy', () => {
  const original = Object.freeze({ OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1',
    CODEX_OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1', OPENAI_API_KEY: 'test-only-api-key',
    CODEX_API_KEY: 'test-key', CODEX_ACCESS_TOKEN: 'test-token', HTTPS_PROXY: 'http://127.0.0.1:7897', PATH: '/test/bin' });
  const { args, env } = codexLaunchOptions(original);
  assert.equal(original.OPENAI_BASE_URL, 'http://127.0.0.1:15721/v1');
  for (const key of ['OPENAI_BASE_URL', 'CODEX_OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.HTTPS_PROXY, original.HTTPS_PROXY);
  assert.equal(env.PATH, original.PATH);
  assert.ok(args.includes('model_provider="openai"'));
  assert.ok(args.includes(`openai_base_url="${CHATGPT_CODEX_URL}"`));
  assert.doesNotMatch(args.join(' '), /15721|test-only-api-key/);
});

test('GUI children receive a separate loopback network proxy without a model gateway override', () => {
  const { env, args } = codexLaunchOptions({}, 'http://127.0.0.1:7897');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.ok(args.includes(`openai_base_url="${CHATGPT_CODEX_URL}"`));
  assert.equal(codexLaunchOptions({ HTTPS_PROXY: 'http://127.0.0.1:8888' }, 'http://127.0.0.1:7897').env.HTTPS_PROXY, 'http://127.0.0.1:8888');
  for (const url of ['https://example.com', 'http://user:password@127.0.0.1:7897', 'file:///tmp/a']) assert.throws(() => codexLaunchOptions({}, url), /代理地址无效/);
});

test('model discovery follows pagination and uses account-returned reasoning options', async () => {
  const calls = [];
  const list = await readModels({ call: async (method, params) => {
    calls.push(params);
    if (!params.cursor) return { data: [model('gpt-a', ['low', 'high'], true)], nextCursor: 'next' };
    return { data: [model('gpt-b', ['medium', 'ultra']), model('external/foo', ['high'])], nextCursor: null };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'next');
  assert.deepEqual(list.map(m => m.id), ['gpt-a', 'gpt-b']);
  assert.deepEqual(list[1].efforts.map(e => e.value), ['medium', 'ultra']);
});
test('invalid model/effort combinations are rejected rather than silently changed', () => {
  const models = [{ id: 'gpt-a', defaultEffort: 'low', efforts: [{ value: 'low' }, { value: 'high' }], isDefault: true }];
  assert.deepEqual(selectSettings(models, {}), { ...defaults, model: 'gpt-a', effort: 'low', customPrompt: '' });
  assert.deepEqual(selectSettings(models, { model: 'gpt-a', effort: 'high' }, { strict: true }), { ...defaults, model: 'gpt-a', effort: 'high', customPrompt: '' });
  assert.throws(() => selectSettings(models, { model: 'missing' }, { strict: true }), /不支持/);
  assert.throws(() => selectSettings(models, { model: 'gpt-a', effort: 'ultra' }, { strict: true }), /不支持/);
});
test('partial settings preserve current values and validate custom prompt boundaries', () => {
  const models = [{ id: 'gpt-a', defaultEffort: 'low', efforts: [{ value: 'low' }, { value: 'high' }], isDefault: true }];
  const current = { ...defaults, model: 'gpt-a', effort: 'high', customPrompt: '按段落解释' };
  assert.deepEqual(selectSettings(models, {}, { strict: true, current }), current);
  assert.deepEqual(selectSettings(models, { customPrompt: ' \n\t ' }, { strict: true, current }), { ...current, customPrompt: '' });
  const prompt = '中'.repeat(12000);
  assert.equal(selectSettings(models, { customPrompt: prompt }).customPrompt, prompt);
  for (const customPrompt of [undefined, null, false, 1, [], {}, '中'.repeat(12001)]) {
    assert.throws(() => selectSettings(models, { customPrompt }, { strict: true }), /自定义提示词/);
  }
});
test('selected model and reasoning effort are sent to the actual Codex turn', async () => {
  const client = new CodexClient();
  const calls = [];
  client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: 'test-thread' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        client.onMessage({ method: 'item/completed', params: { threadId: 'test-thread', item: { id: 'answer', type: 'agentMessage', text: '答案[第3页]' } } });
        client.onMessage({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'test-turn' } };
    }
  };
  const result = await client.ask({ model: 'gpt-picked', effort: 'high', instructions: INSTRUCTIONS, prompt: '问题' });
  assert.equal(result.text, '答案[第3页]');
  assert.equal(calls.find(c => c.method === 'thread/start').params.model, 'gpt-picked');
  assert.equal(calls.find(c => c.method === 'thread/start').params.config.openai_base_url, CHATGPT_CODEX_URL);
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.model, 'gpt-picked'); assert.equal(turn.effort, 'high');
});
test('page references are explicitly the default for summaries, methods and followups', () => {
  assert.match(INSTRUCTIONS, /每次论文回答的默认格式，无需用户提醒/);
  assert.match(INSTRUCTIONS, /总结全文、解释方法、分析图表和连续追问/);
  assert.match(INSTRUCTIONS, /不编造引用/);
});

test('Windows mixed-case provider overrides are removed from child environment', () => {
  const input = { OpenAi_Api_Key: 'fixture', OpenAI_Base_Url: 'https://example.test', Path: 'preserved' };
  assert.deepEqual(codexLaunchOptions(input).env, { Path: 'preserved' });
  assert.equal(input.OpenAi_Api_Key, 'fixture');
});
