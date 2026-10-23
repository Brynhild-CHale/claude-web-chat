// The `elements` answer kind's REPORT layout (annotation engine PLAN.md 2B.1;
// DECISIONS.md A3; U312), loaded by answer.js for an `elements` document whose
// layout is `report` (./<kind>-<layout>.js): the carrier of a REMOTE viewer's
// resolver answers. The chrome cannot call the answer API itself — it runs in
// the pane scripts' realm, and the API answers only a document this origin
// served, by the nonce in its <meta> — so it posts each batch in here, and
// this document POSTs it to /answer/api/elements/report
// (lib/server/domain/reports-remote.js), which hands it to the same
// reports.accept() a local page's socket reaches.
//
//   mount(rt) → { stop() }       rt is answer.js's runtime, never copied
//
// THE MESSAGES. In, from window.parent only (e.source === window.parent),
// checked by comparison: {channel: REPORT_CHANNEL, report: {surface, mounts}}
// — the batch public/app/overlay-report.js built, less its type. Out, to
// window.parent only and to '*' like answer.js's own hints, carrying nothing:
// {channel: READY_CHANNEL} once this module listens (answer.js's size message
// goes before the module is loaded, so the chrome waits for this one), and
// {channel: EXPIRED_CHANNEL} once when the daemon refuses this document's
// nonce (its two hours ran out, or the surface closed and forgot it): the
// chrome then mounts a fresh document.
//
// THE POST. {reports: [part], device, viewer}: the device and the per-tab
// viewer id are this document's own (its query, which the chrome set when it
// framed it; the nonce key holds the viewer). A batch whose JSON would be over
// PART_MAX_BYTES (the kit reads 64 KB) is split into parts, mount by mount in
// order, and a mount too large alone item by item; the parts go one at a time,
// in order. At most MAX_PENDING parts wait; more are dropped.
//
// It draws nothing, stores nothing, and never echoes a body back (no message
// carries what was posted or answered). C-15-1: any script of the chrome's
// realm can post here; what it can post is bounded by the daemon exactly as a
// forged socket report is.

export const REPORT_CHANNEL = 'wc-elements:report';
export const READY_CHANNEL = 'wc-elements:ready';
export const EXPIRED_CHANNEL = 'wc-elements:expired';
export const PART_MAX_BYTES = 48 * 1024;
export const MAX_PENDING = 64;
export const VIEWER_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DEVICES = new Set(['desktop', 'mobile']);

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function bytesOf(v, enc) {
  let s;
  try { s = JSON.stringify(v); } catch { return Infinity; }
  return enc ? enc.encode(s).length : s.length * 3;
}

// A report's {surface, mounts} split into parts whose POST body (`wrap(part)`)
// stays at most `max` bytes. Order is kept; a single item over the cap goes
// alone (the daemon refuses it).
export function splitReport(report, wrap, max = PART_MAX_BYTES, enc = typeof TextEncoder === 'function' ? new TextEncoder() : null) {
  const parts = [];
  const empty = () => ({ surface: report.surface, mounts: [] });
  const base = bytesOf(wrap(empty()), enc);
  let cur = empty();
  let size = base;
  const flush = () => { if (cur.mounts.length) parts.push(cur); cur = empty(); size = base; };
  const add = (entry, cost) => {
    if (cur.mounts.length && size + cost > max) flush();
    cur.mounts.push(entry);
    size += cost;
  };
  for (const entry of report.mounts) {
    const cost = bytesOf(entry, enc) + 1;
    if (base + cost <= max || !isObj(entry) || !Array.isArray(entry.items) || entry.items.length <= 1) { add(entry, cost); continue; }
    // Too large alone: its items, in chunks, each its own entry.
    const head = { ...entry, items: [] };
    const headCost = bytesOf(head, enc) + 1;
    let chunk = [];
    let chunkCost = headCost;
    const push = () => { if (chunk.length) add({ ...entry, items: chunk }, chunkCost); chunk = []; chunkCost = headCost; };
    for (const it of entry.items) {
      const c = bytesOf(it, enc) + 1;
      if (chunk.length && base + chunkCost + c > max) push();
      chunk.push(it);
      chunkCost += c;
    }
    push();
  }
  flush();
  return parts;
}

export function mount(rt) {
  const { win } = rt;
  const enc = typeof win.TextEncoder === 'function' ? new win.TextEncoder() : null;
  const viewer = rt.query && VIEWER_RE.test(String(rt.query.viewer || '')) ? rt.query.viewer : null;
  const device = DEVICES.has(rt.device) ? rt.device : null;
  const framed = () => !!win.parent && win.parent !== win;
  const tell = (channel) => {
    if (!framed()) return;
    try { win.parent.postMessage({ channel }, '*'); } catch { /* the parent is going */ }
  };
  let stopped = false;
  let expired = false;
  let pending = 0;
  let chain = Promise.resolve();

  const wrap = (part) => {
    const body = { reports: [part] };
    if (device) body.device = device;
    if (viewer) body.viewer = viewer;
    return body;
  };

  async function send(part) {
    if (stopped || expired) return;
    let r = null;
    try { r = await rt.api('report', { method: 'POST', body: wrap(part) }); } catch { r = null; }
    if (stopped || expired) return;
    if (r && r.status === 403 && r.body && r.body.refused === 'nonce') {
      expired = true;
      tell(EXPIRED_CHANNEL);
    }
  }

  function onMessage(e) {
    if (stopped || expired || !framed() || e.source !== win.parent) return;
    const d = e.data;
    if (!isObj(d) || d.channel !== REPORT_CHANNEL) return;
    const report = d.report;
    if (!isObj(report) || !Number.isSafeInteger(report.surface) || !Array.isArray(report.mounts) || !report.mounts.length) return;
    for (const part of splitReport({ surface: report.surface, mounts: report.mounts }, wrap, PART_MAX_BYTES, enc)) {
      if (pending >= MAX_PENDING) return;
      pending += 1;
      chain = chain.then(() => send(part)).finally(() => { pending -= 1; });
    }
  }

  win.addEventListener('message', onMessage);
  tell(READY_CHANNEL);
  return {
    stop() {
      stopped = true;
      win.removeEventListener('message', onMessage);
    },
  };
}
