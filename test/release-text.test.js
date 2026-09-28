// The 0.8.0 text items — doc claims that went stale because nothing tied them to
// the code they describe (F-15, H-6, H-8, H-9). Each check reads its truth from
// the tree, never from a list written here: a new path, a new browser-gated
// route or a new doc quoting the Channels launch line is caught by the check,
// not by someone remembering this file.
//
// It sits beside test/doc-truth.test.js rather than inside it only so the two
// can change in parallel; the same rule applies — a claim a machine can check
// is checked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { docFiles } = require('../test-support/doc-truth');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const flatten = (s) => s.replace(/\s+/g, ' ');

// The bullets of install.md's "What it writes to your machine" section.
function inventoryBullets() {
  const body = read('docs/install.md');
  const start = body.indexOf('## What it writes to your machine');
  assert.ok(start >= 0, 'docs/install.md lost its "What it writes to your machine" section');
  const end = body.indexOf('\n## ', start + 1);
  return body.slice(start, end < 0 ? undefined : end).split('\n').filter((l) => l.startsWith('- '));
}

// Every name directly under `dir` that a paths() object resolves to — the
// first path segment below it, so `packs/quarantine` counts as `packs`.
function topLevelNames(obj, dir) {
  const names = new Set();
  for (const v of Object.values(obj)) {
    if (typeof v !== 'string' || !v.startsWith(dir + path.sep)) continue;
    names.add(path.relative(dir, v).split(path.sep)[0]);
  }
  return [...names].sort();
}

// A name counts as named when it stands on its own between backticks or path
// separators: `hub.log`, `~/.web-chat/instances.json`, `services/trusted.json`.
function names(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\`|/)${esc}(?:\`|/)`).test(text);
}

test('install.md\'s inventory names everything web-chat writes under <project>/.web-chat/', () => {
  const { projectPaths } = require('../lib/core/paths');
  const p = projectPaths('/proj');
  const expected = topLevelNames(p, p.dir);
  assert.ok(expected.length >= 15, `expected the whole project tier, found ${expected.join(', ')}`);
  const bullet = inventoryBullets().find((l) => l.startsWith('- `<project>/.web-chat/`'));
  assert.ok(bullet, 'the inventory lost its <project>/.web-chat/ bullet');
  const missing = expected.filter((n) => !names(bullet, n));
  assert.deepEqual(missing, [], `docs/install.md's <project>/.web-chat/ bullet does not name: ${missing.join(', ')}`);
});

test('install.md\'s inventory names everything web-chat writes under ~/.web-chat/', () => {
  const { userPaths, installPaths } = require('../lib/core/paths');
  const u = userPaths();
  const expected = [...new Set([
    ...topLevelNames(u, u.root),
    ...topLevelNames(installPaths(), u.root),
  ])].sort();
  assert.ok(expected.includes('hub.log') && expected.includes('versions'), `unexpected user tier: ${expected.join(', ')}`);
  const bullets = inventoryBullets().filter((l) => l.includes('~/.web-chat/')).join('\n');
  const missing = expected.filter((n) => !names(bullets, n));
  assert.deepEqual(missing, [], `docs/install.md's ~/.web-chat/ bullets do not name: ${missing.join(', ')}`);
});

// Every route that refuses a browser, read from the routes themselves: the
// handler registered by an `app.<verb>('<path>'` whose body calls
// isBrowserRequest. A route added to that set without a word in the doc fails
// here — which is how "a pane can call any local route" stayed in the trust
// section after three routes stopped answering pages.
function browserGatedRoutes() {
  const dir = path.join(REPO_ROOT, 'lib/server/routes');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const parts = src.split(/(?=\bapp\.(?:get|post|put|patch|delete)\(')/);
    for (const part of parts) {
      const m = /^app\.(get|post|put|patch|delete)\('([^']+)'/.exec(part);
      if (m && /\bisBrowserRequest\(/.test(part)) out.push({ method: m[1].toUpperCase(), path: m[2], file: f });
    }
  }
  return out;
}

test('driving-the-surface.md names every route a pane\'s browser request cannot use as-is', () => {
  const gated = browserGatedRoutes();
  const paths = gated.map((r) => r.path);
  for (const p of ['/api/shutdown', '/api/export/:ref', '/api/replay/open']) {
    assert.ok(paths.includes(p), `${p} no longer refuses a browser request — re-read the trust section before changing this`);
  }
  const para = read('docs/driving-the-surface.md').split(/\n(?=- \*\*)/).map(flatten)
    .find((b) => b.includes("Pane code runs with the chrome's authority"));
  assert.ok(para, 'docs/driving-the-surface.md lost its "Pane code runs with the chrome\'s authority" bullet');
  assert.doesNotMatch(para, /call any local route/, 'the trust section says a pane can call ANY local route again');
  for (const r of gated) {
    assert.ok(para.includes(`${r.method} ${r.path}`),
      `${r.method} ${r.path} (${r.file}) treats a browser request differently, but the trust section does not name it`);
  }
  assert.match(para, /format=file/, 'the export exception is the file-writing one, and the doc should say so');
});

test('every doc that quotes the Channels launch line quotes all of it', () => {
  const { LAUNCH_COMMAND } = require('../lib/core/channels');
  let quoted = 0;
  for (const { rel, body } of docFiles()) {
    for (const line of body.split('\n')) {
      if (!line.includes('claude --dangerously-load-development-channels')) continue;
      quoted++;
      assert.ok(line.includes(LAUNCH_COMMAND),
        `${rel} quotes the Channels launch line without the whole of it (${LAUNCH_COMMAND}): ${line.trim()}`);
    }
  }
  assert.ok(quoted >= 3, `expected the guide, channels-dev and remote-access to quote it, found ${quoted}`);
});

test('remote-access.md tells a phone user what a parked Push means, and that the host must stay awake', () => {
  const doc = flatten(read('docs/remote-access.md'));
  const sees = doc.slice(doc.indexOf('## What a remote viewer sees'), doc.indexOf('## The remote access log'));
  assert.match(sees, /wakes Claude only if that project's Claude Code session has Channels on/);
  assert.match(sees, /types into Claude Code \*\*on the host\*\*/, 'the parked state must say where "your next message" is typed');

  const commands = doc.slice(doc.indexOf('## Commands'), doc.indexOf('## Keeping a project off the tunnel'));
  assert.match(commands, /Nothing starts at login/);
  assert.match(commands, /nothing keeps the machine awake/);
  assert.match(commands, /caffeinate -s/);

  const trouble = doc.slice(doc.indexOf('**The tunnel.**'), doc.indexOf('## Commands'));
  assert.match(trouble, /Cloudflare error page/, 'Troubleshooting says nothing about a sleeping host');
  assert.match(trouble, /A Push from the phone did nothing/, 'Troubleshooting says nothing about a parked Push');
});

test('install.md points at a drift report the user sees, not the MCP server\'s stderr', () => {
  const doc = flatten(read('docs/install.md'));
  assert.doesNotMatch(doc, /MCP server logs a one-line nudge/, 'install.md promises the stderr nudge nobody sees');
  assert.match(read('lib/cli/commands/open.js'), /staleManagedLine\(/, '`open` no longer reports stale managed files');
  assert.match(doc, /each time you run `claude-web-chat open` in a project whose managed files are behind the package/);
});
