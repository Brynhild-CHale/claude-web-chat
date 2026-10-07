// lib/server/composer.js — the composer's rules, once (spec §6.3).
//
// A message the user types on the page reaches Claude as a quoted block of a
// wake (§6.5). Everything that decides whether such a message may be queued,
// and in what shape, lives here: the text's normalisation, the leading-skill
// parse, the files check, the limits, the rate limiter and BUILTIN_COMMANDS.
// The queue routes (lib/server/routes/queue.js, U61a) and the release
// scheduler (lib/server/queue-release.js, U63) both call it, so a message is
// validated by one set of rules whether it is sent, edited or released later.
//
// Pure: no I/O, no timers, no module state. The two lookups it needs are
// injected, so the module is testable without a route, an index or a catalog.
//
// ── The two adapters ─────────────────────────────────────────────────────────
//
// skills   (the `/` catalog, lib/server/skills.js, U58; wired by U66a as
//          ctx.skills, one instance per daemon):
//
//            skills.resolve(name, {conversation_id}) → 'skill' | 'user_only' | null
//
//          sync or as a Promise. `name` is passed as typed (it already matches
//          SKILL_NAME_RE); `conversation_id` is the message's target, or null
//          for the primary conversation. 'skill': a model-invocable skill the
//          target conversation can run. 'user_only': a skill whose frontmatter
//          says `disable-model-invocation` (the catalog excludes these from its
//          listing, but answers for them here so the refusal can say why).
//          null: unknown. Any other answer, or a throw, counts as null.
//          BUILTIN_COMMANDS is checked here before the adapter is asked, and
//          the catalog imports the same list to exclude those names (§6.2).
//
// projectFiles  (the `@` index, lib/server/project-files.js, U57; wired by U66a
//          as ctx.projectFiles, one instance per daemon):
//
//            projectFiles.check(rel) → {ok: true, path, bytes}
//                                    | {ok: false, why, category?}
//
//          sync or as a Promise, called as-is with the path the request named.
//          `why` is one of outside, symlink, sensitive (with its `category`),
//          ignored, missing, not-a-file, and is passed through to the refusal.
//          A throw or a malformed answer refuses the file as 'unavailable', as
//          does a missing adapter (reachable only before U66a wires it).
//
// ── What is NOT here ─────────────────────────────────────────────────────────
//
// No route, queue state, id minting or answer modes (U61a); no file index or
// skill catalog (U57, U58); no envelope, and so no ENVELOPE_MAX, which lives in
// lib/channel/envelope.js (U59) because lib/channel may not import lib/server.
// The one character guard is lib/core/text.js's stripControls (§6.5): this
// module calls it and keeps no character set of its own.

const { stripControls } = require('../core/text');

// ── Limits (§6.3) ────────────────────────────────────────────────────────────

// Characters are UTF-16 code units: the unit Claude Code's string limit and
// gate V29 measure.
const MESSAGE_MAX = 3000;
// The longest args the Skill line repeats (§6.5). An explicit `skill` field's
// args over it are refused; args parsed from the text never are (MESSAGE_MAX
// bounds them) and, past it, are stored as {name, args_in_text: true}, so
// lib/channel never needs this number (ruling C2 (d)).
const SKILL_ARGS_MAX = 300;
const FILES_MAX = 5;
const PATH_MAX = 240;
const QUEUED_MESSAGES_MAX = 50;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60000;

const SKILL_NAME_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEND_MODES = Object.freeze(['auto', 'now', 'hold']);

// Claude Code's own terminal commands: a UX guard (the user is told to type
// them in the terminal), not security. The list's one home; the `/` catalog
// (lib/server/skills.js) imports it to exclude the same names.
const BUILTIN_COMMANDS = Object.freeze([
  'clear', 'compact', 'model', 'resume', 'exit', 'quit', 'config', 'login',
  'logout', 'rewind', 'permissions', 'add-dir', 'mcp', 'hooks', 'agents', 'init',
  'memory', 'plugin', 'export', 'cost', 'status', 'context', 'doctor', 'help',
  'vim', 'terminal-setup', 'ide', 'upgrade', 'output-style', 'statusline',
  'privacy-settings', 'release-notes', 'bug', 'pr-comments',
  'install-github-app', 'todos', 'usage',
]);
const BUILTIN_SET = new Set(BUILTIN_COMMANDS);

// ── Refusals ─────────────────────────────────────────────────────────────────

// Every refusal code of the composer's routes (§6.3), the validation's and the
// route's own (too_many, rate_limited, disabled, not_editable), so the route
// answers each with the same hint. bad_request is not in §6.3: a malformed
// field (notes-C Q6), which must not be guessed at.
const REFUSALS = Object.freeze([
  'bad_request', 'empty', 'too_large', 'unknown_skill', 'user_only_skill',
  'builtin_command', 'file_refused', 'too_many_files', 'too_many',
  'rate_limited', 'disabled', 'not_editable',
]);

// One short sentence per code. `<name>` is filled with the skill's name.
const HINTS = Object.freeze({
  bad_request: 'The request is malformed: send text, skill, files, send and conversation_id as the composer does.',
  empty: 'Type a message, pick a skill or attach a file.',
  too_large: `A message is at most ${MESSAGE_MAX.toLocaleString('en-US')} characters.`,
  unknown_skill: '/<name> is not a skill Claude can run in this conversation.',
  user_only_skill: 'Only you can run /<name>: type it in the terminal.',
  builtin_command: '/<name> is a Claude Code command: type it in the terminal.',
  file_refused: 'That file cannot be attached.',
  too_many_files: `A message attaches at most ${FILES_MAX} files.`,
  too_many: `At most ${QUEUED_MESSAGES_MAX} messages can wait in the queue: send or remove one first.`,
  rate_limited: 'Too many messages in the last minute: wait a moment and try again.',
  disabled: 'Sending messages is turned off for this project.',
  not_editable: 'That message has already gone: only a queued or held message can be edited.',
});

// too_large names its field; each field has its own sentence.
const TOO_LARGE_HINTS = Object.freeze({
  text: HINTS.too_large,
  args: `A skill's arguments are at most ${SKILL_ARGS_MAX} characters.`,
  path: `A file path is at most ${PATH_MAX} characters.`,
});

// file_refused names why; each answer of check() has its own sentence.
const FILE_HINTS = Object.freeze({
  outside: 'Only a file inside this project can be attached.',
  symlink: 'A symbolic link cannot be attached.',
  sensitive: 'That file looks like it holds secrets, so it cannot be attached.',
  ignored: 'An ignored file cannot be attached.',
  missing: 'That file does not exist in this project.',
  'not-a-file': 'Only a regular file can be attached.',
  unavailable: 'The project file index is not available yet.',
});

// A name echoed in a refusal: it came from the request, so it is cleaned and
// capped before it is shown.
const echo = (s) => stripControls(String(s)).slice(0, 64);

function refuse(refused, extra = {}) {
  let hint = HINTS[refused];
  if (refused === 'too_large' && TOO_LARGE_HINTS[extra.field]) hint = TOO_LARGE_HINTS[extra.field];
  if (refused === 'file_refused' && FILE_HINTS[extra.why]) hint = FILE_HINTS[extra.why];
  if ('name' in extra) hint = hint.replace('<name>', extra.name);
  return { ok: false, refused, hint, ...extra };
}

// ── Text ─────────────────────────────────────────────────────────────────────

// CRLF and a lone CR → LF, then the one guard keeping `\n` and `\t`, then the
// trailing whitespace only: a pasted block's leading indentation survives.
function normalizeText(s) {
  if (typeof s !== 'string') return '';
  return stripControls(s.replace(/\r\n?/g, '\n'), { keepNewlines: true }).trimEnd();
}

// A leading `/<name>` and everything after it. As Claude Code's own parser
// (2.1.292): the name ends at the first space or line break, and the args are
// everything after the name, every line, trimmed (ruling C2 (d)). null when
// the text does not open with `/` or the token fails SKILL_NAME_RE.
function parseLeadingSkill(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*\/(\S+)/.exec(text);
  if (!m || !SKILL_NAME_RE.test(m[1])) return null;
  return { name: m[1], args: text.slice(m[0].length).trim() };
}

// 'builtin' | 'user_only' | 'skill' | null, always as a Promise.
async function classifySkill(name, { skills, conversation_id = null } = {}) {
  if (typeof name !== 'string') return null;
  if (BUILTIN_SET.has(name.toLowerCase())) return 'builtin';
  if (!skills || typeof skills.resolve !== 'function') return null;
  let answer;
  try {
    answer = await skills.resolve(name, { conversation_id });
  } catch {
    return null;
  }
  return answer === 'skill' || answer === 'user_only' ? answer : null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The body's shape, before any value is looked at: the field that is wrong, or
// null.
function badField(body) {
  if (!isPlainObject(body)) return 'body';
  if (body.text !== undefined && typeof body.text !== 'string') return 'text';
  if (body.skill !== undefined && body.skill !== null) {
    const k = body.skill;
    if (!isPlainObject(k) || typeof k.name !== 'string') return 'skill';
    if (k.args !== undefined && typeof k.args !== 'string') return 'skill';
  }
  if (body.files !== undefined) {
    if (!Array.isArray(body.files)) return 'files';
    if (!body.files.every((f) => typeof f === 'string' || (isPlainObject(f) && 'path' in f))) return 'files';
  }
  if (body.send !== undefined && !SEND_MODES.includes(body.send)) return 'send';
  if (body.conversation_id !== undefined && body.conversation_id !== null
    && !(typeof body.conversation_id === 'string' && CONVERSATION_ID_RE.test(body.conversation_id))) {
    return 'conversation_id';
  }
  return null;
}

// The skill the message asks for: {skill} (one of the two stored shapes, or
// null) or {refusal}.
async function resolveSkill(explicit, text, { skills, conversation_id }) {
  if (explicit) {
    const name = explicit.name;
    if (!SKILL_NAME_RE.test(name)) return { refusal: refuse('unknown_skill', { name: echo(name) }) };
    const cls = await classifySkill(name, { skills, conversation_id });
    if (cls === 'builtin') return { refusal: refuse('builtin_command', { name }) };
    if (cls === 'user_only') return { refusal: refuse('user_only_skill', { name }) };
    if (cls !== 'skill') return { refusal: refuse('unknown_skill', { name }) };
    // An explicit field's args have no quoted text to point at, so they must
    // fit on the Skill line: one line, at most SKILL_ARGS_MAX.
    const args = normalizeText(explicit.args).replace(/\n/g, ' ').trim();
    if (args.length > SKILL_ARGS_MAX) return { refusal: refuse('too_large', { field: 'args', max: SKILL_ARGS_MAX }) };
    return { skill: { name, args } };
  }
  const parsed = parseLeadingSkill(text);
  if (!parsed) return { skill: null };
  const cls = await classifySkill(parsed.name, { skills, conversation_id });
  if (cls === 'builtin') return { refusal: refuse('builtin_command', { name: parsed.name }) };
  if (cls === 'user_only') return { refusal: refuse('user_only_skill', { name: parsed.name }) };
  if (cls !== 'skill') return { skill: null };
  // The text is kept as typed; the stored shape tells the Skill line whether
  // to repeat the args or point at the quoted text after /name (§6.5).
  if (parsed.args.length <= SKILL_ARGS_MAX) return { skill: { name: parsed.name, args: parsed.args } };
  return { skill: { name: parsed.name, args_in_text: true } };
}

// The attached files: {files: [{path, bytes}]} or {refusal}.
async function checkFiles(list, projectFiles) {
  const raw = (list || []).map((f) => (typeof f === 'string' ? f : f.path));
  const distinct = [...new Set(raw)];
  if (distinct.length > FILES_MAX) return { refusal: refuse('too_many_files', { max: FILES_MAX }) };
  const files = [];
  const seen = new Set();
  for (const p of distinct) {
    if (typeof p !== 'string' || p === '') {
      return { refusal: refuse('file_refused', { path: typeof p === 'string' ? p : null, why: 'outside' }) };
    }
    if (p.length > PATH_MAX) return { refusal: refuse('too_large', { field: 'path', max: PATH_MAX, path: p }) };
    if (!projectFiles || typeof projectFiles.check !== 'function') {
      return { refusal: refuse('file_refused', { path: p, why: 'unavailable' }) };
    }
    let answer;
    try {
      answer = await projectFiles.check(p);
    } catch {
      answer = null;
    }
    if (answer && answer.ok === true && typeof answer.path === 'string') {
      // Two spellings the index resolves to one file attach it once.
      if (!seen.has(answer.path)) {
        seen.add(answer.path);
        files.push({ path: answer.path, bytes: answer.bytes });
      }
      continue;
    }
    if (answer && answer.ok === false && typeof answer.why === 'string') {
      const extra = { path: p, why: answer.why };
      if (answer.category !== undefined) extra.category = answer.category;
      return { refusal: refuse('file_refused', extra) };
    }
    return { refusal: refuse('file_refused', { path: p, why: 'unavailable' }) };
  }
  return { files };
}

// A composer message as the route received it → the message to store, or a
// refusal ({ok: false, refused, hint, …}). Never throws for a bad body.
async function validateMessage(body, { skills, projectFiles } = {}) {
  const field = badField(body);
  if (field) return refuse('bad_request', { field });

  const conversation_id = body.conversation_id ?? null;
  const send = body.send ?? 'auto';

  const text = normalizeText(body.text);
  const chars = text.length;
  if (chars > MESSAGE_MAX) return refuse('too_large', { field: 'text', max: MESSAGE_MAX });

  const s = await resolveSkill(body.skill || null, text, { skills, conversation_id });
  if (s.refusal) return s.refusal;

  const f = await checkFiles(body.files, projectFiles);
  if (f.refusal) return f.refusal;

  if (!text && !s.skill && f.files.length === 0) return refuse('empty');

  return { ok: true, message: { text, skill: s.skill, files: f.files, chars, conversation_id, send } };
}

// An edit of a queued or held message item: the body's present fields (text,
// skill, files) replace the item's and the result is validated as a send is.
// send and conversation_id are not editable and are ignored. A body without a
// `skill` field re-parses the leading skill from the merged text, so a stored
// skill is never fed back as an explicit one; a body with one takes it as
// explicit (§6.3's PATCH row as amended, ruling C2 (d)). Answers
// {ok: true, message: {text, skill, files, chars, conversation_id}} with the
// item's conversation_id, or a refusal.
async function validateEdit(item, body, deps = {}) {
  if (!isPlainObject(item) || !isPlainObject(body)) return refuse('bad_request', { field: 'body' });
  const merged = {
    text: body.text !== undefined ? body.text : (item.text ?? ''),
    files: body.files !== undefined ? body.files : (Array.isArray(item.files) ? item.files : []),
    // The catalog answers for the item's own conversation.
    conversation_id: item.conversation_id ?? null,
  };
  if (body.skill !== undefined) merged.skill = body.skill;
  const r = await validateMessage(merged, deps);
  if (!r.ok) return r;
  const { text, skill, files, chars } = r.message;
  return { ok: true, message: { text, skill, files, chars, conversation_id: item.conversation_id ?? null } };
}

// ── Rate limit ───────────────────────────────────────────────────────────────

// A sliding window over accepted actions: take() records one and answers ok,
// or answers how many whole seconds (at least 1) until the oldest leaves the
// window. The caller takes only for what it accepted (a refusal does not use up
// the budget, notes-C D10). One instance per mountQueueRoutes call.
function createRateLimit({ max = RATE_MAX, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  let stamps = [];
  return {
    take() {
      const t = now();
      stamps = stamps.filter((s) => s > t - windowMs);
      if (stamps.length < max) {
        stamps.push(t);
        return { ok: true };
      }
      const wait = stamps[0] + windowMs - t;
      return { ok: false, retry_after: Math.max(1, Math.ceil(wait / 1000)) };
    },
    reset() {
      stamps = [];
    },
  };
}

module.exports = {
  MESSAGE_MAX,
  SKILL_ARGS_MAX,
  FILES_MAX,
  PATH_MAX,
  QUEUED_MESSAGES_MAX,
  RATE_MAX,
  RATE_WINDOW_MS,
  SKILL_NAME_RE,
  CONVERSATION_ID_RE,
  SEND_MODES,
  BUILTIN_COMMANDS,
  REFUSALS,
  HINTS,
  TOO_LARGE_HINTS,
  FILE_HINTS,
  normalizeText,
  parseLeadingSkill,
  classifySkill,
  validateMessage,
  validateEdit,
  createRateLimit,
};
