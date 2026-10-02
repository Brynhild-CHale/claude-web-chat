// The chat chrome's registration slots (public/app/chat-slots.js), in plain
// node: the registry is DOM-free and imports only the chrome bus, so it loads
// with no jsdom at all — which is also the point of its one import.
//
// What is pinned: the socket's posture has one owner, the registry, and it
// speaks (chrome-bus `chat:posture`) only when the posture actually moves; the
// one Escape step the chat views get goes to the open view that takes it; and
// every register function hands back an unregister that works — including when
// a later registration has taken its slot, where it must do nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(REPO, 'public/app', rel)).href);

let slots, bus;
test.before(async () => {
  slots = await load('chat-slots.js');
  ({ bus } = await load('bus.js'));
});

// A chat view the test opens and closes by hand. `escape` answers what the test
// says it should, and every call is counted.
function fakeView(id, { open = false, takesEscape = true } = {}) {
  const v = {
    id, open, takesEscape, escapes: 0, closes: 0,
    isOpen() { return v.open; },
    escape() { v.escapes++; if (v.takesEscape) v.open = false; return v.takesEscape; },
    close() { v.closes++; v.open = false; },
  };
  return v;
}

// Register for the length of one test only, so no view leaks into the next and
// the registry's posture is back to 'status' when the test ends.
function register(t, view) {
  const reg = slots.registerChatView(view);
  t.after(() => reg.unregister());
  return reg;
}

function postures(t) {
  const seen = [];
  t.after(bus.on('chat:posture', (d) => seen.push(d.posture)));
  return seen;
}

test('the registry imports nothing but the chrome bus', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/chat-slots.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./bus.js'], 'chat-slots.js stays DOM-free: its one import is bus.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|\bHTMLElement\b/, 'and its code touches no DOM');
});

test('a view\'s changed() recomputes the posture and announces it only when it moves', (t) => {
  assert.equal(slots.posture(), 'status', 'precondition: no view is open');
  const seen = postures(t);
  const dock = fakeView('dock');
  const reg = register(t, dock);
  assert.deepEqual(seen, [], 'registering a closed view moves nothing');

  dock.open = true;
  assert.equal(reg.changed(), 'full');
  assert.deepEqual(seen, ['full'], 'opening announces full');
  reg.changed();
  reg.changed();
  assert.deepEqual(seen, ['full'], 'and only once: a changed() with nothing changed says nothing');

  dock.open = false;
  assert.equal(reg.changed(), 'status');
  assert.deepEqual(seen, ['full', 'status'], 'closing announces status');
  reg.changed();
  assert.deepEqual(seen, ['full', 'status']);
});

test('the posture is full while ANY view is open, so one view closing does not drop it', (t) => {
  const seen = postures(t);
  const dock = fakeView('dock');
  const sheet = fakeView('sheet');
  const d = register(t, dock);
  const s = register(t, sheet);

  dock.open = true; d.changed();
  sheet.open = true; s.changed();
  assert.deepEqual(seen, ['full'], 'a second open view is not a second announcement');
  dock.open = false; d.changed();
  assert.equal(slots.posture(), 'full', 'the sheet is still open');
  assert.deepEqual(seen, ['full'], 'so nothing is announced');
  sheet.open = false; s.changed();
  assert.deepEqual(seen, ['full', 'status']);
});

test('unregistering an open view takes its posture with it', (t) => {
  const seen = postures(t);
  const dock = fakeView('dock', { open: true });
  const reg = register(t, dock);
  assert.deepEqual(seen, ['full'], 'a view registered open is counted at once');
  reg.unregister();
  assert.deepEqual(seen, ['full', 'status'], 'and its unregister recomputes');
  assert.deepEqual(slots.chatViews(), [], 'it is gone from the list');
  reg.unregister();
  assert.deepEqual(seen, ['full', 'status'], 'a second unregister is a no-op');
  dock.open = true;
  assert.equal(reg.changed(), 'status', 'a stale handle reports the posture…');
  assert.deepEqual(seen, ['full', 'status'], '…and announces nothing: it speaks for no view any more');
});

test('escapeChatViews: the open view that takes the Escape handles it, and says so', (t) => {
  const seen = postures(t);
  assert.equal(slots.escapeChatViews(), false, 'no view registered: nothing handled it');

  const closed = fakeView('sheet');
  const dock = fakeView('dock', { open: true });
  const d = register(t, closed);
  register(t, dock);
  d.changed();
  assert.equal(slots.escapeChatViews(), true, 'the open dock took it');
  assert.equal(dock.escapes, 1);
  assert.equal(closed.escapes, 0, 'a closed view is never asked');
  assert.equal(slots.posture(), 'status', 'the dock closed itself on that Escape');
  assert.deepEqual(seen, ['full', 'status'], 'and the registry announced it, without the view calling changed()');

  assert.equal(slots.escapeChatViews(), false, 'nothing open now: the Escape falls through');
  assert.equal(dock.escapes, 1);
});

test('escapeChatViews: a view that declines (a window without focus) leaves the Escape unhandled', (t) => {
  const win = fakeView('dock', { open: true, takesEscape: false });
  register(t, win);
  assert.equal(slots.escapeChatViews(), false);
  assert.equal(win.escapes, 1, 'it was asked');
  assert.equal(slots.posture(), 'full', 'and stays open');
});

test('escapeChatViews: a view whose escape throws is reported, and the next open view is asked', (t) => {
  const errors = [];
  const saved = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  t.after(() => { console.error = saved; });
  const broken = fakeView('broken', { open: true });
  broken.escape = () => { throw new Error('boom'); };
  const sheet = fakeView('sheet', { open: true });
  register(t, broken);
  register(t, sheet);
  assert.equal(slots.escapeChatViews(), true, 'the sheet still took it');
  assert.equal(sheet.escapes, 1);
  assert.equal(errors.length, 1, 'the failure was reported once');
  assert.match(errors[0], /chat view 'broken': escape\(\) failed/);
});

test('closeChatViews closes every open view, and the posture follows', (t) => {
  const seen = postures(t);
  const dock = fakeView('dock', { open: true });
  const sheet = fakeView('sheet');
  register(t, dock);
  register(t, sheet);
  assert.equal(slots.closeChatViews(), true);
  assert.equal(dock.closes, 1);
  assert.equal(sheet.closes, 0, 'a closed view is left alone');
  assert.deepEqual(seen, ['full', 'status']);
  assert.equal(slots.closeChatViews(), false, 'nothing was open the second time');
});

test('chatViews lists every view with whether it is open, in registration order', (t) => {
  assert.deepEqual(slots.chatViews(), []);
  const dock = fakeView('dock', { open: true });
  register(t, dock);
  register(t, fakeView('sheet'));
  const list = slots.chatViews();
  assert.deepEqual(list.map((v) => ({ ...v })), [{ id: 'dock', open: true }, { id: 'sheet', open: false }]);
  assert.ok(Object.isFrozen(list[0]), 'a snapshot: the caller cannot reach into the registry through it');
  // A view whose isOpen throws counts as closed, and does not hide the others.
  const errors = [];
  const saved = console.error;
  console.error = (...a) => errors.push(a);
  t.after(() => { console.error = saved; });
  dock.isOpen = () => { throw new Error('no'); };
  assert.deepEqual(slots.chatViews().map((v) => v.open), [false, false]);
  assert.equal(slots.posture(), 'status');
  assert.ok(errors.length >= 1, 'the failure was reported');
});

test('a view registered again under its id replaces the earlier registration', (t) => {
  const seen = postures(t);
  const first = fakeView('dock', { open: true });
  const a = register(t, first);
  const second = fakeView('dock');
  const b = register(t, second);
  assert.deepEqual(slots.chatViews().map((v) => v.id), ['dock'], 'one view per id');
  assert.deepEqual(seen, ['full', 'status'], 'the replacement is closed, so the posture fell back');
  a.unregister();
  assert.deepEqual(slots.chatViews().map((v) => v.id), ['dock'], 'the replaced handle cannot remove its successor');
  b.unregister();
  assert.deepEqual(slots.chatViews(), []);
});

test('registerComposer returns a working unregister, and a later composer takes the slot', () => {
  assert.equal(slots.composer(), null);
  const a = { mount() {}, focus() {}, escape() { return false; } };
  const offA = slots.registerComposer(a);
  assert.equal(slots.composer(), a);
  offA();
  assert.equal(slots.composer(), null, 'unregistered');

  const offA2 = slots.registerComposer(a);
  const b = { mount() {}, focus() {}, escape() { return true; } };
  const offB = slots.registerComposer(b);
  assert.equal(slots.composer(), b, 'the later registration holds the slot');
  offA2();
  assert.equal(slots.composer(), b, 'the replaced composer\'s unregister does not evict its successor');
  offB();
  assert.equal(slots.composer(), null);
});

test('registerApprovals returns a working unregister, and a later one takes the slot', () => {
  assert.equal(slots.approvals(), null);
  const make = () => ({ mountBar() { return true; }, mountCard() { return true; }, mountSheet() { return true; }, unmount() {} });
  const a = make();
  const b = make();
  const offA = slots.registerApprovals(a);
  assert.equal(slots.approvals(), a);
  const offB = slots.registerApprovals(b);
  assert.equal(slots.approvals(), b);
  offA();
  assert.equal(slots.approvals(), b);
  offB();
  assert.equal(slots.approvals(), null);
});

test('a registration missing part of its contract is refused at once, not at the first call', () => {
  assert.throws(() => slots.registerComposer({ mount() {}, focus() {} }), /registerComposer: escape must be a function/);
  assert.throws(() => slots.registerComposer(null), /registerComposer: expects an object/);
  assert.throws(() => slots.registerApprovals({ mountBar() {} }),
    /registerApprovals: mountCard, mountSheet, unmount must be functions/);
  assert.throws(() => slots.registerChatView({ isOpen() {}, escape() {}, close() {} }),
    /registerChatView: id must be a non-empty string/);
  assert.throws(() => slots.registerChatView({ id: 'dock', isOpen() {}, close() {} }),
    /registerChatView: escape must be a function/);
  assert.equal(slots.composer(), null, 'a refused registration takes no slot');
  assert.deepEqual(slots.chatViews(), []);
});
