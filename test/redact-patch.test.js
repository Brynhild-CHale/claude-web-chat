// lib/core/redact.js redactPatch (PLAN 1D.2, R4 §3 seam (e), M-10): a unified
// diff redacted WITHOUT renumbering it. redactText masks a private key as one
// mask, so a key mid-hunk folded many patch lines into one and renderDiff,
// which numbers lines from the @@ counts, numbered every line after it wrong.
// redactPatch masks a key line by line (prefix kept, the rest the pem mask), so
// the line count, every line's first character, every @@ header and so
// renderDiff's data-old/data-new are the unredacted patch's.
//
// Key blocks come from test-support/fake-secrets.js (the PEM marker is spelled
// there and in lib/core/redact.js alone).

const test = require('node:test');
const assert = require('node:assert');

const { MASK, WITHHELD, redactText, redactPatch, createRedactor } = require('../lib/core/redact');
const { renderDiff } = require('../lib/core/markdown');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');

const FAKES = fakeSecrets();
const fake = (id) => {
  const f = FAKES.find((x) => x.id === id);
  assert.ok(f, `fake-secrets has no ${id}`);
  return f;
};
const PEM_MASK = MASK('private-key');
// A fake's key block as its lines: BEGIN, the body, END (the carrier's own
// prose lines around it dropped).
const keyBlock = (id) => {
  const lines = fake(id).text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const last = lines.findIndex((l) => l.startsWith('-----END'));
  return lines.slice(first, last + 1);
};

// One hunk numbered from 1 on both sides: `body` is [[prefix, text], …]; the
// expected numbers are computed here, not by renderDiff.
function hunkFile(file, body) {
  let o = 0;
  let n = 0;
  const expected = body.map(([t]) => {
    if (t !== '+') o += 1;
    if (t !== '-') n += 1;
    return { old: t === '+' ? '' : String(o), new: t === '-' ? '' : String(n) };
  });
  const oc = body.filter(([t]) => t !== '+').length;
  const nc = body.filter(([t]) => t !== '-').length;
  const patch = `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`
    + `@@ -1,${oc} +1,${nc} @@\n${body.map(([t, s]) => t + s).join('\n')}\n`;
  return { patch, expected };
}

// Every span renderDiff draws, as { cls, old, new }.
function numbering(patch) {
  const out = [];
  const re = /<span class="dl ([^"]+)" data-old="([^"]*)" data-new="([^"]*)">/g;
  let m;
  while ((m = re.exec(renderDiff(patch)))) out.push({ cls: m[1], old: m[2], new: m[3] });
  return out;
}
const bodyRows = (patch) => numbering(patch).filter((r) => /dl-(?:ctx|add|del)/.test(r.cls));

// What every patch redaction must keep, whatever it masked.
function assertShape(original, redacted) {
  const a = original.split('\n');
  const b = redacted.split('\n');
  assert.equal(b.length, a.length, 'the line count is kept');
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].charAt(0), a[i].charAt(0), `line ${i + 1} keeps its first character`);
    if (a[i].startsWith('@@')) assert.equal(b[i], a[i], `the @@ header on line ${i + 1} is intact`);
  }
  assert.deepEqual(numbering(redacted), numbering(original), 'renderDiff numbers every line as on the unredacted patch');
}

const CTX = [[' ', 'line 1'], [' ', 'line 2']];
const TAIL = Array.from({ length: 6 }, (_, i) => [' ', `after ${i + 1}`]);

test('a PEM block added mid-hunk (the s6 shape): 20/20 lines numbered right, each key line prefix + mask, no key bytes', () => {
  const carrier = fake('pem-rsa').text.split('\n');
  const { patch, expected } = hunkFile('src/key.js', [...CTX, ['+', 'const key = `'], ...carrier.map((s) => ['+', s]), ['+', '`;'], ...TAIL]);
  const out = redactPatch(patch, { context: { file: 'src/key.js' } });
  assertShape(patch, out);
  const rows = bodyRows(out);
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((r) => ({ old: r.old, new: r.new })), expected, '20/20 on the true numbers');
  assert.deepEqual(findLeaks(out, [fake('pem-rsa')]), []);
  const block = keyBlock('pem-rsa');
  const lines = out.split('\n');
  const masked = lines.filter((l) => l === `+${PEM_MASK}`);
  assert.equal(masked.length, block.length, 'one mask per key line, BEGIN and END included');
  assert.ok(lines.includes('+the deploy key:') && lines.includes('+that is all'), 'the lines around the key are untouched');
  // The same patch through redactText is what this fixes: one mask, fewer lines.
  assert.notEqual(redactText(patch).split('\n').length, patch.split('\n').length);
});

test('a key added among context and removed lines (pem-pkcs8): numbering equal, no key bytes', () => {
  const block = keyBlock('pem-pkcs8');
  const body = [
    ...CTX, ['-', 'const old = null;'], ['+', 'const pem = ['],
    ...block.slice(0, 3).map((s) => ['+', s]), [' ', 'kept between'], ['-', 'removed between'],
    ...block.slice(3).map((s) => ['+', s]), ['+', '];'], ['-', 'gone'], ...TAIL,
  ];
  const { patch, expected } = hunkFile('src/pkcs8.js', body);
  const out = redactPatch(patch);
  assertShape(patch, out);
  assert.deepEqual(bodyRows(out).map((r) => ({ old: r.old, new: r.new })), expected);
  assert.deepEqual(findLeaks(out, [fake('pem-pkcs8')]), []);
  // The key runs BEGIN → END across the context and removed lines between, so
  // those are masked too, each on its own line and keeping its prefix.
  const lines = out.split('\n');
  assert.ok(lines.includes(` ${PEM_MASK}`) && lines.includes(`-${PEM_MASK}`));
  assert.ok(lines.includes('-const old = null;') && lines.includes('+];') && lines.includes('-gone'));
});

test('a BEGIN with no END in the first of two hunks: every body line after it, in both hunks, is prefix + mask; the second @@ intact', () => {
  const block = keyBlock('pem-ec');
  const open = block.slice(0, -1); // no END
  const first = [...CTX, ['+', 'const k = `'], ...open.map((s) => ['+', s])];
  const oc1 = first.filter(([t]) => t !== '+').length;
  const nc1 = first.filter(([t]) => t !== '-').length;
  const second = [[' ', 'ctx a'], ['-', 'old b'], ['+', 'new b'], [' ', 'ctx c']];
  const patch = 'diff --git a/k.js b/k.js\n--- a/k.js\n+++ b/k.js\n'
    + `@@ -1,${oc1} +1,${nc1} @@\n${first.map(([t, s]) => t + s).join('\n')}\n`
    + `@@ -40,3 +47,3 @@ function later() {\n${second.map(([t, s]) => t + s).join('\n')}\n`
    + '@@ -90 +97 @@\n-x\n+y\n';
  const out = redactPatch(patch);
  assertShape(patch, out);
  assert.deepEqual(findLeaks(out, [fake('pem-ec')]), []);
  const lines = out.split('\n');
  const begin = lines.indexOf(`+${PEM_MASK}`);
  assert.ok(begin > 0, 'the BEGIN line is masked');
  for (let i = begin; i < lines.length - 1; i++) {
    if (lines[i].startsWith('@@')) continue;
    assert.equal(lines[i].slice(1), PEM_MASK, `body line ${i + 1} after the BEGIN is masked`);
  }
  assert.ok(lines.includes('@@ -40,3 +47,3 @@ function later() {') && lines.includes('@@ -90 +97 @@'));
  assert.equal(lines[lines.length - 1], '', 'the trailing newline is kept');
});

test('a key removed on - lines and its replacement added on + lines: both sides masked line by line, numbering equal', () => {
  const was = keyBlock('pem-rsa');
  const now = keyBlock('pem-openssh');
  const { patch, expected } = hunkFile('deploy/key.txt', [...CTX, ...was.map((s) => ['-', s]), ...now.map((s) => ['+', s]), ...TAIL]);
  const out = redactPatch(patch);
  assertShape(patch, out);
  assert.deepEqual(bodyRows(out).map((r) => ({ old: r.old, new: r.new })), expected);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l === `-${PEM_MASK}`).length, was.length);
  assert.equal(lines.filter((l) => l === `+${PEM_MASK}`).length, now.length);
  assert.deepEqual(findLeaks(out, [fake('pem-rsa'), fake('pem-openssh')]), []);
});

test('a patch with no key is redactText byte for byte: single-line rules still apply', () => {
  const gh = fake('github-ghp');
  const { patch } = hunkFile('scripts/push.sh', [...CTX, ['-', 'git push'], ['+', gh.text], ...TAIL]);
  const out = redactPatch(patch);
  assert.equal(out, createRedactor().text(patch));
  assert.equal(out, redactText(patch));
  assert.notEqual(out, patch, 'the github token was masked');
  assert.deepEqual(findLeaks(out, [gh]), []);
  assertShape(patch, out);
  // An env-dotenv mode (a .env is a mode, not a withholding) runs as in text().
  const env = fake('env-dotenv');
  const { patch: envPatch } = hunkFile('.env', env.text.split('\n').map((s) => ['+', s]));
  assert.equal(redactPatch(envPatch, { context: { file: '.env' } }), redactText(envPatch, { context: { file: '.env' } }));
});

test('a token on the same patch as a key: both masked, numbering kept', () => {
  const gh = fake('github-ghp');
  const { patch } = hunkFile('src/both.js', [...CTX, ['+', gh.text], ...keyBlock('pem-rsa').map((s) => ['+', s]), ...TAIL]);
  const out = redactPatch(patch);
  assertShape(patch, out);
  assert.deepEqual(findLeaks(out, [gh, fake('pem-rsa')]), []);
});

test('idempotent: redactPatch(redactPatch(p)) === redactPatch(p)', () => {
  const patches = [
    hunkFile('a.js', [...CTX, ...keyBlock('pem-rsa').map((s) => ['+', s]), ...TAIL]).patch,
    hunkFile('b.js', [...CTX, ...keyBlock('pem-pgp').map((s) => ['-', s]), ['+', fake('github-ghp').text], ...TAIL]).patch,
    hunkFile('c.js', [...CTX, ...keyBlock('pem-ec').slice(0, -1).map((s) => ['+', s])]).patch,
    hunkFile('d.js', [...CTX, ['+', 'nothing secret here'], ...TAIL]).patch,
  ];
  for (const p of patches) {
    const once = redactPatch(p);
    assert.equal(redactPatch(once), once);
    assert.equal(createRedactor().patch(once), once);
  }
});

test("a learned value: the redactor's patch() masks it on its own line, numbering kept", () => {
  const email = fake('known-email');
  const value = email.secrets[0];
  const { patch } = hunkFile('CODEOWNERS', [...CTX, ['+', `* ${value}`], ...TAIL]);
  assert.ok(redactPatch(patch).includes(value), 'not masked before it is known');
  const r = createRedactor();
  r.addKnown(value, 'email');
  const out = r.patch(patch);
  assert.ok(!out.includes(value));
  assert.ok(out.split('\n').includes(`+* ${MASK('email')}`));
  assertShape(patch, out);
  assert.equal(out, r.text(patch), 'with no key, patch() is text() under the same known values');
});

test('a withholding context answers the whole WITHHELD form exactly as text() does', () => {
  const { patch } = hunkFile('deploy.key', keyBlock('pem-rsa').map((s) => ['+', s]));
  const r = createRedactor();
  const out = r.patch(patch, { context: { file: 'deploy.key' } });
  assert.equal(out, WITHHELD('key'));
  assert.equal(out, r.text(patch, { context: { file: 'deploy.key' } }));
  assert.equal(redactPatch(patch, { context: { file: '/x/.ssh/id_rsa' } }), WITHHELD('ssh'));
});

test('onMask hears one pem note per key region, then the in-line rules', () => {
  const gh = fake('github-ghp');
  const { patch } = hunkFile('two.js', [
    ...CTX, ...keyBlock('pem-rsa').map((s) => ['+', s]), [' ', 'between the keys'],
    ...keyBlock('pem-pkcs8').map((s) => ['-', s]), ['+', gh.text], ...TAIL,
  ]);
  const notes = [];
  const out = redactPatch(patch, { onMask: (n) => notes.push(n) });
  assertShape(patch, out);
  assert.equal(notes.filter((n) => n.id === 'pem').length, 2);
  assert.ok(notes.some((n) => n.id !== 'pem'), 'the github token is noted too');
  for (const n of notes) assert.ok(!JSON.stringify(n).includes(gh.secrets[0]), 'a note never carries a value');
  const one = [];
  redactPatch(hunkFile('one.js', keyBlock('pem-ec').map((s) => ['+', s])).patch, { onMask: (n) => one.push(n) });
  assert.deepEqual(one.map((n) => n.id), ['pem']);
});

test('structural lines inside a key are never masked; an empty context line stays empty; CRLF numbering is kept', () => {
  const block = keyBlock('pem-rsa');
  const lf = 'diff --git a/k b/k\n--- a/k\n+++ b/k\n'
    + `@@ -1,3 +1,${block.length + 3} @@\n line 1\n${block.slice(0, 3).map((s) => '+' + s).join('\n')}\n\n`
    + `${block.slice(3).map((s) => '+' + s).join('\n')}\n line 3\n\\ No newline at end of file\n`;
  const out = redactPatch(lf);
  assertShape(lf, out);
  const lines = out.split('\n');
  assert.ok(lines.includes('\\ No newline at end of file'));
  assert.equal(lines.filter((l) => l === '').length, 2, 'the empty context line and the trailing newline');
  assert.deepEqual(findLeaks(out, [fake('pem-rsa')]), []);
  const crlf = lf.replace(/\n/g, '\r\n');
  const outCrlf = redactPatch(crlf);
  assert.equal(outCrlf.split('\r\n').length, crlf.split('\r\n').length);
  assert.deepEqual(numbering(outCrlf), numbering(crlf));
  assert.equal(outCrlf.replace(/\r\n/g, '\n'), out, 'the line breaks are the patch\'s own');
});

test('a hunk opening inside a key (an END and no BEGIN): masked from the patch start, file headers kept', () => {
  const block = keyBlock('pem-rsa');
  const tailOnly = block.slice(3); // body lines then END
  const patch = 'diff --git a/id b/id\nindex 1..2 100644\n--- a/id\n+++ b/id\n'
    + `@@ -4,${tailOnly.length} +4,${tailOnly.length + 1} @@\n${tailOnly.map((s) => ' ' + s).join('\n')}\n+appended\n`;
  const out = redactPatch(patch);
  assertShape(patch, out);
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 4), patch.split('\n').slice(0, 4));
  assert.equal(lines.filter((l) => l === ` ${PEM_MASK}`).length, tailOnly.length);
  assert.ok(lines.includes('+appended'));
});

test('not a string, or empty: returned as it came', () => {
  for (const v of [undefined, null, 42, '']) assert.equal(redactPatch(v), v);
});
