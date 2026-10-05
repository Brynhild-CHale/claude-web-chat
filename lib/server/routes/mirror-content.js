// The chat mirror's content over HTTP (spec §2.10, "Content"): a conversation's
// turns, one turn with its items, one item's field paged, and an attachment's
// bytes. The chrome reads these when it opens a conversation, scrolls back,
// expands a tool call or shows an image a prompt carried.
//
//   GET /api/mirror/conversations/:cid/turns[?before=&limit=&items=]
//     {conversation_id, turns: [Turn (+ items)], next_before, total, rev}: the
//     newest page before `before`, ascending within it. `before` a turn's seq
//     (a finite number ≥ 0; absent, the newest page), `limit` an integer 1..50
//     (default 20), `items` 'none' | 'summary' | 'full' (default 'summary',
//     ruled 2026-10-04): each turn's items at that level. Pass `next_before`
//     back as `before` for the page above; null when there is none.
//   GET /api/mirror/turns/:turnId
//     {turn, items: [Item, full caps], rev}
//   GET /api/mirror/items/:itemId[?field=&from=&max=]
//     {id, field, text, from, to, total, eof}: `field` 'text' | 'input' |
//     'result' (default 'text'), `from` an integer ≥ 0 (default 0), `max` an
//     integer 1..262144 (default 262144). `to` is where the next page starts:
//     pass it back as `from` and no line is lost (the source answers the
//     window's `next`, lib/core/claude-files readWindow).
//   GET /api/mirror/items/:itemId/attachments/:n
//     the bytes of the item's n-th attachment (n an integer ≥ 0), sent only for
//     image/png, image/jpeg, image/gif, image/webp or application/pdf and at
//     most ATTACHMENT_MAX_BYTES (6 MiB − 48 KiB), with nosniff, a CSP that
//     runs nothing (`default-src 'none'; sandbox`), same-origin CORP and
//     no-cache. Any other type, or a larger or
//     non-binary body, is 404: nothing else is ever served as an attachment.
//
// Every route sits behind the audience's gate at `read` (ctx.audience
// requireMirror('read'), §5.4): a remote viewer whose project has not opted in,
// and every network peer, gets its 403 and hint. The portal's table refuses
// them first (lib/core/remote-policy, `GET /api/mirror/*` at `read`); this is
// the daemon's second lock, and the only one for a network peer. They are P0
// read-open (§5.7): GETs only, readable by any same-origin script, protected by
// redaction and, remotely, by level.
//
// THIN, as routes/mirror.js is. Each route validates its parameters and calls
// the facade (ctx.mirror: turns, turn, itemField, attachment — Promises that
// answer {unavailable: true} until the transcripts source registers, §2.12).
// Every file read, fence and redaction is the transcripts source's and the
// facade's (§2.9's read boundary): this module requires neither fs nor
// lib/core/claude-files, and opens, fences and redacts nothing. A body is the
// facade's answer cut to §2.10's keys — a key the facade adds is not passed on,
// so no path a source might put beside its answer leaves here — plus `rev`.
//
// `rev` is ctx.mirror.status().rev read BEFORE the dispatched call: a frame
// emitted while the read ran carries a newer rev, and the chrome re-applies any
// frame newer than the body it holds, so nothing between the two is missed.
//
// The answers every mirror route shares come from routes/mirror.js (mirrorFor,
// isUnavailable, sendUnavailable, sendFailure): the wait on `mirror.ready` (at
// most READY_WAIT_MS), the disabled 200 with its hint, the 503 for a source not
// registered yet (an `{unavailable: true}` answer or a rejection coded
// 'unavailable'), and the 500 that never carries the error's message. Besides
// those:
//   400 {ok:false, error}           a malformed or out-of-range parameter
//   404 {ok:false, error:'not found'} an id over ID_MAX characters, a source
//                                   that answered null, or an attachment this
//                                   route will not serve
//
// Mounted by lib/server/index.js (tranche 2's integration, U40); a route test
// mounts it on a bare Express app with a fake ctx.mirror and ctx.audience.

const { mirrorFor, isUnavailable, sendUnavailable, sendFailure, READY_WAIT_MS } = require('./mirror');

// A path id longer than this names nothing the mirror holds.
const ID_MAX = 128;
// GET …/turns: the page size.
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
// GET /api/mirror/items/:itemId: the longest page of a field.
const FIELD_MAX = 262144;
// GET …/attachments/:n: the largest attachment sent — the transcripts source's
// own limit, 6 MiB − 48 KiB (ruled U28b@attachment-limit: what one transcript
// line can carry and readWindow re-read whole) — and the types that are. Spelled
// here, not required (this module requires only ./mirror); test/mirror-
// transcripts.test.js pins it equal to lib/server/mirror/transcripts.js's.
const ATTACHMENT_MAX_BYTES = 6242304;
const ATTACHMENT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

const ITEMS = Object.freeze(['none', 'summary', 'full']);
const FIELDS = Object.freeze(['text', 'input', 'result']);

// The keys of each body (§2.10), `rev` stamped by the route.
const TURNS_KEYS = Object.freeze(['conversation_id', 'turns', 'next_before', 'total']);
const TURN_KEYS = Object.freeze(['turn', 'items']);
const FIELD_KEYS = Object.freeze(['id', 'field', 'text', 'from', 'to', 'total', 'eof']);

// The headers an attachment is sent with: never sniffed, never run (the CSP
// sandboxes a PDF viewer's document too), never read cross-origin, and
// revalidated each time.
const ATTACHMENT_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
});

// Digits only: no sign, exponent, hex, space or empty string slips through
// Number()'s leniency.
const INT_RE = /^\d{1,16}$/;
const NUM_RE = /^\d{1,16}(?:\.\d{1,16})?$/;

const NOT_FOUND = Object.freeze({ ok: false, error: 'not found' });

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A parameter that failed validation; answered 400 with its message.
class BadParam extends Error {}

// One query parameter, read as given: absent → `dflt`; present, it must be a
// single string `parse` accepts.
function param(query, name, parse, dflt) {
  const raw = query[name];
  if (raw === undefined) return dflt;
  const v = typeof raw === 'string' ? parse(raw) : undefined;
  if (v === undefined) throw new BadParam(`${name}: ${parse.expects}`);
  return v;
}

function intIn(min, max) {
  const parse = (raw) => {
    if (!INT_RE.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  };
  parse.expects = max === Number.MAX_SAFE_INTEGER
    ? `an integer ≥ ${min}` : `an integer from ${min} to ${max}`;
  return parse;
}

function finiteAtLeastZero() {
  const parse = (raw) => {
    if (!NUM_RE.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  parse.expects = 'a finite number ≥ 0';
  return parse;
}

function oneOf(words) {
  const parse = (raw) => (words.includes(raw) ? raw : undefined);
  parse.expects = `one of ${words.join(', ')}`;
  return parse;
}

const BEFORE = finiteAtLeastZero();
const LIMIT = intIn(1, LIMIT_MAX);
const FROM = intIn(0, Number.MAX_SAFE_INTEGER);
const MAX = intIn(1, FIELD_MAX);
const NTH = intIn(0, Number.MAX_SAFE_INTEGER);
const ITEMS_LEVEL = oneOf(ITEMS);
const FIELD = oneOf(FIELDS);

// A path id is passed through as given; one too long to be an id is 404.
function idOk(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= ID_MAX;
}

// The facade's answer cut to `keys`.
function pick(v, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k];
  return out;
}

// An attachment's bytes as a Buffer, or null when they are not bytes.
function bytesOf(b) {
  if (Buffer.isBuffer(b)) return b;
  if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  return null;
}

function mountMirrorContentRoutes(app, ctx, { readyWaitMs = READY_WAIT_MS } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    // Fail at boot rather than serve the conversation with no gate in front of it.
    throw new TypeError('mountMirrorContentRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const gate = audience.requireMirror('read');
  const opts = { readyWaitMs };

  // A JSON content route: validate (400 / 404 before anything waits), wait for
  // the mirror, read the status's rev, then the dispatched call; null is 404,
  // `unavailable` 503, any other non-object a failure.
  function jsonRoute(route, { ids, query, call, keys }) {
    app.get(route, gate, async (req, res) => {
      let args;
      try {
        if (!ids.every((name) => idOk(req.params[name]))) return res.status(404).json(NOT_FOUND);
        args = query(req.query || {});
      } catch (e) {
        if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
        return sendFailure(res, e, `GET ${route}`);
      }
      try {
        const mirror = await mirrorFor(ctx, res, opts);
        if (!mirror) return undefined;
        const status = await mirror.status();
        if (isUnavailable(status)) return sendUnavailable(res);
        if (!isPlain(status)) throw new TypeError('the mirror\'s status is not an object');
        const rev = Number.isFinite(status.rev) ? status.rev : null;
        const body = await call(mirror, req.params, args);
        if (body === null || body === undefined) return res.status(404).json(NOT_FOUND);
        if (isUnavailable(body)) return sendUnavailable(res);
        if (!isPlain(body)) throw new TypeError('the mirror\'s answer is not an object');
        return res.json({ ...pick(body, keys), rev });
      } catch (e) {
        return sendFailure(res, e, `GET ${route}`);
      }
    });
  }

  jsonRoute('/api/mirror/conversations/:cid/turns', {
    ids: ['cid'],
    query: (q) => ({
      before: param(q, 'before', BEFORE, null),
      limit: param(q, 'limit', LIMIT, LIMIT_DEFAULT),
      items: param(q, 'items', ITEMS_LEVEL, 'summary'),
    }),
    call: (mirror, p, args) => mirror.turns(p.cid, args),
    keys: TURNS_KEYS,
  });

  jsonRoute('/api/mirror/turns/:turnId', {
    ids: ['turnId'],
    query: () => null,
    call: (mirror, p) => mirror.turn(p.turnId),
    keys: TURN_KEYS,
  });

  jsonRoute('/api/mirror/items/:itemId', {
    ids: ['itemId'],
    query: (q) => ({
      field: param(q, 'field', FIELD, 'text'),
      from: param(q, 'from', FROM, 0),
      max: param(q, 'max', MAX, FIELD_MAX),
    }),
    call: (mirror, p, args) => mirror.itemField(p.itemId, args),
    keys: FIELD_KEYS,
  });

  const ATTACHMENT_ROUTE = '/api/mirror/items/:itemId/attachments/:n';
  app.get(ATTACHMENT_ROUTE, gate, async (req, res) => {
    if (!idOk(req.params.itemId)) return res.status(404).json(NOT_FOUND);
    const n = NTH(req.params.n);
    if (n === undefined) return res.status(400).json({ ok: false, error: `n: ${NTH.expects}` });
    try {
      const mirror = await mirrorFor(ctx, res, opts);
      if (!mirror) return undefined;
      const a = await mirror.attachment(req.params.itemId, n);
      if (a === null || a === undefined) return res.status(404).json(NOT_FOUND);
      if (isUnavailable(a)) return sendUnavailable(res);
      if (!isPlain(a)) throw new TypeError('the mirror\'s attachment is not an object');
      const type = typeof a.media_type === 'string' ? a.media_type : '';
      const bytes = bytesOf(a.bytes);
      if (!ATTACHMENT_TYPES.includes(type) || !bytes || bytes.length > ATTACHMENT_MAX_BYTES) {
        return res.status(404).json(NOT_FOUND);
      }
      res.status(200);
      res.set({ 'Content-Type': type, 'Content-Length': String(bytes.length), ...ATTACHMENT_HEADERS });
      return res.end(bytes);
    } catch (e) {
      return sendFailure(res, e, `GET ${ATTACHMENT_ROUTE}`);
    }
  });
}

module.exports = {
  mountMirrorContentRoutes,
  ID_MAX,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  FIELD_MAX,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENT_HEADERS,
};
