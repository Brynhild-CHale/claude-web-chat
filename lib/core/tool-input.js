// lib/core/tool-input.js — the one per-tool field table.
//
// Claude Code hands web-chat a tool call as a name and an input object: in every
// PreToolUse, PostToolUse and PermissionRequest hook, and in the transcript's
// tool_use blocks. Several readers need to know what the fields of each tool
// mean — which ones are a command, a path, a file's whole content — and each
// was on course to keep its own list. This is the one list:
//
//   the mirror hook        bounds a tool input before it crosses the socket, and
//                          labels the step (`tool.input`, `kind`, `label`,
//                          `call`, `input_hash` in envelope v1)
//   the ask hook           shows a permission request in full, or says it can't
//   the mirror engine      labels a transcript tool call exactly as the hook
//                          labelled the live step
//   the redactor           learns which file a result came from (fileOf), so it
//                          can withhold a sensitive one without naming a tool
//
//   projectToolInput(name, input, {profile}) → {input, truncated}
//       profile 'mirror'   an ALLOWLIST per tool, for the live envelope and the
//                          stream: a command, a path, a pattern, a URL, never a
//                          file's text (the editing tools carry their strings'
//                          UTF-8 sizes as `<field>_bytes` instead, so a 5 MB
//                          Write projects to a path and a number), and an
//                          MCP or unknown tool's top-level scalars only. At most
//                          MIRROR_MAX_BYTES of JSON.
//       profile 'display'  EVERY field, for a permission prompt the user answers
//                          in the browser: the fields that need room get it
//                          (a Bash command 8,000 characters, an Edit's strings
//                          4,000 each, a Write's content 4,000 plus its size),
//                          and anything else is bounded generically (strings
//                          1,000). Nothing is left out quietly: a field the user
//                          would approve without seeing is the failure here.
//       truncated          the input fields whose value a cap shortened or
//                          dropped, in input order. For 'display' a non-empty
//                          list means the request cannot be shown whole, so it
//                          is answered in the terminal. What the mirror
//                          allowlist omits by design (unlisted fields, the text
//                          behind a `_bytes` size) is not a cut.
//   toolKind(name)         the head word, safe to show any viewer: `Edit` for
//                          Edit, MultiEdit and NotebookEdit, `MCP` for every
//                          mcp__ tool (a server's name says which services the
//                          user connects), the tool card's word for the rest
//                          (`Web` for WebFetch, `Stop` for TaskStop, …), else
//                          the name itself when it is a plain word, else `Tool`.
//   toolSubject(name, input)  what the call is about, ≤ SUBJECT_MAX: a command's
//                          first line, a file's basename, the pattern, the URL's
//                          host, the description.
//   stepLabel(name, input)  `Edit · QueueRail.tsx`, `Bash · npm test`,
//                          `web-chat · render · md-title`; ≤ LABEL_MAX.
//   callLabel(name, input)  the call as written, `Bash(rm -rf dist && npm run
//                          build)`, line breaks shown as ↵; ≤ CALL_MAX.
//   fileOf(name, input)    the one file a tool reads or writes (`file_path`, or
//                          `notebook_path`), else null.
//   inputHash(input)       sha1 of stableStringify over the FULL input: a
//                          PermissionRequest is matched to its PreToolUse by an
//                          input deep-equal to it, which no projection keeps.
//
// Caps count characters (code points), so an emoji is never cut in half.
// Labels are text for a textContent sink, never HTML; whitespace runs collapse
// to one space. Control characters are the text guard's to strip, downstream.
//
// Dependency direction: core; this file imports only ./stable-json.

const { stableHash } = require('./stable-json');

const MIRROR_MAX_BYTES = 8 * 1024;
const DISPLAY_MAX_BYTES = 128 * 1024;
const SUBJECT_MAX = 300;
const LABEL_MAX = 200;
const CALL_MAX = 300;

// The generic bounds: an MCP or unknown tool, and every display field the table
// does not name.
const MIRROR_SCALAR_KEYS = 16;
const MIRROR_SCALAR_TEXT = 200;
const DISPLAY_TEXT = 1000;
const DISPLAY_KEYS = 64;
const DISPLAY_ITEMS = 64;
const DISPLAY_DEPTH = 6;

// A path, in each profile; a flag, number or short name (cut only when it
// arrives as a long string).
const PATH_MIRROR = 1024;
const PATH_DISPLAY = 4096;
const SCALAR = 64;

// How much of a long string a label ever looks at.
const SCAN_MAX = 16 * 1024;
// `truncated` stays bounded whatever the input: at most this many names, each
// at most NAME_MAX characters, then '…'.
const TRUNCATED_MAX = 64;
const NAME_MAX = 100;

const PROFILES = Object.freeze(['mirror', 'display']);

// ── small text helpers ──────────────────────────────────────────────────────

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An own, enumerable property, even for a key such as `__proto__` that plain
// assignment would turn into a prototype change (and so hide from the output).
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// At most `max` characters of `s`; the string itself when it fits.
function clip(s, max) {
  if (s.length <= max) return s;
  const head = Array.from(s.slice(0, max * 2));
  if (head.length <= max && s.length <= max * 2) return s;
  return head.slice(0, max).join('');
}

// At most `max` characters, ending in '…' (counted) when it was cut.
function ellipsize(s, max) {
  if (clip(s, max) === s) return s;
  return clip(s, max - 1).trimEnd() + '…';
}

function flat(s) {
  return typeof s === 'string' ? s.slice(0, SCAN_MAX).replace(/\s+/g, ' ').trim() : '';
}

function lineList(s) {
  return typeof s === 'string' ? s.slice(0, SCAN_MAX).split(/\r\n|\r|\n/).map(flat).filter(Boolean) : [];
}

// The first non-blank line, and ' …' when more follow.
function firstLine(s) {
  const lines = lineList(s);
  if (!lines.length) return '';
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
}

// Every non-blank line on one line, the breaks shown as ↵.
function oneLine(s) {
  return lineList(s).join(' ↵ ');
}

function basename(p) {
  if (typeof p !== 'string') return '';
  const t = p.trim().replace(/[\\/]+$/, '');
  return t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1) || p.trim();
}

// The host of a URL (credentials never included), or '' when it is not one.
function hostOf(u) {
  if (typeof u !== 'string' || !u) return '';
  try { return new URL(u).host; } catch { return ''; }
}

function asString(s) {
  return typeof s === 'string' ? s : '';
}

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

// ── field projectors ────────────────────────────────────────────────────────
// A projector takes (value, field, mode) and answers {entries: [[key, value]],
// cut} or null when it cannot represent the value: the mirror then leaves the
// field out (an allowlist), the display shows it generically (nothing hidden).

// A scalar: a string cut to `max`; a number, boolean or null as it is.
const scalar = (max) => (v, field) => {
  if (typeof v === 'string') {
    const c = clip(v, max);
    return { entries: [[field, c]], cut: c !== v };
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return { entries: [[field, v]], cut: false };
  return null;
};

// Never the text: its UTF-8 size, as `<field>_bytes`.
const size = (v, field) => (typeof v === 'string'
  ? { entries: [[`${field}_bytes`, byteLength(v)]], cut: false }
  : null);

// The text cut to `max`, and the size of the whole of it.
const textAndSize = (max) => (v, field) => {
  if (typeof v !== 'string') return null;
  const c = clip(v, max);
  return { entries: [[field, c], [`${field}_bytes`, byteLength(v)]], cut: c !== v };
};

// An array of objects, at most `max` of them, each through `spec`.
const list = (max, spec) => (v, field, mode) => {
  if (!Array.isArray(v)) return null;
  let cut = v.length > max;
  const items = [];
  for (const item of v.slice(0, max)) {
    if (isObject(item)) {
      items.push(projectFields(item, spec, mode, () => { cut = true; }));
    } else if (mode === 'display') {
      const b = bound(item, 1);
      if (b.cut) cut = true;
      items.push(b.value === undefined ? null : b.value);
    } else {
      cut = true;
    }
  }
  return { entries: [[field, items]], cut };
};

// MultiEdit, in the mirror: how many edits, and the sizes of their strings.
const editSizes = (v) => {
  if (!Array.isArray(v)) return null;
  let oldBytes = 0;
  let newBytes = 0;
  for (const e of v) {
    if (!isObject(e)) continue;
    if (typeof e.old_string === 'string') oldBytes += byteLength(e.old_string);
    if (typeof e.new_string === 'string') newBytes += byteLength(e.new_string);
  }
  return { entries: [['edits_count', v.length], ['old_string_bytes', oldBytes], ['new_string_bytes', newBytes]], cut: false };
};

// A copy of any JSON value inside the display bounds.
function bound(v, depth) {
  if (typeof v === 'string') {
    const c = clip(v, DISPLAY_TEXT);
    return { value: c, cut: c !== v };
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return { value: v, cut: false };
  if (typeof v !== 'object') return { value: undefined, cut: true };
  if (depth >= DISPLAY_DEPTH) return { value: undefined, cut: true };
  let cut = false;
  if (Array.isArray(v)) {
    if (v.length > DISPLAY_ITEMS) cut = true;
    const out = v.slice(0, DISPLAY_ITEMS).map((x) => {
      const b = bound(x, depth + 1);
      if (b.cut) cut = true;
      return b.value === undefined ? null : b.value;
    });
    return { value: out, cut };
  }
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= DISPLAY_KEYS) { cut = true; break; }
    const b = bound(v[k], depth + 1);
    if (b.cut) cut = true;
    if (b.value !== undefined) { put(out, k, b.value); n++; }
  }
  return { value: out, cut };
}

// One object through a field spec. In 'display' mode every field the spec does
// not handle is shown generically; in 'mirror' mode it is left out.
function projectFields(src, spec, mode, onCut) {
  const out = {};
  const handled = new Set();
  for (const field of Object.keys(spec)) {
    if (!Object.hasOwn(src, field)) continue;
    const r = spec[field](src[field], field, mode);
    if (!r) continue;
    for (const [k, v] of r.entries) put(out, k, v);
    if (r.cut) onCut(field);
    handled.add(field);
  }
  if (mode !== 'display') return out;
  for (const k of Object.keys(src)) {
    if (handled.has(k)) continue;
    // A computed key (`content_bytes`) wins over an input field of that name,
    // and the field it hid is reported, not dropped in silence.
    if (Object.hasOwn(out, k) || Object.keys(out).length >= DISPLAY_KEYS) { onCut(k); continue; }
    const b = bound(src[k], 1);
    if (b.cut) onCut(k);
    if (b.value !== undefined) put(out, k, b.value);
  }
  return out;
}

// An MCP or unknown tool, in the mirror: top-level scalars only.
function projectScalars(src, onCut) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (!(v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) continue;
    if (n >= MIRROR_SCALAR_KEYS) { onCut(k); continue; }
    const r = scalar(MIRROR_SCALAR_TEXT)(v, k);
    put(out, k, r.entries[0][1]);
    if (r.cut) onCut(k);
    n++;
  }
  return out;
}

// The JSON size bound. Caps per field already keep any real input well inside
// it; this is for the pathological one (a command of control characters, which
// JSON spells six bytes each, CJK text, a hundred huge keys). Every string
// longer than a shared limit is cut to it, the limit halving each pass, so the
// work is a few passes however many strings there are; once no string is
// worth cutting, the largest fields go.
function fitBytes(out, maxBytes, onCut) {
  const bytes = () => byteLength(JSON.stringify(out));
  let total = bytes();
  let limit = longestString(out);
  while (total > maxBytes && limit > 16) {
    limit >>= 1;
    eachString(out, (holder, key, top, s) => {
      if (s.length <= limit) return;
      let cut = s.slice(0, limit);
      if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
      put(holder, key, cut);
      onCut(top);
    });
    total = bytes();
  }
  while (total > maxBytes) {
    let largest = null;
    let largestBytes = -1;
    for (const k of Object.keys(out)) {
      const b = byteLength(JSON.stringify(k)) + byteLength(JSON.stringify(out[k]) || '');
      if (b > largestBytes) { largest = k; largestBytes = b; }
    }
    if (largest === null) return;
    delete out[largest];
    onCut(largest);
    total = bytes();
  }
}

// fn(holder, key, topLevelField, string) for every string value under `root`.
function eachString(root, fn) {
  const walk = (holder, key, top) => {
    const v = holder[key];
    if (typeof v === 'string') fn(holder, key, top, v);
    else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) walk(v, k, top);
  };
  for (const k of Object.keys(root)) walk(root, k, k);
}

function longestString(root) {
  let longest = 0;
  eachString(root, (holder, key, top, s) => { if (s.length > longest) longest = s.length; });
  return longest;
}

// ── the table ───────────────────────────────────────────────────────────────
// Per tool: `head` (toolKind and the label's head word), `file` (the field
// fileOf reads; its basename is the subject and its path the call), `subject`
// and `call` (from the raw input), and the field spec of each profile. A field
// a display spec does not name is shown generically.

const flag = scalar(SCALAR);
const firstQuestion = (i) => {
  const q = Array.isArray(i.questions) && isObject(i.questions[0]) ? i.questions[0] : null;
  return q ? (flat(q.question) || flat(q.header)) : '';
};
const todoCounts = (i) => {
  if (!Array.isArray(i.todos)) return '';
  const done = i.todos.filter((t) => isObject(t) && t.status === 'completed').length;
  return `${done} / ${i.todos.length}`;
};

const TOOLS = new Map(Object.entries({
  Bash: {
    head: 'Bash',
    subject: (i) => firstLine(i.command) || flat(i.description),
    call: (i) => oneLine(i.command),
    mirror: { command: scalar(2000), description: scalar(300), run_in_background: flag, timeout: flag },
    display: { command: scalar(8000) },
  },
  Read: {
    head: 'Read', file: 'file_path',
    mirror: { file_path: scalar(PATH_MIRROR) },
    display: { file_path: scalar(PATH_DISPLAY) },
  },
  Edit: {
    head: 'Edit', file: 'file_path',
    mirror: { file_path: scalar(PATH_MIRROR), old_string: size, new_string: size },
    display: { file_path: scalar(PATH_DISPLAY), old_string: scalar(4000), new_string: scalar(4000) },
  },
  MultiEdit: {
    head: 'Edit', file: 'file_path',
    mirror: { file_path: scalar(PATH_MIRROR), edits: editSizes },
    display: {
      file_path: scalar(PATH_DISPLAY),
      edits: list(20, { old_string: scalar(4000), new_string: scalar(4000) }),
    },
  },
  NotebookEdit: {
    head: 'Edit', file: 'notebook_path',
    mirror: {
      notebook_path: scalar(PATH_MIRROR), cell_id: scalar(100), cell_type: flag, edit_mode: flag, new_source: size,
    },
    display: { notebook_path: scalar(PATH_DISPLAY), new_source: textAndSize(4000) },
  },
  Write: {
    head: 'Write', file: 'file_path',
    mirror: { file_path: scalar(PATH_MIRROR), content: size },
    display: { file_path: scalar(PATH_DISPLAY), content: textAndSize(4000) },
  },
  Grep: {
    head: 'Grep',
    subject: (i) => flat(i.pattern),
    call: (i) => oneLine(i.pattern),
    mirror: { pattern: scalar(500), path: scalar(PATH_MIRROR), glob: scalar(200) },
    display: { path: scalar(PATH_DISPLAY) },
  },
  Glob: {
    head: 'Glob',
    subject: (i) => flat(i.pattern),
    call: (i) => oneLine(i.pattern),
    mirror: { pattern: scalar(500), path: scalar(PATH_MIRROR), glob: scalar(200) },
    display: { path: scalar(PATH_DISPLAY) },
  },
  WebFetch: {
    head: 'Web',
    subject: (i) => hostOf(i.url),
    call: (i) => flat(i.url),
    mirror: { url: scalar(2000) },
    display: { url: scalar(4000), prompt: scalar(4000) },
  },
  WebSearch: {
    head: 'Search',
    subject: (i) => flat(i.query),
    call: (i) => flat(i.query),
    mirror: { query: scalar(500) },
    display: {},
  },
  Agent: {
    head: 'Agent',
    subject: (i) => flat(i.description) || flat(i.subagent_type),
    call: (i) => flat(i.description) || flat(i.subagent_type),
    mirror: { description: scalar(300), subagent_type: scalar(100), run_in_background: flag, prompt: scalar(300) },
    display: { prompt: scalar(8000) },
  },
  Skill: {
    head: 'Skill',
    subject: (i) => flat(i.skill),
    call: (i) => flat(i.skill),
    mirror: { skill: scalar(200), args: scalar(200) },
    display: {},
  },
  TodoWrite: {
    head: 'Todo',
    subject: todoCounts,
    call: todoCounts,
    mirror: { todos: list(30, { content: scalar(160), status: flag }) },
    display: {},
  },
  Monitor: {
    head: 'Monitor',
    subject: (i) => flat(i.description) || firstLine(i.command) || hostOf(isObject(i.ws) ? i.ws.url : ''),
    call: (i) => oneLine(i.command) || flat(isObject(i.ws) ? i.ws.url : '') || flat(i.description),
    mirror: { description: scalar(300), command: scalar(500) },
    display: { command: scalar(8000) },
  },
  TaskStop: {
    head: 'Stop',
    subject: (i) => flat(i.task_id) || flat(i.shell_id),
    call: (i) => flat(i.task_id) || flat(i.shell_id),
    // shell_id is task_id's deprecated name: the same id, never content.
    mirror: { task_id: scalar(100), shell_id: scalar(100) },
    display: {},
  },
  AskUserQuestion: {
    head: 'Question',
    subject: firstQuestion,
    call: firstQuestion,
    mirror: {
      questions: list(4, { header: scalar(60), question: scalar(300), options: list(6, { label: scalar(100) }) }),
    },
    display: {
      questions: list(8, {
        header: scalar(200), question: scalar(4000),
        options: list(12, { label: scalar(500), description: scalar(2000) }),
      }),
    },
  },
  ExitPlanMode: {
    head: 'Plan',
    subject: () => '',
    call: () => '',
    // The answer frame shows the plan read from its file, so the display
    // carries only the plan's size here, and the mirror only its path.
    mirror: { planFilePath: scalar(PATH_MIRROR) },
    display: { planFilePath: scalar(PATH_DISPLAY), plan: size },
  },
}));

// ── names ───────────────────────────────────────────────────────────────────

const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

function isMcp(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

// 'mcp__<server>__<tool>' → {server, tool}; a server's own name may not hold '__'.
function mcpParts(name) {
  const rest = name.slice(5);
  const at = rest.indexOf('__');
  return at < 0 ? { server: rest, tool: '' } : { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

function entryOf(name) {
  return typeof name === 'string' && !isMcp(name) ? TOOLS.get(name) : undefined;
}

function toolKind(name) {
  if (typeof name !== 'string') return 'Tool';
  if (isMcp(name)) return 'MCP';
  const entry = TOOLS.get(name);
  if (entry) return entry.head;
  return KIND_RE.test(name) && !name.includes('__') ? name : 'Tool';
}

// The label's head: the kind for a known tool, `server · tool` for an MCP one,
// and an unknown tool's own name.
function labelHead(name) {
  if (typeof name !== 'string' || !flat(name)) return 'Tool';
  if (isMcp(name)) {
    const { server, tool } = mcpParts(name);
    return ellipsize([server, tool].map(flat).filter(Boolean).join(' · '), NAME_MAX) || 'MCP';
  }
  const entry = TOOLS.get(name);
  return entry ? entry.head : ellipsize(flat(name), NAME_MAX);
}

// What a call to a tool the table does not know is about: the first of the
// fields that usually name one. web-chat's own tools act on a pane or a
// markdown item, so their id comes first.
const PICK_TEXT = ['title', 'subject', 'description', 'name', 'query', 'pattern', 'skill'];
const PICK_PATH = ['file_path', 'notebook_path', 'path'];
const PICK_ID = ['id', 'task_id'];

function genericSubject(name, i) {
  const first = isMcp(name) && mcpParts(name).server === 'web-chat' ? ['id'] : [];
  for (const k of [...first, ...PICK_TEXT]) if (flat(i[k])) return flat(i[k]);
  const host = hostOf(i.url);
  if (host) return host;
  for (const k of PICK_PATH) if (flat(i[k])) return basename(i[k]);
  for (const k of PICK_ID) if (flat(i[k])) return flat(i[k]);
  return firstLine(i.command);
}

function rawSubject(name, i) {
  const entry = entryOf(name);
  if (!entry) return genericSubject(name, i);
  if (entry.subject) return entry.subject(i);
  return entry.file ? basename(i[entry.file]) : '';
}

function toolSubject(name, input) {
  return ellipsize(flat(rawSubject(name, isObject(input) ? input : {})), SUBJECT_MAX);
}

function stepLabel(name, input) {
  const head = labelHead(name);
  const subject = toolSubject(name, input);
  return ellipsize(subject ? `${head} · ${subject}` : head, LABEL_MAX);
}

function callLabel(name, input) {
  const i = isObject(input) ? input : {};
  let head;
  if (typeof name !== 'string' || !flat(name)) head = 'Tool';
  else if (isMcp(name)) head = labelHead(name);
  else head = ellipsize(flat(name), NAME_MAX);
  const entry = entryOf(name);
  let arg;
  if (!entry) arg = genericSubject(name, i);
  else if (entry.call) arg = entry.call(i);
  else arg = entry.file ? flat(i[entry.file]) : '';
  arg = asString(arg);
  if (!arg) return ellipsize(head, CALL_MAX);
  const room = CALL_MAX - Array.from(head).length - 2;
  if (room < 16) return ellipsize(`${head}(${arg})`, CALL_MAX);
  return `${head}(${ellipsize(arg, room)})`;
}

function fileOf(name, input) {
  const entry = entryOf(name);
  if (!entry || !entry.file || !isObject(input)) return null;
  const p = input[entry.file];
  return typeof p === 'string' && p ? p : null;
}

function inputHash(input) {
  return stableHash(input);
}

// ── the projection ──────────────────────────────────────────────────────────

function projectToolInput(name, input, { profile } = {}) {
  if (!PROFILES.includes(profile)) {
    throw new TypeError(`projectToolInput: profile must be 'mirror' or 'display', not ${JSON.stringify(profile)}`);
  }
  const cut = new Set();
  const onCut = (field) => cut.add(field);
  let out = {};
  if (isObject(input)) {
    const entry = entryOf(name);
    if (profile === 'mirror') out = entry ? projectFields(input, entry.mirror, 'mirror', onCut) : projectScalars(input, onCut);
    else out = projectFields(input, entry ? entry.display : {}, 'display', onCut);
    fitBytes(out, profile === 'mirror' ? MIRROR_MAX_BYTES : DISPLAY_MAX_BYTES, onCut);
  } else if (profile === 'display' && input != null) {
    // Not an object at all: nothing can be shown field by field.
    cut.add('…');
  }
  return { input: out, truncated: truncatedList(cut, input) };
}

function truncatedList(cut, input) {
  const order = new Map(isObject(input) ? Object.keys(input).map((k, n) => [k, n]) : []);
  const rank = (k) => (order.has(k) ? order.get(k) : Number.MAX_SAFE_INTEGER);
  const names = [...cut].sort((a, b) => rank(a) - rank(b)).map((k) => ellipsize(String(k), NAME_MAX));
  return names.length > TRUNCATED_MAX ? [...names.slice(0, TRUNCATED_MAX), '…'] : names;
}

module.exports = {
  PROFILES,
  MIRROR_MAX_BYTES,
  DISPLAY_MAX_BYTES,
  SUBJECT_MAX,
  LABEL_MAX,
  CALL_MAX,
  projectToolInput,
  toolKind,
  toolSubject,
  stepLabel,
  callLabel,
  fileOf,
  inputHash,
};
