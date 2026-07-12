#!/usr/bin/env node
// Example driver: a test runner that renders pass/fail into a pane and writes a
// `test_run` signal key Claude (or a pane button) can react to.
//
// This is a *driver* — a local process that pushes live state into the web-chat
// surface without being Claude. See docs/driving-the-surface.md.
//
// (Named run-tests.js, not test-runner.js, so `node --test` doesn't mistake it
// for a test file via the `test-*` discovery pattern.)
//
// Usage:
//   claude-web-chat open          # make sure the surface is up
//   node examples/run-tests.js    # runs `node --test` and reports into a pane
//   node examples/run-tests.js -- npm test    # or wrap any test command
//
// The pane shows the latest run and a "Re-run" button. Clicking it bumps the
// `rerun_request` store key; this script waits on that key and runs again — so
// the user drives re-runs from the browser with no terminal round-trip. Claude
// can also `wait_for` the `test_run` key to be told when a run finishes.

const { spawn } = require('child_process');
const { createDriver } = require('../lib/driver');

const PANE_ID = 'test_run';
const OWNER = 'test-runner';
const TIMEOUT_MS = 30 * 60 * 1000; // hard backstop — never poll forever
const command = process.argv.slice(2).filter((a) => a !== '--');
const [cmd, ...cmdArgs] = command.length ? command : ['node', '--test'];

let wc;
try {
  wc = createDriver({ owner: OWNER });
} catch (e) {
  console.error(`[test-runner] ${e.message}`);
  process.exit(1);
}

// The pane subscribes to `test_run` and re-renders; the Re-run button writes
// `rerun_request` with a bumping seq. We seed an initial value so a late-mounting
// pane has something to show.
function paneHtml() {
  return `
<style>
  :host, .wrap { font: 13px var(--wc-font, system-ui, sans-serif); color: var(--wc-fg, #111); }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .badge { font-weight: 700; padding: 2px 10px; border-radius: var(--wc-radius-sm, 5px); }
  .pass { background: var(--wc-green, #1a7f37); color: #fff; }
  .fail { background: #cf222e; color: #fff; }
  .run  { background: var(--wc-gold, #d4a72c); color: #111; }
  .meta { color: var(--wc-muted, #57606a); }
  button { font: inherit; padding: 4px 12px; border-radius: var(--wc-radius-sm, 5px);
    border: 1px solid var(--wc-border, #d0d7de); background: var(--wc-panel-bg, #fff); cursor: pointer; }
  pre { background: var(--wc-bg, #f6f8fa); padding: 8px; border-radius: var(--wc-radius-sm, 5px);
    max-height: 220px; overflow: auto; white-space: pre-wrap; margin: 0; }
</style>
<div class="wrap">
  <div class="row">
    <span id="badge" class="badge run">…</span>
    <span id="meta" class="meta">waiting for first run</span>
    <button id="rerun">Re-run</button>
  </div>
  <pre id="log"></pre>
</div>
<script>
  const badge = root.getElementById('badge');
  const meta = root.getElementById('meta');
  const logEl = root.getElementById('log');
  function paint(r) {
    if (!r) return;
    if (r.status === 'running') { badge.className = 'badge run'; badge.textContent = 'RUN'; meta.textContent = r.detail || 'running…'; }
    else if (r.status === 'pass') { badge.className = 'badge pass'; badge.textContent = 'PASS'; meta.textContent = (r.passed||0) + ' passed'; }
    else { badge.className = 'badge fail'; badge.textContent = 'FAIL'; meta.textContent = (r.failed||0) + ' failed / ' + (r.passed||0) + ' passed'; }
    if (r.log != null) logEl.textContent = r.log;
  }
  root.getElementById('rerun').addEventListener('click', () => {
    store.set({ rerun_request: { seq: Date.now() } });
    badge.className = 'badge run'; badge.textContent = 'RUN'; meta.textContent = 'queued…';
  });
  store.subscribe('${PANE_ID}', paint);
  paint(store.get('${PANE_ID}'));
</script>`;
}

function parseCounts(out) {
  const passed = (out.match(/^# pass (\d+)/m) || [])[1];
  const failed = (out.match(/^# fail (\d+)/m) || [])[1];
  return { passed: passed != null ? +passed : null, failed: failed != null ? +failed : null };
}

function runOnce() {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, cmdArgs, { cwd: process.cwd() });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const { passed, failed } = parseCounts(out);
      resolve({ code, out, passed, failed });
    });
    child.on('error', (e) => resolve({ code: 1, out: `failed to spawn ${cmd}: ${e.message}`, passed: 0, failed: 1 }));
  });
}

async function report(status, extra) {
  try {
    await wc.setStore({ [PANE_ID]: { seq: Date.now(), status, ...extra } });
  } catch (e) {
    console.error(`[test-runner] surface unreachable: ${e.message}`);
  }
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function main() {
  const r0 = await wc.render({ id: PANE_ID, html: paneHtml(), params: { title: `tests: ${cmd} ${cmdArgs.join(' ')}` } });
  if (!r0.ok) {
    console.error(`[test-runner] could not render pane: ${JSON.stringify(r0)}`);
    return;
  }
  console.log(`[test-runner] driving pane '${PANE_ID}' as ${wc.owner}. Re-run from the browser or Ctrl-C to stop.`);

  // First run immediately.
  let lastReq = (await wc.getStore(['rerun_request']).catch(() => ({})))?.rerun_request?.seq || 0;
  const tStart = Date.now();
  let pending = true;

  while (Date.now() - tStart < TIMEOUT_MS) {
    if (pending) {
      pending = false;
      await report('running', { detail: `${cmd} ${cmdArgs.join(' ')}` });
      const res = await runOnce();
      await report(res.code === 0 ? 'pass' : 'fail', {
        passed: res.passed, failed: res.failed, log: res.out.slice(-4000),
      });
      console.log(`[test-runner] run finished: ${res.code === 0 ? 'PASS' : 'FAIL'}`);
    }
    // Wait for a Re-run click (bumped seq), bounded so the loop can exit.
    const w = await wc.waitFor({ store_key: 'rerun_request', exists: true }, { timeout_ms: 5000 }).catch(() => ({ ok: false }));
    if (w.ok && w.value && w.value.seq > lastReq) { lastReq = w.value.seq; pending = true; }
  }
  console.log('[test-runner] timeout reached — exiting.');
}

main().catch((e) => { console.error(e); process.exit(1); });
