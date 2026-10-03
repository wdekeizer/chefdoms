// ============================================================================
//  CHEFDOMS — authoritative game simulation (runs on the server only).
//  The server steps this 20x per second, feeds it player commands, and streams
//  the resulting state to every browser. Clients never simulate.
// ============================================================================
import {
  TICK_RATE, DT, RES, TILE, TREE_WOOD, NODES, BUILDINGS, TECHS, COMMANDERS, BUFFS,
  AURA_RADIUS, ZARA_TIP, HERO_RESPAWN, START_RES, MAP_SIZES, mapSizeFor,
  computeStats, techCost, techTime, trainList,
} from './data.js';
import { Pathfinder } from './pathfinding.js';
import { generateMap } from './mapgen.js';

export const K_UNIT = 0, K_BLDG = 1, K_NODE = 2;
export const ST = { IDLE: 0, MOVE: 1, ATTACK: 2, GATHER: 3, BUILD: 4, HEAL: 5 };
export const POS_Q = 32;              // network position precision: 1/32 of a tile

const REACH = 1.1;                    // how close a worker must be to its target's edge
const MELEE_GAP = 0.3;
const PATH_BUDGET = 48;               // A* searches per tick; the rest wait a tick
const PROJ_SPEED = { sauce: 10, flame: 12, frosting: 11, skewer: 13, plate: 11, pepper: 12, macaron: 7.5, meatball: 6.5 };

export function rectDist(x, y, e) {
  const dx = x < e.tx ? e.tx - x : x > e.tx + e.size ? x - e.tx - e.size : 0;
  const dy = y < e.ty ? e.ty - y : y > e.ty + e.size ? y - e.ty - e.size : 0;
  return dx === 0 ? dy : dy === 0 ? dx : Math.hypot(dx, dy);
}
const rectGoal = (e) => ({ rect: [e.tx, e.ty, e.tx + e.size - 1, e.ty + e.size - 1] });
const isAlive = (e) => !e.dead;

export class Game {
  /**
   * @param {{players:{name:string,commander:string,team:number,color:number,bot?:string|null}[],
   *          mapSize?:string,startRes?:string,popCap?:number|string,seed?:number}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.seed = opts.seed ?? ((Math.random() * 2147483647) | 0);
    this.mapSize = mapSizeFor(opts.mapSize, opts.players.length);
    const size = MAP_SIZES[this.mapSize];
    const map = generateMap(size, opts.players.length, this.seed);
    this.w = map.w; this.h = map.h;
    this.tiles = map.tiles;
    const N = this.w * this.h;
    this.treeWood = new Uint16Array(N);
    this.block = new Uint8Array(N);       // 1 = impassable
    this.occ = new Int32Array(N);         // id of the station/node on this tile, 0 = none
    for (let i = 0; i < N; i++) {
      const t = this.tiles[i];
      if (t === TILE.TREE) { this.treeWood[i] = TREE_WOOD; this.block[i] = 1; }
      else if (t === TILE.WATER) this.block[i] = 1;
    }
    this.pf = new Pathfinder(this.w, this.h, this.block);

    this.tick = 0;
    this.nextId = 1;
    this.ents = new Map();
    this.units = []; this.bldgs = []; this.nodes = [];
    this.events = []; this.tileChanges = []; this.removed = [];
    this.hits = []; this.deadList = [];
    this.pathQueue = []; this.pathBudget = PATH_BUDGET;
    this.cells = new Array(N);
    for (let i = 0; i < N; i++) this.cells[i] = [];
    this.touched = [];
    this._near = [];
    this.over = null;

    for (const n of map.nodes) this.addNode(n.type, n.tx, n.ty);
    this.players = opts.players.map((p, idx) => this.makePlayer(p, idx));
    this.teamsAtStart = new Set(this.players.map((p) => p.team)).size;
    this.starts = map.starts;
    map.starts.forEach((s, i) => this.setupBase(this.players[i], s));
  }

  // ==========================================================================
  //  Setup
  // ==========================================================================
  makePlayer(p, idx) {
    const cmd = COMMANDERS[p.commander] ? p.commander : 'flint';
    return {
      idx, name: p.name, commander: cmd, team: p.team, color: p.color, bot: p.bot || null,
      res: { ...(START_RES[this.opts.startRes] || START_RES.standard) },
      pop: 0, popCap: 0, maxPop: +this.opts.popCap || 100,
      age: 1, techs: [], pending: new Set(),
      stats: computeStats(cmd, 1, []),
      alive: true, heroId: 0, heroRespawn: 0, abilityReady: 0, lunchUntil: 0,
      lastAlert: -9999, lastAttacked: null, popNote: -9999,
      dropoffs: [], home: { x: 0, y: 0 }, ai: null, gatherBonus: 1,
      score: { kills: 0, lost: 0, razed: 0, bldgLost: 0, gathered: 0, trained: 0 },
      _sig: '',
    };
  }

  setupBase(P, s) {
    P.home = { x: s.x, y: s.y };
    this.addBuilding(P.idx, 'hq', s.tx, s.ty, true);
    for (let i = 0; i < 4; i++) this.spawnUnit(P.idx, 'cook', s.x - 1.5 + i, s.y + 2.6);
    this.spawnUnit(P.idx, COMMANDERS[P.commander].hero, s.x + 2.8, s.y + 0.5);
  }

  addNode(type, tx, ty) {
    const n = {
      id: this.nextId++, kind: K_NODE, type, owner: -1, tx, ty, size: 1, x: tx + 0.5, y: ty + 0.5,
      amount: NODES[type].amount, hp: 1, dead: false, _amt: -1,
    };
    const i = ty * this.w + tx;
    this.block[i] = 1; this.occ[i] = n.id;
    this.ents.set(n.id, n); this.nodes.push(n);
    return n;
  }

  addBuilding(owner, type, tx, ty, done) {
    const P = this.players[owner];
    const S = P.stats.bldgs[type];
    const b = {
      id: this.nextId++, kind: K_BLDG, type, owner, tx, ty, size: S.size,
      x: tx + S.size / 2, y: ty + S.size / 2, S,
      hp: done ? S.hp : 1, prog: done ? 1 : 0, done: false,
      q: [], rally: null, cd: 0, tgt: 0, builders: 0, worker: 0, paid: null,
      lastHit: -9999, dead: false, _sig: '',
    };
    for (let y = ty; y < ty + S.size; y++) for (let x = tx; x < tx + S.size; x++) {
      const i = y * this.w + x;
      this.occ[i] = b.id;
      if (!S.walkable) this.block[i] = 1;
    }
    this.ents.set(b.id, b); this.bldgs.push(b);
    if (done) this.completeBuilding(b);
    return b;
  }

  completeBuilding(b) {
    b.done = true; b.prog = 1;
    if (b.hp > b.S.hp) b.hp = b.S.hp;
    this.refreshBuildings(this.players[b.owner]);
    this.events.push(['built', b.owner, b.id]);
  }

  refreshBuildings(P) {
    let cap = 0;
    const drops = [];
    for (const b of this.bldgs) {
      if (b.dead || b.owner !== P.idx || !b.done) continue;
      cap += b.S.pop;
      if (b.S.dropoff) drops.push(b);
    }
    P.popCap = Math.min(P.maxPop, cap);
    P.dropoffs = drops;
  }

  spawnUnit(owner, type, x, y) {
    const P = this.players[owner];
    const S = P.stats.units[type];
    const u = {
      id: this.nextId++, kind: K_UNIT, type, owner, x, y, S, hp: S.hp, r: S.radius,
      isCook: type === 'cook', isHero: S.tags.includes('hero'),
      order: null, queue: [], path: null, pi: 0, goal: null, wantPath: false, partial: false, repathAt: 0,
      st: ST.IDLE, tgt: 0, cd: 0, face: 1,
      carryType: null, carryAmt: 0, gAcc: 0,
      buffs: null, bAtk: 1, bReload: 1, bSpeed: 1, bDmg: 1, bGather: 1, bmask: 0,
      lastHit: -9999, ignoreId: 0, ignoreUntil: 0, killer: -1, dead: false,
      _new: true, _hp: 0, _st: 0, _tgt: 0, _carry: 0, _bm: 0, _qx: 0, _qy: 0,
    };
    this.ents.set(u.id, u); this.units.push(u);
    P.pop += S.pop;
    if (u.isHero) P.heroId = u.id;
    return u;
  }

  hostile(a, b) { return b >= 0 && this.players[a].team !== this.players[b].team; }

  // ==========================================================================
  //  Main loop
  // ==========================================================================
  step() {
    const tick = ++this.tick;

    // path requests that didn't fit in last tick's budget
    this.pathBudget = PATH_BUDGET;
    if (this.pathQueue.length) {
      const q = this.pathQueue; this.pathQueue = [];
      for (const u of q) {
        if (u.dead || !u.wantPath) continue;
        if (this.pathBudget > 0) { this.pathBudget--; this.computePath(u); }
        else this.pathQueue.push(u);
      }
    }

    this.rebuildHash();
    const units = this.units;
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (!u.dead) this.updateUnit(u); }
    this.separate();
    const bl = this.bldgs;
    for (let i = 0; i < bl.length; i++) { const b = bl[i]; if (!b.dead) this.updateBuilding(b); }
    if (this.hits.length) this.resolveHits();
    if (tick % 5 === 0) this.updateBuffs(true);
    if (tick % 10 === 0) this.updateHeroes();
    this.cleanup();
    if (tick % 20 === 0) this.checkVictory();
    for (const P of this.players) if (P.ai && P.alive && !this.over) P.ai.update();
  }

  rebuildHash() {
    const t = this.touched;
    for (let i = 0; i < t.length; i++) t[i].length = 0;
    t.length = 0;
    const w = this.w, cells = this.cells;
    for (const u of this.units) {
      if (u.dead) continue;
      const c = cells[(u.y | 0) * w + (u.x | 0)];
      if (c.length === 0) t.push(c);
      c.push(u);
    }
  }

  /** Units in the square of half-width R around (x,y). Returns a scratch array — don't keep it. */
  near(x, y, R) {
    const out = this._near; out.length = 0;
    const w = this.w, h = this.h, cells = this.cells;
    const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.floor(x + R));
    const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.floor(y + R));
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * w;
      for (let xx = x0; xx <= x1; xx++) {
        const c = cells[row + xx];
        for (let i = 0; i < c.length; i++) out.push(c[i]);
      }
    }
    return out;
  }

  // ==========================================================================
  //  Orders & movement
  // ==========================================================================
  setOrder(u, o, queued) {
    if (queued && u.order) { if (u.queue.length < 12) u.queue.push(o); return; }
    u.queue.length = 0;
    this.beginOrder(u, o);
  }
  beginOrder(u, o) {
    this.leaveOrder(u);
    u.order = o; u.path = null; u.wantPath = false; u.repathAt = 0;
    if (!o) { u.st = ST.IDLE; u.tgt = 0; }
  }
  leaveOrder(u) {
    const o = u.order;
    if (o && o.t === 'gather' && o.gid) {
      const g = this.ents.get(o.gid);
      if (g && g.worker === u.id) g.worker = 0;
    }
  }
  nextOrder(u) { this.beginOrder(u, u.queue.length ? u.queue.shift() : null); }

  requestPath(u, goal) {
    u.path = null; u.pi = 0; u.goal = goal; u.partial = false;
    if (!goal.rect) {
      // short hop with a clear line: skip A*
      const gx = goal.x, gy = goal.y;
      if (Math.abs(gx - u.x) + Math.abs(gy - u.y) < 7 && !this.pf.blockedAt(gx, gy) && this.pf.lineClear(u.x, u.y, gx, gy)) {
        u.path = [gx, gy]; u.wantPath = false; return;
      }
    }
    if (this.pathBudget > 0) { this.pathBudget--; this.computePath(u); }
    else if (!u.wantPath) { u.wantPath = true; this.pathQueue.push(u); }
  }
  computePath(u) {
    u.wantPath = false;
    const r = this.pf.find(u.x, u.y, u.goal);
    u.path = r ? r.pts : null; u.pi = 0; u.partial = r ? r.partial : false;
  }

  /** Advance along the current path. 0 = finished / no path, 1 = travelling, 2 = got blocked. */
  travel(u, speed) {
    if (u.wantPath) return 1;
    const p = u.path;
    if (!p) return 0;
    const w = this.w, block = this.block;
    let rem = speed * DT;
    while (rem > 1e-9) {
      if (u.pi >= p.length) { u.path = null; return 0; }
      const tx = p[u.pi], ty = p[u.pi + 1];
      const dx = tx - u.x, dy = ty - u.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      let nx, ny, reached;
      if (d <= rem) { nx = tx; ny = ty; reached = true; rem -= d; }
      else { nx = u.x + (dx / d) * rem; ny = u.y + (dy / d) * rem; reached = false; rem = 0; }
      if (block[(ny | 0) * w + (nx | 0)]) { u.path = null; return 2; }
      if (dx > 0.01) u.face = 1; else if (dx < -0.01) u.face = -1;
      u.x = nx; u.y = ny;
      if (reached) u.pi += 2;
    }
    if (u.pi >= p.length) { u.path = null; return 0; }
    return 1;
  }

  /**
   * Keep walking toward `goal` until the caller decides the unit is in reach.
   * Re-paths when the path runs out; returns false once the goal looks unreachable.
   * Set o.pathed = false to force a fresh path (e.g. the target moved).
   */
  approach(u, o, goal, speed) {
    u.st = ST.MOVE;
    const r = this.travel(u, speed);
    if (r === 1 && o.pathed) return true;
    if (this.tick < u.repathAt) return true;
    u.repathAt = this.tick + 10;
    if (o.pathed) { o.fails = (o.fails | 0) + 1; if (o.fails > 4) return false; }
    o.pathed = true;
    this.requestPath(u, goal);
    return true;
  }

  unstick(u) {
    const f = this.pf.nearestFree(u.x | 0, u.y | 0, 14);
    if (f) { u.x = f[0] + 0.5; u.y = f[1] + 0.5; }
    u.path = null;
    if (u.order) { u.order.pathed = false; u.order.go = 0; }
  }

  // ==========================================================================
  //  Units
  // ==========================================================================
  updateUnit(u) {
    const S = u.S, tick = this.tick;
    if (u.cd > 0) u.cd--;
    if (this.block[(u.y | 0) * this.w + (u.x | 0)]) this.unstick(u);
    const o = u.order;
    if (!o) {
      u.st = ST.IDLE; u.tgt = 0;
      if ((tick + u.id) % 8 === 0) this.idleScan(u, S);
      return;
    }
    const speed = S.speed * u.bSpeed;
    switch (o.t) {
      case 'move': {
        u.st = ST.MOVE; u.tgt = 0;
        if (!o.go) { o.go = 1; this.requestPath(u, { x: o.x, y: o.y }); }
        const r = this.travel(u, speed);
        if (r === 0) this.nextOrder(u);
        else if (r === 2) { if ((o.tries = (o.tries | 0) + 1) > 3) this.nextOrder(u); else this.requestPath(u, { x: o.x, y: o.y }); }
        break;
      }
      case 'amove': {
        if ((tick + u.id) % 6 === 0) {
          const tg = this.acquire(u, S);
          if (tg) { this.beginOrder(u, { t: 'attack', id: tg.id, auto: true, gx: u.x, gy: u.y, resume: o }); break; }
        }
        u.st = ST.MOVE; u.tgt = 0;
        if (!o.go) { o.go = 1; this.requestPath(u, { x: o.x, y: o.y }); }
        const r = this.travel(u, speed);
        if (r === 0) this.nextOrder(u);
        else if (r === 2) { if ((o.tries = (o.tries | 0) + 1) > 3) this.nextOrder(u); else this.requestPath(u, { x: o.x, y: o.y }); }
        break;
      }
      case 'attack': {
        const tg = this.ents.get(o.id);
        if (!tg || tg.dead || tg.hp <= 0 || tg.kind === K_NODE || !this.hostile(u.owner, tg.owner)) { this.endAttack(u, o, false); break; }
        const isB = tg.kind === K_BLDG;
        const d = isB ? rectDist(u.x, u.y, tg) : Math.hypot(tg.x - u.x, tg.y - u.y) - tg.r;
        const reach = S.range > 0 ? S.range : isB ? 0.85 : u.r + MELEE_GAP;
        if (S.minRange > 0 && d < S.minRange) {
          // too close for artillery: automatic targets are dropped, explicit ones wait
          u.st = ST.IDLE; u.tgt = 0; u.path = null;
          if (o.auto) { u.ignoreId = tg.id; u.ignoreUntil = tick + 40; this.endAttack(u, o, false); }
          break;
        }
        if (d <= reach) {
          u.path = null; u.wantPath = false; u.st = ST.ATTACK; u.tgt = tg.id; o.pathed = false; o.fails = 0;
          if (Math.abs(tg.x - u.x) > 0.05) u.face = tg.x > u.x ? 1 : -1;
          if (u.cd <= 0) {
            this.strike(u, S, tg);
            u.cd = Math.max(2, Math.round(S.reload * u.bReload * TICK_RATE));
          }
        } else {
          if (o.auto && Math.hypot(u.x - o.gx, u.y - o.gy) > (o.resume ? 14 : 10)) { this.endAttack(u, o, true); break; }
          if (!isB && o.pathed && Math.hypot(tg.x - o.px, tg.y - o.py) > 0.8) o.pathed = false;   // target moved
          if (!o.pathed) { o.px = tg.x; o.py = tg.y; }
          u.tgt = tg.id;
          if (!this.approach(u, o, isB ? rectGoal(tg) : { x: tg.x, y: tg.y }, speed)) {
            u.ignoreId = tg.id; u.ignoreUntil = tick + 100;
            this.endAttack(u, o, false);
          }
        }
        break;
      }
      case 'gather': this.doGather(u, o, S, speed); break;
      case 'build': {
        const b = this.ents.get(o.id);
        if (!b || b.dead || b.kind !== K_BLDG || this.hostile(u.owner, b.owner)) { this.nextOrder(u); break; }
        if (b.done && b.hp >= b.S.hp) { this.afterBuild(u, o, b); break; }
        if (rectDist(u.x, u.y, b) <= REACH) {
          u.path = null; u.wantPath = false; u.st = ST.BUILD; u.tgt = b.id; o.pathed = false; o.fails = 0;
          if (Math.abs(b.x - u.x) > 0.05) u.face = b.x > u.x ? 1 : -1;
          b.builders++;
        } else { u.tgt = 0; if (!this.approach(u, o, rectGoal(b), speed)) this.nextOrder(u); }
        break;
      }
      case 'heal': {
        const tg = this.ents.get(o.id);
        if (!tg || tg.dead || tg.kind !== K_UNIT || tg.hp >= tg.S.hp || this.hostile(u.owner, tg.owner)) { this.nextOrder(u); break; }
        const d = Math.hypot(tg.x - u.x, tg.y - u.y) - tg.r;
        if (d <= S.range) {
          u.path = null; u.wantPath = false; u.st = ST.HEAL; u.tgt = tg.id; o.pathed = false; o.fails = 0;
          if (Math.abs(tg.x - u.x) > 0.05) u.face = tg.x > u.x ? 1 : -1;
          tg.hp = Math.min(tg.S.hp, tg.hp + S.heal * DT);
        } else {
          if (o.pathed && Math.hypot(tg.x - o.px, tg.y - o.py) > 0.8) o.pathed = false;
          if (!o.pathed) { o.px = tg.x; o.py = tg.y; }
          if (!this.approach(u, o, { x: tg.x, y: tg.y }, speed)) this.nextOrder(u);
        }
        break;
      }
      default: this.nextOrder(u);
    }
  }

  idleScan(u, S) {
    if (S.heal > 0) {
      const t = this.findWounded(u, 7);
      if (t) this.beginOrder(u, { t: 'heal', id: t.id, auto: true });
      return;
    }
    if (S.atk <= 0 || u.isCook) return;
    const tg = this.acquire(u, S);
    if (tg) this.beginOrder(u, { t: 'attack', id: tg.id, auto: true, gx: u.x, gy: u.y });
  }

  endAttack(u, o, leashed) {
    if (o.resume) { o.resume.go = 0; o.resume.tries = 0; this.beginOrder(u, o.resume); return; }
    if (o.auto && leashed) { this.beginOrder(u, { t: 'move', x: o.gx, y: o.gy }); return; }
    this.nextOrder(u);
  }

  /** Pick something to attack near u (enemy units first, then stations). */
  acquire(u, S) {
    const R = Math.max(S.sight, S.range + 1.5);
    const team = this.players[u.owner].team;
    const players = this.players, tick = this.tick;
    let best = null, bs = Infinity;
    if (!S.onlyBldg) {
      const list = this.near(u.x, u.y, R);
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.dead || players[v.owner].team === team) continue;
        if (v.id === u.ignoreId && tick < u.ignoreUntil) continue;
        const d = Math.hypot(v.x - u.x, v.y - u.y);
        if (d > R || (S.minRange > 0 && d - v.r < S.minRange)) continue;
        const score = d + (v.isCook ? 3 : 0);
        if (score < bs) { bs = score; best = v; }
      }
      if (best) return best;
    }
    for (const b of this.bldgs) {
      if (b.dead || players[b.owner].team === team) continue;
      if (b.id === u.ignoreId && tick < u.ignoreUntil) continue;
      const d = rectDist(u.x, u.y, b);
      if (d > R || (S.minRange > 0 && d < S.minRange)) continue;
      const score = d + (b.type === 'garden' ? 5 : 0) - (b.S.atk > 0 ? 1.5 : 0);
      if (score < bs) { bs = score; best = b; }
    }
    return best;
  }

  findWounded(u, R) {
    const team = this.players[u.owner].team;
    const list = this.near(u.x, u.y, R);
    let best = null, bs = Infinity;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v === u || v.dead || v.hp >= v.S.hp || this.players[v.owner].team !== team) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d > R) continue;
      const score = d + (v.hp / v.S.hp) * 4;
      if (score < bs) { bs = score; best = v; }
    }
    return best;
  }

  strike(u, S, tg) {
    const atk = S.atk * u.bAtk;
    if (S.proj) this.launch(u, S, tg, atk);
    else this.applyDamage(u.owner, u.id, tg, atk, S.bonus, false);
  }

  launch(src, S, tg, atk) {
    const dist = Math.hypot(tg.x - src.x, tg.y - src.y);
    const travel = Math.max(2, Math.round((dist / (PROJ_SPEED[S.proj] || 10)) * TICK_RATE));
    this.hits.push({ at: this.tick + travel, owner: src.owner, src: src.id, tid: tg.id, x: tg.x, y: tg.y, atk, bonus: S.bonus, splash: S.splash || 0 });
    this.events.push(['shot', src.id, tg.id, S.proj, travel, Math.round(tg.x * POS_Q), Math.round(tg.y * POS_Q)]);
  }

  resolveHits() {
    const tick = this.tick;
    const keep = [];
    for (const h of this.hits) {
      if (h.at > tick) { keep.push(h); continue; }
      if (h.splash > 0) {
        // lands where it was aimed, hurting every enemy in the blast
        const team = this.players[h.owner].team;
        const list = this.near(h.x, h.y, h.splash + 0.6).slice();
        for (const v of list) {
          if (v.dead || this.players[v.owner].team === team) continue;
          if (Math.hypot(v.x - h.x, v.y - h.y) - v.r <= h.splash) this.applyDamage(h.owner, h.src, v, h.atk, h.bonus, true);
        }
        for (const b of this.bldgs) {
          if (b.dead || this.players[b.owner].team === team) continue;
          if (rectDist(h.x, h.y, b) <= h.splash * 0.5) this.applyDamage(h.owner, h.src, b, h.atk, h.bonus, true);
        }
      } else {
        const tg = this.ents.get(h.tid);
        if (tg && !tg.dead && tg.hp > 0) this.applyDamage(h.owner, h.src, tg, h.atk, h.bonus, true);
      }
    }
    this.hits = keep;
  }

  applyDamage(owner, srcId, tg, atk, bonus, ranged) {
    if (tg.dead || tg.kind === K_NODE) return;
    const TS = tg.S, tags = TS.tags;
    let mult = 1;
    for (let i = 0; i < tags.length; i++) { const m = bonus[tags[i]]; if (m !== undefined) mult *= m; }
    let dmg = atk * mult - (ranged ? TS.parmor : TS.armor);
    if (dmg < 1) dmg = 1;
    if (tg.kind === K_UNIT) dmg *= tg.bDmg;
    tg.hp -= dmg; tg.lastHit = this.tick;
    if (tg.hp <= 0) { this.killEntity(tg, owner); return; }
    this.onDamaged(tg, srcId, owner);
  }

  onDamaged(tg, srcId, by) {
    const P = this.players[tg.owner];
    if (!P) return;
    const tick = this.tick;
    if (tick - P.lastAlert > 120) { P.lastAlert = tick; this.events.push(['alert', tg.owner, Math.round(tg.x), Math.round(tg.y), tg.kind]); }
    P.lastAttacked = { tick, x: tg.x, y: tg.y, by };
    // idle soldiers hit back
    if (tg.kind === K_UNIT && !tg.order && tg.S.atk > 0 && !tg.isCook) {
      const src = this.ents.get(srcId);
      if (src && !src.dead && (!tg.S.onlyBldg || src.kind === K_BLDG) && Math.hypot(src.x - tg.x, src.y - tg.y) < 12) {
        this.beginOrder(tg, { t: 'attack', id: src.id, auto: true, gx: tg.x, gy: tg.y });
      }
    }
  }

  killEntity(e, killer) {
    if (e.dead) return;
    e.dead = true; e.hp = 0; e.killer = killer ?? -1;
    this.deadList.push(e);
  }

  // --------------------------------------------------------------- gathering
  gatherOrder(e) {
    if (e.kind === K_NODE) return { t: 'gather', nid: e.id, ntype: e.type, tree: -1, gid: 0, res: NODES[e.type].res, phase: 0, ox: e.x, oy: e.y };
    return { t: 'gather', nid: 0, tree: -1, gid: e.id, res: 'food', phase: 0, ox: e.x, oy: e.y, jx: (Math.random() - 0.5) * 0.9, jy: (Math.random() - 0.5) * 0.9 };
  }
  treeOrder(idx) {
    return { t: 'gather', nid: 0, tree: idx, gid: 0, res: 'wood', phase: 0, ox: (idx % this.w) + 0.5, oy: ((idx / this.w) | 0) + 0.5 };
  }
  gardenBusy(g) {
    if (!g.worker) return false;
    const wk = this.ents.get(g.worker);
    return !!(wk && !wk.dead && wk.order && wk.order.t === 'gather' && wk.order.gid === g.id);
  }

  doGather(u, o, S, speed) {
    const P = this.players[u.owner];
    if (o.phase === 2) {                       // walking back with a full basket
      let d = this.ents.get(o.drop);
      if (!d || d.dead || !d.done) {
        d = this.findDropoff(u);
        if (!d) { this.nextOrder(u); return; }
        o.drop = d.id; o.pathed = false; o.fails = 0;
      }
      u.tgt = 0;
      if (rectDist(u.x, u.y, d) <= REACH) {
        if (u.carryAmt > 0) { P.res[u.carryType] += u.carryAmt; P.score.gathered += u.carryAmt; u.carryAmt = 0; }
        if (o.last) { this.nextOrder(u); return; }
        o.phase = 0; o.pathed = false; o.fails = 0; u.repathAt = 0;
      } else if (!this.approach(u, o, rectGoal(d), speed)) this.nextOrder(u);
      return;
    }

    // what are we harvesting, and are we next to it?
    let node = null, goal, inReach, tid = 0, fx;
    if (o.gid) {
      const g = this.ents.get(o.gid);
      if (!g || g.dead || !g.done || g.owner !== u.owner || (g.worker !== u.id && this.gardenBusy(g))) { this.retarget(u, o); return; }
      g.worker = u.id; node = g; tid = g.id; fx = g.x;
      inReach = Math.abs(u.x - g.x) < 0.8 && Math.abs(u.y - g.y) < 0.8;
      goal = { x: g.x + o.jx, y: g.y + o.jy };
    } else if (o.nid) {
      node = this.ents.get(o.nid);
      if (!node || node.dead || node.amount <= 0) { this.retarget(u, o); return; }
      tid = node.id; fx = node.x;
      inReach = rectDist(u.x, u.y, node) <= REACH;
      goal = rectGoal(node);
    } else {
      if (this.tiles[o.tree] !== TILE.TREE) { this.retarget(u, o); return; }
      const tx = o.tree % this.w, ty = (o.tree / this.w) | 0;
      fx = tx + 0.5;
      const dx = u.x < tx ? tx - u.x : u.x > tx + 1 ? u.x - tx - 1 : 0;
      const dy = u.y < ty ? ty - u.y : u.y > ty + 1 ? u.y - ty - 1 : 0;
      inReach = Math.hypot(dx, dy) <= REACH;
      goal = { rect: [tx, ty, tx, ty] };
    }
    if (!inReach) {
      u.tgt = 0;
      if (!this.approach(u, o, goal, speed)) this.nextOrder(u);
      return;
    }

    u.path = null; u.wantPath = false; u.st = ST.GATHER; u.tgt = tid; o.pathed = false; o.fails = 0;
    if (Math.abs(fx - u.x) > 0.05) u.face = fx > u.x ? 1 : -1;
    if (u.carryType !== o.res) { u.carryType = o.res; u.carryAmt = 0; }
    if (u.carryAmt >= S.carry) { this.startDrop(u, o); return; }
    u.gAcc += S.gather[o.gid ? 'garden' : o.res] * u.bGather * P.gatherBonus * DT;
    if (u.gAcc >= 1) {
      u.gAcc -= 1; u.carryAmt++;
      if (o.nid) { if (--node.amount <= 0) this.killEntity(node, -1); }
      else if (!o.gid) { if (--this.treeWood[o.tree] <= 0) this.fellTree(o.tree); }
      if (u.carryAmt >= S.carry) this.startDrop(u, o);
    }
  }

  startDrop(u, o) {
    const d = this.findDropoff(u);
    if (!d) { this.nextOrder(u); return; }
    o.phase = 2; o.drop = d.id; o.pathed = false; o.fails = 0; u.repathAt = 0;
  }

  findDropoff(u) {
    const list = this.players[u.owner].dropoffs;
    let best = null, bd = Infinity;
    for (const b of list) {
      if (b.dead) continue;
      const d = rectDist(u.x, u.y, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** The thing being harvested ran out: find more of the same nearby, or finish up. */
  retarget(u, o) {
    let found = false;
    if (o.gid) {
      const g = this.findGarden(u, o.ox, o.oy, 12, null);
      if (g) { o.gid = g.id; g.worker = u.id; o.ox = g.x; o.oy = g.y; found = true; }
    } else if (o.nid) {
      const n = this.findNode(o.ntype, o.ox, o.oy, 9);
      if (n) { o.nid = n.id; o.ox = n.x; o.oy = n.y; found = true; }
      else if (o.res === 'food') {
        const g = this.findGarden(u, o.ox, o.oy, 14, null);
        if (g) { o.nid = 0; o.gid = g.id; g.worker = u.id; o.ox = g.x; o.oy = g.y; o.jx = (Math.random() - 0.5) * 0.9; o.jy = (Math.random() - 0.5) * 0.9; found = true; }
      }
    } else {
      const t = this.findTree(o.ox, o.oy, 8);
      if (t >= 0) { o.tree = t; o.ox = (t % this.w) + 0.5; o.oy = ((t / this.w) | 0) + 0.5; found = true; }
    }
    if (found) { o.pathed = false; o.fails = 0; u.repathAt = 0; return; }
    if (u.carryAmt > 0) { o.last = true; this.startDrop(u, o); return; }
    this.nextOrder(u);
  }

  findNode(type, x, y, R) {
    let best = null, bd = R;
    for (const n of this.nodes) {
      if (n.dead || n.type !== type || n.amount <= 0) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  findGarden(u, x, y, R, exclude) {
    let best = null, bd = R;
    for (const b of this.bldgs) {
      if (b.dead || b.type !== 'garden' || b.owner !== u.owner || !b.done) continue;
      if (exclude && exclude.has(b.id)) continue;
      if (b.worker !== u.id && this.gardenBusy(b)) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  /** Nearest tree tile to (ox,oy) that has an open side. Returns tile index or -1. */
  findTree(ox, oy, R) {
    const w = this.w, h = this.h, tiles = this.tiles, block = this.block;
    const cx = ox | 0, cy = oy | 0;
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
        const i = y * w + x;
        if (tiles[i] !== TILE.TREE) continue;
        const d = (x + 0.5 - ox) * (x + 0.5 - ox) + (y + 0.5 - oy) * (y + 0.5 - oy);
        if (d >= bd) continue;
        if ((x > 0 && !block[i - 1]) || (x < w - 1 && !block[i + 1]) || (y > 0 && !block[i - w]) || (y < h - 1 && !block[i + w])) { bd = d; best = i; }
      }
    }
    return best;
  }
  /** Up to `count` reachable tree tiles around idx, nearest first (so a group spreads over a grove). */
  treesNear(idx, count) {
    const w = this.w, h = this.h, tiles = this.tiles, block = this.block;
    const cx = idx % w, cy = (idx / w) | 0, R = 4;
    const out = [];
    for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
        const i = y * w + x;
        if (tiles[i] !== TILE.TREE) continue;
        if ((x > 0 && !block[i - 1]) || (x < w - 1 && !block[i + 1]) || (y > 0 && !block[i - w]) || (y < h - 1 && !block[i + w])) {
          out.push([i, (x - cx) * (x - cx) + (y - cy) * (y - cy)]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    const res = out.slice(0, Math.max(1, count)).map((a) => a[0]);
    return res.length ? res : [idx];
  }
  fellTree(idx) {
    this.tiles[idx] = TILE.STUMP; this.block[idx] = 0; this.treeWood[idx] = 0;
    this.tileChanges.push(idx, TILE.STUMP);
  }
  /** A gather order for whatever resource is closest to (x,y), or null. */
  nearestResource(x, y, R) {
    let order = null, bd = R;
    for (const n of this.nodes) {
      if (n.dead) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; order = this.gatherOrder(n); }
    }
    const t = this.findTree(x, y, Math.ceil(R));
    if (t >= 0) {
      const d = Math.hypot((t % this.w) + 0.5 - x, ((t / this.w) | 0) + 0.5 - y);
      if (d < bd) order = this.treeOrder(t);
    }
    return order;
  }

  afterBuild(u, o, b) {
    if (u.queue.length || o.rep) { this.nextOrder(u); return; }
    if (b.owner === u.owner) {
      if (b.type === 'garden' && !this.gardenBusy(b)) { this.beginOrder(u, this.gatherOrder(b)); return; }
      if (b.S.dropoff && b.type !== 'hq') {
        const g = this.nearestResource(b.x, b.y, 7);
        if (g) { this.beginOrder(u, g); return; }
      }
    }
    let best = null, bd = 14;
    for (const x of this.bldgs) {
      if (x.dead || x.done || x.owner !== u.owner) continue;
      const d = Math.hypot(x.x - u.x, x.y - u.y);
      if (d < bd) { bd = d; best = x; }
    }
    if (best) this.beginOrder(u, { t: 'build', id: best.id });
    else this.nextOrder(u);
  }

  /** Soft collisions: overlapping units nudge each other apart. */
  separate() {
    const w = this.w, h = this.h, cells = this.cells, block = this.block;
    const maxX = w - 0.3, maxY = h - 0.3;
    for (const u of this.units) {
      if (u.dead) continue;
      const st = u.st, ot = u.order ? u.order.t : '';
      // workers on a job hold their spot and slip past each other, so a busy
      // veggie patch or tree line can never wall anyone out
      if (st === ST.GATHER || st === ST.BUILD || ot === 'gather' || ot === 'build') continue;
      const cx = u.x | 0, cy = u.y | 0;
      let ax = 0, ay = 0;
      for (let yy = cy - 1; yy <= cy + 1; yy++) {
        if (yy < 0 || yy >= h) continue;
        for (let xx = cx - 1; xx <= cx + 1; xx++) {
          if (xx < 0 || xx >= w) continue;
          const c = cells[yy * w + xx];
          for (let i = 0; i < c.length; i++) {
            const v = c[i];
            if (v === u || v.dead) continue;
            const min = u.r + v.r;
            const dx = u.x - v.x, dy = u.y - v.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            if (d2 < 1e-6) { const a = (u.id * 2.399963) % 6.2832; ax += Math.cos(a) * 0.1; ay += Math.sin(a) * 0.1; continue; }
            const d = Math.sqrt(d2), push = (min - d) / d;
            ax += dx * push; ay += dy * push;
          }
        }
      }
      if (ax === 0 && ay === 0) continue;
      const k = st === ST.ATTACK || st === ST.HEAL ? 0.08 : st === ST.MOVE ? 0.15 : 0.35;
      ax *= k; ay *= k;
      if (st === ST.MOVE) {
        // a walking unit is never shoved back by more than half its stride, so crowds slow it but cannot stop it
        const lim = u.S.speed * u.bSpeed * DT * 0.5, len = Math.sqrt(ax * ax + ay * ay);
        if (len > lim) { ax *= lim / len; ay *= lim / len; }
      }
      let nx = u.x + ax, ny = u.y + ay;
      nx = nx < 0.3 ? 0.3 : nx > maxX ? maxX : nx;
      ny = ny < 0.3 ? 0.3 : ny > maxY ? maxY : ny;
      if (!block[(ny | 0) * w + (nx | 0)]) { u.x = nx; u.y = ny; }
      else if (!block[(u.y | 0) * w + (nx | 0)]) u.x = nx;
      else if (!block[(ny | 0) * w + (u.x | 0)]) u.y = ny;
    }
  }

  // ==========================================================================
  //  Buildings
  // ==========================================================================
  updateBuilding(b) {
    const S = b.S, P = this.players[b.owner], tick = this.tick;
    if (!b.done) {
      if (b.builders > 0) {
        const rate = ((b.builders + 2) / 3) * P.stats.misc.buildMul / S.time;
        b.prog += rate * DT;
        b.hp = Math.min(S.hp, b.hp + rate * DT * S.hp);
        if (b.prog >= 1) this.completeBuilding(b);
      }
      b.builders = 0;
      return;
    }
    if (b.builders > 0) {
      if (b.hp < S.hp) b.hp = Math.min(S.hp, b.hp + (S.hp * DT * (b.builders + 2)) / (3 * S.time * 1.5));
      b.builders = 0;
    }

    // production queue
    if (b.q.length) {
      const it = b.q[0];
      if (it.t < it.total) it.t = Math.min(it.total, it.t + DT * (tick < P.lunchUntil ? 3 : 1));
      if (it.t >= it.total) {
        if (it.k === 'u') {
          const US = P.stats.units[it.key];
          if (P.pop + US.pop <= P.popCap) { b.q.shift(); this.spawnFrom(b, it.key); P.score.trained++; }
          else if (tick - P.popNote > 240) { P.popNote = tick; this.events.push(['note', P.idx, P.popCap >= P.maxPop ? 'popmax' : 'pop']); }
        } else { b.q.shift(); this.completeTech(P, it.key); }
      }
    }

    // defensive fire
    if (S.atk > 0) {
      if (b.cd > 0) b.cd--;
      let tg = b.tgt ? this.ents.get(b.tgt) : null;
      if (tg && (tg.dead || tg.hp <= 0 || rectDist(tg.x, tg.y, b) > S.range + 0.5)) tg = null;
      if (!tg && (tick + b.id) % 6 === 0) tg = this.acquireForBuilding(b, S);
      b.tgt = tg ? tg.id : 0;
      if (tg && b.cd <= 0) { this.launch(b, S, tg, S.atk); b.cd = Math.round(S.reload * TICK_RATE); }
    }
  }

  acquireForBuilding(b, S) {
    const team = this.players[b.owner].team;
    const list = this.near(b.x, b.y, S.range + b.size / 2 + 0.5);
    let best = null, bd = S.range;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.dead || this.players[v.owner].team === team) continue;
      const d = rectDist(v.x, v.y, b);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  /** Free tile on the ring around a station, closest to (tx,ty). */
  spawnPoint(b, tx, ty) {
    const w = this.w, h = this.h;
    let best = null, bd = Infinity;
    for (let ring = 1; ring <= 5 && !best; ring++) {
      const x0 = b.tx - ring, y0 = b.ty - ring, x1 = b.tx + b.size - 1 + ring, y1 = b.ty + b.size - 1 + ring;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
        if (x < 0 || y < 0 || x >= w || y >= h || this.block[y * w + x]) continue;
        const d = (x + 0.5 - tx) * (x + 0.5 - tx) + (y + 0.5 - ty) * (y + 0.5 - ty);
        if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; }
      }
    }
    return best || [b.x, b.y + b.size / 2 + 0.5];
  }

  spawnFrom(b, key) {
    const r = b.rally;
    const pt = this.spawnPoint(b, r ? r.x : b.x, r ? r.y : b.y + b.size);
    const u = this.spawnUnit(b.owner, key, pt[0], pt[1]);
    if (!r) return u;
    let order = null;
    if (u.isCook) {
      if (r.tid) {
        const e = this.ents.get(r.tid);
        if (e && !e.dead) {
          if (e.kind === K_NODE) order = this.gatherOrder(e);
          else if (e.kind === K_BLDG && e.owner === u.owner) {
            if (!e.done) order = { t: 'build', id: e.id };
            else if (e.type === 'garden') order = this.gatherOrder(e);
          }
        } else if (r.ntype) {
          const n = this.findNode(r.ntype, r.x, r.y, 9);
          if (n) order = this.gatherOrder(n);
        }
      } else if (r.tree >= 0) {
        const t = this.tiles[r.tree] === TILE.TREE ? r.tree : this.findTree(r.x, r.y, 8);
        if (t >= 0) order = this.treeOrder(t);
      }
    }
    this.beginOrder(u, order || { t: 'move', x: r.x, y: r.y });
    return u;
  }

  completeTech(P, key) {
    const T = TECHS[key];
    P.pending.delete(key);
    P.techs.push(key);
    if (T.setAge) { P.age = T.setAge; this.events.push(['age', P.idx, P.age]); }
    else this.events.push(['tech', P.idx, key]);
    this.recomputeStats(P);
  }

  recomputeStats(P) {
    P.stats = computeStats(P.commander, P.age, P.techs);
    for (const u of this.units) {
      if (u.owner !== P.idx || u.dead) continue;
      const old = u.S.hp;
      u.S = P.stats.units[u.type];
      if (u.S.hp > old) u.hp += u.S.hp - old; else if (u.hp > u.S.hp) u.hp = u.S.hp;
    }
    for (const b of this.bldgs) {
      if (b.owner !== P.idx || b.dead) continue;
      const old = b.S.hp;
      b.S = P.stats.bldgs[b.type];
      if (b.S.hp > old) { if (b.done) b.hp += b.S.hp - old; } else if (b.hp > b.S.hp) b.hp = b.S.hp;
    }
    this.refreshBuildings(P);
  }

  // ==========================================================================
  //  Buffs, heroes, abilities
  // ==========================================================================
  updateBuffs(regen) {
    const tick = this.tick;
    for (const P of this.players) {
      if (!P.alive || !P.heroId) continue;
      const hero = this.ents.get(P.heroId);
      if (!hero || hero.dead) continue;
      const key = COMMANDERS[P.commander].aura.key;
      const list = this.near(hero.x, hero.y, AURA_RADIUS);
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.owner !== P.idx || v.dead || Math.hypot(v.x - hero.x, v.y - hero.y) > AURA_RADIUS) continue;
        (v.buffs || (v.buffs = {}))[key] = tick + 8;
      }
    }
    for (const u of this.units) {
      if (u.dead) continue;
      let atk = 1, rel = 1, spd = 1, dmg = 1, gat = 1, heal = 0, mask = 0;
      const bf = u.buffs;
      if (bf) {
        let any = false;
        for (const k in bf) {
          if (bf[k] <= tick) { delete bf[k]; continue; }
          any = true;
          const B = BUFFS[k];
          mask |= B.bit;
          if (B.atkMul) atk *= B.atkMul;
          if (B.reloadMul) rel *= B.reloadMul;
          if (B.speedMul) spd *= B.speedMul;
          if (B.dmgTakenMul) dmg *= B.dmgTakenMul;
          if (B.gatherMul) gat *= B.gatherMul;
          if (B.regen) heal += B.regen;
          if (B.regenFrac) heal += B.regenFrac * u.S.hp;
        }
        if (!any) u.buffs = null;
      }
      u.bAtk = atk; u.bReload = rel; u.bSpeed = spd; u.bDmg = dmg; u.bGather = gat; u.bmask = mask;
      if (!regen) continue;
      if (u.isHero && tick - u.lastHit > 6 * TICK_RATE) heal += 2;
      if (heal > 0 && u.hp < u.S.hp) u.hp = Math.min(u.S.hp, u.hp + heal * 0.25);
    }
  }

  addBuff(u, key, seconds) {
    (u.buffs || (u.buffs = {}))[key] = this.tick + Math.round(seconds * TICK_RATE);
  }

  updateHeroes() {
    for (const P of this.players) {
      if (!P.alive || P.heroId || !P.heroRespawn || this.tick < P.heroRespawn) continue;
      let home = null;
      for (const b of this.bldgs) {
        if (b.dead || !b.done || b.owner !== P.idx || b.type === 'garden') continue;
        if (b.type === 'hq') { home = b; break; }
        if (!home) home = b;
      }
      if (!home) continue;
      const pt = this.spawnPoint(home, home.x, home.y + home.size);
      this.spawnUnit(P.idx, COMMANDERS[P.commander].hero, pt[0], pt[1]);
      P.heroRespawn = 0;
      this.events.push(['heroup', P.idx]);
    }
  }

  useAbility(P) {
    const A = COMMANDERS[P.commander].ability;
    const hero = P.heroId ? this.ents.get(P.heroId) : null;
    if (!hero || hero.dead || this.tick < P.abilityReady) return false;
    P.abilityReady = this.tick + A.cd * TICK_RATE;
    switch (A.key) {
      case 'service': case 'mangia': case 'lowslow': {
        const list = this.near(hero.x, hero.y, A.radius);
        for (const v of list) {
          if (v.owner === P.idx && !v.dead && Math.hypot(v.x - hero.x, v.y - hero.y) <= A.radius) this.addBuff(v, A.key, A.dur);
        }
        break;
      }
      case 'cuts': {
        const dmg = A.dmg + A.dmgPerAge * (P.age - 1);
        const list = this.near(hero.x, hero.y, A.radius).slice();
        for (const v of list) {
          if (v.dead || !this.hostile(P.idx, v.owner)) continue;
          if (Math.hypot(v.x - hero.x, v.y - hero.y) - v.r <= A.radius) this.applyDamage(P.idx, hero.id, v, dmg + v.S.armor, {}, false);
        }
        break;
      }
      case 'sugar':
        for (const u of this.units) if (u.owner === P.idx && !u.dead) this.addBuff(u, 'sugar', A.dur);
        break;
      case 'lunch':
        P.lunchUntil = this.tick + A.dur * TICK_RATE;
        break;
    }
    this.updateBuffs(false);
    this.events.push(['ability', P.idx, A.key, Math.round(hero.x * POS_Q), Math.round(hero.y * POS_Q)]);
    return true;
  }

  // ==========================================================================
  //  Deaths, elimination, victory
  // ==========================================================================
  freeTiles(e) {
    for (let y = e.ty; y < e.ty + e.size; y++) for (let x = e.tx; x < e.tx + e.size; x++) {
      const i = y * this.w + x;
      if (this.occ[i] === e.id) { this.occ[i] = 0; this.block[i] = 0; }
    }
  }

  cleanup() {
    const dl = this.deadList;
    if (!dl.length) return;
    let du = false, db = false, dn = false;
    for (let i = 0; i < dl.length; i++) {
      const e = dl[i];
      this.ents.delete(e.id);
      this.removed.push(e.id);
      const P = this.players[e.owner], K = this.players[e.killer];
      if (e.kind === K_UNIT) {
        du = true;
        this.leaveOrder(e);
        P.pop -= e.S.pop;
        if (K && K !== P) {
          K.score.kills++; P.score.lost++;
          if (K.commander === 'zara' && K.heroId) {
            const hero = this.ents.get(K.heroId);
            if (hero && !hero.dead && Math.hypot(hero.x - e.x, hero.y - e.y) <= AURA_RADIUS) {
              K.res.spice += ZARA_TIP;
              this.events.push(['tip', K.idx, Math.round(e.x * POS_Q), Math.round(e.y * POS_Q)]);
            }
          }
        }
        if (e.isHero) {
          P.heroId = 0;
          P.heroRespawn = this.tick + HERO_RESPAWN[P.age] * TICK_RATE;
          this.events.push(['herodown', P.idx, K ? K.idx : -1]);
        }
      } else if (e.kind === K_BLDG) {
        db = true;
        this.freeTiles(e);
        for (const it of e.q) if (it.k === 't') P.pending.delete(it.key);
        if (K && K !== P) { K.score.razed++; P.score.bldgLost++; }
      } else {
        dn = true;
        this.freeTiles(e);
      }
    }
    dl.length = 0;
    if (du) this.units = this.units.filter(isAlive);
    if (dn) this.nodes = this.nodes.filter(isAlive);
    if (db) {
      this.bldgs = this.bldgs.filter(isAlive);
      for (const P of this.players) this.refreshBuildings(P);
    }
  }

  eliminate(P) {
    if (!P.alive) return;
    P.alive = false;
    this.events.push(['elim', P.idx]);
    for (const e of this.ents.values()) if (e.owner === P.idx && !e.dead) this.killEntity(e, -1);
  }

  checkVictory() {
    if (this.over) return;
    for (const P of this.players) {
      if (!P.alive) continue;
      // 'hq' (default): you are out when your last finished Kitchen HQ falls.
      // 'conquest': you are out when every station (gardens aside) is gone.
      const hqOnly = this.opts.victory !== 'conquest';
      let has = false;
      for (const b of this.bldgs) {
        if (b.dead || b.owner !== P.idx) continue;
        if (hqOnly ? b.type === 'hq' && b.done : b.type !== 'garden') { has = true; break; }
      }
      if (!has) this.eliminate(P);
    }
    if (this.teamsAtStart < 2) return;
    const teams = new Set();
    for (const P of this.players) if (P.alive) teams.add(P.team);
    if (teams.size <= 1) {
      this.over = { team: teams.size ? [...teams][0] : -1, tick: this.tick };
      this.events.push(['over', this.over.team]);
    }
  }

  // ==========================================================================
  //  Player commands (everything a client or bot can ask for)
  // ==========================================================================
  ownUnits(pi, ids) {
    const out = [];
    if (!Array.isArray(ids)) return out;
    for (let i = 0; i < ids.length && i < 400; i++) {
      const e = this.ents.get(ids[i]);
      if (e && e.kind === K_UNIT && e.owner === pi && !e.dead) out.push(e);
    }
    return out;
  }
  ownBldg(pi, id) {
    const e = this.ents.get(id);
    return e && e.kind === K_BLDG && e.owner === pi && !e.dead ? e : null;
  }
  canAfford(P, cost) {
    for (const r in cost) if (P.res[r] < cost[r]) return false;
    return true;
  }
  pay(P, cost) {
    if (!this.canAfford(P, cost)) return false;
    for (const r in cost) P.res[r] -= cost[r];
    return true;
  }
  refund(P, cost, frac = 1) {
    for (const r in cost) P.res[r] += Math.floor(cost[r] * frac);
  }
  canPlace(type, tx, ty) {
    const S = BUILDINGS[type];
    if (!S) return false;
    const n = S.size;
    if (!(tx >= 0 && ty >= 0 && tx + n <= this.w && ty + n <= this.h)) return false;
    for (let y = ty; y < ty + n; y++) for (let x = tx; x < tx + n; x++) {
      const i = y * this.w + x, t = this.tiles[i];
      if ((t !== TILE.GRASS && t !== TILE.STUMP) || this.occ[i]) return false;
    }
    return true;
  }

  groupMove(units, x, y, type, q) {
    const n = units.length;
    if (!n) return;
    const cl = (v, max) => (v < 0.5 ? 0.5 : v > max - 0.5 ? max - 0.5 : v);
    x = cl(x, this.w); y = cl(y, this.h);
    const kind = (u) => (type === 'amove' && !(u.S.atk > 0) ? 'move' : type);
    if (n === 1) { this.setOrder(units[0], { t: kind(units[0]), x, y }, q); return; }
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x; cy += u.y; }
    cx /= n; cy /= n;
    let rad = 0;
    for (const u of units) rad = Math.max(rad, Math.hypot(u.x - cx, u.y - cy));
    const maxR = 0.55 * Math.sqrt(n) + 0.4;
    const k = rad > maxR ? maxR / rad : 1;
    for (const u of units) this.setOrder(u, { t: kind(u), x: cl(x + (u.x - cx) * k, this.w), y: cl(y + (u.y - cy) * k, this.h) }, q);
  }

  command(pi, c) {
    const P = this.players[pi];
    if (!P || !P.alive || this.over || !c || typeof c !== 'object') return;
    const q = !!c.q;
    switch (c.c) {
      case 'mv': case 'am':
        if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
        this.groupMove(this.ownUnits(pi, c.ids), c.x, c.y, c.c === 'mv' ? 'move' : 'amove', q);
        break;

      case 'at': {
        const tg = this.ents.get(c.tid);
        if (!tg || tg.dead || tg.kind === K_NODE || !this.hostile(pi, tg.owner)) return;
        for (const u of this.ownUnits(pi, c.ids)) {
          if (u.S.atk > 0 && (!u.S.onlyBldg || tg.kind === K_BLDG)) this.setOrder(u, { t: 'attack', id: tg.id }, q);
          else this.setOrder(u, { t: 'move', x: tg.x, y: tg.y }, q);
        }
        break;
      }

      case 'hl': {
        const tg = this.ents.get(c.tid);
        if (!tg || tg.dead || tg.kind !== K_UNIT || this.hostile(pi, tg.owner)) return;
        for (const u of this.ownUnits(pi, c.ids)) {
          if (u.S.heal > 0 && u !== tg) this.setOrder(u, { t: 'heal', id: tg.id }, q);
        }
        break;
      }

      case 'ga': {
        const cooks = this.ownUnits(pi, c.ids).filter((u) => u.isCook);
        if (!cooks.length) return;
        if (c.tree !== undefined) {
          const idx = c.tree | 0;
          if (idx < 0 || idx >= this.tiles.length || this.tiles[idx] !== TILE.TREE) return;
          const trees = this.treesNear(idx, Math.ceil(cooks.length / 2));
          cooks.forEach((u, i) => this.setOrder(u, this.treeOrder(trees[((i / 2) | 0) % trees.length]), q));
          return;
        }
        const e = this.ents.get(c.tid);
        if (!e || e.dead) return;
        if (e.kind === K_NODE) { for (const u of cooks) this.setOrder(u, this.gatherOrder(e), q); return; }
        if (e.kind !== K_BLDG || e.type !== 'garden' || e.owner !== pi) return;
        if (!e.done) { for (const u of cooks) this.setOrder(u, { t: 'build', id: e.id }, q); return; }
        const taken = new Set();
        for (const u of cooks) {
          const g = !taken.has(e.id) && (e.worker === u.id || !this.gardenBusy(e)) ? e : this.findGarden(u, e.x, e.y, 12, taken);
          if (!g) continue;
          taken.add(g.id);
          this.setOrder(u, this.gatherOrder(g), q);
          if (!q || u.order.gid === g.id) g.worker = u.id;
        }
        break;
      }

      case 'bp': {
        const S = P.stats.bldgs[c.b];
        if (!S || S.age > P.age) return;
        const tx = c.tx | 0, ty = c.ty | 0;
        if (!this.canPlace(c.b, tx, ty)) { this.events.push(['note', pi, 'place']); return; }
        if (!this.pay(P, S.cost)) { this.events.push(['note', pi, 'res']); return; }
        const b = this.addBuilding(pi, c.b, tx, ty, false);
        b.paid = { ...S.cost };
        for (const u of this.ownUnits(pi, c.ids)) if (u.isCook) this.setOrder(u, { t: 'build', id: b.id }, q);
        break;
      }

      case 'ba': {
        const b = this.ents.get(c.tid);
        if (!b || b.dead || b.kind !== K_BLDG || this.hostile(pi, b.owner)) return;
        for (const u of this.ownUnits(pi, c.ids)) if (u.isCook) this.setOrder(u, { t: 'build', id: b.id, rep: b.done }, q);
        break;
      }

      case 'tr': {
        const b = this.ownBldg(pi, c.bid);
        if (!b || !b.done) return;
        const n = Math.max(1, Math.min(5, c.n | 0));
        for (let i = 0; i < n; i++) if (!this.cmdTrain(P, b, c.u)) break;
        break;
      }

      case 'rs': {
        const b = this.ownBldg(pi, c.bid);
        if (b && b.done) this.cmdResearch(P, b, c.tech);
        break;
      }

      case 'cq': {
        const b = this.ownBldg(pi, c.bid);
        if (!b) return;
        const i = c.i | 0;
        const it = b.q[i];
        if (!it) return;
        b.q.splice(i, 1);
        this.refund(P, it.cost);
        if (it.k === 't') P.pending.delete(it.key);
        break;
      }

      case 'ry': {
        if (!Array.isArray(c.bids) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
        const tgt = c.tid ? this.ents.get(c.tid) : null;
        for (let i = 0; i < c.bids.length && i < 60; i++) {
          const b = this.ownBldg(pi, c.bids[i]);
          if (!b) continue;
          b.rally = {
            x: Math.max(0.5, Math.min(this.w - 0.5, c.x)), y: Math.max(0.5, Math.min(this.h - 0.5, c.y)),
            tid: tgt ? tgt.id : 0, ntype: tgt && tgt.kind === K_NODE ? tgt.type : null,
            tree: c.tree === undefined ? -1 : c.tree | 0,
          };
        }
        break;
      }

      case 'st':
        for (const u of this.ownUnits(pi, c.ids)) { u.queue.length = 0; this.beginOrder(u, null); }
        break;

      case 'dl': {
        if (!Array.isArray(c.ids)) return;
        for (let i = 0; i < c.ids.length && i < 200; i++) {
          const e = this.ents.get(c.ids[i]);
          if (!e || e.dead || e.owner !== pi || e.isHero) continue;
          if (e.kind === K_BLDG) {
            if (!e.done && e.paid) this.refund(P, e.paid, 1 - e.prog);
            for (const it of e.q) this.refund(P, it.cost);
          }
          this.killEntity(e, -1);
        }
        break;
      }

      case 'ab': this.useAbility(P); break;
      case 'rg': this.eliminate(P); this.checkVictory(); break;
    }
  }

  cmdTrain(P, b, key) {
    if (b.q.length >= 10) return false;
    if (!trainList(b.type, P.commander).includes(key)) return false;
    const US = P.stats.units[key];
    if (!US || US.age > P.age) return false;
    if (!this.pay(P, US.cost)) { this.events.push(['note', P.idx, 'res']); return false; }
    b.q.push({ k: 'u', key, t: 0, total: US.time * P.stats.misc.trainMul, cost: { ...US.cost } });
    return true;
  }

  cmdResearch(P, b, key) {
    const T = TECHS[key];
    if (!T || !b.S.techs.includes(key) || b.q.length >= 10) return false;
    if (P.techs.includes(key) || P.pending.has(key)) return false;
    if (T.setAge ? P.age !== T.setAge - 1 : T.age > P.age) return false;
    if (T.req && !P.techs.includes(T.req)) return false;
    const cost = techCost(key, P.stats.misc);
    if (!this.pay(P, cost)) { this.events.push(['note', P.idx, 'res']); return false; }
    P.pending.add(key);
    b.q.push({ k: 't', key, t: 0, total: techTime(key, P.stats.misc), cost });
    return true;
  }

  // ==========================================================================
  //  Network state
  // ==========================================================================
  unitRec(u) {
    return [u.id, 0, u.type, u.owner, u._qx, u._qy, u._hp, u.st, u.tgt, u._carry, u.bmask];
  }
  bldgRec(b) {
    const q = b.q;
    return [
      b.id, 1, b.type, b.owner, b.tx, b.ty, Math.ceil(b.hp),
      b.done ? 100 : Math.min(99, Math.floor(b.prog * 100)),
      q.length ? Math.floor((q[0].t / q[0].total) * 100) : 0,
      q.map((it) => it.k + it.key),
      b.rally ? [Math.round(b.rally.x * POS_Q), Math.round(b.rally.y * POS_Q)] : 0,
    ];
  }
  nodeRec(n) { return [n.id, 2, n.type, -1, n.tx, n.ty, n.amount]; }
  playerRec(P) {
    return [
      P.idx, Math.floor(P.res.food), Math.floor(P.res.wood), Math.floor(P.res.spice), Math.floor(P.res.salt),
      P.pop, P.popCap, P.age, P.techs, P.alive ? 1 : 0, P.heroId, P.heroRespawn, P.abilityReady, P.lunchUntil,
      [...P.pending], P.score.kills, P.score.lost, P.score.razed,
    ];
  }

  /** Everything that changed since the previous call. Call once per broadcast. */
  delta() {
    const e = [], m = [];
    for (const u of this.units) {
      const hp = Math.ceil(u.hp), carry = u.carryAmt > 0 ? RES.indexOf(u.carryType) + 1 : 0;
      const qx = Math.round(u.x * POS_Q), qy = Math.round(u.y * POS_Q);
      const moved = qx !== u._qx || qy !== u._qy;
      u._qx = qx; u._qy = qy;
      if (u._new || hp !== u._hp || u.st !== u._st || u.tgt !== u._tgt || carry !== u._carry || u.bmask !== u._bm) {
        u._new = false; u._hp = hp; u._st = u.st; u._tgt = u.tgt; u._carry = carry; u._bm = u.bmask;
        e.push(this.unitRec(u));
      } else if (moved) m.push(u.id, qx, qy);
    }
    for (const b of this.bldgs) {
      const rec = this.bldgRec(b), s = JSON.stringify(rec);
      if (s !== b._sig) { b._sig = s; e.push(rec); }
    }
    for (const n of this.nodes) {
      if (n.amount !== n._amt) { n._amt = n.amount; e.push(this.nodeRec(n)); }
    }
    const out = { t: 's', k: this.tick };
    if (e.length) out.e = e;
    if (m.length) out.m = m;
    if (this.removed.length) { out.r = this.removed; this.removed = []; }
    if (this.tileChanges.length) { out.tc = this.tileChanges; this.tileChanges = []; }
    const p = [];
    for (const P of this.players) {
      const rec = this.playerRec(P), s = JSON.stringify(rec);
      if (s !== P._sig) { P._sig = s; p.push(rec); }
    }
    if (p.length) out.p = p;
    if (this.events.length) { out.ev = this.events; this.events = []; }
    return out;
  }

  /** Complete state for a client that just joined (does not disturb delta bookkeeping). */
  full() {
    const e = [];
    for (const u of this.units) {
      if (u.dead) continue;
      e.push([u.id, 0, u.type, u.owner, Math.round(u.x * POS_Q), Math.round(u.y * POS_Q), Math.ceil(u.hp), u.st, u.tgt,
        u.carryAmt > 0 ? RES.indexOf(u.carryType) + 1 : 0, u.bmask]);
    }
    for (const b of this.bldgs) if (!b.dead) e.push(this.bldgRec(b));
    for (const n of this.nodes) if (!n.dead) e.push(this.nodeRec(n));
    return { t: 's', k: this.tick, full: 1, e, p: this.players.map((P) => this.playerRec(P)) };
  }

  /** Static match description sent once when the match starts (or on reconnect). */
  startInfo() {
    let tiles = '';
    for (let i = 0; i < this.tiles.length; i++) tiles += this.tiles[i];
    return {
      w: this.w, h: this.h, tiles, seed: this.seed, q: POS_Q, tickRate: TICK_RATE,
      players: this.players.map((P) => ({ idx: P.idx, name: P.name, commander: P.commander, team: P.team, color: P.color, bot: P.bot, home: P.home })),
      opts: { mapSize: this.mapSize, startRes: this.opts.startRes, popCap: this.opts.popCap, fog: this.opts.fog, speed: this.opts.speed, victory: this.opts.victory || 'hq' },
    };
  }

  summary() {
    return this.players.map((P) => ({
      idx: P.idx, name: P.name, commander: P.commander, team: P.team, color: P.color, alive: P.alive, age: P.age, ...P.score,
    }));
  }
}
