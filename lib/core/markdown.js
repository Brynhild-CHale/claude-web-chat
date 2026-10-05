// The ONE markdown renderer — the prose Claude writes between and around panes
// (write_markdown → lib/server/domain/page), and the replies the chat mirror
// shows. Two consumers, one implementation:
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
// TWO FLAVOURS, one parser. `renderMarkdown(text)` (or any option but
// `{flavor: 'chat'}`) is the PAGE flavour, and its output is frozen byte for
// byte: test/markdown-chat.test.js replays test/fixtures/markdown-page-golden.json
// (recorded before the chat flavour existed) through it, here and through the
// served module. `renderMarkdown(text, {flavor: 'chat'})` is the CHAT flavour
// the mirror renders Claude's replies with (spec §7.11); it is the same block
// loop and the same inline scanner with more branches switched on, never a
// second parser.
//
// The page subset is deliberately small (the maintainer's page model, plan
// §2b D3/D4):
//   paragraphs · `#`–`###` headings (all three render; only `#`/`##` get a
//   Contents row) · **strong** · *em* · `code` · fenced code (```lang) · `- `
//   bullets and `1. ` numbered lists (flat) · [text](href)
// The chat flavour adds: headings to six levels (with neither `data-slug` nor
// `id` — a chat heading is not a page section), GFM tables with alignment (at
// most 200 body rows × 30 columns, else the block as <pre>), task items as the
// glyphs ☐/☑ (never form controls), lists nested to depth 4 and quotes to
// depth 3 (deeper levels flatten into the deepest), `---` rules, ~~strike~~,
// bare http(s):// autolinks, images through `gateImg`, `diff`/`patch` fences
// through `renderDiff`, and `mermaid` fences as labelled source (spec Q6: it
// renders in 0.8.6). Its output is wrapped in one `<div class="md-chat">` (the
// app.css section's scope), and an input over 200,000 characters renders the
// first 200,000 and a note.
//
// Everything else — raw HTML included — is TEXT: every character that reaches
// the output goes through escapeHtml, so a `<script>` in the markdown renders as
// the literal characters. Links are scheme-gated to http/https/mailto plus
// relative and fragment hrefs; a link whose href fails the gate renders as its
// label alone. `#`/`##` headings are what build the page's Contents nav (`###`
// is a sub-heading with no row — the chrome's outline drops it), so
// `headings(text)` returns every page heading with the same slug the rendered
// element carries (`data-slug`, never `id` — a heading must not be able to claim
// a chrome id). headings() is the page's alone: the chat flavour has no outline.
//
// Images (chat only): the chrome has no CSP (lib/core/theme-values.js), so this
// engine is the only thing between a reply and a request to a third party.
// `gateImg` lets an <img> load only the mirror's own attachment route or a
// small base64 data:image (an <img> runs no script, svg+xml included); a remote
// http(s) image becomes a click-to-load placeholder (span.md-img-remote with
// the URL in data-src — the stream owns the click), and anything else shows
// its alt text.
//
// Authored ES5-ish apart from one unicode regex, like public/mount-runtime.js,
// because the export splices rendered output (not this code) and the chrome is
// an evergreen browser. Non-ASCII characters the CODE needs are written as \u
// escapes; keep them that way (an authoring tool once turned typed escapes
// into raw characters, and gateHref's control-character class must stay one).
//
// The browser module is memoised per process (browserSrc below): an edit to
// this file reaches the chrome only after `claude-web-chat restart` AND a
// refresh.

const { escapeHtml } = require('./html');

function createMarkdown(escapeHtml) {
  var SAFE_SCHEMES = { 'http:': 1, 'https:': 1, 'mailto:': 1 };

  // The chat flavour's caps (spec §7.11).
  var CHAT_MAX_CHARS = 200000;
  var TABLE_MAX_ROWS = 200;
  var TABLE_MAX_COLS = 30;
  var LIST_MAX_DEPTH = 4;
  var QUOTE_MAX_DEPTH = 3;
  var DIFF_MAX_LINES = 5000;
  var IMG_DATA_MAX = 1048576;

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

  // Image gate (chat flavour). The same control-character strip as gateHref,
  // then exactly three answers:
  //   {kind: 'img', src}    — the mirror's attachment route, or a base64
  //                           data:image of an allowed type up to 1 MiB;
  //   {kind: 'remote', src} — an http(s) URL: never loaded by the engine, a
  //                           click-to-load placeholder carries it;
  //   {kind: 'alt', src: ''} — anything else: show the alt text.
  // The attachment id grammar is the mirror model's (lib/server/mirror/model.js
  // ID_RE): it starts with a letter or digit, so no `..` segment can walk the
  // URL off the attachment route.
  var ATTACHMENT_RE = /^\/api\/mirror\/items\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/attachments\/\d{1,6}$/;
  var DATA_IMG_RE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+\/]*={0,2}$/i;
  function gateImg(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\u0000-\u0020\u007f]+/g, '');
    if (ATTACHMENT_RE.test(s)) return { kind: 'img', src: s };
    if (s.length <= IMG_DATA_MAX && DATA_IMG_RE.test(s)) return { kind: 'img', src: s };
    if (/^https?:\/\/[^\/?#]/i.test(s)) return { kind: 'remote', src: s };
    return { kind: 'alt', src: '' };
  }

  // A bare http(s):// URL inside chat text. Trailing punctuation that closes the
  // sentence (or an unbalanced `)`) is not part of the URL, as GFM trims it.
  var AUTOLINK_RE = /^https?:\/\/[^\s<>"'`\u0000-\u001f\u007f]+/i;
  function trimUrl(u) {
    for (;;) {
      var last = u.charAt(u.length - 1);
      if ('.,;:!?*_~\'"'.indexOf(last) >= 0) { u = u.slice(0, -1); continue; }
      if (last === ')' && u.split(')').length > u.split('(').length) { u = u.slice(0, -1); continue; }
      return u;
    }
  }

  var LINK_TAIL_RE = /\(([^()\s]*)\)/y;
  var PAGE_ESC_RE = /[\\`*_\[\]()#+\-.!]/;
  var CHAT_ESC_RE = /[\\`*_\[\]()#+\-.!~|>]/;

  // Inline markup → HTML. Plain runs are escaped; the recognised spans recurse
  // into their inner text. Every opener must find its closer or it is literal.
  // `chat` switches on the chat flavour's spans (images, ~~strike~~, autolinks);
  // `inLink` keeps a link's label from growing a second, nested link.
  function inline(s, chat, inLink) {
    var out = '';
    var plain = '';
    var i = 0;
    function flush() { if (plain) { out += escapeHtml(plain); plain = ''; } }
    // `[label](href)` at i, exactly /^\[([^\]]*)\]\(([^()\s]*)\)/ — but the
    // first `]` after i and the `(href)` after it are found once and reused
    // while i walks up to that `]`, so a run of unclosed `[` costs one scan,
    // not one scan per bracket.
    var close = -2;
    var tail;
    function linkAt(at) {
      if (close !== -1 && close <= at) { close = s.indexOf(']', at + 1); tail = undefined; }
      if (close < 0) return null;
      if (tail === undefined) { LINK_TAIL_RE.lastIndex = close + 1; tail = LINK_TAIL_RE.exec(s); }
      if (!tail) return null;
      return { label: s.slice(at + 1, close), href: tail[1], end: close + 1 + tail[0].length };
    }
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && (chat ? CHAT_ESC_RE : PAGE_ESC_RE).test(s.charAt(i + 1))) {
        plain += s.charAt(i + 1); i += 2; continue;
      }
      if (c === '`') {
        var j = s.indexOf('`', i + 1);
        if (j > i) { flush(); out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>'; i = j + 1; continue; }
      }
      if (chat && c === '!' && s.charAt(i + 1) === '[') {
        var im = linkAt(i + 1);
        if (im) { flush(); out += image(im.label, im.href); i = im.end; continue; }
      }
      if (c === '[') {
        var lm = linkAt(i);
        if (lm) {
          flush();
          var href = gateHref(lm.href);
          var label = inline(lm.label, chat, true);
          out += href && !inLink
            ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
            : label;
          i = lm.end;
          continue;
        }
      }
      if (chat && !inLink && (c === 'h' || c === 'H') && !/[A-Za-z0-9]/.test(s.charAt(i - 1))) {
        var am = AUTOLINK_RE.exec(s.slice(i, i + 4096));
        var url = am ? trimUrl(am[0]) : '';
        var ahref = url && /^https?:\/\/[^\/?#]/i.test(url) ? gateHref(url) : '';
        if (ahref) {
          flush();
          out += '<a href="' + escapeHtml(ahref) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
          i += url.length;
          continue;
        }
      }
      if (c === '*' && s.charAt(i + 1) === '*') {
        var k = s.indexOf('**', i + 2);
        if (k > i + 2) { flush(); out += '<strong>' + inline(s.slice(i + 2, k), chat, inLink) + '</strong>'; i = k + 2; continue; }
      }
      if (c === '*' && s.charAt(i + 1) !== ' ' && s.charAt(i + 1) !== '*') {
        var e = s.indexOf('*', i + 1);
        if (e > i + 1) { flush(); out += '<em>' + inline(s.slice(i + 1, e), chat, inLink) + '</em>'; i = e + 1; continue; }
      }
      if (chat && c === '~' && s.charAt(i + 1) === '~') {
        var d = s.indexOf('~~', i + 2);
        if (d > i + 2) { flush(); out += '<del>' + inline(s.slice(i + 2, d), chat, inLink) + '</del>'; i = d + 2; continue; }
      }
      plain += c;
      i++;
    }
    flush();
    return out;
  }

  // One chat image, through gateImg. Alt text is the label's visible text.
  function image(alt, src) {
    var text = plainText(alt);
    var g = gateImg(src);
    if (g.kind === 'img') return '<img src="' + escapeHtml(g.src) + '" alt="' + escapeHtml(text) + '" loading="lazy">';
    if (g.kind === 'remote') {
      return '<span class="md-img-remote" data-src="' + escapeHtml(g.src) + '" role="button" tabindex="0">'
        + escapeHtml(text || 'image') + '</span>';
    }
    return text ? '<span class="md-img-alt">' + escapeHtml(text) + '</span>' : '';
  }

  // The visible text of an inline run — what a Contents entry shows.
  // (The link pass runs only when a `](` exists: with none it matches nothing,
  // and skipping it keeps a long run of unclosed `[` from costing n² steps.)
  function plainText(s) {
    s = String(s);
    if (s.indexOf('](') >= 0) s = s.replace(/\[([^\]]*)\]\([^()\s]*\)/g, '$1');
    return s
      .replace(/\\([\\`*_\[\]()#+\-.!])/g, '$1')
      .replace(/[`*]/g, '')
      .trim();
  }

  function slugify(text) {
    var s = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return s || 'section';
  }

  // A heading line: hashes, a space, the text (a closing run of hashes is
  // dropped, as CommonMark does). The ONE heading regex of the engine: the page
  // flavour (and headings()) keeps levels 1–3 and treats four to six hashes as
  // the paragraph they always were; the chat flavour renders all six. Seven or
  // more hashes is never a heading.
  var HEADING_RE = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  var PAGE_MAX_LEVEL = 3;
  var FENCE_RE = /^[ \t]{0,3}```[ \t]*([\w+-]*)[^`]*$/;
  var FENCE_END_RE = /^[ \t]{0,3}```[ \t]*$/;
  var BULLET_RE = /^[ \t]*[-*][ \t]+(.*)$/;
  var NUMBER_RE = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;
  // The chat flavour's list item: the indent is kept (it decides the nesting)
  // and `+` is a bullet too.
  var CHAT_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
  var TASK_RE = /^\[([ xX])\](?:[ \t]+([\s\S]*))?$/;
  var RULE_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var QUOTE_RE = /^[ \t]{0,3}>/;
  var TABLE_DELIM_CELL_RE = /^:?-+:?$/;

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

  // Tabs count as four columns of indent.
  function indentOf(ws) { return ws.replace(/\t/g, '    ').length; }

  // A GFM table row's cells: the outer pipes are optional, `\|` is a literal
  // pipe (inline() unescapes it), and every cell is trimmed.
  function tableCells(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\' && s.charAt(i + 1) === '|') { cur += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  // The delimiter row under a table's header: its alignments, or null.
  function tableAligns(line) {
    if (line == null || line.indexOf('|') < 0 || !/-/.test(line)) return null;
    var cells = tableCells(line);
    var aligns = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!TABLE_DELIM_CELL_RE.test(c)) return null;
      var l = c.charAt(0) === ':';
      var r = c.charAt(c.length - 1) === ':';
      aligns.push(l && r ? 'center' : r ? 'right' : l ? 'left' : '');
    }
    return aligns;
  }

  function renderTable(header, aligns, rows) {
    function cell(tag, text, a) {
      var style = aligns[a] ? ' style="text-align:' + aligns[a] + '"' : '';
      return '<' + tag + style + '>' + inline(text, true) + '</' + tag + '>';
    }
    function row(tag, cells) {
      var out = '';
      for (var a = 0; a < aligns.length; a++) out += cell(tag, cells[a] == null ? '' : cells[a], a);
      return '<tr>' + out + '</tr>';
    }
    var body = rows.map(function (r) { return row('td', r); }).join('');
    return '<div class="md-table"><table><thead>' + row('th', header) + '</thead>'
      + (body ? '<tbody>' + body + '</tbody>' : '') + '</table></div>';
  }

  // The chat flavour's nested list: items carry their indent; an item indented
  // past its predecessor opens a list inside it, down to LIST_MAX_DEPTH, below
  // which deeper items flatten into the deepest list.
  function renderChatList(items) {
    var root = { lists: [] };
    var stack = []; // { indent, list, owner }
    function open(owner, it) {
      var last = owner.lists[owner.lists.length - 1];
      if (last && last.tag === it.tag && owner !== root) return last;
      var list = { tag: it.tag, start: it.start, items: [] };
      owner.lists.push(list);
      return list;
    }
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      while (stack.length && it.indent < stack[stack.length - 1].indent) stack.pop();
      var top = stack[stack.length - 1];
      if (!top) {
        stack.push({ indent: it.indent, list: open(root, it), owner: root });
      } else if (it.indent > top.indent && stack.length < LIST_MAX_DEPTH) {
        var parent = top.list.items[top.list.items.length - 1];
        stack.push({ indent: it.indent, list: open(parent, it), owner: parent });
      } else if (top.list.tag !== it.tag) {
        top.list = { tag: it.tag, start: it.start, items: [] };
        top.owner.lists.push(top.list);
      }
      stack[stack.length - 1].list.items.push({ text: it.text, lists: [] });
    }
    function list(l) {
      var openTag = l.tag === 'ol' && l.start !== 1 ? '<ol start="' + l.start + '">' : '<' + l.tag + '>';
      return openTag + l.items.map(item).join('') + '</' + l.tag + '>';
    }
    function item(x) {
      var inner = x.lists.map(list).join('');
      var t = TASK_RE.exec(x.text);
      if (t) {
        var done = t[1] !== ' ';
        return '<li class="md-task"><span class="md-tick' + (done ? ' md-done' : '') + '">'
          + (done ? '\u2611' : '\u2610') + '</span> ' + inline(t[2] || '', true) + inner + '</li>';
      }
      return '<li>' + inline(x.text, true) + inner + '</li>';
    }
    return root.lists.map(list).join('');
  }

  // The block loop. The page flavour takes exactly the branches it always had;
  // `chat` switches on the rest. `depth` is the blockquote depth (chat only).
  function blocks(ls, chat, depth) {
    var out = [];
    var para = [];
    var list = null; // page: { tag, start, items: [] } · chat: { items: [{indent, tag, start, text}] }
    var nextSlug = slugger();

    function endPara() {
      if (para.length) { out.push('<p>' + inline(para.join('\n'), chat) + '</p>'); para = []; }
    }
    function endList() {
      if (!list) return;
      if (chat) {
        out.push(renderChatList(list.items));
      } else {
        var open = list.tag === 'ol' && list.start !== 1 ? '<ol start="' + list.start + '">' : '<' + list.tag + '>';
        out.push(open + list.items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</' + list.tag + '>');
      }
      list = null;
    }

    for (var i = 0; i < ls.length; i++) {
      var line = ls[i];
      var fence = FENCE_RE.exec(line);
      if (fence) {
        endPara(); endList();
        var body = [];
        i++;
        while (i < ls.length && !FENCE_END_RE.test(ls[i])) { body.push(ls[i]); i++; }
        var lang = fence[1].toLowerCase();
        if (chat && (lang === 'diff' || lang === 'patch')) {
          out.push('<pre class="md-diff">' + renderDiff(body.join('\n')) + '</pre>');
        } else if (chat && lang === 'mermaid') {
          out.push('<pre class="md-mermaid"><span class="md-fence-label">Mermaid diagram \u00b7 source</span>'
            + '<code class="lang-mermaid">' + escapeHtml(body.join('\n')) + '</code></pre>');
        } else {
          var cls = fence[1] ? ' class="lang-' + escapeHtml(fence[1]) + '"' : '';
          out.push('<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
        }
        continue;
      }
      if (!line.trim()) { endPara(); endList(); continue; }
      var h = HEADING_RE.exec(line);
      if (h && (chat || h[1].length <= PAGE_MAX_LEVEL)) {
        endPara(); endList();
        var level = h[1].length;
        out.push(chat
          ? '<h' + level + '>' + inline(h[2], true) + '</h' + level + '>'
          : '<h' + level + ' data-slug="' + escapeHtml(nextSlug(plainText(h[2]))) + '">' + inline(h[2]) + '</h' + level + '>');
        continue;
      }
      if (chat) {
        if (RULE_RE.test(line)) { endPara(); endList(); out.push('<hr>'); continue; }
        if (depth < QUOTE_MAX_DEPTH && QUOTE_RE.test(line)) {
          endPara(); endList();
          // The third level takes every deeper marker with it: deeper quotes
          // flatten into it.
          var strip = depth + 1 >= QUOTE_MAX_DEPTH ? /^[ \t]{0,3}(?:>[ \t]?)+/ : /^[ \t]{0,3}>[ \t]?/;
          var inner = [];
          while (i < ls.length && QUOTE_RE.test(ls[i])) { inner.push(ls[i].replace(strip, '')); i++; }
          i--;
          out.push('<blockquote>' + blocks(inner, true, depth + 1) + '</blockquote>');
          continue;
        }
        var aligns = line.indexOf('|') >= 0 ? tableAligns(ls[i + 1]) : null;
        var header = aligns ? tableCells(line) : null;
        if (header && header.length === aligns.length) {
          endPara(); endList();
          var raw = [line, ls[i + 1]];
          var rows = [];
          i += 2;
          while (i < ls.length && ls[i].trim() && ls[i].indexOf('|') >= 0) { raw.push(ls[i]); rows.push(tableCells(ls[i])); i++; }
          i--;
          out.push(rows.length > TABLE_MAX_ROWS || aligns.length > TABLE_MAX_COLS
            ? '<pre>' + escapeHtml(raw.join('\n')) + '</pre>'
            : renderTable(header, aligns, rows));
          continue;
        }
        var ci = CHAT_ITEM_RE.exec(line);
        if (ci) {
          endPara();
          if (!list) list = { items: [] };
          list.items.push({ indent: indentOf(ci[1]), tag: ci[2] ? 'ul' : 'ol', start: ci[2] ? 1 : parseInt(ci[3], 10), text: ci[4] });
          continue;
        }
        if (list && /^[ \t]+\S/.test(line)) {
          list.items[list.items.length - 1].text += '\n' + line.trim();
          continue;
        }
        endList();
        para.push(line);
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

  // renderMarkdown(text)                    — the page flavour (frozen)
  // renderMarkdown(text, {flavor: 'chat'})  — the chat flavour
  function renderMarkdown(text, opts) {
    if (!(opts && opts.flavor === 'chat')) return blocks(lines(text), false, 0);
    var s = String(text == null ? '' : text);
    var note = '';
    if (s.length > CHAT_MAX_CHARS) {
      var cut = CHAT_MAX_CHARS;
      // Never split a surrogate pair.
      var cc = s.charCodeAt(cut - 1);
      if (cc >= 0xd800 && cc <= 0xdbff) cut--;
      note = '\n<p class="md-note">The rest of this message (' + (s.length - cut) + ' more characters) is not shown here.</p>';
      s = s.slice(0, cut);
    }
    var html = blocks(lines(s), true, 0) + note;
    return html ? '<div class="md-chat">' + html + '</div>' : '';
  }

  // Unified-diff text → escaped HTML, one span per line:
  //   <span class="dl dl-add|dl-del|dl-ctx|dl-hunk|dl-meta" data-old="…" data-new="…">
  // data-old/data-new are the line's numbers in the old and new file (empty
  // where the line has none) for CSS to draw; `{lineNumbers: false}` leaves
  // them off. Inside a hunk the header's counts decide what is a line of the
  // hunk; outside one (file headers, or a fragment with no @@ at all) a line is
  // classed by its first character and carries no number. Past 5,000 lines the
  // rest is one note. Text only (ruled 2026-10-04): any other input renders ''.
  var HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  var DIFF_META_RE = /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|\\)/;
  function renderDiff(input, opts) {
    if (typeof input !== 'string') return '';
    var numbers = !opts || opts.lineNumbers === undefined ? true : !!opts.lineNumbers;
    var ls = input.replace(/\r\n?/g, '\n').split('\n');
    if (ls.length && ls[ls.length - 1] === '') ls.pop();
    var out = '';
    var oldN = 0, newN = 0, oldLeft = 0, newLeft = 0;
    function span(kind, text, o, n) {
      var attrs = numbers ? ' data-old="' + (o == null ? '' : o) + '" data-new="' + (n == null ? '' : n) + '"' : '';
      return '<span class="dl ' + kind + '"' + attrs + '>' + escapeHtml(text) + '</span>';
    }
    var shown = Math.min(ls.length, DIFF_MAX_LINES);
    for (var i = 0; i < shown; i++) {
      var l = ls[i];
      var c = l.charAt(0);
      if (oldLeft > 0 || newLeft > 0) {
        if (c === '+') { out += span('dl-add', l, null, newN); newN++; newLeft--; continue; }
        if (c === '-') { out += span('dl-del', l, oldN, null); oldN++; oldLeft--; continue; }
        if (c === ' ' || l === '') { out += span('dl-ctx', l, oldN, newN); oldN++; newN++; oldLeft--; newLeft--; continue; }
        if (c === '\\') { out += span('dl-meta', l); continue; }
        oldLeft = newLeft = 0; // a line that is not the hunk's ends it
      }
      var hm = HUNK_RE.exec(l);
      if (hm) {
        oldN = parseInt(hm[1], 10); newN = parseInt(hm[3], 10);
        oldLeft = hm[2] == null ? 1 : parseInt(hm[2], 10);
        newLeft = hm[4] == null ? 1 : parseInt(hm[4], 10);
        out += span('dl-hunk', l);
        continue;
      }
      if (c === '@' && l.charAt(1) === '@') { out += span('dl-hunk', l); continue; }
      if (DIFF_META_RE.test(l)) { out += span('dl-meta', l); continue; }
      out += span(c === '+' ? 'dl-add' : c === '-' ? 'dl-del' : 'dl-ctx', l);
    }
    if (ls.length > shown) {
      out += '<span class="dl dl-meta dl-more">\u2026 ' + (ls.length - shown) + ' more lines not shown</span>';
    }
    return out;
  }

  // Every heading of one text (`#`–`###`), in order, with the slug
  // renderMarkdown stamps on each element — the Contents nav keeps `#`/`##`
  // (`###` is a sub-heading with no row). Fenced code is skipped: a `# comment`
  // inside a code block is not a section. The page flavour's alone.
  function headings(text) {
    var ls = lines(text);
    var out = [];
    var nextSlug = slugger();
    var inFence = false;
    for (var i = 0; i < ls.length; i++) {
      if (inFence) { if (FENCE_END_RE.test(ls[i])) inFence = false; continue; }
      if (FENCE_RE.test(ls[i])) { inFence = true; continue; }
      var h = HEADING_RE.exec(ls[i]);
      if (!h || h[1].length > PAGE_MAX_LEVEL) continue;
      var t = plainText(h[2]);
      out.push({ level: h[1].length, text: t, slug: nextSlug(t) });
    }
    return out;
  }

  return {
    renderMarkdown: renderMarkdown,
    renderDiff: renderDiff,
    headings: headings,
    slugify: slugify,
    gateHref: gateHref,
    gateImg: gateImg,
  };
}

const api = createMarkdown(escapeHtml);

// The browser copy: an ES module assembled from the two functions' own source,
// so there is no second implementation to keep in step. Served by
// lib/server/routes/page.js at /app/markdown.js (beside the chrome's modules).
// Memoised for the process's life: an edit here needs a daemon restart.
let browserSrc = null;
function browserModuleSource() {
  if (browserSrc == null) {
    browserSrc = [
      '// Generated from lib/core/markdown.js + lib/core/html.js — do not edit; see those files.',
      `const escapeHtml = ${escapeHtml.toString()};`,
      `const createMarkdown = ${createMarkdown.toString()};`,
      'const md = createMarkdown(escapeHtml);',
      'export const renderMarkdown = md.renderMarkdown;',
      'export const renderDiff = md.renderDiff;',
      'export const headings = md.headings;',
      'export const slugify = md.slugify;',
      'export const gateHref = md.gateHref;',
      'export const gateImg = md.gateImg;',
      'export default md;',
      '',
    ].join('\n');
  }
  return browserSrc;
}

module.exports = { ...api, createMarkdown, browserModuleSource };
