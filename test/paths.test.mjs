import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defaultDataDir, resolveRuntimePaths, withConfigLock, writePrivateConfig, prepareConfig } from '../bridge/paths.mjs';
import { HistoryStore } from '../bridge/history.mjs';

const moduleFile = fileURLToPath(new URL('../bridge/paths.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'paper-chat-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "用户数据 & 100% ! 'space");
  const legacy = join(root, 'old-project', 'bridge', 'config.json');
  const history = join(dirname(legacy), 'runtime', 'conversations');
  const write = (file, bytes) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  const run = () => resolveRuntimePaths(legacy, { dataDir });
  return { root, dataDir, legacy, history, write, run };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('data directory defaults and overrides for macOS, Windows and Linux', () => {
  assert.equal(defaultDataDir({ platform: 'darwin', homeDir: '/Users/fixture', env: {} }), '/Users/fixture/Library/Application Support/Zotero Paper Chat');
  assert.equal(defaultDataDir({ platform: 'win32', homeDir: 'C:\\Users\\fixture', env: { AppData: 'D:\\漫游 100% &' } }), win32.join('D:\\漫游 100% &', 'Zotero Paper Chat'));
  assert.equal(defaultDataDir({ platform: 'win32', homeDir: 'C:\\Users\\fixture', env: {} }), 'C:\\Users\\fixture\\AppData\\Roaming\\Zotero Paper Chat');
  assert.equal(defaultDataDir({ platform: 'win32', homeDir: 'C:\\Users\\fixture', env: { paper_chat_data_dir: 'E:\\测试 !' } }), 'E:\\测试 !');
  assert.equal(defaultDataDir({ platform: 'linux', homeDir: '/home/fixture', env: { XDG_DATA_HOME: '/var/data' } }), '/var/data/Zotero Paper Chat');
  assert.equal(defaultDataDir({ platform: 'linux', homeDir: '/home/fixture', env: { XDG_DATA_HOME: 'relative' } }), '/home/fixture/.local/share/Zotero Paper Chat');
  assert.equal(defaultDataDir({ platform: 'linux', homeDir: '/home/fixture', env: { PAPER_CHAT_DATA_DIR: '/ci/private' } }), '/ci/private');
});

test('import has no filesystem side effects even with a configured data directory', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../bridge/paths.mjs', import.meta.url).href)});`],
    { env: { ...process.env, PAPER_CHAT_DATA_DIR: f.dataDir }, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.equal(existsSync(f.dataDir), false);
});

test('fresh paths create private directories, leaving config creation to the builder', t => {
  const f = fixture(t), paths = f.run();
  assert.equal(paths.configFile, join(f.dataDir, 'config.json'));
  assert.equal(paths.historyDir, join(f.dataDir, 'conversations'));
  assert.equal(paths.runtimeDir, join(f.dataDir, 'runtime'));
  assert.equal(existsSync(paths.configFile), false);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(statSync(paths.historyDir).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(statSync(f.dataDir).mode & 0o777, 0o700);
});

test('complete byte-exact configuration backup and history copy preserve all fields', t => {
  const f = fixture(t);
  const raw = Buffer.from('{\r\n "token": "fixture-token", "port": 23222, "model": "chosen", "customPrompt": "保留全部", "contextBudget": {"contextWindow": 123456}, "external": {"apiKey": "fixture-secret"}, "unknown": {"nested": [1,2]}\r\n}\r\n');
  f.write(f.legacy, raw);
  f.write(join(f.history, 'conversation.json'), '{"messages":["fixture history"]}\r\n');
  f.write(join(f.history, 'nested', 'legacy.json'), 'unparsed legacy format');
  const paths = f.run();
  assert.deepEqual(readFileSync(paths.configFile), raw);
  assert.deepEqual(readFileSync(f.legacy), raw);
  assert.deepEqual(readFileSync(join(f.dataDir, 'backups', 'legacy-config-' + hash(raw) + '.json')), raw);
  assert.equal(readFileSync(join(paths.historyDir, 'nested', 'legacy.json'), 'utf8'), 'unparsed legacy format');
  assert.equal(readFileSync(join(paths.historyDir, 'conversation.json'), 'utf8'), readFileSync(join(f.history, 'conversation.json'), 'utf8'));
  if (process.platform !== 'win32') assert.equal(statSync(paths.configFile).mode & 0o777, 0o600);
});

test('existing fixed settings and archives win, and deleted migrated chats stay deleted', t => {
  const f = fixture(t);
  f.write(f.legacy, '{"token":"legacy","newUnknown":true}');
  f.write(join(f.history, 'same.json'), 'legacy-same');
  f.write(join(f.history, 'new.json'), 'legacy-new');
  f.write(join(f.dataDir, 'config.json'), '{"token":"fixed","customPrompt":"retained"}');
  f.write(join(f.dataDir, 'conversations', 'same.json'), 'fixed-same');
  const paths = f.run();
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{"token":"fixed","customPrompt":"retained"}');
  assert.equal(readFileSync(join(paths.historyDir, 'same.json'), 'utf8'), 'fixed-same');
  assert.equal(readFileSync(join(paths.historyDir, 'new.json'), 'utf8'), 'legacy-new');
  rmSync(join(paths.historyDir, 'new.json'));
  f.run();
  assert.equal(existsSync(join(paths.historyDir, 'new.json')), false);
  assert.equal(readdirSync(join(f.dataDir, 'backups')).length, 1);
});

test('a cloned project merges only missing histories without replacing target config', t => {
  const f = fixture(t);
  f.write(f.legacy, '{"token":"first"}');
  f.write(join(f.history, 'one.json'), 'first chat');
  const paths = f.run();
  const other = join(f.root, 'clone', 'bridge', 'config.json');
  f.write(other, '{"token":"second"}');
  f.write(join(dirname(other), 'runtime', 'conversations', 'one.json'), 'conflicting chat');
  f.write(join(dirname(other), 'runtime', 'conversations', 'two.json'), 'second chat');
  resolveRuntimePaths(other, { dataDir: f.dataDir });
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{"token":"first"}');
  assert.equal(readFileSync(join(paths.historyDir, 'one.json'), 'utf8'), 'first chat');
  assert.equal(readFileSync(join(paths.historyDir, 'two.json'), 'utf8'), 'second chat');
  assert.equal(readdirSync(join(f.dataDir, 'backups')).length, 2);
});

test('a mandatory backup failure stops migration without modifying originals or destinations', t => {
  const f = fixture(t);
  const raw = '{"token":"fixture-keep"}';
  f.write(f.legacy, raw); f.write(join(f.history, 'chat.json'), 'source chat');
  f.write(join(f.dataDir, 'backups'), 'blocked directory');
  assert.throws(() => f.run());
  assert.equal(readFileSync(f.legacy, 'utf8'), raw);
  assert.equal(readFileSync(join(f.history, 'chat.json'), 'utf8'), 'source chat');
  assert.equal(existsSync(join(f.dataDir, 'config.json')), false);
  assert.equal(existsSync(join(f.dataDir, 'conversations')), false);
});

test('corrupt backup is never trusted or replaced', t => {
  const f = fixture(t), raw = Buffer.from('{"token":"fixture"}');
  f.write(f.legacy, raw);
  f.write(join(f.dataDir, 'backups', 'legacy-config-' + hash(raw) + '.json'), 'corrupt');
  assert.throws(() => f.run(), /备份校验失败/);
  assert.equal(existsSync(join(f.dataDir, 'config.json')), false);
});

test('interrupted history migration can retry; already copied files remain intact', t => {
  const f = fixture(t);
  f.write(f.legacy, '{}');
  f.write(join(f.history, 'a.json'), 'first'); f.write(join(f.history, 'b.json'), 'second');
  mkdirSync(join(f.dataDir, 'conversations', 'b.json'), { recursive: true });
  assert.throws(() => f.run(), /普通文件/);
  assert.equal(existsSync(join(f.dataDir, 'migrations')), false);
  assert.equal(readFileSync(join(f.dataDir, 'conversations', 'a.json'), 'utf8'), 'first');
  rmSync(join(f.dataDir, 'conversations', 'b.json'), { recursive: true });
  f.run();
  assert.equal(readFileSync(join(f.dataDir, 'conversations', 'b.json'), 'utf8'), 'second');
});

test('invalid legacy JSON is backed up, fails closed, and CLI never prints its text', t => {
  const f = fixture(t), raw = 'fixture-secret-that-must-never-be-printed invalid json';
  f.write(f.legacy, raw);
  const result = spawnSync(process.execPath, [moduleFile, '--resolve', f.legacy, '--data-dir', f.dataDir], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('fixture-secret'), false);
  assert.equal(readFileSync(join(f.dataDir, 'backups', 'legacy-config-' + hash(raw) + '.json'), 'utf8'), raw);
  assert.equal(existsSync(join(f.dataDir, 'config.json')), false);
  assert.equal(readFileSync(f.legacy, 'utf8'), raw);
});

test('history-only migration preserves raw archives even without legacy configuration', t => {
  const f = fixture(t); f.write(join(f.history, 'legacy.json'), 'old content');
  const paths = f.run();
  assert.equal(readFileSync(join(paths.historyDir, 'legacy.json'), 'utf8'), 'old content');
  assert.equal(existsSync(paths.configFile), false);
});

test('migrated real history records can resume, save, reopen and delete without resurrection', t => {
  const f = fixture(t);
  const oldStore = new HistoryStore(f.history);
  const original = oldStore.create('library/item', '合成会话');
  const paths = f.run();
  const store = new HistoryStore(paths.historyDir);
  assert.deepEqual(store.get(original.id), original);
  const resumed = { ...original, title: '继续讨论', context: { summary: '合成摘要', through: 0, revision: 1 } };
  store.save(resumed);
  f.run();
  assert.deepEqual(new HistoryStore(paths.historyDir).get(original.id), resumed);
  assert.deepEqual(oldStore.get(original.id), original);
  store.delete(original.id);
  f.run();
  assert.equal(new HistoryStore(paths.historyDir).get(original.id), null);
});

test('explicit dataDir overrides environment and CLI returns paths without secrets', t => {
  const f = fixture(t); f.write(f.legacy, '{"token":"private-fixture"}');
  const other = join(f.root, 'must-not-exist');
  const result = spawnSync(process.execPath, [moduleFile, '--resolve', f.legacy, '--data-dir', f.dataDir],
    { env: { ...process.env, PAPER_CHAT_DATA_DIR: other }, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).dataDir, f.dataDir);
  assert.equal(result.stdout.includes('private-fixture'), false);
  assert.equal(existsSync(other), false);
});

test('environment overrides isolate runtime resolution without an explicit option', t => {
  const f = fixture(t);
  const paths = resolveRuntimePaths(f.legacy, { env: { PAPER_CHAT_DATA_DIR: f.dataDir } });
  assert.equal(paths.dataDir, f.dataDir);
});

test('both nesting directions and equal source/data paths are rejected before writing', t => {
  const f = fixture(t), source = dirname(dirname(f.legacy));
  for (const dataDir of [source, join(source, 'private'), f.root]) {
    assert.throws(() => resolveRuntimePaths(f.legacy, { dataDir }), /不能相互嵌套/);
  }
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(join(f.root, 'config.json')), false);
});

test('symlink aliases cannot bypass source/data separation', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), source = dirname(dirname(f.legacy));
  mkdirSync(source, { recursive: true });
  const alias = join(f.root, 'source-alias'); symlinkSync(source, alias, 'dir');
  assert.throws(() => resolveRuntimePaths(f.legacy, { dataDir: join(alias, 'data') }), /不能相互嵌套/);
  assert.equal(existsSync(join(source, 'data')), false);
});

test('private writes accept objects/raw bytes and retain atomic modes and cleanup', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  withConfigLock(file, () => writePrivateConfig(file, { token: 'fixture', future: { nested: true } }));
  assert.equal(JSON.parse(readFileSync(file)).future.nested, true);
  const raw = Buffer.from('{"raw":"保留"}\r\n');
  withConfigLock(file, () => writePrivateConfig(file, raw));
  assert.deepEqual(readFileSync(file), raw);
  assert.deepEqual(readdirSync(f.dataDir), ['config.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('locks return callback results, release on exceptions, and reject same-process nesting', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  assert.equal(withConfigLock(file, () => 42), 42);
  assert.throws(() => withConfigLock(file, () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.throws(() => withConfigLock(file, () => withConfigLock(file, () => 0)), /不能重复进入/);
  assert.throws(() => withConfigLock(file, () => Promise.resolve()), /必须同步/);
  assert.equal(withConfigLock(file, () => 'available'), 'available');
  assert.equal(existsSync(file + '.lock'), false);
  assert.deepEqual(readdirSync(f.dataDir), []);
});

const importLock = `import {withConfigLock,writePrivateConfig,prepareConfig} from ${JSON.stringify(pathToFileURL(moduleFile).href)};`;
function runChild(code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
}

test('a dead owner lock is recovered; empty orphan locks are safe to recover too', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  const result = runChild(importLock + `withConfigLock(${JSON.stringify(file)},()=>process.exit(0));`);
  assert.equal(result.status, 0); assert.equal(existsSync(file + '.lock'), true);
  assert.equal(withConfigLock(file, () => 'recovered'), 'recovered');
  assert.equal(existsSync(file + '.lock'), false);
  mkdirSync(file + '.lock');
  assert.equal(withConfigLock(file, () => 'empty recovered'), 'empty recovered');
});

test('a live owner is never stolen and contention has a bounded five-second timeout', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  withConfigLock(file, () => {
    const result = runChild(importLock + `const start=performance.now();try{withConfigLock(${JSON.stringify(file)},()=>{throw new Error('stolen')});process.exit(2)}catch(error){console.log(JSON.stringify({timeout:error.message.includes('超时'),elapsed:performance.now()-start}));}`);
    assert.equal(result.status, 0);
    const state = JSON.parse(result.stdout);
    assert.equal(state.timeout, true); assert.ok(state.elapsed >= 4900 && state.elapsed < 7000);
    assert.equal(existsSync(file + '.lock'), true);
  });
  assert.equal(existsSync(file + '.lock'), false);
});

test('real concurrent processes read the latest configuration without losing fields or updates', async t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  const original = { count: 0, token: 'fixture-token', customPrompt: '合成提示词', external: { apiKey: 'fixture-key' }, contextBudget: { contextWindow: 32768 }, unknown: { keep: true } };
  f.write(file, JSON.stringify(original));
  const script = importLock + `import {readFileSync} from 'node:fs';const file=${JSON.stringify(file)};for(let i=0;i<10;i++)withConfigLock(file,()=>{const current=JSON.parse(readFileSync(file));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3);current.count++;writePrivateConfig(file,current)});`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  })));
  for (const result of results) assert.deepEqual(result, { code: 0, out: '', err: '' });
  assert.deepEqual(JSON.parse(readFileSync(file)), { ...original, count: 40 });
  assert.deepEqual(readdirSync(f.dataDir), ['config.json']);
});

test('prepare fills only missing fields, preserving raw bytes when nothing is missing', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  const raw = '{\r\n"token":"fixture","port":23456,"customPrompt":"retain","contextBudget":{"contextWindow":32768},"codexNetworkProxy":"manual","unknown":{"nested":true}\r\n}\r\n';
  f.write(file, raw);
  prepareConfig(file, { proxy: 'http://localhost:8000' });
  assert.equal(readFileSync(file, 'utf8'), raw);
  f.write(file, '{"unknown":{"keep":true},"external":{"apiKey":"fixture"},"contextBudget":{"contextWindow":65536}}');
  prepareConfig(file, { proxy: 'http://localhost:80' });
  const next = JSON.parse(readFileSync(file));
  assert.deepEqual(next.unknown, { keep: true }); assert.equal(next.external.apiKey, 'fixture');
  assert.equal(next.contextBudget.contextWindow, 65536); assert.equal(next.port, 23127);
  assert.equal(next.token.length, 64); assert.equal(next.codexNetworkProxy, 'http://localhost:80');
});

test('prepare CLI emits no values and malformed JSON errors cannot echo configuration text', t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  const result = runChild(`import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,[${JSON.stringify(moduleFile)},'--prepare',${JSON.stringify(file)},'--proxy','http://localhost:8888'],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:r.status,out:r.stdout,err:r.stderr}));`);
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { status: 0, out: '', err: '' });
  const raw = '{"token":SYNTHETIC_PRIVATE_CANARY}'; f.write(file, raw);
  const invalid = spawnSync(process.execPath, [moduleFile, '--prepare', file], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr.includes('SYNTHETIC_PRIVATE_CANARY'), false);
  assert.equal(readFileSync(file, 'utf8'), raw); assert.equal(existsSync(file + '.lock'), false);
  assert.throws(() => prepareConfig(file), /本机配置格式错误/);
});

test('simultaneous prepare calls create a single stable capability without changing manual settings', async t => {
  const f = fixture(t), file = join(f.dataDir, 'config.json');
  f.write(file, '{"model":"manual","customPrompt":"retain","contextBudget":{"contextWindow":32768}}');
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [moduleFile, '--prepare', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  })));
  assert.ok(results.every(r => r.code === 0 && r.output === ''));
  const saved = readFileSync(file, 'utf8'); prepareConfig(file); assert.equal(readFileSync(file, 'utf8'), saved);
  const config = JSON.parse(saved); assert.equal(config.token.length, 64); assert.equal(config.model, 'manual');
  assert.equal(config.customPrompt, 'retain'); assert.equal(config.contextBudget.contextWindow, 32768);
});
