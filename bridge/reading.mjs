import { t } from './ui-text.mjs';

export const MAX_PAPER_CHARS = 2_000_000;
export const MAX_REQUEST_BYTES = 10_000_000;
export const MIN_READING_PAGES = 30;
// Deliberately conservative UTF-8/JSON estimate, not a provider tokenizer.
export const estimateReadingTokens = value => Buffer.byteLength(String(value || ''), 'utf8') + 32;

export class PaperReadingError extends Error {
  constructor(code, details = {}) {
    const key = `errors.reading.${code}`;
    // Parent adds these translations; preserve a usable existing error while
    // independent helpers are being integrated into the shared checkout.
    let message;
    try { message = t(key); } catch { message = t('errors.context.evidenceTooLarge'); }
    super(message);
    this.name = 'PaperReadingError'; this.code = code; this.messageKey = key;
    Object.assign(this, details);
  }
}

export function requestsWholePaper(body = {}) {
  if (body.paper?.readingScope != null) return ['full', 'all'].includes(body.paper.readingScope);
  if (body.readingScope === 'all' || body.wholePaper === true) return true;
  return /全文|整篇|全篇|全文章|完整(?:阅读|读|总结|分析)|\b(?:whole|entire|full)\s+(?:paper|article|document|text)\b/i.test(String(body.question || ''));
}

function coverage(paper, pages, requiredPages, scope) {
  const segments = pages.map(p => ({ page: p.number, sourceOffset: p.sourceOffset || 0,
    sourceEnd: p.sourceEnd ?? p.text.length, sourceLength: p.sourceLength ?? p.text.length }));
  const completePages = segments.filter(s => s.sourceOffset === 0 && s.sourceEnd === s.sourceLength).map(s => s.page);
  return { providedPages: paper.pages.length, selectedPages: new Set(pages.map(p => p.number)).size,
    totalPages: paper.pageCount, partial: completePages.length !== paper.pageCount,
    scope, requiredPages, completePages, segments };
}
function batch(paper, pages, requiredPages, scope) {
  return { ...paper, readingScope: scope === 'all' ? 'full' : 'first30', pages, sourceCoverage: coverage(paper, pages, requiredPages, scope) };
}
function numbered(count) { return Array.from({ length: count }, (_, i) => i + 1); }
function segment(page, start, end) {
  return { ...page, text: page.text.slice(start, end), sourceOffset: start, sourceEnd: end,
    sourceLength: page.text.length, truncated: start !== 0 || end !== page.text.length };
}
function boundary(text, end) {
  return end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] || '') ? end - 1 : end;
}

// tokens is the PAPER allowance after instructions/history/question/output have
// been reserved by the caller. Every batch's full serialized paper fits it.
// Whole-paper requests require every physical page. Other requests require the
// first min(30,pageCount) plus current/selected pages, then use spare room for
// complete additional pages. No mandatory source text is silently excerpted.
export function planPaperReading(paper, body = {}, tokens) {
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new PaperReadingError('invalidBudget');
  const all = requestsWholePaper(body), scope = all ? 'all' : 'first30';
  const required = new Set(numbered(all ? paper.pageCount : body.legacyPartial ? 0 : Math.min(MIN_READING_PAGES, paper.pageCount)));
  // Only the current request determines extra mandatory pages/scope. The merged
  // paper can also contain cached pages from unrelated earlier questions.
  for (const page of body.paper?.pages || []) {
    if (Number.isSafeInteger(page.number) && page.number > 0 && page.number <= paper.pageCount) required.add(page.number);
  }
  for (const page of [body.currentPage, body.selectionPage]) if (Number.isSafeInteger(page) && page > 0 && page <= paper.pageCount) required.add(page);
  const requiredPages = [...required].sort((a, b) => a - b);
  const available = new Map(paper.pages.map(p => [p.number, p]));
  const missingPages = requiredPages.filter(n => !available.has(n));
  // A truncated client payload is not a complete source page either.
  const incompletePages = requiredPages.filter(n => {
    const p = available.get(n);
    return p && (p.truncated === true || (p.sourceOffset || 0) !== 0 || (p.sourceLength != null && p.sourceLength !== p.text.length));
  });
  if (missingPages.length || incompletePages.length) throw new PaperReadingError('missingPages', { missingPages, incompletePages, requiredPages });
  const fits = pages => estimateReadingTokens(JSON.stringify(batch(paper, pages, requiredPages, scope))) <= tokens;
  let selected = requiredPages.map(n => available.get(n));
  const finish = batches => ({ scope, requiredPages, selectedPages: selected.map(p => p.number), batches,
    requiresBatching: batches.length > 1, sourceCoverage: coverage(paper, selected, requiredPages, scope),
    estimatedBatchTokens: batches.map(b => estimateReadingTokens(JSON.stringify(b))) });
  if (fits(selected)) {
    // Add a prefix of complete optional pages using a logarithmic fit search.
    // Serializing the full payload once per page is quadratic on long papers.
    const optional = [...paper.pages].sort((a, b) => a.number - b.number).filter(p =>
      !required.has(p.number) && !p.truncated && !p.sourceOffset && (p.sourceLength == null || p.sourceLength === p.text.length));
    let low = 0, high = optional.length;
    const candidate = n => [...selected, ...optional.slice(0, n)].sort((a, b) => a.number - b.number);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(candidate(middle))) low = middle;
      else high = middle - 1;
    }
    selected = candidate(low);
    return finish([batch(paper, selected, requiredPages, scope)]);
  }
  const batches = []; let current = [];
  const flush = () => { if (current.length) { batches.push(batch(paper, current, requiredPages, scope)); current = []; } };
  for (const page of selected) {
    if (fits([...current, page])) { current.push(page); continue; }
    flush();
    if (fits([page])) { current.push(page); continue; }
    if (!page.text.length) throw new PaperReadingError('budgetTooSmall');
    let offset = 0;
    while (offset < page.text.length) {
      let low = offset, high = page.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits([segment(page, offset, middle)])) low = middle;
        else high = middle - 1;
      }
      const end = boundary(page.text, low);
      if (end <= offset) throw new PaperReadingError('budgetTooSmall');
      current = [segment(page, offset, end)]; flush(); offset = end;
    }
  }
  flush();
  return finish(batches);
}

// Read explicit capacity metadata only. Never guess a capacity from a model ID.
// Parent resolves which metadata object belongs to the selected model first.
export function capacityFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const values = [];
  const visit = (object, depth) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || depth > 3) return;
    for (const key of ['context_window', 'contextWindow', 'context_length', 'contextLength', 'max_context_length', 'max_context_tokens', 'maxContextTokens']) {
      const n = object[key];
      if (Number.isSafeInteger(n) && n > 0) values.push(n);
    }
    for (const key of ['limits', 'capabilities', 'metadata', 'model_info', 'top_provider']) visit(object[key], depth + 1);
  };
  visit(metadata, 0);
  return values.length ? Math.min(...values) : null;
}
