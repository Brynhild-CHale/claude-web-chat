// The ONE markdown renderer — the prose Claude writes between and around panes
// (write_markdown → lib/server/domain/page). Two consumers, one implementation:
//
//   * the host: the glance preview and the offline export render a node's
//     markdown items server-side (require this module);
//   * the browser chrome: GET /app/markdown.js serves `browserModuleSource()`,
//     an ES module built from the SAME factory function's source text, so the
//     live surface cannot drift from the preview/export rendering of one item.
//
// That is why the renderer is a FACTORY taking its escaper: `createMarkdown` must
// stay self-contained — it may reference nothing outside its own body except the
// `escapeHtml` parameter, because the browser copy is `createMarkdown.toString()`
// spliced beside `escapeHtml.toString()` (lib/core/html). A closure over a
// module-level helper would work here and throw a ReferenceError in the browser;
// test/page-markdown.test.js evaluates the served module to pin that.
//
// The subset is deliberately small (the maintainer's page model, plan §2b D3/D4):
//   paragraphs · `#`–`###` headings · **strong** · *em* · `code` · fenced code
//   (```lang) · `- ` bullets and `1. ` numbered lists (flat) · [text](href)
// Everything else — raw HTML included — is TEXT: every character that reaches
// the output goes through escapeHtml, so a `<script>` in the markdown renders as
// the literal characters. Links are scheme-gated to http/https/mailto plus
// relative and fragment hrefs; a link whose href fails the gate renders as its
// label alone. `#`–`###` headings are what build the page's Contents nav, so
// `headings(text)` returns them with the same slug the rendered element carries
// (`data-slug`, never `id` — a heading must not be able to claim a chrome id).
//
// Authored ES5-ish apart from one unicode regex, like public/mount-runtime.js,
// because the export splices rendered output (not this code) and the chrome is
// an evergreen browser.

const { escapeHtml } = require('./html');

function createMarkdown(escapeHtml) {
  var SAFE_SCHEMES = { 'http:': 1, 'https:': 1, 'mailto:': 1 };

  // Scheme gate. Control characters and whitespace are stripped FIRST, exactly
  // as a browser's URL parser does before it reads the scheme — `java\tscript:`
  // is `javascript:` to the browser, so it must be to the gate too. A value with
  // no scheme is relative (or a #fragment) and navigates within the origin.
  function gateHref(raw) {
    var h = String(raw == null ? '' : raw).replace(/[\u0000-\u0020\u007f]+/g, '');
    if (!h) return '';
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(h);
    if (!m) return h;
    return SAFE_SCHEMES[m[1].toLowerCase() + ':'] ? h : '';
  }

  // Inline markup → HTML. Plain runs are escaped; the recognised spans recurse
  // into their inner text. Every opener must find its closer or it is literal.
  function inline(s) {
    var out = '';
    var plain = '';
    var i = 0;
    function flush() { if (plain) { out += escapeHtml(plain); plain = ''; } }
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && /[\\`*_\[\]()#+\-.!]/.test(s.charAt(i + 1))) {
        plain += s.charAt(i + 1); i += 2; continue;
      }
      if (c === '`') {
        var j = s.indexOf('`', i + 1);
        if (j > i) { flush(); out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>'; i = j + 1; continue; }
      }
      if (c === '[') {
        var lm = /^\[([^\]]*)\]\(([^()\s]*)\)/.exec(s.slice(i));
        if (lm) {
          flush();
          var href = gateHref(lm[2]);
          var label = inline(lm[1]);
          out += href
            ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
            : label;
          i += lm[0].length;
          continue;
        }
      }
      if (c === '*' && s.charAt(i + 1) === '*') {
        var k = s.indexOf('**', i + 2);
        if (k > i + 2) { flush(); out += '<strong>' + inline(s.slice(i + 2, k)) + '</strong>'; i = k + 2; continue; }
      }
      if (c === '*' && s.charAt(i + 1) !== ' ' && s.charAt(i + 1) !== '*') {
        var e = s.indexOf('*', i + 1);
        if (e > i + 1) { flush(); out += '<em>' + inline(s.slice(i + 1, e)) + '</em>'; i = e + 1; continue; }
      }
      plain += c;
      i++;
    }
    flush();
    return out;
  }

  // The visible text of an inline run — what a Contents entry shows.
  function plainText(s) {
    return String(s)
      .replace(/\[([^\]]*)\]\([^()\s]*\)/g, '$1')
      .replace(/\\([\\`*_\[\]()#+\-.!])/g, '$1')
      .replace(/[`*]/g, '')
      .trim();
  }

  function slugify(text) {
    var s = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return s || 'section';
  }

  // A heading line: one to three hashes, a space, the text (a closing run of
  // hashes is dropped, as CommonMark does). Four or more hashes is not a
  // heading in this subset and stays a paragraph.
  var HEADING_RE = /^(#{1,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  var FENCE_RE = /^[ \t]{0,3}```[ \t]*([\w+-]*)[^`]*$/;
  var BULLET_RE = /^[ \t]*[-*][ \t]+(.*)$/;
  var NUMBER_RE = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;

  function lines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  // Slugs are unique within one text: a repeat gets -1, -2, … appended.
  function slugger() {
    var seen = {};
    return function (text) {
      var base = slugify(text);
      var slug = base;
      var n = 0;
      while (Object.prototype.hasOwnProperty.call(seen, slug)) { n++; slug = base + '-' + n; }
      seen[slug] = 1;
      return slug;
    };
  }

  function renderMarkdown(text) {
    var ls = lines(text);
    var out = [];
    var para = [];
    var list = null; // { tag, start, items: [] }
    var nextSlug = slugger();

    function endPara() {
      if (para.length) { out.push('<p>' + inline(para.join('\n')) + '</p>'); para = []; }
    }
    function endList() {
      if (!list) return;
      var open = list.tag === 'ol' && list.start !== 1 ? '<ol start="' + list.start + '">' : '<' + list.tag + '>';
      out.push(open + list.items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</' + list.tag + '>');
      list = null;
    }

    for (var i = 0; i < ls.length; i++) {
      var line = ls[i];
      var fence = FENCE_RE.exec(line);
      if (fence) {
        endPara(); endList();
        var body = [];
        i++;
        while (i < ls.length && !/^[ \t]{0,3}```[ \t]*$/.test(ls[i])) { body.push(ls[i]); i++; }
        var cls = fence[1] ? ' class="lang-' + escapeHtml(fence[1]) + '"' : '';
        out.push('<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { endPara(); endList(); continue; }
      var h = HEADING_RE.exec(line);
      if (h) {
        endPara(); endList();
        var level = h[1].length;
        out.push('<h' + level + ' data-slug="' + escapeHtml(nextSlug(plainText(h[2]))) + '">' + inline(h[2]) + '</h' + level + '>');
        continue;
      }
      var b = BULLET_RE.exec(line);
      var o = b ? null : NUMBER_RE.exec(line);
      if (b || o) {
        endPara();
        var tag = b ? 'ul' : 'ol';
        if (list && list.tag !== tag) endList();
        if (!list) list = { tag: tag, start: o ? parseInt(o[1], 10) : 1, items: [] };
        list.items.push(b ? b[1] : o[2]);
        continue;
      }
      // An indented line straight after a list item continues that item.
      if (list && /^[ \t]+\S/.test(line)) {
        list.items[list.items.length - 1] += '\n' + line.trim();
        continue;
      }
      endList();
      para.push(line);
    }
    endPara(); endList();
    return out.join('\n');
  }

  // The `#`–`###` headings of one text, in order, with the slug renderMarkdown
  // stamps on each element. Fenced code is skipped: a `# comment` inside a code
  // block is not a section.
  function headings(text) {
    var ls = lines(text);
    var out = [];
    var nextSlug = slugger();
    var inFence = false;
    for (var i = 0; i < ls.length; i++) {
      if (inFence) { if (/^[ \t]{0,3}```[ \t]*$/.test(ls[i])) inFence = false; continue; }
      if (FENCE_RE.test(ls[i])) { inFence = true; continue; }
      var h = HEADING_RE.exec(ls[i]);
      if (!h) continue;
      var t = plainText(h[2]);
      out.push({ level: h[1].length, text: t, slug: nextSlug(t) });
    }
    return out;
  }

  return { renderMarkdown: renderMarkdown, headings: headings, slugify: slugify, gateHref: gateHref };
}

const api = createMarkdown(escapeHtml);

// The browser copy: an ES module assembled from the two functions' own source,
// so there is no second implementation to keep in step. Served by
// lib/server/routes/page.js at /app/markdown.js (beside the chrome's modules).
let browserSrc = null;
function browserModuleSource() {
  if (browserSrc == null) {
    browserSrc = [
      '// Generated from lib/core/markdown.js + lib/core/html.js — do not edit; see those files.',
      `const escapeHtml = ${escapeHtml.toString()};`,
      `const createMarkdown = ${createMarkdown.toString()};`,
      'const md = createMarkdown(escapeHtml);',
      'export const renderMarkdown = md.renderMarkdown;',
      'export const headings = md.headings;',
      'export const slugify = md.slugify;',
      'export default md;',
      '',
    ].join('\n');
  }
  return browserSrc;
}

module.exports = { ...api, createMarkdown, browserModuleSource };
