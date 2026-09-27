// The remote-access setup PAGE (lib/server/tunnel-setup/public), driven as
// real DOM in jsdom with its one script loaded the way the browser loads it.
// The daemon side (the gate, the run) is test/tunnel-setup-page.test.js; this
// pins what the page does with it:
//   * every call carries this load's nonce (X-WC-Setup) and JSON, and goes to
//     the page's own origin;
//   * the checklist ticks itself from the status route — setup done, portal,
//     connector, sign-in, picker — and an already-set-up machine shows the
//     summary, the picker link and the re-run hint;
//   * the permissions listed are the ones the daemon sent (cf-api PERMS);
//   * Apply is offered only for the exact input a shown plan was made from,
//     streams the run's lines, and clears the token field when it succeeds;
//   * a token that sees several accounts gets a picker;
//   * an expired page says so, and stops polling;
//   * the terminal path's commands copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = path.resolve(__dirname, '..', 'lib/server/tunnel-setup/public');
const NONCE = 'nonce-for-this-load';

const NOT_SET_UP = {
  ok: true, busy: false,
  status: { configured: false, error: 'no tunnel.json', hostname: null, picker: null, signin: null, tunnel: null,
    portal: { running: false, invalid: false, restart: [], config_current: true, token_current: true }, cloudflared: null, jwks_error: null, sessions: 0 },
  defaults: { hostname: '', emails: [] },
  perms: ['Account › Cloudflare Tunnel › Edit', 'Zone › DNS › Edit'],
  links: { token: 'https://dash.cloudflare.com/profile/api-tokens', zeroTrust: 'https://one.dash.cloudflare.com' },
};
const SET_UP = {
  ...NOT_SET_UP,
  status: {
    ...NOT_SET_UP.status, configured: true, error: null, hostname: 'wc.example.test', picker: 'https://wc.example.test/', signin: 'pin+biometric',
    tunnel: { kind: 'token', name: 'web-chat' },
    portal: { running: true, invalid: false, restart: [], config_current: true, token_current: false },
    cloudflared: { state: 'running', ready: true, connections: 4, error: null },
  },
  defaults: { hostname: 'wc.example.test', emails: ['me@example.test'] },
};

// A fetch Response stand-in: JSON, or NDJSON read whole (the page falls back
// to text() where there is no streaming body).
const res = (status, body, { ndjson = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (ndjson ? 'application/x-ndjson' : 'application/json') : null) },
  json: async () => body,
  text: async () => (ndjson ? body.map((o) => JSON.stringify(o)).join('\n') + '\n' : JSON.stringify(body)),
  body: null,
});

function boot({ routes }) {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace('{{CSRF}}', NONCE)
    .replace(/<script src="[^"]+" defer><\/script>/, '');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:61234/setup/tunnel', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opts = {}) => {
    const name = String(url).replace('/setup/tunnel/', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), name, method: opts.method, headers: opts.headers || {}, body });
    const r = routes[name];
    return typeof r === 'function' ? r(body) : r;
  };
  w.setTimeout = (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)); // no status poller left running
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  w.eval(fs.readFileSync(path.join(PUB, 'setup.js'), 'utf8'));
  return { w, $: (id) => w.document.getElementById(id), calls, copied, close: () => w.close() };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const type = (p, id, v) => { const el = p.$(id); el.value = v; el.dispatchEvent(new p.w.Event('input', { bubbles: true })); };

test('the checklist starts unticked, the permissions are the daemon\'s, and every call carries the nonce as JSON', async (t) => {
  const p = boot({ routes: { status: res(200, NOT_SET_UP) } });
  t.after(p.close);
  await tick();
  for (const id of ['ck-config', 'ck-portal', 'ck-connector', 'ck-signin', 'ck-picker']) {
    assert.ok(p.$(id).classList.contains('todo'), `${id} is not ticked`);
  }
  assert.deepEqual([...p.$('perms').querySelectorAll('li')].map((l) => l.textContent), NOT_SET_UP.perms);
  assert.equal(p.$('lnk-token').href, NOT_SET_UP.links.token);
  assert.equal(p.$('st-rerun').hidden, true, 'no re-run hint before a setup');
  const c = p.calls[0];
  assert.equal(c.url, '/setup/tunnel/status', 'same-origin, relative');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['X-WC-Setup'], NONCE);
  assert.equal(c.headers['Content-Type'], 'application/json');
});

test('an already-set-up machine: ticks, the picker link, the re-run hint, and a restart warning', async (t) => {
  const p = boot({ routes: { status: res(200, SET_UP) } });
  t.after(p.close);
  await tick();
  for (const id of ['ck-config', 'ck-portal', 'ck-connector', 'ck-signin', 'ck-picker']) {
    assert.ok(p.$(id).classList.contains('done'), `${id} ticked`);
  }
  assert.match(p.$('ck-connector').textContent, /ready \(4 connections\)/);
  assert.match(p.$('ck-signin').textContent, /emailed PIN \+ biometrics/);
  assert.equal(p.$('lnk-picker').getAttribute('href'), 'https://wc.example.test/');
  assert.equal(p.$('st-rerun').hidden, false);
  assert.equal(p.$('st-warn').hidden, false);
  assert.match(p.$('st-warn').textContent, /connector token changed/);
  assert.equal(p.$('f-host').value, 'wc.example.test', 'the form starts from what tunnel.json holds');
  assert.equal(p.$('f-email').value, 'me@example.test');
  assert.equal(p.$('f-token').value, '', 'never the token');
});

test('Apply is offered only for the exact input a plan was shown for; it streams, then clears the token', async (t) => {
  const planned = [];
  const p = boot({
    routes: {
      status: res(200, NOT_SET_UP),
      plan: (b) => { planned.push(b); return res(200, { ok: true, lines: ['The plan (nothing is changed with --dry-run):', '  create   tunnel "web-chat"'], plan: { steps: [], conflicts: [] } }); },
      apply: res(200, [{ line: 'Applying:' }, { line: '  ✓ the API token was not saved' }, { done: true, ok: true, signin: 'pin', why: 'no MFA on this plan', picker: 'https://wc.example.test/' }], { ndjson: true }),
    },
  });
  t.after(p.close);
  await tick();
  assert.equal(p.$('btn-apply').disabled, true, 'nothing to apply before a plan');
  type(p, 'f-token', 'tok-SECRET-123456');
  type(p, 'f-host', 'wc.example.test');
  type(p, 'f-email', 'me@example.test');
  await p.w.__wcTunnelSetup.plan();
  assert.deepEqual(planned[0], { token: 'tok-SECRET-123456', hostname: 'wc.example.test', email: 'me@example.test', signin: 'pin+biometric', account: null });
  assert.match(p.$('out-setup').textContent, /The plan/);
  assert.equal(p.$('btn-apply').disabled, false, 'offered for the planned input');

  type(p, 'f-host', 'other.example.test');
  assert.equal(p.$('btn-apply').disabled, true, 'an edit after the plan takes Apply away');
  type(p, 'f-host', 'wc.example.test');
  assert.equal(p.$('btn-apply').disabled, false);

  await p.w.__wcTunnelSetup.apply();
  const call = p.calls.find((c) => c.name === 'apply');
  assert.equal(call.body.token, 'tok-SECRET-123456', 'the token goes in the body of the call that uses it');
  assert.equal(call.headers['X-WC-Setup'], NONCE);
  assert.match(p.$('out-setup').textContent, /Applying:\n {2}✓ the API token was not saved/);
  assert.equal(p.$('f-token').value, '', 'the token field is cleared once it has been used');
  assert.match(p.$('form-msg').textContent, /Sign-in: emailed PIN — no MFA on this plan/);
  assert.equal(p.$('lnk-picker').getAttribute('href'), 'https://wc.example.test/');
  assert.equal(p.$('btn-apply').disabled, true, 'nothing left to apply');
  assert.ok(!p.w.location.href.includes('tok-SECRET'), 'never in the URL');
});

test('a token that sees several accounts gets a picker, and the choice rides the next plan', async (t) => {
  const planned = [];
  const p = boot({
    routes: {
      status: res(200, NOT_SET_UP),
      plan: (b) => {
        planned.push(b);
        return b.account
          ? res(200, { ok: true, lines: ['The plan'], plan: { steps: [], conflicts: [] } })
          : res(200, { ok: false, error: 'the token sees 2 accounts', lines: [], accounts: [{ id: 'a1', name: 'One' }, { id: 'a2', name: '<b>Two</b>' }] });
      },
    },
  });
  t.after(p.close);
  await tick();
  type(p, 'f-token', 'tok-123456789'); type(p, 'f-host', 'wc.example.test'); type(p, 'f-email', 'me@example.test');
  await p.w.__wcTunnelSetup.plan();
  assert.equal(p.$('acct-row').hidden, false);
  const opts = [...p.$('f-account').options];
  assert.deepEqual(opts.map((o) => o.value), ['a1', 'a2']);
  assert.equal(opts[1].textContent, '<b>Two</b> (a2)', 'an account name is text, never markup');
  p.$('f-account').value = 'a2';
  await p.w.__wcTunnelSetup.plan();
  assert.equal(planned[1].account, 'a2');
});

test('Bring it up streams the up lines, and says why when it fails', async (t) => {
  const p = boot({
    routes: {
      status: res(200, SET_UP),
      up: res(200, [{ line: '✓ portal up — pid 9 on 127.0.0.1:5171' }, { done: true, ok: false, error: 'cloudflared not found' }], { ndjson: true }),
    },
  });
  t.after(p.close);
  await tick();
  await p.w.__wcTunnelSetup.up();
  assert.match(p.$('out-up').textContent, /✓ portal up[\s\S]*✗ cloudflared not found/);
});

test('an expired page says so and stops asking', async (t) => {
  const p = boot({ routes: { status: res(403, { ok: false, error: 'this setup page has expired — reopen it from ⌘K' }) } });
  t.after(p.close);
  await tick();
  assert.equal(p.$('expired').hidden, false);
  const n = p.calls.length;
  await p.w.__wcTunnelSetup.poll();
  assert.equal(p.calls.length, n, 'no more status calls');
});

test('the terminal path\'s commands copy', async (t) => {
  const p = boot({ routes: { status: res(200, NOT_SET_UP) } });
  t.after(p.close);
  await tick();
  const btns = [...p.w.document.querySelectorAll('button.copy')];
  assert.deepEqual(btns.map((b) => b.getAttribute('data-copy')), [
    'claude-web-chat tunnel setup --dry-run', 'claude-web-chat tunnel setup', 'claude-web-chat tunnel up', 'claude-web-chat tunnel status',
  ]);
  btns[0].dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.deepEqual(p.copied, ['claude-web-chat tunnel setup --dry-run']);
});
