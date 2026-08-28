// The generic leaf helpers that were promoted into lib/core, and the facts that
// must stay single-sourced once they live there. Each of these had two or more
// homes before; this file is where "there is one, and it behaves like this" is
// written down, so a re-divergence fails a test rather than a review.

const test = require('node:test');
const assert = require('node:assert');

const { escapeHtml } = require('../lib/core/html');

// ── escapeHtml ──────────────────────────────────────────────────────────────

test('escapeHtml: the default escapes all five characters', () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});

test('escapeHtml: & is replaced first, so output is never double-escaped', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml: nullish renders as empty, not the literal "null"', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml: { quotes: false } leaves quotes alone but still closes tags', () => {
  assert.equal(escapeHtml(`it's <b>&</b> "q"`), `it&#39;s &lt;b&gt;&amp;&lt;/b&gt; &quot;q&quot;`);
  assert.equal(escapeHtml(`it's <b>&</b> "q"`, { quotes: false }), `it's &lt;b&gt;&amp;&lt;/b&gt; "q"`);
});

test('escapeHtml: the old homes re-export the SAME function, not a copy', () => {
  assert.equal(require('../lib/server/util/html').escapeHtml, escapeHtml);
  assert.equal(require('../lib/server/export').htmlEscape, escapeHtml);
});

// ── isInside / realpath ─────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside, realpath } = require('../lib/core/paths');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir; // deliberately NOT realpath'd — that is what isInside is for
}

test('isInside: a directory is inside itself, and its existing children are', (t) => {
  const root = tmp(t, 'wc-inside-');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, 'a', 'b')), true);
});

// The documented fail-closed edge, pinned because a caller that fences a path
// which does not exist YET (a file about to be written) will get `false` on any
// machine whose tmp/home is reached through a symlink — macOS $TMPDIR being the
// everyday case. isInside answers about the filesystem, not about strings; a
// caller that needs to fence a not-yet-existing path must check the lexical
// shape of the relative part separately (lib/packs does exactly that).
test('isInside: a child that does not exist under a symlinked parent fails CLOSED', (t) => {
  const base = fs.realpathSync(tmp(t, 'wc-inside-'));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  // Same directory, reached two ways. The parent resolves through the symlink;
  // the child cannot (it is not there to resolve), so the two disagree.
  assert.equal(isInside(link, path.join(link, 'not-created-yet')), false);
  assert.equal(isInside(real, path.join(real, 'not-created-yet')), true);
});

test('isInside: a traversal out is refused, even before it exists', (t) => {
  const root = tmp(t, 'wc-inside-');
  assert.equal(isInside(root, path.join(root, '..', 'elsewhere')), false);
  assert.equal(isInside(root, path.join(root, 'a', '..', '..', 'etc', 'passwd')), false);
  assert.equal(isInside(root, path.dirname(root)), false);
});

test('isInside: a sibling with the parent as a name PREFIX is not inside it', (t) => {
  const base = tmp(t, 'wc-inside-');
  const versions = path.join(base, 'versions');
  const backup = path.join(base, 'versions-backup');
  fs.mkdirSync(versions);
  fs.mkdirSync(backup);
  assert.equal(isInside(versions, backup), false);
});

test('isInside: a symlink pointing OUT of the parent resolves out and is refused', (t) => {
  const base = tmp(t, 'wc-inside-');
  const inside = path.join(base, 'inside');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'x');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(inside, 'link'));
  // Lexically `inside/link` is inside; by realpath it is not. The realpath
  // answer is the one a fence needs.
  assert.equal(isInside(inside, path.join(inside, 'link')), false);
});

test('isInside: a symlinked parent still matches its own real children', (t) => {
  const base = tmp(t, 'wc-inside-');
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(path.join(real, 'child'), { recursive: true });
  fs.symlinkSync(real, link);
  assert.equal(isInside(link, path.join(real, 'child')), true);
  assert.equal(isInside(real, path.join(link, 'child')), true);
});

test('isInside: a missing side is never inside anything', () => {
  assert.equal(isInside('', '/tmp'), false);
  assert.equal(isInside('/tmp', ''), false);
  assert.equal(isInside(null, null), false);
});

test('realpath: returns null rather than throwing for a path that is not there', () => {
  assert.equal(realpath(path.join(os.tmpdir(), 'wc-definitely-not-here-9c1f')), null);
  assert.equal(realpath(os.tmpdir()), fs.realpathSync(os.tmpdir()));
});

test('isInside: the old home re-exports the SAME function, not a copy', () => {
  assert.equal(require('../lib/update/install-layout').isInside, isInside);
});
