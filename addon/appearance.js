/* Integration: mount(plugin, state) returns row; the caller mounts it in settings.
 * state(plugin) returns a settings snapshot; set(plugin, patch) syncs all panels.
 * fontSize is a read/write compatibility alias for chatFontSize only.
 * apply(plugin, state) reapplies settings. cleanup(state)/stop(plugin) release UI/events.
 */
var PaperChatAppearance = (() => {
  const records = new WeakMap();
  const mounts = new WeakMap();
  const prefix = 'extensions.paper-chat.';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
    && Number.isFinite(Number(value)) ? Number(value) : null;
  const font = (value, fallback = 13) => number(value) === null ? fallback : clamp(Math.round(Number(value)), 11, 24);
  const zoom = (value, fallback = 1) => number(value) === null ? fallback : clamp(Number(value), .75, 1.75);
  function read(key) { try { return Zotero.Prefs.get(prefix + key, true); } catch { return undefined; } }
  function save(key, value) {
    try { Zotero.Prefs.set(prefix + key, key === 'uiZoom' ? String(value) : value, true); }
    catch { /* In-memory controls still work. */ }
  }
  function record(plugin) {
    if (!records.has(plugin)) {
      const legacy = font(read('fontSize'));
      const chat = read('chatFontSize'), system = read('systemFontSize');
      const value = {
        side: read('side') === 'left' ? 'left' : 'right',
        chatFontSize: font(chat, legacy), systemFontSize: font(system, legacy),
        uiZoom: zoom(read('uiZoom')), mounted: new Set(),
      };
      records.set(plugin, value);
      // Save both migrated values immediately, so later chat edits cannot change
      // the system fallback after a restart. Valid split preferences always win.
      if (number(chat) === null) save('chatFontSize', value.chatFontSize);
      if (number(system) === null) save('systemFontSize', value.systemFontSize);
    }
    return records.get(plugin);
  }
  function snapshot(plugin) {
    const { side, chatFontSize, systemFontSize, uiZoom } = record(plugin);
    return { side, chatFontSize, systemFontSize, fontSize: chatFontSize, uiZoom };
  }
  function apply(plugin, state) {
    if (!state?.panel || state.disposed) return;
    const value = record(plugin), panel = state.panel;
    // Capture before layout changes, including zero offsets (e.g. newly opened logs).
    const containers = new Set([panel, state.log,
      ...panel.querySelectorAll('.pc-table-scroll,.pc-settings-menu,.pc-selection-text')]);
    const scroll = [...containers].filter(Boolean).map(el => [el, el.scrollTop, el.scrollLeft]);
    panel.style.order = value.side === 'left' ? '-1' : '1';
    panel.style.borderLeft = value.side === 'right' ? '1px solid #ccc' : 'none';
    panel.style.borderRight = value.side === 'left' ? '1px solid #ccc' : 'none';
    panel.style.fontSize = value.systemFontSize + 'px';
    panel.style.setProperty('--pc-chat-font-size', value.chatFontSize + 'px');
    panel.style.setProperty('--pc-system-font-size', value.systemFontSize + 'px');
    panel.style.setProperty('--pc-font-size', value.chatFontSize + 'px');
    panel.style.zoom = String(value.uiZoom);
    panel.style.setProperty('--pc-ui-zoom', String(value.uiZoom));
    const ui = mounts.get(state);
    if (ui) {
      ui.sideButton.textContent = value.side === 'left' ? PaperChatText.t("appearance.moveRight") : PaperChatText.t("appearance.moveLeft");
      ui.fontInput.value = ui.fontRange.value = String(value.chatFontSize);
      ui.systemInput.value = ui.systemRange.value = String(value.systemFontSize);
      ui.zoomButton.textContent = PaperChatText.t("appearance.format01", {value1: (Math.round(value.uiZoom * 100))});
    }
    for (const [el, top, left] of scroll) { el.scrollTop = top; el.scrollLeft = left; }
    return snapshot(plugin);
  }
  function set(plugin, patch) {
    const value = record(plugin);
    const next = {};
    if (patch.side === 'left' || patch.side === 'right') next.side = patch.side;
    if ('fontSize' in patch && number(patch.fontSize) !== null) next.chatFontSize = font(patch.fontSize, value.chatFontSize);
    if ('chatFontSize' in patch && number(patch.chatFontSize) !== null) next.chatFontSize = font(patch.chatFontSize, value.chatFontSize);
    if ('systemFontSize' in patch && number(patch.systemFontSize) !== null) next.systemFontSize = font(patch.systemFontSize, value.systemFontSize);
    if ('uiZoom' in patch && number(patch.uiZoom) !== null) next.uiZoom = zoom(patch.uiZoom, value.uiZoom);
    for (const [key, entry] of Object.entries(next)) {
      value[key] = entry;
      save(key, entry);
      if (key === 'chatFontSize') save('fontSize', entry);
    }
    const states = new Set([...value.mounted, ...(plugin.states?.values() || [])]);
    for (const state of states) {
      if (state.disposed) { cleanup(state); continue; }
      apply(plugin, state);
    }
    return snapshot(plugin);
  }
  const scope = '.paper-chat-panel[data-pc-appearance]';
  const systemRules = [
    ['.pc-title', 15], ['.pc-title button', 12], ['.pc-status,.pc-role', 11],
    ['.pc-compose,button,select,textarea,input,.pc-settings-title,.pc-drawer', 13],
    ['.pc-model-trigger,.pc-settings-menu label,.pc-selection,.pc-prompt-input,.pc-error', 12],
    ['.pc-settings-title button,.pc-settings-help,.pc-selection-head button,.pc-prompt-status', 11],
    ['.pc-hint', 10.5], ['.pc-appearance,.pc-appearance input,.pc-appearance button', 12],
    ['.pc-activity,.pc-context-status,.pc-capacity,.pc-muted,.pc-drawer-error', 12],
  ];
  const chatRules = [
    ['.pc-message,.pc-markdown,.pc-plain,.pc-compose>textarea:not(.pc-prompt-input),.pc-selection-text', 13],
    ['.pc-markdown h1', 21], ['.pc-markdown h2', 18], ['.pc-markdown h3', 15.5],
    ['.pc-markdown h4', 14], ['.pc-markdown h5,.pc-markdown h6', 13],
    ['.pc-markdown pre code', 11.5], ['.pc-markdown table', 12], ['.pc-markdown .pc-cite', 11],
  ];
  const sizes = (rules, variable) => rules.map(([selectors, px]) => selectors.split(',').map(s => `${scope} ${s}`).join(',')
    + `{font-size:calc(var(${variable}) * ${px / 13})!important}`).join('\n');
  const css = sizes(systemRules, '--pc-system-font-size') + '\n' + sizes(chatRules, '--pc-chat-font-size') + `
    ${scope}{overflow-anchor:none}
    ${scope} .pc-appearance{display:grid;gap:10px;min-width:0}
    ${scope} .pc-appearance-font{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
    ${scope} .pc-appearance .pc-appearance-font label{display:flex;align-items:center;gap:6px;min-width:0;font-size:inherit!important}
    ${scope} .pc-appearance-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
    ${scope} .pc-appearance input[type=number]{width:4em;min-width:0;max-width:100%;flex:none;padding:2px 3px;border:1px solid #cbd2d9;border-radius:4px;background:var(--material-background,#fff);color:inherit}
    ${scope} .pc-appearance input[type=range]{flex:1;min-width:36px;width:70px;margin:0}
    ${scope} .pc-appearance button{min-height:24px;padding:2px 5px}
    /* Native Zotero buttons may have a global max-height. Let text controls grow
       with system text, without imposing a minimum on panels or textareas. */
    ${scope} button:not([class*="resize"]){height:auto!important;max-height:none!important;min-height:calc(1.3em + 8px);line-height:1.3}
    ${scope} select{height:auto!important;max-height:none!important;min-height:calc(1.3em + 8px)}
    ${scope} input[type=number],${scope} input[type=text]{height:auto!important;max-height:none!important;line-height:1.4}
    ${scope} .pc-title{gap:5px}
    ${scope} .pc-title>span{flex:1;min-width:0}
    ${scope} .pc-settings-menu{max-height:calc(70vh / var(--pc-ui-zoom))}
  `;
  function mount(plugin, state) {
    if (mounts.has(state)) { apply(plugin, state); return mounts.get(state); }
    const panel = state.panel, doc = panel.ownerDocument, listeners = [];
    const el = (tag, text) => {
      const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
      if (text != null) node.textContent = text;
      return node;
    };
    const on = (node, type, handler, options) => {
      node.addEventListener(type, handler, options);
      listeners.push(() => node.removeEventListener(type, handler, options));
    };
    const sideButton = el('button'); sideButton.type = 'button'; sideButton.className = 'pc-appearance-side';
    const row = el('div'); row.className = 'pc-appearance';
    const fontControls = (labelText, sliderText) => {
      const line = el('div'); line.className = 'pc-appearance-font';
      const label = el('label', labelText), input = el('input'), range = el('input');
      input.type = 'number'; range.type = 'range';
      for (const control of [input, range]) { control.min = '11'; control.max = '24'; control.step = '1'; }
      input.setAttribute('aria-label', labelText); range.setAttribute('aria-label', sliderText);
      label.append(input); line.append(label, range); row.append(line);
      return [input, range];
    };
    const [fontInput, fontRange] = fontControls(PaperChatText.t("appearance.chatFont"), PaperChatText.t("appearance.chatFontSlider"));
    const [systemInput, systemRange] = fontControls(PaperChatText.t("appearance.systemFont"), PaperChatText.t("appearance.systemFontSlider"));
    const zoomButton = el('button'); zoomButton.type = 'button'; zoomButton.title = PaperChatText.t("appearance.resetZoom");
    const actions = el('div'); actions.className = 'pc-appearance-actions';
    actions.append(sideButton, zoomButton); row.append(actions);
    const style = el('style', css); style.setAttribute('data-pc-appearance-style', ''); panel.append(style);
    panel.setAttribute('data-pc-appearance', '');
    const ui = { plugin, sideButton, fontInput, fontRange, systemInput, systemRange, zoomButton, row, style, listeners };
    mounts.set(state, ui); record(plugin).mounted.add(state);
    on(sideButton, 'click', () => set(plugin, { side: record(plugin).side === 'left' ? 'right' : 'left' }));
    on(zoomButton, 'click', () => set(plugin, { uiZoom: 1 }));
    on(row, 'keydown', event => event.stopPropagation());
    on(sideButton, 'keydown', event => event.stopPropagation());
    for (const [input, range, key] of [[fontInput, fontRange, 'chatFontSize'], [systemInput, systemRange, 'systemFontSize']]) {
      on(input, 'input', () => {
        const n = number(input.value);
        // Preserve unfinished/out-of-range edits until blur/change.
        if (n !== null && Number.isInteger(n) && n >= 11 && n <= 24) set(plugin, { [key]: n });
      });
      const commit = () => set(plugin, { [key]: font(input.value, record(plugin)[key]) });
      on(input, 'change', commit); on(input, 'blur', commit);
      on(range, 'input', () => set(plugin, { [key]: range.value }));
      on(range, 'change', () => set(plugin, { [key]: range.value }));
    }
    let source = '', lastTime = 0, gestureBase = 1, mozUpdated = false;
    const accept = kind => {
      const now = Date.now();
      if (source && source !== kind && now - lastTime < 250) return false;
      source = kind; lastTime = now; return true;
    };
    const consume = event => { event.preventDefault(); event.stopPropagation(); };
    on(panel, 'wheel', event => {
      if (!event.ctrlKey) return;
      consume(event);
      if (accept('wheel') && Number.isFinite(event.deltaY))
        set(plugin, { uiZoom: record(plugin).uiZoom * Math.exp(clamp(-event.deltaY * .003, -100, 100)) });
    }, { passive: false });
    on(panel, 'MozMagnifyGestureStart', event => { consume(event); mozUpdated = false; }, { passive: false });
    on(panel, 'MozMagnifyGestureUpdate', event => {
      consume(event);
      if (accept('moz') && Number.isFinite(event.delta)) {
        mozUpdated = true; set(plugin, { uiZoom: record(plugin).uiZoom * Math.exp(clamp(event.delta * .003, -100, 100)) });
      }
    }, { passive: false });
    on(panel, 'MozMagnifyGesture', event => {
      consume(event);
      if (!mozUpdated && accept('moz') && Number.isFinite(event.delta))
        set(plugin, { uiZoom: record(plugin).uiZoom * Math.exp(clamp(event.delta * .003, -100, 100)) });
      mozUpdated = false;
    }, { passive: false });
    on(panel, 'gesturestart', event => { consume(event); gestureBase = record(plugin).uiZoom; }, { passive: false });
    on(panel, 'gesturechange', event => {
      consume(event);
      if (accept('gesture') && Number.isFinite(event.scale) && event.scale > 0)
        set(plugin, { uiZoom: gestureBase * event.scale });
    }, { passive: false });
    on(panel, 'gestureend', consume, { passive: false });
    apply(plugin, state);
    return ui;
  }
  function cleanup(state) {
    const ui = mounts.get(state); if (!ui) return;
    for (const remove of ui.listeners) remove();
    for (const node of [ui.sideButton, ui.row, ui.style]) node.remove();
    state.panel.removeAttribute('data-pc-appearance');
    record(ui.plugin).mounted.delete(state); mounts.delete(state);
  }
  function stop(plugin) {
    for (const state of [...record(plugin).mounted]) cleanup(state);
    records.delete(plugin);
  }
  return { mount, apply, state: snapshot, set, cleanup, stop };
})();
