// The pack HTTP surface — what the drawer's Manage tab drives.
//
// The endpoint CANNOT tell a user's click from a pane's fetch: the two are
// byte-identical requests. That is accepted knowingly. What this suite pins is
// everything that stays closed regardless of who asked:
//
//   * a builtin name is refused for the HTTP actor exactly as for the CLI;
//   * the routes have no `replace`, so a user's own component is never replaced;
//   * removing a drifted pack is refused with the terminal command instead;
//   * a refusal is 200 + ok:false — the lockReject envelope — so a caller that
//     reads the body learns WHY rather than seeing a bare status code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { withServer, withTempHome } = require('../test-support/helpers');
const { packFixture, tmpDir, write, fakeForge, repoWithArchive, repoWithRelease } = require('../test-support/packs');
const { projectPaths, claudePaths, userPaths } = require('../lib/core/paths');
const { readAudit, listPacks } = require('../lib/packs/store');

const SHA = 'a'.repeat(40);
const forgeFor = (t, dir, sha = SHA) => fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha }) } });

test('GET /api/packs reports installed + quarantined, with drift', async (t) => {
  await withServer(t, async ({ api, root }) => {
    let r = await api.get('/api/packs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.packs, []);
    assert.deepEqual(r.json.quarantined, []);

    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    assert.equal(r.json.ok, true);

    r = await api.get('/api/packs');
    assert.equal(r.json.packs.length, 1);
    assert.equal(r.json.packs[0].name, 'acme-ops');
    assert.equal(r.json.packs[0].drift, false);

    fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- mine -->');
    r = await api.get('/api/packs');
    assert.equal(r.json.packs[0].drift, true);
  });
});

test('POST /api/packs/install lands the components, the skill and the audit line', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({
      components: [{ name: 'deploy-board', service: 'module.exports={async start(){}};' }],
    }));
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.services, ['deploy-board'], 'the caller is told what needs `trust`');
    assert.ok(r.json.skill.dest.endsWith('SKILL.md'));

    assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html')));
    assert.ok(fs.existsSync(claudePaths(root).skill('acme-ops')));

    // And the component is live in the ordinary listing, no reload involved.
    const comps = (await api.get('/api/components')).json.components.map((c) => c.name);
    assert.ok(comps.includes('deploy-board'));

    const audit = readAudit(root);
    assert.equal(audit.at(-1).op, 'install');
    assert.equal(audit.at(-1).actor, 'http', 'who asked is recorded — that is what makes a pane install discoverable');
  });
});

test('an install broadcasts `components` so the drawer and palette cache invalidate live', async (t) => {
  await withServer(t, async ({ api, port, ws }) => {
    const sock = ws();
    const frames = [];
    await new Promise((resolve) => {
      sock.on('message', (d) => {
        const m = JSON.parse(d.toString());
        frames.push(m.type);
        if (m.type === 'hello') resolve();
      });
    });
    const forge = await forgeFor(t, packFixture());
    await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    await new Promise((r) => setTimeout(r, 120));
    sock.close();
    assert.ok(frames.includes('packs:changed'));
    assert.ok(frames.includes('components'), 'without this an install is invisible until reload');
  });
});

test('a BUILTIN name is refused for the HTTP actor too — 200 ok:false, no override', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'git-dashboard' }] }));
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    assert.equal(r.status, 200, 'a refusal is not a transport failure');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.rejected, true);
    assert.match(r.json.hint, /built-in name/);
    assert.deepEqual(listPacks(root), []);
  });
});

test('the install route has NO replace — a component you already had is never taken over', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const mine = path.join(projectPaths(root).components, 'deploy-board');
    write(path.join(mine, 'component.html'), '<div>mine</div>');
    write(path.join(mine, 'meta.json'), JSON.stringify({ name: 'deploy-board', description: 'mine' }));

    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    // Ask for it explicitly, the way a hostile pane would.
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops'), replace: true, force: true });
    assert.equal(r.json.ok, false);
    assert.match(r.json.hint, /--replace/);
    assert.match(fs.readFileSync(path.join(mine, 'component.html'), 'utf8'), /mine/);
  });
});

test('quarantine stages without installing, and review reads it back', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board', service: 'module.exports={};' }] }));
    let r = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    assert.equal(r.json.ok, true);
    assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
    assert.equal(fs.existsSync(claudePaths(root).skill('acme-ops')), false);

    const comps = (await api.get('/api/components')).json.components.map((c) => c.name);
    assert.equal(comps.includes('deploy-board'), false, 'quarantine adds nothing to the registry');

    r = await api.get('/api/packs/quarantine/acme-ops/review');
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.plan.services, ['deploy-board']);
    assert.ok(r.json.tree.some((f) => f.path === 'SKILL.md'));

    r = await api.get('/api/packs/quarantine/acme-ops/review?file=SKILL.md');
    assert.match(r.json.text, /^---/);
  });
});

test('review refuses a path outside the staged pack', async (t) => {
  await withServer(t, async ({ api }) => {
    const forge = await forgeFor(t, packFixture());
    await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    const r = await api.get('/api/packs/quarantine/acme-ops/review?file=' + encodeURIComponent('../../../../etc/passwd'));
    assert.equal(r.json.ok, false);
    assert.match(r.json.hint, /is not part of the quarantined pack/);
  });
});

test('approve installs the reviewed tree; a tampered one is refused', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    const packDir = q.json.record.pack_dir;

    fs.appendFileSync(path.join(packDir, 'components', 'deploy-board', 'component.html'), '<script>fetch("http://evil")</script>');
    let r = await api.post('/api/packs/quarantine/acme-ops/approve');
    assert.equal(r.json.ok, false);
    assert.match(r.json.hint, /no longer matches what was downloaded/);
    assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  });
});

test('discard is allowed from the browser — nothing was ever live', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture());
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    const r = await api.del('/api/packs/quarantine/acme-ops');
    assert.equal(r.json.ok, true);
    assert.equal(fs.existsSync(q.json.record.dir), false);
    assert.equal((await api.get('/api/packs')).json.quarantined.length, 0);
  });
});

test('DELETE /api/packs/:name removes a clean pack', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    const r = await api.del('/api/packs/acme-ops');
    assert.equal(r.json.ok, true);
    assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
    assert.deepEqual((await api.get('/api/packs')).json.packs, []);
  });
});

test('DELETE refuses a DRIFTED pack and hands back the terminal command', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    const f = path.join(projectPaths(root).components, 'deploy-board', 'component.html');
    fs.appendFileSync(f, '<!-- my edit -->');

    const r = await api.del('/api/packs/acme-ops');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.drift, true);
    assert.equal(r.json.command, 'claude-web-chat pack remove acme-ops',
      'the terminal runs the per-unit rule: it removes what you did not touch and keeps what you did');
    assert.ok(fs.existsSync(f), 'my edit survives — destroying it is a terminal decision');
  });
});

test('POST /api/packs/announce is the CLI nudge and touches nothing', async (t) => {
  await withServer(t, async ({ api, ws }) => {
    const sock = ws();
    const frames = [];
    await new Promise((resolve) => {
      sock.on('message', (d) => { const m = JSON.parse(d.toString()); frames.push(m.type); if (m.type === 'hello') resolve(); });
    });
    const r = await api.post('/api/packs/announce', { pack: 'acme-ops' });
    assert.equal(r.json.ok, true);
    await new Promise((x) => setTimeout(x, 100));
    sock.close();
    assert.ok(frames.includes('packs:changed'));
    assert.ok(frames.includes('components'));
  });
});

test('a bad URL is a 400, an unreachable one is a readable refusal', async (t) => {
  await withServer(t, async ({ api }) => {
    assert.equal((await api.post('/api/packs/install', {})).status, 400);
    const r = await api.post('/api/packs/install', { url: 'not a url at all' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.match(r.json.hint, /not a pack source|not a URL/);
  });
});

test('a verified release install is reported as verified', async (t) => {
  await withServer(t, async ({ api }) => {
    const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithRelease(packFixture(), { sha: 'b'.repeat(40) }) } });
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops') });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.pack.source.via, 'release');
    assert.equal(r.json.pack.source.sums_verified, true);
  });
});

test('--global from the browser writes the user tier — the checkbox genuinely works', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await forgeFor(t, packFixture({ components: [{ name: 'deploy-board' }] }));
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'ops'), global: true });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tier, 'system');
    assert.ok(fs.existsSync(path.join(userPaths().components, 'deploy-board', 'component.html')));
    assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  });
});
