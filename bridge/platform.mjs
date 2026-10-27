import { t } from './ui-text.mjs';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// Resolve Windows npm installations to their JS entry point instead of executing
// a .cmd shim through a shell. All protocol arguments remain separate arguments.
export function windowsCodexCommand({ env = process.env, exists = existsSync, node = process.execPath } = {}) {
  const get = name => env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const resolve = candidate => {
    if (/\.exe$/i.test(candidate) && exists(candidate)) return { executable: candidate, prefix: [] };
    if (/\.m?js$/i.test(candidate) && exists(candidate)) return { executable: node, prefix: [candidate] };
    const directory = win32.dirname(candidate);
    const entry = win32.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (/codex(?:\.cmd|\.bat)?$/i.test(win32.basename(candidate)) && exists(entry)) return { executable: node, prefix: [entry] };
    return null;
  };
  const override = get('PAPER_CHAT_CODEX');
  if (override) {
    const command = resolve(override);
    if (command) return command;
    throw new Error(t("errors.platform.error01"));
  }
  const directories = (get('PATH') || '').split(';').map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  if (get('APPDATA')) directories.push(win32.join(get('APPDATA'), 'npm'));
  for (const directory of directories) {
    const native = resolve(win32.join(directory, 'codex.exe'));
    if (native) return native;
    const npm = resolve(win32.join(directory, 'codex.cmd'));
    if (npm) return npm;
  }
  throw new Error(t("errors.platform.error02"));
}
