'use strict';
// The search add-on (annotation engine 4E.1, U551; DECISIONS A2, A4, J3).
//
//   GET /api/elements/search?q=&type=&limit=
//
// A FILTER over each element's LATEST version in the element log, computed per
// request (RULED SEARCH@latest (a)): no index, no cache that outlives the
// request, and never a read of a node's copy. Under C1's branch scope the
// log's latest is not always the version visible from the active node
// (domain/element-scope); that difference is accepted — it is the safe
// reading: an element made private since a node committed its shared copy is
// private here (X-14). A `node` parameter (or v, versions, all) answers 400:
// this route refuses to be an all-copies index; GET /api/elements?node= reads
// one node.
//
// THE CORPUS. Every id the log holds, its type resolved by the element
// routes' own resolver (ctx.elementGates, published by mountElementRoutes —
// the one home of a type's {type, gate, schema}; never a second copy here):
// a type the request may not see (its gate's `see`, or the one ?type=) is
// left out, a chat-family element the log has dropped is left out, and for a
// reader that does not see private records (audience.seesPrivate: only a
// local browser does — never lib/client, Claude's tools, a remote viewer or a
// network peer) a private element (latest version shared === false) is left
// out BEFORE matching, counting and the limit, so it neither appears nor uses
// up the limit nor sets `truncated` (C-16-2: no probe).
//
// THE MATCH. Case-insensitive substring (NFC, lower case on both sides) over
// the record's MASKED text only (domain/elements record(): text masked at read
// through the log's views), never raw bytes, so a masked value never matches
// its raw text. Fields, in order: every top-level string of the schema's keys
// but anchor and shared (a comment's text, a highlight's note, a plug-in
// type's declared strings), each reply's text, then the anchor's label
// (routes/elements describeAnchor). The first that matches is the hit's
// `field` (the key, 'replies' or 'anchor').
//
// THE BODY: {hits, truncated}, newest first (seq descending, then id), cut to
// `limit` (default 50, at most 200). Each hit:
//   {id, type, family, v, seq, created_at, shared, anchor_label, field,
//    snippet, live, home}
// `snippet` is at most SNIPPET_MAX characters of the matched field's masked
// text around the first match ('…' where cut). `live`: on the live surface now
// (a comment in state.comments; another page type by its reference; a chat
// element while undropped). `home`: the stored id of the node that first
// committed that version, or null. No chain, record, anchor object, writer or
// provenance rides a hit.
//
// WHO. FLOOR.see (read) first: basic — no opt-in, and every network peer — is
// refused 403 before anything is read. The body passes dropPrivate
// (PRIVATE_RULES.routes) for anyone who does not see private records, and
// stripText (TEXT_RULES.routes) below read (unreachable behind the gate, kept
// so the tables and the route agree). The route never asks the chat mirror, never
// writes, stamps nothing and grants nothing on a writer class (C-15-1..3).

const elementLog = require('../../core/element-log');
const { FLOOR } = require('../../core/element-policy');
const { dropPrivate, stripText } = require('../../core/remote-policy');
const { hasForbidden } = require('../../core/text');
const { refOf } = require('../domain/element-refs');
const { describeAnchor } = require('./elements');
const { param, intIn, BadParam } = require('./mirror-query');

const Q_MAX = 256;
const TYPE_MAX = 64;
const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;
const SNIPPET_MAX = 160;
const ELLIPSIS = '…';
// The parameters an all-copies read would take; each answers 400.
const COPY_PARAMS = Object.freeze(['node', 'v', 'versions', 'all']);
const COPY_HINT = 'search reads each element\'s latest version; GET /api/elements?node=<stored id> reads one node';
const TYPE_HINT = 'an element type is a built-in or one an approved element pack lists (GET /api/elements/types)';
const NOT_MOUNTED = 'the element routes are not mounted';
// The family whose elements are one line of versions in the log alone
// (domain/elements familyOf): live while the log has not dropped them.
const CHAT_FAMILY = 'chat';
// The schema keys that are never searched as text.
const NOT_TEXT = new Set(['anchor', 'shared', 'replies']);

// q: one string of 1..Q_MAX characters after trim, with no control, bidi or
// invisible character (lib/core/text).
function queryText() {
  const parse = (raw) => {
    const t = raw.trim();
    return t.length >= 1 && t.length <= Q_MAX && !hasForbidden(t) ? t : undefined;
  };
  parse.expects = `1 to ${Q_MAX} characters, with no control, bidi or invisible character`;
  return parse;
}
function typeName() {
  const parse = (raw) => (raw.length >= 1 && raw.length <= TYPE_MAX ? raw : undefined);
  parse.expects = `an element type name of 1 to ${TYPE_MAX} characters`;
  return parse;
}
const parseQ = queryText();
const parseType = typeName();
const parseLimit = intIn(1, LIMIT_MAX);

const fold = (s) => s.normalize('NFC').toLowerCase();

// A schema's row: element-log's schemaRow when it has one (U513's plug-in
// rows beside the frozen SCHEMAS), else the SCHEMAS table's own row.
function rowOf(schema) {
  if (typeof elementLog.schemaRow === 'function') return elementLog.schemaRow(schema);
  return typeof schema === 'string' && Object.prototype.hasOwnProperty.call(elementLog.SCHEMAS, schema)
    ? elementLog.SCHEMAS[schema] : null;
}

// The record's searchable text, in match order: [field, masked text] pairs.
function textsOf(rec) {
  const out = [];
  const row = rowOf(rec.schema);
  for (const k of row && Array.isArray(row.keys) ? row.keys : []) {
    if (NOT_TEXT.has(k)) continue;
    if (typeof rec[k] === 'string' && rec[k]) out.push([k, rec[k]]);
  }
  for (const r of Array.isArray(rec.replies) ? rec.replies : []) {
    if (r && typeof r.text === 'string' && r.text) out.push(['replies', r.text]);
  }
  return out;
}

// At most SNIPPET_MAX characters of `text` around its first match of the
// folded query (the match's offset in the folded text, mapped back only when
// folding kept the length; else the text's head).
function snippetOf(text, needle) {
  const t = text.normalize('NFC');
  if (t.length <= SNIPPET_MAX) return t;
  const folded = t.toLowerCase();
  let at = folded.length === t.length ? folded.indexOf(needle) : 0;
  if (at < 0) at = 0;
  const room = SNIPPET_MAX - 2; // both ellipses, at worst
  let start = Math.max(0, at - Math.floor((room - Math.min(needle.length, room)) / 2));
  let end = Math.min(t.length, start + room);
  start = Math.max(0, end - room);
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(t[start])) start += 1;
  if (end < t.length && /[\uDC00-\uDFFF]/.test(t[end])) end -= 1;
  return `${start > 0 ? ELLIPSIS : ''}${t.slice(start, end)}${end < t.length ? ELLIPSIS : ''}`;
}

function mountElementSearchRoutes(app, ctx) {
  const { state, audience, graph } = ctx || {};
  if (!graph || !graph.elements) throw new TypeError('mountElementSearchRoutes: ctx.graph.elements (the element store) is required');
  if (!audience || typeof audience.requireMirror !== 'function') throw new TypeError('mountElementSearchRoutes: ctx.audience is required');

  app.get('/api/elements/search', audience.requireMirror(FLOOR.see), (req, res) => {
    // The element routes' type resolver, read per request (mountElementRoutes
    // publishes it; the mount order does not matter).
    const gates = ctx.elementGates;
    if (!gates || typeof gates.typeInfo !== 'function') return res.status(503).json({ error: NOT_MOUNTED });
    const query = req.query || {};
    let q;
    let typeArg;
    let limit;
    try {
      const copy = COPY_PARAMS.find((p) => query[p] !== undefined);
      if (copy) return res.status(400).json({ error: `${copy}: search takes no node or version`, hint: COPY_HINT });
      q = param(query, 'q', parseQ, undefined);
      if (q === undefined) throw new BadParam(`q: ${parseQ.expects}`);
      typeArg = param(query, 'type', parseType, undefined);
      limit = param(query, 'limit', parseLimit, LIMIT_DEFAULT);
    } catch (e) {
      if (e instanceof BadParam) return res.status(400).json({ error: e.message });
      throw e;
    }
    let permitted;
    if (typeArg !== undefined) {
      const info = gates.typeInfo(typeArg);
      if (!info) return res.status(400).json({ error: 'unknown element type', type: typeArg, hint: TYPE_HINT });
      if (!gates.passes(info.gate.see, req, res)) return undefined;
      permitted = new Set([info.type]);
    } else {
      permitted = new Set(gates.allTypes().filter((t) => gates.meets(gates.infoOf(t).gate.see, req)));
    }

    const store = graph.elements;
    const seesPrivate = audience.seesPrivate(req);
    const needle = fold(q);
    const liveComments = new Set((Array.isArray(state && state.comments) ? state.comments : []).map((p) => p && p.id));
    const matched = [];
    for (const id of store.log.ids()) {
      const type = store.typeOf(id);
      if (!permitted.has(type)) continue;
      const family = store.familyOf(type);
      if (family === CHAT_FAMILY && store.dropped(id)) continue;
      const latest = store.latest(id);
      if (!latest) continue;
      const rec = store.record(id, latest.v);
      if (!rec) continue;
      // Private: never a hit, a count or a limit's worth for this reader.
      if (!seesPrivate && rec.shared === false) continue;
      const label = describeAnchor(rec.anchor);
      const texts = textsOf(rec);
      if (typeof label === 'string' && label) texts.push(['anchor', label]);
      const hit = texts.find(([, text]) => fold(text).includes(needle));
      if (!hit) continue;
      const home = store.homeOf(id, rec.v);
      matched.push({
        id,
        type,
        family,
        v: rec.v,
        seq: rec.seq,
        created_at: rec.created_at ?? null,
        shared: rec.shared !== false,
        anchor_label: label || null,
        field: hit[0],
        snippet: snippetOf(hit[1], needle),
        live: family === CHAT_FAMILY ? true
          : liveComments.has(id) || refOf(state, id) !== null,
        home: home != null && graph.nodes.has(home) ? home : null,
      });
    }
    matched.sort((a, b) => (b.seq || 0) - (a.seq || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = { hits: matched.slice(0, limit), truncated: matched.length > limit };
    let out = seesPrivate ? body : dropPrivate('routes', 'GET /api/elements/search', body);
    if (!gates.meets(FLOOR.see, req)) out = stripText('routes', 'GET /api/elements/search', out);
    return res.json(out);
  });
}

module.exports = { mountElementSearchRoutes, Q_MAX, LIMIT_MAX, LIMIT_DEFAULT, SNIPPET_MAX };
