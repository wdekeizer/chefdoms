// Headless bot-vs-bot match runner. Useful for checking that the rules still
// work after you tweak game/data.js, and for rough balance testing.
//
//   node tools/sim-test.js                         one 4-bot match, prints a timeline
//   node tools/sim-test.js --seed 42 --minutes 40
//   node tools/sim-test.js --players flint:hard,nonna:normal --map small
//   node tools/sim-test.js --series 12             many quick matches, prints win table
import { Game } from '../game/sim.js';
import { Bot } from '../game/ai.js';
import { TacticsGame } from '../game/tactics.js';
import { TacticsBot } from '../game/tactics-ai.js';
import { COMMANDER_KEYS, TICK_RATE } from '../game/data.js';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);

function parsePlayers(spec, n = 4, level = 'normal', shuffle = 0) {
  if (spec) {
    return spec.split(',').map((s, i) => {
      const [cmd, lvl, team] = s.split(':');
      return { name: cmd + (i + 1), commander: cmd, team: team !== undefined ? +team : i, color: i, bot: lvl || level };
    });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const cmd = COMMANDER_KEYS[(i + shuffle) % COMMANDER_KEYS.length];
    out.push({ name: cmd + (i + 1), commander: cmd, team: i, color: i, bot: level });
  }
  return out;
}

/** Turn-based match between bots. `rounds` = give up after this many rounds. */
export function runTactics({ players, seed, rounds = 150, mapSize = 'auto', verbose = false, popCap = 100, startRes = 'standard' }) {
  const g = new TacticsGame({ players, mapSize, startRes, popCap, seed });
  for (const P of g.players) { P.ai = new TacticsBot(g, P, P.bot); P.ai.L = { ...P.ai.L, pace: 1 }; }
  const t0 = Date.now();
  let lastRound = 0, guard = 0;
  while (!g.over && g.turn.n <= rounds && guard++ < 4e6) {
    g.step(); g.delta();
    if (verbose && g.turn.n !== lastRound && g.turn.n % 5 === 0) {
      lastRound = g.turn.n;
      console.log(`r${String(g.turn.n).padStart(3)}  ` + g.players.map((P) => {
        if (!P.alive) return `${P.name}: out`;
        let cooks = 0, army = 0, b = 0, st = 0;
        for (const u of g.units) if (u.owner === P.idx) { if (u.isCook) cooks++; else if (!u.isHero) army++; }
        for (const x of g.bldgs) if (x.owner === P.idx) { b++; if (x.pays) st++; }
        const r = P.res, i = P.income;
        return `${P.name} A${P.age} c${cooks} a${army} b${b}/${st} [${r.food} ${r.wood} ${r.spice} ${r.salt}] +[${i.food} ${i.wood} ${i.spice} ${i.salt}] ${P.ai.state[0]}${P.heroId ? '' : 'x'}`;
      }).join(' | '));
    }
  }
  return { game: g, over: g.over, rounds: g.turn.n, wall: Date.now() - t0, ticks: g.tick };
}

export function runMatch({ players, seed, minutes = 45, mapSize = 'medium', verbose = false, popCap = 100, startRes = 'standard' }) {
  const g = new Game({ players, mapSize, startRes, popCap, seed });
  for (const P of g.players) P.ai = new Bot(g, P, P.bot);
  const maxTicks = minutes * 60 * TICK_RATE;
  let bytes = 0, snaps = 0, worst = 0, win = 0, peak = 0;
  const t0 = Date.now();
  while (g.tick < maxTicks && !g.over) {
    const s = performance.now();
    g.step();
    const d = g.delta();
    const dt = performance.now() - s;
    if (dt > worst) worst = dt;
    const len = JSON.stringify(d).length;
    bytes += len; win += len; snaps++;
    if (g.tick % TICK_RATE === 0) { if (win > peak) peak = win; win = 0; }
    if (verbose && g.tick % (60 * TICK_RATE) === 0) {
      const m = g.tick / (60 * TICK_RATE);
      const line = g.players.map((P) => {
        if (!P.alive) return `${P.name}: out`;
        let cooks = 0, army = 0;
        for (const u of g.units) if (u.owner === P.idx) { if (u.isCook) cooks++; else if (!u.isHero) army++; }
        let b = 0;
        for (const x of g.bldgs) if (x.owner === P.idx) b++;
        const r = P.res;
        return `${P.name} A${P.age} c${cooks} a${army} b${b} [${r.food | 0} ${r.wood | 0} ${r.spice | 0} ${r.salt | 0}] ${P.ai.state[0]}${P.heroId ? '' : 'x'}`;
      }).join(' | ');
      console.log(`${String(m).padStart(2)}m  ${line}`);
    }
  }
  const wall = Date.now() - t0;
  return {
    game: g, over: g.over, minutes: g.tick / (60 * TICK_RATE), wall,
    msPerTick: wall / g.tick, worstTick: worst, bytesPerSec: (bytes / g.tick) * TICK_RATE, peakBytesPerSec: peak, snaps,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('sim-test.js')) {
  const series = +arg('series', 0);
  const minutes = +arg('minutes', 45);
  const mapSize = arg('map', 'medium');
  const level = arg('level', 'normal');
  if (arg('mode') === 'turn') {
    // node tools/sim-test.js --mode turn [--series 8] [--n 2] [--level hard] [--rounds 150]
    const rounds = +arg('rounds', 150), map = arg('map', 'auto');
    if (series) {
      const wins = {}, played = {};
      let unfinished = 0, total = 0;
      for (let i = 0; i < series; i++) {
        const players = parsePlayers(arg('players'), +arg('n', 2), level, i);
        const r = runTactics({ players, seed: 1000 + i * 7919, rounds, mapSize: map });
        for (const p of players) played[p.commander] = (played[p.commander] || 0) + 1;
        if (r.over) { const w = r.game.players.find((P) => P.team === r.over.team); wins[w.commander] = (wins[w.commander] || 0) + 1; total += r.rounds; console.log(`match ${i + 1}: ${w.name} wins in round ${r.rounds}  (${r.wall} ms)`); }
        else { unfinished++; console.log(`match ${i + 1}: no winner after ${rounds} rounds`); }
      }
      console.log('\ncommander   wins / played');
      for (const k of COMMANDER_KEYS) if (played[k]) console.log(`${k.padEnd(10)}  ${wins[k] || 0} / ${played[k]}`);
      console.log(`unfinished: ${unfinished}, average length of finished matches: ${(total / Math.max(1, series - unfinished)).toFixed(0)} rounds`);
    } else {
      const players = parsePlayers(arg('players'), +arg('n', 2), level);
      const r = runTactics({ players, seed: +arg('seed', 12345), rounds, mapSize: map, verbose: !flag('quiet') });
      const g = r.game;
      console.log(r.over ? `\nWinner: team ${r.over.team} (${g.players.filter((P) => P.team === r.over.team).map((P) => P.name).join(', ')}) in round ${r.rounds}` : `\nNo winner after ${rounds} rounds`);
      console.table(g.summary().map((s) => ({ name: s.name, alive: s.alive, age: s.age, kills: s.kills, lost: s.lost, razed: s.razed, gathered: s.gathered, trained: s.trained, built: s.built, score: s.score.total })));
      console.log(`${r.ticks} ticks simulated in ${r.wall} ms`);
    }
  } else if (series) {
    const wins = {}, played = {};
    let unfinished = 0, totalMin = 0;
    for (let i = 0; i < series; i++) {
      const players = parsePlayers(arg('players'), +arg('n', 4), level, i);
      const r = runMatch({ players, seed: 1000 + i * 7919, minutes, mapSize });
      for (const p of players) played[p.commander] = (played[p.commander] || 0) + 1;
      if (r.over) {
        const w = r.game.players.find((P) => P.team === r.over.team);
        wins[w.commander] = (wins[w.commander] || 0) + 1;
        totalMin += r.minutes;
        console.log(`match ${i + 1}: ${w.name} wins at ${r.minutes.toFixed(1)}m  (${r.msPerTick.toFixed(2)} ms/tick)`);
      } else { unfinished++; console.log(`match ${i + 1}: no winner after ${minutes}m`); }
    }
    console.log('\ncommander   wins / played');
    for (const k of COMMANDER_KEYS) if (played[k]) console.log(`${k.padEnd(10)}  ${wins[k] || 0} / ${played[k]}`);
    console.log(`unfinished: ${unfinished}, average length of finished matches: ${(totalMin / Math.max(1, series - unfinished)).toFixed(1)} min`);
  } else {
    const seed = +arg('seed', 12345);
    const players = parsePlayers(arg('players'), +arg('n', 4), level);
    console.log('players:', players.map((p) => `${p.name}(${p.bot})`).join(', '), '| seed', seed, '| map', mapSize);
    const r = runMatch({ players, seed, minutes, mapSize, verbose: !flag('quiet') });
    const g = r.game;
    console.log(r.over ? `\nWinner: team ${r.over.team} (${g.players.filter((P) => P.team === r.over.team).map((P) => P.name).join(', ')}) at ${r.minutes.toFixed(1)} min` : `\nNo winner after ${r.minutes.toFixed(1)} min`);
    console.table(g.summary().map((s) => ({ name: s.name, alive: s.alive, age: s.age, kills: s.kills, lost: s.lost, razed: s.razed, bldgLost: s.bldgLost, gathered: s.gathered, trained: s.trained })));
    console.log(`sim: ${r.msPerTick.toFixed(3)} ms/tick avg, ${r.worstTick.toFixed(1)} ms worst tick; network: ~${(r.bytesPerSec / 1024).toFixed(1)} KB/s per client on average, ${(r.peakBytesPerSec / 1024).toFixed(1)} KB/s in the busiest second`);
    console.log(`pathfinding: ${g.pf.searches} searches, ${(g.pf.expanded / Math.max(1, g.pf.searches)).toFixed(0)} nodes avg`);
  }
}
