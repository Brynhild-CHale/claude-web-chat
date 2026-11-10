'use strict';

// Pairing on the machine (contract 06 C-06.8 over 05's handshake, C-05.1 to
// C-05.3): the foreground half of `claude-web-chat connect <hub>`, never run by
// the service (`connect run` refuses a record that is not paired).
//
// THE ORDER, exactly C-06.8's:
//   1. the hub's origin (lib/setup/connector.js hubOrigin) and the host the
//      connector dials — `new URL(origin).host`, port included, the one string
//      both signed messages carry; one hub per machine (C-06.2): a paired
//      record for another hub refuses before any request is made;
//   2. an Ed25519 key pair IN MEMORY (crypto.generateKeyPairSync);
//   3. the signed start, POST <origin>/connector/pair, through lib/util/outbound
//      (https with verification on; plain http only to a loopback host, the
//      fake hub's — OUTBOUND@tls-on);
//   4. the answer's fingerprint checked against the one computed here, its
//      hub id against the record's grammar;
//   5. the code, the hub, the minutes left and the fingerprint printed ONCE to
//      the terminal (deps.print);
//   6. the record written with credential.state 'pending' (its first write:
//      nothing reaches the disk before the start answer names the hub id);
//   7. the signed long-poll, POST <origin>/connector/pair/poll, one in flight;
//   8. on `bound`, and only then: the private key FIRST (PKCS#8, 0600), then
//      the record 'paired' — both through lib/setup/connector.js
//      writeMachineKey, the one key-file writer, in one critical section.
// expired, refused, a mismatch, an error word or Ctrl-C (deps.signal) before
// `bound` leaves no key and the record 'unpaired' (when this run made it
// pending), and pair() answers { ok: false } for a non-zero exit.
//
// THE SECRETS (C-05.50, C-06.7, C-03.22). The pairing code goes to the
// terminal once and nowhere else: not to a log (pairing logs nothing), not to
// the record, not into a returned message or an error. The private key lives
// in memory until `bound` and then only in its own 0600 file; a proof is sent
// to the hub and kept nowhere. Nothing here puts any of them in an argv or the
// environment.
//
// TIME. The local clock signs the poll's `ts` (C-05.3) and draws the minutes
// left on the screen; no decision is ever taken by comparing a hub timestamp
// with it (07 C-07.31): an expired code is the hub's word, never ours.
//
// The key id and fingerprint are lib/setup/connector.js's (keyIdOf,
// fingerprintOf — the one derivation, U714b), re-exported here unchanged.

const crypto = require('crypto');
const os = require('os');
const timers = require('timers/promises');

const outbound = require('../util/outbound');
const { packageVersion } = require('../core/versions');
const { stripControls } = require('../core/text');
const { isHubId } = require('../core/paths');
const {
  hubOrigin, listRecords, readRecord, updateRecord, newRecord, withDefaults,
  keyIdOf, fingerprintOf, writeMachineKey,
} = require('../setup/connector');

const PAIR_PATH = '/connector/pair';
const POLL_PATH = '/connector/pair/poll';
const PAIR_PROOF_PREFIX = 'web-chat-connector-pair/1';
const POLL_PROOF_PREFIX = 'web-chat-connector-pair-poll/1';

const START_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 35000;      // the hub holds a poll at most 25 s (C-05.3)
const MAX_BYTES = 64 * 1024;
const HINT_MAX = 500;               // 05-pairing.json's hint maxLength
const POLL_AFTER_MAX_MS = 30000;    // 05-pairing.json's poll_after_ms maximum
const POLL_FLOOR_MS = 200;          // a pending answered at once never makes a tight loop
const RETRY_AFTER_MAX_S = 30;       // the longest a poll waits on a 429 before asking again
const TRANSIENT_TRIES = 5;          // network errors and 503s in a row before giving up
const PLATFORMS = Object.freeze(['darwin', 'linux']); // 05-pairing.json's enum

const PAIRING_ID_RE = /^pr_[0-9a-hjkmnp-tv-z]{26}$/;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MACHINE_ID_RE = /^mch_[0-9a-hjkmnp-tv-z]{26}$/;
const KEY_ID_RE = /^mky_[0-9a-hjkmnp-tv-z]{26}$/;
const CONNECT_URL_RE = /^wss:\/\/[a-z0-9.-]+(:[0-9]{1,5})?\/connector$/;

const defaultPrint = (line) => { process.stdout.write(`${line}\n`); };

// A hub's hint, as words for the terminal: controls, bidi and invisibles out,
// at most 500 characters — never a body dump.
function hintOf(json) {
  const h = json && typeof json.hint === 'string' ? stripControls(json.hint).trim() : '';
  return h ? h.slice(0, HINT_MAX) : '';
}

// The error word a refusal names, when it names one the shape of a word.
function wordOf(json) {
  const w = json && typeof json.error === 'string' ? json.error : '';
  return /^[a-z_]{1,40}$/.test(w) ? w : '';
}

function abortError() {
  const e = new Error('pairing cancelled');
  e.name = 'AbortError';
  return e;
}
const isAbort = (e) => !!e && e.name === 'AbortError';

// `promise`, or an AbortError the moment `signal` fires. The request itself
// is handed the signal too; whatever it settles to after an abort is dropped.
function abortable(promise, signal) {
  if (!signal) return promise;
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function sleep(ms, signal) {
  if (signal && signal.aborted) throw abortError();
  try {
    await timers.setTimeout(Math.max(0, ms), undefined, signal ? { signal } : undefined);
  } catch (e) {
    if (isAbort(e) || (e && e.code === 'ABORT_ERR')) throw abortError();
    throw e;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(privateKey, text) {
  return b64url(crypto.sign(null, Buffer.from(text, 'utf8'), privateKey));
}

// The minutes left, for the screen only (display, never a decision).
function minutesLeft(expiresAt, now) {
  if (!Number.isFinite(expiresAt)) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 60000));
}

function retryAfterOf(res) {
  const j = res && res.json;
  if (j && Number.isInteger(j.retry_after_s) && j.retry_after_s >= 1) return j.retry_after_s;
  const h = res && res.headers && res.headers['retry-after'];
  const n = Number.parseInt(h, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function waitWords(seconds) {
  if (seconds < 120) return `${seconds} s`;
  return `about ${Math.ceil(seconds / 60)} minutes`;
}

// The paired records, split by whether they name this hub (by its origin
// before the start answers, by its id after). A record that cannot be read is
// not paired.
function pairedRecords({ origin, hubId }) {
  const out = { here: null, elsewhere: null };
  for (const r of listRecords()) {
    if (!r.read.ok) continue;
    const rec = r.read.value;
    if (rec.credential.state !== 'paired') continue;
    const same = hubId != null ? r.hubId === hubId : rec.hub.origin === origin;
    if (same) out.here = out.here || rec;
    else out.elsewhere = out.elsewhere || rec;
  }
  return out;
}

// pair({hubUrl, workdir, rePair, deps}) → { ok, state, hubId, reason?, message?,
// machineId?, keyId? }. ok false is a non-zero exit for the caller; every line
// the person needs has already gone through deps.print. `state` is the
// record's credential state as this run leaves it (null when no record was
// written). deps: request (lib/util/outbound's), print (the terminal), now
// (epoch ms), signal (an AbortSignal: the CLI wires SIGINT to it),
// insecureLoopback (tests and the fake only), platform, hostname.
async function pair({ hubUrl, workdir, rePair = false, deps = {} } = {}) {
  const d = {
    request: outbound.request,
    print: defaultPrint,
    now: Date.now,
    signal: null,
    insecureLoopback: false,
    platform: process.platform,
    hostname: () => os.hostname(),
    ...deps,
  };
  const say = (line) => d.print(line);
  let hubId = null;
  let state = null;
  let pendingKey = null;   // the public key this run wrote as pending, if it did

  const fail = (reason, message) => {
    say(message);
    return { ok: false, state, hubId, reason, message };
  };

  // Back to unpaired, only for the pending record this run wrote (a paired
  // record a re-pair left alone, or someone else's pending, stays as it is).
  const revert = () => {
    if (!pendingKey) return;
    try {
      const after = updateRecord(hubId, (cur) => {
        if (!cur || cur.credential.state !== 'pending' || cur.credential.public_key !== pendingKey) return null;
        return { ...cur, credential: { state: 'unpaired' } };
      });
      state = after ? after.credential.state : null;
    } catch {
      // The record could not be rewritten: no key was written either, and the
      // next `connect` pairs over a pending record as over an unpaired one.
    }
  };
  const again = (origin) => `run \`claude-web-chat connect ${origin}\` again`;

  // (1) the origin, the host, one hub per machine, the platform.
  let origin;
  try {
    origin = hubOrigin(hubUrl, { insecureLoopback: !!d.insecureLoopback });
  } catch (e) {
    return fail('bad_origin', `Cannot pair: ${e.code === 'EHUBORIGIN' ? e.message : 'that is not a hub address'}.`);
  }
  const host = new URL(origin).host;
  const before = pairedRecords({ origin });
  if (before.elsewhere) {
    return fail('other_hub', `This machine is already paired with ${before.elsewhere.hub.origin}; run \`claude-web-chat connect disconnect\` first.`);
  }
  if (before.here && !rePair) {
    return fail('already_paired', `This machine is already paired with ${origin}; pass --re-pair to pair it again.`);
  }
  if (!PLATFORMS.includes(d.platform)) {
    return fail('platform', `Cannot pair: the connector runs on macOS and Linux, not ${stripControls(String(d.platform)).slice(0, 40)}.`);
  }
  if (d.signal && d.signal.aborted) return fail('aborted', 'Pairing cancelled; nothing was saved.');

  // (2) the key, in memory only.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicWire = publicKey.export({ format: 'jwk' }).x;
  const raw = Buffer.from(publicWire, 'base64url');
  const fingerprint = fingerprintOf(raw);
  const keyId = keyIdOf(raw);
  const clientNonce = b64url(crypto.randomBytes(32));

  // (3) the signed start.
  const hostname = stripControls(String(d.hostname() || '')).slice(0, 253);
  const startBody = {
    v: 1,
    public_key: publicWire,
    client_nonce: clientNonce,
    proof: sign(privateKey, `${PAIR_PROOF_PREFIX}\n${host}\n${clientNonce}`),
    connector: { hostname, platform: d.platform, package_version: packageVersion() },
  };
  let res;
  try {
    res = await abortable(d.request(`${origin}${PAIR_PATH}`, {
      method: 'POST', body: startBody, timeoutMs: START_TIMEOUT_MS, maxBytes: MAX_BYTES, signal: d.signal || undefined,
    }), d.signal);
  } catch (e) {
    if (isAbort(e)) return fail('aborted', 'Pairing cancelled; nothing was saved.');
    return fail('unreachable', `Cannot reach ${origin}: ${stripControls(String(e && e.message)).slice(0, HINT_MAX)}.`);
  }
  if (res.status === 429) {
    const wait = retryAfterOf(res);
    const word = wordOf(res.json) || 'rate_limited';
    return fail(word, `The hub is turning pairing requests away (${word}): wait ${wait ? waitWords(wait) : 'a while'}, then ${again(origin)}.`);
  }
  const start = res.json;
  if (res.status !== 200 || !start || start.ok !== true) {
    const word = wordOf(start) || `http_${res.status}`;
    const hint = hintOf(start);
    return fail(word, `The hub refused to start pairing (${word})${hint ? `: ${hint}` : '.'}`);
  }

  // (4) the answer: its shape, its fingerprint, its hub id.
  if (typeof start.pairing_id !== 'string' || !PAIRING_ID_RE.test(start.pairing_id)
    || typeof start.code !== 'string' || !CODE_RE.test(start.code)
    || typeof start.fingerprint !== 'string' || !FINGERPRINT_RE.test(start.fingerprint)
    || !Number.isInteger(start.expires_at)) {
    return fail('bad_answer', 'The hub\'s answer to the pairing start is not the protocol\'s; nothing was saved.');
  }
  if (start.fingerprint !== fingerprint) {
    return fail('fingerprint_mismatch', `The hub reports a key fingerprint that is not this machine's (${fingerprint}); nothing was saved.`);
  }
  if (typeof start.hub_id !== 'string' || !isHubId(start.hub_id)) {
    return fail('bad_answer', 'The hub named itself with an id this machine cannot use; nothing was saved.');
  }
  hubId = start.hub_id;
  const other = pairedRecords({ hubId }).elsewhere;
  if (other) {
    return fail('other_hub', `This machine is already paired with ${other.hub.origin}; run \`claude-web-chat connect disconnect\` first.`);
  }
  const existing = readRecord(hubId);
  if (existing.corrupt || existing.invalid) {
    return fail('record', `The connector record for ${hubId} is ${existing.corrupt ? 'unreadable' : 'not the record\'s shape'}; move it aside and ${again(origin)}.`);
  }
  const wasPaired = !!(existing.ok && existing.value.credential.state === 'paired');
  if (wasPaired && !rePair) {
    state = 'paired';
    return fail('already_paired', `This machine is already paired with ${existing.value.hub.origin}; pass --re-pair to pair it again.`);
  }
  const pollAfter = Math.min(POLL_AFTER_MAX_MS, Number.isInteger(start.poll_after_ms) && start.poll_after_ms >= 0 ? start.poll_after_ms : 1000);

  // (5) the code, once, to the terminal.
  const left = minutesLeft(start.expires_at, d.now());
  say(`Pairing this machine with ${origin}.`);
  say(`Enter this code on the hub, in Settings > Machines: ${start.code}`);
  if (left != null) say(`The code works once and expires in about ${left} minute${left === 1 ? '' : 's'}.`);
  say(`Confirm that the hub shows this machine's key fingerprint: ${fingerprint}`);
  say('Waiting for the hub to confirm (Ctrl-C cancels)...');

  // (6) the record, pending — or, for a re-pair of a paired record, left as
  // it is: the working key and its record stay until `bound` replaces both.
  if (!wasPaired) {
    try {
      const rec = updateRecord(hubId, (cur) => {
        const base = cur ? withDefaults(cur) : newRecord({ hubId, origin, workdir });
        return {
          ...base,
          hub: { ...base.hub, origin },
          credential: { state: 'pending', algorithm: 'ed25519', public_key: publicWire, fingerprint },
        };
      });
      pendingKey = publicWire;
      state = rec.credential.state;
    } catch (e) {
      return fail('record', `Cannot write the connector record for ${hubId}${e && e.code === 'ERECORD' ? ` (it is ${e.state})` : ''}; ${again(origin)}.`);
    }
  } else {
    state = 'paired';
  }

  // (7) the signed long-poll, one in flight.
  const failAfterPending = (reason, message) => { revert(); return fail(reason, message); };
  let bound = null;
  let transient = 0;
  let gap = pollAfter;
  try {
    for (;;) {
      await sleep(gap, d.signal);
      const ts = d.now();
      const body = {
        v: 1,
        pairing_id: start.pairing_id,
        ts,
        proof: sign(privateKey, `${POLL_PROOF_PREFIX}\n${host}\n${start.pairing_id}\n${ts}`),
      };
      const began = Date.now();
      let r;
      try {
        r = await abortable(d.request(`${origin}${POLL_PATH}`, {
          method: 'POST', body, timeoutMs: POLL_TIMEOUT_MS, maxBytes: MAX_BYTES, signal: d.signal || undefined,
        }), d.signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        if (++transient >= TRANSIENT_TRIES) {
          return failAfterPending('unreachable', `Lost the hub at ${origin} while waiting: ${stripControls(String(e && e.message)).slice(0, HINT_MAX)}; ${again(origin)}.`);
        }
        gap = Math.max(pollAfter, 1000);
        continue;
      }
      const j = r.json;
      if (r.status === 200 && j && j.state === 'pending') {
        transient = 0;
        gap = Math.max(0, Math.max(pollAfter, POLL_FLOOR_MS) - (Date.now() - began));
        continue;
      }
      if (r.status === 200 && j && j.state === 'bound') { bound = j; break; }
      if (r.status === 200 && j && (j.state === 'expired' || j.state === 'refused')) {
        const hint = hintOf(j);
        const what = j.state === 'expired' ? 'The pairing code expired unused' : 'The pairing was declined on the hub';
        return failAfterPending(j.state, `${what}; ${again(origin)}.${hint ? ` ${hint}` : ''}`);
      }
      const word = wordOf(j);
      if (word === 'clock_skew') {
        return failAfterPending('clock_skew', `The hub refused the wait because this machine's clock is more than two minutes off: set this machine's clock, then ${again(origin)}.`);
      }
      if (r.status === 429) {
        if (++transient >= TRANSIENT_TRIES) {
          return failAfterPending(word || 'rate_limited', `The hub keeps turning the wait away (${word || 'rate_limited'}); ${again(origin)}.`);
        }
        gap = Math.min(RETRY_AFTER_MAX_S, retryAfterOf(r) || 1) * 1000;
        continue;
      }
      if (r.status === 503 || word === 'unavailable') {
        if (++transient >= TRANSIENT_TRIES) {
          const hint = hintOf(j);
          return failAfterPending('unavailable', `The hub is unavailable; ${again(origin)}.${hint ? ` ${hint}` : ''}`);
        }
        gap = Math.max(pollAfter, 1000);
        continue;
      }
      const hint = hintOf(j);
      const named = word || (r.status === 200 ? 'bad_answer' : `http_${r.status}`);
      return failAfterPending(named, `The hub refused the wait (${named}); ${again(origin)}.${hint ? ` ${hint}` : ''}`);
    }
  } catch (e) {
    if (isAbort(e)) return failAfterPending('aborted', 'Pairing cancelled; no key was saved.');
    throw e;
  }

  // (8) bound: check every field against what this machine knows, then the
  // key first, then the record.
  if (typeof bound.machine_id !== 'string' || !MACHINE_ID_RE.test(bound.machine_id)
    || typeof bound.machine_name !== 'string' || [...bound.machine_name].length > 120
    || typeof bound.key_id !== 'string' || !KEY_ID_RE.test(bound.key_id)
    || typeof bound.connect_url !== 'string' || !CONNECT_URL_RE.test(bound.connect_url)) {
    return failAfterPending('bad_answer', `The hub's confirmation is not the protocol's; no key was saved; ${again(origin)}.`);
  }
  if (bound.key_id !== keyId) {
    return failAfterPending('key_id_mismatch', `The hub bound a key id that is not this machine's key; no key was saved; ${again(origin)}.`);
  }
  if (bound.hub_id !== hubId) {
    return failAfterPending('hub_id_mismatch', `The hub's confirmation names another hub; no key was saved; ${again(origin)}.`);
  }
  if (new URL(bound.connect_url).host !== host) {
    return failAfterPending('connect_url_mismatch', `The hub's confirmation points the machine at another host than ${host}; no key was saved; ${again(origin)}.`);
  }

  // The key and its record in one critical section, through the ONE key-file
  // writer (lib/setup/connector.js writeMachineKey, K.2-312): the key at 0600
  // first, then the record; a failed record write puts the previous key back
  // (a re-pair's working key) or removes the new one.
  const machineName = stripControls(bound.machine_name).slice(0, 120);
  try {
    const rec = writeMachineKey({
      hubId,
      pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      keyId,
      publicKey: publicWire,
      fingerprint,
      update: (cur) => {
        const base = cur ? withDefaults(cur) : newRecord({ hubId, origin, workdir });
        return {
          ...base,
          hub: { ...base.hub, origin },
          machine: { id: bound.machine_id, name: machineName },
          credential: { state: 'paired', algorithm: 'ed25519', paired_at: d.now() },
        };
      },
    });
    state = rec.credential.state;
  } catch (e) {
    if (e && e.step === 'key') {
      return failAfterPending('key_write', `Cannot write the machine key (${stripControls(String(e && e.code || 'error'))}); ${again(origin)}.`);
    }
    return failAfterPending('record', `Paired on the hub, but the connector record for ${hubId} could not be written${e && e.code === 'ERECORD' ? ` (it is ${e.state})` : ''}; ${again(origin)}.`);
  }
  say(`Paired with ${origin} as "${machineName}" (${keyId}).`);
  return { ok: true, state, hubId, machineId: bound.machine_id, keyId };
}

module.exports = {
  pair,
  keyIdOf,
  fingerprintOf,
  PAIR_PROOF_PREFIX,
  POLL_PROOF_PREFIX,
  START_TIMEOUT_MS,
  POLL_TIMEOUT_MS,
  PLATFORMS,
};
