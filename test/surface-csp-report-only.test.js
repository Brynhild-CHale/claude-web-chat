// The surface page's Content-Security-Policy-Report-Only (annotation engine
// tranche 5, U632; plan.json tranches[4] 5B.2, CHROME@element-module-reach's
// engine half; RULED CHROME@csp C3 = a, U632@csp-report-sink H6 = a,
// U632@report-only-frame-src H10 = a): lib/server/index.js's express.static
// setHeaders sends lib/core/cors.js SURFACE_CSP_REPORT_ONLY on public/index.html
// alone — a policy that measures network reach and blocks nothing. The surface
// page keeps no enforced Content-Security-Policy; no other static file carries
// either header; the preview route's enforced PREVIEW_CSP is unchanged; the
// policy names no report sink (no report-uri, no report-to: the gate's Chrome
// and devtools read the violations, no route is added).
const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { PREVIEW_CSP, SURFACE_CSP_REPORT_ONLY } = require('../lib/core/cors');

const RO = 'content-security-policy-report-only';
const ENFORCED = 'content-security-policy';
const directives = (p) => Object.fromEntries(p.split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('the policy: connect-src \'self\', img-src \'self\' data: blob:, script-src with \'unsafe-inline\' \'unsafe-eval\', a loopback frame-src, no report sink', () => {
  assert.equal(typeof SURFACE_CSP_REPORT_ONLY, 'string');
  const d = directives(SURFACE_CSP_REPORT_ONLY);
  assert.deepStrictEqual(d['default-src'], ["'self'"]);
  assert.deepStrictEqual(d['connect-src'], ["'self'"], 'the daemon\'s routes and its same-host WebSocket only');
  assert.deepStrictEqual(d['img-src'], ["'self'", 'data:', 'blob:']);
  assert.deepStrictEqual(d['script-src'], ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'the mount runtime\'s new Function and the panes\' inline scripts: the report measures network reach, not the pane compile');
  assert.deepStrictEqual(d['style-src'], ["'self'", "'unsafe-inline'"]);
  assert.deepStrictEqual(d['font-src'], ["'self'", 'data:']);
  assert.deepStrictEqual(d['media-src'], ["'self'", 'data:', 'blob:']);
  assert.deepStrictEqual(d['frame-src'], ["'self'", 'http://127.0.0.1:*'],
    'previews same-origin; the answer and control frames on the isolated origin\'s loopback listener');
  assert.deepStrictEqual(d['object-src'], ["'none'"]);
  assert.deepStrictEqual(d['base-uri'], ["'self'"]);
  assert.deepStrictEqual(d['form-action'], ["'self'"]);
  assert.equal('report-uri' in d, false, 'no report-uri');
  assert.equal('report-to' in d, false, 'no report-to');
  assert.doesNotMatch(SURFACE_CSP_REPORT_ONLY, /report-(uri|to)/);
  assert.notEqual(SURFACE_CSP_REPORT_ONLY, PREVIEW_CSP);
});

test('GET / and GET /index.html carry Content-Security-Policy-Report-Only and no enforced policy; a static script carries neither; the preview keeps PREVIEW_CSP', async (t) => {
  const { api } = await withServer(t);
  for (const url of ['/', '/index.html']) {
    const r = await api.get(url);
    assert.equal(r.status, 200, url);
    assert.match(String(r.headers.get('content-type')), /text\/html/, `${url} is the surface page`);
    assert.match(r.text, /<html/i);
    assert.strictEqual(r.headers.get(RO), SURFACE_CSP_REPORT_ONLY, `${url}: the report-only policy`);
    assert.equal(r.headers.get(ENFORCED), null, `${url}: no enforced Content-Security-Policy`);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${url}: the rest of the static hunk unchanged`);
    assert.match(String(r.headers.get('etag')), /^W\/"/);
  }
  const js = await api.get('/app/main.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers.get(RO), null, 'a static script carries no report-only policy');
  assert.equal(js.headers.get(ENFORCED), null, 'nor an enforced one');
  const css = await api.get('/app.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get(RO), null, 'a stylesheet neither');
  const pv = await api.get('/preview/node/nope');
  assert.equal(pv.status, 404);
  assert.equal(pv.headers.get(ENFORCED), PREVIEW_CSP, 'the preview\'s enforced policy unchanged');
  assert.equal(pv.headers.get(RO), null, 'and no report-only beside it');
});
