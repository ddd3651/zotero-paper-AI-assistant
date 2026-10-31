import { t } from './ui-text.mjs';
import http from 'node:http';
import { askExternal, normalizeExternal, redactError } from './external.mjs';
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { HistoryStore, validateTitle, messages, scrub, importData } from './history.mjs';
import { contextBudget, estimateTokens, contextInfo, historyPrompt, compactionEnd, SUMMARY_INSTRUCTIONS, budgetPaper, retrieveHistory, retrievalPrompt, excerptWithin } from './context.mjs';
import { CodexClient } from './codex.mjs';
import { INSTRUCTIONS, validatePaperRequest, buildPrompt, contextHash } from './paper.mjs';
import { readModels, selectSettings, composeInstructions } from './models.mjs';

function mergePaper(cached, paper) {
  // Keep page recency in insertion order, replacing earlier copies of the same page.
  const pages = new Map((cached?.pages || []).filter(page => page.number <= paper.pageCount)
    .map(page => [page.number, page]));
  const incoming = new Set(paper.pages.map(page => page.number));
  for (const page of paper.pages) {
    pages.delete(page.number);
    pages.set(page.number, page);
  }
  let chars = [...pages.values()].reduce((total, page) => total + page.text.length, 0);
  for (const [number, page] of pages) {
    if (chars <= 400000 && pages.size <= 1000) break;
    if (incoming.has(number)) continue;
    pages.delete(number);
    chars -= page.text.length;
  }
  return { ...paper, pages: [...pages.values()] };
}

// Importing this module does not read configuration, launch Codex or listen on a port.
export function createBridge({ config, codex, configFile, historyDir }) {
  config = { ...config, contextBudget: contextBudget(config.contextBudget) };
  const store = new HistoryStore(historyDir || join(dirname(configFile), 'runtime', 'conversations'),
    () => [config.token, config.external?.apiKey]);
  const sessions = new Map();
  const active = new Map();
  const locks = new Set();
  const jobs = new Map();
  let startupError = null;
  let codexConnecting = true;
  let models = [];
  let settings = selectSettings(models, config);
  const initializeCodex = () => Promise.resolve().then(() => codex.start()).then(async () => {
    models = await readModels(codex);
    settings = selectSettings(models, config);
  }).catch(error => { startupError = error.message; }).finally(() => { codexConnecting = false; });
  let ready = initializeCodex();

  async function ensureCodexReady() {
    await ready;
    // A transient discovery failure must not poison every later question until Zotero restarts.
    if (startupError && /timed out|超时|连接|network|connection/i.test(startupError) && !codexConnecting) {
      codex.close(); startupError = null; codexConnecting = true;
      ready = initializeCodex();
    }
    await ready;
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(scrub(data, [config.token, config.external?.apiKey])));
  }

  function authorized(req) {
    if (req.headers.origin) return false;
    if (req.headers.host !== `127.0.0.1:${config.port}`) return false;
    const value = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + config.token);
    return value.length === expected.length && timingSafeEqual(value, expected);
  }

  async function readBody(req) {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 6000000) throw new Error(t("errors.server.error01"));
      chunks.push(chunk);
    }
    return length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  function getRecord(id) {
    const record = store.get(id);
    if (!record) throw Object.assign(new Error(t("errors.history.notFound")), { status: 404 });
    // A process restart cannot resume an in-flight attempt. Keep it for replay,
    // but never feed partial answers back into model context.
    if (!sessions.get(id)?.busy && !locks.has(id)) {
      let changed = false;
      for (const turn of record.turns) if (turn.status === 'running') {
        turn.status = 'interrupted'; turn.finishedAt = Date.now(); changed = true;
      }
      if (changed) store.save(record);
    }
    return record;
  }
  function openRecord(record) { return { ...record, conversationId: record.id, messages: messages(record),
    pageCount: Math.max(record.pageCount || 0, ...record.turns.map(t => t.paper?.pageCount || 0)),
    allowedPages: [...new Set([...(record.allowedPages || []), ...record.turns.flatMap(t => t.pageReferences || [])])] }; }
  async function release(session) {
    const threadId = session.threadId;
    session.threadId = null; session.hash = null; session.nativeTokens = 0;
    if (threadId) await codex.release(threadId).catch(() => {});
  }
  async function sessionFor(record) {
    let session = sessions.get(record.id);
    if (!session) {
      if (sessions.size >= 8) {
        const oldest = [...sessions.entries()].filter(([id, s]) => !s.busy && !locks.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) throw new Error(t("errors.server.error04"));
        sessions.delete(oldest[0]); await release(oldest[1]);
      }
      session = { threadId: null, hash: null, paper: null, lastUsed: Date.now(), busy: false, nativeTokens: 0 };
      // Restore evidence from durable originals without restoring provider settings.
      for (const turn of record.turns) if (turn.paper) session.paper = mergePaper(session.paper, turn.paper);
      sessions.set(record.id, session);
    }
    return session;
  }
  const safe = value => scrub(value, [config.token, config.external?.apiKey]);
  function newJob(record, requestSettings, type = 'ask') {
    const job = { id: randomUUID(), conversationId: record.id, type, phase: type === 'compact' ? 'compacting' : 'preparing',
      status: 'running', text: '', summary: '', searches: [], startedAt: Date.now(), firstTextAt: null, error: null,
      settings: requestSettings, apiKey: config.external?.apiKey || '', controller: new AbortController(),
      context: contextInfo(record, requestSettings.contextBudget) };
    jobs.set(job.id, job); return job;
  }
  function checkAbort(job) { if (job.controller.signal.aborted) throw new Error(t("errors.context.cancelled")); }
  async function summarize(job, input, limit) {
    checkAbort(job);
    const prompt = 'Character limit: ' + Math.max(64, Math.floor((limit - 32) / 3)) + '\n<untrusted_conversation>\n' + JSON.stringify(input) + '\n</untrusted_conversation>';
    if (estimateTokens(prompt) + estimateTokens(SUMMARY_INSTRUCTIONS) + limit > job.settings.contextBudget.contextWindow) throw new Error(t("errors.context.summaryInputTooLarge"));
    let result;
    if (job.settings.provider === 'external') {
      result = await askExternal({ ...job.settings.external, apiKey: job.apiKey,
        messages: [{ role: 'system', content: SUMMARY_INSTRUCTIONS }, { role: 'user', content: prompt }],
        maxTokens: limit, signal: job.controller.signal });
    } else {
      await ensureCodexReady();
      if (startupError) throw new Error(startupError);
      result = await codex.ask({ model: job.settings.model, effort: job.settings.effort,
        instructions: SUMMARY_INSTRUCTIONS, webSearch: false, prompt, signal: job.controller.signal });
      if (result.threadId) await codex.release(result.threadId);
    }
    checkAbort(job);
    const text = safe(result.text || '').trim();
    if (!text || estimateTokens(text) > limit) throw new Error(t("errors.context.invalidSummary"));
    return text;
  }
  async function compact(job, record, session, tailBudget) {
    const budget = job.settings.contextBudget, end = compactionEnd(record, tailBudget || budget);
    if (end <= record.context.through) return false;
    job.phase = 'compacting';
    let summary = record.context.summary;
    // Chunk even a single oversized message. Originals are never rewritten.
    const payloadLimit = Math.floor((budget.contextWindow - budget.summaryTokens * 2 - 2048) / 4);
    if (payloadLimit < 256) throw new Error(t("errors.context.insufficientBudget"));
    const turns = record.turns.slice(record.context.through, end).filter(turn => turn.status === 'completed');
    const citations = new Set();
    for (const turn of record.turns.slice(0, end)) for (const citation of turn.citations || []) citations.add(citation);
    const source = JSON.stringify(turns.map(turn => ({ user: turn.user, assistant: turn.assistant, pageReferences: turn.pageReferences })));
    for (let offset = 0; offset < source.length;) {
      const chunk = excerptWithin(source, offset, payloadLimit).text;
      if (!chunk) throw new Error(t("errors.context.insufficientBudget"));
      summary = await summarize(job, { previousSummary: summary, transcriptChunk: chunk,
        chunkOffset: offset, totalCharacters: source.length }, budget.summaryTokens);
      offset += chunk.length;
    }
    if (!turns.length) return false;
    // Keep exact citation targets even if the model accidentally omits them.
    for (const citation of [...citations].reverse()) {
      if (summary.includes(citation)) continue;
      const candidate = summary + '\nCitation source: ' + citation;
      if (estimateTokens(candidate) <= budget.summaryTokens) summary = candidate;
    }
    const provenance = record.turns.slice(0, end).filter(t => t.status === 'completed').map(t => ({
      turnId: t.id, pageReferences: t.pageReferences || [], citations: t.citations || [] }));
    checkAbort(job);
    const next = { ...record, lastUsage: null, context: { summary, through: end, revision: record.context.revision + 1, provenance, compactedAt: Date.now() } };
    store.save(next); Object.assign(record, next);
    await release(session);
    job.context = contextInfo(record, budget);
    return true;
  }
  async function runJob(job, body, session, record) {
    let turn;
    const budget = job.settings.contextBudget;
    const onDelta = delta => { job.firstTextAt ||= Date.now(); job.text += delta; };
    try {
      if (job.type === 'compact') {
        job.compacted = await compact(job, record, session);
      } else {
        turn = record.turns.find(t => t.id === job.turnId);
        if (session.provider && session.provider !== job.settings.provider) await release(session);
        session.provider = job.settings.provider;
        session.paper = mergePaper(session.paper, body.paper);
        if (session.threadId && (session.customPrompt !== job.settings.customPrompt || session.webSearch !== job.settings.webSearch || session.model !== job.settings.model)) await release(session);
        const instructions = composeInstructions(INSTRUCTIONS, job.settings.customPrompt, job.settings.webSearch);
        const outputGuard = job.settings.provider === 'codex' ? '\n\n本次回答请控制在约 ' + Math.max(64, Math.floor((budget.outputReserve - 32) / 3)) + ' 字符以内，优先保留结论、必要依据及页码引用。' : '';
        const fixed = estimateTokens(instructions) + estimateTokens(buildPrompt(body, false)) + estimateTokens(outputGuard) + 512;
        const inputBudget = budget.contextWindow - budget.outputReserve;
        const evidenceCost = Math.min(estimateTokens(JSON.stringify(session.paper)), Math.floor(inputBudget * 0.55));
        if (fixed + evidenceCost + estimateTokens(historyPrompt(record)) > inputBudget * budget.threshold || session.nativeTokens + fixed + evidenceCost > inputBudget * budget.threshold) {
          job.compacted = await compact(job, record, session, { ...budget, recentTokens: Math.max(0, Math.min(budget.recentTokens, inputBudget - fixed - evidenceCost - budget.summaryTokens - 1024)) });
          // Native thread may include older copies of paper evidence; rebuild it
          // even when no additional old turns can be summarized.
          if (session.nativeTokens + fixed > inputBudget * budget.threshold) await release(session);
        }
        const retrieved = retrieveHistory(record, body.question, Math.min(2048, budget.summaryTokens));
        let history = (session.threadId ? '' : historyPrompt(record)) + retrievalPrompt(retrieved);
        const available = Math.min(inputBudget - fixed - estimateTokens(history), Math.floor(inputBudget * 0.55));
        let promptBody = { ...body, currentPage: body.currentPage || body.paper.pages[0].number,
          paper: budgetPaper(session.paper, body, available) };
        let hash = contextHash(promptBody.paper);
        let prompt = history + buildPrompt(promptBody, !session.threadId || hash !== session.hash) + outputGuard;
        if (session.threadId && session.nativeTokens + estimateTokens(prompt) + estimateTokens(instructions) > inputBudget) {
          await release(session);
          history = historyPrompt(record) + retrievalPrompt(retrieved);
          promptBody = { ...promptBody, paper: budgetPaper(session.paper, body, Math.min(inputBudget - fixed - estimateTokens(history), Math.floor(inputBudget * 0.55))) };
          hash = contextHash(promptBody.paper);
          prompt = history + buildPrompt(promptBody, true) + outputGuard;
        }
        if (estimateTokens(prompt) + estimateTokens(instructions) > inputBudget) throw new Error(t("errors.context.inputTooLarge"));
        job.context = contextInfo(record, budget, { estimatedInputTokens: estimateTokens(prompt) + estimateTokens(instructions),
          sourcePages: promptBody.paper.pages.map(p => p.number), sourceCoverage: promptBody.paper.sourceCoverage,
          outputLimitEnforced: job.settings.provider === 'external', outputReserveKind: job.settings.provider === 'external' ? 'requestedMaxTokens' : 'planningAllowance',
          retrievedTurnIds: retrieved.map(item => item.turnId), paperTruncated: promptBody.paper.sourceCoverage.partial });
        job.phase = 'answering'; checkAbort(job);
        const result = job.settings.provider === 'external' ? await askExternal({
          ...job.settings.external, apiKey: job.apiKey,
          messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }],
          maxTokens: budget.outputReserve, signal: job.controller.signal, onDelta,
        }) : await codex.ask({
          threadId: session.threadId, model: job.settings.model, effort: job.settings.effort,
          instructions, webSearch: job.settings.webSearch, prompt, signal: job.controller.signal, onDelta,
          onSummary: summary => { job.summary = String(summary).slice(0, 50000); },
          onSearch: search => {
            const index = job.searches.findIndex(item => item.id === search.id);
            if (index >= 0) job.searches[index] = search;
            else if (job.searches.length < 40) job.searches.push(search);
          },
        });
        if (job.controller.signal.aborted) { if (result.threadId) await codex.release(result.threadId); checkAbort(job); }
        session.threadId = result.threadId || null; session.hash = hash;
        session.nativeTokens = job.settings.provider === 'codex' ? session.nativeTokens + estimateTokens(prompt) + estimateTokens(result.text) + (session.nativeTokens ? 0 : estimateTokens(instructions)) : 0;
        session.customPrompt = job.settings.customPrompt; session.webSearch = job.settings.webSearch; session.model = job.settings.model;
        job.text = result.text;
        if (job.text) job.firstTextAt ||= Date.now();
        Object.assign(turn, { assistant: safe(result.text), summary: safe(job.summary), searches: safe(job.searches), status: 'completed',
          finishedAt: Date.now(), firstTextAt: job.firstTextAt, sourcePages: safe(promptBody.paper.pages),
          citations: safe([...new Set(result.text.match(/paperchat:[^\s)"<>]+|https?:\/\/[^\s)"<>]+/g) || [])]) });
        record.lastUsage = { estimatedInputTokens: job.settings.provider === 'codex' ? session.nativeTokens : estimateTokens(prompt) + estimateTokens(instructions) + estimateTokens(result.text),
          outputLimitEnforced: job.settings.provider === 'external', outputReserveKind: job.settings.provider === 'external' ? 'requestedMaxTokens' : 'planningAllowance',
          sourceCoverage: promptBody.paper.sourceCoverage, sourcePages: promptBody.paper.pages.map(p => p.number), retrievedTurnIds: retrieved.map(item => item.turnId) };
        record.updatedAt = Date.now(); store.save(record);
      }
      job.status = 'completed'; job.phase = 'completed';
    } catch (error) {
      job.error = redactError(error, [config.token, config.external?.apiKey, job.apiKey]);
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.phase = job.status;
      if (turn) {
        Object.assign(turn, { status: job.status, assistant: safe(job.text), summary: safe(job.summary), searches: safe(job.searches), error: job.error, finishedAt: Date.now() });
        record.updatedAt = Date.now();
        try { store.save(record); } catch { job.error = t("errors.history.saveFailed"); }
      }
      await release(session);
    } finally {
      job.context = { ...job.context, ...contextInfo(record, budget) };
      job.messages = turn ? messages({ turns: [turn] }) : [];
      session.busy = false; session.lastUsed = Date.now(); job.finishedAt = Date.now(); locks.delete(record.id);
      job.text = safe(job.text); job.summary = safe(job.summary); job.searches = safe(job.searches);
      const live = sessions.get(record.id); if (live) live.context = { ...job.context };
      job.apiKey = ''; // Do not retain credentials in completed job objects.
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return json(res, 403, { error: t("errors.server.text01") });
    let lockedId = null;
    const lock = id => {
      if (locks.has(id) || sessions.get(id)?.busy) throw Object.assign(new Error(t("errors.history.busy")), { status: 409 });
      locks.add(id); lockedId = id;
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/status') {
        return json(res, 200, {
          codexError: startupError ? redactError({ message: startupError }, [config.external?.apiKey]) : null,
          settingsAvailable: true, codexConnecting, current: settings,
          ok: settings.provider === 'external' || (!codexConnecting && !startupError), account: codex.account, model: settings?.model, effort: settings?.effort, error: settings.provider === 'codex' ? redactError({ message: startupError || '' }, [config.external?.apiKey]) || null : null,
          version: '0.6.3', apiVersion: 5, provider: settings.provider, billing: settings.provider === 'external' ? 'external' : 'chatgpt',
        });
      }
      if (path === '/settings' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          const desired = await readBody(req);
          const selected = selectSettings(models, desired, { strict: true, current: settings });
          // Atomic local save; the user's Codex-wide configuration is not modified.
          const external = normalizeExternal(Object.hasOwn(desired, 'external') ? desired.external : {}, config.external || {});
          const next = { ...config, ...selected, external };
          const temporary = configFile + '.' + randomUUID() + '.tmp';
          try {
            writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            renameSync(temporary, configFile);
          } finally { rmSync(temporary, { force: true }); }
          Object.assign(config, next); settings = selected;
        }
        return json(res, 200, { models, current: settings, codexConnecting });
      }
      if (req.method === 'POST' && path === '/ask') {
        const body = validatePaperRequest(await readBody(req));
        const overrides = Object.fromEntries(['model', 'effort', 'customPrompt', 'provider', 'external', 'webSearch', 'contextBudget']
          .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
        // /ask accepts the sanitized UI selection; credentials come only from saved config.
        if (Object.hasOwn(overrides, 'external')) {
          if (!overrides.external || typeof overrides.external !== 'object' || Array.isArray(overrides.external)) throw new Error(t("errors.server.error02"));
          overrides.external = Object.fromEntries(['baseUrl', 'model'].filter(key => Object.hasOwn(overrides.external, key))
            .map(key => [key, overrides.external[key]]));
        }
        overrides.provider ??= settings.provider;
        if (overrides.provider === 'codex') await ensureCodexReady();
        const requestSettings = selectSettings(models, overrides, { strict: true, current: settings });
        const apiKey = config.external?.apiKey || '';
        if (requestSettings.provider === 'codex' && startupError) throw new Error(startupError);
        if (requestSettings.provider === 'external' && (!requestSettings.external.baseUrl || !requestSettings.external.model || !apiKey)) {
          throw new Error(t("errors.server.error03"));
        }
        let record;
        if (body.conversationId != null) {
          record = getRecord(body.conversationId);
          if (record.paperId !== body.paper.id) throw new Error(t("errors.history.paperMismatch"));
        } else {
          const id = active.get(body.paper.id) || store.list(body.paper.id)[0]?.id;
          record = id ? getRecord(id) : store.create(body.paper.id);
        }
        lock(record.id);
        const session = await sessionFor(record);
        if (session.busy) return json(res, 409, { error: t("errors.server.text02") });
        const job = newJob(record, requestSettings);
        const turn = safe({ id: randomUUID(), status: 'running', startedAt: job.startedAt,
          question: body.question, user: buildPrompt(body, false), assistant: '', currentPage: body.currentPage || body.paper.pages[0].number,
          selection: body.selection || '', selectionPage: body.selectionPage || null,
          pageReferences: body.paper.pages.map(page => page.number),
          paper: { id: body.paper.id, title: typeof body.paper.title === 'string' ? body.paper.title : '', pageCount: body.paper.pageCount,
            pages: body.paper.pages.map(page => ({ number: page.number, text: page.text,
              ...(Array.isArray(page.sections) ? { sections: page.sections.filter(s => typeof s === 'string').slice(0, 100) } : {}) })) } });
        record.turns.push(turn); record.updatedAt = Date.now();
        try { store.save(record); } catch (error) { jobs.delete(job.id); throw error; }
        job.turnId = turn.id; session.busy = true; active.set(body.paper.id, record.id);
        json(res, 202, { jobId: job.id, conversationId: record.id });
        lockedId = null; // Job owns the lock until its finally block.
        void runJob(job, body, session, record);
        return;
      }
      const match = path?.match(/^\/jobs\/([a-f0-9-]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return json(res, 404, { error: t("errors.server.text03") });
        if (req.method === 'POST' && match[2]) {
          job.controller.abort();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && !match[2]) return json(res, 200, { status: job.status, text: safe(job.text), error: job.error,
          summary: safe(job.summary), searches: safe(job.searches), webSearch: job.settings.webSearch,
          conversationId: job.conversationId, phase: job.phase, compacted: job.compacted ?? null, noOp: job.type === 'compact' && job.compacted === false, context: safe(job.context), messages: safe(job.messages || []), turnId: job.turnId || null,
          startedAt: job.startedAt, firstTextAt: job.firstTextAt, finishedAt: job.finishedAt || null });
      }
      if (path === '/conversations' && req.method === 'GET') {
        const conversations = store.list(url.searchParams.has('paperId') ? url.searchParams.get('paperId') : undefined);
        return json(res, 200, { conversations, warnings: conversations.warnings });
      }
      if (path === '/conversations' && req.method === 'POST') {
        const body = await readBody(req);
        const imported = importData(body, [config.token, config.external?.apiKey]);
        if (imported.importKey) for (const item of store.list(body.paperId)) {
          const previous = getRecord(item.id);
          if (previous.importKey !== imported.importKey) continue;
          if (previous.importDigest !== imported.importDigest) throw new Error(t("errors.history.invalidImport"));
          active.set(previous.paperId, previous.id);
          return json(res, 200, { conversationId: previous.id, conversation: openRecord(previous) });
        }
        const record = store.create(body.paperId, body.title, imported);
        active.set(record.paperId, record.id);
        return json(res, 201, { conversationId: record.id, conversation: openRecord(record) });
      }
      const conversationMatch = path.match(/^\/conversations\/([^/]+)(\/(context|compact))?$/);
      if (conversationMatch) {
        const record = getRecord(conversationMatch[1]), action = conversationMatch[3];
        if (url.searchParams.has('paperId') && url.searchParams.get('paperId') !== record.paperId) throw new Error(t("errors.history.paperMismatch"));
        if (req.method === 'GET' && !action) {
          active.set(record.paperId, record.id);
          return json(res, 200, { ...openRecord(record), conversation: openRecord(record) });
        }
        if (req.method === 'GET' && action === 'context') return json(res, 200, { conversationId: record.id,
          ...sessions.get(record.id)?.context, ...contextInfo(record, settings.contextBudget), busy: locks.has(record.id) || !!sessions.get(record.id)?.busy });
        lock(record.id);
        const scopedBody = ['PATCH', 'POST', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        if (!scopedBody || typeof scopedBody !== 'object' || Array.isArray(scopedBody)) throw new Error(t("errors.history.invalidRecord"));
        if (Object.hasOwn(scopedBody, 'paperId') && scopedBody.paperId !== record.paperId) throw new Error(t("errors.history.paperMismatch"));
        if (req.method === 'PATCH' && !action) {
          record.title = validateTitle(scopedBody.title); record.updatedAt = Date.now();
          store.save(record);
          return json(res, 200, { conversationId: record.id, conversation: openRecord(record) });
        }
        if (req.method === 'DELETE' && !action) {
          if (sessions.has(record.id)) await release(sessions.get(record.id));
          sessions.delete(record.id); store.delete(record.id);
          if (active.get(record.paperId) === record.id) active.delete(record.paperId);
          return json(res, 200, { ok: true, conversationId: record.id });
        }
        if (req.method === 'POST' && action === 'compact') {
          const session = await sessionFor(record);
          const job = newJob(record, { ...settings, contextBudget: contextBudget(settings.contextBudget) }, 'compact');
          session.busy = true;
          json(res, 202, { jobId: job.id, conversationId: record.id });
          lockedId = null;
          void runJob(job, null, session, record); return;
        }
      }
      if (req.method === 'POST' && path === '/reset') {
        const { paperId, conversationId } = await readBody(req);
        const id = conversationId || active.get(paperId) || store.list(paperId)[0]?.id;
        if (!conversationId && (typeof paperId !== 'string' || !paperId)) throw new Error(t("errors.history.identityRequired"));
        if (!id) return json(res, 200, { ok: true });
        lock(id);
        const record = getRecord(id), session = sessions.get(id);
        if (paperId && record.paperId !== paperId) throw new Error(t("errors.history.paperMismatch"));
        if (session?.busy) return json(res, 409, { error: t("errors.server.text04") });
        if (session) await release(session);
        sessions.delete(id); record.turns = []; record.allowedPages = []; record.lastUsage = null; delete record.importKey; delete record.importDigest; record.context = { summary: '', through: 0, revision: 0 }; record.updatedAt = Date.now();
        store.save(record);
        return json(res, 200, { ok: true, conversationId: id });
      }
      if (req.method === 'POST' && path === '/shutdown') {
        json(res, 200, { ok: true });
        shutdown();
        return;
      }
      json(res, 404, { error: t("errors.server.text05") });
    } catch (error) { json(res, error.status || 400, { error: redactError(error, [config.token, config.external?.apiKey]) }); }
    finally { if (lockedId) locks.delete(lockedId); }
  });

  server.on('error', error => { console.error(error.message); codex.close(); process.exitCode = 1; });
  const sweep = setInterval(() => {
    for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > 600000) jobs.delete(id);
  }, 60000);
  sweep.unref();
  function shutdown() { for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); clearInterval(sweep); codex.close(); if (server.listening) server.close(); }
  return { server, shutdown, ready };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const configFile = fileURLToPath(new URL('./config.json', import.meta.url));
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const runtime = fileURLToPath(new URL('./runtime', import.meta.url));
  mkdirSync(runtime, { recursive: true });
  const { server, shutdown } = createBridge({ config, configFile, codex: new CodexClient({ cwd: runtime, networkProxy: config.codexNetworkProxy || '' }) });
  server.listen(config.port, '127.0.0.1', () => console.log(`Paper Chat ready at 127.0.0.1:${config.port}`));
  const stop = () => { shutdown(); setTimeout(() => process.exit(), 300).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
