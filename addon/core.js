/* Shared pure helpers; no DOM or Zotero globals. */
var PaperChatCore = {
  pageText(data) {
    if (Array.isArray(data?.chars)) return data.chars.map(c =>
      (c.u || '') + (c.paragraphBreakAfter ? '\n\n' : c.lineBreakAfter ? '\n' : c.spaceAfter ? ' ' : '')
    ).join('').trim();
    if (Array.isArray(data?.items)) return data.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join('').trim();
    throw new Error(PaperChatText.t("core.error01"));
  },
  isAllowedPage(page, pageCount, allowedPages) {
    return Number.isSafeInteger(page) && page >= 1 && page <= pageCount
      && (!allowedPages || allowedPages.has(page));
  },
  citationParts(text, pageCount, allowedPages) {
    const parts = [];
    const re = /\[第\s*(\d+)\s*页\]/g;
    let pos = 0, match;
    while ((match = re.exec(text))) {
      if (match.index > pos) parts.push({ text: text.slice(pos, match.index) });
      const page = Number(match[1]);
      parts.push({ text: match[0], page: this.isAllowedPage(page, pageCount, allowedPages) ? page : null });
      pos = re.lastIndex;
    }
    if (pos < text.length) parts.push({ text: text.slice(pos) });
    return parts;
  },
};
