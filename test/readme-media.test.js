// scripts/readme-media — the recipe behind the README's replay clips. The clips
// themselves need Chrome and are re-recorded by hand, but the recipe can rot
// silently: a route the story drives changes shape, or the story stops adding
// anything below the fold and the "smooth-scroll" clips quietly stop
// scrolling. This drives the story on a test daemon and checks both, with no
// browser: every step of both clip scripts resolves, and each flow step after
// the first scrolls toward something that step ADDED to the page.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const client = require('../lib/client');
const { withServer } = require('../test-support/helpers');
const story = require('../scripts/readme-media/story');

async function driveStory(ctx) {
  // lib/client, as the recorder does: replay/open refuses anything that looks
  // like a browser (fetch's Sec-Fetch-* headers included).
  const post = async (p, body) => {
    const r = await client.post(p, body || {}, { port: ctx.port, noSpawn: true });
    assert.ok(!(r && r.ok === false), `${p} refused: ${JSON.stringify(r)}`);
    return r;
  };
  const ws = ctx.ws('/ws', { headers: { origin: ctx.baseUrl } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    await story.drive({ post, send: (f) => ws.send(JSON.stringify(f)), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  } finally {
    ws.terminate();
  }
  return post;
}

test('readme-media: the story leaves the graph both clips replay, and every flow step scrolls to something it added', async (t) => {
  await withServer(t, async (ctx) => {
    const post = await driveStory(ctx);

    const g = (await ctx.api.get('/api/graph')).json;
    const byLabel = new Map(g.nodes.map((n) => [n.label, n]));
    for (const l of ['n1.0', 'n1.1', 'n1.2', 'n1.3', 'n1.1.0', 'n1.1.1']) assert.ok(byLabel.has(l), `the story commits ${l}`);
    assert.equal(byLabel.get('n1.2').folded_count, 2, 'the two chat-only turns fold onto the read path');
    assert.ok(byLabel.get('n1.1').bookmarked, 'the recommendation is bookmarked');

    // replay.gif: Claude's directed replay opens against this graph.
    const open = await post('/api/replay/open', { script: story.REPLAY });
    assert.equal(open.steps, story.REPLAY.steps.length);

    // flow.gif: the same request the recorder sends, as the Chrome-free
    // document format — its payload carries each step's scroll focus.
    const r = await post('/api/replay/render', { ...story.FLOW, format: 'replay' });
    const html = fs.readFileSync(r.path, 'utf8');
    const payload = JSON.parse(/<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(payload.steps.length, story.FLOW.script.steps.length);
    // A frame's node is the preview's JSON: its page items in order.
    const pageOf = (s) => new Set(JSON.parse(s.node).page.map((it) => it.pane || it.md));
    for (let i = 1; i < payload.steps.length; i++) {
      const s = payload.steps[i];
      const first = s.focus && s.focus.targets[0];
      assert.ok(first, `flow step ${i} has a scroll target`);
      assert.ok(pageOf(s).has(first), `flow step ${i}: ${first} is on its page`);
      assert.ok(!pageOf(payload.steps[i - 1]).has(first),
        `flow step ${i} scrolls first to ${first}, which the step before already showed — add a pane below the fold instead`);
    }
  });
});
