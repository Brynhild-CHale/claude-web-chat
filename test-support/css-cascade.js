// A stylesheet read as a browser reads it, for the chrome tests that run in
// jsdom (which lays nothing out and cascades nothing): its rules parsed, matched
// against the live DOM with el.matches(), and cascaded — !important first, then
// specificity, then source order, then declaration order. The ONE copy: four
// test files each carried a private one until U111, and a fix to one copy (a
// specificity rule, !important, a media query) silently left the others wrong.
// test/css-cascade.test.js pins the branches and holds the tripwire that no file
// under test/ defines its own `function specificity(` or `function parseRules(`.
//
// What it understands, and no more: style rules, nested in @media (any other
// at-rule — @keyframes, @supports, @font-face — is skipped whole); selector
// lists split at top-level commas; specificity with :is()/:not()/:has()/
// :matches() taking their most specific argument, :where() counting zero, an
// attribute selector or a pseudo-class counting as a class, and a
// pseudo-element as an element. A selector jsdom cannot parse matches nothing.
// Shorthands are not expanded: `border` and `border-left` are separate
// properties, as the tests ask for them.
//
//   const { createCascade } = require('../test-support/css-cascade');
//   const css = createCascade(CSS, { win: () => W });   // W assigned in before()
//   css.value(el, 'display')                            // → 'block' | null
//   css.cascade(el, ['left', 'right'])                  // → the winning declaration
//   css.inherited(el, '--cs-pulse')                     // walks up parentElement
//
// `win` is a Window or a function returning the current one: a media query is
// evaluated against the window current at the call, its MediaQueryList cached
// per window (a WeakMap) and its `matches` read on every call, so a viewport
// flip that updates the list is seen, and two windows never share an answer.
// CommonJS, no dependencies; deliberately outside test/ (node --test would
// collect it).

// The stylesheet with every comment blanked to spaces, newlines kept, so every
// offset into the result is an offset into the source.
function stripComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

// The index of the bracket closing the one at `open` ('(' or '{').
function closing(text, open) {
  const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  throw new Error(`the stylesheet has an unbalanced '${o}'`);
}

// Every style rule in source order: {at, media, selector, decls}, `at` the
// offset of its selector in the text, `media` the @media condition it sits
// under (null at the top level), `decls` its [property, raw value] pairs.
// Pass comment-free text (stripComments) — a brace inside a comment is read.
function parseRules(text, base = 0, media = null, out = []) {
  for (let i = 0; ;) {
    const open = text.indexOf('{', i);
    if (open < 0) return out;
    const lead = text.slice(i, open);
    const prelude = lead.trim();
    const close = closing(text, open);
    const body = text.slice(open + 1, close);
    if (prelude.startsWith('@media')) parseRules(body, base + open + 1, prelude.slice('@media'.length).trim(), out);
    else if (!prelude.startsWith('@')) {
      const decls = [];
      for (const d of body.split(';')) {
        const c = d.indexOf(':');
        if (c > 0) decls.push([d.slice(0, c).trim(), d.slice(c + 1).trim()]);
      }
      out.push({ at: base + i + (lead.length - lead.trimStart().length), media, selector: prelude, decls });
    }
    i = close + 1;
  }
}

// A selector list split at its top-level commas.
function selectors(list) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

// Compares two [ids, classes, elements] triples: < 0, 0 or > 0.
const bySpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// One selector's specificity as [ids, classes, elements].
function specificity(sel) {
  const s = [0, 0, 0];
  const word = (j) => (/^-?[_a-zA-Z][\w-]*/.exec(sel.slice(j)) || [''])[0];
  for (let i = 0; i < sel.length;) {
    const c = sel[i];
    if (c === '#' || c === '.') { s[c === '#' ? 0 : 1]++; i += 1 + word(i + 1).length; }
    else if (c === '[') { s[1]++; i = sel.indexOf(']', i) + 1; }
    else if (c === ':') {
      const element = sel[i + 1] === ':';
      let j = i + (element ? 2 : 1);
      const name = word(j);
      j += name.length;
      let args = '';
      if (sel[j] === '(') { const end = closing(sel, j); args = sel.slice(j + 1, end); j = end + 1; }
      if (element) s[2]++;
      else if (/^(is|not|has|matches)$/.test(name)) {
        const top = selectors(args).map(specificity).sort(bySpec).pop() || [0, 0, 0];
        for (let k = 0; k < 3; k++) s[k] += top[k];
      } else if (name !== 'where') s[1]++;
      i = j;
    } else if (/[a-zA-Z]/.test(c)) { s[2]++; i += word(i).length; }
    else i++;
  }
  return s;
}

// Whether declaration `a` wins over `b`: !important first, then specificity,
// then the later rule, then the later declaration in the same rule.
function beats(a, b) {
  if (a.important !== b.important) return a.important;
  return (bySpec(a.spec, b.spec) || a.at - b.at || a.pos - b.pos) > 0;
}

function createCascade(css, { win } = {}) {
  const rules = parseRules(stripComments(css));
  const currentWindow = typeof win === 'function' ? win : () => win;
  const lists = new WeakMap();   // window → Map(media → MediaQueryList)

  function holds(media) {
    const W = currentWindow();
    if (!W || typeof W.matchMedia !== 'function') throw new Error(`css-cascade: no window to evaluate @media ${media} against`);
    let byMedia = lists.get(W);
    if (!byMedia) { byMedia = new Map(); lists.set(W, byMedia); }
    if (!byMedia.has(media)) byMedia.set(media, W.matchMedia(media));
    return byMedia.get(media).matches;
  }

  // The declaration that wins for `el` among `props` (a property name or an
  // array of them): {prop, value, important, spec, at, pos}, or null.
  function cascade(el, props, from = rules) {
    const wanted = Array.isArray(props) ? props : [props];
    let win = null;
    for (const r of from) {
      if (r.media && !holds(r.media)) continue;
      let spec = null;
      for (const sel of selectors(r.selector)) {
        let hit = false;
        try { hit = el.matches(sel); } catch { /* jsdom cannot parse it: no match */ }
        if (hit) {
          const sp = specificity(sel);
          if (!spec || bySpec(sp, spec) > 0) spec = sp;
        }
      }
      if (!spec) continue;
      r.decls.forEach(([prop, raw], pos) => {
        if (!wanted.includes(prop)) return;
        const important = /!\s*important$/.test(raw);
        const d = { prop, value: raw.replace(/\s*!\s*important$/, ''), important, spec, at: r.at, pos };
        if (!win || beats(d, win)) win = d;
      });
    }
    return win;
  }

  // The winning value of `prop` on `el` itself, or null.
  const value = (el, prop) => { const d = cascade(el, prop); return d ? d.value : null; };

  // The value of `name` on `el` or its nearest ancestor that declares it (a
  // custom property inherits), or null.
  function inherited(el, name) {
    for (let n = el; n; n = n.parentElement) {
      const d = cascade(n, name);
      if (d) return d.value;
    }
    return null;
  }

  return { rules, cascade, value, inherited };
}

module.exports = { stripComments, closing, parseRules, selectors, specificity, bySpec, beats, createCascade };
