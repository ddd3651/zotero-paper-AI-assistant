/* Server-owned archives. Never persist model context or transcripts in preferences. */
var PaperChatConversations = {
  icon(plugin, doc, key, kind) {
    const button = plugin.el(doc, 'button', null, 'pc-icon');
    button.type = 'button'; button.title = PaperChatText.t(key); button.setAttribute('aria-label', button.title);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', { history: 'M3 11a9 9 0 1 1 2 7 M3 3v8h8 M12 7v5l3 2', new: 'M13 4H4v16h16v-9 M10 14l1-5L19 1l4 4-8 8z', collapse: 'm9 5 7 7-7 7', close: 'm6 6 12 12 M6 18 18 6' }[kind]);
    svg.append(path); button.append(svg); return button;
  },
  mount(plugin, state, { head, history, welcome }) {
    const doc = state.panel.ownerDocument, t = (key, args) => PaperChatText.t(key, args);
    const el = (tag, text, cls) => plugin.el(doc, tag, text, cls);
    const style = el('style', `
      .paper-chat-panel{position:relative}
      .paper-chat-panel [hidden]{display:none!important}
      .paper-chat-panel .pc-head{padding:9px 12px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
      .paper-chat-panel .pc-title{gap:5px;font-size:14px}
      .paper-chat-panel .pc-title>span{flex:1;min-width:0}
      .paper-chat-panel .pc-title .pc-icon,.paper-chat-panel .pc-icon{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;width:28px;height:28px;min-height:28px;padding:5px}
      .paper-chat-panel .pc-icon:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
      .paper-chat-panel .pc-icon svg{display:block;pointer-events:none}
      .paper-chat-panel .pc-log{padding:20px}
      .paper-chat-panel .pc-message{padding:0;border:0;background:transparent;border-radius:0;margin:0 0 24px}
      .paper-chat-panel .pc-message[data-role=user]{margin-left:35px;padding:10px 14px;border-radius:14px;background:color-mix(in srgb,currentColor 6%,transparent)}
      .paper-chat-panel .pc-role{display:none}
      .paper-chat-panel .pc-compose{margin:0 14px 14px;padding:10px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;background:transparent;gap:7px}
      .paper-chat-panel .pc-compose>textarea{border:0;background:transparent;min-height:58px;padding:0}
      .paper-chat-panel .pc-context-status{display:flex;align-items:center;gap:7px;margin:0 14px;padding:8px 0;border:0;background:transparent;border-radius:0;font-size:.9em;text-align:left}
      .paper-chat-panel .pc-context-status:before{content:'';width:6px;height:6px;border-radius:50%;background:#40865f;flex:none}
      .paper-chat-panel .pc-context-status span:first-child{flex:1}
      .paper-chat-panel .pc-status{margin:0 14px 4px;font-size:.85em}
      .paper-chat-panel .pc-drawer{position:absolute;inset:0;z-index:5;overflow:auto;background:var(--material-background,#fafafa);padding:18px;user-select:text}
      .paper-chat-panel .pc-drawer-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .paper-chat-panel .pc-drawer h3{font-size:1em;margin:0;font-weight:600}
      .paper-chat-panel .pc-muted{opacity:.65;font-size:.9em}
      .paper-chat-panel .pc-history-entry{padding:13px 0;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
      .paper-chat-panel .pc-history-open{display:block;width:100%;text-align:left;border:0;padding:4px 0;background:transparent;white-space:normal}
      .paper-chat-panel .pc-history-actions{display:flex;gap:8px;margin-top:7px}
      .paper-chat-panel .pc-history-actions button{font-size:.85em;min-height:24px;padding:3px 7px}
      .paper-chat-panel .pc-history-entry input{width:100%;padding:5px}
      .paper-chat-panel .pc-context-detail{padding:14px;margin:16px 0;border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}
      .paper-chat-panel .pc-context-meter{width:100%;height:5px;margin:12px 0}
      .paper-chat-panel .pc-capacity{display:grid;gap:6px;margin:16px 0;font-size:.9em}
      .paper-chat-panel .pc-capacity input{width:100%;padding:5px}
      .paper-chat-panel .pc-drawer-error{color:#b33d2d;white-space:pre-wrap;font-size:.9em}
    `);
    state.panel.append(style);
    state.welcome = welcome;
    const status = el('button', null, 'pc-context-status'); status.type = 'button'; status.setAttribute('aria-expanded', 'false');
    const statusText = el('span', t('history.loading')), detail = el('span', t('context.details')); status.append(statusText, detail);
    const compose = state.input.parentElement;
    const notice = el('div', '', 'pc-status'); notice.setAttribute('role', 'status');
    compose.before(state.status, notice, status); // activity/connection status lives near the composer
    const drawer = (key) => {
      const node = el('section', null, 'pc-drawer'); node.hidden = true;
      node.setAttribute('aria-label', t(key));
      const heading = el('div', null, 'pc-drawer-head');
      const close = this.icon(plugin, doc, 'history.close', 'close');
      heading.append(el('h3', t(key)), close); node.append(heading); state.panel.append(node);
      close.addEventListener('click', () => this.close(state));
      return node;
    };
    const historyDrawer = drawer('history.title'), contextDrawer = drawer('context.title');
    const historyList = el('div'), historyError = el('div', '', 'pc-drawer-error'); historyError.setAttribute('role', 'status');
    const retry = el('button', t('history.retry'));
    historyDrawer.append(el('div', t('history.localPaper'), 'pc-muted'), historyList, historyError, retry);
    const usage = el('div'), meter = el('progress', null, 'pc-context-meter'); meter.max = 100;
    meter.setAttribute('aria-label', t('context.estimatedUsage'));
    const sources = el('div', '', 'pc-context-detail');
    const coverage = el('div', '', 'pc-context-detail'); coverage.hidden = true; coverage.setAttribute('role', 'status');
    const summary = el('details'), summaryText = el('div', '', 'pc-context-detail'); summary.append(el('summary', t('context.showSummary')), summaryText);
    const capacityLabel = el('label', t('context.capacity'), 'pc-capacity'), capacity = el('input');
    capacity.type = 'number'; capacity.min = '16384'; capacity.max = '2000000'; capacity.step = '1'; capacity.placeholder = t('context.unknownCapacity');
    capacityLabel.append(capacity);
    const saveCapacity = el('button', t('context.saveCapacity')), compact = el('button', t('context.compact'));
    const compactCancel = el('button', t('common.stop')); compactCancel.hidden = true;
    const reconcile = el('button', t('context.reconcile')); reconcile.hidden = true;
    const contextError = el('div', '', 'pc-drawer-error'); contextError.setAttribute('role', 'status');
    contextDrawer.append(usage, meter, el('p', t('context.auto'), 'pc-muted'), sources, coverage, summary,
      el('p', t('context.archiveNote'), 'pc-muted'), capacityLabel, saveCapacity, el('p', t('context.compactCost'), 'pc-muted'), compact, compactCancel, reconcile, contextError);
    state.conversationsUI = { history, status, statusText, historyDrawer, contextDrawer, historyList, historyError, retry, usage, meter, sources, coverage, summaryText, capacity, saveCapacity, compact, compactCancel, reconcile, contextError, notice };
    history.setAttribute('aria-expanded', 'false');
    history.addEventListener('click', () => { this.open(state, 'history'); this.list(plugin, state).catch(e => { historyError.textContent = e.message; }); });
    retry.addEventListener('click', () => { if (!state.historyLoaded) state.historyReady = this.initialize(plugin, state).catch(e => { historyError.textContent = e.message; }); else this.list(plugin, state).catch(e => { historyError.textContent = e.message; }); });
    status.addEventListener('click', () => { this.open(state, 'context'); this.refreshContext(plugin, state).catch(e => { contextError.textContent = e.message; }); });
    compact.addEventListener('click', () => this.compact(plugin, state));
    compactCancel.addEventListener('click', async () => {
      state.cancelRequested = true;
      if (state.jobId) await plugin.api('/jobs/' + encodeURIComponent(state.jobId) + '/cancel', 'POST', {}).catch(error => { contextError.textContent = error.message; });
    });
    reconcile.addEventListener('click', () => this.reconcileCompact(plugin, state));
    saveCapacity.addEventListener('click', () => this.mutate(plugin, state, async id => {
      const value = capacity.value.trim(), number = Number(value);
      if (value && (!Number.isInteger(number) || number < 16384 || number > 2000000)) throw new Error(t('context.invalidCapacity'));
      const current = await plugin.api('/settings');
      const result = await plugin.api('/settings', 'POST', { contextBudget: { ...current.current.contextBudget, contextWindow: value ? number : 32768 } });
      plugin.applySettings(result);
      await this.refreshContext(plugin, state);
    }));
    state.panel.addEventListener('keydown', event => {
      const drawer = !historyDrawer.hidden ? historyDrawer : !contextDrawer.hidden ? contextDrawer : null;
      if (!drawer) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(state); return; }
      if (event.key !== 'Tab') return;
      const controls = [...drawer.querySelectorAll('button:not([disabled]),input:not([disabled]),summary,[tabindex="0"]')]
        .filter(node => !node.closest('[hidden]'));
      if (!controls.length) return;
      const index = controls.indexOf(doc.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0].focus(); }
    });
    this.setBusy(state);
  },
  path(id) { return '/conversations/' + encodeURIComponent(id); },
  request(plugin, state, id, action = '', method = 'GET', body = {}) {
    const path = this.path(id) + action;
    return method === 'GET' ? plugin.api(path + '?paperId=' + encodeURIComponent(state.paperId))
      : plugin.api(path, method, { ...body, paperId: state.paperId });
  },
  close(state) {
    const ui = state.conversationsUI;
    const target = !ui.historyDrawer.hidden ? ui.history : !ui.contextDrawer.hidden ? ui.status : null;
    ui.historyDrawer.hidden = ui.contextDrawer.hidden = true;
    ui.history.setAttribute('aria-expanded', 'false'); ui.status.setAttribute('aria-expanded', 'false');
    target?.focus();
  },
  open(state, name) {
    const ui = state.conversationsUI; this.close(state);
    const drawer = name === 'history' ? ui.historyDrawer : ui.contextDrawer;
    drawer.hidden = false; (name === 'history' ? ui.history : ui.status).setAttribute('aria-expanded', 'true');
    drawer.querySelector('button')?.focus();
  },
  setBusy(state) {
    const ui = state.conversationsUI; if (!ui) return;
    const locked = !!(state.busy || state.historyBusy || !state.historyLoaded);
    for (const button of [ui.compact, ui.saveCapacity, ui.capacity, ...ui.historyList.querySelectorAll('button,input')]) button.disabled = locked;
    ui.retry.disabled = !!state.historyBusy && !state.unsettledJob;
    ui.compactCancel.hidden = !state.compacting; ui.reconcile.hidden = !state.unsettledJob;
  },
  async initialize(plugin, state) {
    if (state.disposed || state.historyBusy) return;
    state.historyBusy = true; state.historyLoaded = false; plugin.setBusy(state, state.busy);
    try {
      const rows = await this.list(plugin, state);
      if (state.disposed) return;
      const imported = await this.resumeSnapshot(plugin, state);
      if (state.disposed) return;
      const data = imported || (rows.length ? await this.request(plugin, state, rows[0].id) : await plugin.api('/conversations', 'POST', this.newBody(state)));
      if (state.disposed) return;
      this.restore(plugin, state, data.conversation || data); state.historyLoaded = true;
      await this.refreshContext(plugin, state);
    } catch (error) {
      state.error.textContent = error.message; state.conversationsUI.historyError.textContent = error.message;
      state.conversationsUI.statusText.textContent = PaperChatText.t('history.loadFailed');
      throw error;
    } finally { state.historyBusy = false; if (!state.disposed) plugin.setBusy(state, state.busy); }
  },
  async resumeSnapshot(plugin, state) {
    const saved = plugin.savedTranscripts?.[state.reader._instanceID];
    if (!saved?.conversationId) return this.importSnapshot(plugin, state);
    try {
      if (saved.paperId && saved.paperId !== state.paperId) throw Object.assign(new Error(PaperChatText.t('errors.history.paperMismatch')), { status: 404 });
      const data = await this.request(plugin, state, saved.conversationId);
      const record = data.conversation || data;
      if (record.paperId && record.paperId !== state.paperId) throw Object.assign(new Error(PaperChatText.t('errors.history.paperMismatch')), { status: 404 });
      delete plugin.savedTranscripts[state.reader._instanceID]; return data;
    } catch (error) {
      if (error.status !== 404 && error.message !== PaperChatText.t('errors.history.paperMismatch')) throw error;
      state.conversationsUI.notice.textContent = PaperChatText.t('history.resumeFallback');
      delete plugin.savedTranscripts[state.reader._instanceID]; return null;
    }
  },
  async importSnapshot(plugin, state) {
    const saved = plugin.savedTranscripts?.[state.reader._instanceID];
    if (!saved?.messages?.length || saved.conversationId) return null;
    // Keep the in-memory handoff intact until the server confirms durable import.
    saved.importKey ||= `${state.paperId}/${state.reader._instanceID}/${Date.now()}`;
    const data = await plugin.api('/conversations', 'POST', { ...this.newBody(state),
      title: PaperChatText.t('history.importedTitle'), pageCount: saved.pageCount || state.pageCount,
      messages: saved.messages, allowedPages: saved.allowedPages || [], importKey: saved.importKey });
    const record = data.conversation || data;
    if (!record.id || (record.messages || []).length < saved.messages.length) throw new Error(PaperChatText.t('history.importFailed'));
    delete plugin.savedTranscripts[state.reader._instanceID];
    return data;
  },
  newBody(state) { return { paperId: state.paperId, paperTitle: state.paperTitle, pageCount: state.pageCount, title: PaperChatText.t('common.newChat') }; },
  restore(plugin, state, conversation) {
    if (conversation.paperId && conversation.paperId !== state.paperId) throw new Error(PaperChatText.t('errors.history.paperMismatch'));
    if (!conversation.id) throw new Error(PaperChatText.t('history.invalidResponse'));
    state.conversationId = conversation.id; state.conversationTitle = conversation.title;
    state.pageCount = conversation.pageCount || state.pageCount;
    state.allowedPages = new Set(conversation.allowedPages || []);
    for (const turn of conversation.turns || []) {
      for (const page of turn.pageReferences || []) state.allowedPages.add(page);
      if (turn.paper?.pageCount) state.pageCount = Math.max(state.pageCount, turn.paper.pageCount);
    }
    state.messages = []; state.log.replaceChildren(); state.navigationSerial = (state.navigationSerial || 0) + 1;
    PaperChatReader.clearHighlight(state); plugin.removeSelection(state);
    for (const entry of conversation.messages || []) {
      if (!['user', 'assistant'].includes(entry.role)) continue;
      const text = String(entry.text ?? entry.content ?? '');
      for (const page of entry.pageReferences || []) state.allowedPages.add(page);
      for (const page of entry.sourcePages || []) if (page?.number) state.allowedPages.add(page.number);
      for (const match of text.matchAll(/paperchat:(\d+)|\[第\s*(\d+)\s*页\]/g)) state.allowedPages.add(Number(match[1] || match[2]));
      const body = plugin.message(state, entry.role, text);
      Object.assign(body._paperChatEntry, entry, { text });
      if (entry.role === 'assistant') {
        const turn = conversation.turns?.find(turn => turn.id === entry.turnId);
        const activity = entry.activity || (turn || entry.startedAt ? {
          startedAt: turn?.startedAt || entry.startedAt, firstTextAt: turn?.firstTextAt || entry.firstTextAt,
          finishedAt: turn?.finishedAt || entry.finishedAt, status: entry.status || turn?.status,
          summary: entry.summary || turn?.summary || '', searches: entry.searches || turn?.searches || [],
        } : null);
        if (activity) {
          body._paperChatEntry.activity = { ...activity, status: activity.status === 'running' ? 'cancelled' : activity.status,
            finishedAt: activity.finishedAt || Date.now() };
          PaperChatInteraction.progress(plugin, state, body);
        }
      }
    }
    if (!state.messages.length) state.log.append(state.welcome);
    plugin.refreshCitations(state); state.input.value = ''; state.error.textContent = '';
    state.log.scrollTop = state.log.scrollHeight;
    if (typeof PaperChatReader.loadOutline === 'function') this.warmCitations(plugin, state).catch(error => {
      if (!state.disposed && state.conversationId === conversation.id) state.error.textContent = error.message;
    });
  },
  async warmCitations(plugin, state) {
    const id = state.conversationId;
    await PaperChatReader.loadOutline(state);
    const pages = new Set();
    for (const entry of state.messages) for (const match of entry.text.matchAll(/paperchat:(\d+)|\[第\s*(\d+)\s*页\]/g)) pages.add(Number(match[1] || match[2]));
    for (const page of [...pages].slice(0, 30)) {
      if (state.disposed || state.conversationId !== id) return;
      if (page >= 1 && page <= state.pageCount && !state.rawPageCache.has(page)) await PaperChatReader.loadPage(state, page);
    }
    if (!state.disposed && state.conversationId === id) plugin.refreshCitations(state);
  },
  async list(plugin, state) {
    const serial = state.historyListSerial = (state.historyListSerial || 0) + 1;
    const data = await plugin.api('/conversations?paperId=' + encodeURIComponent(state.paperId));
    const rows = (Array.isArray(data) ? data : data.conversations || []).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (state.disposed || serial !== state.historyListSerial) return rows;
    const ui = state.conversationsUI, doc = state.panel.ownerDocument, t = (key, args) => PaperChatText.t(key, args);
    ui.historyError.textContent = data.warnings?.length ? t('history.unreadable', { count: data.warnings.length }) + '\n' + data.warnings.map(warning => warning.error).filter(Boolean).join('\n') : ''; ui.historyList.replaceChildren();
    if (!rows.length) ui.historyList.append(plugin.el(doc, 'p', t('history.empty'), 'pc-muted'));
    for (const row of rows) {
      const item = plugin.el(doc, 'div', null, 'pc-history-entry');
      const open = plugin.el(doc, 'button', (row.title || t('common.newChat')) + (row.id === state.conversationId ? t('history.current') : ''), 'pc-history-open');
      open.addEventListener('click', () => this.mutate(plugin, state, async () => {
        const data = await this.request(plugin, state, row.id);
        if (state.disposed) return;
        this.restore(plugin, state, data.conversation || data); this.close(state); await this.refreshContext(plugin, state);
      }));
      const meta = plugin.el(doc, 'div', t('history.entryMeta', { time: row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '', count: row.messageCount ?? 0 }), 'pc-muted');
      const actions = plugin.el(doc, 'div', null, 'pc-history-actions'), rename = plugin.el(doc, 'button', t('history.rename')), remove = plugin.el(doc, 'button', t('history.delete'));
      const editor = plugin.el(doc, 'div'); editor.hidden = true;
      const input = plugin.el(doc, 'input'); input.value = row.title || ''; input.maxLength = 200; input.setAttribute('aria-label', t('history.rename'));
      const save = plugin.el(doc, 'button', t('history.save')), cancel = plugin.el(doc, 'button', t('history.cancel'));
      editor.append(input, save, cancel);
      rename.addEventListener('click', () => { editor.hidden = false; input.focus(); });
      cancel.addEventListener('click', () => { editor.hidden = true; });
      save.addEventListener('click', () => this.mutate(plugin, state, async () => {
        if (!input.value.trim()) throw new Error(t('history.titleRequired'));
        await this.request(plugin, state, row.id, '', 'PATCH', { title: input.value.trim() }); await this.list(plugin, state);
      }));
      let confirming = false;
      remove.addEventListener('click', () => {
        if (!confirming) { confirming = true; remove.textContent = t('history.confirmDelete'); return; }
        this.mutate(plugin, state, async id => {
          await this.request(plugin, state, row.id, '', 'DELETE');
          if (row.id === id && !state.disposed) {
            state.historyLoaded = false; state.conversationId = null;
            state.messages = []; state.log.replaceChildren(state.welcome);
            const data = await plugin.api('/conversations', 'POST', this.newBody(state));
            if (state.disposed) return;
            this.restore(plugin, state, data.conversation || data); state.historyLoaded = true; await this.refreshContext(plugin, state);
          }
          await this.list(plugin, state);
        });
      });
      actions.append(rename, remove); item.append(open, meta, actions, editor); ui.historyList.append(item);
    }
    this.setBusy(state); return rows;
  },
  async mutate(plugin, state, operation) {
    if (state.disposed || state.busy || state.historyBusy || !state.historyLoaded) return;
    state.historyBusy = true; plugin.setBusy(state, state.busy);
    const id = state.conversationId, ui = state.conversationsUI;
    ui.historyError.textContent = ui.contextError.textContent = state.error.textContent = '';
    try { await operation(id); }
    catch (error) { if (!state.disposed) ui.historyError.textContent = ui.contextError.textContent = state.error.textContent = error.message; }
    finally { state.historyBusy = !!state.unsettledJob; if (!state.disposed) plugin.setBusy(state, state.busy); }
  },
  create(plugin, state) {
    return this.mutate(plugin, state, async () => {
      const data = await plugin.api('/conversations', 'POST', this.newBody(state));
      if (state.disposed) return;
      this.restore(plugin, state, data.conversation || data); this.close(state); await this.refreshContext(plugin, state);
    });
  },
  clear(plugin, state) {
    return this.mutate(plugin, state, async id => {
      await plugin.api('/reset', 'POST', { paperId: state.paperId, conversationId: id });
      if (state.disposed || state.conversationId !== id) return;
      this.restore(plugin, state, { id, messages: [] });
      state.status.textContent = PaperChatText.t('panel.text23'); await this.refreshContext(plugin, state);
    });
  },
  async refreshContext(plugin, state) {
    const id = state.conversationId; if (!id || state.disposed) return;
    const serial = state.contextSerial = (state.contextSerial || 0) + 1;
    const data = await this.request(plugin, state, id, '/context');
    if (state.disposed || state.conversationId !== id || serial !== state.contextSerial) return;
    const context = data.context || data, ui = state.conversationsUI, t = (key, args) => PaperChatText.t(key, args);
    const capacity = context.capacityTokens ?? context.contextCapacityTokens ?? context.contextWindow;
    const tokens = context.estimatedInputTokens ?? context.estimatedTokens;
    const percent = context.usagePercent ?? (capacity > 0 && Number.isFinite(tokens) ? tokens / capacity * 100 : null);
    const known = Number.isFinite(percent);
    ui.statusText.textContent = known ? t('context.status', { percent: Math.round(percent) }) : t('context.unknownUsage');
    ui.usage.textContent = known ? t('context.usage', { percent: Math.round(percent) }) : t('context.unknownUsage');
    if (known) ui.meter.value = Math.max(0, Math.min(100, percent)); else ui.meter.removeAttribute('value');
    ui.meter.hidden = !known;
    ui.sources.textContent = t('context.sources', { tokens: Number.isFinite(tokens) ? tokens : t('context.unknown'), recent: context.recentMessageCount ?? (Number.isFinite(context.retainedTurns) ? context.retainedTurns * 2 : t('context.unknown')), reserved: context.reservedTokens ?? context.outputReserve ?? t('context.unknown') });
    const coverage = context.sourceCoverage;
    ui.coverage.hidden = !coverage?.partial;
    ui.coverage.textContent = coverage?.partial ? t('context.partialCoverage', { selected: coverage.selectedPages, provided: coverage.providedPages, total: coverage.totalPages }) : '';
    ui.summaryText.textContent = context.summary || t('context.noSummary');
    if (state.panel.ownerDocument.activeElement !== ui.capacity) ui.capacity.value = capacity > 0 ? String(capacity) : '';
  },
  async settleCompact(plugin, state) {
    const jobId = state.jobId;
    if (!jobId) return true;
    await plugin.api('/jobs/' + encodeURIComponent(jobId) + '/cancel', 'POST', {}).catch(() => {});
    for (let attempt = 0; attempt < 20 && !state.disposed; attempt++) {
      try {
        const job = await plugin.api('/jobs/' + encodeURIComponent(jobId));
        if (!['running', 'queued', 'pending'].includes(job.status)) return true;
      } catch (error) {
        if (error.status !== 404) return false;
        try { const context = await this.request(plugin, state, state.conversationId, '/context'); return context.busy === false; }
        catch { return false; }
      }
      await Zotero.Promise.delay(500);
    }
    return false;
  },
  async reconcileCompact(plugin, state) {
    if (state.reconciling || !state.unsettledJob) return;
    state.reconciling = true;
    try {
      if (!await this.settleCompact(plugin, state)) return;
      state.jobId = null; state.compacting = false; state.unsettledJob = false; state.historyBusy = false;
      state.conversationsUI.contextError.textContent = PaperChatText.t('context.stopped');
      await this.refreshContext(plugin, state);
    } catch (error) { state.conversationsUI.contextError.textContent = error.message; }
    finally { state.reconciling = false; if (!state.disposed) plugin.setBusy(state, state.busy); }
  },
  compact(plugin, state) {
    return this.mutate(plugin, state, async id => {
      const ui = state.conversationsUI; ui.compact.textContent = PaperChatText.t('context.compacting');
      state.compacting = true; state.cancelRequested = false; plugin.setBusy(state, state.busy);
      let settled = false;
      try {
        const result = await this.request(plugin, state, id, '/compact', 'POST');
        if (!result.jobId) throw new Error(PaperChatText.t('history.invalidResponse'));
        state.jobId = result.jobId;
        const deadline = Date.now() + 30 * 60 * 1000;
        let noOp = false;
        while (!state.disposed && state.conversationId === id) {
          if (state.cancelRequested) throw new Error(PaperChatText.t('context.stopped'));
          const job = await plugin.api('/jobs/' + encodeURIComponent(result.jobId));
          if (job.status === 'completed') { settled = true; noOp = job.noOp === true || job.compacted === false; break; }
          if (!['running', 'queued', 'pending'].includes(job.status)) { settled = true; throw new Error(job.error || PaperChatText.t('context.compactFailed')); }
          if (Date.now() > deadline) throw new Error(PaperChatText.t('context.compactTimeout'));
          await Zotero.Promise.delay(500);
        }
        if (!state.disposed && state.conversationId === id) { await this.refreshContext(plugin, state); ui.contextError.textContent = noOp ? PaperChatText.t('context.noCompactNeeded') : PaperChatText.t('context.compacted'); }
      } catch (error) {
        if (!settled && state.jobId && !state.disposed) settled = await this.settleCompact(plugin, state);
        if (!settled && state.jobId) {
          state.unsettledJob = true;
          throw new Error(error.message + '\n' + PaperChatText.t('context.unsettled'));
        }
        throw error;
      } finally {
        if (!state.unsettledJob) { state.jobId = null; state.compacting = false; }
        ui.compact.textContent = PaperChatText.t('context.compact');
      }
    });
  },
};
