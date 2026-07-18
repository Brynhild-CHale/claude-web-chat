// Structural diff between two graph nodes (or the live surface). Pure functions
// only — callers pass node-like objects ({ mounts, store, theme }); resolution
// of ids/labels/`live`/`active` is the route's job. Output is deliberately
// token-cheap: unchanged content is listed by id/key, never echoed; html field
// changes come back as truncated unified-diff hunks rather than full blobs.

// ---- equality ------------------------------------------------------------

// Order-independent deep stringify, used only for change *detection*. undefined
// gets a distinct sentinel so an absent field differs from an explicit null.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
function stableStringify(v) {
  if (v === undefined) return '\u0000undef';
  return JSON.stringify(sortKeys(v));
}

// Truncate a value for transport: pass it through if its JSON is small, else
// return a marker with a preview so we never dump a megabyte into context.
function truncVal(v, cap = 2000) {
  let s;
  try { s = JSON.stringify(v); } catch { return { _unserializable: true }; }
  if (s === undefined) return v; // undefined
  if (s.length <= cap) return v;
  return { _truncated: true, bytes: s.length, preview: s.slice(0, cap) };
}

// ---- line diff -----------------------------------------------------------

// LCS-based line diff → ops [{op:' '|'-'|'+', line}]. O(n*m); the caller caps
// input size before reaching here.
function lcsDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ op: ' ', line: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: '-', line: aLines[i] }); i++; }
    else { ops.push({ op: '+', line: bLines[j] }); j++; }
  }
  while (i < n) ops.push({ op: '-', line: aLines[i++] });
  while (j < m) ops.push({ op: '+', line: bLines[j++] });
  return ops;
}

// Split into logical lines the way git counts them: a single trailing newline
// terminates the last line rather than creating a phantom empty one. Without
// this, content that ends in '\n' (almost all html/css) inflates line counts by
// one and a lone trailing-newline difference reads as a content change.
function splitLines(s) {
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Unified-diff header for a hunk, computed from the lines actually present
// (op-prefixed strings). Counts are derived here — never carried over from a
// pre-truncation slice — so the header always describes its own body.
function hunkHeader(aStart, bStart, lines) {
  let aCount = 0, bCount = 0;
  for (const l of lines) {
    const op = l[0];
    if (op !== '+') aCount++;
    if (op !== '-') bCount++;
  }
  return `@@ -${aStart},${aCount} +${bStart},${bCount} @@`;
}

// Group ops into hunks with `context` lines around each change, merging windows
// that overlap. Returns {aStart, bStart, lines} — the header is formatted later
// so truncation can recompute counts from the retained lines.
function buildHunks(ops, context) {
  const n = ops.length;
  const changes = [];
  for (let i = 0; i < n; i++) if (ops[i].op !== ' ') changes.push(i);
  if (!changes.length) return [];

  const windows = changes.map((i) => [Math.max(0, i - context), Math.min(n - 1, i + context)]);
  const merged = [windows[0].slice()];
  for (let k = 1; k < windows.length; k++) {
    const last = merged[merged.length - 1];
    const [s, e] = windows[k];
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  // running a/b line numbers (0-based) at the start of each op
  const pos = [];
  let a = 0, b = 0;
  for (const o of ops) { pos.push({ a, b }); if (o.op === ' ') { a++; b++; } else if (o.op === '-') a++; else b++; }

  return merged.map(([s, e]) => ({
    aStart: pos[s].a + 1,
    bStart: pos[s].b + 1,
    lines: ops.slice(s, e + 1).map((o) => o.op + o.line),
  }));
}

// Compact unified diff of two strings. Returns null when equal (including when
// they differ only by a trailing newline). Skips the LCS table entirely
// (summary only) when either side is too large to diff cheaply.
function lineDiff(aStr, bStr, { context = 2, maxLines = 800, maxHunkLines = 160 } = {}) {
  const A = aStr == null ? '' : String(aStr);
  const B = bStr == null ? '' : String(bStr);
  if (A === B) return null;

  const aLines = splitLines(A);
  const bLines = splitLines(B);
  const out = {
    a_lines: aLines.length, b_lines: bLines.length,
    a_bytes: Buffer.byteLength(A), b_bytes: Buffer.byteLength(B),
  };

  if (aLines.length > maxLines || bLines.length > maxLines) {
    out.too_large = true; // diff suppressed; sizes above tell the story
    return out;
  }

  const ops = lcsDiff(aLines, bLines);
  let added = 0, removed = 0;
  for (const o of ops) { if (o.op === '+') added++; else if (o.op === '-') removed++; }
  // After newline normalization the only difference may have been a trailing
  // '\n' — no actual line changed, so report equality.
  if (added === 0 && removed === 0) return null;
  out.added = added;
  out.removed = removed;

  const hunks = buildHunks(ops, context);
  const capped = [];
  let total = 0, truncated = false;
  for (const h of hunks) {
    if (total + h.lines.length > maxHunkLines) {
      const room = maxHunkLines - total;
      if (room > 0) {
        const kept = h.lines.slice(0, room);
        capped.push({ header: hunkHeader(h.aStart, h.bStart, kept), lines: kept });
      }
      truncated = true;
      break;
    }
    capped.push({ header: hunkHeader(h.aStart, h.bStart, h.lines), lines: h.lines });
    total += h.lines.length;
  }
  out.hunks = capped;
  if (truncated) out.truncated = true;
  return out;
}

// ---- node diff -----------------------------------------------------------

const MOUNT_FIELDS = ['html', 'target', 'params', 'component', 'pane_state', 'form_state', 'theme'];

function mountSummary(m) {
  const html = m.html == null ? '' : String(m.html);
  return {
    id: m.id,
    target: m.target ?? null,
    component: m.component ?? null,
    params: m.params ?? null,
    html_lines: html ? splitLines(html).length : 0,
    html_bytes: Buffer.byteLength(html),
  };
}

function diffMount(am, bm, opts) {
  const fields = {};
  for (const f of MOUNT_FIELDS) {
    if (f === 'html') {
      const ld = lineDiff(am.html, bm.html, opts);
      if (ld) fields.html = ld;
    } else if (stableStringify(am[f]) !== stableStringify(bm[f])) {
      fields[f] = { from: truncVal(am[f]), to: truncVal(bm[f]) };
    }
  }
  return fields;
}

function diffMounts(aMounts, bMounts, opts) {
  const aById = new Map(aMounts.map((m) => [m.id, m]));
  const bById = new Map(bMounts.map((m) => [m.id, m]));
  const added = [], removed = [], changed = [], unchanged = [];

  for (const [id, bm] of bById) if (!aById.has(id)) added.push(mountSummary(bm));
  for (const [id, am] of aById) {
    if (!bById.has(id)) { removed.push(mountSummary(am)); continue; }
    const fields = diffMount(am, bById.get(id), opts);
    if (Object.keys(fields).length === 0) unchanged.push(id);
    else changed.push({ id, fields });
  }
  return { added, removed, changed, unchanged };
}

function diffStore(aStore, bStore) {
  const added = {}, removed = {}, changed = {}, unchanged = [];
  for (const k of Object.keys(bStore)) if (!(k in aStore)) added[k] = truncVal(bStore[k]);
  for (const k of Object.keys(aStore)) {
    if (!(k in bStore)) { removed[k] = truncVal(aStore[k]); continue; }
    if (stableStringify(aStore[k]) !== stableStringify(bStore[k])) {
      changed[k] = { from: truncVal(aStore[k]), to: truncVal(bStore[k]) };
    } else unchanged.push(k);
  }
  return { added, removed, changed, unchanged };
}

function diffTheme(aTheme, bTheme, opts) {
  if (stableStringify(aTheme ?? null) === stableStringify(bTheme ?? null)) return null;
  const at = (aTheme && aTheme.tokens) || {};
  const bt = (bTheme && bTheme.tokens) || {};
  const tokens = { added: {}, removed: {}, changed: {} };
  for (const k of Object.keys(bt)) if (!(k in at)) tokens.added[k] = bt[k];
  for (const k of Object.keys(at)) {
    if (!(k in bt)) tokens.removed[k] = at[k];
    else if (at[k] !== bt[k]) tokens.changed[k] = { from: at[k], to: bt[k] };
  }
  const aCss = (aTheme && aTheme.css) || '';
  const bCss = (bTheme && bTheme.css) || '';
  return { tokens, css: aCss !== bCss ? lineDiff(aCss, bCss, opts) : null };
}

// aNode / bNode: { mounts: [...], store: {...}, theme?: {...} }
function diffNodes(aNode, bNode, opts = {}) {
  return {
    mounts: diffMounts(aNode.mounts || [], bNode.mounts || [], opts),
    store: diffStore(aNode.store || {}, bNode.store || {}),
    theme: diffTheme(aNode.theme, bNode.theme, opts),
  };
}

module.exports = { diffNodes, lineDiff, stableStringify };
