'use strict';

// The built-in element pack says where it came from (DECISIONS.md K.2-47).
//
// web-chat-builtins is installed at every boot from this build's own tree
// (lib/server/builtins seedElementTypes, its record's source {via: 'builtin'}),
// so it was fetched from nowhere: `pack list` and the drawer's Manage card say
// "built in with web-chat" instead of falling through to the tarball line
// ("tarball @ <sha7>"), and the drawer offers no Remove for it (the daemon
// refuses one with code 'builtin-pack').

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { BUILTIN_ELEMENT_PACK } = require('../lib/core/names');
const { findPack } = require('../lib/packs/store');
const { withServer } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');

function runCli(args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env: { ...process.env, WEB_CHAT_NO_GH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack list` on a booted project names the built-in pack "built in with web-chat", never a tarball', async (t) => {
  const { root } = await withServer(t);
  const found = findPack(root, BUILTIN_ELEMENT_PACK, 'local');
  assert.ok(found, 'the boot installed the built-in pack');
  assert.equal(found.pack.source && found.pack.source.via, 'builtin', 'its record says it was built in');

  const list = await runCli(['pack', 'list'], { cwd: root });
  assert.equal(list.status, 0, list.stderr);
  const lines = list.stdout.split('\n');
  const at = lines.findIndex((l) => l.includes(BUILTIN_ELEMENT_PACK));
  assert.ok(at >= 0, `pack list names ${BUILTIN_ELEMENT_PACK}:\n${list.stdout}`);
  // The pack's own block: its line and the indented lines under it.
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) block.push(lines[i]);
  const text = block.join('\n');
  assert.match(text, /built in with web-chat/, text);
  assert.doesNotMatch(text, /tarball/, text);
});

test('the drawer\'s Manage card reads the same provenance and offers no Remove for the built-in pack', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'app', 'drawer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function provenance(source)'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /source\.via === 'builtin'\) return 'built in with web-chat'/,
    'provenance() answers the built-in line before the tarball fallback');
  assert.ok(body.indexOf("'builtin'") < body.indexOf('tarball @'), 'the built-in branch comes first');
  assert.match(src, /if \(!\(p\.source && p\.source\.via === 'builtin'\)\) \{\s*const rm = el\('button', 'btn', 'Remove'\)/,
    'the card draws Remove only for a pack that is not built in');
});
