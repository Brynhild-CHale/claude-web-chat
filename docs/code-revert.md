# Restore files (code revert)

The chat mirror records what each Claude Code turn changed in your project's
files. **Restore files** puts the working tree back to how it was before a turn
(or a graph node), and **Undo** puts it back again. This page says what it
touches, what it never touches, when it refuses, and what Claude is told.

Read it from the terminal with `claude-web-chat docs code-revert`.

## Where it comes from

Every turn that runs a tool gets a snapshot of the working tree before it and
after it. The snapshots live in a private git store under
`.web-chat/mirror/git/`, which borrows your repository's objects and never
writes your repository's `.git`. A turn's record (its files, its counts, and
the trees and HEAD commit beside each snapshot) is what Restore files reads.

- **A turn** restores to its own before-snapshot ("before this turn"). A turn
  that changed no files, or whose record is not ready yet, has nothing to
  restore to: the preview says *the turn changed no files, or its record is
  not ready*.
- **A node** in the graph restores to the before-snapshot of its first turn
  that changed files.
- Snapshots are kept for 7 days. An older target is refused: *the snapshot was
  pruned*.

## The preview

Before anything changes, the page shows a preview (`GET /api/code/preview`,
readable at the mirror's `read` level, its paths redacted like the diffs):

- the files that will be **rewritten**, **re-created** (they existed then and
  are gone now) and **deleted** (they were created since);
- the files it will **not cover**, each with its reason (below);
- a notice when **HEAD has moved** since that snapshot: commits are kept, only
  the files on disk go back;
- and, plainly: **edits made since that turn, yours included, are reverted
  too.** A file you changed by hand after the turn goes back with the rest.

The preview is bound to the working tree as it was when the preview was made.
If any file changes after that, the restore is refused as **stale** and nothing
is written: open Restore files again to see what it would do now. A preview
expires after 10 minutes.

## What it never touches

| Never touched | Why |
| --- | --- |
| HEAD, branches, tags, the index, refs, objects and config of your repository | Restore files writes only the working tree; it never runs checkout, reset, stash or commit in your project. |
| Ignored files | A path your ignore rules ignore now is listed as *ignored*, never written. |
| Files outside the project root | A path that leads out (a symlinked directory, say) is listed as *outside*. So is anything under `.web-chat/`. |
| Untracked files over the size cap | They were never snapshot (*over-cap*), so there is nothing to put back. |
| Files the redactor treats as sensitive | An untracked file such as a key file is never snapshot (*sensitive*). |
| Nested repositories and git worktrees | Their contents are not in the snapshot, only a pointer to them (*nested-repo*). They are listed and never written part way. |

## When it refuses

The confirm is refused, with the reason on the button, while:

- **the graph is locked**: a turn is in progress. Wait for it to end; a lock
  left behind by a crash is cleared with `claude-web-chat unlock`;
- **Claude is busy**: a conversation of this project is working, waiting on
  you, asking you a question or compacting;
- **a session in a subdirectory is busy**: `claude agents --json` lists a
  session whose directory is inside the project and is not idle. The message
  names only its path inside the project. When `claude` is not found this
  check is skipped, and the preview says so; when its answer cannot be read,
  or takes longer than 3 seconds, the restore is refused (*retry, or stop the
  session in the terminal*);
- **the files changed since the preview** (*stale*).

Restore and Undo each run at most once every 5 seconds. Both are buttons in a
confirm frame served by web-chat's answer origin, never by the page itself, so
a pane cannot press them. On a remote surface they need the project's `full`
mirror level.

## Undo

Every restore first keeps a **safety snapshot** of the files as they were, so
Undo puts back exactly that, including any file the restore deleted. The last
20 restores keep theirs; an older one cannot be undone. An undo is itself kept
the same way.

Undo is refused as **stale** when files changed after the restore: it never
silently reverts newer edits. If a restore could not write every file (a
permission error, say), it says which ones and offers Undo, which puts
everything back.

Each restore and undo is recorded in `.web-chat/control/restores.json` (ids,
trees and the lists of paths, never file contents) and in the control audit
log.

## What Claude is told

Claude Code only notices a modified file it had already read, and never a
deleted one. So after a restore or an undo, web-chat keeps one notice for the
conversation of the restored turn, added to Claude's context once, at the start
of its next turn:

> **Files restored from the web-chat page** to before turn n1.4 (…).
> Rewritten: … Deleted: … Re-created: …
> Read a file again before you edit it.

It lists paths only, never contents, at most 40 per list. An undo replaces a
notice Claude has not seen yet instead of adding a second one, and nothing is
added when nothing was restored.

## Requirements and switches

- **git 2.40 or newer.** Older git cannot snapshot a file's exact bytes
  (`--attr-source`), so Restore files is unavailable there (*git-too-old*).
- **A git repository.** Restore files is unavailable in a project that is not
  one (*not-a-git-repo*); support for that is deferred.
- **Per-turn diffs on.** `WEB_CHAT_MIRROR_DIFFS=0` turns the snapshots off, and
  with them Restore files (*diffs-off*).
- Until the first turn of a project has been snapshot there is nothing to
  restore (*no-snapshots*).

When Restore files is unavailable the buttons are not shown; the reason is the
one in parentheses above.
