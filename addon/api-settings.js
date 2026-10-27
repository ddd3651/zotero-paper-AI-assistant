/* Independent settings UI. Load before panel.js; the parent owns /settings I/O. */
var PaperChatAPISettings = {
  views: new WeakMap(),

  mount(plugin, state, { settingsMenu, modelLabel, effortLabel }) {
    if (this.views.has(state)) return this.views.get(state);
    const doc = settingsMenu.ownerDocument;
    const el = (tag, text) => plugin.el(doc, tag, text);
    const label = (text, control) => {
      const node = el('label', text);
      control.setAttribute('aria-label', text);
      node.append(control);
      return node;
    };
    const provider = el('select');
    for (const [value, text] of [['codex', PaperChatText.t("settings.codexProvider")], ['external', PaperChatText.t("settings.externalProvider")]]) {
      const option = el('option', text); option.value = value; provider.append(option);
    }
    provider.value = 'codex';
    const providerLabel = label(PaperChatText.t("settings.provider"), provider);
    const external = el('div');
    external.style.display = 'grid'; external.style.gap = '10px';
    const baseUrl = el('input'); baseUrl.type = 'text';
    baseUrl.placeholder = PaperChatText.t("settings.baseUrlPlaceholder");
    const model = el('input'); model.type = 'text'; model.placeholder = PaperChatText.t("apiSettings.text01");
    const apiKey = el('input'); apiKey.type = 'password';
    apiKey.autocomplete = 'off'; apiKey.setAttribute('spellcheck', 'false');
    const clearKey = el('input'); clearKey.type = 'checkbox';
    const save = el('button', PaperChatText.t("settings.saveAPI")); save.type = 'button';
    const status = el('div', ''); status.setAttribute('role', 'status');
    const help = el('div', PaperChatText.t("apiSettings.text02"));
    help.className = 'pc-settings-help';
    external.append(label(PaperChatText.t("settings.baseUrl"), baseUrl), label(PaperChatText.t("settings.externalModel"), model),
      label(PaperChatText.t("settings.apiKey"), apiKey), label(PaperChatText.t("apiSettings.text03"), clearKey), save, status, help);
    settingsMenu.insertBefore(providerLabel, modelLabel);
    settingsMenu.insertBefore(external, modelLabel);
    const webSearch = el('input'); webSearch.type = 'checkbox';
    webSearch.setAttribute('aria-label', PaperChatText.t("settings.webSearch"));
    const webLabel = el('label'); webLabel.style.display = 'flex'; webLabel.style.alignItems = 'center'; webLabel.style.gap = '8px';
    webLabel.append(webSearch, el('span', PaperChatText.t("settings.webSearch")));
    const webHelp = el('div', ''); webHelp.className = 'pc-settings-help';
    const webGroup = el('div'); webGroup.append(webLabel, webHelp);
    settingsMenu.insertBefore(webGroup, modelLabel);
    const view = { provider, external, baseUrl, model, apiKey, clearKey, save, status,
      webSearch, webHelp,
      modelLabel, effortLabel, dirty: new Set(), revisions: {}, pending: null,
      current: { provider: 'codex', external: {} }, busy: false };
    this.views.set(state, view);
    const edit = name => {
      view.dirty.add(name);
      view.revisions[name] = (view.revisions[name] || 0) + 1;
      status.textContent = PaperChatText.t("common.unsaved");
    };
    for (const [name, control] of Object.entries({ baseUrl, model, apiKey, clearKey })) {
      control.addEventListener(name === 'clearKey' ? 'change' : 'input', () => {
        edit(name);
        if (name === 'clearKey') this.setBusy(state, view.busy);
      });
    }
    for (const control of [provider, baseUrl, model, apiKey, clearKey]) {
      control.addEventListener('keydown', event => event.stopPropagation());
    }
    // Errors may contain credentials from a transport: never log or echo them here.
    const submit = async changes => {
      const publicChanges = { provider: changes.provider };
      if (changes.external) publicChanges.external = {
        baseUrl: changes.external.baseUrl, model: changes.external.model,
      };
      view.pending = { changes: publicChanges, revisions: { ...view.revisions }, accepted: false };
      this.setBusy(state, view.busy);
      status.textContent = PaperChatText.t("common.saving");
      try {
        const result = await plugin.saveSettings(state, changes);
        // The parent applies before returning. Only a successful return may
        // acknowledge drafts; null must preserve dirty fields and the key.
        if (result?.current) {
          view.pending.accepted = true;
          this.apply(state, result);
        }
      }
      catch { status.textContent = PaperChatText.t("common.saveFailed"); }
      finally {
        if (view.pending) {
          status.textContent = PaperChatText.t("common.saveFailed");
          provider.value = view.current.provider;
        }
        view.pending = null;
        this.showProvider(view);
        this.setBusy(state, view.busy);
      }
    };
    provider.addEventListener('change', () => {
      if (provider.disabled) return;
      // Display the new provider only after the parent applies the saved result.
      const value = provider.value;
      state.settingsPromise = submit({ provider: value });
    });
    webSearch.addEventListener('change', () => {
      if (webSearch.disabled) return;
      state.settingsPromise = submit({ provider: view.current.provider, webSearch: webSearch.checked });
    });
    webSearch.addEventListener('keydown', event => event.stopPropagation());
    save.addEventListener('click', () => {
      if (save.disabled) return;
      const values = { baseUrl: baseUrl.value, model: model.value };
      if (clearKey.checked) values.apiKey = '';
      else if (apiKey.value) values.apiKey = apiKey.value;
      state.settingsPromise = submit({ provider: 'external', external: values });
    });
    this.showProvider(view);
    this.setBusy(state, state.busy);
    return view;
  },

  showProvider(view) {
    const external = view.current.provider === 'external';
    view.webSearch.checked = !external && view.current.webSearch === true;
    view.webHelp.textContent = external ? PaperChatText.t("apiSettings.text04")
      : view.webSearch.checked ? PaperChatText.t("apiSettings.text05")
      : PaperChatText.t("apiSettings.text06");
    view.external.hidden = !external;
    // Inline display is needed because the external group itself uses a grid.
    view.external.style.display = external ? 'grid' : 'none';
    view.modelLabel.hidden = external;
    view.effortLabel.hidden = external;
    // The panel's label { display:grid } rule overrides the browser's [hidden].
    view.modelLabel.style.display = external ? 'none' : '';
    view.effortLabel.style.display = external ? 'none' : '';
  },

  apply(state, data) {
    const view = this.views.get(state);
    if (!view || !data?.current) return;
    const current = data.current;
    const external = current.external || {};
    // Deliberately pick public fields; never retain an apiKey from a response.
    view.current = { provider: current.provider === 'external' ? 'external' : 'codex', webSearch: current.webSearch === true,
      external: { baseUrl: external.baseUrl || '', model: external.model || '', hasApiKey: !!external.hasApiKey } };
    const pending = view.pending;
    const saved = pending?.accepted;
    if (saved) {
      if (pending.changes.external) {
        for (const name of ['baseUrl', 'model', 'apiKey', 'clearKey']) {
          if (view.revisions[name] !== pending.revisions[name]) continue;
          view.dirty.delete(name);
          if (name === 'apiKey') view.apiKey.value = '';
          if (name === 'clearKey') view.clearKey.checked = false;
        }
      }
      view.pending = null;
    }
    view.provider.value = view.current.provider;
    for (const name of ['baseUrl', 'model']) {
      if (!view.dirty.has(name)) view[name].value = view.current.external[name];
    }
    view.apiKey.placeholder = view.current.external.hasApiKey ? PaperChatText.t("common.saved") : '';
    view.status.textContent = view.dirty.size ? PaperChatText.t("common.unsaved") : (saved ? PaperChatText.t("common.saved") : '');
    this.showProvider(view);
    this.setBusy(state, view.busy);
  },

  setBusy(state, busy) {
    const view = this.views.get(state);
    if (!view) return;
    view.busy = !!busy;
    const disabled = view.busy || !!state.settingsSaving || !state.settingsReady || !!view.pending;
    for (const control of [view.provider, view.baseUrl, view.model, view.apiKey, view.clearKey, view.save]) {
      control.disabled = disabled || (control === view.apiKey && view.clearKey.checked);
    }
    view.webSearch.disabled = disabled || view.current.provider === 'external';
  },
};
