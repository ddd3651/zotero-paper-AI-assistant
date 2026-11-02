// Importing this module never accesses configuration or creates directories.
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync, realpathSync,
  openSync, closeSync, fsyncSync, linkSync, rmSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export function defaultDataDir({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const value = name => platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : env[name];
  const override = value('PAPER_CHAT_DATA_DIR');
  if (override) return paths.resolve(override);
  if (platform === 'win32') return paths.join(value('APPDATA') || paths.join(homeDir, 'AppData', 'Roaming'), 'Zotero Paper Chat');
  if (platform === 'darwin') return paths.join(homeDir, 'Library', 'Application Support', 'Zotero Paper Chat');
  const xdg = value('XDG_DATA_HOME');
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(homeDir, '.local', 'share'), 'Zotero Paper Chat');
}

function stat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!stat(directory)?.isDirectory()) throw new Error('数据目录必须是普通目录');
}
function regularFile(file) {
  const info = stat(file);
  if (info && !info.isFile()) throw new Error('迁移文件必须是普通文件');
  return !!info;
}
function syncDirectory(directory) {
  // Windows and some filesystems do not support directory fsync.
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error.code)
        && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
  }
  finally { if (fd !== undefined) closeSync(fd); }
}

function canonicalPath(file) {
  let parent = path.resolve(file);
  const tail = [];
  while (!stat(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('无法解析数据目录');
    parent = next;
  }
  return path.join(realpathSync(parent), ...tail);
}
function inside(file, directory) {
  const relative = path.relative(directory, file);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function separateDataDir(dataDir, legacy) {
  const source = canonicalPath(path.dirname(path.dirname(legacy)));
  const data = canonicalPath(dataDir);
  if (inside(source, data) || inside(data, source)) throw new Error('数据目录与源码目录不能相互嵌套');
}

const heldLocks = new Set();
const pause = new Int32Array(new SharedArrayBuffer(4));
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM is a live owner.
}
function removeOwner(lock, owner) {
  // Never recursively remove a shared lock path. The unique owner filename
  // makes a stale reader harmless if another process has already recovered it.
  try { unlinkSync(path.join(lock, owner)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { rmdirSync(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}
function recoverDeadLock(lock) {
  let entries;
  try { entries = readdirSync(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) {
    // Acquisition publishes a populated candidate atomically, so an empty
    // directory has no live owner. rmdir cannot remove a newly acquired lock.
    try { rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    return;
  }
  if (entries.length !== 1) return;
  const match = /^owner-([1-9][0-9]*)-([a-f0-9-]{36})\.json$/.exec(entries[0]);
  if (!match) return;
  const pid = Number(match[1]);
  if (Number.isSafeInteger(pid) && pid <= 2147483647 && !ownerAlive(pid)) removeOwner(lock, entries[0]);
}

/** Synchronous cross-process directory lock. fn MUST read config inside it.
 * Waits at most 5s (20ms steps); CLI/startup and small settings saves only.
 * Reentrant/async callbacks are rejected. writePrivateConfig does NOT relock.
 */
export function withConfigLock(configFile, fn) {
  const file = canonicalPath(configFile), key = process.platform === 'win32' ? file.toLowerCase() : file;
  if (heldLocks.has(key)) throw new Error('配置锁不能重复进入');
  privateDirectory(path.dirname(file));
  const lock = file + '.lock', nonce = randomUUID();
  const candidate = lock + '.' + nonce + '.candidate';
  const owner = `owner-${process.pid}-${nonce}.json`;
  const deadline = performance.now() + 5000;
  let acquired = false;
  try {
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(path.join(candidate, owner), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    while (!acquired) {
      try { renameSync(candidate, lock); acquired = true; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const info = stat(lock);
        if (info && !info.isDirectory()) throw error;
        if (info) recoverDeadLock(lock);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('等待配置锁超时，请稍后重试');
        Atomics.wait(pause, 0, 0, Math.min(20, remaining));
      }
    }
    heldLocks.add(key);
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('配置锁回调必须同步执行');
    return result;
  } finally {
    if (acquired) { heldLocks.delete(key); removeOwner(lock, owner); }
    else rmSync(candidate, { recursive: true, force: true });
  }
}

/** Atomic private write; callers performing read/modify/write MUST hold the
 * config lock around the whole operation, not merely around this write.
 */
export function writePrivateConfig(file, bytesOrObj) {
  regularFile(file);
  privateDirectory(path.dirname(file));
  const bytes = Buffer.isBuffer(bytesOrObj) || typeof bytesOrObj === 'string'
    ? bytesOrObj : JSON.stringify(bytesOrObj, null, 2) + '\n';
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { rmSync(temporary, { force: true }); }
}

function parseConfig(raw) {
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('本机配置格式错误，已保留原文件'); }
}
function safeProxy(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password && !url.search && !url.hash) return value;
  } catch {}
  throw new Error('代理地址必须是不含凭据的本机HTTP或HTTPS地址');
}
export function prepareConfig(configFile, { proxy } = {}) {
  return withConfigLock(configFile, () => {
    regularFile(configFile);
    const exists = !!stat(configFile);
    const config = exists ? parseConfig(readFileSync(configFile)) : {};
    let changed = !exists;
    if (!Object.hasOwn(config, 'port')) { config.port = 23127; changed = true; }
    if (!Object.hasOwn(config, 'token')) { config.token = randomBytes(32).toString('hex'); changed = true; }
    if (proxy !== undefined && !Object.hasOwn(config, 'codexNetworkProxy')) { config.codexNetworkProxy = safeProxy(proxy); changed = true; }
    if (changed) writePrivateConfig(configFile, config);
  });
}

// Publish a fully written file without replacing an existing destination, even
// if the builder and bridge start at the same time. NTFS supports hard links.
function writeExclusive(target, bytes) {
  if (regularFile(target)) return false;
  privateDirectory(path.dirname(target));
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); }
    catch (error) { if (error.code === 'EEXIST' && regularFile(target)) return false; throw error; }
    syncDirectory(path.dirname(target));
    return true;
  } finally { rmSync(temporary, { force: true }); }
}

function copyHistory(source, target) {
  const info = stat(source);
  if (!info) return;
  if (!info.isDirectory()) throw new Error('旧历史目录必须是普通目录');
  if (source === target) return;
  if (target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
    throw new Error('新旧历史目录不能相互嵌套');
  }
  privateDirectory(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyHistory(from, to);
    else if (entry.isFile()) writeExclusive(to, readFileSync(from));
    else throw new Error('历史迁移不支持符号链接或特殊文件');
  }
}

/**
 * Called by the build CLI and server MAIN only, never inside createBridge().
 * The caller reads configFile, gives historyDir to createBridge(), and uses
 * runtimeDir as the Codex cwd. An explicit dataDir (e.g. --data-dir) wins over
 * PAPER_CHAT_DATA_DIR. All migration writes are confined to this dataDir.
 * Legacy data is copied, never moved/deleted; existing destinations win.
 * Errors are fatal: do not generate fresh credentials after a migration error.
 */
export function resolveRuntimePaths(legacyConfigFile, options = {}) {
  const dataDir = path.resolve(options.dataDir || defaultDataDir(options));
  const configFile = path.join(dataDir, 'config.json');
  const historyDir = path.join(dataDir, 'conversations');
  const runtimeDir = path.join(dataDir, 'runtime');
  const legacy = path.resolve(legacyConfigFile);
  const legacyHistoryDir = path.join(path.dirname(legacy), 'runtime', 'conversations');
  separateDataDir(dataDir, legacy);
  privateDirectory(dataDir);
  return withConfigLock(configFile, () => {
  regularFile(configFile);
  // Using the fixed configuration as the entry point is already migrated.
  if (legacy !== configFile) {
    const digest = createHash('sha256').update(legacy).digest('hex');
    const marker = path.join(dataDir, 'migrations', digest + '.json');
    const hasConfig = regularFile(legacy), hasHistory = !!stat(legacyHistoryDir);
    // Backup the exact bytes, including unknown fields, before ANY import.
    if (hasConfig) {
      const raw = readFileSync(legacy);
      const hash = createHash('sha256').update(raw).digest('hex');
      const backup = path.join(dataDir, 'backups', 'legacy-config-' + hash + '.json');
      writeExclusive(backup, raw);
      if (!readFileSync(backup).equals(raw)) throw new Error('旧配置备份校验失败，已停止迁移');
      if (!regularFile(configFile)) {
        let config;
        try { config = JSON.parse(raw.toString('utf8')); } catch { throw new Error('旧配置格式错误，已保留原始备份'); }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('旧配置必须是JSON对象');
        writeExclusive(configFile, raw);
      }
    }
    // A receipt prevents deleted chats from reappearing on every restart.
    // It is written only after a complete copy; interrupted copies can retry.
    if (!regularFile(marker) && (hasConfig || hasHistory)) {
      copyHistory(legacyHistoryDir, historyDir);
      writeExclusive(marker, Buffer.from(JSON.stringify({ version: 1 }) + '\n'));
    }
  }
  privateDirectory(historyDir);
  privateDirectory(runtimeDir);
  return { dataDir, configFile, historyDir, runtimeDir, legacyHistoryDir };
  });
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const [operation, file, flag, value, ...extra] = process.argv.slice(2);
    if (!file || extra.length) throw new Error('无效参数');
    if (operation === '--resolve' && (!flag || (flag === '--data-dir' && value))) {
      console.log(JSON.stringify(resolveRuntimePaths(file, { dataDir: value })));
    } else if (operation === '--prepare' && (!flag || (flag === '--proxy' && value))) {
      prepareConfig(file, { proxy: value }); // Deliberately no configuration output.
    } else throw new Error('无效参数');
  } catch (error) {
    // Never echo JSON parsing errors, credential values, or configuration bytes.
    console.error('无法迁移本机配置或历史记录，原文件已保留。请检查数据目录和备份权限。' + (error.code ? ` (${error.code})` : ''));
    process.exitCode = 1;
  }
}
