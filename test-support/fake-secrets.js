// Fake credentials, in every format lib/core/redact.js masks, for the tests that
// prove nothing secret survives it: the rule tests, and the mirror's end-to-end
// redaction sweep.
//
// NEVER A REAL VALUE. Every value is drawn from a seeded PRNG (mulberry32) over
// the format's alphabet, every host is an example.com/example.org name, and no
// literal from a real transcript, a vendor's documentation or this machine is
// copied in — not even the published "example" keys. A seed reproduces the whole
// set byte for byte, so a failing case names its seed and can be replayed.
//
// The markers a scanner keys on (the PEM header, the mask's opening) are built by
// concatenation rather than written out, so this file does not count as a second
// home of either literal: lib/core/redact.js is the one place that spells them.
//
// Each fake is one carrier of one format:
//
//   {
//     id,        unique, e.g. 'github-ghp'
//     rule,      the RULES id expected to mask it (its label is the rule's label)
//     secrets,   the strings that must not survive, whole or as any 8-char window
//     text,      a realistic line (or block) carrying them
//     tail:      { text, secret, secrets } — the same carrier cut short inside the
//                value at the end of a text (Claude Code's previews and summaries
//                cut that way), the fragment, and everything in the tail that
//                must not survive (the fragment, plus any whole line before it)
//     json?,     a structured carrier for redactValue, where the format is a key
//     context?,  the redaction context the format needs (env-dotenv, env-dump)
//     known?,    the label a known value is registered under (rule 'known')
//   }
//
// fakeSecrets({ seed }) → the array; findLeaks(haystack, fakes) → what survived;
// fakeCorpus({ seed, bytes }) → a mixed text with fakes sprinkled through it;
// jsonText(text, { levels, tail }) → a carrier as JSON text holds it.

const PEM_DASHES = '-----';
const PEM_TAIL = ['PRIVATE', 'KEY'].join(' ') + PEM_DASHES;   // the marker, assembled
const pem = (kind, edge) => `${PEM_DASHES}${edge} ${kind ? kind + ' ' : ''}${PEM_TAIL}`;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
const HEX = DIGITS + 'abcdef';
const UPNUM = UPPER + DIGITS;
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '-_';
// Password-ish: symbols a password manager emits that carry no shell or code
// meaning (a value holding `$(`, a backtick or `;` is display-safe by design).
const PASSWORD = ALNUM + '!@#%^*_-+=~';
const URL_PASSWORD = ALNUM + '!*_-~';

// Substrings that would make a value look like ANOTHER format (and so be masked
// under another rule's label): a generated value never contains one.
const FOREIGN = /eyj|sk[-_]|gh[pousr]_|github_pat|akia|asia|xox|xapp|aiza|gocspx|ya29|npm_|hf_|whsec|rk_(?:live|test)|_live_|_test_|private|-----/i;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function classesOf(s) {
  return (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0);
}

function makeGen(seed) {
  const next = mulberry32(seed);
  const char = (alphabet) => alphabet[Math.floor(next() * alphabet.length)];
  const raw = (n, alphabet) => { let s = ''; for (let i = 0; i < n; i++) s += char(alphabet); return s; };
  // A value as a real generator would emit it, retried (deterministically) until
  // it is unmistakably random: every character class its alphabet offers, the
  // first eight characters mixed too (that is what a tail fragment keeps), it
  // starts with a letter or digit, and nothing in it reads as another format.
  function strong(n, alphabet) {
    const want = classesOf(alphabet);
    for (let i = 0; i < 1000; i++) {
      const s = raw(n, alphabet);
      if (classesOf(s) < want || classesOf(s.slice(0, 8)) < Math.min(2, want)) continue;
      if (!/^[A-Za-z0-9]/.test(s) || FOREIGN.test(s)) continue;
      return s;
    }
    throw new Error(`fake-secrets: no value of ${n} from a ${alphabet.length}-letter alphabet in 1000 tries`);
  }
  const digits = (n) => char('123456789') + raw(n - 1, DIGITS);
  const word = () => raw(3 + Math.floor(next() * 5), LOWER);
  const uuid = () => [8, 4, 4, 4, 12].map((n) => raw(n, HEX)).join('-');
  return { next, raw, strong, digits, word, uuid };
}

const b64url = (s) => Buffer.from(s).toString('base64url');
const b64 = (s) => Buffer.from(s).toString('base64');

// One fake per carrier. The tail keeps the first `cut` characters of `from`
// (the first secret unless named) after `tail` (the text before that secret
// unless given), so a tail always ENDS inside a secret, optionally with the
// ellipsis a summary appends. `extra` names secrets the tail carries whole (a
// PEM body line before the cut).
function fake(id, rule, { secrets, text, tail, cut, from, extra = [], json, context, known, ellipsis = false }) {
  const source = from || secrets[0];
  const fragment = source.slice(0, cut);
  const lead = tail != null ? tail : text.slice(0, text.indexOf(source));
  const out = {
    id,
    rule,
    secrets,
    text,
    tail: { text: lead + fragment + (ellipsis ? '…' : ''), secret: fragment, secrets: [fragment, ...extra] },
  };
  if (json !== undefined) out.json = json;
  if (context) out.context = context;
  if (known) out.known = known;
  return out;
}

function fakeSecrets({ seed = 0x5eed } = {}) {
  const g = makeGen(seed);
  const all = [];
  const add = (...a) => all.push(fake(...a));

  // ── tier 1 ────────────────────────────────────────────────────────────────

  for (const [id, kind] of [['pem-rsa', 'RSA'], ['pem-openssh', 'OPENSSH'], ['pem-pkcs8', ''], ['pem-ec', 'EC']]) {
    const lines = Array.from({ length: 6 }, () => g.strong(64, B64));
    const block = [pem(kind, 'BEGIN'), ...lines, pem(kind, 'END')].join('\n');
    add(id, 'pem', {
      secrets: lines,
      text: `the deploy key:\n${block}\nthat is all`,
      // The tail: a block cut inside its second line, before its END (a
      // preview, a summary, a window).
      tail: `cat deploy_key\n${pem(kind, 'BEGIN')}\n${lines[0]}\n`,
      from: lines[1],
      extra: [lines[0]],
      cut: 40,
    });
  }
  {
    const lines = Array.from({ length: 5 }, () => g.strong(64, B64));
    const kind = 'PGP';
    const head = `${PEM_DASHES}BEGIN ${kind} ${['PRIVATE', 'KEY', 'BLOCK'].join(' ')}${PEM_DASHES}`;
    const foot = `${PEM_DASHES}END ${kind} ${['PRIVATE', 'KEY', 'BLOCK'].join(' ')}${PEM_DASHES}`;
    add('pem-pgp', 'pem', {
      secrets: lines,
      text: `${head}\n\n${lines.join('\n')}\n${foot}\n`,
      tail: `${head}\n\n${lines[0]}\n`,
      from: lines[1],
      extra: [lines[0]],
      cut: 30,
    });
  }

  {
    const email = `${g.word()}.${g.word()}${g.digits(3)}@example.com`;
    add('known-email', 'known', { secrets: [email], text: `signed in as ${email} on this machine`, cut: 12, known: 'email', ellipsis: true });
    const org = g.uuid();
    add('known-org', 'known', { secrets: [org], text: `organisation ${org} (from credential_org)`, cut: 14, known: 'org' });
  }

  for (const [id, alg] of [['jwt-rs256', 'RS256'], ['jwt-hs256', 'HS256']]) {
    const header = b64url(JSON.stringify({ alg, kid: g.strong(16, ALNUM), typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: g.strong(20, ALNUM), email: `${g.word()}@example.com`, exp: 1700000000 + Math.floor(g.next() * 1e8), iss: 'https://login.example.com' }));
    const sig = g.strong(alg === 'RS256' ? 342 : 43, B64URL);
    const jwt = `${header}.${payload}.${sig}`;
    add(id, 'jwt', { secrets: [jwt], text: `the portal answered with ${jwt} as the session`, cut: 18 });
  }

  for (const [id, prefix, body] of [
    ['sk-anthropic-api', 'sk-ant-api03-', () => g.strong(93, B64URL) + 'AA'],
    ['sk-anthropic-oauth', 'sk-ant-oat01-', () => g.strong(86, B64URL) + 'AA'],
    ['sk-openrouter', 'sk-or-v1-', () => g.strong(64, HEX)],
    ['sk-openai-project', 'sk-proj-', () => g.strong(124, B64URL)],
    ['sk-openai-service', 'sk-svcacct-', () => g.strong(96, B64URL)],
    ['sk-openai-legacy', 'sk-', () => g.strong(48, ALNUM)],
  ]) {
    const key = prefix + body();
    add(id, 'sk-key', { secrets: [key], text: `calling the API with ${key} today`, cut: prefix.length + 10, ellipsis: id === 'sk-openrouter' });
  }

  {
    const v = g.strong(43, B64URL);
    add('messaging-token', 'messaging-token', { secrets: [v], text: `CLAUDE_CODE_MESSAGING_TOKEN=${v}`, cut: 10 });
    const w = g.strong(32, HEX);
    add('messaging-token-json', 'messaging-token', { secrets: [w], text: `{"CLAUDE_CODE_MESSAGING_TOKEN": "${w}", "CLAUDE_PID": "4242"}`, cut: 9 });
  }

  {
    const t = g.strong(40, ALNUM + '._~-');
    add('bearer-header', 'bearer', { secrets: [t], text: `curl -H "Authorization: Bearer ${t}" https://api.example.com/v1/me`, tail: 'request headers: Authorization: Bearer ', cut: 5 });
    const u = g.strong(32, ALNUM);
    add('bearer-bare', 'bearer', { secrets: [u], text: `send it as Bearer ${u} on every call`, tail: 'the header value was Bearer ', cut: 7, ellipsis: true });
    const basic = b64(`svc-${g.word()}:${g.strong(18, ALNUM)}`);
    add('bearer-basic', 'bearer', { secrets: [basic], text: `authorization: Basic ${basic}\naccept: */*`, cut: 9 });
  }

  {
    const v = g.strong(32, ALNUM + '%-_');
    add('cookie-set', 'cookie', { secrets: [v], text: `< HTTP/1.1 200 OK\n< Set-Cookie: session=${v}; Path=/; HttpOnly; Secure\n< Content-Length: 12`, tail: '< Set-Cookie: session=', cut: 9 });
    const a = g.strong(43, B64URL);
    const b = g.strong(24, HEX);
    add('cookie-request', 'cookie', { secrets: [a, b], text: `curl -H 'Cookie: _csrf_token=${a}; sid=${b}; theme=dark' https://app.example.com/`, tail: 'Cookie: sid=', cut: 8 });
  }

  {
    const p = g.strong(20, PASSWORD);
    add('assign-shell', 'assign', { secrets: [p], text: `PGPASSWORD=${p} psql -h db.example.com -U app`, tail: 'export PGPASSWORD=', cut: 7 });
    const phrase = [g.word(), g.word(), g.word(), g.word()].join(' ');
    add('assign-quoted-phrase', 'assign', { secrets: [phrase], text: `password='${phrase}'`, tail: `password='`, cut: 13 });
    const k = g.strong(32, ALNUM);
    add('assign-json-text', 'assign', { secrets: [k], text: `{"service": "mailer", "api_key": "${k}", "retries": 3}`, tail: '{"service": "mailer", "api_key": "', cut: 11 });
    const c = g.strong(36, ALNUM + '_-');
    add('assign-yaml', 'assign', { secrets: [c], text: `oauth:\n  client_id: app-${g.digits(6)}\n  client_secret: ${c}\n`, tail: 'oauth:\n  client_secret: ', cut: 10 });
    const t = g.strong(28, ALNUM);
    add('assign-python', 'assign', { secrets: [t], text: `client = Client(token = "${t}", timeout=30)`, tail: 'client = Client(token = "', cut: 8, ellipsis: true });
    const q = g.strong(40, ALNUM + '-_');
    add('assign-query', 'assign', { secrets: [q], text: `GET https://api.example.com/v2/items?access_token=${q}&page=2`, tail: 'GET https://api.example.com/v2/items?access_token=', cut: 12 });
    const r = g.strong(48, B64URL);
    add('assign-js', 'assign', { secrets: [r], text: `const session = { refreshToken: '${r}', expiresIn: 3600 };`, tail: `const session = { refreshToken: '`, cut: 10 });
    const s = g.strong(24, PASSWORD);
    add('assign-escaped-json', 'assign', { secrets: [s], text: `{"input":"{\\"password\\":\\"${s}\\"}"}`, tail: `{"input":"{\\"password\\":\\"`, cut: 9 });
  }

  {
    const hex = g.raw(64, HEX);
    add('json-key-hex-token', 'json-key', {
      secrets: [hex],
      text: JSON.stringify({ ok: true, store: { token: hex, save_endpoint: '/api/save', url: 'http://localhost:5173' } }),
      tail: '{"ok":true,"store":{"token":"',
      cut: 20,
      json: { ok: true, store: { token: hex, save_endpoint: '/api/save', url: 'http://localhost:5173' } },
    });
    const k = g.strong(40, ALNUM);
    add('json-key-api-key', 'json-key', {
      secrets: [k],
      text: JSON.stringify({ name: 'search', config: { api_key: k } }),
      tail: '{"name":"search","config":{"api_key":"',
      cut: 9,
      json: { name: 'search', config: { api_key: k } },
    });
    const r = g.strong(64, B64URL);
    add('json-key-camel', 'json-key', {
      secrets: [r],
      text: JSON.stringify({ tokens: { refreshToken: r, tokenType: 'Bearer' } }),
      tail: '{"tokens":{"refreshToken":"',
      cut: 11,
      json: { tokens: { refreshToken: r, tokenType: 'Bearer' } },
    });
    const x = g.strong(30, ALNUM);
    add('json-key-secret', 'json-key', {
      secrets: [x],
      text: JSON.stringify({ webhook: { signing_secret: x, events: ['push'] } }),
      tail: '{"webhook":{"signing_secret":"',
      cut: 8,
      json: { webhook: { signing_secret: x, events: ['push'] } },
    });
  }

  {
    const v = g.strong(24, PASSWORD);
    add('env-line-plain', 'env-line', { secrets: [v], text: `DB_PASSWORD=${v}\nDB_HOST=db.example.com\n`, tail: 'DB_HOST=db.example.com\nDB_PASSWORD=', cut: 8 });
    const w = g.strong(36, ALNUM);
    add('env-line-export', 'env-line', { secrets: [w], text: `#!/bin/sh\nexport WEBHOOK_SIGNING_SECRET="${w}"\nexec ./serve`, tail: 'export WEBHOOK_SIGNING_SECRET=', cut: 9 });
    const x = g.strong(30, ALNUM);
    add('env-line-numbered', 'env-line', { secrets: [x], text: `     1→NODE_ENV=production\n     2→SESSION_COOKIE_KEY=${x}\n     3→PORT=8080`, tail: '     2→SESSION_COOKIE_KEY=', cut: 10 });
  }

  {
    const a = g.strong(20, ALNUM);
    const b = g.strong(26, PASSWORD);
    const host = `${g.word()}.example.org`;
    add('env-dotenv', 'env-dotenv', {
      secrets: [a, b, host],
      text: `# local settings\nMAILER_HOST=${host}\nMAILER_USER=${a}\nexport MAILER_PASS="${b}"\n`,
      tail: `# local settings\nMAILER_USER=`,
      cut: 7,
      context: { mode: 'env-dotenv' },
    });
    const c = g.strong(40, ALNUM);
    const phrase = `${g.word()} ${g.word()} ${g.word()}`;
    add('env-dump', 'env-dump', {
      secrets: [c, phrase],
      text: `HOME=/home/someone\nSHELL=/bin/zsh\ndeclare -x DEPLOY_TOKEN="${c}"\nVAULT_PASSPHRASE=${phrase}\nLANG=en_US.UTF-8\n`,
      tail: `SHELL=/bin/zsh\nDEPLOY_TOKEN=`,
      cut: 9,
      context: { mode: 'env-dump' },
    });
  }

  // ── tier 2 ────────────────────────────────────────────────────────────────

  for (const p of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
    const t = `${p}_${g.strong(36, ALNUM)}`;
    add(`github-${p}`, 'github', { secrets: [t], text: `git remote set-url origin https://x-access-token:${t}@github.example.com/org/repo.git`, tail: 'the token printed was ', cut: 14 });
  }
  {
    const t = `github_pat_${g.strong(22, ALNUM)}_${g.strong(59, ALNUM)}`;
    add('github-pat', 'github', { secrets: [t], text: `GH_ENTERPRISE_TOKEN is ${t}`, cut: 20, ellipsis: true });
  }

  for (const p of ['AKIA', 'ASIA']) {
    const id = p + g.strong(16, UPNUM);
    add(`aws-${p.toLowerCase()}`, 'aws-key-id', { secrets: [id], text: `[default]\naws_access_key_id = ${id}\nregion = us-east-1`, tail: 'access key id ', cut: 10 });
  }
  {
    const s = g.strong(40, ALNUM + '/+');
    add('aws-secret', 'aws-secret', { secrets: [s], text: `[default]\naws_secret_access_key = ${s}\n`, tail: '[default]\naws_secret_access_key = ', cut: 7 });
    const t = g.strong(40, ALNUM + '/+');
    add('aws-secret-json', 'aws-secret', { secrets: [t], text: `{"Credentials": {"SecretAccessKey": "${t}", "Expiration": "2026-10-02T00:00:00Z"}}`, tail: '{"Credentials": {"SecretAccessKey": "', cut: 7 });
  }

  {
    const t = `xoxb-${g.digits(12)}-${g.digits(13)}-${g.strong(24, ALNUM)}`;
    add('slack-bot', 'slack-token', { secrets: [t], text: `SLACK_BOT=${t}`, tail: 'slack said ', cut: 36 });
    const u = `xoxp-${g.digits(12)}-${g.digits(12)}-${g.digits(13)}-${g.strong(32, HEX)}`;
    add('slack-user', 'slack-token', { secrets: [u], text: `token: ${u}`, tail: 'slack user token ', cut: 50 });
    // The app id and the timestamp are not secret; the cut reaches the hex secret.
    const a = `xapp-1-A${g.strong(10, UPNUM)}-${g.digits(13)}-${g.strong(64, HEX)}`;
    add('slack-app', 'slack-token', { secrets: [a], text: `app token ${a} for socket mode`, cut: 44 });
    const path = `T${g.strong(8, UPNUM)}/B${g.strong(10, UPNUM)}/${g.strong(24, ALNUM)}`;
    add('slack-webhook', 'slack-webhook', { secrets: [path.split('/')[2]], text: `curl -X POST https://hooks.slack.com/services/${path} -d @payload.json`, tail: 'curl -X POST https://hooks.slack.com/services/' + path.slice(0, path.lastIndexOf('/') + 1), cut: 8 });
  }

  {
    const k = `AIza${g.strong(35, B64URL)}`;
    add('google-api-key', 'google-api-key', { secrets: [k], text: `maps?key=${k}&callback=init`, tail: 'the browser key is ', cut: 14 });
    const s = `GOCSPX-${g.strong(28, B64URL)}`;
    add('google-client-secret', 'google-client-secret', { secrets: [s], text: `"client_id":"1234-${g.raw(8, LOWER)}.apps.example.com", "web": ${s}`, tail: 'client secret ', cut: 14 });
    const t = `ya29.${g.strong(120, B64URL)}`;
    add('google-oauth-token', 'google-oauth-token', { secrets: [t], text: `gcloud printed ${t}`, cut: 16 });
  }

  {
    const t = `npm_${g.strong(36, ALNUM)}`;
    add('npm', 'npm', { secrets: [t], text: `//registry.npmjs.org/:_authToken=${t}`, tail: 'npm token ', cut: 12 });
    const h = `hf_${g.strong(34, ALNUM)}`;
    add('huggingface', 'huggingface', { secrets: [h], text: `huggingface-cli login --add-to-git-credential ${h}`, tail: 'hub token: ', cut: 11 });
  }

  for (const [id, prefix, n] of [['stripe-sk-live', 'sk_live_', 99], ['stripe-rk-live', 'rk_live_', 99], ['stripe-sk-test', 'sk_test_', 24], ['stripe-whsec', 'whsec_', 32]]) {
    const k = prefix + g.strong(n, ALNUM);
    add(id, 'stripe', { secrets: [k], text: `Stripe.api_key = ${k}`, tail: 'stripe key ', cut: prefix.length + 8 });
  }

  {
    const token = b64(JSON.stringify({ a: g.raw(32, HEX), t: g.uuid(), s: g.strong(44, B64) }));
    add('cloudflare-tunnel', 'cloudflare-tunnel', { secrets: [token], text: `cloudflared tunnel run --token ${token}`, tail: 'the connector token: ', cut: 20 });
  }

  {
    const p = g.strong(22, URL_PASSWORD);
    add('url-creds-postgres', 'url-creds', { secrets: [p], text: `DATABASE_URL=postgres://app_user:${p}@db.example.com:5432/app`, tail: 'connect to postgres://app_user:', cut: 9 });
    const q = g.strong(18, URL_PASSWORD);
    add('url-creds-https', 'url-creds', { secrets: [q], text: `git clone https://deploy:${q}@git.example.com/team/repo.git`, tail: 'cloning https://deploy:', cut: 7, ellipsis: true });
    const r = g.strong(26, ALNUM);
    add('url-creds-redis', 'url-creds', { secrets: [r], text: `redis://:${r}@cache.example.com:6379/0`, tail: 'redis://:', cut: 10 });
  }

  {
    const p = g.strong(20, ALNUM + '!_-');
    add('curl-user', 'curl-user', { secrets: [p], text: `curl -u admin:${p} https://api.example.com/v1/health`, tail: 'curl -s -u admin:', cut: 8 });
    const q = g.strong(24, ALNUM);
    add('curl-user-long', 'curl-user', { secrets: [q], text: `curl --silent --user "svc:${q}" https://api.example.com/`, tail: 'curl --user svc:', cut: 6 });
  }

  {
    const a = g.strong(32, ALNUM);
    add('cli-flag-token', 'cli-flag', { secrets: [a], text: `deployer push --token ${a} --env prod`, tail: 'deployer push --token ', cut: 9 });
    const b = g.strong(20, PASSWORD);
    add('cli-flag-password', 'cli-flag', { secrets: [b], text: `mysqldump --user=root --password=${b} appdb`, tail: 'mysqldump --password=', cut: 6 });
    const c = g.strong(36, ALNUM);
    add('cli-flag-client-secret', 'cli-flag', { secrets: [c], text: `oauth2-proxy --client-id=web --client-secret '${c}'`, tail: `oauth2-proxy --client-secret '`, cut: 8 });
    const d = g.strong(28, ALNUM);
    add('cli-flag-api-key', 'cli-flag', { secrets: [d], text: `search-cli --api-key ${d} query "x"`, tail: 'search-cli --api-key ', cut: 5 });
  }

  {
    const k = g.strong(40, ALNUM);
    add('x-api-key', 'x-api-key', { secrets: [k], text: `curl https://api.example.com -H 'x-api-key: ${k}'`, tail: 'x-api-key: ', cut: 6 });
    const j = g.strong(32, HEX);
    add('x-api-key-json', 'x-api-key', { secrets: [j], text: `{"headers": {"X-API-Key": "${j}", "accept": "application/json"}}`, tail: '{"headers": {"X-API-Key": "', cut: 7 });
  }

  return all;
}

// A carrier as JSON-encoded text holds it: on its own line inside a multi-line
// string in a record, JSON-encoded once (a .jsonl transcript line a command
// printed, an MCP result) or `levels` times (that record inside another
// tool's JSON result). There a line break is `\n` (`\\n` a level deeper) and
// a quote `\"` (`\\\"`). A tail keeps its fragment at the very end of its
// string, so only the closing quotes and brackets of the JSON follow it.
function jsonText(text, { levels = 1, tail = false } = {}) {
  let t = tail ? `first line\n${text}` : `first line\n${text}\nlast line`;
  for (let i = 0; i < levels; i++) {
    t = JSON.stringify(i === 0 ? { type: 'user', message: { content: t } } : { type: 'tool_result', content: t });
  }
  return t;
}

// Which fakes leaked into `haystack` (a string, or a value it serialises): a
// secret found whole, or any `window` characters of it (8 by default —
// acceptance criterion 1). Multi-line secrets are checked line by line, since a
// window across a newline never appears verbatim anywhere a mask could have
// missed it. The secrets' windows are indexed once and the haystack is read
// once, so a megabyte against hundreds of fakes stays quick.
function findLeaks(haystack, fakes, { window = 8, tail = false } = {}) {
  const hay = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  const leaked = new Map();   // fake id → { id, rule, at }
  const owners = new Map();   // window → the fakes whose secrets contain it
  for (const f of fakes) {
    for (const secret of tail ? f.tail.secrets : f.secrets) {
      for (const part of secret.split('\n')) {
        if (!part) continue;
        if (part.length <= window) {
          const at = hay.indexOf(part);
          if (at >= 0 && !leaked.has(f.id)) leaked.set(f.id, { id: f.id, rule: f.rule, at });
          continue;
        }
        for (let i = 0; i + window <= part.length; i++) {
          const w = part.slice(i, i + window);
          const list = owners.get(w);
          if (!list) owners.set(w, [f]);
          else if (!list.includes(f)) list.push(f);
        }
      }
    }
  }
  if (owners.size) {
    for (let i = 0; i + window <= hay.length; i++) {
      const list = owners.get(hay.slice(i, i + window));
      if (!list) continue;
      for (const f of list) if (!leaked.has(f.id)) leaked.set(f.id, { id: f.id, rule: f.rule, at: i });
    }
  }
  return [...leaked.values()];
}

// A mixed text of roughly `bytes` characters — source code, JSON lines, logs,
// shell sessions and prose, with a fake carrier every few dozen lines, every
// third one JSON-encoded — for the speed measurement and for a sweep over text
// the rules did not see in isolation. `carried` lists the lines that hold a
// carrier. Context-driven fakes are left out (they need their context); known
// values too.
function fakeCorpus({ seed = 0xc0ffee, bytes = 1 << 20 } = {}) {
  const g = makeGen(seed);
  const fakes = fakeSecrets({ seed: seed ^ 0x9e3779b9 }).filter((f) => !f.context && f.rule !== 'known');
  const lines = [];
  const used = [];
  const carried = [];
  let size = 0;
  let i = 0;
  const filler = [
    () => `const ${g.word()} = await ${g.word()}.${g.word()}(${g.word()}, { retries: ${g.digits(1)} });`,
    () => `  if (${g.word()}.length > ${g.digits(3)}) return ${g.word()}(${g.word()});`,
    () => JSON.stringify({ id: g.uuid(), kind: g.word(), count: Number(g.digits(3)), at: '2026-10-02T04:00:00Z', session_id: g.uuid(), max_tokens: 4096 }),
    () => `2026-10-02 04:${g.digits(2).slice(0, 2)}:00 INFO ${g.word()} handled ${g.word()} in ${g.digits(2)} ms (commit ${g.raw(40, HEX)})`,
    () => `$ git log --oneline -3 && npm test -- --test-reporter=spec # ${g.word()}`,
    () => `The ${g.word()} step ${g.word()}s the ${g.word()} before it ${g.word()}s; see lib/core/${g.word()}.js:${g.digits(3)} and http://localhost:5173/app.`,
    () => `| ${g.word()} | ${g.digits(2)} | ${g.word()} ${g.word()} |`,
    () => `    "${g.word()}": "${g.raw(24, ALNUM)}",`,
    () => `export function ${g.word()}(token: string, options?: Options): Promise<${g.word()}> {`,
    () => `password: process.env.DB_PASSWORD, token: config.token, key: ${g.word()}Key,`,
  ];
  while (size < bytes) {
    let line;
    if (i % 40 === 39) {
      const k = i / 40 | 0;
      const f = fakes[k % fakes.length];
      used.push(f);
      line = k % 3 === 2 ? jsonText(f.text) : f.text;
      carried.push(...line.split('\n'));
    } else {
      line = filler[Math.floor(g.next() * filler.length)]();
    }
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  return { text: lines.join('\n'), fakes: used, carried };
}

module.exports = { fakeSecrets, findLeaks, fakeCorpus, jsonText, mulberry32 };
