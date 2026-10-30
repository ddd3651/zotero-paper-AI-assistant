import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createUIContext } from '../scripts/test-ui-context.mjs';
import { t } from '../bridge/ui-text.mjs';
const data = JSON.parse(readFileSync(new URL('../addon/ui-text.json', import.meta.url), 'utf8'));
test('UI and bridge resolve every referenced text key from the single dictionary', () => {
  const scope = createUIContext();
  for (const folder of ['addon', 'bridge']) {
    const base = new URL('../' + folder + '/', import.meta.url);
    for (const file of readdirSync(base).filter(name => /\.(js|mjs)$/.test(name))) {
      const source = readFileSync(new URL(file, base), 'utf8');
      for (const match of source.matchAll(/\bt\((['"])([a-zA-Z0-9_.]+)\1/g)) {
        assert.equal(scope.PaperChatText.t(match[2]), t(match[2]), file + ': ' + match[2]);
      }
    }
  }
});
test('custom labels and interpolation preserve braces and empty/zero values', () => {
  const text = structuredClone(data);
  text.common.send = '提交问题';
  text.custom = { sentence: '{name}: {count}; {name}; {empty}' };
  const scope = createUIContext({}, text);
  assert.equal(scope.PaperChatText.t('common.send'), '提交问题');
  assert.equal(scope.PaperChatText.t('custom.sentence', { name: '{count}', count: 0, empty: '' }), '{count}: 0; {count}; ');
  assert.throws(() => scope.PaperChatText.t('missing.label'), /Missing interface text/);
});

test('bootstrap loads bundled JSON through a privileged channel before mounting the panel', async () => {
  const vm = await import('node:vm');
  const events = [];
  const channel = {};
  const scope = vm.createContext({
    Services: { scriptloader: { loadSubScript(url, target) {
      const file = url.split('!/')[1];
      if (file === 'ui-text.js') vm.runInContext(readFileSync(new URL('../addon/ui-text.js', import.meta.url), 'utf8'), target);
      if (file === 'panel.js') target.PaperChat = { async start() { events.push(target.PaperChatText.t('common.send')); } };
    } } },
    ChromeUtils: { importESModule() { return { NetUtil: { newChannel(options) {
      assert.equal(options.uri, 'jar:file:///fixture/plugin.xpi!/ui-text.json');
      assert.equal(options.loadUsingSystemPrincipal, true);
      return channel;
    } } }; } },
    Zotero: { File: { async getContentsAsync(source, charset) {
      assert.equal(source, channel);
      assert.equal(charset, 'UTF-8');
      events.push('read');
      return JSON.stringify(data);
    } } },
  });
  vm.runInContext(readFileSync(new URL('../addon/bootstrap.js', import.meta.url), 'utf8'), scope);
  await scope.startup({ rootURI: 'jar:file:///fixture/plugin.xpi!/' });
  assert.deepEqual(events, ['read', '发送']);
});
