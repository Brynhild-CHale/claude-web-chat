// Update-available banner. Fetches GET /api/version (the running build vs the
// latest on the git remote); when a newer build exists it reveals a full-width
// advisory (#update-banner) with an "Update & restart" button. The button POSTs
// /api/update, which spawns a detached `claude-web-chat update` that pulls the
// build and bounces the daemon — a STATE-PRESERVING restart (draft.json snapshot
// + restore), so this tab just drops its socket, reconnects, and rehydrates.
//
// Success is observed passively: the daemon restart drops the WS; on reconnect
// the `hello` handler (ws.js) re-runs checkVersion(), which sees `current` has
// moved to the new build and clears the banner. A stall timer guards the case
// where the update never lands (npm error → the old daemon just keeps running).
import { $ } from './state.js';

let currentBuild = null;   // running daemon version (from the first successful check)
let latestShown = null;    // the latest version currently surfaced in the banner
let dismissedFor = null;   // a version the user dismissed this session — don't re-nag for it
let inProgress = false;    // an update was kicked off from this tab
let fromBuild = null;      // the build we updated FROM (so a bounce to any newer build = success)
let stallTimer = null;

const RECHECK_MS = 20 * 60 * 1000; // long-open tabs re-check occasionally (server caches 24h)
const STALL_MS = 150 * 1000;       // no new build within this after clicking = show a manual hint

const banner = () => $('update-banner');
const msgEl = () => { const b = banner(); return b && b.querySelector('.ub-msg'); };
const btnEl = () => $('btn-update-now');
const show = () => { const b = banner(); if (b) b.classList.remove('hidden'); };
const hide = () => { const b = banner(); if (b) { b.classList.add('hidden'); b.classList.remove('ok'); } };

function setMsg(text) { const m = msgEl(); if (m) m.textContent = text; }
function setBtn(text, disabled) { const b = btnEl(); if (b) { b.textContent = text; b.disabled = !!disabled; b.classList.remove('hidden'); } }

// The one entry point: fetch current-vs-latest and reconcile the banner. Safe to
// call repeatedly (boot, interval, every WS reconnect).
export async function checkVersion() {
  let info;
  try { info = await fetch('/api/version').then((r) => r.json()); } catch { return; }
  if (!info || !info.ok || !info.current) return;
  if (currentBuild == null) currentBuild = info.current;

  // A restart landed us on a different build — the update (ours or a terminal
  // `claude-web-chat update`) succeeded. Celebrate briefly, then clear.
  if (inProgress && info.current !== fromBuild) { updateSucceeded(info.current); return; }
  if (inProgress) return; // mid-update: leave the "Updating…" state as set

  currentBuild = info.current;
  if (info.updateAvailable && info.latest && info.latest !== dismissedFor) {
    latestShown = info.latest;
    setMsg(`web-chat ${info.latest} is available — you're on ${info.current}.`);
    setBtn('Update & restart', false);
    show();
  } else if (!info.updateAvailable) {
    hide();
  }
}

async function onUpdate() {
  setBtn('Updating…', true);
  setMsg('Pulling the update and restarting — the surface will reconnect automatically.');
  let ok = false;
  try {
    const r = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok = r.ok;
  } catch {}
  if (!ok) { setMsg('Could not start the update. Run `claude-web-chat update` in the terminal.'); setBtn('Retry', false); return; }
  inProgress = true;
  fromBuild = currentBuild;
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    inProgress = false;
    setMsg('Update is taking a while — check the terminal, or run `claude-web-chat update`.');
    setBtn('Retry', false);
  }, STALL_MS);
}

function updateSucceeded(v) {
  inProgress = false;
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  currentBuild = v;
  dismissedFor = null;
  const b = banner();
  if (b) b.classList.add('ok');
  setMsg(`Updated to ${v} ✓`);
  const btn = btnEl();
  if (btn) btn.classList.add('hidden');
  setTimeout(hide, 4000);
}

// Explicit "Check for updates" (the … menu). Forces a fresh fetch past the 24h
// throttle: reveals the banner if a newer build exists (overriding any prior
// dismissal), otherwise flashes a brief "you're on the latest" confirmation so
// the click always gives feedback.
export async function checkForUpdatesNow() {
  let info;
  try { info = await fetch('/api/version?force=1').then((r) => r.json()); } catch { info = null; }
  if (!info || !info.ok || !info.current) { flashInfo('Could not check for updates — try again.'); return; }
  currentBuild = info.current;
  if (inProgress) return; // an update is already running; don't stomp its state
  if (info.updateAvailable && info.latest) {
    dismissedFor = null; // an explicit check overrides a prior dismiss
    latestShown = info.latest;
    const b = banner(); if (b) b.classList.remove('ok');
    setMsg(`web-chat ${info.latest} is available — you're on ${info.current}.`);
    setBtn('Update & restart', false);
    show();
  } else {
    flashInfo(`You're on the latest version (${info.current}).`);
  }
}

// Brief informational flash in the banner (green, no update button, auto-hides).
function flashInfo(text) {
  const b = banner(); if (!b) return;
  b.classList.add('ok');
  setMsg(text);
  const btn = btnEl(); if (btn) btn.classList.add('hidden');
  show();
  clearTimeout(flashInfo._t);
  flashInfo._t = setTimeout(hide, 4000);
}

function onDismiss() {
  const b = banner();
  if (b && b.classList.contains('ok')) return; // never dismiss the success flash out from under itself
  if (latestShown) dismissedFor = latestShown;
  hide();
}

export function initVersion() {
  const btn = btnEl();
  if (btn) btn.addEventListener('click', onUpdate);
  const x = $('btn-update-dismiss');
  if (x) x.addEventListener('click', onDismiss);
  checkVersion();
  setInterval(checkVersion, RECHECK_MS);
}
