#!/usr/bin/env node
// Example driver: a file watcher that updates a pane whenever a watched path
// changes. A minimal "host owns state the surface should reflect" loop —
// see docs/driving-the-surface.md.
//
// Usage:
//   claude-web-chat open                       # make sure the surface is up
//   node examples/file-watcher.js <path>...    # watch one or more files/dirs
//   node examples/file-watcher.js src lib      # (defaults to cwd if omitted)
//
// On each change it bumps the `file_change` store key (a signal Claude can
// `wait_for`) and re-renders a pane listing the most recent changes. It owns the
// pane as `service:file-watcher`, so Claude won't clobber it by accident.

const fs = require('fs');
const path = require('path');
const { createDriver } = require('../lib/driver');

const PANE_ID = 'file_watch';
const OWNER = 'file-watcher';
const TIMEOUT_MS = 60 * 60 * 1000; // hard backstop
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];

let wc;
try {
  wc = createDriver({ owner: OWNER });
} catch (e) {
  console.error(`[file-watcher] ${e.message}`);
  process.exit(1);
}

function paneHtml() {
  return `
<style>
  :host, .wrap { font: 13px var(--wc-font, system-ui, sans-serif); color: var(--wc-fg, #111); }
  .head { color: var(--wc-muted, #57606a); margin-bottom: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 3px 0; border-bottom: 1px solid var(--wc-border-light, #eaeef2); display: flex; gap: 8px; }
  li.changed { animation: flash 0.8s ease; }
  @keyframes flash { from { background: var(--wc-gold, #fff3cd); } to { background: transparent; } }
  .file { font-family: var(--wc-mono, ui-monospace, monospace); }
  .ts { color: var(--wc-muted, #8c959f); margin-left: auto; }
  .empty { color: var(--wc-muted, #8c959f); font-style: italic; }
</style>
<div class="wrap">
  <div class="head" id="head">watching…</div>
  <ul id="list"><li class="empty">no changes yet</li></ul>
</div>
<script>
  const list = root.getElementById('list');
  const head = root.getElementById('head');
  function paint(r) {
    if (!r) return;
    if (r.watching) head.textContent = 'watching: ' + r.watching;
    const recent = (r.recent || []);
    if (!recent.length) { list.innerHTML = '<li class="empty">no changes yet</li>'; return; }
    list.innerHTML = '';
    recent.forEach((c, i) => {
      const li = document.createElement('li');
      if (i === 0) li.className = 'changed';
      const f = document.createElement('span'); f.className = 'file'; f.textContent = c.event + ' ' + c.file;
      const t = document.createElement('span'); t.className = 'ts'; t.textContent = c.at;
      li.appendChild(f); li.appendChild(t); list.appendChild(li);
    });
  }
  store.subscribe('${PANE_ID}', paint);
  paint(store.get('${PANE_ID}'));
</script>`;
}

const recent = [];
let watching = '';

async function push() {
  try {
    await wc.setStore({ [PANE_ID]: { seq: Date.now(), watching, recent: recent.slice(0, 20) } });
    // A separate signal key so Claude can wait on *any* change cheaply.
    await wc.setStore({ file_change: { seq: Date.now(), last: recent[0] || null } });
  } catch (e) {
    console.error(`[file-watcher] surface unreachable: ${e.message}`);
  }
}

const watchers = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const w of watchers) { try { w.close(); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function main() {
  const r0 = await wc.render({ id: PANE_ID, html: paneHtml(), params: { title: 'file changes' } });
  if (!r0.ok) {
    console.error(`[file-watcher] could not render pane: ${JSON.stringify(r0)}`);
    return;
  }
  watching = targets.join(', ');
  await push();
  console.log(`[file-watcher] watching ${watching} → pane '${PANE_ID}' as ${wc.owner}. Ctrl-C to stop.`);

  // Debounce: fs.watch fires multiple events per save on some platforms.
  let debounce = null;
  const onChange = (event, file) => {
    recent.unshift({ event, file: file || '(unknown)', at: new Date().toTimeString().slice(0, 8) });
    if (recent.length > 50) recent.length = 50;
    clearTimeout(debounce);
    debounce = setTimeout(push, 120);
  };

  for (const t of targets) {
    try {
      const stat = fs.statSync(t);
      const w = fs.watch(t, { recursive: stat.isDirectory() }, onChange);
      watchers.push(w);
    } catch (e) {
      console.error(`[file-watcher] cannot watch ${t}: ${e.message}`);
    }
  }
  if (!watchers.length) { console.error('[file-watcher] nothing to watch — exiting.'); return; }

  // Hard timeout backstop so a forgotten watcher doesn't run forever.
  setTimeout(() => { console.log('[file-watcher] timeout reached — exiting.'); cleanup(); process.exit(0); }, TIMEOUT_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });
