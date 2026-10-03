// ============================================================================
//  CHEFDOMS client entry point: connects, switches screens, turns server
//  events into sights and sounds, and runs the frame loop.
// ============================================================================
import { G, K_UNIT, K_BLDG, beginMatch, applySnapshot, frameUpdate, canSee, isAlly, tileVisible, send, isSpectator } from './state.js';
import { Net, wsUrl } from './net.js';
import * as R from './render.js';
import * as UI from './ui.js';
import * as IN from './input.js';
import * as SPR from './sprites.js';
import { sfx, unlockAudio, setCustomSfx, effectiveMusicVolume } from './audio.js';
import { music } from './music.js';
import { COMMANDERS, COMMANDER_KEYS, AGE_NAMES, TECHS, VERSION } from '/game/data.js';

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
  if (phase !== 'game') { for (const m of document.querySelectorAll('.modal')) m.remove(); $('tooltip').classList.add('hidden'); }
  battleUntil = 0;
  music.setState(phase === 'game' ? 'calm' : 'lobby');
}

// ---- music follows the action, and the kitchen makes little working noises
let battleUntil = 0, fightSince = 0, lastAmbient = 0, lastMood = 0;
function soundscape(now) {
  if (now - lastMood > 500) {
    lastMood = now;
    let fighting = G.lastAlertAt && now - G.lastAlertAt < 6000;
    if (!fighting) {
      let n = 0;
      for (const e of G.units) if (e.st === 2 && (G.me < 0 || e.owner === G.me)) { if (++n >= (G.me < 0 ? 6 : 2)) { fighting = true; break; } }
    }
    if (fighting) { if (!fightSince) fightSince = now; if (now - fightSince > 1200) battleUntil = now + 9000; } else fightSince = 0;
    if (!G.over) music.setState(now < battleUntil ? 'battle' : 'calm');
  }
  if (now - lastAmbient > 130 && G.cam.scale >= 24) {
    lastAmbient = now;
    const [x0, y0] = R.screenToWorld(0, 0), [x1, y1] = R.screenToWorld(window.innerWidth, window.innerHeight);
    const seen = [];
    for (const e of G.units) if (e.rx > x0 && e.rx < x1 && e.ry > y0 && e.ry < y1 && (e.st >= 2) && canSee(e)) seen.push(e);
    if (!seen.length) return;
    const e = seen[(Math.random() * seen.length) | 0];
    if (e.st === 2) { if (now - e.hitAt < 400 || Math.random() < 0.35) sfx(Math.random() < 0.5 ? 'clang' : 'hit'); }
    else if (Math.random() < 0.45) sfx(e.st === 4 ? 'hammer' : e.tgt ? 'pick' : 'chop');
  }
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
      G.hostId = m.host;
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
      break;
    }
    case 's': if (G.phase === 'game') applySnapshot(m); break;
    case 'chat': UI.addChat(m); break;
    case 'paused':
      G.paused = m.v;
      UI.note(m.v ? `Paused by ${m.by}` : 'Back to work!', 'warn');
      $('banner').textContent = 'Paused by ' + m.by; $('banner').classList.toggle('hidden', !m.v);
      break;
    case 'host': G.hostId = m.host; break;
    case 'over':
      G.over = m; G.mode = null;
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
  }
}

// -------------------------------------------------------------- game events
const NOTES = {
  res: 'Not enough ingredients for that',
  place: "Can't build there",
  pop: 'Staff limit reached: build another Break Room',
  popmax: 'Staff limit reached',
};
const onScreen = (x, y) => (isSpectator() || tileVisible(x, y));

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
      if (onScreen(x0, y0)) sfx('shot');
      break;
    }
    case 'alert':
      if (!mine) break;
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
    case 'built':
      if (mine && G.tick > 20) sfx('built');
      break;
    case 'placed': {
      const b = G.ents.get(ev[1]);
      if (b && canSee(b)) G.fx.push({ kind: 'dust', x: b.x, y: b.y + b.size * 0.3, t0: now, dur: 500, k: b.size * 0.5 });
      break;
    }
    case 'ability': {
      const P = G.players[ev[1]], A = COMMANDERS[P.commander].ability;
      const x = ev[3] / Q, y = ev[4] / Q;
      if (onScreen(x, y) || mine) {
        G.fx.push({ kind: 'ring', x, y, t0: now, dur: 900, color: R.colorOf(ev[1]), k: (A.radius || 8) / 3 });
        sfx('ability');
      }
      if (mine) UI.note(A.name + '!', 'good');
      else if (isAlly(ev[1])) UI.note(`${P.name} used ${A.name}`);
      break;
    }
    case 'herodown': {
      const P = G.players[ev[1]];
      UI.note(mine ? 'Your commander is down! Back at the Kitchen HQ shortly.' : `${COMMANDERS[P.commander].name} (${P.name}) has been carried off the field`, mine ? 'bad' : '');
      if (mine) sfx('herodown');
      break;
    }
    case 'heroup':
      if (mine) { UI.note('Your commander is back on the field', 'good'); sfx('train'); }
      break;
    case 'elim':
      UI.note(mine ? 'Your kitchen has fallen. You can keep watching.' : `${G.players[ev[1]].name} has been eliminated`, mine ? 'bad' : 'warn');
      if (mine) { G.sel.clear(); G.mode = null; }
      break;
    case 'note':
      if (mine && NOTES[ev[2]]) { UI.note(NOTES[ev[2]], 'warn'); sfx('error'); }
      break;
    case 'tip':
      G.fx.push({ kind: 'coin', x: ev[2] / Q, y: ev[3] / Q - 0.6, t0: now, dur: 900 });
      break;
  }
};

G.hooks.impact = (kind, x, y) => {
  if (!onScreen(x, y)) return;
  sfx(kind === 'sauce' || kind === 'frosting' ? 'splat' : kind === 'meatball' || kind === 'macaron' ? 'boom' : 'hit');
};

G.hooks.removed = (e) => {
  if (G.phase !== 'game' || G.tick < 5) return;
  const now = performance.now();
  if (e.kind === K_UNIT) {
    if (!onScreen(e.rx, e.ry)) return;
    G.fx.push({ kind: 'death', x: e.rx, y: e.ry, t0: now, dur: 650, color: R.colorOf(e.owner) });
    sfx('death');
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
  });
  IN.initInput(canvas, {
    selection: () => UI.refreshAll(true),
    cardKey: (letter, shift) => UI.cardKey(letter, shift),
    openChat: (team) => UI.openChat(team),
    toggleMenu: (v) => UI.toggleMenu(v),
    note: (t) => UI.note(t, 'warn'),
  });
  IN.setEdgeScroll(store.get('edge') !== '0');

  // minimap: left-drag moves the camera, right-click sends the selection there
  let mmDrag = false;
  const mmWorld = (ev) => { const r = mm.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * G.w, ((ev.clientY - r.top) / r.height) * G.h]; };
  mm.addEventListener('mousedown', (ev) => {
    const [x, y] = mmWorld(ev);
    if (ev.button === 0) { mmDrag = true; G.cam.x = x; G.cam.y = y; }
    else if (ev.button === 2) IN.contextCommand(x, y, ev.shiftKey);
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => { if (mmDrag) { const [x, y] = mmWorld(ev); G.cam.x = x; G.cam.y = y; } });
  window.addEventListener('mouseup', () => { mmDrag = false; });

  // came back to a page we already used: rejoin straight away (this is also how a refresh mid-match reconnects)
  if (store.get('name') && store.get('token')) { G.name = store.get('name'); $('join-status').textContent = 'Connecting…'; net.connect(); }
  else $('name').focus();

  let last = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (G.phase !== 'game') return;
    IN.updateInput(dt);
    frameUpdate(now);
    const hov = G.mouse.inside && !G.mode && !G.drag ? IN.pickEntity(G.mouse.wx, G.mouse.wy) : null;
    G.hover = hov ? hov.id : 0;
    const cur = G.mode ? 'crosshair' : hov ? (hov.kind !== 2 && hov.owner >= 0 && !isAlly(hov.owner) && G.sel.size && G.me >= 0 ? 'crosshair' : 'pointer') : 'default';
    if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
    R.render(now);
    UI.updateHUD(now);
    soundscape(now);
  };
  requestAnimationFrame(frame);
}

boot();
// handy for debugging from the browser console
window.CHEFDOMS = G;
