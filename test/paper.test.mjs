import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { validatePaperRequest, buildPrompt, contextHash } from '../bridge/paper.mjs';
import { CodexClient } from '../bridge/codex.mjs';
const ctx = createUIContext({});
vm.runInContext(readFileSync(new URL('../addon/core.js', import.meta.url), 'utf8'), ctx);
const core = ctx.PaperChatCore;
const body = () => ({ question: '总结', currentPage: 1, paper: { id: 'test', title: '论文', pageCount: 3, pages: [{ number: 1, text: '原文' }] } });

test('citations use one-based physical pages and ignore unavailable pages', () => {
  const parts = core.citationParts('结论[第1页]，方法[第3页]，错误[第0页][第4页]', 3, new Set([1]));
  assert.deepEqual(Array.from(parts.filter(p => p.page), p => p.page), [1]);
});
test('Zotero 10 character extraction preserves word and paragraph boundaries', () => {
  assert.equal(core.pageText({ chars: [{ u: 'hello', spaceAfter: true }, { u: 'world', paragraphBreakAfter: true }, { u: 'next' }] }), 'hello world\n\nnext');
  assert.equal(core.pageText({ items: [{ str: 'old', hasEOL: true }, { str: 'API' }] }), 'old\nAPI');
});
test('reject malformed, duplicate, out-of-range and scan-only pages', () => {
  for (const pages of [[], [{ number: 0, text: 'x' }], [{ number: 4, text: 'x' }], [{ number: 1, text: '' }], [{ number: 1, text: 'a' }, { number: 1, text: 'b' }]]) {
    const b = body(); b.paper.pages = pages;
    assert.throws(() => validatePaperRequest(b));
  }
});
test('full text is never silently truncated and oversize inputs fail visibly', () => {
  const b = body(); b.paper.pages[0].text = 'x'.repeat(400001);
  assert.throws(() => validatePaperRequest(b), /上限/);
});
test('followups omit unchanged paper but carry selection and question', () => {
  const b = body(); b.selection = 'selected';
  assert.match(buildPrompt(b, true), /untrusted_paper/);
  assert.doesNotMatch(buildPrompt(b, false), /untrusted_paper/);
  assert.match(buildPrompt(b, false), /selected/);
  assert.equal(contextHash(b.paper), contextHash(structuredClone(b.paper)));
  b.paper.pages[0].text = '变化';
  assert.notEqual(contextHash(b.paper), contextHash(body().paper));
});
test('API-key and logged-out accounts cannot start a generation', async () => {
  for (const account of [{ type: 'apiKey' }, null]) {
    const client = new CodexClient();
    const called = [];
    client.call = async method => { called.push(method); return { account }; };
    await assert.rejects(client.ask({ prompt: 'test' }), /不会使用\s*API Key/);
    assert.deepEqual(called, ['account/read']);
  }
});
