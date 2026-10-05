// ============================================================================
//  CHEFDOMS — Capture the Flag ("ctf"), server side.
//
//  One hero per player and no kitchen to run. Every team has a base with an
//  unbreakable Kitchen HQ and a flag in front of it. Camps of wild minions
//  pay Tips when felled; Tips buy items at your own kitchen that raise your
//  hero's stats, and heroes level up as the match goes on. Carry an enemy
//  flag to your own stand to capture it. First to the capture target wins, or
//  whoever leads when the clock runs out (a level score goes to sudden death:
//  the next capture wins).
//
//  CtfGame extends the real-time Game: movement, combat, buffs, abilities,
//  ultimates and the network snapshots are all the same code.
// ============================================================================
import { Game, K_UNIT, K_BLDG, POS_Q } from './sim.js';
import { TICK_RATE, TILE, COMMANDERS, CTF, computeStats, ctfKit, ctfHeroStats, ctfItemCost, ctfLevelNeed, makeRng } from './data.js';

const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
const FLAG_HOME = 0, FLAG_CARRIED = 1, FLAG_DROPPED = 2;
export const ITEM_KEYS = Object.keys(CTF.items);
const NEUTRAL_NAME = 'The Wild Kitchen';

// ----------------------------------------------------------------------------
//  Map: bases round a ring, each with its own wedge of camps, the Head Critic
//  in the middle, forests and ponds in between, and a path from everything to
//  everything.
// ----------------------------------------------------------------------------
export function generateCtfMap(teams, seed) {
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const size = CTF.mapSize(teams.length), w = size, h = size, N = w * h;
  const tiles = new Uint8Array(N);
  const c = (size - 1) / 2, R = size * 0.38, a0 = teams.length === 2 ? Math.PI : rng() * Math.PI * 2;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const bases = teams.map((team, i) => {
    const a = a0 + (i * Math.PI * 2) / teams.length;
    const tx = Math.max(4, Math.min(w - 7, Math.round(c + Math.cos(a) * R) - 1)), ty = Math.max(4, Math.min(h - 7, Math.round(c + Math.sin(a) * R) - 1));
    return { team, tx, ty, x: tx + 1.5, y: ty + 1.5, angle: a };
  });
  // camps: a wedge of them in front of every base, and the boss in the middle
  const wedge = (Math.PI * 2) / teams.length, few = teams.length >= 6;
  const camps = [];
  // the two buff camps go in first: in the gaps between bases, on opposite sides (with two teams: top and bottom)
  const gaps = [0, Math.floor(teams.length / 2)];
  for (const [k, type] of [[gaps[0], 'pepper'], [gaps[1], 'sugar']]) {
    const a = a0 + ((2 * k + 1) * Math.PI) / teams.length, d = (teams.length === 2 ? 0.78 : 0.62) * R;
    const x = Math.max(4, Math.min(w - 5, Math.round(c + Math.cos(a) * d))), y = Math.max(4, Math.min(h - 5, Math.round(c + Math.sin(a) * d)));
    camps.push({ x, y, type, side: 0 });
  }
  for (const b of bases) {
    for (const type in CTF.camps) {
      const def = CTF.camps[type];
      if (def.boss || def.buff) continue;
      const sides = def.ang === 0 ? [0] : few && type !== 'dishpit' && type !== 'riders' ? [1] : [1, -1];
      if (few && type === 'sauce') continue;
      for (const s of sides) {
        const a = b.angle + s * def.ang * wedge / 2, d = def.r * R;
        const x = Math.round(c + Math.cos(a) * d), y = Math.round(c + Math.sin(a) * d);
        if (!inb(x, y) || x < 3 || y < 3 || x > w - 4 || y > h - 4) continue;
        if (camps.some((k) => Math.hypot(k.x + 0.5 - x - 0.5, k.y + 0.5 - y - 0.5) < 5) || Math.hypot(x - b.x, y - b.y) < 7) continue;
        camps.push({ x, y, type, side: s });
      }
    }
  }
  camps.push({ x: Math.round(c), y: Math.round(c), type: 'critic', side: 0 });
  // clearings that must stay open
  const openAt = (x, y) => {
    for (const b of bases) if (Math.hypot(x - b.x, y - b.y) < 8) return true;
    for (const k of camps) if (Math.hypot(x - k.x - 0.5, y - k.y - 0.5) < (k.type === 'critic' ? 6 : CTF.camps[k.type].buff ? 4.6 : 3.6)) return true;
    return false;
  };
  const blob = (cx, cy, count, type) => {
    const placed = [];
    if (!inb(cx, cy) || openAt(cx + 0.5, cy + 0.5)) return;
    tiles[cy * w + cx] = type; placed.push([cx, cy]);
    for (let g = 0; placed.length < count && g < count * 30; g++) {
      const p = placed[(rng() * placed.length) | 0], d = (rng() * 4) | 0, nx = p[0] + DX[d], ny = p[1] + DY[d];
      if (!inb(nx, ny) || nx < 1 || ny < 1 || nx > w - 2 || ny > h - 2 || tiles[ny * w + nx] === type || openAt(nx + 0.5, ny + 0.5)) continue;
      tiles[ny * w + nx] = type; placed.push([nx, ny]);
    }
  };
  for (let i = 0, n = Math.round(N / 140); i < n; i++) blob((rng() * w) | 0, (rng() * h) | 0, 6 + ((rng() * 12) | 0), TILE.TREE);   // a few copses, not a forest
  for (let i = 0, n = Math.round(N / 900); i < n; i++) blob((rng() * w) | 0, (rng() * h) | 0, 6 + ((rng() * 10) | 0), TILE.WATER);
  // everything must be reachable from everything: carve straight paths to the middle where it is not
  const walk = (i) => tiles[i] !== TILE.WATER && tiles[i] !== TILE.TREE;
  const flood = (sx, sy) => {
    const seen = new Uint8Array(N), q = [sy * w + sx];
    seen[q[0]] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi] % w, y = (q[qi] / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d], ni = ny * w + nx;
        if (!inb(nx, ny) || seen[ni] || !walk(ni)) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  };
  const carve = (x, y) => {
    const gx = Math.round(c), gy = Math.round(c);
    while (x !== gx || y !== gy) {
      if (Math.abs(gx - x) > Math.abs(gy - y)) x += Math.sign(gx - x); else y += Math.sign(gy - y);
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) { const i = (y + oy) * w + x + ox; if (inb(x + ox, y + oy) && !walk(i)) tiles[i] = TILE.GRASS; }
    }
  };
  const spots = [...bases.map((b) => [Math.round(b.x), Math.round(b.y) + 3]), ...camps.map((k) => [k.x, k.y])];
  let seen = flood(spots[0][0], spots[0][1]);
  for (const [x, y] of spots) if (!seen[y * w + x]) { carve(x, y); seen = flood(spots[0][0], spots[0][1]); }
  return { w, h, tiles, bases, camps, nodes: [], seed };
}

// ----------------------------------------------------------------------------
export class CtfGame extends Game {
  constructor(opts) {
    const real = opts.players.filter((p) => !p.neutral);
    super({ ...opts, players: [...real, { name: NEUTRAL_NAME, commander: 'dolly', team: -1, color: 0, bot: null, neutral: true }] });
    const map = this._map;
    this.camps = map.camps.map((k, i) => ({ i, x: k.x + 0.5, y: k.y + 0.5, type: k.type, def: CTF.camps[k.type], leash: CTF.minion.leash, level: 0, units: new Set(), nextAt: 1, alive: 0, _sig: '' }));
    this.minionLevel = 0;
    this._ctfSig = ''; this._flagSig = '';
    for (const P of this.players) if (!P.neutral) this.refreshHero(P);
  }

  // ==========================================================================
  //  Setup
  // ==========================================================================
  makeMap(opts) {
    this.mode = 'ctf';
    const real = opts.players.filter((p) => !p.neutral);
    const teams = [...new Set(real.map((p) => p.team))].sort((a, b) => a - b);
    const map = generateCtfMap(teams, this.seed);
    this.mapSize = 'ctf' + map.w;
    this._map = map;
    this.baseOf = new Map(map.bases.map((b) => [b.team, b]));
    // every player starts at their team's base
    map.starts = real.map((p) => { const b = this.baseOf.get(p.team); return { x: b.x, y: b.y, tx: b.tx, ty: b.ty }; });
    this.capsToWin = Math.max(1, Number(opts.ctfCaps) || 3);
    this.timeLimit = Math.max(1, Number(opts.ctfTime) || 15) * 60 * TICK_RATE;
    this.suddenUntil = this.timeLimit + CTF.sudden * 60 * TICK_RATE;
    this.ultUnlock = CTF.ultUnlockMin * 60 * TICK_RATE;
    this.flags = map.bases.map((b) => ({ team: b.team, hx: b.x, hy: b.y + 2.6, x: b.x, y: b.y + 2.6, state: FLAG_HOME, carrier: 0, dropAt: 0 }));
    this.caps = {};
    for (const b of map.bases) this.caps[b.team] = 0;
    this.sudden = false;
    return map;
  }

  makePlayer(p, idx) {
    const P = super.makePlayer(p, idx);
    P.neutral = !!p.neutral;
    P.age = CTF.heroAge;
    P.stats = computeStats(P.commander, P.age, []);
    P.res = { food: P.neutral ? 0 : CTF.startTips, wood: 0, spice: 0, salt: 0 };    // food = Tips
    P.items = {}; for (const k of ITEM_KEYS) P.items[k] = 0;
    P.caps = 0; P.deaths = 0; P.minions = 0; P.energyReady = 0; P.earned = 0;
    P.level = 1; P.xp = 0;
    P.popCap = 1; P.maxPop = 1;
    return P;
  }

  setupBase(P, s) {
    const base = this.baseOf.get(P.team);
    P.home = { x: base.x, y: base.y };
    if (!base.hq) {
      const hq = this.addBuilding(P.idx, 'hq', base.tx, base.ty, true);
      hq.invuln = true; hq.shared = true;
      base.hq = hq;
    }
    const pt = this.spawnPoint(base.hq, base.x + (this.players.filter((q) => q.team === P.team && q.idx < P.idx).length - 1) * 1.2, base.y + 2);
    this.spawnUnit(P.idx, COMMANDERS[P.commander].hero, pt[0], pt[1]);
  }

  /** The hero's stats at its level with the items bought so far (also fixes up a living hero). */
  refreshHero(P) {
    const type = COMMANDERS[P.commander].hero;
    const base = computeStats(P.commander, P.age, []).units[type];
    const S = ctfHeroStats(base, P.items, P.commander, P.level);
    const hero = P.heroId ? this.ents.get(P.heroId) : null;
    if (hero && !hero.dead) { const old = hero.S.hp; hero.S = S; hero.hp = Math.min(S.hp, hero.hp + Math.max(0, S.hp - old)); }
    P.stats.units[type] = S;
    return S;
  }

  /** XP: level up as it comes in (each level makes the hero tougher and hit harder, and tops up its health by the gain). */
  gainXp(P, n) {
    if (P.neutral || !P.alive || !(n > 0) || P.level >= CTF.level.max) return;
    P.xp += n;
    let up = false;
    while (P.level < CTF.level.max && P.xp >= ctfLevelNeed(P.level)) { P.xp -= ctfLevelNeed(P.level); P.level++; up = true; }
    if (P.level >= CTF.level.max) P.xp = 0;
    if (up) { this.refreshHero(P); this.events.push(['lvl', P.idx, P.level]); }
  }
  /** Set a hero's level outright (tests and tools). */
  setLevel(P, lv) { P.level = Math.max(1, Math.min(CTF.level.max, lv | 0)); P.xp = 0; this.refreshHero(P); }

  // the commanders' kits, scaled for a 15-minute match
  kitOf(P) { return ctfKit(COMMANDERS[P.commander]); }
  cdMul() { return CTF.abilityCdMul; }
  ultCdMul() { return CTF.ultCdMul; }
  cdOf(A, ult) { return A.ctfCd || A.cd * (ult ? CTF.ultCdMul : CTF.abilityCdMul); }      // the slows keep longer cooldowns of their own
  ultLocked() { return this.tick < this.ultUnlock; }
  ultLevel() { return Math.floor(this.tick / (6 * 60 * TICK_RATE)); }      // ultimates grow a step every six minutes
  heroRespawnTicks() { return Math.round(Math.min(CTF.respawn.max, CTF.respawn.base + CTF.respawn.perMin * this.tick / (60 * TICK_RATE)) * TICK_RATE); }
  tipJar(K, amount) { this.earn(K, amount); }
  earn(P, amount) { if (P.neutral) return; P.res.food += amount; P.earned += amount; P.score.gathered += amount; }
  heroOf(P) { const h = P.heroId ? this.ents.get(P.heroId) : null; return h && !h.dead ? h : null; }
  get neutral() { return this.players[this.players.length - 1]; }

  // ==========================================================================
  //  Camps
  // ==========================================================================
  spawnCamp(camp) {
    const N = this.neutral, def = camp.def, lvl = this.minionLevel;
    const stats = N.stats.units;
    camp.units.clear();
    def.units.forEach((type, k) => {
      const a = (k / def.units.length) * Math.PI * 2 + 0.6, r = def.units.length > 1 ? 1.1 : 0;
      const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
      const spot = this.pf.nearestFree(Math.floor(camp.x + dx), Math.floor(camp.y + dy), 4) || [Math.floor(camp.x), Math.floor(camp.y)];
      const u = this.spawnUnit(N.idx, type, spot[0] + 0.5, spot[1] + 0.5);
      const base = stats[type];
      u.S = { ...base, bonus: { ...base.bonus }, hp: Math.round(base.hp * (1 + CTF.minion.hp * lvl) * (def.hpMul || 1)), atk: Math.round(base.atk * (1 + CTF.minion.atk * lvl) * (def.atkMul || 1) * 10) / 10 };
      u.hp = u.S.hp; u.noPop = true; u.stance = camp.i + 1;                     // (the stance slot tells clients which camp it belongs to)
      u.camp = camp; u.campOff = [dx, dy];
      u.bounty = Math.round(def.bounty * (1 + CTF.minion.bounty * lvl) / def.units.length);
      if (def.boss) { u.boss = true; u.bounty = Math.round(def.bounty * (1 + CTF.minion.bounty * lvl)); }
      camp.units.add(u.id);
    });
    camp.alive = camp.units.size; camp.nextAt = 0; camp.level = lvl;
    this.events.push(['camp', camp.i, 'up']);
  }

  updateCamps() {
    const tick = this.tick;
    const lvl = Math.floor(tick / (CTF.minion.levelEvery * TICK_RATE));
    if (lvl !== this.minionLevel) { this.minionLevel = lvl; this.events.push(['minions', lvl]); }
    for (const camp of this.camps) {
      if (camp.nextAt && tick >= camp.nextAt) this.spawnCamp(camp);
    }
  }

  // ==========================================================================
  //  The loop
  // ==========================================================================
  step() {
    super.step();
    if (this.over) return;
    const tick = this.tick;
    if (tick % TICK_RATE === 0) for (const P of this.players) if (P.alive && !P.neutral) { this.earn(P, CTF.passiveTips); this.gainXp(P, CTF.level.xpPerSec); }
    if (tick % 5 === 0) this.fountains();
    this.updateCamps();
    this.updateFlags();
  }

  /** Fallen heroes come back at their team's kitchen (whoever owns the building). */
  updateHeroes() {
    for (const P of this.players) {
      if (P.neutral || !P.alive || P.heroId || !P.heroRespawn || this.tick < P.heroRespawn) continue;
      const base = this.baseOf.get(P.team);
      const pt = this.spawnPoint(base.hq, base.x, base.y + 2);
      this.spawnUnit(P.idx, COMMANDERS[P.commander].hero, pt[0], pt[1]);
      P.heroRespawn = 0;
      this.events.push(['heroup', P.idx]);
    }
  }

  /** Resigning takes your hero off the field; the team's kitchen stays for the others. */
  eliminate(P) {
    if (!P.alive) return;
    P.alive = false; P.score.outAt = this.tick;
    this.events.push(['elim', P.idx]);
    const hero = this.heroOf(P);
    if (hero) this.killEntity(hero, -1);
    P.heroRespawn = 0;
  }

  /** Heroes heal fast at their own kitchen. */
  fountains() {
    for (const P of this.players) {
      const hero = this.heroOf(P);
      if (!hero || P.neutral || hero.hp >= hero.S.hp) continue;
      const base = this.baseOf.get(P.team);
      if (Math.hypot(hero.x - base.x, hero.y - base.y) <= CTF.fountain.radius) hero.hp = Math.min(hero.S.hp, hero.hp + hero.S.hp * CTF.fountain.regenFrac * 0.25);
    }
  }

  atBase(P, u) { const b = this.baseOf.get(P.team); return Math.hypot(u.x - b.x, u.y - b.y) <= CTF.shopRadius; }
  /** Can anyone on `team` see unit u right now (its heroes' sight, or its kitchen's)? The bots play by this too. */
  seenBy(team, u) {
    if (this.opts.fog === 'off') return true;
    const b = this.baseOf.get(team);
    if (b && Math.hypot(u.x - b.x, u.y - b.y) <= 10) return true;
    for (const P of this.players) {
      if (P.team !== team || P.neutral) continue;
      const h = this.heroOf(P);
      if (h && Math.hypot(u.x - h.x, u.y - h.y) <= (h.S.sight || 7.5) + 0.5) return true;
    }
    return false;
  }

  // ==========================================================================
  //  Flags
  // ==========================================================================
  flagOf(team) { return this.flags.find((f) => f.team === team); }
  carrying(u) { return this.flags.find((f) => f.state === FLAG_CARRIED && f.carrier === u.id) || null; }
  flagEvent(kind, f, pi) { this.events.push(['flag', kind, f.team, pi, Math.round(f.x * POS_Q), Math.round(f.y * POS_Q)]); }

  returnFlag(f, pi) { f.state = FLAG_HOME; f.carrier = 0; f.x = f.hx; f.y = f.hy; f.dropAt = 0; f.revealAt = 0; this.flagEvent('return', f, pi); }
  dropFlag(f, x, y) {
    f.state = FLAG_DROPPED; f.carrier = 0; f.x = x; f.y = y; f.dropAt = this.tick; f.revealAt = 0;
    this.flagEvent('drop', f, -1);
  }

  updateFlags() {
    const tick = this.tick, heroes = [];
    for (const P of this.players) { const h = this.heroOf(P); if (h && !P.neutral && !h.stunned) heroes.push([P, h]); }
    for (const f of this.flags) {
      if (f.state === FLAG_CARRIED) {
        const u = this.ents.get(f.carrier), P = u ? this.players[u.owner] : null;
        if (!u || u.dead || !P) { this.dropFlag(f, f.x, f.y); continue; }
        f.x = u.x; f.y = u.y;
        (u.buffs || (u.buffs = {})).flagged = tick + 8;
        if (tick >= f.revealAt) {                                   // every few seconds the carrier shows up on everyone's minimap
          f.revealAt = tick + CTF.reveal * TICK_RATE; f.lastSeen = { x: u.x, y: u.y, tick };
          this.events.push(['reveal', f.team, Math.round(u.x * POS_Q), Math.round(u.y * POS_Q), P.idx]);
        }
        // home with it: reaching your own flag stand scores, wherever your own flag is right now
        const own = this.flagOf(P.team);
        if (own && Math.hypot(u.x - own.hx, u.y - own.hy) <= CTF.flag.capture) this.capture(f, P);
        continue;
      }
      if (f.state === FLAG_DROPPED && tick - f.dropAt >= CTF.flag.dropReturn * TICK_RATE) { this.returnFlag(f, -1); continue; }
      let taker = null, best = Infinity;
      for (const [P, h] of heroes) {
        const d = Math.hypot(h.x - f.x, h.y - f.y);
        if (d > CTF.flag.pickup) continue;
        if (P.team === f.team) { if (f.state === FLAG_DROPPED) { this.returnFlag(f, P.idx); taker = null; best = -1; break; } continue; }
        if (this.carrying(h)) continue;                       // one flag at a time
        if (d < best) { best = d; taker = [P, h]; }
      }
      if (taker) {
        f.state = FLAG_CARRIED; f.carrier = taker[1].id; f.x = taker[1].x; f.y = taker[1].y; this.flagEvent('take', f, taker[0].idx);
        f.revealAt = tick + CTF.reveal * TICK_RATE; f.lastSeen = { x: f.x, y: f.y, tick };          // everyone hears where it was taken
      }
    }
  }

  capture(f, P) {
    this.caps[P.team] = (this.caps[P.team] || 0) + 1;
    P.caps++;
    this.earn(P, 50);
    this.gainXp(P, CTF.level.capXp);
    f.x = f.hx; f.y = f.hy;
    this.flagEvent('cap', f, P.idx);
    f.state = FLAG_HOME; f.carrier = 0; f.revealAt = 0;
    this.checkVictory();
  }

  // ==========================================================================
  //  Deaths: bounties, dropped flags, respawns
  // ==========================================================================
  cleanup() {
    for (const e of this.deadList) {
      if (e.kind !== K_UNIT) continue;
      const K = e.killer >= 0 ? this.players[e.killer] : null, P = this.players[e.owner];
      const held = this.carrying(e);
      if (held) this.dropFlag(held, e.x, e.y);
      if (e.camp) {
        e.camp.units.delete(e.id);
        e.camp.alive = e.camp.units.size;
        if (!e.camp.alive) {
          e.camp.nextAt = this.tick + e.camp.def.respawn * TICK_RATE; this.events.push(['camp', e.camp.i, 'down']);
          const def = e.camp.def, kh = K && !K.neutral ? this.heroOf(K) : null;
          if (def.buff && kh) { this.addBuff(kh, def.buff, def.buffDur); this.events.push(['buffcamp', K.idx, e.camp.type]); }   // the last hit takes the buff
        }
        if (K && !K.neutral) { this.earn(K, Math.round(e.bounty * (K.gatherBonus || 1))); this.gainXp(K, Math.round(e.bounty * CTF.level.bountyXp)); K.minions++; this.events.push(['bounty', K.idx, e.bounty, Math.round(e.x * POS_Q), Math.round(e.y * POS_Q)]); }
      } else if (e.isHero && !P.neutral) {
        P.deaths++;
        if (K && K !== P && !K.neutral) {
          let tiers = 0; for (const k of ITEM_KEYS) tiers += P.items[k];
          const b = CTF.heroBounty + CTF.heroBountyPerTier * tiers + CTF.level.bountyPerLevel * (P.level - 1);
          this.earn(K, b); this.gainXp(K, CTF.level.killXp + CTF.level.killXpPerLevel * P.level); this.events.push(['bounty', K.idx, b, Math.round(e.x * POS_Q), Math.round(e.y * POS_Q)]);
        }
      }
    }
    super.cleanup();
  }

  // ==========================================================================
  //  Victory: captures, then the clock
  // ==========================================================================
  checkVictory() {
    if (this.over || this.teamsAtStart - 1 < 2) return;                 // (the wild kitchen is a team of its own; alone you just practise)
    const alive = new Set();
    for (const P of this.players) if (P.alive && !P.neutral) alive.add(P.team);
    const finish = (team) => { this.over = { team, tick: this.tick }; this.events.push(['over', team]); this.sample(true); };
    if (alive.size <= 1) { finish(alive.size ? [...alive][0] : -1); return; }
    let top = -1, lead = -1, tie = false;
    for (const t of alive) { const n = this.caps[t] || 0; if (n > top) { top = n; lead = t; tie = false; } else if (n === top) tie = true; }
    if (top >= this.capsToWin && !tie) { finish(lead); return; }
    if (this.tick >= this.timeLimit) {
      if (!tie) { finish(lead); return; }
      if (!this.sudden) { this.sudden = true; this.events.push(['sudden']); }
      if (this.tick >= this.suddenUntil) {                       // still level: most hero kills, then fewest deaths
        let best = null, bs = -Infinity;
        for (const t of alive) {
          let k = 0, d = 0;
          for (const P of this.players) if (P.team === t && !P.neutral) { k += P.score.heroKills; d += P.deaths; }
          const s = k * 10 - d;
          if (s > bs) { bs = s; best = t; }
        }
        finish(best);
      }
    }
  }

  // ==========================================================================
  //  Orders
  // ==========================================================================
  command(pi, c) {
    const P = this.players[pi];
    if (!P || P.neutral || !P.alive || this.over || !c || typeof c !== 'object') return;
    switch (c.c) {
      case 'mv': case 'am': case 'at': case 'st': case 'sn': case 'ab': case 'ul': case 'rg': super.command(pi, c); break;
      case 'buy': this.buy(P, c.item); break;
      case 'eat': this.eat(P); break;
      default: break;
    }
  }

  buy(P, key) {
    if (typeof key !== 'string' || !Object.hasOwn(CTF.items, key)) return false;
    const lv = P.items[key] | 0, cost = ctfItemCost(key, lv);
    if (!cost) { this.events.push(['note', P.idx, 'maxed']); return false; }
    const hero = this.heroOf(P);
    if (hero && !this.atBase(P, hero)) { this.events.push(['note', P.idx, 'shop']); return false; }
    if (P.res.food < cost) { this.events.push(['note', P.idx, 'tips']); return false; }
    P.res.food -= cost;
    P.items[key] = lv + 1;
    this.refreshHero(P);
    this.events.push(['item', P.idx, key, lv + 1]);
    return true;
  }

  eat(P) {
    const hero = this.heroOf(P);
    if (!hero) return false;
    if (this.tick < P.energyReady) { this.events.push(['note', P.idx, 'full']); return false; }
    if (P.res.food < CTF.energy.cost) { this.events.push(['note', P.idx, 'tips']); return false; }
    P.res.food -= CTF.energy.cost;
    P.energyReady = this.tick + CTF.energy.cd * TICK_RATE;
    this.addBuff(hero, 'energy', 4);
    this.events.push(['eat', P.idx, Math.round(hero.x * POS_Q), Math.round(hero.y * POS_Q)]);
    return true;
  }

  // ==========================================================================
  //  Network state and scores
  // ==========================================================================
  playerRec(P) {
    const r = super.playerRec(P);
    r[21] = ITEM_KEYS.map((k) => P.items[k]);
    r[22] = P.caps; r[23] = P.deaths; r[24] = P.energyReady; r[25] = P.minions; r[26] = P.score.heroKills;
    r[27] = P.level; r[28] = P.xp;
    return r;
  }
  ctfRec() { return { caps: this.caps, sudden: this.sudden ? 1 : 0, lvl: this.minionLevel }; }
  flagRec() { return this.flags.map((f) => [f.team, f.state, f.state === FLAG_CARRIED ? 0 : Math.round(f.x * POS_Q), f.state === FLAG_CARRIED ? 0 : Math.round(f.y * POS_Q), f.carrier, f.dropAt]); }
  campRec() { return this.camps.map((k) => [k.i, k.level, k.nextAt, k.alive]); }
  delta() {
    const out = super.delta();
    const a = JSON.stringify(this.ctfRec()); if (a !== this._ctfSig) { this._ctfSig = a; out.ctf = this.ctfRec(); }
    const b = JSON.stringify(this.flagRec()); if (b !== this._flagSig) { this._flagSig = b; out.flags = this.flagRec(); }
    const camps = [];
    for (const k of this.camps) { const s = k.level + ':' + k.nextAt + ':' + k.alive; if (s !== k._sig) { k._sig = s; camps.push([k.i, k.level, k.nextAt, k.alive]); } }
    if (camps.length) out.camps = camps;
    return out;
  }
  full() {
    const out = super.full();
    out.ctf = this.ctfRec(); out.flags = this.flagRec(); out.camps = this.campRec();
    return out;
  }
  startInfo() {
    const info = super.startInfo();
    info.mode = 'ctf';
    info.opts.mode = 'ctf'; info.opts.ctfCaps = this.capsToWin; info.opts.ctfTime = this.timeLimit / TICK_RATE / 60;
    info.players.forEach((p, i) => { if (this.players[i].neutral) p.neutral = true; });
    info.ctf = {
      capsToWin: this.capsToWin, timeLimit: this.timeLimit / TICK_RATE, sudden: CTF.sudden * 60, ultUnlock: this.ultUnlock / TICK_RATE, neutral: this.neutral.idx,
      bases: this._map.bases.map((b) => ({ team: b.team, x: b.x, y: b.y })),
      flags: this.flags.map((f) => ({ team: f.team, x: f.hx, y: f.hy })),
      camps: this.camps.map((k) => ({ x: k.x, y: k.y, type: k.type })),
    };
    return info;
  }

  scoreOf(P) {
    const s = P.score;
    const military = s.heroKills * 60 + P.minions * 4, economy = Math.round(P.earned / 4), technology = ITEM_KEYS.reduce((n, k) => n + P.items[k] * 40, 0), society = P.caps * 400;
    return { military, economy, technology, society, total: military + economy + technology + society };
  }
  sample(force) {
    const tl = this.tl, n = this.players.length;
    if (tl.t.length && tl.t[tl.t.length - 1] === this.tick) return;
    tl.t.push(this.tick);
    this.players.forEach((P, i) => {
      const row = tl.s[i];
      row.score.push(this.scoreOf(P).total); row.army.push(P.caps); row.pop.push(P.deaths); row.gathered.push(P.earned); row.kills.push(P.score.heroKills);
    });
    if (!force && tl.t.length >= 240) {
      tl.every *= 2;
      const keep = tl.t.map((t) => t % tl.every === 0);
      tl.t = tl.t.filter((_, k) => keep[k]);
      for (const row of tl.s) for (const key in row) row[key] = row[key].filter((_, k) => keep[k]);
    }
    void n;
  }
  timeline() {
    const out = super.timeline();
    const keep = this.players.map((P) => !P.neutral);
    for (const key in out.series) out.series[key] = out.series[key].filter((_, i) => keep[i]);
    out.labels = { score: 'Score', army: 'Captures', pop: 'Deaths', gathered: 'Tips earned', kills: 'Hero kills' };
    return out;
  }
  summary() {
    return super.summary().filter((s) => !this.players[s.idx].neutral).map((s) => {
      const P = this.players[s.idx];
      return { ...s, caps: P.caps, deaths: P.deaths, minions: P.minions, earned: P.earned, items: { ...P.items }, kills: P.score.heroKills, level: P.level, ctf: true };
    });
  }
}
