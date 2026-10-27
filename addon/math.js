/* Recognize TeX before Markdown consumes backslashes, then render local MathML. */
var PaperChatMath = {
  cache: new Map(),
  escaped(src, pos) {
    let count = 0;
    while (pos > 0 && src[--pos] === '\\') count++;
    return count % 2 === 1;
  },
  token(src, block = false) {
    const prefix = block ? (src.match(/^ {0,3}/)?.[0] || '') : '';
    const rest = src.slice(prefix.length);
    const pair = [['\\[', '\\]', true], ['$$', '$$', true], ['\\(', '\\)', false], ['$', '$', false]]
      .find(([open, , display]) => rest.startsWith(open) && (!block || display));
    if (!pair) return;
    const [open, close, display] = pair;
    if (open === '$' && /[\s$]/.test(rest[1] || ' ')) return;
    let end = open.length;
    while ((end = rest.indexOf(close, end)) !== -1) {
      if (!this.escaped(rest, end) && (open !== '$' || (!/\s/.test(rest[end - 1]) && !/[\d$]/.test(rest[end + 1] || '')))) {
        const tex = rest.slice(open.length, end);
        if (!tex.trim() || (!display && tex.includes('\n'))) return;
        const raw = prefix + rest.slice(0, end + close.length);
        return { type: 'paper_math', raw, tex, display };
      }
      end += close.length;
    }
  },
  lex(text) {
    if (!this.parser) {
      const self = this;
      this.parser = new marked.Marked({ gfm: true, breaks: false, extensions: [
        { name: 'paper_math_block', level: 'block', start(src) { return src.search(/^(?: {0,3})(?:\\\[|\$\$)/m); }, tokenizer(src) { return self.token(src, true); } },
        { name: 'paper_math_inline', level: 'inline', start(src) { return src.search(/\\[([]|\$/); }, tokenizer(src) { return self.token(src); } },
      ] });
    }
    return this.parser.lexer(text);
  },
  markup(tex, display) {
    if (tex.length > 20000) throw new Error(PaperChatText.t("math.error01"));
    const key = `${display}:${tex}`;
    if (!this.cache.has(key)) {
      const markup = katex.renderToString(tex, { output: 'mathml', displayMode: display,
        trust: false, throwOnError: true, strict: 'ignore', maxExpand: 1000, maxSize: 15, macros: {} });
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, markup);
    }
    return this.cache.get(key);
  },
  render(doc, tex, display) {
    const htmlNS = 'http://www.w3.org/1999/xhtml';
    const mathNS = 'http://www.w3.org/1998/Math/MathML';
    try {
      const parsed = new doc.defaultView.DOMParser().parseFromString(this.markup(tex, display), 'application/xml');
      const math = parsed.getElementsByTagNameNS(mathNS, 'math')[0];
      if (!math) throw new Error(PaperChatText.t("math.error02"));
      // Only the MathML subset is copied; model HTML, links and events never enter the document.
      const tags = new Set('math semantics annotation mrow mi mn mo mtext mspace ms mstyle mfrac msqrt mroot msup msub msubsup mover munder munderover mtable mtr mtd mpadded mphantom menclose mmultiscripts mprescripts none'.split(' '));
      const attrs = new Set('display mathvariant mathsize mathcolor mathbackground displaystyle scriptlevel stretchy symmetric fence separator lspace rspace maxsize minsize largeop movablelimits accent accentunder columnalign columnspacing rowalign rowspacing columnlines rowlines frame align notation width height depth voffset encoding'.split(' '));
      const copy = node => {
        if (node.nodeType === 3) return doc.createTextNode(node.nodeValue);
        if (node.namespaceURI !== mathNS || !tags.has(node.localName)) return null;
        const target = doc.createElementNS(mathNS, node.localName);
        for (const attr of node.attributes) if (attrs.has(attr.name)) target.setAttribute(attr.name, attr.value);
        for (const child of node.childNodes) { const safe = copy(child); if (safe) target.append(safe); }
        return target;
      };
      const wrapper = doc.createElementNS(htmlNS, 'span');
      wrapper.className = `pc-math pc-math-${display ? 'display' : 'inline'}`;
      wrapper.title = tex;
      wrapper.append(copy(math));
      return wrapper;
    } catch (error) {
      const fallback = doc.createElementNS(htmlNS, 'code');
      fallback.className = 'pc-math-error';
      fallback.textContent = tex;
      fallback.title = PaperChatText.t("math.format01", {value1: (error.message)});
      return fallback;
    }
  },
};
