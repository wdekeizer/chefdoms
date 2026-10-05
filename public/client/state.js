// ============================================================================
//  Client-side game state: a mirror of what the server streams to us, plus
//  purely local things (selection, camera, fog of war, visual effects).
// ============================================================================
import { UNITS, BUILDINGS, NODES, COMMANDERS, CTF, computeStats, tbUnit, tbBldg, tbAdjust, ctfHeroStats } from '/game/data.js';

export const K_UNIT = 0, K_BLDG = 1, K_NODE = 2;
export const ST_INSIDE = 6;               // unit state: sheltering inside a station (hidden)

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
  tb: null,                 // turn-based match: { n: round, cur: whose turn, deadline: tick the turn ends (0 = no timer), time, limit }
  ctf: null,                // capture the flag: { capsToWin, timeLimit, ultUnlock, neutral, bases, flags, camps, caps, sudden, lvl }
  follow: false,            // camera follows your hero (capture the flag)

  // --- local
  sel: new Set(), groups: {},
  cam: { x: 0, y: 0, scale: 40 },
  mode: null,               // { type:'place', b } | { type:'amove' } | null
  mouse: { x: 0, y: 0, wx: 0, wy: 0, inside: false },
  fogVis: null, fogExp: null, fogDirty: true,
  fx: [], projs: [], marks: [], pings: [],
  teamPings: [],            // pings from team-mates, drawn on the map: { x, y, t0, color, name }
  hover: 0, hoverTree: -1,  // what the mouse is over: an entity id, or a tree's tile index
  formation: 0,             // index into FORMATIONS used for the army's move orders
  lastAlert: null,
  hooks: { event: () => {}, removed: () => {} },
};
try { G.formation = Math.max(0, Math.min(4, Number(localStorage.getItem('chefdoms.formation')) || 0)); } catch { /* private mode */ }

export const isSpectator = () => G.me < 0 || !G.ps[G.me] || !G.ps[G.me].alive;
/** My hero on the field (capture the flag), or null. */
export const myHero = () => { const p = G.me >= 0 ? G.ps[G.me] : null; return p && p.heroId ? G.ents.get(p.heroId) || null : null; };
export const myTeam = () => (G.me >= 0 ? G.players[G.me].team : -99);
export const isAlly = (owner) => owner >= 0 && G.me >= 0 && G.players[owner].team === G.players[G.me].team;
/** The camp a wild minion belongs to (capture the flag), or null. */
export const campOf = (e) => (G.ctf && e.kind === K_UNIT && e.owner === G.ctf.neutral && e.sn > 0 ? G.ctf.camps[e.sn - 1] || null : null);
export const maxHp = (e) => {
  if (e.kind === K_NODE) return 1;
  const st = G.ps[e.owner] && G.ps[e.owner].stats;
  const S = st && (e.kind === K_UNIT ? st.units[e.type] : st.bldgs[e.type]);
  if (!S) return 1;
  const camp = campOf(e);
  if (camp) { const def = CTF.camps[camp.type]; return Math.round(S.hp * (1 + CTF.minion.hp * camp.level) * ((def && def.hpMul) || 1)); }
  return G.tb && e.kind === K_BLDG ? tbBldg(S).hp : S.hp;      // stations are much smaller on the tactics grid
};
export const statsOf = (e) => {
  const st = G.ps[e.owner] && G.ps[e.owner].stats;
  return st ? (e.kind === K_UNIT ? st.units[e.type] : st.bldgs[e.type]) : null;
};

// ---------------------------------------------------------------- match setup
export function beginMatch(m) {
  G.me = m.you; G.players = m.players; G.opts = m.opts || {};
  G.tb = m.mode === 'turn' ? { n: 1, cur: 0, deadline: 0, team: -1, ended: 0, time: Number(G.opts.turnTime) || 0, limit: Number(G.opts.turnLimit) || 0, teams: G.opts.turnOrder === 'team' } : null;
  G.market = { food: 1, wood: 1, spice: 1, salt: 1 };
  G.ctf = m.mode === 'ctf' && m.ctf ? {
    ...m.ctf, caps: {}, sudden: false, lvl: 0,
    flags: m.ctf.flags.map((f) => ({ team: f.team, hx: f.x, hy: f.y, x: f.x, y: f.y, state: 0, carrier: 0, dropAt: 0 })),
    camps: m.ctf.camps.map((k, i) => ({ i, x: k.x, y: k.y, type: k.type, level: 0, nextAt: 0, alive: 0 })),
  } : null;
  G.w = m.w; G.h = m.h; G.Q = m.q || 32; G.tickRate = m.tickRate || 20;
  const N = G.w * G.h;
  G.tiles = new Uint8Array(N);
  for (let i = 0; i < N; i++) G.tiles[i] = m.tiles.charCodeAt(i) - 48;
  G.occ = new Int32Array(N);
  G.ents.clear(); G.ghosts.clear(); G.listsDirty = true;
  G.ps = m.players.map((p) => ({
    res: { food: 0, wood: 0, spice: 0, salt: 0 }, pop: 0, cap: 0, age: 1, techs: [], alive: true,
    heroId: 0, heroRespawn: 0, abilityReady: 0, lunchUntil: 0, pending: [], kills: 0, lost: 0, razed: 0, bell: false,
    ultReady: 0, lockUntil: 0, income: [0, 0, 0, 0], items: {}, caps: 0, deaths: 0, energyReady: 0, minions: 0, heroKills: 0, level: 1, xp: 0,
    stats: computeStats(p.commander, 1, []), sig: '',
  }));
  G.tick = m.tick || 0; G.snapAt = 0; G.snapDt = 1000 / G.tickRate / (Number(G.opts.speed) || 1);
  G.paused = !!m.paused; G.over = null; G.votes = null;
  if (!m.resync) {
    G.sel.clear(); G.groups = {}; G.mode = null;
    G.fx = []; G.projs = []; G.marks = []; G.pings = []; G.teamPings = []; G.lastAlert = null; G.lastAlertAt = 0; G.lastFightAt = 0;
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

function upsert(r, now, syncing) {
  const id = r[0], kind = r[1], Q = G.Q;
  let e = G.ents.get(id);
  if (kind === K_UNIT) {
    const x = r[4] / Q, y = r[5] / Q;
    if (!e) {
      e = { id, kind, type: r[2], owner: r[3], x, y, px: x, py: y, rx: x, ry: y, t0: now, hp: r[6], st: r[7], tgt: r[8], carry: r[9], bm: r[10], sn: r[11] || 0, face: 1, hitAt: 0, r: (UNITS[r[2]] || {}).radius || 0.32 };
      G.ents.set(id, e); G.listsDirty = true;
      if (!syncing && G.tick > 5) G.hooks.event(['spawned', id]);
      return;
    }
    if (r[7] === ST_INSIDE || e.st === ST_INSIDE) { e.x = x; e.y = y; e.px = e.rx = x; e.py = e.ry = y; e.t0 = now; }   // stepping in or out of a shelter: no sliding
    else if (x !== e.x || y !== e.y) movePos(e, x, y, now);
    if (r[6] < e.hp) e.hitAt = now;
    e.hp = r[6]; e.st = r[7]; e.tgt = r[8]; e.carry = r[9]; e.bm = r[10]; e.sn = r[11] || 0;
    if (e.st === ST_INSIDE) G.sel.delete(id);
  } else if (kind === K_BLDG) {
    if (!e) {
      const size = G.tb ? 1 : (BUILDINGS[r[2]] || { size: 2 }).size;           // on the tactics grid every station is one tile
      e = { id, kind, type: r[2], owner: r[3], tx: r[4], ty: r[5], size, x: r[4] + size / 2, y: r[5] + size / 2, rx: 0, ry: 0, hp: r[6], prog: r[7], qpct: r[8], q: r[9], rally: r[10], inside: r[11] || 0, hitAt: 0, seen: false, gprog: r[7], born: now };
      e.rx = e.x; e.ry = e.y; bldgFlags(e, r[12]);
      if (G.tb) tbStation(e, r);
      G.ents.set(id, e); G.listsDirty = true;
      setOcc(e, id);
      G.ghosts.delete(id);
      if (r[7] < 100 && G.tick > 5) G.hooks.event(['placed', id]);
      return;
    }
    if (r[6] < e.hp) e.hitAt = now;
    e.hp = r[6]; e.prog = r[7]; e.qpct = r[8]; e.q = r[9]; e.rally = r[10]; e.inside = r[11] || 0; bldgFlags(e, r[12]);
    if (G.tb) tbStation(e, r);
  } else {
    if (!e) {
      e = { id, kind, type: r[2], owner: -1, tx: r[4], ty: r[5], size: 1, x: r[4] + 0.5, y: r[5] + 0.5, rx: r[4] + 0.5, ry: r[5] + 0.5, amount: r[6], max: (NODES[r[2]] || { amount: 1 }).amount };
      G.ents.set(id, e); G.listsDirty = true;
      const on = G.ents.get(G.occ[e.ty * G.w + e.tx]);
      if (!(on && on.kind === K_BLDG)) setOcc(e, id);         // (turn-based) a Pantry may already stand on it
      return;
    }
    e.amount = r[6];
  }
}

/** Turn-based mode reuses three slots of the station record: turns left for the queue, turns left to build, what it pays. */
function tbStation(e, r) {
  e.qleft = r[8] || 0; e.qpct = 0;
  e.left = r[10] || 0; e.rally = null;
  e.pays = r[11] || 0; e.inside = 0;
  e.trally = r[12] || null;                 // [x, y]: the side its recruits walk out
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
  if (G.tb && e.kind === K_BLDG) {                           // the resource under a fallen Pantry is free again
    for (const n of G.ents.values()) if (n.kind === K_NODE && n.tx === e.tx && n.ty === e.ty) G.occ[n.ty * G.w + n.tx] = n.id;
  }
  if (e.kind === K_BLDG && e.seen && !isAlly(e.owner) && !tileVisible(e.x, e.y)) {
    G.ghosts.set(id, { id, type: e.type, owner: e.owner, tx: e.tx, ty: e.ty, size: e.size, x: e.x, y: e.y, prog: e.gprog });
  }
  G.hooks.removed(e);
}

/** A station's standing orders: the stance its recruits get, keep them inside, a barred gate; and how many soldiers are inside. */
function bldgFlags(e, f) {
  f = f | 0;
  e.bsn = f & 3; e.keep = !!(f & 4); e.locked = !!(f & 8); e.mil = f >> 4;
}

function updatePlayer(r) {
  const p = G.ps[r[0]];
  if (!p) return;
  p.res.food = r[1]; p.res.wood = r[2]; p.res.spice = r[3]; p.res.salt = r[4];
  p.pop = r[5]; p.cap = r[6];
  const sig = r[7] + '|' + r[8].join(',');
  const items = G.ctf && r[21] ? r[21].join('') + ':' + (r[27] || 1) : '';
  if (sig + items !== p.sig) {
    p.sig = sig + items; p.age = r[7]; p.techs = r[8]; p.stats = computeStats(G.players[r[0]].commander, p.age, p.techs);
    if (G.tb) tbAdjust(p.stats, G.players[r[0]].commander);                // the grid's own tweaks, as on the server
    if (G.ctf && r[21]) {                                      // capture the flag: the hero wears what it bought, at its level
      const cmdKey = G.players[r[0]].commander, C = COMMANDERS[cmdKey], keys = Object.keys(CTF.items);
      p.items = {}; keys.forEach((k, i) => { p.items[k] = r[21][i] | 0; });
      if (C) p.stats.units[C.hero] = ctfHeroStats(p.stats.units[C.hero], p.items, cmdKey, r[27] || 1);
    }
  }
  p.alive = !!r[9]; p.heroId = r[10]; p.heroRespawn = r[11]; p.abilityReady = r[12]; p.lunchUntil = r[13];
  p.pending = r[14]; p.kills = r[15]; p.lost = r[16]; p.razed = r[17]; p.bell = !!r[18];
  p.ultReady = r[19] || 0; p.lockUntil = r[20] || 0; p.score = r[29] || 0;
  if (G.ctf) { p.caps = r[22] || 0; p.deaths = r[23] || 0; p.energyReady = r[24] || 0; p.minions = r[25] || 0; p.heroKills = r[26] || 0; p.level = r[27] || 1; p.xp = r[28] || 0; p.campBuffs = r[30] || [0, 0]; }
  else if (r[21]) p.income = r[21];
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
  if (m.tb && G.tb) { G.tb.n = m.tb[0]; G.tb.cur = m.tb[1]; G.tb.deadline = m.tb[2]; G.tb.team = m.tb[3] ?? -1; G.tb.ended = m.tb[4] || 0; }
  if (m.mk) { G.market = { food: m.mk[0] / 1000, wood: m.mk[1] / 1000, spice: m.mk[2] / 1000, salt: m.mk[3] / 1000 }; G.marketAt = performance.now(); }
  if (G.ctf) {
    if (m.ctf) { G.ctf.caps = m.ctf.caps || {}; G.ctf.sudden = !!m.ctf.sudden; G.ctf.lvl = m.ctf.lvl || 0; }
    if (m.flags) for (const r of m.flags) { const f = G.ctf.flags.find((x) => x.team === r[0]); if (!f) continue; f.state = r[1]; f.carrier = r[4]; f.dropAt = r[5]; if (r[1] !== 1) { f.x = r[2] / G.Q; f.y = r[3] / G.Q; } }
    if (m.camps) for (const r of m.camps) { const k = G.ctf.camps[r[0]]; if (k) { k.level = r[1]; k.nextAt = r[2]; k.alive = r[3]; } }
  }
  if (G.tb && (m.e || m.m || m.r || m.tb || m.p)) G.tbDirty = true;
  if (m.e) for (const r of m.e) upsert(r, now, !!m.full);
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
    const st = G.ps[e.owner].stats;                       // upgrades can extend sight
    if (e.kind === K_UNIT) { if (e.st === ST_INSIDE) continue; const S = st.units[e.type] || UNITS[e.type] || { sight: 5, speed: 1, range: 0 }; r = G.tb ? tbUnit(S).sight + 0.5 : S.sight; cx = e.rx; cy = e.ry; }
    else if (G.tb) { r = e.prog < 100 ? 1.5 : tbBldg(st.bldgs[e.type] || BUILDINGS[e.type]).sight + 0.5; cx = e.x; cy = e.y; }
    else { r = e.prog < 100 ? 2.5 : (st.bldgs[e.type] || BUILDINGS[e.type] || { sight: 4 }).sight + e.size / 2; cx = e.x; cy = e.y; }
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
  if (e.kind === K_UNIT) return e.st !== ST_INSIDE && (isAlly(e.owner) || G.fogVis[(e.ry | 0) * G.w + (e.rx | 0)] === 1);
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
