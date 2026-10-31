import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../addon/resize.js', import.meta.url), 'utf8');
const key = 'extensions.paper-chat.panelWidth';

// DOM mock with layout (including CSS zoom), event listeners, pointer capture,
// style mutation delivery, and resize observer delivery rather than source checks.
function fixture({ side = 'right', zoom = 1, saved, available = 1200, broken = false, captureFails = false, platform = 'mac', composer = false, savedHeight, height = 800, chatFont = 13, systemFont = 13, selection = false } = {}) {
  const mutations = new Set(), resizes = new Set(), writes = [], prefs = { [key]: saved, 'extensions.paper-chat.composerHeight': savedHeight };
  class Target {
    events = new Map();
    addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
    removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
    fire(type, props = {}) {
      const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 500, clientY: 400,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
      for (const fn of [...(this.events.get(type) || [])]) fn(event);
      return event;
    }
    get listenerCount() { return [...this.events.values()].reduce((n, entries) => n + entries.size, 0); }
  }
  class Element extends Target {
    children = []; attrs = {}; hidden = false; captured = new Set();
    constructor(tag) {
      super(); this.tagName = tag; this.ownerDocument = doc;
      this.style = new Proxy({ position: '', width: '', flexBasis: '', minWidth: '', maxWidth: '', order: '', zoom: '', fontSize: '' }, {
        set: (target, prop, value) => {
          if (target[prop] !== value) for (const observer of mutations) if (observer.target === this) observer.pending = true;
          target[prop] = value; return true;
        },
      });
    }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    before(...nodes) { const parent = this.parentElement, index = parent.children.indexOf(this); for (const node of nodes) { node.remove(); node.parentElement = parent; } parent.children.splice(index, 0, ...nodes); }
    querySelectorAll(selector) { return this.children.flatMap(node => [node, ...node.querySelectorAll(selector)]); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    get offsetWidth() { return Math.round(parseFloat(this.style.width) || 370); }
    getBoundingClientRect() {
      let ancestor = this;
      while (ancestor && ancestor.tagName !== 'aside') ancestor = ancestor.parentElement;
      const scale = Number(ancestor?.style.zoom) || 1;
      const area = ancestor?.children.find(n => n.className === 'pc-input-area');
      let layoutHeight = 0;
      if (this.tagName === 'main' || this.tagName === 'aside') layoutHeight = height;
      else if (this.tagName === 'header') layoutHeight = 44 * systemFont / 13;
      else if (this.className === 'pc-resize-composer') layoutHeight = 12;
      else if (this.className === 'pc-input-area') layoutHeight = parseFloat(this.style.height) || 240;
      else if (this.className === 'pc-composer-footer') layoutHeight = systemFont * 3 + 6;
      else if (this.className === 'pc-compose') layoutHeight = Math.max(0, (parseFloat(area?.style.height) || 240) - (systemFont * 3 + 6) - 23);
      else if (this.className === 'pc-model-row') layoutHeight = systemFont * 1.5 + 12;
      else if (this.className === 'pc-bottom') layoutHeight = Math.max(28, systemFont * 1.5 + 8);
      else if (this.className === 'pc-selection') layoutHeight = this.hidden ? 0 : systemFont * 4 + 18;
      else if (this.tagName === 'textarea') layoutHeight = chatFont * 3.2;
      return { width: this.tagName === 'main' ? available : (parseFloat(this.style.width) || 370) * scale, height: layoutHeight * scale };
    }
    setPointerCapture(id) { if (captureFails) throw Error('capture'); this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); this.fire('lostpointercapture', { pointerId: id }); }
  }
  class MutationObserver {
    constructor(fn) { this.fn = fn; mutations.add(this); }
    observe(target) { this.target = target; }
    disconnect() { mutations.delete(this); }
  }
  class ResizeObserver {
    targets = new Set();
    constructor(fn) { this.fn = fn; resizes.add(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { resizes.delete(this); }
  }
  const win = new Target(); Object.assign(win, { MutationObserver, ResizeObserver,
    getComputedStyle(panel) {
      const styles = { ...panel.style, display: panel.hidden ? 'none' : 'block', position: panel.style.position || 'static', width: panel.style.width || '370px',
        fontSize: (panel.tagName === 'textarea' ? chatFont : systemFont) + 'px', lineHeight: (panel.tagName === 'textarea' ? chatFont * 1.6 : systemFont * 1.5) + 'px' };
      if (panel.className === 'pc-input-area') Object.assign(styles, { paddingTop: '4px', paddingBottom: '12px', rowGap: '7px' });
      if (panel.className === 'pc-compose') Object.assign(styles, { paddingTop: '10px', paddingBottom: '10px', borderTopWidth: '1px', borderBottomWidth: '1px', rowGap: '7px' });
      if (panel.className === 'pc-resize-panel') styles.position = 'absolute';
      return styles;
    },
  });
  const doc = Object.assign(new Target(), { defaultView: win, createElementNS: (_, tag) => new Element(tag) });
  doc.documentElement = new Element('html');
  const calls = [], plugin = {};
  const scope = vm.createContext({ Zotero: { isMac: platform === 'mac', isWin: platform === 'win', Prefs: {
    get(name, raw) { assert.equal(raw, true); if (broken) throw Error('prefs'); return prefs[name]; },
    set(name, value, raw) { assert.equal(raw, true); assert.ok(Number.isInteger(value)); writes.push([name, value]); if (broken) throw Error('prefs'); prefs[name] = value; },
  } }, PaperChatText: { t(name) { calls.push(name); return 'Localized resize'; } },
  PaperChatAppearance: { state: () => ({ side, fontSize: 17, uiZoom: zoom }) } });
  vm.runInContext(source, scope);
  const api = scope.PaperChatResize;
  const root = new Element('main');
  function panel() {
    const panel = new Element('aside');
    Object.assign(panel.style, { order: side === 'left' ? '-1' : '1', zoom: String(zoom), fontSize: '17px',
      flexBasis: 'clamp(300px,32vw,440px)', width: '370px' });
    root.append(panel); const state = { panel };
    if (composer) {
      state.log = new Element('div'); state.log.className = 'pc-log';
      state.inputArea = new Element('div'); state.inputArea.className = 'pc-input-area';
      state.compose = new Element('div'); state.compose.className = 'pc-compose';
      state.input = new Element('textarea');
      const selected = new Element('div'); selected.className = 'pc-selection'; selected.hidden = !selection;
      const model = new Element('div'); model.className = 'pc-model-row';
      const bottom = new Element('div'); bottom.className = 'pc-bottom';
      const footer = new Element('div'); footer.className = 'pc-composer-footer';
      panel.append(new Element('header'), state.log, state.inputArea);
      state.inputArea.append(state.compose, footer); state.compose.append(selected, state.input, model, bottom);
      state.selectionCard = selected;
    }
    return { state, panel, ui: api.mount(plugin, state) };
  }
  function flush() {
    for (let count = 0; count < 10; count++) {
      const pending = [...mutations].filter(o => o.pending);
      if (!pending.length) return;
      for (const observer of pending) { observer.pending = false; observer.fn([]); }
    }
    assert.fail('mutation observer loop');
  }
  return { api, plugin, panel, root, win, doc, prefs, calls, writes, mutations, resizes, flush,
    resize(width) { available = width; for (const observer of [...resizes]) observer.fn([]); flush(); },
    resizeHeight(value) { height = value; for (const observer of [...resizes]) observer.fn([]); flush(); },
    fonts(chat, system) { chatFont = chat; systemFont = system; for (const observer of [...resizes]) observer.fn([]); flush(); } };
}
const drag = (p, dx) => {
  p.ui.handle.fire('pointerdown'); p.ui.handle.fire('pointermove', { clientX: 500 + dx }); p.ui.handle.fire('pointerup');
};
for (const platform of ['mac', 'win']) for (const side of ['left', 'right']) {
  test(`${platform} ${side}: physical inner divider, drag direction, localized accessible native button`, () => {
    const f = fixture({ platform, side }), p = f.panel();
    assert.equal(p.ui.handle.tagName, 'button'); assert.equal(p.ui.handle.type, 'button');
    assert.equal(p.ui.handle.attrs['aria-label'], 'Localized resize');
    assert.deepEqual(f.calls, ['appearance.resizePanel']);
    assert.equal(p.panel.style.position, 'relative');
    assert.equal(p.ui.handle.style[side === 'left' ? 'right' : 'left'], '0px');
    assert.match(p.ui.style.textContent, /position:absolute!important/);
    assert.match(p.ui.style.textContent, /touch-action:none/);
    drag(p, side === 'left' ? 100 : -100);
    assert.equal(p.panel.getBoundingClientRect().width, 470); assert.equal(f.prefs[key], 470);
    assert.equal(p.ui.handle.captured.size, 0); assert.equal(p.ui.drag, null); f.flush();
  });
}
test('clamps to 280 and parent minus 240, including initial saved width and narrow windows', () => {
  const f = fixture({ saved: 2000 }), p = f.panel();
  assert.equal(p.ui.actual, 960);
  drag(p, 2000); assert.equal(p.ui.actual, 280);
  drag(p, -3000); assert.equal(p.ui.actual, 960);
  f.resize(800); assert.equal(p.ui.actual, 560); assert.equal(f.prefs[key], 960);
  f.resize(1200); assert.equal(p.ui.actual, 960);
  f.resize(400); assert.equal(p.ui.actual, 280);
});
for (const zoom of [.75, 1.25, 1.75]) test(`zoom ${zoom}: physical drag delta and font/zoom invariance`, () => {
  const f = fixture({ zoom, saved: 400 }), p = f.panel();
  assert.ok(Math.abs(p.panel.getBoundingClientRect().width - 400) < 1e-9);
  drag(p, -80);
  assert.ok(Math.abs(p.panel.getBoundingClientRect().width - 480) < 1e-9);
  assert.equal(p.panel.style.flexBasis, p.panel.style.width);
  assert.equal(p.panel.style.fontSize, '17px'); assert.equal(p.panel.style.zoom, String(zoom));
  assert.deepEqual(f.writes, [[key, 480]]);
});
test('saved integer width survives cleanup/remount and repeat mount is idempotent', () => {
  const f = fixture(), p = f.panel(); drag(p, -123.4);
  assert.equal(f.prefs[key], 493);
  assert.equal(f.api.mount(f.plugin, p.state), p.ui);
  assert.equal(p.panel.children.length, 2);
  f.api.cleanup(p.state); const q = f.panel(); assert.equal(q.ui.actual, 493);
});
test('order and zoom changes automatically move divider and preserve physical width without observer loop', () => {
  const f = fixture({ saved: 400 }), p = f.panel();
  p.panel.style.order = '-1'; p.panel.style.zoom = '1.75'; f.flush();
  assert.equal(p.ui.side, 'left'); assert.equal(p.ui.handle.style.right, '0px');
  assert.equal(p.ui.handle.style.left, 'auto');
  assert.ok(Math.abs(p.panel.getBoundingClientRect().width - 400) < 1e-9);
  drag(p, 60); assert.equal(p.ui.actual, 460); f.flush();
  p.panel.style.order = '0'; f.flush(); assert.equal(p.ui.side, 'right');
});
test('pointercancel preserves the last visible width and removes the drag layer', () => {
  const f = fixture(), p = f.panel(), h = p.ui.handle;
  h.fire('pointerdown'); h.fire('pointermove', { clientX: 400 });
  assert.equal(p.ui.actual, 470); h.fire('pointercancel');
  assert.equal(p.ui.actual, 470); assert.equal(p.ui.drag, null); assert.equal(h.captured.size, 0);
  assert.equal(f.prefs[key], 470); assert.equal(f.doc.documentElement.children.length, 0);
  drag(p, -20); assert.equal(f.prefs[key], 490);
});
test('ignores secondary pointers and non-primary buttons; blur commits the visible width', () => {
  const f = fixture(), p = f.panel(), h = p.ui.handle;
  for (const props of [{ button: 2 }, { isPrimary: false }]) { h.fire('pointerdown', props); assert.equal(p.ui.drag, null); }
  h.fire('pointerdown'); h.fire('pointermove', { pointerId: 2, clientX: 300 });
  h.fire('pointerup', { pointerId: 2 }); assert.ok(p.ui.drag); assert.equal(p.ui.actual, 370);
  h.fire('pointermove', { clientX: 300 }); f.win.fire('blur'); assert.equal(p.ui.actual, 570);
  assert.equal(f.prefs[key], 570); assert.equal(f.doc.listenerCount, 0);
});
test('keyboard arrows follow physical edge; shift uses larger step and commits', () => {
  for (const side of ['left', 'right']) {
    const f = fixture({ side }), p = f.panel(), h = p.ui.handle;
    const event = h.fire('keydown', { key: side === 'left' ? 'ArrowRight' : 'ArrowLeft' });
    assert.ok(event.prevented && event.stopped); assert.equal(p.ui.actual, 380);
    h.fire('keydown', { key: side === 'left' ? 'ArrowLeft' : 'ArrowRight', shiftKey: true });
    assert.equal(p.ui.actual, 340); assert.equal(f.prefs[key], 340);
  }
});
test('cleanup during drag releases capture, observers, listeners, nodes and restores layout; safe twice', () => {
  const f = fixture(), p = f.panel(), h = p.ui.handle;
  h.fire('pointerdown'); h.fire('pointermove', { clientX: 400 }); f.api.cleanup(p.state); f.api.cleanup(p.state);
  assert.equal(h.captured.size, 0); assert.equal(h.listenerCount, 0); assert.equal(f.win.listenerCount, 0);
  assert.equal(f.mutations.size, 0); assert.equal(f.resizes.size, 0); assert.equal(p.panel.children.length, 0);
  assert.equal(p.panel.style.flexBasis, 'clamp(300px,32vw,440px)'); assert.equal(p.panel.style.width, '370px');
  assert.equal(p.panel.style.position, ''); assert.equal(p.panel.style.zoom, '1'); assert.equal(f.writes.length, 0);
});
test('dispose during drag cleans up and does not save; disposed state cannot mount', () => {
  const f = fixture(), p = f.panel(); p.ui.handle.fire('pointerdown');
  p.state.disposed = true; p.ui.handle.fire('pointermove', { clientX: 300 });
  assert.equal(p.panel.children.length, 0); assert.equal(f.resizes.size, 0);
  assert.equal(f.api.mount(f.plugin, p.state), undefined); assert.equal(f.writes.length, 0);
});
test('bad saved values, preference failures and pointer capture failure are recoverable', () => {
  for (const saved of ['400', NaN, Infinity, -5, 0]) { const f = fixture({ saved }), p = f.panel(); assert.equal(p.ui.actual, 370); }
  const f = fixture({ broken: true }), p = f.panel(); drag(p, -40); assert.equal(p.ui.actual, 410);
  const g = fixture({ captureFails: true }), q = g.panel(); q.ui.handle.fire('pointerdown');
  assert.ok(q.ui.drag); assert.equal(q.ui.actual, 370);
  g.doc.fire('pointermove', { clientX: 400, buttons: 1 });
  g.doc.fire('pointerup', { clientX: 400 });
  assert.equal(q.ui.actual, 470); assert.equal(g.prefs[key], 470); assert.equal(q.ui.drag, null);
});
test('window resize fallback works without ResizeObserver', () => {
  const f = fixture(); delete f.win.ResizeObserver; const p = f.panel(); drag(p, -400);
  f.resize(700); f.win.fire('resize'); assert.equal(p.ui.actual, 460);
});
test('side change commits current width before accepting the new drag direction', () => {
  const f = fixture({ saved: 400 }), p = f.panel(), h = p.ui.handle;
  h.fire('pointerdown'); h.fire('pointermove', { clientX: 450 });
  p.panel.style.order = '-1'; f.flush();
  assert.equal(p.ui.actual, 450); assert.equal(h.captured.size, 0); assert.equal(p.ui.drag, null);
  assert.equal(f.prefs[key], 450); drag(p, 80); assert.equal(f.prefs[key], 530);
});

for (const side of ['left', 'right']) test(`${side}: sustained document moves survive capture loss, relayout and reversals`, () => {
  const f = fixture({ side, zoom: 1.25, saved: 400 }), p = f.panel(), h = p.ui.handle;
  h.fire('pointerdown');
  assert.equal(f.doc.documentElement.children.length, 1);
  const direction = side === 'left' ? 1 : -1;
  for (let step = 1; step <= 30; step++) {
    if (step === 5) h.fire('lostpointercapture');
    if (step === 10) f.win.fire('resize');
    f.doc.fire('pointermove', { clientX: 500 + direction * step * 4, buttons: 1 });
    f.flush();
    assert.ok(p.ui.drag); assert.equal(p.ui.actual, 400 + step * 4);
  }
  for (let step = 30; step >= 10; step--) {
    f.doc.fire('pointermove', { clientX: 500 + direction * step * 4, buttons: 1 });
    f.resize(1200); assert.equal(p.ui.actual, 400 + step * 4); assert.ok(p.ui.drag);
  }
  f.doc.fire('pointerup');
  assert.equal(f.prefs[key], 440); assert.equal(f.doc.listenerCount, 0);
  assert.equal(f.doc.documentElement.children.length, 0);
  assert.equal(p.panel.style.fontSize, '17px'); assert.equal(p.panel.style.zoom, '1.25');
  drag(p, direction * 20); assert.equal(f.prefs[key], 460);
});

test('mouse fallback, Escape cancellation and release outside the window clean up the overlay', () => {
  const f = fixture({ saved: 400 }), p = f.panel(), h = p.ui.handle;
  h.fire('mousedown'); f.doc.fire('mousemove', { clientX: 450, buttons: 1 });
  f.doc.fire('mouseup'); assert.equal(f.prefs[key], 450); assert.equal(f.doc.listenerCount, 0);
  h.fire('pointerdown'); f.doc.fire('pointermove', { clientX: 420, buttons: 1 });
  f.doc.fire('keydown', { key: 'Escape' }); assert.equal(p.ui.actual, 450); assert.equal(f.prefs[key], 450);
  h.fire('pointerdown'); f.doc.fire('pointermove', { clientX: 470, buttons: 1 });
  f.doc.fire('pointermove', { clientX: 470, buttons: 0 });
  assert.equal(f.prefs[key], 480); assert.equal(f.doc.documentElement.children.length, 0);
});

test('ResizeObserver cannot mask a side change before MutationObserver delivery', () => {
  const f = fixture({ saved: 400 }), p = f.panel(), h = p.ui.handle;
  h.fire('pointerdown'); h.fire('pointermove', { clientX: 450 });
  p.panel.style.order = '-1'; f.resize(1200);
  assert.equal(p.ui.drag, null); assert.equal(p.ui.actual, 450); assert.equal(p.ui.side, 'left');
  assert.equal(f.doc.documentElement.children.length, 0);
});
test('same state can mount again after cleanup; preserves other appearance styles', () => {
  const f = fixture({ zoom: 1.25 }), p = f.panel(); drag(p, -50);
  p.panel.style.fontSize = '20px'; f.api.cleanup(p.state);
  const ui = f.api.mount(f.plugin, p.state);
  assert.notEqual(ui, p.ui); assert.equal(ui.actual, 513);
  assert.equal(p.panel.style.fontSize, '20px'); assert.equal(p.panel.style.zoom, '1.25');
  assert.equal(p.panel.children.length, 2); f.flush();
});


const composerKey = 'extensions.paper-chat.composerHeight';
for (const platform of ['mac', 'win']) test(`${platform}: composer drag and keyboard resize keep fonts, restore saved height and expose a thin visual line`, () => {
  const f = fixture({ platform, composer: true, savedHeight: 300 }), p = f.panel(), c = p.ui.composer;
  assert.ok(c); assert.equal(c.handle.type, 'button'); assert.equal(c.actual, 300);
  assert.equal(c.handle.attrs['aria-label'], 'Localized resize');
  assert.equal(c.area.parentElement, p.panel);
  c.handle.fire('pointerdown');
  f.doc.fire('pointermove', { clientY: 350, buttons: 1 });
  assert.equal(c.actual, 350); assert.equal(c.area.style.height, '350px');
  assert.match(f.doc.documentElement.children[0].style.cssText, /row-resize/);
  f.doc.fire('pointerup'); assert.equal(f.prefs[composerKey], 350);
  c.handle.fire('keydown', { key: 'ArrowDown' }); assert.equal(c.actual, 340);
  c.handle.fire('keydown', { key: 'ArrowUp', shiftKey: true }); assert.equal(c.actual, 380);
  assert.equal(p.panel.style.fontSize, '17px'); assert.equal(p.panel.style.zoom, '1');
  assert.match(p.ui.style.textContent, /width:16px!important/);
  assert.match(p.ui.style.textContent, /height:12px!important/);
  assert.match(p.ui.style.textContent, /height:1px/);
  assert.match(p.ui.style.textContent, /width:1px/);
  assert.match(p.ui.style.textContent, /height:2px/);
  assert.match(p.ui.style.textContent, /width:2px/);
  assert.match(p.ui.style.textContent, /:hover[^}]*background:transparent!important/);
  f.api.cleanup(p.state);
  assert.equal(f.doc.listenerCount, 0); assert.equal(c.handle.parentElement, null);
  const q = f.panel(); assert.equal(q.ui.composer.actual, 380);
});

for (const zoom of [.75, 1.25, 1.75]) test(`composer zoom ${zoom} converts pointer deltas to layout pixels`, () => {
  const f = fixture({ composer: true, savedHeight: 300, zoom }), p = f.panel(), c = p.ui.composer;
  c.handle.fire('pointerdown');
  f.doc.fire('pointermove', { clientY: 400 - 60 * zoom, buttons: 1 });
  assert.ok(Math.abs(c.actual - 360) < 1e-9);
  f.doc.fire('pointerup'); assert.equal(f.prefs[composerKey], 360);
  assert.equal(p.panel.style.zoom, String(zoom));
});

test('composer dynamic content floor grows for both fonts and selected excerpts, and clamps extreme downward drags', () => {
  const f = fixture({ composer: true, savedHeight: 10 }), p = f.panel(), c = p.ui.composer;
  const small = c.minimum; assert.equal(c.actual, small);
  assert.ok(small > 150); assert.ok(c.minimum <= c.maximum);
  f.fonts(24, 24); const big = c.minimum;
  assert.ok(big > small + 70); assert.equal(c.actual, big);
  p.state.selectionCard.hidden = false; f.resize(1200);
  assert.ok(c.minimum > big + 90); assert.equal(c.actual, c.minimum);
  c.handle.fire('pointerdown');
  f.doc.fire('pointermove', { clientY: 2000, buttons: 1 });
  assert.equal(c.actual, c.minimum); f.doc.fire('pointerup');
  assert.equal(f.prefs[composerKey], c.minimum);
  p.state.selectionCard.hidden = true; f.resize(1200);
  assert.ok(c.minimum < f.prefs[composerKey]);
});

test('very short windows cap composer at available height and can recover without losing the requested height', () => {
  const f = fixture({ composer: true, savedHeight: 400, height: 800, chatFont: 24, systemFont: 24, selection: true });
  const p = f.panel(), c = p.ui.composer;
  assert.ok(c.minimum < c.maximum); assert.equal(c.actual, c.minimum);
  f.resizeHeight(280);
  assert.ok(c.actual < c.minimum); assert.equal(c.actual, c.maximum);
  assert.ok(c.actual >= 0 && c.actual < 280);
  f.resizeHeight(800); assert.equal(c.actual, c.minimum);
});

test('composer capture-loss fallback, Escape, blur, wrong pointer and teardown work independently of sidebar width', () => {
  const f = fixture({ composer: true, captureFails: true, saved: 400, savedHeight: 300 }), p = f.panel(), c = p.ui.composer;
  c.handle.fire('pointerdown'); c.handle.fire('lostpointercapture');
  f.doc.fire('pointermove', { clientY: 300, pointerId: 2, buttons: 1 }); assert.equal(c.actual, 300);
  f.doc.fire('pointermove', { clientY: 350, buttons: 1 }); assert.equal(c.actual, 350);
  f.doc.fire('keydown', { key: 'Escape' }); assert.equal(c.actual, 300); assert.equal(f.prefs[composerKey], 300);
  c.handle.fire('mousedown'); f.doc.fire('mousemove', { clientY: 370, buttons: 1 }); f.win.fire('blur');
  assert.equal(f.prefs[composerKey], 330); assert.equal(f.prefs[key], 400);
  c.handle.fire('pointerdown'); f.api.cleanup(p.state);
  assert.equal(c.area.style.height, undefined); assert.equal(f.doc.listenerCount, 0);
  assert.equal(f.doc.documentElement.children.length, 0); assert.equal(f.mutations.size, 0); assert.equal(f.resizes.size, 0);
});

test('composer height still adjusts without ResizeObserver and invalid persisted heights use the content floor', () => {
  for (const savedHeight of [0, -3, '330', NaN, Infinity]) {
    const f = fixture({ composer: true, savedHeight }); delete f.win.ResizeObserver;
    const p = f.panel(), c = p.ui.composer;
    assert.ok(c.actual >= c.minimum); assert.ok(c.actual <= c.maximum);
    f.resizeHeight(320); f.win.fire('resize'); assert.ok(c.actual <= c.maximum);
  }
});


test('Home restores default composer height and native initial sidebar width, bounded by content and window size', () => {
  const f = fixture({ composer: true, saved: 600, savedHeight: 420, zoom: 1.25 }), p = f.panel(), c = p.ui.composer;
  const xEvent = p.ui.handle.fire('keydown', { key: 'Home' });
  const yEvent = c.handle.fire('keydown', { key: 'Home' });
  assert.ok(xEvent.prevented && xEvent.stopped && yEvent.prevented && yEvent.stopped);
  assert.equal(p.ui.actual, Math.round(370 * 1.25)); assert.equal(f.prefs[key], Math.round(370 * 1.25));
  assert.equal(c.actual, Math.max(240, c.minimum)); assert.equal(f.prefs[composerKey], c.actual);
  f.fonts(24, 24); c.handle.fire('keydown', { key: 'Home' });
  assert.equal(c.actual, c.minimum); assert.ok(c.minimum > 240);
  c.handle.fire('pointerdown'); f.doc.fire('pointermove', { clientY: 300, buttons: 1 });
  c.handle.fire('keydown', { key: 'Home' });
  assert.equal(p.ui.drag, null); assert.equal(f.doc.listenerCount, 0);
  assert.equal(f.doc.documentElement.children.length, 0); assert.equal(c.actual, c.minimum);
});

test('composer minimum is independent of requested height and excludes hidden or visible out-of-flow menus', () => {
  const f = fixture({ composer: true, savedHeight: 300 }), p = f.panel(), c = p.ui.composer;
  const minimum = c.minimum;
  c.handle.fire('keydown', { key: 'ArrowUp', shiftKey: true });
  assert.equal(c.minimum, minimum);
  const menu = f.doc.createElementNS('', 'div'); menu.style.position = 'absolute';
  menu.getBoundingClientRect = () => ({ width: 300, height: 1200 });
  c.compose.append(menu); f.api.apply(f.plugin, p.state); assert.equal(c.minimum, minimum);
  c.area.append(menu); f.api.apply(f.plugin, p.state); assert.equal(c.minimum, minimum);
  menu.style.position = 'fixed'; f.api.apply(f.plugin, p.state); assert.equal(c.minimum, minimum);
  menu.style.position = 'relative'; menu.hidden = true;
  f.api.apply(f.plugin, p.state); assert.equal(c.minimum, minimum);
  menu.hidden = false; f.api.apply(f.plugin, p.state); assert.ok(c.minimum > minimum + 900);
});
