#!/usr/bin/env node
// A stand-in for a Chrome launched with --remote-debugging-pipe, for
// test/replay-render.test.js.
//
// lib/replay/chrome.js spawns a real browser and speaks the DevTools protocol
// to it over fds 3 (commands in) and 4 (replies out), NUL-delimited JSON. The
// only honest test of that plumbing without a browser on the CI machine is a
// real process on the other end of real pipes — this one. It answers the
// handful of commands the capture uses, and on Page.navigate it really GETs the
// URL it was sent (recording the status and CSP), so a test proves the daemon
// pointed it at a /replay document that loads.
//
// Environment:
//   FAKE_CHROME_LOG   append-only JSONL: {argv} once, then {method, params} per command
//   FAKE_CHROME_MODE  'ok' (default) | 'die' (exit on the first screenshot)
//                     | 'hang' (never answer a screenshot) | 'slow' (each
//                     screenshot waits FAKE_CHROME_SLOW_MS, default 400)
//                     | 'wrong-size' (screenshots 1 px narrower than asked)
//                     | 'ignore-close' (never exit on Browser.close)
//   FAKE_CHROME_STUBBORN '1' — a WEDGED browser, on top of any mode: ignores
//                     SIGTERM, Browser.close and its pipe closing, and starts a
//                     helper process (same process group, also deaf to SIGTERM)
//                     the way Chrome starts renderers. Only SIGKILL ends either.
//                     Logs {helper: pid} and {signal: 'SIGTERM'} on receipt.
//   FAKE_CHROME_HELPER '1' — only the deaf helper: the browser itself behaves,
//                     exits on Browser.close, and leaves the helper behind.

const fs = require('fs');
const net = require('net');
const { encodePng, solid } = require('./png-encode');

const LOG = process.env.FAKE_CHROME_LOG;
const MODE = process.env.FAKE_CHROME_MODE || 'ok';
const STUBBORN = process.env.FAKE_CHROME_STUBBORN === '1';
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };
log({ argv: process.argv.slice(2), pid: process.pid });

if (STUBBORN || process.env.FAKE_CHROME_HELPER === '1') {
  const helper = require('child_process').spawn(process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], { stdio: 'ignore' });
  helper.unref();
  log({ helper: helper.pid });
}
if (STUBBORN) {
  process.on('SIGTERM', () => log({ signal: 'SIGTERM' }));
  setInterval(() => {}, 1 << 30);
}
const exitsOnClose = MODE !== 'ignore-close' && !STUBBORN;

// net.Socket, not fs streams: an fs.ReadStream on a pipe parks a threadpool
// thread in a blocking read(), and process.exit then waits on it forever.
const out = new net.Socket({ fd: 4, readable: false, writable: true });
const inp = new net.Socket({ fd: 3, readable: true, writable: false });

let width = 800;
let height = 600;
let lastT = 0;
let session = 'S1';

function send(obj) { out.write(JSON.stringify(obj) + '\0'); }
function reply(msg, result) { send({ id: msg.id, result: result || {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }); }

async function handle(msg) {
  log({ method: msg.method, params: msg.params, sessionId: msg.sessionId || null });
  switch (msg.method) {
    case 'Target.createTarget': return reply(msg, { targetId: 'T1' });
    case 'Target.attachToTarget': return reply(msg, { sessionId: session });
    case 'Emulation.setDeviceMetricsOverride':
      width = msg.params.width; height = msg.params.height;
      return reply(msg);
    case 'Page.enable': return reply(msg);
    case 'Page.navigate': {
      let status = 0; let csp = null;
      try {
        const r = await fetch(msg.params.url);
        status = r.status; csp = r.headers.get('content-security-policy');
        await r.text();
      } catch (e) { status = -1; }
      log({ fetched: msg.params.url, status, csp });
      reply(msg, { frameId: 'F1', loaderId: 'L1' });
      send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: msg.sessionId });
      return undefined;
    }
    case 'Runtime.evaluate': {
      const ex = String(msg.params.expression || '');
      if (/ready\(\)/.test(ex)) return reply(msg, { result: { type: 'object', value: { duration: 0, steps: 0 } } });
      const m = /seek\(([-\d.e]+)\)/.exec(ex);
      if (m) { lastT = Number(m[1]); return reply(msg, { result: { type: 'boolean', value: true } }); }
      return reply(msg, { result: { type: 'undefined' } });
    }
    case 'Page.captureScreenshot': {
      if (MODE === 'die') process.exit(3);
      if (MODE === 'hang') return undefined;
      if (MODE === 'slow') await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CHROME_SLOW_MS || 400)));
      const w = MODE === 'wrong-size' ? width - 1 : width;
      // One colour per seek time, so distinct times make distinct frames and a
      // repeated time makes an identical one.
      const shade = Math.floor(lastT / 10) % 256;
      const png = encodePng(solid(w, height, [shade, 255 - shade, 90], [4, 4, 10, 10, [0, 0, 0]]), w, height, { alpha: false });
      return reply(msg, { data: png.toString('base64') });
    }
    case 'Browser.close':
      reply(msg);
      if (!exitsOnClose) return undefined;
      setTimeout(() => process.exit(0), 20);
      return undefined;
    default:
      return send({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` } });
  }
}

let buf = Buffer.alloc(0);
inp.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let nul;
  while ((nul = buf.indexOf(0)) >= 0) {
    const raw = buf.subarray(0, nul).toString('utf8');
    buf = buf.subarray(nul + 1);
    handle(JSON.parse(raw));
  }
});
inp.on('end', () => { if (exitsOnClose) process.exit(0); });
