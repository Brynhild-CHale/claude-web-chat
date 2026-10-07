'use strict';

// The rules text cannot drift from the strings the code emits (U59b, the
// maintainer's follow-up t4f-F, finding U66b@rules-text-drift).
//
// Spec §6.8's block in the rules files tells Claude what each web-chat block or
// denial means by quoting the header the code emits. Nothing else ties the two:
// before this file, renaming an emitter's header, or deleting ruling C3 (a)'s
// repeat-marker sentence from a rules file, left every test green. Each emitted
// string is read from its module (an exported constant, or the halt script's
// text, since that one is shell), so a change on either side without the other
// fails here. Both rules files are checked: the template every install copies
// and this repository's own dogfood copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const envelope = require('../lib/channel/envelope');
const askOutput = require('../lib/hooks/ask-output');
const revert = require('../lib/server/control/revert');
const { messageMarker } = require('../lib/core/prompt-class');

const RULES_FILES = [
  'templates/rules/web-chat.md',
  '.claude/rules/web-chat.md',
];

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// How the rules text writes a marker: the emitted form with the id elided.
const RULES_MARKER = '[web-chat message m-…]';

// C3 (a)'s sentence, as the rules text spells it (the marker in code ticks).
const REPEAT_SENTENCE = `A block whose \`${RULES_MARKER}\` marker you have already seen in this conversation is a repeat delivery: do not act on it again.`;

// The halt script's PreToolUse denial reason, read out of its JSON line.
function haltReason() {
  const src = read('lib/hooks/claude-web-chat-hook-halt.sh');
  const lines = src.split('\n').filter((l) => /^\s*printf\b/.test(l) && l.includes('"PreToolUse"'));
  assert.equal(lines.length, 1, 'the halt script prints exactly one PreToolUse denial');
  const json = lines[0].match(/'(\{.*\})'/);
  assert.ok(json, 'the halt script\'s denial is a single-quoted JSON literal');
  const reason = JSON.parse(json[1]).hookSpecificOutput.permissionDecisionReason;
  assert.equal(typeof reason, 'string');
  return reason;
}

// ── the emitters say what the constants say ─────────────────────────────────
// A header the code builds without its constant would leave the constant
// (and so this file) behind; these pin the emitted text to the constants.

test('the envelope emits its two headers from the exported constants, with the marker the rules write', () => {
  assert.equal(typeof envelope.MESSAGE_HEADER, 'string');
  assert.equal(typeof envelope.STOP_REQUEST_HEADER, 'string');
  const id = 'm-0123abcd';
  const marker = messageMarker(id);
  assert.equal(marker.replace(/m-[0-9a-f]{8}/, 'm-…'), RULES_MARKER, 'the rules text writes the marker the code emits');

  const msg = envelope.messageBlock({ kind: 'message', msg_id: id, text: 'hi', skill: null, files: [] });
  assert.equal(msg.split('\n')[0], `${envelope.MESSAGE_HEADER} ${marker}:`);

  const stop = envelope.stopRequestBlock({ kind: 'message', source: 'task-stop', msg_id: id, task_id: 'b1a2c3d4' });
  assert.ok(stop.startsWith(`${envelope.STOP_REQUEST_HEADER} ${marker}:`), stop);
});

test('the ask hook\'s denials all say where the user decided, in the exported phrase', () => {
  assert.equal(typeof askOutput.PAGE_PHRASE, 'string');
  for (const k of ['DENY_MESSAGE', 'DECLINE_MESSAGE', 'REJECT_FEEDBACK', 'REJECT_NO_FEEDBACK']) {
    assert.ok(askOutput[k].includes(askOutput.PAGE_PHRASE), `${k} says ${JSON.stringify(askOutput.PAGE_PHRASE)}`);
  }
});

test('the revert notice\'s header is the exported constant', () => {
  assert.equal(typeof revert.NOTICE_HEADER, 'string');
  // The notice is built inside installRevert; its two head templates are the
  // only places the header appears outside the constant's own line.
  const src = read('lib/server/control/revert.js');
  const literal = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && l.includes(revert.NOTICE_HEADER));
  assert.equal(literal.length, 1, 'the header is spelled once, on the constant\'s line');
  assert.equal((src.match(/\*\*\$\{NOTICE_HEADER\}\*\*/g) || []).length, 2, 'both heads (restore, undo) use the constant');
});

// ── each rules file quotes every emitted string ─────────────────────────────

for (const rel of RULES_FILES) {
  test(`${rel}: quotes the message and stop-request headers as the envelope emits them`, () => {
    const rules = read(rel);
    assert.ok(rules.includes(`**${envelope.MESSAGE_HEADER} ${RULES_MARKER}**`),
      `${rel} quotes **${envelope.MESSAGE_HEADER} ${RULES_MARKER}**`);
    assert.ok(rules.includes(`**${envelope.STOP_REQUEST_HEADER} ${RULES_MARKER}**`),
      `${rel} quotes **${envelope.STOP_REQUEST_HEADER} ${RULES_MARKER}**`);
  });

  test(`${rel}: quotes the Skill line as the envelope emits it`, () => {
    const rules = read(rel);
    const block = envelope.messageBlock({ kind: 'message', msg_id: 'm-0123abcd', text: '/demo go', skill: { name: 'demo', args: 'go' }, files: [] });
    const line = block.split('\n').find((l) => !l.startsWith('>') && l.includes('/demo'));
    assert.ok(line, 'the block has a Skill line');
    const prefix = line.slice(0, line.indexOf('/demo') + 1); // 'Skill requested: /'
    assert.ok(rules.includes(`**${prefix}<name> …**`), `${rel} quotes **${prefix}<name> …**`);
    // Ruling C2 (d): an over-long args points at the quoted text instead.
    const long = envelope.messageBlock({ kind: 'message', msg_id: 'm-0123abcd', text: '/demo …', skill: { name: 'demo', args_in_text: true }, files: [] });
    assert.match(long, /the message text after "\/demo" quoted above/);
    assert.ok(rules.includes('the quoted message text after `/<name>`'), `${rel} tells Claude where args_in_text args are`);
  });

  test(`${rel}: holds ruling C3 (a)'s repeat-marker sentence`, () => {
    assert.ok(read(rel).includes(REPEAT_SENTENCE), `${rel} holds: ${REPEAT_SENTENCE}`);
  });

  test(`${rel}: quotes the ask hook's page phrase`, () => {
    assert.ok(read(rel).includes(`'${askOutput.PAGE_PHRASE}'`), `${rel} quotes '${askOutput.PAGE_PHRASE}'`);
  });

  test(`${rel}: quotes the halt script's denial reason`, () => {
    // The script's sentence, as the rules quote it mid-sentence: no capital, no stop.
    const reason = haltReason().replace(/\.$/, '');
    const quoted = reason.charAt(0).toLowerCase() + reason.slice(1);
    assert.ok(read(rel).includes(`'${quoted}'`), `${rel} quotes '${quoted}'`);
  });

  test(`${rel}: quotes the revert notice's header`, () => {
    assert.ok(read(rel).includes(`**${revert.NOTICE_HEADER}**`), `${rel} quotes **${revert.NOTICE_HEADER}**`);
  });
}
