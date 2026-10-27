/* A PDF selection only offers an action. Stage its snapshot after an explicit click. */
var PaperChatSelection = {
  MAX_CHARS: 30000,
  _plugin: null,
  _listener: null,
  _readerAPI: null,
  _readers: new WeakMap(),
  _nodes: new Set(),
  _bindings: new WeakMap(),

  start(plugin) {
    if (typeof plugin?.captureSelection !== 'function') {
      throw new TypeError(PaperChatText.t("selection.error01"));
    }
    if (this._plugin === plugin && this._listener) return this;
    this.stop();
    const api = Zotero.Reader;
    const listener = event => {
      if (this._listener !== listener) return;
      try { this._render(event); }
      catch (error) { Zotero.logError?.(error); }
    };
    api.registerEventListener('renderTextSelectionPopup', listener, plugin.id);
    this._readerAPI = api;
    this._plugin = plugin;
    this._listener = listener;
    return this;
  },

  stop() {
    const listener = this._listener;
    this._listener = null;
    this._plugin = null;
    try {
      if (listener) this._readerAPI.unregisterEventListener('renderTextSelectionPopup', listener);
    } finally {
      for (const ref of this._nodes) this._remove(ref.deref());
      this._nodes.clear();
      this._readers = new WeakMap();
      this._bindings = new WeakMap();
      this._readerAPI = null;
    }
  },

  // Physical pages are one-based. pages, when present, is an inclusive [first, last] range.
  // Returns null for no selection; throws RangeError for > MAX_CHARS (UTF-16 code units).
  read(reader) {
    reader = this._chromeReader(reader);
    if (!reader || (reader._type && reader._type !== 'pdf')) return null;
    return this._fromView(reader._internalReader?._primaryView);
  },

  _chromeReader(reader) {
    if (!reader) return null;
    const readers = Zotero.Reader._readers;
    const instanceID = reader._instanceID;
    if (readers) {
      for (let i = 0; i < readers.length; i++) {
        const candidate = readers[i];
        if (candidate === reader || (instanceID != null && candidate._instanceID === instanceID)) return candidate;
      }
    }
    return reader;
  },

  _plain(value) {
    // Content Array#map/slice invoke content functions and can return content arrays.
    // Parse with this bootstrap global's JSON before any array callbacks or plugin calls.
    return value == null ? value : JSON.parse(JSON.stringify(value));
  },

  _copyPosition(position) {
    position = this._plain(position);
    if (!position || !Number.isSafeInteger(position.pageIndex) || position.pageIndex < 0) return null;
    return position;
  },

  _selection(annotation) {
    annotation = this._plain(annotation);
    if (typeof annotation?.text !== 'string' || !annotation.text.trim()) return null;
    if (annotation.text.length > this.MAX_CHARS) {
      throw new RangeError(PaperChatText.t("selection.format01", {value1: (annotation.text.length), value2: (this.MAX_CHARS)}));
    }
    const position = this._copyPosition(annotation.position);
    if (!position) return null;
    const page = position.pageIndex + 1;
    return {
      text: annotation.text, page, position,
      ...(position.nextPageRects?.length ? { pages: [page, page + 1] } : {}),
    };
  },

  _fromView(view) {
    if (!view) return null;
    const ranges = this._plain(view._selectionRanges);
    if (ranges?.[0]?.collapsed) return null;
    if (ranges?.length > 2) return this._fromRanges(ranges);
    const popup = view._selectionPopup?.annotation;
    if (popup) return this._selection(popup);
    return this._fromRanges(ranges);
  },

  _fromRanges(ranges) {
    if (!ranges?.length || ranges[0].collapsed) return null;
    if (ranges.some(range => !range || range.collapsed || typeof range.text !== 'string' || !this._copyPosition(range.position))) {
      throw new Error(PaperChatText.t("selection.error02"));
    }
    // Reproduce the helper's one/two-page text without calling a content-realm method.
    const sorted = ranges.slice().sort((a, b) => a.position.pageIndex - b.position.pageIndex);
    const position = this._copyPosition(sorted[0].position);
    if (sorted.length > 1) position.nextPageRects = this._plain(sorted[1].position.rects);
    const selection = this._selection({ text: sorted.map(range => range.text).join(sorted.length > 2 ? '\n' : ' '), position });
    if (selection && sorted.length > 1) selection.pages = [selection.page, sorted[sorted.length - 1].position.pageIndex + 1];
    return selection;
  },

  _eventSelection(reader, annotation) {
    annotation = this._plain(annotation);
    const selection = this._selection(annotation);
    if (!selection) return null;
    const internal = reader._internalReader;
    for (const view of [internal?._primaryView, internal?._secondaryView]) {
      const ranges = this._plain(view?._selectionRanges);
      if (!(ranges?.length > 2)) continue;
      let preview = this._plain(view._selectionPopup?.annotation);
      if (!preview) {
        const firstTwo = ranges.slice().sort((a, b) => a.position.pageIndex - b.position.pageIndex).slice(0, 2);
        preview = {
          text: firstTwo.map(range => range.text).join(' '),
          position: { ...firstTwo[0].position, nextPageRects: firstTwo[1].position.rects },
        };
      }
      // Never substitute another pane's selection for the official event payload.
      if (preview?.text === annotation.text && preview.position?.pageIndex === annotation.position.pageIndex
        && JSON.stringify(preview.position?.rects) === JSON.stringify(annotation.position.rects)
        && JSON.stringify(preview.position?.nextPageRects) === JSON.stringify(annotation.position.nextPageRects)) {
        return this._fromView(view);
      }
    }
    return selection;
  },

  _remove(node) {
    if (!node) return;
    const binding = this._bindings.get(node);
    try {
      if (binding?.click) node.removeEventListener('click', binding.click);
      if (binding?.mousedown) node.removeEventListener('mousedown', binding.mousedown);
      node.remove();
    } catch { /* A closed reader may already have destroyed its document. */ }
    if (binding) this._nodes.delete(binding.ref);
    this._bindings.delete(node);
  },

  _track(reader, node, binding = {}) {
    // Weak references allow closed reader documents and their callbacks to be collected.
    for (const ref of this._nodes) if (!ref.deref()) this._nodes.delete(ref);
    binding.ref = new WeakRef(node);
    this._nodes.add(binding.ref);
    this._bindings.set(node, binding);
    this._readers.set(reader, node);
  },

  _render(event) {
    const { doc, append } = event;
    const reader = this._chromeReader(event.reader);
    if (!reader || (reader._type && reader._type !== 'pdf')) return;
    this._remove(this._readers.get(reader));
    this._readers.delete(reader);
    if (!doc || typeof append !== 'function') return;
    let selection;
    try {
      selection = this._eventSelection(reader, event.params?.annotation);
    } catch (error) {
      const notice = doc.createElement('span');
      notice.setAttribute('role', 'alert');
      notice.textContent = error.message;
      append(notice);
      this._track(reader, notice);
      return;
    }
    if (!selection) return;
    const plugin = this._plugin;
    const listener = this._listener;
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = PaperChatText.t("common.askAI");
    button.title = PaperChatText.t("selection.text01");
    button.setAttribute('data-paper-chat-selection', 'true');
    button.setAttribute('data-tabstop', '1');
    const capture = focus => {
      if (this._listener !== listener) return;
      try {
        const result = plugin.captureSelection(reader, this._plain(selection), focus);
        if (result?.then) Promise.resolve(result).catch(report);
      } catch (error) { report(error); }
    };
    const report = error => {
      if (this._listener !== listener) return;
      button.textContent = error?.message || String(error);
      button.setAttribute('role', 'alert');
      const localError = new Error(button.textContent);
      localError.stack = String(error?.stack || error);
      Zotero.logError?.(localError);
    };
    const mousedown = e => { e.preventDefault(); e.stopPropagation(); };
    const click = e => { e.preventDefault(); e.stopPropagation(); capture(true); };
    button.addEventListener('mousedown', mousedown);
    button.addEventListener('click', click);
    append(button);
    this._track(reader, button, { click, mousedown });
  },
};
