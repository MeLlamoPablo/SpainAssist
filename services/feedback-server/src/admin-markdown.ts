/**
 * A small Markdown renderer for the admin page's entry preview, as browser JavaScript embedded in
 * the page's inline script (so the CSP hash covers it). `markdown(text, h)` returns nodes built
 * with `h(tag, attrs, ...children)`; strings are text. It never produces HTML from the input, so
 * nothing in an entry can inject markup: unknown syntax stays visible as text, and links only
 * become anchors for http(s) URLs.
 *
 * Blocks: paragraphs (single newlines kept as line breaks), # headings, - / 1. lists, > quotes,
 * fenced code, --- rules. Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs.
 *
 * Written with String.raw: backslashes are literal and a backtick is spelled \x60.
 */
export const MARKDOWN_JS = String.raw`
function markdown(src, h) {
  const INLINE = /\x60([^\x60\n]+)\x60|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(^|[^\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}])|\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/gu;
  const UL = /^\s{0,3}[-*+]\s+(.*)$/;
  const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const FENCE = /^\s{0,3}\x60{3,}/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const blank = (line) => /^\s*$/.test(line);
  const starts = (line) =>
    FENCE.test(line) || HEAD.test(line) || QUOTE.test(line) || HR.test(line) || UL.test(line) || OL.test(line);

  const link = (url, children) =>
    /^https?:\/\//i.test(url)
      ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, ...children)
      : h('span', null, ...children);

  function inline(text) {
    const out = [];
    const re = new RegExp(INLINE.source, INLINE.flags);
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + (m[7] !== undefined ? m[6].length : 0);
      if (start > last) out.push(text.slice(last, start));
      if (m[1] !== undefined) out.push(h('code', null, m[1]));
      else if (m[2] !== undefined || m[3] !== undefined) out.push(h('strong', null, ...inline(m[2] ?? m[3])));
      else if (m[4] !== undefined) out.push(h('del', null, ...inline(m[4])));
      else if (m[5] !== undefined || m[7] !== undefined) out.push(h('em', null, ...inline(m[5] ?? m[7])));
      else if (m[8] !== undefined) out.push(link(m[9], inline(m[8])));
      else out.push(link(m[10], [m[10]]));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // Lines of one block, with their single newlines kept as line breaks.
  const lines = (list) => list.flatMap((line, i) => (i ? [h('br', null)] : []).concat(inline(line.trim())));

  const rows = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let m;
  while (i < rows.length) {
    const row = rows[i];
    if (blank(row)) { i++; continue; }
    if (FENCE.test(row)) {
      const code = [];
      i++;
      while (i < rows.length && !FENCE.test(rows[i])) code.push(rows[i++]);
      i++;
      blocks.push(h('pre', null, h('code', null, code.join('\n'))));
    } else if ((m = HEAD.exec(row))) {
      blocks.push(h('h4', { class: 'md-h' + m[1].length }, ...inline(m[2])));
      i++;
    } else if (HR.test(row)) {
      blocks.push(h('hr', null));
      i++;
    } else if (QUOTE.test(row)) {
      const inner = [];
      while (i < rows.length && (m = QUOTE.exec(rows[i]))) { inner.push(m[1]); i++; }
      blocks.push(h('blockquote', null, ...markdown(inner.join('\n'), h)));
    } else if (UL.test(row) || OL.test(row)) {
      const ordered = !UL.test(row);
      const item = ordered ? OL : UL;
      const first = ordered ? OL.exec(row)[1] : '1';
      const items = [];
      while (i < rows.length) {
        if ((m = item.exec(rows[i]))) items.push([ordered ? m[2] : m[1]]);
        else if (items.length && !blank(rows[i]) && !starts(rows[i])) items[items.length - 1].push(rows[i]);
        else break;
        i++;
      }
      const lis = items.map((parts) => h('li', null, ...lines(parts)));
      blocks.push(h(ordered ? 'ol' : 'ul', first !== '1' ? { start: first } : null, ...lis));
    } else {
      const para = [];
      while (i < rows.length && !blank(rows[i]) && (para.length === 0 || !starts(rows[i]))) para.push(rows[i++]);
      blocks.push(h('p', null, ...lines(para)));
    }
  }
  return blocks;
}
`;
