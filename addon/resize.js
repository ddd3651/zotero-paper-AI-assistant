/* Load after appearance.js. Mount after the panel is attached; call cleanup on
 * reader disposal and plugin shutdown. panelWidth stores viewport CSS pixels. */
var PaperChatResize = (() => {
  const mounts = new WeakMap();
  const key = 'extensions.paper-chat.panelWidth';
  const minimum = 280, readerMinimum = 240;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  function mount(plugin, state) {
    if (!state?.panel || state.disposed) return;
    if (mounts.has(state)) { apply(plugin, state); return mounts.get(state); }
    const panel = state.panel, parent = panel.parentElement;
    if (!parent) return;
    const doc = panel.ownerDocument, win = doc.defaultView;
    const handle = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    handle.type = 'button'; handle.className = 'pc-resize-panel';
    handle.setAttribute('aria-label', PaperChatText.t('appearance.resizePanel'));
    const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    // Zotero's global button max-height otherwise caps this full-height edge at 25px.
    style.textContent = `.paper-chat-panel > .pc-resize-panel {
      position:absolute!important;top:0!important;bottom:0!important;width:16px!important;
      height:100%!important;max-height:none!important;max-width:none!important;
      min-width:0!important;min-height:0!important;margin:0!important;
      padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;
      appearance:none!important;cursor:col-resize!important;pointer-events:auto!important;
      touch-action:none;user-select:none;z-index:20;
      -moz-window-dragging:no-drag;
    }
    .paper-chat-panel > .pc-resize-panel:hover {background:color-mix(in srgb,currentColor 9%,transparent)!important}
    .paper-chat-panel > .pc-resize-panel:focus-visible {outline:2px solid Highlight;outline-offset:-2px}`;
    const original = {};
    for (const name of ['position', 'width', 'flexBasis', 'minWidth', 'maxWidth']) original[name] = panel.style[name];
    let saved;
    try { saved = Zotero.Prefs.get(key, true); } catch { /* Use current layout. */ }
    const ui = { plugin, state, panel, parent, win, handle, style, original,
      desired: numeric(saved) ? saved : null, drag: null, listeners: [], observers: [] };
    mounts.set(state, ui);
    panel.append(style, handle);
    const on = (node, type, fn, options) => {
      node.addEventListener(type, fn, options);
      ui.listeners.push(() => node.removeEventListener(type, fn, options));
    };
    const consume = event => { event.preventDefault(); event.stopPropagation(); };
    const persist = () => {
      ui.desired = Math.round(ui.actual);
      try { Zotero.Prefs.set(key, ui.desired, true); } catch { /* Session still works. */ }
    };
    const finish = (commit = false) => {
      const drag = ui.drag; if (!drag) return;
      ui.drag = null;
      for (const remove of drag.listeners) remove();
      drag.overlay.remove();
      if (commit) persist();
      else { ui.desired = drag.desired; apply(plugin, state); }
      try { if (drag.pointer && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id); } catch { /* Detached document. */ }
    };
    const move = event => {
      if (state.disposed) { cleanup(state); return; }
      const drag = ui.drag;
      if (!drag || drag.lastEvent === event || (drag.pointer && event.pointerId !== drag.id) || !Number.isFinite(event.clientX)) return;
      drag.lastEvent = event;
      // Document listeners also see a release whose up event was lost outside the window.
      if (event.buttons === 0) { finish(true); return; }
      consume(event);
      ui.desired = drag.width + (event.clientX - drag.x) * (drag.side === 'left' ? 1 : -1);
      apply(plugin, state);
    };
    const up = event => {
      const drag = ui.drag;
      if (!drag || (drag.pointer && event.pointerId !== drag.id)) return;
      consume(event); finish(!state.disposed);
      if (state.disposed) cleanup(state);
    };
    const begin = (event, pointer) => {
      if (state.disposed) { cleanup(state); return; }
      if (ui.drag || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.clientX)) return;
      apply(plugin, state);
      consume(event);
      const overlay = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      overlay.className = 'pc-resize-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;'
        + 'background:transparent!important;cursor:col-resize!important;pointer-events:auto!important;'
        + 'touch-action:none!important;user-select:none!important;-moz-window-dragging:no-drag;';
      // Stay outside the zoomed panel and above the PDF iframe for the entire gesture.
      (doc.documentElement || parent).append(overlay);
      const drag = ui.drag = { id: event.pointerId, pointer, x: event.clientX, width: ui.actual,
        side: ui.side, zoom: panel.style.zoom, desired: ui.desired, overlay, listeners: [] };
      const listen = (target, type, handler) => {
        target.addEventListener(type, handler, true);
        drag.listeners.push(() => target.removeEventListener(type, handler, true));
      };
      listen(doc, pointer ? 'pointermove' : 'mousemove', move);
      listen(doc, pointer ? 'pointerup' : 'mouseup', up);
      listen(doc, 'keydown', event => { if (event.key === 'Escape') { consume(event); finish(); } });
      if (pointer) {
        listen(doc, 'pointercancel', event => { if (event.pointerId === ui.drag?.id) finish(true); });
        // Capturing is an optimization. Gecko can drop it while the sibling PDF relayouts.
        try { handle.setPointerCapture(event.pointerId); } catch { /* Overlay/document fallback remains active. */ }
      }
    };
    on(handle, 'pointerdown', event => begin(event, true));
    on(handle, 'mousedown', event => begin(event, false));
    on(handle, 'pointermove', move);
    on(handle, 'pointerup', up);
    on(handle, 'pointercancel', event => {
      if (event.pointerId === ui.drag?.id) finish(true);
    });
    on(win, 'blur', () => finish(true));
    on(handle, 'keydown', event => {
      if (state.disposed) { cleanup(state); return; }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      consume(event); finish(); apply(plugin, state);
      ui.desired = ui.actual + (event.key === 'ArrowRight' ? 1 : -1) * (ui.side === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10);
      apply(plugin, state); persist();
    });
    const refresh = () => {
      if (state.disposed) { cleanup(state); return; }
      if (ui.drag && (ui.drag.zoom !== panel.style.zoom || ui.drag.side !== sideFor(plugin, panel, win))) finish(true);
      apply(plugin, state);
    };
    on(win, 'resize', refresh);
    if (win.ResizeObserver) {
      const observer = new win.ResizeObserver(() => {
        if (state.disposed) cleanup(state); else apply(plugin, state);
      });
      observer.observe(parent); observer.observe(panel); ui.observers.push(observer);
    }
    if (win.MutationObserver) {
      const observer = new win.MutationObserver(() => {
        // Ignore our own width writes, but react to appearance order/zoom changes.
        const signature = panel.style.order + '/' + panel.style.zoom + '/' + panel.hidden;
        if (signature !== ui.signature) refresh();
      });
      observer.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden'] });
      ui.observers.push(observer);
    }
    ui.finish = finish;
    apply(plugin, state);
    return ui;
  }
  function sideFor(plugin, panel, win) {
    const order = Number(win.getComputedStyle(panel).order);
    if (order < 0) return 'left';
    if (order > 0) return 'right';
    try { return PaperChatAppearance.state(plugin).side; } catch { return 'right'; }
  }
  function apply(plugin, state) {
    const ui = mounts.get(state); if (!ui) return;
    if (state.disposed) { cleanup(state); return; }
    const { panel, parent, handle, win } = ui;
    const side = sideFor(plugin, panel, win);
    // Compare with the gesture itself: a ResizeObserver can run before MutationObserver.
    if (ui.drag && (ui.drag.side !== side || ui.drag.zoom !== panel.style.zoom)) ui.finish(true);
    const rect = panel.getBoundingClientRect();
    const computed = win.getComputedStyle(panel);
    // Computed border-box width avoids offsetWidth's integer rounding at zoom.
    const layoutWidth = parseFloat(computed.width) || panel.offsetWidth;
    const ratio = rect.width > 0 && layoutWidth > 0 ? rect.width / layoutWidth
      : (parseFloat(computed.zoom) || 1);
    const available = parent.getBoundingClientRect().width;
    const maximum = Math.max(minimum, available - readerMinimum);
    if (ui.desired === null && rect.width > 0) ui.desired = rect.width;
    ui.actual = Math.max(minimum, Math.min(maximum, ui.desired ?? minimum));
    ui.side = side;
    const write = (target, name, value) => { if (target.style[name] !== value) target.style[name] = value; };
    if (computed.position === 'static' || !computed.position) write(panel, 'position', 'relative');
    const width = (ui.actual / ratio) + 'px';
    write(panel, 'flexBasis', width); write(panel, 'width', width);
    write(panel, 'minWidth', '0px'); write(panel, 'maxWidth', 'none');
    write(handle, 'left', side === 'right' ? '0px' : 'auto');
    write(handle, 'right', side === 'left' ? '0px' : 'auto');
    ui.signature = panel.style.order + '/' + panel.style.zoom + '/' + panel.hidden;
  }
  function cleanup(state) {
    const ui = mounts.get(state); if (!ui) return;
    mounts.delete(state);
    for (const observer of ui.observers) observer.disconnect();
    for (const remove of ui.listeners) remove();
    ui.finish();
    ui.handle.remove(); ui.style.remove();
    for (const [name, value] of Object.entries(ui.original)) ui.panel.style[name] = value;
  }
  return { mount, apply, cleanup };
})();
