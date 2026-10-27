import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../addon/selection.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const annotation = (text = '选中的原文', pageIndex = 2) => ({ text, position: { pageIndex, rects: [[1, 2, 3, 4]] } });
class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.events = new Map(); this.removed = false; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); }
  remove() { this.removed = true; }
  fire(name) {
    const event = { prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    this.events.get(name)?.(event);
    return event;
  }
}
function setup() {
  const registrations = [], unregistrations = [], captures = [], errors = [];
  const Reader = {
    registerEventListener(...args) { registrations.push(args); },
    unregisterEventListener(...args) { unregistrations.push(args); },
  };
  const scope = createUIContext({ Zotero: { Reader, logError: error => errors.push(error) } });
  vm.runInContext(source, scope);
  const api = scope.PaperChatSelection;
  const plugin = { id: 'paper-chat@test', captureSelection(...args) { captures.push(args); },
    ask() { assert.fail('selecting text must not send an AI question'); },
    api() { assert.fail('selecting text must not access the bridge'); } };
  const reader = { _type: 'pdf', _internalReader: { _primaryView: {} } };
  const doc = { createElement: tag => new Element(tag) };
  const render = (value = annotation(), target = reader) => {
    const nodes = [];
    registrations.at(-1)[1]({ reader: target, doc, params: { annotation: value }, append: node => nodes.push(node) });
    return nodes;
  };
  api.start(plugin);
  return { api, plugin, reader, registrations, unregistrations, captures, errors, render, scope, Reader };
}

test('start is idempotent, uses the official event and plugin ID, and stop removes nodes/listeners', () => {
  const f = setup();
  f.api.start(f.plugin);
  assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0][0], 'renderTextSelectionPopup');
  assert.equal(f.registrations[0][2], f.plugin.id);
  const [button] = f.render();
  const oldListener = f.registrations[0][1];
  f.api.stop(); f.api.stop();
  assert.deepEqual(f.unregistrations, [['renderTextSelectionPopup', oldListener]]);
  assert.equal(button.removed, true);
  assert.equal(button.events.size, 0);
  button.fire('click');
  oldListener({ reader: f.reader });
  assert.equal(f.captures.length, 0);
  f.api.start(f.plugin);
  assert.equal(f.registrations.length, 2);
  oldListener({ reader: f.reader });
  assert.equal(f.captures.length, 0);
  f.render();
  assert.equal(f.captures.length, 0);
});

test('selection only offers a button; clicking stages the exact detached snapshot with focus=true', () => {
  const f = setup();
  const value = annotation('  原文\n第二行 <script>  ');
  const [button] = f.render(value);
  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '向AI提问');
  assert.equal(f.captures.length, 0);
  const original = structuredClone(value);
  // A focus change may clear the live selection. The button still stages its original context.
  value.position.rects[0][0] = 999;
  f.reader._internalReader._primaryView._selectionPopup = null;
  assert.equal(button.fire('mousedown').prevented, true);
  const click = button.fire('click');
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0][0], f.reader);
  assert.deepEqual(plain(f.captures[0][1]), { text: original.text, page: 3, position: original.position });
  assert.equal(Object.getPrototypeOf(f.captures[0][1].position), vm.runInContext('Object.prototype', f.scope));
  assert.equal(Object.getPrototypeOf(f.captures[0][1].position.rects), vm.runInContext('Array.prototype', f.scope));
  assert.equal(Object.getPrototypeOf(f.captures[0][1].position.rects[0]), vm.runInContext('Array.prototype', f.scope));
  assert.equal(f.captures[0][2], true);
  assert.deepEqual(plain(f.captures[0][1].position.rects), [[1, 2, 3, 4]]);
});

test('rerendering replaces a previous button and an empty selection removes it', () => {
  const f = setup();
  const [first] = f.render();
  const [second] = f.render(annotation('新的选区'));
  assert.equal(first.removed, true); assert.equal(first.events.size, 0);
  first.fire('click');
  assert.equal(f.captures.length, 0);
  second.fire('click');
  assert.equal(f.captures.at(-1)[1].text, '新的选区');
  assert.deepEqual(f.render(annotation(' \n\t')), []);
  assert.equal(second.removed, true);
  for (const empty of [null, {}, annotation(''), annotation(42), annotation('text', -1), annotation('text', 1.5)]) {
    assert.deepEqual(f.render(empty), []);
  }
  assert.equal(f.captures.length, 1);
});

test('only PDF readers participate and independent readers keep independent buttons', () => {
  const f = setup();
  const [first] = f.render();
  const other = { _type: 'pdf' };
  const [second] = f.render(annotation('另一个 PDF'), other);
  assert.equal(first.removed, false);
  assert.deepEqual(f.render(annotation(), { _type: 'epub' }), []);
  assert.equal(f.api.read({ _type: 'epub' }), null);
  second.fire('click');
  assert.equal(f.captures.at(-1)[0], other);
  f.reader._instanceID = 'chrome-reader';
  f.Reader._readers = [f.reader, other];
  f.render(annotation(), vm.runInNewContext('({ _type: "pdf", _instanceID: "chrome-reader" })'))[0].fire('click');
  assert.equal(f.captures.at(-1)[0], f.reader);
  f.api.stop();
  assert.equal(first.removed, true); assert.equal(second.removed, true);
});

test('30000 code units pass unchanged; longer selections throw or display an explicit warning', () => {
  const f = setup();
  const view = f.reader._internalReader._primaryView;
  for (const text of ['x'.repeat(30000), '😀'.repeat(15000)]) {
    view._selectionPopup = { annotation: annotation(text) };
    assert.equal(f.api.read(f.reader).text, text);
    f.render(annotation(text))[0].fire('click');
    assert.equal(f.captures.at(-1)[1].text, text);
  }
  view._selectionPopup.annotation.text += 'x';
  assert.throws(() => f.api.read(f.reader), { name: 'RangeError', message: /30001.*30000.*缩小选区/ });
  const before = f.captures.length;
  const [notice] = f.render(view._selectionPopup.annotation);
  assert.equal(notice.attrs.role, 'alert');
  assert.match(notice.textContent, /30001.*30000.*缩小选区/);
  assert.equal(f.captures.length, before);
  const [replacement] = f.render(annotation('恢复正常'));
  assert.equal(notice.removed, true);
  f.api.stop(); assert.equal(replacement.removed, true);
});

test('read returns a detached popup selection with an inclusive two-page range', () => {
  const f = setup();
  const value = annotation(); value.position.nextPageRects = [[5, 6, 7, 8]];
  f.reader._internalReader._primaryView._selectionPopup = { annotation: value };
  const result = f.api.read(f.reader);
  assert.deepEqual(plain(result), { ...value, page: 3, pages: [3, 4] });
  result.position.nextPageRects[0][0] = 0;
  assert.equal(value.position.nextPageRects[0][0], 5);
  assert.deepEqual(plain(f.render(value)[0].tag), 'button');
  f.render(value)[0].fire('click');
  assert.deepEqual(plain(f.captures[0][1].pages), [3, 4]);
});

test('read derives fallback text without invoking a content helper or mutating ranges', () => {
  const f = setup();
  const ranges = [{ text: '第一页', position: annotation().position }, { text: '第二页', position: annotation('', 3).position }];
  const original = structuredClone(ranges);
  f.reader._internalReader._primaryView = {
    _selectionRanges: ranges,
    _getAnnotationFromSelectionRanges() { assert.fail('must not pass bootstrap objects to a content helper'); },
    _onAddAnnotation() { assert.fail('must not persist an annotation'); },
  };
  const result = f.api.read(f.reader);
  assert.equal(result.text, '第一页 第二页');
  assert.deepEqual(plain(result.pages), [3, 4]);
  assert.deepEqual(ranges, original);
});

test('missing, empty and collapsed selections return null without calling the helper', () => {
  const f = setup();
  for (const reader of [null, {}, { _internalReader: {} }, f.reader]) assert.equal(f.api.read(reader), null);
  for (const ranges of [[], [{ collapsed: true }]]) {
    f.reader._internalReader._primaryView = { _selectionRanges: ranges,
      _getAnnotationFromSelectionRanges() { assert.fail('no active ranges'); } };
    assert.equal(f.api.read(f.reader), null);
  }
  f.reader._internalReader._primaryView = { _selectionPopup: { annotation: annotation(' \n ') } };
  assert.equal(f.api.read(f.reader), null);
});

function multiPageView(texts = ['第一页', '第二页', '第三页']) {
  const ranges = texts.map((text, index) => ({ text, pageIndex: index + 2, position: annotation('', index + 2).position }));
  const preview = annotation(texts.slice(0, 2).join(' '));
  preview.position.nextPageRects = ranges[1].position.rects;
  return { _selectionRanges: ranges, _selectionPopup: { annotation: preview } };
}

test('selections spanning more than two pages preserve all text in read and matching popup events', () => {
  const f = setup();
  const view = multiPageView();
  f.reader._internalReader._primaryView = view;
  const original = structuredClone(view);
  const result = f.api.read(f.reader);
  assert.equal(result.text, '第一页\n第二页\n第三页');
  assert.deepEqual(plain(result.pages), [3, 5]);
  f.render(structuredClone(view._selectionPopup.annotation))[0].fire('click');
  assert.deepEqual(plain(f.captures[0][1]), plain(result));
  assert.deepEqual(view, original);
  view._selectionRanges.reverse();
  assert.equal(f.api.read(f.reader).text, result.text);
});

test('full cross-page text is checked for overflow even when the two-page preview fits', () => {
  const f = setup();
  const view = multiPageView(['a'.repeat(10000), 'b'.repeat(10000), 'c'.repeat(10000)]);
  f.reader._internalReader._primaryView = view;
  assert.throws(() => f.api.read(f.reader), /30002.*30000/);
  const [notice] = f.render(view._selectionPopup.annotation);
  assert.equal(notice.attrs.role, 'alert');
  assert.match(notice.textContent, /30002.*30000/);
  assert.equal(f.captures.length, 0);
  f.api.stop();
  assert.equal(notice.removed, true);
});

test('an event still reads all selected pages before the view has stored its popup', () => {
  const f = setup();
  const view = multiPageView();
  const value = view._selectionPopup.annotation;
  delete view._selectionPopup;
  f.reader._internalReader._primaryView = view;
  f.render(value)[0].fire('click');
  assert.equal(f.captures[0][1].text, '第一页\n第二页\n第三页');
  assert.deepEqual(plain(f.captures[0][1].pages), [3, 5]);
});

test('an incomplete cross-page selection fails visibly instead of sending a partial preview', () => {
  const f = setup();
  const view = multiPageView();
  delete view._selectionRanges[2].text;
  f.reader._internalReader._primaryView = view;
  assert.throws(() => f.api.read(f.reader), /无法完整读取跨页选区/);
  const [notice] = f.render(view._selectionPopup.annotation);
  assert.match(notice.textContent, /无法完整读取跨页选区/);
  assert.equal(f.captures.length, 0);
});

test('an event uses its own pane, not an unrelated primary selection', () => {
  const f = setup();
  f.reader._internalReader._primaryView = multiPageView();
  const secondary = multiPageView(['A', 'B', 'C']);
  f.reader._internalReader._secondaryView = secondary;
  f.render(secondary._selectionPopup.annotation)[0].fire('click');
  assert.equal(f.captures[0][1].text, 'A\nB\nC');
  f.render(annotation('独立的事件选区', 8))[0].fire('click');
  assert.equal(f.captures[1][1].text, '独立的事件选区');
  assert.equal(f.captures[1][1].page, 9);
});

test('switching plugins detaches the old callback and nodes', () => {
  const f = setup();
  const [old] = f.render();
  const captures = [];
  f.api.start({ id: 'replacement@test', captureSelection: (...args) => captures.push(args) });
  assert.equal(f.unregistrations.length, 1); assert.equal(old.removed, true);
  const [replacement] = f.render();
  assert.equal(captures.length, 0); assert.equal(f.captures.length, 0);
  replacement.fire('click');
  assert.equal(captures.length, 1); assert.equal(f.captures.length, 0);
  assert.throws(() => f.api.start({}), /captureSelection/);
});

test('capture failures stay visible and asynchronous callbacks do not leak rejections', async () => {
  const f = setup();
  f.plugin.captureSelection = () => { throw new Error('无法加入选区'); };
  const [first] = f.render();
  assert.equal(f.errors.length, 0);
  first.fire('click');
  assert.equal(first.attrs.role, 'alert'); assert.equal(first.textContent, '无法加入选区');
  assert.match(f.errors[0].stack, /无法加入选区/);
  f.plugin.captureSelection = () => Promise.reject(new Error('异步失败'));
  const [second] = f.render();
  second.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.textContent, '异步失败'); assert.equal(f.errors.length, 2);
});

test('a destroyed popup document cannot interrupt Zotero event dispatch', () => {
  const f = setup();
  const callback = f.registrations[0][1];
  assert.doesNotThrow(() => callback({ reader: f.reader, params: { annotation: annotation() },
    doc: { createElement() { throw new Error('dead document'); } }, append() {} }));
  assert.equal(f.errors[0].message, 'dead document');
});
