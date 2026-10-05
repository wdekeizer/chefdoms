// ============================================================================
//  CHEFDOMS — procedural sprite library (client only)
//  Every pixel of art in the game is drawn here with Canvas 2D paths: no image
//  files, no fonts, no libraries.
//
//  How it works
//   * Art is authored in TILE UNITS as small vector functions ("draw a toque",
//     "draw a hip roof").  bake() rasterises one pose of one thing at one zoom
//     level, runs a shared post-process (top-left bevel light, dark silhouette
//     outline, ground shadow), trims the result and keeps it in an LRU cache.
//     drawUnit / drawTree / drawNode / drawBuilding are then one Map lookup and
//     one drawImage (buildings add a few tiny animated overlays: smoke, flames,
//     flags, bubbles).
//   * Animation = a handful of cached frames per pose, picked from `t`.
//     Tip for the renderer: pass `t + id * 0.37` so units do not move in sync.
//   * `scale` is canvas (device) pixels per tile.  Sprites are baked at the
//     nearest scale "bucket" >= scale and blitted 1:1 when scale is a bucket
//     (all even sizes up to 32, steps of 4 to 64, steps of 8 to 96).
//   * Baking is budgeted (a few ms per frame): if a zoom change makes many
//     sprites miss at once, the sprite of a neighbouring zoom level is drawn
//     scaled until the crisp one has been baked, so frames stay short.
//   * Integration tips: keep the camera offset on whole pixels (sprites snap
//     to pixels, so a fractional camera makes them wobble against the terrain),
//     size the canvas in device pixels for HiDPI, and draw things sorted by y.
//
//  Exports: initSprites, drawUnit, drawBuilding, drawNode, drawTree, drawStump,
//  drawProjectile, drawEffect, paintGround, icon (+ setBakeBudget, spriteStats).
// ============================================================================
import { UNITS, BUILDINGS, COMMANDERS, TILE } from '/game/data.js';

const PI = Math.PI, TAU = PI * 2;
/** Lookup table without a prototype, so unknown keys such as 'constructor' are simply undefined. */
const dict = (o) => Object.assign(Object.create(null), o);
const BLD = dict(BUILDINGS), CMD = dict(COMMANDERS);
const OUTLINE = '#38251c';

// ---------------------------------------------------------------- colours ---
const _rgb = new Map(), _mix = new Map();
let _probe = null;
function rgbOf(col) {
  let v = _rgb.get(col);
  if (v) return v;
  let h = String(col || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (!/^#[0-9a-f]{6}$/i.test(h) && typeof document !== 'undefined') {       // named / rgb() colours
    _probe = _probe || document.createElement('canvas').getContext('2d');
    _probe.fillStyle = '#888888'; _probe.fillStyle = h; h = _probe.fillStyle;
  }
  const n = /^#[0-9a-f]{6}$/i.test(h) ? parseInt(h.slice(1), 16) : 0x888888;
  v = [n >> 16 & 255, n >> 8 & 255, n & 255];
  if (_rgb.size > 500) _rgb.clear();
  _rgb.set(col, v);
  return v;
}
/** amt < 0 mixes toward a warm dark, amt > 0 toward a warm white. */
function mix(col, amt) {
  const key = col + amt;
  let v = _mix.get(key);
  if (v) return v;
  const [r, g, b] = rgbOf(col), a = Math.abs(amt), t = amt < 0 ? [46, 26, 44] : [255, 250, 236];
  v = `rgb(${Math.round(r + (t[0] - r) * a)},${Math.round(g + (t[1] - g) * a)},${Math.round(b + (t[2] - b) * a)})`;
  if (_mix.size > 4000) _mix.clear();
  _mix.set(key, v);
  return v;
}
const dk = (col, a = 0.22) => mix(col, -a), lt = (col, a = 0.25) => mix(col, a);
const rgba = (col, a) => { const [r, g, b] = rgbOf(col); return `rgba(${r},${g},${b},${a})`; };

// Neutral palette (team colour is always passed in separately)
const WHITE = '#fbf5e6', STEEL = '#c5d0d6', IRON = '#4b4f5a', WOOD = '#b88146', WOOD_D = '#8a5a32', WOOD_L = '#dcae72',
  GOLD = '#f6c544', BRICK = '#c4694a', STONE = '#b9b3a6', CREAM = '#f4e6c8', GLOW = '#ffd98a', SHOE = '#4a3a36', PANTS = '#57586b',
  LEAF = '#5aa846', LEAF_D = '#3f8a3e', SAUCE = '#d9402b', CRUST = '#dfa551', MEAT = '#8a4b32', SOIL = '#7a5236';
const SKIN = ['#f7d0a8', '#ebb888', '#c98f62', '#8f5d3f'];
const HAIR = { blk: '#2f2624', brn: '#6a4326', red: '#e2562a', gry: '#c9c5c0', bld: '#e6c06a', aub: '#a5532d' };

// ----------------------------------------------------------- determinism ---
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ sprite cache ---
// Sprites are baked at a "bucket" scale (the next bucket >= the requested px-per-tile) and blitted 1:1
// when the scale is exactly a bucket. Keys are small integers: [kind | what/colour/frame bits | bucket(5)].
const BUCKETS = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 112, 128];
const NB = BUCKETS.length, BK = new Uint8Array(130);
for (let s = 0, i = 0; s < 130; s++) { while (i < NB - 1 && BUCKETS[i] < s) i++; BK[s] = i; }
const bucketIdx = (s) => BK[s >= 128 ? 128 : s > 0 ? Math.ceil(s - 0.01) : 0];
const FRAME_STRIDE = 512;                         // unit keys: ...frame(3) | face(1) | carry(3) | bucket(5)
const K_UNIT = 0, K_TREE = 1 << 27, K_NODE = 2 << 27, K_PROJ = 3 << 27, K_FX = 4 << 27, K_BLD = 5 << 27, K_WALL = 6 << 27;
const MAX_PX = 30e6, MAX_SPRITES = 7000;        // cache budget (~120 MB of RGBA worst case)
const KEEP = 5000;                                // sprites drawn within the last KEEP blits (~2 busy frames) are never evicted
const FRAME_MS = 14;
let bakeMs = 6;                                   // baking time allowed per frame before borrowing a similar sprite (see setBakeBudget)
const cache = new Map();
let cachePx = 0, clock = 0, winT = 0, spent = 0, softPx = MAX_PX, softN = MAX_SPRITES, evictClock = 0;
const colorIds = new Map();
function colorId(col) {                           // small integer per colour string (max 64 distinct colours)
  let i = colorIds.get(col);
  if (i === undefined) {
    if (colorIds.size >= 64) { colorIds.clear(); cache.clear(); cachePx = 0; softPx = MAX_PX; softN = MAX_SPRITES; }
    i = colorIds.size; colorIds.set(col, i);
  }
  return i;
}
function evict() {                                // drop the least recently used sprites, down to 70% of the budget
  const all = [...cache.entries()].sort((a, b) => a[1].used - b[1].used), keep = clock - KEEP;
  for (let i = 0; i < all.length && all[i][1].used < keep && (cachePx > MAX_PX * 0.7 || cache.size > MAX_SPRITES * 0.7); i++) { cache.delete(all[i][0]); cachePx -= all[i][1].w * all[i][1].h; }
  // If what is on screen right now is itself bigger than the budget, grow a little rather than re-baking it every frame.
  softPx = Math.max(MAX_PX, cachePx * 1.25); softN = Math.max(MAX_SPRITES, cache.size * 1.25); evictClock = clock;
}
/**
 * Cache miss: bake the sprite with build(bucketScale). If this frame has already spent its baking budget
 * (the zoom just changed, or a whole army walked into view) borrow a stand-in instead: the same sprite from a
 * nearby zoom bucket (drawn scaled) or, for units, another frame of the same animation (f = frame, n = frame
 * count). The exact sprite gets baked on a later frame, so nothing is ever skipped.
 */
function miss(key, build, f, n) {
  const now = performance.now();
  if (now - winT > FRAME_MS) { winT = now; spent = 0; }
  if (spent >= bakeMs) {
    const bi = key & 31, base = key - bi;
    for (let d = 1; d < NB; d++) { const sp = (bi + d < NB && cache.get(base + bi + d)) || (bi >= d && cache.get(base + bi - d)); if (sp) return sp; }
    for (let d = 1; d < n; d++) { const sp = cache.get(key + ((f + n - d) % n - f) * FRAME_STRIDE); if (sp) return sp; }
  }
  const sp = build(BUCKETS[key & 31]);
  spent += performance.now() - now;
  return store(key, sp);
}
function store(key, sp) {
  sp.used = ++clock;                               // newest = last in line for eviction
  cache.set(key, sp); cachePx += sp.w * sp.h;
  if (cachePx > softPx || cache.size > softN || ((cachePx > MAX_PX || cache.size > MAX_SPRITES) && clock - evictClock > 200000)) evict();
  return sp;
}
/** Draw sprite with its anchor at (x,y). `scale` = wanted px per tile. */
function blit(ctx, sp, x, y, scale) {
  sp.used = ++clock;
  if (scale === sp.s) ctx.drawImage(sp.cv, Math.round(x - sp.ox), Math.round(y - sp.oy));
  else { const k = scale / sp.s; ctx.drawImage(sp.cv, x - sp.ox * k, y - sp.oy * k, sp.w * k, sp.h * k); }
}

// --------------------------------------------------------------- baking ---
// Layer being drawn: 0 = under (ground shadows, glows: no outline), 1 = main art, 2 = over (smoke, sparks: no outline).
// Art functions are simply run three times; every primitive below draws only on its own layer.
let L = 1, S = 32, LW = 0.03, FACE = 1;
const scratchPads = [];
function scratch(i, w, h) {
  let p = scratchPads[i];
  if (!p) { const cv = document.createElement('canvas'); p = scratchPads[i] = { cv, c: cv.getContext('2d', { willReadFrequently: true }) }; cv.width = cv.height = 0; }
  if (p.cv.width < w || p.cv.height < h) { p.cv.width = Math.max(p.cv.width, w); p.cv.height = Math.max(p.cv.height, h); }
  p.c.setTransform(1, 0, 0, 1, 0, 0); p.c.globalAlpha = 1; p.c.globalCompositeOperation = 'source-over';
  p.c.clearRect(0, 0, w, h);
  return p;
}
/** Bounding box [x0, y0, x1, y1] of the non-transparent pixels in the top-left W x H of a scratch canvas (or null). */
function bounds(c, W, H) {
  const px = new Uint32Array(c.getImageData(0, 0, W, H).data.buffer);
  let x0 = W, y0 = -1, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < H; y++) {
    let hit = false;
    for (let x = 0; x < W; x++, i++) if (px[i] !== 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; hit = true; }
    if (hit) { if (y0 < 0) y0 = y; y1 = y; }
  }
  return y0 < 0 ? null : [x0, y0, x1, y1];
}
/**
 * Rasterise `draw(c)` (tile units, origin at the anchor) at `s` px per tile.
 * box = [left, up, right, down] generous extents in tiles; the result is trimmed.
 * opt: { face, outline:false, bevel:false }
 */
function bake(s, box, draw, opt = {}) {
  const ow = opt.outline === false ? 0 : (s < 36 ? 1 : s * 0.031);
  const m = Math.ceil(ow) + 2, face = opt.face === -1 ? -1 : 1;
  const ox = Math.ceil(box[0] * s) + m, oy = Math.ceil(box[1] * s) + m;
  const W = ox + Math.ceil(box[2] * s) + m, H = oy + Math.ceil(box[3] * s) + m;
  const a = scratch(0, W, H), b = scratch(1, W, H), o = scratch(2, W, H);
  const run = (c, layer) => {
    L = layer; S = s; FACE = face; LW = Math.max(0.026, 0.8 / s);
    c.save(); c.translate(ox, oy); c.scale(s * face, s); c.lineJoin = c.lineCap = 'round';
    draw(c);
    c.restore(); L = 1;
  };
  run(a.c, 1);
  // the post-process only touches the part of the scratch pad the art actually covers
  const bb = bounds(a.c, W, H) || [0, 0, 0, 0];
  const rx = Math.max(0, bb[0] - m), ry = Math.max(0, bb[1] - m), rw = Math.min(W, bb[2] + m + 1) - rx, rh = Math.min(H, bb[3] + m + 1) - ry;
  if (opt.bevel !== false) {                    // consistent top-left light on every silhouette
    const d = Math.max(1, s * 0.035), c = b.c;
    for (const [sh, col, al] of [[d, '#fffbe8', 0.32], [-d, '#24122a', 0.26]]) {
      c.globalCompositeOperation = 'copy'; c.drawImage(a.cv, rx, ry, rw, rh, rx, ry, rw, rh);
      c.globalCompositeOperation = 'destination-out'; c.drawImage(a.cv, rx, ry, rw, rh, rx + sh, ry + sh, rw, rh);
      c.globalCompositeOperation = 'source-in'; c.fillStyle = col; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'source-over';
      a.c.globalCompositeOperation = 'source-atop'; a.c.globalAlpha = al; a.c.drawImage(b.cv, rx, ry, rw, rh, rx, ry, rw, rh);
      a.c.globalAlpha = 1; a.c.globalCompositeOperation = 'source-over';
      c.clearRect(rx, ry, rw, rh);
    }
  }
  run(o.c, 0);
  if (ow) {                                     // dark silhouette outline
    const c = b.c;
    c.drawImage(a.cv, rx, ry, rw, rh, rx, ry, rw, rh);
    c.globalCompositeOperation = 'source-in'; c.fillStyle = OUTLINE; c.fillRect(rx, ry, rw, rh); c.globalCompositeOperation = 'source-over';
    const n = ow < 1.6 ? 8 : ow < 3 ? 12 : 16;
    for (let i = 0; i < n; i++) {
      const an = i / n * TAU; let dx = Math.cos(an) * ow, dy = Math.sin(an) * ow;
      if (ow === 1) { dx = Math.round(dx); dy = Math.round(dy); }
      o.c.drawImage(b.cv, rx, ry, rw, rh, rx + dx, ry + dy, rw, rh);
    }
  }
  o.c.drawImage(a.cv, rx, ry, rw, rh, rx, ry, rw, rh);
  run(o.c, 2);
  const t = bounds(o.c, W, H) || [0, 0, 0, 0];   // trim to the painted pixels
  const cv = document.createElement('canvas');
  cv.width = t[2] - t[0] + 1; cv.height = t[3] - t[1] + 1;
  cv.getContext('2d').drawImage(o.cv, t[0], t[1], cv.width, cv.height, 0, 0, cv.width, cv.height);
  return { cv, ox: ox - t[0], oy: oy - t[1], w: cv.width, h: cv.height, s, used: 0 };
}

// ------------------------------------------------- drawing vocabulary ---
// All coordinates are tile units.  `ink` fills the current path and strokes it in a darker tone of the fill.
function ink(c, fill, lw) {
  if (L !== 1) return;
  c.fillStyle = fill; c.fill();
  if (lw !== 0) { c.strokeStyle = dk(fill, 0.36); c.lineWidth = lw || LW; c.stroke(); }
}
/** For paths made of several overlapping sub-shapes: outline only the union. */
function inkU(c, fill, lw) {
  if (L !== 1) return;
  c.strokeStyle = dk(fill, 0.36); c.lineWidth = (lw || LW) * 2; c.stroke();
  c.fillStyle = fill; c.fill();
}
function ell(c, x, y, rx, ry, fill, rot, lw) { c.beginPath(); c.ellipse(x, y, rx, ry, rot || 0, 0, TAU); ink(c, fill, lw); }
function circ(c, x, y, r) { c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); }                    // sub-path helper
function rr(c, x, y, w, h, r) {
  if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function box(c, x, y, w, h, r, fill, lw) { c.beginPath(); rr(c, x, y, w, h, r); ink(c, fill, lw); }
function poly(c, p, fill, lw) {
  c.beginPath(); c.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
  c.closePath(); ink(c, fill, lw);
}
/** Thick round-ended stroke with an outline (arms, handles, poles). */
function limb(c, x1, y1, x2, y2, w, fill) {
  if (L !== 1) return;
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
  c.strokeStyle = dk(fill, 0.36); c.lineWidth = w + LW * 2; c.stroke();
  c.strokeStyle = fill; c.lineWidth = w; c.stroke();
}
/** Plain line(s) on the current path / or from a point list. */
function pen(c, col, w, p) {
  if (L !== 1) return;
  if (p) { c.beginPath(); c.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]); }
  c.strokeStyle = col; c.lineWidth = w || LW; c.stroke();
}
function dot(c, x, y, r, fill) { if (L !== 1) return; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fillStyle = fill; c.fill(); }
/** Soft white highlight / dark shade blob (no outline). The light always comes from the top-left, even on mirrored sprites. */
function glint(c, x, y, rx, ry, a = 0.4, rot = 0) {
  if (L !== 1) return;
  c.fillStyle = `rgba(255,252,235,${a})`; c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, TAU); c.fill();
}
function ball(c, x, y, r, fill) { ell(c, x, y, r, r, fill); glint(c, x - r * 0.3 * FACE, y - r * 0.35, r * 0.38, r * 0.28, 0.4); }
function shadow(c, x, y, rx, ry, a = 0.26) {
  if (L !== 0) return;
  c.fillStyle = `rgba(28,38,18,${a})`; c.beginPath(); c.ellipse(x + 0.04 * FACE, y + 0.01, rx, ry, 0, 0, TAU); c.fill();
}
/** Un-outlined translucent blob on the "over" layer (smoke, steam, glow). */
function puff(c, x, y, r, col, a) {
  if (L !== 2) return;
  c.globalAlpha = a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.globalAlpha = 1;
}
/** Run fn with the context scaled by k around (x,y), keeping line weights constant. */
function scaled(c, x, y, k, fn, rot) {
  c.save(); c.translate(x, y); if (rot) c.rotate(rot); c.scale(k, k);
  const lw = LW; LW = lw / Math.abs(k); fn(); LW = lw; c.restore();
}
const lerp = (a, b, t) => a + (b - a) * t;

// ====================================================================== PROPS
// Small reusable bits of art. Unless noted they are drawn around the origin, pointing along +x.
function carrot(c, x, y, k, rot) {
  scaled(c, x, y, k, () => {
    for (const a of [-0.5, 0.5, 0]) ell(c, -0.07 * Math.cos(a), -0.07 * Math.sin(a) * 1.3, 0.085, 0.035, LEAF, a);
    c.beginPath(); c.moveTo(0, -0.075); c.quadraticCurveTo(0.22, -0.055, 0.38, 0); c.quadraticCurveTo(0.22, 0.055, 0, 0.075); c.quadraticCurveTo(-0.045, 0, 0, -0.075);
    ink(c, '#f08a24'); pen(c, '#c9651a', LW, [0.1, -0.05, 0.12, -0.01]); pen(c, '#c9651a', LW, [0.2, 0.035, 0.22, 0]);
  }, rot);
}
function chili(c, x, y, k, rot, col = '#de3a2a') {
  scaled(c, x, y, k, () => {
    limb(c, 0.01, -0.005, -0.06, -0.045, 0.03, LEAF_D);
    c.beginPath(); c.moveTo(0, -0.05); c.bezierCurveTo(0.14, -0.085, 0.26, -0.03, 0.33, 0.075);
    c.bezierCurveTo(0.21, 0.045, 0.11, 0.065, 0, 0.05); c.quadraticCurveTo(-0.04, 0, 0, -0.05);
    ink(c, col); glint(c, 0.11, -0.025, 0.07, 0.014, 0.5, 0.1);
  }, rot);
}
function logPiece(c, x, y, len, r, rot) {
  scaled(c, x, y, 1, () => {
    box(c, 0, -r, len, r * 2, r * 0.5, WOOD_D); pen(c, dk(WOOD_D, 0.2), LW, [len * 0.2, -r * 0.3, len * 0.7, -r * 0.3]);
    ell(c, len, 0, r * 0.5, r, WOOD_L); ell(c, len, 0, r * 0.22, r * 0.5, lt(WOOD_L, 0.3), 0, LW * 0.7);
  }, rot);
}
/** Faceted crystal standing on (x,y). */
function crystal(c, x, y, w, h, tilt, col = '#d6ecf7') {
  scaled(c, x, y, 1, () => {
    const p = [-w / 2, 0, w / 2, 0, w / 2, -h * 0.68, 0.02 * w, -h, -w / 2, -h * 0.72];
    poly(c, p, col);
    if (L === 1) {
      c.fillStyle = 'rgba(255,255,255,0.75)'; c.beginPath(); c.moveTo(-w / 2, 0); c.lineTo(-w * 0.12, 0); c.lineTo(-w * 0.12, -h * 0.8); c.lineTo(-w / 2, -h * 0.72); c.fill();
      c.fillStyle = 'rgba(110,160,200,0.45)'; c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w * 0.2, 0); c.lineTo(w * 0.2, -h * 0.8); c.lineTo(w / 2, -h * 0.68); c.fill();
    }
  }, tilt);
}
function meatball(c, x, y, r) {
  ell(c, x, y, r, r, MEAT);
  for (const [a, d] of [[0.6, 0.5], [2.4, 0.45], [4.2, 0.55], [5.3, 0.2]]) dot(c, x + Math.cos(a) * r * d, y + Math.sin(a) * r * d, r * 0.13, dk(MEAT, 0.3));
  glint(c, x - r * 0.3 * FACE, y - r * 0.38, r * 0.34, r * 0.22, 0.45);
}
function macaron(c, x, y, r, col) {
  box(c, x - r, y - r * 0.2, r * 2, r * 0.4, r * 0.15, '#fff6e6');
  c.beginPath(); c.ellipse(x, y - r * 0.18, r, r * 0.55, 0, PI, TAU); c.closePath(); ink(c, col);
  c.beginPath(); c.ellipse(x, y + r * 0.18, r, r * 0.5, 0, 0, PI); c.closePath(); ink(c, dk(col, 0.1));
  glint(c, x - r * 0.3 * FACE, y - r * 0.45, r * 0.35, r * 0.12, 0.5);
}
const PASTEL = ['#f7a8c4', '#a9e3c8', '#f7e08a', '#c9b4f2'];
/** Teardrop flame standing on (x,y). `f` = flicker frame. */
function flame(c, x, y, k, f = 0, rot = 0) {
  scaled(c, x, y, k, () => {
    const w = f % 2 ? 0.03 : -0.03, h = 1 + (f % 3) * 0.12;
    const tear = (s, col) => { c.beginPath(); c.moveTo(0, 0.02); c.bezierCurveTo(-0.16 * s, 0, -0.1 * s, -0.16 * s * h, w * s, -0.34 * s * h);
      c.bezierCurveTo(0.06 * s, -0.2 * s * h, 0.17 * s, -0.04 * s, 0, 0.02); if (L === 1) { c.fillStyle = col; c.fill(); } };
    tear(1, '#f0621d'); tear(0.68, '#ffb62e'); tear(0.36, '#fff3a6');
  }, rot);
}
function wheel(c, x, y, r, rot, hub) {
  ell(c, x, y, r, r, '#3b3a40'); ell(c, x, y, r * 0.58, r * 0.58, hub || STEEL, 0, LW * 0.8);
  for (let i = 0; i < 3; i++) { const a = rot + i * PI / 3; pen(c, dk(hub || STEEL, 0.3), LW, [x - Math.cos(a) * r * 0.5, y - Math.sin(a) * r * 0.5, x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5]); }
  dot(c, x, y, r * 0.16, '#3b3a40');
}
/** Chef toque standing on (x,y) = centre of the band's bottom edge. */
function toque(c, x, y, h, band) {
  const yt = y - h;
  c.beginPath(); c.rect(x - 0.125, yt + 0.07, 0.25, h - 0.09);
  circ(c, x - 0.088, yt + 0.085, 0.085); circ(c, x + 0.088, yt + 0.085, 0.085); circ(c, x, yt + 0.072, 0.098);
  inkU(c, WHITE);
  pen(c, dk(WHITE, 0.16), LW, [x - 0.045, yt + 0.15, x - 0.045, y - 0.08]); pen(c, dk(WHITE, 0.16), LW, [x + 0.05, yt + 0.15, x + 0.05, y - 0.08]);
  box(c, x - 0.142, y - 0.075, 0.284, 0.078, 0.02, band);
}
function coffeeCup(c, x, y, k) {
  scaled(c, x, y, k, () => {
    poly(c, [-0.055, 0, 0.055, 0, 0.075, -0.17, -0.075, -0.17], '#fffaf0');
    poly(c, [-0.064, -0.05, 0.064, -0.05, 0.071, -0.125, -0.071, -0.125], '#b9793f', LW * 0.7);
    box(c, -0.085, -0.2, 0.17, 0.045, 0.015, '#5b4033');
  });
}
function sack(c, x, y, k, col = '#e9d9b4') {
  scaled(c, x, y, k, () => {
    c.beginPath(); c.moveTo(-0.16, 0); c.bezierCurveTo(-0.22, -0.16, -0.15, -0.3, -0.06, -0.31); c.lineTo(0.06, -0.31); c.bezierCurveTo(0.15, -0.3, 0.22, -0.16, 0.16, 0); c.closePath(); ink(c, col);
    poly(c, [-0.07, -0.3, 0.07, -0.3, 0.1, -0.39, 0, -0.35, -0.1, -0.39], col); pen(c, dk(col, 0.4), LW * 1.4, [-0.065, -0.305, 0.065, -0.305]);
  });
}
function crate(c, x, y, w, h) {
  box(c, x, y - h, w, h, 0.015, WOOD_L); pen(c, WOOD_D, LW, [x, y - h * 0.5, x + w, y - h * 0.5]);
  pen(c, WOOD_D, LW * 1.3, [x + w * 0.12, y - h, x + w * 0.12, y]); pen(c, WOOD_D, LW * 1.3, [x + w * 0.88, y - h, x + w * 0.88, y]);
}
function barrel(c, x, y, k) {
  scaled(c, x, y, k, () => {
    c.beginPath(); c.moveTo(-0.13, 0); c.quadraticCurveTo(-0.19, -0.17, -0.13, -0.34); c.lineTo(0.13, -0.34); c.quadraticCurveTo(0.19, -0.17, 0.13, 0); c.closePath(); ink(c, WOOD);
    ell(c, 0, -0.34, 0.13, 0.045, WOOD_L); pen(c, IRON, LW * 1.6, [-0.16, -0.1, 0.16, -0.1]); pen(c, IRON, LW * 1.6, [-0.16, -0.24, 0.16, -0.24]);
  });
}

// ====================================================================== TOOLS
// Held items, drawn at the hand with +x pointing along the tool. `fx` = effect frame (flames etc).
const TOOLS = {
  pan(c) { limb(c, -0.03, 0, 0.15, 0, 0.04, '#2e3038'); ell(c, 0.27, 0, 0.14, 0.125, IRON); ell(c, 0.27, 0, 0.1, 0.088, '#6a6f7c', 0, LW * 0.8); glint(c, 0.24, -0.03 * FACE, 0.04, 0.025, 0.35); },
  cleaver(c) { limb(c, -0.04, 0, 0.07, 0, 0.045, WOOD_D); box(c, 0.07, -0.03, 0.25, 0.185, 0.02, STEEL); pen(c, lt(STEEL, 0.6), LW * 1.6, [0.09, 0.135, 0.3, 0.135]); dot(c, 0.27, 0.0, 0.016, dk(STEEL, 0.45)); },
  ladle(c) { limb(c, -0.03, 0, 0.27, 0, 0.03, STEEL); ell(c, 0.31, 0.015, 0.075, 0.07, STEEL); ell(c, 0.31, 0.015, 0.05, 0.046, SAUCE, 0, LW * 0.7); },
  cup(c) { c.save(); c.rotate(PI / 2); coffeeCup(c, 0.055, 0.09, 0.95); c.restore(); },
  torch(c, fx) {
    box(c, -0.09, -0.055, 0.17, 0.11, 0.035, '#f2c230'); box(c, -0.03, -0.055, 0.05, 0.11, 0.0, '#3c3f48', LW * 0.6);
    limb(c, 0.08, 0, 0.19, 0, 0.04, '#8c949c'); box(c, 0.17, -0.032, 0.05, 0.064, 0.01, '#b9813a');
    flame(c, 0.21, 0, 0.42 + fx * 0.22, fx, PI / 2);
    if (fx) puff(c, 0.3 + fx * 0.05, 0, 0.09 + fx * 0.03, '#ffb62e', 0.18);
  },
  pin(c) { limb(c, -0.05, 0, 0.44, 0, 0.03, WOOD_D); box(c, 0.05, -0.06, 0.31, 0.12, 0.04, WOOD_L); glint(c, 0.2, -0.028 * FACE, 0.11, 0.014, 0.5); },
  hammer(c) { limb(c, -0.04, 0, 0.3, 0, 0.042, WOOD_D); box(c, 0.22, -0.125, 0.16, 0.25, 0.025, '#aab4bb');
    for (const yy of [-0.07, 0, 0.07]) pen(c, dk(STEEL, 0.35), LW, [0.24, yy, 0.36, yy]); pen(c, dk(STEEL, 0.35), LW, [0.3, -0.11, 0.3, 0.11]); },
  yanagi(c) { limb(c, -0.04, 0, 0.06, 0, 0.04, '#3a2c28'); box(c, 0.055, -0.025, 0.02, 0.05, 0.005, GOLD, LW * 0.6);
    poly(c, [0.075, -0.026, 0.4, -0.02, 0.47, 0.012, 0.075, 0.03], '#e3ebef'); pen(c, '#fff', LW, [0.1, -0.008, 0.4, -0.006]); },
  spoon(c) { limb(c, -0.05, 0, 0.3, 0, 0.036, WOOD); ell(c, 0.36, 0, 0.1, 0.075, WOOD); ell(c, 0.365, 0, 0.065, 0.045, dk(WOOD, 0.14), 0, LW * 0.6); },
  piping(c, fx) {
    poly(c, [-0.1, -0.09, -0.1, 0.09, 0.17, 0.022, 0.17, -0.022], '#fff8ef'); box(c, 0.16, -0.028, 0.06, 0.056, 0.01, STEEL);
    ell(c, -0.1, 0, 0.035, 0.09, '#f7a8c4'); if (fx) for (let i = 0; i < fx; i++) dot(c, 0.25 + i * 0.045, 0, 0.03 - i * 0.004, '#f7a8c4');
  },
  skewers(c) {
    for (const a of [-0.22, 0.22, 0]) { c.save(); c.rotate(a); pen(c, '#d9d2c3', LW * 1.6, [-0.04, 0, 0.42, 0]); box(c, 0.14, -0.035, 0.07, 0.07, 0.015, MEAT);
      box(c, 0.23, -0.035, 0.06, 0.07, 0.02, a ? '#6dbb4a' : '#f2c230'); box(c, 0.31, -0.032, 0.065, 0.064, 0.015, MEAT); c.restore(); }
  },
  hatchet(c) { limb(c, -0.04, 0, 0.24, 0, 0.036, WOOD_D); poly(c, [0.15, -0.02, 0.27, -0.03, 0.29, 0.12, 0.2, 0.085, 0.15, 0.03], STEEL); },
  mallet(c) { limb(c, -0.04, 0, 0.24, 0, 0.036, WOOD_D); box(c, 0.17, -0.09, 0.12, 0.18, 0.025, WOOD_L); },
  scoop(c, fx) { limb(c, -0.04, 0, 0.26, 0, 0.034, STEEL); ell(c, 0.32, 0, 0.085, 0.085, STEEL); ell(c, 0.32, 0, 0.06, 0.06, '#9fd4ee', 0, LW * 0.7); if (fx) for (let i = 0; i < fx; i++) dot(c, 0.44 + i * 0.05, -0.02 * i, 0.03 - i * 0.004, PASTEL[i % 4]); },
  twin(c) { for (const m of [-1, 1]) { c.save(); c.translate(0, m * 0.07); c.rotate(m * 0.12); limb(c, -0.04, 0, 0.05, 0, 0.04, '#3a2c28'); box(c, 0.05, -0.028, 0.22, 0.16, 0.02, STEEL); pen(c, lt(STEEL, 0.6), LW * 1.5, [0.07, 0.115, 0.26, 0.115]); c.restore(); } },
  bigpan(c) { limb(c, -0.03, 0, 0.14, 0, 0.045, '#2e3038'); ell(c, 0.31, 0, 0.19, 0.17, IRON); ell(c, 0.31, 0, 0.14, 0.125, '#6a6f7c', 0, LW * 0.8); glint(c, 0.27, -0.04 * FACE, 0.05, 0.03, 0.35); },
};

// ===================================================================== FIGURES
// One parametric chibi chef covers all infantry and heroes; SPEC says how each one differs.
// Frames per animation and loop length in seconds.
const ANIM = dict({ idle: [2, 1.3], walk: [6, 0.6], attack: [6, 0.75], gather: [4, 0.7], build: [4, 0.62], heal: [4, 1.0] });
const SPEC = dict({
  cook:       { skin: 0, hair: 'brn', hat: 'cap' },
  line:       { skin: 1, hair: 'blk', hat: 'toque', hatH: 0.22, tool: 'pan' },
  butcher:    { skin: 0, hair: 'aub', hat: 'bandana', tool: 'cleaver', w: 1.24, apron: 'stripe', beard: 'stache' },
  saucier:    { skin: 2, hair: 'blk', hat: 'toque', hatH: 0.14, tool: 'ladle', toolK: 1.3, bottle: 1, w: 0.95 },
  barista:    { skin: 1, hair: 'red', hat: 'visor', tool: 'cup', toolK: 1.35, jacket: '#8a6248', style: 'aim', rest: [-0.2, -PI / 2], bun: 1 },
  flambadier: { skin: 0, hair: 'blk', hat: 'beanie', goggles: 1, tool: 'torch', jacket: '#565b68', style: 'aim', rest: [-0.2, -0.3] },
  pinroller:  { skin: 1, hair: 'brn', hat: 'pot', tool: 'pin', w: 1.32, shield: 1, toolK: 1.1 },
  brute:      { skin: 2, hair: 'blk', hat: 'bandana', tool: 'hammer', w: 1.6, k: 1.17, bare: 1, beard: 'stubble', toolK: 1.15, mood: 'stern' },
  dancer:     { skin: 0, hair: 'blk', hat: 'headband', tool: 'yanagi', w: 0.84, jacket: '#3d4259', style: 'thrust', rest: [-0.25, -0.85], knot: 1, apron: 'sash', lean: 0.12 },
  hero_flint: { hero: 1, skin: 0, hair: 'red', hat: 'toque', hatH: 0.44, tool: 'cleaver', toolK: 1.6, mood: 'stern', hairBack: 1, w: 1.12 },
  hero_nonna: { hero: 1, skin: 1, hair: 'gry', hat: 'none', bun: 1, glasses: 1, tool: 'spoon', toolK: 1.35, jacket: '#5d5766', apron: 'white', shawl: 1, w: 1.2, k: 0.94 },
  hero_hank:  { hero: 1, skin: 1, hair: 'brn', hat: 'ballcap', beard: 'full', tool: 'hammer', toolK: 1.45, jacket: '#6d5a4c', w: 1.62, k: 1.1, smoke: 1, mood: 'grin', bare: 1 },
  hero_ryo:   { hero: 1, skin: 0, hair: 'blk', hat: 'headband', knot: 1, eyes: 'calm', tool: 'yanagi', toolK: 1.35, jacket: '#353b50', style: 'thrust', rest: [-0.25, -0.9], apron: 'sash', mood: 'flat', w: 0.95 },
  hero_odile: { hero: 1, skin: 0, hair: 'bld', hat: 'toque', hatH: 0.34, bow: 1, bun: 2, tool: 'piping', toolK: 1.25, style: 'aim', rest: [-0.25, -0.35], mood: 'lips', lashes: 1, w: 0.94 },
  hero_zara:  { hero: 1, skin: 3, hair: 'blk', hat: 'wrap', tool: 'skewers', toolK: 1.2, jacket: '#4b4853', apron: 'half', earring: 1, mood: 'grin', rest: [-0.7, -1.15] },
  hero_dolly: { hero: 1, skin: 2, hair: 'blk', hat: 'pot', bun: 1, tool: 'bigpan', toolK: 1.35, shield: 1, jacket: '#8a3b2a', apron: 'stripe', w: 1.3, k: 1.02, mood: 'stern' },
  hero_kofi:  { hero: 1, skin: 3, hair: 'blk', hat: 'bandana', tool: 'twin', toolK: 1.3, jacket: '#2f3a3f', apron: 'sash', style: 'thrust', rest: [-0.25, -0.85], w: 0.9, lean: 0.1, mood: 'grin', earring: 1 },
  hero_ingrid: { hero: 1, skin: 0, hair: 'bld', hat: 'beret', bun: 1, shawl: 1, lashes: 1, tool: 'scoop', toolK: 1.3, style: 'aim', rest: [-0.2, -0.3], jacket: '#6ea8d8', mood: 'flat', w: 0.94 },
  hero_rafa:  { hero: 1, skin: 1, hair: 'brn', hat: 'visor', beard: 'stubble', bottle: 1, tool: 'ladle', toolK: 1.55, style: 'aim', rest: [-0.2, -0.25], jacket: '#a03a2a', apron: 'half', eyes: 'calm' },
  _crew:      { skin: 1, hair: 'brn', hat: 'beret', k: 0.8 },
  _none:      { skin: 1, hair: 'brn', hat: 'none', jacket: '#b9b3a6' },
});
const HERO_K = 1.35;

function pose(sp, anim, f, hasTool) {
  const st = sp.style || 'swing', rest = hasTool ? (sp.rest || [-0.75, -1.3]) : [1.15, 0];
  const p = { bob: 0, lean: sp.lean || 0, dx: 0, arm: rest[0], tool: rest[1], back: 0, la: 0, lb: 0, ua: 0, ub: 0, sw: 0, fx: 0 };
  if (anim === 'walk') {
    const ph = f / 6 * TAU, sn = Math.sin(ph), cs = Math.cos(ph);
    p.bob = -Math.abs(sn) * 0.042; p.lean += 0.06 + sn * 0.07; p.la = sn * 0.085; p.lb = -sn * 0.085;
    p.ua = Math.max(0, cs) * 0.055; p.ub = Math.max(0, -cs) * 0.055;
    p.arm += sn * 0.22; p.tool += sn * 0.1; p.back = -sn * 0.6;
  } else if (anim === 'heal' || (anim === 'attack' && st === 'aim')) {        // steady forward arm: torch, piping bag, coffee
    const q = f / ANIM[anim][0] * TAU;
    p.arm = -0.12 + Math.sin(q) * 0.07; p.tool = sp.tool === 'cup' ? rest[1] : -0.05;
    p.dx = -Math.max(0, Math.sin(q)) * 0.025; p.lean += 0.08; p.fx = [1, 2, 3, 2, 1, 0][f % 6];
  } else if (anim === 'attack' && st === 'thrust') {
    p.arm = [-0.35, -0.6, -0.05, 0.02, 0, -0.2][f]; p.tool = [-0.5, -0.45, -0.02, 0.02, 0, -0.3][f];
    p.dx = [-0.03, -0.08, 0.1, 0.17, 0.11, 0.03][f]; p.lean = [-0.04, -0.14, 0.22, 0.3, 0.2, 0.06][f];
    p.la = [-0.02, -0.03, -0.1, -0.12, -0.08, -0.02][f]; p.lb = [0, -0.02, 0.05, 0.08, 0.05, 0.01][f];
    p.sw = f === 2 || f === 3 ? 2 : 0;
  } else if (anim === 'attack') {
    p.arm = [-1.75, -2.5, -1.3, 0.38, 0.3, -0.8][f]; p.tool = p.arm + [-0.45, -0.5, -0.1, 0.25, 0.2, -0.35][f];
    p.lean += [-0.04, -0.14, 0.05, 0.22, 0.18, 0.04][f]; p.dx = [0, -0.03, 0.03, 0.07, 0.06, 0.02][f];
    p.sw = f === 2 || f === 3 ? 1 : 0;
  } else if (anim === 'gather' || anim === 'build') {
    p.arm = [-2.25, -1.3, 0.42, 0.1][f]; p.tool = p.arm + [-0.4, -0.2, 0.3, 0.25][f];
    p.lean += [-0.06, 0.04, 0.24, 0.15][f]; p.dx = [0, 0, 0.02, 0.01][f]; p.sw = f === 2 ? 1 : 0;
  } else if (f) { p.bob = 0.012; p.arm += 0.05; }
  return p;
}

let DET = 32;       // px per figure unit: gates fine face detail

function head(c, sp, tc, hx, hy, fl) {
  const hr = HAIR[sp.hair] || HAIR.brn, sk = SKIN[sp.skin || 0], EYE = '#2c1c18', D = DET;
  if (sp.hairBack) { c.beginPath(); circ(c, hx - 0.07, hy - 0.01, 0.165); circ(c, hx - 0.12, hy + 0.09, 0.075); inkU(c, hr); }
  if (sp.bun === 1) ell(c, hx - 0.12, hy - 0.16, 0.085, 0.08, hr);
  if (sp.bun === 2) ell(c, hx - 0.17, hy + 0.03, 0.075, 0.085, hr);
  ell(c, hx, hy, 0.18, 0.168, sk);
  c.beginPath(); c.ellipse(hx, hy, 0.184, 0.172, 0, PI * 0.93, PI * 1.9); c.quadraticCurveTo(hx + 0.03, hy - 0.11, hx - 0.19, hy + 0.045); c.closePath(); ink(c, hr);
  if (sp.knot) ell(c, hx - 0.05, hy - 0.2, 0.055, 0.048, hr);
  if (sp.beard === 'full') {
    c.beginPath();
    for (const [bx, by, br] of [[-0.03, 0.1, 0.095], [0.1, 0.115, 0.09], [0.035, 0.17, 0.1], [0.17, 0.065, 0.045], [-0.11, 0.05, 0.06]]) circ(c, hx + bx, hy + by, br);
    inkU(c, hr);
  }
  if (sp.beard === 'stubble' && L === 1) { c.fillStyle = 'rgba(50,34,30,0.26)'; c.beginPath(); c.ellipse(hx + 0.01, hy + 0.01, 0.172, 0.158, 0, 0.12 * PI, 0.88 * PI); c.closePath(); c.fill(); }
  // --- face (3/4 view: features sit toward the facing side)
  const ex = hx + 0.05, ey = hy + 0.012, mx = hx + 0.095, my = hy + 0.088;
  if (D >= 24 && L === 1) { c.fillStyle = 'rgba(238,104,96,0.32)'; c.beginPath(); c.ellipse(hx + 0.14, hy + 0.068, 0.034, 0.022, 0, 0, TAU); c.fill(); }
  if (sp.goggles) {
    pen(c, '#3a3038', 0.04, [hx - 0.178, ey - 0.012, hx + 0.178, ey - 0.012]);
    for (const dx of [-0.005, 0.092]) { ell(c, ex + dx, ey, 0.05, 0.05, '#4a4048'); ell(c, ex + dx, ey, 0.032, 0.032, '#ffb548', 0, 0); glint(c, ex + dx - 0.01 * FACE, ey - 0.012, 0.012, 0.009, 0.8); }
  } else if (sp.eyes === 'calm') {
    for (const dx of [0, 0.088]) { c.beginPath(); c.arc(ex + dx, ey - 0.012, 0.026, 0.12 * PI, 0.88 * PI); pen(c, EYE, Math.max(LW * 1.4, 0.014)); }
  } else if (L === 1) {
    for (const dx of [0, 0.088]) {
      c.fillStyle = EYE; c.beginPath(); c.ellipse(ex + dx, ey, 0.021, 0.029, 0, 0, TAU); c.fill();
      if (D >= 40) dot(c, ex + dx - 0.007 * FACE, ey - 0.011, 0.008, '#fff');
      if (sp.lashes && D >= 36) pen(c, EYE, LW, [ex + dx + 0.012, ey - 0.02, ex + dx + 0.04, ey - 0.04]);
    }
  }
  if (sp.glasses && L === 1) {
    for (const dx of [0, 0.088]) { c.beginPath(); c.arc(ex + dx, ey, 0.043, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.32)'; c.fill(); pen(c, '#5a4a44', LW * 1.25); }
    pen(c, '#5a4a44', LW * 1.25, [ex - 0.043, ey, ex - 0.1, ey - 0.02]);
  }
  if (D >= 40) {                                   // brows
    const bc = sp.mood === 'stern' ? EYE : dk(hr, 0.2), dy = sp.mood === 'stern' ? 0.024 : -0.006;
    pen(c, bc, LW * 1.7, [ex - 0.036, ey - 0.064, ex + 0.022, ey - 0.064 + dy]); pen(c, bc, LW * 1.7, [ex + 0.066, ey - 0.064 + dy, ex + 0.124, ey - 0.064]);
  }
  if (D >= 64) { c.beginPath(); c.moveTo(mx + 0.008, hy + 0.03); c.quadraticCurveTo(mx + 0.03, hy + 0.05, mx + 0.006, hy + 0.056); pen(c, dk(sk, 0.3), LW); }   // nose
  if (sp.beard === 'stache') { ell(c, mx - 0.032, my - 0.012, 0.042, 0.022, hr, -0.25); ell(c, mx + 0.032, my - 0.012, 0.042, 0.022, hr, 0.25); }
  else if (D >= 28 && L === 1) {                   // mouth
    const m = sp.mood;
    c.beginPath();
    if (m === 'lips') { c.ellipse(mx, my, 0.024, 0.015, 0, 0, TAU); c.fillStyle = '#c8384e'; c.fill(); }
    else if (m === 'grin') { c.arc(mx, my - 0.025, 0.04, 0.05 * PI, 0.95 * PI); c.closePath(); c.fillStyle = '#fff'; c.fill(); pen(c, EYE, LW); }
    else {
      if (m === 'stern') c.arc(mx, my + 0.03, 0.032, 1.2 * PI, 1.8 * PI); else if (m === 'flat') { c.moveTo(mx - 0.025, my); c.lineTo(mx + 0.025, my); } else c.arc(mx, my - 0.025, 0.032, 0.2 * PI, 0.8 * PI);
      pen(c, EYE, LW * 1.25);
    }
  }
  if (sp.earring) { c.beginPath(); c.arc(hx - 0.085, hy + 0.12, 0.03, 0, TAU); pen(c, GOLD, Math.max(LW * 1.6, 0.016)); }
  // --- headwear
  const y0 = hy - 0.095;                             // forehead line
  switch (sp.hat) {
    case 'toque':
      toque(c, hx, y0, (sp.hatH || 0.2) + 0.075, sp.hero ? GOLD : tc);
      if (sp.bow) { poly(c, [hx + 0.1, y0 - 0.04, hx + 0.2, y0 - 0.1, hx + 0.2, y0 + 0.02], '#f7a8c4'); poly(c, [hx + 0.1, y0 - 0.04, hx, y0 - 0.1, hx, y0 + 0.02], '#f7a8c4');
        ell(c, hx + 0.1, y0 - 0.04, 0.025, 0.025, '#ee86ad'); }
      break;
    case 'cap':
      c.beginPath(); c.moveTo(hx - 0.172, y0); c.bezierCurveTo(hx - 0.215, y0 - 0.215, hx + 0.215, y0 - 0.215, hx + 0.172, y0); c.closePath(); ink(c, WHITE);
      box(c, hx - 0.176, y0 - 0.04, 0.352, 0.05, 0.02, tc);
      break;
    case 'beret':
      ell(c, hx - 0.02, y0 - 0.045, 0.2, 0.085, tc, -0.12); dot(c, hx - 0.02, y0 - 0.125, 0.02, dk(tc, 0.3));
      break;
    case 'beanie':
      c.beginPath(); c.moveTo(hx - 0.178, y0 + 0.01); c.bezierCurveTo(hx - 0.2, y0 - 0.22, hx + 0.2, y0 - 0.22, hx + 0.178, y0 + 0.01); c.closePath(); ink(c, tc);
      box(c, hx - 0.185, y0 - 0.045, 0.37, 0.06, 0.025, dk(tc, 0.16));
      break;
    case 'bandana':
      poly(c, [hx - 0.16, hy - 0.06, hx - 0.31, hy - 0.04 + fl, hx - 0.27, hy - 0.1], tc); poly(c, [hx - 0.16, hy - 0.05, hx - 0.29, hy + 0.06 + fl, hx - 0.22, hy - 0.01], tc);
      c.beginPath(); c.moveTo(hx - 0.186, hy - 0.02); c.bezierCurveTo(hx - 0.21, hy - 0.27, hx + 0.21, hy - 0.27, hx + 0.186, hy - 0.08); c.quadraticCurveTo(hx, hy - 0.135, hx - 0.186, hy - 0.02); c.closePath(); ink(c, tc);
      ell(c, hx - 0.175, hy - 0.045, 0.032, 0.032, dk(tc, 0.14));
      break;
    case 'visor':
      box(c, hx - 0.183, y0 - 0.03, 0.366, 0.062, 0.02, tc); ell(c, hx + 0.2, y0 + 0.012, 0.125, 0.036, dk(tc, 0.12), 0.1);
      break;
    case 'headband':
      limb(c, hx - 0.17, y0, hx - 0.31, y0 + 0.03 + fl, 0.035, tc); limb(c, hx - 0.17, y0 + 0.01, hx - 0.29, y0 + 0.1 + fl, 0.035, tc);
      box(c, hx - 0.185, y0 - 0.025, 0.37, 0.055, 0.015, tc); if (sp.hero) dot(c, hx + 0.09, y0 + 0.002, 0.018, GOLD);
      break;
    case 'pot':
      limb(c, hx - 0.18, y0 - 0.09, hx - 0.3, y0 - 0.09, 0.035, IRON);
      box(c, hx - 0.185, y0 - 0.2, 0.37, 0.215, 0.05, STEEL); box(c, hx - 0.185, y0 - 0.1, 0.37, 0.06, 0, tc, LW * 0.7);
      box(c, hx - 0.205, y0 - 0.012, 0.41, 0.045, 0.02, dk(STEEL, 0.16)); glint(c, hx - 0.09 * FACE, y0 - 0.16, 0.05, 0.02, 0.6);
      break;
    case 'ballcap':
      ell(c, hx + 0.2, y0 + 0.01, 0.14, 0.04, dk(tc, 0.2), 0.08);
      c.beginPath(); c.moveTo(hx - 0.186, y0 + 0.01); c.bezierCurveTo(hx - 0.2, y0 - 0.2, hx + 0.2, y0 - 0.2, hx + 0.186, y0 + 0.01); c.closePath(); ink(c, tc);
      dot(c, hx, y0 - 0.14, 0.02, GOLD);
      break;
    case 'wrap':
      c.beginPath(); circ(c, hx - 0.015, y0 - 0.06, 0.175); circ(c, hx - 0.07, y0 - 0.17, 0.125); circ(c, hx + 0.05, y0 - 0.22, 0.1); inkU(c, tc);
      c.beginPath(); c.moveTo(hx - 0.17, y0 - 0.03); c.quadraticCurveTo(hx, y0 - 0.2, hx + 0.13, y0 - 0.25); pen(c, GOLD, Math.max(LW * 1.5, 0.018));
      c.beginPath(); c.moveTo(hx - 0.1, y0 + 0.01); c.quadraticCurveTo(hx + 0.05, y0 - 0.1, hx + 0.17, y0 - 0.09); pen(c, dk(tc, 0.25), LW * 1.3);
      break;
  }
}

function carried(c, kind, x, y) {
  if (kind === 'food') {
    carrot(c, x - 0.07, y - 0.1, 0.5, PI / 2 - 0.35); carrot(c, x + 0.07, y - 0.1, 0.5, PI / 2 + 0.35); carrot(c, x, y - 0.13, 0.55, PI / 2);
    poly(c, [x - 0.13, y - 0.03, x + 0.13, y - 0.03, x + 0.1, y + 0.12, x - 0.1, y + 0.12], '#cf9f58'); pen(c, '#a5743a', LW, [x - 0.12, y + 0.03, x + 0.12, y + 0.03]);
    box(c, x - 0.14, y - 0.05, 0.28, 0.04, 0.02, '#b98443');
  } else if (kind === 'wood') {
    logPiece(c, x - 0.13, y + 0.07, 0.25, 0.05, 0); logPiece(c, x - 0.1, y - 0.02, 0.25, 0.05, 0); logPiece(c, x - 0.15, y - 0.02, 0.2, 0.045, -0.05);
    pen(c, '#e9dcc0', LW * 1.6, [x + 0.0, y - 0.07, x + 0.0, y + 0.12]);
  } else if (kind === 'spice') {
    ell(c, x, y - 0.06, 0.1, 0.07, '#de3a2a'); chili(c, x - 0.02, y - 0.1, 0.42, -0.5); sack(c, x, y + 0.13, 0.62, '#d9bf8f');
    ell(c, x, y - 0.055, 0.085, 0.032, '#c22f22', 0, LW * 0.7);
  } else {
    crystal(c, x - 0.055, y - 0.02, 0.08, 0.14, -0.2); crystal(c, x + 0.06, y - 0.02, 0.075, 0.12, 0.25); crystal(c, x, y - 0.02, 0.09, 0.17, 0);
    box(c, x - 0.13, y - 0.035, 0.26, 0.155, 0.02, WOOD_L); pen(c, WOOD_D, LW, [x - 0.13, y + 0.04, x + 0.13, y + 0.04]);
  }
}

/** The chibi chef. Drawn facing +x with the feet on the origin. */
function figure(c, sp, tc, anim, f, carry) {
  const toolKey = carry ? null : anim === 'gather' ? 'hatchet' : (anim === 'build' || (anim === 'attack' && !sp.tool)) ? 'mallet' : sp.tool;
  const w = sp.w || 1, jk = sp.jacket || WHITE, sk = SKIN[sp.skin || 0], p = pose(sp, anim, f, !!toolKey);
  const aw = sp.bare ? 0.105 : 0.085, fl = anim === 'walk' ? Math.sin(f / 6 * TAU) * 0.03 : f % 2 ? 0.012 : 0;
  shadow(c, 0, 0, 0.19 * w + 0.05, 0.075);
  if (sp.hero && L === 0) {                           // boss ring on the ground
    c.beginPath(); c.ellipse(0, -0.005, 0.34, 0.125, 0, 0, TAU);
    c.strokeStyle = rgba(GOLD, 0.32); c.lineWidth = 0.11; c.stroke(); c.strokeStyle = 'rgba(255,236,150,0.97)'; c.lineWidth = Math.max(0.03, LW * 1.7); c.stroke();
  }
  c.save(); c.translate(p.dx, 0);
  for (const [lx, off, up] of [[-0.075 * w, p.la, p.ua], [0.075 * w, p.lb, p.ub]]) {     // legs
    limb(c, lx, -0.16, lx + off * 0.6, -0.07 - up, 0.085, PANTS);
    ell(c, lx + off + 0.018, -0.036 - up, 0.082, 0.046, SHOE);
  }
  c.translate(0, -0.13 + p.bob); c.rotate(p.lean); c.translate(0, 0.13);
  const sx = 0.085 * w, sy = -0.35, AL = 0.165;
  if (sp.hero && !sp.shawl) {                         // cape
    const cf = anim === 'walk' ? 0.07 + fl : anim === 'attack' ? 0.06 : fl;
    c.beginPath(); c.moveTo(-0.13 * w, -0.42); c.lineTo(0.02, -0.42); c.quadraticCurveTo(-0.05, -0.22, -0.09 - cf, -0.06);
    c.quadraticCurveTo(-0.2 - cf, -0.1, -0.3 * Math.min(w, 1.25) - cf * 2, -0.04); c.quadraticCurveTo(-0.25 * Math.min(w, 1.25), -0.25, -0.13 * w, -0.42); c.closePath(); ink(c, dk(tc, 0.1));
  }
  { const b = PI / 2 + 0.28 + p.back * 0.5, bx = -0.1 * w, by = -0.345;                    // back arm
    limb(c, bx, by, bx + Math.cos(b) * AL * 0.8, by + Math.sin(b) * AL * 0.8, aw, sp.bare ? sk : dk(jk, 0.08));
    ell(c, bx + Math.cos(b) * AL, by + Math.sin(b) * AL, 0.045, 0.045, sk);
    if (sp.bottle) { const qx = bx + Math.cos(b) * AL - 0.07, qy = by + Math.sin(b) * AL;
      poly(c, [qx - 0.02, qy - 0.03, qx + 0.02, qy - 0.03, qx + 0.008, qy - 0.115, qx - 0.008, qy - 0.115], WHITE); box(c, qx - 0.058, qy - 0.035, 0.116, 0.175, 0.035, SAUCE);
      glint(c, qx - 0.025 * FACE, qy + 0.03, 0.014, 0.05, 0.5); }
  }
  const wt = 0.15 * w, wb = 0.185 * w, yT = -0.415, yB = -0.115;                           // torso
  c.beginPath(); c.moveTo(-wt, yT + 0.06); c.quadraticCurveTo(-wt, yT, -wt + 0.06, yT); c.lineTo(wt - 0.06, yT); c.quadraticCurveTo(wt, yT, wt, yT + 0.06);
  c.lineTo(wb, yB - 0.04); c.quadraticCurveTo(wb, yB, wb - 0.04, yB); c.lineTo(-wb + 0.04, yB); c.quadraticCurveTo(-wb, yB, -wb, yB - 0.04); c.closePath(); ink(c, jk);
  const ax0 = -0.095 * w, ax1 = 0.175 * w, ap = sp.apron || 'full';                        // apron: the big team-colour area
  if (ap === 'sash') { box(c, -wb - 0.005, -0.275, wb * 2 + 0.01, 0.075, 0.02, tc); poly(c, [0.01, -0.21, 0.15 * w, -0.21, 0.13 * w, -0.06, 0.04, -0.085], tc);
    poly(c, [-wt, yT + 0.03, -wt + 0.07, yT, wb, -0.24, wb - 0.02, -0.2], tc, LW * 0.8); }
  else if (ap === 'half') { box(c, ax0 - 0.04, -0.27, ax1 - ax0 + 0.05, 0.19, 0.035, tc); pen(c, dk(tc, 0.28), LW * 1.4, [ax0 - 0.04, -0.235, ax1 + 0.01, -0.235]);
    poly(c, [-wt + 0.02, yT + 0.01, wt - 0.02, yT + 0.01, 0.03, yT + 0.1], tc, LW * 0.8); }
  else {
    box(c, ax0, -0.365, ax1 - ax0, 0.285, 0.04, ap === 'full' ? tc : WHITE);
    if (ap === 'stripe') for (let i = 0; i < 3; i++) pen(c, tc, 0.036 * w, [ax0 + (ax1 - ax0) * (0.2 + i * 0.3), -0.35, ax0 + (ax1 - ax0) * (0.2 + i * 0.3), -0.095]);
    pen(c, dk(ap === 'full' ? tc : '#cbbfa8', 0.25), LW * 1.4, [ax0, -0.25, ax1, -0.25]);
    if (sp.hero) { c.beginPath(); rr(c, ax0, -0.365, ax1 - ax0, 0.285, 0.04); pen(c, GOLD, Math.max(LW * 1.3, 0.016)); }
  }
  if (sp.shawl) { poly(c, [-wt - 0.03, -0.43, wt + 0.03, -0.43, wb + 0.03, -0.3, 0.03, -0.19, -wb - 0.03, -0.3], tc); pen(c, GOLD, Math.max(LW * 1.3, 0.016), [-wb - 0.02, -0.3, 0.03, -0.195, wb + 0.02, -0.3]); }
  if (sp.hero && !sp.shawl) ell(c, sx + 0.02, sy - 0.035, 0.05, 0.03, GOLD);                // epaulette
  if (sp.shield) { ell(c, -0.07, -0.25, 0.155, 0.16, STEEL); ell(c, -0.07, -0.25, 0.1, 0.105, tc, 0, LW * 0.8); ell(c, -0.07, -0.25, 0.035, 0.036, '#3b3a40'); glint(c, -0.07 - 0.06 * FACE, -0.32, 0.04, 0.025, 0.6); }
  head(c, sp, tc, 0.015, -0.555, fl);
  if (carry) {                                        // both hands on a full basket
    limb(c, sx, sy, 0.16, -0.27, aw, jk); carried(c, carry, 0.21, -0.25); ell(c, 0.12, -0.2, 0.045, 0.045, sk);
  } else {
    const hx = sx + Math.cos(p.arm) * AL, hy = sy + Math.sin(p.arm) * AL;
    limb(c, sx, sy, sx + (hx - sx) * 0.8, sy + (hy - sy) * 0.8, aw, sp.bare ? sk : jk);
    if (toolKey) { c.save(); c.translate(hx, hy); c.rotate(p.tool); scaled(c, 0, 0, toolKey === sp.tool ? sp.toolK || 1 : 1, () => TOOLS[toolKey](c, p.fx)); c.restore(); }
    ell(c, hx, hy, 0.047, 0.047, sk);
    if (L === 2) {
      if (p.sw === 1) { c.strokeStyle = 'rgba(255,255,255,0.65)'; c.lineWidth = 0.05; c.beginPath(); c.arc(sx, sy, 0.44 * (sp.toolK || 1), p.arm - 1.1, p.arm + 0.05); c.stroke(); }
      if (p.sw === 2) { c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 0.03; for (const dy of [-0.05, 0.03]) { c.beginPath(); c.moveTo(hx - 0.25, hy + dy); c.lineTo(hx + 0.2, hy + dy); c.stroke(); } }
      if (sp.tool === 'cup' && toolKey === 'cup') { puff(c, hx + 0.09 + fl, hy - 0.3 - p.fx * 0.02, 0.035, '#fff', 0.6); puff(c, hx + 0.05, hy - 0.39 - p.fx * 0.025, 0.028, '#fff', 0.4); }
    }
  }
  if (sp.smoke) { puff(c, -0.26, -0.5 - fl * 2, 0.07, '#d8d2cc', 0.4); puff(c, -0.34, -0.66 - fl * 3, 0.055, '#d8d2cc', 0.28); puff(c, -0.3, -0.8 - fl * 2, 0.04, '#d8d2cc', 0.18); }
  c.restore();
}

// ============================================================ VEHICLES & SIEGE
const SPIN = PI / 9;                                  // wheel rotation per walk frame (loops seamlessly over 6 frames)
const LUNGE = [-0.03, -0.08, 0.07, 0.14, 0.08, 0.02];
function exhaust(c, x, y, f) { for (let i = 0; i < 3; i++) { const q = (f + i * 2) % 6; puff(c, x - q * 0.035, y - q * 0.018, 0.035 + q * 0.008, '#efe9df', 0.5 - q * 0.075); } }

function scooterArt(c, tc, anim, f, lancer) {
  const mv = anim === 'walk', atk = anim === 'attack', rot = mv ? f * SPIN : 0, bob = mv ? (f % 2 ? -0.014 : 0) : (f % 2 ? 0.006 : 0);
  shadow(c, 0, 0, 0.47, 0.09);
  c.save(); c.translate(atk ? LUNGE[f] : 0, 0);
  if (atk) { c.translate(-0.28, -0.1); c.rotate([0, -0.05, -0.17, -0.1, -0.03, 0][f]); c.translate(0.28, 0.1); }      // little wheelie
  wheel(c, -0.28, -0.115, 0.115, rot); wheel(c, 0.31, -0.115, 0.115, rot);
  c.translate(0, bob);
  if (!lancer) { box(c, -0.6, -0.69, 0.27, 0.27, 0.035, WHITE); box(c, -0.615, -0.72, 0.3, 0.085, 0.025, tc); dot(c, -0.465, -0.53, 0.04, tc); }   // delivery box
  else { limb(c, -0.42, -0.42, -0.5, -0.95, 0.022, WOOD_D); poly(c, [-0.5, -0.96, -0.5, -0.76, -0.76, -0.86 + (f % 2) * 0.03], tc); }                 // pennant
  c.beginPath(); c.moveTo(-0.46, -0.22); c.quadraticCurveTo(-0.48, -0.41, -0.3, -0.42); c.lineTo(-0.1, -0.41); c.quadraticCurveTo(-0.02, -0.39, -0.01, -0.25);
  c.lineTo(0.2, -0.25); c.lineTo(0.22, -0.17); c.lineTo(-0.4, -0.17); c.closePath(); ink(c, tc);                                                      // cowl + floorboard
  box(c, -0.37, -0.465, 0.3, 0.065, 0.03, '#4a3a36');                                                                                               // seat
  c.beginPath(); c.arc(0.31, -0.115, 0.175, PI * 1.08, PI * 1.92); c.arc(0.31, -0.115, 0.125, PI * 1.92, PI * 1.08, true); c.closePath(); ink(c, tc);   // fender
  limb(c, 0.2, -0.21, 0.275, -0.52, 0.08, tc);                                                                                                      // leg shield
  ell(c, 0.325, -0.45, 0.04, 0.048, '#ffe58a'); limb(c, 0.255, -0.53, 0.3, -0.6, 0.035, IRON);
  // rider
  limb(c, -0.19, -0.47, 0.02, -0.4, 0.09, PANTS); limb(c, 0.02, -0.4, 0.08, -0.27, 0.08, PANTS); ell(c, 0.11, -0.245, 0.075, 0.042, SHOE);
  c.save(); c.translate(-0.2, -0.46); c.rotate(0.16);
  box(c, -0.125, -0.3, 0.25, 0.32, 0.08, WHITE); box(c, -0.02, -0.25, 0.13, 0.26, 0.03, lancer ? tc : dk(WHITE, 0.07), LW * 0.8);
  const hx = 0.03, hy = -0.44;
  if (lancer) { poly(c, [hx - 0.14, hy - 0.06, hx - 0.3, hy - 0.04 + bob * 2, hx - 0.25, hy - 0.11], tc); poly(c, [hx - 0.14, hy - 0.05, hx - 0.28, hy + 0.06, hx - 0.2, hy - 0.01], tc); }
  ell(c, hx, hy, 0.165, 0.155, SKIN[lancer ? 2 : 1]);
  if (L === 1) { c.fillStyle = '#2c1c18'; for (const dx of [0.055, 0.13]) { c.beginPath(); c.ellipse(hx + dx, hy + 0.012, 0.019, 0.027, 0, 0, TAU); c.fill(); } }
  c.beginPath(); c.moveTo(hx - 0.175, hy - 0.01); c.bezierCurveTo(hx - 0.2, hy - 0.25, hx + 0.2, hy - 0.25, hx + 0.175, hy - 0.06); c.quadraticCurveTo(hx, hy - 0.1, hx - 0.175, hy - 0.01); c.closePath();
  ink(c, lancer ? tc : WHITE);
  if (!lancer) { box(c, hx - 0.18, hy - 0.085, 0.36, 0.05, 0.02, tc); } else dot(c, hx + 0.06, hy - 0.13, 0.022, GOLD);
  c.restore();
  if (lancer) {                                                                                                                                     // couched kebab lance
    const th = atk ? [-0.06, -0.14, 0.1, 0.2, 0.1, 0][f] : 0;
    c.save(); c.translate(th, 0); c.rotate(-0.06);
    pen(c, '#e4dfd4', Math.max(LW * 1.6, 0.03), [-0.45, -0.6, 0.86, -0.6]); poly(c, [0.84, -0.63, 0.98, -0.6, 0.84, -0.57], '#f1f4f5');
    box(c, 0.42, -0.655, 0.1, 0.11, 0.025, MEAT); box(c, 0.54, -0.65, 0.085, 0.1, 0.03, '#6dbb4a'); box(c, 0.645, -0.655, 0.1, 0.11, 0.025, MEAT); box(c, 0.76, -0.645, 0.075, 0.09, 0.03, '#e8452f');
    c.restore();
  }
  limb(c, -0.14, -0.66, 0.2, -0.585, 0.08, WHITE); ell(c, 0.26, -0.575, 0.045, 0.045, SKIN[lancer ? 2 : 1]);                                         // arm to the bars
  if (mv) exhaust(c, -0.52, -0.2, f);
  c.restore();
}

function truckArt(c, tc, anim, f) {
  const mv = anim === 'walk', atk = anim === 'attack', rot = mv ? f * SPIN : 0;
  shadow(c, 0, 0, 0.64, 0.12);
  c.save(); c.translate(atk ? LUNGE[f] : 0, 0);
  wheel(c, -0.33, -0.125, 0.125, rot); wheel(c, 0.34, -0.125, 0.125, rot);
  c.translate(0, mv ? (f % 2 ? -0.014 : 0) : (f % 2 ? 0.005 : 0)); if (atk) c.rotate([0, -0.02, 0.03, 0.05, 0.02, 0][f]);
  poly(c, [-0.55, -0.76, 0.3, -0.76, 0.23, -0.87, -0.49, -0.87], lt(tc, 0.3));                                 // roof (top face)
  box(c, -0.36, -0.95, 0.11, 0.1, 0.02, STEEL); box(c, -0.38, -0.97, 0.15, 0.04, 0.015, dk(STEEL, 0.2));
  scaled(c, -0.02, -0.82, 0.62, () => toque(c, 0, 0, 0.26, GOLD));                                             // roof sign
  c.beginPath(); c.moveTo(-0.58, -0.2); c.lineTo(-0.58, -0.72); c.quadraticCurveTo(-0.58, -0.77, -0.53, -0.77); c.lineTo(0.3, -0.77);
  c.lineTo(0.45, -0.52); c.lineTo(0.56, -0.49); c.quadraticCurveTo(0.6, -0.48, 0.6, -0.43); c.lineTo(0.6, -0.2); c.closePath(); ink(c, tc);
  box(c, -0.58, -0.29, 1.18, 0.09, 0.02, dk(tc, 0.2)); box(c, 0.53, -0.27, 0.1, 0.075, 0.02, STEEL);           // skirt + bumper
  poly(c, [0.2, -0.71, 0.285, -0.71, 0.4, -0.52, 0.2, -0.52], '#c6ecf5'); glint(c, 0.25, -0.63, 0.02, 0.06, 0.7, 0.5);
  box(c, -0.47, -0.61, 0.57, 0.22, 0.02, '#4a3530'); ell(c, -0.3, -0.45, 0.07, 0.065, SKIN[1], 0, LW * 0.8); scaled(c, -0.3, -0.5, 0.42, () => toque(c, 0, 0, 0.24, WHITE));
  box(c, -0.5, -0.41, 0.63, 0.05, 0.015, WOOD_L);                                                              // counter
  poly(c, [-0.5, -0.7, 0.13, -0.7, 0.18, -0.57, -0.55, -0.57], WHITE);                                         // striped awning
  if (L === 1) { c.fillStyle = dk(tc, 0.18); for (let i = 0; i < 4; i++) { const u = i / 4 + 0.03; c.beginPath(); c.moveTo(lerp(-0.5, 0.13, u), -0.7);
    c.lineTo(lerp(-0.5, 0.13, u + 0.125), -0.7); c.lineTo(lerp(-0.55, 0.18, u + 0.125), -0.57); c.lineTo(lerp(-0.55, 0.18, u), -0.57); c.fill(); } }
  ell(c, 0.575, -0.38, 0.022, 0.04, '#ffe58a');
  if (mv) exhaust(c, -0.62, -0.22, f);
  c.restore();
}

function catapultArt(c, tc, anim, f, bare) {
  const rot = anim === 'walk' ? f * SPIN : 0, atk = anim === 'attack';
  const a = atk ? [3.6, 3.72, 2.6, 1.25, 1.42, 2.9][f] : 3.6, loaded = !atk || f < 3;
  const P = [0.08, -0.56], ux = Math.cos(a), uy = -Math.sin(a), bx = P[0] + ux * 0.47, by = P[1] + uy * 0.47;
  shadow(c, 0, 0, 0.6, 0.11);
  c.save(); if (atk && f === 3) c.translate(0.02, 0);
  if (!bare) { limb(c, 0.42, -0.2, 0.42, -0.74, 0.022, WOOD_D); poly(c, [0.42, -0.75, 0.42, -0.57, 0.64, -0.66], tc); }  // pennant
  limb(c, 0.32, -0.2, P[0] + 0.03, P[1], 0.055, WOOD_D);
  wheel(c, -0.35, -0.12, 0.12, rot, tc); wheel(c, 0.35, -0.12, 0.12, rot, tc);
  limb(c, -0.52, -0.21, 0.5, -0.21, 0.07, WOOD);
  if (!bare) { box(c, -0.21, -0.39, 0.42, 0.17, 0.025, tc); pen(c, dk(tc, 0.3), LW, [-0.21, -0.305, 0.21, -0.305]); }   // painted side board
  limb(c, P[0] - ux * 0.15, P[1] - uy * 0.15, bx - ux * 0.1, by - uy * 0.1, 0.055, WOOD_L);                            // spoon arm
  ell(c, P[0] - ux * 0.18, P[1] - uy * 0.18, 0.085, 0.085, IRON);                                                      // counterweight
  c.save(); c.translate(bx, by); c.rotate(Math.atan2(uy, ux)); ell(c, 0, 0, 0.15, 0.1, WOOD_L); ell(c, 0.005, -0.012 * Math.sign(ux || 1), 0.105, 0.06, dk(WOOD_L, 0.16), 0, LW * 0.7); c.restore();
  if (loaded && !bare) meatball(c, bx, by - 0.075, 0.115);
  limb(c, -0.16, -0.2, P[0] - 0.03, P[1], 0.055, WOOD_D); ell(c, P[0], P[1], 0.04, 0.04, IRON);
  if (L === 2 && atk && (f === 3 || f === 2)) { c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 0.05; c.beginPath(); c.arc(P[0], P[1], 0.5, -a - 0.1, -a + 1.1); c.stroke(); }
  c.restore();
}

function ramArt(c, tc, anim, f) {
  const rot = anim === 'walk' ? f * SPIN : 0;
  const sw = anim === 'attack' ? [-0.08, -0.17, 0.06, 0.2, 0.1, 0][f] : anim === 'walk' ? Math.sin(f / 6 * TAU) * 0.02 : f % 2 ? 0.008 : 0;
  shadow(c, 0, 0, 0.62, 0.11);
  limb(c, -0.42, -0.2, -0.31, -0.76, 0.05, WOOD_D); limb(c, 0.42, -0.2, 0.31, -0.76, 0.05, WOOD_D);
  wheel(c, -0.37, -0.11, 0.11, rot, tc); wheel(c, 0, -0.11, 0.11, rot, tc); wheel(c, 0.37, -0.11, 0.11, rot, tc);
  limb(c, -0.5, -0.2, 0.5, -0.2, 0.06, WOOD);
  pen(c, '#efe4cb', Math.max(LW * 1.4, 0.02), [-0.24, -0.74, -0.24 + sw, -0.45]); pen(c, '#efe4cb', Math.max(LW * 1.4, 0.02), [0.24, -0.74, 0.24 + sw, -0.45]);
  c.save(); c.translate(sw, 0);                                                                                        // the baguette
  box(c, -0.56, -0.47, 1.24, 0.21, 0.105, CRUST);
  if (L === 1) { c.fillStyle = 'rgba(120,60,20,0.22)'; c.beginPath(); rr(c, -0.54, -0.35, 1.2, 0.085, 0.04); c.fill(); }
  for (let i = 0; i < 5; i++) pen(c, lt(CRUST, 0.55), Math.max(LW * 1.8, 0.03), [-0.4 + i * 0.22, -0.44, -0.3 + i * 0.22, -0.37]);
  c.restore();
  poly(c, [-0.45, -0.72, 0.45, -0.72, 0.36, -0.93, -0.36, -0.93], tc);                                                // canopy
  if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.22)'; c.beginPath(); c.moveTo(-0.36, -0.93); c.lineTo(0.36, -0.93); c.lineTo(0.39, -0.86); c.lineTo(-0.39, -0.86); c.fill(); }
  box(c, -0.47, -0.745, 0.94, 0.055, 0.02, dk(tc, 0.2));
}

function mortarArt(c, tc, anim, f) {
  const rot = anim === 'walk' ? f * SPIN : 0, atk = anim === 'attack', rc = atk ? [0, 0.01, 0.07, 0.045, 0.02, 0][f] : 0;
  shadow(c, 0.1, 0, 0.4, 0.085);
  const k = 0.82; DET = S * k;
  scaled(c, -0.28, 0, k, () => figure(c, SPEC._crew, tc, atk ? 'idle' : anim, atk ? (f > 1 && f < 4 ? 1 : 0) : f, null));
  limb(c, 0.2, -0.2, 0.0, -0.035, 0.05, WOOD_D);                                                                      // trail leg
  c.save(); c.translate(0.2, -0.24); c.rotate(-1.0);
  c.save(); c.translate(0.41 - rc, 0); c.rotate(PI / 2); macaron(c, 0, 0, 0.12, PASTEL[0]); c.restore();
  ell(c, -0.1 - rc, 0, 0.06, 0.115, '#77838f'); poly(c, [-0.1 - rc, -0.115, 0.32 - rc, -0.135, 0.32 - rc, 0.135, -0.1 - rc, 0.115], '#8590a0');
  box(c, 0.0 - rc, -0.124, 0.16, 0.248, 0, tc, LW * 0.8); box(c, 0.29 - rc, -0.16, 0.08, 0.32, 0.03, '#aab4bf');
  c.restore();
  wheel(c, 0.2, -0.12, 0.12, rot, tc);
  macaron(c, 0.47, -0.05, 0.075, PASTEL[1]); macaron(c, 0.38, -0.045, 0.07, PASTEL[2]); macaron(c, 0.43, -0.125, 0.07, PASTEL[3]);
  if (atk && (f === 2 || f === 3)) { puff(c, 0.47, -0.72, 0.11 + f * 0.02, '#fbd3e2', 0.6); puff(c, 0.56, -0.8, 0.07, '#fff', 0.5); }
}

function unitArt(c, type, tc, anim, f, carry) {
  switch (type) {
    case 'scooter': return scaled(c, 0, 0, 0.9, () => scooterArt(c, tc, anim, f, false));
    case 'skewer': return scaled(c, 0, 0, 0.9, () => scooterArt(c, tc, anim, f, true));
    case 'truck': return truckArt(c, tc, anim, f);
    case 'catapult': return catapultArt(c, tc, anim, f);
    case 'ram': return ramArt(c, tc, anim, f);
    case 'mortar': return mortarArt(c, tc, anim, f);
  }
  const sp = SPEC[type] || SPEC._none, k = (sp.k || 1) * (sp.hero ? HERO_K : 1);
  DET = S * k;
  scaled(c, 0, 0, k, () => figure(c, sp, tc, anim, f, carry));
}

const UBOX = [1.6, 2.4, 1.6, 0.45];
const safeColor = (col) => (typeof col === 'string' && col ? col : '#9a9a9a');
const ANIM_LIST = ['idle', 'walk', 'attack', 'gather', 'build', 'heal'], CARRY_LIST = ['', 'food', 'wood', 'spice', 'salt'];
const ANIM_ID = dict({ idle: 0, walk: 1, attack: 2, gather: 3, build: 4, heal: 5 }), CARRY_ID = dict({ food: 1, wood: 2, spice: 3, salt: 4 });
const UNIT_ID = new Map(Object.keys(UNITS).map((k, i) => [k, i]));

/**
 * Draw one unit with its feet on (x,y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type   a UNITS key (anything else draws a neutral placeholder figure)
 * @param {string} color  team colour (hex)
 * @param {number} scale  canvas pixels per tile
 * @param {{face?:1|-1, anim?:'idle'|'walk'|'attack'|'gather'|'build'|'heal', t?:number, carry?:null|'food'|'wood'|'spice'|'salt'}} [o]
 *        `carry` only shows on Prep Cooks while idle or walking.
 */
export function drawUnit(ctx, type, color, x, y, scale, o) {
  const ai = (o && ANIM_ID[o.anim]) | 0, anim = ANIM_LIST[ai], A = ANIM[anim], n = A[0];
  const f = ((Math.floor(((o && +o.t) || 0) / A[1] * n) % n) + n) % n, fi = o && o.face < 0 ? 1 : 0;
  const ci = ai < 2 && type === 'cook' && o && o.carry ? CARRY_ID[o.carry] | 0 : 0;
  const col = safeColor(color), ti = UNIT_ID.get(type);
  const key = K_UNIT + ((((((ti === undefined ? 63 : ti) * 64 + colorId(col)) * 8 + ai) * 8 + f) * 2 + fi) * 8 + ci) * 32 + bucketIdx(scale);
  const sp = cache.get(key) || miss(key, (s) => bake(s, UBOX, (c) => unitArt(c, ti === undefined ? '_none' : type, col, anim, f, CARRY_LIST[ci]), { face: fi ? -1 : 1 }), f, n);
  blit(ctx, sp, x, y, scale);
}

// ============================================================== TREES & NODES
// Drawn with the origin at the tile's top-left corner; one tile is 1x1.
const TREE_VARIANTS = 7;
function leafBlob(c, pts, col) {                      // union of circles, lit from the top-left
  const path = (dx, dy, k) => { c.beginPath(); for (let i = 0; i < pts.length; i += 3) circ(c, pts[i] + dx, pts[i + 1] + dy, pts[i + 2] * k); };
  path(0, 0, 1); inkU(c, col);
  if (L !== 1) return;
  c.save(); c.clip();
  c.fillStyle = dk(col, 0.2); c.fillRect(-3, -3, 9, 9);
  path(-0.035, -0.055, 0.97); c.fillStyle = col; c.fill();
  path(-0.07, -0.085, 0.5); c.fillStyle = lt(col, 0.2); c.fill();
  c.restore();
}
function treeArt(c, v) {
  const r = rng(v * 77 + 5);
  shadow(c, 0.5, 0.88, 0.36, 0.12, 0.28);
  if (v === 3 || v === 6) {                           // pine
    const g = v === 3 ? '#3c8a52' : '#34804e';
    limb(c, 0.5, 0.86, 0.5, 0.5, 0.11, WOOD_D);
    for (const [yb, hw, ya] of [[0.68, 0.4, 0.2], [0.42, 0.33, -0.04], [0.16, 0.25, -0.34]]) {
      c.beginPath(); c.moveTo(0.5, ya); c.quadraticCurveTo(0.5 + hw * 0.5, yb - 0.1, 0.5 + hw, yb); c.quadraticCurveTo(0.5, yb + 0.09, 0.5 - hw, yb); c.quadraticCurveTo(0.5 - hw * 0.5, yb - 0.1, 0.5, ya); c.closePath(); ink(c, g);
      if (L === 1) { c.fillStyle = lt(g, 0.16); c.beginPath(); c.moveTo(0.5, ya + 0.03); c.quadraticCurveTo(0.5 - hw * 0.45, yb - 0.1, 0.5 - hw * 0.9, yb - 0.01);
        c.quadraticCurveTo(0.5 - hw * 0.3, yb - 0.02, 0.5 - 0.02, ya + 0.14); c.fill(); }
    }
    return;
  }
  if (v === 2) {                                      // cypress
    limb(c, 0.5, 0.86, 0.5, 0.6, 0.1, WOOD_D);
    leafBlob(c, [0.5, 0.42, 0.26, 0.5, 0.12, 0.24, 0.5, -0.16, 0.18, 0.5, -0.36, 0.1], '#3f8f48');
    return;
  }
  const col = ['#4f9e42', '#5aa63f', 0, 0, '#479a4a', '#62a844'][v], big = v === 0 || v === 4;
  limb(c, 0.5, 0.86, 0.5, 0.4, big ? 0.15 : 0.13, WOOD_D); limb(c, 0.5, 0.55, 0.36, 0.4, 0.06, WOOD_D);
  const k = big ? 1 : 0.9, cy = big ? 0.14 : 0.2;
  leafBlob(c, [0.5, cy, 0.37 * k, 0.24, cy + 0.14, 0.24 * k, 0.76, cy + 0.14, 0.24 * k, 0.38, cy - 0.24, 0.25 * k, 0.64, cy - 0.21, 0.24 * k], col);
  if (v === 1 || v === 4) {                           // fruit: apples / oranges
    const fc = v === 1 ? '#e2452f' : '#f59a23';
    for (let i = 0; i < 6; i++) { const a = r() * TAU, d = 0.08 + r() * 0.24; ball(c, 0.5 + Math.cos(a) * d * 1.2, cy + 0.02 + Math.sin(a) * d, 0.05, fc); }
  }
}
const TREE_BOX = [0.5, 1.1, 1.6, 1.3];
/** One tree on the tile whose top-left corner is (x,y). `seed` picks the species and a small position jitter. Draw forests row by row, top to bottom. */
export function drawTree(ctx, x, y, scale, seed) {
  const v = (hash2(seed, 913) * TREE_VARIANTS) | 0, key = K_TREE + v * 32 + bucketIdx(scale);
  const sp = cache.get(key) || miss(key, (s) => bake(s, TREE_BOX, (c) => treeArt(c, v)));
  blit(ctx, sp, x + Math.round((hash2(seed, 71) - 0.5) * 0.18 * scale), y + Math.round((hash2(seed, 29) - 0.5) * 0.14 * scale), scale);   // whole-pixel jitter: forests never "swim"
}
function stumpArt(c, v) {
  shadow(c, 0.5, 0.8, 0.26, 0.08, 0.22);
  const m = v ? -1 : 1, X = (d) => 0.5 + d * m;
  ell(c, X(-0.2), 0.78, 0.07, 0.035, WOOD_D); ell(c, X(0.2), 0.79, 0.08, 0.035, WOOD_D);
  box(c, 0.33, 0.6, 0.34, 0.2, 0.05, WOOD_D); ell(c, 0.5, 0.61, 0.17, 0.085, WOOD_L); ell(c, 0.5, 0.61, 0.09, 0.043, lt(WOOD_L, 0.25), 0, LW * 0.7);
  box(c, X(0.27), 0.86, 0.09 * m, 0.035, 0.01, WOOD_L, LW * 0.7); box(c, X(-0.36), 0.7, 0.07 * m, 0.03, 0.01, WOOD_L, LW * 0.7);
  for (const d of [-0.3, 0.33]) { pen(c, LEAF_D, Math.max(LW * 1.3, 0.02), [X(d), 0.84, X(d) - 0.03, 0.75]); pen(c, LEAF, Math.max(LW * 1.3, 0.02), [X(d) + 0.03, 0.84, X(d) + 0.05, 0.77]); }
}
/** What is left of a tree: a stump on the tile at (x,y). */
export function drawStump(ctx, x, y, scale, seed) {
  const v = hash2(seed, 5) < 0.5 ? 0 : 1, key = K_TREE + (16 + v) * 32 + bucketIdx(scale);
  blit(ctx, cache.get(key) || miss(key, (s) => bake(s, [0.3, 0.5, 1.3, 1.2], (c) => stumpArt(c, v))), x, y, scale);
}

function bush(c, x, y, k, col) { scaled(c, x, y, k, () => leafBlob(c, [0, -0.1, 0.13, -0.11, -0.03, 0.09, 0.11, -0.03, 0.09], col)); }
const NODE_ART = dict({
  veg(c, n, v) {                                       // n = 1..4 plants left
    const m = v === 1 ? -1 : 1, X = (d) => 0.5 + d * m;
    box(c, 0.07, 0.44, 0.86, 0.48, 0.2, SOIL);
    for (const yy of [0.58, 0.72, 0.84]) pen(c, dk(SOIL, 0.22), LW * 1.5, [0.16, yy, 0.84, yy]);
    const spots = [[-0.02, 0.86, 2], [0.24, 0.62, 0], [-0.25, 0.64, 1], [0.24, 0.87, 3], [-0.27, 0.88, 2]];
    spots.forEach(([dx, y, kind], i) => {
      const x = X(dx);
      if (i > n) { ell(c, x, y - 0.03, 0.07, 0.03, dk(SOIL, 0.25), 0, 0); return; }               // harvested: a hole
      if (kind === 0) { bush(c, x, y, 1.15, LEAF); ball(c, x - 0.07, y - 0.1, 0.05, '#e5402e'); ball(c, x + 0.07, y - 0.16, 0.045, '#e5402e'); ball(c, x + 0.03, y - 0.05, 0.04, '#e5402e'); }
      else if (kind === 1) { bush(c, x, y, 1.1, '#8ccf5a'); c.beginPath(); c.arc(x, y - 0.1, 0.07, 0.8, 4.2); pen(c, '#5d9d3d', LW * 1.2); }
      else if (kind === 2) { for (const a of [-0.5, 0, 0.5]) ell(c, x + Math.sin(a) * 0.1, y - 0.11 - Math.cos(a) * 0.04, 0.03, 0.1, LEAF_D, a); ell(c, x, y - 0.025, 0.05, 0.035, '#f08a24'); }
      else { bush(c, x, y, 0.95, '#6bb548'); ball(c, x - 0.02, y - 0.09, 0.05, '#f2c230'); }
    });
  },
  spice(c, n, v) {
    const m = v === 1 ? -1 : 1, k = 0.5 + n * 0.125, X = (d) => 0.5 + d * m;
    ell(c, 0.5, 0.78, 0.43, 0.15, '#d8bf8e'); ell(c, 0.5, 0.775, 0.36, 0.115, '#c7a56a', 0, LW * 0.7);
    c.beginPath(); c.moveTo(0.5 - 0.37 * k, 0.8); c.bezierCurveTo(0.5 - 0.35 * k, 0.8 - 0.26 * k, 0.5 - 0.2 * k, 0.8 - 0.47 * k, 0.5 + 0.02 * m, 0.8 - 0.48 * k);
    c.bezierCurveTo(0.5 + 0.22 * k, 0.8 - 0.47 * k, 0.5 + 0.35 * k, 0.8 - 0.26 * k, 0.5 + 0.37 * k, 0.8); c.quadraticCurveTo(0.5, 0.88, 0.5 - 0.37 * k, 0.8); c.closePath(); ink(c, '#e0542c');
    if (L === 1) { c.fillStyle = 'rgba(255,190,90,0.4)'; c.beginPath(); c.ellipse(0.5 - 0.13 * k, 0.8 - 0.27 * k, 0.09 * k, 0.15 * k, 0.7, 0, TAU); c.fill();
      for (let i = 0; i < 9; i++) dot(c, 0.5 + (hash2(i, v) - 0.5) * 0.4 * k, 0.78 - hash2(i, v + 9) * 0.3 * k, 0.012, '#a82f1c'); }
    const ch = [[0.16, 0.84, 0.2], [-0.36, 0.86, 2.8], [0.0, 0.8 - 0.4 * k, -0.5], [-0.12, 0.92, -0.1]];
    for (let i = 0; i < n; i++) chili(c, X(ch[i][0]), ch[i][1], 0.62, m > 0 ? ch[i][2] : PI - ch[i][2]);
  },
  salt(c, n, v) {
    const m = v === 1 ? -1 : 1, X = (d) => 0.5 + d * m, col = v === 2 ? '#e3eef6' : '#d3e9f6';
    ell(c, 0.5, 0.8, 0.42, 0.14, '#c9d6de');
    for (const [dx, dy] of [[-0.3, 0.82], [0.31, 0.84], [0.05, 0.9], [-0.12, 0.76]]) crystal(c, X(dx), dy, 0.07, 0.07, dx, col);
    const cr = [[-0.02, 0.8, 0.24, 0.56, 0.05], [0.2, 0.83, 0.17, 0.36, 0.3], [-0.22, 0.83, 0.17, 0.4, -0.28], [0.08, 0.88, 0.13, 0.22, -0.12]];
    for (let i = Math.min(n, 4) - 1; i >= 0; i--) { const q = cr[[0, 2, 1, 3][i]]; crystal(c, X(q[0]), q[1], q[2], q[3] * (0.7 + n * 0.075), q[4] * m, col); }
    if (L === 2 && n > 1) { c.fillStyle = '#fff'; for (const [sx, sy, r] of [[0.3, 0.34, 0.07], [0.73, 0.5, 0.055]]) { c.beginPath(); c.moveTo(sx, sy - r);
      c.quadraticCurveTo(sx, sy, sx + r, sy); c.quadraticCurveTo(sx, sy, sx, sy + r); c.quadraticCurveTo(sx, sy, sx - r, sy); c.quadraticCurveTo(sx, sy, sx, sy - r); c.fill(); } }
  },
  fish(c, n, v) {                                      // a shoal in a patch of deeper water; fewer fish as it is fished out
    const m = v === 1 ? -1 : 1, X = (d) => 0.5 + d * m;
    ell(c, 0.5, 0.6, 0.42, 0.24, '#49a7d6', 0, 0); ell(c, 0.5, 0.61, 0.3, 0.15, '#3c93c6', 0, 0);
    const fishAt = (x, y, k, rot, col) => scaled(c, x, y, k, () => {
      poly(c, [-0.17, 0, -0.34, -0.12, -0.3, 0, -0.34, 0.12], col); ell(c, 0, 0, 0.21, 0.1, col);
      poly(c, [-0.04, -0.09, 0.06, -0.17, 0.09, -0.08], dk(col, 0.12)); dot(c, 0.12, -0.02, 0.022, '#1d2a33'); glint(c, 0.0, -0.035, 0.1, 0.025, 0.45);
    }, rot);
    const spots = [[-0.13, 0.63, 0.78, 0.15, '#f2a444'], [0.15, 0.56, 0.7, PI - 0.25, '#dfe7ea'], [0.03, 0.72, 0.66, 0.05, '#f2a444']];
    for (let i = 0; i < Math.min(n, 3); i++) { const q = spots[i]; fishAt(X(q[0]), q[1], q[2], m > 0 ? q[3] : PI - q[3], q[4]); }
    if (n >= 4) {                                      // a full spot: one fish leaps clear of the water
      fishAt(X(0.04), 0.27, 0.95, m > 0 ? -0.95 : PI + 0.95, '#f2a444');
      for (const [dx, dy, r] of [[-0.12, 0.42, 0.028], [0.17, 0.4, 0.022], [0.03, 0.47, 0.03], [-0.03, 0.36, 0.018]]) dot(c, X(dx), dy, r, '#eefcff');
    }
  },
  wood(c, n, v) {                                      // Timber Stand (turn-based maps): a stack of logs with an axe; the stack shrinks as it is used
    const m = v === 1 ? -1 : 1, X = (d) => 0.5 + d * m;
    ell(c, 0.5, 0.86, 0.43, 0.11, '#c9b48a');
    for (const [dx, dy] of [[-0.34, 0.9], [0.36, 0.92], [0.04, 0.95]]) box(c, X(dx) - 0.035, dy - 0.012, 0.07, 0.024, 0.01, WOOD_L, LW * 0.6);
    const ends = [[-0.24, 0.78], [-0.01, 0.78], [0.22, 0.78], [-0.125, 0.585], [0.105, 0.585], [-0.01, 0.39]];
    for (let i = 0, count = [2, 3, 5, 6][n - 1]; i < count; i++) {
      const x = X(ends[i][0]), y = ends[i][1];
      ell(c, x, y, 0.118, 0.118, WOOD_D); ell(c, x, y, 0.082, 0.082, WOOD_L, 0, LW * 0.7); ell(c, x, y, 0.036, 0.036, lt(WOOD_L, 0.3), 0, LW * 0.6);
    }
    const ax = X(0.37);
    limb(c, ax + 0.03 * m, 0.9, ax - 0.03 * m, 0.52, 0.04, WOOD);
    poly(c, [ax - 0.13 * m, 0.46, ax + 0.03 * m, 0.48, ax + 0.03 * m, 0.6, ax - 0.13 * m, 0.64], STEEL);
  },
  _none(c) { ell(c, 0.5, 0.7, 0.3, 0.2, STONE); },
});
const NODE_ID = dict({ veg: 0, spice: 1, salt: 2, _none: 3, fish: 4, wood: 5 });
/** Resource node ('veg' | 'spice' | 'salt') on the tile at (x,y). `frac` = fraction remaining (4 visible depletion steps), `seed` = variation. */
export function drawNode(ctx, type, x, y, scale, frac, seed) {
  const n = frac >= 0.75 ? 4 : frac >= 0.5 ? 3 : frac >= 0.25 ? 2 : 1, v = (hash2(seed, 37) * 3) | 0, k = NODE_ART[type] ? type : '_none';
  const key = K_NODE + ((NODE_ID[k] * 4 + n - 1) * 4 + v) * 32 + bucketIdx(scale);
  blit(ctx, cache.get(key) || miss(key, (s) => (k === 'fish'
    ? bake(s, [0.3, 0.7, 1.3, 1.25], (c) => NODE_ART.fish(c, n, v), { outline: false, bevel: false })
    : bake(s, [0.3, 0.7, 1.3, 1.25], (c) => { shadow(c, 0.5, 0.84, 0.42, 0.12, 0.2); NODE_ART[k](c, n, v); }))), x, y, scale);
}

// ================================================================ PROJECTILES
// Art points along +x and is centred on the origin. `spin` = radians per second (instead of following the flight angle).
const PROJ = dict({
  sauce: { k: 1.25, draw(c) { c.beginPath(); c.moveTo(0.16, 0); c.bezierCurveTo(0.16, 0.13, -0.02, 0.11, -0.3, 0.0); c.bezierCurveTo(-0.02, -0.11, 0.16, -0.13, 0.16, 0); ink(c, SAUCE);
    ell(c, -0.4, 0.03, 0.04, 0.03, SAUCE); glint(c, 0.05, -0.04, 0.05, 0.022, 0.6); } },
  meatball: { spin: 5, draw(c) { meatball(c, 0, 0, 0.18); } },
  flame: { k: 1.5, draw(c, f) { flame(c, 0.14, 0, 0.95, f, -PI / 2); }, plain: 1 },
  macaron: { k: 1.2, spin: 7, draw(c) { macaron(c, 0, 0, 0.14, PASTEL[0]); } },
  frosting: { k: 1.2, draw(c) { ell(c, -0.12, 0, 0.1, 0.11, '#f7a8c4'); ell(c, 0, 0, 0.085, 0.09, '#f9b9d0'); ell(c, 0.1, 0, 0.06, 0.065, '#fbcadb');
    poly(c, [0.14, -0.035, 0.24, 0, 0.14, 0.035], '#fbcadb'); dot(c, -0.1, -0.04, 0.018, '#fff'); dot(c, 0.0, 0.03, 0.015, '#a9e3c8'); } },
  skewer: { k: 1.15, draw(c) { pen(c, '#e4dfd4', Math.max(LW * 1.6, 0.03), [-0.34, 0, 0.3, 0]); poly(c, [0.26, -0.03, 0.4, 0, 0.26, 0.03], '#f1f4f5');
    box(c, -0.2, -0.06, 0.11, 0.12, 0.025, MEAT); box(c, -0.07, -0.055, 0.09, 0.11, 0.03, '#6dbb4a'); box(c, 0.04, -0.06, 0.11, 0.12, 0.025, MEAT);
    box(c, 0.165, -0.05, 0.08, 0.1, 0.03, '#e8452f'); } },
  plate: { k: 1.1, spin: 9, draw(c) { ell(c, 0, 0, 0.18, 0.18, '#fdfbf4'); ell(c, 0, 0, 0.11, 0.11, '#eee9dc', 0, LW * 0.8);
    for (let i = 0; i < 3; i++) dot(c, Math.cos(i * TAU / 3) * 0.145, Math.sin(i * TAU / 3) * 0.145, 0.022, '#5b8fd6'); } },
  pepper: { k: 1.4, draw(c) { dot(c, -0.2, 0.01, 0.025, '#4a4444'); dot(c, -0.12, -0.02, 0.035, '#3a3434'); ell(c, 0, 0, 0.075, 0.075, '#3a3232'); glint(c, -0.02, -0.03, 0.025, 0.018, 0.5); } },
  _none: { draw(c) { ell(c, 0, 0, 0.08, 0.08, STONE); } },
});
Object.keys(PROJ).forEach((k, i) => { PROJ[k].id = i; });
/** Projectile centred on (x,y). `angle` = flight direction in radians; spinning kinds (meatball, macaron, plate) use `t` instead. */
export function drawProjectile(ctx, kind, x, y, scale, angle, t) {
  const P = PROJ[kind] || PROJ._none, f = P.plain ? (Math.floor((+t || 0) * 12) & 1) : 0, key = K_PROJ + (P.id * 2 + f) * 32 + bucketIdx(scale);
  const sp = cache.get(key) || miss(key, (s) => bake(s, [0.9, 0.9, 0.9, 0.9], (c) => scaled(c, 0, 0, P.k || 1, () => P.draw(c, f)), P.plain ? { outline: false, bevel: false } : {}));
  ctx.save(); ctx.translate(x, y); ctx.rotate(P.spin ? (+t || 0) * P.spin : +angle || 0); blit(ctx, sp, 0, 0, scale); ctx.restore();
}

// ==================================================================== EFFECTS
// One-shot effects are few, so they are drawn as live vectors (p = progress 0..1).
function fxPuffs(ctx, n, p, R, r, col, a, up = 0, sq = 1) {
  const e = 1 - (1 - p) * (1 - p);
  ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const an = i / n * TAU + hash2(i, n) * 0.9, d = R * (0.35 + 0.65 * e) * (0.7 + hash2(i, 3) * 0.5);
    ctx.globalAlpha = Math.max(0, a * (1 - p));
    ctx.beginPath(); ctx.arc(Math.cos(an) * d, Math.sin(an) * d * sq - up * e, r * (0.6 + 0.6 * e) * (0.7 + hash2(i, 8) * 0.6), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function fxBits(ctx, n, p, R, size, cols, grav = 0.8) {                 // tumbling debris with outlines
  for (let i = 0; i < n; i++) {
    const an = i / n * TAU + hash2(i, n + 4), d = R * p * (0.5 + hash2(i, 12) * 0.8), h = (0.5 + hash2(i, 21) * 0.9);
    ctx.save(); ctx.translate(Math.cos(an) * d, Math.sin(an) * d * 0.5 - h * 4 * p * (1 - p) * grav - 0.1); ctx.rotate(p * (4 + hash2(i, 2) * 6));
    ctx.globalAlpha = Math.min(1, (1 - p) * 3);
    const s = size * (0.6 + hash2(i, 31) * 0.8); ctx.beginPath(); ctx.rect(-s, -s * 0.45, s * 2, s * 0.9); ink(ctx, cols[i % cols.length]);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function fxStar(ctx, r0, r1, n, col, w) {
  ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
  for (let i = 0; i < n; i++) { const a = i / n * TAU + 0.3; ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); }
  ctx.stroke();
}
/**
 * One-shot effect centred on the ground point (x,y); p = progress 0..1.
 * 'hit' | 'death' | 'splat' | 'boom' | 'dust' | 'collapse' | 'heal' | 'ring' | 'coin'.
 * `color` tints 'ring' (which expands to a radius of 3 tiles) and the band of the tumbling hat in 'death'.
 * 'dust' and 'collapse' are about 2.5 to 3 tiles wide: centre them on the station.
 */
export function drawEffect(ctx, kind, x, y, scale, p, color) {
  p = Math.max(0, Math.min(1, p || 0));
  const e = 1 - (1 - p) * (1 - p), q = 1 - p;
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.lineJoin = ctx.lineCap = 'round';
  L = 1; S = scale; FACE = 1; LW = Math.max(0.026, 0.8 / scale);
  switch (kind) {
    case 'hit':
      ctx.globalAlpha = q; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 0.07 + 0.1 * e, 0, TAU); ctx.fill();
      fxStar(ctx, 0.1 + 0.16 * e, 0.2 + 0.3 * e, 7, '#fff3b8', 0.07 * q + 0.01); ctx.globalAlpha = 1;
      break;
    case 'death': {
      fxPuffs(ctx, 7, p, 0.42, 0.2, '#fdf9ef', 0.85, 0.25, 0.6);
      const sp = fxSprite('hat', scale * 0.8, 0, color ? safeColor(color) : '#e9e2d2');
      ctx.globalAlpha = Math.min(1, q * 4); ctx.translate(0.28 * p, -0.4 - 0.55 * 4 * p * q + 0.25 * p); ctx.rotate(p * 5.5); ctx.scale(1 / scale, 1 / scale); blit(ctx, sp, 0, 0, scale * 0.8);
      break; }
    case 'splat':
      ctx.globalAlpha = Math.min(1, q * 1.6) * 0.85; ctx.beginPath(); ctx.ellipse(0, 0.02, 0.12 + 0.3 * e, 0.06 + 0.13 * e, 0, 0, TAU); ink(ctx, SAUCE);
      for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + 0.4, d = 0.5 * e * (0.6 + hash2(i, 5) * 0.6); ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d * 0.55 - Math.sin(p * PI) * 0.3 * (0.5 + hash2(i, 6)), 0.055 * (1 - p * 0.5), 0, TAU); ink(ctx, i % 3 ? SAUCE : '#ee6a4a'); }
      break;
    case 'boom':
      ctx.globalAlpha = q * 0.8; ctx.strokeStyle = '#f4e3c0'; ctx.lineWidth = 0.1 * q + 0.02; ctx.beginPath(); ctx.ellipse(0, 0, 0.2 + 0.9 * e, 0.12 + 0.5 * e, 0, 0, TAU); ctx.stroke();
      fxPuffs(ctx, 8, p, 0.75, 0.24, '#d9c4a0', 0.75, 0.2, 0.6); fxBits(ctx, 9, p, 0.95, 0.07, [MEAT, dk(MEAT, 0.2), '#a8623f'], 1);
      if (p < 0.35) { ctx.globalAlpha = 1 - p / 0.35; fxStar(ctx, 0.1, 0.35 + p, 8, '#fff3b8', 0.08); }
      break;
    case 'dust':
      ctx.scale(1, 0.55); fxPuffs(ctx, 12, p, 1.25, 0.26, '#eadbb6', 0.8, 0.15);
      break;
    case 'collapse':
      fxPuffs(ctx, 9, p, 1.0, 0.42, '#8f8880', 0.7, 1.0, 0.55); fxPuffs(ctx, 7, p, 1.25, 0.3, '#e2d6bd', 0.7, 0.2, 0.5);
      fxBits(ctx, 14, p, 1.5, 0.13, [WOOD, WOOD_D, BRICK, STONE, WOOD_L], 1.5);
      break;
    case 'heal':
      for (let i = 0; i < 3; i++) {
        const pp = Math.min(1, Math.max(0, p * 1.35 - i * 0.16)); if (pp <= 0 || pp >= 1) continue;
        const px = [-0.2, 0.06, 0.26][i], py = -0.25 - pp * 0.75 - i * 0.07, s = 0.085 + (i === 1 ? 0.03 : 0);
        ctx.globalAlpha = Math.min(1, (1 - pp) * 2.5);
        for (const [w, col] of [[0.085, '#1f7a43'], [0.045, '#7df09a']]) { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(px - s, py); ctx.lineTo(px + s, py);
          ctx.moveTo(px, py - s); ctx.lineTo(px, py + s); ctx.stroke(); }
      }
      break;
    case 'ring': {                                    // expands to a radius of 3 tiles
      const R = 0.25 + 2.75 * e, col = safeColor(color);
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU);
      ctx.globalAlpha = q * 0.3; ctx.strokeStyle = col; ctx.lineWidth = 0.5 * q + 0.1; ctx.stroke();                        // soft halo
      ctx.globalAlpha = Math.min(1, q * 1.7); ctx.lineWidth = 0.15 * q + 0.05; ctx.stroke();                                 // body in the team colour
      ctx.strokeStyle = lt(col, 0.7); ctx.lineWidth = 0.05 * q + 0.015; ctx.stroke();                                         // bright core
      ctx.fillStyle = '#fff'; for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + p * 1.5; ctx.beginPath(); ctx.arc(Math.cos(a) * R, Math.sin(a) * R, 0.06 * q + 0.012, 0, TAU); ctx.fill(); }
      break; }
    case 'coin': {
      ctx.globalAlpha = Math.min(1, q * 3); ctx.translate(0, -0.35 - 0.8 * e);
      const s = 1 + Math.sin(Math.min(1, p * 4) * PI) * 0.25;
      scaled(ctx, 0.05, 0, s, () => { chili(ctx, -0.07, 0.03, 1.05, -0.5); });
      for (const [w, col] of [[0.085, OUTLINE], [0.04, GOLD]]) { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(-0.33, 0); ctx.lineTo(-0.17, 0);
        ctx.moveTo(-0.25, -0.08); ctx.lineTo(-0.25, 0.08); ctx.stroke(); }
      break; }
    default:
      ctx.globalAlpha = q; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 0.1 + 0.2 * e, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ================================================================== BUILDINGS
// Origin = top-left of the footprint (N x N tiles). The front wall sits on the bottom edge of the
// footprint and the roof rises up to ~0.7 tile above its top edge: classic top-down "3/4" RTS view.
function pad(c, N) { if (L !== 0) return; c.fillStyle = 'rgba(104,78,46,0.28)'; c.beginPath(); rr(c, 0.05, 0.12, N - 0.1, N - 0.16, 0.3); c.fill(); }
function bshadow(c, x0, y0, x1, y1) { if (L !== 0) return; c.fillStyle = 'rgba(28,38,18,0.27)'; c.beginPath(); rr(c, x0 + 0.16, y0 + 0.14, x1 - x0, y1 - y0, 0.14); c.fill(); }
function wall(c, x0, y0, x1, y1, col, tex) {
  box(c, x0, y0, x1 - x0, y1 - y0, 0.03, col);
  const d = dk(col, 0.15);
  if (tex === 'plank') for (let x = x0 + 0.2; x < x1 - 0.05; x += 0.2) pen(c, d, LW, [x, y0 + 0.03, x, y1 - 0.03]);
  if (tex === 'brick') for (let y = y0 + 0.13, r = 0; y < y1 - 0.03; y += 0.13, r++) { pen(c, d, LW, [x0 + 0.03, y, x1 - 0.03, y]);
    for (let x = x0 + (r % 2 ? 0.14 : 0.28); x < x1 - 0.05; x += 0.28) pen(c, d, LW, [x, y - 0.13, x, y]); }
  if (tex !== 'plain') box(c, x0 - 0.02, y1 - 0.13, x1 - x0 + 0.04, 0.13, 0.02, tex === 'brick' ? dk(col, 0.2) : STONE);
}
/** Hip roof seen from the front-top: back slope, two hips and the big front slope (the team colour). */
function roof(c, x0, x1, yT, yR, yE, hip, col) {
  const a = x0 + hip, b = x1 - hip;
  poly(c, [x0, yT, x1, yT, b, yR, a, yR], lt(col, 0.2));
  if (hip) { poly(c, [x0, yT, a, yR, x0, yE], lt(col, 0.07)); poly(c, [x1, yT, b, yR, x1, yE], dk(col, 0.2)); }
  poly(c, [x0, yE, x1, yE, b, yR, a, yR], col);
  const n = Math.max(2, Math.round((yE - yR) / 0.3));
  for (let i = 1; i < n; i++) { const u = i / n; pen(c, dk(col, 0.17), LW * 1.2, [lerp(a, x0, u) + 0.04, lerp(yR, yE, u), lerp(b, x1, u) - 0.04, lerp(yR, yE, u)]); }
  pen(c, lt(col, 0.5), Math.max(LW * 1.6, 0.03), [a, yR, b, yR]);
  box(c, x0 - 0.02, yE - 0.03, x1 - x0 + 0.04, 0.085, 0.03, dk(col, 0.24));
}
function door(c, x, yb, w, h, col = WOOD_D) {
  c.beginPath(); c.moveTo(x, yb); c.lineTo(x, yb - h + w / 2); c.arc(x + w / 2, yb - h + w / 2, w / 2, PI, 0); c.lineTo(x + w, yb); c.closePath(); ink(c, col, LW * 1.6);
  pen(c, dk(col, 0.25), LW, [x + w / 2, yb - h + 0.03, x + w / 2, yb]); dot(c, x + w * 0.62, yb - h * 0.42, 0.025, GOLD);
}
function win(c, x, y, w, h, glass = GLOW) {
  box(c, x - 0.035, y - 0.035, w + 0.07, h + 0.07, 0.03, '#fff8ea'); box(c, x, y, w, h, 0.02, glass, LW * 0.8);
  pen(c, '#fff8ea', Math.max(LW, 0.025), [x + w / 2, y, x + w / 2, y + h]); pen(c, '#fff8ea', Math.max(LW, 0.025), [x, y + h / 2, x + w, y + h / 2]);
  if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.45)'; c.beginPath(); c.moveTo(x + w * 0.1, y + h * 0.4); c.lineTo(x + w * 0.4, y + h * 0.08); c.lineTo(x + w * 0.1, y + h * 0.08); c.fill(); }
}
function chimney(c, x, yt, yb, w) {
  box(c, x, yt, w, yb - yt, 0.02, BRICK); for (let y = yt + 0.15; y < yb - 0.04; y += 0.13) pen(c, dk(BRICK, 0.2), LW, [x + 0.02, y, x + w - 0.02, y]);
  box(c, x - 0.05, yt - 0.03, w + 0.1, 0.11, 0.03, STONE);
}
function awning(c, x0, x1, y0, y1, col, n = 5) {     // striped, scalloped awning (team colour + white)
  const d = 0.07;
  poly(c, [x0, y0, x1, y0, x1 + d, y1, x0 - d, y1], WHITE);
  if (L === 1) {
    c.fillStyle = col;
    for (let i = 0; i < n; i += 2) { const u0 = i / n, u1 = (i + 1) / n; c.beginPath(); c.moveTo(lerp(x0, x1, u0), y0); c.lineTo(lerp(x0, x1, u1), y0);
      c.lineTo(lerp(x0 - d, x1 + d, u1), y1); c.lineTo(lerp(x0 - d, x1 + d, u0), y1); c.fill(); }
  }
  const sw = (x1 - x0 + d * 2) / n;
  for (let i = 0; i < n; i++) { c.beginPath(); c.arc(x0 - d + sw * (i + 0.5), y1, sw / 2, 0, PI); c.closePath(); ink(c, i % 2 ? WHITE : col, LW * 0.8); }
  pen(c, dk(col, 0.36), LW, [x0, y0, x1, y0]);
}
function roundSign(c, x, y, r, col, icon) { ell(c, x, y, r, r, WOOD_D); ell(c, x, y, r * 0.8, r * 0.8, col, 0, LW * 0.8); scaled(c, x, y, r / 0.5, icon); }
function star(c, x, y, r, col, lw) {
  c.beginPath(); for (let i = 0; i < 10; i++) { const a = -PI / 2 + i * PI / 5, q = i % 2 ? r * 0.45 : r; c[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * q, y + Math.sin(a) * q); } c.closePath(); ink(c, col, lw);
}
function sprout(c, x, y, k, col) { ell(c, x - 0.045 * k, y - 0.05 * k, 0.06 * k, 0.03 * k, col, 0.7, LW * 0.8); ell(c, x + 0.045 * k, y - 0.05 * k, 0.06 * k, 0.03 * k, col, -0.7, LW * 0.8); }

const B_ART = dict({
  hq(c, tc) {
    pad(c, 4); bshadow(c, 0.3, 0.9, 3.72, 3.72);
    limb(c, 0.75, 0.7, 0.75, -0.58, 0.05, WOOD_D); dot(c, 0.75, -0.6, 0.045, GOLD);
    wall(c, 0.3, 2.42, 3.7, 3.72, CREAM);
    for (const x of [0.36, 1.5, 2.5, 3.64]) pen(c, WOOD_D, 0.07, [x, 2.55, x, 3.58]);
    roof(c, 0.12, 3.88, -0.3, 0.75, 2.6, 1.05, tc);
    chimney(c, 2.78, -0.45, 0.7, 0.44);
    for (const x of [0.56, 1.02, 2.62, 3.08]) win(c, x, 2.92, 0.34, 0.44);
    poly(c, [1.24, 2.66, 2.0, 1.72, 2.76, 2.66], dk(tc, 0.12)); poly(c, [1.5, 2.66, 2.0, 2.04, 2.5, 2.66], CREAM);        // entrance gable
    box(c, 1.44, 2.62, 1.12, 0.1, 0.02, WOOD_D);
    roundSign(c, 2.0, 2.4, 0.2, '#fff8ea', () => toque(c, 0, 0.3, 0.52, GOLD));
    door(c, 1.6, 3.72, 0.8, 0.94); box(c, 1.46, 3.7, 1.08, 0.1, 0.02, STONE);
    barrel(c, 3.42, 3.94, 0.95); crate(c, 0.38, 3.95, 0.36, 0.3); sack(c, 0.95, 3.96, 0.8);
  },
  house(c, tc) {
    pad(c, 2); bshadow(c, 0.24, 0.6, 1.78, 1.86);
    wall(c, 0.24, 1.1, 1.76, 1.86, CREAM);
    roof(c, 0.1, 1.9, -0.22, 0.4, 1.24, 0.5, tc);
    chimney(c, 1.32, -0.4, 0.36, 0.25);
    door(c, 0.46, 1.86, 0.38, 0.56); win(c, 1.14, 1.4, 0.36, 0.3);
    roundSign(c, 0.65, 1.1, 0.2, '#fff8ea', () => coffeeCup(c, 0, 0.26, 2.3));
  },
  pantry(c, tc) {
    pad(c, 2); bshadow(c, 0.22, 0.6, 1.8, 1.8);
    wall(c, 0.22, 1.02, 1.78, 1.8, WOOD_L, 'plank');
    poly(c, [0.08, 1.14, 1.92, 1.14, 1.8, -0.15, 0.2, -0.15], tc);
    for (const u of [0.33, 0.66]) pen(c, dk(tc, 0.17), LW * 1.2, [lerp(0.2, 0.08, u) + 0.04, lerp(-0.15, 1.14, u), lerp(1.8, 1.92, u) - 0.04, lerp(-0.15, 1.14, u)]);
    pen(c, lt(tc, 0.5), Math.max(LW * 1.6, 0.03), [0.22, -0.13, 1.78, -0.13]); box(c, 0.06, 1.1, 1.88, 0.09, 0.03, dk(tc, 0.24));
    box(c, 0.4, 1.3, 0.62, 0.5, 0.03, '#4a3530');
    pen(c, WOOD, LW * 1.6, [0.42, 1.5, 1.0, 1.5]);
    ['#e5402e', '#f2c230', '#6dbb4a'].forEach((q, i) => { box(c, 0.47 + i * 0.17, 1.38, 0.1, 0.115, 0.02, q, LW * 0.7); box(c, 0.47 + i * 0.17, 1.6, 0.1, 0.115, 0.02, ['#f2c230', '#fff8ea', '#e58a2a'][i], LW * 0.7); });
    crate(c, 1.2, 1.96, 0.44, 0.36); crate(c, 1.3, 1.6, 0.34, 0.28); carrot(c, 1.36, 1.3, 0.45, PI / 2 - 0.3); carrot(c, 1.52, 1.3, 0.45, PI / 2 + 0.3);
    sack(c, 0.3, 1.97, 0.85); sack(c, 0.68, 1.99, 0.7, '#dcc9a0');
  },
  garden(c, tc) {
    box(c, 0.07, 0.09, 1.86, 1.84, 0.07, WOOD_L); box(c, 0.15, 0.17, 1.7, 1.68, 0.05, tc, LW * 0.8); box(c, 0.215, 0.235, 1.57, 1.55, 0.04, SOIL);
    for (let r = 0; r < 4; r++) {
      const y = 0.48 + r * 0.4;
      if (L === 1) { c.fillStyle = dk(SOIL, 0.16); c.beginPath(); rr(c, 0.27, y - 0.02, 1.46, 0.11, 0.05); c.fill(); }
      for (let i = 0; i < 5; i++) {
        const x = 0.38 + i * 0.31;
        if (r % 2) { sprout(c, x, y + 0.02, 1.25, '#8ccf5a'); dot(c, x, y - 0.03, 0.035, '#b4e37c'); }
        else { ell(c, x, y + 0.02, 0.04, 0.03, '#f08a24', 0, LW * 0.7); sprout(c, x, y, 1.1, LEAF); }
      }
    }
    for (const [x, y] of [[0.01, 0.03], [1.82, 0.03], [0.01, 1.78], [1.82, 1.78]]) box(c, x, y, 0.17, 0.17, 0.05, tc);
  },
  grill(c, tc) {
    pad(c, 3); bshadow(c, 0.34, 0.5, 2.68, 2.84);
    wall(c, 0.35, 0.7, 2.65, 1.6, BRICK, 'brick');
    box(c, 0.72, 0.9, 1.56, 0.56, 0.03, '#4a3530');
    for (const [x, k] of [[1.0, 1], [1.38, 0.8]]) { c.save(); c.translate(x, 0.98); c.rotate(PI / 2); scaled(c, 0, 0, k, () => TOOLS.pan(c)); c.restore(); }
    c.save(); c.translate(1.82, 0.98); c.rotate(PI / 2); TOOLS.cleaver(c); c.restore();
    roof(c, 0.2, 2.8, -0.42, 0.1, 0.84, 0.6, tc);
    chimney(c, 2.08, -0.62, 0.22, 0.36);
    box(c, 0.42, 2.2, 2.16, 0.64, 0.05, STONE);                                             // grill: stone front
    for (let x = 0.7; x < 2.5; x += 0.3) pen(c, dk(STONE, 0.16), LW, [x, 2.34, x, 2.8]);
    c.beginPath(); c.moveTo(1.12, 2.84); c.lineTo(1.12, 2.58); c.arc(1.5, 2.58, 0.38, PI, 0); c.lineTo(1.88, 2.84); c.closePath(); ink(c, '#40302c');
      ell(c, 1.5, 2.76, 0.26, 0.07, '#f0621d', 0, 0); ell(c, 1.5, 2.77, 0.14, 0.04, '#ffb62e', 0, 0);
    box(c, 0.4, 1.46, 2.2, 0.82, 0.06, '#5d5e68'); box(c, 0.52, 1.56, 1.96, 0.62, 0.04, '#2f2a2b');   // iron top + fire bed
    for (let i = 0; i < 14; i++) dot(c, 0.62 + hash2(i, 3) * 1.76, 1.64 + hash2(i, 4) * 0.46, 0.035, i % 3 ? '#f0621d' : '#ffb62e');
    for (let x = 0.64; x < 2.44; x += 0.15) pen(c, '#9aa2aa', Math.max(LW * 1.2, 0.022), [x, 1.57, x, 2.17]);
    ell(c, 0.95, 1.82, 0.17, 0.11, '#a2573b', 0.3); ell(c, 2.02, 1.92, 0.16, 0.1, '#a2573b', -0.3); limb(c, 1.32, 1.7, 1.62, 1.76, 0.07, '#c96a4a'); limb(c, 1.36, 1.98, 1.66, 2.02, 0.07, '#c96a4a');
  },
  sauce(c, tc) {
    const COPPER = '#cf7d42';
    pad(c, 3); bshadow(c, 0.42, 0.7, 2.6, 2.82);
    wall(c, 0.44, 0.6, 2.56, 1.42, WOOD_L, 'plank'); box(c, 0.58, 0.86, 1.84, 0.5, 0.03, '#4a3530'); pen(c, WOOD, LW * 1.6, [0.6, 1.31, 2.4, 1.31]);
    [SAUCE, '#f2c230', '#6dbb4a', '#e58a2a', SAUCE, '#f2c230'].forEach((q, i) => { box(c, 0.67 + i * 0.29, 1.03, 0.15, 0.27, 0.04, q, LW * 0.8); box(c, 0.715 + i * 0.29, 0.94, 0.06, 0.1, 0.01, '#fff8ea', LW * 0.7); });
    awning(c, 0.4, 2.6, -0.38, 0.72, tc, 7);
    logPiece(c, 0.3, 2.86, 0.5, 0.075, -0.1); logPiece(c, 2.2, 2.8, 0.5, 0.075, 0.12); ell(c, 1.5, 2.83, 0.75, 0.09, '#f0621d', 0, 0);
    ell(c, 0.47, 2.0, 0.1, 0.15, dk(COPPER, 0.14)); ell(c, 2.53, 2.0, 0.1, 0.15, dk(COPPER, 0.14));
    c.beginPath(); c.moveTo(0.5, 1.72); c.bezierCurveTo(0.42, 2.45, 0.72, 2.8, 1.1, 2.84); c.lineTo(1.9, 2.84); c.bezierCurveTo(2.28, 2.8, 2.58, 2.45, 2.5, 1.72); c.closePath(); ink(c, COPPER);
    glint(c, 0.8, 2.25, 0.07, 0.32, 0.4, 0.2); c.beginPath(); c.moveTo(0.52, 2.08); c.quadraticCurveTo(1.5, 2.46, 2.48, 2.08); pen(c, dk(COPPER, 0.2), LW * 1.5);
    ell(c, 1.5, 1.72, 1.02, 0.38, lt(COPPER, 0.3)); ell(c, 1.5, 1.75, 0.88, 0.3, SAUCE);
    c.beginPath(); c.ellipse(1.42, 1.74, 0.52, 0.14, 0, 0.4, 3.7); pen(c, '#f07a55', Math.max(LW * 1.5, 0.04));
    ell(c, 1.05, 1.82, 0.07, 0.035, LEAF, 0.4, LW * 0.7); ell(c, 1.14, 1.86, 0.06, 0.03, LEAF, -0.5, LW * 0.7);
    limb(c, 1.92, 1.64, 2.74, 1.02, 0.075, WOOD); ell(c, 2.76, 1.0, 0.075, 0.075, WOOD);
  },
  garage(c, tc) {
    pad(c, 3); bshadow(c, 0.22, 0.2, 2.8, 2.78);
    box(c, 0.16, -0.12, 2.68, 1.68, 0.07, lt(tc, 0.3)); box(c, 0.3, 0.02, 2.4, 1.36, 0.05, tc);                    // flat roof, team colour
    if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.8)'; for (let i = 0; i < 3; i++) { c.beginPath(); rr(c, 0.55 + i * 0.36, 0.5, 0.2, 0.44, 0.02); c.fill(); } }
    box(c, 1.9, 0.26, 0.56, 0.5, 0.04, STEEL); for (const y of [0.4, 0.52, 0.64]) pen(c, dk(STEEL, 0.3), LW, [1.96, y, 2.4, y]);
    wall(c, 0.2, 1.5, 2.8, 2.78, '#ece5d6', 'plain'); box(c, 0.18, 2.66, 2.64, 0.12, 0.02, STONE);
    box(c, 0.2, 1.5, 2.6, 0.27, 0.02, dk(tc, 0.1)); wheel(c, 1.12, 1.635, 0.1, 0.4, '#fff8ea');
    box(c, 0.4, 1.92, 1.44, 0.86, 0.03, '#9ea7ae'); for (let y = 2.03; y < 2.5; y += 0.11) pen(c, dk('#9ea7ae', 0.22), LW, [0.43, y, 1.81, y]);
    box(c, 0.43, 2.52, 1.38, 0.26, 0.01, '#3a3038', 0);
    win(c, 2.06, 2.04, 0.5, 0.36, '#bfe6f2');
    wheel(c, 0.2, 2.86, 0.11, 0, '#5a5960'); wheel(c, 0.2, 2.7, 0.11, 0.5, '#5a5960');
    scaled(c, 2.3, 2.96, 0.66, () => scooterArt(c, tc, 'idle', 0, false));
  },
  lab(c, tc) {
    pad(c, 3); bshadow(c, 0.24, 0.2, 2.78, 2.78);
    box(c, 0.18, -0.1, 2.64, 1.66, 0.12, '#f4f1e9'); box(c, 0.34, 0.06, 2.32, 1.3, 0.07, tc);
    box(c, 0.56, 0.3, 0.86, 0.6, 0.04, '#bfe6f2'); pen(c, '#fff', Math.max(LW, 0.025), [0.99, 0.3, 0.99, 0.9]); glint(c, 0.75, 0.48, 0.05, 0.16, 0.6, 0.7);
    box(c, 1.86, 0.28, 0.4, 0.42, 0.05, dk(STEEL, 0.12)); ell(c, 2.06, 0.28, 0.2, 0.07, STEEL);
    wall(c, 0.24, 1.5, 2.76, 2.78, '#f7f4ee', 'plain'); box(c, 0.22, 2.66, 2.56, 0.12, 0.02, '#c9d0d4'); box(c, 0.24, 1.5, 2.52, 0.14, 0.02, tc);
    box(c, 0.44, 1.86, 1.22, 0.62, 0.03, '#9fd8ea'); for (const x of [0.85, 1.25]) pen(c, '#f7f4ee', Math.max(LW * 1.3, 0.03), [x, 1.86, x, 2.48]);
    if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.moveTo(0.5, 2.3); c.lineTo(0.8, 1.9); c.lineTo(0.62, 1.9); c.lineTo(0.5, 2.06); c.fill(); }
    box(c, 1.9, 1.86, 0.56, 0.92, 0.03, '#9fd8ea'); pen(c, '#f7f4ee', Math.max(LW * 1.3, 0.03), [2.18, 1.86, 2.18, 2.78]);
    limb(c, 1.05, 1.5, 1.05, 1.3, 0.06, STEEL);                                                                     // emblem billboard
    roundSign(c, 1.05, 1.08, 0.4, '#fff8ea', () => {
      c.save(); c.rotate(-0.5); pen(c, IRON, 0.05, [0, 0.28, 0, 0.02]); ell(c, 0, -0.12, 0.1, 0.16, '#fff8ea', 0, 0.035); pen(c, dk(STEEL, 0.4), 0.03, [0, 0.02, 0, -0.28]); c.restore();
      c.save(); c.rotate(0.5); poly(c, [-0.05, -0.28, 0.05, -0.28, 0.05, -0.1, 0.17, 0.2, -0.17, 0.2, -0.05, -0.1], '#dff3f7', 0.03); poly(c, [-0.1, 0.03, 0.1, 0.03, 0.17, 0.2, -0.17, 0.2], '#6dbb4a', 0); c.restore();
    });
  },
  workshop(c, tc) {
    const x0 = 0.2, x1 = 2.2, xm = 1.2;
    pad(c, 3); bshadow(c, 0.24, 1.0, 2.14, 2.78);
    poly(c, [x0 - 0.12, 1.6, xm, 0.72, xm, -0.48, x0 - 0.12, 0.3], lt(tc, 0.1)); poly(c, [x1 + 0.12, 1.6, xm, 0.72, xm, -0.48, x1 + 0.12, 0.3], dk(tc, 0.15));
    for (const u of [0.35, 0.68]) { pen(c, dk(tc, 0.12), LW * 1.2, [lerp(xm, x0 - 0.12, u), lerp(0.72, 1.6, u), lerp(xm, x0 - 0.12, u), lerp(-0.48, 0.3, u)]);
      pen(c, dk(tc, 0.3), LW * 1.2, [lerp(xm, x1 + 0.12, u), lerp(0.72, 1.6, u), lerp(xm, x1 + 0.12, u), lerp(-0.48, 0.3, u)]); }
    pen(c, lt(tc, 0.5), Math.max(LW * 1.6, 0.03), [xm, 0.72, xm, -0.46]);
    poly(c, [x0, 2.78, x0, 1.52, xm, 0.84, x1, 1.52, x1, 2.78], WOOD_L);
    for (let x = x0 + 0.2; x < x1 - 0.05; x += 0.2) pen(c, dk(WOOD_L, 0.15), LW, [x, 2.76, x, 1.52 - (1 - Math.abs(x - xm) / (xm - x0)) * 0.66 + 0.04]);
    limb(c, x0 - 0.12, 1.6, xm, 0.72, 0.1, dk(tc, 0.05)); limb(c, x1 + 0.12, 1.6, xm, 0.72, 0.1, dk(tc, 0.05));
    box(c, x0 - 0.02, 2.65, x1 - x0 + 0.04, 0.13, 0.02, STONE);
    box(c, xm - 0.52, 1.82, 1.04, 0.96, 0.04, '#4a3530'); box(c, xm - 0.72, 1.86, 0.22, 0.92, 0.02, WOOD); box(c, xm + 0.5, 1.86, 0.22, 0.92, 0.02, WOOD);
    ell(c, xm, 1.38, 0.16, 0.16, '#4a3530'); pen(c, WOOD_D, LW * 1.5, [xm - 0.16, 1.38, xm + 0.16, 1.38]); pen(c, WOOD_D, LW * 1.5, [xm, 1.22, xm, 1.54]);
    box(c, xm - 0.3, 2.5, 0.6, 0.08, 0.02, WOOD_L); pen(c, WOOD_D, 0.04, [xm - 0.24, 2.58, xm - 0.3, 2.78]); pen(c, WOOD_D, 0.04, [xm + 0.24, 2.58, xm + 0.3, 2.78]);   // saw-horse
    scaled(c, 2.52, 2.9, 0.68, () => catapultArt(c, WOOD, 'idle', 0, true));
    logPiece(c, 2.3, 1.72, 0.5, 0.075, 0); logPiece(c, 2.34, 1.57, 0.44, 0.07, 0); logPiece(c, 2.28, 1.87, 0.54, 0.075, 0);
  },
  market(c, tc) {                                  // two market stalls under striped awnings, a balance on the sign
    pad(c, 3); bshadow(c, 0.22, 1.0, 2.8, 2.8);
    box(c, 0.2, 0.86, 2.6, 1.2, 0.05, WOOD_L); for (let y = 1.0; y < 2.0; y += 0.2) pen(c, dk(WOOD_L, 0.14), LW, [0.24, y, 2.76, y]);   // back boards
    for (const x of [0.26, 1.44, 1.56, 2.74]) limb(c, x, 2.7, x, 0.92, 0.07, WOOD_D);                                               // posts
    awning(c, 0.16, 1.48, 0.7, 1.12, tc, 5); awning(c, 1.52, 2.84, 0.7, 1.12, tc, 5);
    // left stall: produce
    box(c, 0.2, 2.0, 1.32, 0.66, 0.04, WOOD); pen(c, WOOD_D, LW * 1.2, [0.22, 2.22, 1.5, 2.22]); box(c, 0.16, 1.94, 1.4, 0.1, 0.03, WOOD_L);
    crate(c, 0.3, 1.94, 0.5, 0.3); crate(c, 0.9, 1.94, 0.5, 0.3);
    for (let i = 0; i < 4; i++) { ball(c, 0.38 + i * 0.11, 1.62, 0.07, '#e5402e'); ball(c, 0.98 + i * 0.11, 1.62, 0.07, i % 2 ? '#6dbb4a' : '#8fd05a'); }
    carrot(c, 0.62, 1.5, 0.45, PI / 2 - 0.4); carrot(c, 1.22, 1.5, 0.45, PI / 2 + 0.3);
    // right stall: spice sacks and a heap of salt
    box(c, 1.48, 2.0, 1.32, 0.66, 0.04, WOOD); pen(c, WOOD_D, LW * 1.2, [1.5, 2.22, 2.78, 2.22]); box(c, 1.44, 1.94, 1.4, 0.1, 0.03, WOOD_L);
    sack(c, 1.74, 1.92, 0.95, '#c98a4a'); ell(c, 1.74, 1.6, 0.11, 0.05, '#d8452a', 0, LW * 0.7);
    sack(c, 2.06, 1.92, 0.95, '#b7743c'); ell(c, 2.06, 1.6, 0.11, 0.05, '#f2b531', 0, LW * 0.7);
    c.beginPath(); c.moveTo(2.22, 1.92); c.quadraticCurveTo(2.48, 1.46, 2.72, 1.92); c.closePath(); ink(c, '#f4f6f8');                 // salt
    // the sign: a balance
    limb(c, 1.5, 0.74, 1.5, 0.5, 0.06, WOOD_D);
    roundSign(c, 1.5, 0.26, 0.34, '#fff8ea', () => {
      pen(c, IRON, 0.05, [0, -0.3, 0, 0.3]); pen(c, IRON, 0.05, [-0.32, -0.16, 0.32, -0.16]); pen(c, IRON, 0.035, [-0.16, 0.3, 0.16, 0.3]);
      for (const sx of [-0.28, 0.28]) { pen(c, IRON, 0.025, [sx, -0.16, sx - 0.1, 0.06]); pen(c, IRON, 0.025, [sx, -0.16, sx + 0.1, 0.06]); c.beginPath(); c.moveTo(sx - 0.14, 0.06); c.quadraticCurveTo(sx, 0.18, sx + 0.14, 0.06); c.closePath(); ink(c, GOLD, 0.025); }
    });
  },
  tower(c, tc) {
    pad(c, 2); shadow(c, 1.12, 1.78, 0.86, 0.26, 0.27);
    box(c, 0.2, 1.6, 1.6, 0.3, 0.14, dk(STONE, 0.14)); ell(c, 1, 1.62, 0.8, 0.2, STONE);
    const body = () => { c.beginPath(); c.moveTo(0.44, 1.66); c.bezierCurveTo(0.44, 1.2, 0.74, 1.15, 0.72, 0.86); c.bezierCurveTo(0.7, 0.62, 0.5, 0.56, 0.5, 0.3);
      c.bezierCurveTo(0.5, 0.04, 0.76, -0.02, 0.78, -0.12); c.lineTo(1.22, -0.12); c.bezierCurveTo(1.24, -0.02, 1.5, 0.04, 1.5, 0.3); c.bezierCurveTo(1.5, 0.56, 1.3, 0.62, 1.28, 0.86);
      c.bezierCurveTo(1.26, 1.15, 1.56, 1.2, 1.56, 1.66); c.quadraticCurveTo(1, 1.84, 0.44, 1.66); c.closePath(); };
    body(); ink(c, WOOD);
    if (L === 1) {
      c.save(); body(); c.clip();
      c.fillStyle = tc; c.fillRect(0, -0.12, 2, 0.74); c.fillStyle = dk(tc, 0.2); c.fillRect(0, 0.52, 2, 0.1); c.fillStyle = STEEL; c.fillRect(0, 0.78, 2, 0.15);
      c.fillStyle = 'rgba(255,250,235,0.3)'; c.beginPath(); c.ellipse(0.72, 0.8, 0.09, 1.0, 0.03, 0, TAU); c.fill();
      c.fillStyle = 'rgba(46,26,44,0.2)'; c.beginPath(); c.ellipse(1.5, 0.8, 0.22, 1.1, 0, 0, TAU); c.fill();
      c.restore(); body(); pen(c, dk(WOOD, 0.36), LW);
    }
    box(c, 0.93, 0.16, 0.14, 0.22, 0.07, '#3a2c28'); box(c, 0.93, 1.02, 0.14, 0.22, 0.07, '#3a2c28'); door(c, 0.86, 1.74, 0.28, 0.36, '#5a3a26');
    ell(c, 1, -0.13, 0.25, 0.08, STEEL); ball(c, 1, -0.34, 0.2, WOOD_L); ell(c, 1, -0.55, 0.07, 0.04, STEEL);
  },
  restaurant(c, tc) {
    const ST = '#f8f0de';
    pad(c, 4); bshadow(c, 0.24, 0.9, 3.8, 3.72);
    for (const x of [0.5, 3.5]) { limb(c, x, 0.5, x, -0.46, 0.045, WOOD_D); dot(c, x, -0.48, 0.04, GOLD); }
    wall(c, 0.24, 2.28, 3.76, 3.72, ST, 'plain'); box(c, 0.2, 3.58, 3.6, 0.14, 0.02, '#d6ccb8');
    roof(c, 0.1, 3.9, -0.3, 0.68, 2.46, 1.15, tc);
    pen(c, GOLD, Math.max(LW * 2, 0.05), [1.25, 0.68, 2.75, 0.68]); ball(c, 1.25, 0.62, 0.075, GOLD); ball(c, 2.75, 0.62, 0.075, GOLD);
    c.beginPath(); c.moveTo(1.26, 2.5); c.lineTo(1.26, 1.95); c.bezierCurveTo(1.26, 1.15, 2.74, 1.15, 2.74, 1.95); c.lineTo(2.74, 2.5); c.closePath(); ink(c, ST, LW * 1.4);   // frontispiece
    c.beginPath(); c.moveTo(1.26, 1.95); c.bezierCurveTo(1.26, 1.15, 2.74, 1.15, 2.74, 1.95); pen(c, GOLD, Math.max(LW * 2, 0.06));
    ell(c, 2, 1.94, 0.34, 0.34, '#51456a'); star(c, 2, 1.95, 0.26, GOLD);
    box(c, 1.18, 2.42, 1.64, 0.1, 0.02, GOLD);
    for (const x of [0.58, 2.86]) { win(c, x, 2.94, 0.56, 0.52); awning(c, x - 0.07, x + 0.63, 2.6, 2.84, tc, 5); }
    for (const x of [0.38, 1.36, 2.64, 3.62]) { box(c, x - 0.07, 2.52, 0.14, 1.06, 0.02, '#fffaf0'); box(c, x - 0.1, 2.48, 0.2, 0.07, 0.02, GOLD, LW * 0.7); }
    box(c, 1.5, 3.68, 1.0, 0.28, 0.03, '#a32c3e'); pen(c, GOLD, LW * 1.3, [1.56, 3.7, 1.56, 3.94]); pen(c, GOLD, LW * 1.3, [2.44, 3.7, 2.44, 3.94]);
    box(c, 1.6, 2.9, 0.8, 0.82, 0.03, GOLD); box(c, 1.66, 2.96, 0.31, 0.76, 0.02, '#8cc3d4', LW * 0.8); box(c, 2.03, 2.96, 0.31, 0.76, 0.02, '#8cc3d4', LW * 0.8);
    awning(c, 1.5, 2.5, 2.6, 2.82, tc, 5);
    for (const x of [1.4, 2.6]) { box(c, x - 0.09, 3.74, 0.18, 0.2, 0.03, '#b9693f'); ball(c, x, 3.6, 0.16, LEAF_D); }
  },
  wall(c, tc) { wallArt(c, tc, 2 | 8, false); },          // (command card icon: a straight run)
  gate(c, tc) { gateArt(c, tc, 2 | 8, false); },
  saltwall(c, tc) { wallArt(c, tc, 2 | 8, false, true); },
  saltgate(c, tc) { gateArt(c, tc, 2 | 8, false, false, true); },
  _(c, tc, N) {
    pad(c, N); bshadow(c, 0.25, N * 0.4, N - 0.25, N - 0.2);
    wall(c, 0.25, N * 0.6, N - 0.25, N - 0.15, STONE); roof(c, 0.12, N - 0.12, -0.2, N * 0.22, N * 0.6 + 0.12, N * 0.25, tc); door(c, N / 2 - 0.2, N - 0.15, 0.4, N * 0.25);
  },
});
// ---- walls (v1.4.0): one tile each, drawn to join up with the walls next door. mask: 1 = N, 2 = E, 4 = S, 8 = W.
function wallCrate(c, x, y, w, h, tc) {                 // a crate standing on (x, y): its front, with a lid on top
  box(c, x, y - h, w, h, 0.02, WOOD_L);
  pen(c, WOOD_D, LW * 1.2, [x + w * 0.1, y - h, x + w * 0.1, y]); pen(c, WOOD_D, LW * 1.2, [x + w * 0.9, y - h, x + w * 0.9, y]);
  pen(c, WOOD_D, LW, [x, y - h * 0.5, x + w, y - h * 0.5]);
  if (tc) box(c, x + w * 0.1, y - h * 0.62, w * 0.8, h * 0.24, 0.01, tc, LW * 0.7);               // painted in the team colour
  box(c, x - 0.015, y - h - 0.09, w + 0.03, 0.1, 0.02, lt(WOOD_L, 0.18), LW * 0.8);              // lid
}
const SALT = '#eef2f4', SALT_D = '#b9c7cf';
function saltBlock(c, x, y, w, h, tc) {                 // a pressed salt brick standing on (x, y), sparkling a little
  box(c, x, y - h, w, h, 0.03, SALT);
  pen(c, SALT_D, LW, [x + w * 0.5, y - h, x + w * 0.5, y - h * 0.5]); pen(c, SALT_D, LW, [x, y - h * 0.5, x + w, y - h * 0.5]);
  pen(c, SALT_D, LW, [x + w * 0.25, y - h * 0.5, x + w * 0.25, y]); pen(c, SALT_D, LW, [x + w * 0.75, y - h * 0.5, x + w * 0.75, y]);
  if (tc) box(c, x + w * 0.08, y - h * 0.62, w * 0.84, h * 0.22, 0.01, tc, LW * 0.7);
  box(c, x - 0.02, y - h - 0.08, w + 0.04, 0.09, 0.03, '#fbfdfe', LW * 0.8);
  dot(c, x + w * 0.2, y - h * 0.78, 0.022, '#ffffff'); dot(c, x + w * 0.72, y - h * 0.3, 0.018, '#ffffff');
}
function wallArt(c, tc, mask, site, salt) {
  if (L === 0) { c.fillStyle = 'rgba(28,38,18,0.25)'; c.beginPath(); rr(c, 0.14, 0.62, 0.78, 0.36, 0.12); c.fill(); }
  if (salt) {                                             // salt blocks: a taller, solid rampart
    const low = site ? 0.2 : 0.42;
    if (mask & 1) { box(c, 0.28, -0.14, 0.44, 0.66, 0.03, SALT_D, LW); for (let y = 0.0; y < 0.5; y += 0.15) pen(c, dk(SALT_D, 0.15), LW, [0.3, y, 0.7, y]); }
    if (mask & 8) saltBlock(c, -0.02, 0.86, 0.52, low, null);
    if (mask & 2) saltBlock(c, 0.5, 0.86, 0.52, low, null);
    if (mask & 4) { box(c, 0.28, 0.5, 0.44, 0.56, 0.03, SALT_D, LW); for (let y = 0.64; y < 1.02; y += 0.15) pen(c, dk(SALT_D, 0.15), LW, [0.3, y, 0.7, y]); }
    if (site) { saltBlock(c, 0.22, 0.9, 0.56, 0.3, null); limb(c, 0.14, 0.94, 0.4, 0.8, 0.05, WOOD); return; }
    saltBlock(c, 0.16, 0.9, 0.68, 0.42, null);
    saltBlock(c, 0.2, 0.42, 0.6, 0.38, tc);
    return;
  }
  const low = site ? 0.18 : 0.3;                          // the connecting crates (a pillar sits on every tile)
  if (mask & 1) { box(c, 0.32, -0.08, 0.36, 0.62, 0.02, WOOD, LW); for (let y = 0.05; y < 0.5; y += 0.16) pen(c, WOOD_D, LW, [0.34, y, 0.66, y]); }
  if (mask & 8) wallCrate(c, -0.02, 0.86, 0.5, low, null);
  if (mask & 2) wallCrate(c, 0.52, 0.86, 0.5, low, null);
  if (mask & 4) { box(c, 0.32, 0.5, 0.36, 0.56, 0.02, WOOD, LW); for (let y = 0.62; y < 1.02; y += 0.16) pen(c, WOOD_D, LW, [0.34, y, 0.66, y]); }
  if (site) {                                             // being built: a single crate and some loose planks
    wallCrate(c, 0.24, 0.9, 0.52, 0.3, null);
    limb(c, 0.16, 0.92, 0.42, 0.78, 0.05, WOOD); limb(c, 0.58, 0.95, 0.86, 0.86, 0.05, WOOD_L);
    return;
  }
  wallCrate(c, 0.2, 0.9, 0.6, 0.36, null);
  wallCrate(c, 0.24, 0.45, 0.52, 0.32, tc);
}
function gateArt(c, tc, mask, open, site, salt) {
  const vert = (mask & 5) && !(mask & 10);               // in a north-south wall: the wall runs on behind and in front of the doorway
  if (vert) {
    if (mask & 1) { box(c, 0.32, -0.08, 0.36, 0.5, 0.02, WOOD, LW); for (let y = 0.05; y < 0.4; y += 0.16) pen(c, WOOD_D, LW, [0.34, y, 0.66, y]); }
    if (mask & 4) { box(c, 0.32, 0.86, 0.36, 0.2, 0.02, WOOD, LW); }
  }
  if (L === 0) { c.fillStyle = 'rgba(28,38,18,0.25)'; c.beginPath(); rr(c, 0.04, 0.62, 0.96, 0.36, 0.12); c.fill(); }
  if (salt) { saltBlock(c, -0.06, 0.94, 0.24, site ? 0.6 : 1.26, null); saltBlock(c, 0.82, 0.94, 0.24, site ? 0.6 : 1.26, null); }   // salt pillars
  else { limb(c, 0.08, 0.92, 0.08, site ? 0.3 : -0.3, 0.13, WOOD_D); limb(c, 0.92, 0.92, 0.92, site ? 0.3 : -0.3, 0.13, WOOD_D); }   // posts
  if (site) { limb(c, 0.08, 0.5, 0.92, 0.5, 0.06, WOOD_L); return; }
  box(c, -0.02, -0.42, 1.04, 0.2, 0.04, tc, LW);                                                   // the sign over the door
  pen(c, '#fff8ea', Math.max(LW * 1.6, 0.03), [0.3, -0.32, 0.7, -0.32]);
  if (open) {                                                                                      // swung open: thin panels by the posts
    box(c, 0.14, 0.2, 0.12, 0.62, 0.03, '#c98d54'); box(c, 0.74, 0.2, 0.12, 0.62, 0.03, '#c98d54');
  } else {                                                                                         // saloon doors: scalloped tops, porthole windows
    for (const [x0, x1] of [[0.14, 0.49], [0.51, 0.86]]) {
      c.beginPath(); c.moveTo(x0, 0.84); c.lineTo(x0, 0.3); c.quadraticCurveTo((x0 + x1) / 2, x0 < 0.5 ? 0.12 : 0.36, x1, 0.24); c.lineTo(x1, 0.84); c.closePath(); ink(c, '#c98d54');
      ell(c, (x0 + x1) / 2, 0.48, 0.07, 0.07, '#8cc3d4', 0, LW * 0.8);
      pen(c, '#8a5a32', LW, [x0 + 0.04, 0.68, x1 - 0.04, 0.68]);
    }
  }
}
const WALL_BOX = [0.25, 0.75, 1.5, 1.95];
/**
 * Draw one Crate Wall / Swing Gate tile with the top-left of its tile on (x, y).
 * o = { mask (neighbours to join), open (gate), progress (< 1 = still being built), ghost: false|'ok'|'bad' }
 */
export function drawWall(ctx, type, color, x, y, scale, o = {}) {
  const gate = type === 'gate' || type === 'saltgate', salt = type === 'saltwall' || type === 'saltgate', col = safeColor(color), mask = (o.mask | 0) & 15, bi = bucketIdx(scale);
  const site = o.progress != null && o.progress < 1;
  const variant = (o.ghost ? (gate ? 7 : 5) + (o.ghost === 'bad' ? 1 : 0) : gate ? (site ? 4 : o.open ? 3 : 2) : site ? 1 : 0) + (salt ? 9 : 0);
  const key = K_WALL + ((variant * 64 + colorId(col)) * 16 + mask) * 32 + bi;
  const art = (c) => (gate ? gateArt(c, col, mask, !!o.open, site, salt) : wallArt(c, col, mask, site, salt));
  let sp = cache.get(key);
  if (!sp) {
    sp = miss(key, (s) => {
      const src = bake(s, WALL_BOX, art);
      if (!o.ghost) return src;
      const cv = document.createElement('canvas'); cv.width = src.w; cv.height = src.h;
      const c = cv.getContext('2d'); c.drawImage(src.cv, 0, 0); c.globalCompositeOperation = 'source-atop'; c.globalAlpha = 0.5;
      c.fillStyle = o.ghost === 'bad' ? '#ff3b30' : '#3ddc64'; c.fillRect(0, 0, src.w, src.h);
      return { cv, ox: src.ox, oy: src.oy, w: src.w, h: src.h, s: src.s, used: 0 };
    });
  }
  const ga = ctx.globalAlpha;
  if (o.ghost) ctx.globalAlpha = ga * 0.7;
  blit(ctx, sp, x, y, scale);
  ctx.globalAlpha = ga;
}
const bSize = (type) => (BLD[type] ? BLD[type].size : 2);
const bArt = (c, type, tc) => (B_ART[type] || B_ART._)(c, tc, bSize(type));

/** Construction site: foundation + timber frame, with the real building rising from the ground as q goes 0..1. */
function siteArt(c, type, tc, q) {
  const N = bSize(type);
  if (BLD[type] && BLD[type].walkable) {                 // flat plots: staked out, filled in left to right
    c.save(); c.beginPath(); c.rect(-1, -1, 1 + N * (0.12 + 0.88 * q), N + 2); c.clip(); bArt(c, type, tc); c.restore();
    pen(c, '#efe4cb', Math.max(LW * 1.2, 0.02), [0.1, 0.12, N - 0.1, 0.12, N - 0.1, N - 0.1, 0.1, N - 0.1, 0.1, 0.12]);
    for (const [x, y] of [[0.1, 0.12], [N - 0.1, 0.12], [0.1, N - 0.1], [N - 0.1, N - 0.1]]) limb(c, x, y, x, y - 0.2, 0.05, WOOD_L);
    return;
  }
  const yb = N - 0.2, y0 = N * 0.42, xs = [0.36, N / 2, N - 0.36];
  pad(c, N);
  box(c, 0.14, y0, N - 0.28, yb - y0 + 0.06, 0.06, '#cfc7b6');                                                   // foundation slab
  for (let x = 0.5; x < N - 0.3; x += 0.42) pen(c, dk('#cfc7b6', 0.14), LW, [x, y0 + 0.04, x, yb]);
  for (const x of xs) limb(c, x, yb - 0.1, x, 0.12, 0.07, WOOD_L);                                                // timber frame
  for (const y of [0.16, N * 0.36, N * 0.62]) limb(c, xs[0], y, xs[2], y, 0.06, WOOD_L);
  limb(c, xs[0], N * 0.62, xs[1], N * 0.36, 0.045, WOOD); limb(c, xs[2], N * 0.62, xs[1], N * 0.36, 0.045, WOOD);
  limb(c, xs[0], N * 0.36, xs[1], 0.16, 0.045, WOOD); limb(c, xs[2], N * 0.36, xs[1], 0.16, 0.045, WOOD);
  const cut = lerp(N - 0.12, -0.85, q);
  c.save(); c.beginPath(); c.rect(-1, cut, N + 2, N + 2 - cut); c.clip(); bArt(c, type, tc); c.restore();
  const lx = N - 0.62, top = Math.max(0.3, cut - 0.15);                                                           // ladder + plank pile in front
  limb(c, lx, yb + 0.1, lx + 0.05, top, 0.04, WOOD_D); limb(c, lx + 0.24, yb + 0.1, lx + 0.29, top, 0.04, WOOD_D);
  for (let y = yb - 0.08; y > top + 0.05; y -= 0.2) pen(c, WOOD_D, Math.max(LW * 1.5, 0.03), [lx + 0.02, y, lx + 0.27, y]);
  box(c, 0.2, yb - 0.04, 0.62, 0.09, 0.02, WOOD_L); box(c, 0.26, yb - 0.13, 0.56, 0.09, 0.02, WOOD); box(c, 0.22, yb - 0.22, 0.5, 0.09, 0.02, WOOD_L);
}

// Small animated overlays, shared by all buildings.
const FX_ID = dict({ puff: 0, soot: 1, flame: 2, bubble: 3, flag: 4, hat: 5 });
function fxSprite(kind, scale, f, col) {
  const plain = kind === 'puff' || kind === 'soot' || kind === 'flame';
  const key = K_FX + ((FX_ID[kind] * 8 + f) * 64 + (col ? colorId(col) : 0)) * 32 + bucketIdx(scale);
  return cache.get(key) || miss(key, (s) => bake(s, [0.8, 0.9, 0.9, 0.7], (c) => {
    if (kind === 'hat') return toque(c, 0, 0.12, 0.3, col);
    if (kind === 'flame') flame(c, 0, 0.12, 1, f);
    else if (kind === 'bubble') { ell(c, 0, 0, 0.1, 0.085, '#ee6a4a'); glint(c, -0.03, -0.03, 0.035, 0.022, 0.7); }
    else if (kind === 'flag') {
      c.beginPath();
      const wv = (u) => Math.sin(u * 5.5 - f * TAU / 4) * 0.045 * (0.25 + u);
      for (let i = 0; i <= 8; i++) c.lineTo(i / 8 * 0.56, wv(i / 8));
      for (let i = 8; i >= 0; i--) c.lineTo(i / 8 * 0.56, wv(i / 8) + 0.34 - (i / 8) * 0.04);
      c.closePath(); ink(c, col); dot(c, 0.2, 0.17 + wv(0.36), 0.06, '#fff8ea');
    } else if (L === 1) {
      const d = kind === 'soot';
      c.fillStyle = d ? '#544e4b' : '#ebe5da'; c.beginPath(); c.arc(0, 0, 0.2, 0, TAU); c.fill();
      c.fillStyle = d ? '#6e6763' : '#fdfaf3'; c.beginPath(); c.arc(-0.025, -0.03, 0.16, 0, TAU); c.fill();
    }
  }, plain ? { outline: false, bevel: false } : {}));
}
function fxBlit(ctx, sp, px, py, scale, k, a) {
  const kk = k * scale / sp.s; sp.used = ++clock;
  ctx.globalAlpha = a; ctx.drawImage(sp.cv, px - sp.ox * kk, py - sp.oy * kk, sp.w * kk, sp.h * kk);
}
const frac = (v) => v - Math.floor(v);
function fxSmoke(ctx, kind, px, py, scale, k, t, a0, seed) {
  const sp = fxSprite(kind, scale, 0);
  for (let i = 0; i < 3; i++) {
    const ph = frac(t * 0.42 + i / 3 + seed);
    fxBlit(ctx, sp, px + (Math.sin(ph * 5 + i * 2.1) * 0.07 + ph * 0.3) * scale * k, py - ph * scale * k, scale, k * (0.45 + ph * 0.95), a0 * (1 - ph) * Math.min(1, ph * 6));
  }
}
// [kind, x, y, size] in footprint tiles
const B_FX = dict({
  hq: [['smoke', 3.0, -0.5, 1], ['flag', 0.78, -0.56, 1]],
  house: [['smoke', 1.445, -0.45, 0.6]],
  grill: [['smoke', 2.26, -0.68, 0.8], ['flame', 0.95, 1.98, 0.85], ['flame', 1.5, 1.9, 1.05], ['flame', 2.05, 1.98, 0.85]],
  sauce: [['bubble', 1.12, 1.72, 1], ['bubble', 1.72, 1.82, 0.8], ['bubble', 1.98, 1.68, 0.9], ['steam', 1.5, 1.55, 0.9]],
  lab: [['steam', 2.06, 0.2, 0.5]],
  restaurant: [['flag', 0.52, -0.44, 0.85], ['flag', 3.52, -0.44, 0.85]],
});
const BLD_ID = new Map(Object.keys(BUILDINGS).map((k, i) => [k, i]));
const DMG = [[0.3, 0.4], [0.72, 0.28], [0.52, 0.62], [0.22, 0.72]];

/**
 * Draw a station with the TOP-LEFT of its footprint on (x,y). Art rises up to ~0.7 tile above the footprint.
 * @param {string} type   a BUILDINGS key (anything else draws a neutral 2x2 placeholder hut)
 * @param {string} color  team colour (hex)
 * @param {number} scale  canvas pixels per tile
 * @param {{progress?:number, t?:number, hpFrac?:number, ghost?:false|'ok'|'bad'}} [o]
 *        progress < 1 = construction site (10 steps); hpFrac < 0.5 adds smoke, < 0.25 adds flames;
 *        ghost = translucent placement preview tinted green ('ok') or red ('bad').
 */
export function drawBuilding(ctx, type, color, x, y, scale, o) {
  const N = bSize(type), col = safeColor(color), ti = BLD_ID.get(type), bi = bucketIdx(scale);
  const base = K_BLD + ((ti === undefined ? 31 : ti) * 64 + colorId(col)) * 512, ga = ctx.globalAlpha;      // + state * 32 + bucket
  const prog = o && o.progress != null ? o.progress : 1, t = (o && +o.t) || 0, box4 = [0.5, 1.2, N + 0.6, N + 0.5];
  const art = (c) => bArt(c, type, col);
  if (o && o.ghost) {                                              // placement preview: tinted + translucent
    const bad = o.ghost === 'bad', key = base + (bad ? 12 : 11) * 32 + bi;
    const sp = cache.get(key) || miss(key, (s) => {
      const src = cache.get(base + 320 + (key & 31)) || bake(s, box4, art), cv = document.createElement('canvas'); cv.width = src.w; cv.height = src.h;
      const c = cv.getContext('2d'); c.drawImage(src.cv, 0, 0); c.globalCompositeOperation = 'source-atop'; c.globalAlpha = 0.5; c.fillStyle = bad ? '#ff3b30' : '#3ddc64'; c.fillRect(0, 0, src.w, src.h);
      return { cv, ox: src.ox, oy: src.oy, w: src.w, h: src.h, s: src.s, used: 0 };
    });
    ctx.globalAlpha = ga * 0.68; blit(ctx, sp, x, y, scale); ctx.globalAlpha = ga;
    return;
  }
  if (prog < 1) {                                                   // construction site, 10 visible steps
    const q = Math.max(0, Math.min(9, Math.floor(prog * 10))), key = base + q * 32 + bi;
    blit(ctx, cache.get(key) || miss(key, (s) => bake(s, box4, (c) => siteArt(c, type, col, q / 10))), x, y, scale);
    return;
  }
  blit(ctx, cache.get(base + 320 + bi) || miss(base + 320 + bi, (s) => bake(s, box4, art)), x, y, scale);
  const fx = B_FX[type];
  if (fx) for (let i = 0; i < fx.length; i++) {
    const [fk, fx_, fy, k] = fx[i], px = x + fx_ * scale, py = y + fy * scale;
    if (fk === 'smoke') fxSmoke(ctx, 'puff', px, py, scale, k, t, 0.8 * ga, i * 0.37);
    else if (fk === 'steam') fxSmoke(ctx, 'puff', px, py, scale, k, t * 1.3, 0.5 * ga, i * 0.37);
    else if (fk === 'flame') fxBlit(ctx, fxSprite('flame', scale, (Math.floor(t * 9 + i * 1.7) % 3 + 3) % 3), px, py, scale, k, ga);
    else if (fk === 'flag') fxBlit(ctx, fxSprite('flag', scale, (Math.floor(t * 7) % 4 + 4) % 4, col), px, py, scale, k, ga);
    else if (fk === 'bubble') { const ph = frac(t * 0.9 + i * 0.41); if (ph < 0.8) fxBlit(ctx, fxSprite('bubble', scale, 0), px, py, scale, k * (0.35 + ph * 0.9), ga); }
  }
  const hp = o && o.hpFrac != null ? o.hpFrac : 1;
  if (hp < 0.5) {                                                   // damage: smoke, then flames
    const k = Math.max(0.6, N / 3.4);
    for (let i = 0; i < (hp < 0.25 ? 3 : 2); i++) fxSmoke(ctx, 'soot', x + DMG[i][0] * N * scale, y + (DMG[i][1] * N - 0.15) * scale, scale, k, t * 1.1, 0.8 * ga, i * 0.29 + 0.1);
    if (hp < 0.25) for (let i = 0; i < 3; i++) { const d = DMG[(i + 2) % 4]; fxBlit(ctx, fxSprite('flame', scale, (Math.floor(t * 9 + i * 1.3) % 3 + 3) % 3), x + d[0] * N * scale, y + d[1] * N * scale, scale, k * 1.5, ga); }
  }
  ctx.globalAlpha = ga;
}

// ==================================================================== TERRAIN
// Everything is positioned in WORLD tile coordinates and clipped to the tile being painted, so features
// that straddle tile borders (patches, shorelines, tufts) line up seamlessly. All paints are opaque and
// the clip is snapped outward to whole pixels, so fractional tile sizes do not leave hairline seams.
const G_BASE = '#8cc65b', G_LIGHT = '#95cc64', G_DARK = '#85c158', G_FOREST = '#79b254', SAND = '#ecdfa6', SHALLOW = '#8fd8e9', DEEP = '#57b8df';
/**
 * Path of the part of tile (tx,ty) covered by a blob (pond, forest floor). Edges facing a different
 * tile are inset by d and their corners rounded by R; inner corners get a matching fillet. Edges shared
 * with the same kind of tile are pushed out by `ext` so neighbouring tiles overlap instead of leaving a seam.
 */
function blobPath(ctx, tx, ty, same, d, R, ext) {
  const n = !same(0, -1), e = !same(1, 0), s = !same(0, 1), w = !same(-1, 0), r = Math.min(R, 0.5 - d);
  const corners = [[tx + 1, ty, -1, 0, 0, 1, n, e, !same(1, -1)], [tx + 1, ty + 1, 0, -1, -1, 0, e, s, !same(1, 1)],
    [tx, ty + 1, 1, 0, 0, -1, s, w, !same(-1, 1)], [tx, ty, 0, 1, 1, 0, w, n, !same(-1, -1)]];
  ctx.beginPath(); ctx.moveTo(tx + 0.5, ty + (n ? d : -ext));
  for (const [cx, cy, ux, uy, vx, vy, lin, lout, dg] of corners) {
    const a = lout ? d : -ext, b = lin ? d : -ext, qx = cx + ux * a + vx * b, qy = cy + uy * a + vy * b;
    if (lin && lout) { ctx.lineTo(qx + ux * r, qy + uy * r); ctx.arcTo(qx, qy, qx + vx * r, qy + vy * r, r); }
    else if (!lin && !lout && dg) { ctx.lineTo(cx + ux * d - vx * ext, cy + uy * d - vy * ext); ctx.lineTo(cx + ux * d, cy + uy * d);
      ctx.arcTo(cx + (ux + vx) * d, cy + (uy + vy) * d, cx + vx * d, cy + vy * d, d); ctx.lineTo(cx + vx * d - ux * ext, cy + vy * d - uy * ext); }
    else ctx.lineTo(qx, qy);
  }
  ctx.closePath();
}
/**
 * Paint the ground of ONE tile (tx,ty) into the square at (x,y) with side `size` px. Deterministic and seamless.
 * GRASS / TREE / STUMP paint meadow (forest tiles get a shady floor); WATER paints a pond with a sandy shore
 * wherever getTile(tx,ty) reports a non-water neighbour. Meant for (re)building terrain chunks, not per frame.
 */
export function paintGround(ctx, tile, tx, ty, x, y, size, getTile) {
  const at = (dx, dy) => { const v = getTile ? getTile(tx + dx, ty + dy) : undefined; return v === undefined ? tile : v; };
  const isForest = (v) => v === TILE.TREE || v === TILE.STUMP, px = 1 / size, ext = 1.5 * px;
  const hit = (fx, fy, r) => fx + r > tx && fx - r < tx + 1 && fy + r > ty && fy - r < ty + 1;      // does a feature reach this tile?
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.ceil(x + size), y1 = Math.ceil(y + size);
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
  ctx.fillStyle = G_BASE; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.translate(x - tx * size, y - ty * size); ctx.scale(size, size); ctx.lineCap = ctx.lineJoin = 'round';
  // 1. broad lighter / darker meadow patches (up to ~2 tiles across, so look two cells out)
  for (let cy = ty - 2; cy <= ty + 2; cy++) for (let cx = tx - 2; cx <= tx + 2; cx++) {
    const h = hash2(cx * 3 + 1, cy * 7 + 2);
    if (h > 0.2) continue;
    const rx = 0.9 + hash2(cx, cy * 5 + 3) * 0.95, fx = cx + hash2(cx + 11, cy), fy = cy + hash2(cx, cy + 17);
    if (!hit(fx, fy, rx)) continue;
    ctx.fillStyle = h < 0.1 ? G_LIGHT : G_DARK;
    ctx.beginPath(); ctx.ellipse(fx, fy, rx, rx * (0.5 + hash2(cx + 5, cy + 5) * 0.3), hash2(cx + 2, cy + 9) * PI, 0, TAU); ctx.fill();
  }
  // shady forest floor: a rounded blob under contiguous forest, plus one soft bulge per forest tile that may spill onto its neighbours
  if (isForest(tile)) blobPath(ctx, tx, ty, (dx, dy) => isForest(at(dx, dy)), 0.12, 0.38, ext); else ctx.beginPath();
  let shade = isForest(tile);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isForest(at(dx, dy))) {
    const cx = tx + dx, cy = ty + dy, ex = cx + 0.5 + (hash2(cx, cy + 40) - 0.5) * 0.2, ey = cy + 0.5 + (hash2(cx + 40, cy) - 0.5) * 0.2, rx = 0.54 + hash2(cx + 7, cy + 3) * 0.14;
    ctx.moveTo(ex + rx, ey); ctx.ellipse(ex, ey, rx, 0.52 + hash2(cx + 1, cy + 8) * 0.14, 0, 0, TAU); shade = true;
  }
  if (shade) { ctx.fillStyle = G_FOREST; ctx.fill(); }
  // 2. small details: grass tufts (batched into two strokes), flowers, pebbles
  const tufts = [[], []], extras = [];
  for (let cy = ty - 1; cy <= ty + 1; cy++) for (let cx = tx - 1; cx <= tx + 1; cx++) {
    const r = rng(cx * 7919 + cy * 104729 + 13);
    for (let i = 0, n = 1 + (r() * 3 | 0); i < n; i++) { const fx = cx + r(), fy = cy + r(), k = 0.7 + r() * 0.5, li = r() < 0.5 ? 0 : 1; if (hit(fx, fy, 0.16)) tufts[li].push(fx, fy, k); }
    const q = r(), fx = cx + r(), fy = cy + r(), v = r();
    if (q < 0.2 && hit(fx, fy, 0.1)) extras.push(q < 0.13 ? 1 : 0, fx, fy, v);
  }
  ctx.lineWidth = Math.max(0.035, 1.2 * px);
  for (let li = 0; li < 2; li++) {
    const t = tufts[li]; if (!t.length) continue;
    ctx.strokeStyle = li ? '#a6da74' : '#74b34c'; ctx.beginPath();
    for (let i = 0; i < t.length; i += 3) { const fx = t[i], fy = t[i + 1], k = t[i + 2]; ctx.moveTo(fx - 0.05 * k, fy - 0.1 * k); ctx.lineTo(fx, fy);
      ctx.lineTo(fx + 0.06 * k, fy - 0.09 * k); ctx.moveTo(fx, fy); ctx.lineTo(fx + 0.005, fy - 0.13 * k); }
    ctx.stroke();
  }
  for (let i = 0; i < extras.length; i += 4) {
    const fx = extras[i + 1], fy = extras[i + 2];
    if (extras[i]) {                                  // flower
      const col = ['#fff8ea', '#ffe27a', '#f9b3cf', '#fff8ea'][(extras[i + 3] * 4) | 0];
      ctx.fillStyle = col; ctx.beginPath(); for (let j = 0; j < 5; j++) { const ax = fx + Math.cos(j * TAU / 5) * 0.05, ay = fy + Math.sin(j * TAU / 5) * 0.05;
        ctx.moveTo(ax + 0.036, ay); ctx.arc(ax, ay, 0.036, 0, TAU); } ctx.fill();
      ctx.fillStyle = col === '#ffe27a' ? '#f08a24' : '#f6c544'; ctx.beginPath(); ctx.arc(fx, fy, 0.03, 0, TAU); ctx.fill();
    } else {                                          // pebble
      ctx.fillStyle = '#8a9a78'; ctx.beginPath(); ctx.ellipse(fx, fy + 0.012, 0.075, 0.05, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#cfd3c4'; ctx.beginPath(); ctx.ellipse(fx - 0.006, fy - 0.006, 0.066, 0.04, 0, 0, TAU); ctx.fill();
    }
  }
  if (tile === TILE.WATER) {                          // grassy bank -> sand rim -> shallows -> deep water
    const same = (dx, dy) => at(dx, dy) === TILE.WATER;
    blobPath(ctx, tx, ty, same, 0.05, 0.48, ext); ctx.fillStyle = '#7da653'; ctx.fill();
    blobPath(ctx, tx, ty, same, 0.085, 0.45, ext); ctx.fillStyle = SAND; ctx.fill();
    blobPath(ctx, tx, ty, same, 0.17, 0.37, ext); ctx.fillStyle = SHALLOW; ctx.fill();
    blobPath(ctx, tx, ty, same, 0.3, 0.26, ext); ctx.fillStyle = DEEP; ctx.fill();
    ctx.clip();
    const waves = [];
    for (let cy = ty - 1; cy <= ty + 1; cy++) for (let cx = tx - 1; cx <= tx + 1; cx++) {
      const r = rng(cx * 4391 + cy * 9973 + 5), blot = r() < 0.5, bx = cx + r(), by = cy + r(), brx = 0.5 + r() * 0.3, rot = r() * PI;
      if (blot && hit(bx, by, brx)) { ctx.fillStyle = '#4eaad8'; ctx.beginPath(); ctx.ellipse(bx, by, brx, 0.3, rot, 0, TAU); ctx.fill(); }
      for (let i = 0; i < 2; i++) { const fx = cx + r(), fy = cy + r(), w = 0.1 + r() * 0.1; if (hit(fx, fy, 0.22)) waves.push(fx, fy, w); }
    }
    ctx.strokeStyle = '#dcf3fb'; ctx.lineWidth = Math.max(0.035, 1.2 * px); ctx.beginPath();
    for (let i = 0; i < waves.length; i += 3) { const fx = waves[i], fy = waves[i + 1], w = waves[i + 2]; ctx.moveTo(fx - w, fy); ctx.quadraticCurveTo(fx - w / 2, fy - 0.05, fx, fy);
      ctx.quadraticCurveTo(fx + w / 2, fy + 0.05, fx + w, fy); }
    ctx.stroke();
  }
  ctx.restore();
}

// ====================================================================== ICONS
// Icon art is drawn in a unit box centred on the origin (about -0.5..0.5), then baked like any sprite.
function knife(c) {                                   // chef's knife along +x, centred
  box(c, -0.5, -0.075, 0.36, 0.15, 0.06, '#3a2c28'); dot(c, -0.4, 0, 0.022, GOLD); dot(c, -0.26, 0, 0.022, GOLD);
  c.beginPath(); c.moveTo(-0.14, -0.1); c.lineTo(0.3, -0.1); c.quadraticCurveTo(0.5, -0.07, 0.56, 0.07); c.quadraticCurveTo(0.25, 0.14, -0.14, 0.11); c.closePath(); ink(c, '#e6edf0');
  pen(c, '#fff', LW * 1.4, [-0.1, 0.06, 0.3, 0.075]);
}
function heart(c, x, y, k, col) { c.beginPath(); c.moveTo(x, y + 0.3 * k); c.bezierCurveTo(x - 0.5 * k, y - 0.05 * k, x - 0.22 * k, y - 0.4 * k, x, y - 0.14 * k);
  c.bezierCurveTo(x + 0.22 * k, y - 0.4 * k, x + 0.5 * k, y - 0.05 * k, x, y + 0.3 * k); c.closePath(); ink(c, col); }
const RES_ART = dict({
  food(c) { carrot(c, -0.24, -0.24, 2.05, PI / 4); },
  wood(c) { logPiece(c, -0.42, -0.06, 0.72, 0.16, -0.3); logPiece(c, -0.4, 0.26, 0.74, 0.17, -0.12); },
  spice(c) { chili(c, -0.3, -0.16, 2.2, 0.5); },
  salt(c) { crystal(c, -0.24, 0.4, 0.28, 0.5, -0.3); crystal(c, 0.26, 0.4, 0.26, 0.42, 0.32); crystal(c, 0, 0.42, 0.36, 0.86, 0.03); },
  pop(c) { scaled(c, 0, 0.42, 2.25, () => toque(c, 0, 0, 0.38, '#d8cfbd')); },
  tips(c) { ell(c, 0.08, 0.06, 0.34, 0.34, '#d9a93c'); ell(c, -0.1, -0.06, 0.34, 0.34, GOLD); ell(c, -0.1, -0.06, 0.24, 0.24, '#f7d774', 0, LW * 0.8); pen(c, '#a8741a', 0.05, [-0.1, -0.2, -0.1, 0.08]); pen(c, '#a8741a', 0.05, [-0.2, -0.06, 0, -0.06]); },
});
const TECH_ART = dict({
  knives(c) { for (const m of [-1, 1]) { c.save(); c.scale(m, 1); c.rotate(-PI / 4); scaled(c, 0, 0, 0.92, () => knife(c)); c.restore(); } },
  aprons(c, t) {
    const col = ['#f1e2c0', '#f1e2c0', '#a9683c', '#b9c4cb'][t] || '#f1e2c0';
    c.beginPath(); c.arc(0, -0.3, 0.15, PI, 0); pen(c, dk(col, 0.4), 0.07); limb(c, -0.34, -0.02, -0.48, 0.08, 0.05, dk(col, 0.25)); limb(c, 0.34, -0.02, 0.48, 0.08, 0.05, dk(col, 0.25));
    poly(c, [-0.17, -0.32, 0.17, -0.32, 0.2, -0.08, 0.36, -0.02, 0.33, 0.44, -0.33, 0.44, -0.36, -0.02, -0.2, -0.08], col);
    if (t === 3) { for (let y = -0.22; y < 0.4; y += 0.11) for (let x = -0.24; x < 0.3; x += 0.12) dot(c, x + (Math.round(y * 9) % 2 ? 0.06 : 0), y, 0.03, dk(col, 0.3)); }
    else { box(c, -0.16, 0.1, 0.32, 0.2, 0.04, dk(col, 0.13)); if (t < 2) for (const x of [-0.08, 0.08]) pen(c, dk(col, 0.2), LW, [x, -0.28, x, 0.06]); }
  },
  sauce(c) {
    poly(c, [-0.06, -0.28, 0.06, -0.28, 0.025, -0.5, -0.025, -0.5], '#fff8ea');
    c.beginPath(); c.moveTo(-0.19, 0.44); c.lineTo(-0.19, -0.08); c.quadraticCurveTo(-0.18, -0.24, -0.07, -0.3); c.lineTo(0.07, -0.3); c.quadraticCurveTo(0.18, -0.24, 0.19, -0.08);
      c.lineTo(0.19, 0.44); c.closePath(); ink(c, SAUCE);
    box(c, -0.19, 0.0, 0.38, 0.3, 0, '#fff8ea', LW * 0.8); flame(c, 0, 0.27, 0.72, 0); glint(c, -0.11, -0.12, 0.03, 0.08, 0.5);
  },
  bumper(c) {
    box(c, -0.43, 0.24, 0.2, 0.2, 0.05, '#3b3a40'); box(c, 0.23, 0.24, 0.2, 0.2, 0.05, '#3b3a40');
    box(c, -0.38, -0.42, 0.76, 0.66, 0.12, '#e8663c'); box(c, -0.3, -0.34, 0.6, 0.24, 0.05, '#c6ecf5'); glint(c, -0.18, -0.24, 0.03, 0.09, 0.7, 0.6);
    ell(c, -0.25, 0.04, 0.075, 0.075, '#ffe58a'); ell(c, 0.25, 0.04, 0.075, 0.075, '#ffe58a'); for (const x of [-0.08, 0, 0.08]) pen(c, '#8c3b20', LW * 1.4, [x, -0.02, x, 0.1]);
    box(c, -0.48, 0.14, 0.96, 0.19, 0.08, STEEL); dot(c, -0.32, 0.235, 0.03, dk(STEEL, 0.4)); dot(c, 0.32, 0.235, 0.03, dk(STEEL, 0.4)); glint(c, 0, 0.19, 0.3, 0.02, 0.7);
  },
  ovens(c) {
    c.beginPath(); c.moveTo(-0.44, 0.42); c.lineTo(-0.44, -0.02); c.bezierCurveTo(-0.44, -0.58, 0.44, -0.58, 0.44, -0.02); c.lineTo(0.44, 0.42); c.closePath(); ink(c, BRICK);
    if (L === 1) { c.save(); c.clip(); c.strokeStyle = dk(BRICK, 0.24); c.lineWidth = LW * 1.2; for (let y = -0.4, r = 0; y < 0.42; y += 0.14, r++) { c.beginPath(); c.moveTo(-0.5, y);
      c.lineTo(0.5, y); for (let x = -0.5 + (r % 2) * 0.12; x < 0.5; x += 0.24) { c.moveTo(x, y); c.lineTo(x, y + 0.14); } c.stroke(); } c.restore(); }
    c.beginPath(); c.moveTo(-0.22, 0.42); c.lineTo(-0.22, 0.14); c.arc(0, 0.14, 0.22, PI, 0); c.lineTo(0.22, 0.42); c.closePath(); ink(c, '#40302c'); flame(c, 0, 0.4, 0.9, 0);
  },
  meatballs(c) { meatball(c, -0.2, 0.2, 0.22); meatball(c, 0.22, 0.2, 0.21); meatball(c, 0.02, -0.14, 0.25); },
  smock(c, t) {                                        // ranged armour: a sauce-spattered smock, tougher cloth every tier
    const col = ['#f3d9c2', '#f3d9c2', '#c9935a', '#dfe6ea'][t] || '#f3d9c2';
    limb(c, -0.3, -0.26, -0.46, 0.18, 0.12, col); limb(c, 0.3, -0.26, 0.46, 0.18, 0.12, col);
    poly(c, [-0.22, -0.36, 0.22, -0.36, 0.32, -0.22, 0.3, 0.44, -0.3, 0.44, -0.32, -0.22], col);
    poly(c, [-0.1, -0.36, 0, -0.22, 0.1, -0.36], dk(col, 0.18));
    ell(c, 0.1, 0.12, 0.09, 0.06, SAUCE, 0.4, 0); dot(c, -0.08, 0.26, 0.035, SAUCE); dot(c, 0.2, -0.04, 0.025, SAUCE);
    if (t === 3) for (let y = -0.12; y < 0.4; y += 0.16) pen(c, dk(col, 0.25), LW, [-0.26, y, 0.26, y]);
  },
  hubcap(c) {                                          // vehicle attack: a spiked hubcap
    for (let i = 0; i < 8; i++) { const a = i * PI / 4; poly(c, [Math.cos(a - 0.18) * 0.34, Math.sin(a - 0.18) * 0.34, Math.cos(a) * 0.5, Math.sin(a) * 0.5, Math.cos(a + 0.18) * 0.34, Math.sin(a + 0.18) * 0.34], STEEL); }
    ell(c, 0, 0, 0.36, 0.36, '#3b3a40'); ell(c, 0, 0, 0.22, 0.22, STEEL); ell(c, 0, 0, 0.07, 0.07, dk(STEEL, 0.3));
    for (let i = 0; i < 5; i++) { const a = i * TAU / 5; dot(c, Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0.03, dk(STEEL, 0.35)); }
    glint(c, -0.1, -0.12, 0.08, 0.04, 0.6);
  },
  axle(c) {                                            // siege: two wheels on a greased axle
    limb(c, -0.34, 0.12, 0.34, 0.12, 0.09, IRON);
    for (const x of [-0.34, 0.34]) { ell(c, x, 0.12, 0.17, 0.3, WOOD); ell(c, x, 0.12, 0.06, 0.1, WOOD_D); }
    c.beginPath(); c.moveTo(0, -0.46); c.quadraticCurveTo(0.14, -0.24, 0, -0.16); c.quadraticCurveTo(-0.14, -0.24, 0, -0.46); ink(c, '#e8c34a');
  },
  peeler(c) {
    c.save(); c.rotate(-PI / 4);
    for (const m of [-1, 1]) { c.beginPath(); c.moveTo(-0.08, 0); c.quadraticCurveTo(0.1, m * 0.02, 0.16, m * 0.17); c.lineTo(0.46, m * 0.17); pen(c, dk(STEEL, 0.36), 0.085); pen(c, STEEL, 0.05); }
    box(c, 0.3, -0.2, 0.07, 0.4, 0.02, '#e6edf0'); box(c, -0.52, -0.08, 0.46, 0.16, 0.07, '#e58a2a'); dot(c, -0.44, 0, 0.03, dk('#e58a2a', 0.3)); c.restore();
    c.beginPath(); c.arc(0.3, 0.3, 0.11, 0.5, 5.2); pen(c, dk('#f08a24', 0.3), 0.085); pen(c, '#f6a94a', 0.05);
  },
  hatchet(c) { c.save(); c.rotate(-PI / 4); limb(c, -0.46, 0, 0.3, 0, 0.1, WOOD); poly(c, [0.08, -0.06, 0.36, -0.1, 0.44, 0.34, 0.2, 0.24, 0.08, 0.06], STEEL); pen(c, '#fff', LW * 1.6, [0.4, 0.3, 0.23, 0.22]); c.restore(); },
  sifter(c) {
    limb(c, 0.3, 0.02, 0.52, 0.2, 0.07, WOOD_D); ell(c, 0, -0.06, 0.44, 0.3, WOOD_L); ell(c, 0, -0.08, 0.35, 0.22, '#eef2f4');
    if (L === 1) { c.save(); c.beginPath(); c.ellipse(0, -0.08, 0.35, 0.22, 0, 0, TAU); c.clip(); c.strokeStyle = '#9aa7b0'; c.lineWidth = LW; c.beginPath();
      for (let i = -0.4; i < 0.45; i += 0.1) { c.moveTo(i, -0.4); c.lineTo(i, 0.3); c.moveTo(-0.5, i - 0.08); c.lineTo(0.5, i - 0.08); } c.stroke(); c.restore(); }
    for (const [x, y] of [[-0.18, 0.32], [0, 0.4], [0.16, 0.3], [-0.06, 0.26], [0.08, 0.46]]) dot(c, x, y, 0.03, '#e0542c');
  },
  basket(c) {
    c.beginPath(); c.arc(0, 0.02, 0.32, PI, 0); pen(c, dk('#b98443', 0.36), 0.11); pen(c, '#b98443', 0.07);
    carrot(c, -0.14, -0.12, 0.95, PI / 2 - 0.3); ball(c, 0.14, -0.04, 0.12, '#e5402e'); ell(c, 0, -0.05, 0.1, 0.08, '#8ccf5a');
    poly(c, [-0.42, 0.02, 0.42, 0.02, 0.32, 0.44, -0.32, 0.44], '#cf9f58'); for (const y of [0.16, 0.3]) pen(c, '#a5743a', LW * 1.3, [-0.38, y, 0.38, y]);
    for (let x = -0.24; x < 0.3; x += 0.16) pen(c, '#a5743a', LW * 1.3, [x, 0.04, x * 0.85, 0.42]); box(c, -0.45, -0.03, 0.9, 0.09, 0.04, '#b98443');
  },
  carts(c) {
    limb(c, 0.3, -0.02, 0.5, -0.34, 0.055, IRON); crate(c, -0.36, -0.02, 0.3, 0.26); sack(c, 0.12, 0, 0.75);
    box(c, -0.44, -0.02, 0.78, 0.2, 0.04, WOOD_L); pen(c, WOOD_D, LW * 1.3, [-0.42, 0.08, 0.32, 0.08]);
    wheel(c, -0.24, 0.3, 0.15, 0.3, WOOD_L); wheel(c, 0.14, 0.3, 0.15, 0.8, WOOD_L);
  },
  mitts(c) {
    c.beginPath(); c.moveTo(-0.22, 0.3); c.lineTo(-0.24, 0.0); c.bezierCurveTo(-0.3, -0.56, 0.26, -0.56, 0.2, -0.04); c.bezierCurveTo(0.3, -0.24, 0.52, -0.14, 0.42, 0.04);
      c.bezierCurveTo(0.36, 0.16, 0.24, 0.2, 0.2, 0.3); c.closePath(); ink(c, '#e8663c');
    pen(c, dk('#e8663c', 0.22), LW * 1.2, [-0.12, -0.3, 0.1, 0.2]); pen(c, dk('#e8663c', 0.22), LW * 1.2, [0.08, -0.3, -0.14, 0.2]);
    box(c, -0.26, 0.26, 0.5, 0.18, 0.05, '#fff8ea');
  },
  elite(c) { star(c, 0, 0.02, 0.48, GOLD); if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.moveTo(0, -0.46); c.lineTo(-0.1, -0.13); c.lineTo(0, 0.02); c.fill();
    } star(c, 0.36, -0.36, 0.1, '#fff8ea', LW * 0.8); star(c, -0.4, 0.3, 0.08, '#fff8ea', LW * 0.8); },
  age(c, t) {
    ell(c, 0, 0.22, 0.46, 0.2, '#fdfbf4'); ell(c, 0, 0.2, 0.31, 0.12, '#ebe5d6', 0, LW * 0.8);
    poly(c, [0, -0.5, 0.28, -0.2, 0.12, -0.2, 0.12, 0.16, -0.12, 0.16, -0.12, -0.2, -0.28, -0.2], '#4fc46a');
    for (let i = 0; i < t; i++) star(c, (i - (t - 1) / 2) * 0.2, 0.4, 0.095, GOLD, LW * 0.8);
  },
  pans(c) { c.save(); c.rotate(-PI / 5); limb(c, 0.18, 0, 0.56, 0, 0.1, '#3a2c28'); ell(c, -0.14, 0, 0.36, 0.36, '#4b4f5a'); ell(c, -0.14, 0, 0.27, 0.27, '#30333b', 0, LW * 0.8); glint(c, -0.26, -0.12, 0.08, 0.05, 0.35, 0.6); c.restore(); },
  clogs(c) {
    for (const [ox, oy, col] of [[0.08, -0.16, '#d8833a'], [-0.08, 0.14, '#e79a4b']]) {
      c.beginPath(); c.moveTo(ox - 0.4, oy + 0.14); c.lineTo(ox - 0.4, oy - 0.06); c.bezierCurveTo(ox - 0.3, oy - 0.2, ox - 0.02, oy - 0.2, ox + 0.08, oy - 0.08);
      c.bezierCurveTo(ox + 0.3, oy - 0.1, ox + 0.44, oy + 0.02, ox + 0.42, oy + 0.14); c.closePath(); ink(c, col);
      box(c, ox - 0.42, oy + 0.12, 0.86, 0.08, 0.03, '#3a2c28'); ell(c, ox - 0.2, oy - 0.05, 0.12, 0.06, dk(col, 0.35), 0, 0);
    }
  },
  meals(c) {
    for (const x of [-0.16, 0.02, 0.2]) { c.beginPath(); c.moveTo(x, -0.2); c.bezierCurveTo(x - 0.1, -0.3, x + 0.1, -0.38, x, -0.5); pen(c, '#fff8ea', 0.05); }
    ell(c, 0, -0.06, 0.4, 0.1, '#e8b04a'); c.beginPath(); c.moveTo(-0.46, -0.06); c.bezierCurveTo(-0.42, 0.44, 0.42, 0.44, 0.46, -0.06); c.closePath(); ink(c, '#fdfbf4');
    pen(c, '#4f9a5a', 0.045, [-0.36, 0.08, 0.36, 0.08]); box(c, -0.16, 0.36, 0.32, 0.08, 0.03, '#e2ddd0');
  },
  kds(c) {
    box(c, -0.5, -0.44, 1.0, 0.1, 0.04, STEEL);
    for (const [x, h, r] of [[-0.42, 0.62, -0.05], [-0.12, 0.74, 0.03], [0.18, 0.56, -0.02]]) {
      c.save(); c.translate(x + 0.12, -0.38); c.rotate(r); box(c, -0.12, 0, 0.25, h, 0.02, '#fffaf0'); for (let y = 0.12; y < h - 0.06; y += 0.1) pen(c, '#9a8f80', LW * 1.3, [-0.07, y, 0.08, y]); c.restore();
    }
    for (const x of [-0.3, 0, 0.3]) dot(c, x, -0.39, 0.035, '#e2403a');
  },
  mise(c) {
    for (const [x, y, col] of [[-0.26, -0.14, '#e5402e'], [0.26, -0.14, '#8ccf5a'], [0, 0.22, '#f2c230']]) {
      ell(c, x, y, 0.22, 0.1, col); c.beginPath(); c.moveTo(x - 0.24, y); c.bezierCurveTo(x - 0.22, y + 0.26, x + 0.22, y + 0.26, x + 0.24, y); c.closePath(); ink(c, '#fdfbf4');
    }
  },
  veteran(c) { poly(c, [-0.2, -0.5, 0.2, -0.5, 0.12, -0.06, -0.12, -0.06], '#c8452e'); pen(c, '#fff8ea', 0.05, [0, -0.48, 0, -0.08]); ell(c, 0, 0.16, 0.3, 0.3, GOLD); star(c, 0, 0.17, 0.2, '#fff8ea', LW * 0.8); },
  cheftable(c) { scaled(c, 0, 0.3, 2.1, () => toque(c, 0, 0, 0.36, '#d8cfbd')); star(c, 0.32, -0.3, 0.17, GOLD, LW * 0.9); },
  grinders(c) {
    for (const [x, k] of [[-0.2, 1], [0.22, 0.86]]) scaled(c, x, 0.44, k, () => {
      box(c, -0.13, -0.22, 0.26, 0.22, 0.05, WOOD); box(c, -0.1, -0.52, 0.2, 0.3, 0.07, WOOD_L); box(c, -0.14, -0.6, 0.28, 0.1, 0.04, WOOD_D);
      ell(c, 0, -0.68, 0.06, 0.06, STEEL); pen(c, dk(WOOD, 0.3), LW * 1.3, [-0.12, -0.22, 0.12, -0.22]);
    });
    for (const [x, y] of [[-0.02, 0.36], [0.44, 0.3], [0.02, 0.48], [-0.42, 0.4]]) dot(c, x, y, 0.03, '#2b2420');
  },
  _(c) { ell(c, 0, 0, 0.3, 0.3, STEEL); ell(c, 0, 0, 0.12, 0.12, dk(STEEL, 0.3)); },
});
const ABIL_ART = dict({
  service(c) {
    box(c, -0.44, 0.22, 0.88, 0.14, 0.06, '#7a5a3a'); box(c, -0.06, -0.38, 0.12, 0.14, 0.04, STEEL);
    c.beginPath(); c.moveTo(-0.36, 0.22); c.bezierCurveTo(-0.36, -0.36, 0.36, -0.36, 0.36, 0.22); c.closePath(); ink(c, GOLD); glint(c, -0.16, -0.06, 0.06, 0.13, 0.6, 0.5);
    for (const m of [-1, 1]) { pen(c, '#fff', 0.05, [m * 0.36, -0.3, m * 0.46, -0.4]); pen(c, '#fff', 0.05, [m * 0.44, -0.12, m * 0.56, -0.14]); }
  },
  mangia(c) {
    c.beginPath(); for (const [x, y, r] of [[-0.18, -0.02, 0.15], [0.02, -0.1, 0.18], [0.2, -0.02, 0.15]]) circ(c, x, y, r); inkU(c, '#f4d06a');
    c.beginPath(); c.arc(-0.14, -0.02, 0.08, 0.5, 4.5); pen(c, '#d9a93c', LW * 1.3); c.beginPath(); c.arc(0.16, -0.04, 0.08, 2, 6); pen(c, '#d9a93c', LW * 1.3);
    ell(c, 0.02, -0.14, 0.14, 0.08, SAUCE); ell(c, 0.05, -0.19, 0.05, 0.025, LEAF, 0.4, LW * 0.7);
    c.beginPath(); c.moveTo(-0.46, 0.02); c.bezierCurveTo(-0.42, 0.52, 0.42, 0.52, 0.46, 0.02); c.closePath(); ink(c, '#fdfbf4'); pen(c, '#e2553e', 0.04, [-0.36, 0.14, 0.36, 0.14]);
    heart(c, 0.32, -0.34, 0.42, '#f0527a');
  },
  lowslow(c) {
    c.beginPath(); for (let i = 0; i < 9; i++) circ(c, Math.cos(i * TAU / 9) * 0.31, Math.sin(i * TAU / 9) * 0.31 + 0.02, 0.135 + (i % 2) * 0.02); inkU(c, '#e4ded6');
    ell(c, 0, 0.02, 0.17, 0.17, '#6f5a4c', 0, LW); flame(c, 0, 0.14, 0.62, 0);
  },
  cuts(c) {
    for (const [o, k] of [[-0.26, 0.8], [0, 1], [0.26, 0.8]]) { c.save(); c.translate(o, o * 0.2); c.rotate(-PI / 3.2); poly(c, [-0.5 * k, 0, 0, -0.05, 0.5 * k, 0, 0, 0.05], '#f4f8fa'); c.restore(); }
    c.save(); c.translate(0.1, 0.12); c.rotate(PI * 0.8); scaled(c, 0, 0, 0.62, () => knife(c)); c.restore();
  },
  sugar(c) {
    limb(c, 0.02, 0.1, 0.16, 0.5, 0.06, '#fff8ea'); ell(c, -0.06, -0.12, 0.34, 0.34, '#f58ab4');
    c.beginPath(); for (let a = 0; a < 11; a += 0.2) { const r = 0.028 * a; c.lineTo(-0.06 + Math.cos(a) * r, -0.12 + Math.sin(a) * r); } pen(c, '#fff8ea', 0.055);
    poly(c, [0.38, -0.46, 0.2, -0.06, 0.34, -0.06, 0.22, 0.3, 0.52, -0.16, 0.37, -0.16, 0.5, -0.46], '#ffd84a');
  },
  lunch(c) {
    box(c, -0.07, -0.5, 0.14, 0.12, 0.03, STEEL); ell(c, 0.06, 0.04, 0.38, 0.38, '#3f4a66'); ell(c, 0.06, 0.04, 0.3, 0.3, '#fdfbf4', 0, LW * 0.8);
    pen(c, '#3a2c28', 0.05, [0.06, 0.04, 0.06, -0.17]); pen(c, '#e8452f', 0.05, [0.06, 0.04, 0.22, 0.1]); dot(c, 0.06, 0.04, 0.04, '#3a2c28');
    for (const [y, w] of [[-0.14, 0.2], [0.04, 0.26], [0.22, 0.18]]) pen(c, '#fff', 0.055, [-0.52, y, -0.52 + w, y]);
  },
  // --- ultimates
  flambe(c) {                                          // a pan swallowed by a tall flame
    limb(c, 0.2, 0.34, 0.56, 0.4, 0.09, '#3a2c28'); ell(c, -0.06, 0.32, 0.38, 0.12, '#4b4f5a'); ell(c, -0.06, 0.3, 0.3, 0.075, '#30333b', 0, LW * 0.8);
    flame(c, -0.27, 0.3, 1.3, 1); flame(c, 0.17, 0.3, 1.2, 2); flame(c, -0.05, 0.32, 2.3, 0);
  },
  feast(c) {                                           // a roast on a platter, with love
    ell(c, 0, 0.3, 0.5, 0.14, '#fdfbf4'); ell(c, 0, 0.28, 0.4, 0.09, '#ebe5d6', 0, LW * 0.8);
    limb(c, 0.24, 0.12, 0.44, -0.06, 0.07, '#f4e6cf'); ell(c, 0.47, -0.09, 0.06, 0.06, '#fdfbf4');
    c.beginPath(); c.moveTo(-0.3, 0.27); c.bezierCurveTo(-0.36, -0.2, 0.26, -0.24, 0.3, 0.27); c.closePath(); ink(c, '#c8793a'); glint(c, -0.1, -0.02, 0.1, 0.05, 0.4, -0.4);
    heart(c, -0.3, -0.3, 0.42, '#f0527a'); heart(c, 0.14, -0.4, 0.3, '#f0527a');
  },
  lockdown(c) {                                        // a roller shutter with a padlock
    box(c, -0.44, -0.42, 0.88, 0.84, 0.06, '#8fa0ad'); for (const y of [-0.26, -0.1, 0.06, 0.22]) pen(c, dk('#8fa0ad', 0.28), LW * 1.4, [-0.42, y, 0.42, y]);
    c.beginPath(); c.arc(0, 0.0, 0.13, PI, 0); pen(c, OUTLINE, 0.13); pen(c, STEEL, 0.07);
    box(c, -0.19, 0.0, 0.38, 0.3, 0.05, GOLD); ell(c, 0, 0.12, 0.045, 0.045, '#3a2c28'); pen(c, '#3a2c28', 0.04, [0, 0.13, 0, 0.22]);
  },
  perfectcut(c) {                                      // one long stroke of light, and the knife that made it
    c.save(); c.rotate(-PI / 4.5); poly(c, [-0.64, 0, 0, -0.07, 0.64, 0, 0, 0.07], '#f4f8fa'); c.restore();
    c.save(); c.translate(-0.04, 0.1); c.rotate(PI * 0.78); scaled(c, 0, 0, 0.8, () => knife(c)); c.restore();
    star(c, 0.34, -0.34, 0.14, '#fff8ea', LW * 0.8);
  },
  glass(c) {                                           // amber shards of set caramel
    ell(c, 0, 0.38, 0.46, 0.1, '#b8651a');
    crystal(c, -0.24, 0.4, 0.24, 0.5, -0.3, '#f0a53a'); crystal(c, 0.26, 0.4, 0.22, 0.44, 0.32, '#f0a53a'); crystal(c, 0, 0.42, 0.32, 0.86, 0.03, '#f7b955');
    star(c, 0.32, -0.36, 0.1, '#fff8ea', LW * 0.8);
  },
  brace(c) {                                           // Hold the Pass!: a wall of pan lids
    for (const [x, y, r] of [[-0.22, 0.08, 0.3], [0.2, 0.08, 0.3], [0, -0.16, 0.3]]) { ell(c, x, y, r, r, '#8c949c'); ell(c, x, y, r * 0.7, r * 0.7, '#b9c4cb', 0, LW * 0.8); dot(c, x, y, r * 0.18, '#3a2c28'); }
  },
  lastcall(c) {                                        // Last Call: a bell over a heart
    bellShape(c, '#d9a93c'); heart(c, 0.3, 0.3, 0.42, '#f0527a');
  },
  dash(c) {                                            // Flash Fry: speed lines and a cleaver
    for (const y of [-0.26, -0.1, 0.06, 0.22]) pen(c, '#fff', 0.05, [-0.5, y, -0.5 + 0.28 + Math.abs(y) * 0.4, y]);
    c.save(); c.translate(0.12, 0); c.rotate(-0.25); scaled(c, 0, 0, 1.6, () => TOOLS.cleaver(c)); c.restore();
  },
  storm(c) {                                           // Cleaver Storm: blades in a circle
    for (let i = 0; i < 5; i++) { c.save(); c.rotate(i * TAU / 5); c.translate(0.14, 0); scaled(c, 0, 0, 1.1, () => TOOLS.cleaver(c)); c.restore(); }
    ell(c, 0, 0, 0.1, 0.1, '#3a2c28');
  },
  chill(c) {                                           // Brain Freeze: a snowflake
    for (let i = 0; i < 3; i++) { c.save(); c.rotate(i * PI / 3); pen(c, OUTLINE, 0.16, [-0.46, 0, 0.46, 0]); pen(c, '#dff4ff', 0.08, [-0.46, 0, 0.46, 0]); for (const s of [-1, 1]) for (const m of [-1, 1]) pen(c, '#dff4ff', 0.06, [0.26 * s, 0, 0.38 * s, 0.14 * m]); c.restore(); }
  },
  freeze(c) {                                          // Deep Freeze: an ice block with a frozen chef hat inside
    box(c, -0.4, -0.4, 0.8, 0.8, 0.1, '#bfe9ff'); if (L === 1) { c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.moveTo(-0.38, 0.2); c.lineTo(-0.38, -0.3); c.lineTo(0.1, -0.38); c.fill(); }
    scaled(c, 0, 0.24, 1.6, () => toque(c, 0, 0, 0.3, '#9fd4ee'));
  },
  snipe(c) {                                           // Hot Shot: a ladle in crosshairs
    ell(c, 0, 0, 0.44, 0.44, '#3a2c28', 0, LW * 0.6); ell(c, 0, 0, 0.36, 0.36, '#fdfbf4', 0, LW * 0.6);
    pen(c, '#e2403a', 0.045, [-0.5, 0, 0.5, 0]); pen(c, '#e2403a', 0.045, [0, -0.5, 0, 0.5]);
    c.save(); c.rotate(-PI / 4); scaled(c, -0.1, 0, 1.4, () => TOOLS.ladle(c)); c.restore();
  },
  flood(c) {                                           // Sauce Flood: a breaking wave of sauce
    c.beginPath(); c.moveTo(-0.5, 0.4); c.lineTo(-0.5, 0.05); c.bezierCurveTo(-0.3, -0.5, 0.2, -0.5, 0.3, -0.1); c.bezierCurveTo(0.1, -0.2, 0.0, -0.05, 0.12, 0.08); c.bezierCurveTo(0.3, 0.2, 0.5, 0.1, 0.5, 0.4); c.closePath(); ink(c, SAUCE);
    for (const [x, y] of [[0.36, -0.18], [0.22, -0.34], [0.46, -0.3]]) dot(c, x, y, 0.045, SAUCE);
  },
  rush(c) {                                            // Rush Hour: running clogs with speed lines
    for (const y of [-0.3, -0.14, 0.02]) pen(c, '#fff', 0.045, [-0.5, y, -0.22, y]);
    TECH_ART.clogs(c);
  },
  bark(c) {                                            // Thick Bark: a slab of oak
    box(c, -0.42, -0.36, 0.84, 0.72, 0.12, '#6b4a2e'); for (const y of [-0.2, -0.04, 0.12, 0.28]) pen(c, '#4b321e', LW * 1.6, [-0.36, y, 0.36, y + 0.03]);
    ell(c, 0.12, -0.08, 0.07, 0.05, '#4b321e', 0.4, LW * 0.8);
  },
  swarm(c) {                                           // delivery boxes on wheels, racing
    for (const [x, y, k] of [[-0.14, -0.28, 0.72], [0.2, -0.02, 0.86], [-0.08, 0.28, 1]]) scaled(c, x, y, k, () => {
      for (const yy of [-0.1, 0.0, 0.1]) pen(c, '#fff', 0.04, [-0.44, yy, -0.28, yy]);
      box(c, -0.2, -0.16, 0.38, 0.26, 0.05, '#e8663c'); box(c, -0.2, -0.16, 0.38, 0.08, 0.03, '#fff8ea', LW * 0.8);
      wheel(c, -0.11, 0.14, 0.085, 0.3); wheel(c, 0.1, 0.14, 0.085, 0.9);
    });
  },
});
const UI_ART = dict({
  attack(c) { star(c, 0, 0, 0.5, '#e8452f'); c.save(); c.rotate(-PI / 4); scaled(c, 0, 0, 0.9, () => knife(c)); c.restore(); },
  stop(c) { c.beginPath(); for (let i = 0; i < 8; i++) c.lineTo(Math.cos(i * PI / 4 + PI / 8) * 0.48, Math.sin(i * PI / 4 + PI / 8) * 0.48); c.closePath(); ink(c, '#e2403a'); box(c, -0.28, -0.085, 0.56, 0.17, 0.03, '#fff8ea'); },
  rally(c, col) { ell(c, -0.1, 0.42, 0.26, 0.08, '#c9b78e'); limb(c, -0.2, 0.42, -0.2, -0.46, 0.06, WOOD_D); poly(c, [-0.17, -0.46, 0.44, -0.3, -0.17, -0.06], col || '#e2403a'); dot(c, -0.2, -0.47, 0.045, GOLD); },
  delete(c) {
    poly(c, [-0.3, -0.2, 0.3, -0.2, 0.24, 0.46, -0.24, 0.46], STEEL); for (const x of [-0.12, 0, 0.12]) pen(c, dk(STEEL, 0.3), LW * 1.4, [x, -0.08, x * 0.9, 0.34]);
    box(c, -0.38, -0.32, 0.76, 0.13, 0.04, dk(STEEL, 0.1)); box(c, -0.1, -0.44, 0.2, 0.13, 0.04, dk(STEEL, 0.1));
    for (const m of [-1, 1]) { pen(c, OUTLINE, 0.15, [0.14, 0.12 * m + 0.26, 0.42, -0.12 * m + 0.26]); } for (const m of [-1, 1]) pen(c, '#e2403a', 0.09, [0.14, 0.12 * m + 0.26, 0.42, -0.12 * m + 0.26]);
  },
  idle(c, col) {
    c.beginPath(); c.moveTo(-0.44, 0.34); c.bezierCurveTo(-0.5, -0.12, 0.14, -0.12, 0.08, 0.34); c.closePath(); ink(c, WHITE); box(c, -0.46, 0.24, 0.56, 0.14, 0.04, col || '#9aa7b0');
    for (const [x, y, k] of [[0.2, -0.02, 1], [0.38, -0.34, 0.7]]) { c.beginPath(); c.moveTo(x - 0.11 * k, y - 0.12 * k); c.lineTo(x + 0.11 * k, y - 0.12 * k);
      c.lineTo(x - 0.11 * k, y + 0.12 * k); c.lineTo(x + 0.11 * k, y + 0.12 * k); pen(c, OUTLINE, 0.13 * k); pen(c, '#fff8ea', 0.065 * k); }
  },
  repair(c) {
    c.save(); c.rotate(-PI / 4); box(c, -0.48, -0.075, 0.7, 0.15, 0.06, STEEL);
    c.beginPath(); c.arc(0.3, 0, 0.21, 0.55, TAU - 0.55); c.lineTo(0.26, -0.07); c.lineTo(0.26, 0.07); c.closePath(); ink(c, STEEL); dot(c, -0.38, 0, 0.035, dk(STEEL, 0.4)); c.restore();
  },
  build(c) { c.save(); c.rotate(-PI / 4); limb(c, -0.46, 0, 0.2, 0, 0.1, WOOD); box(c, 0.12, -0.26, 0.24, 0.44, 0.04, '#9aa7b0'); poly(c, [0.14, 0.16, 0.34, 0.16, 0.3, 0.34, 0.18, 0.34], '#7d8992'); c.restore(); },
  bell(c) {
    for (const m of [-1, 1]) for (const r of [0.5, 0.62]) { c.beginPath(); c.arc(0, -0.02, r, m > 0 ? -0.75 : PI - 0.25, m > 0 ? 0.25 : PI + 0.75); pen(c, '#fff8ea', 0.05); }
    bellShape(c, GOLD);
  },
  allclear(c) {
    bellShape(c, '#b9c4cb');
    pen(c, OUTLINE, 0.2, [-0.12, 0.16, 0.08, 0.36, 0.46, -0.1]); pen(c, '#57d657', 0.12, [-0.12, 0.16, 0.08, 0.36, 0.46, -0.1]);
  },
  drop(c) {
    poly(c, [-0.1, -0.5, 0.1, -0.5, 0.1, -0.24, 0.24, -0.24, 0, 0.02, -0.24, -0.24, -0.1, -0.24], '#57d657');
    poly(c, [-0.42, 0.06, 0.42, 0.06, 0.32, 0.46, -0.32, 0.46], '#cf9f58'); for (const y of [0.2, 0.33]) pen(c, '#a5743a', LW * 1.3, [-0.38, y, 0.38, y]); box(c, -0.45, 0.02, 0.9, 0.09, 0.04, '#b98443');
  },
  ping(c, col) { ell(c, 0, 0, 0.47, 0.47, col || '#f0b41c'); ell(c, 0, 0, 0.36, 0.36, '#2a1d17', 0, LW * 0.8); box(c, -0.07, -0.26, 0.14, 0.32, 0.05, '#fff8ea'); ell(c, 0, 0.2, 0.075, 0.075, '#fff8ea'); },
  st_aggressive(c) { star(c, 0, 0, 0.5, '#e8452f'); c.save(); c.rotate(-PI / 4); scaled(c, 0, 0, 0.9, () => knife(c)); c.restore(); },
  st_defensive(c) {
    c.beginPath(); c.moveTo(-0.4, -0.42); c.lineTo(0.4, -0.42); c.lineTo(0.4, 0.02); c.bezierCurveTo(0.4, 0.3, 0.14, 0.44, 0, 0.5); c.bezierCurveTo(-0.14, 0.44, -0.4, 0.3, -0.4, 0.02); c.closePath(); ink(c, '#4a8fe0');
    pen(c, '#fff8ea', 0.07, [0, -0.3, 0, 0.34]); pen(c, '#fff8ea', 0.07, [-0.26, -0.06, 0.26, -0.06]);
  },
  st_passive(c) { limb(c, -0.3, 0.48, -0.3, -0.46, 0.07, WOOD_D); c.beginPath(); c.moveTo(-0.26, -0.44); c.bezierCurveTo(-0.02, -0.56, 0.16, -0.3, 0.46, -0.4); c.lineTo(0.46, 0.0); c.bezierCurveTo(0.16, 0.1, -0.02, -0.16, -0.26, -0.04); c.closePath(); ink(c, '#fbf5e6'); },
  endturn(c) {                                         // a turning arrow
    c.beginPath(); c.arc(0, 0.04, 0.34, -PI * 0.3, PI * 1.25); pen(c, OUTLINE, 0.2); pen(c, '#57d657', 0.12);
    poly(c, [0.06, -0.5, 0.46, -0.34, 0.14, -0.1], '#57d657');
  },
  done(c) { ell(c, 0, 0, 0.46, 0.46, '#3f9a52'); pen(c, OUTLINE, 0.2, [-0.22, 0.02, -0.06, 0.2, 0.24, -0.18]); pen(c, '#fff8ea', 0.11, [-0.22, 0.02, -0.06, 0.2, 0.24, -0.18]); },
  back(c) {                                            // back to the main card: a curled arrow
    c.beginPath(); c.arc(0.06, 0.06, 0.3, -PI * 0.9, PI * 0.55); pen(c, OUTLINE, 0.2); c.beginPath(); c.arc(0.06, 0.06, 0.3, -PI * 0.9, PI * 0.55); pen(c, '#fff8ea', 0.11);
    poly(c, [-0.46, -0.2, -0.12, -0.32, -0.3, 0.02], '#fff8ea');
  },
  next(c, col) {                                       // "the next one": a unit dot and a double chevron
    ell(c, -0.26, 0.02, 0.2, 0.2, col || '#e2403a');
    for (const x of [0.02, 0.26]) { pen(c, OUTLINE, 0.17, [x, -0.3, x + 0.22, 0, x, 0.3]); pen(c, '#fff8ea', 0.09, [x, -0.3, x + 0.22, 0, x, 0.3]); }
  },
  energy(c) { box(c, -0.42, -0.2, 0.84, 0.4, 0.08, '#e8a23a'); box(c, -0.42, -0.2, 0.26, 0.4, 0.08, '#c97a1c'); box(c, 0.16, -0.2, 0.26, 0.4, 0.08, '#c97a1c'); for (const x of [-0.08, 0.0, 0.08]) dot(c, x, -0.02, 0.035, '#fff3c4'); },
  follow(c, col) { box(c, -0.42, -0.22, 0.84, 0.52, 0.08, '#3a2c28'); box(c, -0.34, -0.14, 0.68, 0.36, 0.05, '#9fd4ee', LW * 0.8); ell(c, 0, 0.04, 0.12, 0.12, col || '#e2403a'); poly(c, [-0.12, -0.46, 0.12, -0.46, 0.06, -0.22, -0.06, -0.22], '#3a2c28'); },
  flag(c, col) { limb(c, -0.3, 0.5, -0.3, -0.5, 0.06, WOOD_D); poly(c, [-0.27, -0.5, 0.46, -0.3, -0.27, -0.08], col || '#e2403a'); dot(c, -0.3, -0.52, 0.05, GOLD); },
  lock(c) { c.beginPath(); c.arc(0, -0.08, 0.2, PI, 0); pen(c, OUTLINE, 0.17); pen(c, STEEL, 0.09); box(c, -0.3, -0.08, 0.6, 0.46, 0.07, '#8fa0ad'); ell(c, 0, 0.1, 0.06, 0.06, '#3a2c28'); pen(c, '#3a2c28', 0.05, [0, 0.12, 0, 0.26]); },
  f_free(c, col) { formDots(c, col, [[-0.3, -0.22], [0.06, -0.34], [0.34, -0.08], [-0.1, 0.02], [-0.36, 0.26], [0.2, 0.3], [0.0, 0.4]]); },
  f_line(c, col) { formDots(c, col, [[-0.4, -0.14], [-0.2, -0.14], [0, -0.14], [0.2, -0.14], [0.4, -0.14], [-0.3, 0.16], [-0.1, 0.16], [0.1, 0.16], [0.3, 0.16]], true); },
  f_box(c, col) { const p = []; for (const y of [-0.26, 0, 0.26]) for (const x of [-0.26, 0, 0.26]) p.push([x, y]); formDots(c, col, p, true); },
  f_wedge(c, col) { formDots(c, col, [[0, -0.36], [-0.17, -0.16], [0.17, -0.16], [-0.34, 0.04], [0.34, 0.04], [-0.5, 0.24], [0.5, 0.24]], true); },
  f_spread(c, col) { formDots(c, col, [[-0.4, -0.36], [0, -0.36], [0.4, -0.36], [-0.4, 0.02], [0, 0.02], [0.4, 0.02], [-0.4, 0.4], [0, 0.4], [0.4, 0.4]], false, 0.06); },
});
function bellShape(c, col) {
  box(c, -0.05, -0.5, 0.1, 0.1, 0.03, dk(col, 0.3));
  c.beginPath(); c.moveTo(-0.38, 0.24); c.bezierCurveTo(-0.2, 0.08, -0.3, -0.42, 0, -0.42); c.bezierCurveTo(0.3, -0.42, 0.2, 0.08, 0.38, 0.24); c.closePath(); ink(c, col);
  box(c, -0.42, 0.2, 0.84, 0.1, 0.05, dk(col, 0.14)); ell(c, 0, 0.38, 0.09, 0.09, dk(col, 0.32)); glint(c, -0.13, -0.12, 0.05, 0.17, 0.55, 0.25);
}
/** Little formation diagram: dots for units; `front` puts an arrow above to show which way it faces. */
function formDots(c, col, pts, front, r = 0.085) {
  if (front) poly(c, [0, -0.56, 0.1, -0.44, -0.1, -0.44], '#fff8ea', LW * 0.8);
  pts.forEach(([x, y], i) => ell(c, x, y + 0.06, r, r, i === 0 && front ? '#fff8ea' : col || '#e2403a', 0, LW * 0.9));
}
const ABIL_BG = dict({ service: '#c8452e', mangia: '#3f9a52', lowslow: '#6b5b52', cuts: '#3f4a78', sugar: '#c95a94', lunch: '#d98a1c',
  flambe: '#8f2318', feast: '#2c7a55', lockdown: '#3d4852', perfectcut: '#262f5c', glass: '#8a4a14', swarm: '#a8650f',
  brace: '#7a4a3a', lastcall: '#8f2a2a', dash: '#2d4a52', storm: '#1f3a44', chill: '#2b6a9a', freeze: '#1d4f80', snipe: '#8a3a2a', flood: '#9a2e22', rush: '#b86a12', bark: '#5a3b24' });
const CMD_BG = dict({ flint: '#d9532b', nonna: '#4f9a5a', hank: '#8a5a3c', ryo: '#46507a', odile: '#d77aa6', zara: '#e0a020', dolly: '#a0462f', kofi: '#2f5d66', ingrid: '#4f8fc4', rafa: '#b5452c' });

const icons = new Map();
function fitBake(draw, box, target, opt) {             // bake twice: measure, then at the scale that fits `target` px
  const sp = bake(32, box, draw, opt);
  return bake(Math.max(5, Math.min(220, 32 * target / Math.max(sp.w, sp.h, 1))), box, draw, opt);
}
function platePath(c, size, inset) { c.beginPath(); rr(c, inset, inset, size - inset * 2, size - inset * 2, size * 0.17 - inset * 0.5); }
/**
 * Icon for the HTML HUD: a cached size x size canvas (do not draw into it).
 * kind: 'unit' | 'building' | 'tech' | 'res' | 'ability' | 'commander' | 'ui'. Units, buildings, techs, abilities and
 * commanders come on a rounded plate; 'res' and 'ui' are bare glyphs on a transparent background.
 * `color` = team colour for units/buildings/commanders (commanders default to a signature colour) and the flag/cap of ui 'rally'/'idle'.
 */
export function icon(kind, key, size, color) {
  size = Math.max(8, Math.round(size) || 32);
  const id = String(kind) + '|' + String(key) + '|' + size + '|' + (typeof color === 'string' ? color : '');
  let cv = icons.get(id);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d'), col = safeColor(color), UB = [0.75, 0.75, 0.75, 0.75];
  let sp = null, bg = null, cx = size / 2, cy = size / 2;
  if (kind === 'unit') { bg = ['#ecdcb4', '#fbf1d6']; sp = fitBake((g) => unitArt(g, key, col, 'idle', 0, ''), UBOX, size * 0.86); }
  else if (kind === 'building') { const N = bSize(key); bg = ['#b9dc98', '#d9efbe']; sp = fitBake((g) => bArt(g, key, col), [0.5, 1.2, N + 0.6, N + 0.5], size * 0.92); }
  else if (kind === 'tech') {
    const m = /^([a-z]+?)(\d*)$/i.exec(String(key)) || [0, '_', ''], fam = TECH_ART[m[1]] ? m[1] : '_', tier = +m[2] || 0;
    bg = ['#3d4763', '#56648c'];
    sp = fitBake((g) => { TECH_ART[fam](g, tier); if (fam !== 'age') for (let i = 0; i < tier; i++) { ell(g, -0.42 + i * 0.17, 0.5, 0.065, 0.065, GOLD); } }, UB, size * 0.8);
  } else if (kind === 'ability') { bg = [ABIL_BG[key] || '#666', lt(ABIL_BG[key] || '#666', 0.3)]; sp = fitBake((g) => (ABIL_ART[key] || TECH_ART._)(g), UB, size * 0.8); }
  else if (kind === 'commander') {
    const C = CMD[key], hk = C ? C.hero : key, hs = SPEC[hk] || SPEC._none, K = (hs.k || 1) * HERO_K, base = color ? col : CMD_BG[key] || '#8a8a8a';
    const s = Math.min(220, size / K * 1.02);
    bg = [dk(base, 0.5), dk(base, 0.22)];
    sp = bake(s, UBOX, (g) => unitArt(g, C || SPEC[key] ? hk : '_none', base, 'idle', 0, ''));
    cx = size * 0.47 - 0.03 * K * s - sp.ox + sp.w / 2; cy = size * 0.5 + 0.63 * K * s - sp.oy + sp.h / 2;         // centre the head and shoulders
  } else if (kind === 'res') sp = fitBake((g) => (RES_ART[key] || TECH_ART._)(g), UB, size * 0.96);
  else sp = fitBake((g) => (UI_ART[key] || TECH_ART._)(g, color), UB, size * 0.94);
  if (bg) {
    platePath(c, size, 0.5); c.fillStyle = bg[0]; c.fill();
    c.save(); c.clip(); c.fillStyle = bg[1]; c.beginPath(); c.ellipse(size / 2, size * 1.02, size * 0.7, size * 0.62, 0, 0, TAU); c.fill();
  }
  c.drawImage(sp.cv, Math.round(cx - sp.w / 2), Math.round(cy - sp.h / 2));
  if (bg) { c.restore(); platePath(c, size, Math.max(1, size * 0.02)); c.strokeStyle = dk(bg[0], 0.4); c.lineWidth = Math.max(1.5, size * 0.04); c.stroke(); }
  if (icons.size > 800) icons.clear();
  icons.set(id, cv);
  return cv;
}

/**
 * How many milliseconds of sprite baking are allowed per frame (default 6) before stand-ins are used.
 * Pass Infinity to always bake immediately (e.g. behind a loading screen), 0 to bake as little as possible.
 */
export function setBakeBudget(ms) { bakeMs = ms >= 0 ? +ms : 6; }

/** Cache statistics, handy for debugging / the stress test. */
export function spriteStats() { return { sprites: cache.size, megapixels: +(cachePx / 1e6).toFixed(2), icons: icons.size }; }

/** Optional warm-up: creates the scratch canvases and pre-bakes the trees for a common zoom. Safe to call repeatedly. */
export function initSprites(scale = 32) {
  if (typeof document === 'undefined') return;
  for (let v = 0, bi = bucketIdx(scale); v < TREE_VARIANTS; v++) if (!cache.has(K_TREE + v * 32 + bi)) store(K_TREE + v * 32 + bi, bake(BUCKETS[bi], TREE_BOX, (c) => treeArt(c, v)));
}
