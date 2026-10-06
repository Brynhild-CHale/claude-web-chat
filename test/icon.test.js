// lib/core/icon — the image pipeline a project's logo and favicon go through,
// and the dark variant (spec §9.6, D11).
//
// The acceptance is pixel equality with the reference: web-chat-dev's own icon
// (test/fixtures/icon, copied byte for byte from design/assets) gives back its
// transparent, tile and touch variants exactly, and darkVariant gives back the
// three dark files glint.js's variant A wrote. The rest pins each step on
// synthetic inputs: grid recovery from a noisy source, smooth art, the shape
// rules, the tile colour, every refusal, and the size step-down.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const icon = require('../lib/core/icon');
const { decodePng } = require('../lib/core/png');
const { validate, MAX_BYTES } = require('../lib/core/brand-image');
const { encodePng, rawPng, chunk } = require('../test-support/png-encode');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'test', 'fixtures', 'icon');
const read = (...p) => fs.readFileSync(path.join(...p));
const ICON = read(FIX, 'web-chat-dev-icon.png');
const ICON_DARK = read(FIX, 'web-chat-dev-icon-dark.png');
const TILE = read(FIX, 'web-chat-dev-icon-tile.png');
const TILE_DARK = read(FIX, 'web-chat-dev-icon-tile-dark.png');
const FAVICON = read(REPO, 'public', 'favicon.png');
const FAVICON_DARK = read(REPO, 'public', 'favicon-dark.png');
const TOUCH = read(REPO, 'public', 'apple-touch-icon.png');

const sameImage = (a, b) => a.width === b.width && a.height === b.height && a.data.equals(b.data);
const asPng = (im) => encodePng(im.data, im.width, im.height);

// Every result's variants: valid, and the touch icon a 180 px opaque square.
function checkVariants(r) {
  for (const [name, v] of Object.entries(r.variants)) {
    assert.equal(validate(v.bytes), 'png', `${name} passes validate`);
    assert.ok(v.bytes.length <= MAX_BYTES);
    assert.ok(sameImage(decodePng(v.bytes), v.image), `${name}'s bytes are its image`);
  }
  const t = r.variants.touch.image;
  assert.deepEqual([t.width, t.height], [icon.TOUCH_SIDE, icon.TOUCH_SIDE]);
  for (let i = 3; i < t.data.length; i += 4) assert.equal(t.data[i], 255, 'the touch icon is opaque');
  for (let i = 3; i < r.variants.tile.image.data.length; i += 4) assert.equal(r.variants.tile.image.data[i], 255, 'the tile is opaque');
}

// A seeded generator (mulberry32), so every synthetic input is the same each run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h, rgba = [0, 0, 0, 0]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

// An ellipse filling (cx ± rx, cy ± ry), 4×4 supersampled, coloured by `paint`
// (x, y in 0..1 across the ellipse) and composited over what is there.
function ellipse(im, cx, cy, rx, ry, paint) {
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = (x + (sx + 0.5) / 4 - cx) / rx; const dy = (y + (sy + 0.5) / 4 - cy) / ry;
          if (dx * dx + dy * dy <= 1) cover++;
        }
      }
      if (!cover) continue;
      const a = cover / 16;
      const c = paint((x - cx + rx) / (2 * rx), (y - cy + ry) / (2 * ry));
      const i = (y * im.width + x) * 4;
      const da = im.data[i + 3] / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) im.data[i + k] = Math.round((c[k] * a + im.data[i + k] * da * (1 - a)) / oa);
      im.data[i + 3] = Math.round(oa * 255);
    }
  }
  return im;
}
const gradient = (u, v) => [Math.round(200 - 160 * u), Math.round(40 + 60 * v), Math.round(120 + 100 * u)];

// ── the reference ────────────────────────────────────────────────────────────

test('the fixtures are the reference files, byte for byte', () => {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(sha(ICON), '0eeaecc793644b2feb766b13a8153af5c547ef3ae2b040007dbbad7faf7b2423');
  assert.equal(sha(ICON_DARK), 'e33120e9a470673caabd5a4b5a022ff5a038e1f478eae0155ce551d7e3dbfeab');
  assert.equal(sha(TILE), '1a129adfff7d8f5a84c9650aef8fbdd8b35ae42d585581c47a95ec7ec4686bf3');
  assert.equal(sha(TILE_DARK), 'ac0c54e3bfbd8f887303f4c7f08dce24aa3ec2e69555959ddf92b01639377a18');
  assert.deepEqual([decodePng(ICON).width, decodePng(ICON).height], [170, 170]);
  assert.deepEqual([decodePng(TILE).width, decodePng(TILE).height], [190, 190]);
});

test('the reference icon gives back its transparent, tile and touch variants pixel for pixel', () => {
  const r = icon.prepare(ICON, { kind: 'logo' });
  assert.equal(r.format, 'png');
  assert.equal(r.pixel_art, true);
  assert.equal(r.source_cell, 5);
  assert.equal(r.scale, 5);
  assert.equal(r.cell, 5);
  assert.equal(r.square, true);
  assert.equal(r.background, 'transparent');
  assert.ok(sameImage(r.variants.transparent.image, decodePng(ICON)), 'transparent = the input');
  assert.ok(sameImage(r.variants.tile.image, decodePng(TILE)), 'tile = web-chat-dev-icon-tile.png');
  assert.deepEqual(r.variants.tile.colour, [0, 0, 0], 'black, as the reference tile is');
  assert.ok(sameImage(r.variants.touch.image, decodePng(TOUCH)), 'touch = public/apple-touch-icon.png');
  checkVariants(r);
  assert.ok(r.notes.some((n) => /5 px grid/.test(n)), r.notes.join(' | '));
});

test('the same icon as a favicon, and the 32 px favicon (a native sprite), give the same variants', () => {
  const asFavicon = icon.prepare(ICON, { kind: 'favicon' });
  assert.ok(asFavicon.variants.transparent.bytes.equals(icon.prepare(ICON, { kind: 'logo' }).variants.transparent.bytes));
  const fromFavicon = icon.prepare(FAVICON, { kind: 'favicon' });
  assert.equal(fromFavicon.pixel_art, true);
  assert.equal(fromFavicon.source_cell, 1);
  assert.equal(fromFavicon.cell, 5);
  assert.ok(sameImage(fromFavicon.variants.transparent.image, decodePng(ICON)), 'one pixel a cell, upscaled ×5');
  assert.ok(sameImage(fromFavicon.variants.touch.image, decodePng(TOUCH)));
});

test('detectCell reads the cell of each reference without being told', () => {
  assert.equal(icon.detectCell(decodePng(ICON)), 5);
  assert.equal(icon.detectCell(decodePng(TILE)), 5);
  assert.equal(icon.detectCell(decodePng(FAVICON)), 1);
});

test('darkVariant reproduces glint.js variant A on the icon, the tile and the favicon', (t) => {
  let sameBytes = 0;
  for (const [light, dark, cell] of [[ICON, ICON_DARK, 5], [TILE, TILE_DARK, 5], [FAVICON, FAVICON_DARK, 1]]) {
    for (const opts of [{ cell }, {}]) {
      const d = icon.darkVariant(decodePng(light), opts);
      assert.deepEqual(d.hues, { major: 239.7, minor: 57.2 });
      assert.ok(sameImage(d.image, decodePng(dark)), `cell ${cell}${opts.cell ? '' : ' (detected)'}`);
      if (icon.encode(d.image).equals(dark)) sameBytes++;
    }
  }
  // The encoder is the one glint.js used, so the bytes match too wherever this
  // Node's zlib deflates as the one that wrote the files did; logged, not
  // asserted (a Node linked against another zlib differs, pixel-equal).
  t.diagnostic(`byte-identical: ${sameBytes}/6 (zlib ${process.versions.zlib})`);
});

// glint.js's own predicates, as the oracle for what may change.
function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}

test('darkVariant leaves transparency and every grey but the glint untouched', () => {
  const src = decodePng(ICON);
  const out = icon.darkVariant(src, { cell: 5 }).image;
  const W = src.width; const H = src.height;
  const at = (x, y) => (y * W + x) * 4;
  const gold = (x, y) => { const i = at(x, y); if (!src.data[i + 3]) return false; const [h, s] = hsv(src.data[i], src.data[i + 1], src.data[i + 2]); return s >= 0.25 && h >= 25 && h <= 95; };
  const goldNear = (x, y) => { for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H && gold(X, Y)) return true; } return false; };
  let transparent = 0; let greysKept = 0; let glintChanged = 0; let saturatedChanged = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      const same = src.data.subarray(i, i + 4).equals(out.data.subarray(i, i + 4));
      if (!src.data[i + 3]) { assert.ok(same, 'a transparent pixel is untouched'); transparent++; continue; }
      const [, s, v] = hsv(src.data[i], src.data[i + 1], src.data[i + 2]);
      if (s >= 0.25) { if (!same) saturatedChanged++; continue; }
      const glint = v > 0.5 && goldNear(x, y);
      if (glint) { assert.ok(!same); glintChanged++; } else { assert.ok(same, `grey at ${x},${y} is untouched`); greysKept++; }
    }
  }
  assert.ok(transparent > 0 && greysKept > 0 && glintChanged > 0 && saturatedChanged > 0,
    JSON.stringify({ transparent, greysKept, glintChanged, saturatedChanged }));
});

test('darkVariant returns null without two dominant hues', () => {
  const one = canvas(40, 40);
  ellipse(one, 20, 20, 16, 16, (u) => [30, 60 + Math.round(100 * u), 220]); // blues only
  assert.equal(icon.darkVariant(one), null, 'a single hue');
  const grey = canvas(40, 40);
  ellipse(grey, 20, 20, 16, 16, (u) => { const g = Math.round(40 + 180 * u); return [g, g, g]; });
  assert.equal(icon.darkVariant(grey), null, 'greyscale');
  assert.equal(icon.darkVariant(canvas(8, 8)), null, 'nothing at all');
  // A second hue under 5 % of the saturated weight is not dominant.
  const speck = canvas(40, 40);
  ellipse(speck, 20, 20, 18, 18, () => [30, 60, 220]);
  speck.data.set([240, 200, 30, 255], (20 * 40 + 20) * 4);
  assert.equal(icon.darkVariant(speck), null, 'a speck of a second hue');
});

// ── grid recovery from a noisy source ────────────────────────────────────────

const PALETTE = [[230, 40, 40], [40, 200, 60], [50, 70, 230], [240, 220, 50], [240, 240, 240]];

// A 20×18 sprite: palette colours and black (empty) cells, every border row
// and column holding colour, so it trims to exactly 20×18.
function knownSprite() {
  const r = rng(7);
  const cells = [];
  for (let y = 0; y < 18; y++) {
    const row = [];
    for (let x = 0; x < 20; x++) {
      const edge = x === 0 || y === 0 || x === 19 || y === 17;
      const empty = !edge && r() < 0.3;
      row.push(empty ? null : PALETTE[Math.floor(r() * PALETTE.length)]);
    }
    cells.push(row);
  }
  return cells;
}

test('a noisy pixel-art source at pitch 9, phase 4, on flat black gives back exactly its sprite', () => {
  const cells = knownSprite();
  const W = 260; const H = 240; const P = 9; const ox = 40; const oy = 40; // 40 = 4 + 4 × 9
  const im = canvas(W, H, [0, 0, 0, 255]);
  for (let y = 0; y < 18 * P; y++) {
    for (let x = 0; x < 20 * P; x++) {
      const c = cells[Math.floor(y / P)][Math.floor(x / P)];
      if (c) im.data.set([...c, 255], ((y + oy) * W + (x + ox)) * 4);
    }
  }
  const r = rng(42);
  for (let i = 0; i < im.data.length; i += 4) {
    for (let k = 0; k < 3; k++) im.data[i + k] = Math.max(0, Math.min(255, im.data[i + k] + Math.round(r() * 20 - 10)));
  }
  const got = icon.prepare(encodePng(im.data, W, H), { kind: 'logo' });
  checkVariants(got);
  assert.equal(got.pixel_art, true);
  assert.equal(got.source_cell, 9);
  assert.ok(Array.isArray(got.background) && got.background.every((v) => v <= 10), `flat black: ${got.background}`);
  assert.deepEqual(got.variants.tile.colour, got.background, "the tile is the artist's ground");
  // The clean render: 20×18 cells, a one-cell margin, square, ×ceil(160 / 22).
  const scale = Math.ceil(160 / 22);
  assert.equal(got.scale, scale);
  const t = got.variants.transparent.image;
  assert.deepEqual([t.width, t.height], [22 * scale, 22 * scale]);
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const c = (cells[Math.floor(y / scale) - 2] || [])[Math.floor(x / scale) - 1] || null;
      const i = (y * t.width + x) * 4;
      assert.equal(t.data[i + 3], c ? 255 : 0, `alpha at ${x},${y}`);
      // Each cell is sampled from the jittered source, so its colour is the
      // clean one within the ±10 jitter; the geometry is exact.
      if (c) for (let k = 0; k < 3; k++) assert.ok(Math.abs(t.data[i + k] - c[k]) <= 10, `colour at ${x},${y}`);
    }
  }
});

// ── smooth art ───────────────────────────────────────────────────────────────

function disc(size, diameter) {
  return ellipse(canvas(size, size, [255, 255, 255, 255]), size / 2, size / 2, diameter / 2, diameter / 2, gradient);
}

test('a smooth gradient disc on white is not pixel art: keyed softly, area-averaged within 128–512', () => {
  const r = icon.prepare(asPng(disc(300, 240)), { kind: 'logo' });
  checkVariants(r);
  assert.equal(r.pixel_art, false);
  assert.equal(r.cell, 1);
  assert.deepEqual(r.background, [255, 255, 255]);
  assert.deepEqual(r.variants.tile.colour, [255, 255, 255]);
  const t = r.variants.transparent.image;
  for (const v of [t, r.variants.tile.image]) {
    assert.ok(Math.max(v.width, v.height) >= icon.MIN_SIDE && Math.max(v.width, v.height) <= icon.SMOOTH_MAX_SIDE, `${v.width}×${v.height}`);
  }
  assert.equal(t.width, t.height);
  let partial = 0; let clear = 0;
  for (let i = 3; i < t.data.length; i += 4) { if (t.data[i] === 0) clear++; else if (t.data[i] < 255) partial++; }
  assert.ok(clear > 0 && partial > 0, `soft edges: ${partial} partly transparent pixels`);
  assert.equal(t.data[3], 0, 'the white corner is keyed out');
  // The soft key un-mixes each colour from the ground: a partly transparent
  // pixel laid back over white gives the source pixel again. The content here
  // (240 px) is within the size bounds, so the variant is the keyed crop 1:1,
  // centred with its 1/32 margin. Without the un-mix the edge reads as a halo,
  // up to ~18 levels off.
  const src = disc(300, 240);
  let x0 = 300, y0 = 300, x1 = -1, y1 = -1;
  for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) {
    const i = (y * 300 + x) * 4;
    if (Math.max(...[0, 1, 2].map((c) => 255 - src.data[i + c])) > icon.INK_DISTANCE) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const cw = x1 - x0 + 1; const ch = y1 - y0 + 1;
  assert.equal(t.width, cw + 2 * Math.round(Math.max(cw, ch) / 32), 'the crop, unscaled, with its margin');
  const ox = (t.width - cw) >> 1; const oy = (t.height - ch) >> 1;
  let edges = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const o = ((y + oy) * t.width + x + ox) * 4; const a = t.data[o + 3];
    if (!a || a === 255) continue;
    edges++;
    const s = ((y + y0) * 300 + x + x0) * 4;
    for (let c = 0; c < 3; c++) {
      const over = (t.data[o + c] * a + 255 * (255 - a)) / 255;
      assert.ok(Math.abs(over - src.data[s + c]) <= 1, `un-mixed at ${x},${y}: ${over} vs ${src.data[s + c]}`);
    }
  }
  assert.ok(edges > 0, 'the edge is there to check');
});

test('a 40 px smooth input is upscaled to 128, with the note saying so', () => {
  const small = asPng(disc(40, 40));
  const r = icon.prepare(small, { kind: 'logo', mode: 'smooth' });
  checkVariants(r);
  assert.equal(r.pixel_art, false);
  assert.deepEqual([r.variants.transparent.image.width, r.variants.transparent.image.height], [128, 128]);
  assert.ok(r.notes.some((n) => /upscaled from 40 px — smooth art loses detail past its native size/.test(n)), r.notes.join(' | '));
  // In auto mode an image this small is a native sprite (one pixel a cell).
  assert.equal(icon.prepare(small, { kind: 'logo' }).pixel_art, true);
});

test('mode pixel forces the grid path, mode smooth the area-average one', () => {
  const big = asPng(disc(300, 240));
  const forced = icon.prepare(big, { kind: 'logo', mode: 'pixel' });
  assert.equal(forced.pixel_art, true);
  checkVariants(forced);
  const smooth = icon.prepare(ICON, { kind: 'logo', mode: 'smooth' });
  assert.equal(smooth.pixel_art, false);
  checkVariants(smooth);
});

// ── shape ────────────────────────────────────────────────────────────────────

const oval = (w, h) => asPng(ellipse(canvas(w + 20, h + 20), (w + 20) / 2, (h + 20) / 2, w / 2, h / 2, gradient));

test('a 3:1 wordmark keeps its aspect as a logo, and is refused as a favicon', () => {
  const r = icon.prepare(oval(300, 100), { kind: 'logo' });
  checkVariants(r);
  assert.equal(r.square, false);
  const t = r.variants.transparent.image;
  assert.ok(t.width / t.height > 2.5, `${t.width}×${t.height}`);
  assert.throws(() => icon.prepare(oval(300, 100), { kind: 'favicon' }), (e) => e instanceof icon.IconError
    && e.code === 'not-square' && e.hint === 'a favicon is square: crop the artwork to its mark, or set it as the logo');
});

test('a 1.2:1 mark is padded to an exact square, as a logo and as a favicon', () => {
  for (const kind of ['logo', 'favicon']) {
    const r = icon.prepare(oval(240, 200), { kind });
    checkVariants(r);
    assert.equal(r.square, true, kind);
    assert.equal(r.variants.transparent.image.width, r.variants.transparent.image.height);
    assert.equal(r.variants.tile.image.width, r.variants.tile.image.height);
  }
});

test('a pixel-art wordmark keeps its aspect in cells', () => {
  // 30×10 cells of 4 px on transparency.
  const im = canvas(30 * 4 + 8, 10 * 4 + 8);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) {
    const c = PALETTE[(Math.floor(x / 4) + Math.floor(y / 4)) % PALETTE.length];
    im.data.set([...c, 255], ((y + 4) * im.width + (x + 4)) * 4);
  }
  const r = icon.prepare(asPng(im), { kind: 'logo' });
  checkVariants(r);
  assert.equal(r.pixel_art, true);
  assert.equal(r.source_cell, 4);
  const scale = Math.ceil(160 / 32);
  assert.deepEqual([r.variants.transparent.image.width, r.variants.transparent.image.height], [32 * scale, 12 * scale]);
  assert.throws(() => icon.prepare(asPng(im), { kind: 'favicon' }), { code: 'not-square' });
});

// ── tile colour ──────────────────────────────────────────────────────────────

test("the tile is the caller's colour, else the flat ground, else black; the touch icon is opaque in every case", () => {
  const corner = (r, v) => [...r.variants[v].image.data.subarray(0, 3)];
  const mine = icon.prepare(ICON, { kind: 'logo', tile: [10, 20, 30] });
  assert.deepEqual(mine.variants.tile.colour, [10, 20, 30]);
  assert.deepEqual(corner(mine, 'tile'), [10, 20, 30]);
  assert.deepEqual(corner(mine, 'touch'), [10, 20, 30]);
  checkVariants(mine);
  const onGround = icon.prepare(asPng(disc(300, 240)), { kind: 'logo' });
  assert.deepEqual(onGround.variants.tile.colour, [255, 255, 255]);
  assert.deepEqual(corner(onGround, 'touch'), [255, 255, 255]);
  const black = icon.prepare(oval(200, 200), { kind: 'logo' });
  assert.equal(black.background, 'transparent');
  assert.deepEqual(black.variants.tile.colour, [0, 0, 0]);
  assert.deepEqual(corner(black, 'touch'), [0, 0, 0]);
  checkVariants(black);
  assert.throws(() => icon.prepare(ICON, { kind: 'logo', tile: [0, 0, 256] }), TypeError);
  assert.throws(() => icon.prepare(ICON, { kind: 'banner' }), TypeError);
  assert.throws(() => icon.prepare(ICON, { kind: 'logo', mode: 'fancy' }), TypeError);
});

// ── refusals ─────────────────────────────────────────────────────────────────

const refused = (code, re) => (e) => e instanceof icon.IconError && e.code === code && (!re || re.test(e.message));

test('a JPEG, a GIF and an interlaced PNG are unreadable, with the conversion hint', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(64)]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
  const interlaced = rawPng({ width: 2, height: 2, depth: 8, colorType: 6, rows: [Buffer.alloc(8), Buffer.alloc(8)], interlace: 1 });
  for (const [bytes, re] of [[jpeg, /not a PNG or an SVG/], [gif, /not a PNG or an SVG/], [interlaced, /interlaced/]]) {
    assert.throws(() => icon.prepare(bytes, { kind: 'logo' }), (e) => refused('unreadable', re)(e)
      && e.hint === 'convert it first — on macOS: sips -s format png <in> --out <out.png>');
    assert.throws(() => icon.loadImage(bytes), refused('unreadable'));
  }
  assert.throws(() => icon.prepare(Buffer.alloc(0), { kind: 'logo' }), refused('unreadable'));
  // All background: nothing to make an icon of.
  assert.throws(() => icon.prepare(asPng(canvas(20, 20)), { kind: 'logo' }), refused('unreadable', /no content/));
});

test('over MAX_INPUT_BYTES or MAX_INPUT_PIXELS is too large, decided before inflating', () => {
  assert.throws(() => icon.prepare(Buffer.alloc(icon.MAX_INPUT_BYTES + 1), { kind: 'logo' }), refused('too-large'));
  // 5001 × 5001 > 25 000 000, and an IDAT that is not even a deflate stream: a
  // decoder that inflated first would call it unreadable.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(5001, 0); ihdr.writeUInt32BE(5001, 4); ihdr[8] = 8; ihdr[9] = 6;
  const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from('not deflate')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => icon.prepare(huge, { kind: 'logo' }), refused('too-large', /25000000 pixels/));
  assert.ok(5000 * 5000 <= icon.MAX_INPUT_PIXELS, 'the cap itself is allowed');
});

test('an SVG passes through byte for byte, or is refused when active', () => {
  const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"><rect width="64" height="48" fill="#123"/></svg>\n');
  const r = icon.prepare(svg, { kind: 'logo' });
  assert.equal(r.format, 'svg');
  assert.ok(r.bytes.equals(svg), 'byte-identical');
  assert.deepEqual([r.width, r.height, r.square], [64, 48, false]);
  assert.equal(r.variants, undefined, 'no tile, touch or dark variant');
  assert.ok(r.notes.some((n) => /never rasterised/.test(n)));
  assert.deepEqual(icon.loadImage(svg), { format: 'svg', bytes: svg, width: 64, height: 48 });
  assert.throws(() => icon.prepare(svg, { kind: 'favicon' }), refused('not-square'));
  const square = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 99"><circle cx="50" cy="50" r="40"/></svg>');
  assert.equal(icon.prepare(square, { kind: 'favicon' }).square, true, 'within 2 %');
  const noBox = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  assert.equal(icon.prepare(noBox, { kind: 'logo' }).width, null);
  assert.throws(() => icon.prepare(noBox, { kind: 'favicon' }), refused('not-square', /no viewBox/));
  const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>');
  assert.throws(() => icon.prepare(active, { kind: 'logo' }), refused('svg-refused', /<script>/));
});

test('a noise PNG whose 512 px encoding exceeds 256 KB is stepped down until it validates', () => {
  const r = rng(3);
  const im = canvas(512, 512);
  for (let i = 0; i < im.data.length; i += 4) im.data.set([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), 255], i);
  assert.ok(icon.encode({ width: 512, height: 512, data: im.data }).length > MAX_BYTES, 'the premise');
  const got = icon.prepare(asPng(im), { kind: 'logo' });
  checkVariants(got);
  assert.equal(got.pixel_art, false);
  assert.equal(got.background, null, 'no ground found in noise');
  const t = got.variants.transparent.image;
  assert.ok(t.width >= icon.MIN_SIDE && t.width < 512, `${t.width}`);
  assert.ok(got.notes.some((n) => /stepped down/.test(n)), got.notes.join(' | '));
});

test('resample area-averages (premultiplied), and encode is png.encodePng', () => {
  // 2×1 → 1×1: an opaque red beside a transparent pixel stays red, half opaque.
  const out = icon.resample(Buffer.from([255, 0, 0, 255, 0, 0, 255, 0]), 2, 1, 1, 1);
  assert.deepEqual([...out], [255, 0, 0, 128]);
  const im = decodePng(ICON);
  assert.ok(icon.encode(im).equals(require('../lib/core/png').encodePng(im.data, im.width, im.height)));
});
