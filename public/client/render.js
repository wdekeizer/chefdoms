// ============================================================================
//  Canvas renderer: terrain, fog of war, everything on the map, the minimap.
// ============================================================================
import { G, K_UNIT, K_BLDG, canSee, isAlly, maxHp, statsOf, updateFog, isSpectator } from './state.js';
import * as SPR from './sprites.js';
import { BUILDINGS, RES, TILE, PLAYER_COLORS, AURA_RADIUS, COMMANDERS, BUFFS } from '/game/data.js';

export const ZOOMS = [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96];   // device px per tile (sprite cache buckets)
const ANIMS = ['idle', 'walk', 'attack', 'gather', 'build', 'heal'];
const CHUNK = 16, BASE = 32;

let canvas, ctx, W = 0, H = 0, dpr = 1;
let fogCv = null, fogCtx = null, fogImg = null, lastFog = 0;
let mmCv = null, mmCtx = null, mmBase = null, mmBaseCtx = null, mmTiles = -1, lastMini = 0;
const chunks = new Map();
let ox = 0, oy = 0;          // screen px of world (0,0)

export const view = { get W() { return W; }, get H() { return H; }, get dpr() { return dpr; } };

export function initRender(cv, minimap) {
  canvas = cv; ctx = cv.getContext('2d');
  mmCv = minimap; mmCtx = minimap.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  SPR.initSprites(G.cam.scale);
}

export function resize() {
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  W = Math.floor(window.innerWidth * dpr); H = Math.floor(window.innerHeight * dpr);
  canvas.width = W; canvas.height = H;
  canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
  const r = mmCv.getBoundingClientRect();
  const s = Math.max(64, Math.round((r.width || 200) * dpr));
  if (mmCv.width !== s) { mmCv.width = s; mmCv.height = s; }
}

export function defaultZoom() {
  const want = 40 * dpr;
  return ZOOMS.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

export function resetWorld() {
  chunks.clear();
  fogCv = document.createElement('canvas'); fogCv.width = G.w; fogCv.height = G.h;
  fogCtx = fogCv.getContext('2d'); fogImg = fogCtx.createImageData(G.w, G.h);
  mmBase = document.createElement('canvas'); mmBase.width = G.w; mmBase.height = G.h;
  mmBaseCtx = mmBase.getContext('2d'); mmTiles = -1;
  lastFog = 0;
}

export const screenToWorld = (sx, sy) => [(sx * dpr - ox) / G.cam.scale, (sy * dpr - oy) / G.cam.scale];
export const worldToScreen = (wx, wy) => [(ox + wx * G.cam.scale) / dpr, (oy + wy * G.cam.scale) / dpr];

/** Keep the camera inside the map (with a little slack so the HUD never hides the edge rows). */
export function clampCamera() {
  const s = G.cam.scale, hw = W / 2 / s, hh = H / 2 / s;
  const mx = 3, top = 2 + 50 * dpr / s, bottom = 2 + 200 * dpr / s;
  const minX = Math.min(G.w / 2, hw - mx), maxX = Math.max(G.w / 2, G.w - hw + mx);
  const minY = Math.min(G.h / 2, hh - top), maxY = Math.max(G.h / 2, G.h - hh + bottom);
  G.cam.x = Math.max(minX, Math.min(maxX, G.cam.x));
  G.cam.y = Math.max(minY, Math.min(maxY, G.cam.y));
}

export function zoomBy(dir, sx, sy) {
  const i = ZOOMS.indexOf(G.cam.scale);
  const ni = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 5 : i) + dir));
  if (ZOOMS[ni] === G.cam.scale) return;
  const [wx, wy] = screenToWorld(sx, sy);
  G.cam.scale = ZOOMS[ni];
  // keep the point under the cursor fixed
  G.cam.x = wx - (sx * dpr - W / 2) / G.cam.scale;
  G.cam.y = wy - (sy * dpr - H / 2) / G.cam.scale;
  clampCamera();
}

// ------------------------------------------------------------------ terrain
function chunkCanvas(cx, cy, budget) {
  const key = cy * 1024 + cx;
  let c = chunks.get(key);
  if (c) return c;
  if (budget.n <= 0) return null;
  budget.n--;
  c = document.createElement('canvas');
  c.width = c.height = CHUNK * BASE;
  const g = c.getContext('2d');
  const getTile = (tx, ty) => (tx < 0 || ty < 0 || tx >= G.w || ty >= G.h ? undefined : G.tiles[ty * G.w + tx]);
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) {
    const tx = cx * CHUNK + x, ty = cy * CHUNK + y;
    if (tx >= G.w || ty >= G.h) continue;
    SPR.paintGround(g, G.tiles[ty * G.w + tx], tx, ty, x * BASE, y * BASE, BASE, getTile);
  }
  chunks.set(key, c);
  return c;
}

function drawTerrain(x0, y0, x1, y1) {
  const s = G.cam.scale, budget = { n: 2 };
  const cx0 = Math.floor(x0 / CHUNK), cy0 = Math.floor(y0 / CHUNK), cx1 = Math.floor(x1 / CHUNK), cy1 = Math.floor(y1 / CHUNK);
  ctx.imageSmoothingEnabled = true;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const px = ox + cx * CHUNK * s, py = oy + cy * CHUNK * s, size = CHUNK * s;
    const c = chunkCanvas(cx, cy, budget);
    if (c) ctx.drawImage(c, px, py, size, size);
    else { ctx.fillStyle = '#7cc254'; ctx.fillRect(px, py, size, size); }
  }
}

// ---------------------------------------------------------------------- fog
function drawFog(now) {
  if (now - lastFog > 180 || G.fogDirty && now - lastFog > 60) {
    updateFog();
    lastFog = now;
    const d = fogImg.data, vis = G.fogVis, exp = G.fogExp, n = G.w * G.h;
    for (let i = 0, j = 3; i < n; i++, j += 4) d[j] = exp[i] ? (vis[i] ? 0 : 105) : 255;
    fogCtx.putImageData(fogImg, 0, 0);
    G.fogDirty = false;
  }
  if (G.opts.fog === 'off' || isSpectator()) return;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fogCv, ox, oy, G.w * G.cam.scale, G.h * G.cam.scale);
}

// ------------------------------------------------------------------ helpers
const colorOf = (owner) => (owner >= 0 && G.players[owner] ? PLAYER_COLORS[G.players[owner].color % PLAYER_COLORS.length].hex : '#999999');

function hpBar(x, y, w, frac, thick) {
  const h = Math.max(3, Math.round(thick));
  x = Math.round(x - w / 2); y = Math.round(y);
  ctx.fillStyle = 'rgba(20,12,10,0.85)';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = frac > 0.6 ? '#57d657' : frac > 0.3 ? '#f2c230' : '#ef4a3c';
  ctx.fillRect(x, y, Math.max(1, Math.round(w * Math.max(0, Math.min(1, frac)))), h);
}

function ring(x, y, rx, ry, color, lw) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
  ctx.lineWidth = Math.max(1, lw * 0.6); ctx.strokeStyle = color; ctx.stroke();
}

const selColor = (e) => (e.owner === G.me ? '#8dff6a' : isAlly(e.owner) ? '#ffe45c' : e.owner < 0 ? '#ffffff' : '#ff5a4d');

// --------------------------------------------------------------------- main
export function render(now) {
  const s = G.cam.scale, t = now / 1000;
  clampCamera();
  ox = Math.round(W / 2 - G.cam.x * s); oy = Math.round(H / 2 - G.cam.y * s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1411';
  ctx.fillRect(0, 0, W, H);

  const x0 = Math.max(0, Math.floor(-ox / s)), y0 = Math.max(0, Math.floor(-oy / s));
  const x1 = Math.min(G.w - 1, Math.floor((W - ox) / s)), y1 = Math.min(G.h - 1, Math.floor((H - oy) / s) + 1);
  if (x1 < x0 || y1 < y0) return;
  drawTerrain(x0, y0, x1, y1);

  const sel = G.sel, lw = Math.max(2, s / 14);

  // ---- flat things first: garden plots, rally lines, hero aura, range circles
  for (const b of G.bldgs) {
    if (b.type !== 'garden' || !canSee(b)) continue;
    if (b.tx > x1 + 1 || b.ty > y1 + 1 || b.tx + b.size < x0 - 1 || b.ty + b.size < y0 - 1) continue;
    const vis = isAlly(b.owner) || b.vis;
    SPR.drawBuilding(ctx, b.type, colorOf(b.owner), ox + b.tx * s, oy + b.ty * s, s, { progress: (vis ? b.prog : b.gprog) / 100, t, hpFrac: 1, ghost: false });
    if (sel.has(b.id)) { ctx.strokeStyle = selColor(b); ctx.lineWidth = lw; ctx.strokeRect(ox + b.tx * s + 1, oy + b.ty * s + 1, b.size * s - 2, b.size * s - 2); }
  }
  for (const id of sel) {
    const e = G.ents.get(id);
    if (!e) continue;
    if (e.kind === K_BLDG && e.owner === G.me && e.rally) {
      const rx = ox + (e.rally[0] / G.Q) * s, ry = oy + (e.rally[1] / G.Q) * s;
      ctx.setLineDash([s * 0.2, s * 0.15]); ctx.lineWidth = Math.max(1.5, s / 20); ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.moveTo(ox + e.x * s, oy + e.y * s); ctx.lineTo(rx, ry); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#3a2a20'; ctx.fillRect(rx - s * 0.03, ry - s * 0.7, s * 0.06, s * 0.7);
      ctx.fillStyle = colorOf(e.owner); ctx.beginPath(); ctx.moveTo(rx + s * 0.03, ry - s * 0.7); ctx.lineTo(rx + s * 0.45, ry - s * 0.55); ctx.lineTo(rx + s * 0.03, ry - s * 0.38); ctx.fill();
    }
    const S = statsOf(e);
    if (S && sel.size === 1 && S.range > 1 && e.owner === G.me) {
      const rr = (S.range + (e.kind === K_BLDG ? e.size / 2 : 0)) * s;
      ctx.beginPath(); ctx.arc(ox + e.rx * s, oy + e.ry * s, rr, 0, Math.PI * 2);
      ctx.setLineDash([s * 0.25, s * 0.2]); ctx.lineWidth = Math.max(1, s / 24); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke(); ctx.setLineDash([]);
    }
    if (e.kind === K_UNIT && e.type.startsWith('hero_') && e.owner === G.me) {
      ctx.beginPath(); ctx.arc(ox + e.rx * s, oy + e.ry * s, AURA_RADIUS * s, 0, Math.PI * 2);
      ctx.setLineDash([s * 0.12, s * 0.22]); ctx.lineWidth = Math.max(1, s / 22); ctx.strokeStyle = 'rgba(255,214,90,0.45)'; ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ---- bucket everything by map row so nearer things overlap farther ones
  const rows = y1 - y0 + 3;
  const buckets = new Array(rows);
  const put = (row, e) => {
    row = row - y0 + 1;
    if (row < 0) return; if (row >= rows) row = rows - 1;
    (buckets[row] || (buckets[row] = [])).push(e);
  };
  for (const e of G.nodes) if (e.tx >= x0 - 1 && e.tx <= x1 + 1 && e.ty >= y0 - 1 && e.ty <= y1 + 1 && canSee(e)) put(e.ty, e);
  for (const e of G.bldgs) {
    if (e.type === 'garden') continue;
    if (e.tx > x1 + 1 || e.ty > y1 + 2 || e.tx + e.size < x0 - 1 || e.ty + e.size < y0 - 1) continue;
    if (canSee(e)) put(e.ty + e.size - 1, e);
  }
  for (const g of G.ghosts.values()) {
    if (g.type === 'garden' || g.tx > x1 + 1 || g.ty > y1 + 2 || g.tx + g.size < x0 - 1 || g.ty + g.size < y0 - 1) continue;
    put(g.ty + g.size - 1, g);
  }
  for (const e of G.units) {
    if (e.rx < x0 - 2 || e.rx > x1 + 2 || e.ry < y0 - 2 || e.ry > y1 + 3) continue;
    if (canSee(e)) put(Math.floor(e.ry), e);
  }

  const bars = [];
  const tiles = G.tiles, exp = G.fogExp, w = G.w;
  for (let row = y0 - 1; row <= y1 + 1; row++) {
    // trees and stumps of this row
    if (row >= 0 && row < G.h) {
      const base = row * w, py = oy + row * s;
      for (let x = x0; x <= x1; x++) {
        const tl = tiles[base + x];
        if (tl !== TILE.TREE && tl !== TILE.STUMP) continue;
        if (!exp[base + x]) continue;
        if (tl === TILE.TREE) SPR.drawTree(ctx, ox + x * s, py, s, base + x);
        else SPR.drawStump(ctx, ox + x * s, py, s, base + x);
      }
    }
    const list = buckets[row - y0 + 1];
    if (!list) continue;
    list.sort((a, b) => (a.kind === K_UNIT ? a.ry : a.y) - (b.kind === K_UNIT ? b.ry : b.y) || a.id - b.id);
    for (const e of list) {
      if (e.kind === K_UNIT) {
        const sx = ox + e.rx * s, sy = oy + e.ry * s;
        const hero = e.type.startsWith('hero_');
        if (sel.has(e.id)) ring(sx, sy, e.r * s * 1.25, e.r * s * 0.75, selColor(e), lw);
        else if (e.id === G.hover) { ctx.globalAlpha = 0.55; ring(sx, sy, e.r * s * 1.25, e.r * s * 0.75, '#ffffff', lw * 0.7); ctx.globalAlpha = 1; }
        if (e.bm) {
          let col = null;
          for (const k in BUFFS) if (e.bm & BUFFS[k].bit && !k.startsWith('a_')) col = k === 'mangia' ? '#7dff8a' : k === 'lowslow' ? '#c9c9c9' : k === 'sugar' ? '#ff9ad5' : '#ffb347';
          if (col) { ctx.globalAlpha = 0.35 + 0.2 * Math.sin(t * 8 + e.id); ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(sx, sy, e.r * s * 1.1, e.r * s * 0.65, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
        }
        SPR.drawUnit(ctx, e.type, colorOf(e.owner), sx, sy, s, { face: e.face, anim: ANIMS[e.st] || 'idle', t: t + e.id * 0.37, carry: e.carry ? RES[e.carry - 1] : null });
        const mh = maxHp(e);
        if (sel.has(e.id) || e.hp < mh || hero) bars.push(sx, sy - (hero ? 1.45 : e.r > 0.45 ? 1.0 : 1.02) * s, (hero ? 1.0 : 0.62) * s, e.hp / mh, s / (hero ? 9 : 12));
        if (now - e.hitAt < 120) SPR.drawEffect(ctx, 'hit', sx, sy - 0.45 * s, s, (now - e.hitAt) / 120, '#fff');
      } else if (e.kind === K_BLDG) {
        const vis = isAlly(e.owner) || e.vis;
        const mh = maxHp(e);
        SPR.drawBuilding(ctx, e.type, colorOf(e.owner), ox + e.tx * s, oy + e.ty * s, s, { progress: (vis ? e.prog : e.gprog) / 100, t: t + e.id, hpFrac: vis && e.prog >= 100 ? e.hp / mh : 1, ghost: false });
        if (sel.has(e.id)) { ctx.strokeStyle = selColor(e); ctx.lineWidth = lw; ctx.strokeRect(ox + e.tx * s + 1, oy + e.ty * s + 1, e.size * s - 2, e.size * s - 2); }
        else if (e.id === G.hover) { ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = lw * 0.7; ctx.strokeRect(ox + e.tx * s + 1, oy + e.ty * s + 1, e.size * s - 2, e.size * s - 2); }
        if (vis && (sel.has(e.id) || e.hp < mh)) bars.push(ox + e.x * s, oy + (e.ty - 0.55) * s, e.size * s * 0.7, e.hp / mh, s / 10);
        if (vis && e.qpct > 0 && e.owner === G.me) { ctx.fillStyle = 'rgba(20,12,10,0.8)'; ctx.fillRect(ox + (e.tx + 0.15) * s, oy + (e.ty + e.size) * s - s * 0.2, (e.size - 0.3) * s, s * 0.1); ctx.fillStyle = '#6fd3ff'; ctx.fillRect(ox + (e.tx + 0.15) * s, oy + (e.ty + e.size) * s - s * 0.2, (e.size - 0.3) * s * e.qpct / 100, s * 0.1); }
      } else if (e.amount !== undefined) {
        SPR.drawNode(ctx, e.type, ox + e.tx * s, oy + e.ty * s, s, Math.max(0.05, e.amount / e.max), e.id);
        if (sel.has(e.id)) ring(ox + e.x * s, oy + (e.y + 0.25) * s, s * 0.55, s * 0.32, '#ffffff', lw);
      } else {
        SPR.drawBuilding(ctx, e.type, colorOf(e.owner), ox + e.tx * s, oy + e.ty * s, s, { progress: e.prog / 100, t: 0, hpFrac: 1, ghost: false });   // remembered in the fog
      }
    }
  }

  // ---- projectiles
  for (let i = G.projs.length - 1; i >= 0; i--) {
    const p = G.projs[i];
    const a = (now - p.t0) / p.dur;
    const tg = p.tid ? G.ents.get(p.tid) : null;
    if (tg && !p.fixed) { p.tx = tg.rx; p.ty = tg.ry - (tg.kind === K_UNIT ? 0.4 : 0); }
    if (a >= 1) {
      G.projs.splice(i, 1);
      if (G.hooks.impact) G.hooks.impact(p.kind, p.tx, p.ty);
      G.fx.push({ kind: p.kind === 'sauce' || p.kind === 'frosting' ? 'splat' : p.kind === 'meatball' || p.kind === 'macaron' ? 'boom' : 'hit', x: p.tx, y: p.ty, t0: now, dur: p.kind === 'meatball' ? 550 : 320, color: p.kind === 'frosting' ? '#ffc0e0' : '#d8342a', k: p.kind === 'meatball' ? 1.5 : 1 });
      continue;
    }
    const lob = p.kind === 'meatball' || p.kind === 'macaron' ? 0.3 : p.kind === 'sauce' || p.kind === 'plate' ? 0.12 : 0.03;
    const dist = Math.hypot(p.tx - p.x0, p.ty - p.y0);
    const wx = p.x0 + (p.tx - p.x0) * a, wy = p.y0 + (p.ty - p.y0) * a - Math.sin(a * Math.PI) * dist * lob;
    if (G.fogVis[(wy | 0) * w + (wx | 0)] !== 1 && !isSpectator()) continue;
    const ang = Math.atan2(p.ty - p.y0 - Math.cos(a * Math.PI) * Math.PI * dist * lob, p.tx - p.x0);
    SPR.drawProjectile(ctx, p.kind, ox + wx * s, oy + wy * s, s, ang, t);
  }

  // ---- one-shot effects
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    const a = (now - f.t0) / f.dur;
    if (a >= 1) { G.fx.splice(i, 1); continue; }
    if (a < 0) continue;
    SPR.drawEffect(ctx, f.kind, ox + f.x * s, oy + f.y * s, s * (f.k || 1), a, f.color);
  }

  // ---- health bars on top of everything
  for (let i = 0; i < bars.length; i += 5) hpBar(bars[i], bars[i + 1], bars[i + 2], bars[i + 3], bars[i + 4]);

  drawFog(now);

  // ---- command feedback, placement preview, drag box
  for (let i = G.marks.length - 1; i >= 0; i--) {
    const m = G.marks[i];
    const a = (now - m.t0) / 450;
    if (a >= 1) { G.marks.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - a;
    ring(ox + m.x * s, oy + m.y * s, s * (0.6 - 0.4 * a), s * (0.36 - 0.24 * a), m.color, lw);
    ctx.globalAlpha = 1;
  }
  const mode = G.mode;
  if (mode && mode.type === 'place' && G.mouse.inside) {
    const B = BUILDINGS[mode.b];
    const tx = Math.round(G.mouse.wx - B.size / 2), ty = Math.round(G.mouse.wy - B.size / 2);
    const ok = canPlaceLocal(mode.b, tx, ty);
    mode.tx = tx; mode.ty = ty; mode.ok = ok;
    SPR.drawBuilding(ctx, mode.b, colorOf(G.me), ox + tx * s, oy + ty * s, s, { progress: 1, t, hpFrac: 1, ghost: ok ? 'ok' : 'bad' });
    ctx.strokeStyle = ok ? 'rgba(140,255,120,0.9)' : 'rgba(255,90,80,0.9)'; ctx.lineWidth = lw;
    ctx.strokeRect(ox + tx * s, oy + ty * s, B.size * s, B.size * s);
  }
  if (G.drag) {
    const d = G.drag;
    ctx.fillStyle = 'rgba(140,255,120,0.12)'; ctx.strokeStyle = 'rgba(160,255,140,0.9)'; ctx.lineWidth = Math.max(1, dpr);
    const bx = Math.min(d.x0, d.x1) * dpr, by = Math.min(d.y0, d.y1) * dpr, bw = Math.abs(d.x1 - d.x0) * dpr, bh = Math.abs(d.y1 - d.y0) * dpr;
    ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
  }

  if (now - lastMini > 120) { lastMini = now; drawMinimap(now, x0, y0, x1, y1); }
}

/** Client-side placement check (the server re-checks): free, buildable, explored ground. */
export function canPlaceLocal(type, tx, ty) {
  const n = BUILDINGS[type].size;
  if (tx < 0 || ty < 0 || tx + n > G.w || ty + n > G.h) return false;
  for (let y = ty; y < ty + n; y++) for (let x = tx; x < tx + n; x++) {
    const i = y * G.w + x, tl = G.tiles[i];
    if ((tl !== TILE.GRASS && tl !== TILE.STUMP) || G.occ[i] || !G.fogExp[i]) return false;
  }
  return true;
}

// ------------------------------------------------------------------ minimap
const MM_COL = { 0: [108, 176, 74], 1: [46, 110, 52], 2: [70, 140, 210], 3: [120, 168, 78] };
function drawMinimap(now, x0, y0, x1, y1) {
  const n = G.w * G.h, S = mmCv.width, k = S / G.w;
  // terrain base (rebuilt only when a tree falls)
  let sum = 0;
  for (let i = 0; i < n; i += 7) sum += G.tiles[i];
  if (sum !== mmTiles) {
    mmTiles = sum;
    const img = mmBaseCtx.createImageData(G.w, G.h), d = img.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) { const c = MM_COL[G.tiles[i]] || MM_COL[0]; d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = 255; }
    mmBaseCtx.putImageData(img, 0, 0);
  }
  mmCtx.imageSmoothingEnabled = false;
  mmCtx.drawImage(mmBase, 0, 0, S, S);
  for (const e of G.nodes) {
    if (!canSee(e)) continue;
    mmCtx.fillStyle = e.type === 'veg' ? '#ff9a3c' : e.type === 'spice' ? '#e23a2e' : '#eef6ff';
    mmCtx.fillRect(e.tx * k, e.ty * k, Math.max(2, k), Math.max(2, k));
  }
  for (const g of G.ghosts.values()) { mmCtx.fillStyle = colorOf(g.owner); mmCtx.fillRect(g.tx * k, g.ty * k, g.size * k, g.size * k); }
  for (const e of G.bldgs) {
    if (!canSee(e)) continue;
    mmCtx.fillStyle = '#1b1411'; mmCtx.fillRect(e.tx * k - 1, e.ty * k - 1, e.size * k + 2, e.size * k + 2);
    mmCtx.fillStyle = colorOf(e.owner); mmCtx.fillRect(e.tx * k, e.ty * k, e.size * k, e.size * k);
  }
  const us = Math.max(2.5, k * 1.2);
  for (const e of G.units) {
    if (!canSee(e)) continue;
    mmCtx.fillStyle = colorOf(e.owner);
    const big = e.type.startsWith('hero_') ? us * 1.8 : us;
    mmCtx.fillRect(e.rx * k - big / 2, e.ry * k - big / 2, big, big);
  }
  if (!(G.opts.fog === 'off' || isSpectator()) && fogCv) { mmCtx.imageSmoothingEnabled = true; mmCtx.drawImage(fogCv, 0, 0, S, S); }
  for (let i = G.pings.length - 1; i >= 0; i--) {
    const p = G.pings[i], a = (now - p.t0) / 3000;
    if (a >= 1) { G.pings.splice(i, 1); continue; }
    const rr = (4 + ((now - p.t0) % 700) / 700 * 14) * (S / 200);
    mmCtx.strokeStyle = p.color || '#ff3b30'; mmCtx.lineWidth = 2 * (S / 200); mmCtx.globalAlpha = 1 - a * 0.6;
    mmCtx.beginPath(); mmCtx.arc(p.x * k, p.y * k, rr, 0, Math.PI * 2); mmCtx.stroke(); mmCtx.globalAlpha = 1;
  }
  const s = G.cam.scale;
  const vx0 = -ox / s, vy0 = -oy / s, vw = W / s, vh = H / s;
  mmCtx.strokeStyle = '#ffffff'; mmCtx.lineWidth = Math.max(1, S / 160);
  mmCtx.strokeRect(vx0 * k, vy0 * k, vw * k, vh * k);
}

export const commanderColor = (owner) => colorOf(owner);
export { colorOf };
export const heroOf = (pi) => { const p = G.ps[pi]; return p && p.heroId ? G.ents.get(p.heroId) : null; };
export const abilityOf = (pi) => COMMANDERS[G.players[pi].commander].ability;
