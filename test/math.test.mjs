import { createUIContext } from '../scripts/test-ui-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const scope = createUIContext({});
for (const file of ['vendor/marked.umd.js', 'vendor/katex.min.js', 'math.js']) {
  vm.runInContext(readFileSync(new URL('../addon/' + file, import.meta.url), 'utf8'), scope);
}
const math = scope.PaperChatMath;
const tokens = list => list.flatMap(t => [t, ...tokens(t.tokens || []), ...(t.items || []).flatMap(i => tokens(i.tokens || [])), ...(t.header || []).flatMap(c => tokens(c.tokens || [])), ...(t.rows || []).flatMap(r => r.flatMap(c => tokens(c.tokens || [])))]);
const formulas = text => tokens(math.lex(text)).filter(t => t.type === 'paper_math');
test('all four TeX delimiters retain backslashes, subscripts and fractions', () => {
  const found = formulas(String.raw`Inline \(h_l\) and $x_i^2$.

\[
\frac{a_1}{b_2}
\]

$$\sum_{i=1}^{n} x_i$$`);
  assert.equal(found.length, 4);
  assert.deepEqual(Array.from(found, t => t.display), [false, false, true, true]);
  assert.match(found[2].tex, /\\frac/);
  assert.match(math.markup(found[2].tex, true), /<mfrac>/);
  assert.match(math.markup(found[3].tex, true), /<munderover>/);
});
test('formulas work inside headings, lists and tables alongside citations', () => {
  const found = formulas('# Model $h_l$\n\n- Step \\(x_i\\) [第3页]\n\n| Method |\n|---|\n| $y^2$ |');
  assert.equal(found.length, 3);
});
test('code, escaped dollars, currency and unfinished formulas stay literal', () => {
  for (const text of ['`$x$`', '```tex\n\\[x\\]\n```', String.raw`\$20 and \$30`, '$20 and $30', String.raw`\(x`, '$$', '$ x $']) {
    assert.equal(formulas(text).length, 0, text);
  }
});
test('untrusted math cannot create links or images; macro expansion is bounded', () => {
  for (const tex of [String.raw`\href{https://example.com}{x}`, String.raw`\includegraphics{https://example.com/x.png}`]) {
    const result = math.markup(tex, false);
    assert.doesNotMatch(result, /<(?:a|img)\b|href=/);
  }
  assert.throws(() => math.markup(String.raw`\def\a{\a}\a`, false));
  assert.throws(() => math.markup(String.raw`\invalidcommand`, false));
});
