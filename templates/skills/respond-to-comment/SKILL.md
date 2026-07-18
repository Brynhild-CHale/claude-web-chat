---
name: respond-to-comment
description: Reply to a user's comment pin on the web-chat surface — the Google-Docs-style markup thread. Use when a channel wake or get_comments surfaces a comment the user pinned to a rendered element and you should answer in-thread (not in chat). Triggers - a `[comment]` wake line, a `respond_hint` pointing here, or the user saying they left a comment/note on the surface.
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
   only new/updated threads. `respond_hint` on each item points back here.

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

## Etiquette

- **One reply per turn per thread**, unless the user has replied since.
- **Don't restate their comment** back to them — they can see it.
- **Match the register**: terse, concrete, doc-comment tone. No preamble.
- **Multiple pins** → handle each thread, replying with its own `id`.
- **Don't over-render.** If the change is visual, re-render the affected mount and point at
  it; don't spin up a new explainer pane.
- Private pins never reach you (only shared ones do) — everything you see is fair to answer.
