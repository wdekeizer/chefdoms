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
  const { TRACKS, STINGERS, TRACK_PROBLEMS, parseSeq } = await import('../public/client/tracks.js');
  const bad = [...TRACK_PROBLEMS];
  for (const t of [...TRACKS, ...Object.values(STINGERS)]) {
    let lens;
    try { lens = t.parts.map((p) => parseSeq(p.seq).len); } catch (e) { bad.push((t.id || 'stinger') + ': ' + e.message); continue; }
    if (t.id && new Set(lens).size !== 1) bad.push(`${t.id}: parts have different lengths ${lens.join('/')}`);
  }
  ok(bad.length === 0 && TRACKS.length >= 6, 'every music track parses and its parts line up', bad.join('; '));
  const secs = (t) => (parseSeq(t.parts[0].seq).len * 60) / t.bpm;
  const moods = (m) => TRACKS.filter((t) => t.mood === m);
  ok(moods('calm').length >= 5 && moods('ambient').length >= 3 && moods('battle').length >= 3 && moods('calm').every((t) => secs(t) >= 90) && moods('ambient').every((t) => secs(t) >= 150),
    'the soundtrack has five calm, three ambient and three battle pieces, each a full-length arrangement', TRACKS.map((t) => `${t.id} ${Math.round(secs(t))}s`).join(', '));
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

// --------------------------------------------------- v1.0.2: orders and shelter
{
  const g = mk(['flint', 'nonna'], { startRes: 'standard' });
  const P = g.players[0], cooks = mine(g, 0, (u) => u.isCook), hq = hqOf(g, 0);
  const veg = g.findNode('veg', P.home.x, P.home.y, 20);
  const fill = (u) => { for (let i = 0; i < 60 * TICK_RATE && u.carryAmt < 4; i++) g.step(); };

  // drop off on demand
  g.command(0, { c: 'ga', ids: [cooks[0].id], tid: veg.id });
  fill(cooks[0]);
  g.command(0, { c: 'st', ids: [cooks[0].id] });
  const had = cooks[0].carryAmt, food0 = P.res.food;
  g.command(0, { c: 'dr', ids: [cooks[0].id], tid: hq.id });
  run(g, 15);
  ok(had >= 4 && cooks[0].carryAmt === 0 && P.res.food === food0 + had && !cooks[0].order, 'a cook sent to the Kitchen HQ banks what it carries, then waits for orders', `carried ${had}`);

  // a new job never throws the old load away
  g.command(0, { c: 'ga', ids: [cooks[1].id], tid: veg.id });
  fill(cooks[1]);
  const had1 = cooks[1].carryAmt, food1 = P.res.food;
  g.command(0, { c: 'ga', ids: [cooks[1].id], tree: g.findTree(P.home.x, P.home.y, 20) });
  ok(cooks[1].order.res === 'wood' && cooks[1].order.phase === 2, 'a cook holding produce who is sent to chop wood takes the new order at once');
  run(g, 25);
  ok(P.res.food === food1 + had1, 'and banks the produce on the way instead of dropping it');

  // the bell
  g.command(0, { c: 'ga', ids: cooks.map((u) => u.id), tid: veg.id });
  run(g, 6);
  g.command(0, { c: 'bell', on: 1 });
  run(g, 20);
  ok(P.bell && cooks.every((u) => u.inside === hq.id && u.st === ST.INSIDE) && hq.inside === 4, 'the bell sends every Prep Cook inside the Kitchen HQ');
  ok(!g.near(hq.x, hq.y, 8).some((u) => u.isCook) && cooks.every((u) => u.carryAmt === 0), 'sheltered cooks cannot be reached and have emptied their baskets');
  g.command(0, { c: 'mv', ids: cooks.map((u) => u.id), x: P.home.x + 6, y: P.home.y });
  run(g, 1);
  ok(cooks.every((u) => u.inside === hq.id), 'they stay put until the all-clear');
  g.command(0, { c: 'tr', bid: hq.id, u: 'cook' });
  for (let i = 0; i < 60 * TICK_RATE && hq.q.length; i++) g.step();
  run(g, 3);
  const rookie = mine(g, 0, (u) => u.isCook).find((u) => !cooks.includes(u));
  ok(rookie && rookie.inside === hq.id, 'a cook trained while the bell rings goes straight inside');
  g.command(0, { c: 'bell', on: 0 });
  run(g, 1);
  ok(!P.bell && hq.inside === 0 && cooks.every((u) => !u.inside && u.order && u.order.t === 'gather' && u.order.res === 'food'), 'all clear: everyone walks out and goes back to the job they had');
  const f2 = P.res.food;
  run(g, 30);
  ok(P.res.food > f2, 'and the produce flows again');

  // the shelter falls
  g.command(0, { c: 'bell', on: 1 });
  run(g, 20);
  g.killEntity(hq, 1);
  g.cleanup();
  ok(mine(g, 0, (u) => u.isCook).every((u) => !u.inside && !g.block[(u.y | 0) * g.w + (u.x | 0)]), 'if the shelter is destroyed the cooks spill out onto open ground');
}

// ------------------------------------------------------ v1.0.2: fish and salt
{
  const g = mk(['flint', 'nonna'], { startRes: 'standard' });
  const P = g.players[0], cooks = mine(g, 0, (u) => u.isCook);
  const fish = g.findNode('fish', P.home.x, P.home.y, 30);
  const idx = fish ? fish.ty * g.w + fish.tx : 0;
  ok(fish && g.tiles[idx] === TILE.WATER, 'every base has a pond with Fishing Spots within reach');
  const salt = g.nodes.filter((n) => n.type === 'salt' && Math.hypot(n.x - P.home.x, n.y - P.home.y) < 20).length;
  ok(salt >= 7, 'and two salt deposits', `${salt} salt rocks near home`);
  const food0 = P.res.food;
  g.command(0, { c: 'ga', ids: cooks.map((u) => u.id), tid: fish.id });
  run(g, 60);
  ok(P.res.food > food0 + 20, 'cooks fish from the shore and bring the catch home', `+${P.res.food - food0} in 60s`);
  fish.amount = 2;
  run(g, 30);
  ok(fish.dead && g.block[idx] === 1 && cooks.every((u) => g.tiles[(u.y | 0) * g.w + (u.x | 0)] !== TILE.WATER), 'a fished-out spot stays water: nobody can walk into the pond');
}

// --------------------------------------------- v1.0.2: stances and formations
{
  const g = mk(['flint', 'nonna']);
  const c = g.pf.nearestFree(g.w >> 1, g.h >> 1, 20), cx = c[0] + 0.5, cy = c[1] + 0.5;
  const a = g.spawnUnit(0, 'line', cx, cy), b = g.spawnUnit(1, 'butcher', cx + 4.5, cy);
  b.x = cx + 4.5; b.y = cy;
  g.command(1, { c: 'sn', ids: [b.id], v: 2 });
  g.command(0, { c: 'sn', ids: [a.id], v: 2 });
  run(g, 3);
  ok(a.stance === 2 && !a.order && b.hp === b.S.hp, 'Stand Down: a soldier ignores an enemy in plain sight');
  g.applyDamage(1, b.id, a, 5, {}, false);
  run(g, 2);
  ok(!a.order && b.hp === b.S.hp, 'even when hit');
  g.command(0, { c: 'sn', ids: [a.id], v: 1 });
  run(g, 3);
  ok(!a.order && b.hp === b.S.hp, 'Hold the Line: it does not chase an enemy 4.5 tiles away');
  g.command(0, { c: 'at', ids: [a.id], tid: b.id });
  run(g, 4);
  const hurt = b.hp;
  ok(hurt < b.S.hp, 'but a direct attack order is always obeyed');
  g.command(0, { c: 'st', ids: [a.id] });
  g.command(0, { c: 'sn', ids: [a.id], v: 0 });
  b.x = a.x + 4.5; b.y = a.y;
  run(g, 5);
  ok(b.dead || b.hp < hurt, 'Aggressive: it goes after the enemy by itself');

  // formations
  const g2 = mk(['flint', 'nonna']);
  const squad = [];
  for (let i = 0; i < 6; i++) squad.push(g2.spawnUnit(0, 'line', cx + (i % 3) * 0.6, cy + ((i / 3) | 0) * 0.6));
  for (let i = 0; i < 3; i++) squad.push(g2.spawnUnit(0, 'saucier', cx + i * 0.6, cy - 0.6));
  squad.push(g2.spawnUnit(0, 'catapult', cx - 1, cy));
  const ids = squad.map((u) => u.id);
  g2.command(0, { c: 'mv', ids, x: cx + 9, y: cy, f: 1 });
  const xs = (pred) => squad.filter(pred).map((u) => u.order.x);
  const lineX = xs((u) => u.type === 'line'), saucX = xs((u) => u.type === 'saucier'), cataX = xs((u) => u.type === 'catapult');
  ok(Math.min(...lineX) > Math.max(...saucX) && Math.min(...saucX) >= Math.max(...cataX), 'Service Line: infantry in front, ranged behind, siege at the back');
  ok(new Set(squad.map((u) => u.order.x.toFixed(2) + ',' + u.order.y.toFixed(2))).size === squad.length && squad.every((u) => u.order.sp === 1.4), 'everyone gets a slot of their own and marches at the pace of the slowest');
  g2.command(0, { c: 'mv', ids, x: cx + 9, y: cy, f: 3 });
  const tip = squad.reduce((m, u) => (u.order.x > m.order.x ? u : m));
  ok(tip.type === 'line' && Math.abs(tip.order.y - cy) < 0.01 && squad.filter((u) => Math.abs(u.order.x - tip.order.x) < 0.01).length === 1, 'V Wedge: a single infantry unit leads at the tip');
  g2.command(0, { c: 'mv', ids, x: cx + 9, y: cy, f: 4 });
  const near = (list) => { let m = Infinity; for (const p of list) for (const q of list) if (p !== q) m = Math.min(m, Math.hypot(p.order.x - q.order.x, p.order.y - q.order.y)); return m; };
  ok(near(squad) > 1.8, 'Spread Out: nobody stands within splash range of a neighbour');
  g2.command(0, { c: 'fm', ids, f: 2 });
  ok(squad.every((u) => u.order && u.order.t === 'move') && near(squad) > 0.9, 'forming up on the spot works without a destination');
}

// ------------------------------------------ v1.0.2: defences, upgrades, scores
{
  const all = computeStats('flint', 4, Object.keys(TECHS)), base = computeStats('flint', 1, []);
  ok(base.bldgs.restaurant.shots === 3 && base.bldgs.tower.shots === 1 && all.bldgs.tower.shots === 2 && all.bldgs.restaurant.shots === 4 && all.bldgs.grill.shots === 1,
    'the Signature Restaurant fires three plates a volley; Twin Grinders adds one to every armed station');
  const perAge = [1, 2, 3, 4].map((a) => Object.keys(TECHS).filter((k) => TECHS[k].age === a && TECHS[k].mods && TECHS[k].mods.some((m) => ['mil', 'line', 'def', 'hero', 'inf', 'veh', 'ranged', 'siege', 'unique'].includes(m.sel))).length);
  ok(perAge.every((n) => n >= 1) && perAge[1] >= 5, 'there are military upgrades in every age', perAge.join('/'));
  ok(all.units.line.hp > base.units.line.hp * 1.2 && all.units.saucier.sight === base.units.saucier.sight + 2 && all.units.hero_flint.hp > computeStats('flint', 4, []).units.hero_flint.hp, 'the new upgrades change the numbers they promise to');

  const g = mk(['flint', 'nonna']);
  const hq = hqOf(g, 0), P = g.players[0];
  setAge(g, 0, 3);
  const rest = build(g, 0, 'restaurant');
  for (let i = 0; i < 3; i++) g.spawnUnit(1, 'line', rest.x + 5 + i * 0.5, rest.y + 3);
  g.events = [];
  run(g, 0.6);
  const volley = g.events.filter((e) => e[0] === 'shot' && e[1] === rest.id);
  ok(volley.length === 3 && new Set(volley.map((e) => e[2])).size === 3, 'a restaurant volley is three plates at three different intruders', `${volley.length} shots`);
  hq.inside = 10;
  for (const u of g.units) if (u.owner === 1 && u.type === 'line') g.killEntity(u, -1);
  g.cleanup();
  g.spawnUnit(1, 'line', hq.x + 4, hq.y + 3);
  g.events = [];
  run(g, 0.6);
  ok(g.events.filter((e) => e[0] === 'shot' && e[1] === hq.id).length === 3, 'ten sheltered cooks give the Kitchen HQ two extra plates per volley');
  hq.inside = 0;

  run(g, 16);
  const sum = g.summary(), tl = g.timeline();
  ok(sum[0].score.total > 0 && sum[0].built >= 1 && sum[0].score.total === sum[0].score.military + sum[0].score.economy + sum[0].score.technology + sum[0].score.society, 'the score adds up from military, economy, technology and society');
  ok(tl.t.length >= 2 && ['score', 'army', 'pop', 'gathered', 'kills'].every((k) => tl.series[k].length === 2 && tl.series[k].every((s) => s.length === tl.t.length)), 'the timeline has one point per sample for every player and statistic');
  ok(P.score.peakPop >= 4, 'peaks are tracked');
}

// ------------------------------------------------------------ v1.0.3: ultimates
{
  ok(COMMANDER_KEYS.every((k) => { const U = COMMANDERS[k].ultimate; return U && U.cd >= 120 && U.cd <= 180 && U.desc && U.tb && U.key !== COMMANDERS[k].ability.key; }), 'every commander has an ultimate on a 2 to 3 minute cooldown');
  for (const key of COMMANDER_KEYS) {
    const g = mk([key, 'flint'], { seed: 11 });
    const P = g.players[0], U = COMMANDERS[key].ultimate, hero = g.ents.get(P.heroId);
    const pals = [0, 1, 2].map((i) => g.spawnUnit(0, 'line', hero.x + 1 + i * 0.4, hero.y + 1.5));
    const foes = [0, 1, 2].map((i) => g.spawnUnit(1, i === 1 ? 'butcher' : 'line', hero.x + 1 + i * 0.4, hero.y + 3));
    for (const f of foes) f.S = { ...f.S, atk: 0.001 };
    for (const u of pals.concat(hero)) u.stance = 2;                        // stand down: nobody fights, so only the ultimate changes anything
    run(g, 0.3);
    g.command(0, { c: 'ul' });
    const lockedEarly = P.ultReady === 0 && g.events.some((e) => e[0] === 'note' && e[2] === 'ultage');
    setAge(g, 0, 3);
    for (const p of pals) p.hp = p.S.hp * 0.3;
    const before = { foe: foes.map((f) => f.hp), pal: pals.map((p) => p.hp), pop: P.pop, at: foes.map((f) => [f.x, f.y]) };
    g.command(0, { c: 'ul' });
    let good = P.ultReady === g.tick + U.cd * TICK_RATE, why = '';
    if (U.key === 'flambe') good = good && foes.every((f, i) => f.dead || f.hp <= before.foe[i] - 60);
    else if (U.key === 'feast') { run(g, 5); good = good && pals.every((p, i) => p.hp > before.pal[i] + p.S.hp * 0.25); }
    else if (U.key === 'lockdown') {
      const hq = hqOf(g, 0), hp0 = hq.hp;
      g.applyDamage(1, foes[0].id, hq, 200 + hq.S.armor, {}, false);
      good = good && P.lockUntil > g.tick && hp0 - hq.hp > 30 && hp0 - hq.hp < 70; why = 'took ' + (hp0 - hq.hp);
    } else if (U.key === 'perfectcut') {                                     // exactly one falls: the one with the most health
      const top = Math.max(...before.foe);
      run(g, 0.1);
      good = good && foes.filter((f) => f.dead).length === 1 && foes.every((f, i) => !f.dead || before.foe[i] === top) && P.abilityReady <= g.tick; why = foes.map((f) => (f.dead ? 'out' : f.hp)).join(' ');
    }
    else if (U.key === 'glass') {
      g.command(1, { c: 'mv', ids: foes.map((f) => f.id), x: hero.x + 8, y: hero.y + 8 });
      run(g, 3);
      const stuck = foes.every((f, i) => Math.hypot(f.x - before.at[i][0], f.y - before.at[i][1]) < 0.3);
      run(g, 6);
      good = good && stuck && foes.every((f, i) => Math.hypot(f.x - before.at[i][0], f.y - before.at[i][1]) > 1);
      why = 'stuck ' + stuck;
    } else if (U.key === 'swarm') {
      const riders = g.units.filter((u) => u.owner === 0 && u.type === 'scooter');
      good = good && riders.length === U.count && P.pop === before.pop && riders.every((u) => u.expire > g.tick);
      run(g, U.dur + 1);
      good = good && g.units.filter((u) => u.owner === 0 && u.type === 'scooter').length === 0 && P.pop === before.pop;
    }
    const ready = P.ultReady;
    g.command(0, { c: 'ul' });
    ok(lockedEarly && good && P.ultReady === ready, `${key}: "${U.name}" is locked before the Bistro Age, works, then goes on cooldown`, why);
  }
}

// ---------------------------------------------------- v1.0.3: turn-based mode
{
  const { TacticsGame, F_MOVED, F_DONE } = await import('../game/tactics.js');
  const { TacticsBot } = await import('../game/tactics-ai.js');
  const { TB, tbBldg, tbDist, tbCooldown, NODES, RES } = await import('../game/data.js');
  const mkT = (cmds = ['flint', 'nonna'], opts = {}) => {
    const g = new TacticsGame({
      players: cmds.map((c, i) => ({ name: 'P' + i, commander: c, team: i, color: i })),
      mapSize: 'small', startRes: opts.startRes || 'feast', popCap: 100, seed: opts.seed || 5, turnTime: opts.turnTime || 0, turnLimit: opts.turnLimit || 0, victory: opts.victory,
    });
    g.step();
    return g;
  };
  const settle = (g) => { for (let i = 0; i < 600 && (g.busy() || g.queue.length); i++) g.step(); g.step(); };
  const endTurn = (g) => { g.command(g.turn.cur, { c: 'et' }); settle(g); };
  const mineT = (g, pi, type) => g.units.filter((u) => u.owner === pi && !u.dead && u.type === type);
  const beside = (g, u) => g.freeAround(u.tx, u.ty, 1).filter((t) => tbDist(t[0], t[1], u.tx, u.ty) === 1 && g.tiles[t[1] * g.w + t[0]] === TILE.GRASS);
  const notes = (g) => g.noteLog;
  const watch = (g) => { g.noteLog = []; const d = g.delta.bind(g); g.delta = () => { for (const e of g.events) if (e[0] === 'note') g.noteLog.push(e[2]); return d(); }; return g; };
  /** Put a unit on a tile by hand (tests only). */
  const place = (g, u, x, y) => { const i = u.ty * g.w + u.tx; if (g.grid[i] === u.id) g.grid[i] = 0; u.tx = x; u.ty = y; u.x = x + 0.5; u.y = y + 0.5; g.grid[y * g.w + x] = u.id; };
  const noHeroes = (g) => { for (const P of g.players) if (P.heroId) g.killEntity(g.ents.get(P.heroId), -1); settle(g); };

  // --- setup, turn order, movement
  {
    const g = mkT();
    const P0 = g.players[0], hq = hqOf(g, 0);
    ok(g.w === TB.mapSizes.small && hq.size === 1 && hq.hp === tbBldg(hq.S).hp && mineT(g, 0, 'cook').length === 2 && mineT(g, 0, 'line').length === 1 && P0.heroId > 0, 'tactics: a small grid, one-tile stations, a hero, a Line Cook and two Prep Cooks each');
    ok(g.turn.n === 1 && g.turn.cur === 0 && P0.res.food === g.players[1].res.food + TB.hqIncome.food, 'tactics: player 1 goes first and collects the Kitchen HQ income');
    ok(g.nodes.some((n) => n.type === 'wood') && g.startInfo().mode === 'turn' && Array.isArray(g.full().tb), 'tactics: the map has Timber Stands and clients are told it is a turn-based match');
    const line = mineT(g, 0, 'line')[0], foe = mineT(g, 1, 'line')[0];
    const at = [foe.tx, foe.ty];
    g.command(1, { c: 'tmv', id: foe.id, x: foe.tx + 1, y: foe.ty }); settle(g);
    ok(foe.tx === at[0] && foe.ty === at[1], 'tactics: orders out of turn are ignored');
    const reach = g.reach(line), far = [...reach.best].filter(([i]) => !g.grid[i]).sort((a, b) => b[1] - a[1])[0];
    const off = [...Array(g.w * g.h).keys()].find((i) => !reach.best.has(i) && !g.grid[i] && !g.occ[i] && g.tiles[i] === TILE.GRASS);
    g.command(0, { c: 'tmv', id: line.id, x: off % g.w, y: (off / g.w) | 0 }); settle(g);
    const stayed = !line.moved;
    g.command(0, { c: 'tmv', id: line.id, x: far[0] % g.w, y: (far[0] / g.w) | 0 }); settle(g);
    const arrived = line.tx === far[0] % g.w && line.ty === ((far[0] / g.w) | 0) && line.moved && far[1] <= line.T.mv;
    const here = [line.tx, line.ty], next = beside(g, line)[0];
    g.command(0, { c: 'tmv', id: line.id, x: next[0], y: next[1] }); settle(g);
    ok(stayed && arrived && line.tx === here[0] && line.ty === here[1] && (g.flagsOf(line) & F_MOVED) && (g.flagsOf(line) >> 8) === 0, 'tactics: a unit moves once per turn, as far as its movement allows', `mv ${line.T.mv}, went ${far[1]}`);
    endTurn(g);
    ok(g.turn.cur === 1 && g.turn.n === 1, 'tactics: ending the turn hands over to the next kitchen');
    endTurn(g);
    ok(g.turn.cur === 0 && g.turn.n === 2 && !line.moved && !line.acted, 'tactics: after everyone has played a new round begins and units are fresh again');
  }

  // --- fighting
  {
    const g = mkT(['hank', 'nonna'], { seed: 9 });
    noHeroes(g);                                                                // no auras in the sums
    const a = mineT(g, 0, 'line')[0];
    const spot1 = beside(g, a)[0];
    const d = g.spawnUnit(1, 'line', spot1[0] + 0.5, spot1[1] + 0.5);
    const want = g.damageFor(a, d, false), hpA = a.hp, hpD = d.hp;
    g.command(0, { c: 'tat', id: a.id, tid: d.id }); settle(g);
    const back = g.damageFor(d, a, true);
    ok(d.hp === hpD - want && a.hp === hpA - back && back < want && a.acted, 'tactics: an attack lands, and the defender hits back with a weaker blow', `-${want} / -${back}`);
    const hp2 = d.hp;
    g.command(0, { c: 'tat', id: a.id, tid: d.id }); settle(g);
    ok(d.hp === hp2 && (g.flagsOf(a) & F_DONE), 'tactics: attacking ends that unit\'s turn');
    // a thrower out of arm's reach takes no counterattack
    const two = g.freeAround(d.tx, d.ty, 3).find((t) => tbDist(t[0], t[1], d.tx, d.ty) === 2);
    const s = g.spawnUnit(0, 'saucier', two[0] + 0.5, two[1] + 0.5);
    d.hp = d.S.hp;
    const open = g.damageFor(s, d, false), hpS = s.hp, hp3 = d.hp;
    g.command(0, { c: 'tat', id: s.id, tid: d.id }); settle(g);
    ok(s.T.rng >= 2 && s.hp === hpS && d.hp === hp3 - open && open > 0, 'tactics: a Saucier strikes from two tiles away and takes no counterattack', `range ${s.T.rng}, -${open}`);
    // trees give cover
    d.hp = d.S.hp;
    const plain = g.damageFor(s, d, false);
    g.tiles[d.ty * g.w + d.tx] = TILE.TREE;
    ok(Math.abs(g.damageFor(s, d, false) - plain * TB.forestCover) <= 1 && TB.forestCover < 1, 'tactics: a unit standing among trees takes a quarter less damage', `${plain} -> ${g.damageFor(s, d, false)}`);
    // artillery cannot move and fire in the same turn
    const home = g.freeAround(a.tx, a.ty, 3)[0];
    const cat = g.spawnUnit(0, 'catapult', home[0] + 0.5, home[1] + 0.5);
    const spots = g.freeAround(d.tx, d.ty, 6).filter((t) => g.inRange(cat, tbDist(t[0], t[1], d.tx, d.ty)));
    place(g, cat, spots[0][0], spots[0][1]);
    const r = g.reach(cat), step = [...r.best.keys()].find((i) => !g.grid[i] && g.inRange(cat, tbDist(i % g.w, (i / g.w) | 0, d.tx, d.ty)));
    const hp4 = d.hp;
    watch(g);
    if (step !== undefined) { g.command(0, { c: 'tat', id: cat.id, tid: d.id, x: step % g.w, y: (step / g.w) | 0 }); settle(g); g.delta(); }
    const refused = step === undefined || (d.hp === hp4 && notes(g).includes('setup'));
    g.command(0, { c: 'tat', id: cat.id, tid: d.id }); settle(g);
    ok(refused && d.hp < hp4, 'tactics: a Catapult fires from where it stands, but not after moving');
  }

  // --- stations and income
  {
    const g = watch(mkT(['flint', 'nonna'], { seed: 6 }));
    const P = g.players[0], cooks = mineT(g, 0, 'cook');
    const inc0 = { ...P.income };
    const c0 = cooks[0], grass = beside(g, c0).find((t) => !g.occ[t[1] * g.w + t[0]]);
    g.command(0, { c: 'tbd', id: c0.id, b: 'pantry', x: grass[0], y: grass[1], sx: c0.tx, sy: c0.ty }); settle(g); g.delta();
    const refused = notes(g).includes('pantry') && !g.bldgs.some((b) => b.type === 'pantry');
    let job = null;
    const reach = g.reach(c0);
    for (const n of g.nodes) { for (const [i] of reach.best) { if ((g.grid[i] && g.grid[i] !== c0.id) || tbDist(i % g.w, (i / g.w) | 0, n.tx, n.ty) !== 1) continue; job = [n, i]; break; } if (job) break; }
    const node = job[0], wood0 = P.res.wood;
    g.command(0, { c: 'tbd', id: c0.id, b: 'pantry', x: node.tx, y: node.ty, sx: job[1] % g.w, sy: (job[1] / g.w) | 0 }); settle(g);
    const site = g.bldgs.find((b) => b.type === 'pantry' && b.owner === 0);
    ok(refused && site && !site.done && site.tx === node.tx && site.ty === node.ty && site.pays === node.type && P.res.wood === wood0 - P.stats.bldgs.pantry.cost.wood && c0.acted,
      'tactics: a Pantry cannot go on open ground; on a resource a Prep Cook walks over and starts it');
    const c1 = cooks[1], lot = beside(g, c1).find((t) => !g.occ[t[1] * g.w + t[0]]);
    g.command(0, { c: 'tbd', id: c1.id, b: 'house', x: lot[0], y: lot[1], sx: c1.tx, sy: c1.ty }); settle(g);
    const hq = hqOf(g, 0);
    g.command(0, { c: 'tr', bid: hq.id, u: 'cook' }); g.command(0, { c: 'tr', bid: hq.id, u: 'cook' }); settle(g); g.delta();
    ok(hq.q.length === 1 && notes(g).includes('busy') && g.bldgRec(hq)[8] === 1, 'tactics: a station takes one job at a time');
    const nCooks = cooks.length, cap0 = P.popCap, house = g.bldgs.find((b) => b.type === 'house' && b.owner === 0);
    for (let i = 0; i < 8 && !(site.done && house.done); i++) { endTurn(g); endTurn(g); }
    const res = NODES[node.type].res, k = RES.indexOf(res);
    ok(site.done && P.income[res] - inc0[res] >= TB.income[node.type] && g.playerRec(P)[21][k] === P.income[res], 'tactics: the finished Pantry pays its ingredient every turn', `${res} +${inc0[res]} -> +${P.income[res]}`);
    ok(mineT(g, 0, 'cook').length === nCooks + 1 && house.done && P.popCap > cap0 && P.popCap <= P.maxPop && P.maxPop === 20, 'tactics: the trained Prep Cook walked out, and the Break Room raised the staff limit', `${cap0} -> ${P.popCap}`);
    const f0 = P.res[res];
    endTurn(g); endTurn(g);
    ok(P.res[res] === f0 + P.income[res], 'tactics: income arrives at the start of each of your turns');
    g.killEntity(site, 1); settle(g);
    ok(g.occ[node.ty * g.w + node.tx] === node.id && g.cantPlace('pantry', node.tx, node.ty) === '' && P.income[res] === inc0[res], 'tactics: when a Pantry falls its income stops and the resource can be claimed again');
    g.command(0, { c: 'rs', bid: hq.id, tech: 'age2' }); settle(g);
    const turns = hq.q.length ? hq.q[0].total : 0;
    for (let i = 0; i < 4 && P.age < 2; i++) { endTurn(g); endTurn(g); }
    ok(turns >= 1 && turns <= 3 && P.age === 2, 'tactics: advancing an age takes a few turns', turns + ' turns');
  }

  // --- armed stations, repairs, healing
  {
    const g = mkT(['flint', 'nonna'], { seed: 6 });
    noHeroes(g);
    const hq = hqOf(g, 0);
    const spotF = g.freeAround(hq.tx, hq.ty, 1).filter((t) => tbDist(t[0], t[1], hq.tx, hq.ty) === 1)[0];
    const foe = g.spawnUnit(1, 'butcher', spotF[0] + 0.5, spotF[1] + 0.5);
    for (const u of g.units) if (u.owner === 0 && u.S.atk > 0 && !u.isCook) g.killEntity(u, -1);
    endTurn(g);
    const hpF = foe.hp, hpH = hq.hp;
    g.command(1, { c: 'tat', id: foe.id, tid: hq.id }); settle(g);
    ok(hq.hp < hpH && foe.hp === hpF, 'tactics: stations do not hit back when struck...', `HQ ${hpH} -> ${hq.hp}`);
    endTurn(g);
    ok(foe.dead || foe.hp < hpF, 'tactics: ...they volley at the start of their owner\'s turn instead', `butcher ${hpF} -> ${foe.dead ? 'out' : foe.hp}`);
    const cook = mineT(g, 0, 'cook')[0], hp1 = hq.hp;
    const r = g.reach(cook), stand = [...r.best.keys()].find((i) => (!g.grid[i] || g.grid[i] === cook.id) && tbDist(i % g.w, (i / g.w) | 0, hq.tx, hq.ty) === 1);
    g.command(0, { c: 'trp', id: cook.id, tid: hq.id, sx: stand % g.w, sy: (stand / g.w) | 0 }); settle(g);
    ok(hq.hp > hp1 && cook.acted, 'tactics: a Prep Cook repairs a station as its action', `${hp1} -> ${hq.hp}`);
    const other = mineT(g, 0, 'cook')[1];
    other.hp = 10;
    const bspot = beside(g, other)[0], barista = g.spawnUnit(0, 'barista', bspot[0] + 0.5, bspot[1] + 0.5);
    g.command(0, { c: 'thl', id: barista.id, tid: other.id }); settle(g);
    ok(other.hp > 10 && barista.acted, 'tactics: a Barista tops up a friend as its action', '+' + (other.hp - 10));
  }

  // --- abilities and ultimates count turns
  for (const key of COMMANDER_KEYS) {
    const g = watch(mkT([key, 'flint'], { seed: 12 }));
    const P = g.players[0], C = COMMANDERS[key], hero = g.ents.get(P.heroId);
    const near = g.freeAround(hero.tx, hero.ty, 2);
    const pal = g.spawnUnit(0, 'line', near[0][0] + 0.5, near[0][1] + 0.5), foe = g.spawnUnit(1, 'butcher', near[1][0] + 0.5, near[1][1] + 0.5), foe2 = g.spawnUnit(1, 'line', near[2][0] + 0.5, near[2][1] + 0.5);
    pal.hp = 12;
    const hq = hqOf(g, 0);
    if (C.ability.key === 'lunch') { g.command(0, { c: 'tr', bid: hq.id, u: 'cook' }); settle(g); }
    const b4 = { pal: pal.hp, foe: foe.hp, units: mineT(g, 0, 'cook').length, mv: g.mvOf(pal) };
    g.command(0, { c: 'ab' }); settle(g);
    let good = P.abilityCd === tbCooldown(C.ability.cd);
    if (C.ability.key === 'service') good = good && pal.boost && g.mvOf(pal) === b4.mv + 1;
    else if (C.ability.key === 'mangia') good = good && pal.hp > b4.pal + 10;
    else if (C.ability.key === 'lowslow') good = good && pal.guard;
    else if (C.ability.key === 'cuts') good = good && foe.hp < b4.foe;
    else if (C.ability.key === 'sugar') good = good && g.mvOf(pal) === b4.mv + 2 && P.sugarNext;
    else if (C.ability.key === 'lunch') good = good && mineT(g, 0, 'cook').length === b4.units + 1 && hq.q.length === 0;
    g.command(0, { c: 'ul' }); settle(g); g.delta();
    const early = P.ultCd === 0 && notes(g).includes('ultage');
    setAge(g, 0, 3);
    pal.hp = Math.min(pal.hp, 12);
    const U = C.ultimate, c4 = { pal: pal.hp, foe: foe.dead ? 0 : foe.hp, foe2: foe2.dead ? 0 : foe2.hp, pop: P.pop };
    g.command(0, { c: 'ul' }); settle(g);
    let ugood = P.ultCd === tbCooldown(U.cd) && P.ultCd >= 5 && P.ultCd <= 8;
    if (U.key === 'flambe') ugood = ugood && (foe.dead || foe.hp < c4.foe - 30) && (foe2.dead || foe2.hp < c4.foe2 - 30);
    else if (U.key === 'feast') ugood = ugood && pal.hp > c4.pal + pal.S.hp * 0.4 && pal.feast;
    else if (U.key === 'lockdown') ugood = ugood && P.lock && g.playerRec(P)[20] === 1;
    else if (U.key === 'perfectcut') { const top = c4.foe >= c4.foe2 ? foe : foe2, rest = top === foe ? foe2 : foe; ugood = ugood && top.dead && !rest.dead && P.abilityCd === 0; }
    else if (U.key === 'glass') { ugood = ugood && foe.stun === 1 && foe2.stun === 1 && !g.canCounter(foe, pal); endTurn(g); ugood = ugood && foe.acted && foe.moved && foe.stuck && (g.flagsOf(foe) & F_DONE) > 0; }
    else if (U.key === 'swarm') {
      const riders = mineT(g, 0, 'scooter');
      ugood = ugood && riders.length === U.count && P.pop === c4.pop && riders.every((u) => !u.moved && u.temp === TB.swarmTurns);
      for (let i = 0; i < TB.swarmTurns; i++) { endTurn(g); endTurn(g); }
      ugood = ugood && mineT(g, 0, 'scooter').length === 0 && P.pop === c4.pop;
    }
    ok(good && early && ugood, `tactics ${key}: "${C.ability.name}" and "${U.name}" work on the grid, with cooldowns in turns`, `ability ${good}, locked early ${early}, ultimate ${ugood} (every ${tbCooldown(C.ability.cd)} / ${tbCooldown(U.cd)} turns)`);
  }

  // --- the turn timer, the round limit, victory
  {
    const g = watch(mkT(['flint', 'nonna'], { turnTime: 5 }));
    for (let i = 0; i < 5 * TICK_RATE + 5; i++) g.step();
    g.delta();
    ok(g.turn.cur === 1 && notes(g).includes('timeup'), 'tactics: the turn timer ends a turn that runs out of time');
    const g2 = mkT(['flint', 'nonna'], { turnLimit: 2 });
    g2.players[1].score.kills = 50;
    for (let i = 0; i < 4 && !g2.over; i++) endTurn(g2);
    ok(g2.over && g2.over.onScore && g2.over.team === 1 && g2.turn.n === 2, 'tactics: with a round limit the best score wins when it is reached');
    const sum = g2.summary(), tl = g2.timeline();
    ok(tl.unit === 'turn' && tl.t[0] === 0 && tl.t[tl.t.length - 1] === 2 && tl.series.score.every((row) => row.length === tl.t.length) && sum[0].rounds === 2, 'tactics: the timeline counts rounds', tl.t.join(','));
    const g3 = mkT();
    g3.killEntity(hqOf(g3, 1), 0);
    for (let i = 0; i < 30; i++) g3.step();
    ok(g3.over && g3.over.team === 0 && !g3.players[1].alive, 'tactics: destroying the enemy Kitchen HQ wins the match');
    const g4 = mkT(['flint', 'nonna', 'hank']);
    g4.command(0, { c: 'rg' }); settle(g4);
    ok(!g4.over && g4.turn.cur === 1 && !g4.players[0].alive, 'tactics: when the player whose turn it is resigns, play passes on');
    endTurn(g4); endTurn(g4);
    ok(g4.turn.cur === 1 && g4.turn.n === 2, 'tactics: eliminated kitchens are skipped in the turn order');
  }

  // --- things a careful review turned up
  {
    const g = mkT(['ryo', 'hank'], { seed: 8 });
    const P = g.players[0], cook = mineT(g, 0, 'cook')[0], lot = beside(g, cook).find((t) => !g.occ[t[1] * g.w + t[0]]);
    const n0 = g.bldgs.length;
    for (const b of ['constructor', '__proto__', 'toString', ['house'], { toString: () => 'house' }, 7]) { g.command(0, { c: 'tbd', id: cook.id, b, x: lot[0], y: lot[1], sx: cook.tx, sy: cook.ty }); settle(g); }
    ok(g.bldgs.length === n0 && !cook.acted && g.bldgs.every((b) => Number.isFinite(b.hp)), 'tactics: a station order with a made-up station type is refused');
    const grill = g.addBuilding(0, 'grill', lot[0], lot[1], true);
    g.command(0, { c: 'tr', bid: grill.id, u: 'line' }); settle(g);
    const held = P.reserved, food = P.res.food;
    g.command(0, { c: 'dl', ids: [grill.id] }); settle(g);
    ok(held === 1 && P.reserved === 0 && P.res.food === food + P.stats.units.line.cost.food, 'tactics: deleting a station hands back the job it was doing, and its staff room exactly once', `reserved ${held} -> ${P.reserved}`);
    // ability damage respects Smoke Ring, and SERVICE! is over when the turn is
    noHeroes(g);
    const ryo = g.spawnUnit(0, 'hero_ryo', ...g.freeAround(cook.tx, cook.ty, 2)[0].slice(0, 2).map((v) => v + 0.5));
    P.heroId = ryo.id;
    const near = g.freeAround(ryo.tx, ryo.ty, 1);
    const open = g.spawnUnit(1, 'brute', near[0][0] + 0.5, near[0][1] + 0.5), shielded = g.spawnUnit(1, 'brute', near[1][0] + 0.5, near[1][1] + 0.5);
    shielded.guard = true;
    const h0 = [open.hp, shielded.hp];
    g.command(0, { c: 'ab' }); settle(g);
    const d = [h0[0] - open.hp, h0[1] - shielded.hp];
    ok(d[0] > 0 && d[1] === Math.round(d[0] / 2), 'tactics: Smoke Ring halves ability damage too', `${d[0]} / ${d[1]}`);
    const line = mineT(g, 0, 'line')[0];
    line.boost = true;
    endTurn(g);
    ok(!line.boost, 'tactics: the SERVICE! boost ends with the turn it was called in');
    // the turn timer is final: orders still waiting when it runs out are dropped
    const t = mkT(['flint', 'nonna'], { turnTime: 5 });
    while (t.tick < t.turn.deadline - 2) t.step();
    const [a, b] = [mineT(t, 0, 'line')[0], mineT(t, 0, 'cook')[0]];
    const far = (u) => { const r = t.reach(u); return [...r.best].filter(([i]) => !t.grid[i]).sort((x, y) => y[1] - x[1])[0][0]; };
    const fa = far(a), bAt = [b.tx, b.ty];
    t.command(0, { c: 'tmv', id: a.id, x: fa % t.w, y: (fa / t.w) | 0 });
    const fb = far(b);
    t.command(0, { c: 'tmv', id: b.id, x: fb % t.w, y: (fb / t.w) | 0 });
    const queued = t.queue.length;
    for (let i = 0; i < 40; i++) t.step();
    t.command(0, { c: 'tmv', id: b.id, x: fb % t.w, y: (fb / t.w) | 0 });
    ok(queued === 1 && t.turn.cur === 1 && b.tx === bAt[0] && b.ty === bAt[1] && a.tx === fa % t.w, 'tactics: when the turn timer runs out, orders still waiting are dropped and the turn ends');
    const rt = mk(['flint', 'nonna']);
    const stations = rt.bldgs.length;
    for (const b of [['house'], 'constructor', { toString: () => 'house' }]) rt.command(0, { c: 'bp', ids: mine(rt, 0, (u) => u.isCook).map((u) => u.id), b, tx: spot(rt, 0, 'house')[0], ty: spot(rt, 0, 'house')[1] });
    ok(rt.bldgs.length === stations, 'a build order whose station type is not plain text is refused (real-time too)');
  }

  // --- bots, and hostile input
  {
    const g = new TacticsGame({ players: [{ name: 'A', commander: 'ryo', team: 0, color: 0, bot: 'hard' }, { name: 'B', commander: 'zara', team: 1, color: 1, bot: 'normal' }, { name: 'C', commander: 'hank', team: 2, color: 2, bot: 'easy' }], mapSize: 'small', startRes: 'standard', popCap: 100, seed: 21, turnLimit: 25 });
    g.players.forEach((P) => { P.ai = new TacticsBot(g, P, P.bot); });
    let threw = null, bytes = 0;
    try { for (let i = 0; i < 400000 && !g.over; i++) { g.step(); bytes += JSON.stringify(g.delta()).length; } } catch (e) { threw = e; }
    const sum = threw ? [] : g.summary();
    ok(!threw && g.over && g.turn.n <= 25 && sum.every((s) => s.score.total > 0) && sum.some((s) => s.built >= 3 && s.trained >= 3), 'tactics: three bots play a whole match to the round limit', threw ? threw.stack : `${g.turn.n} rounds, ${g.tick} ticks, ${(bytes / g.tick).toFixed(0)} bytes per tick, scores ${sum.map((s) => s.score.total).join(' / ')}`);
    const f = mkT(['flint', 'nonna'], { seed: 3 });
    const junk = [undefined, null, NaN, Infinity, -1, 0, 1e9, '', 'x', '__proto__', 'constructor', [], {}, [1, 2, 3], true, 3, 12, 7.5];
    const pick = () => junk[(Math.random() * junk.length) | 0];
    const kinds = ['tmv', 'tat', 'tbd', 'trp', 'thl', 'twt', 'tr', 'rs', 'cq', 'dl', 'ab', 'ul', 'et', 'mv', 'bp', 'bell', 'zz'];
    let boom = null;
    try {
      for (let i = 0; i < 6000 && !f.over; i++) {
        const any = () => (Math.random() < 0.6 && f.units.length ? f.units[(Math.random() * f.units.length) | 0].id : Math.random() < 0.5 && f.bldgs.length ? f.bldgs[(Math.random() * f.bldgs.length) | 0].id : pick());
        const xy = (n) => (Math.random() < 0.6 ? (Math.random() * n) | 0 : pick());
        f.command((Math.random() * 3) | 0, { c: kinds[(Math.random() * kinds.length) | 0], id: any(), tid: any(), bid: any(), ids: [any(), any()], x: xy(f.w), y: xy(f.h), sx: xy(f.w), sy: xy(f.h), b: Math.random() < 0.7 ? ['house', 'pantry', 'grill', 'garden'][(Math.random() * 4) | 0] : pick(), u: Math.random() < 0.5 ? 'cook' : pick(), tech: Math.random() < 0.5 ? 'age2' : pick(), i: pick() });
        if (i % 7 === 0) { f.step(); f.delta(); }
      }
      for (let i = 0; i < 200; i++) f.step();
    } catch (e) { boom = e; }
    let sane = !boom;
    if (sane) {
      const seen = new Set();
      for (const u of f.units) {
        if (u.dead) continue;
        if (!Number.isFinite(u.x) || !Number.isFinite(u.hp) || !Number.isInteger(u.tx) || !Number.isInteger(u.ty) || u.tx < 0 || u.ty < 0 || u.tx >= f.w || u.ty >= f.h) sane = false;
        const i = u.ty * f.w + u.tx;
        if (seen.has(i) || f.grid[i] !== u.id || f.tiles[i] === TILE.WATER) sane = false;
        seen.add(i);
      }
      for (const P of f.players) { for (const r in P.res) if (!Number.isFinite(P.res[r]) || P.res[r] < 0) sane = false; if (P.pop < 0 || P.reserved < 0) sane = false; }
    }
    ok(sane, 'tactics: thousands of malformed orders never crash the game or put two units on one tile', boom ? boom.stack : '');
  }
}

// ----------------------------------------------------------- hostile input fuzz
{
  const g = mk(['flint', 'nonna'], { seed: 3 });
  const junk = [undefined, null, NaN, Infinity, -1, 0, 1e9, '', 'x', '__proto__', 'constructor', [], {}, [1, 2, 3], { length: 5 }, true];
  const pick = () => junk[(Math.random() * junk.length) | 0];
  const cmds = ['mv', 'am', 'at', 'hl', 'ga', 'bp', 'ba', 'tr', 'rs', 'cq', 'ry', 'st', 'dl', 'ab', 'ul', 'fm', 'sn', 'dr', 'bell', 'zz'];
  let threw = null;
  try {
    for (let i = 0; i < 4000; i++) {
      const ids = Math.random() < 0.5 ? g.units.slice(0, 6).map((u) => u.id) : pick();
      g.command((Math.random() * 3) | 0, { c: cmds[(Math.random() * cmds.length) | 0], ids, bids: pick(), bid: Math.random() < 0.5 ? hqOf(g, 0).id : pick(), tid: Math.random() < 0.5 ? g.nextId * Math.random() | 0 : pick(), x: pick(), y: pick(), tx: pick(), ty: pick(), b: Math.random() < 0.5 ? 'house' : pick(), u: Math.random() < 0.5 ? 'cook' : pick(), tech: Math.random() < 0.5 ? 'age2' : pick(), tree: pick(), i: pick(), n: pick(), q: pick(), f: pick(), v: pick(), on: pick() });
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
