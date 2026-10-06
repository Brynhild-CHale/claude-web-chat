// The one home of the chat mirror's route-query parsers and its JSON route
// (spec §2.10): what routes/mirror-content.js, mirror-tasks.js and
// mirror-code.js share, so each module keeps only its own routes. Before this
// module each carried its own copy (their briefs let them require nothing but
// ./mirror); a parser or a bound rule changed here changes for every mirror
// route at once.
//
// THIN, as the route modules are: it requires only ./mirror — never fs,
// lib/core/claude-files or lib/server/domain/refs — and opens, fences,
// resolves and redacts nothing (§2.9's read boundary; the thin-module scans in
// test/mirror-routes-content.test.js and test/mirror-routes-work.test.js hold
// it to that).
//
// Parsing a query:
//   param(query, name, parse, dflt)  one parameter, read as given: absent →
//                                    `dflt`; present, a single string `parse`
//                                    accepts, else BadParam `<name>: <expects>`
//   intIn(min, max)                  an integer in [min, max], digits only
//   finiteAtLeastZero()              a finite number ≥ 0 (an item seq may be
//                                    fractional), digits and one point only
//   oneOf(words)                     one of the words, exactly
//   notBoth(query, a, b, why)        two parameters that exclude each other
//   idParam(query, name)             an id or ref in the query: a non-empty
//                                    single string, as given; over ID_MAX is
//                                    NotFound (404, as a path id is)
//   idOk(id)                         a path id of 1..ID_MAX characters
//   pick(v, keys)                    the facade's answer cut to `keys`
//
// jsonRoute({app, gate, ctx, readyWaitMs}, route, spec) mounts one GET: the
// ids validated (404) and the query parsed (BadParam → 400, NotFound → 404)
// before anything waits; then the wait for the mirror (mirrorFor), the
// status's rev read BEFORE the dispatched call (unless `ownRev`: the answer
// carries its own), the call; null is 404, `unavailable` 503, any other
// non-object or a throw a failure (sendFailure, which never sends the error's
// message). The body is the answer cut to `keys` — an array, or a function of
// the parsed query for a route whose shape depends on it — plus `rev`.

const { mirrorFor, isUnavailable, sendUnavailable, sendFailure, READY_WAIT_MS } = require('./mirror');

// A path id (or a query id/ref) longer than this names nothing the mirror holds.
const ID_MAX = 128;

// Digits only: no sign, exponent, hex, space or empty string slips through
// Number()'s leniency.
const INT_RE = /^\d{1,16}$/;
const NUM_RE = /^\d{1,16}(?:\.\d{1,16})?$/;

const NOT_FOUND = Object.freeze({ ok: false, error: 'not found' });

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A parameter that failed validation (400), or one too long to name anything (404).
class BadParam extends Error {}
class NotFound extends Error {}

// One query parameter, read as given: absent → `dflt`; present, it must be a
// single string `parse` accepts (an empty one, a repeat, a bracketed list or
// object never is).
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

// Two parameters that exclude each other: present together is 400.
function notBoth(query, a, b, why) {
  if (query[a] !== undefined && query[b] !== undefined) throw new BadParam(`${a}: not with ${b} (${why})`);
}

// An id or ref in the query: a non-empty single string, passed through as
// given; one over ID_MAX characters is 404, as a path id is.
function idParam(query, name) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '') throw new BadParam(`${name}: an id`);
  if (raw.length > ID_MAX) throw new NotFound(name);
  return raw;
}

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

const revOf = (v) => (Number.isFinite(v.rev) ? v.rev : null);

// One JSON mirror route on `app`, behind `gate`. `spec`: `ids` the path
// parameters that must be ids, `query(q)` the parsed arguments (it may throw
// BadParam or NotFound), `call(mirror, params, args)` the facade's answer,
// `keys` the body's keys (or `(args) => keys`), `ownRev` to take `rev` from the
// answer rather than from status().
function jsonRoute({ app, gate, ctx, readyWaitMs = READY_WAIT_MS }, route,
  { ids = [], query = () => null, call, keys, ownRev = false }) {
  const opts = { readyWaitMs };
  app.get(route, gate, async (req, res) => {
    let args;
    try {
      if (!ids.every((name) => idOk(req.params[name]))) return res.status(404).json(NOT_FOUND);
      args = query(req.query || {});
    } catch (e) {
      if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
      if (e instanceof NotFound) return res.status(404).json(NOT_FOUND);
      return sendFailure(res, e, `GET ${route}`);
    }
    try {
      const mirror = await mirrorFor(ctx, res, opts);
      if (!mirror) return undefined;
      let rev = null;
      if (!ownRev) {
        const status = await mirror.status();
        if (isUnavailable(status)) return sendUnavailable(res);
        if (!isPlain(status)) throw new TypeError('the mirror\'s status is not an object');
        rev = revOf(status);
      }
      const body = await call(mirror, req.params, args);
      if (body === null || body === undefined) return res.status(404).json(NOT_FOUND);
      if (isUnavailable(body)) return sendUnavailable(res);
      if (!isPlain(body)) throw new TypeError('the mirror\'s answer is not an object');
      const cut = typeof keys === 'function' ? keys(args) : keys;
      return res.json({ ...pick(body, cut), rev: ownRev ? revOf(body) : rev });
    } catch (e) {
      return sendFailure(res, e, `GET ${route}`);
    }
  });
}

module.exports = {
  ID_MAX,
  INT_RE,
  NUM_RE,
  NOT_FOUND,
  isPlain,
  BadParam,
  NotFound,
  param,
  intIn,
  finiteAtLeastZero,
  oneOf,
  notBoth,
  idParam,
  idOk,
  pick,
  jsonRoute,
};
