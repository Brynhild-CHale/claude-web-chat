// The answer frame's guards (lib/server/answer-surface/public/answer-gate.js,
// spec §4.5 items 1-5), in plain node with a fake clock: the module is pure —
// no DOM, no timers — so every rule is a sequence of reports and a question.
//
//   1. answering enables only after ratio 1 and isVisible have held 500 ms, and
//      any other entry disables it at once;
//   2. the fit rule: a clipped or ellipsized subject element, an overflowing
//      document, or a request the projection cut keeps the acting answers off;
//   3. a pointer click within 300 ms of the pointer entering is ignored;
//   4. a click within 600 ms of a new ask or version, a visibilitychange or a
//      focus is ignored;
//   5. a keyboard activation counts only when focus came by Tab or the pointer.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
let G;
test.before(async () => {
  G = await import(pathToFileURL(path.join(REPO, 'lib/server/answer-surface/public/answer-gate.js')).href);
});

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
const SEEN = { intersectionRatio: 1, isVisible: true };
const pointer = { acting: true, keyboard: false };

// A gate proven visible, fitted, settled, with the pointer in the frame long
// enough: the state each rule is then taken away from.
function ready(opts = {}) {
  const c = clock();
  const g = G.createGate({ now: c.now, ...opts });
  g.setFit(true);
  g.pointerEnter();
  g.observe(SEEN);
  c.advance(G.VISIBLE_MS);
  return { c, g };
}

test('the constants are the spec\'s: 500 ms visible, 300 ms dwell, 600 ms cooldown', () => {
  assert.equal(G.VISIBLE_MS, 500);
  assert.equal(G.DWELL_MS, 300);
  assert.equal(G.COOLDOWN_MS, 600);
  assert.match(G.COVERED, /^Covered or faded: make this prompt fully visible to answer, or answer in the terminal$/);
});

test('item 1: answering enables only after ratio 1 and isVisible have held 500 ms', () => {
  const c = clock();
  const g = G.createGate({ now: c.now });
  g.setFit(true);
  g.pointerEnter();
  assert.equal(g.state().enabled, false, 'nothing proven before the first entry');
  assert.equal(g.state().reason, 'settling');
  g.observe(SEEN);
  c.advance(499);
  assert.equal(g.state().enabled, false, 'not at 499 ms');
  assert.equal(g.allows(pointer), false);
  assert.equal(g.wakeIn(), 1, 'the frame is told when to look again');
  c.advance(1);
  assert.equal(g.state().enabled, true, 'at 500 ms');
  assert.equal(g.allows(pointer), true);
  assert.equal(g.state().reason, null);
});

test('item 1: an entry with isVisible false, or a ratio under 1, disables at once — and the 500 ms start again', () => {
  for (const bad of [{ intersectionRatio: 1, isVisible: false }, { intersectionRatio: 0.99, isVisible: true }, { intersectionRatio: 0, isVisible: false }, null]) {
    const { c, g } = ready();
    assert.equal(g.allows(pointer), true, 'precondition: answering');
    g.observe(bad);
    assert.equal(g.state().enabled, false, `disabled by ${JSON.stringify(bad)}`);
    assert.equal(g.state().reason, 'covered');
    assert.equal(g.allows(pointer), false);
    assert.equal(g.allows({ acting: false }), false, 'Deny and the terminal choice too');
    g.observe(SEEN);
    c.advance(G.VISIBLE_MS - 1);
    assert.equal(g.allows(pointer), false, 'proven again only after another full 500 ms');
    c.advance(1);
    assert.equal(g.allows(pointer), true);
  }
});

test('item 1: a visible entry that repeats does not restart the clock; isVisible must be exactly true', () => {
  const c = clock();
  const g = G.createGate({ now: c.now });
  g.setFit(true);
  g.pointerEnter();
  g.observe(SEEN);
  c.advance(300);
  g.observe(SEEN);
  c.advance(200);
  assert.equal(g.allows(pointer), true);
  g.observe({ intersectionRatio: 1, isVisible: 'yes' });
  assert.equal(g.allows(pointer), false);
});

test('item 1: without the proof (the stop layout, a top-level page window) visibility is not asked', () => {
  const c = clock();
  const g = G.createGate({ now: c.now, proof: false });
  g.setFit(true);
  g.pointerEnter();
  c.advance(G.DWELL_MS);
  assert.equal(g.state().enabled, true);
  assert.equal(g.allows(pointer), true);
});

test('reset(): a new container starts unproven and uncovered', () => {
  const { c, g } = ready();
  g.reset();
  assert.equal(g.state().reason, 'settling');
  assert.equal(g.allows(pointer), false);
  g.observe(SEEN);
  c.advance(G.VISIBLE_MS);
  assert.equal(g.allows(pointer), true);
});

test('item 2: fits() — a clipped or ellipsized subject, an overflowing document or complete false keep Allow off', () => {
  const doc = { scrollWidth: 300, scrollHeight: 100, innerWidth: 300, innerHeight: 100 };
  const whole = { scrollWidth: 120, clientWidth: 120, scrollHeight: 18, clientHeight: 18 };
  assert.equal(G.fits({ doc, subjects: [whole], complete: true }), true);
  assert.equal(G.fits({ doc, subjects: [{ ...whole, scrollWidth: 121 }], complete: true }), false, 'ellipsized: scrollWidth > clientWidth');
  assert.equal(G.fits({ doc, subjects: [{ ...whole, scrollHeight: 19 }], complete: true }), false, 'clipped below');
  assert.equal(G.fits({ doc: { ...doc, scrollWidth: 301 }, subjects: [whole], complete: true }), false, 'the document overflows sideways');
  assert.equal(G.fits({ doc: { ...doc, scrollHeight: 101 }, subjects: [whole], complete: true }), false, 'the frame is smaller than its content');
  assert.equal(G.fits({ doc, subjects: [whole], complete: false }), false, 'a request the projection cut');
  assert.equal(G.fits({ doc, subjects: [whole] }), false, 'complete must be said');
  assert.equal(G.fits({ doc: null, subjects: [], complete: true }), true, 'no document check where it does not apply');
});

test('item 2: without fit, Allow stays off and the reason is fit — Deny and the terminal choice stay on', () => {
  const { g } = ready();
  g.setFit(false);
  const st = g.state();
  assert.equal(st.enabled, true);
  assert.equal(st.fit, false);
  assert.equal(st.acting, false);
  assert.equal(st.reason, 'fit', 'the layout offers Review ›');
  assert.equal(g.allows({ acting: true }), false, 'Allow, answer, approve: off');
  assert.equal(g.allows({ acting: false }), true, 'Deny: on');
  g.setFit(true);
  assert.equal(g.allows({ acting: true }), true);
});

test('item 2: a gate with the fit rule off (the stop layout) never waits on a measurement', () => {
  const c = clock();
  const g = G.createGate({ now: c.now, proof: false, fit: false });
  g.pointerEnter();
  c.advance(G.DWELL_MS);
  assert.equal(g.allows(pointer), true);
  g.setFit(false);
  assert.equal(g.allows(pointer), true, 'setFit is ignored where the rule does not apply');
});

test('item 3: a click within 300 ms of the pointer entering is ignored; leaving resets it', () => {
  const c = clock();
  const g = G.createGate({ now: c.now });
  g.setFit(true);
  g.observe(SEEN);
  c.advance(G.VISIBLE_MS);
  assert.equal(g.allows(pointer), false, 'no pointer in the frame yet');
  g.pointerEnter();
  c.advance(299);
  assert.equal(g.allows(pointer), false, '299 ms after entering');
  c.advance(1);
  assert.equal(g.allows(pointer), true, '300 ms after entering');
  g.pointerEnter();
  assert.equal(g.allows(pointer), true, 'another move inside does not restart the dwell');
  g.pointerLeave();
  g.pointerEnter();
  assert.equal(g.allows(pointer), false, 'leaving and coming back does');
});

test('item 4: a click within 600 ms of new content, a visibilitychange or a focus is ignored', () => {
  const { c, g } = ready();
  assert.equal(g.allows(pointer), true);
  g.content();
  assert.equal(g.allows(pointer), false, 'at once');
  assert.equal(g.allows({ acting: false }), false, 'every button');
  c.advance(599);
  assert.equal(g.allows(pointer), false);
  assert.equal(g.wakeIn(), 1);
  c.advance(1);
  assert.equal(g.allows(pointer), true, 'after 600 ms');
});

test('item 5: Enter or Space acts only after focus came by Tab or the pointer inside the frame', () => {
  const { g } = ready();
  const key = { acting: true, keyboard: true };
  assert.equal(g.allows(key), false, 'no default focus: nothing focused by the user yet');
  g.focusArrived('other');
  assert.equal(g.allows(key), false, 'focus that arrived by script');
  g.focusArrived('tab');
  assert.equal(g.allows(key), true, 'by Tab');
  g.blurred();
  assert.equal(g.allows(key), false, 'focus left the frame');
  g.focusArrived('pointer');
  assert.equal(g.allows(key), true, 'by the pointer');
  g.content();
  assert.equal(g.allows(key), false, 'the cooldown holds for keys too');
});

test('createGate refuses a clock that is not a function', () => {
  assert.throws(() => G.createGate({ now: 5 }), TypeError);
});
