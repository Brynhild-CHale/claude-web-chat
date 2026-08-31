// Update-available advisory. Checks GET /api/version on page open (and on every
// WebSocket reconnect) and, when a newer GitHub RELEASE exists, reveals a
// full-width bar naming the version and the command that takes it.
//
// It INFORMS; it does not update. The bar used to carry an "Update & restart"
// button that POSTed /api/update and let the daemon npm-install over itself.
// That is gone: updating is a deployment decision, not a page interaction, and
// that button could silently destroy an `npm link` dev install or — since
// "newer" was string inequality — install a downgrade over a build running ahead
// of the last release.
//
// Dismissal lasts THE SESSION, per the product decision: closing the message
// closes it until this tab is opened fresh. Session, not local, storage is what
// makes "session" mean session — through storage.js, which is the one home for
// the private-window guard every such access needs.
import { $ } from './state.js';
import { getSession, setSession, removeSession } from './storage.js';

const RECHECK_MS = 20 * 60 * 1000; // long-open tabs re-check occasionally (server caches 24h)
const DISMISS_KEY = 'wc:update-dismissed';

let currentBuild = null;
// The version the bar is announcing RIGHT NOW, remembered here rather than
// re-derived by regexing the message text back out of the DOM: the dismiss
// handler parsed /web-chat (\S+) is available/ off `.ub-msg`, so a reworded
// sentence, a translated one, or a version containing a space would have
// dismissed nothing at all — silently, since hide() runs either way. It is also
// null whenever the bar is borrowed for something else (see flash), which is the
// honest answer to "what would × dismiss?" in that state.
let announced = null;

const banner = () => $('update-banner');
const msgEl = () => { const b = banner(); return b && b.querySelector('.ub-msg'); };
const linkEl = () => $('ub-release-link');
const show = (latest = null) => { announced = latest; const b = banner(); if (b) b.classList.remove('hidden'); };
const hide = () => { announced = null; const b = banner(); if (b) b.classList.add('hidden'); };

function dismissedVersion() {
  return getSession(DISMISS_KEY);
}

function rememberDismissal(v) {
  setSession(DISMISS_KEY, v);   // private window — the bar simply returns next check
}

// The one entry point: fetch current-vs-latest and reconcile the bar. Safe to
// call repeatedly (boot, interval, every WS reconnect).
export async function checkVersion() {
  let info;
  try { info = await fetch('/api/version').then((r) => r.json()); } catch { return; }
  if (!info || !info.ok || !info.current) return;
  currentBuild = info.current;

  if (!info.updateAvailable || !info.latest) { hide(); return; }
  if (info.latest === dismissedVersion()) { hide(); return; }

  const m = msgEl();
  if (m) {
    m.textContent = `web-chat ${info.latest} is available — you're on ${info.current}. Update with: claude-web-chat update`;
  }
  const a = linkEl();
  if (a && info.releaseUrl) a.href = info.releaseUrl;
  show(info.latest);
}

// The "…" menu's Check for updates. Forces past the daemon's 24h throttle AND
// clears this session's dismissal — asking explicitly should get an answer even
// if you closed the bar earlier.
export async function checkForUpdatesNow() {
  removeSession(DISMISS_KEY);
  let info;
  try { info = await fetch('/api/version?force=1').then((r) => r.json()); } catch { info = null; }
  if (!info || !info.ok) { flash('Could not reach GitHub to check for updates.'); return; }
  currentBuild = info.current;
  if (info.updateAvailable && info.latest) { await checkVersion(); return; }
  // No update: say so, rather than leaving the click with no visible effect.
  flash(info.latest
    ? `You're up to date — web-chat ${info.current} is the latest release.`
    : `You're on web-chat ${info.current}. No published release to compare against.`);
}

// Borrow the bar to answer a question the user asked directly, then let it go.
function flash(text, ms = 6000) {
  const m = msgEl();
  if (m) m.textContent = text;
  const a = linkEl();
  if (a) a.classList.add('hidden');
  show();
  setTimeout(() => { hide(); if (a) a.classList.remove('hidden'); }, ms);
}

export function initVersion() {
  const x = $('btn-update-dismiss');
  if (x) {
    x.addEventListener('click', () => {
      // Remember the version we were showing, so a LATER release still speaks up.
      if (announced) rememberDismissal(announced);
      hide();
    });
  }
  checkVersion();
  const t = setInterval(checkVersion, RECHECK_MS);
  if (t && typeof t === 'object' && t.unref) t.unref();
}

export function runningBuild() { return currentBuild; }
