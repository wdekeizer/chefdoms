// ============================================================================
//  CHEFDOMS — bots for Capture the Flag. Each bot steers one hero through the
//  same orders a player has: farm camps for Tips, shop at the kitchen, run for
//  a flag when the coast is clear, chase whoever has ours, and fight when the
//  odds are good. Bots only know about enemy heroes their team can see; a flag
//  carrier out of sight is tracked by the same minimap reveals players get.
// ============================================================================
import { TICK_RATE, COMMANDERS, CTF, ctfItemCost, ctfKit } from './data.js';
import { ITEM_KEYS } from './ctf.js';

const LEVELS = {
  easy:    { think: 16, retreat: 0.22, run: 0.25, brave: 0.8, ability: 0.5, shopEvery: 2, danger: 1.5, react: 40 },
  normal:  { think: 10, retreat: 0.3, run: 0.5, brave: 1.0, ability: 0.85, shopEvery: 1, danger: 2.2, react: 24 },
  hard:    { think: 7, retreat: 0.33, run: 0.7, brave: 1.1, ability: 1, shopEvery: 1, danger: 2.8, react: 14 },
  extreme: { think: 5, retreat: 0.35, run: 0.85, brave: 1.2, ability: 1, shopEvery: 1, danger: 3.2, gatherBonus: 1.25, react: 8 },
};
const DANGER = { dishpit: 1, cooks: 2.2, sauce: 3, riders: 3, brutes: 5, pepper: 6, sugar: 6, critic: 8 };
// what each hero likes to buy first
const WANTS = {
  hero_dolly: ['stew', 'whites', 'skillet', 'herbs', 'espresso', 'clogs'],
  hero_kofi: ['skillet', 'espresso', 'stew', 'clogs', 'whites', 'herbs'],
  hero_ingrid: ['skillet', 'espresso', 'clogs', 'stew', 'herbs', 'whites'],
  hero_rafa: ['skillet', 'espresso', 'clogs', 'stew', 'whites', 'herbs'],
  hero_hank: ['stew', 'whites', 'skillet', 'herbs', 'espresso', 'clogs'],
  hero_nonna: ['stew', 'whites', 'herbs', 'skillet', 'espresso', 'clogs'],
  _: ['skillet', 'stew', 'espresso', 'whites', 'clogs', 'herbs'],
};

export class CtfBot {
  constructor(game, player, level = 'normal') {
    this.g = game; this.P = player;
    this.level = LEVELS[level] ? level : 'normal';
    this.L = LEVELS[this.level];
    player.gatherBonus = this.L.gatherBonus || 1;
    this.nextAt = 0; this.job = null; this.jobUntil = 0; this.lastOrder = ''; this.spotted = null;
    this.rng = (() => { let a = (player.idx * 7919 + 13) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  }

  update() {
    const g = this.g, P = this.P;
    if (g.tick < this.nextAt) return;
    this.nextAt = g.tick + this.L.think;
    try {
      const hero = g.heroOf(P);
      this.shop(hero);
      if (!hero) return;
      this.act(hero);
    } catch (e) { console.error('[ctf bot ' + P.name + ']', e); }
  }

  order(c) { this.g.command(this.P.idx, c); }
  moveTo(hero, x, y, tag) { if (this.lastOrder === tag && hero.order && hero.order.t === 'move') return; this.lastOrder = tag; this.order({ c: 'mv', ids: [hero.id], x, y }); }
  attack(hero, tg) { if (hero.order && hero.order.t === 'attack' && hero.order.id === tg.id) return; this.lastOrder = 'at' + tg.id; this.order({ c: 'at', ids: [hero.id], tid: tg.id }); }

  // ------------------------------------------------------------------ shopping
  shop(hero) {
    const g = this.g, P = this.P;
    if (hero && !g.atBase(P, hero)) return;
    const wants = WANTS[COMMANDERS[P.commander].hero] || WANTS._;
    for (let round = 0; round < 2; round++) {
      // the cheapest next tier among the first few preferences, so the build stays balanced
      let pick = null, best = Infinity;
      wants.forEach((k, i) => {
        const cost = ctfItemCost(k, P.items[k]);
        if (!cost || cost > P.res.food) return;
        const score = cost + i * 60 + P.items[k] * 120;
        if (score < best) { best = score; pick = k; }
      });
      if (!pick) return;
      this.order({ c: 'buy', item: pick });
    }
  }

  // ------------------------------------------------------------------- survey
  power(u) { return u.hp * u.S.atk * (u.S.reload ? 1.2 / u.S.reload : 1) * (u.S.range > 0 ? 1.15 : 1); }
  survey(hero) {
    const g = this.g, P = this.P;
    const c = { foes: [], allies: [], carrier: null, myFlag: g.flagOf(P.team), held: g.carrying(hero), base: g.baseOf.get(P.team), tiers: 0 };
    for (const k of ITEM_KEYS) c.tiers += P.items[k];
    for (const Q of g.players) {
      if (Q.neutral || !Q.alive) continue;
      const h = g.heroOf(Q);
      if (!h || h === hero) continue;
      const d = Math.hypot(h.x - hero.x, h.y - hero.y);
      if (Q.team === P.team) { c.allies.push([d, h]); continue; }
      if (!g.seenBy(P.team, h)) continue;                                                        // out of sight, out of mind
      const fb = g.baseOf.get(Q.team);
      c.foes.push([d, h, Q, Math.hypot(h.x - fb.x, h.y - fb.y) <= CTF.fountain.radius + 1]);     // [distance, hero, player, safe at its own kitchen]
    }
    c.foes.sort((a, b) => a[0] - b[0]); c.allies.sort((a, b) => a[0] - b[0]);
    if (c.myFlag && c.myFlag.state === 1) {
      const u = g.ents.get(c.myFlag.carrier) || null;
      if (u && !u.dead && g.seenBy(P.team, u)) c.carrier = u;
      else if (c.myFlag.lastSeen && g.tick - c.myFlag.lastSeen.tick < (CTF.reveal + 3) * TICK_RATE) c.lastSeen = c.myFlag.lastSeen;   // where it was taken, or the last minimap reveal
    }
    c.hpFrac = hero.hp / hero.S.hp;
    c.atHome = Math.hypot(hero.x - c.base.x, hero.y - c.base.y) <= CTF.fountain.radius;
    return c;
  }

  // ---------------------------------------------------------------- the brain
  act(hero) {
    const g = this.g, P = this.P, L = this.L, c = this.survey(hero);
    this.abilities(hero, c);
    const near = c.foes.filter((f) => f[0] <= 9 && (!f[3] || g.carrying(f[1])));          // nobody is worth chasing into their own kitchen, unless they hold a flag
    const myPower = this.power(hero) * L.brave + c.allies.filter((a) => a[0] <= 8).reduce((s, a) => s + this.power(a[1]) * 0.7, 0);
    const theirPower = near.reduce((s, f) => s + this.power(f[1]), 0);

    // 1. carrying a flag: home, unless our own flag is away (then hold at the base)
    if (c.held) {
      if (c.hpFrac < 0.35 && near.length && P.res.food >= CTF.energy.cost && g.tick >= P.energyReady) this.order({ c: 'eat' });
      if (c.myFlag.state !== 0 && c.atHome) { if (near.length) this.attack(hero, near[0][1]); else this.moveTo(hero, c.myFlag.hx, c.myFlag.hy, 'home'); return; }
      this.moveTo(hero, c.myFlag.hx, c.myFlag.hy, 'home');
      return;
    }
    // 2. hurt: back to the kitchen (unless the enemy there is weaker and we can finish it)
    if (c.hpFrac < L.retreat && !(near.length === 1 && near[0][1].hp < hero.hp * 0.5)) {
      if (!c.atHome) { if (c.hpFrac < 0.25 && P.res.food >= CTF.energy.cost && g.tick >= P.energyReady && near.length) this.order({ c: 'eat' }); this.moveTo(hero, c.base.x, c.base.y + 2, 'heal'); return; }
      if (near.length) { this.attack(hero, near[0][1]); return; }
      if (c.hpFrac < 0.9) { if (hero.order) this.order({ c: 'st', ids: [hero.id] }); return; }
    }
    // 3. someone has our flag: run them down once we have seen them (it takes a moment to react)...
    if (c.carrier && !c.carrier.dead) {
      if (!this.spotted || this.spotted.id !== c.carrier.id) this.spotted = { id: c.carrier.id, tick: g.tick };
      const d = Math.hypot(c.carrier.x - hero.x, c.carrier.y - hero.y);
      const others = c.allies.filter((a) => Math.hypot(a[1].x - c.carrier.x, a[1].y - c.carrier.y) < d - 3).length;
      if (g.tick - this.spotted.tick >= L.react && (d < 30 || others === 0)) { this.attack(hero, c.carrier); return; }
    } else {
      this.spotted = null;
      // ...out of sight: whoever of us is closest goes to look where it was last seen; the others carry on
      if (c.lastSeen) {
        const ls = c.lastSeen, d = Math.hypot(ls.x - hero.x, ls.y - hero.y);
        const closer = c.allies.some((a) => Math.hypot(a[1].x - ls.x, a[1].y - ls.y) < d);
        if (!closer && d < 45 && d > 2) { this.moveTo(hero, ls.x, ls.y, 'hunt' + ls.tick); return; }
      }
    }
    // 3b. an intruder near our flag stand while we are close and healthy: see them off
    if (c.myFlag && c.myFlag.state === 0 && c.hpFrac > 0.5) {
      const dHome = Math.hypot(c.myFlag.hx - hero.x, c.myFlag.hy - hero.y);
      if (dHome < 26) {
        const intruder = c.foes.find((f) => Math.hypot(f[1].x - c.myFlag.hx, f[1].y - c.myFlag.hy) < 12 && f[0] < 30);
        if (intruder) { this.attack(hero, intruder[1]); return; }
      }
    }
    // 4. our flag lies on the ground: fetch it
    if (c.myFlag && c.myFlag.state === 2) {
      const d = Math.hypot(c.myFlag.x - hero.x, c.myFlag.y - hero.y);
      if (d < 25 && !c.allies.some((a) => Math.hypot(a[1].x - c.myFlag.x, a[1].y - c.myFlag.y) < d - 2)) { this.moveTo(hero, c.myFlag.x, c.myFlag.y, 'fetch'); return; }
    }
    // 5. enemies about: fight when the odds are good, or when they carry a flag; otherwise get out of their way
    if (near.length) {
      const carrierNear = near.find((f) => g.carrying(f[1]));
      const target = carrierNear ? carrierNear[1] : near.reduce((m, f) => (f[1].hp / f[1].S.hp < m[1].hp / m[1].S.hp ? f : m))[1];
      const runFlag = this.job && this.job.kind === 'run' ? this.job.flag : null;
      if (carrierNear || myPower >= theirPower * 0.9) { this.attack(hero, target); return; }
      if (runFlag && c.hpFrac > 0.5 && Math.hypot(runFlag.x - hero.x, runFlag.y - hero.y) < 12 && theirPower < myPower * 1.6) { this.moveTo(hero, runFlag.x, runFlag.y, 'run' + runFlag.team); return; }
      if (c.hpFrac < 0.55) { if (!c.atHome) this.moveTo(hero, c.base.x, c.base.y + 2, 'heal'); return; }
      this.job = null;                                           // healthy but outgunned: go and do something else
      const away = { x: hero.x + (hero.x - near[0][1].x) * 3, y: hero.y + (hero.y - near[0][1].y) * 3 };
      if (near[0][0] < 5) { this.moveTo(hero, Math.max(1, Math.min(g.w - 2, away.x)), Math.max(1, Math.min(g.h - 2, away.y)), 'away'); return; }
    }
    // 6. a flag run, when healthy and nobody is minding it
    if (!this.job || g.tick > this.jobUntil) this.job = null;
    if (!this.job && c.hpFrac > 0.75 && (c.tiers >= 2 || g.tick > 2 * 60 * TICK_RATE) && this.rng() < L.run * 0.25) {
      const runner = (g._ctfRunners || (g._ctfRunners = {}))[P.team];
      if (!runner || runner.until < g.tick || runner.id === P.idx) {
        let best = null, bs = Infinity;
        for (const f of g.flags) {
          if (f.team === P.team || f.state === 1) continue;
          const d = Math.hypot(f.x - hero.x, f.y - hero.y);
          let guards = 0;
          for (const [, h, Q] of c.foes) if (Q.team === f.team && Math.hypot(h.x - f.x, h.y - f.y) < 12) guards++;
          const s = d + guards * 25;
          if (s < bs) { bs = s; best = f; }
        }
        if (best) { this.job = { kind: 'run', flag: best }; this.jobUntil = g.tick + 60 * TICK_RATE; g._ctfRunners[P.team] = { id: P.idx, until: this.jobUntil }; }
      }
    }
    if (this.job && this.job.kind === 'run') {
      const f = this.job.flag;
      if (f.state === 1 && f.carrier !== hero.id) { this.job = null; } else { this.moveTo(hero, f.x, f.y, 'run' + f.team); return; }
    }
    // 7. otherwise farm the most rewarding camp we can handle
    const allowed = L.danger + c.tiers * 0.7 + c.allies.filter((a) => a[0] <= 10).length * 2 + (c.hpFrac - 0.5) * 2;
    let camp = null, bs = Infinity;
    for (const k of g.camps) {
      if (!k.alive) continue;
      const danger = DANGER[k.type] || 2;
      if (danger > allowed) continue;
      const d = Math.hypot(k.x - hero.x, k.y - hero.y);
      // the critic and the buff camps are worth a trip; other camps near enemy kitchens are not
      let s = d - danger * 2.5 - (CTF.camps[k.type].buff ? 12 : 0);
      for (const b of g.baseOf.values()) if (b.team !== P.team && Math.hypot(k.x - b.x, k.y - b.y) < 12) s += 20;
      if (s < bs) { bs = s; camp = k; }
    }
    if (camp) {
      let tg = null, th = Infinity;
      for (const id of camp.units) { const u = g.ents.get(id); if (u && !u.dead && u.hp < th) { th = u.hp; tg = u; } }
      if (tg) { this.attack(hero, tg); return; }
    }
    // nothing worth doing: drift to the middle of our half
    if (!hero.order) this.moveTo(hero, (c.base.x + g.w / 2) / 2, (c.base.y + g.h / 2) / 2, 'drift');
  }

  // ---------------------------------------------------------------- abilities
  abilities(hero, c) {
    const g = this.g, P = this.P, L = this.L, kit = ctfKit(COMMANDERS[P.commander]);
    if (this.rng() > L.ability) return;
    const A = kit.ability, U = kit.ultimate;
    const foesIn = (R) => c.foes.filter((f) => f[0] <= R).length;
    const fighting = foesIn(8) > 0 || (hero.order && hero.order.t === 'attack');
    const hurt = c.hpFrac < 0.6;
    if (g.tick >= P.abilityReady) {
      let go = false;
      switch (A.key) {
        case 'mangia': case 'brace': go = hurt && fighting; break;
        case 'lowslow': go = fighting && (hurt || foesIn(6) >= 2); break;
        case 'cuts': case 'chill': go = foesIn(A.radius) >= 1; break;
        case 'dash': case 'snipe': go = foesIn(A.radius) >= 1 && (c.hpFrac > 0.4 || c.held); break;
        case 'service': go = fighting; break;
        case 'sugar': case 'rush': go = !!c.held || (c.carrier && !c.carrier.dead) || (fighting && hurt); break;
        default: go = fighting;
      }
      if (go) this.order({ c: 'ab' });
    }
    if (!g.ultLocked(P) && g.tick >= P.ultReady) {
      let go = false;
      switch (U.key) {
        case 'flambe': case 'storm': case 'freeze': case 'glass': go = foesIn(U.radius || 6) >= 2 || (foesIn(U.radius || 6) >= 1 && (hurt || c.held)); break;
        case 'perfectcut': case 'flood': go = foesIn(U.radius || 8) >= 1 && (c.foes[0][1].hp / c.foes[0][1].S.hp < 0.6 || foesIn(U.radius || 8) >= 2); break;
        case 'feast': case 'lastcall': case 'bark': go = fighting && c.hpFrac < 0.5; break;
        case 'swarm': go = fighting || !!c.held; break;
        default: go = fighting;
      }
      if (go) this.order({ c: 'ul' });
    }
  }
}
