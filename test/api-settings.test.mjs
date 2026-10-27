import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(ownerDocument, tag, text = '') {
    Object.assign(this, { ownerDocument, tag, textContent: text, children: [], attributes: {},
      listeners: {}, style: {}, value: '', checked: false, hidden: false, disabled: false });
  }
  append(...nodes) { this.children.push(...nodes); }
  insertBefore(node, sibling) {
    const index = this.children.indexOf(sibling);
    assert.notEqual(index, -1);
    this.children.splice(index, 0, node);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  fire(name, event = {}) { for (const handler of this.listeners[name] || []) handler(event); }
}

function fixture(provider = 'codex') {
  const context = createUIContext({});
  vm.runInContext(readFileSync(new URL('../addon/api-settings.js', import.meta.url), 'utf8'), context);
  const api = context.PaperChatAPISettings;
  const doc = {};
  const settingsMenu = new Element(doc, 'div');
  const modelLabel = new Element(doc, 'label');
  const effortLabel = new Element(doc, 'label');
  settingsMenu.append(modelLabel, effortLabel);
  const state = { settingsReady: true, selectedSettings: { provider, model: 'codex-model', effort: 'high', customPrompt: '' } };
  let current = { ...state.selectedSettings, external: { baseUrl: 'https://example.test/v1', model: 'external-model', hasApiKey: true } };
  const calls = [];
  const plugin = {
    el: (doc, tag, text) => new Element(doc, tag, text),
    async saveSettings(s, changes) {
      assert.equal(s, state);
      calls.push(JSON.parse(JSON.stringify(changes)));
      current = { ...current, provider: changes.provider };
      if (Object.hasOwn(changes, 'webSearch')) current.webSearch = changes.webSearch;
      if (current.provider === 'external') current.webSearch = false;
      if (changes.external) {
        current.external = { ...current.external, baseUrl: changes.external.baseUrl, model: changes.external.model,
          hasApiKey: Object.hasOwn(changes.external, 'apiKey') ? !!changes.external.apiKey : current.external.hasApiKey };
      }
      const result = { models: [], current };
      api.apply(state, result);
      return result;
    },
  };
  const options = { settingsMenu, modelLabel, effortLabel };
  const view = api.mount(plugin, state, options);
  api.apply(state, { current });
  const edit = (name, value) => { view[name].value = value; view[name].fire('input'); };
  const save = async () => { view.save.fire('click'); await state.settingsPromise; };
  return { api, state, view, plugin, calls, options, edit, save,
    apply: patch => { current = { ...current, ...patch }; api.apply(state, { current }); } };
}

test('mounts Chinese provider options once, masks keys, and toggles Codex labels after save', async () => {
  const f = fixture();
  const { view, state, api, plugin, options } = f;
  assert.equal(api.mount(plugin, state, options), view);
  assert.deepEqual(Array.from(view.provider.children, option => option.textContent), ['Codex登录', '外部模型API']);
  assert.equal(view.apiKey.type, 'password');
  assert.equal(view.apiKey.placeholder, '已保存');
  assert.equal(view.apiKey.value, '');
  assert.equal(view.external.hidden, true);
  view.provider.value = 'external'; view.provider.fire('change');
  await state.settingsPromise;
  assert.deepEqual(f.calls, [{ provider: 'external' }]);
  assert.equal(view.external.hidden, false);
  assert.equal(view.modelLabel.hidden, true);
  assert.equal(view.effortLabel.hidden, true);
  assert.equal(view.modelLabel.style.display, 'none');
  assert.equal(view.effortLabel.style.display, 'none');
  view.provider.value = 'codex'; view.provider.fire('change');
  await state.settingsPromise;
  assert.equal(view.external.hidden, true);
  assert.equal(view.modelLabel.hidden, false);
  assert.equal(view.effortLabel.hidden, false);
  assert.equal(view.modelLabel.style.display, '');
});

test('web search toggle saves immediately, follows provider support and disables while busy', async () => {
  const f = fixture();
  assert.equal(f.view.webSearch.checked, false); assert.equal(f.view.webSearch.disabled, false);
  f.view.webSearch.checked = true; f.view.webSearch.fire('change'); await f.state.settingsPromise;
  assert.deepEqual(f.calls[0], { provider: 'codex', webSearch: true });
  assert.equal(f.view.webSearch.checked, true);
  f.api.setBusy(f.state, true); assert.equal(f.view.webSearch.disabled, true);
  f.api.setBusy(f.state, false);
  f.view.provider.value = 'external'; f.view.provider.fire('change'); await f.state.settingsPromise;
  assert.equal(f.view.webSearch.checked, false); assert.equal(f.view.webSearch.disabled, true);
  assert.match(f.view.webHelp.textContent, /暂不支持/);
});

test('external saves arbitrary model text; omitted key preserves, explicit clear sends empty string', async () => {
  const f = fixture('external');
  f.edit('model', 'vendor/arbitrary-model-2026');
  f.edit('baseUrl', 'https://other.example/v1');
  await f.save();
  assert.deepEqual(f.calls[0], { provider: 'external', external: { baseUrl: 'https://other.example/v1', model: 'vendor/arbitrary-model-2026' } });
  f.edit('apiKey', 'secret-only-in-request');
  await f.save();
  assert.equal(f.calls[1].external.apiKey, 'secret-only-in-request');
  assert.equal(f.view.apiKey.value, '');
  assert.equal(f.view.apiKey.placeholder, '已保存');
  assert.doesNotMatch(JSON.stringify(f.state.selectedSettings), /secret-only-in-request|apiKey/);
  f.edit('apiKey', 'ignore-when-clearing');
  f.view.clearKey.checked = true; f.view.clearKey.fire('change');
  assert.equal(f.view.apiKey.disabled, true);
  await f.save();
  assert.equal(f.calls[2].external.apiKey, '');
  assert.equal(f.view.apiKey.value, '');
  assert.equal(f.view.apiKey.placeholder, '');
  assert.equal(f.view.clearKey.checked, false);
  assert.equal(f.view.status.textContent, '已保存');
});

test('apply updates clean fields and preserves all unsaved fields, including a key and clear choice', () => {
  const f = fixture('external');
  f.edit('model', 'draft-model'); f.edit('apiKey', 'draft-secret');
  f.view.clearKey.checked = true; f.view.clearKey.fire('change');
  f.apply({ external: { baseUrl: 'https://updated.example/v1', model: 'server-model', hasApiKey: false, apiKey: 'must-never-render' } });
  assert.equal(f.view.baseUrl.value, 'https://updated.example/v1');
  assert.equal(f.view.model.value, 'draft-model');
  assert.equal(f.view.apiKey.value, 'draft-secret');
  assert.equal(f.view.clearKey.checked, true);
  assert.equal(f.view.status.textContent, '尚未保存');
  assert.doesNotMatch(JSON.stringify(f.view.current), /must-never-render|apiKey/);
  f.edit('baseUrl', 'https://draft.example/v1');
  f.apply({ provider: 'codex' });
  assert.equal(f.view.baseUrl.value, 'https://draft.example/v1');
});

test('busy, loading, saving and pending requests disable controls; keydown stops Zotero shortcuts', async () => {
  const f = fixture('external');
  const controls = [f.view.provider, f.view.baseUrl, f.view.model, f.view.apiKey, f.view.clearKey, f.view.save];
  for (const flag of ['busy', 'settingsSaving', 'settingsReady']) {
    if (flag === 'busy') f.api.setBusy(f.state, true);
    else { f.state[flag] = flag !== 'settingsReady'; f.api.setBusy(f.state, false); }
    assert.ok(controls.every(control => control.disabled), flag);
    f.state.settingsSaving = false; f.state.settingsReady = true; f.api.setBusy(f.state, false);
    assert.ok(controls.every(control => !control.disabled));
  }
  let stopped = 0;
  for (const control of controls.slice(0, -1)) control.fire('keydown', { stopPropagation() { stopped++; } });
  assert.equal(stopped, 5);
  let release;
  const originalSave = f.plugin.saveSettings;
  f.plugin.saveSettings = async (...args) => { await new Promise(resolve => { release = resolve; }); return originalSave(...args); };
  f.view.save.fire('click');
  assert.ok(controls.every(control => control.disabled));
  f.view.save.fire('click');
  release(); await f.state.settingsPromise;
  assert.equal(f.calls.length, 1);
  assert.ok(controls.every(control => !control.disabled));
});

test('failed saves retain drafts and show a generic error without leaking credentials', async () => {
  for (const rejects of [true, false]) {
    const f = fixture('external');
    f.plugin.saveSettings = async () => {
      if (rejects) throw new Error('transport exposed secret-key');
      f.state.error = { textContent: '父模块保存失败' };
      return null;
    };
    f.edit('model', 'unsaved'); f.edit('apiKey', 'secret-key');
    await f.save();
    assert.equal(f.view.model.value, 'unsaved');
    assert.equal(f.view.apiKey.value, 'secret-key');
    assert.equal(f.view.status.textContent, '保存失败，请重试');
    assert.equal(f.view.save.disabled, false);
    assert.doesNotMatch(f.view.status.textContent, /secret-key/);
  }
});

test('provider failures roll back selection and successful provider saves preserve external drafts', async () => {
  const f = fixture();
  f.edit('model', 'draft');
  const save = f.plugin.saveSettings;
  f.plugin.saveSettings = async () => { throw new Error('failed'); };
  f.view.provider.value = 'external'; f.view.provider.fire('change');
  await f.state.settingsPromise;
  assert.equal(f.view.provider.value, 'codex');
  assert.equal(f.view.external.hidden, true);
  f.plugin.saveSettings = save;
  f.view.provider.value = 'external'; f.view.provider.fire('change');
  await f.state.settingsPromise;
  assert.equal(f.view.model.value, 'draft');
  assert.equal(f.view.status.textContent, '尚未保存');
});

test('an apply during save never discards input edited since the request started', async () => {
  const f = fixture('external');
  let release;
  const originalSave = f.plugin.saveSettings;
  f.plugin.saveSettings = async (...args) => { await new Promise(resolve => { release = resolve; }); return originalSave(...args); };
  f.edit('model', 'submitted'); f.edit('apiKey', 'submitted-key');
  f.view.save.fire('click');
  assert.doesNotMatch(JSON.stringify(f.view.pending), /submitted-key/);
  f.edit('model', 'new-draft'); f.edit('apiKey', 'new-key');
  release(); await f.state.settingsPromise;
  assert.equal(f.view.model.value, 'new-draft');
  assert.equal(f.view.apiKey.value, 'new-key');
  assert.equal(f.view.status.textContent, '尚未保存');
});

test('a matching apply followed by null does not acknowledge dirty fields or clear the key', async () => {
  const f = fixture('external');
  f.edit('baseUrl', 'https://draft.example/v1');
  f.edit('model', 'draft-model'); f.edit('apiKey', 'draft-key');
  f.view.clearKey.checked = true; f.view.clearKey.fire('change');
  f.plugin.saveSettings = async () => {
    f.apply({ external: { baseUrl: f.view.baseUrl.value, model: f.view.model.value, hasApiKey: false } });
    return null;
  };
  await f.save();
  assert.deepEqual(Array.from(f.view.dirty).sort(), ['apiKey', 'baseUrl', 'clearKey', 'model']);
  assert.equal(f.view.apiKey.value, 'draft-key');
  assert.equal(f.view.clearKey.checked, true);
  assert.equal(f.view.status.textContent, '保存失败，请重试');
});

test('successful normalized settings acknowledge drafts only after the parent returns a result', async () => {
  const f = fixture('external');
  f.edit('baseUrl', '  https://normalized.example/v1///  ');
  f.edit('model', '  external-model  ');
  f.edit('apiKey', 'new-key');
  f.plugin.saveSettings = async () => {
    const result = { models: [], current: { provider: 'external', external: {
      baseUrl: 'https://normalized.example/v1', model: 'external-model', hasApiKey: true,
    } } };
    f.api.apply(f.state, result);
    assert.equal(f.view.apiKey.value, 'new-key');
    assert.equal(f.view.dirty.has('apiKey'), true);
    return result;
  };
  await f.save();
  assert.equal(f.view.baseUrl.value, 'https://normalized.example/v1');
  assert.equal(f.view.model.value, 'external-model');
  assert.equal(f.view.apiKey.value, '');
  assert.equal(f.view.dirty.size, 0);
  assert.equal(f.view.status.textContent, '已保存');
  assert.equal(f.view.provider.disabled, false);
});

test('first switch to external accepts empty settings without UI validation', async () => {
  const f = fixture();
  f.apply({ external: { baseUrl: '', model: '', hasApiKey: false } });
  f.view.provider.value = 'external'; f.view.provider.fire('change');
  await f.state.settingsPromise;
  assert.deepEqual(f.calls, [{ provider: 'external' }]);
  assert.equal(f.view.external.hidden, false);
  assert.equal(f.view.status.textContent, '已保存');
  await f.save();
  assert.deepEqual(f.calls[1], { provider: 'external', external: { baseUrl: '', model: '' } });
  assert.equal(f.view.status.textContent, '已保存');
});
