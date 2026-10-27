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
    const match = quote && chars ? PaperChatEvidence.matchQuote(chars, quote) : null;
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
    state.highlight = null;
    try { this.view(state)._iframeWindow.document.querySelectorAll('[data-paper-chat-highlight]').forEach(n => n.remove()); } catch {}
  },
  paintHighlight(state) {
    try {
      const win = this.view(state)._iframeWindow;
      win.document.querySelectorAll('[data-paper-chat-highlight]').forEach(n => n.remove());
      if (!state.highlight || state.disposed) return;
      const { page, rects } = state.highlight;
      const pageView = win.PDFViewerApplication.pdfViewer.getPageView(page - 1);
      if (!pageView?.div || !pageView.viewport) return;
      const layer = win.document.createElement('div');
      layer.setAttribute('data-paper-chat-highlight', 'true');
      layer.setAttribute('aria-label', PaperChatText.t("readerTools.text02"));
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden;';
      for (const rect of rects) {
        const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle(Components.utils.cloneInto(Array.from(rect), win));
        const mark = win.document.createElement('div');
        mark.style.cssText = `position:absolute;left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.max(1, Math.abs(x2 - x1))}px;height:${Math.max(2, Math.abs(y2 - y1))}px;background:rgba(255,210,30,.38);border-bottom:1px solid rgba(190,130,0,.65);border-radius:2px;`;
        layer.append(mark);
      }
      pageView.div.append(layer);
    } catch (error) { Zotero.logError(error); }
  },
  bindHighlight(state) {
    const eventBus = this.view(state)._iframeWindow.PDFViewerApplication.eventBus;
    const repaint = () => this.paintHighlight(state);
    for (const event of ['pagerendered', 'scalechanging', 'rotationchanging']) eventBus.on(event, repaint);
    state.highlightCleanup = () => {
      for (const event of ['pagerendered', 'scalechanging', 'rotationchanging']) eventBus.off(event, repaint);
      this.clearHighlight(state);
    };
  },
  async navigate(state, page, details = {}) {
    const serial = state.navigationSerial = (state.navigationSerial || 0) + 1;
    this.clearHighlight(state);
    state.error.textContent = '';
    await state.reader.navigate({ pageIndex: page - 1 });
    if (!details.quote) { state.status.textContent = PaperChatText.t("readerTools.text03"); return; }
    const data = await this.loadPage(state, page);
    const match = PaperChatEvidence.matchQuote(data.chars || [], details.quote);
    if (serial !== state.navigationSerial || state.disposed) return;
    if (!match?.rects?.length) { state.status.textContent = PaperChatText.t("readerTools.text04"); return; }
    state.highlight = { page, rects: match.rects };
    await state.reader.navigate({ position: { pageIndex: page - 1, rects: match.rects } });
    this.paintHighlight(state);
    state.status.textContent = PaperChatText.t("readerTools.text05");
  },
};
