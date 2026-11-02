import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONTEXT_WINDOW } from './context.mjs';
import { withConfigLock } from './paths.mjs';

export function upgradeDefaults(config) {
  const next = { ...config };
  // Older versions persisted the stock 32K default during unrelated settings
  // saves. Preserve all non-default values and explicitly marked user choices.
  if (config.contextBudget?.contextWindow === 32768 && config.contextBudgetUserSet !== true) {
    next.contextBudget = { ...config.contextBudget, contextWindow: DEFAULT_CONTEXT_WINDOW };
  }
  return next;
}

export function readPrivateConfig(configFile) {
  const raw = readFileSync(configFile); let config;
  try { config = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('本机配置格式错误，原文件已保留'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('本机配置格式错误，原文件已保留');
  return { raw, config };
}

function syncFile(path) {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); } catch {}
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadPersistedConfig(configFile) {
  return withConfigLock(configFile, () => {
    const { raw, config } = readPrivateConfig(configFile);
    const next = upgradeDefaults(config);
    if (JSON.stringify(config) === JSON.stringify(next)) return config;
    const directory = dirname(configFile), backups = join(directory, 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const backup = join(backups, 'defaults-' + createHash('sha256').update(raw).digest('hex') + '.json');
    try { writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!readFileSync(backup).equals(raw)) throw new Error('Configuration backup verification failed');
    syncFile(backup); syncDirectory(backups);
    const temporary = configFile + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      syncFile(temporary);
      renameSync(temporary, configFile);
      syncDirectory(directory);
    } finally { rmSync(temporary, { force: true }); }
    return next;
  });
}
