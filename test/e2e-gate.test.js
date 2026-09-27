// test-support/helpers `e2eGate` — the one switch on the tests that drive a REAL
// headless Chrome or a real ffmpeg. They are opt-in: WEB_CHAT_E2E_CHROME=1 /
// WEB_CHAT_E2E_FFMPEG=1, never "whatever this machine has installed". The gate
// is described with an injected env and finder, so these cases say the same
// thing on a box with every browser as on a bare CI image.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { e2eGate } = require('../test-support/helpers');

// A machine that has everything — the case where the old gate ran real renders.
const everything = { chrome: () => '/x/chrome', ffmpeg: () => '/x/ffmpeg' };
const nothing = { chrome: () => null, ffmpeg: () => null };

test('e2eGate: not opted in → skips however much is installed, naming the env var, and probes nothing', () => {
  const probed = [];
  const spy = { chrome: () => { probed.push('chrome'); return '/x/chrome'; }, ffmpeg: () => { probed.push('ffmpeg'); return '/x/ffmpeg'; } };

  const c = e2eGate(['chrome'], { env: {}, find: spy });
  assert.match(c.skip, /WEB_CHAT_E2E_CHROME=1/);
  assert.equal(c.chrome, undefined);

  const f = e2eGate(['ffmpeg'], { env: {}, find: spy });
  assert.match(f.skip, /WEB_CHAT_E2E_FFMPEG=1/);

  const both = e2eGate(['chrome', 'ffmpeg'], { env: { WEB_CHAT_E2E_CHROME: '1' }, find: spy });
  assert.match(both.skip, /WEB_CHAT_E2E_FFMPEG=1/, 'half opted in is not opted in');
  assert.doesNotMatch(both.skip, /WEB_CHAT_E2E_CHROME/, 'and it names only the var still missing');

  assert.deepEqual(probed, [], 'nothing on the machine is looked at until the test is opted in');
});

test('e2eGate: only exactly "1" opts in', () => {
  for (const v of ['0', 'true', 'yes', '', ' 1']) {
    assert.ok(e2eGate(['chrome'], { env: { WEB_CHAT_E2E_CHROME: v }, find: everything }).skip, `WEB_CHAT_E2E_CHROME=${JSON.stringify(v)} does not opt in`);
  }
});

test('e2eGate: opted in → runs with the found binaries', () => {
  const g = e2eGate(['chrome', 'ffmpeg'], { env: { WEB_CHAT_E2E_CHROME: '1', WEB_CHAT_E2E_FFMPEG: '1' }, find: everything });
  assert.deepEqual(g, { skip: false, chrome: '/x/chrome', ffmpeg: '/x/ffmpeg' });
});

test('e2eGate: opted in with nothing found → still skips, naming the override that points at one', () => {
  const c = e2eGate(['chrome'], { env: { WEB_CHAT_E2E_CHROME: '1' }, find: nothing });
  assert.match(c.skip, /WEB_CHAT_E2E_CHROME=1, but no Chrome-family browser found .*WEB_CHAT_CHROME/);
  const f = e2eGate(['ffmpeg'], { env: { WEB_CHAT_E2E_FFMPEG: '1' }, find: nothing });
  assert.match(f.skip, /WEB_CHAT_E2E_FFMPEG=1, but no ffmpeg found .*WEB_CHAT_FFMPEG/);
});

// CI's contract is the fakes: a workflow that opted in would make CI's result
// depend on what the runner image ships, which is exactly what the gate exists
// to stop.
test('no CI workflow opts into the real-program tests', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'the workflows directory was read');
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /WEB_CHAT_E2E_/, `${f} sets a WEB_CHAT_E2E_ var`);
  }
});
