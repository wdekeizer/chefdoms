#!/usr/bin/env node
// ============================================================================
//  CHEFDOMS server — serves the game page, runs the lobby and the match, and
//  streams the match to every browser over WebSockets.
//
//    node server.js                 host on port 3000
//    node server.js --port 8080     pick another port
//    node server.js --public        also open a free public link (needs cloudflared)
//    node server.js --open          open the game in your browser once it is up
//
//  No dependencies: plain Node.js 18+ on Windows, Linux or macOS.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './lib/wsserver.js';
import { Game } from './game/sim.js';
import { Bot } from './game/ai.js';
import { TacticsGame } from './game/tactics.js';
import { TacticsBot } from './game/tactics-ai.js';
import { CtfGame } from './game/ctf.js';
import { CtfBot } from './game/ctf-ai.js';
import { VERSION, TICK_RATE, MAX_PLAYERS, COMMANDER_KEYS, HERO_KEYS, OPTIONS, PLAYER_COLORS, BOT_LEVELS } from './game/data.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// ----------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const argVal = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const PORT = Number(argVal('port', process.env.PORT || 3000));
const HOST = argVal('host', '0.0.0.0');
const WANT_PUBLIC = argv.includes('--public');
const WANT_OPEN = argv.includes('--open');
const WARP = Number(argVal('warp', 0));          // testing aid: pre-simulate this many seconds before a match begins
const TAKEOVER_MS = Number(process.env.CHEFDOMS_TAKEOVER_MS) || 45000;   // how long a dropped player's kitchen waits before a bot minds it
const SCORES_FILE = process.env.CHEFDOMS_SCORES || path.join(ROOT, 'highscores.json');   // the Hall of Fame lives next to server.js
const SCORE_MIN_MINUTES = Number(process.env.CHEFDOMS_SCORE_MIN) || 3;                    // shorter matches don't count
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Chefdoms server\n  node server.js [--port 3000] [--host 0.0.0.0] [--public] [--open]\n  --public   start a free Cloudflare quick tunnel so friends anywhere can join (needs cloudflared)\n  --open     open the game in your default browser');
  process.exit(0);
}

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// --------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
};
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.flac']);

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const head = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };
    // byte ranges, so browsers can stream and seek your own music files
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m && (m[1] || m[2]) && st.size > 0) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
      code = 206; head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    head['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(code, head);
    if (req.method === 'HEAD' || !st.size) { res.end(); return; }
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

/** Your own audio: public/music/*.mp3 etc. and public/sfx/<sound name>.wav etc. See the README files in those folders. */
function listAudio() {
  const out = { music: { lobby: [], game: [], battle: [] }, sfx: {} };
  const files = (dir) => { try { return fs.readdirSync(path.join(PUBLIC, dir)).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase())).sort(); } catch { return []; } };
  for (const f of files('music')) {
    const kind = /^lobby/i.test(f) ? 'lobby' : /^battle/i.test(f) ? 'battle' : 'game';
    out.music[kind].push('/music/' + encodeURIComponent(f));
  }
  for (const f of files('sfx')) out.sfx[path.basename(f, path.extname(f)).toLowerCase()] = '/sfx/' + encodeURIComponent(f);
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  if (p === '/game/data.js') { serveFile(req, res, path.join(ROOT, 'game', 'data.js')); return; }   // shared rules, also used by the client
  if (p === '/api/audio') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(listAudio())); return; }
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.normalize(path.join(PUBLIC, p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  serveFile(req, res, file);
});

// ------------------------------------------------------------------- state
/** @type {Map<number, any>} */
const clients = new Map();
let nextClientId = 1;

const lobby = {
  slots: new Array(MAX_PLAYERS).fill(null),
  opts: Object.fromEntries(Object.entries(OPTIONS).map(([k, o]) => [k, o.def])),
  hostId: 0,
};
let match = null;       // { g, timer, paused, speed, tokens[], over, emptySince, takeover: Map }
const urls = { local: `http://localhost:${PORT}`, lan: [], public: null };

const send = (c, obj) => c.conn.send(JSON.stringify(obj));
const joined = () => [...clients.values()].filter((c) => c.joined);

// ------------------------------------------------------------ hall of fame
// Best scores by human players in real matches (2+ kitchens), kept in highscores.json.
let hallOfFame = [];
try {
  const j = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  if (Array.isArray(j)) hallOfFame = j.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score)).slice(0, 50);
} catch { /* no scores yet */ }

/** Add this match's human players to the Hall of Fame. Returns the entries that made the list. */
function recordScores(m, summary, team) {
  const minutes = m.g.tick / TICK_RATE / 60;
  if (summary.length < 2 || minutes < SCORE_MIN_MINUTES) return [];
  const bots = summary.filter((s) => s.bot);
  const order = Object.keys(BOT_LEVELS);
  const hardest = bots.reduce((best, s) => (order.indexOf(s.bot) > order.indexOf(best) ? s.bot : best), '');
  const fresh = [];
  summary.forEach((s, i) => {
    if (!m.tokens[i]) return;
    const e = {
      name: s.name, commander: s.commander, score: s.score.total, won: s.team === team, minutes: Math.round(minutes * 10) / 10,
      players: summary.length, bots: bots.length, hardest, map: m.g.mapSize, mode: m.g.mode || 'rt', date: new Date().toISOString().slice(0, 10), id: randomBytes(6).toString('hex'),
    };
    hallOfFame.push(e); fresh.push(e);
  });
  hallOfFame.sort((a, b) => b.score - a.score);
  hallOfFame = hallOfFame.slice(0, 50);
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(hallOfFame, null, 1)); } catch (e) { log('could not save highscores.json:', e.message); }
  return fresh.filter((e) => hallOfFame.includes(e));
}

function cleanName(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return s || 'Chef';
}
function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// ------------------------------------------------------------------- lobby
function freeColor() {
  const used = new Set(lobby.slots.filter(Boolean).map((s) => s.color));
  for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
  return 0;
}
function slotIndexOf(c) { return lobby.slots.findIndex((s) => s && s.kind === 'human' && s.cid === c.id); }
function seat(c, i) {
  if (i === undefined) i = lobby.slots.findIndex((s) => !s);
  if (i < 0 || i >= MAX_PLAYERS || lobby.slots[i]) return false;
  const old = slotIndexOf(c);
  const prev = old >= 0 ? lobby.slots[old] : null;
  if (old >= 0) lobby.slots[old] = null;
  lobby.slots[i] = {
    kind: 'human', cid: c.id, token: c.token, name: c.name,
    commander: prev ? prev.commander : 'random', team: i + 1, color: prev ? prev.color : freeColor(), ready: false,
  };
  return true;
}
function pickHost() {
  const cur = clients.get(lobby.hostId);
  if (cur && cur.joined) return;
  const list = joined();
  const next = list.find((c) => c.local) || list[0];
  lobby.hostId = next ? next.id : 0;
}
function lobbyState() {
  return {
    t: 'lobby', version: VERSION, host: lobby.hostId, opts: lobby.opts, inGame: !!match,
    slots: lobby.slots.map((s) => s && {
      kind: s.kind, name: s.name, commander: s.commander, team: s.team, color: s.color,
      ready: s.kind === 'bot' ? true : s.ready, level: s.level || null, cid: s.cid || 0,
    }),
    spectators: joined().filter((c) => slotIndexOf(c) < 0).map((c) => ({ cid: c.id, name: c.name })),
    urls,
  };
}
function broadcastLobby() {
  if (match) return;
  const st = lobbyState();
  for (const c of joined()) send(c, { ...st, you: c.id });
}
function notice(text, only) {
  const msg = { t: 'chat', sys: 1, m: text };
  if (only) send(only, msg); else for (const c of joined()) send(c, msg);
}

const BOT_NAMES = ['Sous-Bot', 'Robo-Cook', 'Crouton', 'Al Dente', 'Sir Loin', 'Pan-droid', 'Saucebot', 'Dumpling'];

function lobbyAction(c, m) {
  const isHost = c.id === lobby.hostId;
  const myIdx = slotIndexOf(c);
  const mine = myIdx >= 0 ? lobby.slots[myIdx] : null;
  switch (m.t) {
    case 'set': {                                   // change my own seat
      if (!mine) return;
      if (m.k === 'commander' && (m.v === 'random' || HERO_KEYS.includes(m.v))) mine.commander = m.v;
      else if (m.k === 'team' && Number.isInteger(m.v) && m.v >= 1 && m.v <= MAX_PLAYERS) mine.team = m.v;
      else if (m.k === 'color' && Number.isInteger(m.v) && m.v >= 0 && m.v < PLAYER_COLORS.length) {
        if (!lobby.slots.some((s) => s && s !== mine && s.color === m.v)) mine.color = m.v;
      } else if (m.k === 'ready') mine.ready = !!m.v;
      break;
    }
    case 'sit': seat(c, m.i | 0); break;
    case 'spectate': if (myIdx >= 0) lobby.slots[myIdx] = null; break;
    case 'opt': {
      if (!isHost) return;
      const O = OPTIONS[m.k];
      if (O && Object.prototype.hasOwnProperty.call(O.choices, String(m.v))) lobby.opts[m.k] = String(m.v);
      break;
    }
    case 'bot': {                                   // host adds a bot to a free seat
      if (!isHost) return;
      const i = Number.isInteger(m.i) && !lobby.slots[m.i] ? m.i : lobby.slots.findIndex((s) => !s);
      if (i < 0 || i >= MAX_PLAYERS) return;
      const level = BOT_LEVELS[m.level] ? m.level : 'normal';
      const taken = new Set(lobby.slots.filter(Boolean).map((s) => s.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) || 'Bot';
      lobby.slots[i] = { kind: 'bot', name, level, commander: 'random', team: i + 1, color: freeColor(), ready: true };
      break;
    }
    case 'slot': {                                  // host edits any seat
      if (!isHost) return;
      const i = m.i | 0;
      const s = lobby.slots[i];
      if (!s) return;
      if (m.a === 'remove') {
        if (s.kind === 'human' && s.cid === c.id) return;
        lobby.slots[i] = null;
      } else if (m.a === 'commander' && (m.v === 'random' || HERO_KEYS.includes(m.v))) s.commander = m.v;
      else if (m.a === 'team' && Number.isInteger(m.v) && m.v >= 1 && m.v <= MAX_PLAYERS) s.team = m.v;
      else if (m.a === 'level' && s.kind === 'bot' && BOT_LEVELS[m.v]) s.level = m.v;
      else if (m.a === 'color' && Number.isInteger(m.v) && m.v >= 0 && m.v < PLAYER_COLORS.length) {
        if (!lobby.slots.some((x) => x && x !== s && x.color === m.v)) s.color = m.v;
      }
      break;
    }
    case 'start': {
      if (!isHost) return;
      const seats = lobby.slots.filter(Boolean);
      if (!seats.length) { notice('Seat at least one player first.', c); return; }
      const waiting = seats.filter((s) => s.kind === 'human' && s.cid !== c.id && !s.ready);
      if (waiting.length) { notice('Still waiting for: ' + waiting.map((s) => s.name).join(', '), c); return; }
      startMatch();
      return;
    }
    default: return;
  }
  broadcastLobby();
}

// ------------------------------------------------------------------- match
function startMatch() {
  const seats = lobby.slots.map((s, i) => (s ? { ...s, slot: i } : null)).filter(Boolean);
  const mode = lobby.opts.mode === 'turn' ? 'turn' : lobby.opts.mode === 'ctf' ? 'ctf' : 'rt';
  // resolve random commanders, avoiding duplicates where possible (the Capture the Flag heroes only exist in that mode)
  const keys = mode === 'ctf' ? HERO_KEYS : COMMANDER_KEYS;
  const taken = new Set(seats.map((s) => s.commander).filter((k) => k !== 'random' && keys.includes(k)));
  const pool = keys.filter((k) => !taken.has(k)).sort(() => Math.random() - 0.5);
  const players = seats.map((s) => ({
    name: s.name, team: s.team, color: s.color, bot: s.kind === 'bot' ? s.level : null,
    commander: s.commander !== 'random' && keys.includes(s.commander) ? s.commander : (pool.pop() || keys[(Math.random() * keys.length) | 0]),
  }));
  const GameClass = mode === 'turn' ? TacticsGame : mode === 'ctf' ? CtfGame : Game, BotClass = mode === 'turn' ? TacticsBot : mode === 'ctf' ? CtfBot : Bot;
  const g = new GameClass({ players, ...lobby.opts, seed: (Math.random() * 2147483647) | 0 });
  g.players.forEach((P, i) => { if (seats[i] && seats[i].kind === 'bot') P.ai = new BotClass(g, P, seats[i].level); });
  match = {
    g, timer: null, paused: false, over: false, speed: Number(lobby.opts.speed) || 1,
    tokens: seats.map((s) => (s.kind === 'human' ? s.token : null)),
    takeover: new Map(), emptySince: 0, started: Date.now(),
  };
  for (const s of lobby.slots) if (s && s.kind === 'human') s.ready = false;
  if (WARP > 0 && mode === 'rt') { for (let i = 0; i < WARP * TICK_RATE && !g.over; i++) g.step(); g.delta(); }
  for (const c of joined()) {
    c.player = match.tokens.indexOf(c.token);
    sendStart(c);
  }
  log(`match started: ${players.map((p) => `${p.name} (${p.commander}${p.bot ? ', ' + p.bot + ' bot' : ''})`).join(' vs ')} | ${mode === 'turn' ? 'turn-based, ' : mode === 'ctf' ? 'capture the flag, ' : ''}map ${g.mapSize} ${g.w}x${g.h}, seed ${g.seed}`);
  runLoop();
}

function sendStart(c) {
  const g = match.g;
  send(c, { t: 'start', you: c.player, tick: g.tick, paused: match.paused, host: lobby.hostId, cid: c.id, ...g.startInfo() });
  send(c, g.full());
  if (match.over && match.overMsg) send(c, match.overMsg);
  c.synced = true;
}

function runLoop() {
  const m = match;
  const interval = 1000 / (TICK_RATE * m.speed);
  let next = performance.now() + interval;
  const loop = () => {
    if (match !== m) return;
    const now = performance.now();
    let steps = 0;
    while (now >= next && steps < 4) {
      next += interval; steps++;
      if (m.paused || m.over) continue;
      try { m.g.step(); } catch (e) { console.error('simulation error:', e); }
      broadcastDelta(m);
    }
    if (now - next > 500) next = now + interval;              // fell far behind (PC asleep?): don't fast-forward
    housekeeping(m);
    m.timer = setTimeout(loop, Math.max(1, next - performance.now()));
  };
  m.timer = setTimeout(loop, interval);
}

function broadcastDelta(m) {
  const g = m.g;
  const msg = JSON.stringify(g.delta());
  for (const c of clients.values()) {
    if (!c.joined) continue;
    if (!c.synced) {                                           // fell behind earlier: resync once its backlog clears
      if (c.conn.bufferedAmount < 64 * 1024) sendStart(c);
      continue;
    }
    if (c.conn.bufferedAmount > 2 * 1024 * 1024) { c.synced = false; continue; }
    c.conn.send(msg);
  }
  if (g.over && !m.over) {
    m.over = true;
    const summary = g.summary();
    const fresh = recordScores(m, summary, g.over.team);
    const out = {
      t: 'over', team: g.over.team, summary, minutes: g.tick / TICK_RATE / 60, timeline: g.timeline(),
      rounds: g.turn ? g.turn.n : 0, onScore: !!g.over.onScore,
      hof: hallOfFame.slice(0, 10), fresh: fresh.map((e) => e.id),
    };
    m.overMsg = out;
    for (const c of joined()) send(c, out);
    log(`match over after ${(g.tick / TICK_RATE / 60).toFixed(1)} min; winning team ${g.over.team}`);
  }
}

function housekeeping(m) {
  const now = Date.now();
  // a human who dropped gets a caretaker bot after 45s so their kitchen isn't defenceless
  for (const [pi, since] of m.takeover) {
    const P = m.g.players[pi];
    // (in a turn-based match everyone is waiting on the player whose turn it is, so the bot steps in sooner)
    if (!P.ai && P.alive && now - since > (m.g.mode === 'turn' ? Math.min(TAKEOVER_MS, 20000) : TAKEOVER_MS)) {
      P.ai = m.g.mode === 'turn' ? new TacticsBot(m.g, P, 'normal') : m.g.mode === 'ctf' ? new CtfBot(m.g, P, 'normal') : new Bot(m.g, P, 'normal');
      P.ai.caretaker = true;
      if (P.bell) m.g.command(pi, { c: 'bell', on: 0 });        // the caretaker needs the Prep Cooks at work
      for (const c of joined()) send(c, { t: 'chat', sys: 1, m: `${P.name} is still away; a bot is minding their kitchen.` });
    }
  }
  // nobody left watching: stop the match so the PC isn't simulating for no one
  const humans = joined().length;
  if (humans === 0) { if (!m.emptySince) m.emptySince = now; else if (now - m.emptySince > 120000) endMatch('everyone left'); }
  else m.emptySince = 0;
}

function endMatch(why) {
  if (!match) return;
  clearTimeout(match.timer);
  log('match ended' + (why ? ` (${why})` : ''));
  match = null;
  // rebuild the lobby: humans who are still here keep their seat, bots stay
  for (let i = 0; i < lobby.slots.length; i++) {
    const s = lobby.slots[i];
    if (!s || s.kind !== 'human') continue;
    const c = joined().find((x) => x.token === s.token);
    if (c) { s.cid = c.id; s.name = c.name; s.ready = false; } else lobby.slots[i] = null;
  }
  for (const c of clients.values()) { c.player = -1; c.synced = false; }
  pickHost();
  broadcastLobby();
}

function matchAction(c, m) {
  const isHost = c.id === lobby.hostId;
  switch (m.t) {
    case 'c':
      if (c.player >= 0 && !match.paused && !match.over) {
        try { match.g.command(c.player, m); } catch (e) { console.error('bad command from', c.name, e.message); }
      }
      break;
    case 'mp': {                      // map ping: shown to the sender's team
      if (c.player < 0 || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      const now = Date.now();
      if (now - (c.lastPing || 0) < 350) return;
      c.lastPing = now;
      const g = match.g, team = g.players[c.player].team;
      const out = { t: 'mp', p: c.player, x: Math.max(0, Math.min(g.w, m.x)), y: Math.max(0, Math.min(g.h, m.y)) };
      for (const x of joined()) if (x.player >= 0 && g.players[x.player].team === team) send(x, out);
      break;
    }
    case 'pause':
      if (!isHost || match.over) return;
      match.paused = !match.paused;
      for (const x of joined()) send(x, { t: 'paused', v: match.paused, by: c.name });
      break;
    case 'end':                       // back to the lobby: host any time, anyone once the match is decided
      if (isHost || match.over) endMatch(isHost ? 'host returned to lobby' : 'returned to lobby');
      break;
  }
}

// --------------------------------------------------------------- connections
function join(c, m) {
  c.name = cleanName(m.name);
  c.token = typeof m.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(m.token) ? m.token : randomBytes(18).toString('base64url');
  // the same browser reconnecting (or a second tab): the newer connection wins
  for (const other of clients.values()) {
    if (other !== c && other.joined && other.token === c.token) { other.replaced = true; send(other, { t: 'kicked', m: 'You connected from another tab.' }); other.conn.close(4000, 'replaced'); drop(other); }
  }
  c.joined = true;
  const cur = clients.get(lobby.hostId);
  if (!cur || !cur.joined || (c.local && !cur.local)) lobby.hostId = c.id;
  send(c, { t: 'welcome', id: c.id, token: c.token, name: c.name, version: VERSION });
  log(`${c.name} joined (${c.local ? 'this PC' : c.conn.remoteAddress})`);

  if (match) {
    c.player = match.tokens.indexOf(c.token);
    if (c.player >= 0) {
      const P = match.g.players[c.player];
      match.takeover.delete(c.player);
      if (P.ai && P.ai.caretaker) { P.ai = null; P.gatherBonus = 1; }
      notice(`${c.name} is back.`);
    } else notice(`${c.name} is watching.`);
    sendStart(c);
    return;
  }
  // returning to a seat they already held (page refresh)?
  const held = lobby.slots.find((s) => s && s.kind === 'human' && s.token === c.token);
  if (held) { held.cid = c.id; held.name = c.name; } else seat(c);
  broadcastLobby();
}

function drop(c) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  if (!c.joined) return;
  log(`${c.name} left`);
  if (match) {
    if (c.player >= 0 && !c.replaced && match.g.players[c.player].alive && !match.over) {
      match.takeover.set(c.player, Date.now());
      notice(`${c.name} disconnected. They can rejoin with the same link.`);
    }
  } else if (!c.replaced) {
    const i = slotIndexOf(c);
    if (i >= 0) lobby.slots[i] = null;
  }
  pickHost();
  if (match) { for (const x of joined()) send(x, { t: 'host', host: lobby.hostId }); } else broadcastLobby();
}

function onMessage(c, text) {
  // crude flood protection
  const now = Date.now();
  if (now - c.winStart > 1000) { c.winStart = now; c.winCount = 0; }
  if (++c.winCount > 400) { c.conn.close(4008, 'slow down'); return; }
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  if (!c.joined) { if (m.t === 'hello') join(c, m); return; }
  if (m.t === 'ping') { send(c, { t: 'pong', n: m.n }); return; }
  if (m.t === 'scores') { send(c, { t: 'scores', list: hallOfFame }); return; }
  if (m.t === 'chat') {
    const text = cleanText(m.m, 200);
    if (!text) return;
    const out = { t: 'chat', from: c.name, p: match ? c.player : -1, cid: c.id, m: text, team: 0 };
    if (match && m.team && c.player >= 0) {
      const team = match.g.players[c.player].team;
      out.team = 1;
      for (const x of joined()) if (x.player >= 0 && match.g.players[x.player].team === team) send(x, out);
    } else for (const x of joined()) send(x, out);
    return;
  }
  if (m.t === 'name') {
    c.name = cleanName(m.name);
    const s = lobby.slots.find((x) => x && x.kind === 'human' && x.cid === c.id);
    if (s && !match) s.name = c.name;
    broadcastLobby();
    return;
  }
  if (match) matchAction(c, m); else lobbyAction(c, m);
}

attachWebSocket(server, {
  path: '/ws',
  maxPayload: 64 * 1024,
  pingInterval: 15000,
  onError: (err) => console.error('connection handler error:', err),
  onConnection(conn, req) {
    const addr = req.socket.remoteAddress || '';
    const local = !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
    if (clients.size >= 24) { conn.close(1013, 'server full'); return; }
    const c = { id: nextClientId++, conn, local, joined: false, name: '', token: '', player: -1, synced: false, replaced: false, winStart: 0, winCount: 0 };
    clients.set(c.id, c);
    conn.onmessage = (text) => onMessage(c, text);
    conn.onclose = () => drop(c);
  },
});

// ------------------------------------------------------------------ startup
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function startTunnel() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundled = path.join(ROOT, exe);
  const bin = fs.existsSync(bundled) ? bundled : 'cloudflared';
  let child;
  try { child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { tunnelHelp(e); return; }
  let found = false;
  const scan = (buf) => {
    const hit = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(buf));
    if (hit && !found) {
      found = true;
      urls.public = hit[0];
      console.log(`\n  PUBLIC LINK (send this to friends anywhere):\n\n      ${hit[0]}\n\n  It stays valid until you close this window.\n`);
      broadcastLobby();
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', tunnelHelp);
  child.on('exit', (code) => { if (found) { urls.public = null; log('public link closed'); broadcastLobby(); } else if (code) console.log('  cloudflared exited before giving a link (code ' + code + ').'); });
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}
function tunnelHelp(e) {
  console.log('\n  Could not start cloudflared' + (e && e.code === 'ENOENT' ? ' (it is not installed).' : `: ${e && e.message}`));
  console.log('  Install it from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
  console.log('  (or drop cloudflared' + (process.platform === 'win32' ? '.exe' : '') + ' into this folder), then start again with --public.');
  console.log('  LAN play and port forwarding work without it. See README.md.\n');
}

function openBrowser(url) {
  const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser to open (e.g. a headless box): not a problem */ });
    child.unref();
  } catch { /* ignore */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Close the other program or run:  node server.js --port ${PORT + 1}\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  urls.lan = lanAddresses().map((a) => `http://${a}:${PORT}`);
  console.log('\n  ==============================================');
  console.log(`   CHEFDOMS ${VERSION} is cooking!`);
  console.log('  ==============================================\n');
  console.log(`   You (on this PC):        ${urls.local}`);
  for (const u of urls.lan) console.log(`   Friends on your Wi-Fi:   ${u}`);
  console.log('   Friends elsewhere:       see README.md ("Playing over the internet")' + (WANT_PUBLIC ? ' - starting a public link...' : ''));
  console.log('\n   Keep this window open while you play. Press Ctrl+C to stop the server.\n');
  if (WANT_PUBLIC) startTunnel();
  if (WANT_OPEN) openBrowser(urls.local);
});
