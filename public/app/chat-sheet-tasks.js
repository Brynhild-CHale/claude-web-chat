// The phone sheet's Tasks view (design spec §8.6; §8.4's chat:tasks; §7.6's
// rows, actions and the one confirm; §7.12's detail views at the touch density;
// §6.9; deviation 18; rulings E1 (a) and B3 (a)).
//
//   initSheetTasks()   registers the sheet view 'tasks' (chat-sheet.js
//                      registerSheetView); idempotent
//   stopSheetTasks()   unregisters it: its bus listeners, its pending frame and
//                      every page it pushed go
//
// THE ROOT, in #sh-tasks: sheet-model.js's categoryLines over chat-present.js's
// categories(mirror, queueSnapshot(), {now}) — shells, agents, workflows,
// monitors, then the Queue line, which is always there. Each line is a 60 px
// button.sh-line[data-cs-cat] (the category's ink is U17's [data-cs-cat]): a
// .sh-dot (data-pulse only while Claude works on something that runs in it), a
// .sh-ltitle (mono for a shell's command), a .sh-ltag (the singular tag, for a
// category of one), a .sh-lmeta, the step bars of a workflow and a .sh-lline.
// No task category at all: one muted .sh-empty line (deviation 18). Below
// `read` every line shows its counts only and only the Queue line is a button;
// the others are plain rows, out of the tab order. A line pushes its category's
// page; the Queue line shows U70's kept page (showPage('tasks', 'queue')).
//
// A CATEGORY PAGE ('‹ Tasks', the category's title and sub) lists its rows with
// chat-rows.js's rowEl at the touch density, keyed by id and redrawn in place
// with updateRow, so an armed confirm survives a redraw. Kill, Cancel and
// Remove go through chat-actions.js's runAction — the one confirm (two taps at
// this density), the registered stopper (E1 a), the one route; never a second
// confirm and never a POST of this module's own. Output and Open push a DETAIL
// PAGE ('‹ Shells', …) holding chat-detail.js's registered 'task' view
// (chat-panel.js detailOf, B3 a), which follows and says "No longer running"
// by itself. The view sits in a host of this module's whose `hidden` says
// whether it is on screen — the sheet open, on Tasks, the page on top — so it
// pauses its followers while the sheet shows Chat, as while covered. A category that leaves the store while its
// page is open keeps its last rows, without their actions, under that line.
//
// RENDERING: only the visible page renders — the sheet open, on Tasks, narrow —
// and bus 'mirror' and 'queue' are coalesced to ONE animation frame; a 'sheet'
// event (open, close, a segment or a page change: never a drag frame) draws the
// page now on screen at once. A closed sheet draws nothing here (chat-sheet.js
// keeps the tab, the badge and the segment's count). No interval and no timer.
// A page's cleanup ends what it added: its followers (stopFollowers) and its
// row map, and a detail's own view. Every page this view pushed is tracked
// until its cleanup runs, so the unmount pops them all, whichever segment is
// selected.
//
// chat:tasks {category?}, while the sheet is active (initialised and narrow),
// opens Tasks at least half on that category's page, or on the root when the
// category has none; at desktop width the trays answer it (chat-trays.js).
import { isNarrow } from './viewport.js';
import { mirror, serverNow, atLeast } from './chat-state.js';
import { categories } from './chat-present.js';
import { queueSnapshot } from './queue.js';
import { categoryLines } from './sheet-model.js';
import { registerSheetView } from './chat-sheet.js';
import { rowEl, updateRow } from './chat-rows.js';
import { runAction, stopFollowers } from './chat-actions.js';
import { detailOf } from './chat-panel.js';
import { GONE } from './chat-detail.js';

export const VIEW = 'tasks';
export const QUEUE_PAGE = 'queue';
const DETAIL = 'task:';                 // a detail page's key: 'task:' + the row's id
const WORKING = new Set(['working', 'compacting']);

let unregister = null;   // registerSheetView's
let S = null;            // the mounted view's state (one mount at a time)

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function setText(e, s) { if (e.textContent !== s) e.textContent = s; }
function setData(e, name, value) {
  if (value === null || value === undefined || value === false) { if (name in e.dataset) delete e.dataset[name]; }
  else if (e.dataset[name] !== String(value)) e.dataset[name] = String(value);
}

// Whether Claude is at it anywhere: a conversation's live state, or — below
// `read`, where there is no live state — its status row (chat-present's own
// per-conversation rule, over every conversation).
function working() {
  const convs = mirror.conversations instanceof Map ? mirror.conversations : new Map();
  const rows = mirror.status instanceof Map ? mirror.status : new Map();
  for (const c of convs.values()) if (c && c.live && WORKING.has(c.live.state)) return true;
  for (const [id, r] of rows) {
    const c = convs.get(id);
    if (c && c.live) continue;
    if (r && WORKING.has(r.state)) return true;
  }
  return false;
}

const levelOf = () => (mirror.access && mirror.access.level) || 'off';
const snapshot = () => categories(mirror, queueSnapshot(), { now: serverNow() });

// ── the root ─────────────────────────────────────────────────────────────────

function lineEl(tappable) {
  const e = tappable ? el('button', 'sh-line') : el('div', 'sh-line');
  if (tappable) e.type = 'button';
  const dot = el('span', 'sh-dot');
  dot.setAttribute('aria-hidden', 'true');
  const text = el('span', 'sh-ltext');
  const head = el('span', 'sh-lhead');
  head.append(el('span', 'sh-ltitle'), el('span', 'sh-ltag'), el('span', 'sh-lmeta'));
  text.append(head, el('span', 'sh-lline'));
  e.append(dot, text);
  if (tappable) {
    const go = el('span', 'sh-lgo', '›');
    go.setAttribute('aria-hidden', 'true');
    e.append(go);
  }
  return e;
}

function paintSteps(text, steps) {
  let bar = text.querySelector('.sh-lsteps');
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) { if (bar) bar.remove(); return; }
  const key = list.map((s) => `${s.state}\u0000${s.label || ''}`).join('\u0001');
  if (bar && bar.dataset.key === key) return;
  if (!bar) {
    bar = el('span', 'sh-lsteps');
    bar.setAttribute('aria-hidden', 'true');
    text.insertBefore(bar, text.querySelector('.sh-lline'));
  }
  bar.dataset.key = key;
  bar.replaceChildren(...list.map((s) => {
    const seg = el('span', 'sh-lstep');
    seg.dataset.stepState = s.state || 'pending';
    if (s.label) seg.title = s.label;
    return seg;
  }));
}

function paintLine(e, line) {
  setData(e, 'csCat', line.cat);
  setData(e, 'countsOnly', line.countsOnly ? 'true' : null);
  const dot = e.querySelector('.sh-dot');
  setData(dot, 'csTone', line.tone || 'muted');
  setData(dot, 'pulse', line.pulse ? 'true' : null);
  const title = e.querySelector('.sh-ltitle');
  setText(title, line.title || '');
  title.classList.toggle('sh-mono', !!line.mono && !line.countsOnly);
  // Below `read`: the counts, nothing that names the work.
  const tag = e.querySelector('.sh-ltag');
  const t = line.countsOnly ? '' : line.tag || '';
  setText(tag, t);
  tag.hidden = !t;
  const meta = e.querySelector('.sh-lmeta');
  setText(meta, line.meta || '');
  meta.hidden = !line.meta;
  const text = e.querySelector('.sh-ltext');
  paintSteps(text, line.countsOnly ? null : line.steps);
  const l = e.querySelector('.sh-lline');
  const s = line.countsOnly ? '' : line.line || '';
  setText(l, s);
  l.hidden = !s;
}

function renderRoot() {
  const R = S.root;
  const { lines, emptyNote } = categoryLines(snapshot(), {
    level: levelOf(), working: working(), parked: !!queueSnapshot().parked,
  });
  const want = [];
  const seen = new Set();
  for (const line of lines) {
    seen.add(line.cat);
    let e = S.lines.get(line.cat);
    const tappable = !!line.tappable;
    if (e && (e.tagName === 'BUTTON') !== tappable) { e.remove(); e = null; }
    if (!e) { e = lineEl(tappable); S.lines.set(line.cat, e); }
    paintLine(e, line);
    if (line.cat === 'queue' && emptyNote) want.push(S.empty);
    want.push(e);
  }
  if (emptyNote) {
    setText(S.empty, emptyNote);
    if (!want.includes(S.empty)) want.push(S.empty);
  }
  for (const [cat, e] of [...S.lines]) if (!seen.has(cat)) { S.lines.delete(cat); e.remove(); }
  if (!emptyNote) S.empty.remove();
  want.forEach((e, i) => { if (R.children[i] !== e) R.insertBefore(e, R.children[i] || null); });
}

function onRootClick(e) {
  const t = e.target;
  const b = t && typeof t.closest === 'function' ? t.closest('button.sh-line') : null;
  if (!b || !S || !S.root.contains(b)) return;
  const cat = b.dataset.csCat;
  if (cat === 'queue') { S.api.showPage(VIEW, QUEUE_PAGE); return; }
  pushCategory(cat);
}

// ── a category page ──────────────────────────────────────────────────────────

const pageHead = (body) => {
  const page = body && body.parentElement;
  return page ? { title: page.querySelector('.sh-ptitle'), sub: page.querySelector('.sh-psub') } : { title: null, sub: null };
};

function pushCategory(cat) {
  if (!S) return null;
  const entry = snapshot().find((x) => x.cat === cat);
  if (!entry || entry.hidden || !entry.rows.length || cat === 'queue') return null;
  return S.api.pushPage(VIEW, {
    key: cat,
    title: entry.title,
    sub: entry.sub || '',
    back: '‹ Tasks',
    render: (body) => mountCategory(body, cat, entry),
  });
}

function mountCategory(body, cat, entry) {
  const list = el('div', 'sh-rows');
  list.setAttribute('role', 'list');
  const gone = el('p', 'sh-gone', GONE);
  gone.setAttribute('role', 'status');
  gone.hidden = true;
  body.append(gone, list);
  const P = { cat, body, list, gone, title: entry.title, rows: new Map(), models: new Map(), isGone: false };
  const mine = S;
  const onClick = (e) => onRowClick(P, e);
  list.addEventListener('click', onClick);
  mine.pages.set(cat, P);
  mine.pushed.add(P);
  paintCategory(P, entry);
  return () => {
    list.removeEventListener('click', onClick);
    stopFollowers(body);
    P.rows.clear();
    P.models.clear();
    mine.pushed.delete(P);
    if (mine.pages.get(cat) === P) mine.pages.delete(cat);
  };
}

function paintCategory(P, entry) {
  if (!entry || !entry.rows.length) {
    // Gone from the store: the last rows stay, with nothing to act on.
    if (P.isGone) return;
    P.isGone = true;
    stopFollowers(P.body);
    for (const [id, e] of P.rows) {
      const m = P.models.get(id);
      if (m) updateRow(e, { ...m, pulse: false, actions: [] });
    }
    P.gone.hidden = false;
    return;
  }
  P.isGone = false;
  P.gone.hidden = true;
  P.title = entry.title;
  const head = pageHead(P.body);
  if (head.title) setText(head.title, entry.title || '');
  if (head.sub) setText(head.sub, entry.sub || '');
  const seen = new Set();
  entry.rows.forEach((model, i) => {
    seen.add(model.id);
    P.models.set(model.id, model);
    let e = P.rows.get(model.id);
    if (e) updateRow(e, model);
    else { e = rowEl(model, { density: 'touch' }); P.rows.set(model.id, e); }
    if (P.list.children[i] !== e) P.list.insertBefore(e, P.list.children[i] || null);
  });
  for (const [id, e] of [...P.rows]) {
    if (seen.has(id)) continue;
    P.rows.delete(id);
    P.models.delete(id);
    stopFollowers(e);
    e.remove();
  }
}

function onRowClick(P, e) {
  const t = e.target;
  const btn = t && typeof t.closest === 'function' ? t.closest('button[data-action]') : null;
  if (!btn || btn.disabled || !P.list.contains(btn) || P.isGone) return;
  const row = btn.closest('.cs-row');
  const model = row ? P.models.get(row.dataset.rowId) : null;
  if (!model) return;
  const action = btn.dataset.action;
  if (action === 'output' || action === 'open') { pushDetail(model, P.title); return; }
  runAction(model, action, { rowEl: row, density: 'touch', button: btn });
}

// ── a detail page: §7.12's view, inside the Tasks stack (ruling B3 a) ────────

// Whether a detail page's view is on screen: the sheet open on Tasks, and the
// page on top of its stack (or being pushed there). chat-detail.js watches the
// host's `hidden` and pauses or resumes the view's followers with it.
function syncHost(D, pushing = false) {
  if (!S) return;
  const st = S.api.state();
  const hidden = !(st.open && st.view === VIEW && (pushing || st.page === D.key));
  if (D.host.hidden !== hidden) D.host.hidden = hidden;
}
function syncHosts() {
  if (!S) return;
  for (const D of S.pushed) if (D.host) syncHost(D);
}

function pushDetail(model, catTitle) {
  if (!S) return null;
  const key = DETAIL + model.id;
  const api = S.api;
  return api.pushPage(VIEW, {
    key,
    title: model.title || '',
    back: `‹ ${catTitle || 'Tasks'}`,
    render: (body) => {
      const mine = S;
      const D = { key, host: null };
      mine.pushed.add(D);
      const render = detailOf('task');
      if (!render) {
        body.append(el('p', 'sh-gone', 'This view could not be shown.'));
        return () => { mine.pushed.delete(D); stopFollowers(body); };
      }
      // body > .sh-dhost > the view's own body: the host is the view's parent.
      const host = el('div', 'sh-dhost');
      const inner = el('div', 'sh-dbody');
      host.append(inner);
      body.append(host);
      D.host = host;
      syncHost(D, true);
      const head = pageHead(body);
      let cleanup = null;
      try {
        cleanup = render(inner, { id: model.id }, {
          close: () => { if (api.state().page === key) api.popPage(VIEW); },
          setTitle: (t) => { if (head.title) setText(head.title, String(t || '')); },
        });
      } catch (e) {
        console.error('[web-chat] a Tasks detail page failed to render', e);
      }
      return () => {
        mine.pushed.delete(D);
        if (typeof cleanup === 'function') {
          try { cleanup(); } catch (e) { console.error('[web-chat] a Tasks detail page failed to clean up', e); }
        }
        stopFollowers(body);
      };
    },
  });
}

// ── rendering ────────────────────────────────────────────────────────────────

// The page on screen, when the Tasks view is: null (nothing of ours), 'root',
// or a category page's record. A detail page draws itself (chat-detail.js).
function visiblePage() {
  if (!S || !isNarrow()) return null;
  const st = S.api.state();
  if (!st.open || st.view !== VIEW) return null;
  if (!st.page) return 'root';
  return S.pages.get(st.page) || null;
}

function render() {
  cancelFrame();
  const at = visiblePage();
  if (!at) return;
  if (at === 'root') { renderRoot(); return; }
  if (!atLeast(levelOf(), 'read')) {
    // The level fell below `read`: the rows are no longer this viewer's, whether
    // the category is still counted or not.
    while (S && S.pushed.size && S.api.popPage(VIEW));
    return;
  }
  paintCategory(at, snapshot().find((x) => x.cat === at.cat));
}

function cancelFrame() {
  if (!S || S.frame === null) return;
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(S.frame);
  S.frame = null;
}

// Every 'mirror' and 'queue' of one frame is one render, and only of a page on screen.
function schedule() {
  if (!S || S.frame !== null || !visiblePage()) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') { render(); return; }
  S.frame = raf(() => { if (S) S.frame = null; render(); });
}

// chat:tasks {category?}: Tasks, at least half, on that category's page or the root.
function onTasks(detail) {
  if (!S || !isNarrow()) return;
  const want = detail && typeof detail.category === 'string' ? detail.category : null;
  while (S.api.popPage(VIEW));
  if (want === 'queue') { S.api.openSheet({ view: VIEW, min: 'half', page: QUEUE_PAGE }); return; }
  if (want) pushCategory(want);
  S.api.openSheet({ view: VIEW, min: 'half' });
}

// ── the view ─────────────────────────────────────────────────────────────────

function mount(api) {
  const root = el('div', 'sh-root');
  const empty = el('p', 'sh-empty');
  // pages: the category pages by key; pushed: every page this view pushed
  // (category and detail records) until its cleanup runs.
  S = { api, root, empty, lines: new Map(), pages: new Map(), pushed: new Set(), frame: null };
  const mine = S;
  api.views.tasks.prepend(root);
  root.addEventListener('click', onRootClick);
  api.on('mirror', schedule);
  api.on('queue', schedule);
  api.on('sheet', () => { syncHosts(); render(); });
  api.on('chat:tasks', onTasks);
  render();
  return () => {
    if (S !== mine) return;
    cancelFrame();
    // The pages this view pushed go with it (each one's cleanup runs on its pop
    // and drops it from `pushed`); popPage works on the Tasks stack whichever
    // segment is selected.
    while (mine.pushed.size && api.popPage(VIEW));
    root.removeEventListener('click', onRootClick);
    root.remove();
    mine.lines.clear();
    mine.pages.clear();
    mine.pushed.clear();
    S = null;
  };
}

export function initSheetTasks() {
  if (unregister) return true;
  unregister = registerSheetView(VIEW, mount);
  return true;
}

export function stopSheetTasks() {
  const off = unregister;
  unregister = null;
  if (off) off();
}
