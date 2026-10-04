// ============================================================================
//  Turn-based mode, browser side: what the selected unit can do this turn
//  (where it can walk, whom it can hit, what it can build or mend), what a
//  click means, and the damage forecast shown before you commit.
//
//  The rules themselves live on the server (game/tactics.js). Everything here
//  only mirrors them so the map can be highlighted; the server checks every
//  order again.
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, canSee, selected, setSelection, cmd, statsOf, maxHp } from './state.js';
import { TILE, TB, RES, COMMANDERS, tbUnit, tbReach, tbPath, tbDist, tbDamage } from '/game/data.js';

export const F_MOVED = 1, F_DONE = 2, F_STUN = 4, F_TEMP = 8, F_COUNTERED = 16;
export const flagsOf = (e) => (e.sn || 0) & 255;
export const mvLeft = (e) => (e.sn || 0) >> 8;
const ST_MOVE = 1;
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];

/** T.plan = what the selected unit can do; T.hov = what the pointer is offering right now. */
export const T = { plan: null, hov: null, sig: '', holdUntil: 0 };

/** Is it player pi's side that is playing now (their turn, or their team's)? */
export const playing = (pi) => !!G.tb && pi >= 0 && (G.tb.team >= 0 ? G.players[pi].team === G.tb.team : G.tb.cur === pi);
/** Has player pi pressed End turn while their team-mates are still playing? */
export const ended = (pi) => !!G.tb && G.tb.team >= 0 && !!(G.tb.ended & (1 << pi));
export const myTurn = () => !!G.tb && G.me >= 0 && !G.over && playing(G.me) && !ended(G.me) && !!G.ps[G.me] && G.ps[G.me].alive;
export const hostile = (a, b) => a >= 0 && b >= 0 && G.players[a].team !== G.players[b].team;
export const tileOf = (e) => (e.kind === K_UNIT ? [Math.floor(e.x), Math.floor(e.y)] : [e.tx, e.ty]);
/** Has this unit of mine still got something to do this turn? */
export const ready = (e) => e.kind === K_UNIT && e.owner === G.me && !(flagsOf(e) & F_DONE);
export function readyUnits() { return myTurn() ? G.units.filter(ready).sort((a, b) => a.id - b.id) : []; }
/** What a station on this kind of resource pays per turn, before upgrades. */
export const nodeIncome = (type) => TB.income[type] || 0;
export const paysName = (b) => (b.pays ? RES[b.pays - 1] : '');

// ------------------------------------------------------------------ the grid
function unitMap() {
  const m = new Map();
  for (const e of G.units) if (canSee(e)) m.set(Math.floor(e.y) * G.w + Math.floor(e.x), e);
  return m;
}

/** The unit standing on a tile, or the station / resource on it, or null. Tiles, not sprites: this is a grid game. */
export function pickTile(wx, wy) {
  const tx = Math.floor(wx), ty = Math.floor(wy);
  if (tx < 0 || ty < 0 || tx >= G.w || ty >= G.h) return null;
  for (const e of G.units) if (Math.floor(e.rx) === tx && Math.floor(e.ry) === ty && canSee(e)) return e;
  const e = G.ents.get(G.occ[ty * G.w + tx]);
  return e && canSee(e) ? e : null;
}

const inRange = (T2, d) => d >= (T2.rng > 1 ? T2.minRng : 1) && d <= T2.rng;

/** The hero aura a unit of `owner` would stand in on tile (x,y). */
function auraAt(e, x, y) {
  const p = G.ps[e.owner], hero = p && p.heroId ? G.ents.get(p.heroId) : null;
  if (!hero) return '';
  const [hx, hy] = hero === e ? [x, y] : tileOf(hero);
  return cheb(x, y, hx, hy) <= TB.auraRange ? COMMANDERS[G.players[e.owner].commander].aura.key : '';
}

/** Forecast of one blow, using the same formula as the server. `hp` = the attacker's health when it strikes. */
function blow(a, ax, ay, d, dx, dy, counter, hp) {
  const AS = statsOf(a), DS = statsOf(d);
  if (!AS || !DS) return 0;
  const ranged = (a.kind === K_BLDG || tbUnit(AS).rng > 1) && !(a.kind === K_BLDG && d.kind === K_BLDG);
  let mult = 1;
  if (a.kind === K_UNIT) {
    if (AS.tags.includes('ranged') && !AS.tags.includes('siege') && !AS.tags.includes('hero')) mult *= TB.rangedMul;
    if (a.bm & 1) mult *= 1.25;
    const A = auraAt(a, ax, ay);
    if (A === 'a_flint' || A === 'a_ryo') mult *= 1.1;
  }
  if (d.kind === K_UNIT) {
    if (d.bm & 4) mult *= 0.5;
    if (d.bm & 1024) mult *= 0.7;
    if (auraAt(d, dx, dy) === 'a_hank') mult *= 0.82;
  } else if (G.ps[d.owner].lockUntil) mult *= 0.25;
  const cover = d.kind === K_UNIT && G.tiles[dy * G.w + dx] === TILE.TREE ? TB.forestCover : 1;
  return tbDamage(AS, DS, { hpFrac: a.kind === K_UNIT ? Math.max(0, hp) / maxHp(a) : 1, ranged, counter, cover, mult });
}

/** What would happen if `u` attacked `tg` from tile index `stand`: { dmg, kills, counter }. */
export function forecast(u, tg, stand) {
  const sx = stand % G.w, sy = (stand / G.w) | 0, [tx, ty] = tileOf(tg);
  const dmg = blow(u, sx, sy, tg, tx, ty, false, u.hp);
  const kills = dmg >= tg.hp;
  let counter = 0;
  if (!kills && tg.kind === K_UNIT) {
    const DS = statsOf(tg);
    if (DS && DS.atk > 0 && !DS.onlyBldg && !(flagsOf(tg) & (F_STUN | F_COUNTERED)) && inRange(tbUnit(DS), tbDist(sx, sy, tx, ty))) counter = blow(tg, tx, ty, u, sx, sy, true, tg.hp - dmg);
  }
  return { dmg, kills, counter };
}

// ------------------------------------------------------------------ the plan
function compute() {
  T.plan = null;
  if (!myTurn()) return;
  const sel = selected();
  if (sel.length !== 1) return;
  const u = sel[0];
  if (u.kind !== K_UNIT || u.owner !== G.me || (flagsOf(u) & F_DONE)) return;
  for (const e of G.units) if (e.owner === G.me && e.st === ST_MOVE) return;          // someone is still walking: the tiles are not settled yet
  const S = statsOf(u);
  if (!S) return;
  const w = G.w, h = G.h, U = tbUnit(S), [ux, uy] = tileOf(u), start = uy * w + ux;
  const at = unitMap(), team = G.players[G.me].team;
  const heavy = S.tags.includes('veh') || S.tags.includes('siege');
  const cost = (i) => {
    const t = G.tiles[i];
    if (t === TILE.WATER) return Infinity;
    const o = G.ents.get(G.occ[i]);
    if (o && canSee(o)) return Infinity;
    const v = at.get(i);
    if (v && G.players[v.owner].team !== team) return Infinity;
    return t === TILE.TREE ? (heavy ? 3 : 2) : 1;
  };
  const reach = tbReach(w, h, ux, uy, mvLeft(u), cost);
  const stops = new Set();
  for (const i of reach.best.keys()) if (i !== start && !at.has(i)) stops.add(i);
  const stands = [start, ...stops];
  const costOf = (i) => reach.best.get(i) || 0;
  const plan = { unit: u, start, reach, stops, costOf, U, S, targets: new Map(), heals: new Map(), repairs: new Map(), nodes: new Map(), sites: new Map(), at };

  // --- whom it can hit
  if (S.atk > 0 && !(flagsOf(u) & F_STUN)) {
    const artillery = S.tags.includes('siege') && U.rng > 1;                    // fires only from where it stood
    const from = artillery ? ((flagsOf(u) & F_MOVED) ? [] : [start]) : stands;
    const consider = (tg) => {
      const [tx, ty] = tileOf(tg);
      const cands = from.filter((i) => inRange(U, tbDist(i % w, (i / w) | 0, tx, ty)));
      if (cands.length) plan.targets.set(tg.id, { ent: tg, cands });
    };
    if (from.length) {
      if (!S.onlyBldg) for (const e of G.units) if (hostile(G.me, e.owner) && canSee(e)) consider(e);
      for (const e of G.bldgs) if (hostile(G.me, e.owner) && canSee(e)) consider(e);
    }
  }
  const beside = (tx, ty, pred) => stands.filter((i) => pred(tbDist(i % w, (i / w) | 0, tx, ty)));
  // --- a Barista tops up friends
  if (S.heal > 0) {
    for (const e of G.units) {
      if (e === u || hostile(G.me, e.owner) || e.hp >= maxHp(e) || !canSee(e)) continue;
      const [tx, ty] = tileOf(e), cands = beside(tx, ty, (d) => d >= 1 && d <= U.rng);
      if (cands.length) plan.heals.set(e.id, { ent: e, cands });
    }
  }
  // --- a Prep Cook mends stations, lends a hand on building sites, and puts Pantries on resources
  if (u.type === 'cook') {
    for (const e of G.bldgs) {
      if (hostile(G.me, e.owner) || (e.prog >= 100 && e.hp >= maxHp(e))) continue;
      const cands = beside(e.tx, e.ty, (d) => d === 1);
      if (cands.length) plan.repairs.set(e.id, { ent: e, cands });
    }
    for (const e of G.nodes) {
      if (!canSee(e) || G.occ[e.ty * w + e.tx] !== e.id) continue;              // already has a station on it
      const cands = beside(e.tx, e.ty, (d) => d === 1);
      if (cands.length) plan.nodes.set(e.id, { ent: e, cands });
    }
    const mode = G.mode && G.mode.type === 'tplace' ? G.mode : null;
    if (mode && mode.b !== 'pantry') {
      for (const s of stands) {
        const sx = s % w, sy = (s / w) | 0;
        for (let d = 0; d < 4; d++) {
          const x = sx + DX[d], y = sy + DY[d], i = y * w + x;
          if (x < 0 || y < 0 || x >= w || y >= h || G.tiles[i] !== TILE.GRASS || G.occ[i] || at.has(i) || !G.fogExp[i]) continue;
          const c = plan.sites.get(i);
          if (c) c.push(s); else plan.sites.set(i, [s]);
        }
      }
    }
  }
  T.plan = plan;
}

/** Call once per frame: recomputes the plan when the selection, the turn or the map changed. */
export function update() {
  if (!G.tb) { T.plan = null; T.hov = null; return; }
  if (G.mode && G.mode.type === 'tplace') {               // placing a station only makes sense with a Prep Cook that can still act
    const s = selected();
    if (!(myTurn() && s.length === 1 && s[0].type === 'cook' && ready(s[0]))) G.mode = null;
  }
  if (T.holdUntil) {                                      // an order just went out: offer nothing until the server has answered
    if (performance.now() < T.holdUntil) { T.plan = null; return; }
    T.holdUntil = 0; G.tbDirty = true;
  }
  const sig = [...G.sel].join() + '|' + G.tb.cur + ':' + G.tb.ended + '|' + (G.mode ? G.mode.type + (G.mode.b || '') : '') + '|' + (G.over ? 1 : 0);
  if (sig !== T.sig || G.tbDirty) { T.sig = sig; G.tbDirty = false; compute(); }
}

/** Among the tiles a unit could act from, the one to use: stay put if possible, shooters keep their distance, others take the side you point at. */
function chooseStand(plan, cands, wx, wy, tx, ty) {
  if (cands.includes(plan.start)) return plan.start;
  const w = G.w;
  let best = -1, bs = Infinity;
  for (const i of cands) {
    const x = i % w, y = (i / w) | 0;
    const s = plan.U.rng > 1 && tx !== undefined
      ? -tbDist(x, y, tx, ty) * 10 + plan.costOf(i) + Math.hypot(x + 0.5 - wx, y + 0.5 - wy) * 0.01
      : Math.hypot(x + 0.5 - wx, y + 0.5 - wy) + plan.costOf(i) * 0.01;
    if (s < bs) { bs = s; best = i; }
  }
  return best;
}
const pathTo = (plan, stand) => (stand === plan.start ? [] : tbPath(plan.reach.from, stand));

/**
 * What the pointer offers at a map position. Fills T.hov and G.hover, and returns the cursor to show:
 * '' | 'point' | 'attack' | 'build' | 'gather' | 'place'.
 */
export function hover(wx, wy) {
  T.hov = null; G.hoverTree = -1;
  const tx = Math.floor(wx), ty = Math.floor(wy), w = G.w;
  if (tx < 0 || ty < 0 || tx >= w || ty >= G.h) { G.hover = 0; return ''; }
  const i = ty * w + tx, e = pickTile(wx, wy), P = T.plan;
  G.hover = e ? e.id : 0;
  const hov = { tx, ty, i, kind: '', ent: e, stand: -1, path: [], fc: null };
  T.hov = hov;
  const mode = G.mode && G.mode.type === 'tplace' ? G.mode : null;
  if (mode) {
    hov.kind = 'nosite';
    if (P) {
      const cands = mode.b === 'pantry' ? (e && e.kind === K_NODE && P.nodes.has(e.id) ? P.nodes.get(e.id).cands : null) : P.sites.get(i);
      if (cands) { hov.kind = 'site'; hov.stand = chooseStand(P, cands, wx, wy); hov.path = pathTo(P, hov.stand); }
    }
    return 'place';
  }
  if (!P) return e ? 'point' : '';
  const use = (kind, info, ranged) => {
    hov.kind = kind;
    const [ex, ey] = tileOf(info.ent);
    hov.stand = chooseStand(P, info.cands, wx, wy, ranged ? ex : undefined, ey);
    hov.path = pathTo(P, hov.stand);
  };
  if (e && P.targets.has(e.id)) { use('attack', P.targets.get(e.id), true); hov.fc = forecast(P.unit, e, hov.stand); return 'attack'; }
  if (e && P.heals.has(e.id)) { use('heal', P.heals.get(e.id)); return 'point'; }
  if (e && P.repairs.has(e.id)) { use('repair', P.repairs.get(e.id)); return 'build'; }
  if (e && P.nodes.has(e.id)) { use('pantry', P.nodes.get(e.id)); return 'gather'; }
  if (!e && P.stops.has(i)) { hov.kind = 'move'; hov.stand = i; hov.path = pathTo(P, i); return 'point'; }
  return e ? 'point' : '';
}

// ------------------------------------------------------------------- orders
let hooks = { note() {}, sound() {}, selection() {}, canAfford() { return true; } };
export function initTactics(h) { hooks = { ...hooks, ...h }; }
const xy = (i) => [i % G.w, (i / G.w) | 0];

function order(kind, hov, u) {
  const [sx, sy] = xy(hov.stand);
  if (kind === 'attack') { cmd({ c: 'tat', id: u.id, tid: hov.ent.id, x: sx, y: sy }); hooks.sound([u], 'attack'); G.fx.push({ kind: 'atkmark', x: hov.tx + 0.5, y: hov.ty + 0.5, t0: performance.now(), dur: 650 }); }
  else if (kind === 'heal') { cmd({ c: 'thl', id: u.id, tid: hov.ent.id, sx, sy }); hooks.sound([u], 'move'); }
  else if (kind === 'repair') { cmd({ c: 'trp', id: u.id, tid: hov.ent.id, sx, sy }); hooks.sound([u], 'build'); }
  else if (kind === 'move') { cmd({ c: 'tmv', id: u.id, x: sx, y: sy }); hooks.sound([u], 'move'); }
  G.marks.push({ x: hov.tx + 0.5, y: hov.ty + 0.5, t0: performance.now(), color: kind === 'attack' ? '#ff5a4d' : kind === 'move' ? '#8dff6a' : '#ffe45c' });
  T.plan = null; T.hov = null; T.holdUntil = performance.now() + 220;
}

function build(b, hov, u) {
  const S = G.ps[G.me].stats.bldgs[b];
  if (!S) return false;
  if (S.age > G.ps[G.me].age) { hooks.note('That station needs a later age'); return false; }
  if (!hooks.canAfford(S.cost)) { hooks.note('Not enough ingredients for a ' + S.name); return false; }
  const [sx, sy] = xy(hov.stand);
  cmd({ c: 'tbd', id: u.id, b, x: hov.tx, y: hov.ty, sx, sy });
  hooks.sound([u], 'build');
  G.marks.push({ x: hov.tx + 0.5, y: hov.ty + 0.5, t0: performance.now(), color: '#ffe45c' });
  T.plan = null; T.hov = null; T.holdUntil = performance.now() + 220;
  return true;
}

/** A click on the map in turn-based mode. Left: act on a highlighted tile or enemy, otherwise select. Right: act, never select. */
export function click(wx, wy, right) {
  if (T.holdUntil && performance.now() < T.holdUntil) return;      // the second half of a double-click: the first already gave the order
  update();
  hover(wx, wy);
  const hov = T.hov, P = T.plan;
  if (!hov) return;
  const mode = G.mode && G.mode.type === 'tplace' ? G.mode : null;
  if (mode) {
    if (right) { G.mode = null; return; }
    if (hov.kind === 'site' && P) { if (build(mode.b, hov, P.unit)) G.mode = null; }
    else hooks.note(mode.b === 'pantry' ? 'A Pantry goes ON a resource next to where your Prep Cook can stand' : "Can't build there: pick a highlighted tile");
    return;
  }
  if (P) {
    if (hov.kind === 'attack' || hov.kind === 'move') { order(hov.kind, hov, P.unit); return; }
    if (right && (hov.kind === 'heal' || hov.kind === 'repair')) { order(hov.kind, hov, P.unit); return; }
    if (right && hov.kind === 'pantry') { build('pantry', hov, P.unit); return; }
  }
  if (right) {
    const own = selected().find((e) => e.owner === G.me && e.kind === K_UNIT);
    const station = !own && selected().find((e) => e.owner === G.me && e.kind === K_BLDG && e.prog >= 100);
    if (station) {                                         // a station: right-click picks the side its recruits walk out
      cmd({ c: 'trl', bid: station.id, x: hov.tx, y: hov.ty });
      const clear = hov.tx === station.tx && hov.ty === station.ty;
      if (!clear) G.marks.push({ x: hov.tx + 0.5, y: hov.ty + 0.5, t0: performance.now(), color: '#ffffff' });
      hooks.note(clear ? 'Recruits walk out wherever there is room' : 'Recruits from here will walk out on this side');
      return;
    }
    if (!own) return;
    if (!myTurn()) hooks.note('It is not your turn yet');
    else if (flagsOf(own) & F_DONE) hooks.note(flagsOf(own) & F_STUN ? 'Stuck in caramel: this unit misses its turn' : 'That unit is done for this turn');
    else if (own.st === ST_MOVE) return;
    else hooks.note(hov.ent && hov.ent.kind !== K_NODE && hostile(G.me, hov.ent.owner) ? 'Out of reach this turn' : 'Too far: the blue tiles show where it can go');
    return;
  }
  if (hov.ent) { setSelection([hov.ent]); hooks.sound([hov.ent], 'select'); } else G.sel.clear();
  hooks.selection();
}

/** Select the next unit that can still do something this turn and look at it. */
export function nextUnit() {
  const list = readyUnits();
  if (!list.length) { hooks.note(myTurn() ? 'Every unit has acted: end your turn' : 'It is not your turn yet'); return null; }
  const cur = selected(), last = cur.length === 1 ? cur[0].id : 0;
  const e = list.find((x) => x.id > last) || list[0];
  setSelection([e]);
  hooks.selection();
  return e;
}

export function endTurn() {
  if (!myTurn()) { hooks.note('It is not your turn yet'); return false; }
  G.mode = null;
  cmd({ c: 'et' });
  return true;
}

/** Mark the selected unit as finished for this turn. */
export function wait(u) { if (myTurn() && u && u.owner === G.me) cmd({ c: 'twt', id: u.id }); }

/** One line for the selection panel: what this unit can still do this turn. */
export function statusOf(e) {
  const f = flagsOf(e);
  if (f & F_STUN) return e.type.startsWith('hero_') ? 'Stuck in caramel: can walk, but not attack' : 'Stuck in caramel: misses a turn';
  if (!playing(e.owner)) return f & F_TEMP ? 'Hired rider: heads home after a few turns' : f & F_COUNTERED ? 'Has hit back once this turn: no more counterattacks' : '';
  if (f & F_DONE) return 'Done for this turn';
  if (f & F_MOVED) return 'Has moved: can still act';
  return `Can move ${mvLeft(e)} and act`;
}
