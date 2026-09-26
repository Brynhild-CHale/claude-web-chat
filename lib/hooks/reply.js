// What Claude said at the end of this turn, read from the Stop hook's payload.
//
// Claude Code hands the Stop hook `last_assistant_message` — the final reply's
// text — on the versions that have it. Older ones hand only `transcript_path`,
// the session's JSONL transcript, so that is the fallback: read the file's TAIL
// (never the whole thing — a long session's transcript runs to megabytes) and
// take the final assistant text of the current turn.
//
// Everything here is best-effort. A reply summary is a caption, not provenance:
// if the payload has neither field, the file is missing or torn, or the format
// has moved on, the answer is '' and turn-end simply commits without one.

const fs = require('fs');
const { summarizeReply } = require('../core/reply');

// How much of the transcript's end is read. The final reply is the last few
// lines; this leaves room for a long one plus the tool results before it.
const TAIL_BYTES = 1024 * 1024;

function readTail(file, max = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function textOf(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// A `user` entry that is the person typing (not a tool_result Claude Code
// records under role user) marks the start of the current turn: walking back
// past it would pick up the PREVIOUS turn's reply.
function isPrompt(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((b) => b && b.type !== 'tool_result');
}

// The final assistant text of the current turn, from a JSONL transcript. One
// reply can be recorded as several lines (one per content block, sharing a
// message id), so the text blocks of the last text-bearing message are joined.
// Sidechain (subagent) entries are not the reply.
function lastAssistantText(file, { tailBytes = TAIL_BYTES } = {}) {
  const lines = readTail(file, tailBytes).split('\n');
  const parts = [];
  let msgId;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // the tail's first line may be cut
    if (entry.isSidechain) continue;
    if (isPrompt(entry)) break;
    if (entry.type !== 'assistant') continue;
    const id = entry.message && entry.message.id;
    if (parts.length && id !== msgId) break;
    const text = textOf(entry);
    if (!text.trim()) { if (parts.length) break; continue; }
    msgId = id;
    parts.unshift(text);
    if (id === undefined) break; // no id to group by: one line is the reply
  }
  return parts.join('\n');
}

// replySummary(payload) → the summarised reply, or '' when there is none.
function replySummary(payload = {}, opts = {}) {
  try {
    const direct = payload.last_assistant_message;
    if (typeof direct === 'string' && direct.trim()) return summarizeReply(direct);
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      return summarizeReply(lastAssistantText(payload.transcript_path, opts));
    }
  } catch {}
  return '';
}

module.exports = { replySummary, lastAssistantText, TAIL_BYTES };
