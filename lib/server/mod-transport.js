// lib/server/mod-transport.js — the composer on the mod (spec §15.7, §6.1's
// transport seam; U91).
//
//   createModTransport({bridge, mirror, state, bus, log, graph})
//       → transport(item) → {via: 'mod'} | null     (what U94a assigns to
//                                                  state.messageTransport)
//   withModCommands(skills, {bridge, mirror})
//       → the `/` catalog adapter plus modCommands(conversation_id), which
//         U94a sets as ctx.skills so lib/server/composer.js can classify a
//         SAFE_MOD_COMMANDS name ('mod_command') with no edit to the queue
//         routes
//
// THE SEAM (lib/server/domain/queue.js deliver): each MESSAGE item of a
// delivery is offered to state.messageTransport, synchronously; {via} takes it
// (its receipt goes sending → sent at once; the transcript confirms a
// message, §6.6, and the mod's ok a command — see THE FALLBACK), anything
// else — null, a throw — declines it, and a declined item wakes or parks as
// before. So this function is synchronous and never throws.
//
// WHAT IT TAKES. A message item (never a stop request: source 'task-stop'
// keeps the channel or the park, whose immediate path is U89's task-stop row,
// §6.9) whose conversation — item.conversation_id, else the mirror's primary —
// has a session with a web-chat mod attached (bridge.sessionOf, read
// synchronously). It becomes ONE op on that session's queue:
//   * a text parseModCommand reads (one of SAFE_MOD_COMMANDS), with no skill
//     and no files → {op: 'command', args: {name, args}}: Claude Code runs it
//     as if typed (U88 maps it onto $.command.run);
//   * anything else → {op: 'submit', args: {text}}, whose text is
//     lib/channel/envelope wakeEnvelope([item], {origin, device}).content — the
//     'Pushed from:' line and the quoted, marked block (§6.5), from the one
//     builder, never a second block format. So the text never begins with '/'
//     (Claude Code's $.prompt.submit would run it as a command AS THE USER),
//     Q4's analysis holds (the block is the user's words, marked), and the
//     marker lets the transcript confirm it. U88 submits it with asUser: true;
//     this module never chooses.
// An op lib/core/mod-protocol validateOp would refuse is declined, so a
// refusal reaches the user through the channel or the park instead of
// failing after the send (the composer's validation refuses such a command
// before it is queued; a message whose mod went away in the meantime lands
// here).
//
// THE FALLBACK (§15.7: "the channel or the park is the fallback"). enqueue's
// Promise settles later:
//   * a SUBMIT {ok: true}               the transcript confirms; but when the
//     mod says {submitted: true} WITHOUT queued (Claude Code said its turn
//     started), THE NET (below) is armed;
//   * a SUBMIT {ok: false, refused: 'not-submitted'}  Claude Code resolved the
//     submit but did not take the prompt ({ended: 'Prompt not submitted: …'},
//     a hook dropped it: U126, m-71c5c175): handed back exactly as a mod that
//     never had it (below), and the reason is logged;
//   * a COMMAND {ok: true}              its receipt is 'confirmed' at once: a
//     command leaves no marker in the transcript, so §6.6's confirmation would
//     never come (the main session's decision after wave 2; V40 observes it);
//   * {ok: false, delivered: false}     the mod never had it (timeout,
//     queue-full, not-attached, detached, stopped, or a rejection): a SUBMIT
//     is remembered by msg_id and handed once to queue.handBack (reason
//     'mod-fallback', the item's own provenance), whose receipt steps back to
//     'queued' and which keeps §6.4's one message per park: with a live
//     channel it wakes (offered here again on the way — declined this time);
//     with the park already holding a typed message it waits in the queue as
//     'parked_message' for the next idle, where it is offered here again (so
//     it is forgotten, not declined); otherwise it parks;
//   * a SUBMIT {ok: false, delivered: true}  handed out with no result: it
//     stays 'sent', and the transcript has the last word;
//   * a COMMAND that fails either way is never re-sent through the channel
//     (Claude cannot run a command from a message): its receipt is 'failed'
//     (sent → failed), with no wake.
//
// THE NET (U126). A submit Claude Code reported started must show its marker
// in the transcript soon (§6.6). One timer per such message (CONFIRM_NET_MS,
// unref'd): when it fires and the receipt is still the 'sent' it was when the
// net was armed — no confirmation came, and nothing else moved it — and the
// mirror is tailing that conversation (enabled, with a live object: without
// it no confirmation can come, so silence says nothing), the message is
// handed back the same way and the daemon log says so. A receipt that moved
// on (confirmed, handed back) is left alone; a {queued: true} answer arms
// nothing (a queued prompt runs only when the current turn ends). A late
// confirmation after a hand-back is tolerated: the rules file tells Claude a
// repeated [web-chat message m-…] marker is a repeat delivery. stop() (also
// run when the bridge stops, and when the daemon has taken this transport off
// state.messageTransport) clears every timer and declines every later item.
//
// What is NOT here: no route (C46: the chrome reaches the mod only through
// control actions, and a message through the queue); no second delivery path
// beside the queue domain's (deliver, handBack); never file content or image
// bytes (a message's files are paths, Q5).

const queue = require('./domain/queue');
const { redactText } = require('../core/redact');
const { parseModCommand } = require('./composer');
const { wakeEnvelope } = require('../channel/envelope');
const { validateOp } = require('../core/mod-protocol');

// How many handed-back messages are remembered (each is declined once more,
// then forgotten as newer ones arrive). One handBack keeps in the queue for
// the next idle is forgotten at once: the mod is offered it again then.
const HANDED_BACK_MAX = 256;
const VIA = 'mod';
// How long a submit Claude Code reported started may go without its
// transcript marker before THE NET hands it back.
const CONFIRM_NET_MS = 30000;

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

// The mirror's primary conversation, read synchronously (the seam is): a
// snapshot that answers a Promise, or throws, gives none.
function primaryOf(mirror) {
  if (!mirror || typeof mirror.snapshot !== 'function') return null;
  try {
    const s = mirror.snapshot({ level: 'basic' });
    return isPlain(s) && isStr(s.primary) ? s.primary : null;
  } catch {
    return null;
  }
}

// The mod-attached session of a conversation, or null; a throw is null.
function sessionOf(bridge, cid) {
  if (!isStr(cid) || !bridge || typeof bridge.sessionOf !== 'function') return null;
  try {
    const sid = bridge.sessionOf(cid);
    return isStr(sid) ? sid : null;
  } catch {
    return null;
  }
}

// The op one message item becomes.
function opFor(item) {
  const files = Array.isArray(item.files) ? item.files : [];
  if (item.skill == null && files.length === 0) {
    const cmd = parseModCommand(item.text);
    if (cmd) return { op: 'command', args: { name: cmd.command, args: cmd.args } };
  }
  const { content } = wakeEnvelope([item], { origin: item.origin, device: item.device });
  return { op: 'submit', args: { text: content } };
}

// A reason from the mod, as the daemon log may say it: redacted.
function reasonText(r) {
  if (!isPlain(r) || !isStr(r.error)) return '';
  try { return `: ${redactText(r.error)}`; } catch { return ''; }
}

function createModTransport({
  bridge, mirror = null, state, bus, log = () => {}, graph = null, confirmWithinMs = CONFIRM_NET_MS,
} = {}) {
  if (!bridge || typeof bridge.enqueue !== 'function' || typeof bridge.sessionOf !== 'function') {
    throw new TypeError('createModTransport needs { bridge } (lib/server/domain/bridge: enqueue, sessionOf)');
  }
  if (!state || typeof state !== 'object') throw new TypeError('createModTransport needs { state }');
  if (!(Number.isFinite(confirmWithinMs) && confirmWithinMs > 0)) throw new TypeError('createModTransport: confirmWithinMs must be a positive number');
  const say = (msg) => { try { log(`mod-transport: ${msg}`); } catch {} };
  const handedBack = new Set();
  const nets = new Map(); // msg_id → timer handle
  let stopped = false;
  let offBridge = null;

  function remember(msgId) {
    handedBack.add(msgId);
    while (handedBack.size > HANDED_BACK_MAX) handedBack.delete(handedBack.values().next().value);
  }

  // The pid a fallback release is aimed at (§6.4 targeting), best effort.
  function targetPid(cid) {
    if (!isStr(cid) || !mirror || typeof mirror.liveOf !== 'function') return undefined;
    try {
      const live = mirror.liveOf(cid);
      const pid = live && live.process && live.process.pid;
      return queue.isTargetPid(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  function fallBack(item, cid) {
    remember(item.msg_id);
    try {
      const r = queue.handBack(state, bus, item, {
        reason: 'mod-fallback', origin: item.origin, device: item.device, graph: graph || undefined, target_pid: targetPid(cid),
      });
      // Back in the queue for the next idle: the mod is offered it again then.
      if (r && r.mode === 'queued') handedBack.delete(item.msg_id);
    } catch (e) {
      say(`the fallback delivery of ${item.msg_id} failed: ${(e && e.message) || e}`);
    }
  }

  function note(item, next) {
    try { queue.noteReceipt(state, bus, item.msg_id, next); } catch {}
  }

  function receiptOf(msgId) {
    const rec = state.messageReceipts instanceof Map ? state.messageReceipts.get(msgId) : null;
    return rec || null;
  }

  // The mirror tails this conversation: a confirmation could come.
  function tailing(cid) {
    if (!isStr(cid) || !mirror || typeof mirror.enabled !== 'function' || typeof mirror.liveOf !== 'function') return false;
    try {
      const on = mirror.enabled();
      return isPlain(on) && on.enabled === true && !!mirror.liveOf(cid);
    } catch {
      return false;
    }
  }

  function disarm(msgId) {
    const h = nets.get(msgId);
    if (h === undefined) return;
    nets.delete(msgId);
    clearTimeout(h);
  }

  // The daemon took this transport off (stopModLayer): it is stopped.
  function retired() {
    return Object.prototype.hasOwnProperty.call(state, 'messageTransport') && state.messageTransport !== modTransport;
  }

  function armNet(item, cid) {
    disarm(item.msg_id);
    if (stopped) return;
    const rec = receiptOf(item.msg_id);
    if (!rec || rec.state !== 'sent') return;
    const at = rec.at;
    const h = setTimeout(() => {
      nets.delete(item.msg_id);
      if (stopped) return;
      if (retired()) { stop(); return; }
      const now = receiptOf(item.msg_id);
      if (!now || now.state !== 'sent' || now.at !== at) return;
      const secs = Math.round(confirmWithinMs / 1000);
      if (!tailing(cid)) {
        say(`${item.msg_id}: Claude Code said it started, and no transcript is being read to confirm it: left as sent`);
        return;
      }
      say(`${item.msg_id}: Claude Code said it started, but the transcript has not shown it in ${secs} s: the channel or the park takes it`);
      fallBack(item, cid);
    }, confirmWithinMs);
    if (h && typeof h.unref === 'function') h.unref();
    nets.set(item.msg_id, h);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const h of nets.values()) clearTimeout(h);
    nets.clear();
    if (offBridge) { try { offBridge(); } catch {} offBridge = null; }
  }

  // A settle after stop() still hands back (as before the net): only the
  // net's timers stop.
  function settle(item, op, cid, r) {
    const ok = isPlain(r) && r.ok === true;
    if (op.op === 'command') {
      if (ok) { note(item, 'confirmed'); return; }
      const why = isPlain(r) && isStr(r.refused) ? r.refused : 'no answer';
      say(`/${op.args.name} for ${item.msg_id} did not run (${why})`);
      note(item, 'failed');
      return;
    }
    if (ok) {
      const res = isPlain(r.result) ? r.result : {};
      if (res.submitted === true && res.queued !== true) armNet(item, cid);
      return;
    }
    // Claude Code answered the submit and did not take the prompt.
    if (isPlain(r) && r.refused === 'not-submitted') {
      say(`${item.msg_id} was not taken by Claude Code${reasonText(r)}: the channel or the park takes it`);
      fallBack(item, cid);
      return;
    }
    // Handed out and never answered: the mod may have submitted it.
    if (isPlain(r) && r.delivered === true) return;
    const why = isPlain(r) && isStr(r.refused) ? r.refused : 'no answer';
    say(`${item.msg_id} was not taken by the mod (${why}): the channel or the park takes it`);
    fallBack(item, cid);
  }

  function modTransport(item) {
    try {
      if (stopped) return null;
      if (!queue.isMessage(item) || item.source === 'task-stop' || !isStr(item.msg_id)) return null;
      if (handedBack.has(item.msg_id)) return null;
      const cid = isStr(item.conversation_id) ? item.conversation_id : primaryOf(mirror);
      const sid = sessionOf(bridge, cid);
      if (!sid) return null;
      const op = opFor(item);
      if (!validateOp(op.op, op.args).ok) return null;
      const p = bridge.enqueue(sid, op);
      if (!isThenable(p)) return null;
      Promise.resolve(p).then(
        (r) => settle(item, op, cid, r),
        (e) => settle(item, op, cid, { ok: false, refused: (e && e.message) || 'rejected', delivered: false }),
      ).catch((e) => say(`settling ${item.msg_id} failed: ${(e && e.message) || e}`));
      return { via: VIA };
    } catch {
      return null;
    }
  }
  modTransport.stop = stop;

  // The bridge stopping (both teardown paths: stopModLayer) detaches every
  // session with reason 'stopped'; this transport stops with it.
  if (typeof bridge.onChange === 'function') {
    try {
      offBridge = bridge.onChange((info) => { if (isPlain(info) && info.reason === 'stopped') stop(); });
    } catch {
      offBridge = null;
    }
  }
  return modTransport;
}

// The `/` catalog adapter with modCommands(conversation_id): true when a mod
// is attached to that conversation's session (null: the primary one). Every
// other method the wrapped catalog has is forwarded as it is, so
// GET /api/skills answers exactly what it did.
function withModCommands(skills, { bridge, mirror = null } = {}) {
  const base = skills && typeof skills === 'object' ? skills : {};
  const out = {};
  for (const k of ['catalog', 'resolve', 'lookup', 'clear']) {
    if (typeof base[k] === 'function') out[k] = (...args) => base[k](...args);
  }
  out.modCommands = async (conversationId) => {
    let cid = isStr(conversationId) ? conversationId : null;
    if (!cid && mirror && typeof mirror.snapshot === 'function') {
      try {
        const s = await mirror.snapshot({ level: 'basic' });
        cid = isPlain(s) && isStr(s.primary) ? s.primary : null;
      } catch {
        cid = null;
      }
    }
    return sessionOf(bridge, cid) !== null;
  };
  return out;
}

module.exports = { createModTransport, withModCommands, HANDED_BACK_MAX, CONFIRM_NET_MS };
