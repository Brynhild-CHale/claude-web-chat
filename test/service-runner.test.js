// The forked service runner (lib/server/service-runner.js) runs ONLY the
// service.js bytes the approval was keyed on.
//
// The supervisor keys an approval on the sha256 of the bytes it read at
// reconcile; the child starts tens of milliseconds later. The runner used to
// `require(servicePath)` — a second read — so bytes written in between (POST
// /api/components rewrites a non-builtin's service.js for any caller) ran under
// the approved key. It now reads once, checks that read against the approved
// sha256 the start message carries, and runs exactly the bytes it hashed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'lib', 'server', 'service-runner.js');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-runner-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
}

// Fork the runner, send it a start message, and report how it ended: whether
// it said `started`, and its exit code. A started child is stopped again.
function run(msg) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    let started = false;
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('message', (m) => {
      if (m && m.type === 'started') { started = true; child.send({ type: 'stop' }); }
    });
    child.on('exit', (code) => resolve({ code, started, stderr }));
    child.send({ type: 'start', mountId: 'm1', name: 'svc', owner: 'service:svc', params: {}, port: 1, ...msg });
  });
}

test('the runner runs service.js only when its bytes are the approved ones', async (t) => {
  const d = dir(t);
  const file = path.join(d, 'service.js');
  const ran = path.join(d, 'ran.txt');
  fs.writeFileSync(path.join(d, 'helper.js'), "module.exports = () => 'helped';\n");
  // Top-level code runs at load, so `ran.txt` says whether ANY of it ran.
  const src = `#!/usr/bin/env node
const helper = require('./helper.js');
require('fs').writeFileSync(${JSON.stringify(ran)}, helper() + ' ' + __dirname + ' ' + (module.exports === exports));
module.exports = { async start(ctx) { require('fs').appendFileSync(${JSON.stringify(ran)}, ' started:' + ctx.mountId); }, async stop() {} };
`;
  fs.writeFileSync(file, src);

  const other = await run({ servicePath: file, sourceHash: sha256('some other code'), root: d });
  assert.equal(other.code, 1, 'bytes that are not the approved ones are refused');
  assert.equal(other.started, false);
  assert.match(other.stderr, /not the code that was approved/);
  assert.equal(fs.existsSync(ran), false, 'and not one line of them ran');

  const none = await run({ servicePath: file, root: d });
  assert.equal(none.code, 1, 'a start with no approved hash runs nothing');
  assert.equal(fs.existsSync(ran), false);

  const ok = await run({ servicePath: file, sourceHash: sha256(src), root: d });
  assert.equal(ok.started, true, ok.stderr);
  assert.equal(ok.code, 0);
  assert.equal(fs.readFileSync(ran, 'utf8'), `helped ${d} true started:m1`,
    'it loads as CommonJS: a relative require, __dirname, exports, and a #! line all work');
});
