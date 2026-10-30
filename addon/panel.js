var PaperChat = {
  id: 'paper-chat@zotero-paper-chat.local',
  states: new Map(),
  buttons: new Set(),
  process: null,
  starting: null,
  stopped: false,

  async start() {
    try { this.savedTranscripts = JSON.parse(Zotero.PaperChatUpgradeSnapshot || '{}'); }
    catch { this.savedTranscripts = {}; }
    delete Zotero.PaperChatUpgradeSnapshot;
    PaperChatSelection.start(this);
    this.observer = { notify: (event, type) => {
      if (type !== 'tab' || event !== 'close') return;
      for (const [reader, state] of this.states) {
        let closed;
        try { closed = reader._isTabClosed || reader._isUninitialized || !reader._iframe?.isConnected; }
        catch { closed = true; }
        if (closed) {
          state.disposed = true;
          if (state.jobId) this.api(`/jobs/${state.jobId}/cancel`, 'POST', {}).catch(() => {});
          state.highlightCleanup?.();
          state.appearanceCleanup?.();
          state.resizeCleanup?.();
          state.interactionCleanup?.();
          this.states.delete(reader);
        }
      }
    } };
    this.observerID = Zotero.Notifier.registerObserver(this.observer, ['tab'], 'paper-chat');
    this.onToolbar = event => {
      if (event.reader?._type !== 'pdf') return;
      const button = this.button(event.doc, event.reader);
      event.append(button);
      this.scheduleMount(event.reader);
    };
    Zotero.Reader.registerEventListener('renderToolbar', this.onToolbar, this.id);
    for (const reader of Zotero.Reader._readers) {
      if (reader._type === 'pdf') this.scheduleMount(reader);
    }
  },

  async scheduleMount(reader) {
    try {
      await reader._initPromise;
      if (!await PaperChatReader.waitForReady(reader)) return;
      if (this.stopped || reader._isUninitialized) return;
      const doc = reader._iframeWindow.document;
      for (const button of doc.querySelectorAll('[data-paper-chat-toggle]')) {
        if (!this.buttons.has(button)) button.remove();
      }
      if (!doc.querySelector('[data-paper-chat-toggle]')) {
        const toolbar = doc.querySelector('.toolbar');
        if (toolbar) toolbar.append(this.button(doc, reader));
      }
      return this.mount(reader);
    } catch (e) { Zotero.logError(e); }
  },

  button(doc, reader) {
    const b = doc.createElement('button');
    b.setAttribute('data-paper-chat-toggle', 'true');
    b.textContent = PaperChatText.t("panel.toolbarButton");
    b.title = PaperChatText.t("panel.toolbarHelp");
    b.style.cssText = 'white-space:nowrap;min-width:64px;padding:4px 8px;font-size:12px;';
    // Zotero's Windows toolbar is a native drag region; custom controls must opt out.
    if (Zotero.isWin) b.style.setProperty('-moz-window-dragging', 'no-drag');
    b.addEventListener('click', async () => {
      const state = await this.scheduleMount(reader);
      if (!state) return;
      state.panel.hidden = !state.panel.hidden;
      if (!state.panel.hidden) state.input.focus();
    });
    this.buttons.add(b);
    return b;
  },

  el(doc, name, text, className) {
    const el = doc.createElementNS('http://www.w3.org/1999/xhtml', name);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  },

  mount(reader) {
    if (this.states.has(reader)) return this.states.get(reader);
    const doc = reader._iframe.ownerDocument;
    const parent = reader._iframe.parentElement;
    for (const stale of parent.querySelectorAll(':scope > .paper-chat-panel')) stale.remove();
    const oldParentStyle = parent.getAttribute('style');
    const oldReaderStyle = reader._iframe.getAttribute('style');
    parent.style.display = 'flex';
    parent.style.flexDirection = 'row';
    reader._iframe.style.flex = '1 1 0';
    reader._iframe.style.minWidth = '0';
    reader._iframe.style.width = '0';
    const panel = this.el(doc, 'aside', null, 'paper-chat-panel');
    panel.style.cssText = 'box-sizing:border-box;display:flex;flex-direction:column;flex:0 0 clamp(300px,32vw,440px);width:370px;min-height:0;overflow:hidden;background:var(--material-background,#fafafa);color:var(--fill-primary,#202124);border-left:1px solid #ccc;font:13px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;';
    const style = this.el(doc, 'style', `
      .paper-chat-panel[hidden]{display:none!important}
      .paper-chat-panel *{box-sizing:border-box}
      .paper-chat-panel button,.paper-chat-panel select,.paper-chat-panel textarea,.paper-chat-panel input{font:inherit;color:inherit;margin:0;letter-spacing:normal}
      .paper-chat-panel button{cursor:pointer;border:1px solid #cbd2d9;border-radius:7px;padding:6px 10px;min-height:32px;min-width:0;line-height:1.3;white-space:nowrap;background:var(--material-background,#fff);user-select:none}
      .paper-chat-panel button:disabled{opacity:.5;cursor:default}
      .paper-chat-panel button:focus-visible,.paper-chat-panel select:focus-visible,.paper-chat-panel textarea:focus-visible,.paper-chat-panel a:focus-visible{outline:2px solid #1967c8;outline-offset:2px}
      .paper-chat-panel .pc-head{padding:14px 16px 12px;border-bottom:1px solid #ddd;flex-shrink:0}
      .paper-chat-panel .pc-title{font-weight:650;font-size:15px;line-height:1.4;display:flex;gap:12px;justify-content:space-between;align-items:center}
      .paper-chat-panel .pc-title button{min-height:28px;font-size:12px;padding:4px 10px;font-weight:400}
      .paper-chat-panel .pc-status{font-size:11px;line-height:1.55;opacity:.75;white-space:pre-wrap;margin-top:8px;overflow-wrap:anywhere}
      .paper-chat-panel .pc-log{flex:1;min-height:0;overflow:auto;padding:16px;user-select:text;scrollbar-gutter:stable}
      .paper-chat-panel .pc-message{white-space:normal;overflow-wrap:anywhere;margin:0 0 16px;padding:12px 14px;border-radius:10px;background:var(--material-background,#fff);border:1px solid #e0e3e6;line-height:1.7}
      .paper-chat-panel .pc-message:last-child{margin-bottom:0}
      .paper-chat-panel .pc-message[data-role=user]{background:color-mix(in srgb,#3286e2 12%,transparent)}
      .paper-chat-panel .pc-role{font-size:11px;line-height:1.4;opacity:.65;margin:0 0 8px}
      .paper-chat-panel .pc-plain{white-space:pre-wrap}
      .paper-chat-panel .pc-markdown>:first-child{margin-top:0}
      .paper-chat-panel .pc-markdown>:last-child{margin-bottom:0}
      .paper-chat-panel .pc-markdown h1,.paper-chat-panel .pc-markdown h2,.paper-chat-panel .pc-markdown h3,.paper-chat-panel .pc-markdown h4,.paper-chat-panel .pc-markdown h5,.paper-chat-panel .pc-markdown h6{font-weight:650;line-height:1.4;margin:1.2em 0 .55em;color:inherit}
      .paper-chat-panel .pc-markdown h1{font-size:21px}
      .paper-chat-panel .pc-markdown h2{font-size:18px}
      .paper-chat-panel .pc-markdown h3{font-size:15.5px}
      .paper-chat-panel .pc-markdown h4{font-size:14px}
      .paper-chat-panel .pc-markdown h5,.paper-chat-panel .pc-markdown h6{font-size:13px}
      .paper-chat-panel .pc-markdown p{margin:0 0 .85em}
      .paper-chat-panel .pc-markdown ul,.paper-chat-panel .pc-markdown ol{padding-left:1.5em;margin:0 0 .85em}
      .paper-chat-panel .pc-markdown li+li{margin-top:.35em}
      .paper-chat-panel .pc-markdown li>p{margin:0 0 .35em}
      .paper-chat-panel .pc-markdown li>:last-child{margin-bottom:0}
      .paper-chat-panel .pc-markdown li>ul,.paper-chat-panel .pc-markdown li>ol{margin-top:.35em}
      .paper-chat-panel .pc-markdown blockquote{margin:.85em 0;padding:2px 0 2px 12px;border-left:3px solid #aebdce;opacity:.85}
      .paper-chat-panel .pc-markdown blockquote>:last-child{margin-bottom:0}
      .paper-chat-panel .pc-markdown code{font: .9em/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,currentColor 7%,transparent);padding:.12em .35em;border-radius:4px;white-space:pre-wrap}
      .paper-chat-panel .pc-markdown pre{overflow:auto;max-width:100%;margin:0 0 1em;padding:10px 12px;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:7px;white-space:pre}
      .paper-chat-panel .pc-markdown pre code{padding:0;background:none;white-space:pre;font-size:11.5px}
      .paper-chat-panel .pc-markdown hr{border:0;border-top:1px solid #d5dce3;margin:16px 0}
      .paper-chat-panel .pc-table-scroll{overflow-x:auto;max-width:100%;margin:0 0 1em;border:1px solid #d5dce3;border-radius:6px}
      .paper-chat-panel .pc-markdown table{border-collapse:collapse;width:100%;font-size:12px;line-height:1.55}
      .paper-chat-panel .pc-markdown th,.paper-chat-panel .pc-markdown td{padding:7px 9px;border:1px solid #d5dce3;vertical-align:top;text-align:left;min-width:65px}
      .paper-chat-panel .pc-markdown th{font-weight:600;background:color-mix(in srgb,currentColor 5%,transparent)}
      .paper-chat-panel .pc-markdown a{color:#1760a7;text-underline-offset:3px}
      .paper-chat-panel .pc-markdown .pc-cite{display:inline-block;font-size:11px;line-height:1.5;padding:1px 5px;margin:0 3px;border:1px solid color-mix(in srgb,#1760a7 25%,transparent);border-radius:4px;background:color-mix(in srgb,#1760a7 7%,transparent);text-decoration:none;white-space:normal;cursor:pointer;vertical-align:baseline;overflow-wrap:anywhere}
      .paper-chat-panel .pc-math-inline{margin:0 .12em}
      .paper-chat-panel .pc-math-display{display:block;overflow-x:auto;max-width:100%;padding:6px 0;margin:12px 0;text-align:center}
      .paper-chat-panel .pc-math math{font-size:1.08em}
      .paper-chat-panel .pc-compose{padding:12px 16px 14px;border-top:1px solid #ddd;display:grid;gap:10px;flex-shrink:0}
      .paper-chat-panel select{height:32px;line-height:1.3;border:1px solid #cbd2d9;border-radius:7px;background:var(--material-background,#fff)}
      .paper-chat-panel textarea{display:block;resize:vertical;min-height:84px;max-height:210px;width:100%;padding:10px 11px;border:1px solid #aeb8c3;border-radius:8px;line-height:1.6;background:var(--material-background,#fff)}
      .paper-chat-panel .pc-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px}
      .paper-chat-panel .pc-actions{display:flex;align-items:center;gap:8px}
      .paper-chat-panel .pc-model-row{position:relative;min-width:0}
      .paper-chat-panel .pc-model-trigger{width:100%;text-align:left;font-size:12px;overflow:hidden;text-overflow:ellipsis;background:transparent}
      .paper-chat-panel .pc-settings-menu{position:absolute;bottom:calc(100% + 8px);left:0;right:0;z-index:30;padding:12px;display:grid;gap:10px;border:1px solid #bfc9d4;border-radius:10px;background:var(--material-background,#fff);box-shadow:0 5px 20px #0002;max-height:70vh;overflow-y:auto}
      .paper-chat-panel .pc-settings-menu[hidden]{display:none!important}
      .paper-chat-panel .pc-settings-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}
      .paper-chat-panel .pc-settings-title button{font-size:11px;padding:3px 8px;min-height:26px}
      .paper-chat-panel .pc-settings-menu label{display:grid;gap:5px;font-size:12px}
      .paper-chat-panel .pc-settings-menu select{width:100%;padding:5px 8px}
      .paper-chat-panel .pc-settings-menu input:not([type=checkbox]){width:100%;min-width:0;padding:7px 8px;border:1px solid #cbd2d9;border-radius:6px;background:var(--material-background,#fff)}
      .paper-chat-panel .pc-settings-help{font-size:11px;line-height:1.5;opacity:.7}
      .paper-chat-panel .pc-selection{padding:8px 10px;border:1px solid #b8cde6;border-left:3px solid #1967c8;border-radius:7px;font-size:12px;line-height:1.5;background:color-mix(in srgb,#3286e2 6%,transparent)}
      .paper-chat-panel .pc-selection[hidden]{display:none!important}
      .paper-chat-panel .pc-selection-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
      .paper-chat-panel .pc-selection-head button{font-size:11px;min-height:24px;padding:2px 7px}
      .paper-chat-panel .pc-selection-text{max-height:76px;overflow:auto;white-space:pre-wrap;user-select:text}
      .paper-chat-panel .pc-prompt-input{min-height:128px;max-height:230px;font-size:12px}
      .paper-chat-panel .pc-prompt-status{font-size:11px;min-height:16px;line-height:1.4;opacity:.75}
      .paper-chat-panel .pc-send{background:#1967c8;color:white;border-color:#1967c8}
      .paper-chat-panel .pc-hint{font-size:10.5px;line-height:1.4;opacity:.65;text-align:right}
      .paper-chat-panel .pc-error{color:#b33d2d;white-space:pre-wrap;font-size:12px;line-height:1.5}
      .paper-chat-panel .pc-error:empty{display:none}
      .paper-chat-panel .pc-message-actions{display:flex;justify-content:flex-start;margin-top:6px;line-height:1}
      .paper-chat-panel .pc-message-actions .pc-copy-message{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;min-height:24px;padding:3px;border:0;border-radius:5px;background:transparent;opacity:.65}
      .paper-chat-panel .pc-copy-message:hover,.paper-chat-panel .pc-copy-message:focus-visible{opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
      .paper-chat-panel .pc-copy-message svg{display:block;pointer-events:none;flex:none}
      .paper-chat-panel .pc-activity{margin:0 0 10px;color:var(--fill-secondary,#68717c);font-size:.9em}
      .paper-chat-panel .pc-activity summary{cursor:pointer;user-select:none;line-height:1.6}
      .paper-chat-panel .pc-reasoning-summary{margin-top:8px;padding:8px;border-left:2px solid #b9c6d6;max-height:240px;overflow:auto;user-select:text}
      .paper-chat-panel .pc-markdown,.paper-chat-panel .pc-plain{user-select:text;-moz-user-select:text}
    `);
    panel.append(style);
    const head = this.el(doc, 'div', null, 'pc-head');
    const title = this.el(doc, 'div', null, 'pc-title');
    title.append(this.el(doc, 'span', PaperChatText.t("metadata.name")));
    const close = PaperChatConversations.icon(this, doc, "panel.collapse", "collapse");
    close.addEventListener('click', () => { panel.hidden = true; });
    const history = PaperChatConversations.icon(this, doc, "history.title", "history");
    const reset = PaperChatConversations.icon(this, doc, "common.newChat", "new");
    title.append(history, reset, close);
    const status = this.el(doc, 'div', PaperChatText.t("panel.text01"), 'pc-status');
    head.append(title, status);
    const log = this.el(doc, 'div', null, 'pc-log');
    log.setAttribute('aria-live', 'polite');
    const welcome = this.el(doc, 'div', PaperChatText.t("panel.welcome"), 'pc-message pc-plain');
    log.append(welcome);
    const compose = this.el(doc, 'div', null, 'pc-compose');
    const selectionCard = this.el(doc, 'div', null, 'pc-selection'); selectionCard.hidden = true;
    const selectionHead = this.el(doc, 'div', null, 'pc-selection-head');
    const selectionLabel = this.el(doc, 'span', PaperChatText.t("panel.text02"));
    const selectionRemove = this.el(doc, 'button', PaperChatText.t("panel.text03"));
    selectionHead.append(selectionLabel, selectionRemove);
    const selectionText = this.el(doc, 'div', '', 'pc-selection-text');
    selectionCard.append(selectionHead, selectionText);
    const input = this.el(doc, 'textarea');
    input.placeholder = PaperChatText.t("panel.questionPlaceholder");
    input.setAttribute('aria-label', PaperChatText.t("common.askAI"));
    const bottom = this.el(doc, 'div', null, 'pc-bottom');
    const modelRow = this.el(doc, 'div', null, 'pc-model-row');
    const modelButton = this.el(doc, 'button', PaperChatText.t("panel.text04"), 'pc-model-trigger');
    modelButton.setAttribute('aria-label', PaperChatText.t("panel.text05"));
    modelButton.setAttribute('aria-expanded', 'false');
    modelButton.disabled = true;
    const settingsMenu = this.el(doc, 'div', null, 'pc-settings-menu');
    settingsMenu.hidden = true;
    const settingsTitle = this.el(doc, 'div', null, 'pc-settings-title');
    const settingsClose = this.el(doc, 'button', PaperChatText.t("common.done"));
    settingsTitle.append(this.el(doc, 'span', PaperChatText.t("settings.title")), settingsClose);
    const modelLabel = this.el(doc, 'label', PaperChatText.t("settings.model"));
    const modelSelect = this.el(doc, 'select'); modelSelect.setAttribute('aria-label', PaperChatText.t("settings.modelAria"));
    modelLabel.append(modelSelect);
    const effortLabel = this.el(doc, 'label', PaperChatText.t("settings.effort"));
    const effortSelect = this.el(doc, 'select'); effortSelect.setAttribute('aria-label', PaperChatText.t("settings.effortAria"));
    effortLabel.append(effortSelect);
    const promptLabel = this.el(doc, 'label', PaperChatText.t("settings.customPrompt"));
    const promptInput = this.el(doc, 'textarea', null, 'pc-prompt-input');
    promptInput.maxLength = 12000;
    promptInput.setAttribute('aria-label', PaperChatText.t("settings.customPromptAria"));
    promptInput.placeholder = PaperChatText.t("panel.text06");
    promptLabel.append(promptInput);
    const promptSave = this.el(doc, 'button', PaperChatText.t("settings.savePrompt"));
    const promptStatus = this.el(doc, 'div', '', 'pc-prompt-status');
    settingsMenu.append(settingsTitle, modelLabel, effortLabel, promptLabel, promptSave, promptStatus,
      this.el(doc, 'div', PaperChatText.t("panel.text07"), 'pc-settings-help'));
    modelRow.append(modelButton, settingsMenu);
    const clear = this.el(doc, 'button', PaperChatText.t("history.clearCurrent"));
    clear.title = PaperChatText.t("panel.text08");
    const send = this.el(doc, 'button', PaperChatText.t("common.send"), 'pc-send');
    const cancel = this.el(doc, 'button', PaperChatText.t("common.stop")); cancel.hidden = true;
    const hint = this.el(doc, 'div', Zotero.isMac ? PaperChatText.t("panel.text09") : PaperChatText.t("panel.text10"), 'pc-hint');
    const actions = this.el(doc, 'div', null, 'pc-actions');
    const error = this.el(doc, 'div', '', 'pc-error');
    actions.append(cancel, send);
    const leftActions = this.el(doc, 'div', null, 'pc-actions');
    leftActions.append(clear);
    bottom.append(leftActions, actions);
    compose.append(selectionCard, input, modelRow, bottom, hint, error);
    panel.append(head, log, compose);
    parent.append(panel);
    const item = reader._item;
    const state = { reader, panel, status, log, input, send, cancel, reset, clear, error,
      selectionCard, selectionLabel, selectionText, selectedExcerpt: null,
      promptInput, promptSave, promptStatus, promptDirty: false,
      modelButton, modelSelect, effortSelect, settingsMenu, settingsReady: false, settingsSaving: false,
      busy: false, jobId: null, pageCache: new Map(), rawPageCache: new Map(), sections: [], pageCount: 0, allowedPages: new Set(), messages: [],
      paperId: `${item.libraryID}/${item.key}`, paperTitle: reader._title || item.getField('title'),
      oldParentStyle, oldReaderStyle, parent, disposed: false };
    this.states.set(reader, state);
    const appearance = PaperChatAppearance.mount(this, state, { head, title });
    settingsMenu.append(appearance.row, appearance.sideButton);
    PaperChatConversations.mount(this, state, { head, title, history, welcome });
    PaperChatResize.mount(this, state);
    state.resizeCleanup = () => PaperChatResize.cleanup(state);
    state.appearanceCleanup = () => PaperChatAppearance.cleanup(state);
    state.apiSettings = PaperChatAPISettings.mount(this, state, { settingsMenu, modelLabel, effortLabel });
    PaperChatInteraction.mount(this, state, head);
    PaperChatReader.bindHighlight(state);
    PaperChatReader.loadOutline(state).then(async () => {
      const cited = new Set();
      for (const entry of state.messages) {
        for (const match of entry.text.matchAll(/paperchat:(\d+)|\[第\s*(\d+)\s*页\]/g)) cited.add(Number(match[1] || match[2]));
      }
      for (const page of [...cited].slice(0, 30)) {
        if (state.disposed) return;
        if (page >= 1 && page <= state.pageCount) await PaperChatReader.loadPage(state, page);
      }
      if (!state.disposed) this.refreshCitations(state);
    }).catch(error => Zotero.logError(error));
    selectionRemove.addEventListener('click', () => this.removeSelection(state));
    promptInput.addEventListener('input', () => { state.promptDirty = true; promptStatus.textContent = PaperChatText.t("common.unsaved"); });
    promptInput.addEventListener('keydown', e => e.stopPropagation());
    promptInput.addEventListener('keyup', e => e.stopPropagation());
    promptSave.addEventListener('click', () => { state.settingsPromise = this.saveSettings(state, { customPrompt: promptInput.value }); });
    const closeSettings = () => { settingsMenu.hidden = true; modelButton.setAttribute('aria-expanded', 'false'); };
    modelButton.addEventListener('click', () => {
      settingsMenu.hidden = !settingsMenu.hidden;
      modelButton.setAttribute('aria-expanded', String(!settingsMenu.hidden));
      if (!settingsMenu.hidden) (state.selectedSettings?.provider === 'external' ? state.apiSettings.provider : state.modelSelect.options.length ? modelSelect : state.apiSettings.provider).focus();
      if (!settingsMenu.hidden) this.api('/settings').then(data => this.applySettings(data)).catch(error => { state.error.textContent = error.message; });
    });
    settingsClose.addEventListener('click', closeSettings);
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') closeSettings(); });
    panel.addEventListener('click', event => { if (!modelRow.contains(event.target)) closeSettings(); });
    modelSelect.addEventListener('change', () => {
      this.populateEfforts(state, modelSelect.value);
      state.settingsPromise = this.saveSettings(state, { model: modelSelect.value, effort: effortSelect.value });
    });
    effortSelect.addEventListener('change', () => { state.settingsPromise = this.saveSettings(state, { effort: effortSelect.value }); });
    send.addEventListener('click', () => this.ask(state));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.ask(state); }
      e.stopPropagation();
    });
    input.addEventListener('keyup', e => e.stopPropagation());
    cancel.addEventListener('click', async () => {
      state.cancelRequested = true;
      if (state.jobId) await this.api(`/jobs/${state.jobId}/cancel`, 'POST', {}).catch(() => {});
    });
    reset.addEventListener('click', () => PaperChatConversations.create(this, state));
    clear.addEventListener('click', () => this.clearConversation(state, welcome));
    state.historyReady = this.ensureBridge().then(async info => {
      await PaperChatConversations.initialize(this, state);
      const settings = await this.api('/settings');
      this.applySettings(settings);
      this.connectionStatus(state, info);
      if (settings.codexConnecting) this.refreshConnectingModels();
    }).catch(e => { status.textContent = PaperChatText.t("panel.text11"); error.textContent = e.message; });
    return state;
  },

  async refreshConnectingModels() {
    if (this.refreshingModels) return;
    this.refreshingModels = true;
    try {
      for (let i = 0; i < 50 && !this.stopped; i++) {
        await Zotero.Promise.delay(600);
        if (this.stopped) return;
        const data = await this.api('/settings');
        if (!data.codexConnecting) {
          this.applySettings(data);
          const info = await this.api('/status');
          for (const state of this.states.values()) if (!state.busy) this.connectionStatus(state, info);
          break;
        }
      }
    } catch (error) { Zotero.logError(error); }
    finally { this.refreshingModels = false; }
  },

  async api(path, method = 'GET', body) {
    const response = await Zotero.HTTP.request(method, PaperChatConfig.url + path, {
      headers: { Authorization: 'Bearer ' + PaperChatConfig.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), timeout: 65000, successCodes: false,
    });
    let data;
    try { data = JSON.parse(response.responseText); }
    catch { throw new Error(PaperChatText.t("panel.error01")); }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(data.error || PaperChatText.t("panel.format01", {value1: response.status}));
      error.status = response.status; throw error;
    }
    return data;
  },

  async ensureBridge() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const info = await this.api('/status');
        if (info.apiVersion === 5 && info.version === '0.6.1') return info;
        await this.api('/shutdown', 'POST', {});
        await Zotero.Promise.delay(700);
      }
      catch (error) {
        if (/ChatGPT|API Key|可用.*模型/.test(error.message)) throw error;
      }
      const node = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
      node.initWithPath(PaperChatConfig.node);
      if (!node.exists()) throw new Error(PaperChatText.t("panel.error02"));
      const process = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
      process.init(node);
      if (Zotero.isWin) { process.startHidden = true; process.noShell = true; }
      process.runwAsync([PaperChatConfig.server], 1, null, false);
      this.process = process;
      let lastError;
      for (let i = 0; i < 45 && !this.stopped; i++) {
        await Zotero.Promise.delay(500);
        try { return await this.api('/status'); }
        catch (error) { lastError = error; }
      }
      throw new Error(PaperChatText.t("panel.format02", {value1: (lastError?.message || PaperChatText.t("panel.text12")), value2: (PaperChatConfig.launcher || PaperChatText.t("panel.text13"))}));
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  },

  effortLabel(value) {
    return { none: PaperChatText.t("effort.none"), minimal: PaperChatText.t("effort.minimal"), low: PaperChatText.t("effort.low"), medium: PaperChatText.t("effort.medium"), high: PaperChatText.t("effort.high"), xhigh: PaperChatText.t("effort.xhigh"), max: PaperChatText.t("effort.max"), ultra: PaperChatText.t("effort.ultra") }[value] || value;
  },

  populateEfforts(state, modelId, preferred) {
    const model = state.models.find(m => m.id === modelId);
    state.effortSelect.replaceChildren();
    if (!model) return;
    for (const effort of model.efforts) {
      const option = this.el(state.panel.ownerDocument, 'option', this.effortLabel(effort.value));
      option.value = effort.value; option.title = effort.description;
      state.effortSelect.append(option);
    }
    state.effortSelect.value = model.efforts.some(e => e.value === preferred) ? preferred : model.defaultEffort;
    if (!state.effortSelect.value) state.effortSelect.selectedIndex = 0;
  },

  applySettings(data) {
    for (const state of this.states.values()) {
      try {
        state.models = data.models || [];
        state.selectedSettings = { ...data.current };
        if (!state.promptDirty) state.promptInput.value = data.current.customPrompt || '';
        state.promptStatus.textContent = state.promptDirty ? PaperChatText.t("common.unsaved") : (data.current.customPrompt ? PaperChatText.t("panel.text14") : PaperChatText.t("panel.text15"));
        state.modelSelect.replaceChildren();
        for (const model of state.models) {
          const option = this.el(state.panel.ownerDocument, 'option', model.name);
          option.value = model.id; option.title = model.description;
          state.modelSelect.append(option);
        }
        state.modelSelect.value = data.current.model;
        this.populateEfforts(state, data.current.model, data.current.effort);
        const model = state.models.find(m => m.id === data.current.model);
        const external = data.current.provider === 'external';
        state.modelButton.textContent = external ? `${data.current.external?.model || PaperChatText.t("panel.text16")} · API ▾`
          : `${model?.name || data.current.model || PaperChatText.t("common.codex")} · ${this.effortLabel(data.current.effort)}${data.current.webSearch ? PaperChatText.t("panel.text17") : ''} ▾`;
        state.modelButton.title = external ? PaperChatText.t("panel.text18") : PaperChatText.t("panel.format03", {value1: (model?.id || PaperChatText.t("common.codex")), value2: (this.effortLabel(data.current.effort))});
        PaperChatAPISettings.apply(state, data);
        state.settingsReady = true;
        this.setBusy(state, state.busy);
      } catch (error) { Zotero.logError(error); }
    }
  },

  async saveSettings(state, changes = {}) {
    state.settingsSaving = true;
    this.setBusy(state, state.busy);
    state.error.textContent = '';
    try {
      const result = await this.api('/settings', 'POST', changes);
      if (Object.hasOwn(changes, 'customPrompt') && state.promptInput.value === changes.customPrompt) state.promptDirty = false;
      this.applySettings(result);
      this.connectionStatus(state);
      return result;
    } catch (error) {
      state.error.textContent = error.message;
      if (state.selectedSettings) {
        state.modelSelect.value = state.selectedSettings.model;
        this.populateEfforts(state, state.selectedSettings.model, state.selectedSettings.effort);
      }
      return null;
    } finally {
      state.settingsSaving = false;
      this.setBusy(state, state.busy);
    }
  },

  connectionStatus(state, info) {
    if (state.selectedSettings?.provider === 'external') {
      state.status.textContent = PaperChatText.t("panel.format04", {value1: (state.selectedSettings.external?.model || PaperChatText.t("panel.text19"))});
    } else {
      state.status.textContent = info?.codexConnecting ? PaperChatText.t("panel.text20")
        : info?.codexError ? PaperChatText.t("panel.format05", {value1: (info.codexError)})
        : PaperChatText.t("panel.text21");
    }
  },

  pdfApp(reader) {
    const view = reader._internalReader?._primaryView;
    const win = view?._iframeWindow;
    const app = win?.PDFViewerApplication || win?.wrappedJSObject?.PDFViewerApplication;
    if (!app?.pdfDocument) throw new Error(PaperChatText.t("panel.error03"));
    return app;
  },

  refreshCitations(state) {
    for (const body of state.log.querySelectorAll('.pc-markdown')) {
      if (body._paperChatEntry) this.render(state, body, body._paperChatEntry.text);
    }
  },

  captureSelection(reader, excerpt, focus = false) {
    const state = this.mount(reader);
    if (!excerpt?.text?.trim()) return;
    if (excerpt.text.length > 30000) { state.error.textContent = PaperChatText.t("panel.text22"); return; }
    state.selectedExcerpt = excerpt;
    state.selectionCard.hidden = false;
    state.selectionText.textContent = excerpt.text;
    state.selectionLabel.textContent = PaperChatText.t("panel.format06", {value1: (excerpt.page), value2: (excerpt.pages?.[1] > excerpt.page ? '–' + excerpt.pages[1] : excerpt.position?.nextPageRects?.length ? '–' + (excerpt.page + 1) : '')});
    if (focus) { state.panel.hidden = false; state.input.focus(); }
  },

  removeSelection(state) {
    state.selectedExcerpt = null;
    state.selectionCard.hidden = true;
    state.selectionText.textContent = '';
  },

  async clearConversation(state, welcome = state.welcome) {
    if (state.conversationsUI) return PaperChatConversations.clear(this, state);
    if (state.busy) return;
    state.clear.disabled = true; state.reset.disabled = true;
    try {
      await this.api('/reset', 'POST', { paperId: state.paperId, conversationId: state.conversationId });
      state.log.replaceChildren(welcome); state.allowedPages.clear(); state.messages = [];
      state.input.value = ''; state.error.textContent = ''; state.navigationSerial = (state.navigationSerial || 0) + 1;
      this.removeSelection(state); PaperChatReader.clearHighlight(state);
      state.status.textContent = PaperChatText.t("panel.text23");
    } catch (error) { state.error.textContent = error.message; }
    finally { this.setBusy(state, false); }
  },

  async readPaper(state, question = '') {
    const app = this.pdfApp(state.reader);
    const pdf = app.pdfDocument;
    state.pageCount = pdf.numPages;
    const currentPage = app.pdfViewer.currentPageNumber;
    const full = /全文|整篇/.test(question);
    const selectedPage = state.selectedExcerpt?.page;
    const selectionEnd = Math.min(pdf.numPages, state.selectedExcerpt?.pages?.[1] || (state.selectedExcerpt?.position?.nextPageRects?.length ? selectedPage + 1 : selectedPage));
    const numbers = !full && selectedPage ? Array.from({ length: selectionEnd - selectedPage + 1 }, (_, i) => selectedPage + i)
      : /当前页|这一页|本页/.test(question) && !full ? [currentPage] : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    if (numbers.length > 1000) throw new Error(PaperChatText.t("panel.error04"));
    await PaperChatReader.loadOutline(state);
    const pages = [];
    let chars = 0;
    for (const number of numbers) {
      if (state.disposed || state.cancelRequested) throw new Error(PaperChatText.t("panel.error05"));
      state.status.textContent = PaperChatText.t("panel.format07", {number: (number), value2: (pdf.numPages)});
      if (!state.pageCache.has(number)) {
        await PaperChatReader.loadPage(state, number);
      }
      const text = state.pageCache.get(number);
      chars += text.length;
      if (chars > 400000) throw new Error(PaperChatText.t("panel.error06"));
      pages.push({ number, text, sections: PaperChatReader.sectionsForPage(state, number).map(entry => PaperChatReader.sectionLabel(state, entry)) });
    }
    if (pages.every(page => !page.text.trim())) throw new Error(PaperChatText.t("panel.error07"));
    const selection = state.selectedExcerpt?.text || '';
    const selectionPage = state.selectedExcerpt?.page;
    this.refreshCitations(state);
    return { paper: { id: state.paperId, title: state.reader._title || state.reader._item.getField('title'), pageCount: pdf.numPages, pages }, currentPage, selection, selectionPage };
  },

  message(state, role, text) {
    const doc = state.panel.ownerDocument;
    const wrap = this.el(doc, 'div', null, 'pc-message');
    wrap.dataset.role = role;
    const label = this.el(doc, 'div', role === 'user' ? PaperChatText.t("common.you") : state.selectedSettings?.provider === 'external' ? state.selectedSettings.external?.model || PaperChatText.t("common.ai") : PaperChatText.t("common.codex"), 'pc-role');
    const body = this.el(doc, 'div', null, role === 'user' ? 'pc-plain' : 'pc-markdown');
    const entry = { role, text };
    state.messages.push(entry);
    body._paperChatEntry = entry;
    wrap.append(label, body);
    PaperChatInteraction.message(this, state, body, wrap);
    state.log.append(wrap);
    this.render(state, body, text);
    return body;
  },

  render(state, node, text) {
    const followBottom = state.log.scrollHeight - state.log.scrollTop - state.log.clientHeight < 70;
    if (node._paperChatEntry) node._paperChatEntry.text = text;
    const selection = node.ownerDocument.defaultView.getSelection();
    if (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) {
      node._pcPendingRender = text;
      return;
    }
    node._pcPendingRender = null;
    if (node._paperChatEntry?.role === 'user') node.textContent = text;
    else node.replaceChildren(PaperChatMarkdown.render(node.ownerDocument, text, {
      pageCount: state.pageCount, allowedPages: state.allowedPages,
      describeCitation: (page, details) => PaperChatReader.describeCitation(state, page, details),
      navigate: (page, details) => PaperChatReader.navigate(state, page, details).catch(e => { state.error.textContent = e.message; }),
      openLink: url => Zotero.launchURL(url),
    }));
    if (followBottom) state.log.scrollTop = state.log.scrollHeight;
  },

  setBusy(state, busy) {
    state.busy = busy;
    for (const el of [state.send, state.reset, state.clear]) el.disabled = busy || !!state.historyBusy || !state.historyLoaded;
    PaperChatConversations.setBusy(state);
    state.cancel.hidden = !busy && !state.compacting;
    for (const control of [state.modelButton, state.modelSelect, state.effortSelect, state.promptSave, state.promptInput]) control.disabled = busy || state.settingsSaving || !state.settingsReady;
    PaperChatAPISettings.setBusy(state, busy || state.settingsSaving || !state.settingsReady);
    if (busy) { state.settingsMenu.hidden = true; state.modelButton.setAttribute('aria-expanded', 'false'); }
  },

  async ask(state) {
    if (state.busy || state.historyBusy || !state.historyLoaded || !state.input.value.trim()) return;
    const conversationId = state.conversationId;
    const question = state.input.value.trim();
    state.error.textContent = ''; state.cancelRequested = false;
    this.setBusy(state, true);
    const win = state.panel.ownerDocument.defaultView;
    const requestedAt = Date.now();
    state.activityTimer = win.setInterval(() => {
      if (state.disposed) return;
      if (answer) PaperChatInteraction.progress(this, state, answer);
      else state.status.textContent = PaperChatText.t("panel.format08", {value1: (PaperChatInteraction.duration(Date.now() - requestedAt))});
    }, 250);
    let answer;
    try {
      await this.ensureBridge();
      await state.settingsPromise;
      this.applySettings(await this.api('/settings'));
      const data = await this.readPaper(state, question);
      if (state.disposed || state.conversationId !== conversationId) return;
      if (state.cancelRequested) return;
      for (const page of data.paper.pages) state.allowedPages.add(page.number);
      const user = this.message(state, 'user', question);
      Object.assign(user._paperChatEntry, { selection: data.selection, selectionPage: data.selectionPage, currentPage: data.currentPage, pageReferences: data.paper.pages.map(page => page.number) });
      state.input.value = '';
      answer = this.message(state, 'assistant', PaperChatText.t("activity.reading"));
      answer._paperChatEntry.activity = { startedAt: Date.now(), status: 'running', summary: '' };
      PaperChatInteraction.progress(this, state, answer);
      const { jobId, conversationId: returnedId } = await this.api('/ask', 'POST', { ...data, ...state.selectedSettings, conversationId, question });
      if (state.disposed || state.conversationId !== conversationId) return;
      if (!jobId || returnedId && returnedId !== conversationId) throw new Error(PaperChatText.t("history.invalidResponse"));
      state.jobId = jobId;
      state.status.textContent = PaperChatText.t("panel.format09", {value1: (data.paper.pages.length)});
      let previous = '';
      while (!state.disposed && state.conversationId === conversationId) {
        if (state.cancelRequested) await this.api(`/jobs/${jobId}/cancel`, 'POST', {});
        const job = await this.api(`/jobs/${jobId}`);
        if (state.disposed || state.conversationId !== conversationId) return;
        PaperChatInteraction.progress(this, state, answer, job);
        if (job.phase === 'compacting') {
          state.status.textContent = PaperChatText.t('context.compacting');
          state.conversationsUI.statusText.textContent = PaperChatText.t('context.compacting');
        } else if (job.phase === 'answering') {
          state.conversationsUI.statusText.textContent = PaperChatText.t('activity.generating');
        }
        if (job.text && job.text !== previous) { this.render(state, answer, job.text); previous = job.text; }
        if (job.status === 'completed') {
          if (!job.text.trim()) throw new Error(PaperChatText.t("panel.error08"));
          break;
        }
        if (!['running', 'queued', 'pending'].includes(job.status)) throw new Error(job.error || PaperChatText.t("panel.text25"));
        await Zotero.Promise.delay(500);
      }
    } catch (e) {
      Zotero.logError(e);
      if (state.disposed || state.conversationId !== conversationId) return;
      state.error.textContent = e.message;
      if (answer) {
        if (answer._paperChatEntry.text === PaperChatText.t("activity.reading")) this.render(state, answer, PaperChatText.t("panel.text26"));
        Object.assign(answer._paperChatEntry.activity, { status: state.cancelRequested ? 'cancelled' : 'failed', finishedAt: Date.now() });
        PaperChatInteraction.progress(this, state, answer);
      }
    } finally {
      win.clearInterval(state.activityTimer); state.activityTimer = null;
      state.jobId = null;
      if (!state.disposed) { this.setBusy(state, false); this.connectionStatus(state); }
      if (!state.disposed && state.conversationId === conversationId) PaperChatConversations.refreshContext(this, state).catch(e => { state.error.textContent = e.message; });
    }
  },

  async stop() {
    this.stopped = true;
    PaperChatSelection.stop();
    const snapshot = { ...this.savedTranscripts };
    for (const [reader, state] of this.states) {
      try { if (!snapshot[reader._instanceID]?.messages?.length || state.historyLoaded) snapshot[reader._instanceID] = { paperId: state.paperId, conversationId: state.conversationId, messages: state.messages, pageCount: state.pageCount, allowedPages: [...state.allowedPages] }; }
      catch { /* Closed readers do not need a transcript handoff. */ }
    }
    Zotero.PaperChatUpgradeSnapshot = JSON.stringify(snapshot);
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    Zotero.Reader.unregisterEventListener('renderToolbar', this.onToolbar);
    for (const state of this.states.values()) {
      state.disposed = true;
      state.appearanceCleanup?.();
      state.resizeCleanup?.();
      state.highlightCleanup?.();
      state.interactionCleanup?.();
      if (state.jobId) await this.api(`/jobs/${state.jobId}/cancel`, 'POST', {}).catch(() => {});
      try {
        state.panel.remove();
        if (state.oldParentStyle == null) state.parent.removeAttribute('style');
        else state.parent.setAttribute('style', state.oldParentStyle);
        if (state.oldReaderStyle == null) state.reader._iframe.removeAttribute('style');
        else state.reader._iframe.setAttribute('style', state.oldReaderStyle);
      } catch { /* A closed reader has already destroyed its DOM compartment. */ }
    }
    for (const button of this.buttons) { try { button.remove(); } catch {} }
    this.buttons.clear(); this.states.clear();
    if (this.process?.isRunning) {
      await this.api('/shutdown', 'POST', {}).catch(() => {});
      await Zotero.Promise.delay(500);
      if (this.process.isRunning) this.process.kill();
    }
  },
};
