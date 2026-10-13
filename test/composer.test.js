// The composer's rules: lib/server/composer.js (spec §6.3, §6.1, §6.2, §6.5;
// ruling C2 (d)). Pure, so every rule is tested here without a route: the
// normalisation, the leading-skill parse, the limits, the files check, the
// edit's re-validation and the rate limiter, against fake adapters.
const test = require('node:test');
const assert = require('node:assert');

const composer = require('../lib/server/composer');
const {
  MESSAGE_MAX, SKILL_ARGS_MAX, FILES_MAX, PATH_MAX, QUEUED_MESSAGES_MAX, RATE_MAX, RATE_WINDOW_MS,
  SEND_MODES, BUILTIN_COMMANDS, REFUSALS, HINTS,
  normalizeText, parseLeadingSkill, classifySkill, validateMessage, validateEdit, createRateLimit,
} = composer;

// Characters the guard removes, built from numbers so no source line spells
// one (the bidi range is a conventions tripwire in lib/).
const ch = (cp) => String.fromCodePoint(cp);
const NUL = ch(0);
const ESC = ch(27);
const DEL = ch(127);
const LINE_SEP = ch(8232);
const BIDI_OVERRIDE = ch(8238);
const ZWSP = ch(8203);

// A fake catalog: the names it knows, the user-only ones, and whether it
// answers through a Promise. It records what it was asked.
function fakeSkills({ known = ['capture-profile', 'plugin:name', 'review'], userOnly = ['secret-deploy'], async = false } = {}) {
  const calls = [];
  return {
    calls,
    resolve(name, opts) {
      calls.push({ name, opts });
      const a = known.includes(name) ? 'skill' : userOnly.includes(name) ? 'user_only' : null;
      return async ? Promise.resolve(a) : a;
    },
  };
}

// A fake index: refusals by path, every other path ok with a fixed size.
function fakeFiles(refusals = {}, { async = false } = {}) {
  const calls = [];
  return {
    calls,
    check(rel) {
      calls.push(rel);
      const a = refusals[rel] ? { ok: false, ...refusals[rel] } : { ok: true, path: rel, bytes: 100 };
      return async ? Promise.resolve(a) : a;
    },
  };
}

const deps = (o = {}) => ({ skills: fakeSkills(), projectFiles: fakeFiles(), ...o });

// §6.3's list, written out here independently of the module.
const SPEC_BUILTINS = 'clear compact model resume exit quit config login logout rewind permissions add-dir mcp hooks agents init memory plugin export cost status context doctor help vim terminal-setup ide upgrade output-style statusline privacy-settings release-notes bug pr-comments install-github-app todos usage'.split(' ');

test('the limits are §6.3\'s numbers', () => {
  assert.equal(MESSAGE_MAX, 3000);
  assert.equal(SKILL_ARGS_MAX, 300);
  assert.equal(FILES_MAX, 5);
  assert.equal(PATH_MAX, 240);
  assert.equal(QUEUED_MESSAGES_MAX, 50);
  assert.equal(RATE_MAX, 30);
  assert.equal(RATE_WINDOW_MS, 60000);
  assert.deepStrictEqual([...SEND_MODES], ['auto', 'now', 'hold']);
  assert.equal(Object.isFrozen(SEND_MODES), true);
  assert.equal('ENVELOPE_MAX' in composer, false, 'ENVELOPE_MAX lives in lib/channel/envelope.js');
});

test('normalizeText: line breaks, the guard, trailing whitespace', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(normalizeText(`a${NUL}b${ESC}c${DEL}d${LINE_SEP}e${BIDI_OVERRIDE}f${ZWSP}g`), 'abcdefg');
  assert.equal(normalizeText('a\tb\nc'), 'a\tb\nc');
  assert.equal(normalizeText('    indented code\n  more   \n\n  \n'), '    indented code\n  more');
  assert.equal(normalizeText(42), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(null), '');
});

test('BUILTIN_COMMANDS is §6.3\'s 37 names, then plan, rename and recap, in order, frozen', () => {
  // U91 (ruled D-defaults (a), U91@builtin-additions; F1 (a)): the three
  // 2.1.296 built-ins §6.3's list predates are appended.
  assert.equal(SPEC_BUILTINS.length, 37);
  assert.deepStrictEqual([...BUILTIN_COMMANDS], [...SPEC_BUILTINS, 'plan', 'rename', 'recap']);
  assert.equal(Object.isFrozen(BUILTIN_COMMANDS), true);
  assert.throws(() => { 'use strict'; BUILTIN_COMMANDS.push('x'); });
});

test('parseLeadingSkill: the name ends at the first space or line break, the args are every line after it', () => {
  assert.deepStrictEqual(parseLeadingSkill('/capture-profile make one\nsecond line  '), { name: 'capture-profile', args: 'make one\nsecond line' });
  assert.deepStrictEqual(parseLeadingSkill('  /review\nthe args'), { name: 'review', args: 'the args' });
  assert.deepStrictEqual(parseLeadingSkill('/review'), { name: 'review', args: '' });
  assert.deepStrictEqual(parseLeadingSkill('/plugin:name x'), { name: 'plugin:name', args: 'x' });
  assert.equal(parseLeadingSkill(`/${'a'.repeat(65)} x`), null);
  assert.equal(parseLeadingSkill('/a/b x'), null);
  assert.equal(parseLeadingSkill('no slash'), null);
  assert.equal(parseLeadingSkill('text then /review'), null);
  assert.equal(parseLeadingSkill('/ review'), null);
  assert.equal(parseLeadingSkill(7), null);
});

test('classifySkill: builtin first, then the catalog, sync or a Promise; no catalog answers null', async () => {
  assert.equal(await classifySkill('clear', {}), 'builtin');
  assert.equal(await classifySkill('Clear', { skills: fakeSkills() }), 'builtin');
  assert.equal(await classifySkill('review', { skills: fakeSkills() }), 'skill');
  assert.equal(await classifySkill('review', { skills: fakeSkills({ async: true }) }), 'skill');
  assert.equal(await classifySkill('secret-deploy', { skills: fakeSkills() }), 'user_only');
  assert.equal(await classifySkill('nope', { skills: fakeSkills() }), null);
  assert.equal(await classifySkill('review', {}), null);
  const odd = { resolve: () => 'maybe' };
  assert.equal(await classifySkill('review', { skills: odd }), null);
  const throws = { resolve: () => { throw new Error('boom'); } };
  assert.equal(await classifySkill('review', { skills: throws }), null);
  const s = fakeSkills();
  await classifySkill('review', { skills: s, conversation_id: 'c-1' });
  assert.deepStrictEqual(s.calls, [{ name: 'review', opts: { conversation_id: 'c-1' } }]);
});

test('a leading skill is parsed from the text, which is kept as typed', async () => {
  const text = '/capture-profile make one for this site\nand keep the tables';
  const r = await validateMessage({ text }, deps());
  assert.equal(r.ok, true);
  assert.equal(r.message.text, text);
  assert.deepStrictEqual(r.message.skill, { name: 'capture-profile', args: 'make one for this site\nand keep the tables' });
  assert.equal(r.message.chars, text.length);
  assert.equal(r.message.send, 'auto');
  assert.equal(r.message.conversation_id, null);
  assert.deepStrictEqual(r.message.files, []);

  const next = await validateMessage({ text: '/capture-profile\nmake one for this site' }, deps());
  assert.deepStrictEqual(next.message.skill, { name: 'capture-profile', args: 'make one for this site' });
});

test('a parsed skill\'s long args are never too_large: past SKILL_ARGS_MAX they stay in the text', async () => {
  const long = `/review ${'x'.repeat(2900)}`;
  const r = await validateMessage({ text: long }, deps());
  assert.equal(r.ok, true);
  assert.deepStrictEqual(r.message.skill, { name: 'review', args_in_text: true });
  assert.equal(r.message.text, long);

  const at301 = await validateMessage({ text: `/review ${'y'.repeat(301)}` }, deps());
  assert.deepStrictEqual(at301.message.skill, { name: 'review', args_in_text: true });
  assert.equal('args' in at301.message.skill, false);

  const at300 = await validateMessage({ text: `/review ${'y'.repeat(300)}` }, deps());
  assert.deepStrictEqual(at300.message.skill, { name: 'review', args: 'y'.repeat(300) });
});

test('a leading built-in or user-only name is refused; an unknown one is plain text', async () => {
  const clear = await validateMessage({ text: '/clear' }, deps());
  assert.equal(clear.refused, 'builtin_command');
  assert.equal(clear.name, 'clear');
  assert.equal(clear.hint, '/clear is a Claude Code command: type it in the terminal.');

  const uo = await validateMessage({ text: '/secret-deploy now' }, deps());
  assert.equal(uo.refused, 'user_only_skill');
  assert.equal(uo.hint, 'Only you can run /secret-deploy: type it in the terminal.');

  const unknown = await validateMessage({ text: '/unknown x' }, deps());
  assert.equal(unknown.ok, true);
  assert.equal(unknown.message.skill, null);
  assert.equal(unknown.message.text, '/unknown x');

  const noCatalog = await validateMessage({ text: '/anything at all' }, { projectFiles: fakeFiles() });
  assert.equal(noCatalog.ok, true);
  assert.equal(noCatalog.message.skill, null);

  const plugin = await validateMessage({ text: '/plugin:name go' }, deps());
  assert.deepStrictEqual(plugin.message.skill, { name: 'plugin:name', args: 'go' });

  const s = fakeSkills();
  const tooLong = await validateMessage({ text: `/${'a'.repeat(65)} x` }, deps({ skills: s }));
  assert.equal(tooLong.ok, true);
  assert.equal(tooLong.message.skill, null);
  assert.equal(s.calls.length, 0, 'a name outside the grammar is never looked up');
});

test('the catalog is asked for the message\'s conversation', async () => {
  const s = fakeSkills();
  await validateMessage({ text: '/review x', conversation_id: 'conv_1' }, deps({ skills: s }));
  assert.deepStrictEqual(s.calls[0], { name: 'review', opts: { conversation_id: 'conv_1' } });
});

test('an explicit skill: unknown, built-in, user-only, its args\' limit, and the text left unparsed', async () => {
  assert.equal((await validateMessage({ skill: { name: 'nope' } }, deps())).refused, 'unknown_skill');
  assert.equal((await validateMessage({ skill: { name: 'bad name' } }, deps())).refused, 'unknown_skill');
  assert.equal((await validateMessage({ skill: { name: 'compact' } }, deps())).refused, 'builtin_command');
  assert.equal((await validateMessage({ skill: { name: 'secret-deploy' } }, deps())).refused, 'user_only_skill');

  const over = await validateMessage({ skill: { name: 'review', args: 'z'.repeat(301) } }, deps());
  assert.equal(over.refused, 'too_large');
  assert.equal(over.field, 'args');
  assert.equal(over.max, 300);

  const at = await validateMessage({ skill: { name: 'review', args: 'z'.repeat(300) } }, deps());
  assert.deepStrictEqual(at.message.skill, { name: 'review', args: 'z'.repeat(300) });

  const flat = await validateMessage({ skill: { name: 'review', args: ` one\r\ntwo${ESC}\n ` } }, deps());
  assert.deepStrictEqual(flat.message.skill, { name: 'review', args: 'one two' });

  const unparsed = await validateMessage({ text: '/clear please', skill: { name: 'review' } }, deps());
  assert.equal(unparsed.ok, true);
  assert.deepStrictEqual(unparsed.message.skill, { name: 'review', args: '' });
  assert.equal(unparsed.message.text, '/clear please');

  const asyncCat = await validateMessage({ skill: { name: 'review', args: 'go' } }, deps({ skills: fakeSkills({ async: true }) }));
  assert.deepStrictEqual(asyncCat.message.skill, { name: 'review', args: 'go' });

  const nullSkill = await validateMessage({ text: '/review x', skill: null }, deps());
  assert.deepStrictEqual(nullSkill.message.skill, { name: 'review', args: 'x' }, 'skill: null is no explicit skill');
});

test('the text limit counts the normalised text', async () => {
  const at = await validateMessage({ text: 'a'.repeat(3000) }, deps());
  assert.equal(at.ok, true);
  assert.equal(at.message.chars, 3000);
  const over = await validateMessage({ text: 'a'.repeat(3001) }, deps());
  assert.equal(over.refused, 'too_large');
  assert.equal(over.field, 'text');
  assert.equal(over.max, 3000);
  assert.equal(over.hint, 'A message is at most 3,000 characters.');
  const trimmed = await validateMessage({ text: `${'a'.repeat(3000)}   \n\n` }, deps());
  assert.equal(trimmed.ok, true, 'trailing whitespace is gone before counting');
  const crlf = await validateMessage({ text: 'a\r\nb' }, deps());
  assert.equal(crlf.message.text, 'a\nb');
  assert.equal(crlf.message.chars, 3);
});

test('files: the count, duplicates, the path limit and the index\'s answers', async () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  const many = await validateMessage({ text: 'x', files: six }, deps());
  assert.equal(many.refused, 'too_many_files');
  assert.equal(many.max, 5);

  const f = fakeFiles();
  const dup = await validateMessage({ text: 'x', files: ['a', 'b', 'c', 'd', 'e', 'a', { path: 'b' }] }, deps({ projectFiles: f }));
  assert.equal(dup.ok, true, 'a repeated path counts once');
  assert.deepStrictEqual(dup.message.files.map((x) => x.path), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(f.calls, ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(dup.message.files[0], { path: 'a', bytes: 100 });

  const long = 'p'.repeat(241);
  const tooLong = await validateMessage({ text: 'x', files: [long] }, deps());
  assert.equal(tooLong.refused, 'too_large');
  assert.equal(tooLong.field, 'path');
  assert.equal(tooLong.max, 240);
  assert.equal(tooLong.path, long);
  assert.equal((await validateMessage({ text: 'x', files: ['p'.repeat(240)] }, deps())).ok, true);

  for (const bad of ['', { path: 3 }, { path: '' }, { path: null }]) {
    const r = await validateMessage({ text: 'x', files: [bad] }, deps());
    assert.equal(r.refused, 'file_refused', JSON.stringify(bad));
    assert.equal(r.why, 'outside');
  }

  const answers = {
    '.env': { why: 'sensitive', category: 'dotenv' },
    'build/out.js': { why: 'ignored' },
    '../etc/passwd': { why: 'outside' },
    'link': { why: 'symlink' },
    'gone.txt': { why: 'missing' },
    'src': { why: 'not-a-file' },
  };
  for (const [p, a] of Object.entries(answers)) {
    for (const async of [false, true]) {
      const r = await validateMessage({ text: 'x', files: ['ok.js', p] }, deps({ projectFiles: fakeFiles(answers, { async }) }));
      assert.equal(r.ok, false);
      assert.equal(r.refused, 'file_refused');
      assert.equal(r.path, p);
      assert.equal(r.why, a.why);
      if (a.category) assert.equal(r.category, a.category);
      else assert.equal('category' in r, false);
      assert.ok(r.hint);
    }
  }

  const none = await validateMessage({ text: 'x', files: ['a.js'] }, { skills: fakeSkills() });
  assert.equal(none.refused, 'file_refused');
  assert.equal(none.why, 'unavailable');

  const throws = await validateMessage({ text: 'x', files: ['a.js'] }, deps({ projectFiles: { check: () => { throw new Error('x'); } } }));
  assert.equal(throws.why, 'unavailable');

  const resolved = { check: (rel) => ({ ok: true, path: 'src/a.js', bytes: 9, rel }) };
  const folded = await validateMessage({ text: 'x', files: ['./src/a.js', 'src/a.js'] }, deps({ projectFiles: resolved }));
  assert.deepStrictEqual(folded.message.files, [{ path: 'src/a.js', bytes: 9 }], 'two spellings of one file attach it once');
});

test('empty: no text, no skill, no files', async () => {
  assert.equal((await validateMessage({ text: '' }, deps())).refused, 'empty');
  assert.equal((await validateMessage({ text: '   ' }, deps())).refused, 'empty');
  assert.equal((await validateMessage({}, deps())).refused, 'empty');
  assert.equal((await validateMessage({ text: `${ZWSP}\n\t` }, deps())).refused, 'empty');
  const fileOnly = await validateMessage({ text: '   ', files: ['a.js'] }, deps());
  assert.equal(fileOnly.ok, true);
  assert.equal(fileOnly.message.text, '');
  assert.equal(fileOnly.message.chars, 0);
  const skillOnly = await validateMessage({ skill: { name: 'review' } }, deps());
  assert.equal(skillOnly.ok, true);
});

test('bad_request for a malformed field', async () => {
  const cases = [
    [{ text: 5 }, 'text'],
    [{ text: null }, 'text'],
    [{ text: 'x', files: 'a.js' }, 'files'],
    [{ text: 'x', files: [3] }, 'files'],
    [{ text: 'x', send: 'later' }, 'send'],
    [{ text: 'x', conversation_id: 'a b' }, 'conversation_id'],
    [{ text: 'x', conversation_id: 'c'.repeat(65) }, 'conversation_id'],
    [{ text: 'x', skill: 'review' }, 'skill'],
    [{ text: 'x', skill: { name: 3 } }, 'skill'],
    [{ text: 'x', skill: { name: 'review', args: 4 } }, 'skill'],
  ];
  for (const [body, field] of cases) {
    const r = await validateMessage(body, deps());
    assert.equal(r.refused, 'bad_request', JSON.stringify(body));
    assert.equal(r.field, field);
  }
  for (const body of [null, 'text', [], 7]) {
    assert.equal((await validateMessage(body, deps())).refused, 'bad_request');
  }
  const ok = await validateMessage({ text: 'x', send: 'hold', conversation_id: 'f3c1_A-9' }, deps());
  assert.equal(ok.message.send, 'hold');
  assert.equal(ok.message.conversation_id, 'f3c1_A-9');
});

test('validateEdit replaces only the fields the body carries and re-validates them', async () => {
  const item = { text: 'old text', skill: null, files: [{ path: 'a.js', bytes: 100 }], conversation_id: 'c1', autosend: true };
  const t = await validateEdit(item, { text: 'new text' }, deps());
  assert.equal(t.ok, true);
  assert.equal(t.message.text, 'new text');
  assert.deepStrictEqual(t.message.files, [{ path: 'a.js', bytes: 100 }]);
  assert.equal(t.message.conversation_id, 'c1');
  assert.equal('send' in t.message, false);

  const files = await validateEdit(item, { files: ['b.js'] }, deps());
  assert.equal(files.message.text, 'old text');
  assert.deepStrictEqual(files.message.files, [{ path: 'b.js', bytes: 100 }]);

  const ignored = await validateEdit(item, { text: 'x', send: 'now', conversation_id: 'other' }, deps());
  assert.equal(ignored.message.conversation_id, 'c1', 'conversation_id is not editable');

  const refusedFile = await validateEdit(item, {}, deps({ projectFiles: fakeFiles({ 'a.js': { why: 'missing' } }) }));
  assert.equal(refusedFile.refused, 'file_refused', 'the kept files are re-checked');

  assert.equal((await validateEdit(item, { text: 'a'.repeat(3001) }, deps())).refused, 'too_large');
  assert.equal((await validateEdit(item, { text: '', files: [] }, deps())).refused, 'empty');
  assert.equal((await validateEdit(item, { text: 9 }, deps())).refused, 'bad_request');
  assert.equal((await validateEdit(item, null, deps())).refused, 'bad_request');

  const s = fakeSkills();
  await validateEdit(item, { text: '/review go' }, deps({ skills: s }));
  assert.deepStrictEqual(s.calls[0].opts, { conversation_id: 'c1' }, 'the catalog answers for the item\'s conversation');
});

test('validateEdit\'s skill: re-parsed from the merged text unless the body names one', async () => {
  const longArgs = 'q'.repeat(400);
  const item = { text: `/review ${longArgs}`, skill: { name: 'review', args_in_text: true }, files: [], conversation_id: null };

  const still = await validateEdit(item, { text: `/review ${longArgs} more` }, deps());
  assert.deepStrictEqual(still.message.skill, { name: 'review', args_in_text: true });

  const shorter = await validateEdit(item, { text: `/review ${'q'.repeat(300)}` }, deps());
  assert.deepStrictEqual(shorter.message.skill, { name: 'review', args: 'q'.repeat(300) });

  const removed = await validateEdit(item, { text: 'just words now' }, deps());
  assert.equal(removed.message.skill, null);

  const filesOnly = await validateEdit(item, { files: [] }, deps());
  assert.deepStrictEqual(filesOnly.message.skill, { name: 'review', args_in_text: true }, 'the stored skill is never fed back as explicit');

  const explicitItem = { text: 'please', skill: { name: 'review', args: 'go' }, files: [], conversation_id: null };
  const kept = await validateEdit(explicitItem, { text: 'please now', skill: { name: 'review', args: 'go' } }, deps());
  assert.deepStrictEqual(kept.message.skill, { name: 'review', args: 'go' });
  const explicitOver = await validateEdit(explicitItem, { skill: { name: 'review', args: 'g'.repeat(301) } }, deps());
  assert.equal(explicitOver.refused, 'too_large');
  assert.equal(explicitOver.field, 'args');
});

test('createRateLimit: a sliding window of accepted takes, retry_after in whole seconds', () => {
  let t = 1_000_000;
  const rl = createRateLimit({ now: () => t });
  for (let i = 0; i < 30; i++) {
    assert.deepStrictEqual(rl.take(), { ok: true }, `take ${i + 1}`);
    t += 100;
  }
  // The first take was at 1,000,000; it is now 1,003,000: it leaves at 1,060,000.
  const no = rl.take();
  assert.equal(no.ok, false);
  assert.equal(no.retry_after, 57);
  t = 1_059_999;
  assert.equal(rl.take().retry_after, 1, 'never less than one second');
  t = 1_060_000;
  assert.deepStrictEqual(rl.take(), { ok: true }, 'the oldest has slid out');
  assert.equal(rl.take().ok, false);
  rl.reset();
  assert.deepStrictEqual(rl.take(), { ok: true });

  let u = 0;
  const small = createRateLimit({ max: 2, windowMs: 1500, now: () => u });
  small.take();
  small.take();
  u = 200;
  assert.equal(small.take().retry_after, 2, 'rounded up');
});

test('every refusal carries a non-empty hint, and every code has one', async () => {
  assert.deepStrictEqual(Object.keys(HINTS).sort(), [...REFUSALS].sort());
  for (const code of REFUSALS) assert.ok(typeof HINTS[code] === 'string' && HINTS[code].length > 0, code);
  assert.equal(HINTS.builtin_command, '/<name> is a Claude Code command: type it in the terminal.');
  assert.equal(HINTS.user_only_skill, 'Only you can run /<name>: type it in the terminal.');
  assert.equal(HINTS.too_large, 'A message is at most 3,000 characters.');

  const refusals = await Promise.all([
    validateMessage({ text: 5 }, deps()),
    validateMessage({ text: '' }, deps()),
    validateMessage({ text: 'a'.repeat(3001) }, deps()),
    validateMessage({ skill: { name: 'review', args: 'a'.repeat(301) } }, deps()),
    validateMessage({ text: 'x', files: ['p'.repeat(241)] }, deps()),
    validateMessage({ skill: { name: 'nope' } }, deps()),
    validateMessage({ skill: { name: `bad${ESC}` } }, deps()),
    validateMessage({ skill: { name: 'a$&b c' } }, deps()),
    validateMessage({ skill: { name: "$'x y" } }, deps()),
    validateMessage({ text: '/secret-deploy' }, deps()),
    validateMessage({ text: '/help' }, deps()),
    validateMessage({ text: 'x', files: ['a', 'b', 'c', 'd', 'e', 'f'] }, deps()),
    validateMessage({ text: 'x', files: ['a'] }, {}),
    validateMessage({ text: 'x', files: [''] }, deps()),
    validateMessage({ text: 'x', files: ['.env'] }, deps({ projectFiles: fakeFiles({ '.env': { why: 'sensitive', category: 'dotenv' } }) })),
  ]);
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.ok(REFUSALS.includes(r.refused), r.refused);
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0, r.refused);
    assert.equal(r.hint.includes('<name>'), false, r.hint);
    assert.equal(/[\u0000-\u001f]/.test(r.hint), false, 'a hint never carries a control character');
  }
});

test('a refused skill name from the request is named literally: no $ pattern in it expands', async () => {
  // String.prototype.replace treats $&, $', $` and $$ in a replacement string
  // as patterns; a name that fails the grammar still comes from the request.
  for (const name of ['a$&b c', "$'x y", '$`z w', 'p$$q r']) {
    const r = await validateMessage({ skill: { name } }, deps());
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'unknown_skill');
    assert.equal(r.name, name);
    assert.equal(r.hint, `/${name} is not a skill Claude can run in this conversation.`);
    assert.equal(r.hint.includes('<name>'), false, r.hint);
  }
});

// ── the composer on the mod (U91, spec §15.7; ruled D4 (a), D-defaults (a)) ──

const { SAFE_MOD_COMMANDS, RENAME_MAX, parseModCommand } = composer;
const { MOD_COMMANDS, validateOp } = require('../lib/core/mod-protocol');

// A catalog with a mod: modCommands answers `answer` (a value, a Promise, or
// a function to call), and records what it was asked.
function modSkills(answer) {
  const s = fakeSkills();
  s.modCalls = [];
  s.modCommands = (cid) => {
    s.modCalls.push(cid);
    return typeof answer === 'function' ? answer(cid) : answer;
  };
  return s;
}
const MOD_HINT = (name) => `/${name} runs from this page only with the web-chat mod (claude-web-chat mod on); otherwise type it in the terminal.`;

test('SAFE_MOD_COMMANDS is the five, frozen, each a built-in and a mod command', () => {
  assert.deepStrictEqual([...SAFE_MOD_COMMANDS], ['plan', 'compact', 'context', 'rename', 'recap']);
  assert.equal(Object.isFrozen(SAFE_MOD_COMMANDS), true);
  for (const name of SAFE_MOD_COMMANDS) {
    assert.ok(BUILTIN_COMMANDS.includes(name), `${name} is a built-in`);
    assert.ok(MOD_COMMANDS.includes(name), `${name} is one of mod-protocol's MOD_COMMANDS`);
  }
  // /clear and /resume stay behind the control frame (U93); no config command.
  for (const name of ['clear', 'resume', 'model', 'config', 'permissions', 'autocompact']) assert.ok(!SAFE_MOD_COMMANDS.includes(name), name);
  assert.ok(REFUSALS.includes('command_files'));
  assert.equal(HINTS.command_files, 'A command takes no files: send the files in a message of their own.');
});

test('parseModCommand: a leading safe /name, lowercased; its args trimmed and guarded; a rename is one line of 1-64', () => {
  assert.deepStrictEqual(parseModCommand('/Rename  new name '), { command: 'rename', args: 'new name' });
  assert.equal(parseModCommand('/rename first\nsecond'), null);
  assert.equal(parseModCommand('/rename'), null);
  assert.equal(parseModCommand(`/rename ${'x'.repeat(RENAME_MAX + 1)}`), null);
  assert.deepStrictEqual(parseModCommand(`/rename ${'x'.repeat(RENAME_MAX)}`), { command: 'rename', args: 'x'.repeat(RENAME_MAX) });
  assert.deepStrictEqual(parseModCommand('/plan'), { command: 'plan', args: '' });
  assert.deepStrictEqual(parseModCommand('  /PLAN  '), { command: 'plan', args: '' });
  assert.deepStrictEqual(parseModCommand('/compact keep\n  the\ttests'), { command: 'compact', args: 'keep the tests' });
  assert.deepStrictEqual(parseModCommand(`/compact a${BIDI_OVERRIDE}b${ZWSP}c`), { command: 'compact', args: 'abc' });
  for (const t of ['/model', '/clear', '/resume x', 'plan', 'run /plan', '/plan/x', '', null, 7]) assert.equal(parseModCommand(t), null, String(t));
  // RENAME_MAX is the mod's own bound for the command op.
  assert.equal(validateOp('command', { name: 'rename', args: 'x'.repeat(RENAME_MAX) }).ok, true);
  assert.equal(validateOp('command', { name: 'rename', args: 'x'.repeat(RENAME_MAX + 1) }).ok, false);
});

test('classifySkill: a safe name with a mod is mod_command, checked before the built-ins; anything but true is no mod', async () => {
  assert.equal(await classifySkill('plan', { skills: modSkills(true) }), 'mod_command');
  assert.equal(await classifySkill('Compact', { skills: modSkills(Promise.resolve(true)) }), 'mod_command');
  for (const answer of [false, 'yes', 1, null, Promise.resolve(false), () => { throw new Error('boom'); }, () => Promise.reject(new Error('x'))]) {
    assert.equal(await classifySkill('plan', { skills: modSkills(answer) }), 'builtin', String(answer));
  }
  assert.equal(await classifySkill('plan', { skills: fakeSkills() }), 'builtin');
  assert.equal(await classifySkill('model', { skills: modSkills(true) }), 'builtin');
  const s = modSkills(true);
  await classifySkill('recap', { skills: s, conversation_id: 'c-9' });
  assert.deepStrictEqual(s.modCalls, ['c-9']);
  // Only a safe name asks the adapter.
  const t = modSkills(true);
  await classifySkill('model', { skills: t });
  await classifySkill('review', { skills: t });
  assert.deepStrictEqual(t.modCalls, []);
});

test('a safe command with a mod is accepted as plain text, kept exactly as typed', async () => {
  for (const skills of [modSkills(true), modSkills(Promise.resolve(true))]) {
    for (const text of ['/plan', '/compact', '/context', '/rename v40 test', '/recap', '/Plan']) {
      const r = await validateMessage({ text }, deps({ skills }));
      assert.equal(r.ok, true, `${text}: ${r.hint}`);
      assert.equal(r.message.text, text);
      assert.equal(r.message.skill, null);
      assert.deepStrictEqual(r.message.files, []);
    }
  }
});

test('a safe command with args follows the mod\'s command op: /plan and /compact take a line, anything the op refuses is refused with its words', async () => {
  // Claude Code 2.1.296 takes '/plan <description>' and '/compact
  // <instructions>'; lib/core/mod-protocol decides what the op carries, and
  // the validation follows it rather than failing after the send.
  for (const [text, name, args] of [['/plan x', 'plan', 'x'], ['/plan open', 'plan', 'open'], ['/compact keep the tests', 'compact', 'keep the tests']]) {
    const r = await validateMessage({ text }, deps({ skills: modSkills(true) }));
    assert.equal(r.ok, true, `${text}: ${r.hint}`);
    assert.equal(r.message.text, text);
    assert.equal(r.message.skill, null);
    assert.deepStrictEqual(parseModCommand(text), { command: name, args });
    assert.deepStrictEqual(validateOp('command', { name, args }), { ok: true, args: { name, args } });
  }
  for (const [text, name, args] of [['/plan /model', 'plan', '/model'], [`/compact ${'x'.repeat(2001)}`, 'compact', 'x'.repeat(2001)], ['/recap now', 'recap', 'now'], ['/context more', 'context', 'more']]) {
    const r = await validateMessage({ text }, deps({ skills: modSkills(true) }));
    const v = validateOp('command', { name, args });
    assert.equal(v.ok, false, text.slice(0, 20));
    assert.equal(r.ok, false, text.slice(0, 20));
    assert.equal(r.refused, 'builtin_command');
    assert.equal(r.hint, `${v.hint} — type /${name} in the terminal to run it that way.`);
  }
  const multi = await validateMessage({ text: '/rename one\ntwo' }, deps({ skills: modSkills(true) }));
  assert.equal(multi.ok, false);
  assert.equal(multi.refused, 'builtin_command');
  assert.match(multi.hint, /one line/);
  const slash = await validateMessage({ text: '/rename /etc' }, deps({ skills: modSkills(true) }));
  assert.equal(slash.ok, false);
  assert.equal(slash.refused, 'builtin_command');
});

test('without a mod a safe command is refused builtin_command with the mod hint; /model and every other built-in, with or without one', async () => {
  for (const skills of [fakeSkills(), modSkills(false), modSkills(() => { throw new Error('x'); }), modSkills(() => Promise.reject(new Error('y')))]) {
    const r = await validateMessage({ text: '/plan x' }, deps({ skills }));
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'builtin_command');
    assert.equal(r.hint, MOD_HINT('plan'));
  }
  const odd = await validateMessage({ text: '/Re$&cap' }, deps({ skills: fakeSkills() }));
  assert.equal(odd.ok, true, 'not a command name: plain text');
  const cased = await validateMessage({ text: '/Recap' }, deps({ skills: fakeSkills() }));
  assert.equal(cased.hint, MOD_HINT('Recap'));
  for (const skills of [fakeSkills(), modSkills(true)]) {
    for (const name of BUILTIN_COMMANDS.filter((n) => !SAFE_MOD_COMMANDS.includes(n))) {
      const r = await validateMessage({ text: `/${name}` }, deps({ skills }));
      assert.equal(r.ok, false, name);
      assert.equal(r.refused, 'builtin_command', name);
      assert.equal(r.hint, `/${name} is a Claude Code command: type it in the terminal.`, name);
    }
  }
});

test('a mod command with a file is refused command_files; an explicit skill field naming a command stays builtin_command', async () => {
  const r = await validateMessage({ text: '/compact', files: ['a.js'] }, deps({ skills: modSkills(true) }));
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'command_files');
  assert.equal(r.hint, HINTS.command_files);
  for (const name of ['plan', 'compact', 'model']) {
    const e = await validateMessage({ skill: { name } }, deps({ skills: modSkills(true) }));
    assert.equal(e.ok, false);
    assert.equal(e.refused, 'builtin_command');
    assert.equal(e.hint, `/${name} is a Claude Code command: type it in the terminal.`);
  }
});

test('an edit re-validates a mod command against the item\'s conversation', async () => {
  const skills = modSkills((cid) => cid === 'c-mod');
  const ok = await validateEdit({ text: 'hi', conversation_id: 'c-mod' }, { text: '/context' }, deps({ skills }));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.text, '/context');
  const no = await validateEdit({ text: 'hi', conversation_id: 'c-other' }, { text: '/context' }, deps({ skills }));
  assert.equal(no.refused, 'builtin_command');
  assert.equal(no.hint, MOD_HINT('context'));
});
