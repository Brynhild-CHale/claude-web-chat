#!/bin/sh
# "Stop after this step" from the web-chat page: the halt handlers.
#
# Registered three times, synchronously (templates/settings.hooks.json):
#
#   PreToolUse     sh ".../claude-web-chat-hook-halt.sh" pre
#   PostToolUse    sh ".../claude-web-chat-hook-halt.sh" post
#   PostToolBatch  sh ".../claude-web-chat-hook-halt.sh" batch
#
# It runs on EVERY tool call, so it is POSIX sh, not Node: about 3 ms against
# about 65 ms for a Node hook. Without a live flag it prints nothing and exits 0,
# which tells Claude Code nothing at all. With one, it stops the turn at the
# next tool boundary:
#
#   pre          {"continue":false, …, "permissionDecision":"deny", …}
#                (continue:false alone does not block the next tool; deny does)
#   post, batch  {"continue":false, …}
#                (PostToolUseFailure ignores continue:false, so it has no handler)
#
# The flag is $HOME/.web-chat/halt/<session id> (userPaths().haltFlag in
# lib/core/paths.js) holding an epoch-seconds expiry. The daemon's control
# domain writes it for one session and removes it when that session's turn
# closes; an expired flag is ignored here, so a flag left behind can never stop
# a later turn. CLAUDE_CODE_SESSION_ID is set by Claude Code in every hook's
# environment and equals the payload's session_id.
#
# It reads CLAUDE_CODE_SESSION_ID, HOME and the flag, and writes nothing. The
# payload on stdin is read and dropped (never parsed), so Claude Code's write of
# a large tool input or response never meets a closed pipe.
#
# The name keeps the claude-web-chat-hook token: that token is how every reader
# of .claude/settings.json (lib/update/managed-files.js, lib/setup/registration.js)
# recognises a web-chat handler.

# Drop the payload and leave: exit 0, printing nothing more. Never from a
# terminal, where reading stdin would wait for the user.
finish() {
  [ -t 0 ] || cat >/dev/null 2>&1
  exit 0
}

case ${1:-} in
  pre|post|batch) ;;
  *) finish ;;
esac

# A session id is a UUID; anything that could leave the halt directory is not one.
sid=${CLAUDE_CODE_SESSION_ID:-}
case $sid in
  ''|*[!A-Za-z0-9_-]*) finish ;;
esac
[ -n "${HOME:-}" ] || finish
flag=$HOME/.web-chat/halt/$sid
[ -f "$flag" ] || finish

# The expiry: decimal epoch seconds on the first line. Anything else is not a flag.
expiry=
read -r expiry 2>/dev/null < "$flag"
case $expiry in
  ''|*[!0-9]*) finish ;;
esac
[ ${#expiry} -le 12 ] || finish
now=$(date +%s 2>/dev/null)
case $now in
  ''|*[!0-9]*) finish ;;
esac
[ "$expiry" -gt "$now" ] || finish

if [ "$1" = pre ]; then
  printf '%s\n' '{"continue":false,"stopReason":"Stopped from the web-chat page","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user stopped this turn from the web-chat page."}}'
else
  printf '%s\n' '{"continue":false,"stopReason":"Stopped from the web-chat page"}'
fi
finish
