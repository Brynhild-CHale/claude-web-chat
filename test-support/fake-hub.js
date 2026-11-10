'use strict';

// The fake hub (contract 12 C-12.22, PLAN-T6 6A.8): the hub's side of contract
// 05 for the connector's tests, beside fake-access.js and fake-cloudflare.js.
//
// Plain http and ws on 127.0.0.1:0 — never TLS, never a real hub, never a port
// in the reserved band ({5170, 5171} and 5173–5272; it re-listens up to five
// times if the OS hands it one, then throws). It starts nothing, writes nothing
// to disk, logs nothing, and has no runnable entry (REQ@alpha7-checks (a)).
//
// IDENTITY. fake.url (http://127.0.0.1:<port>) is the origin a test hands
// lib/setup/connector.js `hubOrigin(…, {insecureLoopback: true})`: pairing
// posts there and the link dials ws://127.0.0.1:<port>/connector. The schema
// fields that must be https or wss carry the same host — the poll's
// `connect_url` (wss://127.0.0.1:<port>/connector) and hello.ack's
// `hub.origin` (https://127.0.0.1:<port>) — and nothing dials them. The chats'
// minted origins default to A-06.2's local stack (`opts.publicHost`,
// hub.test:8443), which nothing dials either. Every signed string is checked
// over the Host header the fake received (U715 signs over `new URL(origin).host`).
//
// WHAT IT PLAYS (C-12.22): pairing (C-05.1–C-05.3), the signed link (C-05.4–
// C-05.9, rotation and held keys), hello with a compat verdict the test sets
// (`setWindow`), liveness (pings at heartbeat_ms, a dead timer, `silence`,
// `drop`), machine settings and chat assignment, the HTTP and WebSocket relays
// with 05's credit windows (C-05.22, C-05.23), queue delivery one per chat in
// order with replay before new (C-05.25, C-07.26–C-07.28), the events channel's
// acks, and the three hub.request reads (A-05.3) — exactly three: any other type
// fails its schema and is the fatal bad frame A-05.3 says it is. There is no
// frame kind for an update, a restart or a command, and the fake never sends
// one (C-05.15, C-12.14). The fake runs no relay gate of its own and adds no
// security header: the connector's gate is what is under test.
//
// RECORD AND VALIDATION (C-12.21). Every frame the fake sends or receives, and
// every pairing body, is validated through test-support/contracts-loader's
// validator (the v1.4 lock, every locked amendment folder, in lock order) and
// appended to `fake.frames` ({dir, ch, kind, frame, bytes, at, link, ok}). A
// failure goes to `fake.errors`, and fails the test: withFakeHub's t.after runs
// `assertClean()`, which throws naming each failing frame's kind and the ajv
// error. A test that sends a bad frame on purpose takes it back with
// `fake.takeErrors()`. The pairing code is the one value the record masks: the
// fake keeps only its sha256 (the plain code goes back once, in the start
// response, as the hub's does).
//
// TIME. `opts.now` (epoch ms) is the clock every expiry and skew check reads;
// `opts.timers` ({setTimeout, clearTimeout, setInterval, clearInterval}) is what
// every timer the fake arms goes through, so a test can run the 05 cadences
// (schema minimums 5000 / 15000 ms) scaled down while the wire carries the
// contracted values.

const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createValidator } = require('./contracts-loader');

const HOST = '127.0.0.1';
const SUBPROTOCOL = 'web-chat-connector';
const MAX_PAYLOAD = 4 * 1024 * 1024;   // A-05.1 C-05.10a
const FRAME_MAX = 1024 * 1024;         // C-05.10
const CHUNK = 256 * 1024;              // C-05.23: decoded bytes per body / data frame
const CREDIT = 256 * 1024;             // C-05.22: initial credit each way
const CHANNELS = ['control', 'relay', 'events', 'queue'];
const HUB_REQUEST_TYPES = ['ListMachines', 'ListChats', 'GetChatAttach'];
const DERIVED_SIGNALS = new Set(['turn.begun', 'turn.ended', 'ask.opened', 'ask.updated', 'ask.closed', 'conversations', 'resync']);
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 120 * 1000;
const BODY_CAP = 64 * 1024;
const LISTEN_TRIES = 5;

const CROCKFORD_LOWER = '0123456789abcdefghjkmnpqrstvwxyz';
const CROCKFORD_UPPER = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The reserved band: the hub's 5170, the portal's 5171, and the daemons' 5173–5272.
function isReservedPort(port) {
  return port === 5170 || port === 5171 || (port >= 5173 && port <= 5272);
}

// The first n characters of the base32 of buf, most significant bit first.
function base32(buf, n, alphabet = CROCKFORD_LOWER) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < n) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= n) break;
  }
  if (out.length < n) throw new Error(`base32: ${buf.length} bytes do not make ${n} characters`);
  return out;
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// 03 section 2: `mky_` and the first 130 bits of SHA-256 over the raw key, in
// lowercase Crockford base32; the display form is OpenSSH's.
function keyIdOf(publicKey) {
  return `mky_${base32(sha256(rawKey(publicKey)), 26)}`;
}
function fingerprintOf(publicKey) {
  return `SHA256:${sha256(rawKey(publicKey)).toString('base64').replace(/=+$/, '')}`;
}
function rawKey(publicKey) {
  if (Buffer.isBuffer(publicKey)) return publicKey;
  if (typeof publicKey === 'string') return Buffer.from(publicKey, 'base64url');
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
}
function wireKey(publicKey) {
  return rawKey(publicKey).toString('base64url');
}

function mintId(prefix) {
  return `${prefix}_${base32(crypto.randomBytes(17), 26)}`;
}
function mintLabel() {
  return base32(crypto.randomBytes(17), 26);
}

function verifySig(publicKeyWire, text, signature) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyWire }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// One validator per process: each compile is ~0.4 s (U734's hand-off).
let sharedValidator = null;
function validator() {
  if (!sharedValidator) sharedValidator = createValidator({ folders: 'all' });
  return sharedValidator;
}
const HUB_REQUEST_ID = 'https://web-chat-contracts/schemas/10-hub-request.json';
const DECISION_ID = 'https://web-chat-contracts/schemas/04-policy-decision.json';

function example(name) {
  const ex = validator().view.examples.get(name);
  if (!ex) throw new Error(`fake hub: no locked example ${name}`);
  return JSON.parse(JSON.stringify(ex.data));
}

function describeErrors(errors) {
  return (errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ');
}

const iso = (ms) => new Date(ms).toISOString();

function createFakeHub(opts = {}) {
  const o = {
    hubId: 'hub-test',
    publicHost: 'hub.test:8443',
    codeTtlMs: 300 * 1000,
    pollHoldMs: 25 * 1000,
    pollAfterMs: 1000,
    challengeTtlMs: 10 * 1000,
    sessionTtlMs: DAY_MS,
    heartbeatMs: 15000,
    deadAfterMs: 45000,
    retryAfterMs: 10 * 1000,
    protocol: { min: 1, max: 1 },
    hubVersion: '0.1.0',
    webChat: '0.9.0-alpha.7',
    window: { min: '0.9.0-alpha.7', max: '0.9.0', claude_code_min: null },
    capabilities: ['relay.http', 'relay.ws', 'relay.answer', 'relay.decision_ref', 'events.batch', 'events.signals', 'authority.log', 'queue.message', 'key.rotate'],
    windows: {
      relay_stream_bytes: CREDIT,
      relay_streams_max: 256,
      relay_streams_per_chat: 64,
      signals_unacked: 256,
      batches_unacked_per_chat: 4,
      frame_bytes_max: FRAME_MAX,
    },
    tableSha: example('04-policy-decision-local-port').table.sha256,
    rotate: false,
    limits: null,
    now: Date.now,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    isReserved: isReservedPort,
    ...opts,
  };
  const limits = o.limits ? { startsPerAddress: 5, windowMs: 10 * 60 * 1000, pending: 50, ...(o.limits === true ? {} : o.limits) } : null;
  const now = () => o.now();
  const T = o.timers;

  const frames = [];
  const errors = [];
  const watchers = new Set();
  const machines = new Map();
  const pairings = new Map();
  const links = [];
  const assignments = new Map();   // chat label -> { assignment, cursor }
  const queues = new Map();        // chat label -> [item]
  const delivered = [];
  const hubResults = new Map();
  const hubErrors = new Map();
  const globalTimers = new Set();
  const pollTimers = new Set();      // one Set per held poll
  const startsByAddress = new Map();

  let silenced = false;
  let verdict = { state: 'ok', overrides: {} };
  let settings = { agents_at_once: 1, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 1, ...(o.settings || {}) };
  let httpServer = null;
  let wss = null;
  let linkSeq = 0;

  const actorDefault = example('03-actor-header');
  const principalDefault = example('03-principal');

  // ── timers ───────────────────────────────────────────────────────────────
  function after(set, ms, fn) {
    const h = T.setTimeout(() => { set.delete(h); fn(); }, ms);
    set.add(h);
    return h;
  }
  function every(set, ms, fn) {
    const h = T.setInterval(fn, ms);
    set.add({ interval: h });
    return h;
  }
  function clearAll(set) {
    for (const h of set) {
      if (h && h.interval !== undefined) T.clearInterval(h.interval);
      else T.clearTimeout(h);
    }
    set.clear();
  }

  // ── the record ───────────────────────────────────────────────────────────
  function notify(entry) {
    for (const w of [...watchers]) w(entry);
  }
  function pushError(err) {
    errors.push(err);
  }
  function record(dir, link, frame, text, verdictOf) {
    const v = verdictOf || validator().validateFrame(frame);
    const entry = {
      dir,
      ch: frame && typeof frame === 'object' ? frame.ch ?? null : null,
      kind: frame && typeof frame === 'object' ? frame.kind ?? null : null,
      frame,
      bytes: typeof text === 'string' ? Buffer.byteLength(text) : 0,
      at: now(),
      link: link ? link.n : null,
      ok: v.ok,
    };
    frames.push(entry);
    if (!v.ok) {
      pushError({ dir, ch: entry.ch, kind: entry.kind, link: entry.link, message: describeErrors(v.errors), errors: v.errors });
    }
    notify(entry);
    return entry;
  }
  function recordPairing(dir, def, body) {
    const v = validator().validatePairing(def, body);
    const kept = body && typeof body === 'object' && typeof body.code === 'string' ? { ...body, code: '****-****' } : body;
    const entry = { dir, ch: 'pairing', kind: `pairing.${def}`, frame: kept, bytes: Buffer.byteLength(JSON.stringify(kept ?? null)), at: now(), link: null, ok: v.ok };
    frames.push(entry);
    if (!v.ok) pushError({ dir, ch: 'pairing', kind: entry.kind, link: null, message: describeErrors(v.errors), errors: v.errors });
    notify(entry);
    return v.ok;
  }

  // ── sending ──────────────────────────────────────────────────────────────
  function send(link, frame) {
    if (!link || link.state === 'closed') return null;
    const { ch, kind, re, ...body } = frame;
    link.outSeq[ch] = (link.outSeq[ch] || 0) + 1;
    const full = { ch, kind, id: `h${++link.ids}`, seq: link.outSeq[ch], ...(re !== undefined ? { re } : {}), at: now(), ...body };
    const text = JSON.stringify(full);
    record('out', link, full, text);
    if (silenced) link.held.push(text);
    else link.ws.send(text);
    return full;
  }
  function closeLink(link, code, reason) {
    if (!link || link.state === 'closed' || link.closing) return;
    link.closing = true;
    try { link.ws.close(code, reason); } catch { link.ws.terminate(); }
  }
  function fatal(link, code, re, hint) {
    send(link, { ch: 'control', kind: 'control.error', ...(re ? { re } : {}), code, fatal: true, ...(hint ? { hint } : {}) });
    closeLink(link, 4400);
  }
  function upLink() {
    const link = fake.link;
    if (!link || link.state !== 'up') throw new Error('fake hub: no connector link is up');
    return link;
  }

  // ── compat (12) ──────────────────────────────────────────────────────────
  const VERDICTS = {
    ok: { reasons: [], restrictions: [], text: 'Connected.' },
    ahead: {
      reasons: [{ code: 'package_above_max', detail: 'the connector is newer than this hub knows' }],
      restrictions: [],
      text: 'This machine runs a newer web-chat than this hub knows; it stays connected.',
    },
    behind: {
      reasons: [{ code: 'package_below_min', detail: 'the connector is older than the hub\'s minimum' }],
      restrictions: ['no_new_chats', 'no_queue_delivery', 'read_only_relay'],
      text: 'This machine runs an older web-chat than the hub needs. Its chats stay readable and messages wait until it is updated.',
    },
    refused: {
      reasons: [{ code: 'protocol_unsupported', detail: 'the connector and the hub share no protocol' }],
      restrictions: [],
      text: 'This hub no longer speaks to this machine\'s web-chat. The connector keeps retrying and reconnects once updated.',
    },
  };
  function compatFor(state, protocol, overrides = {}) {
    const base = VERDICTS[state];
    if (!base) throw new Error(`fake hub: no compat state ${state}`);
    return {
      kind: 'compat',
      state,
      protocol: state === 'refused' ? null : protocol,
      window: { min: o.window.min, max: o.window.max, protocol: { ...o.protocol }, claude_code_min: o.window.claude_code_min ?? null },
      hub: { version: o.hubVersion, web_chat: o.webChat },
      reasons: base.reasons.map((r) => ({ ...r })),
      restrictions: [...base.restrictions],
      message: { text: base.text, command: null },
      ...overrides,
    };
  }
  function restricted(name) {
    return (verdict.overrides.restrictions || VERDICTS[verdict.state].restrictions).includes(name);
  }

  // ── machines ─────────────────────────────────────────────────────────────
  function addMachine({ publicKey, name = 'Test machine', id = mintId('mch'), pairedBy = principalDefault.user } = {}) {
    if (!publicKey) throw new Error('fake hub: addMachine needs a publicKey');
    const wire = wireKey(publicKey);
    const machine = {
      id,
      name,
      paired_by: pairedBy,
      current: { key_id: keyIdOf(wire), public_key: wire },
      retiring: null,
      held: null,
      revoked: false,
      facts: null,
    };
    machines.set(id, machine);
    return machine;
  }
  function machineView(m) {
    return m && { id: m.id, name: m.name, key_id: m.current.key_id, retiring: m.retiring && m.retiring.key_id, held: m.held && m.held.key_id, revoked: m.revoked };
  }

  // ── pairing (C-05.1–C-05.3) ──────────────────────────────────────────────
  function mintCode() {
    const s = base32(crypto.randomBytes(5), 8, CROCKFORD_UPPER);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }
  const codeHash = (code) => sha256(Buffer.from(String(code).trim().toUpperCase())).toString('hex');

  function pollAnswer(p) {
    if (p.state === 'pending' && now() >= p.expires_at) p.state = 'expired';
    if (p.state === 'bound') {
      const m = machines.get(p.machine_id);
      return {
        ok: true, state: 'bound', machine_id: m.id, machine_name: m.name, key_id: keyIdOf(p.public_key),
        hub_id: o.hubId, connect_url: fake.connectUrl,
      };
    }
    if (p.state === 'expired') return { ok: true, state: 'expired', hint: 'The code expired unused. Run connect again for a new one.' };
    if (p.state === 'refused') return { ok: false, state: 'refused', hint: 'The code was declined on the hub.' };
    return { ok: true, state: 'pending' };
  }
  function wake(p) {
    for (const w of [...p.waiters]) w();
  }
  const pairing = {
    // The signed-in user entering a code in Settings > Machines.
    confirm(code, { name = 'Test machine' } = {}) {
      const h = codeHash(code);
      const p = [...pairings.values()].find((x) => x.codeHash === h);
      if (!p) return { ok: false, reason: 'unknown' };
      if (p.used) return { ok: false, reason: 'used' };
      if (now() >= p.expires_at) { p.state = 'expired'; wake(p); return { ok: false, reason: 'expired' }; }
      p.used = true;
      const m = addMachine({ publicKey: p.public_key, name });
      p.state = 'bound';
      p.machine_id = m.id;
      wake(p);
      return { ok: true, machine_id: m.id, key_id: m.current.key_id };
    },
    refuse(code) {
      const h = codeHash(code);
      const p = [...pairings.values()].find((x) => x.codeHash === h);
      if (!p || p.used) return { ok: false };
      p.used = true;
      p.state = 'refused';
      wake(p);
      return { ok: true };
    },
    get pending() { return [...pairings.values()].filter((p) => p.state === 'pending').length; },
  };

  function reply(res, status, def, body, headers = {}) {
    recordPairing('out', def, body);
    if (res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }
  function refusePairing(res, status, error, hint, extra = {}) {
    const body = { ok: false, error, ...(hint ? { hint } : {}), ...extra };
    reply(res, status, 'error_response', body, extra.retry_after_s ? { 'retry-after': String(extra.retry_after_s) } : {});
  }

  function onStart(req, res, body, host) {
    if (limits) {
      const addr = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const recent = (startsByAddress.get(addr) || []).filter((t) => now() - t < limits.windowMs);
      if (recent.length >= limits.startsPerAddress) {
        const wait = Math.max(1, Math.ceil((recent[0] + limits.windowMs - now()) / 1000));
        startsByAddress.set(addr, recent);
        return refusePairing(res, 429, 'rate_limited', 'Too many pairing requests from this address.', { retry_after_s: wait });
      }
      if (pairing.pending >= limits.pending) {
        return refusePairing(res, 429, 'too_many_pending', 'Too many codes are waiting on this hub.', { retry_after_s: 60 });
      }
      recent.push(now());
      startsByAddress.set(addr, recent);
    }
    if (!recordPairing('in', 'start_request', body)) return refusePairing(res, 400, 'bad_request');
    if (!verifySig(body.public_key, `web-chat-connector-pair/1\n${host}\n${body.client_nonce}`, body.proof)) {
      return refusePairing(res, 400, 'bad_proof');
    }
    const code = mintCode();
    const p = {
      id: mintId('pr'),
      codeHash: codeHash(code),
      public_key: body.public_key,
      connector: body.connector,
      expires_at: now() + o.codeTtlMs,
      state: 'pending',
      used: false,
      machine_id: null,
      polling: false,
      waiters: new Set(),
    };
    pairings.set(p.id, p);
    reply(res, 200, 'start_response', {
      ok: true, pairing_id: p.id, code, expires_at: p.expires_at, poll_after_ms: o.pollAfterMs,
      fingerprint: fingerprintOf(body.public_key), hub_id: o.hubId,
    });
  }

  function onPoll(req, res, body, host) {
    if (!recordPairing('in', 'poll_request', body)) return refusePairing(res, 400, 'bad_request');
    const p = pairings.get(body.pairing_id);
    if (!p) return refusePairing(res, 404, 'unknown_pairing');
    if (!verifySig(p.public_key, `web-chat-connector-pair-poll/1\n${host}\n${body.pairing_id}\n${body.ts}`, body.proof)) {
      return refusePairing(res, 400, 'bad_proof');
    }
    if (Math.abs(body.ts - now()) > CLOCK_SKEW_MS) {
      return refusePairing(res, 400, 'clock_skew', 'Set this machine\'s clock; the hub refuses a poll more than 120 s off.');
    }
    if (limits && p.polling) return refusePairing(res, 429, 'rate_limited', 'One poll at a time.', { retry_after_s: 1 });
    const first = pollAnswer(p);
    if (first.state !== 'pending') return reply(res, 200, 'poll_response', first);
    p.polling = true;
    const timers = new Set();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      p.polling = false;
      p.waiters.delete(finish);
      clearAll(timers);
      pollTimers.delete(timers);
      reply(res, 200, 'poll_response', pollAnswer(p));
    };
    pollTimers.add(timers);
    p.waiters.add(finish);
    after(timers, o.pollHoldMs, finish);
    res.on('close', () => {
      if (done) return;
      done = true;
      p.polling = false;
      p.waiters.delete(finish);
      clearAll(timers);
      pollTimers.delete(timers);
    });
  }

  function onRequest(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    const url = new URL(req.url, 'http://fake-hub.invalid');
    const route = req.method === 'POST' && (url.pathname === '/connector/pair' ? onStart : url.pathname === '/connector/pair/poll' ? onPoll : null);
    if (!route) return refusePairing(res, 404, 'bad_request', 'no such route');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= BODY_CAP) chunks.push(c);
    });
    req.on('end', () => {
      if (size > BODY_CAP) return refusePairing(res, 400, 'bad_request', 'body too large');
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return refusePairing(res, 400, 'bad_request', 'not JSON'); }
      try {
        route(req, res, body, String(req.headers.host || ''));
      } catch (e) {
        pushError({ dir: 'in', ch: 'pairing', kind: 'pairing', link: null, message: `handler threw: ${e.message}` });
        refusePairing(res, 503, 'unavailable');
      }
    });
  }

  // ── the link (C-05.4–C-05.20) ────────────────────────────────────────────
  function onLink(ws, req) {
    let resolveClosed;
    const link = {
      n: ++linkSeq,
      ws,
      host: String(req.headers.host || ''),
      userAgent: req.headers['user-agent'] || null,
      state: 'challenge',
      machine: null,
      keyWire: null,
      challenge: null,
      outSeq: {},
      inSeq: {},
      ids: 0,
      timers: new Set(),
      held: [],
      streams: new Map(),
      ended: new Set(),
      streamSeq: 0,
      closeCode: null,
      closeReason: null,
      closing: false,
      transportErrors: [],
      closed: new Promise((r) => { resolveClosed = r; }),
    };
    links.push(link);
    ws.on('error', (e) => { link.transportErrors.push(e.code || e.message); });
    ws.on('message', (data, isBinary) => onFrame(link, data, isBinary));
    ws.on('close', (code, reason) => {
      link.state = 'closed';
      link.closeCode = code;
      link.closeReason = String(reason || '');
      clearAll(link.timers);
      if (fake.link === link) fake.link = null;
      for (const st of link.streams.values()) endStream(st, { code: 4502, reason: 'the machine is offline' });
      link.streams.clear();
      for (const q of queues.values()) for (const item of q) if (item.inflight && item.inflight.link === link) item.inflight.link = null;
      resolveClosed({ code, reason: link.closeReason });
    });
    resetDead(link);
    const nonce = crypto.randomBytes(32).toString('base64url');
    link.challenge = { nonce, expires_at: now() + o.challengeTtlMs, used: false, id: null };
    const sent = send(link, { ch: 'control', kind: 'auth.challenge', nonce, expires_at: link.challenge.expires_at });
    link.challenge.id = sent.id;
    after(link.timers, o.challengeTtlMs, () => { if (link.state === 'challenge') closeLink(link, 4401, 'no answer to the challenge'); });
  }

  function resetDead(link) {
    if (link.deadTimer) { link.timers.delete(link.deadTimer); T.clearTimeout(link.deadTimer); }
    link.deadTimer = after(link.timers, o.deadAfterMs, () => closeLink(link, 4408, 'heartbeat deadline'));
  }

  function onFrame(link, data, isBinary) {
    if (link.state === 'closed') return;
    resetDead(link);
    const text = isBinary ? null : data.toString('utf8');
    if (isBinary) {
      pushError({ dir: 'in', ch: null, kind: null, link: link.n, message: 'a binary message (protocol 1 sends text frames only)' });
      return fatal(link, 'bad_frame', null);
    }
    if (Buffer.byteLength(text) > FRAME_MAX) {
      pushError({ dir: 'in', ch: null, kind: null, link: link.n, message: `a ${Buffer.byteLength(text)}-byte frame above C-05.10's 1 MiB` });
      return fatal(link, 'too_large', null);
    }
    let frame;
    try { frame = JSON.parse(text); } catch {
      pushError({ dir: 'in', ch: null, kind: null, link: link.n, message: 'malformed JSON' });
      return fatal(link, 'bad_frame', null);
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      pushError({ dir: 'in', ch: null, kind: null, link: link.n, message: 'not a JSON object' });
      return fatal(link, 'bad_frame', null);
    }
    const entry = record('in', link, frame, text);
    const re = typeof frame.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(frame.id) ? frame.id : null;
    if (!CHANNELS.includes(frame.ch)) return fatal(link, 'unknown_channel', re);
    const expected = (link.inSeq[frame.ch] || 0) + 1;
    if (frame.seq !== expected) {
      pushError({ dir: 'in', ch: frame.ch, kind: frame.kind, link: link.n, message: `seq ${frame.seq} on ${frame.ch}, expected ${expected} (C-05.11)` });
      return fatal(link, 'seq_gap', re);
    }
    link.inSeq[frame.ch] = frame.seq;
    if (!validator().frameIndex.has(`${frame.ch}\u0000${frame.kind}`)) {
      if (frame.kind === 'hub.request') return fatal(link, 'bad_frame', re);
      send(link, { ch: 'control', kind: 'control.error', ...(re ? { re } : {}), code: 'unknown_kind', fatal: false });
      return;
    }
    try {
      dispatch(link, frame, entry.ok);
    } catch (e) {
      pushError({ dir: 'in', ch: frame.ch, kind: frame.kind, link: link.n, message: `the fake's handler threw: ${e.message}` });
    }
  }

  function dispatch(link, f, valid) {
    if (link.state === 'challenge') {
      if (f.kind === 'auth.response') return onAuth(link, f);
      return;   // nothing else before authentication; recorded above
    }
    switch (f.kind) {
      case 'hello': return onHello(link, f);
      case 'key.rotate': return onRotate(link, f);
      case 'machine.facts': if (link.machine) link.machine.facts = f; return;
      case 'machine.leave': {
        if (link.machine) link.machine.revoked = true;
        return closeLink(link, 1000);
      }
      case 'hub.request': return onHubRequest(link, f, valid);
      case 'hub.response':
        return send(link, { ch: 'control', kind: 'control.error', re: f.id, code: 'not_allowed', fatal: false });
      case 'events.batch': return onBatch(link, f);
      case 'queue.ack': return onQueueAck(link, f);
      default:
        if (f.ch === 'events' && DERIVED_SIGNALS.has(f.kind)) return onSignal(link, f);
        if (f.ch === 'relay') return onRelay(link, f);
        // heartbeat, chat.status, chat.versions, authority.log, control.error,
        // auth.response again: recorded, nothing to answer.
    }
  }

  function refuseAuth(link, f, reason, code, hint) {
    send(link, { ch: 'control', kind: 'auth.refused', re: f.id, reason, ...(hint ? { hint } : {}) });
    closeLink(link, code);
  }

  function onAuth(link, f) {
    const ch = link.challenge;
    if (ch.used) return;
    ch.used = true;
    if (now() > ch.expires_at || f.re !== ch.id) return refuseAuth(link, f, 'nonce_expired', 4401);
    const machine = machines.get(f.machine_id);
    if (!machine) return refuseAuth(link, f, 'unknown_machine', 4401);
    if (machine.revoked) return refuseAuth(link, f, 'machine_revoked', 4403);
    if (typeof f.public_key !== 'string' || f.key_id !== keyIdOf(f.public_key)) return refuseAuth(link, f, 'bad_signature', 4401);
    const signed = `web-chat-connector-auth/1\n${link.host}\n${ch.nonce}\n${f.machine_id}\n${f.key_id}`;
    if (!verifySig(f.public_key, signed, f.signature)) return refuseAuth(link, f, 'bad_signature', 4401);
    const retiringOk = machine.retiring && machine.retiring.key_id === f.key_id && now() < machine.retiring.until;
    if (machine.current.key_id !== f.key_id && !retiringOk) {
      machine.held = { key_id: f.key_id, public_key: f.public_key };
      return refuseAuth(link, f, 'key_held', 4423,
        `This machine presented a key the hub does not know. Its owner can accept it in Settings > Machines.`);
    }
    for (const other of links) {
      if (other !== link && other.machine === machine && (other.state === 'hello' || other.state === 'up')) closeLink(other, 4409, 'superseded');
    }
    link.state = 'hello';
    link.machine = machine;
    link.keyWire = f.public_key;
    link.connection = mintId('cxs');
    send(link, {
      ch: 'control', kind: 'auth.ok', re: f.id, machine_id: machine.id, connection: link.connection,
      expires_at: now() + Math.min(o.sessionTtlMs, DAY_MS), key_id: machine.current.key_id,
      rotate: Boolean(o.rotate),
    });
  }

  function onRotate(link, f) {
    const m = link.machine;
    const signed = `web-chat-connector-rotate/1\n${link.host}\n${m.id}\n${f.new_key_id}`;
    const ok = typeof f.new_public_key === 'string'
      && f.new_key_id === keyIdOf(f.new_public_key)
      && verifySig(link.keyWire, signed, f.sig_old)
      && verifySig(f.new_public_key, signed, f.sig_new);
    if (!ok) {
      return send(link, { ch: 'control', kind: 'control.error', re: f.id, code: 'not_allowed', fatal: false, hint: 'key.rotate needs both signatures over the rotate string' });
    }
    m.retiring = { ...m.current, until: now() + DAY_MS };
    m.current = { key_id: f.new_key_id, public_key: f.new_public_key };
    link.keyWire = f.new_public_key;
    send(link, { ch: 'control', kind: 'key.rotated', re: f.id, key_id: f.new_key_id });
  }

  function onHello(link, f) {
    if (link.state !== 'hello') return;
    const range = (f.versions && f.versions.protocol) || { min: 0, max: -1 };
    const top = Math.min(range.max, o.protocol.max);
    const meets = top >= Math.max(range.min, o.protocol.min);
    if (verdict.state === 'refused' || !meets) {
      send(link, { ch: 'control', kind: 'hello.refused', re: f.id, compat: compatFor('refused', null, verdict.state === 'refused' ? verdict.overrides : {}) });
      link.state = 'refused';
      return closeLink(link, 4426);
    }
    link.state = 'up';
    link.protocol = top;
    link.hello = f;
    fake.link = link;
    send(link, {
      ch: 'control', kind: 'hello.ack', re: f.id, protocol: top,
      hub: { id: o.hubId, origin: fake.origin },
      machine: { id: link.machine.id, name: link.machine.name },
      capabilities: [...o.capabilities],
      heartbeat_ms: o.heartbeatMs,
      dead_after_ms: o.deadAfterMs,
      windows: { ...o.windows },
      compat: compatFor(verdict.state, top, verdict.overrides),
    });
    every(link.timers, o.heartbeatMs, () => send(link, { ch: 'control', kind: 'ping' }));
    send(link, { ch: 'control', kind: 'machine.settings', settings: { ...settings } });
    for (const { assignment, cursor } of assignments.values()) send(link, { ch: 'control', kind: 'chat.assign', assignment, cursor });
    pumpQueue();
  }

  // ── hub.request (A-05.3) ─────────────────────────────────────────────────
  function defaultResult(type, params) {
    if (type === 'ListChats') return example('10-hub-request-list-chats-ok').result;
    if (type === 'GetChatAttach') {
      const r = example('10-hub-request-get-chat-attach-ok').result;
      if (params && typeof params.chat_id === 'string') r.chat_id = params.chat_id;
      return r;
    }
    return {
      machines: [...machines.values()].map((m) => ({
        machine_id: m.id,
        name: m.name.slice(0, 64),
        state: settings.paused ? 'paused' : links.some((l) => l.machine === m && l.state === 'up') ? 'online' : 'offline',
        connector_version: null,
        claude_code_version: null,
        agents_at_once: settings.agents_at_once,
        accept_new_chats: settings.accept_new_chats,
        home_may_start_agents: settings.let_home_start_agents,
        folders_offered: 0,
        chats: assignments.size,
        last_seen_at: now(),
      })),
    };
  }
  function onHubRequest(link, f, valid) {
    const type = f.request && f.request.type;
    if (!valid || !HUB_REQUEST_TYPES.includes(type)) return fatal(link, 'bad_frame', f.id, 'hub.request takes ListMachines, ListChats or GetChatAttach');
    const params = f.request.params || {};
    const request_id = `rq_${base32(crypto.randomBytes(10), 16, CROCKFORD_UPPER)}`;
    let response;
    if (hubErrors.has(type)) {
      response = { ok: false, type, request_id, error: JSON.parse(JSON.stringify(hubErrors.get(type))) };
    } else {
      const set = hubResults.get(type);
      const result = typeof set === 'function' ? set(params) : set !== undefined ? JSON.parse(JSON.stringify(set)) : defaultResult(type, params);
      response = { ok: true, type, request_id, result };
    }
    const body = validator().ajv.getSchema(HUB_REQUEST_ID);
    if (!body(response)) {
      pushError({ dir: 'out', ch: 'control', kind: 'hub.response', link: link.n, message: `10-hub-request body: ${describeErrors(body.errors)}`, errors: body.errors });
    }
    send(link, { ch: 'control', kind: 'hub.response', re: f.id, response });
  }

  // ── events (C-05.37–C-05.43, 07) ─────────────────────────────────────────
  function sourceCursor(chat) {
    const a = assignments.get(chat);
    if (a) return a.cursor;
    return { type: 'source', chat_id: chat, ring: 'main', boot: null, seq: 0, capture_seq: 0, element_seq: 0 };
  }
  function onBatch(link, f) {
    const b = f.batch || {};
    const prev = sourceCursor(b.chat_id);
    const seqs = (b.entries || []).map((e) => e.seq);
    const caps = (b.reconciled || []).map((r) => r.seq);
    const sameBoot = prev.boot === b.boot;
    const cursor = {
      type: 'source', chat_id: b.chat_id, ring: 'main', boot: b.boot,
      seq: Math.max(b.since || 0, ...seqs),
      capture_seq: Math.max(sameBoot ? prev.capture_seq : 0, ...caps),
      element_seq: sameBoot ? prev.element_seq : 0,
    };
    if (assignments.has(b.chat_id)) assignments.get(b.chat_id).cursor = cursor;
    const ack = {
      ch: 'events', kind: 'events.ack', re: f.id,
      ack: { type: 'events.ack', chat_id: b.chat_id, batch_id: b.batch_id, cursor, ingested: seqs.length, duplicates: 0 },
    };
    if (events.manualAck) events.pending.push({ link, ack });
    else send(link, ack);
  }
  function onSignal(link, f) {
    if (events.holdSignals) { events.pendingSignals.push({ link, up_to: f.seq }); return; }
    send(link, { ch: 'events', kind: 'signals.ack', up_to: f.seq });
  }
  const events = {
    manualAck: false,
    holdSignals: false,
    pending: [],
    pendingSignals: [],
    // Send the held events.ack frames (all, or the first n), each on its own link.
    ack(n = Infinity) {
      const take = events.pending.splice(0, n);
      for (const { link, ack } of take) send(link, ack);
      return take.length;
    },
    ackSignals() {
      const take = events.pendingSignals.splice(0);
      if (take.length) {
        const last = take[take.length - 1];
        send(last.link, { ch: 'events', kind: 'signals.ack', up_to: last.up_to });
      }
      return take.length;
    },
  };

  // ── queue (C-05.25, C-05.27, C-07.26–C-07.28) ────────────────────────────
  // A ULID's shape: 48 bits of time over an 80-bit counter (random start), so
  // ids minted by one fake sort in the order they were minted.
  let hmCounter = BigInt(`0x${crypto.randomBytes(8).toString('hex')}`);
  function mintHubMsgId() {
    hmCounter += 1n;
    const v = (BigInt(Math.max(0, Math.floor(now()))) << 80n) | (hmCounter & ((1n << 80n) - 1n));
    let out = '';
    for (let i = 25; i >= 0; i--) out += CROCKFORD_UPPER[Number((v >> BigInt(5 * i)) & 31n)];
    return `hm_${out}`;
  }
  function deliveriesWithheld() {
    return settings.paused || restricted('no_queue_delivery');
  }
  function sendDeliver(link, item) {
    item.sends += 1;
    if (item.sends > 1) item.delivery.attempt += 1;
    const auth = item.decisionRef ? { decision_ref: item.decisionRef } : { decision: item.decision || decision({ chat: item.chat }) };
    const frame = send(link, {
      ch: 'queue', kind: 'queue.deliver', delivery: item.delivery, actor: item.actor,
      ...auth, ...(item.device ? { device: item.device } : {}),
    });
    item.inflight = { frameId: frame.id, link };
  }
  function pumpQueue() {
    const link = fake.link;
    if (!link || link.state !== 'up' || deliveriesWithheld()) return;
    for (const q of queues.values()) {
      const head = q[0];
      if (!head || head.retryTimer) continue;
      if (head.inflight && head.inflight.link === link) continue;   // one unacknowledged per chat
      sendDeliver(link, head);
    }
  }
  function onQueueAck(link, f) {
    let found = null;
    for (const q of queues.values()) {
      if (q[0] && q[0].inflight && q[0].inflight.frameId === f.re && q[0].inflight.link === link) { found = q; break; }
    }
    if (!found) return send(link, { ch: 'control', kind: 'control.error', re: f.id, code: 'not_allowed', fatal: false });
    const item = found[0];
    const ack = f.ack || {};
    delivered.push({ hub_msg_id: item.delivery.hub_msg_id, chat: item.chat, attempt: item.delivery.attempt, outcome: ack.outcome, ack });
    item.inflight = null;
    if (ack.outcome === 'retry') {
      const wait = Number.isInteger(ack.retry_after_ms) ? ack.retry_after_ms : o.retryAfterMs;
      item.retryTimer = after(globalTimers, wait, () => { item.retryTimer = null; pumpQueue(); });
      return;
    }
    found.shift();
    pumpQueue();
  }
  const queue = {
    delivered,
    // Hold a delivery for a chat (07's body; hub_msg_id, chat_id, attempt and
    // enqueued_at are filled in when absent). Returns the delivery body.
    hold(chat, delivery = {}, { actor, decision: d, decisionRef, device } = {}) {
      const body = {
        type: 'queue.deliver',
        hub_msg_id: delivery.hub_msg_id || mintHubMsgId(),
        chat_id: chat,
        attempt: 1,
        enqueued_at: now(),
        message: { text: 'a held message', send: 'auto' },
        ...delivery,
      };
      if (!queues.has(chat)) queues.set(chat, []);
      queues.get(chat).push({
        chat, delivery: body, actor: actor || JSON.parse(JSON.stringify(actorDefault)), decision: d || null,
        decisionRef: decisionRef || null, device: device || null, sends: 0, inflight: null, retryTimer: null,
      });
      pumpQueue();
      return body;
    },
    held(chat) {
      return (queues.get(chat) || []).map((i) => ({ hub_msg_id: i.delivery.hub_msg_id, attempt: i.delivery.attempt, inflight: Boolean(i.inflight) }));
    },
  };

  // ── decisions (04, A-04.1) ───────────────────────────────────────────────
  function decision({
    chat, daemon_level = 'full', levels, specifics, version = 1, origins, expiresInMs = 300 * 1000,
    relation, chat_state = 'active', machineId, principal,
  } = {}) {
    if (!chat) throw new Error('fake hub: decision needs a chat label');
    const lv = levels || (daemon_level === 'full' ? ['read', 'message', 'write_page', 'files'] : daemon_level === 'read' ? ['read'] : []);
    const rel = relation || (lv.length === 0 ? 'hub' : 'owner');
    const issued = now();
    const m = machineId || (fake.link && fake.link.machine && fake.link.machine.id) || ([...machines.keys()][0]) || example('04-policy-decision-local-port').machine_id;
    return {
      decision_id: mintId('dec'),
      version,
      issued_at: iso(issued),
      expires_at: iso(issued + expiresInMs),
      principal: principal || JSON.parse(JSON.stringify(principalDefault)),
      chat_id: chat,
      machine_id: m,
      relation: rel,
      chat_state,
      levels: lv,
      sources: Object.fromEntries(lv.map((l) => [l, 'always'])),
      specifics: { status: lv.includes('read'), steer: rel === 'owner' && chat_state === 'active' && daemon_level === 'full', destructive: false, private: 'none', ...(specifics || {}) },
      daemon_level,
      origins: origins || {
        surface: `https://chat-${chat}.${o.publicHost}`,
        answer: rel === 'owner' && chat_state === 'active' ? `https://chat-${chat}-a.${o.publicHost}` : null,
      },
      table: { version: 1, sha256: o.tableSha },
    };
  }
  function checkDecision(d) {
    const v = validator().ajv.getSchema(DECISION_ID);
    return v(d) ? { ok: true, errors: null } : { ok: false, errors: v.errors };
  }
  function sendDecision(d) {
    const link = upLink();
    send(link, { ch: 'relay', kind: 'relay.decision', chat: d.chat_id, decision: d });
    return { decision_id: d.decision_id, version: d.version };
  }
  function authOf(chat, d, decisionRef) {
    return decisionRef ? { decision_ref: decisionRef } : { decision: d || decision({ chat }) };
  }

  // ── relays (C-05.28–C-05.36) ─────────────────────────────────────────────
  function newStream(link, kind, chat) {
    const st = {
      kind, id: ++link.streamSeq, chat, link,
      sendCredit: CREDIT, recvCredit: CREDIT, recvUsed: 0,
      out: [], done: false,
    };
    link.streams.set(st.id, st);
    return st;
  }
  function retire(st) {
    st.done = true;
    st.link.streams.delete(st.id);
    st.link.ended.add(st.id);
  }
  function endStream(st, close) {
    if (st.done) return;
    retire(st);
    if (st.kind === 'http') st.reject(Object.assign(new Error(`relay stream ${st.id} ended: ${close.reason || close.code}`), { close }));
    else st.finish(close);
  }
  function receive(st, bytes) {
    st.recvUsed += bytes;
    if (st.recvUsed > st.recvCredit) {
      pushError({ dir: 'in', ch: 'relay', kind: st.kind === 'http' ? 'relay.http.body' : 'relay.ws.data', link: st.link.n, message: `stream ${st.id} sent ${st.recvUsed} bytes on ${st.recvCredit} of credit (C-05.22)` });
      if (st.kind === 'http') send(st.link, { ch: 'relay', kind: 'relay.http.abort', stream: st.id, reason: 'window_exceeded' });
      else send(st.link, { ch: 'relay', kind: 'relay.ws.close', stream: st.id, code: 1008, reason: 'window exceeded' });
      endStream(st, { code: 1008, reason: 'window_exceeded' });
      return false;
    }
    return true;
  }
  function grant(st, bytes) {
    if (bytes <= 0 || st.done) return;
    st.recvCredit += bytes;
    send(st.link, { ch: 'relay', kind: 'relay.window', stream: st.id, bytes });
  }

  // The next piece of buf from offset: at most min(CHUNK, credit) bytes, cut at
  // a UTF-8 boundary for text, and small enough that its frame stays under 1 MiB.
  function piece(buf, offset, credit, text) {
    if (credit <= 0 || offset >= buf.length) return null;
    let end = Math.min(buf.length, offset + Math.min(CHUNK, credit));
    for (;;) {
      if (text) while (end > offset && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
      if (end <= offset) return null;
      const slice = buf.subarray(offset, end);
      const data = text ? slice.toString('utf8') : slice.toString('base64');
      if (Buffer.byteLength(JSON.stringify(data)) + 512 <= FRAME_MAX) return { slice, data, end };
      end = offset + Math.floor((end - offset) / 2);
    }
  }

  function pumpHttp(st) {
    while (!st.done && st.out.length) {
      const head = st.out[0];
      const p = piece(head.buf, head.offset, st.sendCredit, false);
      if (!p) return;
      head.offset = p.end;
      st.sendCredit -= p.slice.length;
      const last = head.offset === head.buf.length;
      if (last) st.out.shift();
      send(st.link, { ch: 'relay', kind: 'relay.http.body', stream: st.id, body: p.data, end: last });
    }
  }

  function relayHttp({
    chat, surface = 'session', method = 'GET', path = '/', headers = {}, body, decision: d, decisionRef, actor, device,
  } = {}) {
    const link = upLink();
    const st = newStream(link, 'http', chat);
    const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const promise = new Promise((resolve, reject) => { st.resolve = resolve; st.reject = reject; });
    st.chunks = [];
    st.response = null;
    const first = buf.length ? piece(buf, 0, st.sendCredit, false) : null;
    if (first) st.sendCredit -= first.slice.length;
    const rest = first ? first.end : 0;
    const frame = send(link, {
      ch: 'relay', kind: 'relay.http.request', stream: st.id, chat, surface, method, path, headers,
      actor: actor || JSON.parse(JSON.stringify(actorDefault)), ...authOf(chat, d, decisionRef),
      ...(device ? { device } : {}), ...(first ? { body: first.data } : {}), end: rest === buf.length,
    });
    st.requestId = frame.id;
    if (rest < buf.length) {
      st.out.push({ buf, offset: rest });
      pumpHttp(st);
    }
    return promise;
  }

  function wsData(st, data) {
    const binary = Buffer.isBuffer(data);
    st.out.push({ buf: binary ? data : Buffer.from(String(data), 'utf8'), offset: 0, binary });
    if (st.state === 'open') pumpWs(st);
  }
  function pumpWs(st) {
    while (!st.done && st.out.length) {
      const head = st.out[0];
      let p;
      if (head.buf.length === 0) p = { slice: head.buf, data: '', end: 0 };
      else p = piece(head.buf, head.offset, st.sendCredit, !head.binary);
      if (!p) return;
      head.offset = p.end;
      st.sendCredit -= p.slice.length;
      const more = head.offset < head.buf.length;
      if (!more) st.out.shift();
      send(st.link, { ch: 'relay', kind: 'relay.ws.data', stream: st.id, binary: head.binary, ...(more ? { more: true } : {}), data: p.data });
    }
  }

  function relayWs({ chat, decision: d, decisionRef, actor, userAgent, device } = {}) {
    const link = upLink();
    const st = newStream(link, 'ws', chat);
    st.state = 'opening';
    st.frag = null;
    const messages = [];
    let onOpened; let onRefused; let onClosed;
    const handle = {
      stream: st.id,
      messages,
      opened: new Promise((r) => { onOpened = r; }),
      refused: new Promise((r) => { onRefused = r; }),
      closed: new Promise((r) => { onClosed = r; }),
      get state() { return st.state; },
      send(data) { if (st.done) return false; wsData(st, data); return true; },
      close(code = 1000, reason) {
        if (st.done) return;
        send(link, { ch: 'relay', kind: 'relay.ws.close', stream: st.id, code, ...(reason ? { reason } : {}) });
        endStream(st, { code, reason: reason || '', by: 'hub' });
      },
    };
    st.handle = handle;
    st.messages = messages;
    st.onOpened = onOpened;
    st.onRefused = onRefused;
    st.finish = (close) => {
      st.state = 'closed';
      onOpened(false);
      onRefused(null);
      onClosed(close);
    };
    send(link, {
      ch: 'relay', kind: 'relay.ws.open', stream: st.id, chat, path: '/ws',
      ...(userAgent ? { user_agent: userAgent } : {}),
      actor: actor || JSON.parse(JSON.stringify(actorDefault)), ...authOf(chat, d, decisionRef),
      ...(device ? { device } : {}),
    });
    return handle;
  }

  function onRelay(link, f) {
    if (f.kind === 'relay.decision' || f.kind === 'relay.http.request' || f.kind === 'relay.ws.open') {
      return send(link, { ch: 'control', kind: 'control.error', re: f.id, code: 'not_allowed', fatal: false });
    }
    const st = link.streams.get(f.stream);
    if (!st && link.ended.has(f.stream)) return;   // a late window or close for a stream that ended: recorded only
    if (!st) return send(link, { ch: 'control', kind: 'control.error', re: f.id, code: 'unknown_stream', fatal: false });
    switch (f.kind) {
      case 'relay.window':
        st.sendCredit += f.bytes;
        return st.kind === 'http' ? pumpHttp(st) : pumpWs(st);
      case 'relay.http.response': {
        st.response = { status: f.status, headers: f.headers || {} };
        return httpBody(st, f.body, f.end);
      }
      case 'relay.http.body':
        return httpBody(st, f.body, f.end);
      case 'relay.http.abort':
        return endStream(st, { code: null, reason: f.reason });
      case 'relay.ws.opened':
        st.state = 'open';
        st.onOpened(true);
        st.onRefused(null);
        return pumpWs(st);
      case 'relay.ws.refused':
        retire(st);
        st.onRefused({ status: f.status, body: f.body });
        st.finish({ code: null, reason: 'refused', status: f.status });
        st.state = 'refused';
        return;
      case 'relay.ws.data': {
        const bytes = f.binary ? Buffer.from(f.data, 'base64') : Buffer.from(f.data, 'utf8');
        if (!receive(st, bytes.length)) return;
        if (st.frag && st.frag.binary !== f.binary) {
          pushError({ dir: 'in', ch: 'relay', kind: 'relay.ws.data', link: link.n, message: `stream ${st.id}: a fragment's binary differs from its message's (C-05.23)` });
        }
        if (!st.frag) st.frag = { binary: f.binary, parts: [] };
        st.frag.parts.push(bytes);
        grant(st, bytes.length);
        if (f.more) return;
        const whole = Buffer.concat(st.frag.parts);
        st.messages.push({ binary: st.frag.binary, data: st.frag.binary ? whole : whole.toString('utf8'), fragments: st.frag.parts.length });
        st.frag = null;
        return;
      }
      case 'relay.ws.close':
        return endStream(st, { code: f.code, reason: f.reason || '', by: 'connector' });
      default:
    }
  }
  function httpBody(st, b64, end) {
    if (b64) {
      const bytes = Buffer.from(b64, 'base64');
      if (!receive(st, bytes.length)) return;
      st.chunks.push(bytes);
      if (!end) grant(st, bytes.length);
    }
    if (end) {
      retire(st);
      st.resolve({ status: st.response ? st.response.status : null, headers: st.response ? st.response.headers : {}, body: Buffer.concat(st.chunks) });
    }
  }

  // ── chats and settings ───────────────────────────────────────────────────
  function assignment({ chat, chat_id, ...rest } = {}) {
    const label = chat_id || chat || mintLabel();
    return {
      v: 1,
      chat_id: label,
      rev: 1,
      issued_at: now(),
      scope: { kind: 'folder', folder_id: 'f_0123456789abcdef' },
      desired: 'running',
      agent: { want: 'none', launch: 'manual', requested_by: 'user' },
      origins: {
        surface: `https://chat-${label}.${o.publicHost}`,
        answer: `https://chat-${label}-a.${o.publicHost}`,
        shell: `https://${o.publicHost}`,
      },
      ...rest,
    };
  }

  const fake = {
    options: o,   // live: a test may change pollHoldMs, codeTtlMs, rotate, … between steps
    frames,
    errors,
    machines,
    links,
    link: null,
    port: null,
    host: null,
    url: null,
    origin: null,
    connectUrl: null,
    pairing,
    queue,
    events,
    hubRequests: {
      set(type, result) {
        if (!HUB_REQUEST_TYPES.includes(type)) throw new Error(`fake hub: ${type} is not one of the three hub.request types`);
        hubErrors.delete(type);
        hubResults.set(type, result);
      },
      setError(type, error) {
        if (!HUB_REQUEST_TYPES.includes(type)) throw new Error(`fake hub: ${type} is not one of the three hub.request types`);
        hubResults.delete(type);
        hubErrors.set(type, error);
      },
      reset() { hubResults.clear(); hubErrors.clear(); },
    },
    keyIdOf,
    fingerprintOf,
    mintLabel,
    addMachine,
    machine(id) { return machineView(id ? machines.get(id) : [...machines.values()][0]); },
    decision,
    checkDecision,
    sendDecision,
    relayHttp,
    relayWs,
    assignment,

    async start() {
      for (let i = 0; i < LISTEN_TRIES; i++) {
        const server = http.createServer(onRequest);
        server.on('clientError', (e, socket) => { socket.destroy(); });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, HOST, () => { server.off('error', reject); resolve(); });
        });
        const { port, address } = server.address();
        if (address !== HOST || o.isReserved(port)) {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
          continue;
        }
        httpServer = server;
        wss = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_PAYLOAD,
          handleProtocols: (set) => (set.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
        });
        wss.on('error', () => {});
        server.on('upgrade', (req, socket, head) => {
          socket.on('error', () => {});
          const path = new URL(req.url, 'http://fake-hub.invalid').pathname;
          const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
          if (path !== '/connector' || !offered.includes(SUBPROTOCOL)) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => onLink(ws, req));
        });
        fake.port = port;
        fake.host = `${HOST}:${port}`;
        fake.url = `http://${HOST}:${port}`;
        fake.origin = `https://${HOST}:${port}`;
        fake.connectUrl = `wss://${HOST}:${port}/connector`;
        fake.wsUrl = `ws://${HOST}:${port}/connector`;
        fake.address = server.address();
        return fake;
      }
      throw new Error(`fake hub: the OS handed ${LISTEN_TRIES} ports in the reserved band; refusing to listen there`);
    },

    async stop() {
      for (const p of pairings.values()) for (const w of [...p.waiters]) w();
      for (const set of [...pollTimers]) clearAll(set);
      pollTimers.clear();
      clearAll(globalTimers);
      for (const link of links) {
        clearAll(link.timers);
        if (link.state !== 'closed') link.ws.terminate();
      }
      if (wss) for (const c of wss.clients) c.terminate();
      if (wss) await new Promise((r) => wss.close(() => r()));
      if (httpServer) {
        httpServer.closeAllConnections();
        await new Promise((r) => httpServer.close(() => r()));
      }
      httpServer = null;
      wss = null;
    },

    // The compat verdict hello answers from now on (12: ok, ahead, behind, refused).
    setWindow(state, overrides = {}) {
      if (!VERDICTS[state]) throw new Error(`fake hub: no compat state ${state}`);
      verdict = { state, overrides };
    },
    // A later verdict on the link that is up (C-05.14's compat.update).
    compatUpdate(state, overrides = {}) {
      if (state === 'refused') throw new Error('fake hub: a refused verdict is hello.refused, not compat.update');
      fake.setWindow(state, overrides);
      const link = upLink();
      send(link, { ch: 'control', kind: 'compat.update', compat: compatFor(state, link.protocol, overrides) });
      pumpQueue();
    },
    settings(patch = {}) {
      settings = { ...settings, ...patch, rev: settings.rev + 1 };
      if (fake.link && fake.link.state === 'up') send(fake.link, { ch: 'control', kind: 'machine.settings', settings: { ...settings } });
      pumpQueue();
      return { ...settings };
    },
    get currentSettings() { return { ...settings }; },
    // Place a chat on the machine: kept, and sent as chat.assign now (when the
    // link is up) and after every hello.ack, with the chat's 07 source cursor.
    assign(a = {}, { cursor } = {}) {
      const full = a.v === 1 && a.origins ? a : assignment(a);
      const prev = assignments.get(full.chat_id);
      const c = cursor || (prev && prev.cursor) || sourceCursor(full.chat_id);
      assignments.set(full.chat_id, { assignment: full, cursor: c });
      if (fake.link && fake.link.state === 'up') send(fake.link, { ch: 'control', kind: 'chat.assign', assignment: full, cursor: c });
      return full;
    },
    revoke(hint) {
      const link = upLink();
      link.machine.revoked = true;
      send(link, { ch: 'control', kind: 'machine.revoked', ...(hint ? { hint } : {}) });
      closeLink(link, 4403);
    },
    // Stop (true) or resume (false) every outbound frame, pings included; what
    // was held goes out in order on resume, as a stalled TCP stream would.
    silence(on = true) {
      silenced = Boolean(on);
      if (silenced) return;
      for (const link of links) {
        if (link.state === 'closed') { link.held = []; continue; }
        for (const text of link.held.splice(0)) link.ws.send(text);
      }
    },
    // Destroy the link's TCP socket: the connector sees 1006.
    drop(link = fake.link) {
      if (link && link.state !== 'closed') link.ws.terminate();
    },
    close(code = 1001, reason, link = fake.link) {
      closeLink(link, code, reason);
    },
    // Send any frame on the link (the id, seq and at are the fake's).
    send(frame, link = fake.link) { return send(link, frame); },

    find(kind, { dir } = {}) {
      return frames.filter((e) => e.kind === kind && (!dir || e.dir === dir));
    },
    // Resolves with the count-th recorded frame of `kind` (default in-bound).
    waitFor(kind, { dir = 'in', count = 1, timeoutMs = 10000 } = {}) {
      const have = () => fake.find(kind, { dir });
      if (have().length >= count) return Promise.resolve(have()[count - 1]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { watchers.delete(watch); reject(new Error(`fake hub: no ${dir} ${kind} #${count} within ${timeoutMs} ms`)); }, timeoutMs);
        const watch = () => {
          const list = have();
          if (list.length >= count) { clearTimeout(timer); watchers.delete(watch); resolve(list[count - 1]); }
        };
        watchers.add(watch);
      });
    },
    takeErrors(pred = () => true) {
      const taken = [];
      for (let i = errors.length - 1; i >= 0; i--) if (pred(errors[i])) taken.unshift(...errors.splice(i, 1));
      return taken;
    },
    assertClean() {
      if (!errors.length) return;
      const list = errors.map((e) => `${e.dir} ${e.kind || '(unparsed)'}${e.link ? ` (link ${e.link})` : ''}: ${e.message}`);
      throw new Error(`fake hub: ${errors.length} frame(s) failed validation or the protocol:\n  ${list.join('\n  ')}`);
    },
  };
  return fake;
}

// Boot one for a test; t.after stops it and fails the test when any frame the
// fake saw or sent failed validation (naming its kind and the ajv error).
async function withFakeHub(t, opts) {
  const fake = createFakeHub(opts);
  await fake.start();
  t.after(async () => {
    await fake.stop();
    fake.assertClean();
  });
  return fake;
}

module.exports = {
  createFakeHub, withFakeHub, isReservedPort, keyIdOf, fingerprintOf, wireKey, mintLabel,
  SUBPROTOCOL, MAX_PAYLOAD, FRAME_MAX, CHUNK, CREDIT, HUB_REQUEST_TYPES,
};
