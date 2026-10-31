/* PDF source positions, verified section labels, and transient citation highlights. */
var PaperChatReader = {
  async waitForReady(reader, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!reader._isUninitialized && !reader._isTabClosed) {
      const app = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication;
      if (app?.pdfDocument && app.eventBus) return true;
      if (Date.now() >= deadline) throw new Error(PaperChatText.t("readerTools.error01"));
      await Zotero.Promise.delay(50);
    }
    return false;
  },
  view(state) { return state.reader._internalReader._primaryView; },
  citationView(state) {
    const internal = state.reader._internalReader;
    // Zotero's public navigate() targets _lastView, which can be the secondary PDF.
    const last = internal._lastView;
    return last?._iframeWindow?.PDFViewerApplication ? last : this.view(state);
  },
  matchQuote(chars, quote) {
    const matches = this.findQuoteMatches(chars, quote);
    return matches.length === 1 ? matches[0] : null;
  },
  findQuoteMatches(chars, quote) {
    if (!Array.isArray(chars) || typeof quote !== 'string' || quote.length > 1500) return [];
    // Normalize only layout/typographic differences, never words, case, numbers or math.
    const typography = text => text.replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"')
      .replace(/\u2011/gu, '\u2010');
    const cjk = value => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value || '');
    const normalized = chars.map((char, index) => {
      if (typeof char?.u !== 'string') return char;
      const copy = { ...char, u: typography(char.u) };
      // A CJK line wrap does not introduce an English word separator. Keep paragraph breaks.
      if (!char.paragraphBreakAfter && char.lineBreakAfter && cjk(Array.from(char.u).at(-1))
        && cjk(Array.from(chars[index + 1]?.u || '')[0])) {
        copy.lineBreakAfter = false;
        copy.spaceAfter = false;
      }
      return copy;
    });
    let needle = typography(quote);
    const source = normalized.map(char => char?.u || '').join('');
    // Some model link titles contain literal \\n/\\r\\n. Decode just line breaks, and only
    // when the PDF itself has no such literal sequence (e.g. a code/string example).
    if (/\\[rn]/u.test(needle) && !/\\[rn]/u.test(source)) needle = needle.replace(/\\r\\n|\\[rn]/gu, '\n');
    needle = needle.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\r?\n(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1');
    return PaperChatEvidence.findQuotes(normalized, needle);
  },
  async loadPage(state, number) {
    if (state.rawPageCache.has(number)) return state.rawPageCache.get(number);
    const win = this.view(state)._iframeWindow;
    const pdf = win.PDFViewerApplication.pdfDocument;
    let data;
    if (typeof pdf.getPageData === 'function') data = await pdf.getPageData(Components.utils.cloneInto({ pageIndex: number - 1 }, win));
    else data = await (await pdf.getPage(number)).getTextContent();
    state.rawPageCache.set(number, data);
    state.pageCache.set(number, PaperChatCore.pageText(data));
    return data;
  },
  async loadOutline(state) {
    if (state.outlinePromise) return state.outlinePromise;
    state.outlinePromise = (async () => {
      const view = this.view(state);
      const pdf = view._iframeWindow.PDFViewerApplication.pdfDocument;
      state.pageCount = pdf.numPages;
      let outline = view._outline || state.reader._internalReader._state?.outline;
      if (!outline?.length && typeof pdf.getOutline2 === 'function') outline = await pdf.getOutline2();
      const entries = [];
      const walk = (items, path = []) => {
        for (const item of items || []) {
          const title = String(item.title || '').replace(/\s+/g, ' ').trim();
          const position = item.location?.position;
          const chain = [...path, title].filter(Boolean);
          if (title && Number.isInteger(position?.pageIndex)) entries.push({ title, path: chain, page: position.pageIndex + 1, rect: position.rects?.[0] });
          walk(item.items, chain);
        }
      };
      walk(outline);
      state.sections = entries;
      return entries;
    })().catch(error => { Zotero.logError(error); state.sections = []; return []; });
    return state.outlinePromise;
  },
  headingOffset(chars, entry) {
    if (!chars?.length || !entry.rect) return 0;
    const [x, y] = entry.rect;
    let best = 0, distance = Infinity;
    chars.forEach((char, index) => {
      const r = char.rect;
      if (!r) return;
      const d = Math.abs(r[0] - x) + Math.abs((r[1] + r[3]) / 2 - y) * 4;
      if (d < distance) { distance = d; best = index; }
    });
    return best;
  },
  sectionLabel(state, entry) {
    if (!entry) return '';
    const data = state.rawPageCache.get(entry.page);
    let number = '';
    if (data?.chars?.length && entry.rect) {
      const offset = this.headingOffset(data.chars, entry);
      let start = offset;
      while (start > 0 && !data.chars[start - 1].lineBreakAfter) start--;
      let line = '';
      for (let i = start; i < Math.min(data.chars.length, start + 180); i++) {
        const c = data.chars[i]; line += (c.u || '') + (c.spaceAfter ? ' ' : '');
        if (c.lineBreakAfter) break;
      }
      number = line.match(/^\s*((?:\d+|[A-Z])(?:\.\d+)*)(?:\s|(?=[A-Z]))/)?.[1] || '';
    }
    return `${number ? '§' + number + ' ' : ''}${entry.title}`;
  },
  sectionsForPage(state, page) {
    const list = (state.sections || []).filter(e => e.page === page);
    const previous = (state.sections || []).filter(e => e.page < page).at(-1);
    return previous ? [previous, ...list] : list;
  },
  sectionForQuote(state, page, quote) {
    const chars = state.rawPageCache.get(page)?.chars;
    const match = quote && chars ? this.matchQuote(chars, quote) : null;
    if (!match) return null;
    let found;
    for (const entry of state.sections || []) {
      if (entry.page < page || (entry.page === page && this.headingOffset(chars, entry) <= match.start)) found = entry;
      if (entry.page > page) break;
    }
    return found;
  },
  describeCitation(state, page, details = {}) {
    const precise = this.sectionForQuote(state, page, details.quote);
    const candidates = this.sectionsForPage(state, page);
    const section = precise || candidates.find(e => e.page === page) || candidates[0];
    const label = this.sectionLabel(state, section);
    const title = [PaperChatText.t("readerTools.format01", {page: (page)}), precise ? precise.path.join(' › ') : candidates.map(e => this.sectionLabel(state, e)).join(' / '),
      details.quote ? PaperChatText.t("readerTools.format02", {value1: (details.quote)}) : PaperChatText.t("readerTools.text01")].filter(Boolean).join('\n');
    return { label: PaperChatText.t("readerTools.format03", {page: (page), value2: (label ? ' · ' + label : '')}), title };
  },
  clearHighlight(state) {
    const highlightedView = state.highlight?.view;
    state.highlight = null;
    const internal = state.reader._internalReader;
    for (const view of new Set([internal._primaryView, internal._secondaryView, highlightedView])) {
      try { view?._iframeWindow?.document.querySelectorAll('[data-paper-chat-highlight]').forEach(n => n.remove()); } catch {}
    }
  },
  safeRects(rects, viewBox) {
    if (!Array.isArray(rects) || !rects.length) return false;
    const area = Array.isArray(viewBox) && viewBox.length === 4 && viewBox.every(Number.isFinite)
      ? Math.abs((viewBox[2] - viewBox[0]) * (viewBox[3] - viewBox[1])) : 0;
    return rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)
      && rect[2] > rect[0] && rect[3] > rect[1]
      && (!area || (rect[2] - rect[0]) * (rect[3] - rect[1]) <= area / 4));
  },
  paintHighlight(state) {
    try {
      const highlight = state.highlight;
      const win = (highlight?.view || this.view(state))._iframeWindow;
      win.document.querySelectorAll('[data-paper-chat-highlight]').forEach(n => n.remove());
      if (!highlight || state.disposed) return false;
      const { page, rects } = highlight;
      const pageView = win.PDFViewerApplication.pdfViewer.getPageView(page - 1);
      if (!pageView?.div || !pageView.viewport || !rects?.length) return false;
      const create = () => win.document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      const layer = create();
      layer.setAttribute('data-paper-chat-highlight', 'true');
      layer.setAttribute('aria-label', PaperChatText.t("readerTools.text02"));
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden;';
      for (const rect of rects) {
        if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return false;
        const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle(Components.utils.cloneInto(Array.from(rect), win));
        if (![x1, y1, x2, y2].every(Number.isFinite) || x1 === x2 || y1 === y2) return false;
        const area = pageView.viewport.width * pageView.viewport.height;
        // A bad glyph box must not turn a sentence citation into a whole-page highlight.
        if (Number.isFinite(area) && area > 0 && Math.abs((x2 - x1) * (y2 - y1)) > area / 4) return false;
        const mark = create();
        mark.style.cssText = `position:absolute;left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.max(1, Math.abs(x2 - x1))}px;height:${Math.max(2, Math.abs(y2 - y1))}px;background:rgba(255,210,30,.38);border-bottom:1px solid rgba(190,130,0,.65);border-radius:2px;`;
        layer.append(mark);
      }
      pageView.div.append(layer);
      if (highlight.pending) {
        highlight.pending = false;
        state.status.textContent = highlight.count > 1
          ? PaperChatText.t("readerTools.multipleMatches", { count: highlight.count })
          : PaperChatText.t("readerTools.text05");
      }
      return true;
    } catch (error) { Zotero.logError(error); return false; }
  },
  watchHighlightView(state, view) {
    const eventBus = view?._iframeWindow?.PDFViewerApplication?.eventBus;
    if (!eventBus || !state.highlightBindings || state.highlightBindings.has(eventBus)) return;
    const repaint = () => { if (state.highlight?.view === view) this.paintHighlight(state); };
    const events = ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging'];
    for (const event of events) eventBus.on(event, repaint);
    state.highlightBindings.set(eventBus, () => { for (const event of events) eventBus.off(event, repaint); });
  },
  bindHighlight(state) {
    state.highlightCleanup?.();
    state.highlightBindings = new Map();
    const internal = state.reader._internalReader;
    for (const view of [internal._primaryView, internal._secondaryView]) this.watchHighlightView(state, view);
    state.highlightCleanup = () => {
      for (const cleanup of state.highlightBindings.values()) cleanup();
      state.highlightBindings.clear();
      this.clearHighlight(state);
    };
  },
  async navigate(state, page, details = {}) {
    const serial = state.navigationSerial = (state.navigationSerial || 0) + 1;
    this.clearHighlight(state);
    state.error.textContent = '';
    const view = this.citationView(state);
    this.watchHighlightView(state, view);
    const navigate = location => typeof view.navigate === 'function' ? view.navigate(location) : state.reader.navigate(location);
    await navigate({ pageIndex: page - 1 });
    if (serial !== state.navigationSerial || state.disposed) return;
    if (!details.quote) { state.status.textContent = PaperChatText.t("readerTools.text03"); return; }
    const data = await this.loadPage(state, page);
    const matches = this.findQuoteMatches(data.chars || [], details.quote);
    if (serial !== state.navigationSerial || state.disposed) return;
    // A repeated abstract/introduction sentence is legitimate evidence at every occurrence.
    // Do not claim uniqueness or discard the other occurrences after dehyphenation.
    if (!matches.length || matches.some(match => !match.rects?.length)) {
      state.status.textContent = PaperChatText.t("readerTools.text04"); return;
    }
    const rects = matches.flatMap(match => match.rects);
    const viewport = view._iframeWindow?.PDFViewerApplication?.pdfViewer?.getPageView(page - 1)?.viewport;
    if (!this.safeRects(rects, data.viewBox || viewport?.viewBox)) {
      state.status.textContent = PaperChatText.t("readerTools.text04"); return;
    }
    state.highlight = { page, rects, view, count: matches.length, pending: true };
    // reader.navigate() does not await the inner PDF view's navigation/rendering.
    // Report success only once our persistent overlay is actually appended.
    state.status.textContent = PaperChatText.t("readerTools.format01", { page });
    // Scroll to a concrete sentence instead of the bounding box spanning both columns.
    // The persistent overlay below still displays every complete match on the page.
    await navigate({ position: { pageIndex: page - 1, rects: matches[0].rects } });
    if (serial !== state.navigationSerial || state.disposed) return;
    this.paintHighlight(state);
  },
};
