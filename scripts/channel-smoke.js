#!/usr/bin/env node
// Manual channel smoke harness — testing the wake edge needs a harness like this.
// It drives a wake-worthy producer against the running daemon,
// pushes the queue, and prints the EXACT <channel> envelope the bridge would
// emit — so you can eyeball the wire without a live Claude Code session. Under
// `WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels
// server:web-chat`, hitting Push (or running this) should actually wake Claude.
//
// Usage:
//   node scripts/channel-smoke.js              # a capture → push (default)
//   node scripts/channel-smoke.js --signal     # a declared queue signal → push
//   node scripts/channel-smoke.js --note "focus on totals"
//
// Discovers/auto-spawns the daemon via lib/client, exactly like the MCP tools.

const WebSocket = require('ws');
const client = require('../lib/client');
const { wakeEnvelope } = require('../lib/channel/envelope');
const { findProjectRoot } = require('../lib/core/paths');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Simulate a browser signal: render a pane that declares the signal, then write
// the key over WS (the only path tagged source:'browser', so it classifies as a
// signal rather than a server write).
async function driveSignal(opts, port) {
  await client.post('/api/render', {
    id: 'smoke-signal',
    html: '<div>smoke signal pane</div>',
    params: { signals: [{ key: 'smoke_signal', wake: 'queue', why: 'smoke test signal' }] },
  }, opts);
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        sock.send(JSON.stringify({ type: 'store:set', patch: { smoke_signal: { seq: 1 } } }));
        setTimeout(() => { sock.close(); resolve(); }, 120);
      }
    });
    sock.on('error', reject);
  });
  console.log('drove a browser signal → smoke_signal');
}

async function driveCapture(opts) {
  const r = await client.post('/api/capture', {
    url: 'https://example.com/smoke-report',
    title: 'Smoke Report',
    html: '<html><body><h1>Report</h1><table><tr><th>Item</th><th>Cost</th></tr><tr><td>Rent</td><td>1200</td></tr></table></body></html>',
  }, opts);
  console.log(`posted capture ${r.capture_id} (profile ${r.profile})`);
}

function renderChannelXml({ content, meta }) {
  // The harness stamps source="<channel-name>"; our meta supplies the rest.
  const attrs = ['source="web-chat"', ...Object.entries(meta).map(([k, v]) => `${k}="${v}"`)].join(' ');
  return `<channel ${attrs}>\n${content}\n</channel>`;
}

async function main() {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const opts = { root, spawn: true };
  const doSignal = process.argv.includes('--signal');
  const note = argValue('--note');

  const port = client.discoverPort({ root });
  if (!port && doSignal) {
    // --signal needs a WS to the daemon; make sure it's up first.
    await client.post('/api/queue', undefined, opts).catch(() => {});
  }

  if (doSignal) await driveSignal(opts, client.discoverPort({ root }));
  else await driveCapture(opts);

  await settle(150);
  const before = await client.get('/api/queue', opts);
  console.log(`queue now holds ${before.count} item(s)`);

  const push = await client.post('/api/queue/push', note ? { note } : {}, opts);
  console.log(`pushed ${push.pushed} item(s) (${push.included} included), wake seq ${push.seq}`);

  const ev = await client.get('/api/events', opts);
  const wake = (ev.events || []).filter((e) => e.kind === 'wake').sort((a, b) => b.seq - a.seq)[0];
  if (!wake) { console.error('no wake event found — is the daemon healthy?'); process.exit(1); }

  const envelope = wakeEnvelope(wake.batch, { reason: wake.reason, source: wake.source, seq: wake.seq, note: wake.note });
  console.log('\n─── the <channel> the bridge would push ───\n');
  console.log(renderChannelXml(envelope));
  console.log('\n───────────────────────────────────────────');
  console.log('\nmeta (string-keyed, string-valued):', JSON.stringify(envelope.meta));
  console.log('\nUnder WEB_CHAT_CHANNEL=1 + a live channel session, this wake reaches');
  console.log('Claude, who then fetches bodies by tool call (get_captures / get_store).');
}

main().catch((e) => { console.error('smoke error:', e.message || e); process.exit(2); });
