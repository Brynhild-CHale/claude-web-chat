// The chrome's socket must follow the page's scheme. public/app/ws.js used to
// build `ws://${location.host}/ws` unconditionally, so a surface served over
// https (a TLS proxy or tunnel in front of the daemon) opened a plain ws: socket
// from a secure page — which the browser refuses as mixed content — and sat on
// "reconnecting…" forever.
//
// Boots the REAL front-end module graph under jsdom at an https:// URL (same
// harness style as test/client-boot.test.js — one boot per file, since the ESM
// cache would hand a second import the already-initialised modules) and reads
// the URL the chrome actually handed to `new WebSocket`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

test('a page served over https opens its socket over wss', async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://wc-demo.example.com/', pretendToBeVisual: true });
  const { window } = dom;

  const urls = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; urls.push(url); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: [], active: null });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/packs') return json({ ok: true, packs: [], quarantined: [] });
    if (u === '/api/services/pending') return json({ ok: true, pending: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'navigator', 'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  try {
    await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(urls, ['wss://wc-demo.example.com/ws'],
      'the chrome opened exactly one socket, on the secure scheme and the page\'s own host');

    // …and the plain-http daemon keeps its plain socket (the helper, both ways).
    const { wsUrl } = await import(pathToFileURL(path.join(REPO, 'public/app/ws.js')).href);
    assert.equal(wsUrl({ protocol: 'http:', host: 'localhost:5174' }), 'ws://localhost:5174/ws');
    assert.equal(wsUrl({ protocol: 'https:', host: 'localhost:5174' }), 'wss://localhost:5174/ws');
  } finally {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  }
});
