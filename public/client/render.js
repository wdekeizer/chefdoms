// ============================================================================
//  Canvas renderer: terrain, fog of war, everything on the map, the minimap.
// ============================================================================
import { G, K_UNIT, K_BLDG, canSee, isAlly, maxHp, statsOf, updateFog, isSpectator, campOf } from './state.js';
import * as SPR from './sprites.js';
import { BUILDINGS, RES, TILE, PLAYER_COLORS, AURA_RADIUS, COMMANDERS, BUFFS, NODES, RES_INFO, TB, CTF, NEUTRAL_COLOR } from '/game/data.js';
import { T as TAC, flagsOf, F_DONE, myTurn, nodeIncome } from './tactics.js';

export const ZOOMS = [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96];   // device px per tile (sprite cache buckets)
const ANIMS = ['idle', 'walk', 'attack', 'gather', 'build', 'heal'];
const CHUNK = 16, BASE = 32;
const MAX_CHUNKS = 72;                 // painted terrain pieces kept in memory (about 1 MB each); the least recently seen go first

let canvas, ctx, W = 0, H = 0, dpr = 1;
let fogCv = null, fogCtx = null, fogImg = null, lastFog = 0;
let mmCv = null, mmCtx = null, mmBase = null, mmBaseCtx = null, mmTiles = -1, lastMini = 0;
const chunks = new Map();
let frameNo = 0;
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
  const want = (G.tb ? 60 : 40) * dpr;              // the tactics grid is small: look at it from closer
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
  if (c) { c.used = frameNo; return c; }
  if (budget.n <= 0) return null;
  budget.n--;
  c = document.createElement('canvas');
  c.used = frameNo;
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
  const s = G.cam.scale, budget = { n: 3 };
  const cx0 = Math.floor(x0 / CHUNK), cy0 = Math.floor(y0 / CHUNK), cx1 = Math.floor(x1 / CHUNK), cy1 = Math.floor(y1 / CHUNK);
  ctx.imageSmoothingEnabled = true;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const px = ox + cx * CHUNK * s, py = oy + cy * CHUNK * s, size = CHUNK * s;
    const c = chunkCanvas(cx, cy, budget);
    if (c) ctx.drawImage(c, px, py, size, size);
    else { ctx.fillStyle = '#7cc254'; ctx.fillRect(px, py, size, size); }
  }
  // Paint the terrain just outside the view ahead of time (first in the direction the camera is moving),
  // so scrolling never has to wait for it.
  if (budget.n > 0) {
    const mx = Math.ceil(G.w / CHUNK) - 1, my = Math.ceil(G.h / CHUNK) - 1;
    const vx = G.cam.vx || 0, vy = G.cam.vy || 0;
    const ring = [];
    for (let cy = cy0 - 1; cy <= cy1 + 1; cy++) for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) {
      if (cx < 0 || cy < 0 || cx > mx || cy > my) continue;
      if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) continue;
      const c = chunks.get(cy * 1024 + cx);
      if (c) { c.used = frameNo; continue; }
      const ahead = (vx > 0 && cx > cx1) || (vx < 0 && cx < cx0) || (vy > 0 && cy > cy1) || (vy < 0 && cy < cy0);
      ring.push([ahead ? 0 : 1, cx, cy]);
    }
    ring.sort((a, b) => a[0] - b[0]);
    const one = { n: 1 };
    if (ring.length) chunkCanvas(ring[0][1], ring[0][2], one);
  }
  if (chunks.size > MAX_CHUNKS) {
    const old = [...chunks.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < old.length - MAX_CHUNKS + 8; i++) if (old[i][1].used < frameNo) chunks.delete(old[i][0]);
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
const colorOf = (owner) => (owner >= 0 && G.players[owner] ? (G.players[owner].neutral ? NEUTRAL_COLOR : PLAYER_COLORS[G.players[owner].color % PLAYER_COLORS.length].hex) : '#999999');
const teamColor = (team) => { const p = G.players.find((q) => q.team === team && !q.neutral); return p ? colorOf(G.players.indexOf(p)) : '#ffffff'; };
const BUFF_GLOW = { service: '#ffb347', mangia: '#7dff8a', lowslow: '#c9c9c9', sugar: '#ff9ad5', feast: '#fff0a8', stun: '#d98a1c', fry: '#ff9a3c', chill: '#9fe3ff', brace: '#d0d8e0', lastcall: '#ff5a4d', storm: '#f4f8fa', bark: '#b07a4a', energy: '#ffd27a' };

/** A flag on a pole, planted at (x,y) (its foot). `wave` animates the cloth. */
function drawFlag(x, y, s, color, wave, k = 1) {
  const H = s * 1.5 * k, W = s * 0.62 * k, lw = Math.max(1.5, s / 14);
  ctx.fillStyle = 'rgba(20,12,10,0.25)'; ctx.beginPath(); ctx.ellipse(x, y, s * 0.3 * k, s * 0.12 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineCap = 'round'; ctx.strokeStyle = '#3a2a20'; ctx.lineWidth = lw * 1.4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - H); ctx.stroke();
  const f1 = Math.sin(wave * 6) * 0.08, f2 = Math.sin(wave * 6 + 1.2) * 0.1;
  ctx.beginPath(); ctx.moveTo(x, y - H); ctx.quadraticCurveTo(x + W * 0.5, y - H - W * f1, x + W, y - H + W * (0.3 + f2)); ctx.quadraticCurveTo(x + W * 0.5, y - H + W * (0.55 + f1), x, y - H + W * 0.6); ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = lw * 0.8; ctx.strokeStyle = 'rgba(20,12,10,0.8)'; ctx.stroke();
  ctx.fillStyle = '#f0b41c'; ctx.beginPath(); ctx.arc(x, y - H, lw * 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.lineCap = 'butt';
}

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

/** Corner brackets around a rectangle: "this is what you are pointing at". */
function brackets(x, y, w, h, color, lw) {
  const k = Math.min(w, h) * 0.28;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + k); ctx.lineTo(x, y); ctx.lineTo(x + k, y);
    ctx.moveTo(x + w - k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + k);
    ctx.moveTo(x + w, y + h - k); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - k, y + h);
    ctx.moveTo(x + k, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - k);
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  path(); ctx.lineWidth = lw + 2 * dpr; ctx.strokeStyle = 'rgba(20,12,10,0.7)'; ctx.stroke();
  path(); ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
}

function label(text, x, y, size, color = '#fff8ea') {
  ctx.font = `800 ${Math.round(size)}px "Trebuchet MS", "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.lineWidth = Math.max(3, size / 4); ctx.strokeStyle = 'rgba(20,12,10,0.85)'; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.lineJoin = 'miter';
}

/** Two crossed blades that drop onto the spot of an attack order. `a` runs 0..1. */
function swordMark(x, y, s, a) {
  const k = s * (0.75 - 0.2 * Math.min(1, a * 3)), drop = (1 - Math.min(1, a * 4)) * s * 0.5;
  ctx.save();
  ctx.translate(x, y - drop - s * 0.25);
  ctx.globalAlpha = a < 0.6 ? 1 : Math.max(0, 1 - (a - 0.6) / 0.4);
  ctx.lineCap = 'round';
  for (const m of [-1, 1]) {
    ctx.save(); ctx.rotate(m * 0.78);
    for (const [col, w] of [['rgba(20,12,10,0.9)', 0.2], ['#f4f8fa', 0.1]]) {      // blade
      ctx.strokeStyle = col; ctx.lineWidth = k * w; ctx.beginPath(); ctx.moveTo(0, k * 0.3); ctx.lineTo(0, -k * 0.62); ctx.stroke();
    }
    for (const [col, w] of [['rgba(20,12,10,0.9)', 0.2], ['#e2403a', 0.1]]) {      // guard and grip
      ctx.strokeStyle = col; ctx.lineWidth = k * w; ctx.beginPath(); ctx.moveTo(-k * 0.17, k * 0.3); ctx.lineTo(k * 0.17, k * 0.3); ctx.moveTo(0, k * 0.3); ctx.lineTo(0, k * 0.52); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Where and how big to draw a station: on its real footprint, or (turn-based) squeezed onto its one tile. Returns [x, y, scale]. */
function stationBox(type, tx, ty, s) {
  if (!G.tb) return [ox + tx * s, oy + ty * s, s];
  const N = BUILDINGS[type] ? BUILDINGS[type].size : 2, wide = type === 'garden' ? 1 : 1 + 0.1 * (N - 1);
  return [ox + (tx + 0.5 - wide / 2) * s, oy + (ty + 1 - wide) * s, (s * wide) / N];
}
const drawStation = (type, owner, tx, ty, s, o) => { const b = stationBox(type, tx, ty, s); SPR.drawBuilding(ctx, type, colorOf(owner), b[0], b[1], b[2], o); };
const FOOT = 0.3;            // turn-based: units stand lower on their tile, so the sprite sits inside it

function tileFill(i, s, fill, stroke, inset = 0.06) {
  const x = ox + ((i % G.w) + inset) * s, y = oy + (((i / G.w) | 0) + inset) * s, k = (1 - inset * 2) * s;
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, k, k); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1, s / 28); ctx.strokeRect(x + 0.5, y + 0.5, k - 1, k - 1); }
}

/** Turn-based: the grid, where the selected unit can go, whom it can hit, and the route under the pointer. Drawn on the ground. */
function drawTacticsGround(now, x0, y0, x1, y1, s) {
  const w = G.w, t = now / 1000;
  ctx.strokeStyle = 'rgba(30,50,20,0.13)'; ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(ox + x * s + 0.5, oy + y0 * s); ctx.lineTo(ox + x * s + 0.5, oy + (y1 + 1) * s); }
  for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(ox + x0 * s, oy + y * s + 0.5); ctx.lineTo(ox + (x1 + 1) * s, oy + y * s + 0.5); }
  ctx.stroke();
  const P = TAC.plan, hov = TAC.hov, pulse = 0.5 + 0.5 * Math.sin(t * 5);
  if (P) {
    const placing = G.mode && G.mode.type === 'tplace' ? G.mode : null;
    if (placing) {
      if (placing.b === 'pantry') for (const n of P.nodes.values()) tileFill(n.ent.ty * w + n.ent.tx, s, `rgba(255,228,92,${0.28 + 0.14 * pulse})`, 'rgba(255,240,150,0.95)');
      else for (const i of P.sites.keys()) tileFill(i, s, `rgba(120,255,140,${0.2 + 0.1 * pulse})`, 'rgba(150,255,160,0.8)');
    } else {
      for (const i of P.stops) tileFill(i, s, 'rgba(70,150,255,0.30)', 'rgba(150,205,255,0.75)');
      for (const n of P.targets.values()) { const [tx, ty] = n.ent.kind === K_UNIT ? [Math.floor(n.ent.x), Math.floor(n.ent.y)] : [n.ent.tx, n.ent.ty]; tileFill(ty * w + tx, s, `rgba(255,70,55,${0.3 + 0.18 * pulse})`, 'rgba(255,130,115,0.95)'); }
      for (const n of P.heals.values()) tileFill(Math.floor(n.ent.y) * w + Math.floor(n.ent.x), s, 'rgba(110,255,140,0.28)', 'rgba(150,255,170,0.9)');
      for (const n of P.repairs.values()) tileFill(n.ent.ty * w + n.ent.tx, s, 'rgba(110,255,140,0.22)', 'rgba(150,255,170,0.85)');
      for (const n of P.nodes.values()) tileFill(n.ent.ty * w + n.ent.tx, s, null, `rgba(255,228,92,${0.55 + 0.3 * pulse})`, 0.03);
    }
    tileFill(P.start, s, null, 'rgba(255,255,255,0.85)', 0.03);
  }
  if (hov) {
    if (P && hov.stand >= 0 && hov.kind && hov.kind !== 'nosite') {          // the route the unit would take, and where it would stand
      const pts = [P.start, ...hov.path];
      if (pts.length > 1) {
        const path = () => { ctx.beginPath(); pts.forEach((i, k) => { const x = ox + ((i % w) + 0.5) * s, y = oy + (((i / w) | 0) + 0.5) * s; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); };
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        path(); ctx.lineWidth = s * 0.2; ctx.strokeStyle = 'rgba(20,12,10,0.55)'; ctx.stroke();
        path(); ctx.lineWidth = s * 0.11; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
        const e = pts[pts.length - 1];
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(20,12,10,0.7)'; ctx.lineWidth = Math.max(1, s / 24);
        ctx.beginPath(); ctx.arc(ox + ((e % w) + 0.5) * s, oy + (((e / w) | 0) + 0.5) * s, s * 0.16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    tileFill(hov.i, s, null, hov.kind === 'attack' ? '#ff5a4d' : hov.kind === 'nosite' ? 'rgba(255,90,80,0.9)' : 'rgba(255,255,255,0.9)', 0.02);
  }
}

/** Turn-based: the damage forecast and the little prompts next to the pointer. Drawn above everything. */
function drawTacticsTop(now, s) {
  const P = TAC.plan, hov = TAC.hov;
  if (!hov) return;
  const fs = Math.max(12 * dpr, s * 0.3), cx = ox + (hov.tx + 0.5) * s, top = oy + (hov.ty - 0.18) * s;
  const placing = G.mode && G.mode.type === 'tplace' ? G.mode : null;
  if (placing) {
    if (hov.kind === 'site') { const b = stationBox(placing.b, hov.tx, hov.ty, s); SPR.drawBuilding(ctx, placing.b, colorOf(G.me), b[0], b[1], b[2], { progress: 1, t: 0, hpFrac: 1, ghost: 'ok' }); }
    return;
  }
  if (P && hov.kind === 'attack' && hov.fc) {
    const f = hov.fc;
    label(f.kills ? `−${f.dmg}  KO!` : `−${f.dmg}`, cx, top, fs * 1.15, '#ff8a7a');
    const sx = hov.stand % G.w, sy = (hov.stand / G.w) | 0;
    if (f.counter > 0) label(`−${f.counter}`, ox + (sx + 0.5) * s, oy + (sy - 0.18) * s, fs, f.counter >= P.unit.hp ? '#ff5a4d' : '#ffd27a');
    else if (!f.kills && hov.ent && hov.ent.kind === K_UNIT) label('no counter', ox + (sx + 0.5) * s, oy + (sy - 0.18) * s, fs * 0.8, '#c9ffbf');
  } else if (P && hov.kind === 'heal') label('Right-click: top up', cx, top, fs * 0.85, '#c9ffbf');
  else if (P && hov.kind === 'repair') label(hov.ent.prog < 100 ? 'Right-click: help build' : 'Right-click: repair', cx, top, fs * 0.85, '#c9ffbf');
  else if (hov.ent && hov.ent.amount !== undefined && canSee(hov.ent)) {
    const N = NODES[hov.ent.type];
    if (N) label(`${N.name} · +${nodeIncome(hov.ent.type)} ${RES_INFO[N.res].name} a turn`, cx, top, fs * 0.85);
    if (P && hov.kind === 'pantry') label('Right-click: build a Pantry here', cx, top - fs, fs * 0.85, '#ffe45c');
  }
}

// --------------------------------------------------------------------- main
export function render(now) {
  const s = G.cam.scale, t = now / 1000;
  frameNo++;
  clampCamera();
  ox = Math.round(W / 2 - G.cam.x * s); oy = Math.round(H / 2 - G.cam.y * s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1411';
  ctx.fillRect(0, 0, W, H);

  const x0 = Math.max(0, Math.floor(-ox / s)), y0 = Math.max(0, Math.floor(-oy / s));
  const x1 = Math.min(G.w - 1, Math.floor((W - ox) / s)), y1 = Math.min(G.h - 1, Math.floor((H - oy) / s) + 1);
  if (x1 < x0 || y1 < y0) return;
  drawTerrain(x0, y0, x1, y1);
  const tac = !!G.tb, foot = tac ? FOOT : 0, ctf = G.ctf;
  if (tac) drawTacticsGround(now, x0, y0, x1, y1, s);
  if (ctf) {                                                   // kitchens heal, camps hold minions, flags sit on their stands
    for (const b of ctf.bases) {
      const col = teamColor(b.team), mine = G.me >= 0 && G.players[G.me].team === b.team;
      ctx.beginPath(); ctx.arc(ox + b.x * s, oy + b.y * s, CTF.fountain.radius * s, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.globalAlpha = mine ? 0.09 : 0.05; ctx.fill(); ctx.globalAlpha = 1;
      ctx.setLineDash([s * 0.3, s * 0.25]); ctx.lineWidth = Math.max(1, s / 20); ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    for (const k of ctf.camps) {
      if (k.x < x0 - 4 || k.x > x1 + 4 || k.y < y0 - 4 || k.y > y1 + 4 || !G.fogExp[(k.y | 0) * G.w + (k.x | 0)]) continue;
      const boss = k.type === 'critic';
      ctx.beginPath(); ctx.arc(ox + k.x * s, oy + k.y * s, (boss ? 3.2 : 2.4) * s, 0, Math.PI * 2);
      ctx.fillStyle = k.alive ? (boss ? 'rgba(120,40,30,0.16)' : 'rgba(60,40,30,0.12)') : 'rgba(255,255,255,0.08)'; ctx.fill();
      ctx.setLineDash([s * 0.18, s * 0.22]); ctx.lineWidth = Math.max(1, s / 26); ctx.strokeStyle = k.alive ? (boss ? 'rgba(255,120,90,0.7)' : 'rgba(255,240,200,0.5)') : 'rgba(255,255,255,0.3)'; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const f of ctf.flags) {                               // the stand
      ctx.beginPath(); ctx.ellipse(ox + f.hx * s, oy + f.hy * s, s * 0.7, s * 0.4, 0, 0, Math.PI * 2); ctx.fillStyle = '#d8c8a8'; ctx.fill(); ctx.lineWidth = Math.max(1, s / 20); ctx.strokeStyle = teamColor(f.team); ctx.stroke();
    }
  }

  const sel = G.sel, lw = Math.max(2, s / 14);

  // ---- flat things first: garden plots, rally lines, hero aura, range circles
  for (const b of G.bldgs) {
    if (b.type !== 'garden' || !canSee(b)) continue;
    if (b.tx > x1 + 1 || b.ty > y1 + 1 || b.tx + b.size < x0 - 1 || b.ty + b.size < y0 - 1) continue;
    const vis = isAlly(b.owner) || b.vis;
    drawStation(b.type, b.owner, b.tx, b.ty, s, { progress: (vis ? b.prog : b.gprog) / 100, t, hpFrac: 1, ghost: false });
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
    if (tac) {
      if (e.kind === K_UNIT && e.type.startsWith('hero_') && e.owner === G.me) {          // the aura reaches this far
        const R = TB.auraRange, hx = Math.floor(e.x), hy = Math.floor(e.y);
        ctx.setLineDash([s * 0.12, s * 0.22]); ctx.lineWidth = Math.max(1, s / 22); ctx.strokeStyle = 'rgba(255,214,90,0.6)';
        ctx.strokeRect(ox + (hx - R) * s, oy + (hy - R) * s, (R * 2 + 1) * s, (R * 2 + 1) * s); ctx.setLineDash([]);
      }
      continue;
    }
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
  for (const e of G.nodes) {
    if (e.tx < x0 - 1 || e.tx > x1 + 1 || e.ty < y0 - 1 || e.ty > y1 + 1 || !canSee(e)) continue;
    if (tac) { const on = G.ents.get(G.occ[e.ty * G.w + e.tx]); if (on && on !== e && canSee(on)) continue; }      // a Pantry stands on it
    put(e.ty, e);
  }
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
  if (ctf) for (const f of ctf.flags) { if (f.state === 1) continue; const vis = G.fogExp[(f.y | 0) * G.w + (f.x | 0)]; if (vis && f.x > x0 - 2 && f.x < x1 + 2 && f.y > y0 - 2 && f.y < y1 + 3) put(Math.floor(f.y), { flag: f, y: f.y, id: -f.team }); }

  const bars = [], badges = [], stationBadges = [];
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
      if (e.flag) {                                              // a flag on its stand, or dropped on the ground
        const f = e.flag, col = teamColor(f.team);
        drawFlag(ox + f.x * s, oy + f.y * s, s, col, t + f.team, f.state === 2 ? 0.85 : 1);
        if (f.state === 2) {                                     // dropped: how long until it goes home
          const left = Math.max(0, CTF.flag.dropReturn - (G.tick - f.dropAt) / G.tickRate);
          ctx.beginPath(); ctx.arc(ox + f.x * s, oy + f.y * s, s * 0.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / CTF.flag.dropReturn)); ctx.lineWidth = Math.max(2, s / 12); ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1;
          label(Math.ceil(left) + 's', ox + f.x * s, oy + (f.y - 1.7) * s, Math.max(11 * dpr, s * 0.28));
        }
        continue;
      }
      if (e.kind === K_UNIT) {
        const sx = ox + e.rx * s, sy = oy + (e.ry + foot) * s;
        const hero = e.type.startsWith('hero_');
        const spent = tac && e.owner === G.tb.cur && (flagsOf(e) & F_DONE) && !G.over;        // has finished for this turn: drawn faded
        if (sel.has(e.id)) ring(sx, sy, e.r * s * 1.25, e.r * s * 0.75, selColor(e), lw);
        else if (e.id === G.hover) { ctx.globalAlpha = 0.55; ring(sx, sy, e.r * s * 1.25, e.r * s * 0.75, '#ffffff', lw * 0.7); ctx.globalAlpha = 1; }
        if (e.bm) {
          let col = null;
          for (const k in BUFF_GLOW) if (e.bm & BUFFS[k].bit) col = BUFF_GLOW[k];
          if (col) { ctx.globalAlpha = 0.35 + 0.2 * Math.sin(t * 8 + e.id); ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(sx, sy, e.r * s * 1.1, e.r * s * 0.65, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
        }
        if (spent) ctx.globalAlpha = 0.5;
        SPR.drawUnit(ctx, e.type, colorOf(e.owner), sx, sy, s, { face: e.face, anim: e.bm & 2048 ? 'idle' : ANIMS[e.st] || 'idle', t: e.bm & 2048 ? 0 : t + e.id * 0.37, carry: e.carry ? RES[e.carry - 1] : null });
        ctx.globalAlpha = 1;
        if (e.bm & 2048) {                             // stuck in caramel: an amber shell
          ctx.globalAlpha = 0.45; ctx.fillStyle = '#e8a23a'; ctx.beginPath(); ctx.ellipse(sx, sy - s * 0.42, e.r * s * 1.25, s * 0.62, 0, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.9; ctx.strokeStyle = '#fff3c4'; ctx.lineWidth = Math.max(1, s / 30); ctx.beginPath(); ctx.ellipse(sx, sy - s * 0.42, e.r * s * 1.25, s * 0.62, 0, 3.6, 4.9); ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (tac && e.owner === G.me && !spent && myTurn() && !sel.has(e.id)) {       // still has something to do this turn
          const bob = Math.sin(t * 5 + e.id) * s * 0.04, px = sx + e.r * s * 0.95, py = sy - s * (hero ? 1.25 : 0.95) + bob, k = Math.max(4, s * 0.1);
          ctx.beginPath(); ctx.arc(px, py, k, 0, Math.PI * 2); ctx.fillStyle = '#ffe45c'; ctx.fill(); ctx.lineWidth = Math.max(1, dpr); ctx.strokeStyle = 'rgba(20,12,10,0.9)'; ctx.stroke();
        }
        if (e.bm & BUFFS.storm.bit) {                  // Cleaver Storm: a ring of spinning blades
          ctx.save(); ctx.translate(sx, sy - s * 0.35); ctx.rotate(t * 9);
          for (let i = 0; i < 5; i++) { ctx.rotate(Math.PI * 2 / 5); ctx.fillStyle = '#e8eef1'; ctx.strokeStyle = 'rgba(20,12,10,0.8)'; ctx.lineWidth = Math.max(1, s / 30); ctx.beginPath(); ctx.moveTo(s * 1.1, -s * 0.12); ctx.lineTo(s * 2.1, -s * 0.05); ctx.lineTo(s * 2.1, s * 0.2); ctx.lineTo(s * 1.1, s * 0.12); ctx.closePath(); ctx.fill(); ctx.stroke(); }
          ctx.restore();
        }
        if (ctf) {
          const carried = ctf.flags.find((f) => f.state === 1 && f.carrier === e.id);
          if (carried) drawFlag(sx + e.r * s * 0.9, sy - s * (hero ? 1.2 : 0.9), s * 0.75, teamColor(carried.team), t + e.id);
          const camp = campOf(e);
          if (camp && CTF.camps[camp.type] && CTF.camps[camp.type].boss) { ctx.beginPath(); ctx.ellipse(sx, sy, e.r * s * 1.6, e.r * s * 0.9, 0, 0, Math.PI * 2); ctx.setLineDash([s * 0.15, s * 0.15]); ctx.lineWidth = Math.max(1.5, s / 14); ctx.strokeStyle = '#ff8a6a'; ctx.stroke(); ctx.setLineDash([]); }
        }
        const mh = maxHp(e);
        if (sel.has(e.id) || e.hp < mh || hero) bars.push(sx, sy - (hero ? 1.45 : e.r > 0.45 ? 1.0 : 1.02) * s, (hero ? 1.0 : 0.62) * s, e.hp / mh, s / (hero ? 9 : 12));
        if (e.sn && e.owner === G.me && !tac) {        // stance marker: a small shield (hold the line) or a white flag (stand down)
          const px = sx + e.r * s * 1.05, py = sy - s * 0.12, k = Math.max(4, s * 0.13);
          ctx.beginPath();
          if (e.sn === 1) { ctx.moveTo(px - k, py - k); ctx.lineTo(px + k, py - k); ctx.lineTo(px + k, py + k * 0.2); ctx.lineTo(px, py + k * 1.2); ctx.lineTo(px - k, py + k * 0.2); ctx.closePath(); ctx.fillStyle = '#6fb7ff'; }
          else { ctx.rect(px - k, py - k, k * 2, k * 1.5); ctx.fillStyle = '#f2ede2'; }
          ctx.fill(); ctx.lineWidth = Math.max(1, dpr); ctx.strokeStyle = 'rgba(20,12,10,0.9)'; ctx.stroke();
        }
        if (now - e.hitAt < 120) SPR.drawEffect(ctx, 'hit', sx, sy - 0.45 * s, s, (now - e.hitAt) / 120, '#fff');
      } else if (e.kind === K_BLDG) {
        const vis = isAlly(e.owner) || e.vis;
        const mh = maxHp(e);
        drawStation(e.type, e.owner, e.tx, e.ty, s, { progress: (vis ? e.prog : e.gprog) / 100, t: t + e.id, hpFrac: vis && e.prog >= 100 ? e.hp / mh : 1, ghost: false });
        if (G.ps[e.owner].lockUntil > (tac ? 0 : G.tick) && vis) {                         // Lockdown: steel shutters
          ctx.globalAlpha = 0.28 + 0.08 * Math.sin(t * 4); ctx.fillStyle = '#9fc4e8'; ctx.fillRect(ox + e.tx * s, oy + (e.ty - 0.2) * s, e.size * s, (e.size + 0.2) * s);
          ctx.globalAlpha = 0.9; ctx.strokeStyle = '#dff0ff'; ctx.lineWidth = lw * 0.6; ctx.strokeRect(ox + e.tx * s + 1, oy + (e.ty - 0.2) * s, e.size * s - 2, (e.size + 0.2) * s - 1); ctx.globalAlpha = 1;
        }
        if (tac && vis) stationBadges.push(e);
        if (sel.has(e.id)) { ctx.strokeStyle = selColor(e); ctx.lineWidth = lw; ctx.strokeRect(ox + e.tx * s + 1, oy + e.ty * s + 1, e.size * s - 2, e.size * s - 2); }
        else if (e.id === G.hover) { ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = lw * 0.7; ctx.strokeRect(ox + e.tx * s + 1, oy + e.ty * s + 1, e.size * s - 2, e.size * s - 2); }
        if (vis && (sel.has(e.id) || e.hp < mh) && !(ctf && e.type === 'hq')) bars.push(ox + e.x * s, oy + (e.ty - (tac ? 0.5 : 0.55)) * s, e.size * s * (tac ? 0.9 : 0.7), e.hp / mh, s / 10);
        if (e.inside > 0 && isAlly(e.owner)) badges.push(e);
        if (vis && e.qpct > 0 && e.owner === G.me) { ctx.fillStyle = 'rgba(20,12,10,0.8)'; ctx.fillRect(ox + (e.tx + 0.15) * s, oy + (e.ty + e.size) * s - s * 0.2, (e.size - 0.3) * s, s * 0.1); ctx.fillStyle = '#6fd3ff'; ctx.fillRect(ox + (e.tx + 0.15) * s, oy + (e.ty + e.size) * s - s * 0.2, (e.size - 0.3) * s * e.qpct / 100, s * 0.1); }
      } else if (e.amount !== undefined) {
        SPR.drawNode(ctx, e.type, ox + e.tx * s, oy + e.ty * s, s, Math.max(0.05, e.amount / e.max), e.id);
        if (e.type === 'fish' && G.fogVis[e.ty * w + e.tx]) {            // ripples spreading on the water
          for (const off of [0, 0.5]) {
            const ph = (t * 0.55 + e.id * 0.37 + off) % 1;
            ctx.globalAlpha = (1 - ph) * 0.55; ctx.strokeStyle = '#f2ffff'; ctx.lineWidth = Math.max(1, s / 30);
            ctx.beginPath(); ctx.ellipse(ox + e.x * s, oy + (e.y + 0.08) * s, s * (0.12 + 0.34 * ph), s * (0.06 + 0.17 * ph), 0, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        if (sel.has(e.id)) ring(ox + e.x * s, oy + (e.y + 0.25) * s, s * 0.55, s * 0.32, '#ffffff', lw);
      } else {
        drawStation(e.type, e.owner, e.tx, e.ty, s, { progress: e.prog / 100, t: 0, hpFrac: 1, ghost: false });   // remembered in the fog
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
    if (f.kind === 'atkmark' || f.kind === 'num') continue;    // drawn above the fog, further down
    SPR.drawEffect(ctx, f.kind, ox + f.x * s, oy + f.y * s, s * (f.k || 1), a, f.color);
  }

  // ---- health bars on top of everything
  for (let i = 0; i < bars.length; i += 5) hpBar(bars[i], bars[i + 1], bars[i + 2], bars[i + 3], bars[i + 4]);
  for (const e of badges) {                                    // "12 inside" on a sheltering Kitchen HQ
    const fs = Math.max(11 * dpr, s * 0.36), text = '\u{1F514} ' + e.inside;
    ctx.font = `800 ${Math.round(fs)}px "Trebuchet MS", "Segoe UI", sans-serif`;
    const tw = ctx.measureText(text).width + fs, bx = ox + e.x * s - tw / 2, by = oy + (e.ty - 1.25) * s;
    ctx.fillStyle = 'rgba(27,20,17,0.88)'; ctx.strokeStyle = '#f0b41c'; ctx.lineWidth = Math.max(1, dpr * 1.5);
    ctx.beginPath(); ctx.roundRect(bx, by, tw, fs * 1.5, fs * 0.75); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fbf1dc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, ox + e.x * s, by + fs * 0.8);
  }

  for (const e of stationBadges) {                             // turn-based: what a station pays, and how long it is busy
    const k = Math.max(14 * dpr, s * 0.34);
    if (e.pays && e.prog >= 100) ctx.drawImage(SPR.icon('res', RES[e.pays - 1], 48), ox + (e.tx + 0.02) * s, oy + (e.ty + 0.98) * s - k, k, k);
    if (!isAlly(e.owner)) continue;
    const left = e.prog < 100 ? e.left : e.q && e.q.length ? e.qleft : 0;
    if (!left) continue;
    const fs = Math.max(11 * dpr, s * 0.24), text = left + (left === 1 ? ' turn' : ' turns');
    ctx.font = `800 ${Math.round(fs)}px "Trebuchet MS", "Segoe UI", sans-serif`;
    const tw = ctx.measureText(text).width + fs * 0.8, bx = ox + (e.tx + 0.5) * s - tw / 2, by = oy + (e.ty + 1) * s - fs * 1.35;
    ctx.fillStyle = 'rgba(27,20,17,0.88)'; ctx.strokeStyle = e.prog < 100 ? '#f0b41c' : '#6fd3ff'; ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath(); ctx.roundRect(bx, by, tw, fs * 1.3, fs * 0.65); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fbf1dc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, ox + (e.tx + 0.5) * s, by + fs * 0.7);
  }

  drawFog(now);
  if (ctf) {
    for (const f of G.fx) {                                    // Sauce Flood: a wave rolling down its line
      if (f.kind !== 'flood') continue;
      const a = (now - f.t0) / f.dur;
      if (a < 0 || a >= 1) continue;
      ctx.save(); ctx.translate(ox + f.x * s, oy + f.y * s); ctx.rotate(f.ang);
      const head = f.len * Math.min(1, a * 1.6), W = f.width;
      ctx.globalAlpha = a > 0.6 ? (1 - a) / 0.4 : 0.85;
      ctx.fillStyle = '#d8342a'; ctx.beginPath(); ctx.roundRect(0, -W * s, head * s, W * 2 * s, W * s); ctx.fill();
      ctx.fillStyle = '#ff7a60'; for (let i = 0; i < 7; i++) { const px = head * s * (0.55 + 0.45 * ((i * 0.37 + a * 2) % 1)), py = Math.sin(i * 2.1 + a * 20) * W * s * 0.7; ctx.beginPath(); ctx.arc(px, py, s * 0.18, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore(); ctx.globalAlpha = 1;
    }
    for (const k of ctf.camps) {                               // who lives where, and when they are back
      if (k.x < x0 - 3 || k.x > x1 + 3 || k.y < y0 - 3 || k.y > y1 + 3 || !G.fogExp[(k.y | 0) * G.w + (k.x | 0)] || s < 20) continue;
      const def = CTF.camps[k.type], fs = Math.max(10 * dpr, s * 0.26);
      const text = k.alive ? `${def.name}${k.level ? ' · Lv ' + (k.level + 1) : ''}` : `${def.name} · back in ${Math.max(0, Math.ceil((k.nextAt - G.tick) / G.tickRate))}s`;
      ctx.globalAlpha = k.alive ? 0.85 : 0.55; label(text, ox + k.x * s, oy + (k.y - (k.type === 'critic' ? 3.1 : 2.3)) * s, fs, k.alive ? '#fff8ea' : '#d8c8a8'); ctx.globalAlpha = 1;
    }
  }
  if (tac) {
    drawTacticsTop(now, s);
    for (const f of G.fx) {                                    // damage and healing numbers float up from where they happened
      if (f.kind !== 'num') continue;
      const a = (now - f.t0) / f.dur;
      if (a < 0 || a >= 1) continue;
      ctx.globalAlpha = a > 0.7 ? (1 - a) / 0.3 : 1;
      label(f.text, ox + f.x * s, oy + (f.y - 0.55 - a * 0.7) * s, Math.max(13 * dpr, s * (f.big ? 0.42 : 0.34)), f.color);
      ctx.globalAlpha = 1;
    }
  }

  // ---- what the mouse is pointing at (resources get brackets and a name, so it is clear what a click will do)
  if (G.hoverTree >= 0) {
    const tx = G.hoverTree % w, ty = (G.hoverTree / w) | 0, pulse = 0.75 + 0.25 * Math.sin(t * 7);
    ctx.globalAlpha = pulse; brackets(ox + (tx - 0.08) * s, oy + (ty - 0.85) * s, s * 1.16, s * 1.9, '#ffe45c', lw); ctx.globalAlpha = 1;
    label(RES_INFO.wood.name, ox + (tx + 0.5) * s, oy + (ty - 0.95) * s, Math.max(11 * dpr, s * 0.3));
  } else if (G.hover && !tac) {
    const e = G.ents.get(G.hover);
    if (e && e.amount !== undefined && canSee(e)) {
      const N = NODES[e.type], gather = G.hoverKind === 'gather', pulse = 0.75 + 0.25 * Math.sin(t * 7);
      ctx.globalAlpha = gather ? pulse : 0.7; brackets(ox + (e.tx - 0.06) * s, oy + (e.ty - 0.12) * s, s * 1.12, s * 1.18, gather ? '#ffe45c' : '#ffffff', lw * (gather ? 1 : 0.7)); ctx.globalAlpha = 1;
      if (N) label(`${N.name} · ${e.amount}`, ox + (e.tx + 0.5) * s, oy + (e.ty - 0.22) * s, Math.max(11 * dpr, s * 0.3));
    }
  }

  // ---- attack orders and team pings (visible through the fog)
  for (const f of G.fx) if (f.kind === 'atkmark') { const a = (now - f.t0) / f.dur; if (a >= 0 && a < 1) swordMark(ox + f.x * s, oy + f.y * s, s, a); }
  for (let i = G.teamPings.length - 1; i >= 0; i--) {
    const p = G.teamPings[i], a = (now - p.t0) / 4500;
    if (a >= 1) { G.teamPings.splice(i, 1); continue; }
    const px = ox + p.x * s, py = oy + p.y * s, fade = a > 0.75 ? (1 - a) * 4 : 1;
    for (let k = 0; k < 3; k++) {
      const ph = ((now - p.t0) / 900 + k / 3) % 1;
      ctx.globalAlpha = (1 - ph) * fade; ctx.lineWidth = Math.max(2, s / 12); ctx.strokeStyle = p.color;
      ctx.beginPath(); ctx.ellipse(px, py, s * (0.3 + 1.5 * ph), s * (0.18 + 0.9 * ph), 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = fade;
    const bob = Math.abs(Math.sin((now - p.t0) / 180)) * s * 0.18, k = Math.max(14 * dpr, s * 0.5);
    ctx.fillStyle = 'rgba(20,12,10,0.9)'; ctx.beginPath(); ctx.moveTo(px, py - bob); ctx.lineTo(px - k * 0.42, py - k * 0.9 - bob); ctx.lineTo(px + k * 0.42, py - k * 0.9 - bob); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py - k * 1.25 - bob, k * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(px, py - k * 1.25 - bob, k * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(k * 0.8)}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', px, py - k * 1.22 - bob);
    if (p.name) label(p.name, px, py - k * 2 - bob, Math.max(11 * dpr, s * 0.28));
    ctx.globalAlpha = 1;
  }

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
    mmCtx.fillStyle = e.type === 'veg' ? '#ff9a3c' : e.type === 'spice' ? '#e23a2e' : e.type === 'fish' ? '#b8f1ff' : e.type === 'wood' ? '#a8713c' : '#eef6ff';
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
  if (G.ctf) {
    for (const c of G.ctf.camps) { mmCtx.fillStyle = c.alive ? '#f0b41c' : '#6b5a40'; mmCtx.fillRect(c.x * k - k, c.y * k - k, k * 2, k * 2); }
  }
  if (!(G.opts.fog === 'off' || isSpectator()) && fogCv) { mmCtx.imageSmoothingEnabled = true; mmCtx.drawImage(fogCv, 0, 0, S, S); }
  if (G.ctf) {
    for (const f of G.ctf.flags) {                             // flags show through the fog: everyone knows where they are
      const col = teamColor(f.team), px = f.x * k, py = f.y * k, r = Math.max(3.5, k * 1.6);
      mmCtx.fillStyle = '#1b1411'; mmCtx.beginPath(); mmCtx.moveTo(px, py - r * 1.6); mmCtx.lineTo(px + r * 1.4, py - r * 0.8); mmCtx.lineTo(px, py); mmCtx.closePath(); mmCtx.fill();
      mmCtx.fillStyle = col; mmCtx.beginPath(); mmCtx.moveTo(px, py - r * 1.45); mmCtx.lineTo(px + r * 1.05, py - r * 0.8); mmCtx.lineTo(px, py - r * 0.15); mmCtx.closePath(); mmCtx.fill();
      mmCtx.strokeStyle = f.state === 1 ? '#ffffff' : '#1b1411'; mmCtx.lineWidth = Math.max(1, S / 160); mmCtx.beginPath(); mmCtx.moveTo(px, py); mmCtx.lineTo(px, py - r * 1.7); mmCtx.stroke();
    }
  }
  for (let i = G.pings.length - 1; i >= 0; i--) {
    const p = G.pings[i], a = (now - p.t0) / (p.color ? 4500 : 3000);
    if (a >= 1) { G.pings.splice(i, 1); continue; }
    const rr = (4 + ((now - p.t0) % 700) / 700 * 14) * (S / 200);
    mmCtx.strokeStyle = '#1b1411'; mmCtx.lineWidth = 4 * (S / 200); mmCtx.globalAlpha = (1 - a * 0.6) * 0.7;
    mmCtx.beginPath(); mmCtx.arc(p.x * k, p.y * k, rr, 0, Math.PI * 2); mmCtx.stroke();
    mmCtx.strokeStyle = p.color || '#ff3b30'; mmCtx.lineWidth = 2 * (S / 200); mmCtx.globalAlpha = 1 - a * 0.6;
    mmCtx.beginPath(); mmCtx.arc(p.x * k, p.y * k, rr, 0, Math.PI * 2); mmCtx.stroke(); mmCtx.globalAlpha = 1;
  }
  const s = G.cam.scale;
  const vx0 = -ox / s, vy0 = -oy / s, vw = W / s, vh = H / s;
  mmCtx.strokeStyle = '#ffffff'; mmCtx.lineWidth = Math.max(1, S / 160);
  mmCtx.strokeRect(vx0 * k, vy0 * k, vw * k, vh * k);
}

export const commanderColor = (owner) => colorOf(owner);
export { colorOf, teamColor };
export const heroOf = (pi) => { const p = G.ps[pi]; return p && p.heroId ? G.ents.get(p.heroId) : null; };
export const abilityOf = (pi) => COMMANDERS[G.players[pi].commander].ability;
