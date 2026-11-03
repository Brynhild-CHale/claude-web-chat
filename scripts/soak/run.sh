#!/bin/bash
# scripts/soak/run.sh — the one command a runner's soak_cmd names (H.11, U579).
#
#   SOAK_SH=/abs/path/to/soak.sh scripts/soak/run.sh --int <worktree> --out <dir> \
#       [--minutes 15] [--port-base N] [--interval 30] [--cache DIR]
#
# Runs the workflow-shape skill's soak.sh template (handed in as SOAK_SH, never
# copied into this repository) over the int worktree's own scripts/soak/
# commands — start.js, drive.js, sample.js, stop.js — with
# scripts/soak/thresholds.json resolved into <out>/thresholds.json (its two
# run-time bounds filled in) and the report at <out>/report.json.
#
# Isolation: a fresh --root is made under --out per run (one daemon per root:
# a shared root is a false failure), HOME / USERPROFILE / CLAUDE_CONFIG_DIR sit
# inside it, and the band is --port-base (or SOAK_PORT_BASE, default 6400):
# the daemon at N, its hub at N+1. lib.js refuses a band in 5173-5272 or on
# 5170, and a HOME that is the real home, with exit 2.
#
# Exit: soak.sh's (0 every judged counter passed, 1 a FAIL), or 2 for a usage
# error or a refusal before it starts.
set -u

usage() { echo "usage: SOAK_SH=<soak.sh> $0 --int <worktree> --out <dir> [--minutes 15] [--port-base N] [--interval 30] [--cache DIR]" >&2; exit 2; }

INT=""; OUT=""; MIN=15; INTERVAL=30; PORT_BASE="${SOAK_PORT_BASE:-6400}"; CACHE=""
while [ $# -gt 0 ]; do case "$1" in
  --int) INT=${2:-}; shift 2 || usage;; --out) OUT=${2:-}; shift 2 || usage;;
  --minutes) MIN=${2:-}; shift 2 || usage;; --port-base) PORT_BASE=${2:-}; shift 2 || usage;;
  --interval) INTERVAL=${2:-}; shift 2 || usage;; --cache) CACHE=${2:-}; shift 2 || usage;;
  -h|--help) usage;;
  *) echo "run.sh: unknown argument $1" >&2; usage;; esac; done

if [ -z "${SOAK_SH:-}" ]; then
  echo "run.sh: SOAK_SH is not set — name the workflow-shape skill's scripts/soak.sh template by its absolute path (the runner hands it in)" >&2
  exit 2
fi
case "$SOAK_SH" in /*) ;; *) echo "run.sh: SOAK_SH=$SOAK_SH is not an absolute path" >&2; exit 2;; esac
[ -f "$SOAK_SH" ] || { echo "run.sh: SOAK_SH=$SOAK_SH does not exist" >&2; exit 2; }
[ -n "$INT" ] && [ -n "$OUT" ] || usage
[ -d "$INT/scripts/soak" ] || { echo "run.sh: --int $INT has no scripts/soak/" >&2; exit 2; }
case "$MIN" in ''|*[!0-9]*) echo "run.sh: --minutes $MIN is not a whole number" >&2; exit 2;; esac
case "$INTERVAL" in ''|*[!0-9]*) echo "run.sh: --interval $INTERVAL is not a whole number" >&2; exit 2;; esac

INT=$(cd "$INT" && pwd -P) || exit 2
mkdir -p "$OUT" || exit 2
OUT=$(cd "$OUT" && pwd -P) || exit 2
ROOT=$(mktemp -d "$OUT/root.XXXXXX") || exit 2
S="$INT/scripts/soak"
NODE=$(command -v node) || { echo "run.sh: no node on PATH" >&2; exit 2; }

echo "run.sh: int $INT · out $OUT · root $ROOT · minutes $MIN · port base $PORT_BASE · node $($NODE --version)"
"$NODE" "$S/lib.js" prepare --root "$ROOT" --out "$OUT" --port-base "$PORT_BASE" || exit $?
FIXTURE_ARGS=(--root "$ROOT" --int "$INT")
[ -n "$CACHE" ] && FIXTURE_ARGS+=(--cache "$CACHE")
"$NODE" "$S/fixture.js" "${FIXTURE_ARGS[@]}" || { echo "run.sh: the fixture failed" >&2; exit 2; }
"$NODE" "$S/lib.js" thresholds --root "$ROOT" --file "$S/thresholds.json" --write "$OUT/thresholds.json" || exit $?

# Each command a simple one, so soak.sh's `bash -c` execs node in place and its
# kill of the drive reaches the drive itself.
cmd() { printf '%q %q --root %q' "$NODE" "$S/$1" "$ROOT"; }

exec bash "$SOAK_SH" --out "$OUT" --minutes "$MIN" --interval "$INTERVAL" --root "$ROOT" \
  --start "$(cmd start.js)" --drive "$(cmd drive.js)" --sample "$(cmd sample.js)" --stop "$(cmd stop.js)" \
  --thresholds "$OUT/thresholds.json" --json "$OUT/report.json"
