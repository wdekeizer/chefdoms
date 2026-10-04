// ============================================================================
//  CHEFDOMS — bots for the turn-based mode.
//  A TacticsBot plays through exactly the same orders as a human (it calls
//  game.command), one order at a time, with a short pause between them so that
//  people watching can follow. It sees the whole map (no fog of war).
// ============================================================================
import { K_UNIT, K_BLDG, K_NODE } from './sim.js';
import { TILE, RES, NODES, BUILDINGS, TECHS, COMMANDERS, ULT_AGE, TB, MARKET, tbReach, tbPath, tbDist, tbDamage, techCost } from './data.js';

const LEVELS = {
  easy:    { cooks: 2, wave: [0, 3, 4, 6, 8],  grow: 0, techs: 0, ability: false, towers: 0, sharp: false, pace: 9 },
  normal:  { cooks: 3, wave: [0, 3, 5, 7, 9],  grow: 1, techs: 1, ability: true,  towers: 0, sharp: true,  pace: 7 },
  hard:    { cooks: 4, wave: [0, 4, 6, 8, 10], grow: 1, techs: 2, ability: true,  towers: 1, sharp: true,  pace: 6 },
  extreme: { cooks: 4, wave: [0, 4, 6, 9, 12], grow: 2, techs: 2, ability: true,  towers: 1, sharp: true,  pace: 5, gatherBonus: 1.25 },
};
const ECO_TECHS = ['peeler1', 'hatchet1', 'sifter1', 'peeler2', 'hatchet2', 'sifter2'];
const MIL_TECHS = ['pans', 'knives1', 'aprons1', 'sauce1', 'meals1', 'knives2', 'aprons2', 'sauce2', 'bumper1', 'meals2', 'ovens', 'grinders', 'cheftable', 'knives3', 'aprons3', 'sauce3', 'bumper2', 'meatballs', 'veteran', 'elite'];
const PROD = ['grill', 'sauce', 'garage', 'workshop', 'restaurant'];
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export class TacticsBot {
  constructor(game, player, level = 'normal') {
    this.g = game; this.P = player;
    this.level = LEVELS[level] ? level : 'normal';
    this.L = LEVELS[this.level];
    player.gatherBonus = this.L.gatherBonus || 1;
    this.turnKey = ''; this.nextAt = 0; this.state = 'muster'; this.waves = 0; this.skip = new Set(); this.managed = false;
    this.wave = null; this.target = null; this.strength = 0; this.claimed = new Map();
  }

  /** Called every tick while it is this bot's turn (or its team's). */
  update() {
    const g = this.g, P = this.P;
    if (!g.isTurnOf(P.idx) || g.busy() || g.queue.length || g.tick < this.nextAt) return;
    const key = g.turn.n + ':' + g.turnSeq;
    if (key !== this.turnKey) { this.turnKey = key; this.skip.clear(); this.claimed = new Map(); this.managed = false; this.nextAt = g.tick + 6; return; }
    this.nextAt = g.tick + this.L.pace;
    try { if (!this.act()) g.command(P.idx, { c: 'et' }); } catch (e) { console.error('[tactics bot ' + P.name + ']', e); g.command(P.idx, { c: 'et' }); }
  }

  // ------------------------------------------------------------------ survey
  survey() {
    const g = this.g, pi = this.P.idx;
    const c = { cooks: [], army: [], support: [], hero: null, B: {}, sites: [], foes: [], foeB: [], hq: null };
    for (const u of g.units) {
      if (u.dead) continue;
      if (u.owner === pi) { if (u.isCook) c.cooks.push(u); else if (u.isHero) c.hero = u; else if (u.S.atk > 0) c.army.push(u); else c.support.push(u); }
      else if (g.hostile(pi, u.owner)) c.foes.push(u);
    }
    for (const b of g.bldgs) {
      if (b.dead) continue;
      if (b.owner === pi) { (c.B[b.type] || (c.B[b.type] = [])).push(b); if (!b.done) c.sites.push(b); if (b.type === 'hq' && b.done && !c.hq) c.hq = b; }
      else if (g.hostile(pi, b.owner)) c.foeB.push(b);
    }
    c.n = (t) => (c.B[t] ? c.B[t].length : 0);
    c.home = c.hq || (Object.values(c.B)[0] || [])[0] || { tx: Math.floor(this.P.home.x), ty: Math.floor(this.P.home.y) };
    this.c = c;
    return c;
  }
  can(cost) { for (const r in cost) if (this.P.res[r] < cost[r]) return false; return true; }
  /** Can we pay for this and still afford the next age when we are saving for it? */
  spare(cost) {
    const rv = this.reserve;
    for (const r in cost) if (this.P.res[r] < cost[r] + (rv && rv[r] ? rv[r] : 0)) return false;
    return true;
  }

  // -------------------------------------------------------------------- turn
  /** Do one thing. Returns false when there is nothing left to do this turn. */
  act() {
    const g = this.g, P = this.P, c = this.survey();
    if (!this.managed) { this.managed = true; this.manage(); this.plan(); }
    if (this.L.ability && this.abilities()) return true;
    for (const u of c.cooks) if (!u.acted && !this.skip.has(u.id) && this.cook(u)) return true;
    // soldiers closest to the enemy go first, so the ones behind can move into the gaps
    const fighters = c.army.concat(c.hero ? [c.hero] : [], c.support).filter((u) => !u.acted && !this.skip.has(u.id));
    const near = (u) => { let d = 99; for (const f of c.foes) d = Math.min(d, tbDist(u.tx, u.ty, f.tx, f.ty)); for (const b of c.foeB) d = Math.min(d, tbDist(u.tx, u.ty, b.tx, b.ty)); return d; };
    fighters.sort((a, b) => near(a) - near(b));
    for (const u of fighters) if (this.soldier(u)) return true;
    this.manage();                                    // spend what is left (a kill may have paid a tip, a site may be done)
    return false;
  }

  /** Where the army gathers: a few tiles in front of the HQ, towards the middle of the map. */
  rally() {
    const g = this.g, home = this.c.home, cx = g.w / 2, cy = g.h / 2, d = Math.hypot(cx - home.tx, cy - home.ty) || 1;
    return { x: Math.round(home.tx + ((cx - home.tx) / d) * 3), y: Math.round(home.ty + ((cy - home.ty) / d) * 3) };
  }

  /** Once a turn: gather the army, and send it out as one wave when it is big enough. */
  plan() {
    const g = this.g, P = this.P, L = this.L, c = this.c;
    const army = c.army, r = this.rally();
    if (this.state === 'attack') {
      const alive = army.filter((u) => this.wave.has(u.id)).length;
      if (alive < Math.max(2, this.strength * 0.3) || !c.foeB.length) { this.state = 'muster'; this.wave = null; this.target = null; }
    }
    if (this.state === 'muster') {
      const need = Math.min(L.wave[P.age] + this.waves * L.grow, Math.max(4, P.maxPop - c.cooks.length - 4));
      const ready = army.filter((u) => tbDist(u.tx, u.ty, r.x, r.y) <= 5).length;
      if (army.length >= need && ready >= need * 0.7 && c.foeB.length) {
        this.state = 'attack'; this.waves++;
        this.wave = new Set(army.concat(c.support, c.hero ? [c.hero] : []).map((u) => u.id));
        this.strength = army.length;
      }
    }
    if (this.state === 'attack') {
      // march on the nearest Kitchen HQ (or whatever is left)
      let best = null, bd = Infinity;
      for (const b of c.foeB) { const d = tbDist(b.tx, b.ty, c.home.tx, c.home.ty) - (b.type === 'hq' && b.done ? 100 : 0); if (d < bd) { bd = d; best = b; } }
      if (best !== this.target) {
        // first gather a short walk from the target, then go in together
        this.target = best; this.phase = 'march'; this.since = g.turn.n;
        const dx = c.home.tx - best.tx, dy = c.home.ty - best.ty, d = Math.hypot(dx, dy) || 1, k = Math.min(6, d / 2);
        this.stage = { x: Math.round(best.tx + (dx / d) * k), y: Math.round(best.ty + (dy / d) * k) };
      }
      if (this.phase === 'march') {
        const mine = army.filter((u) => this.wave.has(u.id));
        const there = mine.filter((u) => tbDist(u.tx, u.ty, this.stage.x, this.stage.y) <= 4).length;
        if (there >= mine.length * 0.7 || g.turn.n - this.since >= 9) this.phase = 'assault';
      }
    }
  }

  // ------------------------------------------------- stations: train, research
  /** At the Farmers Market: swap a pile we are sitting on for what we are short of. */
  market() {
    const g = this.g, P = this.P, c = this.c, res = P.res;
    if (!(c.B.market || []).some((b) => b.done)) return;
    const need = this.reserve || {};
    let get = null, worst = 0;
    for (const r of RES) {
      const want = Math.max(need[r] || 0, r === 'salt' && P.age < 2 ? 0 : 100);
      if (want - res[r] > worst) { worst = want - res[r]; get = r; }
    }
    if (!get) return;
    let give = null, most = 350;
    for (const r of RES) if (r !== get && res[r] - (need[r] || 0) > most) { most = res[r] - (need[r] || 0); give = r; }
    if (give) g.command(P.idx, { c: 'mkt', give, get, n: Math.min(3, Math.floor((most - 200) / MARKET.lot)) || 1 });
  }

  manage() {
    const g = this.g, P = this.P, L = this.L, c = this.c, pi = P.idx, a = P.age;
    this.reserve = null;
    const stations = Object.values(c.B).flat().filter((b) => b.done && b.pays).length;
    // next age
    const next = 'age' + (a + 1);
    if (a < 4 && !P.pending.has(next) && c.hq && stations >= [0, 3, 5, 6][a] && c.n('grill')) {
      const cost = techCost(next, P.stats.misc);
      if (this.can(cost) && !c.hq.q.length) g.command(pi, { c: 'rs', bid: c.hq.id, tech: next });
      else if (c.army.length >= L.wave[a]) this.reserve = cost;              // soldiers first, then save for the age
    }
    // prep cooks: a full crew while there are resources to claim, and always a couple to build, rebuild and repair
    const battered = Object.values(c.B).flat().some((b) => b.done && b.hp < b.T.hp * 0.7);
    const needCooks = this.freeNodes().length > 0 ? L.cooks : this.wanted().length || battered ? 2 : 1;
    const cooking = c.hq && c.hq.q.some((it) => it.key === 'cook') ? 1 : 0;
    if (c.hq && !c.hq.q.length && c.cooks.length < needCooks && this.can(P.stats.units.cook.cost)) g.command(pi, { c: 'tr', bid: c.hq.id, u: 'cook' });
    const cookSlots = Math.max(0, Math.min(2, needCooks) - c.cooks.length - cooking);      // staff room kept free for them
    // upgrades
    if (L.techs) {
      const list = (L.techs > 1 ? ECO_TECHS : ECO_TECHS.slice(0, 3)).concat(a >= 2 ? MIL_TECHS : ['pans']);
      for (const key of list) {
        const T = TECHS[key];
        if (P.techs.includes(key) || P.pending.has(key) || T.age > a || (T.req && !P.techs.includes(T.req))) continue;
        if (!this.spare(techCost(key, P.stats.misc))) continue;
        const b = Object.values(c.B).flat().find((x) => x.done && !x.q.length && x.S.techs.includes(key) && (x.type === 'lab' || x.type === 'pantry' || c.army.length >= 3));
        if (b) { g.command(pi, { c: 'rs', bid: b.id, tech: key }); break; }           // one upgrade a turn keeps units coming
      }
    }
    // soldiers (but leave the firewood alone while a station or a pantry is waiting for it)
    const want = this.wanted();
    const woodHold = (want.length ? P.stats.bldgs[want[0]].cost.wood || 0 : 0) + (this.freeNodes().length ? P.stats.bldgs.pantry.cost.wood : 0);
    const comp = this.composition();
    const have = {};
    for (const u of c.army.concat(c.support)) have[u.type] = (have[u.type] || 0) + 1;
    for (const t of PROD.concat('hq')) for (const b of c.B[t] || []) for (const it of b.q) if (it.k === 'u') have[it.key] = (have[it.key] || 0) + 1;
    // the stations that make the expensive things get first pick of the pantry, or Line Cooks would eat it all
    for (const t of PROD.slice().reverse().concat('hq')) {
      for (const b of c.B[t] || []) {
        if (!b.done || b.q.length) continue;
        let best = null, bs = -1;
        for (let key of b.S.trains) {
          if (key === 'unique') key = COMMANDERS[P.commander].unique;
          const S = P.stats.units[key];
          if (key === 'cook' || !comp[key] || S.age > a || !this.spare(S.cost)) continue;
          if (P.pop + P.reserved + S.pop > P.popCap - cookSlots) continue;
          if (S.cost.wood && P.res.wood - S.cost.wood < woodHold) continue;
          const score = comp[key] / ((have[key] || 0) + 1);
          if (score > bs) { bs = score; best = key; }
        }
        if (best) { g.command(pi, { c: 'tr', bid: b.id, u: best }); have[best] = (have[best] || 0) + 1; }
      }
    }
    this.market();
  }

  composition() {
    const P = this.P, a = P.age, uq = COMMANDERS[P.commander].unique;
    if (a === 1) return { line: 1 };
    if (a === 2) return { line: 3, saucier: 2.5, scooter: 1.5, butcher: 0.6, barista: 0.3 };
    return { line: 2, saucier: 2, scooter: 0.8, truck: 1.5, butcher: 0.5, catapult: 1.2, ram: 1.5, barista: 0.4, [uq]: 4 };
  }

  // ------------------------------------------------------------- prep cooks
  /** Resource spots nobody has built on, safest (closest to home relative to the enemy) first. */
  freeNodes() {
    const g = this.g, c = this.c, pi = this.P.idx;
    const out = [];
    for (const n of g.nodes) {
      if (n.dead || g.occ[n.ty * g.w + n.tx] !== n.id) continue;
      const dh = tbDist(n.tx, n.ty, c.home.tx, c.home.ty);
      let de = 99;
      for (const b of c.foeB) if (b.type === 'hq') de = Math.min(de, tbDist(n.tx, n.ty, b.tx, b.ty));
      for (const P of g.players) if (P.alive && P.idx !== pi && !g.hostile(pi, P.idx)) de = Math.min(de, tbDist(n.tx, n.ty, Math.floor(P.home.x), Math.floor(P.home.y)));   // leave an ally's pantry alone
      if (dh > 12 && dh > de * 0.8) continue;
      out.push(n);
    }
    return out;
  }

  /** What we are short of decides which spot is worth walking to. */
  wantRes(res) {
    const P = this.P, inc = P.income, a = P.age;
    const k = TB.income.veg / 30;        // scale with the income settings
    const want = a === 1 ? { food: 80 * k, wood: 55 * k, spice: 40 * k, salt: 0 } : a === 2 ? { food: 110 * k, wood: 60 * k, spice: 90 * k, salt: 15 * k } : { food: 140 * k, wood: 70 * k, spice: 130 * k, salt: 30 * k };
    return Math.max(0.15, (want[res] - inc[res]) / Math.max(20, want[res]));
  }

  cook(u) {
    const g = this.g, P = this.P, c = this.c, pi = P.idx, L = this.L;
    const far = tbReach(g.w, g.h, u.tx, u.ty, 60, g.costFn(u)), mv = g.mvOf(u);
    /** The cheapest tile next to (x,y) that this cook can walk to: [tile, cost] or null. */
    const beside = (x, y) => {
      let best = null;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (!g.inb(nx, ny)) continue;
        const i = ny * g.w + nx, cst = far.best.get(i);
        if (cst === undefined || (g.grid[i] && g.grid[i] !== u.id)) continue;
        if (!best || cst < best[1]) best = [i, cst];
      }
      return best;
    };
    const goBuild = (type, x, y) => {
      const at = beside(x, y);
      if (!at) return false;
      if (at[1] <= mv) {
        if (!this.can(P.stats.bldgs[type].cost) || g.cantPlace(type, x, y)) return false;
        g.command(pi, { c: 'tbd', id: u.id, b: type, x, y, sx: at[0] % g.w, sy: (at[0] / g.w) | 0 });
        return u.acted;
      }
      return this.stepToward(u, far, at[0]);
    };
    // danger close: do not wander off while raiders are about
    const threat = c.foes.some((f) => f.S.atk > 0 && !f.isCook && tbDist(f.tx, f.ty, u.tx, u.ty) <= f.T.mv + f.T.rng + 1);

    // 1. a site that needs hands, or a battered station
    for (const b of Object.values(c.B).flat()) {
      if ((b.done && b.hp >= b.T.hp * 0.7) || (!b.done && b.total < 2)) continue;
      const at = beside(b.tx, b.ty);
      if (at && at[1] <= mv) { g.command(pi, { c: 'trp', id: u.id, tid: b.id, sx: at[0] % g.w, sy: (at[0] / g.w) | 0 }); if (u.acted) return true; }
    }
    // 2. room for staff
    const sitesOf = (t) => c.sites.filter((b) => b.type === t).length;
    if (P.popCap < P.maxPop && P.popCap - P.pop - P.reserved <= 1 && !sitesOf('house') && this.can(P.stats.bldgs.house.cost)) {
      const t = this.plot(u, far, mv);
      if (t && goBuild('house', t[0], t[1])) return true;
    }
    // 3. the next production station (after the first few pantries: income comes first)
    const stations = Object.values(c.B).flat().filter((b) => b.pays).length;
    const want = this.wanted();
    let saving = 0;                                          // firewood we are putting aside for the next station
    if (want.length && stations >= 3 && !c.sites.some((b) => !b.pays && b.type !== 'house')) {  // one at a time
      const cost = P.stats.bldgs[want[0]].cost;
      if (this.spare(cost)) { const t = this.plot(u, far, mv); if (t && goBuild(want[0], t[0], t[1])) return true; }
      else if (stations >= 6 || !c.n('grill')) saving = cost.wood || 0;      // the first Grill Station cannot wait
    }
    // 4. a pantry on the best free resource
    if (!threat || stations < 2) {
      let best = null, bs = Infinity;
      const claimed = this.claimed;
      for (const n of this.freeNodes()) {
        const who = claimed.get(n.id);
        if (who && who !== u.id) continue;                  // a colleague is already on the way there
        const at = beside(n.tx, n.ty);
        if (!at) continue;
        const score = at[1] / this.wantRes(NODES[n.type].res) + (n.type === 'fish' ? 1 : 0);
        if (score < bs) { bs = score; best = n; }
      }
      if (best && (!saving || P.res.wood >= saving + (P.stats.bldgs.pantry.cost.wood || 0) || NODES[best.type].res === 'wood')) {
        claimed.set(best.id, u.id);
        if (goBuild('pantry', best.tx, best.ty)) return true;
      } else if (!best && !saving && stations >= 3 && P.res.wood > 150 && c.n('garden') < 4 && this.spare(P.stats.bldgs.garden.cost)) {
        const t = this.plot(u, far, mv);
        if (t && goBuild('garden', t[0], t[1])) return true;
      }
    }
    // 5. nothing to do: keep out of the way, close to home
    if (threat && tbDist(u.tx, u.ty, c.home.tx, c.home.ty) > 3) { const at = beside(c.home.tx, c.home.ty); if (at && this.stepToward(u, far, at[0])) return true; }
    this.skip.add(u.id);
    return false;
  }

  /** The production stations we still lack, most urgent first. */
  wanted() {
    const P = this.P, L = this.L, c = this.c, a = P.age, want = [], zara = P.commander === 'zara';
    const need = (t, n = 1) => { if (c.n(t) < n && P.stats.bldgs[t].age <= a) want.push(t); };
    need('grill');
    if (a >= 2) { need(zara ? 'garage' : 'sauce'); need('lab'); need(zara ? 'sauce' : 'garage'); if (L.towers) need('tower', L.towers * (a - 1)); if (L.techs) need('market'); }
    if (a >= 3) { need('workshop'); need('restaurant'); if (L.sharp) need('grill', 2); }
    return want;
  }

  /** A free tile for a new station near home that this cook can get next to, without walling anything in. */
  plot(u, far, mv) {
    const g = this.g, c = this.c, w = g.w;
    let best = null, bs = Infinity;
    for (let y = c.home.ty - 5; y <= c.home.ty + 5; y++) for (let x = c.home.tx - 5; x <= c.home.tx + 5; x++) {
      if (!g.inb(x, y) || x < 1 || y < 1 || x > w - 2 || y > g.h - 2) continue;
      const d = cheb(x, y, c.home.tx, c.home.ty);
      if (d < 2 || g.cantPlace('house', x, y)) continue;
      // keep a walkway: no station directly beside another station or a resource
      let crowd = false, open = 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!g.inb(nx, ny)) continue;
        const i = ny * w + nx;
        if (g.occ[i]) crowd = true; else if (g.tiles[i] !== TILE.WATER) open++;
      }
      if (crowd || open < 3) continue;
      let cost = Infinity;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        const cst = g.inb(nx, ny) ? far.best.get(ny * w + nx) : undefined;
        if (cst !== undefined && cst < cost) cost = cst;
      }
      if (cost === Infinity) continue;
      const score = d * 2 + cost + ((x + y) % 2 ? 0.5 : 0);           // a loose checkerboard round the HQ
      if (score < bs) { bs = score; best = [x, y]; }
    }
    return best;
  }

  /** Walk as far as this turn allows along the way to `goal` (a tile index from a far search). */
  stepToward(u, far, goal) {
    const g = this.g, mv = g.mvOf(u);
    if (u.moved || mv <= 0) return false;
    const path = tbPath(far.from, goal);
    let stop = -1;
    for (const i of path) { if (far.best.get(i) > mv) break; if (!g.grid[i]) stop = i; }
    if (stop < 0) return false;
    g.command(this.P.idx, { c: 'tmv', id: u.id, x: stop % g.w, y: (stop / g.w) | 0 });
    return u.moved;
  }

  // ---------------------------------------------------------------- soldiers
  /** How good is it for u to hit e from tile (sx,sy)? */
  value(u, e, sx, sy) {
    const g = this.g, c = this.c;
    const dmg = g.damageFor(u, e, false), kill = dmg >= e.hp;
    let w = 1;
    if (e.kind === K_UNIT) { if (e.isHero) w = 1.2; else if (e.isCook || e.T.rng > 1 || !(e.S.atk > 0)) w = 1.3; }
    else w = e.type === 'hq' ? (this.state === 'attack' ? 1.6 : 0.5) : e.S.atk > 0 ? 0.8 : e.pays ? 0.6 : 0.45;
    let v = Math.min(dmg, e.hp) * w + (kill ? 25 + (e.isHero ? 40 : 0) + (e.type === 'hq' ? 500 : 0) : 0);
    if (!kill && e.kind === K_UNIT && e.S.atk > 0 && !e.S.onlyBldg && !(e.stun > 0)) {
      const d = tbDist(sx, sy, e.tx, e.ty);
      if (d >= (e.T.rng > 1 ? e.T.minRng : 1) && d <= e.T.rng) {
        const cover = g.tiles[sy * g.w + sx] === TILE.TREE ? TB.forestCover : 1;
        const back = tbDamage(e.S, u.S, { hpFrac: Math.max(0, e.hp - dmg) / e.S.hp, ranged: e.T.rng > 1, counter: true, cover });
        v -= back * (u.isHero ? 1.2 : 0.8);
        if (back >= u.hp) v -= 60;
      }
    }
    if (g.tiles[sy * g.w + sx] === TILE.TREE) v += 2;
    // standing in a tower's reach costs something
    for (const b of c.foeB) if (b.done && b.S.atk > 0 && tbDist(sx, sy, b.tx, b.ty) <= b.T.rng && b !== e) v -= 6;
    return v;
  }

  soldier(u) {
    const g = this.g, P = this.P, c = this.c, pi = P.idx, w = g.w;
    const reach = g.reach(u), mv = g.mvOf(u);
    const stands = [];
    for (const [i, cst] of reach.best) if (!g.grid[i] || g.grid[i] === u.id) stands.push(i);
    const siege = u.S.tags.includes('siege') && u.T.rng > 1;

    // a Barista tops up whoever needs it most
    if (u.S.heal > 0) {
      let best = null, bs = 0;
      for (const v of g.units) {
        if (v.dead || v === u || v.owner !== pi || v.hp >= v.S.hp - 8) continue;
        for (const i of stands) {
          const d = tbDist(i % w, (i / w) | 0, v.tx, v.ty);
          if (d < 1 || d > u.T.rng) continue;
          const score = (v.S.hp - v.hp) + (v.isHero ? 30 : 0) - reach.best.get(i);
          if (score > bs) { bs = score; best = [v, i]; }
        }
      }
      if (best) { g.command(pi, { c: 'thl', id: u.id, tid: best[0].id, sx: best[1] % w, sy: (best[1] / w) | 0 }); if (u.acted) return true; }
    } else if (u.S.atk > 0 && !u.stuck) {
      // the best blow available from anywhere this unit can get to
      // striking first is worth something in itself (the counterattack is the weaker blow), and an army on the march must not dither
      let best = null, bs = this.state === 'attack' && this.wave.has(u.id) ? -30 : this.L.sharp ? -10 : -18;
      const targets = c.foes.concat(c.foeB).filter((e) => tbDist(e.tx, e.ty, u.tx, u.ty) <= mv + u.T.rng && (!u.S.onlyBldg || e.kind === K_BLDG));
      // station-breakers on the assault go for the Kitchen HQ (and whatever shoots at them), not for every Pantry on the way,
      // as long as there is still a way to get at it
      const tg = this.target;
      const breaker = this.state === 'attack' && this.phase === 'assault' && this.wave.has(u.id) && tg && !tg.dead && (u.S.onlyBldg || (u.S.bonus.bldg || 1) >= 2)
        && (u.T.rng > 1 || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const x = tg.tx + dx, y = tg.ty + dy, i = y * w + x; return g.inb(x, y) && g.tiles[i] !== TILE.WATER && !g.occ[i] && (!g.grid[i] || g.grid[i] === u.id); }));
      for (const e of targets) {
        if (breaker && e.kind === K_BLDG && e !== tg && !(e.S.atk > 0)) continue;
        for (const i of stands) {
          const sx = i % w, sy = (i / w) | 0;
          if (siege && (i !== u.ty * w + u.tx || u.moved)) continue;
          if (!g.inRange(u, tbDist(sx, sy, e.tx, e.ty))) continue;
          const v = this.value(u, e, sx, sy) - reach.best.get(i) * 0.1;
          if (v > bs) { bs = v; best = [e, i]; }
        }
      }
      // a badly hurt commander does not pick fights he may lose
      if (best && u.isHero && u.hp < u.S.hp * 0.3 && best[0].kind === K_UNIT && g.damageFor(u, best[0], false) < best[0].hp) best = null;
      if (best) { g.command(pi, { c: 'tat', id: u.id, tid: best[0].id, x: best[1] % w, y: (best[1] / w) | 0 }); if (u.acted) return true; }
    }
    if (u.moved) { this.skip.add(u.id); return false; }

    // nothing to hit: go where we are needed
    const goal = this.goalFor(u);
    if (goal) {
      const far = tbReach(g.w, g.h, u.tx, u.ty, 80, g.costFn(u));
      // the nearest reachable tile within striking distance of the goal
      let at = -1, bc = Infinity;
      const R = goal.keep !== undefined ? goal.keep : u.T.rng;
      for (const [i, cst] of far.best) {
        const d = tbDist(i % w, (i / w) | 0, goal.x, goal.y);
        if (d > R || (goal.keep === undefined && d < 1)) continue;
        const score = cst + (g.grid[i] && g.grid[i] !== u.id ? 3 : 0);
        if (score < bc) { bc = score; at = i; }
      }
      if (at < 0) {
        // the goal is walled off (by its defenders, usually): close in as far as we can get
        for (const [i, cst] of far.best) {
          if (g.grid[i] && g.grid[i] !== u.id) continue;
          const score = tbDist(i % w, (i / w) | 0, goal.x, goal.y) * 4 + cst * 0.2;
          if (score < bc) { bc = score; at = i; }
        }
      }
      if (at >= 0 && at !== u.ty * w + u.tx && this.stepToward(u, far, at)) return true;
    }
    this.skip.add(u.id);
    return false;
  }

  /** Where should this unit head when it has nothing to hit? { x, y, keep? } */
  goalFor(u) {
    const g = this.g, c = this.c, P = this.P, L = this.L;
    const home = c.home;
    if (u.isHero && u.hp < u.S.hp * 0.3) return { x: home.tx, y: home.ty, keep: 2 };
    const inWave = this.state === 'attack' && this.wave.has(u.id) && this.target && !this.target.dead;
    // someone is in our kitchen: everyone who is not out on the march deals with it
    if (!inWave) {
      let intr = null, id = 9;
      for (const f of c.foes) { const d = tbDist(f.tx, f.ty, home.tx, home.ty); if (d < id) { id = d; intr = f; } }
      if (intr) return { x: intr.tx, y: intr.ty };
    }
    if (inWave) {
      const best = this.target;
      if (this.phase === 'march') return { x: this.stage.x, y: this.stage.y, keep: 3 };
      // the commander and the fragile ones walk behind the front
      if (u.S.heal > 0 || (u.isHero && c.army.length >= 3)) {
        const lead = c.army.reduce((m, v) => (this.wave.has(v.id) && (!m || tbDist(v.tx, v.ty, best.tx, best.ty) < tbDist(m.tx, m.ty, best.tx, best.ty)) ? v : m), null);
        if (lead && lead !== u) return { x: lead.tx, y: lead.ty, keep: 2 };
      }
      return { x: best.tx, y: best.ty };
    }
    const r = this.rally();
    return { x: r.x, y: r.y, keep: 2 };
  }

  // ---------------------------------------------------------------- abilities
  abilities() {
    const g = this.g, P = this.P, c = this.c, hero = c.hero, pi = P.idx;
    if (!hero) return false;
    const R = TB.abilityRange;
    const nearMine = c.army.concat(c.support).filter((v) => cheb(v.tx, v.ty, hero.tx, hero.ty) <= R);
    const foesIn = (r) => c.foes.filter((v) => cheb(v.tx, v.ty, hero.tx, hero.ty) <= r);
    const fight = foesIn(6).length;
    if (P.abilityCd === 0) {
      const A = COMMANDERS[P.commander].ability;
      let go = false;
      if (A.key === 'service') go = nearMine.length >= 3 && fight >= 2;
      else if (A.key === 'lowslow') go = nearMine.length >= 3 && fight >= 3;
      else if (A.key === 'mangia') go = nearMine.concat(hero).filter((v) => v.hp < v.S.hp * 0.6).length >= 2;
      else if (A.key === 'cuts') go = foesIn(TB.cutsRange).length >= 2;
      else if (A.key === 'sugar') go = this.state === 'attack' && c.army.filter((v) => !v.moved).length >= 4;
      else if (A.key === 'lunch') go = Object.values(c.B).flat().filter((b) => b.done && b.q.length).length >= 2;
      if (go) { g.command(pi, { c: 'ab' }); if (P.abilityCd > 0) return true; }
    }
    if (P.ultCd === 0 && P.age >= ULT_AGE) {
      const U = COMMANDERS[P.commander].ultimate;
      const stationsIn = c.foeB.filter((b) => cheb(b.tx, b.ty, hero.tx, hero.ty) <= R).length;
      let go = false;
      if (U.key === 'flambe') go = foesIn(R).length + stationsIn >= 3;
      else if (U.key === 'glass') go = foesIn(R).length >= 3;
      else if (U.key === 'perfectcut') go = foesIn(R).some((v) => v.isHero || v.hp >= 110) || (this.state === 'attack' && stationsIn > 0 && !foesIn(R).length);
      else if (U.key === 'swarm') go = fight >= 2 || (this.state === 'attack' && stationsIn > 0);
      else if (U.key === 'feast') go = c.army.filter((v) => v.hp < v.S.hp * 0.55).length >= 4;
      else if (U.key === 'lockdown') go = c.foes.filter((v) => tbDist(v.tx, v.ty, c.home.tx, c.home.ty) <= 5).length >= 3;
      if (go) { g.command(pi, { c: 'ul' }); if (P.ultCd > 0) return true; }
    }
    return false;
  }
}
