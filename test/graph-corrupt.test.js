// Seeded corruption of the durable graph records.
//
// Nothing in the suite corrupted a node file, graph/_meta.json or draft.json
// before this file existed, which is how "the guard only wrapped the parse" and
// "a torn _meta.json deletes the draft" both survived: createServer calls
// graph.load() unguarded, so a throw out of load means the daemon can never boot
// again FOR THAT PROJECT, and there was no test that could notice.
//
// Every case here writes bytes a crash or a full disk can genuinely produce: a
// truncated file, a file that parses to `null`, a file that parses to `{}`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

let clock = 1000;
function node(id, parent_id, extra = {}) {
  return {
    id, parent_id, created_at: clock++, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${id}`, summary: `turn ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}

function graphDir(webChatDir) {
  const dir = path.join(webChatDir, 'graph');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNode(dir, n) {
  fs.writeFileSync(path.join(dir, `${n.id}.json`), JSON.stringify(n, null, 2));
}

test('graph: null, {} and truncated node files are skipped and the daemon still boots', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0', { mounts: [{ id: 'p', html: '<p>ok</p>' }] }));
      // The three shapes a torn or placeholder write actually produces. `null`
      // and `{}` are VALID JSON, so the old parse-only guard let both through to
      // the sort (a.created_at) and to n.id.replace, and both threw out of load.
      fs.writeFileSync(path.join(dir, 'n2.json'), 'null');
      fs.writeFileSync(path.join(dir, 'n3.json'), '{}');
      fs.writeFileSync(path.join(dir, 'n4.json'), '{"id":"n4","created_at":10');
      fs.writeFileSync(path.join(dir, 'n5.json'), '');
      fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: 'n1' }));
    },
  });

  const r = await api.get('/api/graph');
  assert.equal(r.status, 200, 'boot survives every unusable node file');
  assert.deepEqual(r.json.nodes.map((n) => n.id).sort(), ['n0', 'n1'], 'only the valid nodes are listed');
  assert.equal(r.json.active, 'n1');

  const mounts = await api.get('/api/mounts');
  assert.deepEqual(mounts.json.mounts.map((m) => m.id), ['p'], 'the active node still restores its surface');
});

test('graph: a node whose id is not n<digits> is skipped rather than seeding a NaN sequence', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, { ...node('x', null), id: 'not-a-node-id' });
      fs.writeFileSync(path.join(dir, 'weird.json'), JSON.stringify({ id: 'n9', created_at: 'yesterday' }));
      fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: 'n0' }));
    },
  });

  const r = await api.get('/api/graph');
  assert.deepEqual(r.json.nodes.map((n) => n.id), ['n0']);
});

test('graph: a truncated _meta.json boots on the latest node and does NOT delete the draft', async (t) => {
  // The full cascade the atomic write plus the honest read exist to break:
  // torn _meta.json → active read as null (indistinguishable from a deliberate
  // wipe) → clearLiveMounts → loadDraft(…, null) → every draft looks stale →
  // unlink. The draft is the ONLY copy of uncommitted work.
  const { api, webChatDir } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0'));
      fs.writeFileSync(path.join(dir, '_meta.json'), '{"active": "n1", "lock": nu');
      fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
        schema_version: 1, saved_at: Date.now(), base_active: 'n1',
        mounts: [{ id: 'unsaved', html: '<p>work in progress</p>' }], store: { k: 1 },
      }));
    },
  });

  const r = await api.get('/api/graph');
  assert.equal(r.status, 200);
  assert.equal(r.json.active, 'n1', 'a torn meta recovers to the latest node, not to a blank surface');

  const mounts = await api.get('/api/mounts');
  assert.deepEqual(mounts.json.mounts.map((m) => m.id), ['unsaved'], 'the uncommitted draft is restored, not discarded');
  assert.equal(fs.existsSync(path.join(webChatDir, 'draft.json')), true, 'and it is still on disk');

  // The recovery's own saveMeta leaves a readable file in its place. (The torn
  // BYTES are moved aside first rather than overwritten — that half is pinned in
  // test/graph-persistence.test.js.)
  const meta = JSON.parse(fs.readFileSync(path.join(webChatDir, 'graph', '_meta.json'), 'utf8'));
  assert.equal(meta.active, 'n1');
});

test('graph: a _meta.json that parses to a non-object takes the same recovery', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0'));
      fs.writeFileSync(path.join(dir, '_meta.json'), '[]');
    },
  });
  const r = await api.get('/api/graph');
  assert.equal(r.json.active, 'n1');
});

test('graph: an ABSENT _meta.json still means "no commit point", not "recover the latest"', async (t) => {
  // The distinction the tri-state read exists for: absent is meaningful (a wiped
  // or never-committed surface) and must not be conflated with corrupt.
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0'));
    },
  });
  const r = await api.get('/api/graph');
  assert.equal(r.json.active, null, 'no meta file is not the same as a torn one');
  assert.equal(r.json.nodes.length, 2);
});

test('graph: an explicit active:null is still honoured (a deliberate wipe is not corruption)', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: null }));
    },
  });
  const r = await api.get('/api/graph');
  assert.equal(r.json.active, null);
});

test('graph: a dangling active id still falls back to the latest node', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0'));
      fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: 'n99' }));
    },
  });
  const r = await api.get('/api/graph');
  assert.equal(r.json.active, 'n1');
});
