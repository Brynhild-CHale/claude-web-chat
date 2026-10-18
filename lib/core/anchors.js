'use strict';

// The anchor record and the element resolver (annotation engine, PLAN.md 1C.1),
// one self-contained factory on lib/core/markdown.js's pattern: createAnchors
// is written once and runs in three places from its own source text, so there
// is no second implementation to keep in step:
//
//   - here, require()d by node (the tests, the gate's corpus driver);
//   - as an ES module (browserModuleSource, served to the chrome by a later unit);
//   - as a classic script inside every preview, replay frame and export
//     (documentSource, spliced by a later unit; it installs itself on the mount
//     runtime as window.__wcMount.anchor).
//
// The rule is NOT designed here. It is the measured one: the F1 harness v5
// (design/annotation-engine-redesign/tests/F1/harness.js, the G0 GO) ported
// line for line, plus the two tranche-1 rulings (DECISIONS.md I), each behind a
// CONFIG flag the 1C gate's sensitivity rows switch off:
//   head_floor  the head tie-break's winner also needs its head dice >= row_tol;
//   ordinal     keys sharing a digit-folded skeleton must share their first
//               digit run, else the key dice is 0.
// {gate: false, tiebreak: false, ordinal: false} is harness v4's row match.
//
// AUTHORING RULES for the factory (its text is spliced inside a document's
// script element and evaluated in another realm):
//   - ES5 only: var/function; no arrow, let/const, class, template literal,
//     spread, exponent operator or async (test/anchors.test.js scans it);
//   - no globals: only STATES and the DOM reached through the nodes it is
//     handed; no cross-realm type test (nodeType, never a constructor check);
//   - comments only on whole lines starting with //, never a block comment and
//     never a comment after code (the document copy drops whole-line comments);
//   - no script, style or HTML-comment opener spelled anywhere in this file,
//     no shadow-root attach call, no Function constructor, no variable named
//     esc; non-ASCII in code written as \u escapes.
// Four sections, each under a one-line banner, so later units replace only
// their own: element (this one), resolveAll (the chunker), range and source.
//
// The browser copies are memoised per process: an edit here reaches the chrome
// and every document only after `claude-web-chat restart`.

const { ANCHOR_STATES } = require('./anchor-states');

function createAnchors(STATES) {
  // ── element ──
  // The answer's states come from the injected vocabulary, never spelled here.
  function stateOf(name) {
    for (var k = 0; k < STATES.length; k++) {
      if (STATES[k] === name) return STATES[k];
    }
    throw new Error('anchors: the state vocabulary has no ' + name);
  }
  var EXACT = stateOf('exact');
  var RE_RESOLVED = stateOf('re-resolved');
  var ORPHANED = stateOf('orphaned');

  // The pinned config (DECISIONS.md H2) and the two rulings' flags (I).
  var CONFIG = Object.freeze({
    tol: 0.8,
    margin: 0.05,
    row_tol: 0.6,
    row_margin: 0.05,
    key_w: 0.7,
    gate: true,
    tiebreak: true,
    head_n: 128,
    head_floor: true,
    ordinal: true,
    ctx_n: 32,
    quote_max: 2000,
    fuzzy_tol: 0.75,
    source_bracket: true
  });
  // The record's shape constants: never overridable.
  var LIMITS = Object.freeze({ fp_head: 64, row_head: 128, key: 32 });
  // Harness SKIP, tested on tagName exactly as it is (LINK and META are not skipped).
  var SKIP = { STYLE: 1, SCRIPT: 1, TEMPLATE: 1, NOSCRIPT: 1 };
  var CHROME = 'data-wc-chrome';
  var LOCATOR_FORM = 'pin-locator@1';
  var hasOwn = Object.prototype.hasOwnProperty;

  function dict() { return Object.create(null); }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function sortedCopy(a) { return (a || []).slice().sort(); }
  function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }

  function merge(cfg) {
    var out = {};
    var k;
    for (k in CONFIG) out[k] = CONFIG[k];
    if (cfg) {
      for (k in cfg) {
        if (hasOwn.call(cfg, k) && cfg[k] !== undefined) out[k] = cfg[k];
      }
    }
    return out;
  }
  function cfgKey(c) {
    return [c.row_tol, c.row_margin, c.key_w, c.gate === false ? 0 : 1, c.tiebreak === false ? 0 : 1,
      c.head_floor ? 1 : 0, c.ordinal ? 1 : 0, c.head_n].join('/');
  }

  // Similarity: lower-cased bigram SETS (harness bigrams/dice/jacc).
  function bigrams(s) {
    var set = dict();
    var size = 0;
    s = s.toLowerCase();
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.slice(i, i + 2);
      if (!set[g]) { set[g] = true; size++; }
    }
    return { set: set, size: size };
  }
  function dice(a, b, ba, bb) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    ba = ba || bigrams(a);
    bb = bb || bigrams(b);
    if (!ba.size || !bb.size) return 0;
    var x = ba.size < bb.size ? ba : bb;
    var y = x === ba ? bb : ba;
    var n = 0;
    for (var g in x.set) {
      if (y.set[g]) n++;
    }
    return (2 * n) / (ba.size + bb.size);
  }
  function jacc(a, b) {
    if (!a.length && !b.length) return 1;
    var A = dict();
    var B = dict();
    var na = 0;
    var nb = 0;
    var n = 0;
    var k;
    for (k = 0; k < a.length; k++) if (!A[a[k]]) { A[a[k]] = true; na++; }
    for (k = 0; k < b.length; k++) if (!B[b[k]]) { B[b[k]] = true; nb++; }
    for (var x in A) if (B[x]) n++;
    return n / (na + nb - n);
  }
  function sigOverlap(A, B) {
    var inter = 0;
    var uni = 0;
    var k;
    for (k in A) {
      if (!hasOwn.call(A, k)) continue;
      var a = A[k] || 0;
      var b = hasOwn.call(B, k) ? B[k] || 0 : 0;
      inter += Math.min(a, b);
      uni += Math.max(a, b);
    }
    for (k in B) {
      if (!hasOwn.call(B, k) || hasOwn.call(A, k)) continue;
      uni += Math.max(0, B[k] || 0);
    }
    return uni ? inter / uni : 1;
  }

  // RULING H1@ordinal-tail: two different keys that share a skeleton (digit runs
  // folded to #, both lower-cased) clash unless their first digit runs are equal.
  function ordinalClash(a, b) {
    var la = a.toLowerCase();
    var lb = b.toLowerCase();
    if (la.replace(/[0-9]+/g, '#') !== lb.replace(/[0-9]+/g, '#')) return false;
    var ma = la.match(/[0-9]+/);
    var mb = lb.match(/[0-9]+/);
    if (!ma || !mb) return false;
    return ma[0] !== mb[0];
  }

  // The per-pane index (B4): one walk in the harness flatten's order.
  // Elements in document order; a skip element is listed, counted in paths and
  // sib, and marks its subtree skip; an element carrying data-wc-chrome is
  // dropped with its subtree and counted nowhere, so chrome never shifts a path.
  function index(root) {
    var els = [];
    var texts = [];
    var roots = [];
    function walk(node, parent, path, list, skipped) {
      var kids = node.childNodes;
      var ci = 0;
      var seen = dict();
      for (var k = 0; k < kids.length; k++) {
        var ch = kids[k];
        if (ch.nodeType === 3) {
          if (skipped) continue;
          if (ch.data && ch.data.length) texts.push({ el: parent, data: ch.data });
          continue;
        }
        if (ch.nodeType !== 1) continue;
        if (ch.hasAttribute && ch.hasAttribute(CHROME)) continue;
        var tn = ch.tagName;
        seen[tn] = (seen[tn] || 0) + 1;
        var cls = [];
        var cl = ch.classList;
        if (cl) for (var j = 0; j < cl.length; j++) cls.push(cl[j]);
        cls.sort();
        var e = {
          i: els.length,
          node: ch,
          tag: String(ch.localName || tn).toLowerCase(),
          id: ch.id || '',
          cls: cls,
          parent: parent,
          path: path.concat([ci]),
          sib: seen[tn] - 1,
          skip: !!SKIP[tn] || skipped,
          children: [],
          textStart: texts.length,
          textEnd: texts.length
        };
        els.push(e);
        list.push(e.i);
        walk(ch, e.i, e.path, e.children, e.skip);
        e.textEnd = texts.length;
        ci++;
      }
    }
    walk(root, -1, [], roots, false);
    var ix = {
      root: root,
      els: els,
      texts: texts,
      roots: roots,
      sigCount: dict(),
      fpCount: dict(),
      fpList: dict(),
      byTag: dict(),
      group: dict(),
      at: dict(),
      memo: { terms: dict(), head: dict(), g: dict(), dmax: dict() }
    };
    var i;
    for (i = 0; i < els.length; i++) {
      var e = els[i];
      e.sig = e.tag + (e.cls.length ? '.' + e.cls.join('.') : '');
      e.shape = e.tag + '|' + e.id + '|' + e.cls.join('.');
      e.head = e.skip ? '' : textHead(ix, e, LIMITS.fp_head);
      e.fp = e.shape + '|' + e.head;
      e.parentSig = e.parent >= 0 ? els[e.parent].sig : '#root';
      e.gkey = e.parent + '>' + e.sig;
      e.rkey = rowKeyOf(ix, e);
    }
    for (i = 0; i < els.length; i++) {
      e = els[i];
      e.rsigs = dict();
      for (var c = 0; c < e.children.length; c++) {
        var x = els[e.children[c]];
        if (x.skip) continue;
        e.rsigs[x.sig] = (e.rsigs[x.sig] || 0) + 1;
      }
      if (e.skip) continue;
      ix.sigCount[e.gkey] = (ix.sigCount[e.gkey] || 0) + 1;
      var fk = e.parent + '>' + e.fp;
      ix.fpCount[fk] = (ix.fpCount[fk] || 0) + 1;
      push(ix.fpList, e.fp, e.i);
      push(ix.byTag, e.tag, e);
      push(ix.group, e.gkey, e);
      push(ix.at, e.path.length + '|' + e.shape, e);
    }
    return ix;
  }
  function push(m, k, v) {
    if (!m[k]) m[k] = [];
    m[k].push(v);
  }
  // The element's normalised text, first n characters, with an early exit once n
  // are known (harness rowHeadOf; the fp head is the same at 64).
  function textHead(ix, e, n) {
    if (e.skip) return '';
    var acc = '';
    for (var i = e.textStart; i < e.textEnd; i++) {
      acc += ix.texts[i].data;
      if (acc.length > n) {
        var t = norm(acc);
        if (t.length > n) return t.slice(0, n);
      }
    }
    return norm(acc).slice(0, n);
  }
  // The row key: the first non-empty text node in document order, normalised, 32.
  function rowKeyOf(ix, e) {
    if (e.skip) return '';
    for (var i = e.textStart; i < e.textEnd; i++) {
      var t = norm(ix.texts[i].data);
      if (t) return t.slice(0, LIMITS.key);
    }
    return '';
  }
  // The row head, read lazily at tie time only.
  function rowHead(ix, e, n) {
    if (!e.rhead) e.rhead = dict();
    if (e.rhead[n] == null) e.rhead[n] = textHead(ix, e, n);
    return e.rhead[n];
  }
  function rowHeadBg(ix, e, n) {
    if (!e.rhbg) e.rhbg = dict();
    if (!e.rhbg[n]) e.rhbg[n] = bigrams(rowHead(ix, e, n));
    return e.rhbg[n];
  }
  function headBg(e) {
    if (!e.hbg) e.hbg = bigrams(e.head);
    return e.hbg;
  }
  function keyBg(e) {
    if (!e.kbg) e.kbg = bigrams(e.rkey);
    return e.kbg;
  }
  function attrNamesOf(e) {
    if (e.attrs) return e.attrs;
    var out = [];
    var at = e.node.attributes;
    for (var i = 0; i < at.length; i++) {
      var nm = at[i].name;
      if (nm !== 'class' && nm !== 'id' && nm !== 'style') out.push(nm);
    }
    out.sort();
    e.attrs = out;
    return out;
  }
  function isRowLike(ix, e) { return (ix.sigCount[e.gkey] || 0) > 1; }
  function atPath(ix, p) {
    if (!isArr(p) || !p.length) return null;
    var list = ix.roots;
    var el = null;
    for (var k = 0; k < p.length; k++) {
      var i = list[p[k]];
      if (i == null) return null;
      el = ix.els[i];
      list = el.children;
    }
    return el;
  }
  function entryOf(ix, node) {
    for (var i = 0; i < ix.els.length; i++) {
      if (ix.els[i].node === node) return ix.els[i];
    }
    return null;
  }

  // The record.
  function record(root, el, opts) {
    opts = opts || {};
    if (!root || !el || el.nodeType !== 1) return null;
    var ix = opts.ix || index(root);
    var e = entryOf(ix, el);
    if (!e || e.skip) return null;
    var rows = [];
    for (var p = e.parent; p >= 0; p = ix.els[p].parent) {
      var x = ix.els[p];
      if (!isRowLike(ix, x)) continue;
      var sigs = {};
      for (var s in x.rsigs) sigs[s] = x.rsigs[s];
      rows.push({ depth: x.path.length, shape: x.shape, sigs: sigs, key: x.rkey, head: rowHead(ix, x, LIMITS.row_head) });
    }
    var host = root.host;
    var mount = opts.mount != null ? opts.mount
      : host ? ((host.dataset && host.dataset.mountId) || host.id || null) : null;
    return {
      v: 1,
      kind: 'element',
      mount: mount,
      at: { path: e.path.slice(), sib: e.sib },
      fp: { tag: e.tag, id: e.id, cls: e.cls.slice(), head: e.head, attrs: attrNamesOf(e).slice(), parent: e.parentSig },
      rows: rows
    };
  }

  // The row match (harness v5 terms5 .. depthMax5), with the two rulings.
  // A recorded row is wrapped once per resolve: its memo id (harness recId5) and
  // its lazily built bigram sets.
  function wrapRow(r) {
    var hasHead = typeof r.head === 'string';
    return {
      r: r,
      hasHead: hasHead,
      id: r.depth + '|' + r.shape + '|' + r.key + '|' + JSON.stringify(r.sigs) + '|' + (hasHead ? 'h' + r.head : '-'),
      kbg: null,
      hbg: null
    };
  }
  function terms(ix, w, e, c) {
    var k = w.id + '#' + e.i + (c.ordinal ? '#o' : '#-');
    var t = ix.memo.terms[k];
    if (t) return t;
    if (e.skip || e.shape !== w.r.shape) {
      t = { shape: false, key: 0, ov: 0 };
    } else {
      var rk = String(w.r.key == null ? '' : w.r.key);
      var key;
      if (rk === e.rkey) key = 1;
      else if (c.ordinal && ordinalClash(rk, e.rkey)) key = 0;
      else key = dice(rk, e.rkey, w.kbg || (w.kbg = bigrams(rk)), keyBg(e));
      t = { shape: true, key: key, ov: sigOverlap(w.r.sigs || {}, e.rsigs) };
    }
    ix.memo.terms[k] = t;
    return t;
  }
  function headDice(ix, w, e, c) {
    var k = w.id + '#' + e.i + '#h' + c.head_n;
    var h = ix.memo.head[k];
    if (h != null) return h;
    var eh = rowHead(ix, e, c.head_n);
    h = w.r.head === eh ? 1 : dice(w.r.head, eh, w.hbg || (w.hbg = bigrams(w.r.head)), rowHeadBg(ix, e, c.head_n));
    ix.memo.head[k] = h;
    return h;
  }
  function weights(c) {
    var W = c.key_w;
    return [W, +(1 - W).toFixed(10)];
  }
  function groupEval(ix, w, gkey, c) {
    var k = w.id + '@' + gkey + '@' + cfgKey(c);
    var g = ix.memo.g[k];
    if (g) return g;
    var ws = weights(c);
    var W = ws[0];
    var Wo = ws[1];
    var gate = c.gate !== false;
    var Q = [];
    var grp = ix.group[gkey] || [];
    var j;
    for (j = 0; j < grp.length; j++) {
      var t = terms(ix, w, grp[j], c);
      if (!t.shape || (gate && t.key < c.row_tol)) continue;
      Q.push({ i: grp[j].i, s: W * t.key + Wo * t.ov, key: t.key });
    }
    Q.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    var byI = dict();
    for (j = 0; j < Q.length; j++) byI[Q[j].i] = Q[j];
    var match = dict();
    var nMatch = 0;
    var tie = null;
    if (Q.length && Q[0].s >= c.row_tol) {
      var best = Q[0].s;
      for (j = 0; j < Q.length; j++) {
        var o = j === 0 ? (Q.length > 1 ? Q[1].s : 0) : best;
        if (Q[j].s >= c.row_tol && Q[j].s - o >= c.row_margin) { match[Q[j].i] = true; nMatch++; }
      }
      if (!nMatch) {
        var T = [];
        for (j = 0; j < Q.length; j++) if (best - Q[j].s < c.row_margin) T.push(Q[j]);
        var els = ix.els;
        var keysSame = true;
        for (j = 1; j < T.length; j++) if (els[T[j].i].rkey !== els[T[0].i].rkey) keysSame = false;
        tie = {
          n: T.length,
          keys_identical: keysSame,
          heads_identical: null,
          head_lead: null,
          winner: null,
          winner_under_row_tol: false,
          winner_under_head_floor: false
        };
        // A record row without a head never enters the tie-break: it reads row-lookalike.
        if (c.tiebreak !== false && T.length > 1 && w.hasHead) {
          var H = [];
          for (j = 0; j < T.length; j++) H.push({ q: T[j], h: headDice(ix, w, els[T[j].i], c) });
          H.sort(function (a, b) { return b.h - a.h || a.q.i - b.q.i; });
          var headsSame = true;
          var h0 = rowHead(ix, els[T[0].i], c.head_n);
          for (j = 1; j < T.length; j++) if (rowHead(ix, els[T[j].i], c.head_n) !== h0) headsSame = false;
          tie.heads_identical = headsSame;
          tie.head_lead = +(H[0].h - H[1].h).toFixed(4);
          if (H[0].h - H[1].h >= c.row_margin) {
            if (H[0].q.s < c.row_tol) tie.winner_under_row_tol = true;
            else if (c.head_floor && H[0].h < c.row_tol) tie.winner_under_head_floor = true;
            else { match[H[0].q.i] = true; tie.winner = H[0].q.i; }
          }
        }
      }
    }
    g = { byI: byI, match: match, tie: tie, n: Q.length };
    ix.memo.g[k] = g;
    return g;
  }
  // 'match' | 'row-context' (fails the gate, or under row_tol) | 'row-lookalike'
  function verdictIn(g, e, c) {
    if (g.match[e.i]) return 'match';
    var q = g.byI[e.i];
    return !q || q.s < c.row_tol ? 'row-context' : 'row-lookalike';
  }
  function verdict(ix, w, e, c) { return verdictIn(groupEval(ix, w, e.gkey, c), e, c); }
  function depthMax(ix, w, c) {
    var k = w.id + '@' + cfgKey(c);
    var mx = ix.memo.dmax[k];
    if (mx != null) return mx;
    var ws = weights(c);
    var gate = c.gate !== false;
    var list = ix.at[w.r.depth + '|' + w.r.shape] || [];
    mx = 0;
    for (var j = 0; j < list.length; j++) {
      var t = terms(ix, w, list[j], c);
      if (!t.shape || (gate && t.key < c.row_tol)) continue;
      var s = ws[0] * t.key + ws[1] * t.ov;
      if (s > mx) mx = s;
    }
    ix.memo.dmax[k] = mx;
    return mx;
  }

  // Step 2: the fingerprint scoring (harness score + scoreBest), the real one (H3).
  function score(fp, at, aBg, e) {
    var s = 0;
    var w = 0;
    if (fp.id || e.id) { w += 0.15; s += fp.id === e.id ? 0.15 : 0; }
    w += 0.4; s += 0.4 * (fp.head === e.head ? 1 : dice(fp.head, e.head, aBg, headBg(e)));
    w += 0.15; s += 0.15 * jacc(fp.cls || [], e.cls);
    w += 0.1; s += 0.1 * jacc(fp.attrs || [], attrNamesOf(e));
    w += 0.1; s += fp.parent === e.parentSig ? 0.1 : 0;
    w += 0.05; s += at.sib === e.sib ? 0.05 : 0;
    w += 0.05; s += (isArr(at.path) ? at.path.join('.') : '') === e.path.join('.') ? 0.05 : 0;
    return s / w;
  }
  function step2(ix, rec, c) {
    var fp = rec.fp;
    var list = ix.byTag[fp.tag] || [];
    var aBg = bigrams(String(fp.head || ''));
    var b1 = -1;
    var s1 = -1;
    var s2 = -1;
    for (var j = 0; j < list.length; j++) {
      var s = score(fp, rec.at, aBg, list[j]);
      if (s > s1) { s2 = s1; s1 = s; b1 = list[j].i; } else if (s > s2) s2 = s;
    }
    if (s2 < 0) s2 = 0;
    if (b1 >= 0 && s1 >= c.tol && s1 - s2 >= c.margin) return answer(RE_RESOLVED, ix.els[b1], { how: 'score' });
    return answer(ORPHANED, null, { how: b1 < 0 || s1 < c.tol ? 'score-low' : 'score-margin' });
  }

  function answer(state, e, extra) {
    var a = { state: state, el: e ? e.node : null, i: e ? e.i : -1 };
    if (extra) for (var k in extra) a[k] = extra[k];
    return a;
  }
  function tieOut(depth, t) {
    return {
      depth: depth,
      n: t.n,
      keys_identical: t.keys_identical,
      heads_identical: t.heads_identical,
      head_lead: t.head_lead,
      winner: t.winner,
      winner_under_row_tol: t.winner_under_row_tol,
      winner_under_head_floor: t.winner_under_head_floor
    };
  }

  // Resolve: evidenceV5 + rawAtV5 + decideV3, computed only as far as it decides.
  function resolveElement(rec, c, ix) {
    var fp = rec.fp;
    var at = rec.at;
    var p = atPath(ix, at.path);
    var hit = p && !p.skip && p.tag === fp.tag && p.id === fp.id && p.head === fp.head
      && p.cls.join(' ') === (fp.cls || []).join(' ');
    if (!hit) return step2(ix, rec, c);
    var rows = isArr(rec.rows) ? rec.rows : [];
    var want = [];
    var byDepth = dict();
    var j;
    for (j = 0; j < rows.length; j++) {
      var w = wrapRow(rows[j]);
      want.push(w);
      byDepth[w.r.depth] = w;
    }
    var why = (ix.fpCount[p.parent + '>' + p.fp] || 0) !== 1 ? 'sibling-lookalike' : null;
    var tie = null;
    var viaHead = false;
    if (!why) {
      for (var q = p.parent; q >= 0; q = ix.els[q].parent) {
        var t = ix.els[q];
        var wr = byDepth[t.path.length];
        var row = isRowLike(ix, t);
        if (!row && !wr) continue;
        if (!wr) { why = 'row-unrecorded'; break; }
        var g = groupEval(ix, wr, t.gkey, c);
        var v = verdictIn(g, t, c);
        if (g.tie && !tie) tie = tieOut(t.path.length, g.tie);
        if (v === 'match' && g.tie && g.tie.winner === t.i) viaHead = true;
        if (v !== 'match') { why = v; break; }
      }
    }
    if (!why) return answer(EXACT, p, { via_head: viaHead, tie: tie });
    // Option B (F1, G2): never the path element; the origin fingerprint under the
    // recorded rows, one candidate or none.
    var key = fp.tag + '|' + fp.id + '|' + sortedCopy(fp.cls).join('.') + '|' + fp.head;
    var list = ix.fpList[key] || [];
    var cands = [];
    for (j = 0; j < list.length; j++) {
      var anc = dict();
      for (var a = ix.els[list[j]].parent; a >= 0; a = ix.els[a].parent) anc[ix.els[a].path.length] = a;
      var ok = true;
      for (var m = 0; m < want.length && ok; m++) {
        var ai = anc[want[m].r.depth];
        ok = ai != null && verdict(ix, want[m], ix.els[ai], c) === 'match';
      }
      if (ok) cands.push(list[j]);
    }
    if (cands.length === 1) return answer(RE_RESOLVED, ix.els[cands[0]], { why: why, how: 'row-search', tie: tie });
    var how = 'row-ambiguous';
    if (!cands.length) {
      var gone = false;
      for (j = 0; j < want.length && !gone; j++) gone = depthMax(ix, want[j], c) < c.row_tol;
      how = gone ? 'row-gone' : 'not-in-recorded-row';
    }
    return answer(ORPHANED, null, { why: why, how: how, tie: tie });
  }

  // A converted legacy pin (U202's convertAnchor): today's comments.js
  // resolveAnchorEl, its candidate text kept byte for byte, but a guess is never
  // answered: it rides an orphaned answer as `guess`.
  function inChrome(node, root) {
    for (var n = node; n && n !== root; n = n.parentNode) {
      if (n.nodeType === 1 && n.hasAttribute(CHROME)) return true;
    }
    return false;
  }
  function locatorText(e) { return (e.textContent || '').trim().slice(0, 120); }
  function resolveLocator(root, rec, ix) {
    var sel = rec.path && rec.path.selector;
    var cands = [];
    if (typeof sel === 'string' && sel) {
      try {
        var found = root.querySelectorAll(sel);
        for (var k = 0; k < found.length; k++) if (!inChrome(found[k], root)) cands.push(found[k]);
      } catch (err) {
        cands = [];
      }
    }
    if (!cands.length) return { state: ORPHANED, el: null, i: -1, how: 'locator-none', guess: null };
    var ord = rec.ordinal;
    var atOrd = typeof ord === 'number' && ord % 1 === 0 && ord >= 0 && ord < cands.length ? cands[ord] : cands[0];
    var text = rec.fingerprint && rec.fingerprint.text;
    var hitEl = null;
    if (typeof text === 'string' && text) {
      if (locatorText(atOrd) === text) hitEl = atOrd;
      else {
        for (var j = 0; j < cands.length && !hitEl; j++) if (locatorText(cands[j]) === text) hitEl = cands[j];
      }
    }
    if (!hitEl) return { state: ORPHANED, el: null, i: -1, how: 'locator-guess', guess: atOrd };
    var e = entryOf(ix || index(root), hitEl);
    return { state: RE_RESOLVED, el: hitEl, i: e ? e.i : -1, how: 'locator' };
  }

  function resolve(root, rec, cfg, ix) {
    if (rec && rec.form === LOCATOR_FORM) return resolveLocator(root, rec, ix);
    if (!rec || rec.kind !== 'element' || !rec.fp || !rec.at) {
      return { state: ORPHANED, el: null, i: -1, how: 'invalid-record' };
    }
    return resolveElement(rec, merge(cfg), ix || index(root));
  }

  // F2: only an exact find re-stamps, and only `at`.
  function restamp(rec, ans, ix) {
    if (!rec || !ans || ans.state !== EXACT || !ans.el || rec.form === LOCATOR_FORM) return rec;
    if (!ix) {
      var r = ans.el;
      while (r.parentNode) r = r.parentNode;
      ix = index(r);
    }
    var e = ix.els[ans.i] && ix.els[ans.i].node === ans.el ? ix.els[ans.i] : entryOf(ix, ans.el);
    if (!e) return rec;
    var out = {};
    for (var k in rec) if (hasOwn.call(rec, k)) out[k] = rec[k];
    out.at = { path: e.path.slice(), sib: e.sib };
    return out;
  }

  // ── resolveAll ──
  // The chunked incremental re-resolve (PLAN.md 1C.4; DECISIONS.md F6 and G6;
  // PLAN.md section 7 obligation 3). A pass resolves every record with resolve()
  // above against ONE index of its root, record by record, and yields to the
  // next scheduled frame once a chunk's work reaches budget_ms (default 10), so
  // no chunk's work exceeds the budget plus one record. Building the index is a
  // chunk of its own: it never shares a frame with resolve work, and its time is
  // reported apart (index_ms). No frame over 16 ms is the hard line at any
  // density; the whole is reported (wall_ms) and may grow past 481 records.
  //
  // The index is cached per root in a WeakMap, keyed by the mount runtime's
  // settle generation once install(M) has handed us a runtime with generation()
  // (U223), else held until invalidate(root). A pass whose index is dropped
  // (invalidate, or a settle that moved the generation) restarts from its first
  // record on a fresh index at its next chunk, so no answer computed against
  // the old index is ever delivered. resolve() without an index still builds a
  // fresh one, so a direct caller never reads this cache.
  //
  // The scheduler and the clock are injectable (opts.schedule(fn), opts.now());
  // by default they come from the root's own window (its document's defaultView,
  // never a global): requestAnimationFrame, or setTimeout(fn, 16) when there is
  // none or the document is hidden (a hidden tab runs no animation frame); a
  // root with no window is served on a microtask. The clock is the window's
  // performance.now, else Date.now.
  //
  // watch(mountId, {records(), onAnswers(answers, report), cfg?}) is the seam the
  // overlay plugs records into (tranche 2, 2A). install(M) registers one settle
  // listener that only QUEUES (root, mountId): settle is synchronous and on the
  // mount path, so the listener does no work and asks for at most one frame.
  // That frame runs ONE shared loop serving every queued root in FIFO order under
  // the same per-frame budget: two settles before a frame give one pass, and the
  // passes of several panes share the frames. A settle for a mount id nothing
  // watches, or whose host has left its document, costs no index and no frame.
  var DEFAULT_BUDGET_MS = 10;
  var ixCache = new WeakMap();
  var runtime = null;
  var unSettle = null;
  var watchers = dict();
  var shared = { o: {}, passes: [], queue: [], pending: false };

  function docOf(root) { return root.nodeType === 9 ? root : root.ownerDocument; }
  function winOf(root) {
    var d = docOf(root);
    return (d && d.defaultView) || null;
  }
  function defaultSchedule(root) {
    return function (fn) {
      var w = winOf(root);
      var d = docOf(root);
      if (!w) {
        Promise.resolve().then(fn);
        return;
      }
      if (typeof w.requestAnimationFrame === 'function' && !(d && d.hidden)) w.requestAnimationFrame(fn);
      else w.setTimeout(fn, 16);
    };
  }
  function defaultNow(root) {
    var w = winOf(root);
    var perf = w && w.performance;
    if (perf && typeof perf.now === 'function') return function () { return perf.now(); };
    return function () { return Date.now(); };
  }
  function budgetOf(o) {
    var b = o.budget_ms;
    return b == null || !(b >= 0) ? DEFAULT_BUDGET_MS : b;
  }
  function isRoot(root) { return !!root && typeof root === 'object' && typeof root.nodeType === 'number'; }
  // A watched pane whose host has left its document is not served.
  function gone(root) {
    var h = root.host || root;
    return h.isConnected === false;
  }

  // The cache: {ix, gen}; gen is the runtime's settle generation at the build,
  // or null with no runtime, when only invalidate() drops it.
  function genOf(root) {
    return runtime && typeof runtime.generation === 'function' ? runtime.generation(root) : null;
  }
  function cachedIndex(root) {
    var c = ixCache.get(root);
    if (!c) return null;
    if (c.gen !== genOf(root)) {
      ixCache['delete'](root);
      return null;
    }
    return c;
  }
  function invalidate(root) {
    if (root && typeof root === 'object') ixCache['delete'](root);
  }

  // A pass: one root, its records (re-read on a restart), the answers so far.
  function newPass(root, read, cfg, deliver, spec, t0) {
    return {
      root: root,
      read: read,
      cfg: cfg,
      deliver: deliver,
      spec: spec,
      dead: false,
      recs: null,
      answers: [],
      i: 0,
      ix: null,
      gen: null,
      t0: t0,
      chunks: 0,
      longest: 0,
      work: 0,
      ixTime: 0,
      restarts: 0
    };
  }
  function readRecords(p) {
    var r = p.read();
    return isArr(r) ? r.slice() : [];
  }
  // True when the pass holds a valid index. An index dropped since the pass
  // took it restarts the pass from its first record.
  function attach(p) {
    var c = cachedIndex(p.root);
    if (p.ix && (!c || c.ix !== p.ix)) {
      p.restarts++;
      p.ix = null;
      p.gen = null;
      p.i = 0;
      p.answers = [];
      p.recs = null;
    }
    if (!p.recs) p.recs = readRecords(p);
    if (!p.ix && c) {
      p.ix = c.ix;
      p.gen = c.gen;
    }
    return !!p.ix;
  }
  function chunkDone(p, d) {
    p.chunks++;
    if (d > p.longest) p.longest = d;
  }
  // The index chunk: returns the clock reading at its end.
  function buildIndex(p, now) {
    var t = now();
    var ix = index(p.root);
    var gen = genOf(p.root);
    ixCache.set(p.root, { ix: ix, gen: gen });
    p.ix = ix;
    p.gen = gen;
    var e = now();
    p.ixTime += e - t;
    chunkDone(p, e - t);
    return e;
  }
  // A resolve chunk: at least one record, then until the FRAME's work (from t0)
  // reaches the budget. Returns the clock reading at its end.
  function serve(p, now, t0, budget) {
    var t = now();
    var e = t;
    var n = p.recs.length;
    while (p.i < n) {
      p.answers.push(resolve(p.root, p.recs[p.i], p.cfg, p.ix));
      p.i++;
      e = now();
      if (e - t0 >= budget) break;
    }
    p.work += e - t;
    chunkDone(p, e - t);
    return e;
  }
  function reportOf(p, end) {
    return {
      records: p.recs.length,
      chunks: p.chunks,
      longest_ms: p.longest,
      work_ms: p.work,
      index_ms: p.ixTime,
      wall_ms: end - p.t0,
      gen: p.gen,
      restarts: p.restarts
    };
  }
  function livePass(L, root, spec) {
    for (var k = 0; k < L.passes.length; k++) {
      var p = L.passes[k];
      if (p.root === root && p.spec === spec && !p.dead) return true;
    }
    return false;
  }
  function dropped(p) { return p.dead || (p.spec && (p.spec.dead || gone(p.root))); }

  // The loop: {o: {budget_ms, schedule, now}, passes, queue, pending}.
  function kick(L) {
    if (L.pending || (!L.passes.length && !L.queue.length)) return;
    L.pending = true;
    var head = L.passes.length ? L.passes[0].root : L.queue[0].root;
    var sched = L.o.schedule || defaultSchedule(head);
    sched(function () { frame(L); });
  }
  // The queued settles become passes, one per (root, watcher); a root whose
  // mount id nothing watches, or whose host has gone, is dropped unindexed.
  function intake(L) {
    var q = L.queue;
    L.queue = [];
    for (var k = 0; k < q.length; k++) {
      var it = q[k];
      var specs = watchers[it.mountId];
      if (!specs || !specs.length || gone(it.root)) continue;
      for (var s = 0; s < specs.length; s++) {
        if (!livePass(L, it.root, specs[s])) L.passes.push(watchPass(it.root, specs[s], it.t0));
      }
    }
  }
  function frame(L) {
    L.pending = false;
    if (L.queue.length) intake(L);
    var k;
    for (k = L.passes.length - 1; k >= 0; k--) if (dropped(L.passes[k])) L.passes.splice(k, 1);
    if (!L.passes.length) return;
    var now = L.o.now || defaultNow(L.passes[0].root);
    var budget = budgetOf(L.o);
    var t0 = now();
    var last = t0;
    var mode = null;
    var err = null;
    var p = null;
    k = 0;
    try {
      while (k < L.passes.length) {
        p = L.passes[k];
        if (dropped(p)) {
          L.passes.splice(k, 1);
          continue;
        }
        var ready = attach(p);
        if (!p.recs.length) {
          L.passes.splice(k, 1);
          err = keepFirst(err, finish(p, last));
          continue;
        }
        if (!ready) {
          if (mode === 'work' || (mode === 'index' && last - t0 >= budget)) break;
          mode = 'index';
          last = buildIndex(p, now);
          k++;
          continue;
        }
        if (mode === 'index') {
          k++;
          continue;
        }
        if (mode === 'work' && last - t0 >= budget) break;
        mode = 'work';
        last = serve(p, now, t0, budget);
        if (p.i < p.recs.length) break;
        L.passes.splice(k, 1);
        err = keepFirst(err, finish(p, last));
      }
    } catch (e) {
      if (!err) err = e;
      if (p) {
        p.dead = true;
        var at = L.passes.indexOf(p);
        if (at >= 0) L.passes.splice(at, 1);
      }
    }
    kick(L);
    if (err) throw err;
  }
  function keepFirst(a, b) { return a || b; }
  // Delivers a finished pass; a callback's throw is handed back, never lost.
  function finish(p, end) {
    try {
      p.deliver(p.answers, reportOf(p, end));
    } catch (e) {
      return e;
    }
    return null;
  }

  function resolveAll(root, records, opts, onDone) {
    if (!isRoot(root)) throw new TypeError('anchors: resolveAll needs a root node');
    if (typeof onDone !== 'function') throw new TypeError('anchors: resolveAll needs an onDone function');
    var o = opts || {};
    var recs = isArr(records) ? records.slice() : [];
    var L = { o: o, passes: [], queue: [], pending: false };
    var p = newPass(root, function () { return recs; }, o.cfg, onDone, null, (o.now || defaultNow(root))());
    L.passes.push(p);
    kick(L);
    return { cancel: function () { p.dead = true; } };
  }

  function watchPass(root, spec, t0) {
    return newPass(root, spec.records, spec.cfg, spec.onAnswers, spec, t0);
  }
  function watch(mountId, spec) {
    if (mountId == null || mountId === '') throw new TypeError('anchors: watch needs a mount id');
    if (!spec || typeof spec.records !== 'function' || typeof spec.onAnswers !== 'function') {
      throw new TypeError('anchors: watch needs {records(), onAnswers(answers, report)}');
    }
    var key = String(mountId);
    var own = { records: spec.records, onAnswers: spec.onAnswers, cfg: spec.cfg, dead: false };
    if (!watchers[key]) watchers[key] = [];
    watchers[key].push(own);
    return function unwatch() {
      own.dead = true;
      var list = watchers[key];
      var at = list ? list.indexOf(own) : -1;
      if (at >= 0) list.splice(at, 1);
      if (list && !list.length) delete watchers[key];
    };
  }
  // The settle listener: queue (root, mountId) and ask for a frame, nothing more.
  function onSettled(root, mountId) {
    if (!isRoot(root) || mountId == null) return;
    var key = String(mountId);
    var specs = watchers[key];
    if (!specs || !specs.length) return;
    var L = shared;
    var k;
    for (k = 0; k < L.queue.length; k++) {
      if (L.queue[k].root === root && L.queue[k].mountId === key) return;
    }
    var fresh = false;
    for (k = 0; k < specs.length && !fresh; k++) fresh = !livePass(L, root, specs[k]);
    if (!fresh) return;
    L.queue.push({ root: root, mountId: key, t0: (L.o.now || defaultNow(root))() });
    kick(L);
  }

  // ── range ──
  // Range anchors (PLAN.md 1C.2): a W3C TextQuoteSelector (exact, up to
  // CONFIG.ctx_n characters of prefix and suffix) beside a TextPositionSelector,
  // resolved by the measured rule of GT-02 (tests/F1/text-quote.js, workflow D):
  // a unique occurrence is exact; among duplicates the context (common suffix of
  // the recorded prefix, common prefix of the recorded suffix) decides, exact
  // only when one occurrence scores best alone; a context tie goes to the
  // occurrence nearest the recorded start and is re-resolved, never exact; no
  // occurrence falls to the bounded fuzzy match (windows at the first word's
  // starts and the last word's ends, bigram dice >= CONFIG.fuzzy_tol), whose
  // hit is always re-resolved; else orphaned.
  //
  // The pane text is the raw concatenation of the root's text nodes in document
  // order, skip elements and data-wc-chrome subtrees excluded, never
  // whitespace-normalised, so a position is a DOM text offset (RULED
  // U222a@range-text-raw). A table {s, nodes, offs}: offs[i] is nodes[i]'s
  // start in s, offs[nodes.length] is s.length. With `seps`, a text node that
  // is a direct child of the root and holds only newlines is left out (the
  // separators renderMarkdown writes between a markdown item's blocks).
  function textTable(root, seps) {
    var T = { s: '', nodes: [], offs: [] };
    function walk(node) {
      var kids = node.childNodes;
      for (var k = 0; k < kids.length; k++) {
        var ch = kids[k];
        if (ch.nodeType === 3) {
          if (seps && node === root && /^\n*$/.test(ch.data)) continue;
          T.nodes.push(ch);
          T.offs.push(T.s.length);
          T.s += ch.data;
        } else if (ch.nodeType === 1 && !ch.hasAttribute(CHROME) && !SKIP[ch.tagName]) {
          walk(ch);
        }
      }
    }
    walk(root);
    T.offs.push(T.s.length);
    return T;
  }
  // Whether node b is a or lies inside it (bit 16: contained by).
  function holds(a, b) {
    return !!b && (a === b || !!(a.compareDocumentPosition(b) & 16));
  }
  // The text offset of a boundary point (container, offset) in a table: inside
  // a listed text node, its own offset; anywhere else, the length of every
  // listed node before the point (an element or fragment boundary sits before
  // child `offset`, or after its last descendant). Listed nodes are in
  // document order, so the count is a binary search (bit 2: preceding).
  function pointAt(T, container, offset) {
    var k = T.nodes.indexOf(container);
    if (k >= 0) return T.offs[k] + Math.min(offset, container.data.length);
    var t = container.nodeType;
    var data = t === 3 || t === 4 || t === 7 || t === 8;
    var child = data ? null : container.childNodes[offset];
    function before(node) {
      if (data) return !!(container.compareDocumentPosition(node) & 2);
      if (child) return !!(child.compareDocumentPosition(node) & 2);
      return holds(container, node) || !!(container.compareDocumentPosition(node) & 2);
    }
    var lo = 0;
    var hi = T.nodes.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (before(T.nodes[mid])) lo = mid + 1; else hi = mid;
    }
    return T.offs[lo];
  }
  // A DOM Range over [start, end) of a table's text: from the node holding the
  // first character to the node holding the last. Null when there is none.
  function spanRange(doc, T, start, end) {
    var i = -1;
    var j = -1;
    for (var k = 0; k < T.nodes.length; k++) {
      var a = T.offs[k];
      var b = T.offs[k + 1];
      if (b <= a) continue;
      if (i < 0 && start < b) i = k;
      if (a < end) j = k;
    }
    if (!doc || !(end > start) || i < 0 || j < i) return null;
    var range = doc.createRange();
    range.setStart(T.nodes[i], start - T.offs[i]);
    range.setEnd(T.nodes[j], end - T.offs[j]);
    return range;
  }
  function occurrencesOf(hay, needle, cap) {
    var out = [];
    var i = needle ? hay.indexOf(needle) : -1;
    while (i >= 0 && out.length < cap) {
      out.push(i);
      i = hay.indexOf(needle, i + 1);
    }
    return out;
  }
  // The length of a's and b's common prefix, or (back) common suffix.
  function common(a, b, back) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(back ? a.length - 1 - n : n) === b.charAt(back ? b.length - 1 - n : n)) n++;
    return n;
  }
  function inside(root, range) {
    return !!root && !!range && !range.collapsed && holds(root, range.startContainer) && holds(root, range.endContainer);
  }
  // A record head with its quote and pos over [start, end) of s, or null when
  // the span is empty or over CONFIG.quote_max.
  function quoted(head, s, start, end) {
    if (!(end > start) || end - start > CONFIG.quote_max) return null;
    head.quote = { exact: s.slice(start, end), prefix: s.slice(Math.max(0, start - CONFIG.ctx_n), start), suffix: s.slice(end, end + CONFIG.ctx_n) };
    head.pos = { start: start, end: end };
    return head;
  }
  function validQuote(rec, kind) {
    return !!rec && rec.kind === kind && !!rec.quote && !!rec.quote.exact && typeof rec.quote.exact === 'string';
  }
  function quoteAnswer(state, start, end, how, occ) {
    return { state: state, range: null, start: start, end: end, how: how, occ: occ };
  }
  function orphan(how) { return quoteAnswer(ORPHANED, null, null, how, 0); }
  // The quote rule over a text s. `prefer(at)`, when given, breaks a context
  // tie before position (the source anchor's slug hint): one preferred
  // occurrence among the tied is exact (how 'slug'); several narrow the
  // position tie-break to them.
  function quoteRule(s, rec, c, prefer) {
    var q = rec.quote;
    var exact = q.exact;
    var L = exact.length;
    var n = c.ctx_n;
    var prefix = String(q.prefix || '');
    var suffix = String(q.suffix || '');
    var want = rec.pos && typeof rec.pos.start === 'number' ? rec.pos.start : 0;
    var occ = occurrencesOf(s, exact, 400);
    var k;
    var at;
    function pick(state, x, how) { return quoteAnswer(state, x, x + L, how, occ.length); }
    if (occ.length === 1) return pick(EXACT, occ[0], 'unique');
    if (occ.length > 1) {
      var tied = [];
      var top = -1;
      for (k = 0; k < occ.length; k++) {
        at = occ[k];
        var sc = common(prefix, s.slice(Math.max(0, at - n), at), true) + common(suffix, s.slice(at + L, at + L + n));
        if (sc > top) { top = sc; tied = []; }
        if (sc === top) tied.push(at);
      }
      if (tied.length === 1) return pick(EXACT, tied[0], 'context');
      var pref = [];
      for (k = 0; prefer && k < tied.length; k++) if (prefer(tied[k])) pref.push(tied[k]);
      if (pref.length === 1) return pick(EXACT, pref[0], 'slug');
      if (pref.length) tied = pref;
      at = tied[0];
      for (k = 1; k < tied.length; k++) if (Math.abs(tied[k] - want) < Math.abs(at - want)) at = tied[k];
      return pick(RE_RESOLVED, at, 'position');
    }
    var words = exact.split(/\s+/).filter(Boolean);
    if (!words.length) return orphan('none');
    var last = words[words.length - 1];
    var starts = occurrencesOf(s, words[0], 200);
    var ends = occurrencesOf(s, last, 200);
    for (k = 0; k < ends.length; k++) {
      at = Math.max(0, ends[k] + last.length - L);
      if (starts.indexOf(at) < 0) starts.push(at);
    }
    var bq = bigrams(exact);
    var win = null;
    for (k = 0; k < starts.length; k++) {
      var w = s.slice(starts[k], starts[k] + L);
      var d = dice(exact, w, bq);
      if (!win || d > win.d) win = { at: starts[k], end: starts[k] + w.length, d: d };
    }
    if (!win || win.d < c.fuzzy_tol) return orphan('none');
    var hit = quoteAnswer(RE_RESOLVED, win.at, win.end, 'fuzzy', 0);
    hit.dice = win.d;
    return hit;
  }

  // recordRange(root, range, {mount?}) -> {v: 1, kind: 'range', mount, quote:
  // {exact, prefix, suffix}, pos: {start, end}}, or null when the range is
  // collapsed, leaves the root, or its text is empty or over CONFIG.quote_max.
  // mount as record() names it.
  function recordRange(root, range, opts) {
    opts = opts || {};
    if (!inside(root, range)) return null;
    var T = textTable(root);
    var host = root.host;
    var mount = opts.mount != null ? opts.mount
      : host ? ((host.dataset && host.dataset.mountId) || host.id || null) : null;
    return quoted({ v: 1, kind: 'range', mount: mount }, T.s,
      pointAt(T, range.startContainer, range.startOffset), pointAt(T, range.endContainer, range.endOffset));
  }

  // resolveRange(root, rec, cfg?) -> {state, range, start, end, how, occ}
  // (+ dice on a fuzzy hit); how is unique | context | position | fuzzy | none
  // | invalid-record; range is a DOM Range over the answered span, null when
  // orphaned.
  function resolveRange(root, rec, cfg) {
    if (!root || !validQuote(rec, 'range')) return orphan('invalid-record');
    var T = textTable(root);
    var a = quoteRule(T.s, rec, merge(cfg), null);
    if (a.state !== ORPHANED) a.range = spanRange(root.ownerDocument, T, a.start, a.end);
    return a;
  }

  // ── source ──
  // The markdown source-range anchor (PLAN.md 1C.2; R1 section 3 row 3, P-4,
  // P-5): the same quote over the item's LF-normalised source text, mapped to
  // and from the rendered .md-block through U222b's sourceMap (lib/core/
  // markdown.js), never a second parse. The (md, slug) pair is a HINT, never
  // an identity: the slug only breaks a context tie before position, and the
  // hinted section is never answered as a hit. When the quote rule finds
  // nothing, the context fallback is the bracket (RULED U222a@source-fallback
  // (b), behind CONFIG.source_bracket): the recorded prefix's tail (at least 8
  // characters, unique in the source) and the recorded suffix's head (at least
  // 8) after it within exact.length * 2 + 64 characters; the span between is
  // answered re-resolved.
  //
  // alignBlock lays the map's runs end to end by `len` over the block's text
  // table (F2 alignDom; several runs may share a node) and checks each mapped
  // character against the node's data, so a block whose DOM was edited, or a
  // map of another text, does not align (null). It answers {T, R}: R[i] is the
  // source offset of the block's i-th rendered character, -1 when unmapped. A
  // run is [start, end, len, kind, offs?]: kind 'subseq' reads offs, kind
  // 'unmapped' maps nothing, the linear kind (the only other) is start + j.
  function alignBlock(blockEl, map, src) {
    if (!blockEl || !map || !isArr(map.runs) || typeof src !== 'string') return null;
    if (typeof map.len === 'number' && map.len !== src.length) return null;
    var T = textTable(blockEl, true);
    var runs = map.runs;
    var R = [];
    var r = 0;
    for (var i = 0; i < T.nodes.length; i++) {
      var data = T.nodes[i].data;
      var off = 0;
      while (r < runs.length && off < data.length) {
        var run = runs[r];
        var n = isArr(run) ? run[2] : 0;
        if (!(n > 0) || off + n > data.length) return null;
        for (var j = 0; j < n; j++) {
          var o = run[3] === 'subseq' ? (isArr(run[4]) ? run[4][j] : -1) : run[3] === 'unmapped' ? -1 : run[0] + j;
          if (!(o >= 0)) o = -1;
          else if (src.charAt(o) !== data.charAt(off + j)) return null;
          R.push(o);
        }
        off += n;
        r++;
      }
      if (off !== data.length) return null;
    }
    return r === runs.length ? { T: T, R: R } : null;
  }
  // [first, one past the last] index i in [lo, hi) whose R[i] passes ok, or
  // null when none does.
  function scan(R, lo, hi, ok) {
    var a = -1;
    var b = -1;
    for (var i = lo; i < hi; i++) {
      if (!ok(R[i])) continue;
      if (a < 0) a = i;
      b = i + 1;
    }
    return a < 0 ? null : [a, b];
  }
  // The slug of the nearest heading at or before source offset at, or null.
  function slugAt(map, at) {
    var hs = map && isArr(map.headings) ? map.headings : [];
    var slug = null;
    for (var k = 0; k < hs.length && hs[k].start <= at; k++) slug = hs[k].slug;
    return slug;
  }
  // The bracket: {start, end} or null.
  function bracket(src, q) {
    var p = String(q.prefix || '');
    var x = String(q.suffix || '');
    var k = p.length + 1;
    var at = -1;
    while (at < 0 && --k >= 8) at = src.indexOf(p.slice(p.length - k));
    if (at < 0 || src.indexOf(p.slice(p.length - k), at + 1) >= 0) return null;
    var a = at + k;
    var bound = q.exact.length * 2 + 64;
    var win = src.slice(a, a + bound + x.length);
    var b = -1;
    k = x.length + 1;
    while (b < 0 && --k >= 8) b = win.indexOf(x.slice(0, k));
    return b > 0 && b <= bound ? { start: a, end: a + b } : null;
  }

  // recordSource(blockEl, range, map, src, {md?}) -> {v: 1, kind: 'source',
  // md, slug, quote: {exact, prefix, suffix}, pos: {start, end}} over src's
  // offsets (from the first mapped character the range holds to the last), or
  // null when the range is collapsed, leaves the block, holds no mapped
  // character, is over CONFIG.quote_max, or the map does not align. md
  // defaults to the block's data-md-id.
  function recordSource(blockEl, range, map, src, opts) {
    opts = opts || {};
    var al = inside(blockEl, range) ? alignBlock(blockEl, map, src) : null;
    if (!al) return null;
    var w = scan(al.R, pointAt(al.T, range.startContainer, range.startOffset), pointAt(al.T, range.endContainer, range.endOffset),
      function (o) { return o >= 0; });
    if (!w) return null;
    var start = al.R[w[0]];
    var md = opts.md != null ? opts.md : blockEl.getAttribute('data-md-id');
    return quoted({ v: 1, kind: 'source', md: md, slug: slugAt(map, start) }, src, start, al.R[w[1] - 1] + 1);
  }

  // resolveSource(blockEl, src, map, rec, cfg?) -> {state, range, start, end,
  // how, occ} (+ dice on a fuzzy hit) over the CURRENT src and its map; how is
  // unique | context | slug | position | fuzzy | bracket | none | unaligned |
  // invalid-record. range spans the mapped characters whose source offsets lie
  // in the answer (null when there are none, or when orphaned).
  function resolveSource(blockEl, src, map, rec, cfg) {
    var c = merge(cfg);
    if (!validQuote(rec, 'source')) return orphan('invalid-record');
    var al = alignBlock(blockEl, map, src);
    if (!al) return orphan('unaligned');
    var hinted = typeof rec.slug === 'string' || rec.slug === null;
    var a = quoteRule(src, rec, c, hinted ? function (at) { return slugAt(map, at) === rec.slug; } : null);
    var br = a.state === ORPHANED && c.source_bracket ? bracket(src, rec.quote) : null;
    if (br) a = quoteAnswer(RE_RESOLVED, br.start, br.end, 'bracket', 0);
    if (a.state === ORPHANED) return a;
    var w = scan(al.R, 0, al.R.length, function (o) { return o >= a.start && o < a.end; });
    a.range = w && spanRange(blockEl.ownerDocument, al.T, w[0], w[1]);
    return a;
  }

  var api = {
    CONFIG: CONFIG,
    LIMITS: LIMITS,
    STATES: STATES,
    index: index,
    record: record,
    resolve: resolve,
    restamp: restamp,
    install: install,
    resolveAll: resolveAll,
    invalidate: invalidate,
    watch: watch,
    recordRange: recordRange,
    resolveRange: resolveRange,
    recordSource: recordSource,
    resolveSource: resolveSource
  };
  // Puts the api on the mount runtime (window.__wcMount.anchor in a document),
  // keys the index cache by its settle generation, and registers the settle
  // listener (one per factory: a second install moves it to the new runtime).
  // opts {budget_ms, schedule, now} set the shared loop's budget, scheduler and
  // clock; omitted, they are the defaults resolveAll uses.
  function install(M, opts) {
    if (!M) return api;
    M.anchor = api;
    if (unSettle) unSettle();
    unSettle = null;
    runtime = M;
    shared.o = opts || {};
    if (typeof M.onSettle === 'function') unSettle = M.onSettle(onSettled);
    return api;
  }
  return api;
}

const api = createAnchors(ANCHOR_STATES);

// The names the browser copies export, one per api function, in api order.
const FUNCTION_NAMES = Object.keys(api).filter((k) => typeof api[k] === 'function');

// The browser copy: an ES module assembled from the factory's own source.
// It never installs itself; the chrome's import and install are its wiring's.
let browserSrc = null;
function browserModuleSource() {
  if (browserSrc == null) {
    browserSrc = [
      '// Generated from lib/core/anchors.js + lib/core/anchor-states.js; do not edit, see those files.',
      `const ANCHOR_STATES = ${JSON.stringify(ANCHOR_STATES)};`,
      `const createAnchors = ${createAnchors.toString()};`,
      'const anchors = createAnchors(ANCHOR_STATES);',
      'export default anchors;',
      'export const CONFIG = anchors.CONFIG;',
      'export const LIMITS = anchors.LIMITS;',
      ...FUNCTION_NAMES.map((n) => `export const ${n} = anchors.${n};`),
      '',
    ].join('\n');
  }
  return browserSrc;
}

// The document copy: a classic script for previews, replay frames and exports.
// It installs the api on the mount runtime when the runtime is present.
let documentSrc = null;
function documentSource() {
  if (documentSrc == null) {
    documentSrc = [
      '(function () {',
      `var ANCHOR_STATES = ${JSON.stringify(ANCHOR_STATES)};`,
      `var createAnchors = ${createAnchors.toString()};`,
      'var anchors = createAnchors(ANCHOR_STATES);',
      "if (typeof window !== 'undefined' && window.__wcMount) anchors.install(window.__wcMount);",
      '})();',
      '',
    ].join('\n');
  }
  return documentSrc;
}

module.exports = { ...api, createAnchors, browserModuleSource, documentSource, ANCHOR_STATES };
