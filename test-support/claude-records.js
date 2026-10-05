// Claude Code transcript records, built for the chat mirror's tests.
//
// Generated, seeded and deterministic: the same seed and the same calls give the
// same records byte for byte. Never copied from a real transcript, whose records
// hold real prompts and secrets (validation V16). Every value is fake: ids come
// from a seeded PRNG, emails are @example.com, paths sit under /tmp/project. A
// test that wants a secret-shaped value inside a record takes it from
// test-support/fake-secrets.js and passes it in; nothing here invents one, and
// this file spells neither the redaction mask's opening nor the PEM marker.
//
// THE SHAPES. Chain records (user, assistant, attachment, system) carry the 12
// core keys the drift summary found on every one of them (cwd, entrypoint,
// gitBranch, isSidechain, message, parentUuid, sessionId, timestamp, type,
// userType, uuid, version — `message` on user and assistant only; an attachment
// has `attachment`, a system record `subtype` and its own keys). The uuid-less
// metadata records (last-prompt, mode, permission-mode, ai-title, agent-name,
// cost-state, queue-operation, frame-link, …) carry only their own keys, as
// Claude Code writes them: no uuid, no version (a reader inherits the file's
// last version, V15), and a timestamp only where the real kind has one. Where
// the corpus knew only a field's NAME (the inventory stores keys, never values),
// the value is a plausible guess, marked "guessed" below.
//
// THE CHAIN. Each chain record's parentUuid is the previous chain record's uuid
// (the leaf). `branchFrom(uuid)` makes the next chain record a sibling: its
// parent is the named earlier record, as a rewind's branch is (§15.4 case a). A
// compact_boundary starts a new root (parentUuid null, logicalParentUuid = the
// leaf), as the real one does.
//
// THE API (stable: U26, U27, U28a, U28b, U78 and U40's end-to-end check use it).
//
//   const r = createRecords({ seed, sessionId, cwd, gitBranch, entrypoint,
//                             version, start, step, agentId });
//     every option has a default; `start` is the first timestamp (ms), `step`
//     the ms between records; `agentId` makes the chain an agent file's
//     (agentId on every chain record, isSidechain true).
//   r.records            every record built, in order (what a file holds)
//   r.leaf               the uuid the next chain record's parentUuid will be
//   r.lastPromptId       the promptId of the last opener built
//   r.byUuid(uuid)       a chain record built here
//   r.tick(ms) / r.at(ms)   move the clock (by / to)
//   r.setVersion(v)      the version later chain records carry
//   r.branchFrom(uuid)   the next chain record's parent is `uuid` (throws for a
//                        uuid not built here)
//   r.uuid() / r.id(prefix)   a fresh seeded uuid / 'msg_01…'-style id
//
//   Openers (each returns the record):
//   r.prompt(text, {promptId, extra})
//   r.promptImage(text, {promptId, png, mediaType, extra})   + a real PNG block
//   r.taskNotification({taskId, toolUseId, outputFile, status, summary, event,
//                       result, promptId, extra})           origin task-notification
//   r.channel({body, attrs, promptId, extra})               isMeta, origin channel
//   r.slashCommand(name, args, {extra})
//   r.bashMode(input, {extra}) / r.bashOutput(stdout, stderr, {extra})
//
//   The assistant (returns an ARRAY: one record per block, one message.id):
//   r.assistant([block, …], {messageId, model, usage, effort, stopReason,
//                            requestId, extra})
//     blocks: a string (text), {type:'text', text}, {type:'thinking', thinking,
//     durationMs?}, {type:'tool_use', name, input, id?}; tool_use ids default
//     to fresh 'toolu_01…' ids, a thinking block gets a fake signature, and
//     `durationMs` becomes the record's thinkingDurationMs (placement guessed).
//     The last record carries stopReason (default 'end_turn', or 'tool_use'
//     when the last block is a tool_use); earlier ones stop_reason null.
//   r.apiErrorMessage(text, {status})    an assistant record with isApiErrorMessage
//
//   Tool results:
//   r.toolResult(toolUseId, content, {isError, denied, images, persistedOutputPath,
//                persistedOutputSize, stdout, stderr, structuredPatch, filePath,
//                taskId, agentId, runId, toolUseResult, extra})
//     content: a string or an array of blocks; `images` adds image blocks (a
//     tiny real PNG unless given); `denied` writes Claude Code's "doesn't want to
//     proceed" text with is_error; toolUseResult is assembled from the options
//     (backgroundTaskId ← taskId) and then merged with `toolUseResult`.
//
//   Turn and session records:
//   r.turnDuration({durationMs, messageCount, extra})
//   r.compactBoundary({trigger, preTokens, postTokens, durationMs, tailUuid,
//                      headUuid, anchorUuid, extra})
//   r.compactSummary(text, {extra})
//   r.interrupt({forToolUse, extra})
//   r.localCommandOutput(stdout, {stderr, extra})
//   r.localCommandCaveat({extra})
//   r.localCommand(command, {content, extra})               system/local_command
//   r.awaySummary(text) / r.informational(text, {level}) / r.apiError(text, {status})
//
//   Attachments (chain records):
//   r.queuedCommand(prompt, {commandMode, origin, extra})
//   r.hookAdditionalContext(content, {hookName, hookEvent, toolUseID, extra})
//   r.hookPermissionDecision(toolUseID, decision, {hookEvent, extra})
//   r.skillListing({isInitial, names, descriptions, content, extra})
//   r.credentialOrg(organizationUuid, {extra})
//   r.sessionContext({userEmail, rendered, extra})
//   r.attachment(type, fields, {extra})    any other attachment kind
//   r.system(subtype, fields, {extra})     any other system kind
//   r.user(content, {extra})               a user record with this content as-is
//
//   Metadata records (uuid-less; NOT in the chain):
//   r.lastPrompt({leafUuid, rewound, lastPrompt})   leafUuid defaults to r.leaf;
//                                                   pass null for a null anchor
//   r.queueOperation(operation, {content, reason})
//   r.aiTitle(t) / r.agentName(n) / r.mode(m) / r.permissionMode(m)
//   r.costState(fields) / r.frameLink({title, frameUrl, path, artifactCount})
//   r.meta(type, fields)                   any other uuid-less kind
//
//   Files:
//   jsonl(records)                one JSON line per record ('\n' after each);
//                                 nested arrays flatten, a string is a raw line
//   chunksOf(text, splits)        Buffers cut at those BYTE offsets of the UTF-8
//   appendChunked(file, text, {splits, onChunk})   appends chunk by chunk
//                                 (sync); onChunk(i, buf) runs after each write
//   appendChunkedAsync(file, text, {splits, between})   awaits between() after
//                                 each write but the last
//   midCharOffsets(text)          byte offsets that fall inside a multibyte
//                                 character (a split there tears the character)
//   randomSplits(text, {seed, count})   seeded split offsets, sorted
//   taskNotificationText(opts)    the <task-notification> block, for carriers
//   channelText({body, attrs})    the <channel …> block
//   TINY_PNG                      a 2x2 RGBA PNG (Buffer), real and decodable
//   CLAUDE_CODE_VERSION           the default `version` ('2.1.287')

const fs = require('fs');
const { mulberry32 } = require('./fake-secrets');
const { encodePng } = require('./png-encode');

const CLAUDE_CODE_VERSION = '2.1.287';
const DEFAULT_START = Date.UTC(2026, 9, 4, 12, 0, 0);

const TINY_PNG = encodePng(Buffer.from([
  200, 60, 40, 255, 40, 200, 60, 255,
  60, 40, 200, 255, 250, 250, 250, 255,
]), 2, 2);

const HEX = '0123456789abcdef';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const DENIED_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function escAttr(v) {
  return String(v).replace(/"/g, '&quot;');
}

function taskNotificationText({
  taskId = 'b0000001', toolUseId, outputFile, status = 'completed',
  summary = 'Background command "build" completed (exit code 0)', event, result,
} = {}) {
  const lines = ['<task-notification>', `<task-id>${taskId}</task-id>`];
  if (toolUseId) lines.push(`<tool-use-id>${toolUseId}</tool-use-id>`);
  if (outputFile) lines.push(`<output-file>${outputFile}</output-file>`);
  if (status) lines.push(`<status>${status}</status>`);
  lines.push(`<summary>${summary}</summary>`);
  if (event !== undefined) lines.push(`<event>${event}</event>`);
  if (result !== undefined) lines.push(`<result>${result}</result>`);
  lines.push('</task-notification>');
  return lines.join('\n');
}

function channelText({ body = 'Pushed from: origin=local device=desktop', attrs = {} } = {}) {
  const all = { source: 'web-chat', kind: 'batch', count: '0', seq: '1', origin: 'queue', ...attrs };
  const head = Object.entries(all).map(([k, v]) => `${k}="${escAttr(v)}"`).join(' ');
  return `<channel ${head}>\n${body}\n</channel>`;
}

function createRecords({
  seed = 1,
  sessionId,
  cwd = '/tmp/project',
  gitBranch = 'main',
  entrypoint = 'cli',
  version = CLAUDE_CODE_VERSION,
  start = DEFAULT_START,
  step = 1000,
  agentId,
} = {}) {
  const rand = mulberry32(seed);
  const pick = (alphabet, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  const uuid = () => {
    const h = pick(HEX, 32).split('');
    h[12] = '4';
    h[16] = HEX[8 + (HEX.indexOf(h[16]) & 3)];
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  const id = (prefix) => `${prefix}_01${pick(B62, 22)}`;

  const sid = sessionId || uuid();
  const records = [];
  const chain = new Map();          // uuid → record
  const toolOwner = new Map();      // tool_use id → the assistant record's uuid
  let leaf = null;
  let now = start;
  let ver = version;
  let lastPromptId = null;

  const stamp = () => { const t = new Date(now).toISOString(); now += step; return t; };
  const push = (rec) => { records.push(rec); return rec; };

  // A chain record: the core keys, then the kind's own, then the caller's extra.
  function link(type, fields, extra) {
    const rec = {
      parentUuid: leaf,
      isSidechain: agentId ? true : false,
      userType: 'external',
      cwd,
      sessionId: sid,
      version: ver,
      gitBranch,
      entrypoint,
      ...(agentId ? { agentId } : {}),
      type,
      ...fields,
      uuid: uuid(),
      timestamp: stamp(),
      ...(extra || {}),
    };
    chain.set(rec.uuid, rec);
    leaf = rec.uuid;
    return push(rec);
  }

  const userRec = (content, fields, extra) =>
    link('user', { message: { role: 'user', content }, ...fields }, extra);

  // A uuid-less metadata record: only its own keys.
  const meta = (type, fields = {}) => push({ type, ...fields, sessionId: sid });

  const r = {
    get records() { return records; },
    get leaf() { return leaf; },
    get lastPromptId() { return lastPromptId; },
    get sessionId() { return sid; },
    byUuid: (u) => chain.get(u) || null,
    uuid,
    id,
    tick(ms) { now += ms; return r; },
    at(ms) { now = ms; return r; },
    setVersion(v) { ver = v; return r; },
    branchFrom(u) {
      if (!chain.has(u)) throw new Error(`branchFrom: ${u} is not a chain record built here`);
      leaf = u;
      return r;
    },

    // ── openers ─────────────────────────────────────────────────────────────
    prompt(text, { promptId = uuid(), extra } = {}) {
      lastPromptId = promptId;
      return userRec(text, { promptId }, extra);
    },
    promptImage(text, { promptId = uuid(), png = TINY_PNG, mediaType = 'image/png', extra } = {}) {
      lastPromptId = promptId;
      const content = [
        { type: 'text', text },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(png).toString('base64') } },
      ];
      // origin / promptSource values guessed (the corpus kept their names only).
      return userRec(content, {
        imagePasteIds: [1], origin: { kind: 'human' }, permissionMode: 'default', promptSource: 'user', promptId,
      }, extra);
    },
    taskNotification({ promptId = uuid(), extra, ...opts } = {}) {
      lastPromptId = promptId;
      return userRec(taskNotificationText(opts), {
        origin: { kind: 'task-notification', producer: 'session-task' },
        permissionMode: 'default', promptSource: 'system', promptId,
      }, extra);
    },
    channel({ body, attrs, promptId = uuid(), extra } = {}) {
      lastPromptId = promptId;
      return userRec(channelText({ body, attrs }), {
        isMeta: true, origin: { kind: 'channel', server: 'web-chat' }, turnOrigin: 'peer',
        permissionMode: 'default', promptSource: 'system', queueSkipAttachments: true, promptId,
      }, extra);
    },
    slashCommand(name, args = '', { promptId = uuid(), extra } = {}) {
      lastPromptId = promptId;
      const text = `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
      return userRec(text, { promptId }, extra);
    },
    bashMode(input, { promptId = uuid(), extra } = {}) {
      lastPromptId = promptId;
      return userRec(`<bash-input>${input}</bash-input>`, { promptId }, extra);
    },
    bashOutput(stdout = '', stderr = '', { extra } = {}) {
      return userRec(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`, {}, extra);
    },

    // ── the assistant ───────────────────────────────────────────────────────
    assistant(blocks, {
      messageId = id('msg'), model = 'claude-opus-5-5', usage, effort = 'high', stopReason, requestId = id('req'), extra,
    } = {}) {
      const list = (Array.isArray(blocks) ? blocks : [blocks]).map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b));
      const u = usage || { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const out = [];
      list.forEach((b, i) => {
        const last = i === list.length - 1;
        let block;
        const recExtra = {};
        if (b.type === 'thinking') {
          block = { type: 'thinking', thinking: b.thinking || '', signature: b.signature || `fake-signature-${pick(HEX, 16)}` };
          if (b.durationMs !== undefined) recExtra.thinkingDurationMs = b.durationMs;
        } else if (b.type === 'tool_use') {
          block = { type: 'tool_use', id: b.id || id('toolu'), name: b.name, input: b.input || {}, caller: { type: 'direct' } };
        } else {
          block = { ...b };
        }
        const stop = last ? (stopReason || (block.type === 'tool_use' ? 'tool_use' : 'end_turn')) : null;
        const rec = link('assistant', {
          message: {
            model, id: messageId, type: 'message', role: 'assistant', content: [block],
            stop_reason: stop, stop_sequence: null, usage: u,
          },
          requestId, effort, ...recExtra,
        }, extra);
        if (block.type === 'tool_use') toolOwner.set(block.id, rec.uuid);
        out.push(rec);
      });
      return out;
    },
    apiErrorMessage(text = 'API Error: 529 overloaded', { status = 529, extra } = {}) {
      return link('assistant', {
        message: {
          model: '<synthetic>', id: id('msg'), type: 'message', role: 'assistant',
          content: [{ type: 'text', text }], stop_reason: 'stop_sequence', stop_sequence: '', usage: {},
        },
        isApiErrorMessage: true, apiErrorStatus: status,
      }, extra);
    },

    // ── tool results ────────────────────────────────────────────────────────
    toolResult(toolUseId, content = 'ok', {
      isError = false, denied = false, images, persistedOutputPath, persistedOutputSize, stdout, stderr,
      structuredPatch, filePath, taskId, agentId: resultAgentId, runId, toolUseResult, extra,
    } = {}) {
      let body = denied ? DENIED_TEXT : content;
      if (images) {
        const imgs = (images === true ? [TINY_PNG] : images).map((png) => ({
          type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') },
        }));
        body = [...(typeof body === 'string' ? [{ type: 'text', text: body }] : body), ...imgs];
      }
      const block = { tool_use_id: toolUseId, type: 'tool_result', content: body };
      if (isError || denied) block.is_error = true;
      let tur;
      if (denied) {
        tur = 'User rejected tool use';
      } else {
        tur = {};
        if (stdout !== undefined) tur.stdout = stdout;
        if (stderr !== undefined) tur.stderr = stderr;
        if (persistedOutputPath !== undefined) {
          tur.persistedOutputPath = persistedOutputPath;
          tur.persistedOutputSize = persistedOutputSize !== undefined ? persistedOutputSize : 40000;
        }
        if (structuredPatch !== undefined) {
          tur.filePath = filePath || '/tmp/project/lib/x.js';
          tur.structuredPatch = structuredPatch;
        }
        if (taskId !== undefined) tur.backgroundTaskId = taskId;
        if (resultAgentId !== undefined) tur.agentId = resultAgentId;
        if (runId !== undefined) tur.runId = runId;
        if (toolUseResult && typeof toolUseResult === 'object') Object.assign(tur, toolUseResult);
        else if (toolUseResult !== undefined) tur = toolUseResult;
      }
      const fields = { sourceToolAssistantUUID: toolOwner.get(toolUseId) || leaf };
      if (tur !== undefined && !(typeof tur === 'object' && Object.keys(tur).length === 0)) fields.toolUseResult = tur;
      return userRec([block], fields, extra);
    },

    // ── turn and session records ────────────────────────────────────────────
    turnDuration({ durationMs = 4200, messageCount = 4, extra } = {}) {
      return link('system', { subtype: 'turn_duration', durationMs, messageCount, isMeta: false }, extra);
    },
    compactBoundary({
      trigger = 'auto', preTokens = 150000, postTokens = 12000, durationMs = 30000,
      tailUuid, headUuid, anchorUuid, extra,
    } = {}) {
      const logical = leaf;
      leaf = null;   // a compaction starts a new root
      return link('system', {
        subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
        logicalParentUuid: logical,
        compactMetadata: {
          trigger, preTokens, postTokens, cumulativeDroppedTokens: preTokens - postTokens, durationMs,
          preservedSegment: { headUuid: headUuid || null, anchorUuid: anchorUuid || null, tailUuid: tailUuid || logical },
        },
      }, extra);
    },
    compactSummary(text = 'This session is being continued from a previous conversation.', { extra } = {}) {
      return userRec(text, { isCompactSummary: true, isVisibleInTranscriptOnly: true }, extra);
    },
    interrupt({ forToolUse = false, extra } = {}) {
      const text = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]';
      return userRec([{ type: 'text', text }], {}, extra);
    },
    localCommandOutput(stdout = '', { stderr, extra } = {}) {
      const text = stderr !== undefined
        ? `<local-command-stderr>${stderr}</local-command-stderr>`
        : `<local-command-stdout>${stdout}</local-command-stdout>`;
      return userRec(text, {}, extra);
    },
    localCommandCaveat({ extra } = {}) {
      return userRec('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>', { isMeta: true }, extra);
    },
    localCommand(command = 'clear', { content, extra } = {}) {
      return link('system', {
        subtype: 'local_command', content: content || `<command-name>/${command}</command-name>`,
        level: 'info', isMeta: false, commandRun: { command },
      }, extra);
    },
    awaySummary(text = 'While you were away: the build finished.', { extra } = {}) {
      return link('system', { subtype: 'away_summary', content: text, isMeta: false }, extra);
    },
    informational(text = 'Harness notice.', { level = 'info', extra } = {}) {
      return link('system', { subtype: 'informational', content: text, level, isMeta: false }, extra);
    },
    // No api_error was ever seen (drift summary: allowlisted, missing from the
    // corpus), so every field but `subtype` is guessed.
    apiError(text = 'API Error: 529 overloaded', { status = 529, extra } = {}) {
      return link('system', { subtype: 'api_error', content: text, level: 'error', isMeta: false, error: { status } }, extra);
    },

    // ── attachments ─────────────────────────────────────────────────────────
    attachment(type, fields = {}, { extra } = {}) {
      return link('attachment', { attachment: { type, ...fields } }, extra);
    },
    system(subtype, fields = {}, { extra } = {}) {
      return link('system', { subtype, ...fields }, extra);
    },
    user(content, { extra } = {}) {
      return link('user', { message: { role: 'user', content } }, extra);
    },
    queuedCommand(prompt, { commandMode = 'prompt', origin, extra } = {}) {
      const fields = { prompt, commandMode, timestamp: new Date(now).toISOString() };
      if (origin) fields.origin = origin;
      return r.attachment('queued_command', fields, { extra });
    },
    // `content` as an array of strings: guessed (the corpus kept the key only).
    hookAdditionalContext(content, { hookName = 'UserPromptSubmit', hookEvent = 'UserPromptSubmit', toolUseID, extra } = {}) {
      return r.attachment('hook_additional_context', {
        content: Array.isArray(content) ? content : [content], hookName, toolUseID: toolUseID || id('toolu'), hookEvent,
      }, { extra });
    },
    hookPermissionDecision(toolUseID, decision = 'allow', { hookEvent = 'PermissionRequest', extra } = {}) {
      return r.attachment('hook_permission_decision', { decision, toolUseID, hookEvent }, { extra });
    },
    skillListing({ isInitial = true, names = ['review', 'deploy'], descriptions = {}, content, extra } = {}) {
      const text = content !== undefined ? content
        : names.map((n) => `- ${n}: ${descriptions[n] || `The ${n} skill.`}`).join('\n');
      return r.attachment('skill_listing', { content: text, skillCount: names.length, isInitial, names }, { extra });
    },
    credentialOrg(organizationUuid = uuid(), { extra } = {}) {
      return r.attachment('credential_org', { organizationUuid }, { extra });
    },
    sessionContext({ userEmail = `user-${pick(HEX, 8)}@example.com`, rendered, extra } = {}) {
      return link('attachment', {
        attachment: { type: 'session_context', context: { userEmail } },
        rendered: rendered !== undefined ? rendered : `Session context for ${userEmail}`,
      }, extra);
    },

    // ── metadata records (uuid-less, not in the chain) ──────────────────────
    lastPrompt(opts = {}) {
      const fields = { leafUuid: Object.hasOwn(opts, 'leafUuid') ? opts.leafUuid : leaf };
      if (opts.lastPrompt !== undefined) fields.lastPrompt = opts.lastPrompt;
      if (opts.rewound !== undefined) fields.rewound = opts.rewound;
      return meta('last-prompt', fields);
    },
    queueOperation(operation = 'enqueue', { content, reason } = {}) {
      const fields = { operation, timestamp: stamp() };
      if (content !== undefined) fields.content = content;
      if (reason !== undefined) fields.reason = reason;
      return meta('queue-operation', fields);
    },
    aiTitle(aiTitle = 'Fix the build') { return meta('ai-title', { aiTitle }); },
    agentName(agentName = 'builder') { return meta('agent-name', { agentName }); },
    mode(mode = 'normal') { return meta('mode', { mode }); },
    permissionMode(permissionMode = 'default') { return meta('permission-mode', { permissionMode }); },
    costState(fields = {}) {
      return meta('cost-state', {
        hasUnknownModelCost: false, modelUsage: {}, startTime: start, totalAPIDuration: 1000,
        totalAPIDurationWithoutRetries: 1000, totalCostUSD: 0.42, totalDuration: 5000,
        totalLinesAdded: 3, totalLinesRemoved: 1, totalToolDuration: 800, ...fields,
      });
    },
    frameLink({ title = 'A page', frameUrl = 'https://example.com/frame/1', path = '/tmp/project/page.html', artifactCount = 1 } = {}) {
      return meta('frame-link', { artifactCount, timestamp: stamp(), frameUrl, path, title });
    },
    meta,
  };
  return r;
}

// ── files ──────────────────────────────────────────────────────────────────

function jsonl(records) {
  const flat = [];
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else flat.push(x); };
  walk(records);
  return flat.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)) + '\n').join('');
}

function cutPoints(len, splits) {
  return [...new Set((splits || []).map((n) => Math.floor(n)).filter((n) => n > 0 && n < len))].sort((a, b) => a - b);
}

function chunksOf(text, splits = []) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const out = [];
  let from = 0;
  for (const at of cutPoints(buf.length, splits)) { out.push(buf.subarray(from, at)); from = at; }
  out.push(buf.subarray(from));
  return out.filter((b) => b.length > 0);
}

function appendChunked(file, text, { splits = [], onChunk } = {}) {
  const chunks = chunksOf(text, splits);
  chunks.forEach((c, i) => {
    fs.appendFileSync(file, c);
    if (onChunk) onChunk(i, c);
  });
  return chunks.length;
}

async function appendChunkedAsync(file, text, { splits = [], between } = {}) {
  const chunks = chunksOf(text, splits);
  for (let i = 0; i < chunks.length; i++) {
    fs.appendFileSync(file, chunks[i]);
    if (between && i < chunks.length - 1) await between(i, chunks[i]);
  }
  return chunks.length;
}

// Offsets inside a multibyte character: every byte position that is a UTF-8
// continuation byte (10xxxxxx).
function midCharOffsets(text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const out = [];
  for (let i = 1; i < buf.length; i++) if ((buf[i] & 0xc0) === 0x80) out.push(i);
  return out;
}

function randomSplits(text, { seed = 1, count = 4 } = {}) {
  const len = Buffer.isBuffer(text) ? text.length : Buffer.byteLength(text, 'utf8');
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count && len > 1; i++) out.push(1 + Math.floor(rand() * (len - 1)));
  return cutPoints(len, out);
}

module.exports = {
  createRecords,
  jsonl,
  chunksOf,
  appendChunked,
  appendChunkedAsync,
  midCharOffsets,
  randomSplits,
  taskNotificationText,
  channelText,
  TINY_PNG,
  CLAUDE_CODE_VERSION,
};
