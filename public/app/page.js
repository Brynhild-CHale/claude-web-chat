// The live PAGE — #main as one ordered sequence of markdown chunks and panes
// (plan §2b D3). Consecutive panes form a GRID RUN, each its own 12-column grid
// (public/page.css); a markdown chunk sits between runs at reading width; the
// `#`/`##` headings in the markdown build the Contents nav, the topbar title and
// the ⌘K "section" rows. There is no stored section structure — everything here
// is derived from the sequence on every layout.
//
// Ownership:
//   * the pane RECORDS (mount, remove, pane_state, drag, resize) stay in
//     mounts.js — this module only decides WHERE each pane's wrapper sits;
//   * the page RECORD (markdown items, the order, Claude's baseline order, the
//     run flags) lives here, fed by applySnapshot (mounts.js) and the page
//     frames (ws.js), and folded aside while previewing exactly like panes are;
//   * markdown is rendered by the ONE renderer (lib/core/markdown, served as
//     /app/markdown.js) — every character already escaped, so its output is the
//     only innerHTML here that is not static markup.
//
// Stable DOM: layoutPage() moves an element only when it is out of place, and
// orders panes INSIDE a run with CSS `order`, never by moving them — so a
// markdown edit, a re-render, a drag or Claude's reorder never re-parents an
// unrelated pane (a moved <iframe> reloads). Only a change of run membership (a
// markdown chunk written between two panes) re-parents the panes it moves.
import { $, view } from './state.js';
import { renderMarkdown, headings } from './markdown.js';
import { panes, readOnlyNow, unminimize, blockType } from './mounts.js';
import { isPhone } from './viewport.js';
import { labelFor, nodeById, nodeTime } from './labels.js';

export const COLS = 12;
export const ROW_PX = 40;
export const GAP_PX = 14;
export const ROWS_MIN = 2;
export const ROWS_MAX = 24;
export const SPAN_MIN = 2;

// ── the page record ─────────────────────────────────────────────────────────
// { markdown: Map<id,{text,owner}>, order: [id…], claudeOrder: [id…],
//   runs: {anchor: {stacks:false}}, updatedAt: ms|null }
// The same shape for the live page and for the copy a preview folds aside.
export function emptyPage() {
  return { markdown: new Map(), order: [], claudeOrder: [], runs: {}, updatedAt: null };
}

// The page half of a snapshot-shaped value — a hello/reset frame, a graph node,
// or a record already built (a folded live surface carries one as `page`).
export function pageFromFrame(f) {
  if (f && f.page && f.page.markdown instanceof Map) return clonePage(f.page);
  const rec = emptyPage();
  for (const m of (Array.isArray(f && f.markdown) ? f.markdown : [])) {
    if (m && m.id != null) rec.markdown.set(String(m.id), { text: String(m.text == null ? '' : m.text), owner: m.owner || null });
  }
  rec.order = Array.isArray(f && f.order) ? f.order.map(String) : [];
  rec.claudeOrder = Array.isArray(f && f.claude_order) ? f.claude_order.map(String) : rec.order.slice();
  const runs = f && f.runs && typeof f.runs === 'object' && !Array.isArray(f.runs) ? f.runs : {};
  for (const [a, fl] of Object.entries(runs)) if (fl && fl.stacks === false) rec.runs[a] = { stacks: false };
  return rec;
}

export function clonePage(rec) {
  return {
    markdown: new Map([...rec.markdown].map(([id, m]) => [id, { ...m }])),
    order: rec.order.slice(),
    claudeOrder: rec.claudeOrder.slice(),
    runs: { ...rec.runs },
    updatedAt: rec.updatedAt,
  };
}

// The live page. Mutated in place; replaced wholesale only by setPage.
export const page = emptyPage();

export function setPage(rec, updatedAt = null) {
  page.markdown = rec.markdown;
  page.order = rec.order;
  page.claudeOrder = rec.claudeOrder;
  page.runs = rec.runs;
  page.updatedAt = updatedAt != null ? updatedAt : (rec.updatedAt || null);
}

function dropId(seq, id) {
  const i = seq.indexOf(id);
  if (i !== -1) seq.splice(i, 1);
}

// One page frame applied to a record — the live page (ws.js, then layoutPage)
// or the live surface folded aside while previewing. Returns whether it was a
// page frame at all.
export function applyPageFrame(rec, msg) {
  if (!rec || !msg) return false;
  const withOrder = () => {
    if (Array.isArray(msg.order)) rec.order = msg.order.map(String);
    if (Array.isArray(msg.claude_order)) rec.claudeOrder = msg.claude_order.map(String);
  };
  switch (msg.type) {
    case 'markdown':
      rec.markdown.set(String(msg.id), { text: String(msg.text == null ? '' : msg.text), owner: msg.owner || null });
      withOrder();
      rec.updatedAt = Date.now();
      return true;
    case 'markdown:remove':
      rec.markdown.delete(String(msg.id));
      dropId(rec.order, String(msg.id));
      dropId(rec.claudeOrder, String(msg.id));
      delete rec.runs[String(msg.id)];
      rec.updatedAt = Date.now();
      return true;
    case 'page:order':
      withOrder();
      return true;
    case 'page:run':
      if (msg.stacks === false) rec.runs[String(msg.anchor)] = { stacks: false };
      else delete rec.runs[String(msg.anchor)];
      return true;
    case 'render':
      // A pane placed with `after` carries the resulting order.
      withOrder();
      rec.updatedAt = Date.now();
      return true;
    default:
      return false;
  }
}

// ── the sequence ────────────────────────────────────────────────────────────
// The page order over what is actually on the page: the record's order for the
// ids it names, then any pane it does not (a pane rendered without `after` is
// appended — the server's rule — and a node written before `order` existed
// reads its panes in mount order), then any markdown it does not.
export function sequence() {
  const out = [];
  const seen = new Set();
  const known = (id) => page.markdown.has(id) || panes.has(id);
  for (const id of page.order) if (known(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  for (const id of panes.keys()) {
    if (seen.has(id)) continue;
    seen.add(id); out.push(id);
    page.order.push(id);
    if (!page.claudeOrder.includes(id)) page.claudeOrder.push(id);
  }
  for (const id of page.markdown.keys()) if (!seen.has(id)) { seen.add(id); out.push(id); page.order.push(id); }
  return out;
}

// The sequence cut into segments: { md: id } or { anchor, panes: [id…] }, where
// a run's anchor is the markdown id right before it, or 'start' — the key the
// server's run routes and flags use.
export function segments() {
  const segs = [];
  let anchor = 'start';
  let run = null;
  for (const id of sequence()) {
    if (page.markdown.has(id)) { segs.push({ md: id }); anchor = id; run = null; continue; }
    if (!run) { run = { anchor, panes: [] }; segs.push(run); }
    run.panes.push(id);
  }
  return segs;
}

export function runOf(paneId) {
  return segments().find((s) => s.panes && s.panes.includes(paneId)) || null;
}

// ── placement: pane_state → {col, span, rows} ──────────────────────────────
// The chrome's READING of a pane_state, the same rules as the server's placeOf
// (lib/server/domain/page): col 1–12 or auto, span defaults to the whole row,
// rows falls back to the pixel height an older pane was sized in.
const toInt = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rowsFromPx = (px) => {
  const n = Number(px);
  return Number.isFinite(n) && n > 0 ? clamp(Math.round(n / ROW_PX), ROWS_MIN, ROWS_MAX) : null;
};
export function placeOf(ps) {
  const s = ps || {};
  const c = toInt(s.col);
  const col = c != null && c >= 1 && c <= COLS ? c : null;
  const sp = toInt(s.colSpan);
  const span = sp != null && sp >= 1 ? Math.min(sp, COLS) : COLS;
  let rows = toInt(s.rows);
  if (rows == null) rows = rowsFromPx(s.heightPx);
  if (rows == null && s.rowSpan > 1) rows = rowsFromPx(s.rowSpan * 60);
  return { col, span, rows };
}

// Where Claude put it: the pane's claude_place, or — never placed — the default
// a pane with no layout keys has.
function baselineOf(ps) {
  const cp = ps && ps.claude_place;
  if (!cp || typeof cp !== 'object') return { col: null, span: COLS, rows: null };
  return { col: toInt(cp.col), span: toInt(cp.span) || COLS, rows: toInt(cp.rows) };
}

// Does ↺ Claude's layout have anything to do for this run? The same test the
// server's resetLayout applies: an unlocked pane off its baseline placement or
// minimized, or the unlocked panes out of Claude's order. A locked pane keeps
// its slot and size through a reset, so it never makes a run dirty.
export function runDirty(ids) {
  const movable = ids.filter((id) => { const p = panes.get(id); return p && !p.pane_state.locked; });
  const rank = new Map(page.claudeOrder.map((id, i) => [id, i]));
  const r = (id) => (rank.has(id) ? rank.get(id) : Infinity);
  const sorted = movable.slice().sort((a, b) => (r(a) - r(b)) || (movable.indexOf(a) - movable.indexOf(b)));
  if (sorted.some((id, i) => id !== movable[i])) return true;
  for (const id of movable) {
    const ps = panes.get(id).pane_state;
    if (ps.minimized) return true;
    const now = placeOf(ps);
    const base = baselineOf(ps);
    if (now.col !== base.col || now.span !== base.span || now.rows !== base.rows) return true;
  }
  return false;
}

// ── the outline: #/## headings, numbered, with the panes under each ─────────
export function outline() {
  const rows = [];
  let cur = null;
  let n1 = 0, n2 = 0;
  for (const id of sequence()) {
    const md = page.markdown.get(id);
    if (md) {
      for (const h of headings(md.text)) {
        if (h.level > 2) continue;
        if (h.level === 1) { n1++; n2 = 0; } else n2++;
        cur = { level: h.level, text: h.text, slug: h.slug, md: id, num: h.level === 1 ? String(n1) : `${n1}.${n2}`, panes: [] };
        rows.push(cur);
      }
    } else if (cur) cur.panes.push(id);
  }
  return rows;
}

// The number of the section a pane sits under ('' above the first heading).
export function sectionNumOf(paneId) {
  const row = outline().find((r) => r.panes.includes(paneId));
  return row ? row.num : '';
}

export function headingEl(mdId, slug) {
  const el = mdEls.get(mdId);
  if (!el) return null;
  for (const h of el.querySelectorAll('h1, h2, h3')) if (h.dataset.slug === slug) return h;
  return null;
}

export function scrollToHeading(mdId, slug) {
  const h = headingEl(mdId, slug);
  if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return !!h;
}

// ── the user's layout writes ───────────────────────────────────────────────
async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// A drag's result: the run `anchor`'s panes, in their new order. The page order
// changes locally at once (no snap-back while the daemon answers), and the
// daemon hears it as the fewest USER moves (POST /api/page/move — `order` only;
// Claude's baseline stays, which is what ↺ goes back to). Every browser,
// including this one, then gets the daemon's page:order.
export async function commitRunOrder(anchor, ids) {
  const before = sequence();
  const moves = [];
  const sim = before.slice();
  ids.forEach((id, k) => {
    const want = k === 0 ? anchor : ids[k - 1];
    const at = sim.indexOf(id);
    const cur = at <= 0 ? 'start' : sim[at - 1];
    if (cur === want) return;
    moves.push({ id, after: want });
    sim.splice(at, 1);
    sim.splice(want === 'start' ? 0 : sim.indexOf(want) + 1, 0, id);
  });
  if (!moves.length) return [];
  page.order = sim;
  layoutPage();
  const out = [];
  for (const m of moves) {
    const res = await post('/api/page/move', m);
    out.push(res);
    if (res && res.ok === false) break;   // the daemon's page:order is the truth from here
  }
  return out;
}

function resetRun(anchor) { return post('/api/page/reset-layout', { run_anchor: anchor }); }
function setRunStacks(anchor, stacks) { return post('/api/page/run', { anchor, stacks }); }

// ── the DOM ─────────────────────────────────────────────────────────────────
const mdEls = new Map();   // markdown id → .md-block
const runEls = new Map();  // run anchor → .page-run
let zeroEl = null;
let tailEl = null;

function mdElement(id) {
  let el = mdEls.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'md-block';
    el.dataset.mdId = id;
    mdEls.set(id, el);
  }
  const text = page.markdown.get(id).text;
  if (el._wcText !== text) {
    // lib/core/markdown: every character escaped, links scheme-gated, headings
    // carry data-slug (never id — a heading must not claim a chrome id).
    el.innerHTML = renderMarkdown(text);
    el._wcText = text;
  }
  return el;
}

function runElement(seg) {
  let el = runEls.get(seg.anchor);
  if (!el) {
    el = document.createElement('section');
    el.className = 'page-run';
    el.dataset.anchor = seg.anchor;
    const head = document.createElement('div'); head.className = 'run-head';
    const hint = document.createElement('div'); hint.className = 'run-fixed-hint';
    hint.textContent = 'FIXED GRID · SCROLL →';
    const grid = document.createElement('div'); grid.className = 'run-grid';
    const min = document.createElement('div'); min.className = 'run-min';
    el.append(head, hint, grid, min);
    runEls.set(seg.anchor, el);
  }
  const fixed = !!(page.runs[seg.anchor] && page.runs[seg.anchor].stacks === false);
  el.classList.toggle('stacks', !fixed);
  el.classList.toggle('fixed', fixed);
  const grid = el.querySelector('.run-grid');
  seg.panes.forEach((id, i) => {
    const w = panes.get(id).wrapper;
    if (w.parentElement !== grid) grid.appendChild(w);
    w.style.order = String(i);
  });
  renderRunHead(el, seg, fixed);
  renderRunMin(el, seg);
  return el;
}

// The run's controls, drawn only when they would do something: ↺ when the run is
// off Claude's layout, the stacks/fixed chip when there is a row to keep (two or
// more visible panes) or the run is already fixed (so it can be turned back).
// Both are writes, so a read-only view (preview, phone) has neither.
function renderRunHead(el, seg, fixed) {
  const head = el.querySelector('.run-head');
  head.textContent = '';
  if (!readOnlyNow()) {
    if (runDirty(seg.panes)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'run-reset';
      b.textContent = "↺ Claude's layout";
      b.title = 'Restore the arrangement Claude proposed for these blocks';
      b.addEventListener('click', () => { if (!readOnlyNow()) resetRun(seg.anchor); });
      head.appendChild(b);
    }
    const visible = seg.panes.filter((id) => !panes.get(id).pane_state.minimized).length;
    if (visible >= 2 || fixed) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'run-stacks' + (fixed ? ' fixed' : '');
      b.textContent = fixed ? 'fixed grid' : 'stacks on narrow';
      b.setAttribute('aria-pressed', String(fixed));
      b.title = 'On a narrow screen these blocks either stack to one column in reading order, or keep their grid and scroll sideways';
      b.addEventListener('click', () => { if (!readOnlyNow()) setRunStacks(seg.anchor, fixed); });
      head.appendChild(b);
    }
  }
  head.hidden = !head.childElementCount;
}

// Minimized blocks, as chips under the run they belong to. textContent, never
// innerHTML: a pane title can be attacker-controlled (a captured page's <title>
// flows into params.title via routes/capture.js).
function renderRunMin(el, seg) {
  const box = el.querySelector('.run-min');
  box.textContent = '';
  for (const id of seg.panes) {
    const p = panes.get(id);
    if (!p.pane_state.minimized) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'min-chip' + (p.wrapper.classList.contains('peek') ? ' on' : '');
    chip.dataset.paneId = id;
    const label = document.createElement('span');
    label.textContent = p.title || id;
    const restore = document.createElement('span');
    restore.className = 'restore';
    restore.textContent = '↗';
    chip.append(label, restore);
    chip.addEventListener('click', () => {
      // A phone is a read-only viewer: restoring a block would be a write to the
      // live surface, so the chip only shows it HERE (a local peek).
      if (isPhone()) { chip.classList.toggle('on', p.wrapper.classList.toggle('peek')); return; }
      if (readOnlyNow()) return;
      unminimize(id);
    });
    box.appendChild(chip);
  }
  box.hidden = !box.childElementCount;
}

// The zero state. #main used to be literally empty on first open — every OTHER
// panel in this app has a considered empty state, and the one surface every new
// user sees first had none. Static markup only — nothing here is data.
function zeroElement() {
  if (zeroEl) return zeroEl;
  zeroEl = document.createElement('div');
  zeroEl.className = 'zero-state';
  zeroEl.innerHTML =
    '<h2>Nothing on the page yet</h2>' +
    '<p>Ask Claude for something visual in your terminal and it lands here as blocks — ' +
    'a figure, a table, a form, a diagram — and every turn becomes a node you can walk back to. Try:</p>' +
    '<p class="zs-try"><span class="zs-quote">Sketch this project\'s architecture on the page.</span></p>' +
    '<ul class="zs-keys">' +
      '<li><kbd>G</kbd> open the graph</li>' +
      '<li><kbd>N</kbd> add a block from the library</li>' +
      '<li><kbd>?</kbd> all shortcuts</li>' +
    '</ul>';
  return zeroEl;
}

function tailElement() {
  if (tailEl) return tailEl;
  tailEl = document.createElement('div');
  tailEl.className = 'page-tail';
  tailEl.innerHTML = '<span class="pt-hash">#</span>Claude’s next turn appends a heading, prose, or blocks here.';
  return tailEl;
}

const PAGE_CLASSES = ['md-block', 'page-run', 'zero-state', 'page-tail'];

// Put every element of the page where the sequence says, moving only what is
// out of place. Called whenever the page or a pane changes (mounts.js calls it
// on every mount / remove / pane_state; ws.js after a page frame).
export function layoutPage() {
  const main = $('main');
  if (!main) return;
  main.classList.add('page');
  const segs = segments();
  const want = [];
  const liveMd = new Set();
  const liveRuns = new Set();
  for (const s of segs) {
    if (s.md) { want.push(mdElement(s.md)); liveMd.add(s.md); }
    else { want.push(runElement(s)); liveRuns.add(s.anchor); }
  }
  for (const id of [...mdEls.keys()]) if (!liveMd.has(id)) { mdEls.get(id).remove(); mdEls.delete(id); }
  for (const a of [...runEls.keys()]) if (!liveRuns.has(a)) { runEls.get(a).remove(); runEls.delete(a); }
  if (!segs.length) want.push(zeroElement());
  else if (zeroEl) zeroEl.remove();
  if (segs.length && !readOnlyNow()) want.push(tailElement());
  else if (tailEl) tailEl.remove();

  want.forEach((el, i) => {
    const cur = main.children[i];
    if (cur !== el) main.insertBefore(el, cur || null);
  });
  // Anything left past the sequence: a wrapper a failed or superseded mount left
  // at the top level, or a page element whose run went away.
  for (const el of [...main.children].slice(want.length)) {
    if (el.classList.contains('pane') || PAGE_CLASSES.some((c) => el.classList.contains(c))) el.remove();
  }
  syncPageMeta();
  renderContents();
}

// ── title, meta line, contents nav ─────────────────────────────────────────

// The page's title: its first # heading, in page order.
export function pageTitle() {
  for (const id of sequence()) {
    const md = page.markdown.get(id);
    if (!md) continue;
    const h = headings(md.text).find((x) => x.level === 1);
    if (h) return { md: id, text: h.text, slug: h.slug };
  }
  return null;
}

function updatedAt() {
  const n = nodeById(view.previewing ? view.viewedId : view.activeId);
  if (view.previewing) return n && n.created_at ? n.created_at : null;
  return page.updatedAt || (n && n.created_at) || null;
}

// The topbar title slot and the H1's meta line (node · panes · updated), plus
// the read-only badge when this is a preview. Cheap, and called from the
// topbar's updateChip too, because the node label and time arrive with the graph.
export function syncPageMeta() {
  const main = $('main');
  const t = pageTitle();
  const slot = $('page-title');
  if (slot) slot.textContent = t ? t.text : '';
  if (!main) return;
  main.classList.toggle('has-title', !!t);
  for (const el of main.querySelectorAll('.page-h1')) el.classList.remove('page-h1');
  for (const el of main.querySelectorAll('.page-meta')) el.remove();
  if (!t) return;
  const h = headingEl(t.md, t.slug);
  if (!h) return;
  h.classList.add('page-h1');
  const meta = document.createElement('div');
  meta.className = 'page-meta';
  const n = panes.size;
  const at = updatedAt();
  const time = at ? nodeTime({ created_at: at }) : '';
  const bits = [labelFor(view.viewedId || view.activeId), `${n} ${n === 1 ? 'pane' : 'panes'}`];
  if (time) bits.push(`updated ${time}`);
  const text = document.createElement('span');
  text.textContent = bits.join(' · ');
  meta.appendChild(text);
  if (view.previewing) {
    const badge = document.createElement('span');
    badge.className = 'page-badge';
    badge.textContent = 'PREVIEW · READ-ONLY';
    meta.appendChild(badge);
  }
  h.insertAdjacentElement('afterend', meta);
}

// The Contents nav (≥1100px — app.css hides it narrower): one row per # / ##
// heading, numbered, level 2 indented, with the panes until the next heading.
// Empty — and so not drawn — when the page has no headings.
export function renderContents() {
  const nav = $('contents-nav');
  if (!nav) return;
  const rows = outline();
  nav.textContent = '';
  if (!rows.length) return;
  const label = document.createElement('div');
  label.className = 'cn-label';
  label.textContent = 'CONTENTS';
  nav.appendChild(label);
  for (const r of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cn-row' + (r.level === 2 ? ' sub' : '');
    const num = document.createElement('span'); num.className = 'cn-num'; num.textContent = r.num;
    const name = document.createElement('span'); name.className = 'cn-name'; name.textContent = r.text;
    const count = document.createElement('span'); count.className = 'cn-count';
    count.textContent = r.panes.length ? String(r.panes.length) : '';
    b.title = r.text;
    b.append(num, name, count);
    b.addEventListener('click', () => scrollToHeading(r.md, r.slug));
    nav.appendChild(b);
  }
  // The tip is about adding to the page — nothing a read-only view can do.
  if (readOnlyNow()) return;
  const tip = document.createElement('div');
  tip.className = 'cn-tip';
  tip.innerHTML = 'Ask Claude for a new section, or press <kbd>N</kbd> to add a block.';
  nav.appendChild(tip);
}

// ⌘K rows: one "section" row per heading (scrolls to it), and each block's
// section number for its row's hint.
export function paletteSections() {
  return outline().map((r) => ({
    kind: 'section',
    label: `${r.num}  ${r.text}`,
    hint: r.panes.length ? `${r.panes.length} ${r.panes.length === 1 ? 'block' : 'blocks'}` : '',
    run: () => scrollToHeading(r.md, r.slug),
  }));
}
export function blockHint(id) {
  const p = panes.get(id);
  const type = p ? (blockType(p.spec && p.spec.params, p.spec && p.spec.component) || (p.pane_state.minimized ? 'minimized' : '')) : '';
  const num = sectionNumOf(id);
  return [num && `§${num}`, type].filter(Boolean).join(' · ');
}
