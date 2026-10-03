// Rule checks for the simulation: economy, construction, production, combat,
// heroes, abilities and victory. Run with:  node tools/rules-test.js
import { Game, K_UNIT, K_BLDG, ST } from '../game/sim.js';
import { TICK_RATE, COMMANDERS, COMMANDER_KEYS, UNITS, BUILDINGS, TECHS, computeStats, techCost, TILE } from '../game/data.js';

let failed = 0, passed = 0;
const ok = (cond, name, extra = '') => { if (cond) passed++; else failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const mk = (cmds = ['flint', 'nonna'], opts = {}) => new Game({
  players: cmds.map((c, i) => ({ name: 'P' + i, commander: c, team: opts.teams ? opts.teams[i] : i, color: i })),
  mapSize: 'small', startRes: opts.startRes || 'feast', popCap: 100, seed: opts.seed || 7, victory: opts.victory,
});
const run = (g, seconds) => { for (let i = 0; i < seconds * TICK_RATE; i++) g.step(); };
const mine = (g, pi, pred) => g.units.filter((u) => u.owner === pi && pred(u));
const hqOf = (g, pi) => g.bldgs.find((b) => b.owner === pi && b.type === 'hq');
/** A free spot for a building near player pi's home. */
function spot(g, pi, type, minR = 4) {
  const h = g.players[pi].home, n = BUILDINGS[type].size;
  for (let r = minR; r < 16; r++) for (let a = 0; a < 40; a++) {
    const tx = Math.round(h.x + Math.cos(a) * r), ty = Math.round(h.y + Math.sin(a) * r);
    let good = tx > 1 && ty > 1 && tx + n < g.w - 1 && ty + n < g.h - 1;
    for (let y = ty - 1; y <= ty + n && good; y++) for (let x = tx - 1; x <= tx + n; x++) if (g.tiles[y * g.w + x] !== TILE.GRASS || g.occ[y * g.w + x]) { good = false; break; }
    if (good) return [tx, ty];
  }
  throw new Error('no spot for ' + type);
}
function build(g, pi, type, finish = true) {
  const [tx, ty] = spot(g, pi, type);
  const cooks = mine(g, pi, (u) => u.isCook).map((u) => u.id);
  const before = g.bldgs.length;
  g.command(pi, { c: 'bp', ids: cooks, b: type, tx, ty });
  const b = g.bldgs.length > before ? g.bldgs[g.bldgs.length - 1] : null;
  if (b && finish) for (let i = 0; i < 400 * TICK_RATE && !b.done; i++) g.step();
  return b;
}
const setAge = (g, pi, age) => { const P = g.players[pi]; while (P.age < age) g.completeTech(P, 'age' + (P.age + 1)); };

// ------------------------------------------------------------------ data sanity
{
  let bad = [];
  for (const k of COMMANDER_KEYS) {
    const C = COMMANDERS[k];
    if (!UNITS[C.hero] || !UNITS[C.unique] || !UNITS[C.unique].tags.includes('unique')) bad.push(k + ' hero/unique');
    if (C.bonuses.length !== 3) bad.push(k + ' bonuses');
    const st = computeStats(k, 4, Object.keys(TECHS));
    for (const u in st.units) { const S = st.units[u]; if (!(S.hp > 0) || Number.isNaN(S.atk) || !(S.speed > 0)) bad.push(k + ':' + u); for (const r in S.cost) if (!(S.cost[r] >= 0)) bad.push(k + ':' + u + ' cost'); }
  }
  for (const b in BUILDINGS) { for (const t of BUILDINGS[b].techs) if (!TECHS[t]) bad.push('tech ' + t); for (const u of BUILDINGS[b].trains) if (u !== 'unique' && !UNITS[u]) bad.push('unit ' + u); }
  for (const t in TECHS) { if (TECHS[t].req && !TECHS[TECHS[t].req]) bad.push('req ' + t); if (!Object.values(BUILDINGS).some((B) => B.techs.includes(t))) bad.push('unreachable tech ' + t); }
  ok(bad.length === 0, 'game data is consistent', bad.join(', '));
}

// ------------------------------------------------------------------ soundtrack
{
  const { TRACKS, STINGERS, parseSeq } = await import('../public/client/tracks.js');
  const bad = [];
  for (const t of [...TRACKS, ...Object.values(STINGERS)]) {
    let lens;
    try { lens = t.parts.map((p) => parseSeq(p.seq).len); } catch (e) { bad.push((t.id || 'stinger') + ': ' + e.message); continue; }
    if (t.id && new Set(lens).size !== 1) bad.push(`${t.id}: parts have different lengths ${lens.join('/')}`);
  }
  ok(bad.length === 0 && TRACKS.length >= 6, 'every music track parses and its parts line up', bad.join('; '));
}

// ---------------------------------------------------------------------- economy
{
  const g = mk(['flint', 'nonna'], { startRes: 'standard' });
  const P = g.players[0], cooks = mine(g, 0, (u) => u.isCook);
  ok(cooks.length === 4 && P.pop === 4 && P.popCap === 10 && P.heroId > 0, 'start: 4 prep cooks, a hero, staff 4/10');
  const veg = g.findNode('veg', P.home.x, P.home.y, 20), food0 = P.res.food;
  g.command(0, { c: 'ga', ids: cooks.map((u) => u.id), tid: veg.id });
  run(g, 40);
  ok(P.res.food > food0 + 30, 'cooks gather produce and deliver it', `+${P.res.food - food0} in 40s`);
  const tree = g.findTree(P.home.x, P.home.y, 20), wood0 = P.res.wood;
  g.command(0, { c: 'ga', ids: cooks.map((u) => u.id), tree });
  run(g, 45);
  ok(P.res.wood > wood0 + 20, 'cooks chop firewood', `+${P.res.wood - wood0} in 45s`);
  ok(new Set(cooks.map((u) => u.order && u.order.tree)).size >= 2, 'a group spreads over several trees');
  for (const type of ['spice', 'salt']) {
    const n = g.findNode(type, P.home.x, P.home.y, 30), r0 = P.res[type];
    g.command(0, { c: 'ga', ids: cooks.map((u) => u.id), tid: n.id });
    run(g, 60);
    ok(P.res[type] > r0 + 15, `cooks gather ${type}`, `+${P.res[type] - r0} in 60s`);
  }
}
{
  const g = mk();
  const P = g.players[0];
  const garden = build(g, 0, 'garden');
  ok(garden && garden.done, 'a garden plot can be built');
  run(g, 3);
  const workers = mine(g, 0, (u) => u.isCook && u.order && u.order.t === 'gather' && u.order.gid === garden.id);
  ok(workers.length === 1, 'exactly one cook works a garden after building it', `(${workers.length})`);
  const f0 = P.res.food; run(g, 60);
  ok(P.res.food > f0 + 15, 'the garden produces food', `+${P.res.food - f0} in 60s`);
  // tree depletion turns into a stump and frees the tile
  const t = g.findTree(P.home.x, P.home.y, 20);
  g.treeWood[t] = 3;
  g.command(0, { c: 'ga', ids: mine(g, 0, (u) => u.isCook && !(u.order && u.order.gid)).slice(0, 1).map((u) => u.id), tree: t });
  run(g, 40);
  ok(g.tiles[t] === TILE.STUMP && !g.block[t], 'a felled tree becomes a walkable stump');
}

// ---------------------------------------------------------- building & training
{
  const g = mk();
  const P = g.players[0];
  const wood0 = P.res.wood;
  const house = build(g, 0, 'house', false);
  ok(house && !house.done && P.res.wood === wood0 - 30, 'placing a station charges its cost up front');
  ok(!g.canPlace('house', house.tx, house.ty), 'cannot place a station on top of another');
  ok(!build(g, 0, 'sauce', false), 'age-locked stations are refused');
  run(g, 30);
  ok(house.done && P.popCap === 18, 'a finished Break Room raises the staff limit', `cap ${P.popCap}`);
  // cancel construction refunds
  const w1 = P.res.wood;
  const grill = build(g, 0, 'grill', false);
  g.command(0, { c: 'dl', ids: [grill.id] }); run(g, 0.2);
  ok(P.res.wood === w1, 'cancelling an unstarted station refunds it in full', `${P.res.wood} vs ${w1}`);
  // training, queue, cancel
  const hq = hqOf(g, 0), f0 = P.res.food;
  g.command(0, { c: 'tr', bid: hq.id, u: 'cook', n: 5 });
  ok(hq.q.length === 5 && P.res.food === f0 - 250, 'queueing five cooks charges for five');
  g.command(0, { c: 'cq', bid: hq.id, i: 4 });
  ok(hq.q.length === 4 && P.res.food === f0 - 200, 'cancelling a queued unit refunds it');
  g.command(0, { c: 'tr', bid: hq.id, u: 'truck' });
  g.command(0, { c: 'tr', bid: hq.id, u: 'hero_flint' });
  g.command(0, { c: 'tr', bid: hq.id, u: 'line' });
  ok(hq.q.length === 4, 'a station only trains what it is meant to');
  const n0 = mine(g, 0, (u) => u.isCook).length;
  run(g, 60);
  ok(mine(g, 0, (u) => u.isCook).length === n0 + 4, 'queued cooks are trained');
  // rally point onto a resource puts new cooks to work
  const veg = g.findNode('veg', P.home.x, P.home.y, 20);
  g.command(0, { c: 'ry', bids: [hq.id], x: veg.x, y: veg.y, tid: veg.id });
  g.command(0, { c: 'tr', bid: hq.id, u: 'cook' });
  run(g, 20);
  const newest = mine(g, 0, (u) => u.isCook).sort((a, b) => b.id - a.id)[0];
  ok(newest.order && newest.order.t === 'gather', 'a rally point on a veggie patch sends new cooks to gather');
  // staff limit blocks spawning
  P.maxPop = P.pop; g.refreshBuildings(P);
  g.command(0, { c: 'tr', bid: hq.id, u: 'cook' });
  const pop0 = P.pop; run(g, 20);
  ok(P.pop === pop0 && hq.q.length === 1, 'training waits when the staff limit is reached');
}

// ------------------------------------------------------------- research & ages
{
  const g = mk(['odile', 'flint']);
  const P = g.players[0], hq = hqOf(g, 0);
  const f0 = P.res.food;
  g.command(0, { c: 'rs', bid: hq.id, tech: 'age3' });
  ok(hq.q.length === 0, 'cannot skip an age');
  g.command(0, { c: 'rs', bid: hq.id, tech: 'age2' });
  g.command(0, { c: 'rs', bid: hq.id, tech: 'age2' });
  ok(hq.q.length === 1 && P.res.food === f0 - 400, 'age-up is queued once and paid for');
  run(g, 45);
  ok(P.age === 2, 'advancing to the next age works');
  const hero = g.ents.get(P.heroId);
  ok(hero.S.hp > UNITS.hero_odile.hp && hero.hp === hero.S.hp, 'the hero grows stronger with the age');
  const lab = build(g, 0, 'lab');
  const cost = techCost('knives1', P.stats.misc);
  ok(cost.food === 65 && cost.spice === 35, "Odile's upgrades are a third cheaper", JSON.stringify(cost));
  g.command(0, { c: 'rs', bid: lab.id, tech: 'knives2' });
  ok(lab.q.length === 0, 'an upgrade needs its prerequisite');
  const pantry = build(g, 0, 'pantry');
  const rate0 = P.stats.units.cook.gather.wood;
  g.command(0, { c: 'rs', bid: pantry.id, tech: 'hatchet1' });
  run(g, 25);
  ok(P.techs.includes('hatchet1') && Math.abs(P.stats.units.cook.gather.wood / rate0 - 1.15) < 1e-6, 'a researched upgrade changes the stats');
}

// ----------------------------------------------------------------------- combat
{
  const g = mk(['flint', 'nonna']);
  setAge(g, 0, 3); setAge(g, 1, 3);
  const h0 = g.players[0].home, h1 = g.players[1].home;
  const mid = { x: (h0.x + h1.x) / 2, y: (h0.y + h1.y) / 2 };
  const free = g.pf.nearestFree(Math.round(mid.x), Math.round(mid.y), 20);
  const duel = (a, b, n = 1, m = 1) => {
    const A = [], B = [];
    for (let i = 0; i < n; i++) A.push(g.spawnUnit(0, a, free[0] + 0.5 - 2, free[1] + 0.5 + i * 0.3));
    for (let i = 0; i < m; i++) B.push(g.spawnUnit(1, b, free[0] + 0.5 + 2, free[1] + 0.5 + i * 0.3));
    for (let i = 0; i < 90 * TICK_RATE; i++) { g.step(); if (A.every((u) => u.dead) || B.every((u) => u.dead)) break; }
    const res = A.every((u) => u.dead) ? 'B' : B.every((u) => u.dead) ? 'A' : '?';
    for (const u of [...A, ...B]) if (!u.dead) g.killEntity(u, -1);
    g.step();
    return res;
  };
  ok(duel('line', 'line') !== '?', 'two idle enemies find and fight each other');
  ok(duel('butcher', 'scooter', 2, 1) === 'A', 'two Butchers beat a Scooter (anti-vehicle bonus)');
  ok(duel('scooter', 'saucier', 1, 1) === 'A', 'a Scooter runs down a Saucier');
  ok(duel('saucier', 'butcher', 3, 3) === 'A', 'Sauciers out-trade Butchers');
  ok(duel('truck', 'line', 1, 2) === 'A', 'a Food Truck beats two Line Cooks');
  ok(duel('line', 'catapult', 1, 1) === 'A', 'a Line Cook kills a Catapult up close');
  // ranged barely hurts stations; siege wrecks them
  const tgt = g.addBuilding(1, 'house', free[0] + 3, free[1] - 1, true);
  const s = g.spawnUnit(0, 'saucier', free[0] - 1.5, free[1] + 0.5);
  g.command(0, { c: 'at', ids: [s.id], tid: tgt.id });
  run(g, 20);
  const dmgS = tgt.S.hp - tgt.hp;
  g.killEntity(s, -1); tgt.hp = tgt.S.hp;
  const ram = g.spawnUnit(0, 'ram', free[0] - 1.5, free[1] + 0.5);
  g.command(0, { c: 'at', ids: [ram.id], tid: tgt.id });
  run(g, 20);
  const dmgR = tgt.S.hp - tgt.hp;
  ok(dmgS > 0 && dmgS < 30 && (dmgR > 250 || tgt.dead), 'sauce tickles stations, a Battering Baguette wrecks them', `saucier ${dmgS | 0}, ram ${tgt.dead ? 'destroyed' : dmgR | 0}`);
  // towers shoot
  const tower = g.addBuilding(0, 'tower', free[0] - 6, free[1] - 3, true);
  const victim = g.spawnUnit(1, 'line', tower.x + 3, tower.y + 2);
  g.setOrder(victim, { t: 'move', x: tower.x + 3, y: tower.y + 2.1 });
  run(g, 6);
  ok(victim.hp < victim.S.hp, 'a Pepper Mill Tower shoots enemies in range');
  // barista heals
  const hurt = g.spawnUnit(0, 'line', free[0] - 8, free[1] + 4);
  hurt.hp = 10;
  const bar = g.spawnUnit(0, 'barista', free[0] - 9, free[1] + 4);
  run(g, 8);
  ok(hurt.hp > 30 && bar.st === ST.HEAL || hurt.hp >= hurt.S.hp, 'an idle Barista heals wounded friends', `hp ${hurt.hp | 0}`);
}

// ------------------------------------------------------------- heroes & abilities
{
  for (const key of COMMANDER_KEYS) {
    const g = mk([key, 'flint'], { seed: 11 });
    const P = g.players[0], C = COMMANDERS[key], hero = g.ents.get(P.heroId);
    const pals = [0, 1, 2].map((i) => g.spawnUnit(0, 'line', hero.x + 1 + i * 0.4, hero.y + 1.5));
    const foes = [0, 1, 2].map((i) => g.spawnUnit(1, 'line', hero.x + 1 + i * 0.4, hero.y + 3));
    for (const f of foes) { f.S = { ...f.S, atk: 0.001 }; }
    for (const p of pals) p.hp = p.S.hp * 0.5;
    run(g, 0.5);
    ok(pals.every((u) => u.bmask & 0x3f0), `${key}: the hero's aura reaches nearby units`);
    const before = { foeHp: foes.map((f) => f.hp), palHp: pals.map((p) => p.hp) };
    g.command(0, { c: 'ab' });
    let good = P.abilityReady > g.tick;
    if (C.ability.key === 'cuts') good = good && foes.every((f, i) => f.dead || f.hp < before.foeHp[i] - 20);
    else if (C.ability.key === 'mangia') { run(g, 3); good = good && pals.every((p, i) => p.hp > before.palHp[i] + 5); }
    else if (C.ability.key === 'lunch') good = good && P.lunchUntil > g.tick;
    else good = good && pals.every((u) => u.buffs && u.buffs[C.ability.key]);
    const ready = P.abilityReady;
    g.command(0, { c: 'ab' });
    ok(good && P.abilityReady === ready, `${key}: "${C.ability.name}" works and then goes on cooldown`);
  }
  const g = mk(['zara', 'flint']);
  const P = g.players[0], hero = g.ents.get(P.heroId);
  const spice0 = P.res.spice;
  const foe = g.spawnUnit(1, 'cook', hero.x + 1.5, hero.y + 1.5);
  g.command(0, { c: 'at', ids: [hero.id], tid: foe.id });
  run(g, 12);
  ok(foe.dead && P.res.spice > spice0, "Zara's Tip Jar pays spice for kills near her", `+${P.res.spice - spice0}`);
  g.killEntity(hero, 1); run(g, 1);
  ok(P.heroId === 0 && P.heroRespawn > g.tick, 'a fallen hero is scheduled to return');
  run(g, 40);
  ok(P.heroId > 0 && g.ents.get(P.heroId).hp === g.ents.get(P.heroId).S.hp, 'the hero respawns at the Kitchen HQ at full health');
  g.command(0, { c: 'dl', ids: [P.heroId] }); run(g, 0.2);
  ok(P.heroId > 0, 'the hero cannot be deleted');
}

// ---------------------------------------------------------------------- victory
{
  const g = mk(['flint', 'nonna']);
  run(g, 2);
  g.killEntity(hqOf(g, 1), 0); run(g, 2);
  ok(g.over && g.over.team === 0 && !g.players[1].alive, 'HQ victory: losing the last Kitchen HQ eliminates you');
  ok(!g.units.some((u) => u.owner === 1), "an eliminated player's units leave the field");
}
{
  const g = mk(['flint', 'nonna'], { victory: 'conquest' });
  build(g, 1, 'house');
  g.killEntity(hqOf(g, 1), 0); run(g, 2);
  ok(!g.over && g.players[1].alive, 'Conquest: losing the HQ is not the end while other stations stand');
  for (const b of g.bldgs) if (b.owner === 1) g.killEntity(b, 0);
  run(g, 2);
  ok(g.over && g.over.team === 0, 'Conquest: losing every station is');
}
{
  const g = mk(['flint', 'nonna', 'hank', 'ryo'], { teams: [1, 1, 2, 2] });
  run(g, 1);
  g.command(2, { c: 'rg' }); run(g, 1.5);
  ok(!g.over && !g.players[2].alive, 'teams: one ally resigning does not end the match');
  // allies do not shoot each other
  const a = g.ents.get(g.players[0].heroId), b = g.ents.get(g.players[1].heroId);
  b.x = a.x + 1; b.y = a.y; run(g, 3);
  ok(a.hp === a.S.hp && b.hp === b.S.hp, 'allies never attack each other');
  g.command(0, { c: 'at', ids: [a.id], tid: b.id }); run(g, 2);
  ok(b.hp === b.S.hp, 'and cannot be ordered to');
  g.command(3, { c: 'rg' }); run(g, 1.5);
  ok(g.over && g.over.team === 1, 'teams: the match ends when one team is left');
}
{
  const g = mk(['flint']);
  run(g, 3);
  ok(!g.over, 'a solo sandbox never ends on its own');
}

// ----------------------------------------------------------- hostile input fuzz
{
  const g = mk(['flint', 'nonna'], { seed: 3 });
  const junk = [undefined, null, NaN, Infinity, -1, 0, 1e9, '', 'x', '__proto__', 'constructor', [], {}, [1, 2, 3], { length: 5 }, true];
  const pick = () => junk[(Math.random() * junk.length) | 0];
  const cmds = ['mv', 'am', 'at', 'hl', 'ga', 'bp', 'ba', 'tr', 'rs', 'cq', 'ry', 'st', 'dl', 'ab', 'zz'];
  let threw = null;
  try {
    for (let i = 0; i < 4000; i++) {
      const ids = Math.random() < 0.5 ? g.units.slice(0, 6).map((u) => u.id) : pick();
      g.command((Math.random() * 3) | 0, { c: cmds[(Math.random() * cmds.length) | 0], ids, bids: pick(), bid: Math.random() < 0.5 ? hqOf(g, 0).id : pick(), tid: Math.random() < 0.5 ? g.nextId * Math.random() | 0 : pick(), x: pick(), y: pick(), tx: pick(), ty: pick(), b: Math.random() < 0.5 ? 'house' : pick(), u: Math.random() < 0.5 ? 'cook' : pick(), tech: Math.random() < 0.5 ? 'age2' : pick(), tree: pick(), i: pick(), n: pick(), q: pick() });
      if (i % 40 === 0) { g.step(); g.delta(); }
    }
    run(g, 10);
  } catch (e) { threw = e; }
  ok(!threw, 'thousands of malformed commands never crash the simulation', threw ? threw.stack : '');
  let sane = true;
  for (const u of g.units) if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.hp)) sane = false;
  for (const P of g.players) for (const r in P.res) if (!Number.isFinite(P.res[r]) || P.res[r] < 0) sane = false;
  ok(sane, 'and leave no broken numbers behind');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
