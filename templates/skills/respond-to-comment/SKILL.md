---
name: respond-to-comment
description: Reply to a user's comment pin on the web-chat surface — the Google-Docs-style markup thread, on the page or in the chat. Use when a channel wake or get_comments surfaces a comment the user pinned to a rendered element, a markdown section, another annotation or a part of the chat (a chat pin), and you should answer in-thread (not in chat). Triggers - a `[comment]` or `[element]` wake line naming a comment or a chat pin, a `respond_hint` pointing here, or the user saying they left a comment/note on the surface or in the chat.
---

# Responding to comment pins

The user leaves **comment pins** on the web-chat surface: they click an element on a
rendered pane and type a note, anchored to that spot — like a margin comment in Google
Docs or Word. Each pin is a **thread** you and the user pass back and forth. Your job is to
answer **in the thread**, not in chat.

## The loop

1. **Read the thread.** `get_comments` (shared pins only) returns each pin as
   `{ id, text, anchor_label, replies:[{author,text,at}], ... }`. `text` is the user's
   opening note; `anchor_label` says what it's pinned to (e.g. `plan: "Timeline"`);
   `replies` is the conversation so far. Pass `since` (the prior `next_cursor`) to fetch
   only new/updated threads. With no `type`, it lists the page's comments and the chat's
   pins together (see *Chat pins* below). `respond_hint` (one top-level field, not per pin) points
   back here. Both tools go through web-chat's element API, where a comment pin is one
   element type among others.

2. **Do what the comment asks.** A pin usually asks for a **change** to what's on screen
   ("this is too aggressive", "wrong colour") or a **question** about it. Make the change
   first — edit code, re-render the mount, whatever it calls for — *then* reply. A reply
   with no action behind it is noise.

3. **Reply in-thread with `reply_comment({ id, text })`.** Keep it **short and specific —
   a margin note, not an essay.** Say what you did and point at it:
   *"Shortened to 6 weeks and moved QA parallel — see the revised box."* Your reply posts
   under the user's note; the pin's marker turns green so they know you answered.

4. **Continue until resolved.** The user's reply re-wakes you (it enqueues to the rail like
   a new pin). Read the new message, act, reply again. Stop when the thread is settled or
   the user moves on — don't leave a reply hanging with an open question unless you're
   genuinely blocked.

## What a pin is on

- **A point of a pane** — `anchor_label` like `plan: "Timeline"`.
- **A point on an image, an svg or a canvas** — `anchor.kind` is `'point'`, with `x` and
  `y` (0 to 1 across and down that target) and its `aspect`. The `anchor_label` names the
  pane and the target's own text when it has some (`chart: "Q1 Q2 Q3"`), else
  `chart (whole pane)`: it does not say where, so read `x` and `y` — `x: 0.8, y: 0.1` is the
  top right of the chart.
- **A word** — a tap on text pins that word as a range: `anchor.quote.exact` is the word,
  and the `anchor_label` quotes it (`notes: "deadline"`). Answer about that word where it
  stands.
- A comment whose glyph the user dragged away from its spot (a leader line ties it back) is
  still about its anchor; only the glyph moved.
- **A markdown item** — `md-2: on section "Options"` for a pin on the heading itself,
  `md-2: "the words…" — on section "Options"` for one on prose. Answer about that section.
- **Other annotations** — a comment made over a highlight, a box grab or another comment
  also carries `chain` and `chain_label`, e.g. `on highlight h7 › box grab g3 › pane m1 ›
  section "Options"`: the comment is about those elements, smallest first. A member the
  user keeps private reads `a private element` (no type, no id) — don't ask what it is.

## Strokes under or beside a comment

An element pack's strokes tool (ink) draws free-form strokes, private by default. A comment
made over a shared stroke group names it in its `chain` (`on ink p12 › pane m1`). Before you
ask for a picture of the strokes, read what they already say in words: the group's queue
item and its records describe it — `shape` (circle, underline, strike, arrow, check, cross
or other) with its `confidence`, `count` (how many strokes), `bbox` (where they sit in the
target, 0 to 1) and `text_under`, the words the strokes were drawn over. A circle round
"Q3" with a note asking "why?" needs no picture. Ask for one only when the words and the
shape do not answer: `inspect_capture({capture_id: 'element:<id>'})` on one of the group's
elements draws it and returns it beside the clipped HTML. A private stroke never reaches
you, and its member reads `a private element`.

## Chat pins

A **chat pin** (`type: 'chat-comment'`) is a comment on the chat, not the page: on a turn,
a passage of a prompt, reply or thinking block, a tool card, or a line of a turn's code diff
(`anchor_label` like `on turn 3's reply: "…"`, `on tool card Bash`,
`on diff line lib/x.js:42`). `get_comments({type: 'chat-comment'})` reads them alone, and
`reply_comment({ id, text })` answers one in its thread exactly as for a page comment (a chat
pin's id starts with `k`). Each carries `visible` — where it stands now — and `explain`, the
one line the user sees for it:

- `placed` — Pinned here.
- `refused` — This reply is still arriving — pin it once the transcript has it.
- `superseded` — This turn was rewound in the terminal; the pin stays on the turn it was made on.
- `masked` — The pinned words now hold a value web-chat hides; the pin covers the hidden part and never shows it.
- `indexing` — This conversation is being read; the pin places when that is done.
- `unavailable` — What this pin was on is no longer on this machine; its quote is kept.

When a chat pin is not `placed`, answer it from its `quote` (`quote.exact` is the pinned
words, masked where they hold a value web-chat hides) and its `anchor_label` — never ask the
user to re-pin it. An `unavailable` pin is still listed, with its quote: what it was on has
left this machine, so answer from what it quotes. A pin whose whole conversation has left
the chat is still listed; the user finds those under ⌘K **Chat pins no longer in a chat (n)**.

## Etiquette

- **One reply per turn per thread**, unless the user has replied since.
- **Don't restate their comment** back to them — they can see it.
- **Match the register**: terse, concrete, doc-comment tone. No preamble.
- **Multiple pins** → handle each thread, replying with its own `id`.
- **Don't over-render.** If the change is visual, re-render the affected mount and point at
  it; don't spin up a new explainer pane.
- Private pins never reach you (only shared ones do) — everything you see is fair to answer.
- If `get_comments` or `reply_comment` answers that web-chat's comment API moved, this
  Claude Code session loaded the tools before an upgrade: tell the user to `/exit` and
  reopen Claude Code, and answer the comment once it is back.
