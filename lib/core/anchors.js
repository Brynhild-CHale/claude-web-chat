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
    ordinal: true
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
  function resolveAll() { throw new Error('anchors: resolveAll is not built'); }
  function invalidate() { throw new Error('anchors: invalidate is not built'); }
  function watch() { throw new Error('anchors: watch is not built'); }

  // ── range ──
  function recordRange() { throw new Error('anchors: recordRange is not built'); }
  function resolveRange() { throw new Error('anchors: resolveRange is not built'); }

  // ── source ──
  function recordSource() { throw new Error('anchors: recordSource is not built'); }
  function resolveSource() { throw new Error('anchors: resolveSource is not built'); }

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
  // Puts the api on the mount runtime (window.__wcMount.anchor in a document).
  function install(M) {
    if (M) M.anchor = api;
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
