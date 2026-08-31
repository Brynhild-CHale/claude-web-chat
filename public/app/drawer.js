// The ＋ drawer — components AND packs.
//
// It used to be a pane launcher: open it, it re-fetched the component list, you
// clicked a row, a pane appeared. That is still the dominant action (hence the
// glyph, and hence Library being the default tab), but it is no longer the whole
// of it. A component PACK is a repository that installs as components plus a
// Claude skill, and the drawer is where a URL for one goes.
//
// Structure: two tabs, not two stacked sections. An install form above the list
// would push the hot path — spawn a pane — below the fold every time.
//
//   Library   what you can spawn, grouped by tier, with what each one is
//   Manage    install a pack, review a quarantined one, see what is installed
//
// ── Things this file is deliberate about ────────────────────────────────────
//
// * Names and descriptions go in through `textContent`, never a template
//   literal. Before packs they came only from this project; a pack install means
//   they come from a repository somebody else wrote, rendered into a privileged
//   origin with no CSP. `textContent` is not an escaping strategy, it is the
//   absence of a parsing step.
// * A row is a real <button>, not `role="option"`. An option must not contain
//   interactive children, and every row has a second control (⧉ duplicate).
// * "Download for review" is the PRIMARY button. "Install now" is secondary and
//   takes a second, explicit click for a URL that was never reviewed.
// * Never window.confirm / window.prompt: they block the browser, look like
//   nothing else here, and wedge automated drivers.
// * A builtin collision renders as a refusal with NO override control at all.
//   Not a disabled one — none. There is no override to offer.
//
// And one thing it cannot be deliberate about: the warning copy below is for a
// human. `POST /api/packs/install` is reachable by any pane script, and the
// endpoint cannot tell a pane's fetch from a click. See the header of
// lib/server/routes/packs.js. The copy must not imply it is a control.

import { $ } from './state.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { components, invalidate } from './components.js';
import { panes, unminimize } from './mounts.js';

const LIBRARY = 'library';
const MANAGE = 'manage';

let tab = LIBRARY;
let packsState = null;        // last GET /api/packs payload, or null
let packsWired = false;       // has the daemon got the pack routes at all?
let pendingTrust = new Set(); // component names waiting on `claude-web-chat trust`
let armedInstall = null;      // the URL a second "Install now" click would install
// The services a just-finished install left needing a terminal. Held here rather
// than appended to the DOM, because refresh() rebuilds the Manage panel and would
// wipe anything appended after it.
let postInstall = null;

const isOpen = () => !$('drawer').classList.contains('hidden');

/* ── open / close ─────────────────────────────────────────────────────────── */

export function closeDrawer() {
  const el = $('drawer');
  if (!el || el.classList.contains('hidden')) return;
  // Hand focus back to ＋ ONLY if it is currently inside the drawer — i.e. the
  // user closed it from within (Escape, the × button, a row that spawned). The
  // dismiss layer also closes this panel when focus moves somewhere else
  // entirely, and grabbing focus there would yank the user back out of whatever
  // they just tabbed to.
  const inside = el.contains(document.activeElement);
  el.classList.add('hidden');
  document.querySelectorAll('[aria-controls="drawer"]').forEach((c) => c.setAttribute('aria-expanded', 'false'));
  armedInstall = null;
  postInstall = null;
  if (inside) { const btn = $('btn-add'); if (btn) btn.focus(); }
}

export async function openDrawer(which) {
  const el = $('drawer');
  if (!el) return;
  // One panel at a time — the same rule every other chrome panel follows.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: el } }));
  el.classList.remove('hidden');
  document.querySelectorAll('[aria-controls="drawer"]').forEach((c) => c.setAttribute('aria-expanded', 'true'));
  setTab(which || tab);
  await refresh();
  focusFirst();
}

export function toggleDrawer() {
  if (isOpen()) closeDrawer(); else openDrawer();
}

export function openDrawerManage() { return openDrawer(MANAGE); }

// Focus the first BUTTON in the panel — never a text field.
//
// Focusing the pack URL input on open looked helpful and was not: an editable
// element owns its own keys, so the shell's Escape stood down and Escape did
// nothing at all while the field held focus. The same rule swallows the
// single-key shortcuts. A button is the right landing place; the field is one
// Tab away.
function focusFirst() {
  const panel = $(tab === MANAGE ? 'drawer-manage' : 'drawer-library');
  const first = panel && panel.querySelector('button');
  if (first) setTimeout(() => { if (isOpen()) first.focus(); }, 0);
}

function setTab(next) {
  tab = next === MANAGE ? MANAGE : LIBRARY;
  for (const b of document.querySelectorAll('#drawer-tabs [data-tab]')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('drawer-library').classList.toggle('hidden', tab !== LIBRARY);
  $('drawer-manage').classList.toggle('hidden', tab !== MANAGE);
}

/* ── data ─────────────────────────────────────────────────────────────────── */

async function loadPacks() {
  try {
    const r = await fetch('/api/packs');
    if (r.status === 404) { packsWired = false; packsState = null; return; }
    packsWired = true;
    packsState = await r.json();
  } catch {
    // A daemon that is simply gone is not "packs are unavailable" — leave the
    // last known state and let the Library tab's own failure speak.
    packsWired = false;
  }
}

async function loadPendingTrust() {
  try {
    const r = await fetch('/api/services/pending');
    const body = await r.json();
    pendingTrust = new Set((body.pending || []).map((p) => p.name || p.component).filter(Boolean));
  } catch { pendingTrust = new Set(); }
}

async function refresh() {
  const [list] = await Promise.all([components(), loadPacks(), loadPendingTrust()]);
  renderLibrary(list);
  renderManage();
  updateBadges(list);
}

function updateBadges(list) {
  const btn = $('btn-add');
  if (btn) {
    const n = (list || []).length;
    btn.title = `Components — spawn a pane, manage packs · ${n}`;
    btn.setAttribute('aria-label', `Components — spawn a pane, manage packs (${n}), shortcut N`);
  }
  const badge = document.querySelector('#drawer-tabs [data-tab="manage"] .tab-badge');
  if (badge) {
    const waiting = (packsState && packsState.quarantined || []).length;
    badge.textContent = waiting ? String(waiting) : '';
    badge.classList.toggle('hidden', !waiting);
  }
}

/* ── small DOM helpers ────────────────────────────────────────────────────── */

function el(tagName, className, text) {
  const n = document.createElement(tagName);
  if (className) n.className = className;
  if (text != null) n.textContent = text;      // textContent, always
  return n;
}

function chip(text, kind) {
  return el('span', `de-chip${kind ? ' ' + kind : ''}`, text);
}

// The one command that covers whatever is waiting. A pack with three
// service-backed components should not mean three commands to copy out.
function trustCommand(names) {
  const waiting = (names || []).filter(Boolean);
  if (!waiting.length) return 'claude-web-chat trust';
  return waiting.length === 1 ? `claude-web-chat trust ${waiting[0]}` : 'claude-web-chat trust --all';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* not a secure context, or no permission — fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function notice(title, body, cmd) {
  const box = el('div', 'rail-notice');
  box.appendChild(el('div', 'rn-title', title));
  if (body) box.appendChild(el('div', 'rn-body', body));
  if (cmd) {
    // Click-to-copy. The command still has to be run in a terminal — the page
    // cannot grant a service approval, and deliberately does not try (see the
    // header of lib/cli/commands/trust.js). What it can do is make getting the
    // command out of here a single click instead of a careful re-type.
    const row = el('div', 'rn-cmd-row');
    const code = el('code', 'rn-cmd', cmd);
    const copy = el('button', 'rn-copy', 'copy');
    copy.type = 'button';
    copy.title = `Copy: ${cmd}`;
    copy.setAttribute('aria-label', `Copy command: ${cmd}`);
    const flash = (ok) => {
      copy.textContent = ok ? 'copied' : 'select it';
      copy.classList.toggle('ok', ok);
      setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('ok'); }, 1600);
    };
    copy.addEventListener('click', async (e) => { e.stopPropagation(); flash(await copyText(cmd)); });
    // The code itself is user-select:all, so a click selects the whole command
    // even when the clipboard is unavailable.
    row.append(code, copy);
    box.appendChild(row);
  }
  return box;
}

function empty(text) { return el('div', 'palette-empty', text); }

/* ── Library ──────────────────────────────────────────────────────────────── */

const GROUPS = [
  { key: 'builtin', label: 'BUILT-IN', match: (c) => c.builtin === true },
  { key: 'local', label: 'THIS PROJECT', match: (c) => c.location === 'local' },
  { key: 'system', label: 'ALL PROJECTS', match: (c) => c.location === 'system' },
];

// Which pack (if any) installed this component — so a row can say where it came
// from, which is most of what "manage" means for a component.
function packOf(name) {
  for (const p of (packsState && packsState.packs) || []) {
    if ((p.components || []).includes(name)) return p;
  }
  return null;
}

function renderLibrary(list) {
  const body = $('drawer-library');
  body.replaceChildren();

  if (!list.length) {
    body.appendChild(empty('No components yet.'));
    body.appendChild(notice(
      'Where components come from',
      'Claude saves one whenever it builds a pane worth keeping. Or install a set at once — a component pack ships components plus a Claude skill.',
    ));
    const go = el('button', 'btn primary de-cta', 'Install a pack →');
    go.addEventListener('click', () => setTab(MANAGE));
    body.appendChild(go);
    return;
  }

  const seen = new Set();
  for (const g of GROUPS) {
    const inGroup = list.filter((c) => !seen.has(c.name) && g.match(c));
    for (const c of inGroup) seen.add(c.name);
    if (!inGroup.length) continue;
    body.appendChild(el('div', 'de-group', g.label));
    for (const c of inGroup) body.appendChild(componentRow(c));
  }
  // Anything whose location we did not recognise still lists — a component the
  // user can see but not spawn is the bug this whole row is trying not to be.
  const rest = list.filter((c) => !seen.has(c.name));
  if (rest.length) {
    body.appendChild(el('div', 'de-group', 'OTHER'));
    for (const c of rest) body.appendChild(componentRow(c));
  }
}

function componentRow(c) {
  const row = el('div', 'drawer-entry');

  const main = el('button', 'de-main');
  main.type = 'button';
  main.setAttribute('aria-label', `Spawn ${c.name}`);

  const nameRow = el('div', 'name');
  nameRow.appendChild(el('span', 'de-name', c.name));

  if (c.builtin) nameRow.appendChild(chip('built-in', 'builtin'));
  if (c.location === 'system') nameRow.appendChild(chip('all projects', 'tier'));
  if (c.has_service) {
    nameRow.appendChild(pendingTrust.has(c.name)
      ? chip('service · needs approval', 'warn')
      : chip('service', 'service'));
  }
  if (c.has_seed) nameRow.appendChild(chip('seed', 'seed'));
  if (c.params_schema && c.params_schema.properties) nameRow.appendChild(chip('form', 'form'));
  if (Array.isArray(c.shadows) && c.shadows.length) {
    nameRow.appendChild(chip(`shadows ${c.shadows.join(', ')}`, 'shadow'));
  }
  // The registry lists by DIRECTORY name and resolves by directory. When
  // meta.json disagreed it used to list under a name nothing could spawn; now
  // the disagreement is shown instead of silently preferred.
  if (c.meta_name) nameRow.appendChild(chip(`meta.json says "${c.meta_name}"`, 'warn'));

  main.appendChild(nameRow);
  if (c.description) {
    main.appendChild(el('div', 'desc', c.description));
    // The description is clamped to three lines (see app.css). Put the whole of
    // it on the row's tooltip — a property assignment, so it is text either way.
    main.title = `${c.name} — ${c.description}`;
  }

  const pack = packOf(c.name);
  if (pack) main.appendChild(el('div', 'de-from', `from ${pack.name}${pack.version ? ' ' + pack.version : ''}`));

  main.addEventListener('click', () => spawnComponent(c));
  row.appendChild(main);

  const dup = el('button', 'de-dup', '⧉');
  dup.type = 'button';
  dup.title = `Spawn another ${c.name}`;
  dup.setAttribute('aria-label', `Spawn another ${c.name}`);
  dup.addEventListener('click', (e) => { e.stopPropagation(); spawnComponent(c, { fresh: true }); });
  row.appendChild(dup);

  if (c.has_service && pendingTrust.has(c.name)) {
    row.appendChild(notice(
      'Waiting for your approval',
      'This component runs a host-side process. It stays inert until you approve it in a terminal — the page deliberately cannot.',
      trustCommand([c.name]),
    ));
  }
  return row;
}

/* ── spawning ─────────────────────────────────────────────────────────────── */

// A STABLE slot per component, so spawning the same thing twice replaces its
// pane instead of stacking a new one forever. ⧉ takes the next free slot.
function slotFor(name, fresh) {
  const base = `spawn-${name}`;
  if (!fresh) return base;
  for (let i = 2; i < 500; i++) {
    const id = `${base}-${i}`;
    if (!panes.has(id)) return id;
  }
  return `${base}-${Date.now()}`;
}

async function mountComponent(name, id, params) {
  const r = await fetch(`/api/components/${encodeURIComponent(name)}/use`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, params: params || {} }),
  });
  // Read the response. A locked or driver-owned pane answers 200 with
  // { ok:false, … }; the old code discarded that, so a soft rejection looked
  // exactly like success and the user was left wondering why nothing moved.
  let body = null;
  try { body = await r.json(); } catch {}
  if (body && body.ok === false) {
    flash(body.hint || `could not spawn ${name}`);
    return false;
  }
  // A re-spawn into a MINIMIZED slot lands inside a collapsed chip and reads as
  // a no-op. Restore it.
  unminimize(id);
  return true;
}

// ONE armed submit subscription per component. The unsub used to live only in
// the callback's closure, so it ran only if a value ever landed on the key: an
// abandoned form (Claude cleared it, the node was navigated away, the drawer
// spawned the same component again) left the subscription alive for the page's
// lifetime. And since the signal key is STABLE per component, a second spawn
// added a SECOND closure to the same key — one later submit then ran both, each
// with its own `id` from its own slotFor(): two POST /api/clear and two spawns,
// the older one landing in the slot nobody was looking at. Arming replaces;
// submitting disarms.
const armedSpawns = new Map();       // component name → unsubscribe

function disarmSpawn(name) {
  const off = armedSpawns.get(name);
  if (!off) return;
  armedSpawns.delete(name);
  off();
}

export async function spawnComponent(c, { fresh = false } = {}) {
  const name = typeof c === 'string' ? c : c.name;
  const meta = typeof c === 'string' ? { name } : c;

  let seed = null;
  if (meta.has_seed) {
    try {
      const r = await fetch(`/api/components/${encodeURIComponent(name)}/seed`);
      if (r.ok) {
        // The ONE eval home (public/mount-runtime.js). This used to build its own
        // AsyncFunction right here — a second dynamic-eval site in the window
        // realm, invisible to the conventions ratchet because it was spelled
        // differently.
        seed = await window.__wcMount.runSeed(await r.text(), store, (e) => console.error('seed failed', name, e));
      }
    } catch (e) { console.error('seed failed', name, e); }
  }

  const schema = meta.params_schema && meta.params_schema.properties ? meta.params_schema : null;
  const id = slotFor(name, fresh);

  if (!schema || (seed && isParamsComplete(seed, schema))) {
    closeDrawer();
    await mountComponent(name, id, seed || {});
    return;
  }

  // The component needs params it does not have. Render the form-renderer into
  // its own slot and spawn on submit.
  closeDrawer();
  const formMountId = `spawn-form-${name}`;
  // ONE stable signal key per component, nulled after use. A true delete needs a
  // new store primitive across five files (and would move bus-golden), so the
  // key is collapsed rather than removed — see the plan's "left deliberately".
  const submitKey = `__spawn_${name}`;
  disarmSpawn(name);                 // never two closures on one key — see armedSpawns
  const unsub = store.subscribe(submitKey, async (vals) => {
    if (!vals) return;               // our own null-out, echoing back
    if (armedSpawns.get(name) === unsub) armedSpawns.delete(name);
    unsub();
    store.set({ [submitKey]: null });
    await fetch('/api/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: formMountId }),
    });
    await mountComponent(name, id, vals);
  });
  armedSpawns.set(name, unsub);
  await mountComponent('form-renderer', formMountId, {
    schema,
    submit_key: submitKey,
    submit_label: `Spawn ${name}`,
    title: `Configure: ${name}`,
    initial: seed || {},
    emit_event: false,
    form_reset: true,
  });
}

function isParamsComplete(params, schema) {
  for (const k of schema.required || []) {
    if (params[k] === undefined || params[k] === null || params[k] === '') return false;
  }
  return true;
}

/* ── Manage ───────────────────────────────────────────────────────────────── */

function renderManage() {
  const body = $('drawer-manage');
  body.replaceChildren();

  if (!packsWired) {
    // The drawer ships before the pipeline is necessarily deployed. Degrade to
    // saying so plus the command, rather than to a broken tab.
    body.appendChild(notice(
      'Not wired to this build yet',
      'This surface is talking to a daemon without the pack routes. Restart it, or install from a terminal.',
      'claude-web-chat pack get <repository-url>',
    ));
    return;
  }

  body.appendChild(installForm());

  if (postInstall) {
    const p = trustPrompt(postInstall);
    if (p) body.appendChild(p);
  }

  const waiting = (packsState.quarantined || []);
  if (waiting.length) {
    body.appendChild(el('div', 'de-group', 'AWAITING REVIEW'));
    for (const q of waiting) body.appendChild(quarantineCard(q));
  }

  // An install that started here and never finished. It rides ALONGSIDE the
  // installed list and never in it — a half-install must not read as a pack —
  // but it must be visible here too: the terminal already reports it under
  // `pack list`, and a surface that shows nothing is a surface that says the
  // install simply vanished.
  const stalled = (packsState.pending || []);
  if (stalled.length) {
    body.appendChild(el('div', 'de-group', 'INTERRUPTED'));
    for (const p of stalled) body.appendChild(pendingCard(p));
  }

  body.appendChild(el('div', 'de-group', 'INSTALLED'));
  const installed = packsState.packs || [];
  if (!installed.length) body.appendChild(empty('No packs installed here.'));
  for (const p of installed) body.appendChild(installedCard(p));
}

function installForm() {
  const box = el('div', 'pk-install');
  box.appendChild(el('div', 'de-group', 'INSTALL A PACK'));

  const label = el('label', 'sr-only', 'Pack repository URL');
  label.setAttribute('for', 'pk-url');
  const input = document.createElement('input');
  input.id = 'pk-url';
  input.type = 'text';
  input.className = 'pk-url';
  input.placeholder = 'https://github.com/owner/pack…';
  input.autocomplete = 'off';
  // This field OWNS its Escape — the shell's one Escape owner stands down for any
  // editable chrome field, so "let it fall through" is not available and the
  // field has to define the whole behaviour. It does the two-stage thing a
  // search box does: clear a half-typed URL, and on an already-empty field close
  // the panel. Without the second stage the drawer would be un-closable from the
  // keyboard whenever this field held focus.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (input.value) { input.value = ''; armedInstall = null; status(''); }
      else closeDrawer();
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); doQuarantine(); return; }
    armedInstall = null;   // editing the URL disarms a primed "Install now"
  });
  box.append(label, input);

  const globalRow = el('label', 'pk-check');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'pk-global';
  globalRow.append(cb, el('span', null, 'Install for all projects (not just this one)'));
  box.appendChild(globalRow);

  // The honest description of what a pack is. Not a control — see the file
  // header — but the person reading it deserves the specifics.
  const warn = el('div', 'pk-warn');
  warn.appendChild(el('div', 'pk-warn-title', 'A pack is code that runs here'));
  const ul = el('ul');
  for (const line of [
    'Its panes run in this page, with your permissions and no sandbox.',
    'Any service.js is a process on your machine — inert until you run claude-web-chat trust.',
    'Its SKILL.md becomes part of Claude’s instructions in this project.',
  ]) ul.appendChild(el('li', null, line));
  warn.appendChild(ul);
  warn.appendChild(el('div', 'pk-warn-foot', 'If you did not write it, download it for review first.'));
  box.appendChild(warn);

  const actions = el('div', 'pk-actions');
  const review = el('button', 'btn primary', 'Download for review');
  review.type = 'button';
  review.addEventListener('click', doQuarantine);

  const now = el('button', 'btn pk-now', 'Install now');
  now.type = 'button';
  now.addEventListener('click', () => doInstall(now));

  actions.append(review, now);
  box.appendChild(actions);
  box.appendChild(el('div', 'pk-status'));
  return box;
}

const urlValue = () => (($('pk-url') || {}).value || '').trim();
const wantsGlobal = () => Boolean(($('pk-global') || {}).checked);

function status(text, kind) {
  const s = document.querySelector('#drawer-manage .pk-status');
  if (!s) return;
  s.className = `pk-status${kind ? ' ' + kind : ''}`;
  s.textContent = text || '';
}

// Small transient message for anything that happens after the drawer closed.
function flash(text) {
  status(text, 'err');
  if (!isOpen()) console.warn('[web-chat]', text);
}

function busy(on) {
  for (const b of document.querySelectorAll('#drawer-manage .pk-actions button')) b.disabled = on;
}

async function doQuarantine() {
  const url = urlValue();
  if (!url) { status('Paste a repository URL first.', 'err'); return; }
  armedInstall = null;
  busy(true);
  status('Downloading and verifying…');
  try {
    const body = await postJson('/api/packs/quarantine', { url, global: wantsGlobal() });
    if (!body.ok) { status(body.hint || 'could not download that pack', 'err'); return; }
    status('');
    $('pk-url').value = '';
    await refresh();
  } catch (e) {
    status(`could not reach the daemon: ${e.message}`, 'err');
  } finally { busy(false); }
}

// Install now takes TWO clicks for a URL that was never reviewed. The first
// arms it and says what is about to happen; the second does it. Not a
// window.confirm — that blocks the browser and looks like nothing else here.
async function doInstall(btn) {
  const url = urlValue();
  if (!url) { status('Paste a repository URL first.', 'err'); return; }
  const reviewed = (packsState && packsState.quarantined || []).some((q) => q.source && q.source.url === url);
  if (!reviewed && armedInstall !== url) {
    armedInstall = url;
    btn.textContent = 'Install now — click again';
    btn.classList.add('armed');
    status('This installs without reviewing it first. Click again to go ahead.', 'warn');
    return;
  }
  armedInstall = null;
  btn.textContent = 'Install now';
  btn.classList.remove('armed');
  busy(true);
  status('Downloading and installing…');
  try {
    const body = await postJson('/api/packs/install', { url, global: wantsGlobal() });
    if (!body.ok) { status(body.hint || 'could not install that pack', 'err'); return; }
    $('pk-url').value = '';
    postInstall = body;
    invalidate();
    await refresh();
    status(installedSummary(body), 'ok');
  } catch (e) {
    status(`could not reach the daemon: ${e.message}`, 'err');
  } finally { busy(false); }
}

function installedSummary(body) {
  const n = (body.pack.units || []).filter((u) => u.kind === 'component').length;
  const bits = [`installed ${body.pack.name} — ${n} component${n === 1 ? '' : 's'}`];
  if (body.skill) bits.push('skill added');
  const svc = (body.services || []).length;
  if (svc) bits.push(`${svc} need${svc === 1 ? 's' : ''} approval`);
  return bits.join(' · ');
}

// Post-install: the services that need a terminal, and the ONE command that
// covers them, right where the user is still looking. Without this the only
// prompt was a per-component notice further down the Library tab.
function trustPrompt(body) {
  const services = body.services || [];
  if (!services.length) return null;
  return notice(
    services.length === 1 ? 'One component needs your approval' : `${services.length} components need your approval`,
    `${services.join(', ')} ship a service.js — a process on your machine, with your permissions. `
      + 'They stay inert until you approve them in a terminal. The page cannot grant this, and deliberately does not try: '
      + 'a pane script runs in this same page and could ask on its own behalf.',
    trustCommand(services),
  );
}

async function postJson(path, payload) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

/* ── the quarantine card ──────────────────────────────────────────────────── */

function provenance(source) {
  if (!source) return 'unknown source';
  const sha = String(source.sha || '').slice(0, 7);
  const base = source.via === 'release'
    ? `release ${source.ref} · ${source.sums_verified ? 'sha256 verified' : 'UNVERIFIED'} · ${sha}`
    : `tarball @ ${sha}`;
  // `via gh` means the fetch was authenticated as the user — the only way a
  // private pack repository arrives at all.
  return source.transport === 'gh' ? `${base} · via gh` : base;
}

function quarantineCard(q) {
  const card = el('div', 'pk-card pk-quarantined');

  const head = el('div', 'pk-head');
  head.appendChild(el('span', 'pk-name', q.name));
  if (q.version) head.appendChild(chip(q.version, 'tier'));
  head.appendChild(chip(q.tier === 'system' ? 'all projects' : 'this project', 'tier'));
  card.appendChild(head);

  if (q.description) card.appendChild(el('div', 'desc', q.description));
  card.appendChild(el('div', 'pk-prov', provenance(q.source)));
  if (q.source && q.source.url) card.appendChild(el('div', 'pk-prov', q.source.url));

  // What it would install, with the service.js flag on the ones that matter.
  const units = el('div', 'pk-units');
  for (const c of componentsOf(q)) {
    const row = el('div', 'pk-unit');
    row.appendChild(el('span', 'de-name', c.name));
    if (c.has_service) row.appendChild(chip('service.js — host code', 'warn'));
    if (c.has_seed) row.appendChild(chip('seed', 'seed'));
    units.appendChild(row);
  }
  if (units.childElementCount) card.appendChild(units);

  // SKILL.md, expandable inline. This is the artefact nobody thinks to read, and
  // it is the one that ends up in Claude's instructions.
  card.appendChild(skillDisclosure(q));

  for (const c of q.collisions || []) {
    if (c.severity === 'refused') {
      // No override control. Not a disabled one — there is nothing to offer.
      card.appendChild(notice('Refused', c.detail));
    } else if (c.severity === 'replace') {
      card.appendChild(notice(
        'Already exists',
        `${c.detail}. Installing from here keeps yours; replacing is a terminal decision.`,
        `claude-web-chat pack approve ${q.name} --replace`,
      ));
    } else if (c.severity === 'shadowed') {
      card.appendChild(notice('Would be shadowed', c.detail));
    }
  }
  for (const e of q.errors || []) card.appendChild(notice('Cannot install', e));

  const refused = (q.errors || []).length > 0;
  const actions = el('div', 'pk-actions');
  if (!refused) {
    const approve = el('button', 'btn primary', 'Install it');
    approve.type = 'button';
    approve.addEventListener('click', () => approvePack(q.name, approve));
    actions.appendChild(approve);
  }
  const view = el('button', 'btn', 'Files…');
  view.type = 'button';
  view.addEventListener('click', () => toggleFileList(card, q));
  const drop = el('button', 'btn', 'Discard');
  drop.type = 'button';
  drop.addEventListener('click', () => discardPack(q.name, drop));
  actions.append(view, drop);
  card.appendChild(actions);
  card.appendChild(el('div', 'pk-card-status'));
  return card;
}

function componentsOf(q) {
  // The record carries the full component list. Older records (staged before
  // that field existed) only knew which ones had a service.js — fall back to
  // those rather than showing nothing.
  if (Array.isArray(q.components)) return q.components;
  return (q.services || []).map((name) => ({ name, has_service: true }));
}

function skillDisclosure(q) {
  const wrap = el('details', 'pk-skill');
  const sum = el('summary', null, q.skill && q.skill.description
    ? 'what this tells Claude'
    : 'no SKILL.md — Claude will not know these components exist unless it looks');
  wrap.appendChild(sum);
  const inner = el('div', 'pk-skill-body');
  if (q.skill && q.skill.description) {
    inner.appendChild(el('div', 'pk-skill-desc', q.skill.description));
    inner.appendChild(el('div', 'pk-skill-note', 'This sits in Claude’s context from the start of every session in this project.'));
  }
  const more = el('button', 'btn pk-skill-full', 'Read the whole SKILL.md');
  more.type = 'button';
  more.addEventListener('click', async () => {
    more.disabled = true;
    const text = await reviewFile(q.name, 'SKILL.md');
    more.remove();
    const pre = el('pre', 'pk-file', text == null ? 'could not read SKILL.md' : text);
    inner.appendChild(pre);
  });
  if (q.skill && q.skill.description) inner.appendChild(more);
  wrap.appendChild(inner);
  return wrap;
}

async function reviewFile(name, file) {
  try {
    const r = await fetch(`/api/packs/quarantine/${encodeURIComponent(name)}/review?file=${encodeURIComponent(file)}`);
    const body = await r.json();
    return body.ok ? body.text : null;
  } catch { return null; }
}

async function toggleFileList(card, q) {
  const existing = card.querySelector('.pk-files');
  if (existing) { existing.remove(); return; }
  const box = el('div', 'pk-files');
  card.appendChild(box);
  let body = null;
  try {
    const r = await fetch(`/api/packs/quarantine/${encodeURIComponent(q.name)}/review`);
    body = await r.json();
  } catch {}
  if (!body || !body.ok) { box.appendChild(el('div', 'pk-prov', 'could not read the staged pack')); return; }
  for (const f of body.tree || []) {
    const row = el('button', 'pk-file-row');
    row.type = 'button';
    row.appendChild(el('span', 'pk-file-name', f.path));
    row.appendChild(el('span', 'pk-file-size', `${f.bytes} B`));
    row.addEventListener('click', async () => {
      const open = row.nextElementSibling && row.nextElementSibling.classList.contains('pk-file');
      if (open) { row.nextElementSibling.remove(); return; }
      const text = await reviewFile(q.name, f.path);
      const pre = el('pre', 'pk-file', text == null ? 'could not read that file' : text);
      row.after(pre);
    });
    box.appendChild(row);
  }
}

function cardStatus(card, text, kind) {
  const s = card.querySelector('.pk-card-status');
  if (!s) return;
  s.className = `pk-card-status${kind ? ' ' + kind : ''}`;
  s.textContent = text || '';
}

async function approvePack(name, btn) {
  const card = btn.closest('.pk-card');
  btn.disabled = true;
  cardStatus(card, 'Installing…');
  try {
    const body = await postJson(`/api/packs/quarantine/${encodeURIComponent(name)}/approve`, {});
    if (!body.ok) { cardStatus(card, body.hint || 'could not install it', 'err'); btn.disabled = false; return; }
    postInstall = body;
    invalidate();
    await refresh();
  } catch (e) {
    cardStatus(card, `could not reach the daemon: ${e.message}`, 'err');
    btn.disabled = false;
  }
}

async function discardPack(name, btn) {
  const card = btn.closest('.pk-card');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/packs/quarantine/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const body = await r.json();
    if (!body.ok) { cardStatus(card, body.hint || 'could not discard it', 'err'); btn.disabled = false; return; }
    await refresh();
  } catch (e) {
    cardStatus(card, `could not reach the daemon: ${e.message}`, 'err');
    btn.disabled = false;
  }
}

/* ── the installed card ───────────────────────────────────────────────────── */

// A pending marker, in the two shapes it comes in. `applying` means the process
// died between the marker and the record, and re-running the install is the
// whole recovery. `rollback-failed` is the other, rarer news: the unwind ran and
// could not finish, so the tree really is half-applied and the previous bytes
// are sitting in a snapshot directory the card has to name.
function pendingCard(p) {
  const card = el('div', 'pk-card');
  const head = el('div', 'pk-head');
  head.appendChild(el('span', 'pk-name', p.name));
  if (p.version) head.appendChild(chip(p.version, 'tier'));
  head.appendChild(chip(p.tier === 'system' ? 'all projects' : 'this project', 'tier'));
  const torn = p.status === 'rollback-failed';
  head.appendChild(chip(torn ? 'rollback failed' : 'never finished', 'warn'));
  card.appendChild(head);

  if (p.started_at) card.appendChild(el('div', 'pk-prov', `started ${p.started_at}`));
  if (torn) {
    for (const f of p.rollback_errors || []) card.appendChild(el('div', 'pk-prov', `could not undo: ${f}`));
    card.appendChild(notice(
      'This install is half-applied',
      `The rollback could not finish, so some files are from the new version and some are not.${p.backup_dir ? ` The previous bytes were copied aside to ${p.backup_dir}.` : ''} Sort it out from a terminal — the page cannot.`,
      'claude-web-chat pack list',
    ));
  } else {
    card.appendChild(notice(
      'Nothing was registered',
      'This install started and never finished, so no pack was recorded and nothing here is using it. Re-running the install is the whole recovery.',
      'claude-web-chat pack list',
    ));
  }
  return card;
}

function installedCard(p) {
  const card = el('div', 'pk-card');
  const head = el('div', 'pk-head');
  head.appendChild(el('span', 'pk-name', p.name));
  if (p.version) head.appendChild(chip(p.version, 'tier'));
  head.appendChild(chip(p.tier === 'system' ? 'all projects' : 'this project', 'tier'));
  if (p.drift) head.appendChild(chip('locally edited', 'warn'));
  card.appendChild(head);

  if (p.description) card.appendChild(el('div', 'desc', p.description));
  card.appendChild(el('div', 'pk-prov', provenance(p.source)));

  if ((p.components || []).length) {
    card.appendChild(el('div', 'pk-unit-list', p.components.join(' · ')));
  }
  if (p.skill) {
    const d = el('details', 'pk-skill');
    d.appendChild(el('summary', null, 'what this tells Claude'));
    const inner = el('div', 'pk-skill-body');
    inner.appendChild(el('div', 'pk-skill-desc', p.skill.description || '(no description in its frontmatter)'));
    inner.appendChild(el('div', 'pk-skill-note', p.skill.dest));
    d.appendChild(inner);
    card.appendChild(d);
  }
  if ((p.services || []).length) {
    const waiting = p.services.filter((s) => pendingTrust.has(s));
    if (waiting.length) {
      card.appendChild(notice(
        'Waiting for your approval',
        waiting.length === 1
          ? `${waiting[0]} runs a host-side process. It stays inert until you approve it in a terminal.`
          : `${waiting.join(', ')} run host-side processes. They stay inert until you approve them — one command covers all ${waiting.length}.`,
        trustCommand(waiting),
      ));
    }
  }

  const actions = el('div', 'pk-actions');
  const rm = el('button', 'btn', 'Remove');
  rm.type = 'button';
  rm.addEventListener('click', () => removePack(p.name, rm));
  actions.appendChild(rm);
  card.appendChild(actions);
  card.appendChild(el('div', 'pk-card-status'));
  return card;
}

async function removePack(name, btn) {
  const card = btn.closest('.pk-card');
  btn.disabled = true;
  cardStatus(card, 'Removing…');
  try {
    const r = await fetch(`/api/packs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const body = await r.json();
    if (!body.ok) {
      // A drifted pack refuses here and hands back the terminal command. Show it
      // rather than pretending a button could do it.
      cardStatus(card, '');
      card.appendChild(notice('Kept — you have edited this', body.hint || '', body.command));
      btn.disabled = false;
      return;
    }
    invalidate();
    await refresh();
  } catch (e) {
    cardStatus(card, `could not reach the daemon: ${e.message}`, 'err');
    btn.disabled = false;
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

function render() { if (isOpen()) refresh(); }

export function initDrawer() {
  $('drawer-close').addEventListener('click', closeDrawer);
  // A real toggle. The button declares aria-controls="drawer", which opts it
  // into the dismiss layer's owned-panel skip — without that, pointerdown closed
  // the drawer and the click immediately reopened it, so ＋ never closed anything.
  $('btn-add').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });

  const tabs = $('drawer-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    setTab(b.dataset.tab);
    focusFirst();
  });

  // ↑/↓ move between rows. Escape is deliberately NOT handled here: it has one
  // owner (shell.handleEscape, which closes every chrome panel including this
  // one). The drawer used to add a second document-level Escape listener of its
  // own, which is how two of them ended up disagreeing about precedence. A chrome
  // FIELD inside the drawer — the URL box — still owns its own Escape and stops
  // propagation, so typing Escape there clears the field instead of closing the
  // panel out from under a half-typed URL.
  $('drawer').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...$('drawer').querySelectorAll('.de-main, .pk-card button, .pk-actions button, .pk-url')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? items[Math.min(items.length - 1, i + 1)]
      : items[Math.max(0, i - 1)];
    if (next) next.focus();
  });

  // The component set moved (a save_component, or a pack install from anywhere,
  // including another browser or the CLI). One cache, one repaint.
  bus.on('components:changed', render);
  bus.on('packs:changed', render);
}
