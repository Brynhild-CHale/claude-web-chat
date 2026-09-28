# README media

This directory records the README's replay clips, `.github/media/flow.gif` and
`.github/media/replay.gif`. It is dev-only. `scripts/` is not in package.json's
`files` allowlist, and `test/release-build.test.js` fails if it ever ships.

```sh
WEB_CHAT_CHROME=/path/to/chrome node scripts/readme-media/record.js --out .github/media
```

| file | what it is |
| --- | --- |
| `record.js` | Entry point. It boots this checkout's daemon in-process on a throwaway project with a throwaway `HOME` (under the OS temp dir), drives the story, records the clips, then stops the daemon and deletes the scratch files. |
| `story.js` | The demo: choosing a cache for an orders API. It holds the pages, the turns that make the graph (`drive`), and the two clip scripts (`FLOW`, `REPLAY`). |
| `browser.js` | A headless page over `lib/replay/chrome`'s launcher, plus a screen recorder that encodes through `lib/replay/encode`. |

## Options

- `flow` / `replay` records only that clip. With no clip named, it records both.
- `--out <dir>` sets where the GIFs go. The default is a fresh temp dir, and its path is printed.
- `--keep` keeps the scratch project and `HOME`, and prints their path.

## What you need

- A Chrome-family browser. `lib/replay/find` looks for one. Point
  `WEB_CHAT_CHROME` at a binary if it finds none. A Chrome for Testing build works.
- ffmpeg on `PATH`, or pointed to by `WEB_CHAT_FFMPEG`. Without it both clips fall
  back to the built-in encoder and come out larger.

## The clips

- **flow.gif** is web-chat's own scripted replay render (`POST /api/replay/render`
  with `story.FLOW`). The page is drawn at 1280×800 and written at 960×600, at
  20 fps so the scroll moves stay smooth. It covers n1.0 → n1.2.
- **replay.gif** records the live chrome at 1280×800 and 0.75 scale while Claude opens
  a directed replay in it (`POST /api/replay/open` with `story.REPLAY`, the call
  behind `export({script, open: true})`). It covers n1.0 → n1.1 → the n1.1.0 / n1.1.1 branch.

Each replay step scrolls to what the step changed (see "Each step scrolls to what
changed" in `docs/export-pages.md`). A scroll only shows when the change starts
below the fold. That is why the first page carries a traffic chart and the
recommendation carries a second row. `test/readme-media.test.js` drives the
story without a browser. It fails if a flow step's first scroll target is
something the step before already showed.

## After re-recording

- Each GIF must stay under 2.5 MB (`test/doc-truth.test.js`).
- Pull a few frames and look at them before committing:
  `ffmpeg -i .github/media/flow.gif -fps_mode passthrough /tmp/f/%03d.png`.
- If the story changed, update the README's alt text for the clip.

`graph.gif` and `component-install.gif` are not made here. They drive the chrome
by hand over CDP (the graph screen, and a pack installed through ＋ → Manage
against `test-support/fake-gh.js`). Commit 57912ec describes how they were made.
