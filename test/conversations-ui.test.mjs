import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createUIContext } from '../scripts/test-ui-context.mjs';

function fixture(api = async () => ({})) {
  const doc = { activeElement: null };
  class Element {
    constructor(tag, text = '', className = '') { Object.assign(this, { tag, textContent: text || '', className, ownerDocument: doc, children: [], attrs: {}, events: {}, hidden: false, value: '', dataset: {} }); }
    append(...nodes) { for (const n of nodes) { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(x => x !== n); n.parentElement = this; this.children.push(n); } }
    before(...nodes) { const p = this.parentElement; const index = p.children.indexOf(this); for (const n of nodes) { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(x => x !== n); n.parentElement = p; } p.children.splice(index, 0, ...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(key, fn) { (this.events[key] ||= []).push(fn); }
    async fire(key, event = {}) { for (const fn of this.events[key] || []) await fn(event); }
    focus() { doc.activeElement = this; }
    closest(selector) { if (selector === '[hidden]' && this.hidden) return this; return this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) {
      return this.children.flatMap(n => {
        const matches = selector.startsWith('.') ? n.className.split(' ').includes(selector.slice(1)) : selector.includes('button') && n.tag === 'button' || selector.includes('input') && n.tag === 'input' || selector.includes('summary') && n.tag === 'summary';
        return [...(matches && (!selector.includes(':not([disabled])') || !n.disabled) ? [n] : []), ...n.querySelectorAll(selector)];
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  }
  doc.createElementNS = (_, tag) => new Element(tag);
  const scope = createUIContext({ Zotero: { Promise: { delay: async () => {} } }, PaperChatReader: { clearHighlight() {} }, PaperChatInteraction: { progress(_, __, body) { body.progress = true; } } });
  vm.runInContext(readFileSync(new URL('../addon/conversations.js', import.meta.url), 'utf8'), scope);
  const helper = scope.PaperChatConversations;
  const panel = new Element('aside'), head = new Element('header'), title = new Element('div'), history = new Element('button'), status = new Element('div'), log = new Element('main'), compose = new Element('div'), input = new Element('textarea');
  const clear = new Element('button', 'clear'), send = new Element('button', 'send'), hint = new Element('div', 'hint', 'pc-hint');
  const bottom = new Element('div', '', 'pc-bottom'), left = new Element('div', '', 'pc-actions'), actions = new Element('div', '', 'pc-actions');
  const settingsButton = new Element('button', '', 'pc-icon'), settingsMenu = new Element('div', '', 'pc-settings-menu');
  const error = new Element('div', '', 'pc-error');
  left.append(clear); actions.append(send); bottom.append(left, actions);
  compose.append(input, bottom, hint, error); head.append(title, status); panel.append(head, log, compose, settingsMenu);
  const state = { panel, input, status, log, clear, send, settingsButton, settingsMenu, error, reader: { _instanceID: 'reader1' }, pageCount: 12, paperId: '1/ABC', paperTitle: 'Test', allowedPages: new Set(), messages: [] };
  const plugin = { el: (_, tag, text, cls) => new Element(tag, text, cls), api,
    setBusy(state, busy) { state.busy = busy; helper.setBusy(state); }, refreshCitations() {}, removeSelection(state) { state.selectedExcerpt = null; },
    message(state, role, text) { const body = new Element('div'); body._paperChatEntry = { role, text }; state.messages.push(body._paperChatEntry); state.log.append(body); return body; }, applySettings() {} };
  helper.mount(plugin, state, { head, title, history, welcome: new Element('p', 'welcome') });
  return { helper, plugin, state, doc, Element };
}
const context = { estimatedInputTokens: 5000, estimatedTokens: 100, contextWindow: 20000, outputReserve: 1000, retainedTurns: 3, summary: 'Saved summary' };

test('initialization restores latest complete server transcript and exact citation/activity metadata', async () => {
  const calls = [];
  const record = { id: 'latest', title: 'Archive', pageCount: 12, turns: [{ id: 't1', startedAt: 100, firstTextAt: 200, finishedAt: 300, pageReferences: [5] }], messages: [
    { role: 'user', text: 'question', selection: 'quote', selectionPage: 5 },
    { role: 'assistant', turnId: 't1', text: 'answer [第5页]', status: 'completed', summary: 'Reasoning' },
  ] };
  const f = fixture(async path => { calls.push(path); return path.startsWith('/conversations?') ? { conversations: [{ id: 'old', updatedAt: 10 }, { id: 'latest', updatedAt: 20 }] } : path.split('?')[0].endsWith('/context') ? context : { conversation: record }; });
  await f.helper.initialize(f.plugin, f.state);
  assert.equal(f.state.conversationId, 'latest'); assert.equal(f.state.historyLoaded, true);
  assert.equal(f.state.messages.length, 2); assert.equal(f.state.messages[0].selection, 'quote');
  assert.equal(f.state.messages[1].activity.summary, 'Reasoning'); assert.equal(f.state.messages[1].activity.firstTextAt, 200);
  assert.ok(f.state.allowedPages.has(5)); assert.equal(f.state.conversationsUI.statusText.textContent, '已保存到本地 · 上下文约25%');
  assert.equal(calls[0], '/conversations?paperId=1%2FABC');
});

test('failed initial history fetch does not enable send or erase snapshots; retry succeeds', async () => {
  let fail = true;
  const f = fixture(async path => { if (fail) throw new Error('offline'); return path.startsWith('/conversations?') ? { conversations: [] } : path.split('?')[0].endsWith('/context') ? context : { conversation: { id: 'new', messages: [] } }; });
  await assert.rejects(f.helper.initialize(f.plugin, f.state), /offline/);
  assert.equal(f.state.historyLoaded, false); assert.equal(f.state.historyBusy, false); assert.equal(f.state.conversationsUI.compact.disabled, true);
  fail = false; await f.helper.initialize(f.plugin, f.state); assert.equal(f.state.historyLoaded, true);
});

test('new conversation archives previous transcript and reset sends captured conversation id', async () => {
  const calls = []; const f = fixture(async (path, method, body) => { calls.push({ path, method, body }); return path.split('?')[0].endsWith('/context') ? context : { conversation: { id: 'new', messages: [] } }; });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'old', messages: [{ role: 'user', text: 'old' }] });
  await f.helper.create(f.plugin, f.state);
  assert.equal(f.state.conversationId, 'new'); assert.equal(calls[0].path, '/conversations'); assert.equal(calls[0].body.paperId, '1/ABC');
  assert.equal(calls.some(c => c.path === '/reset'), false);
  await f.helper.clear(f.plugin, f.state); assert.equal(calls.find(c => c.path === '/reset').body.conversationId, 'new');
});

test('stale context responses cannot overwrite switched conversation or newer results', async () => {
  const waiting = []; const f = fixture(() => new Promise(resolve => waiting.push(resolve)));
  f.state.conversationId = 'a'; const first = f.helper.refreshContext(f.plugin, f.state);
  f.state.conversationId = 'b'; const second = f.helper.refreshContext(f.plugin, f.state);
  waiting[1]({ ...context, summary: 'b' }); await second;
  waiting[0]({ ...context, summary: 'a' }); await first;
  assert.equal(f.state.conversationsUI.summaryText.textContent, 'b');
});

test('manual compact polls job and reads resulting summary without clearing full messages', async () => {
  const calls = []; let poll = 0;
  const f = fixture(async path => { calls.push(path); return path.endsWith('/compact') ? { jobId: 'compact-job' } : path.startsWith('/jobs') ? { status: ++poll === 1 ? 'running' : 'completed' } : context; });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a', messages: [{ role: 'user', text: 'keep' }] });
  await f.helper.compact(f.plugin, f.state);
  assert.equal(f.state.error.textContent, ''); assert.equal(poll, 2); assert.equal(f.state.jobId, null); assert.equal(f.state.messages[0].text, 'keep'); assert.equal(f.state.conversationsUI.summaryText.textContent, 'Saved summary');
  assert.equal(f.state.historyBusy, false);
});

test('snapshot import is retriable and removes source only after confirmed message persistence', async () => {
  const bodies = []; let accept = false;
  const f = fixture(async (_, __, body) => { bodies.push(body); return { conversation: { id: 'import', messages: accept ? body.messages : [] } }; });
  f.plugin.savedTranscripts = { reader1: { messages: [{ role: 'user', text: 'legacy' }], allowedPages: [3], pageCount: 12 } };
  await assert.rejects(f.helper.importSnapshot(f.plugin, f.state), /旧对话/); assert.ok(f.plugin.savedTranscripts.reader1);
  accept = true; await f.helper.importSnapshot(f.plugin, f.state);
  assert.equal(bodies[0].importKey, bodies[1].importKey); assert.equal(f.plugin.savedTranscripts.reader1, undefined);
});

test('drawers restore trigger focus, trap Tab, Escape closes and icon labels remain accessible', async () => {
  const f = fixture(); const ui = f.state.conversationsUI;
  f.helper.open(f.state, 'context'); assert.equal(ui.contextDrawer.hidden, false);
  const first = ui.contextDrawer.querySelector('button'), last = ui.compact; last.focus();
  let prevented = false;
  await f.state.panel.fire('keydown', { key: 'Tab', stopPropagation() {}, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.doc.activeElement, first);
  await f.state.panel.fire('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} });
  assert.equal(ui.contextDrawer.hidden, true); assert.equal(f.doc.activeElement, ui.status);
  assert.equal(ui.history.attrs['aria-expanded'], 'false');
  const button = f.helper.icon(f.plugin, f.doc, 'common.newChat', 'new'); assert.equal(button.attrs['aria-label'], '新对话');
});

test('unknown context capacity displays unknown instead of invented percentage', async () => {
  const f = fixture(async () => ({ estimatedTokens: 500, capacityTokens: null })); f.state.conversationId = 'a';
  await f.helper.refreshContext(f.plugin, f.state);
  assert.equal(f.state.conversationsUI.meter.hidden, true); assert.match(f.state.conversationsUI.statusText.textContent, /未知/);
});

test('history rename and two-step delete use only their selected archive id', async () => {
  const calls = [];
  const f = fixture(async (path, method, body) => { calls.push({ path, method, body }); return { conversations: [{ id: 'archived', title: 'Old', updatedAt: 10, messageCount: 20 }] }; });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'current' });
  await f.helper.list(f.plugin, f.state);
  let row = f.state.conversationsUI.historyList.children[0];
  const editor = row.children[3]; editor.children[0].value = 'Renamed';
  await editor.children[1].fire('click');
  const patch = calls.find(c => c.method === 'PATCH'); assert.equal(patch.path, '/conversations/archived'); assert.equal(patch.body.title, 'Renamed');
  row = f.state.conversationsUI.historyList.children[0]; const remove = row.children[2].children[1];
  await remove.fire('click'); assert.equal(calls.some(c => c.method === 'DELETE'), false);
  await remove.fire('click'); assert.equal(calls.find(c => c.method === 'DELETE').path, '/conversations/archived');
  assert.equal(f.state.conversationId, 'current');
});

test('an in-flight new conversation prevents double create, clear, and compact', async () => {
  let resolve, creates = 0;
  const f = fixture(async path => { if (path === '/conversations') { creates++; return new Promise(done => { resolve = done; }); } return context; });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a' });
  const pending = f.helper.create(f.plugin, f.state);
  await f.helper.create(f.plugin, f.state); await f.helper.clear(f.plugin, f.state); await f.helper.compact(f.plugin, f.state);
  assert.equal(creates, 1); assert.equal(f.state.historyBusy, true);
  resolve({ conversation: { id: 'b', messages: [] } }); await pending;
  assert.equal(f.state.conversationId, 'b'); assert.equal(f.state.historyBusy, false);
});

test('capacity setting saves the configured budget and preserves other budget fields', async () => {
  const calls = []; const f = fixture(async (path, method, body) => { calls.push({ path, method, body }); return path === '/settings' ? { current: { contextBudget: { contextWindow: 32768, outputReserve: 4096, threshold: 0.75 } } } : context; });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a' });
  f.state.conversationsUI.capacity.value = '65536'; await f.state.conversationsUI.saveCapacity.fire('click');
  const patch = calls.find(c => c.method === 'POST'); assert.equal(patch.path, '/settings'); assert.equal(patch.body.contextBudget.contextWindow, 65536); assert.equal(patch.body.contextBudget.outputReserve, 4096);
  f.state.conversationsUI.capacity.value = 'oops'; const count = calls.length; await f.state.conversationsUI.saveCapacity.fire('click');
  assert.equal(calls.length, count); assert.match(f.state.error.textContent, /整数/);
});

test('failed manual compact unlocks controls and retains full messages and previous summary', async () => {
  const f = fixture(async path => path.endsWith('/compact') ? { jobId: 'j' } : { status: 'failed', error: 'model unavailable' });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a', messages: [{ role: 'assistant', text: 'original' }] });
  f.state.conversationsUI.summaryText.textContent = 'previous'; await f.helper.compact(f.plugin, f.state);
  assert.equal(f.state.error.textContent, 'model unavailable'); assert.equal(f.state.messages[0].text, 'original'); assert.equal(f.state.conversationsUI.summaryText.textContent, 'previous'); assert.equal(f.state.historyBusy, false);
});

test('partial paper coverage and corrupt-history warnings stay visible alongside readable archives', async () => {
  const f = fixture(async path => path.startsWith('/conversations?') ? { conversations: [{ id: 'good', title: 'Readable' }], warnings: [{ error: 'One archive unreadable' }] } : { ...context, sourceCoverage: { partial: true, selectedPages: 2, providedPages: 5, totalPages: 12 } });
  f.state.conversationId = 'a'; await f.helper.list(f.plugin, f.state); await f.helper.refreshContext(f.plugin, f.state);
  assert.equal(f.state.conversationsUI.historyList.children.length, 1); assert.match(f.state.conversationsUI.historyError.textContent, /One archive unreadable/);
  assert.equal(f.state.conversationsUI.coverage.hidden, false); assert.match(f.state.conversationsUI.coverage.textContent, /选入2页.*提供5页.*共12页/);
});

test('manual compact with nothing eligible reports no operation rather than successful compaction', async () => {
  const f = fixture(async path => path.endsWith('/compact') ? { jobId: 'j' } : path.startsWith('/jobs') ? { status: 'completed', noOp: true, compacted: false } : context);
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a' }); await f.helper.compact(f.plugin, f.state);
  assert.match(f.state.conversationsUI.contextError.textContent, /没有需要整理/);
});

test('upgrade restores the saved conversation id before the newer current-paper archive', async () => {
  const calls = []; const f = fixture(async path => { calls.push(path); return path.startsWith('/conversations?') ? { conversations: [{ id: 'latest', updatedAt: 200 }] } : path.split('?')[0].endsWith('/context') ? context : { conversation: { id: 'saved', paperId: '1/ABC', messages: [{ role: 'user', text: 'older open archive' }] } }; });
  f.plugin.savedTranscripts = { reader1: { conversationId: 'saved', paperId: '1/ABC', messages: [{ role: 'user', text: 'snapshot' }] } };
  await f.helper.initialize(f.plugin, f.state);
  assert.equal(f.state.conversationId, 'saved'); assert.ok(calls.includes('/conversations/saved?paperId=1%2FABC')); assert.equal(f.plugin.savedTranscripts.reader1, undefined);
});

test('deleted saved conversation falls back visibly; connectivity errors retain snapshot and prevent fallback', async () => {
  let missing = true; const f = fixture(async path => {
    if (path.startsWith('/conversations?')) return { conversations: [{ id: 'latest', updatedAt: 200 }] };
    if (path.startsWith('/conversations/saved?')) throw Object.assign(new Error(missing ? 'deleted' : 'offline'), { status: missing ? 404 : 503 });
    return path.split('?')[0].endsWith('/context') ? context : { conversation: { id: 'latest', paperId: '1/ABC', messages: [] } };
  });
  const snapshot = () => ({ reader1: { conversationId: 'saved', paperId: '1/ABC', messages: [{ role: 'user', text: 'snapshot' }] } });
  f.plugin.savedTranscripts = snapshot(); await f.helper.initialize(f.plugin, f.state);
  assert.equal(f.state.conversationId, 'latest'); assert.match(f.state.conversationsUI.notice.textContent, /已删除/);
  missing = false; f.plugin.savedTranscripts = snapshot(); await assert.rejects(f.helper.initialize(f.plugin, f.state), /offline/);
  assert.ok(f.plugin.savedTranscripts.reader1); assert.equal(f.state.historyLoaded, false);
});

test('delete submits scoped JSON and every conversation read scopes its paper', async () => {
  const calls = []; const f = fixture(async (path, method, body) => { calls.push({ path, method, body }); return {}; });
  await f.helper.request(f.plugin, f.state, 'c', '', 'DELETE'); await f.helper.request(f.plugin, f.state, 'c', '/context');
  assert.equal(calls[0].body.paperId, '1/ABC'); assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[1].path, '/conversations/c/context?paperId=1%2FABC');
  assert.throws(() => f.helper.restore(f.plugin, f.state, { id: 'wrong', paperId: '2/OTHER', messages: [] }), /另一篇论文/);
});

test('compaction polling failure sends cancel and reconciles terminal job before unlocking', async () => {
  const calls = []; let polls = 0; const f = fixture(async path => {
    calls.push(path);
    if (path.endsWith('/compact')) { assert.equal(f.state.conversationsUI.compactCancel.hidden, false); return { jobId: 'j' }; }
    if (path.endsWith('/cancel')) { assert.equal(f.state.historyBusy, true); return {}; }
    if (path.startsWith('/jobs/')) { if (++polls === 1) throw new Error('poll interrupted'); return { status: 'cancelled' }; }
    return context;
  });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a' }); await f.helper.compact(f.plugin, f.state);
  assert.ok(calls.includes('/jobs/j/cancel')); assert.equal(f.state.historyBusy, false); assert.equal(f.state.jobId, null); assert.equal(f.state.conversationsUI.compactCancel.hidden, true);
});

test('unconfirmed compaction remains locked with stop/reconcile until server termination is confirmed', async () => {
  let offline = true; const f = fixture(async path => {
    if (path.endsWith('/compact')) return { jobId: 'j' };
    if (path.endsWith('/cancel')) return {};
    if (path.startsWith('/jobs/')) { if (offline) throw new Error('offline'); return { status: 'cancelled' }; }
    return context;
  });
  Object.assign(f.state, { historyLoaded: true, conversationId: 'a' }); await f.helper.compact(f.plugin, f.state);
  assert.equal(f.state.historyBusy, true); assert.equal(f.state.jobId, 'j'); assert.equal(f.state.compacting, true); assert.equal(f.state.conversationsUI.reconcile.hidden, false);
  offline = false; await f.state.conversationsUI.reconcile.fire('click');
  assert.equal(f.state.jobId, null); assert.equal(f.state.historyBusy, false); assert.equal(f.state.compacting, false);
});


test('composer footer places settings gear on left, clear above context, menu outside scrolling compose', () => {
  const { state } = fixture(), ui = state.conversationsUI;
  assert.equal(state.inputArea, ui.area); assert.equal(state.compose, ui.compose);
  assert.equal(state.composerFooter, ui.footer);
  assert.deepEqual(ui.footer.children, [state.settingsButton, ui.belowClear, state.settingsMenu]);
  assert.deepEqual(ui.belowClear.children, [state.clear, ui.status]);
  assert.deepEqual(ui.area.children, [ui.compose, ui.footer, state.status, ui.notice, state.error]);
  assert.equal(state.settingsMenu.parentElement, ui.footer);
  assert.equal(state.input.parentElement, ui.compose);
  const bottom = ui.compose.querySelector('.pc-bottom');
  assert.equal(bottom.children.length, 2);
  assert.equal(bottom.children[0].className, 'pc-hint');
  assert.equal(bottom.children[1], state.send.parentElement);
  assert.equal(state.clear.className, 'pc-clear');
});

test('settings and send icons provide actual SVG paths and localized accessible labels', () => {
  const f = fixture();
  for (const [kind, key] of [['settings', 'settings.open'], ['send', 'common.send']]) {
    const button = f.helper.icon(f.plugin, f.doc, key, kind);
    assert.ok(button.attrs['aria-label']);
    const path = button.children[0].children[0].attrs.d;
    assert.ok(path?.length > 10); assert.notEqual(path, 'undefined');
  }
});
