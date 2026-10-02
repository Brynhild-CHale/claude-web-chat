// test/core-helpers.test.js — the three pure core helpers every 0.8.5 layer
// shares: lib/core/stable-json (both deterministic-JSON forms, by name),
// lib/core/prompt-class (the one prompt classifier and the composer marker) and
// lib/core/tool-input (the one per-tool field table).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { stableStringify, stableKey, stableHash } = require('../lib/core/stable-json');

// ── stable-json ─────────────────────────────────────────────────────────────
//
// Both forms moved into core byte-for-byte. The goldens below were captured
// from the ORIGINAL functions (lib/server/domain/turns.js:180-186 and
// lib/server/diff.js:13-25 at e707fc9) before those copies were removed, over
// the corpus here; a node digest and the pane-history hashes are pinned the
// same way. A change to any golden is a change to every graph on disk.

// <stable-json corpus>
// Every value both deterministic forms are pinned on. The quirks are pinned on
// purpose: the forms are byte-identical to the functions they replaced, and a
// "tidier" rewrite would differ exactly here.
const CORPUS = [
  ['null', null],
  ['a top-level undefined', undefined],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['negative zero', -0],
  ['a float', 1.5],
  ['a large exponent', 1e21],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['an empty string', ''],
  ['a plain string', 'plain'],
  ['quotes and a backslash', 'say "hi" \\ bye'],
  ['accents', 'héllo wörld'],
  ['an emoji (a surrogate pair)', '🙂 ok'],
  ['CJK', '漢字かな'],
  ['lone surrogates', 'a\ud800b\udc00c'],
  ['line and paragraph separators', 'line sep para'],
  ['control characters', '\u0000\u0001\b\t\n\f\r\u001f\u007f'],
  ['an empty object', {}],
  ['an empty array', []],
  ['keys out of order, nested', { b: 1, a: 2, c: { z: 1, y: [3, { q: 1, p: 2 }] } }],
  ['an undefined property', { a: undefined, b: null }],
  ['only an undefined property', { x: undefined }],
  ['nested arrays', [[1, [2, [3, []]]], [], [[]]]],
  ['undefined in an array', [undefined, 1, undefined]],
  ['a sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
  ['a function in an array', [() => 1, 2]],
  ['a function property', { f() { return 1; }, a: 1 }],
  ['a symbol property', { s: Symbol('x'), a: 1 }],
  ['integer-like keys', { 10: 'a', 2: 'b', 1: 'c', x: 'd', '-1': 'e', '01': 'f' }],
  ['unicode keys', { 'é': 1, e: 2, z: 3, '🙂': 4, Z: 5, '': 6 }],
  ['undefined nested in arrays and objects', { a: [undefined, { b: undefined, c: [undefined] }] }],
  ['a Date', { at: new Date(0) }],
  ['a Map and a Set', { m: new Map([['a', 1]]), s: new Set([1]) }],
  ['an own __proto__ key', JSON.parse('{"__proto__":{"x":1},"a":1}')],
  ['an own toJSON method', { toJSON() { return 'X'; }, a: 1 }],
  ['a pane record', {
    id: 'p1', html: '<div class="a">&amp; </script></div>', params: { k: [1, 'two', { three: 3 }] },
    pane_state: { colSpan: 6, pinned: true }, form_state: {}, component: undefined, theme: null,
  }],
  ['a store', { draft: 'typed text', count: 3, nested: { list: [{ id: 2 }, { id: 1 }], flag: false } }],
  ['a top-level function', () => 1],
];
// </stable-json corpus>

// <digest corpus>
// A committed node exercising every field the node digest reads: panes with
// absent SNAPSHOT_FIELDS (the turns form spells each as `"k":undefined`), an
// empty and a typed form_state, markdown, a custom order, Claude's baseline and
// a run flag, and a store with keys out of order.
const DIGEST_NODE = {
  id: 'n_golden', parent_id: null, created_at: 1700000000000, author: 'claude',
  trigger: { message: 'golden', summary: 's' },
  mounts: [
    { id: 'p2', html: '<p>two</p>', params: { b: 2, a: 1 }, pane_state: { colSpan: 6 }, form_state: {}, owner: 'claude' },
    { id: 'p1', html: '<p>ünï 🙂</p>', component: 'clock', form_state: { '#x:0': 'typed' }, theme: { tokens: { '--wc-bg': '#000' } } },
  ],
  markdown: [{ id: 'md-title', text: '# Title', owner: 'claude' }],
  order: ['md-title', 'p2', 'p1'],
  claude_order: ['md-title', 'p1', 'p2'],
  runs: { start: { stacks: false }, 'md-title': { stacks: false } },
  store: { b: [1, { y: 2, x: 1 }], a: 'é', u: null },
  comments: [{ seq: 1, text: 'c', anchor: { mount: 'p1' } }],
  captures: [],
};
// Pane versions for the pane-history hash (lineage specHash).
const SPEC_MOUNTS = [
  ['html and params', { html: '<p>a</p>', params: { k: 1 } }],
  ['a component, params out of order', { html: 'x', component: 'clock', params: { z: [1, { b: 2, a: 1 }], a: 'ü' } }],
  ['nothing', null],
  ['undefined params', { html: '<p>a</p>', params: undefined }],
];
// </digest corpus>

// <goldens: captured from the original functions at e707fc9 (lib/server/domain/turns.js:180-186, lib/server/diff.js:13-25)>
const GOLDEN_STRINGIFY = [
  "null", // null
  undefined, // a top-level undefined
  "true", // true
  "false", // false
  "0", // zero
  "0", // negative zero
  "1.5", // a float
  "1e+21", // a large exponent
  "null", // NaN
  "null", // Infinity
  "\"\"", // an empty string
  "\"plain\"", // a plain string
  "\"say \\\"hi\\\" \\\\ bye\"", // quotes and a backslash
  "\"h\u00e9llo w\u00f6rld\"", // accents
  "\"\ud83d\ude42 ok\"", // an emoji (a surrogate pair)
  "\"\u6f22\u5b57\u304b\u306a\"", // CJK
  "\"a\\ud800b\\udc00c\"", // lone surrogates
  "\"line\u2028sep\u2029para\"", // line and paragraph separators
  "\"\\u0000\\u0001\\b\\t\\n\\f\\r\\u001f\u007f\"", // control characters
  "{}", // an empty object
  "[]", // an empty array
  "{\"a\":2,\"b\":1,\"c\":{\"y\":[3,{\"p\":2,\"q\":1}],\"z\":1}}", // keys out of order, nested
  "{\"a\":undefined,\"b\":null}", // an undefined property
  "{\"x\":undefined}", // only an undefined property
  "[[1,[2,[3,[]]]],[],[[]]]", // nested arrays
  "[,1,]", // undefined in an array
  "[1,,3]", // a sparse array
  "[,2]", // a function in an array
  "{\"a\":1,\"f\":undefined}", // a function property
  "{\"a\":1,\"s\":undefined}", // a symbol property
  "{\"-1\":\"e\",\"01\":\"f\",\"1\":\"c\",\"10\":\"a\",\"2\":\"b\",\"x\":\"d\"}", // integer-like keys
  "{\"\":6,\"Z\":5,\"e\":2,\"z\":3,\"\u00e9\":1,\"\ud83d\ude42\":4}", // unicode keys
  "{\"a\":[,{\"b\":undefined,\"c\":[]}]}", // undefined nested in arrays and objects
  "{\"at\":{}}", // a Date
  "{\"m\":{},\"s\":{}}", // a Map and a Set
  "{\"__proto__\":{\"x\":1},\"a\":1}", // an own __proto__ key
  "{\"a\":1,\"toJSON\":undefined}", // an own toJSON method
  "{\"component\":undefined,\"form_state\":{},\"html\":\"<div class=\\\"a\\\">&amp; </script></div>\",\"id\":\"p1\",\"pane_state\":{\"colSpan\":6,\"pinned\":true},\"params\":{\"k\":[1,\"two\",{\"three\":3}]},\"theme\":null}", // a pane record
  "{\"count\":3,\"draft\":\"typed text\",\"nested\":{\"flag\":false,\"list\":[{\"id\":2},{\"id\":1}]}}", // a store
  undefined, // a top-level function
];
const GOLDEN_KEY = [
  "null", // null
  "\u0000undef", // a top-level undefined
  "true", // true
  "false", // false
  "0", // zero
  "0", // negative zero
  "1.5", // a float
  "1e+21", // a large exponent
  "null", // NaN
  "null", // Infinity
  "\"\"", // an empty string
  "\"plain\"", // a plain string
  "\"say \\\"hi\\\" \\\\ bye\"", // quotes and a backslash
  "\"h\u00e9llo w\u00f6rld\"", // accents
  "\"\ud83d\ude42 ok\"", // an emoji (a surrogate pair)
  "\"\u6f22\u5b57\u304b\u306a\"", // CJK
  "\"a\\ud800b\\udc00c\"", // lone surrogates
  "\"line\u2028sep\u2029para\"", // line and paragraph separators
  "\"\\u0000\\u0001\\b\\t\\n\\f\\r\\u001f\u007f\"", // control characters
  "{}", // an empty object
  "[]", // an empty array
  "{\"a\":2,\"b\":1,\"c\":{\"y\":[3,{\"p\":2,\"q\":1}],\"z\":1}}", // keys out of order, nested
  "{\"b\":null}", // an undefined property
  "{}", // only an undefined property
  "[[1,[2,[3,[]]]],[],[[]]]", // nested arrays
  "[null,1,null]", // undefined in an array
  "[1,null,3]", // a sparse array
  "[null,2]", // a function in an array
  "{\"a\":1}", // a function property
  "{\"a\":1}", // a symbol property
  "{\"1\":\"c\",\"2\":\"b\",\"10\":\"a\",\"-1\":\"e\",\"01\":\"f\",\"x\":\"d\"}", // integer-like keys
  "{\"\":6,\"Z\":5,\"e\":2,\"z\":3,\"\u00e9\":1,\"\ud83d\ude42\":4}", // unicode keys
  "{\"a\":[null,{\"c\":[null]}]}", // undefined nested in arrays and objects
  "{\"at\":{}}", // a Date
  "{\"m\":{},\"s\":{}}", // a Map and a Set
  "{\"a\":1}", // an own __proto__ key
  "\"X\"", // an own toJSON method
  "{\"form_state\":{},\"html\":\"<div class=\\\"a\\\">&amp; </script></div>\",\"id\":\"p1\",\"pane_state\":{\"colSpan\":6,\"pinned\":true},\"params\":{\"k\":[1,\"two\",{\"three\":3}]},\"theme\":null}", // a pane record
  "{\"count\":3,\"draft\":\"typed text\",\"nested\":{\"flag\":false,\"list\":[{\"id\":2},{\"id\":1}]}}", // a store
  undefined, // a top-level function
];
const GOLDEN_SNAPSHOT_VIEW = "{\"captures\":[],\"comments\":[{\"anchor\":{\"mount\":\"p1\"},\"seq\":1,\"text\":\"c\"}],\"layout\":{\"claude_order\":[\"md-title\",\"p1\",\"p2\"],\"runs\":{\"md-title\":{\"stacks\":false},\"start\":{\"stacks\":false}}},\"markdown\":[{\"id\":\"md-title\",\"owner\":\"claude\",\"text\":\"# Title\"}],\"mounts\":[{\"component\":\"clock\",\"form_state\":{\"#x:0\":\"typed\"},\"html\":\"<p>\u00fcn\u00ef \ud83d\ude42</p>\",\"id\":\"p1\",\"owner\":undefined,\"pane_state\":undefined,\"params\":undefined,\"target\":undefined,\"theme\":{\"tokens\":{\"--wc-bg\":\"#000\"}}},{\"component\":undefined,\"form_state\":undefined,\"html\":\"<p>two</p>\",\"id\":\"p2\",\"owner\":\"claude\",\"pane_state\":{\"colSpan\":6},\"params\":{\"a\":1,\"b\":2},\"target\":undefined,\"theme\":undefined}],\"order\":[\"md-title\",\"p2\",\"p1\"],\"store\":{\"a\":\"\u00e9\",\"b\":[1,{\"x\":1,\"y\":2}],\"u\":null}}";
const GOLDEN_NODE_VIEW_KEY = "1d680c6c92a546ff444bf8ae16a491ba9e19d1bb";
const GOLDEN_EMPTY_VIEW_KEY = "2ac80090431589de784325f8b186c65d21b9299c";
const GOLDEN_SPEC_HASH = [
  "1b127221980e535e", // html and params
  "5764738b0bcd937f", // a component, params out of order
  "bf21a9e8fbc5a384", // nothing
  "ec6ddba553aee5d8", // undefined params
];
// </goldens>

test('stable-json: stableStringify is byte-identical to the node digest form it replaced', () => {
  assert.strictEqual(GOLDEN_STRINGIFY.length, CORPUS.length);
  CORPUS.forEach(([label, v], i) => assert.strictEqual(stableStringify(v), GOLDEN_STRINGIFY[i], label));
});

test('stable-json: stableKey is byte-identical to the change-detection form it replaced', () => {
  assert.strictEqual(GOLDEN_KEY.length, CORPUS.length);
  CORPUS.forEach(([label, v], i) => assert.strictEqual(stableKey(v), GOLDEN_KEY[i], label));
});

test('stable-json: the two forms disagree on undefined, which is why both exist', () => {
  // The digest's form keeps an absent field in the string; change detection's drops it.
  assert.strictEqual(stableStringify({ a: undefined }), '{"a":undefined}');
  assert.strictEqual(stableKey({ a: undefined }), '{}');
  // Only change detection's tells a top-level undefined from null.
  assert.strictEqual(stableStringify(undefined), undefined);
  assert.notStrictEqual(stableKey(undefined), stableKey(null));
});

test('stable-json: key order never matters, in either form; array order does', () => {
  const a = { b: 1, a: { d: [1, { f: 2, e: 1 }], c: 'x' } };
  const b = { a: { c: 'x', d: [1, { e: 1, f: 2 }] }, b: 1 };
  assert.strictEqual(stableStringify(a), stableStringify(b));
  assert.strictEqual(stableKey(a), stableKey(b));
  assert.notStrictEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.notStrictEqual(stableKey([1, 2]), stableKey([2, 1]));
});

test('stable-json: JSON values only, so a BigInt throws in both forms, as it always did', () => {
  assert.throws(() => stableStringify({ a: 1n }), TypeError);
  assert.throws(() => stableKey({ a: 1n }), TypeError);
});

test('stable-json: stableHash is the sha1 of stableStringify; a top-level undefined hashes instead of throwing', () => {
  const v = { b: [1, 'é'], a: undefined };
  assert.strictEqual(stableHash(v), crypto.createHash('sha1').update(stableStringify(v)).digest('hex'));
  assert.match(stableHash(v), /^[0-9a-f]{40}$/);
  assert.strictEqual(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.strictEqual(stableHash(undefined), crypto.createHash('sha1').update('undefined').digest('hex'));
});

test('stable-json: lib/server/diff still exports the change-detection form as stableStringify', () => {
  assert.strictEqual(require('../lib/server/diff').stableStringify, stableKey);
});

test('stable-json: node digests and pane-history hashes are unchanged', () => {
  const { snapshotView, nodeViewKey } = require('../lib/server/domain/turns');
  const { specHash } = require('../lib/server/domain/lineage');
  assert.strictEqual(snapshotView(DIGEST_NODE), GOLDEN_SNAPSHOT_VIEW);
  assert.strictEqual(nodeViewKey(DIGEST_NODE), GOLDEN_NODE_VIEW_KEY);
  assert.strictEqual(nodeViewKey(null), GOLDEN_EMPTY_VIEW_KEY);
  assert.strictEqual(GOLDEN_SPEC_HASH.length, SPEC_MOUNTS.length);
  SPEC_MOUNTS.forEach(([label, m], i) => assert.strictEqual(specHash(m), GOLDEN_SPEC_HASH[i], label));
});

// ── prompt-class ────────────────────────────────────────────────────────────

const {
  PROMPT_CLASSES, promptLead, classifyPrompt, MESSAGE_MARKER_RE, messageMarker, messageMarkers,
} = require('../lib/core/prompt-class');

test('classifyPrompt: what the user typed is human, whatever it mentions later', () => {
  for (const text of [
    'Fix the retry logic',
    '  \n\tFix it',
    'Please look at how <task-notification> is parsed',
    'what does [Request interrupted mean?',
    // A typed slash command or bash line is not guessed at: only the harness's
    // own tags classify, and those are what the transcript and the hooks carry.
    '/clear',
    '!ls -la',
    // An empty prompt is an image sent alone.
    '',
    '   ',
  ]) assert.strictEqual(classifyPrompt(text), 'human', JSON.stringify(text));
});

test('classifyPrompt: each harness tag classifies the turn it opens', () => {
  const cases = [
    ['<task-notification>\n<task-id>bdz1n2</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>', 'task-notification'],
    ['\n  <task-notification><task-id>a1</task-id></task-notification>', 'task-notification'],
    ['﻿ <task-notification>', 'task-notification'],
    ['<channel source="web-chat" kind="batch" count="1" seq="4" origin="queue">Pushed from: origin=local</channel>', 'channel'],
    ['<channel>bare</channel>', 'channel'],
    ['<command-message>capture-profile</command-message>\n<command-name>/capture-profile</command-name>\n<command-args>x</command-args>', 'command'],
    ['<command-name>/clear</command-name>', 'command'],
    ['<bash-input>ls -la</bash-input>', 'shell'],
    ['<bash-stdout>total 0</bash-stdout><bash-stderr></bash-stderr>', 'shell'],
    ['<bash-stderr>nope</bash-stderr>', 'shell'],
    ['<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>', 'other'],
    ['<local-command-stderr>error</local-command-stderr>', 'other'],
    ['<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>', 'other'],
    ['<user-prompt-submit-hook>context</user-prompt-submit-hook>', 'other'],
    ['[Request interrupted by user]', 'other'],
    ['[Request interrupted by user for tool use]', 'other'],
    ['<system-reminder>note</system-reminder>', 'other'],
  ];
  for (const [text, want] of cases) assert.strictEqual(classifyPrompt(text), want, text.slice(0, 40));
});

test('classifyPrompt: anything that is not a string is other, and every answer is one of the six classes', () => {
  for (const v of [null, undefined, 42, true, ['<task-notification>'], { text: 'hi' }]) {
    assert.strictEqual(classifyPrompt(v), 'other');
  }
  assert.deepStrictEqual([...PROMPT_CLASSES], ['human', 'task-notification', 'channel', 'command', 'shell', 'other']);
  assert.ok(Object.isFrozen(PROMPT_CLASSES));
  for (const text of ['hi', '<channel x>', '<bash-input>', '<system-reminder>', '<command-name>', '<task-notification>']) {
    assert.ok(PROMPT_CLASSES.includes(classifyPrompt(text)));
  }
});

test('promptLead: the record classes of the validation inventory, one per leading tag', () => {
  const cases = [
    ['<task-notification>', 'task-notification'],
    ['<command-name>', 'slash-command'],
    ['<command-message>', 'slash-command'],
    ['<local-command-stdout>', 'local-command-output'],
    ['<local-command-stderr>', 'local-command-output'],
    ['<local-command-caveat>', 'local-command-caveat'],
    ['<bash-input>', 'bash-mode'],
    ['<bash-stdout>', 'bash-mode'],
    ['<bash-stderr>', 'bash-mode'],
    ['<channel source="web-chat">', 'channel'],
    ['<user-prompt-submit-hook>', 'hook-context'],
    ['[Request interrupted by user]', 'interrupt-marker'],
    ['<system-reminder>', 'system-reminder'],
  ];
  for (const [text, want] of cases) {
    assert.strictEqual(promptLead(text), want, text);
    assert.strictEqual(promptLead(`\n \t${text} trailing`), want, `${text}, after whitespace`);
  }
  for (const v of ['plain', '', '  ', ' x <task-notification>', null, undefined, 7]) assert.strictEqual(promptLead(v), null);
});

test('MESSAGE_MARKER_RE: the marker as the spec writes it', () => {
  assert.strictEqual(MESSAGE_MARKER_RE.source, String.raw`\[web-chat message (m-[0-9a-f]{8})\]`);
  assert.strictEqual(MESSAGE_MARKER_RE.flags, 'g');
  MESSAGE_MARKER_RE.lastIndex = 0;
  const found = [...'Message from the user [web-chat message m-3fa9c2d1]:\n> hi'.matchAll(MESSAGE_MARKER_RE)];
  assert.deepStrictEqual(found.map((m) => m[1]), ['m-3fa9c2d1']);
});

test('messageMarkers: finds every marker once, in order, and nothing that only looks like one', () => {
  const block = 'Message from the user [web-chat message m-3fa9c2d1]:\n> Tighten the retry logic.\n'
    + 'Stop request from the web-chat page [web-chat message m-7c1e09aa]: stop background task bdz1n2.\n'
    + 'again [web-chat message m-3fa9c2d1]';
  assert.deepStrictEqual(messageMarkers(block), ['m-3fa9c2d1', 'm-7c1e09aa']);
  for (const lookalike of [
    '[web-chat message m-3FA9C2D1]', // upper-case hex
    '[web-chat message m-3fa9c2d]', // seven digits
    '[web-chat message m-3fa9c2d12]', // nine
    '[web-chat message m-3fa9c2dz]', // not hex
    '(web-chat message m-3fa9c2d1)', // the defanged form a summary or note is given
    '[web-chat  message m-3fa9c2d1]',
    '[Web-chat message m-3fa9c2d1]',
    '[web-chat message 3fa9c2d1]',
    '[web-chat message: m-3fa9c2d1]',
    '[web-chat message m-3fa9c2d1',
    '[wc-msg m-3fa9c2d1]', // the markers the spec did not choose
    '[wc:m-3fa9c2d1]',
  ]) assert.deepStrictEqual(messageMarkers(lookalike), [], lookalike);
  for (const v of [null, undefined, 3, ['[web-chat message m-3fa9c2d1]']]) assert.deepStrictEqual(messageMarkers(v), []);
});

test('messageMarkers: a stray .exec() on the shared global regex does not hide a marker', () => {
  MESSAGE_MARKER_RE.lastIndex = 40;
  try {
    assert.deepStrictEqual(messageMarkers('[web-chat message m-00000000] at the very start'), ['m-00000000']);
    assert.strictEqual(MESSAGE_MARKER_RE.lastIndex, 40, 'the shared regex is left as it was');
  } finally {
    MESSAGE_MARKER_RE.lastIndex = 0;
  }
});

test('messageMarker: writes the marker the scanner finds, and refuses an id it never could', () => {
  assert.strictEqual(messageMarker('m-3fa9c2d1'), '[web-chat message m-3fa9c2d1]');
  assert.deepStrictEqual(messageMarkers(`Message from the user ${messageMarker('m-0a1b2c3d')}:`), ['m-0a1b2c3d']);
  for (const bad of ['m-3FA9C2D1', '3fa9c2d1', 'm-3fa9c2d', 'm-3fa9c2d1 ', '', null, undefined, 42]) {
    assert.throws(() => messageMarker(bad), TypeError, String(bad));
  }
});
