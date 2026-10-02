// The forked service runner (lib/server/service-runner.js) runs ONLY the
// service.js bytes the approval was keyed on.
//
// The supervisor keys an approval on the sha256 of the bytes it read at
// reconcile; the child starts tens of milliseconds later. The runner used to
// `require(servicePath)` — a second read — so bytes written in between (POST
// /api/components rewrites a non-builtin's service.js for any caller) ran under
// the approved key. It now reads once, checks that read against the approved
// sha256 the start message carries, and runs exactly the bytes it hashed
// (lib/server/service-loader.js).
//
// And it runs them as require() did: a service.js written as an ES module, or
// one that calls import(), ran under 0.8.0. The first cut of the one-read
// loader compiled a bare CommonJS wrapper, and both failed to start.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'lib', 'server', 'service-runner.js');
const { loadApproved } = require('../lib/server/service-loader');
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
  // __dirname is the REAL path, as require() gave it (on macOS the temp dir is
  // /var/…, really /private/var/…).
  assert.equal(fs.readFileSync(ran, 'utf8'), `helped ${fs.realpathSync(d)} true started:m1`,
    'it loads as CommonJS: a relative require, __dirname, exports, and a #! line all work');
});

test('it runs what require() ran: an ES module, import(), and CommonJS under a "type": "module" package', async (t) => {
  const d = dir(t);
  const ran = (name) => path.join(d, `${name}.txt`);
  const said = (name) => fs.readFileSync(ran(name), 'utf8');
  const write = (rel, src) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), src);
    return { file: path.join(d, rel), hash: sha256(src) };
  };

  // An ES module: static imports resolve next to the file, import.meta is the
  // file's, and start() can import() again.
  write('esm/helper.mjs', "export const helper = () => 'helped';\n");
  const esm = write('esm/service.js', `import fs from 'node:fs';
import { helper } from './helper.mjs';
fs.writeFileSync(${JSON.stringify(ran('esm'))}, helper() + ' ' + import.meta.url.endsWith('/esm/service.js'));
export async function start(ctx) {
  const { join } = await import('node:path');
  fs.appendFileSync(${JSON.stringify(ran('esm'))}, ' started:' + ctx.mountId + ' ' + typeof join);
}
export async function stop() {}
`);
  const esmRun = await run({ servicePath: esm.file, sourceHash: esm.hash, root: d });
  assert.equal(esmRun.started, true, esmRun.stderr);
  assert.equal(esmRun.code, 0);
  assert.equal(said('esm'), 'helped true started:m1 function', 'an ES module service.js loads and starts');

  // CommonJS that calls import() — a builtin, and a relative module that has
  // to resolve next to service.js, not next to the runner.
  write('dyn/helper.mjs', "export const helper = () => 'imported';\n");
  const dyn = write('dyn/service.js', `module.exports = {
  async start(ctx) {
    const { helper } = await import('./helper.mjs');
    const { join } = await import('node:path');
    require('fs').writeFileSync(${JSON.stringify(ran('dyn'))}, helper() + ' ' + typeof join + ' started:' + ctx.mountId);
  },
  async stop() {},
};
`);
  const dynRun = await run({ servicePath: dyn.file, sourceHash: dyn.hash, root: d });
  assert.equal(dynRun.started, true, dynRun.stderr);
  assert.equal(said('dyn'), 'imported function started:m1', 'import() works from a CommonJS service.js');

  // CommonJS under a package.json that says "type": "module" — a JS project's
  // own, above its .web-chat/components/. require() took the package's word
  // and loaded every service there (the builtins included) as an ES module,
  // where `module` is not defined; the format now comes from the syntax.
  write('tm/package.json', '{ "type": "module" }\n');
  const tm = write('tm/.web-chat/components/x/service.js', `module.exports = {
  async start(ctx) { require('fs').writeFileSync(${JSON.stringify(ran('tm'))}, 'commonjs ' + typeof module + ' started:' + ctx.mountId); },
  async stop() {},
};
`);
  const tmRun = await run({ servicePath: tm.file, sourceHash: tm.hash, root: path.join(d, 'tm') });
  assert.equal(tmRun.started, true, tmRun.stderr);
  assert.equal(said('tm'), 'commonjs object started:m1');

  // The approval gate is the same for an ES module: other bytes run nothing.
  fs.rmSync(ran('esm'));
  const other = await run({ servicePath: esm.file, sourceHash: sha256('other'), root: d });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /not the code that was approved/);
  assert.equal(fs.existsSync(ran('esm')), false, 'and not one line of the module ran');
});

// The race itself, in-process: a write lands on service.js the instant the
// read the hash is taken of returns. Anything that reads the file a second time
// — require(), or an ES module loader re-reading its source from disk — runs
// the swapped bytes under the approval of the first ones.
test('the loader compiles the bytes it hashed, never a second read of the file', (t) => {
  for (const [label, approved, swapped] of [
    ['CommonJS', "module.exports = { which: 'approved' };\n", "module.exports = { which: 'swapped' };\n"],
    ['an ES module', "export const which = 'approved';\n", "export const which = 'swapped';\n"],
  ]) {
    const d = dir(t);
    const file = path.join(d, 'service.js');
    fs.writeFileSync(file, approved);
    let reads = 0;
    const readFile = (f) => {
      reads += 1;
      const bytes = fs.readFileSync(f);
      fs.writeFileSync(f, swapped);
      return bytes;
    };
    const mod = loadApproved(file, sha256(approved), { readFile });
    assert.equal(mod.which, 'approved', `${label}: the bytes that were hashed are the bytes that ran`);
    assert.equal(reads, 1, `${label}: one read`);
    assert.equal(fs.readFileSync(file, 'utf8'), swapped, `${label}: whatever the file says now`);
  }

  // A service.js that does not compile throws, and leaves nothing cached under
  // its path for a later require() to be handed half-built.
  const d = dir(t);
  const broken = path.join(d, 'service.js');
  fs.writeFileSync(broken, 'module.exports = {\n');
  assert.throws(() => loadApproved(broken, sha256('module.exports = {\n')), SyntaxError);
  assert.equal(require.cache[fs.realpathSync(broken)], undefined);
});

// A component directory reached through a symlink (one developed in place and
// linked into .web-chat/components/) resolves its dependencies from where it
// really lives, as it did under require(): the module is named by its real
// path, so the node_modules walk starts there.
test('a service.js in a linked component directory resolves its packages from where it really lives', (t) => {
  const d = dir(t);
  const real = path.join(d, 'checkout', 'pkg', 'svc');
  fs.mkdirSync(path.join(d, 'checkout', 'node_modules', 'hoisted-dep'), { recursive: true });
  fs.writeFileSync(path.join(d, 'checkout', 'node_modules', 'hoisted-dep', 'index.js'), "module.exports = 'hoisted';\n");
  fs.mkdirSync(real, { recursive: true });
  const src = "module.exports = { dep: require('hoisted-dep'), dir: __dirname };\n";
  fs.writeFileSync(path.join(real, 'service.js'), src);
  const components = path.join(d, 'project', '.web-chat', 'components');
  fs.mkdirSync(components, { recursive: true });
  fs.symlinkSync(real, path.join(components, 'svc'));
  const mod = loadApproved(path.join(components, 'svc', 'service.js'), sha256(src));
  assert.equal(mod.dep, 'hoisted', 'a package hoisted above the real directory is found');
  assert.equal(mod.dir, fs.realpathSync(real));
});
