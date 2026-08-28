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
