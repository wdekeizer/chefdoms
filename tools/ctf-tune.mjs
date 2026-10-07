// Tune Capture the Flag heroes automatically with tools/ctf-balance.mjs (takes an hour or so; prints the values to put in game/data.js).
// Three knobs per hero: "power" (attack and health together) steers the fight results (duels + 3v3 at three stages)
// towards 50%, speed steers the whole-match results towards 50%, and growth (what a level gives) evens out early
// against late. Runs the fights and the matches in parallel. Run it from the game's folder.
//   node tools/ctf-tune.mjs [iterations] [--n 300] [--start start.json] [--out ctftune.json]
//   The knobs are relative to what game/data.js holds now; SMIN / SMAX limit the speed change (default -0.5 / +1).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERO_KEYS, CTF } from '../game/data.js';
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ITER = Number(args.find((a) => /^\d+$/.test(a)) || 8), N = Number(argv('n', 300));
const OUT = argv('out', 'ctftune.json');
const TMP = (k) => path.join(os.tmpdir(), `ctfbal-${process.pid}-${k}.json`);
let st = argv('start') ? JSON.parse(fs.readFileSync(argv('start'), 'utf8')).best.knobs : null;
const knobs = st || Object.fromEntries(HERO_KEYS.map((h) => [h, { power: 1, speed: 0 }]));
for (const h of HERO_KEYS) { knobs[h].speed ??= 0; knobs[h].growth ??= 1; delete knobs[h].split; }
// tune on top of what data.js has now: the knobs are relative to it
const baseHp = { ...CTF.heroHp }, baseSpeed = { ...CTF.heroSpeed };
const baseDps = { ...CTF.heroDps };

function bal(k) {
  const heroDps = {}, heroHp = {}, heroSpeed = {}, heroGrowth = {};
  // power = attack x health (half each); speed is added to the hero's own
  for (const h of HERO_KEYS) { const p = k[h].power; heroDps[h] = +((baseDps[h] || 1) * Math.sqrt(p)).toFixed(3); heroHp[h] = +((baseHp[h] || 1) * Math.sqrt(p)).toFixed(3); heroSpeed[h] = +((baseSpeed[h] || 0) + k[h].speed).toFixed(2); heroGrowth[h] = +k[h].growth.toFixed(3); }
  return { heroDps, heroHp, heroSpeed, heroGrowth };
}
const runOne = (modes, out, env) => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['tools/ctf-balance.mjs', ...modes, '--n', String(N), '--json', out], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('exit', (code) => (code ? rej(new Error('exit ' + code)) : res(JSON.parse(fs.readFileSync(out, 'utf8')))));
});
async function measure(k, seed = 0) {
  const env = { BAL: JSON.stringify(bal(k)), SEED: String(seed) };
  const [a, b] = await Promise.all([runOne(['duels', 'teams'], TMP('f'), env), runOne(['matches'], TMP('m'), env)]);
  const F = {}, M = {}, E = {}, Lt = {};
  for (const h of HERO_KEYS) {
    E[h] = (a.cols['duel early'][h] + a.cols['3v3 early'][h] * 2) / 3 * 100; Lt[h] = (a.cols['duel late'][h] + a.cols['3v3 late'][h] * 2) / 3 * 100;
    const f = Object.values(a.cols).map((c) => c[h]), m = Object.values(b.cols).map((c) => c[h]);
    F[h] = f.reduce((s, v) => s + v, 0) / f.length * 100; M[h] = (m[0] * 2 + m[1]) / 3 * 100;     // 3v3 counts double (more samples)
  }
  return { F, M, E, L: Lt, cols: { ...a.cols, ...b.cols } };
}
const score = (r) => Math.sqrt(HERO_KEYS.reduce((s, h) => s + (r.F[h] - 50) ** 2 + (r.M[h] - 50) ** 2 + ((r.E[h] - r.L[h]) / 2) ** 2, 0) / (3 * HERO_KEYS.length));

let best = null;
const log = [];
for (let it = 0; it < ITER; it++) {
  const t0 = Date.now();
  const r = await measure(knobs);
  const err = score(r);
  log.push({ it, err, knobs: JSON.parse(JSON.stringify(knobs)), F: r.F, M: r.M });
  if (!best || err < best.err) best = { err, knobs: JSON.parse(JSON.stringify(knobs)), F: r.F, M: r.M, cols: r.cols };
  console.log(`iter ${it}: rms ${err.toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(0)}s)  ` + HERO_KEYS.map((h) => `${h} ${r.F[h].toFixed(0)}/${r.M[h].toFixed(0)} e${r.E[h].toFixed(0)}/l${r.L[h].toFixed(0)} p${knobs[h].power.toFixed(2)} s${knobs[h].speed >= 0 ? '+' : ''}${knobs[h].speed.toFixed(2)} g${knobs[h].growth.toFixed(2)}`).join(' | '));
  const damp = it < 3 ? 1 : 0.6;
  for (const h of HERO_KEYS) {
    const k = knobs[h];
    k.power = Math.max(0.5, Math.min(2, k.power * Math.exp(damp * 0.7 * (50 - r.F[h]) / 50)));
    k.growth = Math.max(0.8, Math.min(1.25, k.growth * Math.exp(damp * 0.6 * (r.E[h] - r.L[h]) / 50)));
    k.speed = Math.max(Number(process.env.SMIN || -0.5), Math.min(Number(process.env.SMAX || 1.0), k.speed + damp * 1.5 * (50 - r.M[h]) / 100));
  }
  fs.writeFileSync(OUT, JSON.stringify({ best, log }, null, 1));
}
console.log('best rms', best.err.toFixed(1), JSON.stringify(bal(best.knobs)));
