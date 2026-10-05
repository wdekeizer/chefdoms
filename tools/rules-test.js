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
  ok(TRACKS.every((t) => secs(t) >= 135), 'every piece runs well over two minutes before it repeats', TRACKS.filter((t) => secs(t) < 135).map((t) => `${t.id} ${Math.round(secs(t))}s`).join(', '));
  // the plucked accompaniment must not be the same even pulse everywhere: count distinct rhythms (onset patterns) in the harp/lute parts
  const rhythms = new Set();
  for (const t of TRACKS) for (const p of t.parts) {
    if (p.inst !== 'harp' && p.inst !== 'lute') continue;
    const ev = parseSeq(p.seq).ev, durs = new Set(ev.map((e) => e.d));
    rhythms.add([...durs].sort().join(','));
  }
  ok(rhythms.size >= 8, 'the harp and lute parts use many different rhythms, not one shared pulse', rhythms.size + ' distinct');
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
    ok(g.turn.n === 1 && g.turn.cur === 0 && P0.res.food === g.players[1].res.food + Math.round(TB.hqIncome.food * TB.incomeMul), 'tactics: player 1 goes first and collects the Kitchen HQ income');
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

// ------------------------------------------- v1.2.0: market, balance, team turns
{
  const { MARKET, marketQuote, TB, BUILDINGS: BLD, CTF, tbDamage, tbDist } = await import('../game/data.js');
  const { TacticsGame, F_COUNTERED } = await import('../game/tactics.js');
  const { TacticsBot } = await import('../game/tactics-ai.js');
  const { CtfGame } = await import('../game/ctf.js');
  const { CtfBot } = await import('../game/ctf-ai.js');

  // ---- the Farmers Market (real time)
  {
    const g = mk(['flint', 'nonna'], { seed: 4 });
    const P = g.players[0];
    const s0 = { ...P.res };
    g.command(0, { c: 'mkt', give: 'spice', get: 'wood', n: 1 });
    run(g, 0.1);
    ok(P.res.spice === s0.spice && P.res.wood === s0.wood, 'market: no trading without a Farmers Market');
    const [tx, ty] = spot(g, 0, 'market');
    g.addBuilding(0, 'market', tx, ty, true);
    const q1 = marketQuote(g.market, 'spice', 'wood');
    g.command(0, { c: 'mkt', give: 'spice', get: 'wood', n: 1 });
    ok(P.res.spice === s0.spice - MARKET.lot && P.res.wood === s0.wood + q1 && q1 > MARKET.lot, 'market: 100 Spice buys more than 100 Firewood (Spice is worth more)', `${q1} wood`);
    ok(g.market.spice < 1 && g.market.wood > 1, 'market: selling makes a thing cheaper and buying makes it dearer');
    const q2 = marketQuote(g.market, 'spice', 'wood');
    ok(q2 < q1, 'market: so the same trade pays less the second time', `${q1} -> ${q2}`);
    const back = marketQuote(g.market, 'wood', 'spice');
    ok(back < MARKET.lot * 100 / 160 * 1.2 && back < (MARKET.lot * MARKET.lot) / q1, 'market: trading straight back loses on the fee and the spread', `100 wood -> ${back} spice`);
    const w0 = P.res.wood;
    g.command(0, { c: 'mkt', give: 'wood', get: 'salt', n: 5 });
    ok(P.res.wood === w0 - 5 * MARKET.lot, 'market: five lots at once');
    const before = { ...P.res };
    for (const c of [{ give: 'wood', get: 'wood' }, { give: 'gold', get: 'wood' }, { give: '__proto__', get: 'food' }, { give: 'food' }, { give: 'food', get: 'wood', n: 1e9 }]) g.command(0, { c: 'mkt', ...c });
    ok(P.res.food >= before.food - 10 * MARKET.lot && Object.values(P.res).every((v) => Number.isFinite(v) && v >= 0) && P.res.wood >= before.wood, 'market: junk trades are refused or capped at ten lots');
    const f = g.market.spice;
    run(g, 31);
    ok(g.market.spice > f && g.market.spice < 1, 'market: prices drift back towards normal over time', `${f.toFixed(3)} -> ${g.market.spice.toFixed(3)}`);
    const d = g.delta();
    ok(Array.isArray(g.full().mk) && g.full().mk.length === 4, 'market: snapshots carry the prices');
    ok(BLD.restaurant.cost.salt === 500, 'the Signature Restaurant costs 500 Salt');
  }

  // ---- turn-based: income, wood, stats, counters, towers, rally, market
  const mkT = (cmds, opts = {}) => {
    const g = new TacticsGame({ players: cmds.map((c, i) => ({ name: 'P' + i, commander: c, team: opts.teams ? opts.teams[i] : i, color: i })), mapSize: opts.size || 'small', startRes: 'feast', popCap: 100, seed: opts.seed || 5, turnOrder: opts.order || 'player' });
    g.step();
    return g;
  };
  const settle = (g) => { for (let i = 0; i < 600 && (g.busy() || g.queue.length); i++) g.step(); g.step(); };
  const mineT = (g, pi, type) => g.units.filter((u) => u.owner === pi && !u.dead && u.type === type);
  const place = (g, u, x, y) => { const i = u.ty * g.w + u.tx; if (g.grid[i] === u.id) g.grid[i] = 0; u.tx = x; u.ty = y; u.x = x + 0.5; u.y = y + 0.5; g.grid[y * g.w + x] = u.id; };
  {
    const g = mkT(['odile', 'hank']);
    const P = g.players[0];
    const woods = g.nodes.filter((n) => n.type === 'wood').length;
    ok(woods >= 8 * g.players.length, 'tactics: Timber Stands are plentiful (about six by every base and more between)', `${woods} on the map`);
    ok(g.players.every((Q) => g.nodes.filter((n) => n.type === 'wood' && Math.max(Math.abs(n.tx - Math.floor(Q.home.x)), Math.abs(n.ty - Math.floor(Q.home.y))) <= 7).length >= 5), 'tactics: at least five Timber Stands within reach of each base');
    ok(TB.income.wood === 35 && TB.hqIncome.wood === 40, 'tactics: Timber Stands and the Kitchen HQ pay more Firewood');
    const plain = g.incomeOf(P);
    P.sugarNext = true; const sweet = g.incomeOf(P); P.sugarNext = false;
    ok(Math.abs(sweet.food / plain.food - TB.sugarMul) < 0.05 && TB.sugarMul === 1.2, 'tactics: Sugar Rush makes stations pay 20% more, not 40%', `${plain.food} -> ${sweet.food}`);
    const sauc = g.spawnUnit(0, 'saucier', 2.5, 2.5), line = g.spawnUnit(1, 'line', 3.5, 2.5);
    ok(sauc.S.hp === Math.round(38 * TB.rangedHp), 'tactics: ranged units are tougher on the grid', `${sauc.S.hp} HP`);
    const raw = tbDamage(sauc.S, line.S, { ranged: true });
    ok(Math.abs(g.damageFor(sauc, line, false) - raw * TB.rangedMul) <= 1, 'tactics: and hit harder', `${raw} -> ${g.damageFor(sauc, line, false)}`);
    const hank = g.heroOf(g.players[1]);
    ok(hank.S.hp === 420, 'tactics: Big Hank has 420 HP in the Food Cart Age...', String(hank.S.hp));
    g.completeTech(g.players[1], 'age2');
    ok(g.heroOf(g.players[1]).S.hp === 525, '...and 525 in the Diner Age', String(g.heroOf(g.players[1]).S.hp));
    g.killEntity(sauc, -1); g.killEntity(line, -1); settle(g);
  }
  // one counterattack per turn
  {
    const g = mkT(['flint', 'nonna'], { seed: 9 });
    for (const P of g.players) if (P.heroId) g.killEntity(g.ents.get(P.heroId), -1);
    settle(g);
    const d = mineT(g, 1, 'line')[0];
    const around = g.freeAround(d.tx, d.ty, 1).filter((t) => tbDist(t[0], t[1], d.tx, d.ty) === 1);
    const a1 = g.spawnUnit(0, 'line', around[0][0] + 0.5, around[0][1] + 0.5), a2 = g.spawnUnit(0, 'line', around[1][0] + 0.5, around[1][1] + 0.5);
    d.hp = 1000; d.S = { ...d.S, hp: 1000 };
    const h1 = a1.hp, h2 = a2.hp;
    g.command(0, { c: 'tat', id: a1.id, tid: d.id }); settle(g);
    const first = a1.hp < h1, flagged = !!(g.flagsOf(d) & F_COUNTERED);
    g.command(0, { c: 'tat', id: a2.id, tid: d.id }); settle(g);
    ok(first && flagged && a2.hp === h2, 'tactics: a unit hits back only once per enemy turn', `first ${h1}->${a1.hp}, second ${h2}->${a2.hp}`);
    g.command(0, { c: 'et' }); settle(g); g.command(1, { c: 'et' }); settle(g);
    ok(!(g.flagsOf(d) & F_COUNTERED), 'tactics: and can hit back again next turn');
  }
  // towers shoot stations, recruits walk out where you point, the market works on your turn only
  {
    const g = mkT(['hank', 'zara'], { seed: 12 });
    const A = g.players[0], B = g.players[1];
    for (const P of g.players) if (P.heroId) g.killEntity(g.ents.get(P.heroId), -1);
    settle(g);
    for (const u of g.units.slice()) if (u.owner === 1) g.killEntity(u, -1);                 // no enemy units about: only stations to shoot
    settle(g);
    const hq = g.bldgs.find((b) => b.owner === 0 && b.type === 'hq');
    const spotT = g.freeAround(hq.tx, hq.ty, 3).find((t) => tbDist(t[0], t[1], hq.tx, hq.ty) === 2);
    const tower = g.addBuilding(0, 'tower', spotT[0], spotT[1], true);
    const spotE = g.freeAround(tower.tx, tower.ty, 2).find((t) => tbDist(t[0], t[1], tower.tx, tower.ty) === 2);
    const shed = g.addBuilding(1, 'house', spotE[0], spotE[1], true);
    const hp0 = shed.hp;
    g.command(0, { c: 'et' }); settle(g); g.command(1, { c: 'et' }); settle(g);
    ok(shed.hp < hp0, 'tactics: towers (and the Kitchen HQ) shoot enemy stations too', `${hp0} -> ${shed.hp}`);
    // rally: recruits walk out on the chosen side
    const sides = g.freeAround(hq.tx, hq.ty, 1).filter((t) => tbDist(t[0], t[1], hq.tx, hq.ty) === 1);
    const far = sides[sides.length - 1];
    const rx = hq.tx + (far[0] - hq.tx) * 3, ry = hq.ty + (far[1] - hq.ty) * 3;
    g.command(1, { c: 'trl', bid: hq.id, x: rx, y: ry });
    ok(!hq.trally, 'tactics: nobody else can set your rally');
    g.command(0, { c: 'trl', bid: hq.id, x: rx, y: ry });
    ok(hq.trally && hq.trally.x === rx, 'tactics: right-clicking a tile sets where a station\'s recruits walk out');
    g.command(0, { c: 'tr', bid: hq.id, u: 'cook' }); settle(g);
    const before = new Set(mineT(g, 0, 'cook').map((u) => u.id));
    g.command(0, { c: 'et' }); settle(g); g.command(1, { c: 'et' }); settle(g);
    const fresh = mineT(g, 0, 'cook').find((u) => !before.has(u.id));
    ok(fresh && Math.sign(fresh.tx - hq.tx) === Math.sign(far[0] - hq.tx) && Math.sign(fresh.ty - hq.ty) === Math.sign(far[1] - hq.ty), 'tactics: and the next one does', fresh ? `${fresh.tx},${fresh.ty} (hq ${hq.tx},${hq.ty}, side ${far})` : 'none');
    // market on the grid
    const mspot = g.freeAround(hq.tx, hq.ty, 4).find((t) => tbDist(t[0], t[1], hq.tx, hq.ty) >= 2 && !g.grid[t[1] * g.w + t[0]]);
    g.addBuilding(0, 'market', mspot[0], mspot[1], true);
    const w0 = A.res.wood;
    g.command(0, { c: 'mkt', give: 'wood', get: 'salt', n: 1 }); settle(g);
    ok(A.res.wood === w0 - MARKET.lot, 'tactics: the Farmers Market trades during your turn');
    g.command(0, { c: 'et' }); settle(g);
    const w1 = A.res.wood;
    g.command(0, { c: 'mkt', give: 'wood', get: 'salt', n: 1 }); settle(g);
    ok(A.res.wood === w1, 'tactics: but not during someone else\'s');
  }
  // team turns
  {
    const g = mkT(['flint', 'nonna', 'ryo', 'zara'], { teams: [0, 0, 1, 1], order: 'team', size: 'medium' });
    ok(g.teamTurns && g.turn.team === 0 && g.isTurnOf(0) && g.isTurnOf(1) && !g.isTurnOf(2), 'team turns: team-mates play at the same time');
    const r = g.turnRec();
    ok(r.length === 5 && r[3] === 0 && r[4] === 0, 'team turns: clients are told which team is playing');
    const u1 = mineT(g, 1, 'line')[0], u2 = mineT(g, 2, 'line')[0];
    const mv = (u) => { const reach = g.reach(u); const i = [...reach.best.keys()].find((k) => !g.grid[k] && k !== u.ty * g.w + u.tx); return [i % g.w, (i / g.w) | 0]; };
    const [x1, y1] = mv(u1), [x2, y2] = mv(u2);
    g.command(1, { c: 'tmv', id: u1.id, x: x1, y: y1 }); g.command(2, { c: 'tmv', id: u2.id, x: x2, y: y2 }); settle(g);
    ok(u1.tx === x1 && u2.tx !== x2, 'team turns: the second kitchen of the playing team can act; the other team cannot');
    g.command(0, { c: 'et' }); settle(g);
    ok(g.turn.team === 0 && !g.isTurnOf(0) && g.isTurnOf(1) && (g.turnRec()[4] & 1), 'team turns: ending yours waits for your team-mate');
    g.command(1, { c: 'et' }); settle(g);
    ok(g.turn.team === 1 && g.isTurnOf(2) && g.isTurnOf(3) && g.turn.n === 1, 'team turns: when both have ended, the other team plays');
    g.command(2, { c: 'et' }); g.command(3, { c: 'et' }); settle(g);
    ok(g.turn.team === 0 && g.turn.n === 2, 'team turns: then a new round');
    // bots play team turns too
    const b = new TacticsGame({ players: ['flint', 'nonna', 'ryo', 'zara'].map((c, i) => ({ name: 'B' + i, commander: c, team: i < 2 ? 0 : 1, color: i, bot: 'normal' })), mapSize: 'medium', startRes: 'standard', popCap: 100, seed: 3, turnOrder: 'team' });
    for (const P of b.players) { P.ai = new TacticsBot(b, P, 'normal'); P.ai.L = { ...P.ai.L, pace: 1 }; }
    let boom = null;
    try { for (let i = 0; i < 200000 && b.turn.n <= 12 && !b.over; i++) { b.step(); b.delta(); } } catch (e) { boom = e; }
    ok(!boom && b.turn.n > 12, 'team turns: four bots play twelve rounds two at a time', boom ? boom.stack : `round ${b.turn.n}`);
    const solo = mkT(['flint', 'nonna'], { order: 'team' });
    ok(!solo.teamTurns, 'team turns: with one kitchen per team the option changes nothing');
  }

  // ---- capture the flag: slows, buff camps, fair bots
  {
    const g = new CtfGame({ players: [{ name: 'A', commander: 'ingrid', team: 1, color: 0 }, { name: 'B', commander: 'kofi', team: 2, color: 1 }], seed: 3, ctfCaps: 3, ctfTime: 15 });
    run(g, 1);
    const A = g.players[0], B = g.players[1], ha = g.heroOf(A), hb = g.heroOf(B);
    const cplace = (u, x, y) => { u.x = x; u.y = y; u.order = null; u.path = null; u.st = ST.IDLE; };
    cplace(ha, 30, 30); cplace(hb, 32, 30); g.step();
    g.command(0, { c: 'ab' }); g.step();
    ok(Math.abs((A.abilityReady - g.tick) / TICK_RATE - COMMANDERS.ingrid.ability.ctfCd) < 0.2 && COMMANDERS.ingrid.ability.ctfCd >= 30, 'ctf: Brain Freeze has a longer cooldown of its own', `${((A.abilityReady - g.tick) / TICK_RATE).toFixed(1)}s`);
    // buff camps
    const pep = g.camps.find((k) => k.type === 'pepper'), sug = g.camps.find((k) => k.type === 'sugar');
    ok(pep && sug && pep.alive === 1 && sug.alive === 1 && Math.abs(pep.y - sug.y) > g.h * 0.5, 'ctf: a buff camp at the top of the map and one at the bottom', pep && sug ? `${pep.y.toFixed(0)} / ${sug.y.toFixed(0)}` : '');
    const guard = g.ents.get([...pep.units][0]);
    cplace(hb, pep.x - 1.5, pep.y); g.step();
    g.applyDamage(1, hb.id, guard, guard.hp + 50, {}, false); run(g, 0.3);
    ok(hb.buffs && hb.buffs.b_pepper && hb.bAtk > 1.15, 'ctf: the last hit on a buff camp wears its buff', JSON.stringify(hb.buffs));
    // vision
    cplace(ha, 10, 10); cplace(hb, 60, 60); g.step();
    ok(!g.seenBy(1, hb) && g.seenBy(2, hb), 'ctf: an enemy hero far from your heroes and kitchen is out of sight');
    cplace(hb, 12, 10); g.step();
    ok(g.seenBy(1, hb), 'ctf: and in sight once close');
  }
  {
    // the bot only hunts a carrier it can see (or a reveal pointed at)
    const g = new CtfGame({ players: [{ name: 'Human', commander: 'kofi', team: 1, color: 0 }, { name: 'Bot', commander: 'dolly', team: 2, color: 1, bot: 'hard' }], seed: 6, ctfCaps: 3, ctfTime: 15 });
    run(g, 1);
    const H = g.players[0], Bt = g.players[1];
    Bt.ai = new CtfBot(g, Bt, 'hard');
    const hh = g.heroOf(H), bh = g.heroOf(Bt), flag = g.flagOf(2);
    const cplace = (u, x, y) => { u.x = x; u.y = y; u.order = null; u.path = null; u.st = ST.IDLE; };
    cplace(hh, flag.hx, flag.hy); g.step(); g.step();
    ok(flag.state === 1 && flag.carrier === hh.id, 'ctf bots: (setup) the human has the bot\'s flag');
    const reveals = [];
    const hide = g.flagOf(1);
    cplace(bh, hide.hx + 4, hide.hy - 18);                                  // the bot's hero is far off, out of sight
    cplace(hh, hide.hx - 2, hide.hy + 20);
    let chased = false;
    for (let i = 0; i < 6 * TICK_RATE; i++) {
      hh.x = hide.hx - 2; hh.y = hide.hy + 20; hh.order = null;
      g.step();
      for (const e of g.events) if (e[0] === 'reveal') reveals.push(e);
      g.delta();
      if (bh.order && bh.order.t === 'attack' && bh.order.id === hh.id) chased = true;
    }
    ok(!g.seenBy(2, hh) && !chased, 'ctf bots: a carrier out of sight is not hunted down on the spot');
    for (let i = 0; i < (CTF.reveal + 1) * TICK_RATE; i++) { hh.x = hide.hx - 2; hh.y = hide.hy + 20; g.step(); for (const e of g.events) if (e[0] === 'reveal') reveals.push(e); g.delta(); }
    ok(reveals.length >= 1 && reveals[0][1] === 2, `ctf: a carrier shows up on everyone's minimap every ${CTF.reveal}s`, String(reveals.length));
    cplace(bh, hh.x + 3, hh.y); g.step();
    let attacked = false;
    for (let i = 0; i < 3 * TICK_RATE && !attacked; i++) { g.step(); g.delta(); if (bh.order && bh.order.t === 'attack' && bh.order.id === hh.id) attacked = true; }
    ok(attacked, 'ctf bots: but once the carrier is in sight the bot goes for it');
  }
}

// ------------------------------------------------- v1.1.0: capture the flag
{
  const { CtfGame, generateCtfMap, ITEM_KEYS } = await import('../game/ctf.js');
  const { CtfBot } = await import('../game/ctf-ai.js');
  const { CTF, HERO_KEYS, ctfHeroStats, ctfItemCost, MAX_PLAYERS } = await import('../game/data.js');
  const mkc = (specs, opts = {}) => new CtfGame({ players: specs.map(([c, team], i) => ({ name: 'P' + i, commander: c, team, color: i, bot: opts.bots ? 'normal' : null })), seed: opts.seed || 11, ctfCaps: opts.caps || 3, ctfTime: opts.time || 15 });
  const hero = (g, pi) => g.heroOf(g.players[pi]);
  /** Put a unit down somewhere (tests only). */
  const place = (g, u, x, y) => { u.x = x; u.y = y; u.order = null; u.path = null; u.st = ST.IDLE; };
  const settle = (g) => { g.step(); };                                              // (one tick refreshes the spatial index)

  // ---- data: the arena-only heroes exist, the shared keys are split properly
  {
    const extra = HERO_KEYS.filter((k) => !COMMANDER_KEYS.includes(k));
    ok(extra.length === 4 && extra.every((k) => COMMANDERS[k].ctfOnly && UNITS[COMMANDERS[k].hero] && COMMANDERS[k].ability && COMMANDERS[k].ultimate && COMMANDERS[k].aura), 'ctf: four arena-only heroes with a kit, an aura and a unit each', extra.join(','));
    ok(HERO_KEYS.length === 10 && MAX_PLAYERS === 10, 'ctf: ten heroes for ten players');
    const melee = HERO_KEYS.filter((k) => !UNITS[COMMANDERS[k].hero].range).length;
    ok(melee >= 4 && HERO_KEYS.length - melee >= 4, 'ctf: a mix of melee and ranged heroes', `${melee} melee, ${HERO_KEYS.length - melee} ranged`);
    const base = computeStats('kofi', CTF.heroAge, []).units.hero_kofi;
    const full = {}; for (const k of ITEM_KEYS) full[k] = CTF.items[k].tiers.length;
    const S = ctfHeroStats(base, full), S0 = ctfHeroStats(base, {});
    ok(S.hp > S0.hp && S.atk > S0.atk && S.speed > S0.speed && S.reload < S0.reload && S.armor > S0.armor && S.regen > 0, 'ctf: a full bag of items improves every stat', `hp ${S0.hp}→${S.hp} atk ${S0.atk}→${S.atk}`);
    ok(ctfItemCost('skillet', 0) === 140 && ctfItemCost('skillet', 3) === 0 && ctfItemCost('nope', 0) === 0, 'ctf: item prices climb by tier and stop at the top');
  }

  // ---- the map: a base per team, camps, everything connected
  {
    for (const teams of [[1, 2], [1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]) {
      const m = generateCtfMap(teams, 5);
      const bad = [];
      if (m.bases.length !== teams.length) bad.push('bases ' + m.bases.length);
      if (!m.camps.some((c) => c.type === 'critic')) bad.push('no critic');
      if (m.camps.filter((c) => c.type !== 'critic').length < teams.length * 3) bad.push('few camps ' + m.camps.length);
      // every base reaches every other base over grass
      const walk = (t) => t === TILE.GRASS;
      const seen = new Uint8Array(m.w * m.h), q = [m.bases[0].ty * m.w + m.bases[0].tx]; seen[q[0]] = 1;
      while (q.length) { const i = q.pop(), x = i % m.w, y = (i / m.w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue; const j = ny * m.w + nx; if (!seen[j] && walk(m.tiles[j])) { seen[j] = 1; q.push(j); } } }
      for (const b of m.bases) if (!seen[b.ty * m.w + b.tx]) bad.push('base cut off ' + b.team);
      for (const c of m.camps) { let near = false; for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (seen[(c.y + dy) * m.w + c.x + dx]) { near = true; break; } if (!near) bad.push('camp cut off ' + c.type); }
      ok(!bad.length, `ctf: a ${teams.length}-team arena (${m.w}×${m.h}) has a base per team, camps and open paths`, bad.join(', '));
    }
  }

  // ---- start: one hero each, a shared invulnerable kitchen per team, Tips, the wild kitchen last
  {
    const g = mkc([['kofi', 1], ['nonna', 1], ['ryo', 2], ['rafa', 2]]);
    const N = g.neutral;
    ok(N.neutral && N.team === -1 && g.players.length === 5 && g.players.slice(0, 4).every((P) => !P.neutral), 'ctf: the wild kitchen is appended as the last player');
    ok(g.players.slice(0, 4).every((P) => hero(g, P.idx) && P.res.food === CTF.startTips && P.age === CTF.heroAge), 'ctf: everybody starts with a hero and the starting Tips');
    const hqs = g.bldgs.filter((b) => b.type === 'hq');
    ok(hqs.length === 2 && hqs.every((b) => b.invuln && b.shared), 'ctf: one unbreakable kitchen per team');
    const h0 = hero(g, 0), h1 = hero(g, 1);
    ok(Math.hypot(h0.x - h1.x, h0.y - h1.y) < 6, 'ctf: team-mates spawn at the same kitchen');
    run(g, 3);
    const hp = hqs[0].hp; g.applyDamage(2, hero(g, 2).id, hqs[0], 500, {}, false);
    ok(hqs[0].hp === hp, 'ctf: kitchens shrug off damage');
    ok(g.units.some((u) => u.owner === N.idx && u.camp), 'ctf: the wild camps are populated');
    const cooks = g.units.filter((u) => u.owner === N.idx && u.type === 'cook');
    ok(cooks.length > 0 && cooks.every((u) => u.noPop && u.bounty > 0 && u.camp), 'ctf: minions carry a bounty and cost no staff');
  }

  // ---- flags: take, run home, capture; drop on death; a dropped flag returns on touch or by timer
  {
    const g = mkc([['kofi', 1], ['ryo', 2]]);
    const [A, B] = g.players, fA = g.flagOf(1), fB = g.flagOf(2);
    const hA = hero(g, 0);
    ok(fA.state === 0 && fB.state === 0 && fA.x === fA.hx, 'ctf: flags start on their stands');
    place(g, hA, fB.hx, fB.hy); g.step(); g.step();
    ok(fB.state === 1 && fB.carrier === hA.id && hA.buffs && hA.buffs.flagged, 'ctf: stepping on the enemy flag picks it up');
    const ev = g.events.find((e) => e[0] === 'flag' && e[1] === 'take');
    ok(ev && ev[2] === 2 && ev[3] === 0, 'ctf: and announces who took it');
    g.delta();
    const fx = fB.x; run(g, 0.5);
    place(g, hA, fA.hx + 0.5, fA.hy); g.step(); g.step();
    ok(fB.state === 0 && fB.x === fB.hx && g.caps[1] === 1 && A.caps === 1 && A.res.food > CTF.startTips, 'ctf: bringing it to your own stand scores and pays Tips', `caps ${JSON.stringify(g.caps)} tips ${A.res.food}`);
    // our own flag away: the capture still counts (v1.3.0)
    const hB = hero(g, 1);
    place(g, hB, fA.hx, fA.hy); place(g, hA, 40, 40); g.step();
    ok(fA.state === 1 && fA.carrier === hB.id, 'ctf: the other side can take our flag too');
    place(g, hA, fB.hx, fB.hy); g.step();
    ok(fB.state === 1 && fB.carrier === hA.id, 'ctf: both flags can be out at once');
    place(g, hB, 50, 50); g.step();
    place(g, hA, fA.hx, fA.hy); g.step(); g.step();
    ok(fB.state === 0 && g.caps[1] === 2 && fA.state === 1 && fA.carrier === hB.id, 'ctf: reaching your own stand scores even while your own flag is away', JSON.stringify(g.caps));
    place(g, hA, 40, 40); g.step();
    // the carrier falls: the flag drops where they stood, a team-mate (or the owner) touching it returns it
    const tipsBefore = A.res.food;
    g.killEntity(hB, 0); g.step();
    ok(fA.state === 2 && Math.abs(fA.x - 50) < 1 && B.deaths === 1 && A.score.heroKills === 1, 'ctf: a felled carrier drops the flag', `state ${fA.state} at ${fA.x.toFixed(1)}`);
    ok(A.res.food >= tipsBefore + CTF.heroBounty - 2, 'ctf: a hero kill pays a bounty', `${tipsBefore} → ${A.res.food}`);
    place(g, hA, 50, 50); g.step();
    ok(fA.state === 0 && fA.x === fA.hx, 'ctf: touching your own dropped flag returns it');
    // timer return
    const g2 = mkc([['dolly', 1], ['ingrid', 2]]);
    const h2 = hero(g2, 0), f2 = g2.flagOf(2);
    place(g2, h2, f2.hx, f2.hy); g2.step(); place(g2, h2, 30, 30); g2.step(); g2.killEntity(h2, -1); g2.step();
    ok(f2.state === 2, 'ctf: a flag dropped in the field waits');
    run(g2, CTF.flag.dropReturn + 1);
    ok(f2.state === 0 && f2.x === f2.hx, `ctf: and goes home by itself after ${CTF.flag.dropReturn}s`);
    // a stunned hero cannot grab
    const g3 = mkc([['kofi', 1], ['ryo', 2]]);
    const h3 = hero(g3, 0), f3 = g3.flagOf(2);
    h3.stunned = true; place(g3, h3, f3.hx, f3.hy); g3.step();
    ok(f3.state === 0, 'ctf: a stunned hero cannot pick a flag up');
  }

  // ---- shop: at the kitchen only, Tips only, tiers, stats follow; the Energy Bar
  {
    const g = mkc([['kofi', 1], ['ryo', 2]]);
    const A = g.players[0], h = hero(g, 0), base = g.baseOf.get(1);
    const atk0 = h.S.atk, hp0 = h.S.hp;
    ok(Math.abs(atk0 - Math.round(computeStats('kofi', CTF.heroAge, []).units.hero_kofi.atk * CTF.heroAtkMul * (CTF.heroDps.kofi || 1) * 10) / 10) < 0.11, 'ctf: heroes hit harder in the arena', String(atk0));
    g.command(0, { c: 'buy', item: 'herbs' });
    ok(A.items.herbs === 1 && A.res.food === CTF.startTips - 110 && h.S.regen === 3, 'ctf: buying Herb Garden I at the kitchen takes 110 Tips and adds regen');
    g.command(0, { c: 'buy', item: 'skillet' });
    ok(A.items.skillet === 0 && g.events.some((e) => e[0] === 'note' && e[2] === 'tips'), 'ctf: too poor for a Skillet');
    A.res.food = 5000;
    place(g, h, g.w / 2, g.h / 2); g.command(0, { c: 'buy', item: 'skillet' });
    ok(A.items.skillet === 0 && g.events.some((e) => e[0] === 'note' && e[2] === 'shop'), 'ctf: no shopping away from the kitchen');
    place(g, h, base.x + 1, base.y + 2);
    for (let i = 0; i < 5; i++) g.command(0, { c: 'buy', item: 'skillet' });
    ok(A.items.skillet === 3 && h.S.atk > atk0 && g.events.some((e) => e[0] === 'note' && e[2] === 'maxed'), 'ctf: three Skillet tiers, then it is maxed', `atk ${atk0} → ${h.S.atk}`);
    h.hp = 100; g.command(0, { c: 'buy', item: 'stew' });
    ok(h.S.hp === hp0 + 130 && h.hp === 230, 'ctf: a Stew tier raises max health and heals the difference');
    g.command(0, { c: 'buy', item: 'clogs' }); g.command(0, { c: 'buy', item: 'whites' }); g.command(0, { c: 'buy', item: 'espresso' });
    ok(h.S.speed > 3 && h.S.armor > 2 && h.S.reload < 0.75, 'ctf: clogs, whites and espresso change speed, armour and attack rate');
    g.command(0, { c: 'buy', item: '__proto__' }); g.command(0, { c: 'buy', item: 42 }); g.command(0, { c: 'buy' });
    ok(Object.keys(A.items).length === ITEM_KEYS.length, 'ctf: junk item names are ignored');
    // shopping while dead
    const B = g.players[1], hb = hero(g, 1); B.res.food = 1000;
    g.killEntity(hb, 0); g.step();
    g.command(1, { c: 'buy', item: 'whites' });
    ok(B.items.whites === 1, 'ctf: a fallen hero shops while waiting to respawn');
    const back = g.heroRespawnTicks();
    run(g, back / TICK_RATE + 1);
    const hb2 = hero(g, 1);
    ok(hb2 && hb2.S.armor > 2 && Math.hypot(hb2.x - g.baseOf.get(2).x, hb2.y - g.baseOf.get(2).y) < 6, 'ctf: and comes back at the kitchen wearing it');
    // energy bar
    A.res.food = 100; h.hp = 100;
    g.command(0, { c: 'eat' });
    ok(A.res.food === 40 && h.buffs && h.buffs.energy && A.energyReady > g.tick, 'ctf: an Energy Bar costs 60 Tips and starts healing');
    run(g, 4.5);
    ok(h.hp > 100 + h.S.hp * 0.3, 'ctf: it heals about a third of max health', `${h.hp}/${h.S.hp}`);
    A.res.food = 100; g.command(0, { c: 'eat' });
    ok(A.res.food === 100 && g.events.some((e) => e[0] === 'note' && e[2] === 'full'), 'ctf: one bar every 20 seconds');
    // fountain
    place(g, h, base.x, base.y + 3); h.hp = 50; run(g, 5);
    ok(h.hp > 50 + h.S.hp * 0.3, 'ctf: heroes heal fast at their kitchen', `${Math.round(h.hp)}/${h.S.hp}`);
    // respawn gets slower
    const g4 = mkc([['kofi', 1], ['ryo', 2]]);
    const early = g4.heroRespawnTicks(); g4.tick = 12 * 60 * TICK_RATE;
    ok(early === CTF.respawn.base * TICK_RATE && g4.heroRespawnTicks() > early && g4.heroRespawnTicks() <= CTF.respawn.max * TICK_RATE, 'ctf: respawns take longer as the match goes on');
  }

  // ---- camps: bounties, the whole camp fights back, respawn, levels
  {
    const g = mkc([['kofi', 1], ['ryo', 2]]);
    const A = g.players[0], h = hero(g, 0);
    run(g, 1);
    const camp = g.camps.find((c) => c.type === 'dishpit' && c.alive);
    const first = g.ents.get([...camp.units][0]);
    place(g, h, camp.x - 2, camp.y);
    A.res.food = 0;
    g.command(0, { c: 'at', ids: [h.id], tid: first.id });
    run(g, 25);
    ok(A.minions >= 1 && A.res.food >= 25, 'ctf: a hero clears a dishpit camp and pockets the bounties', `minions ${A.minions} tips ${A.res.food}`);
    ok(g.events.some((e) => e[0] === 'camp' && e[1] === camp.i && e[2] === 'down') || camp.alive > 0, 'ctf: a cleared camp announces it');
    if (!camp.alive) {
      ok(camp.nextAt > g.tick, 'ctf: and schedules a respawn');
      place(g, h, 5, 5); run(g, camp.def.respawn + 1);
      ok(camp.alive === camp.def.units.length, 'ctf: the camp comes back later', `${camp.alive}`);
    }
    // leash: minions do not chase across the map
    const g2 = mkc([['rafa', 1], ['ryo', 2]]);
    run(g2, 1);
    const h2 = hero(g2, 0), camp2 = g2.camps.find((c) => c.type === 'cooks' && c.alive), m2 = g2.ents.get([...camp2.units][0]);
    place(g2, h2, camp2.x - 3, camp2.y); settle(g2);
    g2.applyDamage(0, h2.id, m2, 5, {}, true); g2.step();
    const angry = [...camp2.units].map((id) => g2.ents.get(id)).filter((u) => u.order && u.order.t === 'attack').length;
    ok(angry === camp2.units.size, 'ctf: hit one minion and the whole camp turns on you');
    place(g2, h2, 5, 5); run(g2, 12);
    const far = [...camp2.units].map((id) => g2.ents.get(id)).every((u) => u && !u.dead && Math.hypot(u.x - camp2.x, u.y - camp2.y) < CTF.minion.leash + 3);
    ok(far, 'ctf: minions give up the chase and go home');
    // levels
    const g3 = mkc([['kofi', 1], ['ryo', 2]]);
    g3.tick = CTF.minion.levelEvery * TICK_RATE * 2 - 1; g3.step();
    ok(g3.minionLevel === 2 && g3.events.some((e) => e[0] === 'minions' && e[1] === 2), 'ctf: minions level up on the clock');
    for (const c of g3.camps) if (c.type === 'dishpit') { for (const id of c.units) g3.killEntity(g3.ents.get(id), -1); }
    g3.step(); run(g3, CTF.camps.dishpit.respawn + 1);
    const lv2 = g3.units.find((u) => u.camp && u.camp.type === 'dishpit');
    ok(lv2 && lv2.S.hp > UNITS.cook.hp * 1.5 && lv2.bounty > CTF.camps.dishpit.bounty / 4, 'ctf: a respawned camp is tougher and richer', lv2 ? `hp ${lv2.S.hp} bounty ${lv2.bounty}` : 'none');
    const boss = g3.units.find((u) => u.boss);
    ok(boss && boss.S.hp >= UNITS.truck.hp * 3 && boss.bounty >= CTF.camps.critic.bounty, 'ctf: the Critic is a proper boss', boss ? `hp ${boss.S.hp} bounty ${boss.bounty}` : 'none');
  }

  // ---- kits: scaled cooldowns, the ultimate unlock, new abilities do something
  {
    const g = mkc([['kofi', 1], ['dolly', 1], ['ingrid', 2], ['rafa', 2], ['zara', 2], ['hank', 1]]);
    const kofi = hero(g, 0), dolly = hero(g, 1), ingrid = hero(g, 2), rafa = hero(g, 3), zara = hero(g, 4), hank = hero(g, 5);
    g.command(0, { c: 'ul' });
    ok(g.events.some((e) => e[0] === 'note' && e[1] === 0 && e[2] === 'ultage') && !g.players[0].ultReady, 'ctf: ultimates are locked at first');
    // Flash Fry: dash to the enemy hero and hurt it
    place(g, kofi, 30, 30); place(g, ingrid, 35, 30); settle(g); const ihp = ingrid.hp;
    g.command(0, { c: 'ab' }); g.step();
    ok(ingrid.hp < ihp && Math.hypot(kofi.x - ingrid.x, kofi.y - ingrid.y) < 2.5 && kofi.buffs && kofi.buffs.fry, 'ctf: Flash Fry dashes in, hits, and speeds up attacks', `d ${Math.hypot(kofi.x - ingrid.x, kofi.y - ingrid.y).toFixed(1)} hp ${ihp}→${ingrid.hp}`);
    const cd = g.players[0].abilityReady - g.tick;
    ok(Math.abs(cd - Math.round(COMMANDERS.kofi.ability.cd * CTF.abilityCdMul * TICK_RATE)) <= TICK_RATE, 'ctf: ability cooldowns are scaled down', `${cd / TICK_RATE}s`);
    // Hot Shot: a long-range snipe at the most wounded enemy hero
    place(g, rafa, 30, 40); place(g, dolly, 30, 48); settle(g); dolly.hp = 100; const dhp = dolly.hp;
    g.command(3, { c: 'ab' }); run(g, 2);
    ok(dolly.hp < dhp, 'ctf: Hot Shot wounds the weakest enemy hero in range', `${dhp}→${dolly.hp}`);
    // Brain Freeze: chills enemies
    place(g, ingrid, 20, 20); place(g, kofi, 22, 20); settle(g); g.command(2, { c: 'ab' }); g.step();
    ok(kofi.buffs && kofi.buffs.chill && kofi.bSpeed < 0.95, 'ctf: Brain Freeze slows enemies nearby', `speed x${kofi.bSpeed}`);
    // Hold the Pass: Dolly heals and braces
    place(g, dolly, 60, 60); settle(g); dolly.hp = 100; g.command(1, { c: 'ab' }); g.step();
    ok(dolly.hp > 100 && dolly.buffs && dolly.buffs.brace, 'ctf: Hold the Pass heals and braces', `hp ${dolly.hp}`);
    // Rush Hour: Zara speeds up
    g.command(4, { c: 'ab' }); g.step();
    ok(zara.buffs && zara.buffs.sugar, 'ctf: Zara\'s arena ability is Rush Hour (a sugar rush)');
    // ultimates after the unlock
    g.tick = g.ultUnlock; g.step();
    place(g, kofi, 30, 30); place(g, ingrid, 31, 30); place(g, rafa, 32, 31); settle(g); const ihp2 = ingrid.hp, rhp2 = rafa.hp;
    g.command(0, { c: 'ul' }); run(g, 2);
    ok(ingrid.hp < ihp2 && rafa.hp < rhp2, 'ctf: Cleaver Storm damages everyone around Kofi', `${ihp2}→${ingrid.hp}, ${rhp2}→${rafa.hp}`);
    const ucd = g.players[0].ultReady - g.tick;
    ok(ucd > 0 && ucd <= COMMANDERS.kofi.ultimate.cd * CTF.ultCdMul * TICK_RATE, 'ctf: ultimate cooldowns are scaled down', `${ucd / TICK_RATE}s`);
    // (the storm finished Ingrid off: wait for her to come back, then freeze)
    ok(ingrid.dead && g.players[2].deaths === 1, 'ctf: a hero can fall to an ultimate');
    run(g, g.heroRespawnTicks() / TICK_RATE + 1);
    const ingrid2 = hero(g, 2);
    place(g, ingrid2, 20, 20); place(g, kofi, 22, 20); place(g, rafa, 70, 70); settle(g); kofi.stunned = false; delete kofi.storm;
    g.command(2, { c: 'ul' }); g.step();
    ok(ingrid2 && kofi.stunned && kofi.buffs.chill, 'ctf: Deep Freeze stuns and chills enemies around Ingrid');
    const rafa2 = hero(g, 3) || (run(g, g.heroRespawnTicks() / TICK_RATE + 1), hero(g, 3));
    place(g, rafa2, 40, 40); place(g, dolly, 46, 40); place(g, kofi, 70, 70); settle(g); const dhp2 = dolly.hp;
    g.command(3, { c: 'ul' }); run(g, 1);
    ok(rafa2 && dolly.hp < dhp2 && g.events.some((e) => e[0] === 'flood' && e[1] === 3), 'ctf: Sauce Flood pours a line of damage and tells the clients', `${dhp2}→${dolly.hp}`);
    place(g, hank, 10, 10); settle(g); g.command(5, { c: 'ul' }); g.step();
    ok(hank.buffs && hank.buffs.bark, 'ctf: Hank\'s arena ultimate is Thick Bark');
    place(g, dolly, 50, 50); place(g, kofi, 51, 50); settle(g); dolly.hp = 100; g.command(1, { c: 'ul' }); g.step();
    g.applyDamage(1, dolly.id, kofi, 40, {}, false);
    ok(dolly.buffs && dolly.buffs.lastcall && dolly.hp > 100, 'ctf: Last Call heals Dolly for the damage she deals');
  }

  // ---- victory: by captures, by the clock, sudden death, and a resignation
  {
    const g = mkc([['kofi', 1], ['ryo', 2]], { caps: 3 });
    g.caps[1] = 3; g.checkVictory();
    ok(g.over && g.over.team === 1, 'ctf: first to the target wins');
    const g2 = mkc([['kofi', 1], ['ryo', 2]], { caps: 5, time: 10 });
    g2.caps[1] = 2; g2.caps[2] = 1; g2.tick = g2.timeLimit; g2.checkVictory();
    ok(g2.over && g2.over.team === 1, 'ctf: when time is up the most captures wins');
    const g3 = mkc([['kofi', 1], ['ryo', 2]], { caps: 5, time: 10 });
    g3.caps[1] = 2; g3.caps[2] = 2; g3.tick = g3.timeLimit; g3.checkVictory();
    ok(!g3.over && g3.sudden && g3.events.some((e) => e[0] === 'sudden'), 'ctf: a level score goes to sudden death');
    g3.caps[2] = 3; g3.checkVictory();
    ok(g3.over && g3.over.team === 2, 'ctf: the next capture wins it');
    const g4 = mkc([['kofi', 1], ['ryo', 2]], { caps: 5, time: 10 });
    g4.caps[1] = 1; g4.caps[2] = 1; g4.players[0].score.heroKills = 3; g4.players[1].score.heroKills = 1; g4.tick = g4.suddenUntil; g4.checkVictory();
    ok(g4.over && g4.over.team === 1, 'ctf: still level after sudden death: most hero kills wins');
    const g5 = mkc([['kofi', 1], ['nonna', 1], ['ryo', 2]]);
    g5.eliminate(g5.players[2]); run(g5, 1.1);
    ok(g5.over && g5.over.team === 1 && !g5.players[2].alive && !hero(g5, 2), 'ctf: when the last enemy resigns the match ends');
    const g6 = mkc([['kofi', 1], ['nonna', 1], ['ryo', 2], ['rafa', 2]]);
    g6.eliminate(g6.players[2]); run(g6, 1.1);
    ok(!g6.over && g6.players[3].alive && g6.bldgs.filter((b) => b.type === 'hq').length === 2, 'ctf: a team-mate resigning leaves the kitchen for the others');
    const g7 = mkc([['kofi', 1]]);
    run(g7, 2);
    ok(!g7.over, 'ctf: alone you just practise');
  }

  // ---- ten players, snapshots, and the network records
  {
    const specs = HERO_KEYS.map((k, i) => [k, (i % 2) + 1]);
    const g = mkc(specs, { seed: 3 });
    ok(g.players.length === 11 && g.flags.length === 2 && g.bldgs.filter((b) => b.type === 'hq').length === 2, 'ctf: ten heroes, 5v5, two kitchens');
    const full = g.full();
    ok(full.ctf && full.flags && full.camps && full.p.length === 11 && full.p[0].length >= 27, 'ctf: the full snapshot carries flags, camps and the arena record');
    const si = g.startInfo();
    ok(si.mode === 'ctf' && si.ctf.capsToWin === 3 && si.ctf.bases.length === 2 && si.ctf.flags.length === 2 && si.ctf.camps.length === g.camps.length && si.ctf.neutral === 10, 'ctf: start info describes the arena');
    run(g, 2); g.delta();
    const t0 = Date.now(); run(g, 20); const ms = Date.now() - t0;
    ok(ms < 4000, 'ctf: twenty seconds of a 10-hero arena simulate quickly', `${ms} ms`);
    const ffa = mkc(HERO_KEYS.map((k, i) => [k, i + 1]), { seed: 4 });
    ok(ffa.flags.length === 10 && ffa.bldgs.filter((b) => b.type === 'hq').length === 10 && ffa.w >= 100, 'ctf: a ten-way free-for-all gets ten kitchens on a big ring', `${ffa.w}×${ffa.h}`);
  }

  // ---- bots play a whole match
  {
    const g = mkc([['kofi', 1], ['nonna', 1], ['ryo', 2], ['rafa', 2]], { seed: 9, caps: 3, time: 10, bots: true });
    for (const P of g.players) if (!P.neutral) P.ai = new CtfBot(g, P, 'hard');
    let boom = null, flagsTaken = 0, bought = 0;
    try {
      while (!g.over && g.tick < 16 * 60 * TICK_RATE) {
        g.step();
        for (const e of g.events) { if (e[0] === 'flag' && e[1] === 'take') flagsTaken++; if (e[0] === 'item') bought++; }
        g.delta();
      }
    } catch (e) { boom = e; }
    ok(!boom && g.over, 'ctf: four hard bots finish a 2v2 inside the time limit', boom ? boom.stack : `${(g.tick / TICK_RATE / 60).toFixed(1)} min, caps ${JSON.stringify(g.caps)}`);
    ok(flagsTaken >= 3 && bought >= 8 && g.players.slice(0, 4).every((P) => P.minions > 0), 'ctf: they run flags, farm camps and shop', `takes ${flagsTaken} items ${bought} minions ${g.players.slice(0, 4).map((P) => P.minions).join('/')}`);
    const sum = g.summary(), tl = g.timeline();
    ok(sum.length === 4 && sum.every((s) => s.ctf && typeof s.caps === 'number' && s.items) && tl.labels && tl.labels.army === 'Captures' && tl.series.score.length === 4, 'ctf: the summary and timeline leave the wild kitchen out');
  }

  // ---- hostile input
  {
    const g = mkc([['kofi', 1], ['ryo', 2], ['dolly', 1]], { seed: 5 });
    const junk = [undefined, null, NaN, Infinity, -1, 0, 1e9, '', 'x', '__proto__', 'constructor', [], {}, [1, 2, 3], { length: 5 }, true, 'skillet', 'herbs'];
    const pick = () => junk[(Math.random() * junk.length) | 0];
    const cmds = ['mv', 'am', 'at', 'st', 'sn', 'ab', 'ul', 'rg', 'buy', 'eat', 'bp', 'tr', 'ga', 'dl', 'bell', 'zz'];
    let threw = null;
    try {
      for (let i = 0; i < 4000; i++) {
        const pi = (Math.random() * 5) | 0;
        g.command(pi, { c: cmds[(Math.random() * cmds.length) | 0], ids: Math.random() < 0.5 ? g.units.slice(0, 4).map((u) => u.id) : pick(), item: pick(), tid: Math.random() < 0.5 ? (g.nextId * Math.random()) | 0 : pick(), x: pick(), y: pick(), v: pick(), i: pick() });
        if (i % 40 === 0) { g.step(); g.delta(); }
      }
      run(g, 10);
    } catch (e) { threw = e; }
    ok(!threw, 'ctf: thousands of malformed orders never crash the arena', threw ? threw.stack : '');
    let sane = g.units.filter((u) => u.owner === g.neutral.idx).length > 0 && !g.players[g.neutral.idx].items.skillet;
    for (const P of g.players) { for (const r in P.res) if (!Number.isFinite(P.res[r]) || P.res[r] < 0) sane = false; for (const k of ITEM_KEYS) if (!Number.isInteger(P.items[k]) || P.items[k] < 0 || P.items[k] > 3) sane = false; }
    ok(sane, 'ctf: and leave Tips, items and the wild kitchen intact');
  }
}

// ------------------------------------------- v1.3.0: hero levels, arena balance
{
  const { CtfGame } = await import('../game/ctf.js');
  const { CtfBot } = await import('../game/ctf-ai.js');
  const { CTF, HERO_KEYS, COMMANDERS, ctfHeroStats, ctfLevelNeed } = await import('../game/data.js');
  const mkc = (specs, seed = 11) => new CtfGame({ players: specs.map(([c, team], i) => ({ name: 'P' + i, commander: c, team, color: i, bot: null })), seed, ctfCaps: 5, ctfTime: 20 });
  const put = (u, x, y) => { u.x = x; u.y = y; u.order = null; u.path = null; u.st = ST.IDLE; };
  const totalXp = (P) => { let n = P.xp; for (let l = 1; l < P.level; l++) n += ctfLevelNeed(l); return n; };

  // ---- balance: everyone but Big Hank hits harder in the arena, ranged heroes most of all
  {
    const others = HERO_KEYS.filter((k) => k !== 'hank');
    ok(!CTF.heroDps.hank && others.every((k) => CTF.heroDps[k] > 1), 'ctf balance: every hero but Big Hank gets an attack boost in the arena', others.map((k) => k + ' ' + CTF.heroDps[k]).join(', '));
    const ranged = others.filter((k) => COMMANDERS[k] && computeStats(k, CTF.heroAge, []).units[COMMANDERS[k].hero].range > 0);
    const melee = others.filter((k) => !ranged.includes(k));
    ok(Math.min(...ranged.map((k) => CTF.heroDps[k])) >= 1.3 && Math.min(...ranged.map((k) => CTF.heroDps[k])) > Math.max(...melee.filter((k) => k !== 'flint').map((k) => CTF.heroDps[k])), 'ctf balance: ranged heroes get the biggest boosts', ranged.join(','));
    const base = computeStats('ingrid', CTF.heroAge, []).units.hero_ingrid, hb = computeStats('hank', CTF.heroAge, []).units.hero_hank;
    ok(Math.abs(ctfHeroStats(base, {}, 'ingrid').atk - base.atk * CTF.heroAtkMul * CTF.heroDps.ingrid) < 0.1 && Math.abs(ctfHeroStats(hb, {}, 'hank').atk - hb.atk * CTF.heroAtkMul) < 0.1, 'ctf balance: the boost lands on the hero\'s attack (Hank unchanged)');
  }

  // ---- levels: XP every second, so everyone levels over time; each level raises the stats
  {
    const g = mkc([['ingrid', 1], ['hank', 2]]);
    const [A, B] = g.players, hA = g.heroOf(A);
    g.step();
    ok(A.level === 1 && B.level === 1 && A.xp >= 0, 'ctf levels: heroes start at level 1');
    const hp1 = hA.S.hp, atk1 = hA.S.atk, ev = [];
    for (let i = 0; i < (Math.ceil(ctfLevelNeed(1) / CTF.level.xpPerSec) + 1) * TICK_RATE; i++) { g.step(); for (const e of g.events) if (e[0] === 'lvl') ev.push(e); }
    ok(A.level === 2 && B.level === 2, 'ctf levels: XP trickles in every second, so everyone levels up as the match goes on', `A lv ${A.level} (${A.xp} xp)`);
    ok(ev.some((e) => e[1] === A.idx && e[2] === 2), 'ctf levels: a level-up is announced');
    ok(hA.S.hp > hp1 && hA.S.atk > atk1 && hA.hp === hA.S.hp, 'ctf levels: a level raises health and attack (and tops up the gain)', `hp ${hp1}→${hA.S.hp} atk ${atk1}→${hA.S.atk}`);
    const base = computeStats('ingrid', CTF.heroAge, []).units.hero_ingrid;
    const S1 = ctfHeroStats(base, {}, 'ingrid', 1), S10 = ctfHeroStats(base, {}, 'ingrid', 10), S99 = ctfHeroStats(base, {}, 'ingrid', 99);
    ok(Math.abs(S10.hp / S1.hp - (1 + 9 * CTF.level.hp)) < 0.02 && Math.abs(S10.atk / S1.atk - (1 + 9 * CTF.level.atk)) < 0.02 && S10.armor === S1.armor + Math.floor(10 / CTF.level.armorEvery), 'ctf levels: level 10 means +54% health, +45% attack and more armour', `${S1.hp}/${S1.atk} → ${S10.hp}/${S10.atk}`);
    ok(S99.hp === ctfHeroStats(base, {}, 'ingrid', CTF.level.max).hp, `ctf levels: they stop at level ${CTF.level.max}`);
    // a wounded hero keeps its wounds but gains the new health
    hA.hp = 100; const before = hA.S.hp; g.setLevel(A, 4);
    ok(A.level === 4 && Math.abs(hA.hp - (100 + hA.S.hp - before)) < 1, 'ctf levels: levelling up while hurt adds the new health on top');
    // minions, takedowns and captures pay XP on top
    const minion = g.units.find((u) => u.camp && !u.dead && !u.camp.def.boss);
    const x0 = totalXp(A); g.killEntity(minion, A.idx); g.step();
    ok(totalXp(A) - x0 >= Math.round(minion.bounty * CTF.level.bountyXp), 'ctf levels: felling a minion pays XP', `${totalXp(A) - x0} xp`);
    const x1 = totalXp(A); g.killEntity(g.heroOf(B), A.idx); g.step();
    ok(totalXp(A) - x1 >= CTF.level.killXp + CTF.level.killXpPerLevel * B.level, 'ctf levels: a takedown pays more XP the higher the victim', `${totalXp(A) - x1} xp`);
    const fB = g.flagOf(2), fA = g.flagOf(1);
    put(hA, fB.hx, fB.hy); g.step(); g.step();
    const x2 = totalXp(A); put(hA, fA.hx, fA.hy); g.step(); g.step();
    ok(g.caps[1] === 1 && totalXp(A) - x2 >= CTF.level.capXp, 'ctf levels: a capture pays XP too', `${totalXp(A) - x2} xp`);
    // the network carries it, and nothing goes past the top level
    const r = g.playerRec(A);
    ok(r[27] === A.level && r[28] === A.xp, 'ctf levels: clients are told each hero\'s level and XP');
    g.gainXp(A, 1e9);
    ok(A.level === CTF.level.max && A.xp === 0 && Number.isFinite(hA.S.hp), `ctf levels: a flood of XP stops cleanly at level ${CTF.level.max}`);
    const sum = g.summary().find((s) => s.idx === A.idx);
    ok(sum && sum.level === CTF.level.max, 'ctf levels: the end-of-match table shows the level reached');
    run(g, 30);                                                       // B is back on its feet
    const hB = g.heroOf(B), tips0 = B.res.food;
    put(hB, 30, 30); put(hA, 31, 30); g.killEntity(hA, B.idx); g.step();
    ok(hB && B.res.food - tips0 >= CTF.heroBounty + CTF.level.bountyPerLevel * (CTF.level.max - 1), 'ctf levels: a high-level hero is worth a bigger bounty', `${B.res.food - tips0} Tips`);
  }

  // ---- a bot carrying an enemy flag while its own flag is gone still runs to its stand and scores
  {
    const g = new CtfGame({ players: [{ name: 'Human', commander: 'kofi', team: 1, color: 0 }, { name: 'Bot', commander: 'dolly', team: 2, color: 1, bot: 'hard' }], seed: 6, ctfCaps: 3, ctfTime: 15 });
    run(g, 1);
    const H = g.players[0], Bt = g.players[1];
    Bt.ai = new CtfBot(g, Bt, 'hard');
    const hh = g.heroOf(H), bh = g.heroOf(Bt), fH = g.flagOf(1), fBt = g.flagOf(2);
    put(hh, fBt.hx, fBt.hy); g.step(); g.step();                         // the human runs off with the bot's flag...
    put(bh, fH.hx, fH.hy); g.step(); g.step();                           // ...and the bot grabs the human's
    put(hh, 6, 6);
    ok(fBt.state === 1 && fH.state === 1 && fH.carrier === bh.id, 'ctf bots: (setup) both flags are out, the bot carries one');
    let capped = false;
    for (let i = 0; i < 90 * TICK_RATE && !capped; i++) { hh.x = 6; hh.y = 6; hh.order = null; g.step(); g.delta(); if (g.caps[2] >= 1) capped = true; }
    ok(capped, 'ctf bots: a carrier heads straight for its stand and scores, even with its own flag gone', JSON.stringify(g.caps));
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
