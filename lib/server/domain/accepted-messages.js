// The record of accepted client_msg_ids (07 C-07.29): exactly once at the
// daemon. A sender that may repeat a composer message — the connector
// replaying a hub delivery whose ack it never saw — names it with a
// `client_msg_id`; POST /api/queue/message answers a repeat of an id it has
// accepted with the first item's `id` and `msg_id` and `duplicate: true`,
// without enqueueing, and before any other check.
//
// The queue item itself rides draft.json only on a graceful stop, so the ids
// cannot live on the items alone: each accepted id is recorded here, durably,
// BEFORE the route answers ok — the last `max` (1000) in acceptance order, one
// writeJsonAtomic of the whole list per acceptance — and a restart reads them
// back. The file is <project>/.web-chat/queue/accepted-messages.json
// (lib/core/paths projectPaths().acceptedMessages), gitignored with the rest
// of .web-chat/; an older build ignores it (no migration).
//
// Loaded lazily, on the first seen() or record(): absent is empty; a file that
// cannot be read, or reads as the wrong shape, is renamed aside
// (lib/core/fsjson renameAside) and the record starts empty, with one log line
// — never deleted, never a refusal. A write that throws is the CALLER's to
// report: the route then answers ok without echoing the id, which tells the
// connector to keep its own ledger (C-07.29's rule that the echo is the
// signal); the id stays in memory, so this boot still answers its repeat.
//
// `file: null` keeps the record in memory only (a route mounted with no
// project root, as a unit test mounts one).

const { readJson, writeJsonAtomic, renameAside } = require('../../core/fsjson');
// The grammar a client_msg_id must match (07 Q-07.3): the composer's, whose
// badField refuses any other value.
const { CLIENT_MSG_ID_RE } = require('../composer');

const ACCEPTED_MAX = 1000;
const RECORD_VERSION = 1;
// How many renamed-aside copies of a bad record are kept.
const ASIDE_KEEP = 3;

const isClientMsgId = (v) => typeof v === 'string' && CLIENT_MSG_ID_RE.test(v);
const isEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e)
  && isClientMsgId(e.client_msg_id) && typeof e.id === 'string' && typeof e.msg_id === 'string';
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && v.v === RECORD_VERSION && Array.isArray(v.accepted) && v.accepted.every(isEntry);

function createAcceptedMessages({ file = null, max = ACCEPTED_MAX, log = (line) => console.error(line) } = {}) {
  // client_msg_id → {id, msg_id}; a Map keeps insertion (acceptance) order.
  let entries = null;

  function load() {
    if (entries) return entries;
    entries = new Map();
    if (!file) return entries;
    const r = readJson(file, { validate: isRecord });
    if (r.ok) {
      for (const e of r.value.accepted.slice(-max)) entries.set(e.client_msg_id, { id: e.id, msg_id: e.msg_id });
      return entries;
    }
    if (r.absent) return entries;
    let aside = null;
    try { aside = renameAside(file, { tag: r.corrupt ? 'corrupt' : 'invalid', keep: ASIDE_KEEP }); } catch {}
    log(`[web-chat] the accepted-messages record was ${r.corrupt ? 'unreadable' : 'the wrong shape'}`
      + `${aside ? '; renamed aside' : ''}; starting it empty`);
    return entries;
  }

  // The first acceptance of `client_msg_id` — {id, msg_id} — or null.
  function seen(clientMsgId) {
    if (!isClientMsgId(clientMsgId)) return null;
    const hit = load().get(clientMsgId);
    return hit ? { id: hit.id, msg_id: hit.msg_id } : null;
  }

  // Record one acceptance, then write the last `max` through writeJsonAtomic.
  // Throws when the write fails (the entry is kept in memory).
  function record({ client_msg_id, id, msg_id }) {
    if (!isClientMsgId(client_msg_id)) throw new TypeError('client_msg_id does not match its grammar');
    const m = load();
    m.delete(client_msg_id);
    m.set(client_msg_id, { id: String(id), msg_id: String(msg_id) });
    while (m.size > max) m.delete(m.keys().next().value);
    if (!file) return;
    const accepted = [];
    for (const [cid, e] of m) accepted.push({ client_msg_id: cid, id: e.id, msg_id: e.msg_id });
    writeJsonAtomic(file, { v: RECORD_VERSION, accepted });
  }

  return { seen, record };
}

module.exports = { createAcceptedMessages, isClientMsgId, ACCEPTED_MAX };
