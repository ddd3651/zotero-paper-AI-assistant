import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsCodexCommand } from '../bridge/platform.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resolve = (env, files) => windowsCodexCommand({ env, exists: path => files.includes(path), node: 'node.exe' });
test('Windows prefers native executable and honors case-insensitive PATH', () => {
  const exe = String.raw`C:\Tools\codex.exe`;
  assert.deepEqual(resolve({ Path: String.raw`C:\Tools` }, [exe]), { executable: exe, prefix: [] });
});
test('Windows npm Codex uses node and JS arguments without a command shell', () => {
  const entry = String.raw`C:\Users\中文 & 100%\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const command = resolve({ APPDATA: String.raw`C:\Users\中文 & 100%\AppData\Roaming` }, [entry]);
  assert.deepEqual(command, { executable: 'node.exe', prefix: [entry] });
});
test('Windows override is authoritative and unsupported shims fail explicitly', () => {
  const entry = String.raw`D:\custom\node_modules\@openai\codex\bin\codex.js`;
  assert.deepEqual(resolve({ PAPER_CHAT_CODEX: String.raw`D:\custom\codex.cmd` }, [entry]).prefix, [entry]);
  assert.throws(() => resolve({ PAPER_CHAT_CODEX: String.raw`D:\missing.cmd`, PATH: String.raw`C:\Tools` }, [String.raw`C:\Tools\codex.exe`]), /PAPER_CHAT_CODEX/);
  assert.throws(() => resolve({}, []), /找不到\s*Windows/);
});
test('real child process preserves Unicode and shell metacharacters in JS entry paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'paper-chat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "中文 & 100% ! 'space"); mkdirSync(dir);
  const entry = join(dir, 'codex.mjs');
  writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const command = windowsCodexCommand({ env: { PAPER_CHAT_CODEX: entry } });
  const args = ['app-server', '-c', 'model_provider="openai"'];
  const child = spawn(command.executable, [...command.prefix, ...args], { windowsHide: true });
  let output = ''; child.stdout.on('data', data => { output += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output), args);
});
