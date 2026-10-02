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

// ── tool-input ──────────────────────────────────────────────────────────────

const {
  PROFILES, MIRROR_MAX_BYTES, DISPLAY_MAX_BYTES, SUBJECT_MAX, LABEL_MAX, CALL_MAX,
  projectToolInput, toolKind, toolSubject, stepLabel, callLabel, fileOf, inputHash,
} = require('../lib/core/tool-input');

const mirror = (name, input) => projectToolInput(name, input, { profile: 'mirror' });
const display = (name, input) => projectToolInput(name, input, { profile: 'display' });
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v));
const chars = (s) => Array.from(s).length;

test('projectToolInput (mirror): Bash keeps its command, description, background flag and timeout', () => {
  const full = { command: 'x'.repeat(2500), description: 'Run it', run_in_background: true, timeout: 600000, dangerouslyDisableSandbox: true };
  assert.deepStrictEqual(mirror('Bash', full), {
    input: { command: 'x'.repeat(2000), description: 'Run it', run_in_background: true, timeout: 600000 },
    truncated: ['command'],
  });
  assert.deepStrictEqual(mirror('Bash', { command: 'npm test' }), { input: { command: 'npm test' }, truncated: [] });
});

test('projectToolInput (mirror): file tools carry the path and their strings\' sizes, never the text', () => {
  assert.deepStrictEqual(mirror('Read', { file_path: '/r/a.js', offset: 10, limit: 20 }).input, { file_path: '/r/a.js' });

  const edit = mirror('Edit', { file_path: '/r/QueueRail.tsx', old_string: 'secret-old é', new_string: 'secret-new', replace_all: true });
  assert.deepStrictEqual(edit, { input: { file_path: '/r/QueueRail.tsx', old_string_bytes: 13, new_string_bytes: 10 }, truncated: [] });
  assert.ok(!JSON.stringify(edit).includes('secret'));

  // A 5 MB Write projects to its path and a number.
  const write = mirror('Write', { file_path: '/r/big.bin', content: 'w'.repeat(5 * 1024 * 1024) });
  assert.deepStrictEqual(write, { input: { file_path: '/r/big.bin', content_bytes: 5 * 1024 * 1024 }, truncated: [] });
  assert.ok(jsonBytes(write.input) < 100);

  assert.deepStrictEqual(mirror('MultiEdit', {
    file_path: '/r/m.ts', edits: [{ old_string: 'a', new_string: 'bb', replace_all: true }, { old_string: 'ccc', new_string: 'd' }],
  }), { input: { file_path: '/r/m.ts', edits_count: 2, old_string_bytes: 4, new_string_bytes: 3 }, truncated: [] });

  assert.deepStrictEqual(mirror('NotebookEdit', {
    notebook_path: '/r/n.ipynb', cell_id: 'c1', cell_type: 'code', edit_mode: 'replace', new_source: 'print(1)',
  }).input, { notebook_path: '/r/n.ipynb', cell_id: 'c1', cell_type: 'code', edit_mode: 'replace', new_source_bytes: 8 });
});

test('projectToolInput (mirror): every other built-in keeps its allowlist, cut at its caps', () => {
  const cases = [
    ['Grep', { pattern: 'p'.repeat(600), path: '/r', glob: '*.js', output_mode: 'content', '-n': true },
      { pattern: 'p'.repeat(500), path: '/r', glob: '*.js' }, ['pattern']],
    ['Glob', { pattern: '**/*.ts', path: '/r' }, { pattern: '**/*.ts', path: '/r' }, []],
    ['WebFetch', { url: 'https://docs.example.com/x', prompt: 'summarize it' }, { url: 'https://docs.example.com/x' }, []],
    ['WebSearch', { query: 'node 22', allowed_domains: ['nodejs.org'] }, { query: 'node 22' }, []],
    ['Agent', { description: 'Explore rail tests', subagent_type: 'Explore', run_in_background: true, prompt: 'q'.repeat(400), model: 'haiku' },
      { description: 'Explore rail tests', subagent_type: 'Explore', run_in_background: true, prompt: 'q'.repeat(300) }, ['prompt']],
    ['Skill', { skill: 'capture-profile', args: 'a'.repeat(250) }, { skill: 'capture-profile', args: 'a'.repeat(200) }, ['args']],
    ['Monitor', { description: 'build errors', command: 'c'.repeat(600), timeout_ms: 300000 },
      { description: 'build errors', command: 'c'.repeat(500) }, ['command']],
    ['TaskStop', { task_id: 'bdz1n2' }, { task_id: 'bdz1n2' }, []],
    ['TaskStop', { shell_id: 'old1' }, { shell_id: 'old1' }, []],
    ['ExitPlanMode', { plan: '# The plan\n\nSteps.', planFilePath: '/h/.claude/plans/p.md' }, { planFilePath: '/h/.claude/plans/p.md' }, []],
    ['TodoWrite', { todos: [{ content: 'Write tests', status: 'completed', activeForm: 'Writing tests' }] },
      { todos: [{ content: 'Write tests', status: 'completed' }] }, []],
  ];
  for (const [name, input, want, cut] of cases) {
    assert.deepStrictEqual(mirror(name, input), { input: want, truncated: cut }, name);
  }
});

test('projectToolInput (mirror): AskUserQuestion keeps headers, questions and option labels', () => {
  const q = (n) => ({ header: `H${n}`, question: `Question ${n}?`, multiSelect: false, options: [{ label: 'Yes', description: 'go ahead' }, { label: 'No', description: 'stop' }] });
  assert.deepStrictEqual(mirror('AskUserQuestion', { questions: [q(1)] }), {
    input: { questions: [{ header: 'H1', question: 'Question 1?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    truncated: [],
  });
  const five = mirror('AskUserQuestion', { questions: [q(1), q(2), q(3), q(4), q(5)] });
  assert.strictEqual(five.input.questions.length, 4);
  assert.deepStrictEqual(five.truncated, ['questions']);
});

test('projectToolInput (mirror): an MCP or unknown tool keeps top-level scalars only, sixteen of them, strings at 200', () => {
  const input = { id: 'p1', html: 'h'.repeat(300), place: { span: 6 }, signals: [{ key: 'go' }], force: false, none: null };
  for (let n = 0; n < 14; n++) input[`k${n}`] = n;
  const r = mirror('mcp__web-chat__render', input);
  assert.deepStrictEqual(Object.keys(r.input), ['id', 'html', 'force', 'none', ...Array.from({ length: 12 }, (_, n) => `k${n}`)]);
  assert.strictEqual(r.input.html, 'h'.repeat(200));
  // Leaving out the nested values is the allowlist, not a cut; html and the
  // two keys past sixteen are cuts.
  assert.deepStrictEqual(r.truncated, ['html', 'k12', 'k13']);
  assert.deepStrictEqual(mirror('SomeNewTool', { note: 'n', deep: { a: 1 } }), { input: { note: 'n' }, truncated: [] });
});

test('projectToolInput (mirror): the JSON never passes 8 KB, and whatever the bound cut is named', () => {
  // A control character is six bytes of JSON.
  const ctrl = mirror('Bash', { command: '\u0001'.repeat(5000), description: 'd' });
  assert.ok(jsonBytes(ctrl.input) <= MIRROR_MAX_BYTES);
  assert.strictEqual(ctrl.input.description, 'd');
  assert.deepStrictEqual(ctrl.truncated, ['command']);

  // Sixteen keys of 200 CJK characters are 9.6 KB of UTF-8.
  const cjk = {};
  for (let n = 0; n < 16; n++) cjk[`k${n}`] = '漢'.repeat(200);
  const r = mirror('mcp__s__t', cjk);
  assert.ok(jsonBytes(r.input) <= MIRROR_MAX_BYTES);
  assert.strictEqual(Object.keys(r.input).length, 16);
  assert.ok(r.truncated.length > 0 && r.truncated.every((k) => Object.hasOwn(cjk, k)));

  // Keys too long to keep are dropped, and named (cut to 100 characters).
  const keys = {};
  for (let n = 0; n < 10; n++) keys[`${'k'.repeat(2000)}${n}`] = 1;
  const huge = mirror('mcp__s__t', keys);
  assert.ok(jsonBytes(huge.input) <= MIRROR_MAX_BYTES);
  assert.strictEqual(Object.keys(huge.input).length + huge.truncated.length, 10);
  assert.ok(huge.truncated.every((k) => chars(k) === 100 && k.endsWith('…')));

  const ask = { questions: Array.from({ length: 4 }, () => ({ header: '漢'.repeat(60), question: '漢'.repeat(300), options: Array.from({ length: 6 }, () => ({ label: '漢'.repeat(100) })) })) };
  const asked = mirror('AskUserQuestion', ask);
  assert.ok(jsonBytes(asked.input) <= MIRROR_MAX_BYTES);
  assert.deepStrictEqual(asked.truncated, ['questions']);
});

test('projectToolInput (display): every field is shown; the long ones get room', () => {
  const bash = display('Bash', { command: 'x'.repeat(8500), description: 'Run it', timeout: 1000, dangerouslyDisableSandbox: true });
  assert.strictEqual(bash.input.command, 'x'.repeat(8000));
  assert.strictEqual(bash.input.dangerouslyDisableSandbox, true, 'a field the approver must see is never left out');
  assert.strictEqual(bash.input.timeout, 1000);
  assert.deepStrictEqual(bash.truncated, ['command']);
  assert.deepStrictEqual(display('Bash', { command: 'npm test' }), { input: { command: 'npm test' }, truncated: [] });

  const edit = display('Edit', { file_path: '/r/a.js', old_string: 'o'.repeat(4100), new_string: 'n', replace_all: true });
  assert.deepStrictEqual(edit, {
    input: { file_path: '/r/a.js', old_string: 'o'.repeat(4000), new_string: 'n', replace_all: true },
    truncated: ['old_string'],
  });

  const write = display('Write', { file_path: '/r/big.bin', content: 'w'.repeat(5 * 1024 * 1024) });
  assert.deepStrictEqual(write, {
    input: { file_path: '/r/big.bin', content: 'w'.repeat(4000), content_bytes: 5 * 1024 * 1024 },
    truncated: ['content'],
  });
  assert.deepStrictEqual(display('Write', { file_path: '/r/a.txt', content: 'hé' }), {
    input: { file_path: '/r/a.txt', content: 'hé', content_bytes: 3 }, truncated: [],
  });

  assert.deepStrictEqual(display('Read', { file_path: '/r/a.js', offset: 10, limit: 20 }).input, { file_path: '/r/a.js', offset: 10, limit: 20 });
  assert.deepStrictEqual(display('WebFetch', { url: 'https://e.com/', prompt: 'summarize' }).input, { url: 'https://e.com/', prompt: 'summarize' });
  assert.deepStrictEqual(display('ExitPlanMode', { plan: '# Plan', planFilePath: '/p.md' }), { input: { planFilePath: '/p.md', plan_bytes: 6 }, truncated: [] });
});

test('projectToolInput (display): MCP strings stop at 1,000, nested values are shown, and so is an own __proto__ key', () => {
  const r = display('mcp__web-chat__render', {
    id: 'p1', html: 'h'.repeat(1200), place: { span: 6, rows: 4 }, signals: [{ key: 'go', wake: 'queue' }],
  });
  assert.deepStrictEqual(r, {
    input: { id: 'p1', html: 'h'.repeat(1000), place: { span: 6, rows: 4 }, signals: [{ key: 'go', wake: 'queue' }] },
    truncated: ['html'],
  });
  const proto = display('mcp__s__t', JSON.parse('{"__proto__":{"x":1},"a":1}'));
  assert.ok(Object.hasOwn(proto.input, '__proto__'));
  assert.strictEqual(JSON.stringify(proto.input), '{"__proto__":{"x":1},"a":1}');
  assert.deepStrictEqual(proto.truncated, []);
});

test('projectToolInput (display): a computed size never hides an input field of the same name', () => {
  const r = display('Write', { file_path: '/r/a', content: 'abc', content_bytes: 99 });
  assert.strictEqual(r.input.content_bytes, 3);
  assert.deepStrictEqual(r.truncated, ['content_bytes']);
});

test('projectToolInput (display): a request too big to show whole stays bounded and says so', () => {
  const flood = {};
  for (let n = 0; n < 200; n++) flood[`f${n}`] = '\u0002'.repeat(1000);
  const r = display('mcp__s__t', flood);
  assert.ok(jsonBytes(r.input) <= DISPLAY_MAX_BYTES);
  assert.strictEqual(r.truncated.length, 65);
  assert.strictEqual(r.truncated[64], '…');
  let deep = { v: 1 };
  for (let n = 0; n < 10; n++) deep = { d: deep };
  assert.deepStrictEqual(display('mcp__s__t', { deep }).truncated, ['deep']);
});

test('projectToolInput: truncated names every cut field, in input order', () => {
  assert.deepStrictEqual(mirror('Bash', { description: 'd'.repeat(400), timeout: 1, command: 'c'.repeat(3000) }).truncated, ['description', 'command']);
  assert.deepStrictEqual(display('Edit', { new_string: 'n'.repeat(5000), file_path: '/a', old_string: 'o'.repeat(5000) }).truncated, ['new_string', 'old_string']);
});

test('projectToolInput: a non-object input projects to nothing, and the profile is required', () => {
  for (const v of [null, undefined]) {
    assert.deepStrictEqual(mirror('Bash', v), { input: {}, truncated: [] });
    assert.deepStrictEqual(display('Bash', v), { input: {}, truncated: [] });
  }
  for (const v of ['rm -rf /', ['a'], 7]) {
    assert.deepStrictEqual(mirror('Bash', v), { input: {}, truncated: [] });
    assert.deepStrictEqual(display('Bash', v), { input: {}, truncated: ['…'] }, 'nothing could be shown, so it is not complete');
  }
  assert.deepStrictEqual([...PROFILES], ['mirror', 'display']);
  for (const opts of [undefined, {}, { profile: 'full' }]) {
    assert.throws(() => projectToolInput('Bash', { command: 'ls' }, opts), TypeError);
  }
});

test('toolKind: the head word, always a plain word that a basic viewer may be shown', () => {
  const cases = {
    Edit: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit', Write: 'Write', Read: 'Read', Bash: 'Bash',
    Grep: 'Grep', Glob: 'Glob', WebFetch: 'Web', WebSearch: 'Search', Agent: 'Agent', Skill: 'Skill',
    TodoWrite: 'Todo', Monitor: 'Monitor', TaskStop: 'Stop', AskUserQuestion: 'Question', ExitPlanMode: 'Plan',
    'mcp__web-chat__render': 'MCP', mcp__claude_ai_Notion__search: 'MCP', mcp__: 'MCP',
    Workflow: 'Workflow', CronCreate: 'CronCreate',
    'weird name!': 'Tool', a__b: 'Tool', ['x'.repeat(30)]: 'Tool', '': 'Tool', constructor: 'constructor',
  };
  for (const [name, want] of Object.entries(cases)) assert.strictEqual(toolKind(name), want, name);
  for (const v of [undefined, null, 42]) assert.strictEqual(toolKind(v), 'Tool');
  // The basic projection's `word` type: a kind of any other shape would be dropped there.
  for (const name of [...Object.keys(cases), undefined]) {
    const k = toolKind(name);
    assert.match(k, /^[A-Za-z][A-Za-z0-9_-]{0,23}$/);
    assert.ok(!k.includes('__'));
  }
});

test('toolSubject: a command\'s first line, a basename, the pattern, the URL\'s host, the description', () => {
  const cases = [
    ['Bash', { command: 'npm test' }, 'npm test'],
    ['Bash', { command: '\n  cd x\n\nnpm   test\n' }, 'cd x …'],
    ['Bash', { command: '   ', description: 'List files' }, 'List files'],
    ['Read', { file_path: '/repo/src/QueueRail.tsx' }, 'QueueRail.tsx'],
    ['Write', { file_path: 'C:\\Users\\me\\notes.md', content: 'x' }, 'notes.md'],
    ['Edit', { file_path: '/repo/dir/' }, 'dir'],
    ['NotebookEdit', { notebook_path: '/n/a.ipynb' }, 'a.ipynb'],
    ['Grep', { pattern: 'railState', path: '/r' }, 'railState'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['WebFetch', { url: 'https://user:secret@docs.example.com:8443/a?b=c' }, 'docs.example.com:8443'],
    ['WebFetch', { url: 'not a url' }, ''],
    ['WebSearch', { query: 'node 22 release' }, 'node 22 release'],
    ['Agent', { description: 'Explore rail tests', prompt: 'long' }, 'Explore rail tests'],
    ['Skill', { skill: 'capture-profile', args: 'x' }, 'capture-profile'],
    ['Monitor', { description: 'build errors', command: 'tail -f log' }, 'build errors'],
    ['TaskStop', { task_id: 'bdz1n2' }, 'bdz1n2'],
    ['AskUserQuestion', { questions: [{ header: 'Ship', question: 'Ship it?' }] }, 'Ship it?'],
    ['TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'in_progress' }] }, '1 / 3'],
    ['ExitPlanMode', { plan: 'p' }, ''],
    ['mcp__web-chat__use_component', { name: 'git-dashboard', id: 'gd' }, 'gd'],
    ['mcp__claude_ai_Notion__notion-search', { query: 'roadmap' }, 'roadmap'],
    ['mcp__claude-in-chrome__navigate', { url: 'https://example.com/x', tabId: 3 }, 'example.com'],
    ['mcp__s__t', { file_path: '/a/b/c.txt' }, 'c.txt'],
    ['mcp__s__t', {}, ''],
    ['TaskCreate', { subject: 'Fix login', description: 'details' }, 'Fix login'],
  ];
  for (const [name, input, want] of cases) assert.strictEqual(toolSubject(name, input), want, `${name} ${JSON.stringify(input)}`);
  const long = toolSubject('Bash', { command: 'y'.repeat(500) });
  assert.strictEqual(chars(long), SUBJECT_MAX);
  assert.ok(long.endsWith('…'));
  for (const v of [null, undefined, 'npm test']) assert.strictEqual(toolSubject('Bash', v), '');
});

test('stepLabel: the head word and the subject, as the bar and the stream show them', () => {
  const cases = [
    ['Edit', { file_path: '/repo/src/QueueRail.tsx', old_string: 'a', new_string: 'b' }, 'Edit · QueueRail.tsx'],
    ['MultiEdit', { file_path: '/repo/m.ts', edits: [] }, 'Edit · m.ts'],
    ['Bash', { command: 'npm test' }, 'Bash · npm test'],
    ['Write', { file_path: '/r/big.bin', content: 'w'.repeat(1024 * 1024) }, 'Write · big.bin'],
    ['WebFetch', { url: 'https://docs.example.com/guide' }, 'Web · docs.example.com'],
    ['WebSearch', { query: 'tokens' }, 'Search · tokens'],
    ['TaskStop', { task_id: 'bdz1n2' }, 'Stop · bdz1n2'],
    ['AskUserQuestion', { questions: [{ question: 'Ship it?' }] }, 'Question · Ship it?'],
    ['ExitPlanMode', { plan: 'p' }, 'Plan'],
    ['TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }, 'Todo · 1 / 2'],
    ['mcp__web-chat__render', { id: 'md-title', html: '<p>x</p>' }, 'web-chat · render · md-title'],
    ['mcp__claude_ai_Notion__notion-search', { query: 'roadmap' }, 'claude_ai_Notion · notion-search · roadmap'],
    ['mcp__s__t', {}, 's · t'],
    ['CronCreate', {}, 'CronCreate'],
    [undefined, {}, 'Tool'],
  ];
  for (const [name, input, want] of cases) assert.strictEqual(stepLabel(name, input), want, String(name));
  const long = stepLabel('Bash', { command: 'z'.repeat(500) });
  assert.strictEqual(chars(long), LABEL_MAX);
  assert.ok(long.startsWith('Bash · zzz') && long.endsWith('…'));
});

test('callLabel: the call as written, line breaks shown as ↵', () => {
  const cases = [
    ['Bash', { command: 'rm -rf dist && npm run build' }, 'Bash(rm -rf dist && npm run build)'],
    ['Bash', { command: 'cd x\n\n  npm test\n' }, 'Bash(cd x ↵ npm test)'],
    ['Edit', { file_path: '/repo/src/QueueRail.tsx' }, 'Edit(/repo/src/QueueRail.tsx)'],
    ['MultiEdit', { file_path: '/repo/m.ts' }, 'MultiEdit(/repo/m.ts)'],
    ['WebFetch', { url: 'https://docs.example.com/a?b=1' }, 'WebFetch(https://docs.example.com/a?b=1)'],
    ['Grep', { pattern: 'a|b' }, 'Grep(a|b)'],
    ['Monitor', { description: 'errors', command: 'tail -f log | grep --line-buffered ERROR' }, 'Monitor(tail -f log | grep --line-buffered ERROR)'],
    ['Monitor', { description: 'deploy events', ws: { url: 'wss://e.example.com/s' } }, 'Monitor(wss://e.example.com/s)'],
    ['ExitPlanMode', { plan: 'p' }, 'ExitPlanMode'],
    ['mcp__web-chat__render', { id: 'md-title' }, 'web-chat · render(md-title)'],
    ['CronCreate', {}, 'CronCreate'],
  ];
  for (const [name, input, want] of cases) assert.strictEqual(callLabel(name, input), want, name);
  const long = callLabel('Bash', { command: 'q'.repeat(1000) });
  assert.strictEqual(chars(long), CALL_MAX);
  assert.ok(long.startsWith('Bash(qqq') && long.endsWith('…)'));
});

test('fileOf: the one file a tool reads or writes, else null', () => {
  assert.strictEqual(fileOf('Read', { file_path: '/r/.env' }), '/r/.env');
  assert.strictEqual(fileOf('Edit', { file_path: '/r/a.js' }), '/r/a.js');
  assert.strictEqual(fileOf('MultiEdit', { file_path: '/r/m.js', edits: [] }), '/r/m.js');
  assert.strictEqual(fileOf('Write', { file_path: '/r/w.js', content: '' }), '/r/w.js');
  assert.strictEqual(fileOf('NotebookEdit', { notebook_path: '/r/n.ipynb' }), '/r/n.ipynb');
  for (const [name, input] of [
    ['Bash', { command: 'cat /r/.env' }],
    ['Grep', { pattern: 'x', path: '/r' }],
    ['ExitPlanMode', { planFilePath: '/h/plans/p.md' }],
    ['mcp__fs__read_file', { file_path: '/r/a' }],
    ['Read', { file_path: '' }],
    ['Read', { file_path: 7 }],
    ['Read', null],
    ['Read', '/r/a'],
    [undefined, { file_path: '/r/a' }],
  ]) assert.strictEqual(fileOf(name, input), null, `${name} ${JSON.stringify(input)}`);
});

test('inputHash: sha1 of stableStringify over the FULL input', () => {
  const input = { file_path: '/r/a.js', content: 'v1', nested: { b: 2, a: 1 } };
  assert.strictEqual(inputHash(input), crypto.createHash('sha1').update(stableStringify(input)).digest('hex'));
  assert.strictEqual(inputHash(input), inputHash({ nested: { a: 1, b: 2 }, content: 'v1', file_path: '/r/a.js' }));
  // Two writes the mirror cannot tell apart (same path, same size) still hash apart.
  const a = { file_path: '/r/a.js', content: 'v1' };
  const b = { file_path: '/r/a.js', content: 'v2' };
  assert.deepStrictEqual(mirror('Write', a), mirror('Write', b));
  assert.notStrictEqual(inputHash(a), inputHash(b));
  assert.match(inputHash({}), /^[0-9a-f]{40}$/);
});

test('labels: always a string within its bound, whatever the name and the input', () => {
  const names = [
    'Bash', 'Edit', 'WebFetch', 'AskUserQuestion', 'TodoWrite', 'Monitor', 'mcp__web-chat__render',
    `mcp__${'s'.repeat(500)}__${'t'.repeat(500)}`, 'n'.repeat(1000), 'two words', '', undefined, 7,
  ];
  const inputs = [
    {}, null, 'str', [1, 2], { command: 42 }, { file_path: ['x'] }, { url: 'ftp://h/x' },
    { questions: 'no' }, { todos: [null, 1] }, { ws: 'nope' }, { id: 'i'.repeat(2000), description: '\n\n' },
    { command: `${'a'.repeat(20000)}\n${'b'.repeat(10)}` },
  ];
  for (const name of names) {
    for (const input of inputs) {
      const where = `${String(name).slice(0, 20)} ${JSON.stringify(input).slice(0, 40)}`;
      assert.strictEqual(typeof toolKind(name), 'string', where);
      const subject = toolSubject(name, input);
      const step = stepLabel(name, input);
      const call = callLabel(name, input);
      assert.ok(typeof subject === 'string' && chars(subject) <= SUBJECT_MAX, where);
      assert.ok(typeof step === 'string' && step && chars(step) <= LABEL_MAX, where);
      assert.ok(typeof call === 'string' && call && chars(call) <= CALL_MAX, where);
      assert.ok(fileOf(name, input) === null || typeof fileOf(name, input) === 'string', where);
    }
  }
});
