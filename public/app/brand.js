// Brand image slots in the chrome: the topbar logotype, and the Settings
// panel's three drop targets (logotype / lockup / seal). The server owns the
// files and the validation (lib/server/brand.js); this only shows them and
// sends new ones.
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

let current = {};   // slot -> {type, bytes, version} | null

// A native file chooser takes window focus, and the dismiss layer closes every
// panel on window blur — which would shut Settings under the user's pick. The
// shell asks this before treating a blur as "the user went elsewhere".
let picking = false;
export function isPickingFile() { return picking; }

const src = (slot, meta) => `/brand/${slot}?v=${encodeURIComponent(meta.version || '')}`;

/* ---------- topbar ---------- */
function applyTopbar() {
  const bar = $('topbar');
  const wordmark = bar && bar.querySelector('.brand');
  if (!wordmark) return;
  let logo = $('brand-logotype');
  const meta = current.logotype;
  if (!meta) {
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
  const want = src('logotype', meta);
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
    if (body.slots) applyBrand(body.slots);
  } catch { say('Upload failed — is the daemon running?', true); }
}

async function clearSlot(slot) {
  try {
    const r = await fetch(`/api/brand/${slot}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { say(body.error || `Remove failed (${r.status}).`, true); return; }
    say('');
    if (body.slots) applyBrand(body.slots);
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
// `brand` WS frame every viewer gets when any of them changes a slot.
export function applyBrand(slots) {
  const next = {};
  for (const { slot } of SLOTS) {
    const m = slots && slots[slot];
    next[slot] = m && typeof m === 'object' && m.version ? m : null;
  }
  current = next;
  applyTopbar();
  applyRows();
}

export async function refreshBrand() {
  try {
    const r = await fetch('/api/brand');
    if (!r.ok) return;
    const body = await r.json();
    applyBrand(body && body.slots);
  } catch {}
}

export function initBrand() {
  buildRows();
  refreshBrand();
}
