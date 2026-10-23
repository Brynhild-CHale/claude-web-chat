'use strict';

// The answer host's document rule admits the elements kind (U312a; K.2-73;
// spec 2B.2). U312 built the `elements` answer kind — its framed document at
// /answer/elements/report — but the portal's CSRF rule let a same-site
// navigation through only for an ask's or a control action's document, so a
// real browser framing the report document from the session host was refused
// 403 'same-site request refused'. lib/portal/answer.js DOCUMENT_PATH now
// names the kind; the change is inside protocol 12 (ruling B4 (a): nothing is
// released between U332 and alpha.2), so PORTAL_PROTOCOL_VERSION stays 12.
//
// Pinned here, at the portal's own level (the end-to-end load through a real
// portal is test/reports-remote.test.js's):
//   * isDocumentNavigation / answerCsrfRefusal admit a GET (and HEAD)
//     navigation of /answer/elements/<kind-id>, framed (iframe) or opened
//     (document), from the session host (same-site) or a reload (none);
//   * they still refuse /answer/other/x, a POST to the document path, a
//     cross-site navigation, a non-navigation read, a nested path and the
//     bare kind with no id;
//   * PORTAL_PROTOCOL_VERSION === 12.

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerCsrfRefusal, isDocumentNavigation } = require('../lib/portal/answer');
const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');

const O = 'https://wc-0a1b2c3d-a.example.com';
const NAV = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' };
const DOC = '/answer/elements/report?layout=report&mode=light&device=desktop';

const req = (method, url, headers) => ({ method, url, headers });
const refusalOf = (method, url, headers) => answerCsrfRefusal(req(method, url, headers), O);

test('isDocumentNavigation: a navigation GET or HEAD of /answer/elements/<kind-id> is a document load', () => {
  for (const [what, method, url, headers] of [
    ['the frame\'s load from the session', 'GET', DOC, NAV],
    ['the bare path', 'GET', '/answer/elements/report', NAV],
    ['a HEAD', 'HEAD', DOC, NAV],
    ['opened as a document', 'GET', DOC, { ...NAV, 'sec-fetch-dest': 'document' }],
    ['any kind id', 'GET', '/answer/elements/other-id', NAV],
    ['case-insensitive like its siblings', 'GET', '/ANSWER/Elements/report', NAV],
  ]) assert.equal(isDocumentNavigation(req(method, url, headers)), true, what);
});

test('isDocumentNavigation: not the elements document — other paths, methods and fetch kinds', () => {
  for (const [what, method, url, headers] of [
    ['another kind', 'GET', '/answer/other/x', NAV],
    ['the kind with no id', 'GET', '/answer/elements', NAV],
    ['the kind with an empty id', 'GET', '/answer/elements/', NAV],
    ['a nested path', 'GET', '/answer/elements/report/x', NAV],
    ['the API path', 'GET', '/answer/api/elements/report', NAV],
    ['the frame module', 'GET', '/answer/elements-report.js', NAV],
    ['a POST', 'POST', DOC, NAV],
    ['not a navigation', 'GET', DOC, { ...NAV, 'sec-fetch-mode': 'cors' }],
    ['an image load', 'GET', DOC, { ...NAV, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
  ]) assert.equal(isDocumentNavigation(req(method, url, headers)), false, what);
});

test('answerCsrfRefusal: a same-site (or none) navigation of the elements document proceeds', () => {
  assert.equal(refusalOf('GET', DOC, NAV), null, 'the frame\'s load from the session\'s page');
  assert.equal(refusalOf('GET', `${DOC}&viewer=abcdef0123456789`, NAV), null, 'with a per-tab viewer id');
  assert.equal(refusalOf('GET', DOC, { ...NAV, 'sec-fetch-dest': 'document' }), null, 'opened in a popup');
  assert.equal(refusalOf('GET', DOC, { ...NAV, 'sec-fetch-site': 'none' }), null, 'a reload');
  assert.equal(refusalOf('GET', DOC, { ...NAV, 'sec-fetch-site': 'same-origin' }), null, 'same-origin, as before');
  // The siblings are untouched.
  assert.equal(refusalOf('GET', '/answer/ask/x?layout=bar', NAV), null, 'an ask\'s document');
  assert.equal(refusalOf('GET', '/answer/control/interrupt', NAV), null, 'a control action\'s document');
});

test('answerCsrfRefusal: still refuses another path, a POST to the document path and a cross-site navigation', () => {
  for (const [what, method, url, headers, error] of [
    ['a same-site navigation to another kind', 'GET', '/answer/other/x', NAV, 'same-site request refused'],
    ['a same-site navigation to a nested elements path', 'GET', '/answer/elements/report/x', NAV, 'same-site request refused'],
    ['a same-site navigation to the report API', 'GET', '/answer/api/elements/report', NAV, 'same-site request refused'],
    ['a POST to the document path with no Origin', 'POST', DOC, NAV, 'an answer must come from the answer frame\'s own page'],
    ['a same-site POST to the document path', 'POST', DOC, { ...NAV, origin: O }, 'same-site request refused'],
    ['a cross-site navigation', 'GET', DOC, { ...NAV, 'sec-fetch-site': 'cross-site' }, 'cross-site request refused'],
    ['a same-site read that is not a navigation', 'GET', DOC, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }, 'same-site request refused'],
    ['the session host\'s Origin', 'GET', DOC, { ...NAV, origin: 'https://wc-0a1b2c3d.example.com' }, 'cross-origin request refused'],
  ]) {
    const out = refusalOf(method, url, headers);
    assert.ok(out, what);
    assert.equal(out.status, 403, what);
    assert.deepEqual(out.body, { ok: false, remote: true, error }, what);
  }
});

test('no protocol bump: the elements document rule rides protocol 12', () => {
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
});
