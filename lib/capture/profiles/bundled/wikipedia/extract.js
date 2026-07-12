// Wikipedia article extractor. root = node-html-parser document.
// Preserves inline <a> links (absolutized, citations dropped) so the distilled
// content stays navigable.
module.exports = ({ url, html, root }) => {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch (_) {
      return 'https://en.wikipedia.org';
    }
  })();

  const absolutize = (href) => {
    if (!href) return href;
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return origin + href;
    return href;
  };

  const hasClass = (el, name) =>
    ((el && el.getAttribute && el.getAttribute('class')) || '')
      .split(/\s+/)
      .includes(name);

  // Recursively render a node to HTML, keeping ONLY <a href> (absolutized,
  // page-internal #cite/#anchor links collapsed to plain text) and dropping
  // citation superscripts and everything else's markup.
  const linkify = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return esc(node.rawText); // text node
    if (node.nodeType !== 1) return ''; // comment, etc.
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'style' || tag === 'script') return '';
    if (tag === 'br') return ' ';
    if (tag === 'sup' && hasClass(node, 'reference')) return ''; // [1] markers
    const inner = node.childNodes.map(linkify).join('');
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return inner; // self/anchor link
      return `<a href="${esc(absolutize(href))}" target="_blank" rel="noopener">${inner}</a>`;
    }
    return inner;
  };

  const richText = (el) =>
    el ? el.childNodes.map(linkify).join('').replace(/\s+/g, ' ').trim() : '';

  const plain = (s) =>
    (s || '').replace(/\[\d+\]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  const title =
    plain(root.querySelector('h1#firstHeading')?.text) ||
    plain(root.querySelector('title')?.text).replace(/ - Wikipedia$/, '');

  const shortDescription = plain(root.querySelector('.shortdescription')?.text) || null;

  // Lead summary, first non-empty paragraphs, with links preserved.
  const summaryHtml = [];
  for (const p of root.querySelectorAll('.mw-parser-output > p')) {
    if (hasClass(p, 'mw-empty-elt')) continue;
    const t = richText(p);
    if (!t) continue;
    summaryHtml.push(t);
    if (summaryHtml.length >= 3) break;
  }

  // Infobox: key/value rows (two <td>), e.g. taxonomy ladder — values keep links.
  let infobox = null;
  const box = root.querySelector('table.infobox');
  if (box) {
    const facts = [];
    for (const tr of box.querySelectorAll('tr')) {
      if (tr.querySelector('img')) continue;
      const tds = tr.querySelectorAll('td');
      if (tds.length !== 2) continue;
      const key = plain(tds[0].text).replace(/:$/, '');
      const value = plain(tds[1].text);
      const valueHtml = richText(tds[1]);
      if (key && value && key.length <= 24) facts.push({ key, value, valueHtml });
    }
    const headText = plain(box.querySelector('th')?.text);
    const m = headText.match(/Temporal range:\s*(.+?)\s*Pre[^a-z]/i);
    const temporalRange = m ? m[1].trim() : null;
    infobox = { caption: title, temporalRange, facts };
  }

  // Primary image: infobox lead image (with its caption row), else first
  // content thumbnail. Thumb URLs are protocol-relative — absolutize them.
  let image = null;
  const imgEl =
    (box && box.querySelector('img')) ||
    root.querySelector('.mw-parser-output figure img') ||
    root.querySelector('.mw-parser-output img');
  if (imgEl) {
    let caption = plain(imgEl.getAttribute('alt')) || null;
    if (box) {
      const rows = box.querySelectorAll('tr');
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('img')) {
          const next = rows[i + 1];
          const c = next && !next.querySelector('img') ? plain(next.text) : '';
          // a real caption, not a "Kingdom:"-style taxonomy row
          if (c && !/^\w+:\s/.test(c)) caption = c;
          break;
        }
      }
    }
    image = {
      src: absolutize(imgEl.getAttribute('src') || ''),
      caption: caption || null,
      width: imgEl.getAttribute('width') || null,
      height: imgEl.getAttribute('height') || null,
    };
  }

  // Top-level section outline, linked to each heading's anchor.
  const SKIP = new Set([
    'See also', 'References', 'Notes', 'Citations', 'Footnotes',
    'Further reading', 'External links', 'Bibliography', 'Sources',
  ]);
  const sections = [];
  for (const h of root.querySelectorAll('.mw-heading2 h2')) {
    const t = plain(h.text);
    if (!t || SKIP.has(t)) continue;
    const id = h.getAttribute('id');
    sections.push({ title: t, href: id ? `${url}#${id}` : url });
  }

  return {
    kind: 'wikipedia',
    url,
    title,
    titleHref: url,
    shortDescription,
    image,
    summaryHtml,
    infobox,
    sections,
  };
};
