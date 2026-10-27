/* Render Marked tokens as DOM nodes. Model text is never inserted as HTML. */
var PaperChatMarkdown = {
  entityText(text) {
    return String(text || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, value) => {
      if (value[0] === '#') {
        const n = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[value.toLowerCase()] || whole;
    });
  },

  render(doc, text, { pageCount = 0, allowedPages, navigate, openLink, describeCitation } = {}) {
    const create = (tag, content) => {
      const el = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
      if (content != null) el.textContent = content;
      return el;
    };
    const fragment = doc.createDocumentFragment();
    const citation = (page, details, label) => {
      const description = describeCitation?.(page, { ...details });
      const link = create('a', typeof description?.label === 'string' ? description.label : label);
      link.className = 'pc-cite';
      link.href = '#';
      link.title = typeof description?.title === 'string' ? description.title
        : details.quote || PaperChatText.t("markdown.format01", {page: (page)});
      link.addEventListener('click', event => { event.preventDefault(); navigate?.(page, { ...details }); });
      return link;
    };
    const labelText = (tokens = []) => tokens.map(token => token.tokens ? labelText(token.tokens)
      : token.text ?? token.raw ?? '').join('');
    const appendText = (parent, text, allowCitations = true) => {
      if (!allowCitations) { parent.append(doc.createTextNode(this.entityText(text))); return; }
      for (const part of PaperChatCore.citationParts(this.entityText(text), pageCount, allowedPages)) {
        if (!part.page) { parent.append(doc.createTextNode(part.text)); continue; }
        parent.append(citation(part.page, {}, PaperChatText.t("markdown.format02", {value1: (part.page)})));
      }
    };
    const inline = (parent, tokens = [], allowLinks = true) => {
      for (const token of tokens) {
        switch (token.type) {
          case 'paper_math': parent.append(PaperChatMath.render(doc, token.tex, token.display)); break;
          case 'strong': case 'em': case 'del': {
            const el = create(token.type); inline(el, token.tokens, allowLinks); parent.append(el); break;
          }
          case 'codespan': parent.append(create('code', token.text)); break;
          case 'br': parent.append(create('br')); break;
          case 'link': {
            if (!allowLinks) { inline(parent, token.tokens, false); break; }
            const target = this.entityText(token.href);
            const match = /^paperchat:([1-9]\d*)$/.exec(target);
            const page = match ? Number(match[1]) : null;
            if (PaperChatCore.isAllowedPage(page, pageCount, allowedPages)) {
              const label = this.entityText(labelText(token.tokens));
              const quote = this.entityText(token.title);
              // Discard oversize quotes rather than turning a prefix into different evidence.
              const details = { quote: quote.length <= 1500 ? quote : '', section: label.match(/§\s*(.+)$/u)?.[1].trim() || '' };
              parent.append(citation(page, details, label)); break;
            }
            // Only explicit web links can open externally. Images never fetch remote content.
            const href = target.trim();
            if (!/^https?:\/\//i.test(href)) { inline(parent, token.tokens, false); break; }
            const link = create('a'); link.href = href;
            if (token.title) link.title = this.entityText(token.title);
            inline(link, token.tokens, false);
            link.addEventListener('click', event => { event.preventDefault(); openLink?.(href); });
            parent.append(link); break;
          }
          case 'image': appendText(parent, token.text || PaperChatText.t("markdown.image"), false); break;
          case 'html': parent.append(doc.createTextNode(token.raw)); break;
          default:
            if (token.tokens) inline(parent, token.tokens, allowLinks);
            else appendText(parent, token.text ?? token.raw ?? '', allowLinks);
        }
      }
    };
    const blocks = (parent, tokens = []) => {
      for (const token of tokens) {
        switch (token.type) {
          case 'paper_math': parent.append(PaperChatMath.render(doc, token.tex, token.display)); break;
          case 'space': break;
          case 'heading': {
            const el = create(`h${Math.min(6, Math.max(1, token.depth))}`); inline(el, token.tokens); parent.append(el); break;
          }
          case 'paragraph': case 'text': {
            const el = create('p');
            if (token.tokens) inline(el, token.tokens); else appendText(el, token.text);
            parent.append(el); break;
          }
          case 'list': {
            const list = create(token.ordered ? 'ol' : 'ul');
            if (token.ordered && token.start !== 1) list.setAttribute('start', String(token.start));
            for (const item of token.items) {
              const li = create('li');
              if (item.task) {
                const box = create('input'); box.type = 'checkbox'; box.disabled = true; box.checked = !!item.checked; li.append(box);
              }
              blocks(li, item.tokens); list.append(li);
            }
            parent.append(list); break;
          }
          case 'blockquote': {
            const quote = create('blockquote'); blocks(quote, token.tokens); parent.append(quote); break;
          }
          case 'code': {
            const pre = create('pre'); pre.append(create('code', token.text)); parent.append(pre); break;
          }
          case 'table': {
            const scroll = create('div'); scroll.className = 'pc-table-scroll'; scroll.tabIndex = 0;
            scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', PaperChatText.t("markdown.tableAria"));
            const table = create('table');
            const row = (cells, heading = false) => {
              const tr = create('tr');
              cells.forEach((cell, index) => {
                const td = create(heading ? 'th' : 'td');
                if (heading) td.setAttribute('scope', 'col');
                if (token.align[index]) td.style.textAlign = token.align[index];
                inline(td, cell.tokens); tr.append(td);
              }); return tr;
            };
            const head = create('thead'); head.append(row(token.header, true));
            const body = create('tbody'); token.rows.forEach(cells => body.append(row(cells)));
            table.append(head, body); scroll.append(table); parent.append(scroll); break;
          }
          case 'hr': parent.append(create('hr')); break;
          case 'html': { const el = create('p', token.raw); parent.append(el); break; }
          default: if (token.text) appendText(parent, token.text);
        }
      }
    };
    blocks(fragment, PaperChatMath.lex(text));
    return fragment;
  },
};
