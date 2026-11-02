import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upgradeDefaults, loadPersistedConfig } from '../bridge/config.mjs';

test('legacy stock budget upgrades to 500k while explicit capacities and unknown settings are preserved', () => {
  const original = { token: 'fixture-capability', model: 'chosen', effort: 'high', customPrompt: '原样保留',
    external: { baseUrl: 'https://provider.invalid', model: 'custom', apiKey: 'fixture-only-secret' },
    contextBudget: { contextWindow: 32768, summaryTokens: 2048 }, unknown: { retained: [1, 2] } };
  const upgraded = upgradeDefaults(original);
  assert.deepEqual(upgraded, { ...original, contextBudget: { ...original.contextBudget, contextWindow: 500000 } });
  assert.equal(original.contextBudget.contextWindow, 32768);
  for (const window of [32768, 64000, 500000]) {
    const explicit = { ...original, contextBudgetUserSet: true, contextBudget: { contextWindow: window } };
    assert.deepEqual(upgradeDefaults(explicit), explicit);
  }
  assert.equal(upgradeDefaults({ ...original, contextBudget: { contextWindow: 64000 } }).contextBudget.contextWindow, 64000);
});

test('default migration creates a byte-exact private backup before changing one field and is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const bytes = '{ "unknown": true, "contextBudget": { "contextWindow": 32768 }, "token": "fixture-token" }\n';
  writeFileSync(file, bytes);
  assert.equal(loadPersistedConfig(file).contextBudget.contextWindow, 500000);
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1); assert.equal(readFileSync(join(dir, 'backups', backups[0]), 'utf8'), bytes);
  const after = readFileSync(file, 'utf8');
  loadPersistedConfig(file);
  assert.equal(readFileSync(file, 'utf8'), after); assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});

test('malformed local config errors never include sensitive source text', t => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-invalid-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json'); writeFileSync(file, '{"apiKey":"fixture-sensitive-string", invalid}');
  assert.throws(() => loadPersistedConfig(file), error => !error.message.includes('fixture-sensitive-string'));
});
