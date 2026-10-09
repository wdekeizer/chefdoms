// ============================================================================
//  CHEFDOMS — turn-based mode ("tactics"), server side.
//
//  The same brigade on a grid, one player at a time:
//    * every unit may move once (as far as its movement allows) and then do
//      ONE thing: attack, build, repair, heal... Attacking ends its turn.
//    * the defender strikes back if it can reach the attacker.
//    * Prep Cooks build stations; a Pantry built ON a resource pays that
//      ingredient at the start of each of your turns.
//    * a station trains one unit (or researches one upgrade) at a time.
//
//  A lobby option lets team-mates take their turn together (each presses End
//  turn; the next team goes when all of them have).
//
//  TacticsGame extends the real-time Game so that everything around the rules
//  (players, stats, upgrades, network snapshots, scoring, victory) is shared.
//  All the numbers come from game/data.js (see the TB section there).
// ============================================================================
import { Game, K_UNIT, K_BLDG, K_NODE, ST, POS_Q } from './sim.js';
import {
  TICK_RATE, TILE, RES, NODES, BUILDINGS, TECHS, COMMANDERS, ULT_AGE, HERO_RESPAWN, ZARA_TIP, UNITS,
  TB, tbUnit, tbBldg, tbTurns, tbCooldown, tbDamage, tbReach, tbPath, tbDist, tbAdjust, MARKET,
  mapSizeFor, computeStats, techCost, techTime, trainList, makeRng,
} from './data.js';

const MOVE_PER_TICK = 0.36;           // how fast a unit slides along its path on screen (tiles per tick)
const MELEE_TICKS = 6;                // time between a swing and its damage
const PROJ_SPEED = 0.55;              // tiles per tick for thrown things
// unit flags sent to the clients (in the "stance" slot of the unit record)
export const F_MOVED = 1, F_DONE = 2, F_STUN = 4, F_TEMP = 8, F_COUNTERED = 16;
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ----------------------------------------------------------------------------
//  Map: a small grid with forests (slow, good cover), ponds, a pantry of
//  resource spots next to every Kitchen HQ and contested ones in between.
// ----------------------------------------------------------------------------
export function generateTacticsMap(size, nPlayers, seed) {
  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);
  const w = size, h = size, N = w * h;
  const tiles = new Uint8Array(N), taken = new Uint8Array(N);
  let nodes = [];
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const blob = (cx, cy, count, type, ok) => {
    const placed = [];
    if (!inb(cx, cy) || !ok(cx, cy)) return placed;
    tiles[cy * w + cx] = type; placed.push([cx, cy]);
    for (let guard = 0; placed.length < count && guard < count * 30; guard++) {
      const b = placed[(rng() * placed.length) | 0], d = (rng() * 4) | 0, nx = b[0] + DX[d], ny = b[1] + DY[d];
      if (inb(nx, ny) && tiles[ny * w + nx] !== type && ok(nx, ny)) { tiles[ny * w + nx] = type; placed.push([nx, ny]); }
    }
    return placed;
  };

  // --- where everyone starts: evenly round a ring
  const c = (size - 1) / 2, R = size * 0.36, a0 = rng() * Math.PI * 2;
  const starts = [];
  for (let i = 0; i < nPlayers; i++) {
    const a = a0 + (i * Math.PI * 2) / nPlayers;
    const tx = Math.max(3, Math.min(w - 4, Math.round(c + Math.cos(a) * R))), ty = Math.max(3, Math.min(h - 4, Math.round(c + Math.sin(a) * R)));
    starts.push({ x: tx + 0.5, y: ty + 0.5, tx, ty });
  }
  const fromStart = (x, y) => { let d = Infinity; for (const s of starts) d = Math.min(d, cheb(x, y, s.tx, s.ty)); return d; };

  // --- forests and ponds
  const wild = (x, y) => x > 0 && y > 0 && x < w - 1 && y < h - 1 && fromStart(x, y) > 2;
  for (let i = 0, n = Math.round(N / 34); i < n; i++) blob((rng() * w) | 0, (rng() * h) | 0, 4 + ((rng() * 9) | 0), TILE.TREE, (x, y) => wild(x, y) && tiles[y * w + x] === TILE.GRASS);
  for (let i = 0, n = Math.round(N / 260); i < n; i++) blob((rng() * w) | 0, (rng() * h) | 0, 3 + ((rng() * 5) | 0), TILE.WATER, (x, y) => wild(x, y) && fromStart(x, y) > 3 && tiles[y * w + x] !== TILE.WATER);

  // --- resource spots
  const landNear = (x, y) => { let n = 0; for (let d = 0; d < 4; d++) { const nx = x + DX[d], ny = y + DY[d]; if (inb(nx, ny) && tiles[ny * w + nx] !== TILE.WATER && !taken[ny * w + nx]) n++; } return n; };
  const crowded = (x, y) => { for (let d = 0; d < 4; d++) { const nx = x + DX[d], ny = y + DY[d]; if (inb(nx, ny) && taken[ny * w + nx]) return true; } return false; };
  const put = (type, x, y) => { taken[y * w + x] = 1; if (type !== 'fish') tiles[y * w + x] = TILE.GRASS; nodes.push({ type, tx: x, ty: y }); };
  const place = (type, s, dMin, dMax) => {
    for (let tries = 0; tries < 200; tries++) {
      const x = s.tx + Math.round((rng() * 2 - 1) * dMax), y = s.ty + Math.round((rng() * 2 - 1) * dMax);
      if (!inb(x, y) || x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
      const d = cheb(x, y, s.tx, s.ty);
      if (d < dMin || d > dMax || fromStart(x, y) < 2) continue;
      const i = y * w + x;
      if (taken[i] || tiles[i] === TILE.WATER || crowded(x, y) || landNear(x, y) < 3) continue;
      put(type, x, y);
      return true;
    }
    return false;
  };
  for (const s of starts) {
    for (const [type, dMin, dMax] of [['veg', 2, 3], ['wood', 2, 3], ['wood', 2, 3], ['spice', 3, 4], ['wood', 3, 4], ['wood', 3, 5], ['veg', 3, 5], ['salt', 4, 6], ['wood', 4, 6], ['spice', 5, 7], ['wood', 5, 7], ['wood', 5, 7]]) place(type, s, dMin, dMax);
    // a pond with a Fishing Spot a short walk from home
    for (let tries = 0; tries < 60; tries++) {
      const a = rng() * Math.PI * 2, d = 4 + rng() * 2;
      const px = Math.round(s.tx + Math.cos(a) * d), py = Math.round(s.ty + Math.sin(a) * d);
      if (px < 2 || py < 2 || px > w - 3 || py > h - 3) continue;
      const pond = blob(px, py, 3, TILE.WATER, (x, y) => x > 0 && y > 0 && x < w - 1 && y < h - 1 && fromStart(x, y) > 2 && !taken[y * w + x]);
      if (!pond.length) continue;
      const spot = pond.find(([x, y]) => landNear(x, y) >= 1);
      if (spot) { put('fish', spot[0], spot[1]); break; }
    }
  }
  // contested spots between the bases, salt and spice first
  const kinds = ['wood', 'spice', 'wood', 'salt', 'wood', 'veg', 'wood', 'salt', 'wood', 'spice'], neutral = [];
  for (let k = 0, tries = 0, want = Math.round(nPlayers * 3.5 + N / 120); k < want && tries < 3000; tries++) {
    const x = 1 + ((rng() * (w - 2)) | 0), y = 1 + ((rng() * (h - 2)) | 0), i = y * w + x;
    if (fromStart(x, y) < 7 || taken[i] || tiles[i] === TILE.WATER || crowded(x, y) || landNear(x, y) < 3) continue;
    if (neutral.some((n) => cheb(n[0], n[1], x, y) < 3)) continue;
    put(kinds[k % kinds.length], x, y); neutral.push([x, y]); k++;
  }
  // every other pond gets a Fishing Spot too
  for (let i = 0; i < N; i++) {
    if (tiles[i] !== TILE.WATER || taken[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (landNear(x, y) < 1) continue;
    let near = false;
    for (const n of nodes) if (n.type === 'fish' && cheb(n.tx, n.ty, x, y) < 4) { near = true; break; }
    if (!near && rng() < 0.5) put('fish', x, y);
  }

  // --- every base must be able to walk to every other base
  const flood = () => {
    const seen = new Uint8Array(N), q = [starts[0].ty * w + starts[0].tx];
    seen[q[0]] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi] % w, y = (q[qi] / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d], ni = ny * w + nx;
        if (!inb(nx, ny) || seen[ni] || tiles[ni] === TILE.WATER || taken[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  };
  let seen = flood();
  if (starts.some((s) => !seen[s.ty * w + s.tx])) {
    for (const s of starts) {
      let x = s.tx, y = s.ty;
      const gx = Math.round(c), gy = Math.round(c);
      while (x !== gx || y !== gy) {
        if (Math.abs(gx - x) > Math.abs(gy - y)) x += Math.sign(gx - x); else y += Math.sign(gy - y);
        const i = y * w + x;
        if (tiles[i] === TILE.WATER) tiles[i] = TILE.GRASS;
        taken[i] = 0;
      }
    }
    nodes = nodes.filter((n) => taken[n.ty * w + n.tx]);
  }
  return { w, h, tiles, starts, nodes, seed };
}

// ----------------------------------------------------------------------------
export class TacticsGame extends Game {
  // ==========================================================================
  //  Setup
  // ==========================================================================
  makeMap(opts) {
    this.mode = 'turn';
    this.mapSize = mapSizeFor(opts.mapSize, opts.players.length);
    const map = generateTacticsMap(TB.mapSizes[this.mapSize], opts.players.length, this.seed);
    this.grid = new Int32Array(map.w * map.h);          // id of the unit standing on each tile
    this.turn = { n: 1, cur: 0, deadline: 0, team: -1, ended: new Set() };
    // team-mates take their turn together (only matters when some team has two or more kitchens)
    const sizes = new Map();
    for (const p of opts.players) sizes.set(p.team, (sizes.get(p.team) || 0) + 1);
    this.teamTurns = opts.turnOrder === 'team' && [...sizes.values()].some((n) => n > 1);
    this.turnSeq = 0;                                   // goes up every turn: a unit hits back once per enemy turn
    // the turn timer is in real seconds, whatever the game speed (which only changes how fast things animate)
    this.turnTicks = Math.round(Math.max(0, Number(opts.turnTime) || 0) * TICK_RATE * (Number(opts.speed) || 1));
    this.roundLimit = Math.max(0, Number(opts.turnLimit) || 0);
    this.queue = [];                                    // orders waiting for the current animation to finish
    this.timers = [];                                   // [tick, fn]: things that happen a moment later (a blow landing...)
    this.moving = new Set();
    this.started = false;
    this._tbSig = '';
    return map;
  }

  makePlayer(p, idx) {
    const P = super.makePlayer(p, idx);
    P.maxPop = Math.max(10, Math.round((+this.opts.popCap || 100) * TB.popShare));
    P.abilityCd = 0; P.ultCd = 0; P.heroTurns = 0; P.lock = false; P.sugarNext = false; P.reserved = 0; P.income = { food: 0, wood: 0, spice: 0, salt: 0 };
    tbAdjust(P.stats, P.commander);                     // grid-only tweaks (tougher ranged units, a lighter Hank)
    return P;
  }

  setupBase(P, s) {
    P.home = { x: s.x, y: s.y };
    this.addBuilding(P.idx, 'hq', s.tx, s.ty, true);
    const spots = this.freeAround(s.tx, s.ty, 4, Math.round(this.w / 2), Math.round(this.h / 2));
    const crew = [COMMANDERS[P.commander].hero, 'line', 'cook', 'cook'];
    crew.forEach((type, i) => { const t = spots[i]; if (t) this.spawnUnit(P.idx, type, t[0] + 0.5, t[1] + 0.5); });
  }

  /** Called once everything exists: the first player's turn begins. */
  start() {
    if (this.started) return;
    this.started = true;
    for (const P of this.players) this.refreshBuildings(P);
    for (const P of this.players) P.income = this.incomeOf(P);
    this.sample();                                      // round 0 of the end-of-match graphs
    if (this.teamTurns) this.teamOrder = [...new Set(this.players.map((P) => P.team))];      // teams in seat order of their first kitchen
    this.beginTurn(0);
  }

  addBuilding(owner, type, tx, ty, done) {
    const P = this.players[owner], S = P.stats.bldgs[type], T = tbBldg(S);
    const i = ty * this.w + tx;
    const under = this.ents.get(this.occ[i]);
    const node = under && under.kind === K_NODE ? under : null;
    const turns = tbTurns(S.time / P.stats.misc.buildMul);
    const b = {
      id: this.nextId++, kind: K_BLDG, type, owner, tx, ty, size: 1, x: tx + 0.5, y: ty + 0.5, S, T,
      hp: done ? T.hp : Math.ceil(T.hp * 0.4), prog: done ? 1 : 0, done: false, left: done ? 0 : turns, total: turns,
      q: [], rally: null, trally: null, cd: 0, tgt: 0, builders: 0, worker: 0, paid: null,
      node: node ? node.id : 0, pays: node ? node.type : type === 'garden' ? 'garden' : null,
      inside: 0, lastHit: -9999, dead: false, _sig: '',
    };
    // the "inside" slot of the network record carries which ingredient this station pays (1..4), so clients can badge it
    if (b.pays) b.inside = RES.indexOf(b.pays === 'garden' ? 'food' : NODES[b.pays].res) + 1;
    this.occ[i] = b.id; this.block[i] = 1;
    this.ents.set(b.id, b); this.bldgs.push(b);
    if (done) this.completeBuilding(b);
    return b;
  }

  completeBuilding(b) {
    b.done = true; b.prog = 1; b.left = 0; b.hp = b.T.hp;
    if (this.tick > 0) this.players[b.owner].score.built++;
    this.refreshBuildings(this.players[b.owner]);
    this.events.push(['built', b.owner, b.id]);
  }

  refreshBuildings(P) {
    let cap = 0;
    for (const b of this.bldgs) if (!b.dead && b.owner === P.idx && b.done) cap += b.T.pop;
    P.popCap = Math.min(P.maxPop, cap);
    P.dropoffs = [];
    if (this.started) P.income = this.incomeOf(P);
  }

  spawnUnit(owner, type, x, y) {
    const u = super.spawnUnit(owner, type, x, y);
    u.tx = Math.floor(x); u.ty = Math.floor(y);
    u.x = u.tx + 0.5; u.y = u.ty + 0.5;
    u.T = tbUnit(u.S);
    u.moved = false; u.acted = false; u.stun = 0; u.stuck = false; u.temp = 0; u.bonusMv = 0;
    u.boost = false; u.guard = false; u.feast = false;
    u.anim = null; u.onArrive = null;
    this.grid[u.ty * this.w + u.tx] = u.id;
    return u;
  }

  recomputeStats(P) {
    P.stats = tbAdjust(computeStats(P.commander, P.age, P.techs), P.commander);
    for (const u of this.units) {
      if (u.owner !== P.idx || u.dead) continue;
      const old = u.S.hp;
      u.S = P.stats.units[u.type]; u.T = tbUnit(u.S);
      if (u.S.hp > old) u.hp += u.S.hp - old; else if (u.hp > u.S.hp) u.hp = u.S.hp;
    }
    for (const b of this.bldgs) {
      if (b.owner !== P.idx || b.dead) continue;
      const old = b.T.hp;
      b.S = P.stats.bldgs[b.type]; b.T = tbBldg(b.S);
      if (b.T.hp > old) { if (b.done) b.hp += b.T.hp - old; } else if (b.hp > b.T.hp) b.hp = b.T.hp;
    }
    this.refreshBuildings(P);
  }

  // ==========================================================================
  //  The grid
  // ==========================================================================
  inb(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  unitAt(x, y) { return this.inb(x, y) ? this.ents.get(this.grid[y * this.w + x]) || null : null; }
  /** Tiles around (x,y), nearest first (ties: nearer to (px,py)), that a unit could stand on. */
  freeAround(x, y, radius, px = x, py = y) {
    const out = [];
    for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
      if (!this.inb(xx, yy) || (xx === x && yy === y)) continue;
      const i = yy * this.w + xx;
      if (this.tiles[i] === TILE.WATER || this.occ[i] || this.grid[i]) continue;
      out.push([xx, yy, tbDist(xx, yy, x, y) * 100 + Math.hypot(xx - px, yy - py)]);
    }
    return out.sort((a, b) => a[2] - b[2]);
  }
  /** Movement cost function for a unit: enemies, stations, resources and water block; allies can be walked through. */
  costFn(u) {
    const { tiles, occ, grid, ents, players } = this, team = players[u.owner].team;
    const heavy = u.S.tags.includes('veh') || u.S.tags.includes('siege');
    return (i) => {
      const t = tiles[i];
      if (t === TILE.WATER || occ[i]) return Infinity;
      const g = grid[i];
      if (g) { const v = ents.get(g); if (v && players[v.owner].team !== team) return Infinity; }
      return t === TILE.TREE ? (heavy ? 3 : 2) : 1;
    };
  }
  mvOf(u) { return u.moved ? 0 : u.T.mv + u.bonusMv; }
  reach(u) { return tbReach(this.w, this.h, u.tx, u.ty, this.mvOf(u), this.costFn(u)); }
  /** Can `a` (unit or station) hit something at distance d? */
  inRange(a, d) { const T = a.T; return a.kind === K_UNIT ? d >= (T.rng > 1 ? T.minRng : 1) && d <= T.rng : d >= 1 && d <= T.rng; }

  /** May player pi act right now? (Their own turn, or their team's turn and they have not ended theirs yet.) */
  isTurnOf(pi) {
    const tn = this.turn, P = this.players[pi];
    if (!P) return false;
    return this.teamTurns ? P.team === tn.team && !tn.ended.has(pi) : pi === tn.cur;
  }
  /** The players taking the current turn. */
  turnPlayers() { return this.teamTurns ? this.players.filter((P) => P.team === this.turn.team) : [this.players[this.turn.cur]]; }

  // ==========================================================================
  //  Main loop: animations, delayed effects, queued orders, the turn timer
  // ==========================================================================
  busy() { return this.moving.size > 0 || this.timers.length > 0; }
  after(ticks, fn) { this.timers.push([this.tick + Math.max(1, ticks), fn]); }

  step() {
    const tick = ++this.tick;
    if (!this.started) this.start();
    for (const u of this.moving) this.slide(u);
    if (this.timers.length) {
      const due = [];
      this.timers = this.timers.filter((t) => (t[0] <= tick ? (due.push(t), false) : true));
      for (const t of due) t[1]();
    }
    if (this.turnTicks && tick >= this.turn.deadline) this.queue.length = 0;     // orders still waiting when the timer runs out are dropped
    while (this.queue.length && !this.busy() && !this.over) { const [pi, c] = this.queue.shift(); this.exec(pi, c); }
    this.cleanup();
    if (tick % 10 === 0) this.checkVictory();
    if (this.over) return;
    const now = this.turnPlayers().filter((P) => P.alive);
    if (!now.length || (this.teamTurns && now.every((P) => this.turn.ended.has(P.idx)))) { if (!this.busy()) this.endTurn(); return; }
    if (this.turnTicks && tick >= this.turn.deadline && !this.busy()) { for (const P of now) this.events.push(['note', P.idx, 'timeup']); this.endTurn(); return; }
    for (const P of now) if (P.ai && this.isTurnOf(P.idx)) P.ai.update();
  }

  slide(u) {
    const a = u.anim;
    if (!a || u.dead) { this.moving.delete(u); return; }
    let rem = MOVE_PER_TICK;
    while (rem > 1e-6 && a.i < a.pts.length) {
      const tx = a.pts[a.i], ty = a.pts[a.i + 1], dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
      if (dx > 0.01) u.face = 1; else if (dx < -0.01) u.face = -1;
      if (d <= rem) { u.x = tx; u.y = ty; a.i += 2; rem -= d; } else { u.x += (dx / d) * rem; u.y += (dy / d) * rem; rem = 0; }
    }
    if (a.i >= a.pts.length) {
      u.anim = null; u.st = ST.IDLE; this.moving.delete(u);
      const fn = u.onArrive; u.onArrive = null;
      if (fn) fn();
    }
  }

  /** Move a unit along a path of tile indices (already validated). */
  walk(u, path, then) {
    if (!path.length) { if (then) then(); return; }
    const w = this.w, last = path[path.length - 1];
    this.grid[u.ty * w + u.tx] = 0;
    u.tx = last % w; u.ty = (last / w) | 0;
    this.grid[last] = u.id;
    u.moved = true;
    u.anim = { pts: path.flatMap((i) => [(i % w) + 0.5, ((i / w) | 0) + 0.5]), i: 0 };
    u.st = ST.MOVE; u.tgt = 0; u.onArrive = then || null;
    this.moving.add(u);
  }

  // ==========================================================================
  //  Turns
  // ==========================================================================
  incomeOf(P) {
    const inc = { ...TB.hqIncome }, base = UNITS.cook.gather, g = P.stats.units.cook.gather;
    let hq = false;
    for (const b of this.bldgs) {
      if (b.dead || !b.done || b.owner !== P.idx) continue;
      if (b.type === 'hq') hq = true;
      if (!b.pays) continue;
      const res = b.pays === 'garden' ? 'food' : NODES[b.pays].res;
      const stat = b.pays === 'garden' ? 'garden' : b.pays === 'fish' ? 'fish' : res;       // upgrades and commander bonuses carry over
      inc[res] += TB.income[b.pays] * (g[stat] / base[stat]);
    }
    if (!hq) for (const r of RES) inc[r] -= TB.hqIncome[r];
    const mul = TB.incomeMul * (P.gatherBonus || 1) * (P.sugarNext ? TB.sugarMul : 1);
    for (const r of RES) inc[r] = Math.round(inc[r] * mul);
    return inc;
  }

  beginTurn(pi) {
    const P = this.players[pi], tn = this.turn;
    tn.cur = pi;
    tn.deadline = this.turnTicks ? this.tick + this.turnTicks : 0;
    this.turnSeq++;
    if (this.teamTurns) {                                     // everyone on the team starts their turn at once
      tn.team = P.team; tn.ended = new Set();
      for (const Q of this.players) if (Q.team === tn.team && Q.alive) this.startPlayerTurn(Q.idx);
      this.events.push(['turn', tn.n, pi, tn.team]);
      return;
    }
    if (!P.alive) return;
    this.startPlayerTurn(pi);
    this.events.push(['turn', tn.n, pi, -1]);
  }

  /** One player's turn starts: cooldowns tick, units get their moves back, income arrives, stations work, defences fire. */
  startPlayerTurn(pi) {
    const P = this.players[pi];
    // last turn's shields and boosts wear off
    P.lock = false;
    if (P.abilityCd > 0) P.abilityCd--;
    if (P.ultCd > 0) P.ultCd--;
    const hero = P.heroId ? this.ents.get(P.heroId) : null;
    const aura = COMMANDERS[P.commander].aura.key;
    for (const u of this.units.slice()) {
      if (u.owner !== pi || u.dead) continue;
      u.guard = false; u.feast = false; u.boost = false; u.bonusMv = 0;
      u.moved = false; u.acted = false; u.stuck = false;
      if (u.temp > 0 && --u.temp === 0) { this.killEntity(u, -1); continue; }          // the hired riders go home
      if (u.stun > 0) { u.stun--; u.stuck = true; if (!u.isHero) { u.acted = true; u.moved = true; } }   // stuck in caramel: this turn is lost (a commander can still walk)
      if (hero && !hero.dead && u !== hero && cheb(u.tx, u.ty, hero.tx, hero.ty) <= TB.auraRange) {
        if (aura === 'a_nonna' && u.hp < u.S.hp) this.heal(u, 12);
        if (aura === 'a_odile') u.bonusMv += 1;
      }
    }
    // the commander returns
    if (!P.heroId && P.heroTurns > 0 && --P.heroTurns === 0) {
      const home = this.bldgs.find((b) => !b.dead && b.done && b.owner === pi && b.type === 'hq') || this.bldgs.find((b) => !b.dead && b.done && b.owner === pi);
      const t = home ? this.freeAround(home.tx, home.ty, 3)[0] : null;
      if (t) { this.spawnUnit(pi, COMMANDERS[P.commander].hero, t[0] + 0.5, t[1] + 0.5); this.events.push(['heroup', pi]); } else P.heroTurns = 1;
    }
    // income
    const inc = this.incomeOf(P);
    P.sugarNext = false;
    for (const r of RES) { P.res[r] += inc[r]; P.score.gathered += inc[r]; P.score.res[r] += inc[r]; }
    this.events.push(['income', pi, inc.food, inc.wood, inc.spice, inc.salt]);
    // construction, training, research
    for (const b of this.bldgs.slice()) {
      if (b.dead || b.owner !== pi) continue;
      if (!b.done) { b.left--; b.prog = Math.min(0.99, 1 - b.left / b.total); if (b.left <= 0) this.completeBuilding(b); continue; }
      if (b.q.length) { const it = b.q[0]; if (it.t < it.total) it.t++; if (it.t >= it.total) this.finishItem(P, b); }
    }
    P.income = this.incomeOf(P);
    this.volley(P);
  }

  /** The front of a station's queue is done: the unit walks out (if there is room) or the upgrade applies. */
  finishItem(P, b) {
    const it = b.q[0];
    if (!it) return false;
    if (it.k === 't') { b.q.shift(); this.completeTech(P, it.key); return true; }
    // out of the side facing the station's rally tile (set by right-clicking), else towards the middle of the map
    const t = this.freeAround(b.tx, b.ty, 2, b.trally ? b.trally.x : this.w / 2, b.trally ? b.trally.y : this.h / 2)[0];
    if (!t) return false;                                   // boxed in: it waits inside
    b.q.shift();
    P.reserved -= it.pop;
    this.spawnUnit(P.idx, it.key, t[0] + 0.5, t[1] + 0.5);
    P.score.trained++;
    return true;
  }

  /** Armed stations shoot at the start of their owner's turn: one target per projectile, nearest first (units before stations). */
  volley(P) {
    for (const b of this.bldgs) {
      if (b.dead || !b.done || b.owner !== P.idx || !(b.S.atk > 0)) continue;
      const foes = [];
      for (const u of this.units) {
        if (u.dead || !this.hostile(P.idx, u.owner)) continue;
        const d = tbDist(b.tx, b.ty, u.tx, u.ty);
        if (d <= b.T.rng) foes.push([d, u, 0]);
      }
      for (const v of this.bldgs) {
        if (v.dead || !this.hostile(P.idx, v.owner)) continue;
        const d = tbDist(b.tx, b.ty, v.tx, v.ty);
        if (d <= b.T.rng) foes.push([d, v, 1]);
      }
      if (!foes.length) continue;
      foes.sort((x, y) => x[2] - y[2] || x[0] - y[0] || x[1].hp - y[1].hp);
      for (let i = 0; i < b.S.shots; i++) { const tg = foes[i % foes.length][1]; this.shoot(b, tg, i >= foes.length ? 3 : 0); }
    }
  }

  /** Player pi presses End turn. With team turns the team's turn ends once everyone on it has. */
  endTurnFor(pi) {
    if (!this.teamTurns) { if (pi === this.turn.cur) this.endTurn(); return; }
    this.turn.ended.add(pi);
    for (const u of this.units) if (u.owner === pi) { u.stuck = false; u.boost = false; }
    if (this.turnPlayers().every((P) => !P.alive || this.turn.ended.has(P.idx))) this.endTurn();
  }

  endTurn() {
    const tn = this.turn, n = this.players.length;
    this.queue.length = 0;
    for (const P of this.turnPlayers()) for (const u of this.units) if (u.owner === P.idx) { u.stuck = false; u.boost = false; }        // caramel wears off; SERVICE! was for this turn
    if (this.teamTurns) {
      const order = this.teamOrder, T = order.length, ti = order.indexOf(tn.team);
      for (let k = 1; k <= T; k++) {
        const team = order[(ti + k) % T], first = this.players.find((P) => P.team === team && P.alive);
        if (!first) continue;
        if (ti + k >= T) {                                     // every team has had a go: a new round
          tn.n++; this.sample(); this.driftMarket(MARKET.driftTb);
          if (this.roundLimit && tn.n > this.roundLimit && this.teamsAtStart > 1) { tn.n--; this.finishOnScore(); return; }
        }
        this.beginTurn(first.idx);
        return;
      }
      return;
    }
    for (let k = 1; k <= n; k++) {
      const next = (tn.cur + k) % n;
      if (!this.players[next].alive) continue;
      if (next <= tn.cur) {                                    // everyone has had a go: a new round
        tn.n++; this.sample(); this.driftMarket(MARKET.driftTb);
        if (this.roundLimit && tn.n > this.roundLimit && this.teamsAtStart > 1) { tn.n--; this.finishOnScore(); return; }
      }
      this.beginTurn(next);
      return;
    }
  }

  /** The round limit is up: the team with the best score among those still standing wins. */
  finishOnScore() {
    const best = new Map();
    for (const P of this.players) if (P.alive) best.set(P.team, (best.get(P.team) || 0) + this.scoreOf(P).total);
    let team = -1, top = -1;
    for (const [t, s] of best) if (s > top) { top = s; team = t; }
    this.over = { team, tick: this.tick, onScore: true };
    this.events.push(['over', team]);
  }

  // ==========================================================================
  //  Fighting
  // ==========================================================================
  damageFor(a, d, counter) {
    const ranged = a.kind === K_BLDG || a.T.rng > 1;
    let mult = 1;
    if (a.kind === K_UNIT) {
      if (a.S.tags.includes('ranged') && !a.S.tags.includes('siege') && !a.isHero) mult *= TB.rangedMul;   // the grid is hard on ranged units: they hit harder here
      if (a.boost) mult *= 1.25;
      const A = this.auraOf(a);
      if (A === 'a_flint' || A === 'a_ryo') mult *= 1.1;
    }
    if (d.kind === K_UNIT) {
      if (d.guard) mult *= 0.5;
      if (d.feast) mult *= 0.7;
      if (this.auraOf(d) === 'a_hank') mult *= 0.82;
    } else if (this.players[d.owner].lock) mult *= 0.25;
    const cover = d.kind === K_UNIT && this.tiles[d.ty * this.w + d.tx] === TILE.TREE ? TB.forestCover : 1;
    // a station shooting at a station counts as a heavy blow, not a pepper flick off the walls
    return tbDamage(a.S, d.S, { hpFrac: a.kind === K_UNIT ? a.hp / a.S.hp : 1, ranged: ranged && !(a.kind === K_BLDG && d.kind === K_BLDG), counter, cover, mult });
  }
  /** The aura a unit currently stands in (its own commander's, if the hero is close). */
  auraOf(u) {
    const P = this.players[u.owner], hero = P.heroId ? this.ents.get(P.heroId) : null;
    return hero && !hero.dead && cheb(u.tx, u.ty, hero.tx, hero.ty) <= TB.auraRange ? COMMANDERS[P.commander].aura.key : '';
  }
  /** Units hit back when they can reach; stations do their shooting at the start of their owner's turn instead. */
  canCounter(d, a) {
    if (d.dead || d.kind !== K_UNIT || !(d.S.atk > 0) || a.kind !== K_UNIT) return false;
    if (d.stun > 0 || d.S.onlyBldg) return false;
    if (d.counterSeq === this.turnSeq && (d.counters || 0) >= TB.counters) return false;   // it has already hit back this turn
    return this.inRange(d, tbDist(d.tx, d.ty, a.tx, a.ty));
  }

  hurt(tg, dmg, by) {
    if (tg.dead) return;
    dmg = Math.max(1, Math.round(dmg));
    tg.hp -= dmg; tg.lastHit = this.tick;
    this.events.push(['dmg', Math.round(tg.x * POS_Q), Math.round(tg.y * POS_Q), dmg, 0]);
    const P = this.players[tg.owner];
    if (P) {
      if (this.tick - P.lastAlert > 100) { P.lastAlert = this.tick; this.events.push(['alert', tg.owner, Math.round(tg.x), Math.round(tg.y), tg.kind]); }
      P.lastAttacked = { tick: this.tick, x: tg.x, y: tg.y, by: by ? by.owner : -1 };
    }
    if (tg.hp <= 0) this.killEntity(tg, by ? by.owner : -1);
  }
  heal(u, amount) {
    const before = u.hp;
    u.hp = Math.min(u.S.hp, u.hp + amount);
    if (u.hp > before) this.events.push(['dmg', Math.round(u.x * POS_Q), Math.round(u.y * POS_Q), Math.round(u.hp - before), 1]);
  }

  /** One shot or swing from a at tg; the damage lands a moment later. Returns the ticks until it lands. */
  shoot(a, tg, delay = 0, counter = false, then = null) {
    const dist = tbDist(a.tx, a.ty, tg.tx, tg.ty);
    const proj = a.S.proj && (a.kind === K_BLDG || dist > 1 || a.T.rng > 1) ? a.S.proj : null;
    const travel = (proj ? Math.max(4, Math.round(dist / PROJ_SPEED)) : MELEE_TICKS) + delay;
    if (a.kind === K_UNIT) { a.st = ST.ATTACK; a.tgt = tg.id; if (Math.abs(tg.x - a.x) > 0.05) a.face = tg.x > a.x ? 1 : -1; }
    if (proj) this.events.push(['shot', a.id, tg.id, proj, travel, Math.round(tg.x * POS_Q), Math.round(tg.y * POS_Q)]);
    else this.events.push(['swing', a.id, tg.id]);
    this.after(travel, () => {
      if (a.kind === K_UNIT && !a.dead) { a.st = ST.IDLE; a.tgt = 0; }
      if (!tg.dead && !a.dead) {
        const dmg = this.damageFor(a, tg, counter);
        this.hurt(tg, dmg, a);
        if (a.S.splash > 0) {                       // the neighbours get splashed
          for (let d = 0; d < 4; d++) {
            const x = tg.tx + DX[d], y = tg.ty + DY[d];
            if (!this.inb(x, y)) continue;
            const v = this.unitAt(x, y) || this.ents.get(this.occ[y * this.w + x]);
            if (v && !v.dead && v.kind !== K_NODE && v !== a && this.hostile(a.owner, v.owner)) this.hurt(v, this.damageFor(a, v, counter) * 0.5, a);
          }
        }
      }
      if (then) then();
    });
    return travel;
  }

  /** A full exchange: a attacks tg, and tg hits back if it survives and can reach. */
  fight(a, tg) {
    this.shoot(a, tg, 0, false, () => {
      if (!tg.dead && tg.hp > 0 && !a.dead && this.canCounter(tg, a)) {
        if (tg.counterSeq !== this.turnSeq) { tg.counterSeq = this.turnSeq; tg.counters = 0; }
        tg.counters++;
        this.shoot(tg, a, 2, true);
      }
    });
  }

  // ==========================================================================
  //  Abilities (cooldowns count the owner's turns)
  // ==========================================================================
  heroOf(P) { const h = P.heroId ? this.ents.get(P.heroId) : null; return h && !h.dead ? h : null; }
  around(hero, R, pred) { return this.units.filter((v) => !v.dead && cheb(v.tx, v.ty, hero.tx, hero.ty) <= R && pred(v)); }

  /** Damage from an ability: no armour, but Smoke Ring, a feast, Hank's aura and Lockdown still protect. */
  zap(tg, dmg, by) {
    let m = 1;
    if (tg.kind === K_UNIT) { if (tg.guard) m *= 0.5; if (tg.feast) m *= 0.7; if (this.auraOf(tg) === 'a_hank') m *= 0.82; }
    else if (this.players[tg.owner].lock) m *= 0.25;
    this.hurt(tg, dmg * m, by);
  }

  useAbility(P) {
    const A = COMMANDERS[P.commander].ability, hero = this.heroOf(P);
    if (!hero || P.abilityCd > 0) return false;
    const mine = (v) => v.owner === P.idx, foe = (v) => this.hostile(P.idx, v.owner), R = TB.abilityRange;
    switch (A.key) {
      case 'service': for (const v of this.around(hero, R, mine)) { v.boost = true; if (!v.moved) v.bonusMv += 1; } break;
      case 'mangia': for (const v of this.around(hero, R, mine)) this.heal(v, v.S.hp * 0.4); break;
      case 'lowslow': for (const v of this.around(hero, R, mine)) v.guard = true; break;
      case 'cuts': for (const v of this.around(hero, TB.cutsRange, foe)) this.zap(v, A.dmg + A.dmgPerAge * (P.age - 1), hero); break;
      case 'sugar': for (const v of this.units) if (v.owner === P.idx && !v.dead && !v.moved) v.bonusMv += 2; P.sugarNext = true; P.income = this.incomeOf(P); break;
      case 'lunch': for (const b of this.bldgs.slice()) if (!b.dead && b.owner === P.idx && b.done && b.q.length) { b.q[0].t = b.q[0].total; this.finishItem(P, b); } break;
      default: return false;
    }
    P.abilityCd = tbCooldown(A.cd);
    this.events.push(['ability', P.idx, A.key, Math.round(hero.x * POS_Q), Math.round(hero.y * POS_Q)]);
    return true;
  }

  useUltimate(P) {
    const U = COMMANDERS[P.commander].ultimate, hero = this.heroOf(P);
    if (!U) return false;
    if (P.age < ULT_AGE) { this.events.push(['note', P.idx, 'ultage']); return false; }
    if (!hero || P.ultCd > 0) return false;
    const up = P.age - ULT_AGE, R = TB.abilityRange, foe = (v) => this.hostile(P.idx, v.owner);
    const foeStations = () => this.bldgs.filter((b) => !b.dead && foe(b) && cheb(b.tx, b.ty, hero.tx, hero.ty) <= R);
    let fx = hero;
    switch (U.key) {
      case 'flambe':
        for (const v of this.around(hero, R, foe)) this.zap(v, U.dmg + U.dmgPerAge * up, hero);
        for (const b of foeStations()) this.zap(b, (U.bldg + U.bldgPerAge * up) * TB.bldgHp * 2, hero);
        break;
      case 'feast':
        for (const v of this.units) if (v.owner === P.idx && !v.dead) { this.heal(v, v.S.hp * 0.6); v.feast = true; }
        break;
      case 'lockdown': P.lock = true; this.volley(P); break;
      case 'perfectcut': {
        let best = null;
        for (const v of this.around(hero, R, foe)) if (!best || v.hp > best.hp) best = v;
        if (!best) for (const b of foeStations()) if (!best || b.hp > best.hp) best = b;
        if (!best) { this.events.push(['note', P.idx, 'ulttarget']); return false; }
        fx = best;
        const dmg = U.dmg + U.dmgPerAge * up;
        this.zap(best, best.kind === K_BLDG ? dmg * TB.bldgHp * 2 : best.isHero ? dmg / 2 : dmg, hero);
        if (best.dead) P.abilityCd = 0;
        break;
      }
      case 'glass': for (const v of this.around(hero, R, foe)) v.stun = 1; break;
      case 'swarm': {
        const spots = this.freeAround(hero.tx, hero.ty, 2);
        for (let i = 0, n = U.count + up; i < n && i < spots.length; i++) {
          const u = this.spawnUnit(P.idx, 'scooter', spots[i][0] + 0.5, spots[i][1] + 0.5);
          u.temp = TB.swarmTurns; u.noPop = true; P.pop -= u.S.pop;
        }
        break;
      }
      default: return false;
    }
    P.ultCd = tbCooldown(U.cd);
    this.events.push(['ult', P.idx, U.key, Math.round(fx.x * POS_Q), Math.round(fx.y * POS_Q)]);
    return true;
  }

  // ==========================================================================
  //  Deaths
  // ==========================================================================
  cleanup() {
    const dl = this.deadList;
    if (!dl.length) return;
    let du = false, db = false, dn = false;
    for (let k = 0; k < dl.length; k++) {
      const e = dl[k];
      this.ents.delete(e.id);
      this.removed.push(e.id);
      const P = this.players[e.owner], K = this.players[e.killer];
      if (e.kind === K_UNIT) {
        du = true;
        this.moving.delete(e);
        const i = e.ty * this.w + e.tx;
        if (this.grid[i] === e.id) this.grid[i] = 0;
        if (!e.noPop) P.pop -= e.S.pop;
        if (K && K !== P) {
          K.score.kills++; P.score.lost++;
          if (e.isHero) { K.score.heroKills++; P.score.heroDeaths++; }
          const kh = K.commander === 'zara' ? this.heroOf(K) : null;
          if (kh && cheb(kh.tx, kh.ty, e.tx, e.ty) <= TB.auraRange) { K.res.spice += ZARA_TIP; this.events.push(['tip', K.idx, Math.round(e.x * POS_Q), Math.round(e.y * POS_Q)]); }
        }
        if (e.isHero) {
          P.heroId = 0;
          P.heroTurns = Math.max(2, Math.round(HERO_RESPAWN[P.age] / TB.secondsPerTurn) + 1);
          this.events.push(['herodown', P.idx, K ? K.idx : -1]);
        }
      } else if (e.kind === K_BLDG) {
        db = true;
        const i = e.ty * this.w + e.tx;
        if (this.occ[i] === e.id) {                              // the resource underneath is free again
          const node = this.ents.get(e.node);
          this.occ[i] = node && !node.dead ? node.id : 0;
          this.block[i] = this.occ[i] ? 1 : 0;
        }
        for (const it of e.q) { if (it.k === 't') P.pending.delete(it.key); else P.reserved -= it.pop; }
        if (K && K !== P) { K.score.razed++; P.score.bldgLost++; }
      } else { dn = true; const i = e.ty * this.w + e.tx; if (this.occ[i] === e.id) this.occ[i] = 0; }
    }
    dl.length = 0;
    if (du) this.units = this.units.filter((u) => !u.dead);
    if (dn) this.nodes = this.nodes.filter((n) => !n.dead);
    if (db) { this.bldgs = this.bldgs.filter((b) => !b.dead); for (const P of this.players) this.refreshBuildings(P); }
  }

  eliminate(P) {
    const was = P.alive;
    super.eliminate(P);
    if (was) P.score.outRound = this.turn.n;
    if (!was || !this.started || this.over) return;
    if (this.teamTurns) { if (P.team === this.turn.team) this.after(1, () => { if (!this.over && this.turnPlayers().every((Q) => !Q.alive || this.turn.ended.has(Q.idx))) this.endTurn(); }); }
    else if (this.turn.cur === P.idx) this.after(1, () => { if (!this.over && this.turn.cur === P.idx) this.endTurn(); });
  }

  // ==========================================================================
  //  Orders
  // ==========================================================================
  /** Everything a player or bot can ask for. Orders wait their turn while something is still animating. */
  command(pi, c) {
    const P = this.players[pi];
    if (!P || !P.alive || this.over || !c || typeof c !== 'object') return;
    if (!this.started) this.start();                       // an order that arrives before the first tick still finds the first turn begun
    if (c.c === 'rg') { this.eliminate(P); this.checkVictory(); return; }
    if (c.c === 'trl') { this.setRally(pi, c); return; }                 // where recruits walk out can be chosen any time
    if (!this.isTurnOf(pi)) return;
    if (this.turnTicks && this.tick >= this.turn.deadline) return;           // time is up: nothing more this turn
    if (this.busy() || this.queue.length) { if (this.queue.length < 40) this.queue.push([pi, c]); return; }
    this.exec(pi, c);
  }

  ownUnit(pi, id) {
    const u = this.ents.get(id);
    return u && u.kind === K_UNIT && u.owner === pi && !u.dead ? u : null;
  }
  /** Optional walk to (x,y) before acting. Returns the path ([] = stay put) or null if it is not possible. */
  approach(u, x, y) {
    if (x === undefined || y === undefined || (x === u.tx && y === u.ty)) return [];
    x |= 0; y |= 0;
    if (u.moved || !this.inb(x, y)) return null;
    const i = y * this.w + x;
    if (this.grid[i]) return null;
    const r = this.reach(u);
    return r.best.has(i) ? tbPath(r.from, i) : null;
  }
  note(pi, key) { this.events.push(['note', pi, key]); }
  /** Where a station's recruits walk out: towards the tile right-clicked (the station itself clears it). */
  setRally(pi, c) {
    const b = this.ownBldg(pi, c.bid);
    if (!b || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
    const x = c.x | 0, y = c.y | 0;
    b.trally = !this.inb(x, y) || (x === b.tx && y === b.ty) ? null : { x, y };
  }

  exec(pi, c) {
    const P = this.players[pi];
    if (!P.alive || !this.isTurnOf(pi) || this.over) return;
    switch (c.c) {
      case 'tmv': {                                    // move
        const u = this.ownUnit(pi, c.id);
        if (!u || u.acted || u.moved || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
        const path = this.approach(u, c.x, c.y);
        if (!path) { this.note(pi, 'blocked'); return; }
        if (!path.length) return;
        this.walk(u, path);
        break;
      }
      case 'tat': {                                    // (move and) attack
        const u = this.ownUnit(pi, c.id), tg = this.ents.get(c.tid);
        if (!u || u.acted || !(u.S.atk > 0) || !tg || tg.dead || tg.kind === K_NODE || !this.hostile(pi, tg.owner)) return;
        if (u.S.onlyBldg && tg.kind !== K_BLDG) return;
        if (u.stuck) { this.note(pi, 'stuck'); return; }
        const path = this.approach(u, c.x, c.y);
        if (!path) { this.note(pi, 'blocked'); return; }
        const sx = path.length ? path[path.length - 1] % this.w : u.tx, sy = path.length ? (path[path.length - 1] / this.w) | 0 : u.ty;
        if (!this.inRange(u, tbDist(sx, sy, tg.tx, tg.ty))) return;
        if (u.S.tags.includes('siege') && u.T.rng > 1 && (u.moved || path.length)) { this.note(pi, 'setup'); return; }   // artillery fires only from where it stood
        u.acted = true;
        this.walk(u, path, () => { u.moved = true; if (!tg.dead) this.fight(u, tg); });
        break;
      }
      case 'tbd': {                                    // a Prep Cook (walks and) starts a station on the tile next to it
        if (typeof c.b !== 'string' || !Object.hasOwn(BUILDINGS, c.b) || BUILDINGS[c.b].wall) return;      // (no walls on the grid)
        const u = this.ownUnit(pi, c.id), S = P.stats.bldgs[c.b];
        if (!u || !u.isCook || u.acted || !S || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
        if (S.age > P.age) return;
        if (S.needs && !this.hasStation(pi, S.needs)) { this.note(pi, 'needs_' + S.needs); return; }
        const x = c.x | 0, y = c.y | 0;
        const why = this.cantPlace(c.b, x, y);
        if (why) { this.note(pi, why); return; }
        const path = this.approach(u, c.sx, c.sy);
        if (!path) return;
        const sx = path.length ? path[path.length - 1] % this.w : u.tx, sy = path.length ? (path[path.length - 1] / this.w) | 0 : u.ty;
        if (tbDist(sx, sy, x, y) !== 1) return;
        if (!this.pay(P, S.cost)) { this.note(pi, 'res'); return; }
        u.acted = true;
        const cost = { ...S.cost };
        this.walk(u, path, () => {
          u.moved = true;
          if (this.cantPlace(c.b, x, y)) { this.refund(P, cost); return; }          // someone got there first
          const b = this.addBuilding(pi, c.b, x, y, false);
          b.paid = cost;
          u.st = ST.BUILD; u.tgt = b.id; this.after(8, () => { if (!u.dead) { u.st = ST.IDLE; u.tgt = 0; } });
        });
        break;
      }
      case 'trp': {                                    // a Prep Cook repairs a station, or lends a hand on a building site
        const u = this.ownUnit(pi, c.id), b = this.ents.get(c.tid);
        if (!u || !u.isCook || u.acted || !b || b.dead || b.kind !== K_BLDG || this.hostile(pi, b.owner)) return;
        if (b.done && b.hp >= b.T.hp) return;
        const path = this.approach(u, c.sx, c.sy);
        if (!path) return;
        const sx = path.length ? path[path.length - 1] % this.w : u.tx, sy = path.length ? (path[path.length - 1] / this.w) | 0 : u.ty;
        if (tbDist(sx, sy, b.tx, b.ty) !== 1) return;
        u.acted = true;
        this.walk(u, path, () => {
          u.moved = true;
          if (b.dead) return;
          u.st = ST.BUILD; u.tgt = b.id; this.after(8, () => { if (!u.dead) { u.st = ST.IDLE; u.tgt = 0; } });
          if (!b.done) { b.left--; b.prog = Math.min(0.99, 1 - b.left / b.total); if (b.left <= 0) this.completeBuilding(b); }
          else { const before = b.hp; b.hp = Math.min(b.T.hp, b.hp + Math.ceil(b.T.hp * TB.repairShare)); this.events.push(['dmg', Math.round(b.x * POS_Q), Math.round(b.y * POS_Q), Math.round(b.hp - before), 1]); }
        });
        break;
      }
      case 'thl': {                                    // a Barista tops up a friend
        const u = this.ownUnit(pi, c.id), tg = this.ents.get(c.tid);
        if (!u || u.acted || !(u.S.heal > 0) || !tg || tg.dead || tg.kind !== K_UNIT || tg === u || this.hostile(pi, tg.owner) || tg.hp >= tg.S.hp) return;
        const path = this.approach(u, c.sx, c.sy);
        if (!path) return;
        const sx = path.length ? path[path.length - 1] % this.w : u.tx, sy = path.length ? (path[path.length - 1] / this.w) | 0 : u.ty;
        const d = tbDist(sx, sy, tg.tx, tg.ty);
        if (d < 1 || d > u.T.rng) return;
        u.acted = true;
        this.walk(u, path, () => {
          u.moved = true;
          if (tg.dead) return;
          u.st = ST.HEAL; u.tgt = tg.id; this.after(8, () => { if (!u.dead) { u.st = ST.IDLE; u.tgt = 0; } });
          this.heal(tg, u.S.heal * (TB.healAction / 5));
        });
        break;
      }
      case 'twt': { const u = this.ownUnit(pi, c.id); if (u) { u.acted = true; u.moved = true; } break; }   // this unit is done for the turn
      case 'tr': {
        const b = this.ownBldg(pi, c.bid);
        if (b && b.done) this.cmdTrain(P, b, c.u);
        break;
      }
      case 'rs': {
        const b = this.ownBldg(pi, c.bid);
        if (b && b.done) this.cmdResearch(P, b, c.tech);
        break;
      }
      case 'cq': {
        const b = this.ownBldg(pi, c.bid), it = b ? b.q[c.i | 0] : null;
        if (!it) return;
        b.q.splice(c.i | 0, 1);
        this.refund(P, it.cost);
        if (it.k === 't') P.pending.delete(it.key); else P.reserved -= it.pop;
        break;
      }
      case 'dl': {
        if (!Array.isArray(c.ids)) return;
        for (let k = 0; k < c.ids.length && k < 60; k++) {
          const e = this.ents.get(c.ids[k]);
          if (!e || e.dead || e.owner !== pi || e.isHero || e.kind === K_NODE) continue;
          if (e.kind === K_BLDG) { if (!e.done && e.paid) this.refund(P, e.paid, 0.5); for (const it of e.q) this.refund(P, it.cost); }      // (cleanup releases the staff room it had reserved)
          this.killEntity(e, -1);
        }
        break;
      }
      case 'mkt': this.trade(P, c.give, c.get, c.n); break;
      case 'ab': this.useAbility(P); break;
      case 'ul': this.useUltimate(P); break;
      case 'et': this.endTurnFor(pi); break;
    }
  }

  /** Why a station cannot go on this tile ('' = it can). */
  cantPlace(type, x, y) {
    if (typeof type !== 'string' || !Object.hasOwn(BUILDINGS, type) || !this.inb(x, y)) return 'place';
    const i = y * this.w + x, o = this.ents.get(this.occ[i]);
    if (this.grid[i]) return 'place';
    if (type === 'pantry') return o && o.kind === K_NODE ? '' : 'pantry';              // only on a resource
    if (o || this.tiles[i] !== TILE.GRASS) return 'place';
    return '';
  }

  cmdTrain(P, b, key) {
    if (b.q.length >= 1) { this.note(P.idx, 'busy'); return false; }
    if (!trainList(b.type, P.commander).includes(key)) return false;
    const US = P.stats.units[key];
    if (!US || US.age > P.age) return false;
    if (P.pop + (P.reserved || 0) + US.pop > P.popCap) { this.note(P.idx, P.popCap >= P.maxPop ? 'popmax' : 'pop'); return false; }
    if (!this.pay(P, US.cost)) { this.note(P.idx, 'res'); return false; }
    P.reserved = (P.reserved || 0) + US.pop;
    b.q.push({ k: 'u', key, t: 0, total: 1, cost: { ...US.cost }, pop: US.pop });
    return true;
  }
  cmdResearch(P, b, key) {
    const T = TECHS[key];
    if (!T || !b.S.techs.includes(key)) return false;
    if (b.q.length >= 1) { this.note(P.idx, 'busy'); return false; }
    if (P.techs.includes(key) || P.pending.has(key)) return false;
    if (T.setAge ? P.age !== T.setAge - 1 : T.age > P.age) return false;
    if (T.req && !P.techs.includes(T.req)) return false;
    const cost = techCost(key, P.stats.misc);
    if (!this.pay(P, cost)) { this.note(P.idx, 'res'); return false; }
    P.pending.add(key);
    b.q.push({ k: 't', key, t: 0, total: tbTurns(techTime(key, P.stats.misc)), cost });
    return true;
  }

  // ==========================================================================
  //  Network state and scores
  // ==========================================================================
  /** Low byte: what the unit has done this turn; above it: the movement points it has left. */
  flagsOf(u) {
    return (u.moved ? F_MOVED : 0) | (u.acted || (u.stuck && u.moved) ? F_DONE : 0) | (u.stun > 0 || u.stuck ? F_STUN : 0) | (u.temp > 0 ? F_TEMP : 0)
      | (u.counterSeq === this.turnSeq && (u.counters || 0) >= TB.counters ? F_COUNTERED : 0) | (this.mvOf(u) << 8);
  }
  bldgRec(b) {
    const r = super.bldgRec(b);
    r[8] = b.q.length ? b.q[0].total - b.q[0].t : 0;      // turns until the front of the queue is done
    r[10] = b.done ? 0 : b.left;                           // turns of construction left
    r[12] = b.trally ? [b.trally.x, b.trally.y] : 0;       // the tile its recruits walk out towards
    return r;
  }
  playerRec(P) {
    const r = super.playerRec(P);
    r[11] = P.heroTurns; r[12] = P.abilityCd; r[19] = P.ultCd; r[20] = P.lock ? 1 : 0;
    r[21] = [P.income.food, P.income.wood, P.income.spice, P.income.salt];
    return r;
  }
  syncFlags() {
    // the flags ride in the "stance" slot and the buff glows in the buff mask, so the usual snapshot code sends them
    for (const u of this.units) { u.stance = this.flagsOf(u); u.bmask = (u.boost ? 1 : 0) | (u.guard ? 4 : 0) | (u.feast ? 1024 : 0) | (u.stun > 0 || u.stuck ? 2048 : 0); }
  }
  /** [round, player, deadline, team (-1 = one kitchen at a time), bitmask of team-mates who have ended their turn] */
  turnRec() {
    const tn = this.turn;
    let ended = 0;
    if (this.teamTurns) for (const pi of tn.ended) ended |= 1 << pi;
    return [tn.n, tn.cur, tn.deadline, this.teamTurns ? tn.team : -1, ended];
  }
  delta() {
    this.syncFlags();
    const out = super.delta();
    const sig = this.turnRec().join();
    if (sig !== this._tbSig) { this._tbSig = sig; out.tb = this.turnRec(); }
    return out;
  }
  full() {
    this.syncFlags();
    const out = super.full();
    out.tb = this.turnRec();
    return out;
  }
  startInfo() {
    const info = super.startInfo();
    info.mode = 'turn';
    info.opts.mode = 'turn'; info.opts.turnTime = Number(this.opts.turnTime) || 0; info.opts.turnLimit = this.roundLimit; info.opts.turnOrder = this.teamTurns ? 'team' : 'player';
    return info;
  }

  /** One data point per round for the end-of-match graphs. */
  sample() {
    const tl = this.tl, round = this.turn.n - 1;
    if (tl.t.length && tl.t[tl.t.length - 1] === round) return;
    const army = new Array(this.players.length).fill(0);
    for (const u of this.units) if (!u.dead && !u.isCook && !u.isHero && u.S.atk > 0) army[u.owner]++;
    tl.t.push(round);
    this.players.forEach((P, i) => {
      const s = P.score, row = tl.s[i];
      if (P.pop > s.peakPop) s.peakPop = P.pop;
      if (army[i] > s.peakArmy) s.peakArmy = army[i];
      row.score.push(this.scoreOf(P).total); row.army.push(army[i]); row.pop.push(P.pop); row.gathered.push(s.gathered); row.kills.push(s.kills);
    });
  }
  timeline() {
    const tl = this.tl, round = this.turn.n;
    if (!tl.t.length || tl.t[tl.t.length - 1] !== round) { this.turn.n++; this.sample(); this.turn.n--; }
    const series = {};
    for (const key of ['score', 'army', 'pop', 'gathered', 'kills']) series[key] = tl.s.map((row) => row[key]);
    return { unit: 'turn', t: tl.t.slice(), series };
  }
  summary() {
    const out = super.summary();
    out.forEach((s, i) => { s.outAt = this.players[i].score.outRound || 0; s.rounds = this.turn.n; });
    return out;
  }
}
