// Brand image slots in the chrome: the topbar logotype, and the Settings
// panel's three drop targets (logotype / lockup / seal). The server owns the
// files and the validation (lib/server/brand.js); this only shows them and
// sends new ones.
//
// The images are kept per THEME — the project's global theme when they were
// added — so every slot here is the current theme's, Settings → Brand names
// that theme, and a change of theme arrives as a `brand` frame (the daemon
// sends one whenever the global theme moves) carrying the new theme's slots.
//
// An image is only ever an <img> pointed at /brand/<slot> — never SVG markup
// in this document — so a logo cannot run anything in the chrome's origin.
import { $ } from './state.js';

const SLOTS = [
  { slot: 'logotype', label: 'Logotype', where: 'topbar' },
  { slot: 'lockup', label: 'Lockup', where: 'export header' },
  { slot: 'seal', label: 'Seal', where: 'export footer' },
];
const TYPE_BY_EXT = { svg: 'image/svg+xml', png: 'image/png' };
const ACCEPT = '.svg,.png,image/svg+xml,image/png';

let current = {};   // slot -> {type, bytes, version} | null — the current theme's own images
// What fills a slot the theme has no image in — the theme pack's per-user logos
// (lib/server/brand.js explains; deliberately unmentioned anywhere a user
// reads). slot -> {light, dark} (each {type, bytes, version} | null) | null.
// Only the topbar reads it: Settings → Brand shows the theme's own slots.
let fill = {};
// Whose images `current` are: the global theme, { key, name, title } — `title`
// a builtin pack's display name, `name` null for a theme set without one. Null
// until the daemon has said.
let theme = null;

// A native file chooser takes window focus, and the dismiss layer closes every
// panel on window blur — which would shut Settings under the user's pick. The
// shell asks this before treating a blur as "the user went elsewhere".
let picking = false;
export function isPickingFile() { return picking; }

const src = (slot, meta) => `/brand/${slot}?v=${encodeURIComponent(meta.version || '')}`;
// The chrome's effective mode, as theme.js leaves it on <html>.
const viewMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
// The topbar's logotype: the project's own, else the fill for this mode.
function topbarSrc() {
  if (current.logotype) return src('logotype', current.logotype);
  const mode = viewMode();
  const f = fill.logotype && fill.logotype[mode];
  return f ? `/brand/logotype?mode=${mode}&v=${encodeURIComponent(f.version || '')}` : null;
}

/* ---------- topbar ---------- */
function applyTopbar() {
  const bar = $('topbar');
  const wordmark = bar && bar.querySelector('.brand');
  if (!wordmark) return;
  let logo = $('brand-logotype');
  const want = topbarSrc();
  if (!want) {
    // Absent means absent: no empty <img>, no stray divider.
    if (logo) logo.remove();
    const div = bar.querySelector('.brand-logo-div');
    if (div) div.remove();
    return;
  }
  if (!logo) {
    logo = document.createElement('img');
    logo.id = 'brand-logotype';
    logo.className = 'brand-logo';
    logo.alt = 'logo';
    // An unreadable image leaves no broken-image glyph in the chrome.
    logo.addEventListener('error', () => { logo.hidden = true; });
    logo.addEventListener('load', () => { logo.hidden = false; });
    const div = document.createElement('span');
    div.className = 'tb-div brand-logo-div';
    div.setAttribute('aria-hidden', 'true');
    bar.insertBefore(logo, wordmark);
    bar.insertBefore(div, wordmark);
  }
  if (logo.getAttribute('src') !== want) logo.setAttribute('src', want);
}

/* ---------- settings: three drop targets ---------- */
function say(text, bad) {
  const el = $('brand-msg'); if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

function typeOf(file) {
  if (TYPE_BY_EXT.svg === file.type || TYPE_BY_EXT.png === file.type) return file.type;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return TYPE_BY_EXT[ext] || null;
}

async function upload(slot, file) {
  if (!file) return;
  const type = typeOf(file);
  if (!type) { say(`${file.name || 'That file'} is not an SVG or PNG.`, true); return; }
  say(`Uploading ${file.name || slot}…`);
  try {
    const r = await fetch(`/api/brand/${slot}`, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { say(body.error || `Upload failed (${r.status}).`, true); return; }
    say('');
    if (body.slots) applyBrand(body.slots, body.fill, body.theme);
  } catch { say('Upload failed — is the daemon running?', true); }
}

async function clearSlot(slot) {
  try {
    const r = await fetch(`/api/brand/${slot}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { say(body.error || `Remove failed (${r.status}).`, true); return; }
    say('');
    if (body.slots) applyBrand(body.slots, body.fill, body.theme);
  } catch { say('Remove failed — is the daemon running?', true); }
}

function buildRows() {
  const host = $('brand-slots');
  if (!host || host.childElementCount) return;
  for (const { slot, label, where } of SLOTS) {
    const row = document.createElement('div');
    row.className = 'brand-slot';
    row.dataset.slot = slot;

    const name = document.createElement('div');
    name.className = 'brand-slot-name';
    const strong = document.createElement('span');
    strong.textContent = label;
    const sub = document.createElement('span');
    sub.className = 'brand-slot-where';
    sub.textContent = where;
    name.append(strong, sub);

    // The drop target: also a button that opens the file chooser.
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'brand-drop';
    drop.title = `Drop an SVG or PNG, or click to choose — ${label.toLowerCase()}`;
    drop.setAttribute('aria-label', `${label} image (${where}) — choose a file`);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.hidden = true;
    input.addEventListener('change', () => {
      picking = false;
      const f = input.files && input.files[0];
      input.value = '';
      upload(slot, f);
    });
    drop.addEventListener('click', () => {
      picking = true;
      // the chooser may be cancelled without a change event; focus returning
      // to the window ends the pick either way
      window.addEventListener('focus', () => setTimeout(() => { picking = false; }, 300), { once: true });
      input.click();
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      upload(slot, f);
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'brand-remove';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove the ${label.toLowerCase()}`);
    rm.addEventListener('click', () => clearSlot(slot));

    row.append(name, drop, rm, input);
    host.appendChild(row);
  }
}

// Settings → Brand says whose images these are: "Images for the Paper theme".
// Built from text nodes — a theme's name is the user's (or a pack's) text.
function applyThemeLine() {
  const el = $('brand-theme'); if (!el) return;
  el.textContent = '';
  if (!theme) return; // not heard yet: say nothing rather than guess
  const label = theme.title || theme.name;
  if (!label) { el.textContent = 'Images for the current theme, which has no name'; return; }
  const strong = document.createElement('strong');
  strong.textContent = label;
  el.append('Images for the ', strong, ' theme');
}

function applyRows() {
  const host = $('brand-slots'); if (!host) return;
  for (const row of host.querySelectorAll('.brand-slot')) {
    const slot = row.dataset.slot;
    const meta = current[slot];
    const drop = row.querySelector('.brand-drop');
    const rm = row.querySelector('.brand-remove');
    drop.textContent = '';
    if (meta) {
      const img = document.createElement('img');
      img.alt = slot;
      img.src = src(slot, meta);
      drop.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'brand-drop-ph';
      ph.textContent = 'Drop SVG / PNG';
      drop.appendChild(ph);
    }
    drop.classList.toggle('set', !!meta);
    rm.disabled = !meta;
  }
}

// The one place slot state lands — the GET on boot, an upload's reply, and the
// `brand` WS frame every viewer gets when any of them changes a slot, or the
// global theme moves and with it the images that show. `fillIn` / `themeIn`
// absent (a reply or frame that does not carry them) keep what is known.
export function applyBrand(slots, fillIn, themeIn) {
  const next = {};
  for (const { slot } of SLOTS) {
    const m = slots && slots[slot];
    next[slot] = m && typeof m === 'object' && m.version ? m : null;
  }
  current = next;
  if (fillIn !== undefined) {
    const f = {};
    for (const { slot } of SLOTS) {
      const m = fillIn && fillIn[slot];
      f[slot] = m && typeof m === 'object' ? m : null;
    }
    fill = f;
  }
  if (themeIn !== undefined) theme = themeIn && typeof themeIn === 'object' ? themeIn : null;
  applyTopbar();
  applyThemeLine();
  applyRows();
}

export async function refreshBrand() {
  try {
    const r = await fetch('/api/brand');
    if (!r.ok) return;
    const body = await r.json();
    applyBrand(body && body.slots, body && body.fill, body && body.theme);
  } catch {}
}

export function initBrand() {
  buildRows();
  refreshBrand();
  // A light/dark flip can swap the fill's logotype for its reversed variant.
  // theme.js marks the mode on <html>; following the attribute keeps this
  // module out of theme.js's import graph.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(applyTopbar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}
