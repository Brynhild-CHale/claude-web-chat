// The Sessions panel: every web-chat surface on this computer, and which of them
// have a Claude Code session attached — the browser face of `claude-web-chat ls`.
// Opened from ⋯ → Sessions, ⌘K "Sessions…", or S.
//
// It reads ONE route, GET /api/machine/sessions (lib/server/routes/machine.js),
// which reads the one classifier (lib/util/registry sessions + enrichSessions).
// Nothing here decides who is connected; it only draws what the daemon said.
//
// It is a `.popover`, so shell.js's dismiss layer owns closing it (outside click,
// focus leaving, Escape, the window blurring). Opening goes through the
// `wc:close-popovers` window event rather than an import of shell.js, which
// imports this module — the same one-way trick the drawer uses.
//
// The page never STARTS anything. A project with a Claude session and no surface
// shows the command that would start one, with a copy button; running it is the
// user's call, in their terminal.
//
// Every string that came from the registry — a project title, a root path — is
// a directory name somebody chose, so it is set as textContent, never parsed.
import { $ } from './state.js';
import { copyText } from './drawer.js';

const PANEL = 'sessions-panel';
export const REFRESH_MS = 5000;

let timer = null;
let seq = 0; // drops a slow response that lands after a newer one

const isOpen = () => { const p = $(PANEL); return !!p && !p.classList.contains('hidden'); };

function el(tagName, className, text) {
  const n = document.createElement(tagName);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// "just now" / "42s ago" / "3m ago" / "2h ago" / "4d ago", against the SERVER's
// clock (the route sends `now`), which is the clock that stamped the times.
export function ago(ts, now) {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function badge(text, kind) {
  return el('span', `ss-badge${kind ? ' ' + kind : ''}`, text);
}

// The turn lock lives on the daemon, so only a reachable surface can say. It
// rides the Claude line; a lock with no live session beside it (a session that
// just exited mid-turn) shows on the surface line instead, never nowhere.
function turnBadge(s) {
  if (s && s.turn === 'mid-turn') return badge('mid-turn', 'turn');
  if (s && s.turn === 'wake') return badge('wake turn', 'turn');
  return null;
}

// The surface half of a row: running :port · N viewers | not answering | stopped.
function surfaceLine(s, withTurn) {
  const line = el('div', 'ss-line ss-surface');
  if (!s) {
    line.append(el('span', 'ss-dot off', '○'), el('span', null, 'surface stopped'));
    return line;
  }
  if (s.reachable === false) {
    line.append(el('span', 'ss-dot warn', '●'), el('span', null, `:${s.port} · not answering`));
    return line;
  }
  const bits = [`running :${s.port}`];
  if (Number.isFinite(s.viewers)) bits.push(`${s.viewers} viewer${s.viewers === 1 ? '' : 's'}`);
  if (s.active_label) bits.push(`at ${s.active_label}`);
  line.append(el('span', 'ss-dot on', '●'), el('span', null, bits.join(' · ')));
  const turn = withTurn && turnBadge(s);
  if (turn) line.append(turn);
  return line;
}

// The Claude half: ● connected ×N · channel on/off · mid-turn / wake turn · last tool.
function claudeLine(c, s, now) {
  const line = el('div', 'ss-line ss-claude');
  if (!c) {
    line.append(el('span', 'ss-dot off', '—'), el('span', null, 'no Claude session'));
    return line;
  }
  line.append(el('span', 'ss-dot on', '●'), el('span', null, `Claude connected${c.sessions > 1 ? ` ×${c.sessions}` : ''}`));
  line.append(badge(c.channel ? 'channel on' : 'channel off', c.channel ? 'on' : null));
  const turn = turnBadge(s);
  if (turn) line.append(turn);
  const last = ago(c.last_tool_at, now);
  if (last) line.append(el('span', 'ss-muted', `last tool ${last}`));
  return line;
}

function commandRow(cmd) {
  const row = el('div', 'rn-cmd-row ss-cmd');
  const code = el('code', 'rn-cmd', cmd);
  const copy = el('button', 'rn-copy', 'copy');
  copy.type = 'button';
  copy.title = `Copy: ${cmd}`;
  copy.setAttribute('aria-label', `Copy command: ${cmd}`);
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(cmd);
    copy.textContent = ok ? 'copied' : 'select it';
    copy.classList.toggle('ok', ok);
    setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('ok'); }, 1600);
  });
  row.append(code, copy);
  return row;
}

function openSurface(row) {
  if (row.current) { closeSessions(); return; } // you are already looking at it
  window.open(row.surface.url, '_blank', 'noopener');
}

function rowEl(row, now) {
  const item = el('div', 'ss-row');
  item.setAttribute('role', 'listitem');
  item.dataset.root = row.root;
  if (row.current) item.classList.add('current');

  const head = el('div', 'ss-head');
  head.append(el('span', 'ss-title', row.title || row.root));
  if (row.current) head.append(badge('this page', 'here'));
  item.append(head, el('div', 'ss-root', row.display_root || row.root));
  item.append(surfaceLine(row.surface, !row.claude), claudeLine(row.claude, row.surface, now));

  if (row.surface && row.surface.url) {
    item.classList.add('link');
    item.tabIndex = 0;
    item.title = row.current ? 'This surface' : `Open ${row.surface.url} in a new tab`;
    item.addEventListener('click', () => openSurface(row));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSurface(row); }
    });
  } else if (row.open_cmd) {
    item.append(el('div', 'ss-muted', 'Start its surface from a terminal:'), commandRow(row.open_cmd));
  }
  return item;
}

// Draw a /api/machine/sessions body (or an error) into the panel.
export function renderSessions(data, error) {
  const list = $('sessions-list');
  const meta = $('sessions-meta');
  if (!list) return;
  list.replaceChildren();
  if (error || !data || !Array.isArray(data.sessions)) {
    list.append(el('div', 'palette-empty ss-error', `Couldn't read sessions${error ? ` — ${error}` : ''}.`));
    if (meta) meta.textContent = '';
    return;
  }
  const rows = data.sessions;
  if (!rows.length) {
    list.append(el('div', 'palette-empty', 'No web-chat surfaces or Claude sessions on this computer.'));
  }
  for (const row of rows) list.append(rowEl(row, data.now));
  if (meta) {
    const attached = rows.filter((r) => r.claude).length;
    meta.textContent = `${rows.length} project${rows.length === 1 ? '' : 's'} · ${attached} with Claude`;
  }
}

export async function refreshSessions() {
  const mine = ++seq;
  let data = null, error = null;
  try {
    const r = await fetch('/api/machine/sessions');
    if (!r.ok) error = `HTTP ${r.status}`;
    else data = await r.json();
  } catch (e) { error = (e && e.message) || 'network error'; }
  if (mine !== seq || !isOpen()) return;
  renderSessions(data, error);
}

// Poll while open. A setTimeout chain, not setInterval: the next fetch is only
// scheduled once this one has settled, and the chain ends by itself the first
// tick after the dismiss layer hid the panel — no close hook needed.
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (!isOpen()) return;
    await refreshSessions();
    if (isOpen()) schedule();
  }, REFRESH_MS);
}

export function openSessions() {
  const p = $(PANEL); if (!p) return;
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: p } }));
  p.classList.remove('hidden');
  const list = $('sessions-list');
  if (list && !list.firstChild) list.append(el('div', 'palette-empty', 'Loading…'));
  document.querySelectorAll(`[aria-controls="${PANEL}"]`).forEach((c) => c.setAttribute('aria-expanded', 'true'));
  refreshSessions();
  schedule();
}

export function closeSessions() {
  const p = $(PANEL); if (p) p.classList.add('hidden');
  clearTimeout(timer); timer = null;
}

export function toggleSessions() {
  if (isOpen()) closeSessions(); else openSessions();
}
