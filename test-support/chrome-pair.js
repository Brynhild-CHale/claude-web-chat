'use strict';
// Two (or more) REAL chromes against one real daemon, each in a child process
// of its own (test-support/chrome-child.js) — PLAN.md §7 obligation 8 and
// GT-06's "two bootShell child chromes driven through the daemon with live
// timers". bootShell boots one shell per file and process
// (test-support/chrome-shell.js), so a second viewer needs a second process.
//
//   const { spawnChrome, chromePair, DESKTOP, PHONE } = require('../test-support/chrome-pair');
//   const d = await withServer(t);
//   const [a, b] = await chromePair(t, { port: d.port });   // desktop + phone
//   await a.call('mark'); …drive the daemon over HTTP… const { reports } = await a.call('settle');
//
// Each child bridges its chrome's FakeSocket to a real `ws` socket on the
// daemon's port (the daemon's frames in, the chrome's sends out), inits
// public/app/overlay-report.js, and answers the commands chrome-child.js
// lists. The parent drives the daemon over HTTP and reads each child's sent
// reports and its last answers over IPC. Every child is killed on t.after,
// so a failing assertion leaks no process. The helper is reusable by the
// gate's re-aimed F9 c9 adapter; it never runs a gate script itself.
//
//   spawnChrome(t, {port, viewport, routes, transport, name}) → child
//     child.call(cmd, args) → the command's result (rejects on an error reply)
//     child.events          {event, msg} the child posted (a transport's batches)
//     child.name / child.surface
//   chromePair(t, {port, viewports = [DESKTOP, PHONE], routes}) → [child, child]
const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, 'chrome-child.js');
const SANDBOX = path.join(__dirname, 'sandbox.js');
const DESKTOP = Object.freeze({ width: 1280, height: 800 });
const PHONE = Object.freeze({ width: 390, height: 844 });
const CALL_TIMEOUT_MS = 45000;

async function spawnChrome(t, { port, viewport = DESKTOP, routes = {}, transport = false, name = 'chrome' } = {}) {
  if (!Number.isSafeInteger(port)) throw new TypeError('spawnChrome: port is the daemon\'s (withServer d.port)');
  const proc = fork(CHILD, [], {
    // The chrome's ES modules sit in a package without a "type": Node warns once per process.
    execArgv: ['--import', SANDBOX, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let exited = false;
  const pending = new Map();
  const events = [];
  let nextId = 1;
  proc.on('message', (m) => {
    if (m && m.event) { events.push(m); return; }
    const p = m && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(`${name}: ${m.error}`));
  });
  proc.on('exit', (code, signal) => {
    exited = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${name}: the child exited (${code == null ? signal : code})`));
    }
    pending.clear();
  });
  t.after(() => { if (!exited) { try { proc.kill('SIGKILL'); } catch { /* gone */ } } });

  function call(cmd, args = {}, { timeout = CALL_TIMEOUT_MS } = {}) {
    if (exited) return Promise.reject(new Error(`${name}: the child has exited`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name}: '${cmd}' timed out after ${timeout} ms`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      proc.send({ id, cmd, args });
    });
  }

  const child = { name, call, events, proc, surface: null };
  const booted = await call('boot', { port, viewport, routes, transport });
  child.surface = booted.surface;
  return child;
}

// Two viewers, as F9 C-9 had them: a desktop and a phone, each its own clock.
async function chromePair(t, { port, viewports = [DESKTOP, PHONE], routes = {} } = {}) {
  return Promise.all(viewports.map((viewport, i) => spawnChrome(t, { port, viewport, routes, name: `chrome-${i}` })));
}

module.exports = { spawnChrome, chromePair, DESKTOP, PHONE };
