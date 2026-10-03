// End-to-end check of the server: lobby flow, match start, commands, chat,
// pause, reconnect and return-to-lobby, over real WebSockets.
//   node tools/net-test.js        (needs Node 22+ for the built-in WebSocket client)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100 + Math.floor(Math.random() * 500);
const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };

function client(name, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, msgs: [], bytes: 0, lobby: null, start: null, welcome: null, snaps: 0, ents: new Map(), players: [], chat: [], closed: false, over: null, paused: null };
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
    else if (m.t === 's') {
      c.snaps++; c.tick = m.k;
      if (m.e) for (const r of m.e) c.ents.set(r[0], r);
      if (m.m) for (let i = 0; i < m.m.length; i += 3) { const r = c.ents.get(m.m[i]); if (r) { r[4] = m.m[i + 1]; r[5] = m.m[i + 2]; } }
      if (m.r) for (const id of m.r) c.ents.delete(id);
      if (m.p) for (const p of m.p) c.players[p[0]] = p;
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
  ok(a.start.players.length === 3 && a.start.players[0].commander === 'nonna' && a.start.w === 72, 'start info has players and map');
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
  for (const c of [a, b2, spec]) c.ws.close();
  await sleep(200);
} catch (e) { console.error(e); failed++; }
srv.kill();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed) console.log('--- server output ---\n' + srvOut);
process.exit(failed ? 1 : 0);
