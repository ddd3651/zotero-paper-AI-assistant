/* Integration: mount(plugin, state, { head, title }) after creating the header.
 * state(plugin) returns a settings snapshot; set(plugin, patch) syncs all panels.
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
  function record(plugin) {
    if (!records.has(plugin)) records.set(plugin, {
      side: read('side') === 'left' ? 'left' : 'right', fontSize: font(read('fontSize')),
      uiZoom: zoom(read('uiZoom')), mounted: new Set(),
    });
    return records.get(plugin);
  }
  function snapshot(plugin) {
    const { side, fontSize, uiZoom } = record(plugin);
    return { side, fontSize, uiZoom };
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
    panel.style.fontSize = value.fontSize + 'px';
    panel.style.setProperty('--pc-font-size', value.fontSize + 'px');
    panel.style.zoom = String(value.uiZoom);
    panel.style.setProperty('--pc-ui-zoom', String(value.uiZoom));
    const ui = mounts.get(state);
    if (ui) {
      ui.sideButton.textContent = value.side === 'left' ? PaperChatText.t("appearance.moveRight") : PaperChatText.t("appearance.moveLeft");
      ui.fontInput.value = String(value.fontSize);
      ui.fontRange.value = String(value.fontSize);
      ui.zoomButton.textContent = PaperChatText.t("appearance.format01", {value1: (Math.round(value.uiZoom * 100))});
    }
    for (const [el, top, left] of scroll) { el.scrollTop = top; el.scrollLeft = left; }
    return snapshot(plugin);
  }
  function set(plugin, patch) {
    const value = record(plugin);
    const next = {};
    if (patch.side === 'left' || patch.side === 'right') next.side = patch.side;
    if ('fontSize' in patch && number(patch.fontSize) !== null) next.fontSize = font(patch.fontSize, value.fontSize);
    if ('uiZoom' in patch && number(patch.uiZoom) !== null) next.uiZoom = zoom(patch.uiZoom, value.uiZoom);
    for (const [key, entry] of Object.entries(next)) {
      value[key] = entry;
      try { Zotero.Prefs.set(prefix + key, key === 'uiZoom' ? String(entry) : entry, true); }
      catch { /* In-memory controls still work. */ }
    }
    const states = new Set([...value.mounted, ...(plugin.states?.values() || [])]);
    for (const state of states) {
      if (state.disposed) { cleanup(state); continue; }
      apply(plugin, state);
    }
    return snapshot(plugin);
  }
  const scope = '.paper-chat-panel[data-pc-appearance]';
  const rules = [
    ['.pc-title', 15], ['.pc-title button', 12], ['.pc-status,.pc-role', 11],
    ['.pc-message,.pc-markdown,.pc-plain,.pc-compose,button,select,textarea,input,.pc-settings-title', 13],
    ['.pc-markdown h1', 21], ['.pc-markdown h2', 18], ['.pc-markdown h3', 15.5],
    ['.pc-markdown h4', 14], ['.pc-markdown h5,.pc-markdown h6', 13],
    ['.pc-markdown pre code', 11.5], ['.pc-markdown table,.pc-model-trigger,.pc-settings-menu label,.pc-selection,.pc-prompt-input,.pc-error', 12],
    ['.pc-markdown .pc-cite,.pc-settings-title button,.pc-settings-help,.pc-selection-head button,.pc-prompt-status', 11],
    ['.pc-hint', 10.5], ['.pc-appearance,.pc-appearance input,.pc-title .pc-appearance-side,.pc-appearance button', 12],
  ];
  const css = rules.map(([selectors, px]) => selectors.split(',').map(s => `${scope} ${s}`).join(',')
    + `{font-size:calc(var(--pc-font-size) * ${px / 13})!important}`).join('\n') + `
    ${scope}{overflow-anchor:none}
    ${scope} .pc-appearance{display:flex;align-items:center;gap:6px;margin-top:8px;min-width:0}
    ${scope} .pc-appearance input[type=number]{width:48px;min-width:0;padding:2px 3px;border:1px solid #cbd2d9;border-radius:4px;background:var(--material-background,#fff);color:inherit}
    ${scope} .pc-appearance input[type=range]{flex:1;min-width:36px;width:70px;margin:0}
    ${scope} .pc-appearance button{min-height:24px;padding:2px 5px}
    ${scope} .pc-title{gap:5px}
    ${scope} .pc-title>span{flex:1;min-width:0}
    ${scope} .pc-title .pc-appearance-side{padding:3px 5px}
    ${scope} .pc-settings-menu{max-height:calc(70vh / var(--pc-ui-zoom))}
  `;
  function mount(plugin, state, { head, title }) {
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
    title.insertBefore(sideButton, title.lastElementChild);
    const row = el('div'); row.className = 'pc-appearance';
    const label = el('label', PaperChatText.t("appearance.fontLabel")), fontInput = el('input'), fontRange = el('input');
    fontInput.type = 'number'; fontRange.type = 'range';
    for (const input of [fontInput, fontRange]) { input.min = '11'; input.max = '24'; input.step = '1'; }
    fontInput.setAttribute('aria-label', PaperChatText.t("appearance.fontAria")); fontRange.setAttribute('aria-label', PaperChatText.t("appearance.fontSliderAria"));
    label.append(fontInput);
    const zoomButton = el('button'); zoomButton.type = 'button'; zoomButton.title = PaperChatText.t("appearance.resetZoom");
    row.append(label, fontRange, zoomButton); head.append(row);
    const style = el('style', css); style.setAttribute('data-pc-appearance-style', ''); panel.append(style);
    panel.setAttribute('data-pc-appearance', '');
    const ui = { plugin, sideButton, fontInput, fontRange, zoomButton, row, style, listeners };
    mounts.set(state, ui); record(plugin).mounted.add(state);
    on(sideButton, 'click', () => set(plugin, { side: record(plugin).side === 'left' ? 'right' : 'left' }));
    on(zoomButton, 'click', () => set(plugin, { uiZoom: 1 }));
    on(row, 'keydown', event => event.stopPropagation());
    on(sideButton, 'keydown', event => event.stopPropagation());
    on(fontInput, 'input', () => {
      const n = number(fontInput.value);
      // Preserve unfinished/out-of-range edits until blur/change.
      if (n !== null && Number.isInteger(n) && n >= 11 && n <= 24) set(plugin, { fontSize: n });
    });
    const commit = () => { set(plugin, { fontSize: font(fontInput.value, record(plugin).fontSize) }); };
    on(fontInput, 'change', commit); on(fontInput, 'blur', commit);
    on(fontRange, 'input', () => set(plugin, { fontSize: fontRange.value }));
    on(fontRange, 'change', () => set(plugin, { fontSize: fontRange.value }));
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
