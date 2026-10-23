// The hotkey registry (annotation engine 2D.3, W-6): the ONE table of the
// chrome's bindable actions, and the one place a keystroke becomes an action.
//
// Owners register into it; it imports none of them (shell.js registers the
// chrome's defaults in initShell, so there is no import cycle):
//
//   registerAction({id, label, defaultChord, context, whenField, rebindable,
//                   enabled?, legend?, run})
//       id           a chrome action id (the toolbar record's grammar,
//                    /^[a-z][a-z0-9.-]{0,63}$/): what a {kind: 'chrome', action}
//                    binding names. A second registration of an id throws.
//       defaultChord a chord, a list of chords, or null. A chord is the
//                    toolbar record's (lib/core/toolbar-record validChord:
//                    `[Shift+]<Key>`), except the one fixed `Mod+K` row, which
//                    no record can name (Mod+ is never bindable).
//       context      'page' | 'overlay' | 'replay' | 'drawer' | 'sheet', or a
//                    list of them: where the action answers. The shell looks
//                    up 'page', or 'overlay' while the graph overlay owns the
//                    keys; the others are modal contexts whose own handlers
//                    (graph-view.js, replay.js, drawer.js, sheet-drag.js) keep
//                    their keys, so their rows are descriptive until they move.
//       whenField    false (the default): a single key NEVER fires while a
//                    text field has focus, in the chrome or inside a pane.
//       rebindable   false: no record binding may name it (the palette's ⌘K,
//                    and every descriptive row).
//       enabled      () → boolean, read at the press: false and the press is
//                    the page's (M under a float preview or the replay).
//       legend       {section, order, row?, label?}: its place in the shortcut
//                    legend. Rows sharing `row` are drawn as one, keys in
//                    registration order.
//       run          what the key does; null for a descriptive row (the
//                    overlay's and the replay's keys, Escape).
//
//   chordOf(e)           the ONE normaliser of a keydown: a letter uppercased;
//                        Shift+ kept (a binding on X also answers Shift+X unless
//                        Shift+X has an entry of its own, as the head's switch
//                        matched every key but / whatever Shift said); Mod+ for
//                        metaKey or ctrlKey (Shift dropped under it); Alt never
//                        read (the shell's switch never read it). Escape, Tab
//                        and the bare modifiers → null.
//   lookup(chord, ctx, {inField})  → the resolved action ({id, label, run,
//                        …}) over default ⊕ user ⊕ project bindings, merged per
//                        key by /app/tier-merge.js, or null.
//   registerTargetKind(kind, resolve)  a binding kind this module cannot
//                        resolve itself (U337: 'slot', 'tool'). resolve(target)
//                        → {run, label?, context?, whenField?, enabled?} | null.
//   setDefaultSource(name, () => [{chord, target, label}])  a second source of
//                        defaults (U337: the tools' manifest defaults), merged
//                        after the chrome's; a chord the chrome (or an earlier
//                        source) already holds is left unbound and listed by
//                        conflicts().
//   bindingsView()       every chord with its target, tier, shadows, context and
//                        an `inert` reason (null when it works) — the hotkey
//                        pane's data (the pane itself is later).
//   conflicts()          the defaults left unbound because a chord was taken.
//   keyFor(id) / keysFor(id)  the display of an action's first / every bound
//                        chord ('⌘K', 'C', '[', '?', '⇧R'); '' / [] unbound.
//   onHotkeysChange(fn)  → unsubscribe; fn() after every re-merge.
//   registerKeyedElement(elId, actionId)  an element whose title, aria-label,
//                        aria-keyshortcuts or <kbd> name the action's key:
//                        rewritten from keyFor at init, on every rebind, and
//                        whenever its owner rewrites one of those attributes.
//   initHotkeys()        draw the legend (#key-legend .legend-card) and the
//                        keyed titles, and re-merge on every toolbar change.
//   createRegistry({records})  a registry of its own (the tests'); the module's
//                        exports are one wired to toolbar-state.js's records.
//
// Records: the user's bindings are the default tier for every project (H-4),
// the project's override them key by key; the project record binds slots and
// tools and may unbind any key, but a chrome action is rebound only in the user
// record (G1) — a project chrome binding is inert. The records are the
// daemon's to validate (lib/core/toolbar-record); this module reads what
// toolbar-state.js hands it and never writes one.
import { mergeByKey } from './tier-merge.js';
import { toolbarState, onToolbarChange } from './toolbar-state.js';

export const CONTEXTS = Object.freeze(['page', 'overlay', 'replay', 'drawer', 'sheet']);
const ID_RE = /^[a-z][a-z0-9.-]{0,63}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// e.key spellings that are not the key's own name.
const NAMED = Object.freeze({ ' ': 'Space', Spacebar: 'Space' });
const DISPLAY = Object.freeze({
  ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', ArrowRight: '→', Enter: '↵', Escape: 'Esc', Space: 'Space',
});
const NOT_KEYS = new Set(['Escape', 'Esc', 'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock',
  'Dead', 'Unidentified', 'Process', 'Compose', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'NumLock',
  'ScrollLock']);

// The key part of a chord from e.key, or null. Not a grammar: what the records
// may hold is lib/core/toolbar-record's validChord, which test/hotkeys.test.js
// holds this to.
function keyName(k) {
  if (typeof k !== 'string' || !k) return null;
  if (has(NAMED, k)) return NAMED[k];
  if (NOT_KEYS.has(k)) return null;
  if ([...k].length === 1) return /^[a-z]$/.test(k) ? k.toUpperCase() : k;
  return /^[A-Z][A-Za-z0-9]*$/.test(k) ? k : null;   // ArrowUp, Enter, F5, …
}

export function chordOf(e) {
  if (!e) return null;
  const key = keyName(e.key);
  if (!key) return null;
  if (e.metaKey || e.ctrlKey) return `Mod+${key}`;
  return e.shiftKey ? `Shift+${key}` : key;
}

export function displayChord(chord) {
  if (typeof chord !== 'string' || !chord) return '';
  if (chord.startsWith('Mod+')) return `⌘${displayChord(chord.slice(4))}`;
  if (chord.startsWith('Shift+')) return `⇧${displayChord(chord.slice(6))}`;
  return has(DISPLAY, chord) ? DISPLAY[chord] : chord;
}

const listOf = (v) => (v == null ? [] : Array.isArray(v) ? v.slice() : [v]);
const contextsOf = (c) => {
  const list = listOf(c === undefined ? 'page' : c);
  for (const x of list) {
    if (!CONTEXTS.includes(x)) throw new TypeError(`registerAction: context '${x}' is not one of ${CONTEXTS.join(', ')}`);
  }
  if (!list.length) throw new TypeError('registerAction: an action answers in at least one context');
  return Object.freeze(list);
};
const targetKey = (t) => (isObject(t)
  ? `${t.kind}:${t.action || t.type || (t.n !== undefined ? t.n : '')}:${t.profile || ''}` : String(t));

export function createRegistry({ records = () => ({ user: null, project: null }) } = {}) {
  const actions = new Map();      // id → frozen action, in registration order
  const kinds = new Map();        // kind → resolve
  const sources = new Map();      // name → () => [{chord, target, label}]
  const keyed = new Map();        // element id → {action, last}
  const listeners = new Set();
  let cache = null;               // {merged, conflicts, labels}

  function changed() {
    cache = null;
    for (const fn of [...listeners]) {
      try { fn(); } catch (err) { console.error('[hotkeys] a listener failed', err); }
    }
  }

  function registerAction(spec) {
    if (!isObject(spec)) throw new TypeError('registerAction: expects {id, label, defaultChord, context, run, …}');
    const { id, label, defaultChord = null, context, whenField = false, rebindable = true, enabled = null,
      legend = null, run = null } = spec;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`registerAction: '${id}' is not an action id`);
    if (actions.has(id)) throw new TypeError(`registerAction: '${id}' is already registered`);
    if (typeof label !== 'string' || !label) throw new TypeError(`registerAction: '${id}' needs a label`);
    if (run !== null && typeof run !== 'function') throw new TypeError(`registerAction: '${id}' run is a function or null`);
    if (enabled !== null && typeof enabled !== 'function') throw new TypeError(`registerAction: '${id}' enabled is a function`);
    const chords = listOf(defaultChord);
    for (const c of chords) {
      if (typeof c !== 'string' || !c) throw new TypeError(`registerAction: '${id}' has a chord that is not a string`);
    }
    if (legend !== null && !(isObject(legend) && typeof legend.section === 'string' && Number.isFinite(legend.order))) {
      throw new TypeError(`registerAction: '${id}' legend is {section, order, row?, label?}`);
    }
    const action = Object.freeze({
      id, label, chords: Object.freeze(chords), contexts: contextsOf(context), whenField: whenField === true,
      rebindable: run !== null && rebindable !== false, enabled, run,
      legend: legend ? Object.freeze({ ...legend }) : null,
    });
    actions.set(id, action);
    changed();
    return () => { if (actions.get(id) === action) { actions.delete(id); changed(); } };
  }

  function registerTargetKind(kind, resolve) {
    if (typeof kind !== 'string' || !kind || kind === 'chrome') throw new TypeError(`registerTargetKind: '${kind}' cannot be registered`);
    if (typeof resolve !== 'function') throw new TypeError('registerTargetKind: resolve must be a function');
    kinds.set(kind, resolve);
    changed();
    return () => { if (kinds.get(kind) === resolve) { kinds.delete(kind); changed(); } };
  }

  function setDefaultSource(name, fn) {
    if (typeof name !== 'string' || !name || name === 'chrome') throw new TypeError(`setDefaultSource: '${name}' cannot be a source`);
    if (fn !== null && typeof fn !== 'function') throw new TypeError('setDefaultSource: expects a function, or null to remove it');
    sources.delete(name);
    if (fn) sources.set(name, fn);
    changed();
  }

  function onHotkeysChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onHotkeysChange: fn must be a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // The default tier: the chrome's defaults (registration order, first claim
  // wins), then each source's in registration order, its entries by target.
  function defaults() {
    const record = {};
    const owner = {};               // chord → {source, target}
    const labels = {};              // chord → a source's label
    const conflicts = [];
    const claim = (source, chord, target, label) => {
      if (has(record, chord)) {
        conflicts.push(Object.freeze({ chord, winner: owner[chord], source, target, label: label || null }));
        return;
      }
      record[chord] = target;
      owner[chord] = Object.freeze({ source, target });
      if (label) labels[chord] = label;
    };
    for (const a of actions.values()) {
      if (!a.run) continue;
      for (const c of a.chords) claim('chrome', c, Object.freeze({ kind: 'chrome', action: a.id }), null);
    }
    for (const [name, fn] of sources) {
      let list = [];
      try { list = listOf(fn()); } catch (err) { console.error(`[hotkeys] default source '${name}' failed`, err); }
      const rows = list.filter((x) => isObject(x) && typeof x.chord === 'string' && x.chord && isObject(x.target))
        .sort((x, y) => (targetKey(x.target) < targetKey(y.target) ? -1 : targetKey(x.target) > targetKey(y.target) ? 1
          : (x.chord < y.chord ? -1 : x.chord > y.chord ? 1 : 0)));
      for (const r of rows) claim(name, r.chord, r.target, typeof r.label === 'string' ? r.label : null);
    }
    return { record, conflicts, labels };
  }

  function state() {
    if (cache) return cache;
    const d = defaults();
    let rec = {};
    try { rec = records() || {}; } catch { rec = {}; }
    const bindingsOf = (r) => (isObject(r) && isObject(r.bindings) ? r.bindings : null);
    let merged;
    try {
      merged = mergeByKey([
        { tier: 'default', record: d.record },
        { tier: 'user', record: bindingsOf(rec.user) },
        { tier: 'project', record: bindingsOf(rec.project) },
      ]);
    } catch (err) {
      console.error('[hotkeys] a binding record could not be merged; the defaults hold', err);
      merged = mergeByKey([{ tier: 'default', record: d.record }]);
    }
    cache = { merged, conflicts: Object.freeze(d.conflicts), labels: d.labels };
    return cache;
  }

  // A target → {action?, run, label, contexts, whenField, enabled} or {inert}.
  function resolve(target, tier) {
    if (!isObject(target)) return { inert: 'not a binding target' };
    if (target.kind === 'chrome') {
      const a = actions.get(target.action);
      if (!a) return { inert: `no chrome action '${target.action}'` };
      if (!a.run) return { inert: `'${a.id}' is a descriptive row` };
      if (tier === 'project') return { inert: 'a chrome action is rebound in the user record only' };
      if (tier !== 'default' && !a.rebindable) return { inert: `'${a.id}' is not rebindable` };
      return { action: a.id, label: a.label, run: a.run, contexts: a.contexts, whenField: a.whenField, enabled: a.enabled };
    }
    const r = kinds.get(target.kind);
    if (!r) return { inert: `no resolver for the kind '${target.kind}'` };
    let got = null;
    try { got = r(target); } catch (err) { console.error(`[hotkeys] the '${target.kind}' resolver failed`, err); }
    if (!isObject(got) || typeof got.run !== 'function') return { inert: `the '${target.kind}' resolver found nothing` };
    let contexts;
    try { contexts = contextsOf(got.context); } catch { return { inert: `the '${target.kind}' resolver named no context` }; }
    return { label: typeof got.label === 'string' ? got.label : '', run: got.run, contexts,
      whenField: got.whenField === true, enabled: typeof got.enabled === 'function' ? got.enabled : null };
  }

  function entryFor(chord) {
    const { merged } = state();
    if (has(merged, chord)) return merged[chord];
    // The head's switch matched every key but / whatever Shift said: a binding
    // on X answers Shift+X unless Shift+X has an entry of its own.
    if (chord.startsWith('Shift+') && has(merged, chord.slice(6))) return merged[chord.slice(6)];
    return null;
  }

  function lookup(chord, ctx = 'page', { inField = false } = {}) {
    if (typeof chord !== 'string' || !chord) return null;
    const entry = entryFor(chord);
    if (!entry || entry.value == null) return null;
    const r = resolve(entry.value, entry.tier);
    if (r.inert || !r.contexts.includes(ctx)) return null;
    if (inField && !r.whenField) return null;
    if (r.enabled && !r.enabled()) return null;
    return Object.freeze({ id: r.action || null, label: r.label, run: r.run, tier: entry.tier, chord });
  }

  function bindingsView() {
    const { merged, labels } = state();
    const out = [];
    for (const chord of Object.keys(merged)) {
      const e = merged[chord];
      const r = e.value == null ? null : resolve(e.value, e.tier);
      out.push(Object.freeze({
        chord, display: displayChord(chord), target: e.value, tier: e.tier, shadows: e.shadows,
        context: r && r.contexts ? r.contexts : null,
        label: (r && r.label) || labels[chord] || '',
        action: (r && r.action) || null,
        unbound: e.value == null,
        inert: e.value == null ? null : (r.inert || null),
      }));
    }
    for (const a of actions.values()) {
      if (a.run) continue;
      for (const chord of a.chords) {
        out.push(Object.freeze({
          chord, display: displayChord(chord), target: Object.freeze({ kind: 'chrome', action: a.id }), tier: 'default',
          shadows: Object.freeze([]), context: a.contexts, label: a.label, action: a.id, unbound: false,
          inert: null, descriptive: true,
        }));
      }
    }
    return Object.freeze(out);
  }

  function conflicts() { return state().conflicts; }

  // The chords that run an action now: its defaults first (in their order,
  // while still bound to it), then any other chord bound to it, in key order.
  function chordsFor(id) {
    const a = actions.get(id);
    if (!a) return [];
    if (!a.run) return a.chords.slice();
    const { merged } = state();
    const bound = (c) => {
      const e = merged[c];
      if (!e || !isObject(e.value) || e.value.kind !== 'chrome' || e.value.action !== id) return false;
      return !resolve(e.value, e.tier).inert;
    };
    const first = a.chords.filter(bound);
    const rest = Object.keys(merged).filter((c) => !first.includes(c) && bound(c));
    return [...first, ...rest];
  }
  const keysFor = (id) => chordsFor(id).map(displayChord);
  const keyFor = (id) => keysFor(id)[0] || '';

  // ── what is drawn from the table ───────────────────────────────────────────

  // The legend's sections and rows, in order: [{title, rows: [{label, keys}]}].
  // A bound action shows its first key; a descriptive row every key it lists.
  function legendModel() {
    const rows = [];
    const byRow = new Map();
    for (const a of actions.values()) {
      if (!a.legend) continue;
      const keys = a.run ? (keyFor(a.id) ? [keyFor(a.id)] : []) : a.chords.map(displayChord);
      const rk = a.legend.row ? `${a.legend.section}\u0000${a.legend.row}` : null;
      if (rk && byRow.has(rk)) { byRow.get(rk).keys.push(...keys); continue; }
      const row = { section: a.legend.section, order: a.legend.order, label: a.legend.label || a.label, keys };
      if (rk) byRow.set(rk, row);
      rows.push(row);
    }
    rows.sort((x, y) => x.order - y.order);
    const sections = [];
    for (const r of rows) {
      let s = sections.find((x) => x.title === r.section);
      if (!s) { s = { title: r.section, rows: [] }; sections.push(s); }
      if (r.keys.length) s.rows.push({ label: r.label, keys: r.keys });
    }
    return sections;
  }

  // Into #key-legend .legend-card, as index.html wrote it by hand before: an
  // <h3> per section (the later ones .legend-sub), a .legend-row per row with a
  // <span> label and a .keys <span> of <kbd>s — no ids — and index.html's own
  // indentation between them, so the markup is the same byte for byte.
  function drawLegend() {
    const card = document.querySelector('#key-legend .legend-card');
    if (!card) return;
    const nodes = [];
    const indent = () => document.createTextNode('\n        ');
    legendModel().forEach((s, i) => {
      const h = document.createElement('h3');
      if (i > 0) h.className = 'legend-sub';
      h.textContent = s.title;
      nodes.push(indent(), h);
      for (const r of s.rows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const label = document.createElement('span');
        label.textContent = r.label;
        const keys = document.createElement('span');
        keys.className = 'keys';
        for (const k of r.keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          keys.appendChild(kbd);
        }
        row.append(label, keys);
        nodes.push(indent(), row);
      }
    });
    nodes.push(document.createTextNode('\n      '));
    card.replaceChildren(...nodes);
  }

  function registerKeyedElement(elId, actionId) {
    if (typeof elId !== 'string' || !elId || typeof actionId !== 'string') {
      throw new TypeError('registerKeyedElement: expects (element id, action id)');
    }
    if (keyed.has(elId)) return;
    const a = actions.get(actionId);
    const shipped = a && a.chords.length ? a.chords[0] : '';
    // `last`: what this module last made each attribute say (the shipped key
    // until a rebind); `stripped`: an attribute whose key it took out.
    keyed.set(elId, { action: actionId, shipped, last: displayChord(shipped), lastChord: shipped,
      stripped: new Set(), el: null });
    if (drawn) drawKeyed();
  }

  // The key inside an owner's text: ' · K' at the end or before another ' · ',
  // and '(K)' anywhere. Only that token is touched, so an owner that writes the
  // rest of its title (drawer.js's count, theme.js under a one-mode pack) keeps
  // it. → the new text, or null when no candidate key is in it.
  function swapDot(text, cands, next) {
    for (const c of cands) {
      const tok = ` · ${c}`;
      for (let i = text.indexOf(tok); i !== -1; i = text.indexOf(tok, i + 1)) {
        const after = text.slice(i + tok.length);
        if (after === '' || after.startsWith(' · ')) return text.slice(0, i) + (next ? ` · ${next}` : '') + after;
      }
    }
    return null;
  }
  function swapParen(text, cands, next) {
    for (const c of cands) {
      const tok = `(${c})`;
      const i = text.indexOf(tok);
      if (i === -1) continue;
      if (next) return text.slice(0, i) + `(${next})` + text.slice(i + tok.length);
      return text.slice(0, i > 0 && text[i - 1] === ' ' ? i - 1 : i) + text.slice(i + tok.length);
    }
    return null;
  }
  const ariaChord = (c) => (c.startsWith('Mod+') ? `Meta+${c.slice(4)}` : c);

  function setAttr(el, name, v) { if (el.getAttribute(name) !== v) el.setAttribute(name, v); }
  function drawOne(elId, k) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (k.el !== el) {
      k.el = el;
      const MO = typeof window !== 'undefined' && window.MutationObserver;
      // An owner that rewrites its title (drawer.js, theme.js, chat-bar.js) is
      // put back on the bound key at once.
      if (MO) new MO(() => drawOne(elId, k)).observe(el, { attributes: true, attributeFilter: ['title', 'aria-label', 'aria-keyshortcuts'] });
    }
    const chord = chordsFor(k.action)[0] || '';
    const next = displayChord(chord);
    const cands = [...new Set([k.last, displayChord(k.shipped)].filter(Boolean))];
    for (const [name, order] of [['title', [swapDot, swapParen]], ['aria-label', [swapParen, swapDot]]]) {
      const text = el.getAttribute(name);
      if (text === null) continue;
      let out = null;
      for (const f of order) { out = f(text, cands, next); if (out !== null) break; }
      if (out === null && next && k.stripped.has(name)) out = name === 'title' ? `${text} · ${next}` : `${text} (${next})`;
      if (out === null) continue;
      if (next) k.stripped.delete(name); else k.stripped.add(name);
      setAttr(el, name, out);
    }
    const ks = el.getAttribute('aria-keyshortcuts');
    if (ks !== null && [k.lastChord, k.shipped].filter(Boolean).map(ariaChord).includes(ks)) {
      if (chord) setAttr(el, 'aria-keyshortcuts', ariaChord(chord)); else el.removeAttribute('aria-keyshortcuts');
    }
    for (const kbd of el.querySelectorAll(':scope > kbd')) {
      if (cands.includes(kbd.textContent) || (kbd.hidden && !kbd.textContent)) {
        if (kbd.textContent !== next) kbd.textContent = next;
        if (kbd.hidden !== !next) kbd.hidden = !next;
      }
    }
    k.last = next;
    k.lastChord = chord;
  }
  function drawKeyed() { for (const [elId, k] of keyed) drawOne(elId, k); }

  let drawn = false;
  function redraw() {
    if (!drawn) return;
    drawLegend();
    drawKeyed();
  }
  listeners.add(redraw);

  function init() {
    drawn = true;
    drawLegend();
    drawKeyed();
  }

  return {
    registerAction, registerTargetKind, setDefaultSource, onHotkeysChange, lookup, bindingsView, conflicts,
    keyFor, keysFor, legendModel, registerKeyedElement, init, refresh: changed,
    actionOf: (id) => actions.get(id) || null,
  };
}

// ── the chrome's registry, over toolbar-state.js's records ────────────────────

const registry = createRegistry({
  records: () => { const s = toolbarState(); return { user: s.user, project: s.project }; },
});

export const registerAction = registry.registerAction;
export const registerTargetKind = registry.registerTargetKind;
export const setDefaultSource = registry.setDefaultSource;
export const onHotkeysChange = registry.onHotkeysChange;
export const lookup = registry.lookup;
export const bindingsView = registry.bindingsView;
export const conflicts = registry.conflicts;
export const keyFor = registry.keyFor;
export const keysFor = registry.keysFor;
export const registerKeyedElement = registry.registerKeyedElement;

let wired = false;
export function initHotkeys() {
  if (wired) return;
  wired = true;
  onToolbarChange(() => registry.refresh());
  registry.init();
}
