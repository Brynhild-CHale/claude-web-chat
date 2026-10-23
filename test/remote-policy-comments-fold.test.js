// The dead /api/comments rows, folded (U332a; DECISIONS.md K.4: form 3's
// I2-confirm = c under H2 = b, superseding F7 = a). Protocol 11 gave the
// portal three rows for 0.8.5's comment routes — GET at read, the writes at
// full, the rest refused. Since U327a the daemon serves none of them (it
// answers every method on /api/comments and below with its 410, the comment's
// routes being the element API's), and H2 b says the portal's table carries no
// row for a route the daemon no longer serves: the three are one refusal now,
// its hint naming the element API, riding tranche 2's bump (protocol 12, B4
// a: nothing is released between U332 and alpha.2, so no second bump).
//
// test/remote-policy.test.js holds the re-derived pins (T2_ROWS and before12
// carry the refusal; the protocol-11/10/8 digests are unchanged). This file
// pins the fold on its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { RULES, classify, classifier, keyOf, refusalBody, MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');
const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');

const REPO_ROOT = path.join(__dirname, '..');
const LEVELS = [undefined, 'off', 'read', 'full']; // basic (none, off), read, full
const UNKNOWN_HINT = 'this route is not available remotely — use it on the host';

// Protocol 11's three comment rows, as U211 wrote them.
const P11_COMMENT_ROWS = [
  { methods: ['GET'], path: '/api/comments', allow: true, mirror: 'read', hint: MIRROR_HINT },
  { methods: ['POST', 'PATCH', 'DELETE'], path: '/api/comments/*', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },
  { methods: '*', path: '/api/comments/*', allow: false, hint: UNKNOWN_HINT },
];

const underComments = (r) => r.path === '/api/comments' || r.path.startsWith('/api/comments/');
const foldRow = () => RULES.find(underComments);

// RULES with the refusal unfolded back into protocol 11's three rows, in
// place. The rows protocol 12 only adds stay: they decide no comment route.
// The byte-for-byte protocol-11 pin is test/remote-policy.test.js's (before12
// over T2_ROWS, the one list of tranche 2's rows), not a second copy here.
function unfold(rules) {
  const fold = rules.find(underComments);
  const out = [];
  for (const r of rules) {
    if (r === fold) out.push(...P11_COMMENT_ROWS.map((row) => ({ ...row })));
    else out.push(r);
  }
  return out;
}

test('the table holds one row under /api/comments, and it refuses: no allowing row at any level', () => {
  const rows = RULES.filter(underComments);
  assert.equal(rows.length, 1, rows.map(keyOf).join(', '));
  const [row] = rows;
  assert.deepStrictEqual(Object.keys(row).sort(), ['allow', 'hint', 'methods', 'path']);
  assert.deepStrictEqual([row.methods, row.path, row.allow], ['*', '/api/comments/*', false]);
  assert.match(row.hint, /element API/);
  assert.match(row.hint, /\/api\/elements/);
  assert.ok(!RULES.some((r) => underComments(r) && r.allow), 'no allowing row under /api/comments');
  // It holds the place the three rows had: directly above the element floor.
  const i = RULES.indexOf(row);
  assert.equal(keyOf(RULES[i + 1]), 'GET /api/elements/search');
});

test('a remote request to /api/comments or below is refused at basic, read and full, with the element-API hint', () => {
  const { hint } = foldRow();
  const paths = ['/api/comments', '/api/comments/', '/api/comments?since=3&mount=m1&shared_only=1', '/api/comments/c1', '/api/comments/c1/', '/api/comments/c1/reply', '/API/Comments/c1'];
  for (const u of paths) {
    for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS']) {
      for (const optIn of LEVELS) {
        const v = classify(m, u, { mirror: optIn });
        assert.deepStrictEqual([v.allow, v.reason, v.key, v.hint], [false, 'refused', '* /api/comments/*', hint], `${m} ${u} at ${optIn}`);
        assert.deepStrictEqual(refusalBody(v), { ok: false, remote: true, hint }, `${m} ${u} at ${optIn}`);
      }
    }
  }
  // The element API the hint names is where the comments are: reads at read.
  assert.equal(classify('GET', '/api/elements?type=comment', { mirror: 'read' }).allow, true);
});

test('unfolded, the refusal is protocol 11\'s three comment rows, in place', () => {
  const p11 = unfold(RULES);
  const at = p11.findIndex(underComments);
  assert.deepStrictEqual(p11.slice(at, at + 3), P11_COMMENT_ROWS);
  assert.equal(p11.filter(underComments).length, 3);
  assert.equal(p11.length, RULES.length + 2, 'the fold replaced one row by three, no other');
  assert.equal(keyOf(p11[at + 3]), 'GET /api/elements/search', 'still directly above the element floor');
  // And that portal decides the comment routes as protocol 11 did.
  const old = classifier(p11);
  assert.deepStrictEqual([old('GET', '/api/comments', { mirror: 'read' }).allow, old('GET', '/api/comments', {}).reason], [true, 'mirror']);
  assert.deepStrictEqual([old('POST', '/api/comments/c1/reply', { mirror: 'full' }).allow, old('PATCH', '/api/comments/c1', { mirror: 'read' }).need], [true, 'full']);
  assert.equal(old('PUT', '/api/comments/c1', { mirror: 'full' }).hint, UNKNOWN_HINT);
});

test('PORTAL_PROTOCOL_VERSION is 12: the fold rides tranche 2\'s bump (B4 a)', () => {
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
});

test('the chrome reaches no /api/comments route: its comments go through the element API (U327b)', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name) && /\/api\/comments\b/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO_ROOT, p));
    }
  };
  walk(path.join(REPO_ROOT, 'public'));
  assert.deepStrictEqual(hits, []);
});
