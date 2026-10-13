const { findMount, sectionChanges } = require('../domain/lineage');
const { PREVIEW_CSP } = require('../../core/cors');
const { summarizeReply } = require('../../core/reply');
const { atLeast, stripText } = require('../../core/remote-policy');
const { computeLabels, computeCollapse } = require('../graph');
const {
  deleteDraft, acquireLock, releaseLock, guardReaim, lockHeld, commitNode, liveIsDirty,
  setPendingReaim, takePendingReaim, discardFolded, skipTurn, lockView,
  foldOtherSession, sameSession,
} = require('../domain/turns');
const { diffNodes } = require('../diff');
const { renderNodePreview, modeParam } = require('../preview');
const { resolveNodeRef } = require('../domain/refs');
const { createAudience } = require('../audience');
const { ENVELOPE_KEYS, MAX_BODY_BYTES } = require('./hooks');
const { deleteComment } = require('../domain/comments');
const liveCaptures = require('../domain/captures');

// ── The turn routes' envelopes (spec §1.4, §3.1, §5.7 P1′) ──────────────────
//
// POST /api/turn-begin and /api/turn-end are what they were in 0.8.0 for every
// caller: a page's fetch drives the turn lock exactly as it always has (about
// 26 test files do), and nothing below changes what the lock does, or what it
// answers a local caller. They gain one HOST-ONLY effect. A request ctx.audience calls the host (spec
// §5.4 isHost: a loopback peer with no X-WC-Remote that sent no Origin or
// Sec-Fetch-* — what the turn hooks posting through lib/client are) has its
// session fields read, and the turn's envelope v1 goes on the hook tap
// (ctx.hooks): UserPromptSubmit from turn-begin, Stop or StopFailure (`ended:
// 'failed'`) from turn-end. A browser's request (a pane's fetch), a remote
// viewer's and a network peer's (Q9) publish nothing and stay session-less, as
// in 0.8.0: the tap feeds the chat mirror, the turn guard and the asks domain,
// and a pane must not be able to put a prompt bubble in the stream, close the
// real turn or settle a pending ask. Without an audience on ctx no request is
// the host; without a tap nothing is published.
//
// The publish comes BEFORE the lock logic, synchronously (the tap calls its
// subscribers inside publish): a turn-begin answered 409 for a concurrent
// session's turn still records that turn, and the mirror has closed the turn a
// Stop ends before turn-end commits its node.
//
// The fields are the ones lib/hooks/turn-begin.js sessionFields sends, each
// taken only at envelope v1's type (any other value is null), and the sections
// only in their v1 shape. Field caps are the hook's to apply (spec §1.3); the
// envelope as a whole is held to what the hook intake takes (routes/hooks.js
// MAX_BODY_BYTES), and one over it is not published — the lock does not notice.
const SESSION_STRINGS = Object.freeze(['session_id', 'transcript_path', 'cwd', 'prompt_id', 'entrypoint', 'permission_mode']);

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Only a plain `true` from the audience makes a request the host: no audience
// on ctx, or one that throws, is no host — narrower, never wider.
function isHost(ctx, req) {
  const a = ctx.audience;
  if (!a || typeof a.isHost !== 'function') return false;
  try { return a.isHost(req) === true; } catch { return false; }
}

// The session a turn request speaks for: { ts, session_id, transcript_path,
// cwd, prompt_id, claude_pid, entrypoint, permission_mode }, each null when the
// body has none of its type (`ts`, when the hook read stdin, falls back to
// now). Null for every request that is not the host's: its session fields, sent
// or not, are never read. The one reader of a turn route's session fields.
function hostSession(ctx, req) {
  if (!isHost(ctx, req)) return null;
  const body = isPlain(req.body) ? req.body : {};
  const session = { ts: typeof body.ts === 'number' && Number.isFinite(body.ts) && body.ts > 0 ? body.ts : Date.now() };
  for (const k of SESSION_STRINGS) session[k] = typeof body[k] === 'string' ? body[k] : null;
  session.claude_pid = Number.isSafeInteger(body.claude_pid) && body.claude_pid >= 2 ? body.claude_pid : null;
  return session;
}

// UserPromptSubmit's `prompt` section: { author: 'user'|'task', text,
// task_summary }, or null.
function promptSection(body) {
  const p = isPlain(body) ? body.prompt : null;
  if (!isPlain(p) || (p.author !== 'user' && p.author !== 'task') || typeof p.text !== 'string') return null;
  return { author: p.author, text: p.text, task_summary: typeof p.task_summary === 'string' ? p.task_summary : null };
}

// Stop's and StopFailure's `stop` section. A Stop of the main thread has no
// agent transcript.
function stopSection(body) {
  const b = isPlain(body) ? body : {};
  const tasks = b.background_tasks;
  return {
    last_assistant_message: typeof b.last_assistant_message === 'string' ? b.last_assistant_message : null,
    agent_transcript_path: null,
    background_tasks: Array.isArray(tasks) && tasks.every(isPlain) ? tasks : null,
    error: typeof b.error === 'string' ? b.error : null,
  };
}

// Envelope v1 for a turn event: every v1 key (routes/hooks.js ENVELOPE_KEYS, in
// lib/hooks/envelope.js's order), null but the event's own.
function turnEnvelope(event, session, sections) {
  const envelope = {};
  for (const k of ENVELOPE_KEYS) envelope[k] = null;
  return Object.assign(envelope, { v: 1, event }, session, sections);
}

// Put it on the tap. Never throws, and never stands in the lock's way.
function publishTurn(ctx, envelope) {
  const tap = ctx.hooks;
  if (!tap || typeof tap.publish !== 'function') return false;
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_BODY_BYTES) return false;
  try { tap.publish(envelope); } catch { return false; }
  return true;
}

// ── The turn guard's three questions (spec §3.2-3.3) ────────────────────────
// ctx.turnGuard (lib/server/turn-guard.js, U31; wired by createServer) answers
// them. Each is optional and read per request; a guard that is absent, lacks the
// method or throws answers "no", so every route keeps 0.8.0's behaviour.
//
//   ended(lock)              evidence the held turn ended without a Stop (an
//                            Esc, an interrupt from the page): a truthy object,
//                            whose `ended_by` ('terminal'|'web'|'hook') says who
//   closedRecently(sid)      the guard ended that session's turn within its
//                            lateStopMs
//   reconcileLateStop(args)  attach a late Stop to the node (or folded entry)
//                            the guard committed: → its node id, or 'folded';
//                            null when the Stop belongs to no turn it remembers
//
// and is told one thing: noteEnded(lock, result, {ended, since}) — turn-begin
// ended the held turn as interrupted on ended()'s evidence, so a late Stop of
// that turn can be reconciled to it too (ruling U31@late-stop-route-ended).
function guardCall(ctx, method, ...args) {
  const g = ctx.turnGuard;
  if (!g || typeof g[method] !== 'function') return null;
  try { return g[method](...args); } catch { return null; }
}

// How a turn ended, as the turn-end hook says (lib/hooks/turn-end.js): 'failed'
// for a StopFailure, else 'stop'. The guard's 'interrupted' and
// 'session-ended' never come from a request.
const endedOf = (body) => (isPlain(body) && body.ended === 'failed' ? 'failed' : 'stop');

function mountGraphRoutes(app, ctx) {
  const { graph, paths, bus, broadcastReset, state } = ctx;
  // draft.json's path, derived once by createServer (see createGraph).
  const { draftPath } = graph;

  // ── The graph's conversation text below `read` (spec §5.2-5.3, ruling Q2) ──
  // The graph carries the conversation: the typed prompt as the lock's message
  // (and, from 0.8.5, the lock's session fields), each node's trigger_summary,
  // and a node's whole trigger — prompt, summary, reply, error — with the turns
  // folded onto it and its link to the chat mirror's turns. A request below
  // `read` — a remote viewer of a project that has not opted in, a peer on a
  // network bind (Q9) — gets the graph without them: GET /api/graph,
  // GET /api/graph/node/:id, and the node GET /preview/node/:id embeds in its
  // document each drop exactly their TEXT_RULES.routes paths
  // (lib/core/remote-policy). The surface stays: labels, times, authors and the
  // pages. A local request (and one at `read` or `full`) is never projected, so
  // what it gets is byte-identical to 0.8.0's. ctx.audience is read per request,
  // so the order the server builds it in does not matter; until it hands one
  // over, a request is judged with no mirror opt-in (a remote viewer is basic):
  // narrower, never wider. A level that cannot be read is basic.
  const noOptIn = createAudience({ configFile: null });
  const levelOf = (req) => {
    try { return (ctx.audience || noOptIn).levelOf(req); } catch { return 'basic'; }
  };
  const textFor = (req, route, body) => (atLeast(levelOf(req), 'read') ? body : stripText('routes', route, body));

  // ── Re-aim executors ──────────────────────────────────────────────────────
  // The four re-aim bodies, extracted so each runs from TWO places: the route
  // (no fresh lock → execute now) and applyPendingReaim (a fresh lock queued
  // the intent; turn-end/unlock applies it). Behavior is byte-identical to the
  // old inline route bodies.
  // Set active is the one way the user moves the commit point onto a node (the
  // graph screen's Set active / ⑃ Branch). A previewed node is read-only (plan
  // §2b D2); making it active is what lets the next edit or render branch from
  // it. Uncommitted live work is never discarded by the move: if the surface
  // differs from the active node it is committed first, as a user-authored
  // 'preserve' node on the old commit point — the guarantee branch-on-edit used
  // to give, moved to the one gesture that now re-aims.
  //
  // Set active onto the node that is ALREADY active is a no-op: nothing moves,
  // nothing is preserved, the live surface is left exactly as it is. Without
  // this the preserve commit stepped active onto the new preserve node and the
  // re-aim then stepped it straight back, taking the live work off the surface
  // and forking the next commit off the old node.
  function execSetActive(id) {
    if (id === graph.active) return { ok: true, active: id, preserved: null, unchanged: true };
    let preserved = null;
    if (liveIsDirty(graph)) {
      preserved = commitNode(graph, bus, {
        draftPath, parentId: graph.active, author: 'user',
        triggerKind: 'preserve', message: 'auto-preserved before set active',
        clearLock: false, op: 'commit', includeLabelAndUnlock: false,
      }).node_id;
    }
    graph.active = id;
    // The commit point moved: chat-only turns collapsed against the OLD context
    // must not be stapled onto whatever commits next over here. (With work to
    // preserve, the commit above already drained them onto the preserve node.)
    discardFolded(graph);
    graph.restoreLiveToNode(id, bus);
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'set-active', id, ...(preserved ? { preserved } : {}) } });
    return { ok: true, active: id, preserved };
  }

  // A wipe empties the page but STAYS on this node, so (unlike the other three
  // re-aims) it does not move the commit point: collapsed chat-only turns are
  // deliberately kept — the node they eventually land on is still their child.
  // Pinned panes survive: the pin is the user saying "this one stays". The
  // bookmark is set either way, including when survivors mean the page isn't
  // actually empty afterwards — the gesture is what earns the bookmark.
  //
  // What else a wipe clears (ruled A3 (b), 2026-10-13): every comment pin
  // anchored to a pane that is not on the page afterwards — a pin on a removed
  // pane can no longer be drawn — and the live captures. Each pin goes through
  // deleteComment, the one canonical removal, so its delete event dequeues a
  // queued shared pin through the wake policy. The store is kept (U102@store-keys
  // (a): no pruning in 0.8.5), and so is everything committed nodes hold.
  function execWipe(name = '') {
    const kept = graph.clearLiveMounts({ keepPinned: true });
    for (const c of [...state.comments]) {
      const mount = c && c.anchor && c.anchor.mount;
      if (mount && !state.mounts.has(mount)) deleteComment(state, bus, c.id);
    }
    liveCaptures.clearLive(state);
    const label = String(name || '').trim();
    // `wipe` marks the bookmark as a wipe's, so the graph screen can draw it as
    // "⌫ wipe · <label>" rather than as an ordinary ⚑.
    graph.pendingBookmark = { name: label, wipe: true };
    // pendingBookmark now rides _meta.json, so persist the gesture rather than
    // leaving it to whatever writes meta next.
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'wipe', ...(label ? { name: label } : {}), ...(kept.length ? { kept: kept.length } : {}) } });
    return { ok: true, active: graph.active, name: label, kept };
  }

  // A new graph is a fresh tree: it also drops every comment pin (each through
  // deleteComment) and every live capture (ruled A3 (b)). Committed nodes keep
  // theirs; the store is kept, as before.
  function execNewGraph(name) {
    graph.clearLiveMounts();
    for (const c of [...state.comments]) deleteComment(state, bus, c.id);
    liveCaptures.clearLive(state);
    graph.active = null;
    discardFolded(graph);
    graph.pendingBookmark = { name };
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'new-graph', name } });
    return { ok: true, active: null, name };
  }

  // Apply (claim-and-run) the queued re-aim, if any. Called after the turn-end
  // commit and after a manual unlock. A queued set-active applies with nothing
  // dirty (the commit just snapshotted live), so its preserve step naturally
  // no-ops. A queued intent whose target node vanished can't exist — nodes are
  // append-only — but guard anyway.
  function applyPendingReaim() {
    const intent = takePendingReaim(graph);
    if (!intent) return null;
    if (intent.op === 'set-active' && !graph.nodes.has(intent.id)) {
      return { op: intent.op, id: intent.id, ok: false, error: 'not found' };
    }
    const r = intent.op === 'wipe' ? execWipe(intent.name || '')
      : intent.op === 'new-graph' ? execNewGraph(intent.name || '')
      : execSetActive(intent.id);
    return { op: intent.op, ...(intent.id ? { id: intent.id } : {}), ok: r.ok };
  }
  app.get('/api/graph', (req, res) => {
    const labels = computeLabels(graph);
    // Read-time only: which nodes are byte-identical to their parent, and which
    // surviving node stands for each run of them (see graph.computeCollapse).
    // Purely additive — `parent_id` stays the truth on disk, `display_parent` is
    // the edge to draw when the collapsed ones are hidden.
    const collapse = computeCollapse(graph);
    const brief = (id) => {
      const t = graph.topology.get(id) || {};
      return {
        id,
        label: labels.get(id) || id,
        created_at: t.created_at,
        author: t.author,
        trigger_summary: t.trigger_summary || '',
      };
    };
    res.json(textFor(req, 'GET /api/graph', {
      nodes: [...graph.topology.values()].map(t => {
        const c = collapse.get(t.id) || {};
        const absorbed = c.absorbed || [];
        return {
          ...t,
          label: labels.get(t.id) || t.id,
          ...(c.collapsed ? { collapsed: true } : {}),
          display_parent: c.collapsed ? t.parent_id : (c.display_parent !== undefined ? c.display_parent : t.parent_id),
          ...(absorbed.length ? { absorbed: absorbed.map(brief), absorbed_count: absorbed.length } : {}),
        };
      }),
      // How many nodes the viewer will hide. Lets a reader tell "this graph is
      // 12 turns" from "this graph is 12 turns and 559 collapsed no-change ones".
      collapsed_count: [...collapse.values()].filter((c) => c.collapsed).length,
      active: graph.active,
      active_label: graph.active ? (labels.get(graph.active) || null) : null,
      // With `stale` (turns.lockView): a lock whose turn never reached Stop is
      // still reported, but a reader can tell it no longer holds a re-aim off.
      lock: lockView(graph.lock),
      // Intent that has been accepted but not yet applied. Without these, the
      // two things about to happen to the graph were invisible to the only
      // reader that needs them: after `new graph`, the name the user typed lives
      // in pendingBookmark until the first commit — so Claude could be working
      // in a graph the user named and have no way to know it — and a re-aim
      // queued during a turn moves `active` the moment that turn ends, which the
      // guidance warns Claude about while giving it nothing to observe.
      pending_reaim: graph.pendingReaim || null,
      pending_bookmark: graph.pendingBookmark || null,
      // How many turns so far ended without changing the surface and so
      // committed no node. They fold onto the next node that does commit (which
      // then reports them as `folded_count`), so a non-zero value here means
      // "the last N turns are still waiting for something to attach to".
      pending_folded: (graph.pendingFolded || []).length + (graph.pendingFoldedDropped || 0),
    }));
  });

  // What each node changed, per #/## section of its page, against its parent:
  // { changes: { <node id>: [{h, sec, add?, chg?, rm?}] } } — only the nodes
  // whose page has sections (lineage sectionChanges). The phone graph log's
  // chips. Its own route, not a field on /api/graph: that payload is get_graph's
  // verbatim, and the chips need every node's full page, not its topology.
  app.get('/api/graph/changes', (req, res) => {
    const changes = {};
    for (const [id, node] of graph.nodes) {
      const parent = node.parent_id != null ? graph.nodes.get(node.parent_id) || null : null;
      const c = sectionChanges(node, parent);
      if (c.length) changes[id] = c;
    }
    res.json({ changes });
  });

  app.get('/api/graph/node/:id', (req, res) => {
    const node = graph.nodes.get(req.params.id);
    if (!node) return res.status(404).json({ error: 'not found' });
    const labels = computeLabels(graph);
    res.json(textFor(req, 'GET /api/graph/node/:id', { ...node, label: labels.get(node.id) || node.id }));
  });

  // Structural diff between two nodes. `a`/`b` accept a hierarchical label
  // (n1.2), an opaque id (n3), `active`, or `live` (the uncommitted surface).
  app.get('/api/graph/diff', (req, res) => {
    const aRef = req.query.a, bRef = req.query.b;
    if (aRef == null || bRef == null) {
      return res.status(400).json({ error: 'both `a` and `b` query params are required' });
    }
    // One resolver for every node ref (domain/refs). `live` borrows the active
    // node's theme there, so a themed `active` diffed against `live` is not a
    // spurious full-theme removal. The messages stay this route's own.
    const resolveRef = (ref) => {
      const r = resolveNodeRef(graph, String(ref));
      if (r.ok) return { ok: true, value: r };
      if (r.code === 'no-active') return { ok: false, error: 'no active node — the surface has no commit point yet (try `live`)' };
      return { ok: false, error: 'node not found' };
    };

    const A = resolveRef(aRef);
    if (!A.ok) return res.status(404).json({ error: A.error, ref: String(aRef), which: 'a' });
    const B = resolveRef(bRef);
    if (!B.ok) return res.status(404).json({ error: B.error, ref: String(bRef), which: 'b' });

    const ctx = parseInt(req.query.context, 10);
    const opts = Number.isFinite(ctx) && ctx >= 0 ? { context: ctx } : {};
    res.json({
      a: { id: A.value.id, label: A.value.label },
      b: { id: B.value.id, label: B.value.label },
      ...diffNodes(A.value.node, B.value.node, opts),
    });
  });

  app.get('/preview/node/:id', (req, res) => {
    // Set before the 404 too, so every document this path can produce is under
    // the same policy and the header is never a function of which branch ran.
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    const node = graph.nodes.get(req.params.id);
    if (!node) return res.status(404).type('text/html').send('<h1>node not found</h1>');
    // Glance preview reflects the node's resolved theme: global default ⊕ node.
    // The document embeds the node it is handed, so below `read` it is handed
    // the node without its conversation text.
    res.type('text/html').send(renderNodePreview(paths, textFor(req, 'GET /preview/node/:id', node), { mode: modeParam(req.query.mode) }));
  });

  // ONE version of ONE pane, read-only — what the pane-history popover shows
  // (GET /api/mounts/:id/history lists the versions). The same preview document
  // (lib/server/preview) and the same PREVIEW_CSP as /preview/node, handed a
  // node narrowed to that pane: no markdown, no other panes, the node's store
  // (the pane's script reads it) and theme. The pane is shown full-width and
  // never minimized — a collapsed pane would preview as an empty page.
  app.get('/preview/pane/:node/:mount', (req, res) => {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    const node = graph.nodes.get(req.params.node);
    if (!node) return res.status(404).type('text/html').send('<h1>node not found</h1>');
    const m = findMount(node, req.params.mount);
    if (!m) return res.status(404).type('text/html').send('<h1>pane not found in that node</h1>');
    const ps = { ...(m.pane_state || {}) };
    delete ps.minimized;
    delete ps.col;
    ps.colSpan = 12;
    const one = { id: node.id, mounts: [{ ...m, pane_state: ps }], store: node.store || {}, theme: node.theme };
    // `?mode=` — the viewer's light/dark, so the version reads like the page
    // beside it (the pane-history popover passes it).
    res.type('text/html').send(renderNodePreview(paths, one, { mode: modeParam(req.query.mode) }));
  });

  app.post('/api/graph/active', (req, res) => {
    const { id } = req.body || {};
    // "Stay here" is judged against the node the user was LOOKING at — read
    // before guardReaim, whose steal of a stale lock may commit the abandoned
    // turn as a preserve node and move active onto it. Compared after, the
    // request to stay became a real re-aim back onto the old node: the work left
    // the surface, the next commit forked off the old node, and the reply said
    // nothing had been preserved.
    const before = graph.active;
    // guardReaim persists the steal immediately so the cleared lock can't reappear
    // if we bail on the 404 below (or the process dies before the later saveMeta).
    const g = guardReaim(graph, bus, { draftPath });
    if (!graph.nodes.has(id)) return res.status(404).json({ error: 'not found' });
    // Already active → a no-op, and never queued: queued, it would apply after
    // the turn-end commit had moved active onto the turn's node, and so pull
    // active back off Claude's just-landed work. It still SUPERSEDES a re-aim
    // queued earlier — last intent wins, and this one is "stay here". After a
    // steal that preserved, "here" is the preserve node: it holds exactly the
    // live surface the user was looking at, so nothing is restored and the
    // reply names where the work went.
    if (id === before) {
      graph.pendingReaim = null;
      if (id === graph.active) return res.json(execSetActive(id));
      return res.json({ ok: true, active: graph.active, preserved: g.preserved || null, unchanged: true });
    }
    // A fresh lock QUEUES the intent (applied after the turn-end commit) —
    // never a 409 to the user; last queued intent wins.
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'set-active', id });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'set-active', id });
    }
    graph.pendingReaim = null; // an immediate re-aim supersedes any queued intent
    const r = execSetActive(id);
    // A stale-lock steal's preserve is as much this click's doing as the dirty
    // surface's own — whichever made one, the caller is told where the work went.
    res.json({ ...r, preserved: r.preserved || g.preserved || null });
  });

  app.post('/api/turn-begin', (req, res) => {
    const { message = '', author = 'user' } = req.body || {};
    // A host's prompt goes on the hook tap first, whatever the lock then says
    // (see the turn routes' envelopes, above).
    const session = hostSession(ctx, req);
    if (session) publishTurn(ctx, turnEnvelope('UserPromptSubmit', session, { prompt: promptSection(req.body) }));
    // The lock's session (spec §3.2): a host request's session_id, claude_pid
    // and prompt_id, read through hostSession only — a pane's fetch is
    // session-less, so it can never join, interrupt or fold another session's
    // turn; it is answered exactly as in 0.8.0. A same-session user prompt
    // under a fresh lock asks the turn guard whether the held turn already
    // ended (an Esc fires no Stop).
    const lockArgs = {
      message, author, draftPath,
      ...(session ? { session_id: session.session_id, claude_pid: session.claude_pid, prompt_id: session.prompt_id } : {}),
      heldEnded: session ? (held) => guardCall(ctx, 'ended', held) : null,
    };
    // The next node continues the current lineage (child of active). A *new*
    // top-level tree happens only when active is null — set exclusively by
    // `new graph` (POST /api/graph/new). `wipe` clears the panes but keeps
    // active, so it stays on the same graph. (A blank surface no longer implies
    // a new tree; that conflation is what `new graph` now makes explicit.)
    // Stealing a stale lock keeps the abandoned turn's work as its own preserve
    // node (turns.stealStale) — which is a commit, so it needs the draft path.
    let r = acquireLock(graph, bus, lockArgs);
    let interrupted = null;
    if (!r.ok && r.ended) {
      // The guard has evidence the held turn of THIS session ended without a
      // Stop: end it as interrupted (its work committed, or folded when it
      // changed nothing; a queued re-aim applied), then take the lock.
      const held = r.lock;
      const since = Date.now();
      const ended = endTurn({
        author: 'claude', ended: 'interrupted',
        ...(isPlain(r.ended) && typeof r.ended.ended_by === 'string' ? { ended_by: r.ended.ended_by } : {}),
        session_id: held.session_id, prompt_id: held.prompt_id,
      });
      // The guard remembers it, as it remembers its own ends: the Stop of that
      // turn may still come, while this prompt's turn holds the lock.
      guardCall(ctx, 'noteEnded', held, ended, { ended: 'interrupted', since });
      interrupted = ended.node_id || (ended.skipped === 'no-change' ? 'folded' : null);
      r = acquireLock(graph, bus, { ...lockArgs, heldEnded: null });
    }
    if (r.ok && r.joined) return res.json({ ok: true, joined: true });
    // The refusal names the lock it ran into, which holds ANOTHER turn's prompt.
    // A page or a local process gets it whole, as in 0.8.0; a caller below
    // `read` (a peer on a network bind, Q9) gets it as a `lock` frame would
    // reach it, without the lock's text (TEXT_RULES).
    if (!r.ok) {
      const refused = { error: 'already locked', lock: r.lock };
      return res.status(409).json(atLeast(levelOf(req), 'read') ? refused : stripText('frames', 'lock', refused));
    }
    res.json({
      ok: true, lock: r.lock, stole_stale_lock: r.stole_stale_lock,
      ...(r.upgraded_wake_lock ? { upgraded_wake_lock: true } : {}),
      ...(r.preserved ? { preserved: r.preserved } : {}),
      ...(r.dropped_reaim ? { dropped_reaim: r.dropped_reaim } : {}),
      ...(interrupted ? { interrupted } : {}),
    });
  });

  app.post('/api/unlock', (req, res) => {
    const r = releaseLock(graph, bus);
    // A manual unlock releases the turn — honor whatever re-aim was waiting.
    const reaim = applyPendingReaim();
    res.json({ ok: true, cleared: r.cleared, ...(reaim ? { reaim } : {}) });
  });

  // ── endTurn: how a held turn ends (spec §3.2) ────────────────────────────
  // The body POST /api/turn-end has always run, extracted so the turn guard
  // (U31, bound by createServer) can end a turn that never reaches its Stop —
  // an Esc, an interrupt from the page, a session that went away — exactly as a
  // Stop would: commit when the surface changed, skip and fold when it did not,
  // a queued re-aim applied after. mountGraphRoutes returns it. It publishes
  // nothing (a Stop's envelope is the route's), and records how the turn ended
  // (`ended`, `ended_by`, `error`) on the node's trigger or the folded entry,
  // and the session and prompt on the ring entry, each only when present.
  // Returns the route's answer.
  function endTurn({ author = 'claude', summary, reply, ended, ended_by, session_id, prompt_id, error } = {}) {
    // The Stop hook's summary of Claude's reply (hooks/reply.js). Re-summarised
    // here because a request body is not trusted to be short or a string;
    // '' (absent) means the node simply records no reply.
    const rep = summarizeReply(reply);
    const end = { ended, ended_by, error, session_id, prompt_id };
    // No lock, but the surface changed: this is the daemon-spawning turn. The
    // turn-begin hook found nothing reachable and returned WITHOUT locking (it
    // cannot lock a daemon that isn't running), then a tool call auto-spawned the
    // daemon and rendered. Answering `skipped:'no-lock'` here left that work
    // uncommitted until the NEXT prompt's turn-end swept it up and stamped it
    // with that prompt's message — provenance silently wrong for every
    // first-turn-after-spawn, against the promise that every turn commits a node.
    // Commit it as its own node instead, onto the current commit point, with a
    // trigger that says plainly why it carries no prompt.
    if (!graph.lock) {
      if (!liveIsDirty(graph)) return { ok: true, skipped: 'no-lock' };
      const u = commitNode(graph, bus, {
        draftPath, parentId: graph.active, author,
        triggerKind: 'unlocked-turn', message: '',
        summary: summary || 'turn that began before the daemon was running', reply: rep,
        clearLock: false, op: 'turn-end', includeLabelAndUnlock: true, ...end,
      });
      return { ok: true, node_id: u.node_id, unlocked: true };
    }
    // A node exists only where the SURFACE actually changed. A turn that spent
    // itself in chat would otherwise commit a byte-identical copy of its parent,
    // and a run of those makes the graph unnavigable. liveIsDirty is the SAME
    // comparison set-active's auto-preserve uses (mounts incl. per-pane theme + store +
    // comments + captures), so "changed" means exactly "this node would differ".
    //
    // liveIsDirty compares against graph.active; turn-end commits onto
    // graph.lock.base. Those are equal for the whole life of a fresh lock (every
    // re-aim queues while one is held), but if they ever diverge we commit
    // rather than reason about it — a spurious node is a nuisance, a lost node
    // is data loss.
    if (graph.lock.base === graph.active && !liveIsDirty(graph)) {
      const accumulated = skipTurn(graph, bus, { author, summary, reply: rep, ...end });
      // The lock is released either way, so a re-aim the user queued mid-turn
      // must still be honoured — including the case where honouring it discards
      // the very turn we just accumulated (the context it belonged to is gone).
      const reaim = applyPendingReaim();
      return { ok: true, skipped: 'no-change', accumulated, ...(reaim ? { reaim } : {}) };
    }
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.lock.base, author,
      triggerKind: 'turn', message: graph.lock.message, summary, reply: rep,
      clearLock: true, op: 'turn-end', includeLabelAndUnlock: true, ...end,
    });
    // Commit FIRST (on lock.base), then honor the re-aim the user queued
    // mid-turn — the turn's work lands where the turn began, and the user goes
    // where they asked to go.
    const reaim = applyPendingReaim();
    return { ok: true, node_id: r.node_id, ...(reaim ? { reaim } : {}) };
  }

  app.post('/api/turn-end', (req, res) => {
    const body = isPlain(req.body) ? req.body : {};
    const { author = 'claude', summary } = body;
    // A host's Stop — StopFailure for `ended: 'failed'` — goes on the hook tap
    // before anything commits, so the mirror has closed its turn by then.
    const session = hostSession(ctx, req);
    if (session) {
      const event = body.ended === 'failed' ? 'StopFailure' : 'Stop';
      publishTurn(ctx, turnEnvelope(event, session, { stop: stopSection(req.body) }));
    }
    // How the turn ended, and which session it was — a host's only. A page's
    // turn-end is session-less and records nothing new, as in 0.8.0.
    const end = session ? {
      ended: endedOf(body),
      ...(typeof body.error === 'string' && body.error ? { error: body.error } : {}),
      session_id: session.session_id, prompt_id: session.prompt_id,
    } : {};

    // (1) A late Stop: no lock, and the turn guard ended this session's turn a
    // moment ago (it saw the turn close and committed it as interrupted). The
    // Stop is attached to what the guard committed instead of committing a
    // stray node and recording the reply twice. Ahead of the lockless path
    // below, which stays the branch when there is no guard or no recent close,
    // and which the Stop goes on to when the guard answers null: it names a
    // prompt_id no turn the guard remembers had (ruling U31@pick-prompt-mismatch).
    const lateArgs = () => ({
      session_id: session.session_id, prompt_id: session.prompt_id,
      reply: summarizeReply(body.reply), ended: end.ended,
    });
    if (!graph.lock && session && session.session_id && guardCall(ctx, 'closedRecently', session.session_id)) {
      const got = guardCall(ctx, 'reconcileLateStop', lateArgs());
      if (got !== null) {
        const reconciled = typeof got === 'string' && got ? got
          : (isPlain(got) && typeof got.node_id === 'string' ? got.node_id : 'folded');
        return res.json({ ok: true, reconciled });
      }
    }

    // (1b) The same late Stop, arriving while the session's NEXT turn holds the
    // lock (turn-begin ended the old turn as interrupted on the guard's
    // evidence, ruling U31@late-stop-route-ended): the same session, a
    // prompt_id that is not the lock's, and a turn the guard remembers by that
    // prompt_id. It lands on the old turn; the held turn stays open. Anything
    // else here goes on as before.
    if (graph.lock && session && session.session_id && session.prompt_id
      && session.prompt_id !== graph.lock.prompt_id && sameSession(graph.lock, session)
      && guardCall(ctx, 'closedRecently', session.session_id)) {
      const got = guardCall(ctx, 'reconcileLateStop', lateArgs());
      const reconciled = typeof got === 'string' && got ? got
        : (isPlain(got) && typeof got.node_id === 'string' && got.node_id ? got.node_id : null);
      if (reconciled) return res.json({ ok: true, reconciled });
    }

    // (2) Another session's Stop: the lock belongs to a session this request
    // does not speak for. Before 0.8.5 it committed the FIRST session's turn
    // with the second's reply. The lock stays; this turn's trigger folds onto
    // the next commit. A missing session_id on either side is today's path,
    // and so is the same Claude Code process under a new session_id (a /clear,
    // C36: sameSession matches it by claude_pid).
    if (graph.lock && session && session.session_id && graph.lock.session_id
      && !sameSession(graph.lock, session)) {
      foldOtherSession(graph, bus, { author, summary, reply: summarizeReply(body.reply), ...end });
      return res.json({ ok: true, skipped: 'other-session' });
    }

    // (3) Everything else ends the held turn, as in 0.8.0.
    res.json(endTurn({ author, summary, reply: body.reply, ...end }));
  });

  // Wipe: empty the live surface's panes (store preserved) but STAY on the same
  // graph — active is kept, so the next turn continues the lineage. The next
  // committed node is bookmarked as the start of fresh content.
  app.post('/api/graph/wipe', (req, res) => {
    const g = guardReaim(graph, bus, { draftPath });
    // An optional label names that bookmark — "the fresh start I called X".
    // Absent/empty still bookmarks; it just has no label.
    const name = String((req.body && req.body.name) || '').trim();
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'wipe', name });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'wipe', name });
    }
    graph.pendingReaim = null;
    res.json({ ...execWipe(name), preserved: g.preserved || null });
  });

  // New graph: start a fresh top-level tree. Detaches active → null (so the next
  // turn's node is a new root) and bookmarks that root with the graph's name.
  app.post('/api/graph/new', (req, res) => {
    // guardReaim (unlike the old inline steal here) persists the stale-lock steal
    // immediately — fixing the drift where new-graph forgot saveMeta.
    const g = guardReaim(graph, bus, { draftPath });
    const name = String((req.body && req.body.name) || '').trim();
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'new-graph', name });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'new-graph', name });
    }
    graph.pendingReaim = null;
    res.json({ ...execNewGraph(name), preserved: g.preserved || null });
  });

  // Bookmark: name an existing node. Additive fields (bookmarked/name) only —
  // no schema bump, no migration. An empty/absent name un-bookmarks.
  app.post('/api/graph/bookmark', (req, res) => {
    const { id, name = '' } = req.body || {};
    const node = graph.nodes.get(id);
    if (!node) return res.status(404).json({ error: 'not found' });
    const trimmed = String(name || '').trim();
    node.bookmarked = !!trimmed;
    node.name = trimmed;
    graph.writeNode(node);
    const t = graph.topology.get(id);
    if (t) { t.bookmarked = node.bookmarked; t.name = node.name; }
    bus.emit({
      event: { kind: 'graph', op: 'bookmark', id, bookmarked: node.bookmarked },
      ws: { type: 'bookmark', id, bookmarked: node.bookmarked, name: node.name },
    });
    res.json({ ok: true, id, bookmarked: node.bookmarked, name: node.name });
  });

  app.post('/api/commit', (req, res) => {
    if (lockHeld(graph)) return res.status(409).json({ error: 'locked — use turn-end' });
    const { message = '', author = 'manual', summary } = req.body || {};
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.active, author,
      triggerKind: 'manual', message, summary,
      clearLock: false, op: 'commit', includeLabelAndUnlock: false,
    });
    res.json({ ok: true, node_id: r.node_id });
  });

  // The handle createServer keeps (as mountReplayRoutes returns its own): U40
  // binds endTurn to the turn guard, and nothing else calls it.
  return { endTurn };
}

module.exports = { mountGraphRoutes };
