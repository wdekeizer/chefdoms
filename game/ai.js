// ============================================================================
//  CHEFDOMS — AI opponents.
//  A Bot plays through exactly the same command interface as a human (it calls
//  game.command), so it cannot cheat on resources. It does read the full game
//  state, i.e. it is not limited by fog of war.
// ============================================================================
import { RES, TICK_RATE, COMMANDERS, TECHS, BUILDINGS, ULT_AGE, techCost } from './data.js';

const LEVELS = {
  easy: {
    think: 40, cooks: [0, 10, 15, 20, 24], ageCooks: [0, 10, 15, 20],
    wave: [0, 6, 8, 12, 16], waveGrow: 1, firstAttack: 660, regroup: 120,
    armyMax: [0, 5, 10, 16, 22], minArmy: [0, 0, 3, 4, 5], techs: 0, ability: false, towers: 0, prod: 1,
  },
  normal: {
    think: 20, cooks: [0, 16, 26, 34, 40], ageCooks: [0, 13, 22, 30],
    wave: [0, 6, 9, 14, 20], waveGrow: 2, firstAttack: 420, regroup: 60,
    armyMax: [0, 8, 18, 30, 44], minArmy: [0, 2, 5, 8, 10], techs: 1, ability: true, towers: 1, prod: 2,
  },
  hard: {
    think: 10, cooks: [0, 18, 30, 40, 48], ageCooks: [0, 14, 24, 34],
    wave: [0, 6, 10, 16, 24], waveGrow: 3, firstAttack: 280, regroup: 40,
    armyMax: [0, 10, 24, 40, 60], minArmy: [0, 3, 6, 10, 12], techs: 2, ability: true, towers: 2, prod: 3,
  },
  // Extreme plays the Hard script flat out and, openly, gathers 25% faster.
  extreme: {
    think: 5, cooks: [0, 20, 34, 46, 56], ageCooks: [0, 15, 26, 36],
    wave: [0, 6, 12, 18, 28], waveGrow: 4, firstAttack: 240, regroup: 30,
    armyMax: [0, 12, 28, 46, 70], minArmy: [0, 4, 8, 12, 14], techs: 2, ability: true, towers: 2, prod: 4, gatherBonus: 1.25,
  },
};

const ECO_TECHS = ['hatchet1', 'peeler1', 'basket', 'sifter1', 'peeler2', 'hatchet2', 'carts', 'sifter2'];
const MIL_TECHS = ['pans', 'knives1', 'aprons1', 'sauce1', 'meals1', 'clogs', 'mise', 'knives2', 'aprons2', 'sauce2', 'bumper1', 'meals2', 'ovens', 'kds', 'grinders', 'cheftable',
  'knives3', 'aprons3', 'sauce3', 'bumper2', 'meatballs', 'veteran'];
const PROD = ['grill', 'sauce', 'garage', 'workshop', 'restaurant'];

export class Bot {
  constructor(game, player, level = 'normal') {
    this.g = game; this.P = player;
    this.level = LEVELS[level] ? level : 'normal';
    this.L = LEVELS[this.level];
    player.gatherBonus = this.L.gatherBonus || 1;
    this.offset = player.idx * 3 + 1;
    this.state = 'build';                 // build | attack
    this.wave = 0; this.waveStart = 0;
    this.nextAttack = this.L.firstAttack * TICK_RATE;
    this.target = null;
    this.thinks = 0;
    this.hopeless = 0;
    this.reserve = null;
    const h = player.home, cx = game.w / 2, cy = game.h / 2;
    const d = Math.hypot(cx - h.x, cy - h.y) || 1;
    this.rally = { x: h.x + ((cx - h.x) / d) * 8, y: h.y + ((cy - h.y) / d) * 8 };
  }

  update() {
    if ((this.g.tick + this.offset) % this.L.think !== 0) return;
    try { this.think(); } catch (e) { console.error('[bot ' + this.P.name + ']', e); }
  }

  think() {
    const g = this.g, P = this.P, pi = P.idx;
    this.thinks++;
    const cooks = [], idle = [], army = [], support = [];
    let hero = null;
    for (const u of g.units) {
      if (u.owner !== pi || u.dead) continue;
      if (u.isCook) { cooks.push(u); if (!u.order) idle.push(u); }
      else if (u.isHero) hero = u;
      else if (u.S.atk > 0) army.push(u);
      else support.push(u);
    }
    const B = {}, sites = [];
    for (const b of g.bldgs) {
      if (b.owner !== pi || b.dead) continue;
      (B[b.type] || (B[b.type] = [])).push(b);
      if (!b.done) sites.push(b);
    }
    this.c = {
      cooks, idle, army, support, hero, B, sites,
      n: (t) => (B[t] ? B[t].length : 0),
      done: (t) => (B[t] ? B[t].filter((b) => b.done) : []),
    };
    // nothing left to rebuild with: bow out instead of dragging the match on
    if (!cooks.length && P.res.food < P.stats.units.cook.cost && army.length < 3) {
      if (++this.hopeless > 6) { g.command(pi, { c: 'rg' }); return; }
    } else this.hopeless = 0;
    this.reserve = null;
    this.strategy();
    this.economy();
    this.builders();
    this.military();
    this.tactics();
  }

  // ------------------------------------------------------------------ helpers
  /** Can we pay `cost` and still keep `keep` (0..1) of what we are saving up for? */
  canSpend(cost, keep = 1) {
    const res = this.P.res, rv = this.reserve;
    for (const r in cost) if (res[r] < cost[r] + (rv && rv[r] ? rv[r] * keep : 0)) return false;
    return true;
  }

  clearArea(x0, y0, n) {
    const g = this.g;
    if (x0 < 1 || y0 < 1 || x0 + n > g.w - 1 || y0 + n > g.h - 1) return false;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) {
      const i = y * g.w + x, t = g.tiles[i];
      if ((t !== 0 && t !== 3) || g.occ[i]) return false;
    }
    return true;
  }

  /** Top-left tile for a new station near (x,y), keeping a one-tile walkway around it. */
  findSpot(type, x, y, minR, maxR) {
    const size = BUILDINGS[type].size, margin = type === 'garden' ? 0 : 1;
    let best = null, bs = Infinity;
    const x0 = Math.floor(x - maxR - size), x1 = Math.ceil(x + maxR);
    const y0 = Math.floor(y - maxR - size), y1 = Math.ceil(y + maxR);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const d = Math.hypot(tx + size / 2 - x, ty + size / 2 - y);
      if (d < minR || d > maxR) continue;
      const score = d + Math.random() * 2.5;
      if (score >= bs) continue;
      if (!this.clearArea(tx - margin, ty - margin, size + margin * 2)) continue;
      bs = score; best = [tx, ty];
    }
    return best;
  }

  pickBuilder(x, y) {
    let best = null, bs = Infinity;
    for (const u of this.c.cooks) {
      const o = u.order;
      if (o && o.t === 'build') continue;
      const score = Math.hypot(u.x - x, u.y - y) + (o ? 6 : 0) + (u.carryAmt > 3 ? 4 : 0);
      if (score < bs) { bs = score; best = u; }
    }
    return best;
  }

  build(type, near, minR, maxR, builder) {
    const g = this.g, P = this.P;
    const S = P.stats.bldgs[type];
    if (!S || S.age > P.age || !this.canSpend(S.cost)) return false;
    const spot = this.findSpot(type, near.x, near.y, minR, maxR);
    if (!spot) return false;
    const u = builder || this.pickBuilder(spot[0] + S.size / 2, spot[1] + S.size / 2);
    if (!u) return false;
    const before = g.bldgs.length;
    g.command(P.idx, { c: 'bp', ids: [u.id], b: type, tx: spot[0], ty: spot[1] });
    if (g.bldgs.length > before) {
      const b = g.bldgs[g.bldgs.length - 1];
      this.c.sites.push(b);
      (this.c.B[type] || (this.c.B[type] = [])).push(b);
      return true;
    }
    return false;
  }

  research(key) {
    const g = this.g, P = this.P;
    const T = TECHS[key];
    if (!T || P.techs.includes(key) || P.pending.has(key)) return false;
    if (T.setAge ? P.age !== T.setAge - 1 : T.age > P.age) return false;
    if (T.req && !P.techs.includes(T.req)) return false;
    const cost = techCost(key, P.stats.misc);
    if (!(T.setAge ? g.canAfford(P, cost) : this.canSpend(cost))) return false;
    for (const type in this.c.B) {
      if (!BUILDINGS[type].techs.includes(key)) continue;
      for (const b of this.c.B[type]) {
        if (!b.done || b.q.length > (T.setAge ? 1 : 0)) continue;
        g.command(P.idx, { c: 'rs', bid: b.id, tech: key });
        return P.pending.has(key);
      }
    }
    return false;
  }

  nearestDropDist(x, y) {
    let bd = Infinity;
    for (const b of this.P.dropoffs) { const d = Math.hypot(b.x - x, b.y - y); if (d < bd) bd = d; }
    for (const b of this.c.sites) if (b.S.dropoff) { const d = Math.hypot(b.x - x, b.y - y); if (d < bd) bd = d; }
    return bd;
  }

  // ----------------------------------------------------------------- strategy
  strategy() {
    const P = this.P, L = this.L, c = this.c, a = P.age;
    const ncook = c.cooks.length;

    // the very first barracks
    if (!c.n('grill')) {
      if (ncook >= 7 && !this.build('grill', this.rally, 0, 9)) this.reserve = { ...P.stats.bldgs.grill.cost };
      return;
    }

    // next age: save up for it once the kitchen is staffed
    const next = 'age' + (a + 1);
    if (a < 4 && !P.pending.has(next) && ncook >= L.ageCooks[a]) {
      if (!this.research(next)) this.reserve = techCost(next, P.stats.misc);
    }

    // stations for the current age
    const cap = (t) => (a >= 3 ? L.prod : Math.min(L.prod, 2)) - (t === 'workshop' || t === 'restaurant' ? 1 : 0);
    const wants = [];
    if (a >= 2) {
      const veh = P.commander === 'zara';
      wants.push(veh ? 'garage' : 'sauce', 'lab', veh ? 'sauce' : 'garage');
    }
    if (a >= 3) wants.push('restaurant', 'workshop');
    for (const t of wants) {
      if (c.n(t)) continue;
      this.build(t, P.home, 6, 20);
      return;                                   // one new station at a time
    }
    // more production once the basics exist
    if (a >= 2 && c.sites.length === 0) {
      for (const t of PROD) {
        if (!c.n(t) || c.n(t) >= Math.max(1, cap(t)) || BUILDINGS[t].age > a) continue;
        if (P.res.wood > 350 && this.build(t, P.home, 6, 22)) return;
      }
      const towers = c.n('tower');
      if (towers < L.towers * (a - 1) && P.res.salt >= 150 && this.build('tower', P.home, 4, 9)) return;
    }

    // upgrades
    if (L.techs) {
      if (!c.n('pantry') && a >= 2 && c.sites.length === 0) { this.build('pantry', P.home, 5, 12); return; }
      for (const k of ECO_TECHS) if (this.research(k)) return;
      if (a >= 2) for (const k of MIL_TECHS) if (this.research(k)) return;
      if (a >= 4) this.research('elite');
      if (L.techs > 1 && P.res.spice > 250) this.research('mitts');
    }
  }

  // ------------------------------------------------------------------ economy
  weights() {
    const P = this.P, a = P.age;
    const W = a === 1 ? { food: 0.6, wood: 0.34, spice: 0.06, salt: 0 }
      : a === 2 ? { food: 0.42, wood: 0.23, spice: 0.30, salt: 0.05 }
        : { food: 0.33, wood: 0.20, spice: 0.37, salt: 0.10 };
    if (a === 1 && this.c.cooks.length < 8) { W.spice = 0; }
    if (this.c.cooks.length <= 5) { W.food = 0.7; W.wood = 0.3; W.spice = 0; W.salt = 0; }   // rebuilding from scratch
    if (a >= 2) W.wood += 0.04;
    if (P.res.food < 120 && P.res.wood < 120 && !this.g.findNode('veg', P.home.x, P.home.y, 22) && !this.g.findNode('fish', P.home.x, P.home.y, 20)) W.wood *= 2;   // gardens need firewood
    if (a >= 3 && !this.c.n('restaurant') && P.res.salt < 380) W.salt = 0.16;
    else if (a >= 2 && P.res.salt > 500) W.salt = 0.02;
    let sum = 0;
    for (const r of RES) {
      const have = P.res[r];
      W[r] *= have > 1200 ? 0.3 : have > 700 ? 0.6 : have < 80 ? 1.4 : 1;
      sum += W[r];
    }
    for (const r of RES) W[r] /= sum;
    return W;
  }

  economy() {
    const g = this.g, P = this.P, L = this.L, c = this.c, pi = P.idx;

    // prep cooks
    const target = Math.min(L.cooks[P.age], Math.floor(P.maxPop * 0.55));
    let queued = 0;
    const hqs = c.done('hq');
    for (const hq of hqs) for (const it of hq.q) if (it.key === 'cook') queued++;
    for (const hq of hqs) {
      if (c.cooks.length + queued >= target) break;
      if (hq.q.length < 2 && g.canAfford(P, P.stats.units.cook.cost)) { g.command(pi, { c: 'tr', bid: hq.id, u: 'cook' }); queued++; }
    }

    // break rooms
    const housePop = P.stats.bldgs.house.pop;
    let pendingCap = 0, houseSites = 0;
    for (const b of c.sites) if (b.type === 'house') { pendingCap += housePop; houseSites++; }
    const prod = PROD.reduce((s, t) => s + c.n(t), c.n('hq'));
    if (P.popCap + pendingCap < P.maxPop && P.popCap + pendingCap - P.pop <= 2 + prod && houseSites < (P.age >= 3 ? 2 : 1)) {
      const save = this.reserve; this.reserve = null;          // housing is never optional
      this.build('house', P.home, 4.5, 16);
      this.reserve = save;
    }

    // who is doing what
    const count = { food: 0, wood: 0, spice: 0, salt: 0 };
    let working = 0;
    for (const u of c.cooks) {
      const o = u.order;
      if (o && o.t === 'gather') { count[o.res]++; working++; }
    }
    const W = this.weights();
    const total = working + c.idle.length;
    const deficit = (r) => W[r] * total - count[r];

    for (const u of c.idle) {
      const order = RES.slice().sort((x, y) => deficit(y) - deficit(x));
      // no food to pick and no firewood for a garden: chop wood before anything else
      if (order[0] === 'food') { order.splice(order.indexOf('wood'), 1); order.splice(1, 0, 'wood'); }
      for (const r of order) { if (this.assign(u, r)) { count[r]++; break; } }
    }

    // shuffle one cook from the most over-staffed job to the most under-staffed
    if (this.thinks % 3 === 0 && total >= 1) {
      let over = null, under = null;
      for (const r of RES) {
        if (!over || deficit(r) < deficit(over)) over = r;
        if (!under || deficit(r) > deficit(under)) under = r;
      }
      const lim = total >= 8 ? 1.5 : 0.5;
      if (over !== under && count[over] > 0 && deficit(under) >= lim && deficit(over) <= -lim) {
        const u = c.cooks.find((k) => k.order && k.order.t === 'gather' && k.order.res === over && k.order.phase !== 2 && k.carryAmt < 4);
        if (u && !this.assign(u, under) && under === 'food') this.assign(u, 'wood');
      }
    }
  }

  /** Put a cook on a resource. Returns false if there is nothing sensible to do for it. */
  assign(u, res) {
    const g = this.g, P = this.P, pi = P.idx, home = P.home;
    if (res === 'food') {
      const n = g.findNode('veg', home.x, home.y, 22);
      if (n) {
        if (this.nearestDropDist(n.x, n.y) > 8.5 && this.build('pantry', n, 1.5, 5, u)) return true;
        g.command(pi, { c: 'ga', ids: [u.id], tid: n.id });
        return true;
      }
      const fish = g.findNode('fish', home.x, home.y, 20);          // the pond is the next best thing to a veggie patch
      if (fish && this.fishers(fish) < 3) {
        if (this.nearestDropDist(fish.x, fish.y) > 8.5 && this.build('pantry', fish, 1.5, 5, u)) return true;
        g.command(pi, { c: 'ga', ids: [u.id], tid: fish.id });
        return true;
      }
      const gd = g.findGarden(u, home.x, home.y, 40, null);
      if (gd) { g.command(pi, { c: 'ga', ids: [u.id], tid: gd.id }); return !!u.order; }
      let gardenSites = 0;
      for (const b of this.c.sites) if (b.type === 'garden') gardenSites++;
      if (gardenSites < 3) {
        const save = this.reserve; this.reserve = null;        // food is the engine; never starve it
        const ok = this.build('garden', home, 3, 13, u);
        this.reserve = save;
        return ok;
      }
      return false;
    }
    if (res === 'wood') {
      const t = g.findTree(u.x, u.y, 12) >= 0 && Math.hypot(u.x - home.x, u.y - home.y) < 18 ? g.findTree(u.x, u.y, 12) : g.findTree(home.x, home.y, 28);
      if (t < 0) return false;
      const tx = (t % g.w) + 0.5, ty = ((t / g.w) | 0) + 0.5;
      if (this.nearestDropDist(tx, ty) > 8.5 && this.build('pantry', { x: tx, y: ty }, 1.5, 5, u)) return true;
      const near = g.treesNear(t, 5);
      g.command(pi, { c: 'ga', ids: [u.id], tree: near[(Math.random() * near.length) | 0] });
      return true;
    }
    const n = g.findNode(res, home.x, home.y, Math.max(34, Math.min(72, g.w * 0.36)));   // bigger maps: walk further for spice and salt
    if (!n) return false;
    if (this.nearestDropDist(n.x, n.y) > 7.5 && this.build('pantry', n, 1.5, 5, u)) return true;
    g.command(pi, { c: 'ga', ids: [u.id], tid: n.id });
    return true;
  }

  /** How many of our cooks already work the pond around this fishing spot. */
  fishers(node) {
    let n = 0;
    for (const u of this.c.cooks) { const o = u.order; if (o && o.t === 'gather' && o.ntype === 'fish' && Math.hypot(o.ox - node.x, o.oy - node.y) < 8) n++; }
    return n;
  }

  builders() {
    const g = this.g, c = this.c;
    for (const b of c.sites) {
      let n = 0;
      for (const u of c.cooks) if (u.order && u.order.t === 'build' && u.order.id === b.id) n++;
      const want = b.size >= 4 ? 3 : b.size === 3 ? 2 : 1;
      while (n < want && n < c.cooks.length) {
        const u = this.pickBuilder(b.x, b.y);
        if (!u) break;
        g.command(this.P.idx, { c: 'ba', ids: [u.id], tid: b.id });
        if (!u.order || u.order.t !== 'build') break;
        n++;
      }
    }
  }

  // ----------------------------------------------------------------- military
  composition() {
    const g = this.g, P = this.P, a = P.age;
    const uq = COMMANDERS[P.commander].unique;
    let comp;
    if (a === 1) comp = { line: 1 };
    else if (a === 2) comp = { line: 4, saucier: 2.5, scooter: 1.5, butcher: 0.5 };
    else comp = { line: 2.5, saucier: 2, scooter: 0.7, truck: 1.5, butcher: 0.5, catapult: 1.0, ram: 1.2, barista: 0.4, [uq]: 4.5 };
    // react to what the enemies field
    let veh = 0, rng = 0, tot = 0;
    for (const u of g.units) {
      if (u.dead || !g.hostile(P.idx, u.owner) || u.isCook) continue;
      tot++;
      if (u.S.tags.includes('veh')) veh++; else if (u.S.tags.includes('ranged')) rng++;
    }
    if (tot >= 6) {
      if (veh / tot > 0.3 && comp.butcher) comp.butcher *= 4;
      if (rng / tot > 0.35 && comp.scooter) comp.scooter *= 2;
    }
    if (P.commander === 'ryo') comp.line *= 1.5;
    if (P.commander === 'zara' && comp.scooter) { comp.scooter *= 1.3; if (comp.truck) comp.truck *= 1.5; }
    if (P.commander === 'hank') comp.line *= 1.3;
    return comp;
  }

  military() {
    const g = this.g, P = this.P, L = this.L, c = this.c, pi = P.idx;
    if (c.army.length >= L.armyMax[P.age]) return;
    const comp = this.composition();
    const uq = COMMANDERS[P.commander].unique;
    const have = {};
    for (const u of c.army) have[u.type] = (have[u.type] || 0) + 1;
    for (const u of c.support) have[u.type] = (have[u.type] || 0) + 1;
    const trainers = {};       // unit key -> idle-ish building
    for (const t of [...PROD, 'hq']) {
      for (const b of c.done(t)) {
        for (const it of b.q) if (it.k === 'u') have[it.key] = (have[it.key] || 0) + 1;
        if (b.q.length >= 2) continue;
        for (let key of b.S.trains) {
          if (key === 'unique') key = COMMANDERS[P.commander].unique;
          if (key === 'cook' || !comp[key] || P.stats.units[key].age > P.age) continue;
          if (!trainers[key]) trainers[key] = [];
          trainers[key].push(b);
        }
      }
    }
    const waveNeed = Math.min(L.wave[P.age] + this.wave * L.waveGrow, L.armyMax[P.age]);
    const la = P.lastAttacked;
    const underFire = la && g.tick - la.tick < 200;
    const urgent = underFire || c.army.length < L.minArmy[P.age];
    // the bigger the army already is, the more strictly we save for the next age
    const keep = Math.min(1, c.army.length / Math.max(1, waveNeed * 0.8));
    const used = new Set();
    for (let round = 0; round < 6; round++) {
      const keys = Object.keys(trainers).sort((x, y) => comp[y] / ((have[y] || 0) + 1) - comp[x] / ((have[x] || 0) + 1));
      let trained = false;
      for (const key of keys) {
        const b = trainers[key].find((x) => !used.has(x.id));
        if (!b) continue;
        // don't let one cheap unit type swamp the army just because it is affordable
        if (key !== uq && (have[key] || 0) >= Math.max(4, (c.army.length + 2) * 0.45)) continue;
        const cost = P.stats.units[key].cost;
        if (!(this.canSpend(cost, keep) || (urgent && g.canAfford(P, cost)))) continue;
        g.command(pi, { c: 'tr', bid: b.id, u: key });
        have[key] = (have[key] || 0) + 1;
        used.add(b.id);
        trained = true;
        break;
      }
      if (!trained) return;
    }
  }

  // ------------------------------------------------------------------ tactics
  pickTarget(from) {
    const g = this.g, pi = this.P.idx;
    // a strong wave marches on the nearest Kitchen HQ; a weak one picks at softer stations
    let siege = 0;
    for (const u of this.c.army) if (u.S.tags.includes('siege')) siege++;
    const strong = siege >= 2 || this.c.army.length >= 12;
    let best = null, bd = Infinity;
    for (const b of g.bldgs) {
      if (b.dead || !g.hostile(pi, b.owner)) continue;
      let d = Math.hypot(b.x - from.x, b.y - from.y);
      if (b.type === 'garden') d += 15;
      if (strong) { if (b.type === 'hq') d -= 40; }
      else if (b.S.atk > 0) d += 12;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  nearOwnBuilding(x, y, R) {
    for (const t in this.c.B) for (const b of this.c.B[t]) if (Math.hypot(b.x - x, b.y - y) < R) return true;
    return false;
  }

  tactics() {
    const g = this.g, P = this.P, L = this.L, c = this.c, pi = P.idx, tick = g.tick;
    const fighters = c.army, hero = c.hero;
    const all = hero ? fighters.concat(hero, c.support) : fighters.concat(c.support);
    this.maybeAbility(hero);
    this.maybeUltimate(hero);

    // commander falls back when badly hurt
    if (hero && hero.hp < hero.S.hp * 0.3 && Math.hypot(hero.x - P.home.x, hero.y - P.home.y) > 12 && !(hero.order && hero.order.t === 'move')) {
      g.command(pi, { c: 'mv', ids: [hero.id], x: P.home.x, y: P.home.y + 3 });
    }

    // someone is hitting our base
    const la = P.lastAttacked;
    if (la && tick - la.tick < 120 && this.nearOwnBuilding(la.x, la.y, 13)) {
      const ids = [];
      for (const u of all) {
        if (u === hero && hero.hp < hero.S.hp * 0.3) continue;
        const o = u.order;
        if (o && (o.t === 'attack' || o.t === 'heal')) continue;
        if (o && o.t === 'amove' && Math.hypot(o.x - la.x, o.y - la.y) < 6) continue;
        if (this.state === 'attack' && Math.hypot(u.x - la.x, u.y - la.y) > 30) continue;   // the strike force keeps going
        ids.push(u.id);
      }
      if (ids.length) g.command(pi, { c: 'am', ids, x: la.x, y: la.y });
      if (this.state !== 'attack') return;
    }

    if (this.state === 'attack') {
      if (!this.target || this.target.dead) {
        let cx = 0, cy = 0;
        for (const u of fighters) { cx += u.x; cy += u.y; }
        this.target = this.pickTarget(fighters.length ? { x: cx / fighters.length, y: cy / fighters.length } : P.home);
      }
      if (!this.target || fighters.length < Math.max(2, this.waveStart * 0.3)) {
        this.state = 'build'; this.target = null;
        this.nextAttack = tick + L.regroup * TICK_RATE;
        if (all.length) g.command(pi, { c: 'mv', ids: all.map((u) => u.id), x: this.rally.x, y: this.rally.y });
        return;
      }
      const ids = [];
      for (const u of all) if (!u.order && !(u === hero && hero.hp < hero.S.hp * 0.3)) ids.push(u.id);
      if (ids.length) g.command(pi, { c: 'am', ids, x: this.target.x, y: this.target.y });
      return;
    }

    // mustering
    const strays = [];
    for (const u of all) if (!u.order && Math.hypot(u.x - this.rally.x, u.y - this.rally.y) > 7) strays.push(u.id);
    if (strays.length) g.command(pi, { c: 'am', ids: strays, x: this.rally.x, y: this.rally.y });
    const need = Math.min(L.wave[P.age] + this.wave * L.waveGrow, L.armyMax[P.age] - 1);
    if (fighters.length >= need && tick >= this.nextAttack) {
      this.target = this.pickTarget(P.home);
      if (this.target) {
        this.state = 'attack'; this.wave++; this.waveStart = fighters.length;
        g.command(pi, { c: 'am', ids: all.map((u) => u.id), x: this.target.x, y: this.target.y });
      }
    }
  }

  /** Ultimates are rare: wait for a moment that is worth three minutes of cooldown. */
  maybeUltimate(hero) {
    const g = this.g, P = this.P, U = COMMANDERS[P.commander].ultimate;
    if (!this.L.ability || !hero || !U || P.age < ULT_AGE || g.tick < P.ultReady) return;
    const count = (R) => {
      let foes = 0, big = 0;
      const list = g.near(hero.x, hero.y, R);
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.dead || !g.hostile(P.idx, v.owner) || Math.hypot(v.x - hero.x, v.y - hero.y) > R) continue;
        foes++; if (v.isHero || v.hp >= 150) big++;
      }
      return { foes, big };
    };
    const la = P.lastAttacked, fire = () => g.command(P.idx, { c: 'ul' });
    switch (U.key) {
      case 'flambe': if (count(U.radius).foes >= 5) fire(); break;
      case 'glass': if (count(U.radius).foes >= 5) fire(); break;
      case 'perfectcut': if (count(U.radius).big >= 1) fire(); break;
      case 'swarm': if (count(10).foes >= 4) fire(); break;
      case 'feast': {
        let hurt = 0;
        for (const u of this.c.army) if (u.hp < u.S.hp * 0.55) hurt++;
        if (hurt >= 5) fire();
        break;
      }
      case 'lockdown': if (la && g.tick - la.tick < 60 && this.nearOwnBuilding(la.x, la.y, 5) && count(14).foes + this.enemiesNear(la.x, la.y, 8) >= 5) fire(); break;
    }
  }
  enemiesNear(x, y, R) {
    const g = this.g, list = g.near(x, y, R);
    let n = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead && g.hostile(this.P.idx, list[i].owner)) n++;
    return n;
  }

  maybeAbility(hero) {
    const g = this.g, P = this.P;
    if (!this.L.ability || !hero || g.tick < P.abilityReady) return;
    const A = COMMANDERS[P.commander].ability;
    if (A.key === 'sugar') { if (this.c.cooks.length >= 10) g.command(P.idx, { c: 'ab' }); return; }
    if (A.key === 'lunch') {
      let busy = 0;
      for (const t in this.c.B) for (const b of this.c.B[t]) if (b.q.length) busy++;
      if (busy >= 2) g.command(P.idx, { c: 'ab' });
      return;
    }
    let foes = 0, friends = 0, hurt = 0;
    const list = g.near(hero.x, hero.y, A.radius);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.dead || Math.hypot(v.x - hero.x, v.y - hero.y) > A.radius) continue;
      if (g.hostile(P.idx, v.owner)) foes++;
      else if (v.owner === P.idx) { friends++; if (v.hp < v.S.hp * 0.6) hurt++; }
    }
    if (A.key === 'cuts') { if (foes >= 3) g.command(P.idx, { c: 'ab' }); }
    else if (A.key === 'mangia') { if (hurt >= 3 || (hero.hp < hero.S.hp * 0.4 && foes > 0)) g.command(P.idx, { c: 'ab' }); }
    else if (foes >= 3 && friends >= 4) g.command(P.idx, { c: 'ab' });
  }
}
