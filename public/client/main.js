// ============================================================================
//  CHEFDOMS client entry point: connects, switches screens, turns server
//  events into sights and sounds, and runs the frame loop.
// ============================================================================
import { G, K_UNIT, K_BLDG, beginMatch, applySnapshot, frameUpdate, canSee, isAlly, tileVisible, send, isSpectator } from './state.js';
import { Net, wsUrl } from './net.js';
import { labelOf } from './keys.js';
import * as R from './render.js';
import * as UI from './ui.js';
import * as IN from './input.js';
import * as SPR from './sprites.js';
import { sfx, unlockAudio, setCustomSfx, effectiveMusicVolume } from './audio.js';
import { music } from './music.js';
import { cursorFor } from './cursors.js';
import * as TAC from './tactics.js';
import { COMMANDERS, COMMANDER_KEYS, AGE_NAMES, TECHS, UNITS, VERSION, RES, RES_INFO, TB, CTF, ctfKit } from '/game/data.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem('chefdoms.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('chefdoms.' + k, v); } catch { /* private mode */ } },
};

function show(phase) {
  G.phase = phase;
  document.body.dataset.phase = phase;
  $('screen-join').classList.toggle('hidden', phase !== 'join');
  $('screen-lobby').classList.toggle('hidden', phase !== 'lobby');
  $('hud').classList.toggle('hidden', phase !== 'game');
  if (phase !== 'game') { UI.resetMenu(); for (const m of document.querySelectorAll('.modal')) m.remove(); $('tooltip').classList.add('hidden'); }
  battleUntil = 0;
  music.setState(phase === 'game' ? 'calm' : 'lobby');
}

// ---- music follows the action, and the kitchen makes little working noises
let battleUntil = 0, fightSince = 0, lastAmbient = 0, lastMood = 0;
function soundscape(now) {
  if (now - lastMood > 500) {
    lastMood = now;
    let fighting = (G.lastAlertAt && now - G.lastAlertAt < 6000) || (G.tb && G.lastFightAt && now - G.lastFightAt < 9000);
    if (!fighting) {
      let n = 0;
      for (const e of G.units) if (e.st === 2 && (G.me < 0 || e.owner === G.me)) { if (++n >= (G.me < 0 ? 6 : G.ctf ? 1 : 2)) { fighting = true; break; } }
    }
    // a real fight (a few seconds of it) brings the battle music in; it stays for a good while after the last blow,
    // so a skirmish does not keep cutting the calm pieces short (and the piece that was playing resumes afterwards)
    if (fighting) { if (!fightSince) fightSince = now; if (now - fightSince > 3000) battleUntil = now + 25000; } else fightSince = 0;
    if (!G.over) music.setState(now < battleUntil ? 'battle' : 'calm');
  }
  if (now - lastAmbient > 130 && G.cam.scale >= 24) {
    lastAmbient = now;
    const [x0, y0] = R.screenToWorld(0, 0), [x1, y1] = R.screenToWorld(window.innerWidth, window.innerHeight);
    const seen = [];
    for (const e of G.units) if (e.rx > x0 && e.rx < x1 && e.ry > y0 && e.ry < y1 && (e.st >= 2) && canSee(e)) seen.push(e);
    if (!seen.length) return;
    const e = seen[(Math.random() * seen.length) | 0];
    if (e.st === 2) { if (now - e.hitAt < 400 || Math.random() < 0.35) sfx(MELEE_SOUND[e.type] || MELEE_BY_CLASS[unitClass(e.type)] || 'clang'); }
    else if (e.st === 5) { if (Math.random() < 0.2) sfx('steam'); }
    else if (e.st === 6) { /* sheltering: silent */ }
    else if (Math.random() < 0.45) sfx(e.st === 4 ? 'hammer' : workSound(e));
  }
}

// ---- who makes which noise
/** cook | hero | siege | veh | ranged | support | inf */
function unitClass(type) {
  const U = UNITS[type];
  if (!U) return 'inf';
  for (const k of ['cook', 'hero', 'siege', 'veh', 'ranged', 'support']) if (U.tags.includes(k)) return k;
  return 'inf';
}
const MELEE_SOUND = { butcher: 'cleaver', dancer: 'cleaver', hero_ryo: 'cleaver', hero_flint: 'cleaver', ram: 'ram_hit', cook: 'hit' };
const MELEE_BY_CLASS = { veh: 'veh_hit', inf: 'clang', hero: 'clang', ranged: '', siege: '' };
/** The sound of a Prep Cook at work depends on what is being gathered. */
function workSound(e) {
  if (!e.tgt) return 'chop';
  const t = G.ents.get(e.tgt);
  if (!t) return 'pick';
  if (t.kind === K_BLDG) return 'g_garden';
  return { veg: 'g_veg', spice: 'g_spice', salt: 'g_salt', fish: 'g_fish' }[t.type] || 'pick';
}
/** Selection and order acknowledgements: every kind of unit answers in its own voice. */
function unitSound(list, kind) {
  if (!list.length) return;
  const e = list.find((x) => x.kind === K_UNIT && x.type !== 'cook') || list[0];
  if (e.kind !== K_UNIT) { sfx(kind === 'select' ? (e.kind === K_BLDG ? 'sel_bldg' : 'click') : 'move'); return; }
  const cls = unitClass(e.type);
  if (kind === 'select') sfx('sel_' + cls);
  else if (kind === 'attack') sfx(cls === 'veh' ? 'attack_veh' : 'attack');
  else if (kind === 'gather') sfx('gather_ack');
  else if (kind === 'build') sfx('build_ack');
  else sfx(cls === 'veh' ? 'move_veh' : cls === 'siege' ? 'move_siege' : 'move');
}

// ------------------------------------------------------------------ network
let seed = null;
const net = new Net(
  () => ({ t: 'hello', name: G.name, token: store.get('token') || '' }),
  onMessage,
  (status, code) => {
    if (status === 'open') { $('banner').classList.add('hidden'); $('join-status').textContent = ''; return; }
    if (code === 4000) return;
    if (G.phase === 'game') { $('banner').textContent = 'Connection lost. Reconnecting…'; $('banner').classList.remove('hidden'); }
    else if (G.phase === 'lobby') { show('join'); $('join-status').textContent = 'Lost the connection to the server. Reconnecting…'; }
    else if (net.wantOpen) $('join-status').textContent = `Cannot reach the server${store.get('server') ? ' at ' + store.get('server') : ''}. Retrying… (check the address, and that the host's server is running)`;
  },
  () => store.get('server') || '');
G.net = net;
G.hooks.message = (m) => onMessage(m);      // for development scripts: feed the client a server message by hand

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      G.cid = m.id; G.name = m.name;
      store.set('token', m.token); store.set('name', m.name);
      G.versionNote = m.version && m.version !== VERSION ? `Heads up: this server runs Chefdoms ${m.version} and your copy is ${VERSION}. Update your copy (git pull) if things look odd.` : '';
      break;
    case 'lobby':
      G.lobby = m; G.hostId = m.host;
      if (G.phase !== 'lobby') {
        show('lobby');
        const remote = store.get('server');
        $('lobby-version').textContent = (remote ? 'Connected to ' + remote + ' · ' : '') + 'v' + (m.version || VERSION);
        if (G.versionNote) { UI.addChat({ sys: 1, m: G.versionNote }); G.versionNote = ''; }
      }
      UI.renderLobby();
      break;
    case 'start': {
      G.hostId = m.host; G.best = m.best || null;
      m.resync = G.phase === 'game' && seed === m.seed;
      seed = m.seed;
      beginMatch(m);
      R.resetWorld();
      if (!m.resync) { G.cam.scale = R.defaultZoom(); R.clampCamera(); }
      show('game');
      $('banner').textContent = 'Paused'; $('banner').classList.toggle('hidden', !m.paused);
      R.resize();
      UI.resetHUD();
      if (!m.resync) UI.note(m.you >= 0 ? `You are ${COMMANDERS[m.players[m.you].commander].name}. Good luck, chef!` : 'You are watching this match.', 'good');
      if (!m.resync && G.tb && m.you >= 0) UI.note(`Turn-based match: move each unit once, then act. ${labelOf('endTurn')} ends your turn.`);
      G.follow = !!(G.ctf && m.you >= 0 && !m.resync); autoSelect = !!(G.ctf && m.you >= 0);
      if (!m.resync && G.ctf && m.you >= 0) {
        UI.note(`Capture the Flag: carry the enemy flag to your own flag stand to score. First to ${G.ctf.capsToWin}, or the most when ${Math.round(G.ctf.timeLimit / 60)} minutes are up.`);
        UI.note(`Right-click to move or attack · ${labelOf('ability')} ability · ${labelOf('ultimate')} ultimate. Your hero levels up as the match goes on; minions pay Tips and XP. ${labelOf('follow')} frees the camera.`);
      }
      break;
    }
    case 's': if (G.phase === 'game') applySnapshot(m); break;
    case 'chat': UI.addChat(m); break;
    case 'paused':
      G.paused = m.v;
      UI.note(m.v ? `Paused by ${m.by}` : 'Back to work!', 'warn');
      $('banner').textContent = 'Paused by ' + m.by; $('banner').classList.toggle('hidden', !m.v);
      break;
    case 'host': G.hostId = m.host; UI.refreshMenu(); break;
    case 'votes': G.votes = m; UI.refreshMenu(); break;
    case 'over':
      G.over = m; G.mode = null;
      UI.refreshMenu();
      UI.showOver(m);
      {
        const won = G.me >= 0 && G.players[G.me].team === m.team;
        music.setState('off');
        if (effectiveMusicVolume() > 0.01) music.stinger(won ? 'win' : 'lose'); else sfx(won ? 'win' : 'lose');
      }
      break;
    case 'kicked':
      net.stop(); show('join'); $('join-status').textContent = m.m || 'Disconnected.';
      break;
    case 'mp': {                         // a team-mate (or you) pinged the map
      if (G.phase !== 'game' || !G.players[m.p]) break;
      const now = performance.now(), color = R.colorOf(m.p);
      G.teamPings.push({ x: m.x, y: m.y, t0: now, color, name: m.p === G.me ? '' : G.players[m.p].name });
      G.pings.push({ x: m.x, y: m.y, t0: now, color });
      G.lastAlert = { x: m.x, y: m.y };
      sfx('ping');
      if (m.p !== G.me) UI.note(`${G.players[m.p].name} pinged the map (${labelOf('alert')} jumps there)`);
      break;
    }
    case 'scores': UI.showHall(m.list || []); break;
  }
}

// -------------------------------------------------------------- game events
const SPAWN_SOUND = { cook: 'spawn_cook', hero: 'spawn_hero', siege: 'spawn_siege', veh: 'spawn_veh', ranged: 'spawn_mil', support: 'spawn_support', inf: 'spawn_mil' };
const NOTES = {
  bell: 'There is no Kitchen HQ to shelter in',
  nogate: 'You have no gates to bar',
  nogarrison: 'No Kitchen HQ, tower or Signature Restaurant with room for them (towers take no vehicles or siege)',
  res: 'Not enough ingredients for that',
  place: "Can't build there",
  needs_market: 'Garden Plots need a finished Farmers Market first',
  pop: 'Staff limit reached: build another Break Room',
  popmax: 'Staff limit reached',
  ultage: 'Ultimates unlock in the Bistro Age',
  // capture the flag
  shop: 'Shop at your own kitchen (or while you wait to respawn)',
  tips: 'Not enough Tips',
  maxed: 'That item is fully upgraded',
  full: 'Still chewing the last Energy Bar',
  market: 'You need a Farmers Market to trade',
  ulttarget: 'No enemy within reach for that',
  // turn-based
  pantry: 'A Pantry is built ON a resource: a Veggie Patch, Timber Stand, Spice Mound, Salt Rock or Fishing Spot',
  busy: 'That station is busy: one job at a time',
  setup: 'Artillery cannot move and fire in the same turn',
  timeup: 'Time is up: your turn has ended',
  blocked: 'Something is in the way',
  stuck: 'Stuck in caramel: it cannot attack this turn',
};
let lastIncome = null, autoSelect = false;
const onScreen = (x, y) => (isSpectator() || tileVisible(x, y));
const myTeam = () => (G.me >= 0 ? G.players[G.me].team : -2);
const flagOwner = (team) => { const p = G.players.find((q) => q.team === team && !q.neutral); return p ? (team === myTeam() ? 'your' : G.players.filter((q) => q.team === team && !q.neutral).length > 1 ? p.name + "'s team" : p.name + "'s") : 'the'; };
const kitOfPlayer = (pi) => { const C = COMMANDERS[G.players[pi].commander]; return G.ctf ? ctfKit(C) : { ability: C.ability, ultimate: C.ultimate }; };

G.hooks.event = (ev) => {
  const now = performance.now(), Q = G.Q;
  const mine = ev[1] === G.me;
  switch (ev[0]) {
    case 'shot': {
      const src = G.ents.get(ev[1]), tg = G.ents.get(ev[2]);
      if (!src) break;
      const x0 = src.kind === K_UNIT ? src.rx : src.x, y0 = src.kind === K_UNIT ? src.ry - 0.55 : src.ty - 0.1;
      const lobbed = ev[3] === 'meatball' || ev[3] === 'macaron' || ev[3] === 'flame' || !tg;
      G.projs.push({
        kind: ev[3], x0, y0, fixed: lobbed, tid: lobbed ? 0 : ev[2],
        tx: lobbed ? ev[5] / Q : tg.rx, ty: lobbed ? ev[6] / Q : tg.ry - 0.4,
        t0: now, dur: Math.max(60, ev[4] * G.snapDt),
      });
      if (onScreen(x0, y0)) sfx('shot_' + ev[3]);
      break;
    }
    case 'spawned': {                    // one of our own units just walked out of a station
      const e = G.ents.get(ev[1]);
      if (!e || e.owner !== G.me) break;
      const cls = unitClass(e.type);
      if (cls !== 'hero') sfx(SPAWN_SOUND[cls] || 'train');
      G.fx.push({ kind: 'ring', x: e.x, y: e.y, t0: now, dur: 500, color: R.colorOf(G.me), k: 0.3 });
      break;
    }
    case 'bell': {
      const P = G.players[ev[1]];
      if (mine) { UI.note(ev[2] ? 'The bell rings: Prep Cooks are heading inside!' : 'All clear: back to work!', ev[2] ? 'warn' : 'good'); sfx(ev[2] ? 'bell' : 'allclear'); }
      else if (isAlly(ev[1])) { UI.note(`${P.name} ${ev[2] ? 'rang the bell' : 'gave the all-clear'}`); if (ev[2]) sfx('bell', 0.5); }
      UI.refreshAll(true);
      break;
    }
    case 'gates':                        // ['gates', player, barred?, how many]
      if (mine) { UI.note(ev[2] ? `Gates barred (${ev[3]}): nobody gets through, your own side included` : `Gates open again (${ev[3]})`, ev[2] ? 'warn' : 'good'); sfx(ev[2] ? 'gate_lock' : 'gate_open'); }
      UI.refreshAll(true);
      break;
    case 'tribute': {                    // ['tribute', from, to, resource, amount]
      const from = G.players[ev[1]], to = G.players[ev[2]], what = `${ev[4]} ${RES_INFO[ev[3]].name}`;
      if (ev[2] === G.me) { UI.note(`${from.name} sent you ${what}`, 'good'); sfx('tribute'); }
      else if (mine) { UI.note(`Sent ${what} to ${to.name}`, 'good'); sfx('tribute'); }
      else if (isAlly(ev[1])) UI.note(`${from.name} sent ${what} to ${to.name}`);
      break;
    }
    case 'alert':
      if (!mine || G.ctf) break;                                        // (in the arena you see your hero: no alarm bells)
      G.lastAlert = { x: ev[2], y: ev[3] }; G.lastAlertAt = now;
      G.pings.push({ x: ev[2], y: ev[3], t0: now });
      UI.note(ev[4] === K_BLDG ? 'Your station is under attack!' : 'Your crew is under attack!', 'bad');
      sfx('alert');
      break;
    case 'age':
      UI.note(mine ? `You advanced to the ${AGE_NAMES[ev[2]]}!` : `${G.players[ev[1]].name} advanced to the ${AGE_NAMES[ev[2]]}`, mine ? 'good' : '');
      if (mine) sfx('age');
      break;
    case 'tech':
      if (mine) { UI.note('Upgrade complete: ' + TECHS[ev[2]].name, 'good'); sfx('tech'); }
      break;
    case 'built': {
      const b = G.ents.get(ev[2]);
      if (mine && G.tick > 20) {
        if (b && (b.type === 'wall' || b.type === 'saltwall')) { if (now - (G.lastWallSfx || 0) > 1500) { G.lastWallSfx = now; sfx('hammer'); } }     // a wall block goes up: a knock, not a fanfare
        else sfx('built');
      }
      break;
    }
    case 'placed': {
      const b = G.ents.get(ev[1]);
      if (b && canSee(b)) G.fx.push({ kind: 'dust', x: b.x, y: b.y + b.size * 0.3, t0: now, dur: 500, k: b.size * 0.5 });
      break;
    }
    case 'ability': {
      const P = G.players[ev[1]], A = kitOfPlayer(ev[1]).ability;
      const x = ev[3] / Q, y = ev[4] / Q;
      if (onScreen(x, y) || mine) {
        G.fx.push({ kind: 'ring', x, y, t0: now, dur: 900, color: R.colorOf(ev[1]), k: G.tb ? (TB.abilityRange + 0.5) / 3 : (A.radius || 8) / 3 });
        sfx('ability');
      }
      if (mine) UI.note(A.name + '!', 'good');
      else if (isAlly(ev[1])) UI.note(`${P.name} used ${A.name}`);
      break;
    }
    case 'ult': {                        // a commander's ultimate: everybody hears about it
      const P = G.players[ev[1]], U = kitOfPlayer(ev[1]).ultimate;
      const x = ev[3] / Q, y = ev[4] / Q, col = R.colorOf(ev[1]), seen = onScreen(x, y) || mine;
      const big = G.tb ? (TB.abilityRange + 0.5) / 3 : (U.radius || 9) / 3;
      if (seen) {
        for (const [d, k] of [[0, big], [150, big * 0.72], [300, big * 0.45]]) G.fx.push({ kind: 'ring', x, y, t0: now + d, dur: 1100, color: col, k });
        if (ev[2] === 'flambe') G.fx.push({ kind: 'boom', x, y, t0: now, dur: 750, k: 2.4 });
        if (ev[2] === 'perfectcut') G.fx.push({ kind: 'atkmark', x, y, t0: now, dur: 900 });
      }
      sfx('ult_' + ev[2], seen ? 1 : 0.55);
      UI.note(mine ? U.name + '!' : `${P.name} unleashes ${U.name}!`, mine ? 'good' : isAlly(ev[1]) ? '' : 'bad');
      break;
    }
    case 'dmg': {                        // turn-based: numbers float up from every blow and every heal
      const x = ev[1] / Q, y = ev[2] / Q;
      if (!onScreen(x, y)) break;
      G.fx.push({ kind: 'num', x, y, t0: now, dur: 1200, text: (ev[4] ? '+' : '−') + ev[3], color: ev[4] ? '#8dff9a' : '#ff8a7a' });
      if (ev[4]) { G.fx.push({ kind: 'heal', x, y, t0: now, dur: 800 }); sfx('heal'); }
      else { G.fx.push({ kind: 'hit', x, y: y - 0.2, t0: now, dur: 260, k: 1.6 }); G.lastFightAt = now; }
      break;
    }
    case 'swing': {                      // turn-based: a blow at arm's length
      const a = G.ents.get(ev[1]);
      if (a && canSee(a)) sfx(MELEE_SOUND[a.type] || MELEE_BY_CLASS[unitClass(a.type)] || 'clang');
      break;
    }
    case 'income': if (mine) lastIncome = ev; break;
    case 'turn': {                       // ['turn', round, player, team (-1 = one kitchen at a time)]
      if (!G.tb) break;
      G.tb.n = ev[1]; G.tb.cur = ev[2]; G.tb.team = ev[3] ?? -1; G.tb.ended = 0; G.tbDirty = true;
      if (G.mode && G.mode.type === 'tplace') G.mode = null;
      if (TAC.myTurn()) {
        const got = lastIncome ? RES.map((r, i) => (lastIncome[2 + i] ? `+${lastIncome[2 + i]} ${RES_INFO[r].name}` : '')).filter(Boolean).join(', ') : '';
        UI.note((G.tb.team >= 0 ? `Your team's turn` : 'Your turn') + ` · round ${ev[1]}` + (got ? ' · ' + got : ''), 'good');
        sfx('turn');
      } else sfx('turn_other');
      lastIncome = null;
      UI.refreshAll(true);
      break;
    }
    case 'herodown': {
      const P = G.players[ev[1]];
      if (G.ctf) {
        const K = ev[2] >= 0 ? G.players[ev[2]] : null, iKilled = ev[2] === G.me;
        if (mine) { UI.note(`You were taken out${K ? ' by ' + K.name : ''}! Respawning at your kitchen shortly: a good moment to shop.`, 'bad'); sfx('herodown'); G.lastFightAt = now; }
        else if (iKilled) { UI.note(`You took out ${COMMANDERS[P.commander].name} (${P.name})!`, 'good'); sfx('flag_return'); }
        else UI.note(`${P.name} is down${K ? ' (' + K.name + ')' : ''}`, isAlly(ev[1]) ? 'warn' : '');
        break;
      }
      UI.note(mine ? (G.tb ? 'Your commander is down! Back at the Kitchen HQ in a few turns.' : 'Your commander is down! Back at the Kitchen HQ shortly.') : `${COMMANDERS[P.commander].name} (${P.name}) has been carried off the field`, mine ? 'bad' : '');
      if (mine) sfx('herodown');
      break;
    }
    case 'heroup':
      if (mine) { UI.note(G.ctf ? 'Back on the field!' : 'Your commander is back on the field', 'good'); sfx('spawn_hero'); if (G.ctf) autoSelect = true; }
      break;
    // ---- capture the flag
    case 'flag': {                       // ['flag', take|drop|return|cap, flagTeam, player, qx, qy]
      const kind = ev[1], team = ev[2], pi = ev[3], x = ev[4] / Q, y = ev[5] / Q, ours = team === myTeam();
      const who = pi >= 0 && G.players[pi] ? G.players[pi] : null, me = pi === G.me, ally = pi >= 0 && isAlly(pi);
      const col = R.teamColor(team);
      G.fx.push({ kind: 'ring', x, y, t0: now, dur: 800, color: col, k: 0.8 });
      if (kind === 'take') {
        if (ours) { UI.note(`${who ? who.name : 'Someone'} has taken your flag! Hunt the carrier down.`, 'bad'); sfx('flag_lost'); G.lastAlert = { x, y }; G.lastAlertAt = now; G.pings.push({ x, y, t0: now }); }
        else if (me) { UI.note('You have the flag! Run it to your own flag stand (it lights up).', 'good'); sfx('flag_take'); }
        else if (ally) { UI.note(`${who.name} has ${flagOwner(team)} flag: cover the run!`, 'good'); sfx('flag_take', 0.6); }
        else if (who) UI.note(`${who.name} took ${flagOwner(team)} flag`);
      } else if (kind === 'drop') {
        if (ours) { UI.note('Your flag is on the ground: touch it to return it!', 'warn'); G.lastAlert = { x, y }; G.pings.push({ x, y, t0: now }); }
        else if (G.me >= 0) UI.note(`${flagOwner(team)[0].toUpperCase() + flagOwner(team).slice(1)} flag was dropped`);
      } else if (kind === 'return') {
        if (ours) { UI.note(me ? 'You returned your flag!' : 'Your flag is back on its stand', 'good'); sfx('flag_return'); }
      } else if (kind === 'cap') {
        if (me || ally) { UI.note(`CAPTURE! ${me ? 'You' : who.name} scored${G.ctf.caps[myTeam()] !== undefined ? '' : ''}`, 'good'); sfx('flag_cap'); }
        else if (ours) { UI.note(`${who ? who.name : 'The enemy'} captured your flag!`, 'bad'); sfx('flag_lostcap'); }
        else if (who) { UI.note(`${who.name} captured ${flagOwner(team)} flag`); sfx('flag_lostcap', 0.5); }
        for (const [d, k] of [[0, 1.2], [150, 0.9], [300, 0.6]]) G.fx.push({ kind: 'ring', x, y, t0: now + d, dur: 1000, color: col, k });
      }
      UI.refreshAll(true);
      break;
    }
    case 'bounty': {                     // ['bounty', player, tips, qx, qy]
      const x = ev[3] / Q, y = ev[4] / Q;
      if (mine) { G.fx.push({ kind: 'num', x, y: y - 0.3, t0: now, dur: 1300, text: '+' + ev[2], color: '#ffd86b' }); G.fx.push({ kind: 'coin', x, y: y - 0.6, t0: now, dur: 900 }); sfx('coin'); G.lastFightAt = now; }
      else if (onScreen(x, y)) G.fx.push({ kind: 'coin', x, y: y - 0.6, t0: now, dur: 900 });
      break;
    }
    case 'assist':                       // ['assist', player, tips]: helped bring down an enemy hero
      if (mine) { UI.note(`Assist! +${ev[2]} Tips`, 'good'); sfx('coin'); }
      break;
    case 'item': {                       // ['item', player, key, tier]
      if (!mine) break;
      const it = CTF.items[ev[2]];
      UI.note(`Bought ${it ? it.name : ev[2]} ${['I', 'II', 'III'][ev[3] - 1] || ev[3]}`, 'good'); sfx('buy'); UI.refreshAll(true);
      break;
    }
    case 'eat': {                        // ['eat', player, qx, qy]
      const x = ev[2] / Q, y = ev[3] / Q;
      if (onScreen(x, y) || mine) { G.fx.push({ kind: 'heal', x, y, t0: now, dur: 800 }); sfx('heal'); }
      break;
    }
    case 'camp': break;                  // the renderer shows camps coming and going
    case 'trade':                        // ['trade', player, give, get, given, got]
      if (mine) { UI.note(`Traded ${ev[4]} ${RES_INFO[ev[2]].name} for ${ev[5]} ${RES_INFO[ev[3]].name}`, 'good'); sfx('buy'); }
      UI.refreshAll(true);
      break;
    case 'reveal': {                     // ['reveal', flagTeam, qx, qy, carrier]: a flag carrier shows on everyone's minimap
      const f = G.ctf && G.ctf.flags.find((q) => q.team === ev[1]);
      if (!f) break;
      const x = ev[2] / Q, y = ev[3] / Q;
      f.x = x; f.y = y;
      G.pings.push({ x, y, t0: now, color: R.teamColor(ev[1]) });
      if (ev[1] === myTeam()) { G.lastAlert = { x, y }; sfx('ping', 0.5); }
      break;
    }
    case 'buffcamp': {                   // ['buffcamp', player, campType]
      const def = CTF.camps[ev[2]], who = G.players[ev[1]];
      if (!def || !who) break;
      if (mine) { UI.note(`You have the ${def.buffName}: ${def.buffDesc}`, 'good'); sfx('buy'); }
      else UI.note(`${who.name} took the ${def.buffName}`, isAlly(ev[1]) ? 'good' : 'warn');
      break;
    }
    case 'lvl': {                        // ['lvl', player, level]: a hero levelled up
      const p = G.ps[ev[1]], e = p && p.heroId ? G.ents.get(p.heroId) : null;
      if (e && (mine || onScreen(e.rx, e.ry))) G.fx.push({ kind: 'num', x: e.rx, y: e.ry - 1.7, t0: now, dur: 1700, text: 'Level ' + ev[2] + '!', color: '#9fd3ff' });
      if (mine) { UI.note(`Level ${ev[2]}! Your hero is tougher and hits harder.`, 'good'); sfx('levelup'); }
      break;
    }
    case 'minions':                      // ['minions', level]
      if (G.me >= 0) { UI.note(`The wild minions grow tougher (level ${ev[1] + 1}): bigger bounties too`, 'warn'); sfx('level'); }
      break;
    case 'sudden':
      UI.note('SUDDEN DEATH: the next capture wins!', 'bad'); sfx('sudden'); G.lastAlertAt = now;
      break;
    case 'flood': {                      // ['flood', player, qx, qy, angle*100, length, width]
      const x = ev[2] / Q, y = ev[3] / Q;
      if (onScreen(x, y) || mine) G.fx.push({ kind: 'flood', x, y, ang: ev[4] / 100, len: ev[5], width: ev[6], t0: now, dur: 1000 });
      break;
    }
    case 'elim':
      UI.note(mine ? 'Your kitchen has fallen. You can keep watching.' : `${G.players[ev[1]].name} has been eliminated`, mine ? 'bad' : 'warn');
      if (mine) { G.sel.clear(); G.mode = null; }
      break;
    case 'note':
      if (mine && NOTES[ev[2]]) { UI.note(G.ctf && ev[2] === 'ultage' ? `Ultimates unlock at ${CTF.ultUnlockMin}:00` : NOTES[ev[2]], 'warn'); sfx('error'); }
      break;
    case 'tip':
      G.fx.push({ kind: 'coin', x: ev[2] / Q, y: ev[3] / Q - 0.6, t0: now, dur: 900 });
      break;
  }
};

G.hooks.impact = (kind, x, y) => {
  if (!onScreen(x, y)) return;
  sfx(kind === 'sauce' || kind === 'frosting' ? 'splat' : kind === 'meatball' || kind === 'macaron' ? 'boom' : kind === 'plate' ? 'smash' : 'hit');
};

G.hooks.removed = (e) => {
  if (G.phase !== 'game' || G.tick < 5) return;
  const now = performance.now();
  if (e.kind === K_UNIT) {
    if (!onScreen(e.rx, e.ry)) return;
    if (e.st === 6) return;                         // was sheltering: nothing to see
    G.fx.push({ kind: 'death', x: e.rx, y: e.ry, t0: now, dur: 650, color: R.colorOf(e.owner) });
    { const cls = unitClass(e.type); sfx(cls === 'veh' || cls === 'siege' ? 'death_veh' : 'death'); }
  } else if (e.kind === K_BLDG) {
    if (!onScreen(e.x, e.y)) return;
    G.fx.push({ kind: 'collapse', x: e.x, y: e.y + e.size * 0.25, t0: now, dur: 900, k: e.size * 0.5 });
    if (e.type !== 'garden') sfx('collapse');
  }
};

// ------------------------------------------------------------------- startup
function join() {
  const name = $('name').value.trim();
  if (!name) { $('join-status').textContent = 'Type a name first.'; $('name').focus(); return; }
  unlockAudio();
  G.name = name.slice(0, 16);
  store.set('name', G.name);
  store.set('server', $('server').value.trim());
  $('join-status').textContent = 'Connecting…';
  net.connect();
}

function boot() {
  SPR.initSprites(40);
  $('join-faces').replaceChildren(...COMMANDER_KEYS.map((k) => { const i = new Image(); i.src = UI.iconURL('commander', k, 128); i.title = COMMANDERS[k].name; return i; }));
  $('name').value = store.get('name') || '';
  $('server').value = store.get('server') || '';
  const onHostPc = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  $('server-hint').textContent = onHostPc
    ? 'Joining a friend? Paste the address they gave you. Leave empty to play on the server running on this computer.'
    : 'Leave empty to play on the server this page came from.';
  $('server').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') join(); });
  $('btn-leave').addEventListener('click', () => { show('join'); net.stop(); $('join-status').textContent = ''; $('name').focus(); });
  $('btn-join').addEventListener('click', join);
  $('name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') join(); });
  $('btn-help').addEventListener('click', () => UI.showHelp());
  $('btn-hall').addEventListener('click', () => send({ t: 'scores' }));
  $('btn-sound').addEventListener('click', () => UI.showSound());
  fetch('/api/audio').then((r) => r.json()).then((j) => { music.setCustom(j.music || {}); setCustomSfx(j.sfx || {}); }).catch(() => { /* older server: built-in audio only */ });
  music.setState('lobby');
  const lc = $('lobby-chat-input');
  lc.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && lc.value.trim()) { send({ t: 'chat', m: lc.value.trim() }); lc.value = ''; } });
  window.addEventListener('mousedown', unlockAudio, { capture: true });
  window.addEventListener('keydown', unlockAudio, { capture: true });

  const canvas = $('game'), mm = $('minimap');
  R.initRender(canvas, mm);
  UI.initUI({
    selectHero: (center) => IN.selectHero(center),
    selectIdle: () => IN.selectIdleCook(),
    selectArmy: () => IN.selectArmy(),
    stop: () => IN.stopSelected(),
    setEdgeScroll: (v) => IN.setEdgeScroll(v),
    setCamSpeed: (v) => IN.setCamSpeed(v),
    setDblSelect: (v) => IN.setDblSelect(v),
    setZoomSens: (v) => R.setZoomSens(v),
    setFormation: (f) => IN.setFormation(f),
    toggleBell: () => IN.toggleBell(),
    toggleFollow: () => IN.toggleFollow(),
    toggleGates: () => IN.toggleGates(),
    garrison: () => IN.garrisonSelected(null),
  });
  IN.initInput(canvas, {
    selection: () => UI.refreshAll(true),
    cardKey: (i, shift) => UI.cardKey(i, shift),
    cardBack: () => UI.cardBack(),
    unitSound,
    openChat: (team) => UI.openChat(team),
    toggleMenu: (v) => UI.toggleMenu(v),
    note: (t) => UI.note(t, 'warn'),
    openTribute: () => UI.showTribute(),
  });
  TAC.initTactics({ note: (t) => { UI.note(t, 'warn'); sfx('error'); }, sound: unitSound, selection: () => UI.refreshAll(true), canAfford: UI.canAfford });
  IN.setEdgeScroll(store.get('edge') !== '0');
  IN.setCamSpeed(Number(store.get('camSpeed')) || 1);
  IN.setDblSelect(store.get('dblSelect') !== '0');
  R.setZoomSens(Number(store.get('zoomSens')) || 1);

  // minimap: left-drag moves the camera, right-click sends the selection there
  let mmDrag = false;
  const mmWorld = (ev) => { const r = mm.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * G.w, ((ev.clientY - r.top) / r.height) * G.h]; };
  mm.addEventListener('mousedown', (ev) => {
    const [x, y] = mmWorld(ev);
    if (ev.button === 0 && (ev.altKey || (G.mode && G.mode.type === 'ping'))) { IN.pingAt(x, y); if (G.mode && G.mode.type === 'ping') G.mode = null; }
    else if (ev.button === 0) { if (G.follow) IN.toggleFollow(false); mmDrag = true; G.cam.x = x; G.cam.y = y; }
    else if (ev.button === 2 && !G.tb) IN.contextCommand(x, y, ev.shiftKey);
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => { if (mmDrag) { const [x, y] = mmWorld(ev); G.cam.x = x; G.cam.y = y; } });
  window.addEventListener('mouseup', () => { mmDrag = false; });

  // came back to a page we already used: rejoin straight away (this is also how a refresh mid-match reconnects)
  if (store.get('name') && store.get('token')) { G.name = store.get('name'); $('join-status').textContent = 'Connecting…'; net.connect(); }
  else $('name').focus();

  let last = performance.now(), lastCursor = null;
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (G.phase !== 'game') return;
    if (G.ctf && G.me >= 0) {                                   // capture the flag: your hero is all you command, so it always stays selected
      const id = G.ps[G.me].heroId;
      if (id && G.ents.get(id) && !(G.sel.size === 1 && G.sel.has(id))) { autoSelect = false; IN.selectHero(false); }
    }
    IN.updateInput(dt);
    frameUpdate(now);
    // what is under the mouse decides the cursor: sword = attack, basket = gather, hammer = build, arrow = deliver
    let kind = '';
    TAC.update();
    if (G.mode && G.mode.type !== 'tplace') { G.hover = 0; G.hoverTree = -1; TAC.T.hov = null; kind = G.mode.type === 'amove' ? 'attack' : G.mode.type === 'ping' ? 'ping' : 'place'; }
    else if (G.mouse.inside && !G.drag) kind = IN.hoverIntent(G.mouse.wx, G.mouse.wy);
    else { G.hover = 0; G.hoverTree = -1; TAC.T.hov = null; }
    G.hoverKind = kind;
    if (kind !== lastCursor) { lastCursor = kind; canvas.style.cursor = cursorFor(kind); mm.style.cursor = kind === 'ping' ? cursorFor('ping') : 'pointer'; }
    R.render(now);
    UI.updateHUD(now);
    soundscape(now);
  };
  requestAnimationFrame(frame);
}

boot();
// handy for debugging from the browser console
window.CHEFDOMS = G;
G.tac = TAC.T;
