import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const scope = createUIContext({});
vm.runInContext(readFileSync(new URL('../addon/evidence.js', import.meta.url), 'utf8'), scope);
const match = (charsOrData, quote) => {
  const result = scope.PaperChatEvidence.matchQuote(charsOrData, quote);
  return result == null ? null : JSON.parse(JSON.stringify(result));
};
const charsFor = text => Array.from(text, (u, i) => ({ u, rect: [i, 1, i + 1, 2] }));

test('matches whitespace, ligatures and line-end word wraps with original char indices', () => {
  const source = '前言: The\t\u00a0eﬃcient inter-\r\n  national co\u00ad\noperation. 后文';
  const chars = charsFor(source);
  const start = Array.from(source).indexOf('T');
  const end = Array.from(source).indexOf('.') + 1;
  const result = match({ chars }, ' The efficient\n international cooperation. ');
  assert.equal(result.start, start);
  assert.equal(result.end, end);
  const points = Array.from(source), cr = points.indexOf('\r'), lf = points.lastIndexOf('\n');
  assert.deepEqual(result.rects, [[start, 1, cr, 2], [cr + 2, 1, lf, 2], [lf + 1, 1, end, 2]]);
  assert.equal(chars.slice(result.start, result.end).map(c => c.u).join(''), source.slice(start, end));
});

test('Zotero boundary flags and multi-character u fields preserve chars array offsets', () => {
  const chars = [
    { u: '前言', paragraphBreakAfter: true },
    { u: 'An', spaceAfter: true },
    { u: 'eﬀective', lineBreakAfter: true },
    { u: 'inter-', lineBreakAfter: true },
    { u: 'national', spaceAfter: true },
    { u: 'oﬃce.', paragraphBreakAfter: true },
    { u: '结尾' },
  ];
  assert.deepEqual(match(chars, 'An effective international office.'), { start: 1, end: 6 });
  assert.deepEqual(match({ chars }, 'eﬀective inter-\nnational'), { start: 2, end: 5 });
  assert.equal(match(chars, 'Aneffective'), null);
});

test('normalization works in either direction without broad compatibility folding', () => {
  assert.deepEqual(match([{ u: 'office flow starts' }], 'oﬃce ﬂow ﬆarts'), { start: 0, end: 1 });
  assert.deepEqual(match([{ u: 'cooperate' }], 'co\u00adoperate'), { start: 0, end: 1 });
  assert.deepEqual(match([{ u: 'international' }], 'inter\u2010\n  national'), { start: 0, end: 1 });
  for (const [source, quote] of [['x²', 'x2'], ['Ａ', 'A'], ['①', '1'], ['œ', 'oe'], ['æ', 'ae']]) {
    assert.equal(match(charsFor(source), quote), null, `${source} / ${quote}`);
  }
});

test('all supported typographic ligatures map to their complete source glyphs', () => {
  for (const [source, quote] of [['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'], ['ﬆ', 'st']]) {
    assert.deepEqual(match([{ u: `The ${source} example.` }], `The ${quote} example.`), { start: 0, end: 1 });
  }
  assert.equal(match([{ u: 'ﬃ testing' }], 'fi testing'), null);
  assert.equal(match([{ u: 'prefix ﬁ' }], 'prefix f'), null);
  assert.equal(match([{ u: 'prefix ﬃ' }], 'prefix ff'), null);
});

test('repeated matches, including overlaps and normalized variants, are refused', () => {
  for (const [source, quote] of [['same sentence; same sentence', 'same sentence'], ['ab ab ab ab ab', 'ab ab ab ab'],
    ['office result oﬃce result', 'office result'], ['a\t b results / a b results', 'a b results'], ['inter-\nnational international', 'international']]) {
    assert.equal(match(charsFor(source), quote), null, `${source} / ${quote}`);
  }
});

test('wrong words, punctuation, case and omitted text cannot match by guessing', () => {
  for (const quote of ['The result is stable.', 'the result was stable.', 'The result was stable!',
    'The result stable.', 'The result … stable.', 'Theresultwasstable.']) {
    assert.equal(match(charsFor('The result was stable.'), quote), null, quote);
  }
  assert.equal(match(charsFor('note book'), 'notebook'), null);
  assert.equal(match(charsFor('state-of-the-art'), 'stateoftheart'), null);
  assert.equal(match(charsFor('inter-\n\nnational'), 'international'), null);
  assert.equal(match(charsFor('item-\n 42'), 'item42'), null);
});

test('surrogate pairs, skipped soft hyphens and internal whitespace retain source indices', () => {
  const chars = [{ u: '💡' }, { u: 'ﬁ' }, { u: '\u00ad' }, { u: 'n' }, { u: 'd' }, { u: 'ings.' }, { u: '💡' }];
  assert.deepEqual(match(chars, 'findings.💡'), { start: 1, end: 7 });
  assert.deepEqual(match(chars, 'findings.'), { start: 1, end: 6 });
  assert.equal(match(chars, '💡'), null);
  assert.equal(match(chars, '\udca1'), null);
  assert.deepEqual(match([{ u: ' ' }, { u: 'alpha' }, { u: '\n' }, { u: ' ' }, { u: 'beta' }, { u: ' ' }], 'alpha beta'), { start: 1, end: 5 });
});

test('rectangles are optional finite copies and input data is not mutated', () => {
  const chars = [{ u: 'alpha', rect: [1, 2, 3, 4] }, { u: 'beta', rect: [0, 0, Infinity, 1] }, { u: 'gamma' }];
  const before = structuredClone(chars);
  const raw = scope.PaperChatEvidence.matchQuote(chars, 'alphabetagamma');
  assert.equal(raw.start, 0);
  assert.equal(raw.end, 3);
  assert.equal(raw.rects.length, 1);
  assert.notEqual(raw.rects[0], chars[0].rect);
  raw.rects[0][0] = 99;
  assert.deepEqual(chars, before);
  assert.deepEqual(match([{ u: 'examples', rect: ['0', 0, 1, 1] }], 'examples'), { start: 0, end: 1 });
});

test('empty, unsupported and oversized inputs fail without a partial match', () => {
  for (const quote of ['', ' \t\n', '\u00ad', null, 42, 'x'.repeat(1501)]) {
    assert.equal(match(charsFor('x'.repeat(1501)), quote), null);
  }
  for (const data of [null, undefined, 'text', {}, { items: [{ str: 'x' }] }, [], [null], [{}], [{ u: 12 }]]) {
    assert.equal(match(data, 'examples'), null);
  }
  assert.deepEqual(match([{ u: 'x'.repeat(1500) }], 'x'.repeat(1500)), { start: 0, end: 1 });
});

test('short quotes and partial words cannot produce a unique highlight', () => {
  for (const [source, quote] of [['latent', 'late'], ['x = 7 + α.', '7'], ['x = 7 + α.', 'α'],
    ['unique', 'unique'], ['a b c d e f g', 'a b c d e f g'], ['😀😁😂😃😄😅😆', '😀😁😂😃😄😅😆'],
    ['This is latent.', 'This is late'], ['misunderstood analysis', 'understood analysis'],
    ['latentvariable', 'latentvar'], ['1234567890', '12345678'], ['αβγδεζηθικ', 'βγδεζηθι'],
    ['𝒜abcdefgh', 'abcdefgh'], ['abcdefgh\u0301', 'abcdefgh']]) {
    assert.equal(match(charsFor(source), quote), null, `${source} / ${quote}`);
  }
  assert.equal(match(charsFor('boundary'), 'boundary').end, 8);
  assert.equal(match(charsFor('12345678'), '12345678').end, 8);
  const phrase = match(charsFor('The latent variable.'), 'latent variable');
  assert.equal(phrase.start, 4);
  assert.equal(phrase.end, 19);
  const source = '论文发现这个方法在所有数据集上都有效。', quote = '这个方法在所有数据集上都有效';
  assert.equal(match(charsFor(source), quote).start, source.indexOf(quote));
});

const glyphs = (text, { x = 0, y = 0, rotation = 0 } = {}) => Array.from(text, (u, i) => ({
  u, rotation, rect: rotation === 90 || rotation === 270 ? [x, y + i * 5, x + 10, y + i * 5 + 5]
    : [x + i * 5, y, x + i * 5 + 5, y + 10],
}));

test('hundreds of adjacent glyphs on one line become one copied PDF rectangle', () => {
  const text = 'This sentence has enough evidence to highlight. '.repeat(5).trim();
  const chars = glyphs(text, { x: 20, y: 100 });
  const before = structuredClone(chars);
  const result = match(chars, text);
  assert.equal(result.start, 0);
  assert.equal(result.end, chars.length);
  assert.deepEqual(result.rects, [[20, 100, 20 + chars.length * 5, 110]]);
  assert.deepEqual(chars, before);
  result.rects[0][0] = 99;
  assert.deepEqual(chars, before);
});

test('line and paragraph flags stop merging even when rectangles are adjacent', () => {
  for (const flag of ['lineBreakAfter', 'paragraphBreakAfter']) {
    const chars = glyphs('Evidence continues.');
    chars[8][flag] = true;
    const result = match(chars, 'Evidence continues.');
    assert.deepEqual(result.rects, [[0, 0, 45, 10], [45, 0, chars.length * 5, 10]]);
  }
});

test('geometry prevents merging across rows or columns without explicit break flags', () => {
  const first = glyphs('Evidence ');
  for (const origin of [{ x: 0, y: -12 }, { x: 200, y: 0 }, { x: 45, y: 8 }]) {
    const second = glyphs('continues.', origin);
    const result = match([...first, ...second], 'Evidence continues.');
    assert.deepEqual(result.rects, [[0, 0, 45, 10], [origin.x, origin.y, origin.x + 50, origin.y + 10]]);
  }
});

test('rotation is respected and vertical glyphs merge along their own text line', () => {
  for (const rotation of [90, 270]) {
    const result = match(glyphs('Evidence.', { x: 200, y: 30, rotation }), 'Evidence.');
    assert.deepEqual(result.rects, [[200, 30, 210, 75]]);
  }
  const mixed = [...glyphs('Evidence '), ...glyphs('rotated.', { x: 100, rotation: 90 })];
  assert.deepEqual(match(mixed, 'Evidence rotated.').rects, [[0, 0, 45, 10], [100, 0, 110, 40]]);
  // Even touching boxes with matching coordinates cannot merge across a rotation change.
  const touching = glyphs('Evidence.');
  touching.slice(4).forEach(char => { char.rotation = 180; });
  assert.deepEqual(match(touching, 'Evidence.').rects, [[0, 0, 20, 10], [20, 0, 45, 10]]);
  assert.equal(match(glyphs('Evidence.', { rotation: 45 }), 'Evidence.').rects.length, 9);
});

test('gaps, reversed flow and invalid rectangles cannot bridge unrelated glyph runs', () => {
  const reverse = glyphs('abcdefghij');
  reverse.slice(5).forEach((char, i) => { char.rect = [15 - i * 5, 0, 20 - i * 5, 10]; });
  assert.deepEqual(match(reverse, 'abcdefghij').rects, [[0, 0, 25, 10], [-5, 0, 20, 10]]);
  const missing = glyphs('Evidence.');
  delete missing[4].rect;
  assert.deepEqual(match(missing, 'Evidence.').rects, [[0, 0, 20, 10], [25, 0, 45, 10]]);
  for (const rect of [Array(4), [0, 0, 0, 10], [0, 0, NaN, 10]]) {
    assert.deepEqual(match([{ u: 'Evidence.', rect }], 'Evidence.'), { start: 0, end: 1 });
  }
});
