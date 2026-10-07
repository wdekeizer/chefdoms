// Measure Capture the Flag hero balance three ways and print one table (every hero's win rate, 50 = even).
//   node tools/ctf-balance.mjs [duels] [teams] [matches] [--n 300] [--json out.json]      (a few minutes)
//   BAL='{"heroDps":{"kofi":1.0},"heroSpeed":{"hank":0.5},"kit":{"kofi":{"ability":{"dmg":40}}}}' node tools/ctf-balance.mjs
//   (BAL tries changes without editing game/data.js; SEED=n draws different line-ups and maps)
// duels   : 1v1 at three stages of a match (early / mid / late: hero level and items bought as bots do by then),
//           both sides of the arena, with and without ranged heroes stepping back between shots
// teams   : 3v3 skirmishes with random line-ups at the same stages
// matches : whole 3v3 and 2v2 matches between Hard bots with random line-ups
import { CtfGame, ITEM_KEYS } from '../game/ctf.js';
import { CtfBot } from '../game/ctf-ai.js';
import * as D from '../game/data.js';
import { ST } from '../game/sim.js';
const { HERO_KEYS, TICK_RATE, COMMANDERS, UNITS, CTF } = D;

// ---- tuning overrides for quick experiments (applied to the live data objects)
if (process.env.BAL) {
  const o = JSON.parse(process.env.BAL);
  if (o.heroDps) Object.assign(CTF.heroDps, o.heroDps);
  if (o.ctf) for (const k in o.ctf) CTF[k] = typeof o.ctf[k] === 'object' && !Array.isArray(o.ctf[k]) ? { ...CTF[k], ...o.ctf[k] } : o.ctf[k];
  if (o.units) for (const u in o.units) Object.assign(UNITS[u], o.units[u]);
  if (o.kit) for (const c in o.kit) for (const slot in o.kit[c]) { const C = COMMANDERS[c], key = (slot === 'ability' && C.ctfAbility) ? 'ctfAbility' : (slot === 'ultimate' && C.ctfUltimate) ? 'ctfUltimate' : slot; C[key] = { ...C[key], ...o.kit[c][slot] }; }
  if (o.aura) for (const c in o.aura) Object.assign(D.BUFFS[COMMANDERS[c].aura.key], o.aura[c]);
  if (o.heroHp) Object.assign(CTF.heroHp, o.heroHp);
  if (o.heroSpeed) Object.assign(CTF.heroSpeed, o.heroSpeed);
  if (o.heroGrowth) Object.assign(CTF.heroGrowth, o.heroGrowth);
}

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const modes = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !a.endsWith('.json'));
const run = modes.length ? modes : ['duels', 'teams', 'matches'];
const N = Number(argv('n', 300));
const H = HERO_KEYS;
export const STAGES = [
  { name: 'early', minute: 1.5, level: 2, tips: 350 },
  { name: 'mid', minute: 5, level: 5, tips: 1300 },
  { name: 'late', minute: 9, level: 8, tips: 2600 },
];
let seedN = 1 + Number(process.env.SEED || 0) * 10007;
const rnd = (() => { let a = 12345 + Number(process.env.SEED || 0) * 7919; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** A quiet arena: no wild minions, heroes at the given stage (level, the items bots would have bought with `tips`). */
function arena(teams, stage) {
  const players = []; teams.forEach((list, t) => list.forEach((c) => players.push({ name: c + t, commander: c, team: t + 1, color: players.length })));
  const g = new CtfGame({ players, seed: 4, ctfCaps: 9, ctfTime: 30, fog: 'off' });
  g.step();
  for (const k of g.camps) { k.nextAt = 1e9; for (const id of k.units) { const u = g.ents.get(id); if (u) g.killEntity(u, -1); } }
  g.step();
  g.tick = Math.round(stage.minute * 60 * TICK_RATE);
  const bots = [];
  for (const P of g.players) {
    if (P.neutral) continue;
    g.setLevel(P, stage.level);
    const bot = new CtfBot(g, P, 'hard'); bot.L = { ...bot.L, ability: 1 }; bots.push(bot);
    P.res.food = stage.tips;
    const h = g.heroOf(P);
    for (let i = 0; i < 12; i++) bot.shop(h);
    P.abilityReady = 0; P.ultReady = 0;
  }
  // an open spot far from every kitchen
  let spot = null, bestD = -1;
  for (let y = 8; y < g.h - 8; y += 2) for (let x = 8; x < g.w - 8; x += 2) {
    let ok = true; for (let dy = -4; dy <= 4 && ok; dy++) for (let dx = -5; dx <= 5 && ok; dx++) if (g.pf.isBlocked(x + dx, y + dy)) ok = false;
    if (!ok) continue;
    let d = Infinity; for (const s of g._map.bases) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
    if (d > bestD) { bestD = d; spot = [x, y]; }
  }
  return { g, bots, spot };
}

/** One controller step for a hero: abilities as the bots use them, attack the nearest enemy hero, ranged heroes may kite. */
function control(g, bot, kite) {
  const P = bot.P, h = g.heroOf(P);
  if (!h) return;
  const foes = g.players.filter((Q) => !Q.neutral && Q.team !== P.team).map((Q) => g.heroOf(Q)).filter(Boolean);
  if (!foes.length) return;
  const c = bot.survey(h);
  bot.abilities(h, c);
  let tg = foes.reduce((m, f) => (Math.hypot(f.x - h.x, f.y - h.y) < Math.hypot(m.x - h.x, m.y - h.y) ? f : m));
  const inReach = foes.filter((f) => Math.hypot(f.x - h.x, f.y - h.y) <= (h.S.range || 1.2) + 0.5);
  if (inReach.length > 1) tg = inReach.reduce((m, f) => (f.hp < m.hp ? f : m));            // focus the weakest in reach
  const d = Math.hypot(tg.x - h.x, tg.y - h.y);
  if (kite && h.S.range > 0 && !tg.S.range && d < h.S.range * 0.6 && h.cd > 2) {
    if (!h.order || h.order.t !== 'move' || g.tick % 6 === 0) { const k = 2.5 / Math.max(0.1, d); g.command(P.idx, { c: 'mv', ids: [h.id], x: Math.max(2, Math.min(g.w - 2, h.x + (h.x - tg.x) * k)), y: Math.max(2, Math.min(g.h - 2, h.y + (h.y - tg.y) * k)) }); }
  } else if (!h.order || h.order.t !== 'attack' || h.order.id !== tg.id) g.command(P.idx, { c: 'at', ids: [h.id], tid: tg.id });
}

/** Fight it out; returns 1 if team 1 wins, 0 if team 2 wins, 0.5 on a timeout. */
function fight(teams, stage, kite, swap) {
  const { g, bots, spot } = arena(teams, stage);
  const put = (u, x, y) => { u.x = x; u.y = y; u.order = null; u.path = null; u.st = ST.IDLE; u.hp = u.S.hp; };
  for (const b of bots) {
    const h = g.heroOf(b.P), t = b.P.team === 1 ? -1 : 1, i = teams[b.P.team - 1].indexOf(b.P.commander);
    put(h, spot[0] + (swap ? -t : t) * 3.5, spot[1] + (i - (teams[0].length - 1) / 2) * 1.4);
  }
  const t0 = g.tick;
  while (g.tick - t0 < 75 * TICK_RATE) {
    const alive = [1, 2].map((t) => bots.some((b) => b.P.team === t && g.heroOf(b.P)));
    if (!alive[0] || !alive[1]) return alive[0] ? 1 : alive[1] ? 0 : 0.5;
    for (const b of bots) control(g, b, kite);
    for (let k = 0; k < 2; k++) { g.step(); g.delta(); }
    for (const P of g.players) P.heroRespawn = g.tick + 1e9;                                // nobody comes back mid-fight
  }
  // timeout: the side with more health left
  const hpOf = (t) => bots.filter((b) => b.P.team === t).reduce((s, b) => { const h = g.heroOf(b.P); return s + (h ? h.hp / h.S.hp : 0); }, 0);
  return hpOf(1) > hpOf(2) ? 1 : hpOf(2) > hpOf(1) ? 0 : 0.5;
}

export function duels(stage) {
  const w = Object.fromEntries(H.map((h) => [h, [0, 0]])), m = {};
  for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
    let a = 0, n = 0;
    for (const kite of [false, true]) for (const swap of [false, true]) { a += fight([[H[i]], [H[j]]], stage, kite, swap); n++; }
    w[H[i]][0] += a; w[H[i]][1] += n; w[H[j]][0] += n - a; w[H[j]][1] += n;
    (m[H[i]] ||= {})[H[j]] = a / n; (m[H[j]] ||= {})[H[i]] = 1 - a / n;
  }
  return { rate: Object.fromEntries(H.map((h) => [h, w[h][0] / w[h][1]])), matrix: m };
}

export function teams(stage, n) {
  const w = Object.fromEntries(H.map((h) => [h, [0, 0]]));
  for (let k = 0; k < n; k++) {
    const pick = shuffle(H).slice(0, 6), A = pick.slice(0, 3), B = pick.slice(3);
    const r = fight([A, B], stage, rnd() < 0.5, rnd() < 0.5);
    for (const h of A) { w[h][0] += r; w[h][1]++; }
    for (const h of B) { w[h][0] += 1 - r; w[h][1]++; }
  }
  return Object.fromEntries(H.map((h) => [h, w[h][1] ? w[h][0] / w[h][1] : NaN]));
}

export function matches(n, size) {
  const w = Object.fromEntries(H.map((h) => [h, [0, 0]]));
  let mins = 0;
  for (let k = 0; k < n; k++) {
    const pick = shuffle(H).slice(0, size * 2);
    const players = pick.map((c, i) => ({ name: 'P' + i, commander: c, team: (i % 2) + 1, color: i, bot: 'hard' }));
    const g = new CtfGame({ players, seed: 1000 + seedN++ * 7, ctfCaps: 3, ctfTime: 15 });
    for (const P of g.players) if (!P.neutral) P.ai = new CtfBot(g, P, 'hard');
    while (!g.over && g.tick < 21 * 60 * TICK_RATE) { g.step(); g.delta(); }
    mins += g.tick / TICK_RATE / 60;
    const win = g.over ? g.over.team : -1;
    for (const P of g.players) { if (P.neutral) continue; const r = win < 0 ? 0.5 : P.team === win ? 1 : 0; w[P.commander][0] += r; w[P.commander][1]++; }
  }
  return { rate: Object.fromEntries(H.map((h) => [h, w[h][1] ? w[h][0] / w[h][1] : NaN])), avgMin: mins / n };
}

// ------------------------------------------------------------------------ main
if (process.argv[1] && process.argv[1].endsWith('ctf-balance.mjs')) {
  const cols = {}, t0 = Date.now();
  if (run.includes('duels')) for (const s of STAGES) cols['duel ' + s.name] = duels(s).rate;
  if (run.includes('teams')) for (const s of STAGES) cols['3v3 ' + s.name] = teams(s, N);
  let avgMin = 0;
  if (run.includes('matches')) { const a = matches(N, 3), b = matches(Math.round(N / 2), 2); avgMin = (a.avgMin + b.avgMin) / 2; cols['match 3v3'] = a.rate; cols['match 2v2'] = b.rate; }
  const names = Object.keys(cols);
  const rows = H.map((h) => { const r = { hero: h }; let s = 0; for (const c of names) { r[c] = Math.round(cols[c][h] * 100); s += cols[c][h]; } r.avg = Math.round(s / names.length * 100); return r; }).sort((a, b) => b.avg - a.avg);
  console.table(Object.fromEntries(rows.map((r) => [r.hero, Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'hero'))])));
  const avgs = rows.map((r) => r.avg);
  const spread = Math.max(...avgs) - Math.min(...avgs), sd = Math.sqrt(avgs.reduce((s, v) => s + (v - 50) ** 2, 0) / avgs.length);
  console.log(`spread ${spread} points, std dev ${sd.toFixed(1)}${avgMin ? `, matches last ${avgMin.toFixed(1)} min` : ''}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const out = argv('json'); if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify({ cols, rows, spread, sd, avgMin }, null, 1));
}
