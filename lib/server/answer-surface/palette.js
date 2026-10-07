// The answer frames' palette (spec §4.4, §4.5 item 9; ruling A6 (b) of
// 2026-10-06): which colours a frame on the answer origin may paint with, and
// the one lib home of the WCAG contrast ratio.
//
// ── Why the frame does not simply take the project's theme ──────────────────
// Any pane can write the global theme (POST /api/theme has no browser gate),
// save a library theme under any non-builtin name (POST /api/themes), and
// install a pack over HTTP. A theme that sets the text to the background's
// colour would make the real subject of a permission prompt invisible beside a
// decoy. So the frame never reads a theme's WRITABLE values — not theme.json's
// tokens, not the resolver's merge, not a node's or a pane's layer.
//
// ── What it does read (A6 (b)) ──────────────────────────────────────────────
// The active global theme only says WHICH pack to follow, and only a vetted
// pack is followed:
//   * a built-in pack (theme-packs PACKS), when the stored record is an
//     application of it (lib/core/theme-identity appliedBuiltinId: the
//     `builtin` flag, or the retired stock name). Its values come from PACKS,
//     never from the record: a pane that re-applies `paper` with builtin:true
//     and its own tokens still gets Paper's.
//   * an installed pack's theme, when the pack record of the tier the library
//     file is read from owns it, the file's bytes still hash to what the
//     install recorded (a pane's save_theme over the same name changes them),
//     and the packs audit log's latest install or approve of that pack was
//     made in the terminal (actor 'cli'). A pack installed or approved over
//     HTTP (actor 'http') is what a pane can do, so it is not followed.
// Whatever is followed must then pass the contrast check in BOTH modes:
// FRAME_TEXT pairs at 4.5:1 and FRAME_UI pairs at 3:1, each ink against the
// frame surface it is painted on. Anything else — no root, nothing readable, a
// pane-written theme, an http install, an edited file, a failed check — is
// Earthy's light and dark tokens from the shipped PACKS entry.
//
// The frame's stylesheets (U56's answer.css, U85's layouts) take only these
// tokens; the pairs below are what a palette was measured on, so a layout that
// paints an ink on a fill not listed here is painting something unmeasured.
// contrastRatio is exported for those layouts' tests: import it, never copy it.

const fs = require('fs');
const path = require('path');
const { PACKS } = require('../theme-packs');
const { flattenTheme, tokenDecls, normalizeTheme, MODES } = require('../theme');
const { appliedBuiltinId, globalThemeFiles, globalThemeRecord, STOCK_THEME } = require('../../core/theme-identity');
const { projectPaths, userPaths } = require('../../core/paths');
const { isComponentName } = require('../../core/names');
const { findPack, ownerOf, sha256, readAudit } = require('../../packs/store');

// [ink, fill]: text the frame sets at body size, and its controls.
const FRAME_TEXT = Object.freeze([
  ['--wc-fg', '--wc-panel-bg'],
  ['--wc-fg', '--wc-bg'],
  ['--wc-muted', '--wc-panel-bg'],
  ['--wc-content-fg', '--wc-content-bg'],
]);
const FRAME_UI = Object.freeze([
  ['--wc-accent', '--wc-panel-bg'],
  ['--wc-accent-fg', '--wc-accent'],
  ['--wc-accent-text', '--wc-panel-bg'],
  ['--wc-comment', '--wc-panel-bg'],
]);
const TEXT_MIN = 4.5;
const UI_MIN = 3;

const FALLBACK = STOCK_THEME; // 'earthy'
const THEME_MAX_BYTES = 256 * 1024;
const AUDIT_TAIL_BYTES = 2 * 1024 * 1024;

// ── colour ──────────────────────────────────────────────────────────────────
// A colour a contrast can be measured on: #rgb, #rgba, #rrggbb, #rrggbbaa,
// rgb() and rgba() (commas or spaces, an optional `/ alpha`). Anything else
// (a var(), a named colour, color-mix, a gradient) is null: unmeasured, so a
// palette leaning on it does not pass.
function parseColor(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return { r: n[0], g: n[1], b: n[2], a: n[3] / 255 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    let a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    if (![r, g, b, a].every(Number.isFinite) || [r, g, b].some((c) => c > 255) || a > 1) return null;
    a = Math.max(0, a);
    return { r, g, b, a };
  }
  return null;
}

function channel(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// The WCAG 2.x contrast ratio of `ink` painted on `fill`: (L1 + 0.05) / (L2 +
// 0.05) over relative luminance, the lighter over the darker. Each argument is
// a colour string or a parseColor result. A translucent ink is composited over
// the fill first; a translucent fill has nothing known beneath it, so like an
// unparseable colour it answers NaN (which fails every threshold).
function contrastRatio(ink, fill) {
  const i = typeof ink === 'object' && ink ? ink : parseColor(ink);
  const f = typeof fill === 'object' && fill ? fill : parseColor(fill);
  if (!i || !f || f.a < 1) return NaN;
  const mix = (ci, cf) => ci * i.a + cf * (1 - i.a);
  const ink2 = { r: mix(i.r, f.r), g: mix(i.g, f.g), b: mix(i.b, f.b) };
  const a = luminance(ink2);
  const b = luminance(f);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Every FRAME pair of one mode's flat tokens: { ok, failures: [{ink, fill,
// ratio, need}] }.
function checkTokens(tokens) {
  const t = tokens || {};
  const failures = [];
  for (const [pairs, need] of [[FRAME_TEXT, TEXT_MIN], [FRAME_UI, UI_MIN]]) {
    for (const [ink, fill] of pairs) {
      const ratio = contrastRatio(t[ink], t[fill]);
      if (!(ratio >= need)) failures.push({ ink, fill, ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null, need });
    }
  }
  return { ok: failures.length === 0, failures };
}

// A theme (a pack, or an installed theme normalized) in both modes.
function checkTheme(theme) {
  const out = {};
  let ok = true;
  for (const mode of MODES) {
    out[mode] = checkTokens(flattenTheme(theme, mode).tokens);
    if (!out[mode].ok) ok = false;
  }
  return { ok, modes: out };
}

// ── which pack ──────────────────────────────────────────────────────────────
const packById = (id) => PACKS.find((p) => p.name === id) || null;

// Who made this pack's latest install or approve in this tier, by the packs
// audit logs (the project's and the user tier's, read through lib/packs/store
// readAudit; a system-tier command appends its line to both, so a pack the
// terminal installed for every project is found from any of them): 'cli',
// 'http', or null when neither log records one. A failed install (ok: false)
// put nothing in place and is passed over.
function lastActor(root, pack, tier) {
  let best = null;
  let bestAt = '';
  for (const t of ['local', 'system']) {
    for (const e of readAudit(root, { tier: t, limit: Infinity, maxBytes: AUDIT_TAIL_BYTES })) {
      if (!e || typeof e !== 'object') continue;
      if (e.pack !== pack || (e.op !== 'install' && e.op !== 'approve') || e.ok === false) continue;
      if (e.tier != null && e.tier !== tier) continue;
      const at = typeof e.ts === 'string' ? e.ts : '';
      if (!best || at >= bestAt) { best = e; bestAt = at; }
    }
  }
  return best ? (best.actor === 'cli' ? 'cli' : String(best.actor || 'unknown')) : null;
}

// The installed theme `name` as its pack shipped it, or { reason } when it is
// not one this palette may follow. The tiers are read in apply's order (the
// project's library, then the user's), and the first library holding the file
// decides: that is the copy apply_theme would have read.
function installedTheme(root, name) {
  if (!isComponentName(name)) return { reason: 'not-a-pack-theme' };
  for (const tier of ['local', 'system']) {
    const dir = tier === 'system' ? userPaths().themesDir : projectPaths(root).themesDir;
    const file = path.join(dir, `${name}.json`);
    let bytes;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > THEME_MAX_BYTES) return { reason: 'unreadable' };
      bytes = fs.readFileSync(file);
    } catch { continue; }
    const owner = ownerOf(root, tier, 'theme', name);
    if (!owner) return { reason: 'not-installed' };
    const found = findPack(root, owner, tier);
    const unit = found && (found.pack.units || []).find((u) => u && u.kind === 'theme' && u.name === name);
    const rec = unit && Array.isArray(unit.files) && unit.files.find((f) => f && f.path === `${name}.json`);
    if (!rec || typeof rec.sha256 !== 'string' || sha256(bytes) !== rec.sha256) return { reason: 'edited' };
    const actor = lastActor(root, owner, tier);
    if (actor !== 'cli') return { reason: actor ? `actor-${actor}` : 'no-audit' };
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { return { reason: 'unreadable' }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'unreadable' };
    // Tokens and modes only: an installed theme carries no css (refused at plan
    // time), and none would reach the frame anyway.
    const theme = normalizeTheme({ name, tokens: raw.tokens, modes: raw.modes });
    return { theme, pack: owner, tier };
  }
  return { reason: 'not-installed' };
}

// The palette the frames paint with: { name, source, theme, reason? }, where
// source is 'builtin' | 'installed' | 'fallback' and theme is what to render.
function framePalette({ root } = {}) {
  const fallback = (reason) => ({ name: FALLBACK, source: 'fallback', theme: packById(FALLBACK), reason });
  if (!root) return fallback('no-root');
  let record = null;
  try { record = globalThemeRecord(globalThemeFiles(root)); } catch { return fallback('unreadable'); }
  let chosen;
  if (!record) {
    chosen = { name: FALLBACK, source: 'builtin', theme: packById(FALLBACK) };
  } else {
    const id = appliedBuiltinId(record);
    if (id) {
      const pack = packById(id);
      if (!pack) return fallback('unknown-builtin');
      chosen = { name: id, source: 'builtin', theme: pack };
    } else {
      if (!record.name) return fallback('unnamed-theme');
      let got;
      try { got = installedTheme(root, String(record.name)); } catch { got = { reason: 'unreadable' }; }
      if (!got.theme) return fallback(got.reason);
      chosen = { name: String(record.name), source: 'installed', theme: got.theme, pack: got.pack };
    }
  }
  const check = checkTheme(chosen.theme);
  if (!check.ok) return fallback('contrast');
  return chosen;
}

// palette.css: one block per mode, chosen by the document's data-mode.
function renderPalette({ root } = {}) {
  const { theme } = framePalette({ root });
  return MODES.map((mode) => `:root[data-mode=${mode}] {\n${tokenDecls(flattenTheme(theme, mode).tokens)}\n}\n`).join('');
}

module.exports = {
  contrastRatio,
  parseColor,
  checkTokens,
  checkTheme,
  framePalette,
  renderPalette,
  FRAME_TEXT,
  FRAME_UI,
  TEXT_MIN,
  UI_MIN,
};
