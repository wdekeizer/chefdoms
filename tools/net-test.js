// End-to-end check of the server: lobby flow, match start, commands, chat,
// pause, reconnect and return-to-lobby, over real WebSockets.
//   node tools/net-test.js        (needs Node 22+ for the built-in WebSocket client)
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100 + Math.floor(Math.random() * 500);
const SCORES = path.join(os.tmpdir(), `chefdoms-scores-${PORT}.json`);      // keep the test out of the real Hall of Fame
const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHEFDOMS_SCORES: SCORES, CHEFDOMS_SCORE_MIN: '0.01' } });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };

function client(name, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, msgs: [], bytes: 0, lobby: null, start: null, welcome: null, snaps: 0, ents: new Map(), players: [], chat: [], closed: false, over: null, paused: null, pings: [], scores: null, tb: null, events: [] };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, token }));
  ws.onclose = () => { c.closed = true; };
  ws.onmessage = (ev) => {
    c.bytes += ev.data.length;
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') c.welcome = m;
    else if (m.t === 'lobby') { c.lobby = m; c.start = null; }
    else if (m.t === 'start') { c.start = m; c.ents.clear(); }
    else if (m.t === 'chat') c.chat.push(m);
    else if (m.t === 'paused') c.paused = m.v;
    else if (m.t === 'over') c.over = m;
    else if (m.t === 'mp') c.pings.push(m);
    else if (m.t === 'scores') c.scores = m.list;
    else if (m.t === 's') {
      c.snaps++; c.tick = m.k;
      if (m.e) for (const r of m.e) c.ents.set(r[0], r);
      if (m.m) for (let i = 0; i < m.m.length; i += 3) { const r = c.ents.get(m.m[i]); if (r) { r[4] = m.m[i + 1]; r[5] = m.m[i + 2]; } }
      if (m.r) for (const id of m.r) c.ents.delete(id);
      if (m.p) for (const p of m.p) c.players[p[0]] = p;
      if (m.tb) c.tb = m.tb;
      if (m.ctf) c.ctf = m.ctf;
      if (m.flags) c.flags = m.flags;
      if (m.camps) c.camps = m.camps;
      if (m.ev) for (const e of m.ev) c.events.push(e);
    }
  };
  c.send = (o) => ws.send(JSON.stringify(o));
  return c;
}
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(25); } return false; };

try {
  await until(() => srvOut.includes('cooking'), 5000);
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  ok(res.status === 200, 'serves index page', `status ${res.status}`);
  ok((await fetch(`http://127.0.0.1:${PORT}/game/data.js`)).status === 200, 'serves shared data module');
  ok((await fetch(`http://127.0.0.1:${PORT}/game/sim.js`)).status === 404, 'does not expose server code');
  ok((await fetch(`http://127.0.0.1:${PORT}/..%2fserver.js`)).status !== 200, 'blocks path traversal');

  const a = client('Alice');
  await until(() => a.lobby);
  ok(a.welcome && a.lobby && a.lobby.host === a.welcome.id, 'first player becomes host');
  ok(a.lobby.slots[0] && a.lobby.slots[0].name === 'Alice', 'first player is seated');

  const b = client('Bob<script>');
  await until(() => b.lobby && a.lobby.slots[1]);
  ok(a.lobby.slots[1] && a.lobby.slots[1].name === 'Bobscript', 'second player seated, name sanitised', a.lobby.slots[1] && a.lobby.slots[1].name);

  b.send({ t: 'opt', k: 'mapSize', v: 'small' });
  b.send({ t: 'bot', level: 'hard' });
  await sleep(150);
  ok(a.lobby.opts.mapSize === 'auto' && !a.lobby.slots[2], 'non-host cannot change options or add bots');

  a.send({ t: 'opt', k: 'mapSize', v: 'small' });
  a.send({ t: 'bot', level: 'easy' });
  a.send({ t: 'set', k: 'commander', v: 'nonna' });
  a.send({ t: 'set', k: 'team', v: 1 });
  b.send({ t: 'set', k: 'team', v: 1 });
  a.send({ t: 'slot', i: 2, a: 'team', v: 2 });
  await until(() => a.lobby.slots[2] && a.lobby.slots[0].commander === 'nonna' && a.lobby.slots[1].team === 1);
  ok(a.lobby.opts.mapSize === 'small' && a.lobby.slots[2] && a.lobby.slots[2].kind === 'bot', 'host sets options and adds a bot');

  a.send({ t: 'start' });
  await sleep(200);
  ok(!a.start, 'cannot start until everyone is ready');
  b.send({ t: 'set', k: 'ready', v: true });
  await until(() => a.lobby.slots[1].ready);
  a.send({ t: 'start' });
  await until(() => a.start && b.start && a.snaps > 5 && b.snaps > 5);
  ok(a.start && a.start.you === 0 && b.start && b.start.you === 1, 'match starts, each client knows its player');
  ok(a.start.players.length === 3 && a.start.players[0].commander === 'nonna' && a.start.w === 96, 'start info has players and map');
  ok(a.ents.size > 50, 'full snapshot delivers the world', `${a.ents.size} entities`);

  const s0 = a.snaps, t0 = Date.now(), b0 = a.bytes;
  await sleep(2000);
  const rate = (a.snaps - s0) / ((Date.now() - t0) / 1000);
  ok(rate > 17 && rate < 23, 'snapshots arrive at ~20 per second', rate.toFixed(1) + '/s, ' + ((a.bytes - b0) / 2 / 1024).toFixed(1) + ' KB/s');

  // command: train a cook at my HQ
  const hq = [...a.ents.values()].find((r) => r[1] === 1 && r[2] === 'hq' && r[3] === 0);
  const food0 = a.players[0][1];
  a.send({ t: 'c', c: 'tr', bid: hq[0], u: 'cook' });
  await until(() => a.ents.get(hq[0])[9].length === 1);
  ok(a.ents.get(hq[0])[9][0] === 'ucook' && a.players[0][1] < food0, 'train command queues a unit and spends resources');
  // command for a unit I do not own must be ignored
  const theirs = [...a.ents.values()].find((r) => r[1] === 0 && r[3] === 1);
  const before = theirs.slice(4, 6).join();
  a.send({ t: 'c', c: 'mv', ids: [theirs[0]], x: 5, y: 5 });
  await sleep(500);
  ok(a.ents.get(theirs[0]).slice(4, 6).join() === before, "cannot command another player's units");
  // garbage must not hurt
  a.ws.send('not json'); a.send({ t: 'c', c: 'mv', ids: 'x', x: 'NaN' }); a.send({ t: 'c', c: 'bp', b: '__proto__', tx: 1e9, ty: -5, ids: [1, 2] }); a.send({ t: 'c' }); a.send([]);
  await sleep(200);
  ok(!a.closed && a.snaps > 0, 'malformed messages are ignored');

  a.send({ t: 'chat', m: 'hello team', team: 1 });
  await until(() => b.chat.some((m) => m.m === 'hello team'));
  ok(b.chat.some((m) => m.m === 'hello team' && m.team === 1), 'team chat reaches allies');

  a.send({ t: 'mp', x: 10.5, y: 12 });
  await until(() => b.pings.length > 0);
  ok(b.pings.length === 1 && b.pings[0].p === 0 && b.pings[0].x === 10.5 && a.pings.length === 1, 'a map ping reaches the sender and their allies');
  a.send({ t: 'mp', x: 'x' }); a.send({ t: 'mp', x: 1, y: 1 });
  await sleep(200);
  ok(b.pings.length === 1, 'bad or rapid-fire pings are dropped');

  a.send({ t: 'c', c: 'bell', on: 1 });
  await until(() => a.players[0][18] === 1 && a.ents.get(hq[0])[11] >= 4, 8000);
  ok(a.players[0][18] === 1 && a.ents.get(hq[0])[11] >= 4, 'the bell shelters the Prep Cooks inside the Kitchen HQ', `inside: ${a.ents.get(hq[0])[11]}`);
  a.send({ t: 'c', c: 'bell', on: 0 });
  await until(() => a.players[0][18] === 0 && a.ents.get(hq[0])[11] === 0);
  ok(a.ents.get(hq[0])[11] === 0, 'and the all-clear lets them out');

  b.send({ t: 'pause' });
  await sleep(200);
  ok(a.paused === null, 'non-host cannot pause');
  a.send({ t: 'pause' });
  await until(() => a.paused === true);
  const sp = a.snaps; await sleep(400);
  ok(a.paused === true && a.snaps === sp, 'host can pause (no snapshots while paused)');
  a.send({ t: 'pause' });
  await until(() => a.snaps > sp);
  ok(a.paused === false, 'and resume');

  // reconnect
  const token = b.welcome.token;
  b.ws.close();
  await until(() => a.chat.some((m) => m.sys && /disconnected/.test(m.m)));
  ok(true, 'others are told when a player drops');
  const b2 = client('Bob', token);
  await until(() => b2.start && b2.snaps > 2);
  ok(b2.start && b2.start.you === 1 && b2.ents.size > 50, 'player can rejoin their seat with the same token');

  const spec = client('Watcher');
  await until(() => spec.start);
  ok(spec.start && spec.start.you === -1, 'late joiner becomes a spectator');

  a.send({ t: 'end' });
  await until(() => a.lobby && !a.start && b2.lobby && !b2.start);
  ok(a.lobby && a.lobby.slots[0] && a.lobby.slots[1] && a.lobby.slots[2].kind === 'bot', 'host returns everyone to the lobby with seats kept');

  // a second match, played to the end: scores, timeline and the Hall of Fame
  b2.send({ t: 'set', k: 'ready', v: true });
  await until(() => a.lobby.slots[1] && a.lobby.slots[1].ready);
  a.send({ t: 'start' });
  await until(() => a.start && b2.start && a.snaps > 0);
  await sleep(1500);
  a.send({ t: 'c', c: 'rg' }); b2.send({ t: 'c', c: 'rg' });
  await until(() => a.over && spec.over, 6000);
  const o = a.over;
  ok(o && o.summary.length === 3 && o.summary.every((s) => s.score && Number.isFinite(s.score.total)) && o.summary[2].team === o.team, 'the match ends with a score for every player');
  ok(o && o.timeline && o.timeline.t.length >= 1 && o.timeline.series.score.length === 3 && o.timeline.series.pop[0].length === o.timeline.t.length, 'and a timeline for the graphs');
  ok(o && o.hof.length === 2 && o.fresh.length === 2 && o.hof.every((e) => ['Alice', 'Bob'].includes(e.name) && !e.won && e.bots === 1), 'human players enter the Hall of Fame (bots do not)', JSON.stringify(o && o.hof.map((e) => e.name)));
  spec.send({ t: 'scores' });
  await until(() => spec.scores);
  ok(spec.scores && spec.scores.length === 2 && JSON.parse(fs.readFileSync(SCORES, 'utf8')).length === 2, 'the Hall of Fame is saved and served on request');

  // a third match, turn-based: one kitchen at a time
  a.send({ t: 'end' });
  await until(() => a.lobby && !a.start && b2.lobby && !b2.start);
  a.send({ t: 'opt', k: 'mode', v: 'turn' });
  a.send({ t: 'opt', k: 'turnLimit', v: '30' });
  b2.send({ t: 'set', k: 'ready', v: true });
  await until(() => a.lobby.opts.mode === 'turn' && a.lobby.slots[1] && a.lobby.slots[1].ready);
  for (const c of [a, b2, spec]) { c.over = null; c.tb = null; c.events = []; }
  a.send({ t: 'start' });
  await until(() => a.start && b2.start && a.tb && b2.tb && a.snaps > 0);
  ok(a.start.mode === 'turn' && a.start.w === 26 && a.start.opts.turnLimit === 30 && a.tb[0] === 1 && a.tb[1] === 0, 'a turn-based match starts on the small grid with player 1 to move', JSON.stringify(a.tb));
  const unitsOf = (c, pi) => [...c.ents.values()].filter((r) => r[1] === 0 && r[3] === pi);
  const bLine = unitsOf(b2, 1).find((r) => r[2] === 'line'), aLine = unitsOf(a, 0).find((r) => r[2] === 'line');
  ok(aLine && (aLine[11] >> 8) >= 2 && (aLine[11] & 255) === 0, 'units report the movement they have left', aLine && String(aLine[11]));
  b2.send({ t: 'c', c: 'twt', id: bLine[0] });
  a.send({ t: 'c', c: 'twt', id: aLine[0] });
  await until(() => (a.ents.get(aLine[0])[11] & 2) === 2);
  ok((a.ents.get(aLine[0])[11] & 2) === 2 && (b2.ents.get(bLine[0])[11] & 2) === 0, 'orders count on your own turn only');
  const foodT = a.players[0][1];
  b2.send({ t: 'c', c: 'et' });
  await sleep(200);
  ok(a.tb[1] === 0, 'another player cannot end your turn');
  a.send({ t: 'c', c: 'et' });
  await until(() => b2.tb[1] === 1);
  b2.send({ t: 'c', c: 'et' });
  await until(() => a.tb[0] === 2 && a.tb[1] === 0, 15000);
  ok(a.tb[0] === 2 && a.tb[1] === 0 && a.players[0][1] > foodT && Array.isArray(a.players[0][21]) && a.events.some((e) => e[0] === 'turn' && e[2] === 2), 'the turn goes round the table (the bot plays its own) and income arrives', JSON.stringify([a.tb, a.players[0][21]]));
  a.send({ t: 'c', c: 'rg' }); b2.send({ t: 'c', c: 'rg' });
  await until(() => a.over && spec.over, 6000);
  ok(a.over && a.over.rounds >= 2 && a.over.timeline.unit === 'turn' && a.over.summary.length === 3, 'a turn-based match ends with rounds and a per-round timeline', a.over && `rounds ${a.over.rounds}`);

  // a fourth match, capture the flag: heroes, Tips and the wild kitchen
  a.send({ t: 'end' });
  await until(() => a.lobby && !a.start && b2.lobby && !b2.start);
  a.send({ t: 'opt', k: 'mode', v: 'ctf' });
  a.send({ t: 'opt', k: 'ctfCaps', v: '3' });
  a.send({ t: 'opt', k: 'ctfTime', v: '10' });
  a.send({ t: 'set', k: 'commander', v: 'kofi' });
  b2.send({ t: 'set', k: 'commander', v: 'rafa' });
  b2.send({ t: 'set', k: 'ready', v: true });
  await until(() => a.lobby.opts.mode === 'ctf' && a.lobby.slots[0].commander === 'kofi' && a.lobby.slots[1] && a.lobby.slots[1].ready && a.lobby.slots[1].commander === 'rafa');
  ok(a.lobby.slots[0].commander === 'kofi' && a.lobby.slots[1].commander === 'rafa', 'arena-only heroes can be picked in capture the flag');
  for (const c of [a, b2, spec]) { c.over = null; c.tb = null; c.ctf = null; c.flags = null; c.camps = null; c.events = []; }
  a.send({ t: 'start' });
  await until(() => a.start && b2.start && spec.start && a.snaps > 0 && a.flags && a.ctf);
  const nTeams = new Set(a.start.players.filter((p) => p.team >= 0).map((p) => p.team)).size;
  ok(a.start.mode === 'ctf' && a.start.ctf && a.start.ctf.capsToWin === 3 && a.start.ctf.bases.length === nTeams && a.start.ctf.flags.length === nTeams && a.start.ctf.camps.length > 6 && a.start.players.length === 4 && a.start.players[3].team === -1, 'a capture-the-flag match starts with a base per team and the wild kitchen last', JSON.stringify({ teams: nTeams, bases: a.start.ctf && a.start.ctf.bases.length, players: a.start.players.length }));
  ok(a.flags.length === nTeams && a.flags.every((f) => f[1] === 0) && a.camps.length === a.start.ctf.camps.length && a.ctf.caps && a.ctf.sudden === 0, 'snapshots carry the flags, camps and score', JSON.stringify(a.ctf));
  const unitsOfC = (c, pi) => [...c.ents.values()].filter((r) => r[1] === 0 && r[3] === pi);
  await until(() => unitsOfC(spec, 3).length > 8);
  ok(unitsOfC(spec, 0).length === 1 && unitsOfC(spec, 0)[0][2] === 'hero_kofi' && unitsOfC(spec, 1)[0][2] === 'hero_rafa' && unitsOfC(spec, 3).length > 8, 'each kitchen has one hero and the wild kitchen has its minions', JSON.stringify([unitsOfC(spec, 0).map((r) => r[2]), unitsOfC(spec, 1).map((r) => r[2]), unitsOfC(spec, 3).length]));
  ok(a.players[0][1] >= 120 && Array.isArray(a.players[0][21]) && a.players[0][21].length === 6 && a.players[0][22] === 0, 'the player record carries Tips, items and captures', JSON.stringify(a.players[0].slice(21)));
  const tips0 = a.players[0][1];
  a.send({ t: 'c', c: 'buy', item: 'herbs' });
  await until(() => a.players[0][21][5] === 1);
  ok(a.players[0][21][5] === 1 && a.players[0][1] <= tips0 - 110 + 3 && a.events.some((e) => e[0] === 'item' && e[1] === 0 && e[2] === 'herbs'), 'buying an item at the kitchen is reflected in the next snapshot', JSON.stringify([a.players[0][21], a.players[0][1]]));
  a.send({ t: 'c', c: 'buy', item: 'skillet' });
  await until(() => a.events.some((e) => e[0] === 'note' && e[1] === 0 && e[2] === 'tips'));
  ok(a.events.some((e) => e[0] === 'note' && e[1] === 0 && e[2] === 'tips'), 'and a purchase you cannot afford is refused with a note');
  a.send({ t: 'c', c: 'bp', ids: [unitsOfC(a, 0)[0][0]], b: 'house', tx: 5, ty: 5 }); a.send({ t: 'c', c: 'tr', u: 'cook' });
  await sleep(300);
  ok([...spec.ents.values()].filter((r) => r[1] === 1).length === nTeams && unitsOfC(spec, 0).length === 1, 'building and training orders are ignored in the arena', JSON.stringify([...spec.ents.values()].filter((r) => r[1] === 1).map((r) => r[2])));
  a.send({ t: 'c', c: 'rg' }); b2.send({ t: 'c', c: 'rg' });
  await until(() => a.over && spec.over, 6000);
  ok(a.over && a.over.summary.length === 3 && a.over.summary.every((s) => s.ctf && typeof s.caps === 'number') && a.over.timeline.labels && a.over.timeline.labels.army === 'Captures', 'a capture-the-flag match ends with an arena summary (the wild kitchen left out)', a.over && JSON.stringify(a.over.summary.map((s) => s.name)));
  for (const c of [a, b2, spec]) c.ws.close();
  await sleep(200);
  try { fs.unlinkSync(SCORES); } catch { /* nothing written */ }
} catch (e) { console.error(e); failed++; }
srv.kill();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed) console.log('--- server output ---\n' + srvOut);
process.exit(failed ? 1 : 0);
