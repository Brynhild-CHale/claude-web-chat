// GET /api/skills (lib/server/routes/skills.js, spec §6.2, U58) on a bare
// Express app with a fake ctx, as §10.1 says route units are tested; the
// wiring in lib/server/index.js is U66a's.
//
// What is pinned:
//   * the gate is requireMirror('full'): a remote viewer at basic and at read
//     is refused 403, at full and locally it is answered;
//   * the body is exactly §6.2's {ok, conversation, source, partial, skills,
//     note}, with the note's text exact, and no as_of;
//   * the conversation parameter: passed on as given, absent → null (the
//     primary); over ID_MAX characters → 404, a repeat → 400, before the
//     catalog is asked;
//   * the mirror switched off → {ok:true, disabled:true, skills:[], note};
//     no mirror → 503;
//   * a throw → 500 that names nothing;
//   * against a real catalog on the claude-home fixture: the organisation and
//     account ids appear nowhere in the body;
//   * the mount throws without ctx.skills or ctx.audience.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { request } = require('../lib/client');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { atLeast, fromOptIn, MIRROR_FULL_HINT, MIRROR_HINT } = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const { ID_MAX } = require('../lib/server/routes/mirror-query');
const { mountSkillsRoutes, NOTE } = require('../lib/server/routes/skills');
const { createSkillCatalog } = require('../lib/server/skills');

const EXACT_NOTE = 'A skill picked here asks Claude to run it with the Skill tool; it is not a terminal command.';
const ANSWER = Object.freeze({
  conversation: 'conv-1',
  source: 'session',
  partial: false,
  as_of: 1_780_000_000_000,
  skills: [{ name: 'simplify', description: 'Review the changed code.', origin: 'session' },
    { name: 'acme:deploy', description: 'Deploy things.', origin: 'plugin' }],
});
const BODY = Object.freeze({ ok: true, conversation: 'conv-1', source: 'session', partial: false, skills: ANSWER.skills, note: EXACT_NOTE });

function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    needs: [],
    levelOf(req) { return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local'; },
    requireMirror(need) {
      a.needs.push(need);
      return (req, res, next) => {
        const level = a.levelOf(req);
        if (atLeast(level, need)) return next();
        return res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req),
          hint: need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT });
      };
    },
  };
  return a;
}

function fakeSkills(answer = ANSWER) {
  const s = { calls: [] };
  s.catalog = async (cid) => { s.calls.push(cid); return typeof answer === 'function' ? answer(cid) : answer; };
  s.resolve = async () => null;
  return s;
}

function fakeMirror(on = { enabled: true }) {
  return { ready: Promise.resolve(), enabled: () => on };
}

async function host(t, { audience = fakeAudience(), skills = fakeSkills(), mirror = fakeMirror() } = {}) {
  const app = express();
  const ctx = { audience, skills };
  if (mirror) ctx.mirror = mirror;
  mountSkillsRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null,
    { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 30000 });
  return { get, audience, skills, ctx };
}

test('the note is exact', () => {
  assert.equal(NOTE, EXACT_NOTE);
});

test('local: 200 with exactly §6.2\'s body; the conversation passed on as given', async (t) => {
  const h = await host(t);
  const r = await h.get('/api/skills?conversation=conv-1');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, BODY);
  assert.deepStrictEqual(Object.keys(r.body), ['ok', 'conversation', 'source', 'partial', 'skills', 'note']);
  assert.deepStrictEqual(h.audience.needs, ['full']);
  await h.get('/api/skills');
  assert.deepStrictEqual(h.skills.calls, ['conv-1', null], 'absent: null, the primary conversation');
});

test('the gate: 403 for a remote viewer at basic and read; 200 at full', async (t) => {
  const audience = fakeAudience();
  const h = await host(t, { audience });
  for (const optIn of ['off', 'read']) {
    audience.optIn = optIn;
    const r = await h.get('/api/skills', { remote: true });
    assert.equal(r.status, 403, optIn);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.hint, MIRROR_FULL_HINT);
  }
  assert.equal(h.skills.calls.length, 0, 'the catalog is never asked for a refused viewer');
  audience.optIn = 'full';
  const ok = await h.get('/api/skills', { remote: true });
  assert.equal(ok.status, 200);
  assert.deepStrictEqual(ok.body, BODY);
});

test('the mirror switched off: {ok:true, disabled:true, skills:[], note}; no mirror: 503', async (t) => {
  for (const mirror of [fakeMirror({ enabled: false, scope: 'project' }),
    { enabled: async () => ({ enabled: false, scope: 'user' }) }]) {
    const h = await host(t, { mirror });
    const r = await h.get('/api/skills');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, disabled: true, skills: [], note: EXACT_NOTE });
    assert.equal(h.skills.calls.length, 0);
  }
  const none = await host(t, { mirror: null });
  const r = await none.get('/api/skills');
  assert.equal(r.status, 503);
  assert.equal(none.skills.calls.length, 0);
});

test('the conversation parameter: over ID_MAX is 404, a repeat or an empty one 400, before the catalog is asked', async (t) => {
  const h = await host(t);
  const long = await h.get(`/api/skills?conversation=${'a'.repeat(ID_MAX + 1)}`);
  assert.equal(long.status, 404);
  assert.equal(long.body.ok, false);
  for (const p of ['/api/skills?conversation=a&conversation=b', '/api/skills?conversation=']) {
    const r = await h.get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.body.ok, false, p);
  }
  assert.equal(h.skills.calls.length, 0);
  assert.equal((await h.get(`/api/skills?conversation=${'a'.repeat(ID_MAX)}`)).status, 200);
});

test('a throw is a 500 that names nothing; a malformed answer is cleaned', async (t) => {
  const h = await host(t, { skills: fakeSkills(() => { throw new Error('/Users/someone/.claude/skills/synced/org_acct'); }) });
  const r = await h.get('/api/skills');
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(r.body).includes('/Users/'));
  const odd = await host(t, { skills: fakeSkills({
    conversation: 7,
    source: 'other',
    partial: 'yes',
    org: 'x',
    skills: [{ name: 'a', description: 'd', origin: 'project', path: '/abs/path' }, { name: 'b', origin: 'elsewhere' }, null, { name: 3 }],
  }) });
  const body = (await odd.get('/api/skills?conversation=c9')).body;
  assert.deepStrictEqual(body, { ok: true, conversation: 'c9', source: 'disk', partial: false,
    skills: [{ name: 'a', description: 'd', origin: 'project' }], note: EXACT_NOTE });
});

test('a real catalog: the organisation and account ids appear nowhere in the body', async (t) => {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-skills-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const ORG = 'aaaa1111-org0-4000-8000-000000000001';
  const ACCT = 'bbbb2222-acct-4000-8000-000000000002';
  ch.write(`skills/synced/${ORG}_${ACCT}/docx/SKILL.md`, '---\nname: docx\ndescription: Word documents.\n---\n');
  ch.write('skills/mine/SKILL.md', '---\nname: mine\ndescription: Mine.\n---\n');
  const known = [];
  const redactor = { addKnown: (v) => { known.push(v); return true; }, text: (s) => s };
  const mirror = {
    ...fakeMirror(),
    snapshot: () => ({ primary: 'conv-1', conversations: [] }),
    skillFold: () => ({ names: ['anthropic-skills:docx', 'mine'], descriptions: {}, orgUuid: ORG }),
  };
  const skills = createSkillCatalog({ root, mirror, redactor });
  const h = await host(t, { skills, mirror });
  for (const p of ['/api/skills', '/api/skills?conversation=conv-1']) {
    const r = await h.get(p);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.skills, [
      { name: 'anthropic-skills:docx', description: 'Word documents.', origin: 'synced' },
      { name: 'mine', description: 'Mine.', origin: 'user' },
    ]);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(ORG) && !text.includes(ACCT), 'an id leaked');
    assert.ok(!text.includes(ch.dir) && !text.includes(root), 'a path leaked');
  }
  assert.deepStrictEqual(known, [ACCT]);
});

test('the mount throws without ctx.skills or ctx.audience', () => {
  const app = express();
  assert.throws(() => mountSkillsRoutes(app, { audience: fakeAudience() }), /ctx\.skills/);
  assert.throws(() => mountSkillsRoutes(app, { audience: fakeAudience(), skills: {} }), /ctx\.skills/);
  assert.throws(() => mountSkillsRoutes(app, { skills: fakeSkills() }), /ctx\.audience/);
  assert.throws(() => mountSkillsRoutes(app, null), /ctx\.audience/);
});
