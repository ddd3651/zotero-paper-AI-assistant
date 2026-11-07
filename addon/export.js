/* Local, provider-independent exports. Only Markdown and bounded chart data enter the renderer. */
var PaperChatExport = {
  ns: 'http://www.w3.org/1999/xhtml',
  svgNS: 'http://www.w3.org/2000/svg',
  formats: ['html', 'svg', 'png'],
  font: 'sans-serif',
  error(key) { return new Error(PaperChatText.t(key)); },
  escape(value) {
    return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/gu, '')
      .replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  },
  parseChart(source) {
    if (typeof source !== 'string' || source.length > 10000) return null;
    let data;
    try { data = JSON.parse(source); } catch { return null; }
    const label = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v);
    if (!data || !label(data.title, 100)) return null;
    if (data.type === 'flow' && Array.isArray(data.steps) && data.steps.length >= 2 &&
        data.steps.length <= 10 && data.steps.every(s => label(s, 100))) {
      return { type: 'flow', title: data.title, steps: data.steps };
    }
    if (data.type === 'bar' && Array.isArray(data.items) && data.items.length >= 1 &&
        data.items.length <= 12 && data.items.every(i => i && label(i.label, 52) &&
          Number.isFinite(i.value) && Math.abs(i.value) <= 1e12) &&
        (data.unit == null || data.unit === '' || label(data.unit, 16))) {
      return { type: 'bar', title: data.title, items: data.items.map(({ label, value }) => ({ label, value })), unit: data.unit || '' };
    }
    return null;
  },
  wrap(text, width, measure) {
    const result = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      // Keep words together where possible; split CJK and overlong words on code points.
      for (const token of paragraph.match(/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []) {
        if (line && measure(line + token) > width) { result.push(line.trimEnd()); line = ''; }
        if (!line && /^\s+$/.test(token)) continue;
        if (measure(token) <= width) { line += token; continue; }
        for (const char of token) {
          if (line && measure(line + char) > width) { result.push(line); line = ''; }
          line += char;
        }
      }
      result.push(line.trimEnd());
    }
    return result;
  },
  text(x, y, value, size = 17, bold = false, extra = '') {
    return `<text x="${x}" y="${y}" font-size="${size}"${bold ? ' font-weight="700"' : ''}${extra}>${this.escape(value)}</text>`;
  },
  svg(width, height, body) {
    return `<svg xmlns="${this.svgNS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xml:space="preserve"><rect width="100%" height="100%" fill="#fff"/><g fill="#172333" font-family="${this.font}">${body}</g></svg>`;
  },
  diagram(chart, ctx) {
    const width = 800;
    let y = 32, body = '';
    ctx.font = '700 21px ' + this.font;
    for (const line of this.wrap(chart.title, width - 48, s => ctx.measureText(s).width)) {
      body += this.text(24, y, line, 21, true); y += 27;
    }
    if (chart.type === 'flow') {
      ctx.font = '17px ' + this.font;
      for (const [index, step] of chart.steps.entries()) {
        const lines = this.wrap(step, 650, s => ctx.measureText(s).width);
        const h = 22 * lines.length + 24;
        body += `<rect x="56" y="${y}" width="688" height="${h}" rx="8" fill="#edf4ff" stroke="#a8c4ea"/>`;
        lines.forEach((line, i) => { body += this.text(400, y + 26 + i * 22, line, 17, false, ' text-anchor="middle"'); });
        y += h;
        if (index < chart.steps.length - 1) {
          body += `<path d="M400 ${y + 3}v19m-5-5 5 5 5-5" stroke="#4675aa" fill="none"/>`; y += 27;
        }
      }
    } else {
      const low = Math.min(0, ...chart.items.map(i => i.value));
      const high = Math.max(0, ...chart.items.map(i => i.value));
      const x = v => 254 + 323 * (v - low) / (high - low || 1);
      const zero = x(0);
      const start = y;
      ctx.font = '16px ' + this.font;
      for (const { label, value } of chart.items) {
        const lines = this.wrap(label, 208, s => ctx.measureText(s).width);
        const h = Math.max(35, 20 * lines.length + 12);
        lines.forEach((line, i) => { body += this.text(24, y + 20 + i * 20, line, 16); });
        body += `<rect x="${Math.min(zero, x(value))}" y="${y + 6}" width="${Math.abs(x(value) - zero)}" height="20" rx="2" fill="#477fca"/>`;
        const metric = String(value) + (chart.unit ? ' ' + chart.unit : '');
        this.wrap(metric, 182, s => ctx.measureText(s).width).forEach((line, i) => {
          body += this.text(594, y + 20 + i * 20, line, 16);
        });
        y += Math.max(h, 20 * this.wrap(metric, 182, s => ctx.measureText(s).width).length + 12);
      }
      body += `<path d="M${zero} ${start}V${y}" stroke="#8498b1"/>`;
    }
    return { width, height: y + 17, body };
  },
  document(doc, entry, state) {
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 200000) throw this.error('export.tooLarge');
    const content = doc.createElementNS(this.ns, 'article');
    const charts = new WeakMap();
    let count = 0;
    const context = doc.createElementNS(this.ns, 'canvas').getContext('2d');
    content.append(PaperChatMarkdown.render(doc, entry.text, {
      pageCount: state.pageCount, allowedPages: state.allowedPages,
      renderCode: (lang, source) => {
        if (lang !== 'paper-chart' || count >= 12) return null;
        const spec = this.parseChart(source);
        if (!spec) return null;
        const chart = this.diagram(spec, context);
        const markup = this.svg(chart.width, chart.height, chart.body);
        const parsed = new doc.defaultView.DOMParser().parseFromString(markup, 'image/svg+xml');
        if (parsed.documentElement.namespaceURI !== this.svgNS) return null;
        const node = doc.importNode(parsed.documentElement, true);
        node.setAttribute('role', 'img'); node.setAttribute('aria-label', spec.title);
        charts.set(node, chart); count++;
        return node;
      },
    }));
    // A static export retains citation labels and quotes, and has no live navigation.
    for (const link of content.querySelectorAll('a')) {
      link.removeAttribute('href');
      if (link.classList.contains('pc-cite')) link.classList.add('paper-citation');
    }
    return { content, charts, context };
  },
  html(content) {
    return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
      '<title>' + this.escape(PaperChatText.t('export.title')) + '</title>' +
      '<style>body{color:#172333;background:#fff;margin:32px auto;padding:0 20px;max-width:850px;font:17px/1.65 sans-serif;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f4f6f8;padding:12px}blockquote{border-left:3px solid #becad8;margin-left:0;padding-left:14px}table{border-collapse:collapse}td,th{border:1px solid #cbd5e0;padding:6px 10px}svg{display:block;max-width:100%;height:auto;margin:12px 0}.paper-citation{color:#285f9e}.pc-table-scroll{overflow:auto}.pc-math-display{display:block;text-align:center;overflow:auto}</style></head><body>' +
      content.outerHTML + '</body></html>';
  },
  graphic({ content, charts, context }) {
    const width = 864, margin = 32;
    let y = 30, markup = '';
    const line = (value, { size = 17, depth = 0, bold = false } = {}) => {
      const x = margin + Math.min(depth, 10) * 18;
      context.font = `${bold ? '700 ' : ''}${size}px ${this.font}`;
      for (const row of this.wrap(value, width - margin - x, s => context.measureText(s).width)) {
        y += size + 8;
        if (y > 14000) throw this.error('export.imageTooLarge');
        markup += this.text(x, y, row, size, bold);
      }
      y += 5;
    };
    const flatten = node => {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.classList?.contains('pc-math')) return node.title || node.textContent;
      if (node.localName === 'br') return '\n';
      if (node.localName === 'input') return node.checked ? '[x] ' : '[ ] ';
      return Array.from(node.childNodes || [], flatten).join('');
    };
    const block = (node, depth = 0, prefix = '') => {
      if (node.nodeType === 3) { if (node.nodeValue.trim()) line(prefix + node.nodeValue, { depth }); return; }
      const chart = charts.get(node);
      if (chart) {
        markup += `<g transform="translate(${margin} ${y + 8})">${chart.body}</g>`;
        y += chart.height + 8;
        if (y > 14000) throw this.error('export.imageTooLarge');
        return;
      }
      const tag = node.localName;
      if (/^h[1-6]$/.test(tag)) { y += 8; line(flatten(node), { size: tag === 'h1' ? 25 : 21, depth, bold: true }); return; }
      if (tag === 'ol' || tag === 'ul') {
        Array.from(node.children).forEach((li, index) => {
          let marker = tag === 'ol' ? (Number(node.getAttribute('start') || 1) + index) + '. ' : '• ';
          for (const child of li.childNodes) { block(child, depth + 1, marker); marker = ''; }
        });
        return;
      }
      if (tag === 'table') {
        for (const row of node.querySelectorAll('tr')) {
          line(Array.from(row.children, flatten).join('  |  '), { depth, bold: row.firstElementChild?.localName === 'th' });
        }
        return;
      }
      if (tag === 'hr') { markup += `<path d="M32 ${y + 10}H832" stroke="#cbd5e0"/>`; y += 20; return; }
      if (['article', 'div', 'blockquote'].includes(tag)) {
        for (const child of node.childNodes) block(child, depth + (tag === 'blockquote' ? 1 : 0));
        return;
      }
      line(prefix + flatten(node), { depth });
    };
    block(content);
    if (y > 14000) throw this.error('export.imageTooLarge');
    return { width, height: y + 24, source: this.svg(width, y + 24, markup) };
  },
  async raster(doc, image, graphic) {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(graphic.source);
    image.src = url;
    await image.decode();
    const canvas = doc.createElementNS(this.ns, 'canvas');
    canvas.width = graphic.width; canvas.height = graphic.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw this.error('export.failed');
    return blob;
  },
  async save(win, format, data) {
    const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, PaperChatText.t('export.save'), Ci.nsIFilePicker.modeSave);
    picker.defaultString = 'paper-chat-answer.' + format;
    picker.defaultExtension = format;
    picker.appendFilter(format.toUpperCase(), '*.' + format);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return;
    if (format === 'png') await IOUtils.write(picker.file.path, new Uint8Array(await data.arrayBuffer()));
    else await IOUtils.writeUTF8(picker.file.path, data);
  },
  button(plugin, state, body) {
    const doc = body.ownerDocument;
    const button = plugin.el(doc, 'button', null, 'pc-copy-message pc-export-answer');
    button.type = 'button';
    button.title = PaperChatText.t('export.title'); button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', 'false');
    const svg = doc.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(this.svgNS, 'path');
    path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.7');
    svg.append(path); button.append(svg);
    button.addEventListener('click', () => {
      const entry = body._paperChatEntry;
      if (!entry?.text?.trim() || (entry.activity && entry.activity.status !== 'completed')) return;
      try { this.preview(plugin, state, entry, button); }
      catch (error) { state.error.textContent = error.message; }
    });
    return button;
  },
  htmlBlock(plugin, state, body, lang, source) {
    if (!/^(html|htm)$/i.test(lang || '')) return null;
    const doc = body.ownerDocument;
    const block = plugin.el(doc, 'div', null, 'pc-html-block');
    const card = this.playButton(plugin, state, body, source);
    card.className = 'pc-html-card';
    card.append(plugin.el(doc, 'span', PaperChatText.t('export.demo')));
    const pre = plugin.el(doc, 'pre'); pre.append(plugin.el(doc, 'code', source));
    const completed = !body._paperChatEntry?.activity || body._paperChatEntry.activity.status === 'completed';
    card.hidden = !completed; pre.hidden = completed;
    block.append(card, pre);
    return block;
  },
  refreshHTMLCards(body) {
    const completed = !body._paperChatEntry?.activity || body._paperChatEntry.activity.status === 'completed';
    for (const block of body.querySelectorAll?.('.pc-html-block') || []) {
      block.children[0].hidden = !completed;
      block.children[1].hidden = completed;
    }
  },
  playButton(plugin, state, body, source) {
    const doc = body.ownerDocument;
    const button = plugin.el(doc, 'button', null, 'pc-copy-message pc-play-html');
    button.type = 'button';
    button.title = PaperChatText.t('export.openHTML');
    button.setAttribute('aria-label', button.title);
    const svg = doc.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(this.svgNS, 'path');
    path.setAttribute('d', 'M8 5l11 7-11 7z'); path.setAttribute('fill', 'currentColor');
    svg.append(path); button.append(svg);
    button.addEventListener('click', async () => {
      const entry = body._paperChatEntry;
      if (button.disabled || !entry?.text?.trim() || (entry.activity && entry.activity.status !== 'completed')) return;
      button.disabled = true;
      try { await this.openHTML(source === undefined ? this.answerHTML(doc, entry, state) : this.interactiveHTML(source)); }
      catch (error) { state.error.textContent = error.message || PaperChatText.t('export.failed'); }
      finally { button.disabled = false; }
    });
    return button;
  },
  htmlSource(text) {
    if (typeof text !== 'string' || text.length > 200000) throw this.error('export.tooLarge');
    // Use the same Markdown parser as chat, so fence length and nesting agree.
    const blocks = [];
    const visit = tokens => {
      for (const token of tokens || []) {
        if (token.type === 'code' && /^(html|htm)$/i.test((token.lang || '').trim())) blocks.push(token.text);
        if (token.tokens) visit(token.tokens);
        if (token.items) for (const item of token.items) visit(item.tokens);
      }
    };
    visit(marked.lexer(text));
    if (blocks.length) return blocks.at(-1);
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) return text.trim();
    return null;
  },
  interactiveHTML(source) {
    // Run generated scripts only in an opaque browser frame, never Zotero chrome.
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    const inner = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + this.escape(policy) + '">' + source;
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + this.escape(PaperChatText.t('export.title')) + '</title>' +
      '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head>' +
      '<body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="HTML" srcdoc="' + this.escape(inner) + '"></iframe></body></html>';
  },
  answerHTML(doc, entry, state) {
    const source = this.htmlSource(entry.text);
    return source === null ? this.html(this.document(doc, entry, state).content) : this.interactiveHTML(source);
  },
  async openHTML(content) {
    // A unique owner-only local file; never send paper content to a web service.
    const file = Services.dirsvc.get('TmpD', Ci.nsIFile).clone();
    file.append('paper-chat-answer.html');
    file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    await IOUtils.writeUTF8(file.path, typeof content === 'string' ? content : this.html(content));
    const handler = Cc['@mozilla.org/uriloader/external-protocol-service;1']
      .getService(Ci.nsIExternalProtocolService).getProtocolHandlerInfo('http');
    handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
    handler.launchWithURI(Services.io.newFileURI(file), null);
    return file.path;
  },
  preview(plugin, state, entry, anchor) {
    const doc = state.panel.ownerDocument;
    const el = (tag, text, cls) => plugin.el(doc, tag, text, cls);
    state.exportClose?.(false);
    const menu = el('div', null, 'pc-export-menu');
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', PaperChatText.t('export.format'));
    anchor.parentElement.append(menu);
    const finish = (restore = true) => {
      menu.remove(); anchor.setAttribute('aria-expanded', 'false');
      if (state.exportClose === finish) state.exportClose = null;
      if (restore && anchor.isConnected) anchor.focus();
    };
    state.exportClose = finish;
    anchor.setAttribute('aria-expanded', 'true');
    for (const format of this.formats) {
      const button = el('button', format.toUpperCase()); button.type = 'button';
      menu.append(button);
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        for (const item of menu.children) item.disabled = true;
        try {
          if (format === 'html') await this.openHTML(source === undefined ? this.answerHTML(doc, entry, state) : this.interactiveHTML(source));
          else await this.inlineImage(plugin, state, anchor, format, this.document(doc, entry, state));
          finish();
        } catch (error) {
          state.error.textContent = error.message || PaperChatText.t('export.failed');
          for (const item of menu.children) item.disabled = false;
        }
      });
    }
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(); }
    });
    menu.firstElementChild.focus();
  },
  async inlineImage(plugin, state, anchor, format, rendered) {
    const doc = state.panel.ownerDocument;
    const el = (tag, text, cls) => plugin.el(doc, tag, text, cls);
    const graphic = this.graphic(rendered);
    const payload = format === 'svg' ? graphic.source : await this.raster(doc, el('img'), graphic);
    let source;
    if (format === 'svg') source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(payload);
    else source = await new Promise((resolve, reject) => {
      const reader = new doc.defaultView.FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(payload);
    });
    const image = el('img'); image.alt = format.toUpperCase(); image.src = source;
    await image.decode();
    if (state.disposed || !anchor.isConnected) return;
    const host = anchor.parentElement.parentElement;
    host.querySelector('.pc-inline-export')?.remove();
    const figure = el('div', null, 'pc-inline-export');
    const zoom = el('button', null, 'pc-image-zoom'); zoom.type = 'button';
    zoom.title = PaperChatText.t('export.zoom'); zoom.setAttribute('aria-label', zoom.title);
    zoom.append(image);
    const save = el('button', PaperChatText.t('export.save'), 'pc-image-save'); save.type = 'button';
    const download = async button => {
      button.disabled = true;
      try { await this.save(doc.defaultView, format, payload); }
      catch { state.error.textContent = PaperChatText.t('export.failed'); }
      finally { button.disabled = false; }
    };
    save.addEventListener('click', () => download(save));
    figure.append(zoom, save); host.append(figure);
    zoom.addEventListener('click', () => {
      state.exportClose?.(false);
      const overlay = el('div', null, 'pc-export-dialog');
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', PaperChatText.t('export.zoom'));
      const controls = el('div', null, 'pc-export-controls');
      const exportButton = el('button', PaperChatText.t('export.save')); exportButton.type = 'button';
      const close = el('button', PaperChatText.t('common.done')); close.type = 'button';
      const area = el('div', null, 'pc-export-content pc-image-full'); area.tabIndex = 0;
      const full = el('img'); full.src = source; full.alt = image.alt;
      area.append(full); controls.append(exportButton, close); overlay.append(controls, area);
      state.panel.append(overlay);
      const finish = (restore = true) => {
        overlay.remove(); if (state.exportClose === finish) state.exportClose = null;
        if (restore && zoom.isConnected) zoom.focus();
      };
      state.exportClose = finish;
      close.addEventListener('click', () => finish());
      exportButton.addEventListener('click', () => download(exportButton));
      overlay.addEventListener('keydown', event => {
        event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); finish(); }
      });
      close.focus();
    });
  },
};
