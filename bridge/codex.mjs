import { t } from './ui-text.mjs';
import { windowsCodexCommand } from './platform.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

export const CHATGPT_CODEX_URL = 'https://chatgpt.com/backend-api/codex';

export function codexLaunchOptions(sourceEnv = process.env, networkProxy = '') {
  const env = { ...sourceEnv };
  // A ChatGPT account check alone does not prevent a global gateway override.
  // Scope routing overrides to this child process; leave the user's CLI settings intact.
  const routingKeys = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'CODEX_OPENAI_BASE_URL']);
  // Windows environment names are case-insensitive.
  for (const name of Object.keys(env)) if (routingKeys.has(name.toUpperCase())) delete env[name];
  if (networkProxy) {
    const proxy = new URL(networkProxy);
    if (!['http:', 'https:'].includes(proxy.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)
      || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error(t("errors.codex.error01"));
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] ||= networkProxy;
  }
  return { env, args: ['app-server', '--stdio', '-c', 'model_provider="openai"',
    '-c', `openai_base_url="${CHATGPT_CODEX_URL}"`] };
}

export function findCodex() {
  if (process.env.PAPER_CHAT_CODEX) return process.env.PAPER_CHAT_CODEX;
  for (const path of [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  ]) if (existsSync(path)) return path;
  return 'codex';
}

export class CodexClient extends EventEmitter {
  constructor({ cwd, executable, networkProxy = '' } = {}) {
    super();
    this.cwd = cwd;
    this.executable = executable;
    this.networkProxy = networkProxy;
    this.nextId = 1;
    this.pending = new Map();
    this.jobs = new Map();
  }

  async start() {
    const { env, args } = codexLaunchOptions(process.env, this.networkProxy);
    const command = process.platform === 'win32'
      ? windowsCodexCommand({ env: this.executable ? { ...env, PAPER_CHAT_CODEX: this.executable } : env })
      : { executable: this.executable || findCodex(), prefix: [] };
    const proc = this.proc = spawn(command.executable, [...command.prefix, ...args], {
      cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.on('error', error => { if (this.proc === proc) this.failAll(error); });
    this.proc.stderr.on('data', data => {
      // Keep diagnostics out of the protocol and avoid recording account secrets.
      this.lastDiagnostic = String(data).slice(-1000);
    });
    proc.on('exit', (code, signal) => { if (this.proc === proc) this.failAll(new Error(t("errors.codex.format01", {value1: (signal || code)}))); });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      if (this.proc !== proc) return;
      try { this.onMessage(JSON.parse(line)); }
      catch (error) { this.emit('diagnostic', error.message); }
    });
    await this.call('initialize', {
      clientInfo: { name: 'zotero_paper_chat', title: 'Zotero Paper Chat', version: '0.6.3' },
    });
    this.send({ method: 'initialized', params: {} });
    const { account } = await this.call('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') {
      this.close();
      throw new Error(t("errors.codex.error02"));
    }
    this.account = { type: account.type, planType: account.planType };
    return this.account;
  }

  send(message) {
    if (!this.proc?.stdin.writable) throw new Error(t("errors.codex.error03"));
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params = {}, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t("errors.codex.format02", {method: (method)})));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  onMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      // Reading papers never requires approving commands, writes, or external tools.
      this.send({ id: message.id, error: { code: -32601, message: 'Paper Chat does not approve tool actions' } });
      return;
    }
    const params = message.params || {};
    const job = this.jobs.get(params.threadId);
    if (!job) return;
    if (['item/started', 'item/completed'].includes(message.method) && params.item?.type === 'webSearch') {
      const item = params.item, action = item.action || {};
      job.onSearch?.({ id: item.id, status: message.method === 'item/started' ? 'searching' : 'completed',
        query: String(action.query || item.query || action.queries?.join(' / ') || '').slice(0, 1000) });
    }
    // Summaries are explicitly published by the provider. Never forward raw reasoning/content.
    if (message.method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') {
      job.summaries ||= new Map();
      const key = `${params.itemId}/${params.summaryIndex || 0}`;
      job.summaries.set(key, (job.summaries.get(key) || '') + params.delta);
      job.onSummary?.([...job.summaries.values()].join('\n\n'));
    }
    if (message.method === 'item/completed' && params.item?.type === 'reasoning' && Array.isArray(params.item.summary)) {
      job.summaries ||= new Map();
      for (const key of job.summaries.keys()) if (key.startsWith(params.item.id + '/')) job.summaries.delete(key);
      params.item.summary.forEach((text, index) => {
        if (typeof text === 'string') job.summaries.set(`${params.item.id}/${index}`, text);
      });
      job.onSummary?.([...job.summaries.values()].join('\n\n'));
    }
    if (message.method === 'item/agentMessage/delta') {
      job.onDelta?.(params.delta);
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      job.messages.set(params.item.id, params.item.text);
    }
    if (message.method === 'turn/completed') {
      clearTimeout(job.timer);
      this.jobs.delete(params.threadId);
      if (params.turn.status !== 'completed') {
        job.reject(new Error(params.turn.error?.message || t("errors.codex.format03", {value1: (params.turn.status === 'interrupted' ? t("errors.codex.text01") : t("errors.codex.text02"))})));
      } else job.resolve([...job.messages.values()].join('\n'));
    }
  }

  async ask({ threadId, prompt, model, effort, instructions, webSearch = false, onDelta, onSummary, onSearch, signal, timeoutMs = 240000 }) {
    if (signal?.aborted) throw new Error(t("errors.codex.error04"));
    const { account } = await this.call('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error(t("errors.codex.error05"));
    const createdThread = !threadId;
    if (!threadId) {
      const result = await this.call('thread/start', {
        ...(model ? { model } : {}), modelProvider: 'openai', cwd: this.cwd,
        approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        baseInstructions: instructions || '你是论文阅读助手。只根据用户提供的论文内容回答，不调用任何工具。',
        config: { openai_base_url: CHATGPT_CODEX_URL,
          features: { shell_tool: false, apps: false, plugins: false }, web_search: webSearch ? 'live' : 'disabled' },
      });
      threadId = result.thread.id;
    }
    if (this.jobs.has(threadId)) throw new Error(t("errors.codex.error06"));
    let interrupt;
    const answerPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.jobs.get(threadId);
        this.jobs.delete(threadId);
        if (current?.turnId) this.call('turn/interrupt', { threadId, turnId: current.turnId }).catch(() => {});
        reject(new Error(t("errors.codex.error07")));
      }, timeoutMs);
      this.jobs.set(threadId, { resolve, reject, timer, onDelta, onSummary, onSearch, messages: new Map() });
    });
    // Attach a rejection handler immediately: cancellation can arrive during turn/start.
    answerPromise.catch(() => {});
    try {
      const { turn } = await this.call('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }], summary: 'detailed', ...(effort ? { effort } : {}),
        ...(model ? { model } : {}), approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      });
      const job = this.jobs.get(threadId);
      if (job) job.turnId = turn.id;
      interrupt = () => this.call('turn/interrupt', { threadId, turnId: turn.id }).catch(() => {});
      signal?.addEventListener('abort', interrupt, { once: true });
      if (signal?.aborted) interrupt();
      return { threadId, text: await answerPromise };
    } catch (error) {
      const job = this.jobs.get(threadId);
      if (job) { clearTimeout(job.timer); this.jobs.delete(threadId); }
      if (createdThread) await this.release(threadId);
      throw error;
    } finally {
      if (interrupt) signal?.removeEventListener('abort', interrupt);
    }
  }

  release(threadId) {
    return this.call('thread/unsubscribe', { threadId }).catch(() => {});
  }

  failAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    for (const j of this.jobs.values()) { clearTimeout(j.timer); j.reject(error); }
    this.pending.clear(); this.jobs.clear();
  }

  close() {
    this.failAll(new Error(t("errors.codex.error08")));
    const proc = this.proc; this.proc = null;
    proc?.kill();
  }
}
