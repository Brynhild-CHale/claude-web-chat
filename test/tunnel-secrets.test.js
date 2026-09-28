// `tunnel setup` asks for every pasted credential through the prompt engine's
// hidden read (prompt.secret — test/prompt.test.js proves it echoes nothing),
// never through the visible prompt.line: the account-wide Cloudflare API token,
// the connector token and the Google OAuth client secret. A recording prompt
// stands in for the engine; the one-token runs go against the in-process fake
// Cloudflare API (test-support/fake-cloudflare), so nothing reaches Cloudflare.
//
// What must hold, per credential: it is asked for with secret() and not line(),
// the pasted value is what setup uses, and setup's own output never prints it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const tunnel = require('../lib/cli/commands/tunnel');
const { withTempHome } = require('../test-support/helpers');
const { withFakeCloudflare } = require('../test-support/fake-cloudflare');
const { createFakeAccess } = require('../test-support/fake-access');
const { userPaths } = require('../lib/core/paths');
const { readToken } = require('../lib/tunnel/cloudflared');

function capture() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), text: () => lines.join('\n') };
}

// Answers by question substring, and records which method each question used.
function recordingPrompt(answers = {}) {
  const asked = { line: [], secret: [] };
  const answer = (q) => {
    for (const [k, v] of Object.entries(answers)) if (q.includes(k)) return v;
    return '';
  };
  return {
    asked,
    line: async (q) => { asked.line.push(q); return answer(q); },
    secret: async (q) => { asked.secret.push(q); return answer(q); },
    confirm: async (q, { def = false } = {}) => def,
    close() {},
  };
}

const CREDENTIAL = /token|secret/i;

test('one token: the pasted API token and Google client secret are read hidden, used, and never printed', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const access = createFakeAccess({ team: fake.team });
  const env = { ...process.env, WEB_CHAT_CF_API: fake.base };
  const clientSecret = 'g-PASTED-client-secret';
  const prompt = recordingPrompt({ 'Paste the Cloudflare API token': fake.token, 'Google OAuth Client secret': clientSecret });
  const c = capture();

  await tunnel(['setup', '--hostname', 'wc.example.test', '--email', 'me@example.test',
    '--signin', 'google', '--google-client-id', 'g-client.apps.googleusercontent.com'],
  { log: c.log, prompt, env, fetchJwks: access.fetchJwks });

  assert.equal(prompt.asked.secret.length, 2, JSON.stringify(prompt.asked));
  assert.match(prompt.asked.secret[0], /^Paste the Cloudflare API token\b.*not shown as you paste/);
  assert.match(prompt.asked.secret[1], /^Google OAuth Client secret\b.*not shown as you paste/);
  assert.deepEqual(prompt.asked.line.filter((q) => CREDENTIAL.test(q)), [], 'no credential is asked for with the echoing line()');

  const g = fake.db.idps.find((i) => i.type === 'google');
  assert.equal(g.config.client_secret, clientSecret, 'the pasted secret is the one setup used');
  assert.equal(fake.db.apps.length, 1, 'the pasted API token drove the run');
  assert.ok(!c.text().includes(fake.token), 'setup printed the API token');
  assert.ok(!c.text().includes(clientSecret), 'setup printed the Google client secret');
});

test('one token: with nothing pasted the API token was still asked for hidden, and setup stops', async (t) => {
  withTempHome(t);
  const prompt = recordingPrompt();
  await assert.rejects(tunnel(['setup'], { log: () => {}, prompt }), /no Cloudflare API token/);
  assert.equal(prompt.asked.secret.length, 1);
  assert.match(prompt.asked.secret[0], /Paste the Cloudflare API token/);
  assert.deepEqual(prompt.asked.line, []);
});

test('manual: the pasted connector token is read hidden, stored 0600, and never printed', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const connector = 'eyJ-PASTED-connector-token';
  const prompt = recordingPrompt({ 'Connector token': connector });
  const c = capture();

  await tunnel(['setup', '--hostname', 'wc.example.test', '--style', 'flat', '--team', access.team, '--aud', access.aud,
    '--email', 'me@example.test', '--kind', 'token'], { log: c.log, prompt, fetchJwks: access.fetchJwks });

  assert.equal(prompt.asked.secret.length, 1, JSON.stringify(prompt.asked));
  assert.match(prompt.asked.secret[0], /^Connector token\b.*stored 0600.*not shown as you paste/);
  assert.deepEqual(prompt.asked.line, []);
  assert.equal(fs.statSync(userPaths().tunnelToken).mode & 0o777, 0o600);
  assert.equal(readToken(userPaths().tunnelToken), connector);
  assert.match(c.text(), /wrote the connector token to .* \(0600\)/);
  assert.ok(!c.text().includes(connector), 'setup printed the connector token');
});
