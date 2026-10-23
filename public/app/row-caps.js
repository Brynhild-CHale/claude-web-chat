// ROW CAPS for element rows (PLAN.md 2A.4; readiness R2 §3 row 12; verdict
// S-19). The annotation engine's elements reach three chrome lists: the ⌘K
// palette (shell.js registerPaletteSource), the queue rail and the graph
// inspector. Each list is rebuilt whole — the palette on every keystroke — and
// S-19 read 5.6 ms per keystroke at 500 rows and 21.7 ms at 2000, so a list of
// elements is never drawn unbounded: it shows ELEMENT_ROW_CAP rows and one
// '+N more — type to narrow' row for the rest.
//
//   ELEMENT_ROW_CAP          1000 — between S-19's 500 and 2000 readings.
//   capRows(list, cap?)      → {rows, more}: the first `cap` rows, and how many
//                            were left out (0 when the list fits).
//   moreLabel(n)             the one wording of the row that stands for them.
//
// The rail needs no cap of its own: the daemon bounds the queue at MAX_QUEUE
// (lib/server/domain/queue.js), which is at most this cap — a test holds that
// relation, so raising MAX_QUEUE past it fails the build instead of drawing an
// unbounded rail.

export const ELEMENT_ROW_CAP = 1000;

export function capRows(list, cap = ELEMENT_ROW_CAP) {
  const all = Array.isArray(list) ? list : [];
  const n = Number.isInteger(cap) && cap >= 0 ? cap : ELEMENT_ROW_CAP;
  if (all.length <= n) return { rows: all.slice(), more: 0 };
  return { rows: all.slice(0, n), more: all.length - n };
}

export const moreLabel = (n) => `+${n} more — type to narrow`;
