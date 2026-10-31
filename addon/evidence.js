/* Exact PDF evidence matching; no DOM or Zotero globals. */
var PaperChatEvidence = (() => {
  // Only typographic ligatures are expanded. NFKC would also equate distinct math symbols.
  const ligatures = { '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };
  const letter = value => value != null && /^\p{L}$/u.test(value);
  const horizontalSpace = value => value != null && /^[^\S\r\n\u2028\u2029]$/u.test(value);
  const unitsFor = (text, index) => Array.from(text, value => ({ value, index }));
  // CJK words do not require surrounding spaces; letters, numbers and marks elsewhere do.
  const wordChar = value => /^[\p{L}\p{N}\p{M}_]$/u.test(value || '')
    && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(value);
  const lineBreak = /[\r\n\u2028\u2029]/u;

  const rangeRects = (chars, start, end) => {
    const rects = [];
    let run = null, previous = null;
    for (let index = start; index < end; index++) {
      const char = chars[index], raw = char.rect;
      if (!Array.isArray(raw) || raw.length !== 4 || !Array.from(raw).every(Number.isFinite)
        || (lineBreak.test(char.u) && !char.u.trim())) { run = previous = null; continue; }
      const rect = [Math.min(raw[0], raw[2]), Math.min(raw[1], raw[3]), Math.max(raw[0], raw[2]), Math.max(raw[1], raw[3])];
      if (rect[0] === rect[2] || rect[1] === rect[3]) { run = previous = null; continue; }
      const rawRotation = char.rotation ?? 0;
      const rotation = Number.isFinite(rawRotation) ? (rawRotation % 360 + 360) % 360 : null;
      let merge = run && previous && run.rotation === rotation && [0, 90, 180, 270].includes(rotation)
        && !previous.char.lineBreakAfter && !previous.char.paragraphBreakAfter
        && !lineBreak.test(previous.char.u) && !lineBreak.test(char.u);
      let direction = 0;
      if (merge) {
        const along = rotation === 90 || rotation === 270 ? 1 : 0, across = 1 - along;
        const anchor = run.anchor, last = previous.rect;
        const height = Math.min(anchor[across + 2] - anchor[across], rect[across + 2] - rect[across]);
        const overlap = Math.min(anchor[across + 2], rect[across + 2]) - Math.max(anchor[across], rect[across]);
        const centerShift = Math.abs(anchor[across] + anchor[across + 2] - rect[across] - rect[across + 2]) / 2;
        const gap = Math.max(last[along], rect[along]) - Math.min(last[along + 2], rect[along + 2]);
        direction = Math.sign(rect[along] + rect[along + 2] - last[along] - last[along + 2]);
        // Compare against the first glyph as well as the last, so rows cannot drift together.
        merge = overlap >= height * 0.6 && centerShift <= height * 0.3 && gap <= height * 0.5
          && (!direction || !run.direction || direction === run.direction);
      }
      if (merge) {
        for (let axis = 0; axis < 2; axis++) {
          run.rect[axis] = Math.min(run.rect[axis], rect[axis]);
          run.rect[axis + 2] = Math.max(run.rect[axis + 2], rect[axis + 2]);
        }
        if (direction) run.direction = direction;
      } else {
        rects.push(rect);
        run = { rect, anchor: rect.slice(), rotation, direction: 0 };
      }
      previous = { char, rect };
    }
    return rects;
  };

  const normalize = units => {
    const pieces = [], indices = [], origins = [];
    for (let i = 0; i < units.length; i++) {
      const { value, index } = units[i];
      if ((value === '-' || value === '\u2010' || value === '\u00ad') && letter(units[i - 1]?.value)) {
        let next = i + 1;
        while (horizontalSpace(units[next]?.value)) next++;
        if (['\r', '\n', '\u2028'].includes(units[next]?.value)) {
          if (units[next++].value === '\r' && units[next]?.value === '\n') next++;
          while (horizontalSpace(units[next]?.value)) next++;
          // One line break between letters is a word wrap; paragraph breaks are retained.
          if (letter(units[next]?.value)) { i = next - 1; continue; }
        }
      }
      if (value === '\u00ad') continue;
      const space = /^\s$/u.test(value);
      if (space && (!pieces.length || pieces[pieces.length - 1] === ' ')) continue;
      const normalized = space ? ' ' : ligatures[value] || value;
      pieces.push(normalized);
      // Map every UTF-16 offset, including expansions and surrogate pairs, back to chars.
      for (let j = 0; j < normalized.length; j++) { indices.push(index); origins.push(i); }
    }
    if (pieces[pieces.length - 1] === ' ') { pieces.pop(); indices.pop(); origins.pop(); }
    return { text: pieces.join(''), indices, origins };
  };

  return {
    // start is inclusive and end exclusive, both indexing the original getPageData().chars.
    // Quotes need at least eight non-whitespace code points and cannot cut through words.
    // rects are adjacent glyph bounds merged within one line and rotation, in PDF coordinates.
    matchQuote(charsOrData, quote) {
      const matches = this.findQuotes(charsOrData, quote);
      return matches.length === 1 ? matches[0] : null;
    },
    // All full, contiguous matches on this page, including normalized duplicates.
    // Callers must show every match or verify a narrower scope, never silently take [0].
    findQuotes(charsOrData, quote) {
      const chars = Array.isArray(charsOrData) ? charsOrData : charsOrData?.chars;
      if (!Array.isArray(chars) || typeof quote !== 'string' || !quote.length || quote.length > 1500) return [];
      const needle = normalize(unitsFor(quote, 0)).text;
      const points = Array.from(needle);
      if (points.filter(value => !/\s/u.test(value)).length < 8) return [];
      const units = [];
      for (let index = 0; index < chars.length; index++) {
        const char = chars[index];
        if (!char || typeof char.u !== 'string') return [];
        for (const unit of unitsFor(char.u, index)) units.push(unit);
        const after = char.paragraphBreakAfter ? '\n\n' : char.lineBreakAfter ? '\n' : char.spaceAfter ? ' ' : '';
        for (const unit of unitsFor(after, index)) units.push(unit);
      }
      const source = normalize(units);
      const matches = [];
      for (let offset = source.text.indexOf(needle); offset !== -1; offset = source.text.indexOf(needle, offset + 1)) {
        const end = offset + needle.length;
        // A match cannot start or end partway through a single expanded ligature or code point.
        if ((offset > 0 && source.origins[offset - 1] === source.origins[offset])
          || (end < source.text.length && source.origins[end - 1] === source.origins[end])) continue;
        const before = Array.from(source.text.slice(Math.max(0, offset - 2), offset)).pop();
        const after = end < source.text.length ? String.fromCodePoint(source.text.codePointAt(end)) : '';
        if ((wordChar(before) && wordChar(points[0])) || (wordChar(points[points.length - 1]) && wordChar(after))) continue;
        const start = source.indices[offset], finish = source.indices[end - 1] + 1;
        const rects = rangeRects(chars, start, finish);
        matches.push(rects.length ? { start, end: finish, rects } : { start, end: finish });
      }
      return matches;
    },
  };
})();
