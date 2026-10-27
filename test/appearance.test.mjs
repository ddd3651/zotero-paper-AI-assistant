import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../addon/appearance.js', import.meta.url), 'utf8');
class Element {
  constructor(tag, doc) {
    this.tag = tag; this.ownerDocument = doc; this.children = []; this.attrs = {};
    this.events = new Map(); this.value = ''; this.scrollTop = 0; this.scrollLeft = 0;
    this.style = { setProperty(key, value) { this[key] = value; } };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  insertBefore(node, before) { node.parent = this; this.children.splice(this.children.indexOf(before), 0, node); }
  get lastElementChild() { return this.children.at(-1); }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(type, handler, options) {
    const handlers = this.events.get(type) || []; handlers.push({ handler, options }); this.events.set(type, handlers);
  }
  removeEventListener(type, handler) {
    const handlers = (this.events.get(type) || []).filter(entry => entry.handler !== handler);
    if (handlers.length) this.events.set(type, handlers); else this.events.delete(type);
  }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? all : all.filter(child => selector.split(',')
      .some(part => (child.className || '').split(/\s+/).includes(part.slice(1))));
  }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  fire(type, extra = {}) {
    const event = { prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (const { handler } of this.events.get(type) || []) handler(event);
    return event;
  }
}
function fixture(saved = {}, broken = false) {
  const prefs = { ...saved }, calls = [];
  const scope = createUIContext({ Zotero: { Prefs: {
    get(key, raw) { calls.push(['get', key, raw]); if (broken) throw Error('unavailable'); return prefs[key]; },
    set(key, value, raw) {
      calls.push(['set', key, value, raw]); if (broken) throw Error('unavailable');
      // Zotero numeric prefs use integer storage; floats must be strings.
      if (typeof value === 'number') assert.ok(Number.isInteger(value));
      prefs[key] = value;
    },
  } } });
  vm.runInContext(source, scope);
  const api = scope.PaperChatAppearance, plugin = { states: new Map() };
  const doc = { createElementNS: (_, tag) => new Element(tag, doc) };
  function panel() {
    const root = new Element('root', doc), reader = new Element('iframe', doc);
    reader.style.order = '0';
    const state = { panel: new Element('aside', doc), log: new Element('div', doc) };
    const head = new Element('div', doc), title = new Element('div', doc), close = new Element('button', doc);
    title.append(new Element('span', doc), close); head.append(title); state.panel.append(head, state.log);
    root.append(reader, state.panel); plugin.states.set(reader, state);
    const ui = api.mount(plugin, state, { head, title });
    return { state, head, title, close, root, reader, ui };
  }
  return { api, plugin, prefs, calls, panel };
}
const key = name => 'extensions.paper-chat.' + name;
const input = (el, value, type = 'input') => { el.value = value; return el.fire(type); };

test('mount defaults, compact controls, scoped styles and repeated mount are stable', () => {
  const f = fixture(), p = f.panel();
  assert.equal(p.state.panel.style.fontSize, '13px');
  assert.equal(p.state.panel.style['--pc-font-size'], '13px');
  assert.equal(p.state.panel.style.order, '1');
  assert.equal(p.ui.sideButton.textContent, '移到左侧');
  assert.equal(p.title.children.at(-2), p.ui.sideButton);
  assert.equal(p.title.lastElementChild, p.close);
  assert.equal(p.ui.fontInput.type, 'number'); assert.equal(p.ui.fontRange.type, 'range');
  assert.equal(p.ui.fontInput.attrs['aria-label'], '插件字号');
  assert.equal(p.ui.fontRange.attrs['aria-label'], '插件字号滑块');
  assert.equal(p.ui.fontInput.min, '11'); assert.equal(p.ui.fontInput.max, '24');
  assert.equal(p.ui.fontInput.step, '1');
  assert.equal(f.api.mount(f.plugin, p.state, p), p.ui);
  assert.equal(p.state.panel.children.filter(node => node.tag === 'style').length, 1);
  for (const selector of ['.pc-title', '.pc-message', '.pc-markdown table', '.pc-cite', '.pc-prompt-input', '.pc-settings-menu label'])
    assert.ok(p.ui.style.textContent.includes(selector));
  assert.match(p.ui.style.textContent, /font-size:calc\(var\(--pc-font-size\)/);
  assert.ok(p.ui.row.fire('keydown').stopped); assert.ok(p.ui.sideButton.fire('keydown').stopped);
});

test('number and slider sync immediately across all panels, retaining rendered answers and scroll', () => {
  const f = fixture(), a = f.panel(), b = f.panel();
  const answer = new Element('article', a.state.panel.ownerDocument); a.state.log.append(answer);
  a.state.log.scrollTop = 157; a.state.log.scrollLeft = 19; answer.scrollTop = 8;
  input(a.ui.fontInput, '19');
  for (const p of [a, b]) {
    assert.equal(p.ui.fontInput.value, '19'); assert.equal(p.ui.fontRange.value, '19');
    assert.equal(p.state.panel.style.fontSize, '19px');
  }
  assert.equal(a.state.log.scrollTop, 157); assert.equal(a.state.log.scrollLeft, 19);
  assert.equal(a.state.log.children[0], answer); assert.equal(answer.scrollTop, 8);
  input(b.ui.fontRange, '23'); assert.equal(a.ui.fontInput.value, '23');
  assert.equal(f.prefs[key('fontSize')], 23);
  assert.ok(f.calls.every(call => call.at(-1) === true));
});

test('unfinished/invalid numbers remain editable, then blur/change correct and clamp', () => {
  const f = fixture(), p = f.panel();
  input(p.ui.fontInput, '17');
  for (const value of ['', '-', 'abc', 'NaN', 'Infinity']) {
    input(p.ui.fontInput, value); assert.equal(p.ui.fontInput.value, value);
    assert.equal(p.state.panel.style.fontSize, '17px');
    p.ui.fontInput.fire('blur'); assert.equal(p.ui.fontInput.value, '17');
  }
  for (const [value, expected] of [['2', '11'], ['999', '24'], ['15.6', '16']]) {
    input(p.ui.fontInput, value); assert.equal(p.ui.fontInput.value, value);
    p.ui.fontInput.fire('change'); assert.equal(p.ui.fontInput.value, expected);
    assert.equal(p.ui.fontRange.value, expected);
  }
});

test('pinch only reads and restores designated scroll containers', () => {
  const f = fixture(), p = f.panel(), containers = [];
  for (const className of ['pc-table-scroll', 'pc-settings-menu', 'pc-selection-text']) {
    const node = new Element('div', p.state.panel.ownerDocument); node.className = className;
    p.state.log.append(node); containers.push(node);
  }
  const answer = new Element('p', p.state.panel.ownerDocument); p.state.log.append(answer);
  for (const prop of ['scrollTop', 'scrollLeft']) Object.defineProperty(answer, prop, {
    get() { assert.fail('must not read ordinary answer scroll offsets'); },
    set() { assert.fail('must not write ordinary answer scroll offsets'); },
  });
  const writes = [];
  for (const [index, node] of [p.state.panel, p.state.log, ...containers].entries()) {
    for (const prop of ['scrollTop', 'scrollLeft']) Object.defineProperty(node, prop, {
      get() { return index * 10; }, set(value) { writes.push([index, prop, value]); },
    });
  }
  const query = p.state.panel.querySelectorAll.bind(p.state.panel);
  p.state.panel.querySelectorAll = selector => {
    assert.equal(selector, '.pc-table-scroll,.pc-settings-menu,.pc-selection-text');
    return query(selector);
  };
  p.state.panel.fire('wheel', { ctrlKey: true, deltaY: -20 });
  assert.equal(writes.length, 10);
  assert.ok(writes.every(([index, , value]) => value === index * 10));
});

test('side switches use order and opposing border, persist to fresh plugin without moving reader', () => {
  const f = fixture(), a = f.panel(), b = f.panel();
  a.ui.sideButton.fire('click');
  for (const p of [a, b]) {
    assert.equal(p.state.panel.style.order, '-1'); assert.equal(p.reader.style.order, '0');
    assert.equal(p.state.panel.style.borderLeft, 'none'); assert.equal(p.state.panel.style.borderRight, '1px solid #ccc');
    assert.equal(p.ui.sideButton.textContent, '移到右侧');
    assert.deepEqual(p.root.children, [p.reader, p.state.panel]);
  }
  assert.equal(f.prefs[key('side')], 'left');
  const fresh = fixture(f.prefs).panel(); assert.equal(fresh.state.panel.style.order, '-1');
  b.ui.sideButton.fire('click'); assert.equal(a.state.panel.style.order, '1');
  assert.equal(a.state.panel.style.borderRight, 'none');
});

test('preferences tolerate exceptions and corrupt values; valid saved settings are normalized', () => {
  for (const value of [undefined, null, '', {}, false, 'bad', Infinity]) {
    const f = fixture({ [key('fontSize')]: value, [key('uiZoom')]: value, [key('side')]: value });
    const p = f.panel(); assert.equal(p.ui.fontInput.value, '13'); assert.equal(p.state.panel.style.zoom, '1');
    assert.equal(p.state.panel.style.order, '1');
  }
  const f = fixture({}, true), p = f.panel();
  input(p.ui.fontRange, '21'); assert.equal(p.state.panel.style.fontSize, '21px');
  const saved = fixture({ [key('fontSize')]: '18.7', [key('side')]: 'left', [key('uiZoom')]: '1.25' }).panel();
  assert.equal(saved.ui.fontInput.value, '19'); assert.equal(saved.state.panel.style.zoom, '1.25');
});

test('ctrl wheel pinch zooms only panel, syncs/persists, clamps and resets without changing font', () => {
  const f = fixture(), a = f.panel(), b = f.panel();
  input(a.ui.fontInput, '18');
  const ordinary = a.state.panel.fire('wheel', { ctrlKey: false, deltaY: 100 });
  assert.equal(ordinary.prevented, false); assert.equal(ordinary.stopped, false);
  assert.equal(a.state.panel.style.zoom, '1');
  const pinch = a.state.panel.fire('wheel', { ctrlKey: true, deltaY: -50 });
  assert.ok(pinch.prevented && pinch.stopped);
  assert.equal(Number(a.state.panel.style.zoom), Math.exp(.15));
  assert.equal(b.state.panel.style.zoom, a.state.panel.style.zoom);
  assert.equal(f.prefs[key('uiZoom')], String(Math.exp(.15)));
  assert.equal(fixture(f.prefs).panel().state.panel.style.zoom, String(Math.exp(.15)));
  assert.equal(a.reader.style.zoom, undefined); assert.equal(a.ui.fontInput.value, '18');
  assert.equal(a.state.panel.events.get('wheel')[0].options.passive, false);
  a.state.panel.fire('wheel', { ctrlKey: true, deltaY: -1000000 });
  assert.equal(a.state.panel.style.zoom, '1.75');
  a.state.panel.fire('wheel', { ctrlKey: true, deltaY: 1000000 });
  assert.equal(a.state.panel.style.zoom, '0.75');
  a.ui.zoomButton.fire('click');
  assert.equal(a.state.panel.style.zoom, '1'); assert.equal(b.ui.zoomButton.textContent, '界面 100%');
  assert.equal(a.state.panel.style['--pc-ui-zoom'], '1');
  assert.equal(fixture(f.prefs).panel().state.panel.style.zoom, '1');
});

test('Gecko and gesture events zoom, and alternate event streams do not double apply', () => {
  const f = fixture(), p = f.panel();
  p.state.panel.fire('MozMagnifyGestureStart');
  p.state.panel.fire('MozMagnifyGestureUpdate', { delta: 30 });
  const magnified = p.state.panel.style.zoom;
  assert.equal(Number(magnified), Math.exp(.09));
  p.state.panel.fire('MozMagnifyGesture', { delta: 30 }); assert.equal(p.state.panel.style.zoom, magnified);
  p.state.panel.fire('wheel', { ctrlKey: true, deltaY: -30 }); assert.equal(p.state.panel.style.zoom, magnified);
  const other = fixture(), q = other.panel();
  q.state.panel.fire('gesturestart'); q.state.panel.fire('gesturechange', { scale: 1.4 });
  assert.equal(q.state.panel.style.zoom, '1.4');
  q.state.panel.fire('gesturechange', { scale: 1.5 }); assert.equal(q.state.panel.style.zoom, '1.5');
  assert.ok(q.state.panel.fire('gestureend').prevented);
});

test('cleanup and stop release every listener, allow remount and skip disposed states', () => {
  const f = fixture(), a = f.panel(), b = f.panel();
  f.api.cleanup(a.state); f.api.cleanup(a.state);
  assert.equal(a.state.panel.events.size, 0); assert.equal(a.ui.fontInput.events.size, 0);
  const event = a.state.panel.fire('wheel', { ctrlKey: true, deltaY: -20 }); assert.equal(event.prevented, false);
  assert.equal(a.ui.row.events.size, 0); assert.equal(a.ui.sideButton.events.size, 0);
  a.state.disposed = true; f.api.set(f.plugin, { fontSize: 20 });
  assert.equal(a.state.panel.style.fontSize, '13px'); assert.equal(b.ui.fontInput.value, '20');
  f.api.stop(f.plugin); assert.equal(b.state.panel.events.size, 0);
  assert.equal(b.state.panel.children.filter(node => node.tag === 'style').length, 0);
  const ui = f.api.mount(f.plugin, b.state, b); assert.equal(ui.fontInput.value, '20');
  f.api.stop(f.plugin);
});
