// ============================================================================
//  Client-side game state: a mirror of what the server streams to us, plus
//  purely local things (selection, camera, fog of war, visual effects).
// ============================================================================
import { UNITS, BUILDINGS, NODES, computeStats } from '/game/data.js';

export const K_UNIT = 0, K_BLDG = 1, K_NODE = 2;

export const G = {
  phase: 'join',            // join | lobby | game
  net: null,
  cid: 0, hostId: 0, name: '',
  lobby: null,

  // --- match (filled by the 'start' message)
  me: -1, players: [], ps: [], opts: {},
  w: 0, h: 0, tiles: null, occ: null, Q: 32, tickRate: 20,
  ents: new Map(), units: [], bldgs: [], nodes: [], listsDirty: true,
  ghosts: new Map(),        // enemy stations last seen in the fog
  tick: 0, snapAt: 0, snapDt: 50, startedAt: 0,
  paused: false, over: null,

  // --- local
  sel: new Set(), groups: {},
  cam: { x: 0, y: 0, scale: 40 },
  mode: null,               // { type:'place', b } | { type:'amove' } | null
  mouse: { x: 0, y: 0, wx: 0, wy: 0, inside: false },
  fogVis: null, fogExp: null, fogDirty: true,
  fx: [], projs: [], marks: [], pings: [],
  lastAlert: null,
  hooks: { event: () => {}, removed: () => {} },
};

export const isSpectator = () => G.me < 0 || !G.ps[G.me] || !G.ps[G.me].alive;
export const myTeam = () => (G.me >= 0 ? G.players[G.me].team : -99);
export const isAlly = (owner) => owner >= 0 && G.me >= 0 && G.players[owner].team === G.players[G.me].team;
export const maxHp = (e) => {
  if (e.kind === K_NODE) return 1;
  const st = G.ps[e.owner] && G.ps[e.owner].stats;
  const S = st && (e.kind === K_UNIT ? st.units[e.type] : st.bldgs[e.type]);
  return S ? S.hp : 1;
};
export const statsOf = (e) => {
  const st = G.ps[e.owner] && G.ps[e.owner].stats;
  return st ? (e.kind === K_UNIT ? st.units[e.type] : st.bldgs[e.type]) : null;
};

// ---------------------------------------------------------------- match setup
export function beginMatch(m) {
  G.me = m.you; G.players = m.players; G.opts = m.opts || {};
  G.w = m.w; G.h = m.h; G.Q = m.q || 32; G.tickRate = m.tickRate || 20;
  const N = G.w * G.h;
  G.tiles = new Uint8Array(N);
  for (let i = 0; i < N; i++) G.tiles[i] = m.tiles.charCodeAt(i) - 48;
  G.occ = new Int32Array(N);
  G.ents.clear(); G.ghosts.clear(); G.listsDirty = true;
  G.ps = m.players.map((p) => ({
    res: { food: 0, wood: 0, spice: 0, salt: 0 }, pop: 0, cap: 0, age: 1, techs: [], alive: true,
    heroId: 0, heroRespawn: 0, abilityReady: 0, lunchUntil: 0, pending: [], kills: 0, lost: 0, razed: 0,
    stats: computeStats(p.commander, 1, []), sig: '',
  }));
  G.tick = m.tick || 0; G.snapAt = 0; G.snapDt = 1000 / G.tickRate / (Number(G.opts.speed) || 1);
  G.paused = !!m.paused; G.over = null;
  if (!m.resync) {
    G.sel.clear(); G.groups = {}; G.mode = null;
    G.fx = []; G.projs = []; G.marks = []; G.pings = [];
    G.fogVis = new Uint8Array(N); G.fogExp = new Uint8Array(N);
    if (G.opts.fog === 'explored' || G.opts.fog === 'off' || G.me < 0) G.fogExp.fill(1);
    const home = G.me >= 0 ? m.players[G.me].home : { x: G.w / 2, y: G.h / 2 };
    G.cam.x = home.x; G.cam.y = home.y;
    G.startedAt = performance.now();
  }
  G.fogDirty = true;
}

// ----------------------------------------------------------------- snapshots
function setOcc(e, v) {
  for (let y = e.ty; y < e.ty + e.size; y++) for (let x = e.tx; x < e.tx + e.size; x++) {
    const i = y * G.w + x;
    if (v || G.occ[i] === e.id) G.occ[i] = v;
  }
}

function upsert(r, now) {
  const id = r[0], kind = r[1], Q = G.Q;
  let e = G.ents.get(id);
  if (kind === K_UNIT) {
    const x = r[4] / Q, y = r[5] / Q;
    if (!e) {
      e = { id, kind, type: r[2], owner: r[3], x, y, px: x, py: y, rx: x, ry: y, t0: now, hp: r[6], st: r[7], tgt: r[8], carry: r[9], bm: r[10], face: 1, hitAt: 0, r: (UNITS[r[2]] || {}).radius || 0.32 };
      G.ents.set(id, e); G.listsDirty = true;
      return;
    }
    if (x !== e.x || y !== e.y) movePos(e, x, y, now);
    if (r[6] < e.hp) e.hitAt = now;
    e.hp = r[6]; e.st = r[7]; e.tgt = r[8]; e.carry = r[9]; e.bm = r[10];
  } else if (kind === K_BLDG) {
    if (!e) {
      const size = (BUILDINGS[r[2]] || { size: 2 }).size;
      e = { id, kind, type: r[2], owner: r[3], tx: r[4], ty: r[5], size, x: r[4] + size / 2, y: r[5] + size / 2, rx: 0, ry: 0, hp: r[6], prog: r[7], qpct: r[8], q: r[9], rally: r[10], hitAt: 0, seen: false, gprog: r[7], born: now };
      e.rx = e.x; e.ry = e.y;
      G.ents.set(id, e); G.listsDirty = true;
      setOcc(e, id);
      G.ghosts.delete(id);
      if (r[7] < 100 && G.tick > 5) G.hooks.event(['placed', id]);
      return;
    }
    if (r[6] < e.hp) e.hitAt = now;
    e.hp = r[6]; e.prog = r[7]; e.qpct = r[8]; e.q = r[9]; e.rally = r[10];
  } else {
    if (!e) {
      e = { id, kind, type: r[2], owner: -1, tx: r[4], ty: r[5], size: 1, x: r[4] + 0.5, y: r[5] + 0.5, rx: r[4] + 0.5, ry: r[5] + 0.5, amount: r[6], max: (NODES[r[2]] || { amount: 1 }).amount };
      G.ents.set(id, e); G.listsDirty = true;
      setOcc(e, id);
      return;
    }
    e.amount = r[6];
  }
}

function movePos(e, x, y, now) {
  e.px = e.rx; e.py = e.ry;
  if (x > e.x + 0.004) e.face = 1; else if (x < e.x - 0.004) e.face = -1;
  e.x = x; e.y = y; e.t0 = now;
}

function remove(id) {
  const e = G.ents.get(id);
  if (!e) return;
  G.ents.delete(id); G.listsDirty = true;
  G.sel.delete(id);
  if (e.kind !== K_UNIT) setOcc(e, 0);
  if (e.kind === K_BLDG && e.seen && !isAlly(e.owner) && !tileVisible(e.x, e.y)) {
    G.ghosts.set(id, { id, type: e.type, owner: e.owner, tx: e.tx, ty: e.ty, size: e.size, x: e.x, y: e.y, prog: e.gprog });
  }
  G.hooks.removed(e);
}

function updatePlayer(r) {
  const p = G.ps[r[0]];
  if (!p) return;
  p.res.food = r[1]; p.res.wood = r[2]; p.res.spice = r[3]; p.res.salt = r[4];
  p.pop = r[5]; p.cap = r[6];
  const sig = r[7] + '|' + r[8].join(',');
  if (sig !== p.sig) { p.sig = sig; p.age = r[7]; p.techs = r[8]; p.stats = computeStats(G.players[r[0]].commander, p.age, p.techs); }
  p.alive = !!r[9]; p.heroId = r[10]; p.heroRespawn = r[11]; p.abilityReady = r[12]; p.lunchUntil = r[13];
  p.pending = r[14]; p.kills = r[15]; p.lost = r[16]; p.razed = r[17];
}

export function applySnapshot(m) {
  const now = performance.now();
  if (m.full) {
    for (const e of G.ents.values()) if (e.kind !== K_UNIT) setOcc(e, 0);
    G.ents.clear(); G.listsDirty = true;
  } else if (G.snapAt) {
    const dt = Math.max(15, Math.min(250, now - G.snapAt));
    G.snapDt = G.snapDt * 0.9 + dt * 0.1;
  }
  G.snapAt = now;
  G.tick = m.k;
  if (m.p) for (const r of m.p) updatePlayer(r);
  if (m.e) for (const r of m.e) upsert(r, now);
  if (m.m) {
    const mv = m.m, Q = G.Q;
    for (let i = 0; i < mv.length; i += 3) {
      const e = G.ents.get(mv[i]);
      if (e) movePos(e, mv[i + 1] / Q, mv[i + 2] / Q, now);
    }
  }
  if (m.tc) for (let i = 0; i < m.tc.length; i += 2) G.tiles[m.tc[i]] = m.tc[i + 1];
  if (m.r) for (const id of m.r) remove(id);
  if (m.ev) for (const ev of m.ev) G.hooks.event(ev);
}

/** Rebuild the per-kind lists and advance position interpolation. Call once per frame. */
export function frameUpdate(now) {
  if (G.listsDirty) {
    G.units = []; G.bldgs = []; G.nodes = [];
    for (const e of G.ents.values()) (e.kind === K_UNIT ? G.units : e.kind === K_BLDG ? G.bldgs : G.nodes).push(e);
    G.listsDirty = false;
  }
  const dur = Math.max(40, G.snapDt * 1.25);
  for (const e of G.units) {
    const a = (now - e.t0) / dur;
    if (a >= 1) { e.rx = e.x; e.ry = e.y; }
    else { e.rx = e.px + (e.x - e.px) * a; e.ry = e.py + (e.y - e.py) * a; }
  }
}

// --------------------------------------------------------------- fog of war
export function tileVisible(x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= G.w || y >= G.h) return false;
  return G.fogVis[y * G.w + x] === 1;
}
export function tileExplored(x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= G.w || y >= G.h) return false;
  return G.fogExp[y * G.w + x] === 1;
}

export function updateFog() {
  const w = G.w, h = G.h, vis = G.fogVis, exp = G.fogExp;
  G.fogDirty = true;
  if (G.opts.fog === 'off' || isSpectator()) { vis.fill(1); exp.fill(1); markSeen(); return; }
  vis.fill(0);
  const team = myTeam();
  for (const e of G.ents.values()) {
    if (e.kind === K_NODE || G.players[e.owner].team !== team) continue;
    let r, cx, cy;
    if (e.kind === K_UNIT) { r = (UNITS[e.type] || { sight: 5 }).sight; cx = e.rx; cy = e.ry; }
    else { r = e.prog < 100 ? 2.5 : (BUILDINGS[e.type] || { sight: 4 }).sight + e.size / 2; cx = e.x; cy = e.y; }
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.floor(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.floor(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy, row = y * w;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) { vis[row + x] = 1; exp[row + x] = 1; }
      }
    }
  }
  markSeen();
}

function markSeen() {
  for (const e of G.bldgs) {
    if (isAlly(e.owner)) { e.seen = true; continue; }
    let v = false;
    for (let y = e.ty; y < e.ty + e.size && !v; y++) for (let x = e.tx; x < e.tx + e.size; x++) if (G.fogVis[y * G.w + x]) { v = true; break; }
    e.vis = v;
    if (v) { e.seen = true; e.gprog = e.prog; }
  }
  for (const [id, g] of G.ghosts) {
    let v = false;
    for (let y = g.ty; y < g.ty + g.size && !v; y++) for (let x = g.tx; x < g.tx + g.size; x++) if (G.fogVis[y * G.w + x]) { v = true; break; }
    if (v) G.ghosts.delete(id);
  }
}

/** Should this entity be drawn / clickable right now? */
export function canSee(e) {
  if (e.kind === K_UNIT) return isAlly(e.owner) || G.fogVis[(e.ry | 0) * G.w + (e.rx | 0)] === 1;
  if (e.kind === K_BLDG) return isAlly(e.owner) || e.seen;
  return G.fogExp[e.ty * G.w + e.tx] === 1;
}

// ---------------------------------------------------------------- selection
export function selected() {
  const out = [];
  for (const id of G.sel) { const e = G.ents.get(id); if (e) out.push(e); else G.sel.delete(id); }
  return out;
}
export function setSelection(list) {
  G.sel.clear();
  for (const e of list) G.sel.add(e.id);
}
export const send = (o) => { if (G.net) G.net.send(o); };
export const cmd = (o) => { if (G.me >= 0 && !G.over) send({ t: 'c', ...o }); };
