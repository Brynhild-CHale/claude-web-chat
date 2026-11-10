// The soak's band refuses the portal's and cloudflared's metrics ports
// (annotation engine tranche 6, 6C.4, unit U764 — corrective to U641's band).
//
// scripts/soak/lib.js refused a band whose daemon or hub port is in 5173–5272
// (lib/util/registry SCAN_PORTS) or on the hub's 5170 (lib/util/hub
// DEFAULT_HUB_PORT); a base of 5171 put the soak's daemon on the portal's
// fixed loopback port and was accepted. Pinned here, with nothing bound or
// dialled:
//   * forbiddenPort answers true for lib/tunnel/config's DEFAULT_PORTAL_PORT
//     (5171) and DEFAULT_METRICS_PORT (5172), beside DEFAULT_HUB_PORT (5170);
//   * bandOf refuses a base that puts the daemon or the hub on any of the
//     three (a SoakRefusal, code SOAK_REFUSED, a hint naming a base outside
//     the band, a message naming the portal), and still answers 6400;
//   * the CLI's prepare at --port-base 5171 exits 2 with "hint: " on stderr
//     and writes nothing under the root;
//   * lib.js names those ports by their constants, never as literals.
// test/soak-harness.test.js keeps the band's earlier refusals as they were.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { DEFAULT_HUB_PORT } = require('../lib/util/hub');
const { DEFAULT_PORTAL_PORT, DEFAULT_METRICS_PORT } = require('../lib/tunnel/config');

const SOAK = path.join(__dirname, '..', 'scripts', 'soak');
const lib = require('../scripts/soak/lib');

const tmp = (prefix) => fs.mkdtempSync(path.join(SANDBOX, prefix));

const refused = (base) => (e) => {
  assert.ok(e instanceof lib.SoakRefusal, `port base ${base}: a SoakRefusal`);
  assert.equal(e.code, 'SOAK_REFUSED');
  assert.equal(typeof e.hint, 'string');
  assert.match(e.hint, /port base outside it/);
  assert.match(e.hint, new RegExp(`--port-base ${lib.SOAK_PORT_BASE_DEFAULT}`));
  return true;
};

test('the constants are the ports the brief names', () => {
  assert.equal(DEFAULT_HUB_PORT, 5170);
  assert.equal(DEFAULT_PORTAL_PORT, 5171);
  assert.equal(DEFAULT_METRICS_PORT, 5172);
});

test('forbiddenPort refuses the hub\'s, the portal\'s and cloudflared\'s metrics ports', () => {
  assert.equal(lib.forbiddenPort(5171), true);
  assert.equal(lib.forbiddenPort(DEFAULT_PORTAL_PORT), true);
  assert.equal(lib.forbiddenPort(5172), true);
  assert.equal(lib.forbiddenPort(DEFAULT_METRICS_PORT), true);
  assert.equal(lib.forbiddenPort(DEFAULT_HUB_PORT), true);
  for (const p of [5169, 6400, 6401]) assert.equal(lib.forbiddenPort(p), false, `${p} is not forbidden`);
});

test('bandOf refuses a base that puts the daemon or the hub on 5170, 5171 or 5172', () => {
  // 5169: hub on 5170; 5170: daemon on 5170, hub on the portal; 5171: daemon
  // on the portal, hub on the metrics port; 5172: daemon on the metrics port.
  for (const base of [DEFAULT_HUB_PORT - 1, DEFAULT_HUB_PORT, DEFAULT_PORTAL_PORT, DEFAULT_METRICS_PORT, 5171, '5171']) {
    assert.throws(() => lib.bandOf(base), refused(base), `port base ${base} is refused`);
  }
  assert.deepEqual(lib.bandOf(6400), { port: 6400, hubPort: 6401 });
  assert.deepEqual(lib.bandOf(lib.SOAK_PORT_BASE_DEFAULT), { port: 6400, hubPort: 6401 }, 'the default is unchanged');
});

test('the refusal message names the portal, the hub and the metrics port', () => {
  let err;
  try { lib.bandOf(DEFAULT_PORTAL_PORT); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  assert.match(err.message, /daemon port 5171/);
  assert.match(err.message, /the portal's 5171/);
  assert.match(err.message, /the hub's 5170/);
  assert.match(err.message, /metrics 5172/);
  assert.match(err.message, /5173–5272/);
  let hubErr;
  try { lib.bandOf(DEFAULT_HUB_PORT); } catch (e) { hubErr = e; }
  assert.match(hubErr.message, /daemon port 5170/, 'a base of 5170 is still refused for its daemon first');
});

test('the CLI\'s prepare at --port-base 5171 or 5172 exits 2 with a hint and writes nothing', () => {
  const root = tmp('wc-soak-ports-');
  for (const base of ['5171', '5172']) {
    const r = spawnSync(process.execPath, [path.join(SOAK, 'lib.js'), 'prepare', '--root', root, '--out', root, '--port-base', base], { encoding: 'utf8' });
    assert.equal(r.status, 2, `--port-base ${base}: ${r.stderr}`);
    assert.match(r.stderr, /hint: /);
    assert.match(r.stderr, /the portal's 5171/);
  }
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was written under the root');
});

test('lib.js names the portal and metrics ports by their constants, never as literals', () => {
  const src = fs.readFileSync(path.join(SOAK, 'lib.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const literals = code.match(/\b517[0-2]\b/g) || [];
  assert.deepEqual(literals, [], 'no 5170, 5171 or 5172 outside a comment');
  assert.ok(src.includes("require('../../lib/tunnel/config')"), 'the ports come from lib/tunnel/config');
});
