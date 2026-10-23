'use strict';
// One chrome in a process of its own, for test-support/chrome-pair.js (PLAN.md
// §7 obligation 8: two bootShell chromes with live timers, driven through a
// real daemon). A file and a process boot one shell (chrome-shell.js), so a
// second viewer is a second process.
//
// The child boots the REAL chrome (bootShell) and bridges its FakeSocket to a
// real daemon socket: a `ws` client to the parent's withServer port. The
// daemon's frames go to `socket.receive`, the chrome's sends go to the daemon.
// setTimeout and the shell's requestAnimationFrame stay live. It inits
// public/app/overlay-report.js through bootShell's `init` hook (main.js does
// not initialise it yet) and answers the parent's commands over IPC:
//
//   {cmd: 'boot', port, viewport, routes, transport}   → {surface}
//       transport: true registers a report transport that posts every batch
//       to the parent as {event: 'transport', msg} (a remote page's carrier)
//   {cmd: 'mark'}                → {} — a change begins: counts restart here
//   {cmd: 'settle', min}         → {reports, frames}: once a frame arrived since
//       the mark (unless `min` alone is asked) and the report module is quiet,
//       the report frames sent since the mark
//   {cmd: 'last'}                → {surface, answers: {'mount|id@v': {state, how, gen, surface}}}:
//       what this viewer last sent per element, on the current surface
//   {cmd: 'hold'} / {cmd: 'release'}   hold the chrome's outgoing frames on the
//       wire, then let them go (a report crossing a reset on the wire)
//   {cmd: 'reconnect'}           drop the daemon socket; the chrome reconnects
//   {cmd: 'stats'}               → the module's stats()
//   {cmd: 'overlay'}             → {elements, surface, orphans, delivered, conn}: the overlay's
//       live set and its last 20 onAnswers payloads in brief (for a failure's message)
//   {cmd: 'record', mount, selector, index} → an engine anchor record of that
//       element in the pane's shadow root (anchors.record)
//   {cmd: 'exit'}                restore the shell and exit
//
// Replies are {id, ok, result} or {id, ok: false, error}. Deliberately outside
// test/ (node --test would collect it).
const { bootShell } = require('./chrome-shell');
const { wsConnect, waitUntil } = require('./helpers');

let shell = null;
let inst = null;
let anchors = null;
let port = null;
let holding = false;
const held = [];
const wires = new Set();
let framesIn = 0;
let inited = false;
const afterInit = [];
const whenInited = (fn) => { if (inited) fn(); else afterInit.push(fn); };
const delivered = [];   // every onAnswers payload, in brief
let markAt = { reports: 0, frames: 0, t: 0 };

const reportsSent = () => (shell ? shell.sockets.flatMap((s) => s.frames('report')) : []);

function bridge(sock) {
  sock.autoOpen = false;
  const ws = wsConnect(port, '/ws');
  const wire = { ws, sock };
  wires.add(wire);
  // The chrome hears nothing before its init hook has run (as bootShell's own
  // first socket): the daemon's hello must reach overlay-report.js.
  // A frame that arrives before then waits for the open, as on a real socket.
  const early = [];
  ws.on('open', () => {
    whenInited(() => {
      sock.open();
      for (const d of early.splice(0)) sock.receive(d);
    });
  });
  ws.on('message', (d) => {
    framesIn += 1;
    if (sock.readyState === 1) sock.receive(d.toString());
    else early.push(d.toString());
  });
  ws.on('close', () => { wires.delete(wire); sock.drop(); });
  ws.on('error', () => { /* the close follows */ });
  const sendFake = sock.send.bind(sock);
  sock.send = (data) => {
    sendFake(data);
    if (holding) held.push({ ws, data });
    else if (ws.readyState === 1) ws.send(data);
  };
  const closeFake = sock.close.bind(sock);
  sock.close = () => { closeFake(); try { ws.close(); } catch { /* gone */ } };
}

async function boot({ port: p, viewport, routes, transport }) {
  port = p;
  shell = await bootShell({
    routes: routes || {},
    viewport: viewport || {},
    onSocket: bridge,
    init: async (sh) => {
      const rep = await sh.importApp('overlay-report.js');
      if (transport) rep.setReportTransport((msg) => { process.send({ event: 'transport', msg }); });
      inst = rep.initOverlayReport();
      const ov = await sh.importApp('overlay.js');
      ov.onAnswers((m) => {
        delivered.push({ scope: m.scope, mount: m.mount, surface: m.surface, n: m.items.length, states: m.items.map((i) => i.state) });
        if (delivered.length > 200) delivered.shift();
      });
      inited = true;
      for (const fn of afterInit.splice(0)) fn();
    },
  });
  anchors = (await shell.importApp('anchors.js')).default;
  await waitUntil(() => framesIn > 0 && inst.stats().surface != null, { timeout: 15000, what: 'the daemon\'s hello' });
  return { surface: inst.stats().surface };
}

function quietNow() {
  const s = inst.stats();
  return !s.armed && s.holding === 0 && !s.awaiting_hello && Date.now() - s.last_delivery_at >= 150;
}

async function settle({ min = 150, frames = true } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(min);
  try {
    await waitUntil(() => (!frames || framesIn > markAt.frames) && Date.now() - markAt.t >= min && quietNow(),
      { timeout: 15000, interval: 10, what: 'the chrome to go quiet' });
  } catch (e) {
    throw new Error(`${e.message}: frames since the mark ${framesIn - markAt.frames}, stats ${JSON.stringify(inst.stats())}`);
  }
  // One more quiet beat: a pass started by the last frame shows up as a delivery.
  await sleep(120);
  await waitUntil(quietNow, { timeout: 15000, interval: 10, what: 'the chrome to stay quiet' });
  return { reports: reportsSent().slice(markAt.reports), frames: framesIn - markAt.frames };
}

function last() {
  const surface = inst.stats().surface;
  const answers = {};
  for (const f of reportsSent()) {
    if (f.surface !== surface) continue;
    for (const m of f.mounts) {
      for (const it of m.items) answers[`${m.mount}|${it.id}@${it.v}`] = { state: it.state, how: it.how || null, gen: m.gen, surface: f.surface };
    }
  }
  return { surface, answers };
}

function record({ mount, selector, index }) {
  const it = shell.window.__wcMount.itemEl(shell.document, mount);
  const root = it && it.el && it.el.shadowRoot;
  if (!root) throw new Error(`no pane ${mount}`);
  const el = root.querySelectorAll(selector)[index];
  if (!el) throw new Error(`no ${selector}[${index}] in ${mount}`);
  return anchors.record(root, el, { mount });
}

const COMMANDS = {
  boot,
  mark: () => { markAt = { reports: reportsSent().length, frames: framesIn, t: Date.now() }; return {}; },
  settle,
  last,
  hold: () => { holding = true; return {}; },
  release: () => {
    holding = false;
    for (const { ws, data } of held.splice(0)) if (ws.readyState === 1) ws.send(data);
    return {};
  },
  reconnect: () => { for (const w of [...wires]) w.ws.close(); return {}; },
  stats: () => inst.stats(),
  overlay: async () => {
    const ov = await shell.importApp('overlay.js');
    return { elements: ov.elementsOf('live').length, surface: ov.surfaceOf('live'), orphans: ov.orphans().length,
      delivered: delivered.slice(-20), conn: (await shell.importApp('state.js')).view.conn };
  },
  record,
  exit: async () => {
    for (const w of [...wires]) { try { w.ws.terminate(); } catch { /* gone */ } }
    if (shell) await shell.restore();
    setImmediate(() => process.exit(0));
    return {};
  },
};

process.on('message', async (msg) => {
  if (!msg || msg.id == null) return;
  const fn = COMMANDS[msg.cmd];
  try {
    if (!fn) throw new Error(`unknown command ${msg.cmd}`);
    const result = await fn(msg.args || {});
    process.send({ id: msg.id, ok: true, result });
  } catch (e) {
    process.send({ id: msg.id, ok: false, error: String((e && e.stack) || e) });
  }
});
process.on('disconnect', () => { process.exit(0); });
