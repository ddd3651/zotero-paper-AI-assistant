/* Load after appearance.js. Mount after the panel is attached; call cleanup on
 * reader disposal and plugin shutdown. panelWidth stores viewport CSS pixels. */
var PaperChatResize = (() => {
  const mounts = new WeakMap();
  const key = 'extensions.paper-chat.panelWidth';
  const composerKey = 'extensions.paper-chat.composerHeight';
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
    .paper-chat-panel > .pc-resize-panel:after {
      content:'';position:absolute;top:0;bottom:0;left:0;width:1px;
      background:color-mix(in srgb,currentColor 18%,transparent);pointer-events:none;
    }
    .paper-chat-panel > .pc-resize-panel[data-side=left]:after {left:auto;right:0}
    .paper-chat-panel > .pc-resize-panel:hover,.paper-chat-panel > .pc-resize-panel[data-dragging] {background:transparent!important}
    .paper-chat-panel > .pc-resize-panel:hover:after,.paper-chat-panel > .pc-resize-panel[data-dragging]:after {width:2px}
    .paper-chat-panel > .pc-resize-composer {
      position:relative!important;display:block!important;flex:0 0 12px!important;
      height:12px!important;width:100%!important;max-height:none!important;max-width:none!important;
      min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;
      border:0!important;border-radius:0!important;background:transparent!important;appearance:none!important;
      cursor:row-resize!important;pointer-events:auto!important;touch-action:none;user-select:none;
      -moz-window-dragging:no-drag;
    }
    .paper-chat-panel > .pc-resize-composer:after {
      content:'';position:absolute;left:14px;right:14px;top:5px;height:1px;
      background:color-mix(in srgb,currentColor 18%,transparent);pointer-events:none;
    }
    .paper-chat-panel > .pc-resize-composer:hover:after,.paper-chat-panel > .pc-resize-composer[data-dragging]:after {height:2px}
    .paper-chat-panel > .pc-resize-composer:focus-visible {outline:2px solid Highlight;outline-offset:-2px}
    .paper-chat-panel > .pc-resize-panel:focus-visible {outline:2px solid Highlight;outline-offset:-2px}`;
    const original = {};
    for (const name of ['position', 'width', 'flexBasis', 'minWidth', 'maxWidth']) original[name] = panel.style[name];
    let saved;
    try { saved = Zotero.Prefs.get(key, true); } catch { /* Use current layout. */ }
    const ui = { plugin, state, panel, parent, win, handle, style, original,
      desired: numeric(saved) ? saved : null, defaultWidth: panel.getBoundingClientRect().width || minimum,
      drag: null, listeners: [], observers: [] };
    if (state.inputArea && state.compose && state.input) {
      const grip = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
      grip.type = 'button'; grip.className = 'pc-resize-composer';
      grip.setAttribute('aria-label', PaperChatText.t('appearance.resizeComposer'));
      let height;
      try { height = Zotero.Prefs.get(composerKey, true); } catch { /* Default height. */ }
      ui.composer = { area: state.inputArea, compose: state.compose, input: state.input, handle: grip,
        desired: numeric(height) ? height : 240, originalHeight: state.inputArea.style.height };
      state.inputArea.before(grip);
    }
    mounts.set(state, ui);
    panel.append(style, handle);
    const on = (node, type, fn, options) => {
      node.addEventListener(type, fn, options);
      ui.listeners.push(() => node.removeEventListener(type, fn, options));
    };
    const consume = event => { event.preventDefault(); event.stopPropagation(); };
    const persist = (axis = 'x') => {
      const target = axis === 'y' ? ui.composer : ui;
      target.desired = Math.round(target.actual);
      try { Zotero.Prefs.set(axis === 'y' ? composerKey : key, target.desired, true); } catch { /* Session still works. */ }
    };
    const finish = (commit = false) => {
      const drag = ui.drag; if (!drag) return;
      ui.drag = null;
      for (const remove of drag.listeners) remove();
      drag.overlay.remove();
      drag.handle.removeAttribute('data-dragging');
      if (commit) persist(drag.axis);
      else { (drag.axis === 'y' ? ui.composer : ui).desired = drag.desired; apply(plugin, state); }
      try { if (drag.pointer && drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id); } catch { /* Detached document. */ }
    };
    const move = event => {
      if (state.disposed) { cleanup(state); return; }
      const drag = ui.drag;
      if (!drag || drag.lastEvent === event || (drag.pointer && event.pointerId !== drag.id) || !Number.isFinite(drag.axis === 'y' ? event.clientY : event.clientX)) return;
      drag.lastEvent = event;
      // Document listeners also see a release whose up event was lost outside the window.
      if (event.buttons === 0) { finish(true); return; }
      consume(event);
      if (drag.axis === 'y') ui.composer.desired = drag.height + (drag.y - event.clientY) / drag.ratio;
      else ui.desired = drag.width + (event.clientX - drag.x) * (drag.side === 'left' ? 1 : -1);
      apply(plugin, state);
    };
    const up = event => {
      const drag = ui.drag;
      if (!drag || (drag.pointer && event.pointerId !== drag.id)) return;
      consume(event); finish(!state.disposed);
      if (state.disposed) cleanup(state);
    };
    const begin = (event, pointer, axis = 'x') => {
      if (state.disposed) { cleanup(state); return; }
      if (ui.drag || event.button !== 0 || event.isPrimary === false || !Number.isFinite(axis === 'y' ? event.clientY : event.clientX)) return;
      apply(plugin, state);
      consume(event);
      const activeHandle = axis === 'y' ? ui.composer.handle : handle;
      activeHandle.setAttribute('data-dragging', '');
      const overlay = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      overlay.className = 'pc-resize-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;'
        + 'background:transparent!important;cursor:' + (axis === 'y' ? 'row-resize' : 'col-resize') + '!important;pointer-events:auto!important;'
        + 'touch-action:none!important;user-select:none!important;-moz-window-dragging:no-drag;';
      // Stay outside the zoomed panel and above the PDF iframe for the entire gesture.
      (doc.documentElement || parent).append(overlay);
      const drag = ui.drag = { id: event.pointerId, pointer, axis, handle: activeHandle, x: event.clientX, y: event.clientY, width: ui.actual,
        height: ui.composer?.actual, ratio: ui.ratio,
        side: ui.side, zoom: panel.style.zoom, desired: (axis === 'y' ? ui.composer : ui).desired, overlay, listeners: [] };
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
        try { activeHandle.setPointerCapture(event.pointerId); } catch { /* Overlay/document fallback remains active. */ }
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
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      consume(event); finish(); apply(plugin, state);
      ui.desired = event.key === 'Home' ? ui.defaultWidth
        : ui.actual + (event.key === 'ArrowRight' ? 1 : -1) * (ui.side === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10);
      apply(plugin, state); persist();
    });
    if (ui.composer) {
      const grip = ui.composer.handle;
      on(grip, 'pointerdown', event => begin(event, true, 'y'));
      on(grip, 'mousedown', event => begin(event, false, 'y'));
      on(grip, 'pointermove', move); on(grip, 'pointerup', up);
      on(grip, 'pointercancel', event => { if (event.pointerId === ui.drag?.id) finish(true); });
      on(grip, 'keydown', event => {
        if (state.disposed) { cleanup(state); return; }
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        consume(event); finish(); apply(plugin, state);
        ui.composer.desired = event.key === 'Home' ? 240
          : ui.composer.actual + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 40 : 10);
        apply(plugin, state); persist('y');
      });
    }
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
      observer.observe(parent); observer.observe(panel);
      if (ui.composer) {
        observer.observe(ui.composer.area); observer.observe(ui.composer.compose);
        for (const node of ui.composer.area.querySelectorAll('*')) observer.observe(node);
      }
      ui.observers.push(observer);
    }
    if (win.MutationObserver) {
      const observer = new win.MutationObserver(() => {
        // Ignore our own width writes, but react to appearance order/zoom changes.
        const signature = panel.style.order + '/' + panel.style.zoom + '/' + panel.hidden;
        if (signature !== ui.signature) refresh();
      });
      observer.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden'] });
      ui.observers.push(observer);
      if (ui.composer) {
        // Selection cards, wrapped labels, warnings and text/font changes can raise the floor.
        const content = new win.MutationObserver(refresh);
        content.observe(ui.composer.area, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
        ui.observers.push(content);
      }
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
    ui.side = side; ui.ratio = ratio;
    const write = (target, name, value) => { if (target.style[name] !== value) target.style[name] = value; };
    if (computed.position === 'static' || !computed.position) write(panel, 'position', 'relative');
    const width = (ui.actual / ratio) + 'px';
    write(panel, 'flexBasis', width); write(panel, 'width', width);
    write(panel, 'minWidth', '0px'); write(panel, 'maxWidth', 'none');
    handle.setAttribute('data-side', side);
    write(handle, 'left', side === 'right' ? '0px' : 'auto');
    write(handle, 'right', side === 'left' ? '0px' : 'auto');
    applyComposer(ui);
    ui.signature = panel.style.order + '/' + panel.style.zoom + '/' + panel.hidden;
  }
  function applyComposer(ui) {
    const c = ui.composer; if (!c) return;
    const { win, ratio, panel } = ui;
    const px = value => parseFloat(value) || 0;
    const css = node => win.getComputedStyle(node);
    const edges = (node, names) => names.reduce((sum, key) => sum + px(css(node)[key]), 0);
    const spacing = node => edges(node, ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']);
    const margins = node => edges(node, ['marginTop', 'marginBottom']);
    const visible = node => !node.hidden && css(node).display !== 'none';
    const height = node => node.getBoundingClientRect().height / ratio;
    // Only normal-flow children consume row height or a flex gap. Visible
    // absolute menus do not contribute; hidden controls are excluded as well.
    const children = node => [...node.children].filter(child => visible(child)
      && !['absolute', 'fixed'].includes(css(child).position)
      && !['style', 'script'].includes(child.tagName?.toLowerCase()));
    const inputCSS = css(c.input);
    // Two actual text lines, not a fixed pixel floor: both fonts may be enlarged.
    const font = px(inputCSS.fontSize) || 13;
    const line = px(inputCSS.lineHeight) || font * 1.6;
    const inputMinimum = Math.max(px(inputCSS.minHeight), line * 2 + spacing(c.input));
    const rows = children(c.compose);
    const composeMinimum = spacing(c.compose) + rows.reduce((sum, node) => sum
      + (node === c.input ? inputMinimum : height(node)) + margins(node), 0)
      + Math.max(0, rows.length - 1) * px(css(c.compose).rowGap || css(c.compose).gap);
    const areaRows = children(c.area);
    c.minimum = Math.ceil(spacing(c.area) + areaRows.reduce((sum, node) => sum
      + (node === c.compose ? composeMinimum : height(node)) + margins(node), 0)
      + Math.max(0, areaRows.length - 1) * px(css(c.area).rowGap || css(c.area).gap));
    const siblings = children(panel).filter(node => node !== c.area && node !== ui.state.log
      && node !== ui.handle && node.tagName?.toLowerCase() !== 'style' && css(node).position !== 'absolute');
    const available = Math.max(0, height(panel) - spacing(panel)
      - siblings.reduce((sum, node) => sum + height(node) + margins(node), 0));
    // Normally retain reading space; when the window is very short, scroll the
    // compose content instead of squeezing text/controls into overlapping rows.
    c.maximum = Math.max(0, available - Math.min(96, Math.max(0, available - c.minimum)));
    c.actual = Math.min(c.maximum, Math.max(c.minimum, c.desired));
    const value = c.actual + 'px';
    if (c.area.style.height !== value) c.area.style.height = value;
  }
  function cleanup(state) {
    const ui = mounts.get(state); if (!ui) return;
    mounts.delete(state);
    for (const observer of ui.observers) observer.disconnect();
    for (const remove of ui.listeners) remove();
    ui.finish();
    ui.handle.remove(); ui.style.remove();
    if (ui.composer) { ui.composer.handle.remove(); ui.composer.area.style.height = ui.composer.originalHeight; }
    for (const [name, value] of Object.entries(ui.original)) ui.panel.style[name] = value;
  }
  return { mount, apply, cleanup };
})();
