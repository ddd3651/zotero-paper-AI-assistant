import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './ui-text.mjs';
import { randomUUID, createHash } from 'node:crypto';

export const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export function scrub(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  return value;
}

// Only explicitly constructed conversation records enter this store. Provider settings,
// custom/system prompts and native thread identifiers are deliberately process-local.
export class HistoryStore {
  constructor(directory, secrets = () => []) {
    this.directory = directory; this.secrets = secrets;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
  }
  path(id) {
    if (!validId(id)) throw new Error(t("errors.history.invalidId"));
    return join(this.directory, id + '.json');
  }
  save(record) {
    const clean = scrub(record, this.secrets());
    const target = this.path(record.id), temporary = target + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(clean) + '\n', { mode: 0o600, flag: 'wx' });
      const fd = openSync(temporary, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, target);
      // Directory fsync is not supported on every platform; the atomic file remains valid.
      try { const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch {}
    } finally { rmSync(temporary, { force: true }); }
    return clean;
  }
  get(id) {
    let record;
    try { record = JSON.parse(readFileSync(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error(t("errors.history.readFailed")); }
    if (!record || record.id !== id || typeof record.paperId !== 'string' || !Array.isArray(record.turns) || !record.context ||
        typeof record.context.summary !== 'string' || !Number.isSafeInteger(record.context.through) || record.context.through < 0 || record.context.through > record.turns.length ||
        !Number.isSafeInteger(record.context.revision) || record.turns.some(turn => !turn || !validId(turn.id) || typeof turn.user !== 'string' || typeof turn.assistant !== 'string' ||
          !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status))) throw new Error(t("errors.history.invalidRecord"));
    return scrub(record, this.secrets());
  }
  list(paperId) {
    const result = [];
    result.warnings = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
      let record;
      try { record = this.get(name.slice(0, -5)); } catch {
        result.warnings.push({ conversationId: name.slice(0, -5), error: t("errors.history.readFailed") }); continue;
      }
      if (!record) continue;
      if (paperId !== undefined && record.paperId !== paperId) continue;
      result.push({ id: record.id, conversationId: record.id, paperId: record.paperId, title: record.title,
        createdAt: record.createdAt, updatedAt: record.updatedAt, messageCount: messages(record).length,
        turnCount: record.turns.length });
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  create(paperId, title = t("common.newChat"), data = {}) {
    if (typeof paperId !== 'string' || !paperId || paperId.length > 160) throw new Error(t("errors.history.invalidPaperId"));
    title = validateTitle(title);
    const now = Date.now();
    return this.save({ id: randomUUID(), paperId, title, createdAt: now, updatedAt: now, turns: [], context: { summary: '', through: 0, revision: 0 }, ...data });
  }
  delete(id) { rmSync(this.path(id), { force: true }); }
}
export function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error(t("errors.history.invalidTitle"));
  return title.trim();
}
export function messages(record) {
  return record.turns.flatMap(turn => turn.importedMessages || [
    { id: turn.id + ':user', turnId: turn.id, role: 'user', text: turn.question, content: turn.question,
      createdAt: turn.startedAt, status: turn.status, currentPage: turn.currentPage, selection: turn.selection,
      selectionPage: turn.selectionPage, pageReferences: turn.pageReferences, sourcePages: turn.sourcePages },
    { id: turn.id + ':assistant', turnId: turn.id, role: 'assistant', text: turn.assistant, content: turn.assistant,
      createdAt: turn.finishedAt || turn.startedAt, status: turn.status, summary: turn.summary || '',
      thinking: { summary: turn.summary || '' }, searches: turn.searches || [], citations: turn.citations || [], error: turn.error || null },
  ]);
}

export function importData(body, secrets = []) {
  const fail = () => { throw new Error(t("errors.history.invalidImport")); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  const pageCount = body.pageCount ?? 0;
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || pageCount > 10000 ||
      (body.paperTitle != null && (typeof body.paperTitle !== 'string' || body.paperTitle.length > 4000))) fail();
  const allowedPages = body.allowedPages ?? [];
  if (!Array.isArray(allowedPages) || allowedPages.length > 10000 || allowedPages.some(p => !Number.isSafeInteger(p) || p < 1 || p > (pageCount || 10000))) fail();
  const metadata = { pageCount, paperTitle: body.paperTitle || '', allowedPages: [...new Set(allowedPages)] };
  if (!Object.hasOwn(body, 'messages')) return { ...metadata, turns: [] };
  if (!Array.isArray(body.messages) || body.messages.length > 2000 || typeof body.importKey !== 'string' || !body.importKey || body.importKey.length > 1000) fail();
  const entries = body.messages.map(entry => {
    if (!entry || !['user', 'assistant'].includes(entry.role)) fail();
    const text = entry.text ?? entry.content;
    if (typeof text !== 'string' || text.length > 500000) fail();
    const activity = entry.activity || {};
    const timestamps = {};
    for (const key of ['startedAt', 'firstTextAt', 'finishedAt']) {
      const value = entry[key] ?? activity[key];
      if (value != null) { if (!Number.isFinite(value) || value < 0) fail(); timestamps[key] = value; }
    }
    const status = entry.status || activity.status || 'completed';
    if (!['completed', 'failed', 'cancelled', 'interrupted', 'running'].includes(status)) fail();
    const summary = entry.summary ?? activity.summary ?? '';
    if (typeof summary !== 'string' || summary.length > 50000) fail();
    const pageReferences = entry.pageReferences ?? metadata.allowedPages;
    if (!Array.isArray(pageReferences) || pageReferences.some(p => !Number.isSafeInteger(p) || p < 1 || p > (pageCount || 10000))) fail();
    return scrub({ role: entry.role, text, content: text, status: status === 'running' ? 'interrupted' : status,
      summary, pageReferences, ...timestamps }, secrets);
  });
  if (JSON.stringify(entries).length > 2500000) fail();
  const turns = [];
  for (const entry of entries) {
    let turn = turns.at(-1);
    if (entry.role === 'user' || !turn || turn.importedMessages.some(m => m.role === 'assistant')) {
      turn = { id: randomUUID(), user: '', question: '', assistant: '', startedAt: entry.startedAt || Date.now(), status: 'interrupted',
        pageReferences: entry.pageReferences, citations: [], importedMessages: [] }; turns.push(turn);
    }
    entry.id = turn.id + ':' + entry.role; entry.turnId = turn.id; turn.importedMessages.push(entry);
    if (entry.role === 'user') { turn.user = entry.text; turn.question = entry.text; }
    else { turn.assistant = entry.text; turn.status = entry.status; turn.summary = entry.summary; turn.finishedAt = entry.finishedAt;
      turn.citations = [...new Set(entry.text.match(/paperchat:[^\s)"<>]+|https?:\/\/[^\s)"<>]+/g) || [])]; }
  }
  const hash = value => createHash('sha256').update(value).digest('hex');
  // Digest excludes generated IDs/timestamps, so retries across restarts remain idempotent.
  const normalized = entries.map(({ id, turnId, ...entry }) => entry);
  return { ...metadata, turns, importKey: hash(body.paperId + '\0' + body.importKey), importDigest: hash(JSON.stringify(normalized)) };
}
