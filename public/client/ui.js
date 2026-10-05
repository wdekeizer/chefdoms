// ============================================================================
//  All the HTML user interface: lobby, in-game HUD, command card, tooltips,
//  chat, notifications, menus and the end-of-match screen.
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, selected, setSelection, cmd, send, statsOf, maxHp, campOf, myHero } from './state.js';
import * as SPR from './sprites.js';
import {
  BUILDINGS, TECHS, COMMANDERS, COMMANDER_KEYS, RES, RES_INFO, AGE_NAMES, AGE_SHORT, OPTIONS, PLAYER_COLORS,
  BOT_LEVELS, BOT_NOTES, MAX_PLAYERS, MAP_SIZES, mapSizeFor, NODES, trainList, techCost, techTime, computeStats,
  STANCES, FORMATIONS, GARRISON_PER_SHOT, GARRISON_MAX_SHOTS, VERSION,
  ULT_AGE, TB, tbUnit, tbBldg, tbTurns, tbCooldown, tbDamage,
  HERO_KEYS, CTF, NEUTRAL_COLOR, ctfKit, ctfHeroStats, ctfItemCost, ctfLevelNeed, MARKET, marketQuote,
} from '/game/data.js';
import * as TAC from './tactics.js';
import { ACTIONS, keyOf, keyLabel, labelOf, setKey, resetKeys, setWasd, isWasd, canBind, onKeysChanged } from './keys.js';
import { sfx, setMuted, isMuted, setSfxVolume, setMusicVolume, getSfxVolume, getMusicVolume } from './audio.js';
import { music } from './music.js';

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h('div', {class:'x', onclick}, child, 'text', ...) */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'selected' || k === 'value') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

const iconCache = new Map();
export function iconURL(kind, key, size = 96, color) {
  const k = kind + '|' + key + '|' + size + '|' + (color || '');
  let u = iconCache.get(k);
  if (!u) { u = SPR.icon(kind, key, size, color).toDataURL(); iconCache.set(k, u); }
  return u;
}
const img = (kind, key, cls, color, size) => h('img', { class: cls || 'ico', src: iconURL(kind, key, size || 96, color), draggable: 'false', alt: '' });
const colorHex = (i) => PLAYER_COLORS[i % PLAYER_COLORS.length].hex;
const playerColor = (i) => (G.players[i] && G.players[i].neutral ? NEUTRAL_COLOR : colorHex(G.players[i].color));
const teamHex = (team) => { const p = G.players.find((q) => q.team === team && !q.neutral); return p ? colorHex(p.color) : '#999'; };
const realPlayers = () => G.players.map((p, i) => [p, i]).filter(([p]) => !p.neutral);
const ITEM_KEYS = Object.keys(CTF.items);
const myColor = () => (G.me >= 0 ? colorHex(G.players[G.me].color) : '#999');
/** Are we looking at (or setting up) a turn-based match? Texts and numbers differ. */
const isTurn = () => (G.phase === 'game' ? !!G.tb : !!(G.lobby && G.lobby.opts.mode === 'turn'));
const isCtf = () => (G.phase === 'game' ? !!G.ctf : !!(G.lobby && G.lobby.opts.mode === 'ctf'));
/** The kit a commander plays with in the mode at hand. */
const kitOf = (C) => (isCtf() ? ctfKit(C) : { ability: C.ability, ultimate: C.ultimate });
const turnsText = (n) => n + (n === 1 ? ' turn' : ' turns');
const abilText = (A) => (isTurn() && A.tb ? A.tb : A.desc);
const cdText = (A, ult) => (isTurn() ? `every ${turnsText(tbCooldown(A.cd))}` : isCtf() ? `every ${Math.round(A.ctfCd || A.cd * (ult ? CTF.ultCdMul : CTF.abilityCdMul))}s` : `every ${A.cd}s`);
const fmtClock = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
const PLAIN = { tags: [], armor: 0, parmor: 0 };
/** Turn-based stat lines: what a unit or station can do on the grid. */
function tbUnitText(S) {
  const U = tbUnit(S), bits = [`HP ${S.hp}`];
  if (S.atk) bits.push(`Strike ${tbDamage(S, PLAIN)}`);
  if (S.heal) bits.push(`Heals ${Math.round(S.heal * TB.healAction / 5)}`);
  bits.push(`Armour ${S.armor}/${S.parmor}`, `Move ${U.mv}`);
  if (U.rng > 1) bits.push(`Range ${U.minRng > 1 ? U.minRng + '–' : ''}${U.rng}`);
  return bits.join(' · ');
}
function tbBldgText(S) {
  const B = tbBldg(S), bits = [`HP ${B.hp}`];
  if (S.atk) bits.push(`Volley ${tbDamage(S, PLAIN)}` + (S.shots > 1 ? ` ×${S.shots}` : ''), `Range ${B.rng}`);
  if (S.pop) bits.push(`Staff +${B.pop}`);
  return bits.join(' · ');
}

let hooks = { selectHero() {}, selectIdle() {}, selectArmy() {}, stop() {}, leaveToLobby() {}, setEdgeScroll() {}, setCamSpeed() {}, setDblSelect() {}, setZoomSens() {}, setFormation() {}, toggleBell() {} };
export function initUI(hk) { hooks = { ...hooks, ...hk }; buildStatic(); }

// ============================================================================
//  LOBBY
// ============================================================================
const amHost = () => G.lobby && G.lobby.host === G.cid;
/** The game modes as the lobby shows them: key, icon, name, one line about it. */
const MODES = [
  ['rt', ['building', 'hq'], 'Real-time', 'The classic: build a kitchen, raise a brigade, raze the enemy HQ.'],
  ['turn', ['ui', 'endturn'], 'Turn-based', 'The same game on a grid, one kitchen at a time. Every unit moves once.'],
  ['ctf', ['ui', 'flag'], 'Capture the Flag', 'One hero each. Level up, buy items, steal the flag.'],
];
const mySlot = () => (G.lobby ? G.lobby.slots.findIndex((s) => s && s.cid === G.cid) : -1);

function slotCard(s, i) {
  const host = amHost(), me = s && s.cid === G.cid;
  if (!s) {
    return h('div', { class: 'slot empty' },
      h('div', { class: 'slot-empty-label' }, 'Empty seat'),
      h('div', { class: 'slot-actions' },
        mySlot() !== i && h('button', { class: 'btn small', onclick: () => send({ t: 'sit', i }) }, mySlot() < 0 ? 'Sit here' : 'Move here'),
        host && h('select', { class: 'addbot', title: BOT_NOTES.extreme, onchange: (ev) => { if (ev.target.value) send({ t: 'bot', i, level: ev.target.value }); } },
          h('option', { value: '' }, '+ Add bot…'), Object.keys(BOT_LEVELS).map((lv) => h('option', { value: lv }, BOT_LEVELS[lv] + ' bot')))));
  }
  const canEdit = me || (host && s.kind === 'bot');
  const edit = (k, v) => send(me ? { t: 'set', k, v } : { t: 'slot', i, a: k, v });
  const used = new Set(G.lobby.slots.filter((x) => x && x !== s).map((x) => x.color));
  const cycleColor = () => { for (let n = 1; n <= PLAYER_COLORS.length; n++) { const c = (s.color + n) % PLAYER_COLORS.length; if (!used.has(c)) { edit('color', c); return; } } };
  const C = COMMANDERS[s.commander];
  return h('div', { class: 'slot' + (me ? ' mine' : ''), style: `--pc:${colorHex(s.color)}` },
    h('div', { class: 'slot-head' },
      h('button', { class: 'swatch', title: canEdit ? 'Change colour' : PLAYER_COLORS[s.color].name, disabled: !canEdit, onclick: cycleColor }),
      h('div', { class: 'slot-name' }, s.name),
      s.cid === G.lobby.host && h('span', { class: 'tag host' }, 'HOST'),
      me && h('span', { class: 'tag you' }, 'YOU'),
      s.kind === 'bot' && h('span', { class: 'tag bot' }, 'BOT'),
      s.kind === 'human' && s.cid !== G.lobby.host && h('span', { class: 'tag ' + (s.ready ? 'ready' : 'wait') }, s.ready ? 'READY' : 'NOT READY'),
      host && !me && h('button', { class: 'x', title: s.kind === 'bot' ? 'Remove bot' : 'Move to spectators', onclick: () => send({ t: 'slot', i, a: 'remove' }) }, '×')),
    h('div', { class: 'slot-body' },
      h('button', { class: 'cmd-pick' + (canEdit ? '' : ' locked'), disabled: !canEdit, title: canEdit ? (isCtf() ? 'Choose a hero' : 'Choose a commander') : '', onclick: canEdit ? () => openCommanderPicker(s, edit) : null },
        C && (isCtf() || !C.ctfOnly) ? img('commander', s.commander, 'portrait', null, 128) : h('div', { class: 'portrait random' }, '?'),
        h('div', { class: 'cmd-pick-text' }, h('div', { class: 'cmd-name' }, C && (isCtf() || !C.ctfOnly) ? C.name : isCtf() ? 'Random hero' : 'Random commander'), h('div', { class: 'cmd-title' }, C && (isCtf() || !C.ctfOnly) ? C.title : 'Surprise me'))),
      h('div', { class: 'slot-row' },
        h('select', { disabled: !canEdit, title: 'Same team number = allies', onchange: (ev) => edit('team', +ev.target.value) },
          Array.from({ length: MAX_PLAYERS }, (_, t) => h('option', { value: t + 1, selected: s.team === t + 1 }, 'Team ' + (t + 1)))),
        s.kind === 'bot' && h('select', { disabled: !host, title: BOT_NOTES.extreme, onchange: (ev) => send({ t: 'slot', i, a: 'level', v: ev.target.value }) },
          Object.keys(BOT_LEVELS).map((lv) => h('option', { value: lv, selected: s.level === lv }, BOT_LEVELS[lv]))))));
}

export function renderLobby() {
  const L = G.lobby;
  if (!L) return;
  const host = amHost(), mine = mySlot();
  $('lobby-slots').replaceChildren(...L.slots.map(slotCard));

  const turn = L.opts.mode === 'turn', ctf = L.opts.mode === 'ctf';
  // the game mode: three big buttons across the top of the lobby
  const cur = L.opts.mode || OPTIONS.mode.def;
  $('lobby-modes').replaceChildren(h('div', { class: 'modes-label' }, 'Game mode'), ...MODES.map(([key, icon, name, line]) => h('button', {
    class: 'mode-card' + (cur === key ? ' on' : ''), 'data-mode': key, disabled: !host && cur !== key,
    title: host ? (cur === key ? 'Selected' : 'Switch to ' + name) : 'The host picks the game mode',
    onclick: () => { if (host && cur !== key) { send({ t: 'opt', k: 'mode', v: key }); sfx('click'); } },
  }, img(icon[0], icon[1], 'mode-ico', icon[0] === 'building' ? (mine >= 0 ? colorHex(L.slots[mine].color) : '#e2403a') : null, 96), h('div', { class: 'mode-text' }, h('div', { class: 'mode-name' }, name), h('div', { class: 'mode-line' }, line)))));
  const shown = (k) => k !== 'mode' && (k.startsWith('turn') ? turn : k.startsWith('ctf') ? ctf : ctf ? ['fog', 'speed'].includes(k) : true);
  $('lobby-opts').replaceChildren(...Object.keys(OPTIONS).filter(shown).map((k) => h('label', { class: 'opt' + (k === 'mode' ? ' wide' : '') }, h('span', null, OPTIONS[k].label),
    h('select', { disabled: !host, 'data-opt': k, onchange: (ev) => send({ t: 'opt', k, v: ev.target.value }) },
      Object.keys(OPTIONS[k].choices).map((v) => h('option', { value: v, selected: String(L.opts[k]) === v }, OPTIONS[k].choices[v]))))));
  const nSeats = L.slots.filter(Boolean).length, real = mapSizeFor(L.opts.mapSize, Math.max(1, nSeats));
  const nTeams = new Set(L.slots.filter(Boolean).map((s) => s.team)).size;
  $('lobby-mapnote').textContent = ctf
    ? `Capture the Flag: one hero each, no kitchen to run. ${nTeams <= 1 ? 'Give the seats different team numbers: ' : nTeams + ' team' + (nTeams === 1 ? '' : 's') + ' on a ' + CTF.mapSize(Math.max(2, nTeams)) + '×' + CTF.mapSize(Math.max(2, nTeams)) + ' arena. '}Same team number = one shared base and flag; every seat its own number = free-for-all. Fell wild minions for Tips, buy items at your kitchen, level up as the match goes on; carry an enemy flag to your own stand to score. First to ${L.opts.ctfCaps || 3} captures (or the most when ${L.opts.ctfTime || 15} minutes are up) wins.`
    : turn
    ? `Turn-based: one kitchen plays at a time on a ${TB.mapSizes[real]}×${TB.mapSizes[real]} grid. Every unit moves once and then does one thing; stations built on resources pay every turn. Staff limit ${Math.max(10, Math.round((+L.opts.popCap || 100) * TB.popShare))}.`
    : `With ${nSeats} kitchen${nSeats === 1 ? '' : 's'} this match plays on the ${OPTIONS.mapSize.choices[real].replace(' (cozy)', '')} map (${MAP_SIZES[real]}×${MAP_SIZES[real]} tiles).`;

  // invite links
  const links = [];
  const add = (label, url, note) => links.push(h('div', { class: 'invite-row' }, h('span', { class: 'invite-label' }, label),
    h('code', null, url), h('button', { class: 'btn small ghost', onclick: (ev) => { copyText(url); ev.target.textContent = 'Copied'; setTimeout(() => { ev.target.textContent = 'Copy'; }, 1200); } }, 'Copy'),
    note && h('div', { class: 'invite-note' }, note)));
  const here = location.origin;
  const isLocalhost = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (L.urls.public) add('Anywhere', L.urls.public, 'Public link: works for friends on any network.');
  for (const u of L.urls.lan || []) add('Same Wi-Fi', u);
  if (!isLocalhost && !links.some((x) => x.textContent.includes(here))) add('This page', here);
  if (!L.urls.public) links.push(h('div', { class: 'invite-note' }, 'Friends in other houses need a public link or port forwarding. The README in the game folder explains both (the short version: start the server with --public).'));
  $('lobby-invite').replaceChildren(...links);

  $('lobby-spectators').replaceChildren(L.spectators.length ? 'Watching: ' + L.spectators.map((s) => s.name + (s.cid === G.cid ? ' (you)' : '')).join(', ') : '');

  const seats = L.slots.filter(Boolean);
  const waiting = seats.filter((s) => s.kind === 'human' && s.cid !== L.host && !s.ready);
  const btns = [];
  if (host) {
    btns.push(h('button', { class: 'btn primary big', disabled: !seats.length || waiting.length > 0, onclick: () => send({ t: 'start' }) }, 'Start cooking'));
    btns.push(h('div', { class: 'muted' }, !seats.length ? 'Seat at least one player.' : waiting.length ? 'Waiting for ' + waiting.map((s) => s.name).join(', ') + ' to ready up.' : seats.length === 1 ? 'Solo sandbox: add a bot or a friend for a real match.' : 'Everyone is ready.'));
  } else if (mine >= 0) {
    const r = L.slots[mine].ready;
    btns.push(h('button', { class: 'btn big ' + (r ? 'ghost' : 'primary'), onclick: () => send({ t: 'set', k: 'ready', v: !r }) }, r ? 'Not ready' : "I'm ready"));
    btns.push(h('div', { class: 'muted' }, 'The host starts the match once everyone is ready.'));
  } else btns.push(h('div', { class: 'muted' }, 'You are watching. Take an empty seat to play.'));
  if (mine >= 0) btns.push(h('button', { class: 'btn small ghost', onclick: () => send({ t: 'spectate' }) }, 'Just watch'));
  $('lobby-actions').replaceChildren(...btns);
}

function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).catch(() => {}); return; }
  const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = t; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}

function commanderDetail(key) {
  const C = COMMANDERS[key];
  const U = statsFor(key).units, uq = U[C.unique], hero = U[C.hero];
  if (isCtf()) {
    const kit = ctfKit(C), H = ctfHeroStats(computeStats(key, CTF.heroAge, []).units[C.hero], {}, key, 1);
    return h('div', { class: 'cd' },
      h('div', { class: 'cd-head' }, img('commander', key, 'portrait big', null, 192),
        h('div', null, h('div', { class: 'cd-name' }, C.name), h('div', { class: 'cd-title' }, `${C.title}`), h('div', { class: 'cd-style' }, C.style))),
      h('p', { class: 'cd-blurb' }, C.blurb),
      h('div', { class: 'cd-sec' }, 'In the arena'),
      h('div', { class: 'tt-stats' }, `HP ${H.hp} · Attack ${H.atk} every ${H.reload}s · Armour ${H.armor}/${H.parmor} · Speed ${H.speed.toFixed(1)} · ${H.range ? 'Range ' + H.range : 'Melee'}`),
      h('div', { class: 'muted' }, `Levels up during the match (up to ${CTF.level.max}): +${Math.round(CTF.level.hp * 100)}% health and +${Math.round(CTF.level.atk * 100)}% attack a level, +1 armour every ${CTF.level.armorEvery} levels.`),
      h('div', { class: 'cd-row' }, img('unit', C.hero, 'ico', '#e2403a'), h('div', null, h('b', null, 'Aura · ' + C.aura.name), h('br'), h('span', { class: 'muted' }, C.aura.desc))),
      h('div', { class: 'cd-row' }, img('ability', kit.ability.key, 'ico'), h('div', null, h('b', null, kit.ability.name), ` (${cdText(kit.ability)})`, h('br'), h('span', { class: 'muted' }, kit.ability.desc))),
      h('div', { class: 'cd-row' }, img('ability', kit.ultimate.key, 'ico ult'), h('div', null, h('b', null, kit.ultimate.name), ` · ultimate (${cdText(kit.ultimate, true)}, from minute ${CTF.ultUnlockMin})`, h('br'), h('span', { class: 'muted' }, kit.ultimate.desc))),
      h('p', { class: 'cd-quote' }, '“' + C.quotes[0] + '”'));
  }
  return h('div', { class: 'cd' },
    h('div', { class: 'cd-head' }, img('commander', key, 'portrait big', null, 192),
      h('div', null, h('div', { class: 'cd-name' }, C.name), h('div', { class: 'cd-title' }, `${C.title} — ${C.brigade}`), h('div', { class: 'cd-style' }, C.style))),
    h('p', { class: 'cd-blurb' }, C.blurb),
    h('div', { class: 'cd-sec' }, 'Kitchen bonuses'),
    h('ul', null, C.bonuses.map((b) => h('li', null, b))),
    h('div', { class: 'cd-sec' }, 'Hero on the field'),
    h('div', { class: 'cd-row' }, img('unit', C.hero, 'ico', '#e2403a'), h('div', null, h('b', null, hero.name), isTurn() ? ' · ' + tbUnitText(hero) : ` · ${hero.hp} HP, ${hero.atk} attack` + (hero.range ? `, range ${hero.range}` : ', melee'), h('br'), h('span', { class: 'muted' }, `Aura · ${C.aura.name}: ${abilText(C.aura)}`))),
    h('div', { class: 'cd-row' }, img('ability', C.ability.key, 'ico'), h('div', null, h('b', null, C.ability.name), ` (${cdText(C.ability)})`, h('br'), h('span', { class: 'muted' }, abilText(C.ability)))),
    h('div', { class: 'cd-row' }, img('ability', C.ultimate.key, 'ico ult'), h('div', null, h('b', null, C.ultimate.name), ` · ultimate (${cdText(C.ultimate)}, from the ${AGE_NAMES[ULT_AGE]})`, h('br'), h('span', { class: 'muted' }, abilText(C.ultimate)))),
    h('div', { class: 'cd-sec' }, 'Unique unit'),
    h('div', { class: 'cd-row' }, img('unit', C.unique, 'ico', '#e2403a'), h('div', null, h('b', null, uq.name), ` · ${uq.role.replace('Unique · ', '')}`, h('br'), h('span', { class: 'muted' }, uq.desc))),
    h('p', { class: 'cd-quote' }, '“' + C.quotes[0] + '”'));
}
const statsCache = {};
function statsFor(key) { return statsCache[key] || (statsCache[key] = computeStats(key, 1, [])); }

function openCommanderPicker(slot, edit) {
  const KEYS = isCtf() ? HERO_KEYS : COMMANDER_KEYS;
  let cur = KEYS.includes(slot.commander) ? slot.commander : KEYS[0];
  const detail = h('div', { class: 'picker-detail' });
  const list = h('div', { class: 'picker-list' });
  const draw = () => {
    list.replaceChildren(
      ...KEYS.map((k) => h('button', { class: 'picker-item' + (k === cur ? ' on' : ''), onclick: () => { cur = k; draw(); sfx('click'); } },
        img('commander', k, 'portrait', null, 128), h('div', null, h('div', { class: 'cmd-name' }, COMMANDERS[k].name), h('div', { class: 'cmd-title' }, COMMANDERS[k].title)))),
      h('button', { class: 'picker-item', onclick: () => { edit('commander', 'random'); close(); } }, h('div', { class: 'portrait random' }, '?'), h('div', null, h('div', { class: 'cmd-name' }, 'Random'), h('div', { class: 'cmd-title' }, 'Decided when the match starts'))));
    detail.replaceChildren(commanderDetail(cur), h('button', { class: 'btn primary big', onclick: () => { edit('commander', cur); close(); } }, 'Play as ' + COMMANDERS[cur].name));
  };
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) close(); } }, h('div', { class: 'modal-box picker' }, list, detail));
  const close = () => modal.remove();
  draw();
  document.body.append(modal);
}

// ============================================================================
//  IN-GAME HUD
// ============================================================================
const BUILD_ORDER = ['house', 'pantry', 'garden', 'grill', 'sauce', 'garage', 'lab', 'workshop', 'tower', 'restaurant', 'hq', 'market'];
let card = new Array(15).fill(null), cardSig = '', selSig = '', hoverCard = -1;
let cardPage = '', cardPageSel = '';          // 'walls' while the Prep Cooks' walls & gates page is open (for the cooks it was opened for)
/** Close an open card page (Cancel does this before it deselects anything). True if there was one. */
export function cardBack() { if (!cardPage) return false; cardPage = ''; refreshCard(true); return true; }
let cardBtns = [], resEls = {}, lastSlow = 0, menuOpen = false;
const gridLabel = (i) => labelOf('card' + i);

function buildStatic() {
  // top bar
  const res = RES.map((r) => { const v = h('span', { class: 'res-v' }, '0'), inc = h('span', { class: 'res-inc' }, ''); resEls[r] = v; resEls[r + 'Inc'] = inc; const box = h('div', { class: 'res res-' + r, title: RES_INFO[r].name }, img('res', r, 'res-i', null, 64), v, inc); resEls[r + 'Box'] = box; return box; });
  resEls.tips = h('div', { class: 'res res-tips hidden', title: 'Tips: fell minions and heroes to earn them, spend them at your kitchen' }, img('res', 'tips', 'res-i', null, 64), h('span', { class: 'res-v' }, '0'), h('span', { class: 'res-inc' }, 'Tips'));
  resEls.popBox = h('div', { class: 'res', title: 'Staff (population)' }, img('res', 'pop', 'res-i', null, 64), null);
  resEls.pop = h('span', { class: 'res-v' }, '0/0');
  resEls.age = h('span', null, '');
  resEls.clock = h('span', { class: 'clock' }, '0:00');
  resEls.ping = h('span', { class: 'ping' }, '');
  const menuBtn = h('button', { class: 'btn small ghost', onclick: () => toggleMenu() }, `Menu (${labelOf('menu') || '—'})`);
  onKeysChanged(() => { menuBtn.textContent = `Menu (${labelOf('menu') || '—'})`; });
  $('topbar').replaceChildren(
    h('div', { class: 'res-group' }, ...res, resEls.tips, (resEls.popBox.append(resEls.pop), resEls.popBox)),
    h('div', { class: 'age' }, resEls.age),
    h('div', { class: 'top-right' }, resEls.clock, resEls.ping, menuBtn));

  // command card
  const cc = $('card');
  cardBtns = [];
  for (let i = 0; i < 15; i++) {
    const b = h('button', { class: 'cbtn', onmousedown: (ev) => { if (ev.button === 0) trigger(i, ev.shiftKey); ev.preventDefault(); }, onmouseenter: () => { hoverCard = i; showCardTip(); }, onmouseleave: () => { if (hoverCard === i) { hoverCard = -1; hideTip(); } } },
      h('img', { class: 'c-ico', draggable: 'false', alt: '' }), h('span', { class: 'c-key' }, gridLabel(i)), h('span', { class: 'c-badge' }));
    cardBtns.push(b); cc.append(b);
  }
  onKeysChanged(() => { cardBtns.forEach((b, i) => { b.children[1].textContent = gridLabel(i); }); heroSig = ''; turnSig = ''; });

  // chat input
  const input = $('chat-input');
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      const m = input.value.trim();
      if (m) send({ t: 'chat', m, team: input.dataset.team === '1' ? 1 : 0 });
      input.value = ''; closeChat();
    } else if (ev.key === 'Escape') { input.value = ''; closeChat(); }
  });
  input.addEventListener('blur', closeChat);
}

export function note(text, cls) {
  const box = $('msgs');
  const n = h('div', { class: 'msg ' + (cls || '') }, text);
  box.append(n);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => { n.classList.add('fade'); setTimeout(() => n.remove(), 600); }, 3800);
}

export function addChat(m) {
  const line = h('div', { class: 'chat-line' + (m.sys ? ' sys' : '') });
  if (m.sys) line.append(m.m);
  else {
    const color = m.p >= 0 && G.players[m.p] ? colorHex(G.players[m.p].color) : '#d8c8a8';
    line.append(h('b', { style: `color:${color}` }, (m.team ? '[Team] ' : '') + m.from + ': '), m.m);
  }
  if (G.phase === 'game') {
    const log = $('chatlog');
    log.append(line);
    while (log.children.length > 9) log.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 12000);
  } else {
    const log = $('lobby-chat-log');
    log.append(line);
    while (log.children.length > 80) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  if (!m.sys) sfx('chat');
}

export function openChat(team) {
  const input = $('chat-input');
  input.dataset.team = team ? '1' : '0';
  input.placeholder = team ? 'Message your team…' : `Message everyone… (Shift+${labelOf('chat') || 'Enter'} for team chat)`;
  $('chatbox').classList.remove('hidden');
  $('chatlog').classList.add('open');
  input.focus();
}
function closeChat() { $('chatbox').classList.add('hidden'); $('chatlog').classList.remove('open'); $('chat-input').blur(); }

// ------------------------------------------------------------------ tooltips
function costRow(cost, time, pop, turns) {
  const me = G.ps[G.me];
  const parts = [];
  for (const r of RES) if (cost && cost[r]) parts.push(h('span', { class: 'tt-c' + (me && me.res[r] < cost[r] ? ' lack' : '') }, img('res', G.ctf && r === 'food' ? 'tips' : r, 'tt-i', null, 64), cost[r], G.ctf && r === 'food' ? ' Tips' : ''));
  if (pop) parts.push(h('span', { class: 'tt-c' }, img('res', 'pop', 'tt-i', null, 64), pop));
  if (turns) parts.push(h('span', { class: 'tt-c time' }, turnsText(turns)));
  else if (time) parts.push(h('span', { class: 'tt-c time' }, Math.round(time) + 's'));
  return parts.length ? h('div', { class: 'tt-cost' }, ...parts) : null;
}
function statLine(S) {
  if (!S || S.hp === undefined) return null;
  const bits = [`HP ${S.hp}`];
  if (S.atk) bits.push(`Attack ${S.atk}` + (S.shots > 1 ? ` ×${S.shots}` : ''));
  if (S.heal) bits.push(`Heals ${S.heal}/s`);
  if (S.armor !== undefined) bits.push(`Armour ${S.armor}/${S.parmor}`);
  if (S.range) bits.push(`Range ${S.range}`);
  if (S.speed) bits.push(`Speed ${S.speed.toFixed(1)}`);
  return h('div', { class: 'tt-stats' }, bits.join(' · '));
}
function showTip(node, anchor) {
  const tt = $('tooltip');
  tt.replaceChildren(node);
  tt.classList.remove('hidden');
  const r = anchor.getBoundingClientRect(), w = tt.offsetWidth, hh = tt.offsetHeight;
  const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  let y = r.top - hh - 10;
  if (y < 8) y = r.bottom + 10;
  tt.style.left = x + 'px'; tt.style.top = y + 'px';
}
function hideTip() { $('tooltip').classList.add('hidden'); }
const simpleTip = (title, key, desc, hint) => h('div', null,
  h('div', { class: 'tt-title' }, title, key && h('span', { class: 'tt-key' }, key)), desc && h('div', { class: 'tt-desc' }, desc), hint && h('div', { class: 'tt-hint' }, hint));
function showCardTip() {
  const c = card[hoverCard];
  if (!c) { hideTip(); return; }
  showTip(h('div', null,
    h('div', { class: 'tt-title' }, c.title, h('span', { class: 'tt-key' }, gridLabel(hoverCard))),
    c.sub && h('div', { class: 'tt-sub' }, c.sub),
    costRow(c.cost, c.time, c.pop, c.turns),
    h('div', { class: 'tt-desc' }, c.desc),
    c.statText ? h('div', { class: 'tt-stats' }, c.statText) : statLine(c.stats),
    !c.ok && h('div', { class: 'tt-why' }, c.why),
    c.hint && h('div', { class: 'tt-hint' }, c.hint)), cardBtns[hoverCard]);
}

// --------------------------------------------------------------- command card
export const canAfford = (cost) => { const me = G.ps[G.me]; for (const r in cost) if (me.res[r] < cost[r]) return false; return true; };
const lacking = (cost) => { const me = G.ps[G.me]; return RES.filter((r) => cost[r] && me.res[r] < cost[r]).map((r) => RES_INFO[r].name); };

function bellCard(me) {
  return me.bell
    ? { icon: ['ui', 'allclear'], title: 'All clear', desc: 'Silence the bell: your Prep Cooks come out and go straight back to what they were doing.', ok: true, active: true, hint: `Hotkey from anywhere: ${labelOf('bell')}`, run: () => hooks.toggleBell() }
    : { icon: ['ui', 'bell'], title: 'Ring the bell', desc: `Every Prep Cook drops what they hold at the door and shelters inside the nearest Kitchen HQ (${BUILDINGS.hq.garrison} each), safe from harm. Every ${GARRISON_PER_SHOT} cooks inside add a plate to the HQ's volley.`, ok: true, hint: `Hotkey from anywhere: ${labelOf('bell')}`, run: () => hooks.toggleBell() };
}

function buildCard() {
  card = new Array(15).fill(null);
  if (G.me < 0 || G.over) return;
  const me = G.ps[G.me];
  if (!me || !me.alive) return;
  const sel = selected().filter((e) => e.owner === G.me);
  if (!sel.length && !G.ctf) return;
  const st = me.stats, cmdKey = G.players[G.me].commander;
  if (G.ctf) { buildCardCtf(me); return; }
  if (G.tb) { buildCardTurn(me, sel[0], st, cmdKey); return; }
  const units = sel.filter((e) => e.kind === K_UNIT), bl = sel.filter((e) => e.kind === K_BLDG);
  const stop = { icon: ['ui', 'stop'], title: 'Stop', desc: 'Drop whatever they are doing.', ok: true, run: () => hooks.stop() };
  if (units.length) {
    if (units.every((e) => e.type === 'cook')) {
      const selKey = units.map((e) => e.id).join(',');
      if (cardPage && cardPageSel !== selKey) cardPage = '';
      if (cardPage === 'walls') {                    // walls & gates: crates from the start, salt from the Diner Age
        ['wall', 'saltwall', 'gate', 'saltgate'].forEach((k, i) => {
          const S = st.bldgs[k], line = !S.gate;
          card[i] = {
            icon: ['building', k], title: S.name, sub: line ? `${Object.keys(S.cost).map((r) => S.cost[r] + ' ' + RES_INFO[r].name).join(' + ')} a block` : '', desc: S.desc, cost: S.cost,
            time: S.time / st.misc.buildMul, ok: me.age >= S.age, why: `Requires the ${AGE_NAMES[S.age]}`, stats: { hp: S.hp },
            active: G.mode && (line ? G.mode.type === 'wall' && (G.mode.b || 'wall') === k : G.mode.type === 'place' && G.mode.b === k),
            hint: line ? 'Then press where the wall starts and drag to where it ends. Hold Shift to lay several stretches.' + (k === 'saltwall' ? ' Dragged over your own crates, it replaces them.' : '')
              : 'Then click a gap in your wall, or one of your own wall blocks to swap it for the gate.',
            run: () => { G.mode = line ? { type: 'wall', b: k } : { type: 'place', b: k }; },
          };
        });
        card[14] = { icon: ['ui', 'back'], title: 'Back', desc: 'Back to the Prep Cooks\' other jobs.', hint: `${labelOf('cancel')} does the same.`, ok: true, run: () => { cardPage = ''; G.mode = null; refreshCard(true); } };
        return;
      }
      BUILD_ORDER.forEach((b, i) => {
        const S = st.bldgs[b];
        card[i] = {
          icon: ['building', b], title: S.name, desc: S.desc, cost: S.cost, time: S.time / st.misc.buildMul, ok: me.age >= S.age,
          why: `Requires the ${AGE_NAMES[S.age]}`, active: G.mode && G.mode.type === 'place' && G.mode.b === b,
          hint: 'Click to place. Hold Shift to place several.', stats: S.atk ? S : { hp: S.hp },
          run: () => { G.mode = { type: 'place', b }; },
        };
      });
      // walls and gates have a page of their own; the bell lives on the quick bar
      card[12] = { icon: ['building', me.age >= 2 ? 'saltwall' : 'wall'], title: 'Walls & gates', desc: 'Crate Walls and Swing Gates from the start; Salt Block Walls and Salt Gates (much tougher) from the Diner Age.', ok: true,
        hint: 'Opens the walls page.', run: () => { cardPage = 'walls'; cardPageSel = selKey; G.mode = null; refreshCard(true); } };
      const carrying = units.some((e) => e.carry);
      card[13] = { icon: ['ui', 'drop'], title: 'Deliver', desc: 'Carry what they are holding to the nearest drop-off right now. (Right-clicking a Kitchen HQ or Pantry does the same.)', ok: carrying, why: 'Nobody here is carrying anything', run: () => cmd({ c: 'dr', ids: units.map((e) => e.id) }) };
      card[14] = stop;
    } else {
      const army = units.filter((e) => e.type !== 'cook');
      const ids = army.map((e) => e.id);
      FORMATIONS.forEach((F, i) => {
        card[i] = { icon: ['ui', 'f_' + F.key], title: 'Formation: ' + F.name, desc: F.desc, ok: true, active: G.formation === i,
          hint: i ? 'Your army forms up now and keeps this shape on every move order.' : 'Move orders keep the group as it stands.', run: () => hooks.setFormation(i) };
      });
      card[5] = { icon: ['ui', 'attack'], title: 'Attack-move', desc: 'Then left-click a spot: your units walk there and fight anything hostile on the way.', ok: true, active: G.mode && G.mode.type === 'amove', run: () => { G.mode = { type: 'amove' }; } };
      card[6] = stop;
      STANCES.forEach((S, i) => {
        card[10 + i] = { icon: ['ui', 'st_' + S.key], title: 'Stance: ' + S.name, desc: S.desc, ok: true, active: army.every((e) => (e.sn || 0) === i), run: () => { cmd({ c: 'sn', ids, v: i }); for (const e of army) e.sn = i; } };
      });
    }
    return;
  }
  if (!bl.length) return;
  const b0 = bl[0];
  const same = bl.filter((e) => e.type === b0.type);
  if (b0.prog < 100) {
    card[14] = { icon: ['ui', 'delete'], title: 'Cancel construction', desc: 'Tear it down and refund the unbuilt share of the cost.', ok: true, run: () => cmd({ c: 'dl', ids: same.filter((e) => e.prog < 100).map((e) => e.id) }) };
    return;
  }
  const idle = () => same.filter((e) => e.prog >= 100).sort((a, c) => a.q.length - c.q.length)[0];
  let i = 0;
  for (const u of trainList(b0.type, cmdKey)) {
    const S = st.units[u];
    const queued = same.reduce((n, b) => n + b.q.filter((x) => x === 'u' + u).length, 0);
    card[i++] = {
      icon: ['unit', u], title: S.name, sub: S.role, desc: S.desc, cost: S.cost, time: S.time * st.misc.trainMul, pop: S.pop, stats: S,
      ok: me.age >= S.age, why: `Requires the ${AGE_NAMES[S.age]}`, badge: queued || '', hint: 'Shift-click to queue five.',
      run: (shift) => { const b = idle(); if (b) cmd({ c: 'tr', bid: b.id, u, n: shift ? 5 : 1 }); },
    };
  }
  let j = i === 0 ? 0 : 5;
  const last = b0.type === 'hq' ? 14 : 15;
  for (const key of BUILDINGS[b0.type].techs) {
    if (j >= last) break;
    const T = TECHS[key];
    if (me.techs.includes(key)) continue;
    if (T.req && !me.techs.includes(T.req)) continue;
    if (T.setAge && T.setAge !== me.age + 1) continue;
    const pending = me.pending.includes(key);
    card[j++] = {
      icon: ['tech', key], title: T.name, desc: T.desc, cost: techCost(key, st.misc), time: techTime(key, st.misc), pending,
      ok: !pending && (T.setAge ? true : me.age >= T.age), why: pending ? 'Already in progress' : `Requires the ${AGE_NAMES[T.age]}`,
      run: () => { const b = idle(); if (b) cmd({ c: 'rs', bid: b.id, tech: key }); },
    };
  }
  if (b0.type === 'hq') card[14] = bellCard(me);
}

/** The command card in Capture the Flag: your hero's orders on the top row, the shop below. */
function buildCardCtf(me) {
  const P = G.players[G.me], C = COMMANDERS[P.commander], kit = ctfKit(C), hero = myHero();
  const alive = !!hero, base = G.ctf.bases.find((b) => b.team === P.team);
  const atBase = !alive || (base && Math.hypot(hero.rx - base.x, hero.ry - base.y) <= CTF.shopRadius);
  const cd = Math.max(0, Math.ceil((me.abilityReady - G.tick) / G.tickRate)), ucd = Math.max(0, Math.ceil((me.ultReady - G.tick) / G.tickRate));
  const locked = G.tick < G.ctf.ultUnlock * G.tickRate;
  card[0] = { icon: ['ui', 'attack'], title: 'Attack-move', desc: 'Then left-click a spot: your hero walks there and fights anything hostile on the way.', ok: alive, why: 'Your hero is down', active: G.mode && G.mode.type === 'amove', run: () => { G.mode = { type: 'amove' }; } };
  card[1] = { icon: ['ui', 'stop'], title: 'Stop', desc: 'Stand still.', ok: alive, why: 'Your hero is down', run: () => hooks.stop() };
  card[2] = { icon: ['ability', kit.ability.key], title: kit.ability.name, sub: `Ability · ${cdText(kit.ability)}`, desc: kit.ability.desc, ok: alive && cd === 0, why: !alive ? 'Your hero is down' : `Ready in ${cd}s`, badge: cd || '', hint: `Hotkey: ${labelOf('ability')}`, run: () => cmd({ c: 'ab' }) };
  card[3] = { icon: ['ability', kit.ultimate.key], title: kit.ultimate.name, sub: `Ultimate · ${cdText(kit.ultimate, true)}`, desc: kit.ultimate.desc, ok: alive && !locked && ucd === 0, why: !alive ? 'Your hero is down' : locked ? `Ultimates unlock at ${CTF.ultUnlockMin}:00` : `Ready in ${ucd}s`, badge: locked ? '' : ucd || '', hint: `Hotkey: ${labelOf('ultimate')}`, run: () => cmd({ c: 'ul' }) };
  const ecd = Math.max(0, Math.ceil((me.energyReady - G.tick) / G.tickRate));
  card[4] = { icon: ['ui', 'energy'], title: 'Energy Bar', sub: `${CTF.energy.cost} Tips · usable anywhere`, desc: 'Wolf one down: heals 35% of your health over 4 seconds. One every 20 seconds.', cost: { food: CTF.energy.cost }, ok: alive && ecd === 0, why: !alive ? 'Your hero is down' : `Still chewing: ${ecd}s`, badge: ecd || '', run: () => cmd({ c: 'eat' }) };
  ITEM_KEYS.forEach((key, i) => {
    const it = CTF.items[key], lv = me.items[key] | 0, max = lv >= it.tiers.length, cost = ctfItemCost(key, lv);
    const now = lv ? it.tiers[lv - 1][0] : 0, next = max ? null : it.tiers[lv][0];
    const fmt = (v) => (it.stat === 'reload' ? Math.round((1 - v) * 100) + '% faster attacks' : it.stat === 'speed' ? '+' + v.toFixed(2) + ' speed' : it.stat === 'regen' ? '+' + v + ' HP/s' : it.stat === 'hp' ? '+' + v + ' HP' : it.stat === 'armor' ? '+' + v + ' armour' : '+' + v + ' attack');
    card[5 + i] = {
      icon: it.icon, title: `${it.name}${lv ? ' ' + ['I', 'II', 'III'][lv - 1] : ''}`, sub: max ? 'Fully upgraded' : `Tier ${lv + 1} of ${it.tiers.length}`,
      desc: it.desc + (lv ? ` You have: ${fmt(now)}.` : '') + (next !== null ? ` Next: ${fmt(next)}.` : ''), cost: max ? null : { food: cost },
      ok: !max && atBase, why: max ? 'Nothing more to buy here' : 'Shop at your own kitchen (or while you wait to respawn)', badge: lv ? ['I', 'II', 'III'][lv - 1] : '', pending: lv >= it.tiers.length,
      hint: atBase ? '' : 'Walk back to your kitchen to shop.', run: () => cmd({ c: 'buy', item: key }),
    };
  });
}

/** The command card in turn-based mode: one unit or station at a time, and only on your turn. */
function buildCardTurn(me, e, st, cmdKey) {
  const my = TAC.myTurn(), wait = 'Wait for your turn';
  if (e.kind === K_UNIT) {
    const f = TAC.flagsOf(e), done = !!(f & TAC.F_DONE);
    const why = (age) => (!my ? wait : done ? 'This unit is done for this turn' : `Requires the ${AGE_NAMES[age]}`);
    if (e.type === 'cook') {
      BUILD_ORDER.forEach((b, i) => {
        const S = st.bldgs[b];
        card[i] = {
          icon: ['building', b], title: S.name, desc: TB.desc[b] || S.desc, cost: S.cost, turns: tbTurns(S.time / st.misc.buildMul),
          ok: my && !done && me.age >= S.age, why: why(S.age), active: G.mode && G.mode.type === 'tplace' && G.mode.b === b, statText: tbBldgText(S),
          hint: b === 'pantry' ? 'Then click a highlighted resource within reach. Right-clicking a resource does the same.' : 'Then click a highlighted tile: the Prep Cook walks next to it and starts building.',
          run: () => { G.mode = { type: 'tplace', b }; G.tbDirty = true; },
        };
      });
    }
    card[13] = { icon: ['ui', 'next'], title: 'Next unit', desc: 'Jump to the next unit that can still do something this turn.', ok: my, why: wait, hint: `Hotkey from anywhere: ${labelOf('idle')}`, run: () => hooks.selectIdle() };
    card[14] = { icon: ['ui', 'done'], title: 'Done for this turn', desc: 'This unit stays where it is and stops asking for orders this turn.', ok: my && !done, why: why(1), run: () => TAC.wait(e) };
    return;
  }
  if (e.kind !== K_BLDG) return;
  if (e.prog < 100) {
    card[14] = { icon: ['ui', 'delete'], title: 'Cancel construction', desc: 'Tear it down and get half the cost back.', ok: my, why: wait, run: () => cmd({ c: 'dl', ids: [e.id] }) };
    return;
  }
  const busy = e.q && e.q.length > 0, whyNot = (age) => (!my ? wait : busy ? 'This station is busy: one job at a time (click the job to cancel it)' : `Requires the ${AGE_NAMES[age]}`);
  let i = 0;
  for (const u of trainList(e.type, cmdKey)) {
    const S = st.units[u];
    card[i++] = {
      icon: ['unit', u], title: S.name, sub: S.role, desc: S.desc, cost: S.cost, turns: 1, pop: S.pop, statText: tbUnitText(S),
      ok: my && !busy && me.age >= S.age, why: whyNot(S.age), badge: busy && e.q[0] === 'u' + u ? '1' : '', hint: 'Walks out at the start of your next turn.',
      run: () => cmd({ c: 'tr', bid: e.id, u }),
    };
  }
  let j = i === 0 ? 0 : 5;
  for (const key of BUILDINGS[e.type].techs) {
    if (j >= 15) break;
    const T = TECHS[key];
    if (me.techs.includes(key)) continue;
    if (T.req && !me.techs.includes(T.req)) continue;
    if (T.setAge && T.setAge !== me.age + 1) continue;
    const pending = me.pending.includes(key);
    card[j++] = {
      icon: ['tech', key], title: T.name, desc: T.desc, cost: techCost(key, st.misc), turns: tbTurns(techTime(key, st.misc)), pending,
      ok: my && !busy && !pending && (T.setAge ? true : me.age >= T.age), why: pending ? 'Already in progress' : whyNot(T.age),
      run: () => cmd({ c: 'rs', bid: e.id, tech: key }),
    };
  }
}

function trigger(i, shift) {
  buildCard();                      // the selection may have changed since the last HUD refresh
  const c = card[i];
  if (!c) return false;
  if (!c.ok) { note(c.why, 'warn'); sfx('error'); return true; }
  if (c.cost && !canAfford(c.cost)) { note(G.ctf ? 'Not enough Tips' : 'Not enough ' + lacking(c.cost).join(' and '), 'warn'); sfx('error'); return true; }
  c.run(shift);
  sfx('click');
  refreshCard(true);
  return true;
}
/** A command-card hotkey was pressed: i = button index 0..14. */
export function cardKey(i, shift) {
  if (!(i >= 0 && i < 15)) return false;
  return trigger(i, shift);
}

function refreshCard(force) {
  buildCard();
  const sig = card.map((c) => (c ? c.icon.join('.') + (c.ok ? 1 : 0) + (c.badge || '') + (c.active ? 'a' : '') + (c.pending ? 'p' : '') + (c.cost && !canAfford(c.cost) ? 'x' : '') : '-')).join('|');
  if (sig === cardSig && !force) return;
  cardSig = sig;
  const col = myColor();
  card.forEach((c, i) => {
    const b = cardBtns[i];
    if (!c) { b.className = 'cbtn none'; return; }
    b.className = 'cbtn' + (c.ok ? '' : ' locked') + (c.active ? ' active' : '') + (c.pending ? ' pending' : '') + (c.cost && !canAfford(c.cost) ? ' poor' : '') + (c.icon[0] === 'ui' ? ' glyph' : '');
    const src = iconURL(c.icon[0], c.icon[1], 96, col);
    if (b.firstChild.src !== src) b.firstChild.src = src;
    b.children[2].textContent = c.badge || '';
  });
  if (hoverCard >= 0) showCardTip();
}

// ------------------------------------------------------------ selection panel
function bar(frac, cls) {
  return h('div', { class: 'bar ' + (cls || '') }, h('div', { class: 'bar-fill', style: `width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%;background:${frac > 0.6 ? '#57d657' : frac > 0.3 ? '#f2c230' : '#ef4a3c'}` }));
}
function itemIcon(code, col) {
  return code[0] === 'u' ? iconURL('unit', code.slice(1), 96, col) : iconURL('tech', code.slice(1), 96, col);
}
const itemName = (code) => (code[0] === 'u' ? (G.ps[G.me].stats.units[code.slice(1)] || {}).name : (TECHS[code.slice(1)] || {}).name) || code;

function refreshSelection(force) {
  const sel = selected();
  const panel = $('selpanel');
  const sig = sel.length === 0 ? 'none' + G.me + (G.ctf && G.me >= 0 ? ':' + G.ps[G.me].heroId + ':' + Math.ceil((G.ps[G.me].heroRespawn - G.tick) / G.tickRate) : '')
    : sel.length === 1 ? [sel[0].id, sel[0].hp, sel[0].prog, sel[0].qpct, (sel[0].q || []).join(), sel[0].amount, sel[0].carry, sel[0].sn, sel[0].inside, sel[0].owner >= 0 ? G.ps[sel[0].owner].sig : '', sel[0].left, sel[0].qleft, G.tb ? G.tb.cur + ':' + G.tb.ended : '', sel[0].trally,
      sel[0].type === 'market' && G.me >= 0 ? G.marketAt + ':' + RES.map((r) => Math.floor(G.ps[G.me].res[r] / MARKET.lot)).join() : ''].join('|')
      : sel.map((e) => e.id + ':' + Math.ceil(e.hp / 5)).join(',');
  if (G.ctf) {                                                   // the arena keeps the screen clear: no info panel at all
    if (selSig !== 'ctf') { selSig = 'ctf'; panel.classList.add('empty'); panel.replaceChildren(); }
    return;
  }
  if (sig === selSig && !force) return;
  selSig = sig;
  // nothing selected: the panel tucks itself away
  panel.classList.toggle('empty', !sel.length);

  if (!sel.length) {
    if (G.me < 0) { panel.replaceChildren(h('div', { class: 'sel-empty' }, h('b', null, 'Spectating'), h('div', { class: 'muted' }, 'You can see the whole map. Click anything to inspect it.'))); return; }
    const C = COMMANDERS[G.players[G.me].commander];
    if (G.ctf) {
      const me = G.ps[G.me], back = Math.max(0, Math.ceil((me.heroRespawn - G.tick) / G.tickRate));
      panel.replaceChildren(h('div', { class: 'sel-one' }, img('commander', G.players[G.me].commander, 'sel-ico', null, 160),
        h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, C.name, h('span', { class: 'sel-role' }, C.title)),
          h('div', { class: 'sel-turn done' }, me.heroId ? '' : back ? `Down. Back at your kitchen in ${back}s — a good moment to shop.` : 'Returning to the kitchen…'),
          h('div', { class: 'sel-desc' }, h('b', null, kitOf(C).ability.name + ': '), kitOf(C).ability.desc),
          h('div', { class: 'muted' }, `Right-click to move or attack · ${labelOf('ability')} ability · ${labelOf('ultimate')} ultimate · ${labelOf('hero')} selects your hero (twice: jump there) · ${labelOf('follow')} locks the camera on it`))));
      return;
    }
    panel.replaceChildren(h('div', { class: 'sel-one' }, img('commander', G.players[G.me].commander, 'sel-ico', null, 160),
      h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, C.name, h('span', { class: 'sel-role' }, C.title)),
        h('ul', { class: 'sel-bonus' }, C.bonuses.map((b) => h('li', null, b))),
        h('div', { class: 'muted' }, G.tb
          ? `Click a unit, then a blue tile to move or a red enemy to attack · every unit moves once and does one thing · ${labelOf('idle')} = next unit · ${labelOf('endTurn')} ends your turn`
          : `Drag to select units · right-click to give orders · ${labelOf('hq')} jumps to your Kitchen HQ · Alt+click pings your team`))));
    return;
  }
  if (sel.length === 1) {
    const e = sel[0];
    if (e.kind === K_NODE) {
      const N = NODES[e.type];
      panel.replaceChildren(h('div', { class: 'sel-one' }, h('div', { class: 'sel-ico res-big' }, img('res', N.res, 'sel-resico', null, 128)),
        G.tb
          ? h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, N.name), h('div', null, `A Pantry built on it pays +${TAC.nodeIncome(e.type)} ${RES_INFO[N.res].name} at the start of each of your turns.`), h('div', { class: 'muted' }, 'Select a Prep Cook and right-click this resource (or use the Pantry button) to build one.'))
          : h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, N.name), h('div', null, `${e.amount} ${RES_INFO[N.res].name} left`), h('div', { class: 'muted' }, e.type === 'fish' ? 'Right-click it with Prep Cooks selected: they fish from the shore.' : 'Right-click it with Prep Cooks selected to gather.'))));
      return;
    }
    const S = statsOf(e) || {}, col = playerColor(e.owner), mh = maxHp(e), mine = e.owner === G.me;
    const camp = campOf(e);
    if (camp) {                                                  // a wild minion
      const def = CTF.camps[camp.type], bounty = Math.round(def.bounty * (1 + CTF.minion.bounty * camp.level) / (def.boss ? 1 : def.units.length));
      panel.replaceChildren(h('div', { class: 'sel-one' }, h('img', { class: 'sel-ico', src: iconURL('unit', e.type, 160, NEUTRAL_COLOR), draggable: 'false', alt: '' }),
        h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, S.name || e.type, h('span', { class: 'sel-role' }, def.name + (camp.level ? ' · level ' + (camp.level + 1) : ''))),
          h('div', { class: 'sel-hp' }, bar(e.hp / mh), h('span', null, `${Math.max(0, e.hp)} / ${mh}`)),
          h('div', { class: 'tt-stats' }, `Attack ${Math.round(S.atk * (1 + CTF.minion.atk * camp.level) * (def.atkMul || 1) * 10) / 10} · Armour ${S.armor}/${S.parmor} · Bounty ${bounty} Tips`),
          def.buff && h('div', { class: 'sel-turn' }, `Last hit wins the ${def.buffName}: ${def.buffDesc}.`),
          h('div', { class: 'sel-desc' }, def.boss ? 'The toughest customer on the map. Bring friends, or a full bag of items.' : def.buff ? 'A buff camp: one tough guardian. It comes back two minutes after it falls.' : 'Wild minions mind their own business until you hit one; then the whole camp comes for you. They heal between fights and come back a while after they are cleared.'))));
      return;
    }
    const head = h('div', { class: 'sel-name' }, S.name || e.type, h('span', { class: 'sel-role' }, e.kind === K_UNIT ? S.role : mine ? '' : G.players[e.owner].name),
      !mine && e.kind === K_UNIT && h('span', { class: 'sel-owner', style: `color:${col}` }, G.players[e.owner].name));
    const info = h('div', { class: 'sel-info' }, head, h('div', { class: 'sel-hp' }, bar(e.hp / mh), h('span', null, `${Math.max(0, e.hp)} / ${mh}`)));
    if (e.kind === K_UNIT) {
      if (G.ctf && e.type.startsWith('hero_')) {
        const p = G.ps[e.owner], tiers = ITEM_KEYS.map((k) => p.items[k] | 0);
        info.append(h('div', { class: 'tt-stats' }, `HP ${mh} · Attack ${S.atk} every ${S.reload}s · Armour ${S.armor}/${S.parmor} · Speed ${S.speed.toFixed(1)}${S.regen ? ' · Regen ' + S.regen + '/s' : ''}${S.range ? ' · Range ' + S.range : ''}`));
        const carried = G.ctf.flags.find((f) => f.state === 1 && f.carrier === e.id);
        info.append(h('div', { class: 'sel-items' },
          h('span', { class: 'items' }, ...ITEM_KEYS.map((k, i) => tiers[i] ? h('span', { class: 'item', title: CTF.items[k].name + ' ' + ['I', 'II', 'III'][tiers[i] - 1] }, h('img', { src: iconURL(CTF.items[k].icon[0], CTF.items[k].icon[1], 48, col), draggable: 'false', alt: '' }), h('b', null, ['I', 'II', 'III'][tiers[i] - 1])) : null)),
          !tiers.some(Boolean) && h('span', { class: 'muted' }, mine ? 'No items yet: fell some minions and shop at your kitchen.' : 'No items yet.'),
          carried && h('span', { class: 'sel-turn' }, `Carrying the ${G.players.find((q) => q.team === carried.team && !q.neutral)?.name || 'enemy'} flag!`)));
      } else info.append(G.tb ? h('div', { class: 'tt-stats' }, tbUnitText(S)) : statLine(S) || '');
      if (G.tb) { const stt = TAC.statusOf(e); if (stt) info.append(h('div', { class: 'sel-turn' + (TAC.flagsOf(e) & (TAC.F_DONE | TAC.F_STUN) ? ' done' : '') }, stt)); }
      if (e.type.startsWith('hero_')) {
        const C = COMMANDERS[G.players[e.owner].commander], kit = kitOf(C);
        info.append(h('div', { class: 'sel-desc' }, h('b', null, C.aura.name + ': '), abilText(C.aura)), h('div', { class: 'sel-desc' }, h('b', null, kit.ability.name + ': '), abilText(kit.ability)));
      } else info.append(h('div', { class: 'sel-desc' }, S.desc || ''));
      if (e.carry) info.append(h('div', { class: 'sel-desc' }, 'Carrying ' + RES_INFO[RES[e.carry - 1]].name + (mine ? ' — right-click a Kitchen HQ or Pantry to deliver it' : '')));
      if (mine && e.type !== 'cook' && S.atk > 0 && !G.tb && !G.ctf) info.append(h('div', { class: 'muted' }, 'Stance: ' + STANCES[e.sn || 0].name));
    } else if (e.prog < 100) {
      if (G.tb) info.append(h('div', { class: 'sel-desc' }, mine ? `Under construction: ${turnsText(e.left || 1)} left` : 'Under construction'), mine ? h('div', { class: 'muted' }, 'Right-click it with a Prep Cook to finish a turn sooner.') : '');
      else info.append(h('div', { class: 'sel-desc' }, `Under construction: ${e.prog}%`), mine ? h('div', { class: 'muted' }, 'Right-click it with Prep Cooks to speed things up.') : '');
    } else if (G.ctf && e.type === 'hq') {
      const own = G.me >= 0 && G.players[e.owner].team === G.players[G.me].team;
      info.append(h('div', { class: 'sel-desc' }, own ? 'Your kitchen. Heroes heal fast around it, you shop within a few tiles of it, and you come back here when you fall.' : 'An enemy kitchen: unbreakable, and their heroes heal fast around it. Their flag stands in front.'));
    } else if (G.tb) {
      info.append(h('div', { class: 'tt-stats' }, tbBldgText(S)));
      if (mine && e.q && e.q.length) {
        const code = e.q[0];
        info.append(h('div', { class: 'sel-desc' }, (code[0] === 'u' ? 'Training ' : 'Researching ') + itemName(code) + `: ready in ${turnsText(e.qleft || 1)}`),
          h('div', { class: 'queue' }, h('button', { class: 'q-item first', title: 'Cancel ' + itemName(code) + ' (refunds the cost)', onmousedown: (ev) => { cmd({ c: 'cq', bid: e.id, i: 0 }); sfx('click'); ev.preventDefault(); } },
            h('img', { src: itemIcon(code, col), draggable: 'false', alt: '' }))));
      } else info.append(h('div', { class: 'sel-desc' }, TB.desc[e.type] || S.desc || ''));
      if (e.pays) info.append(h('div', { class: 'sel-desc' }, h('b', null, `Pays ${RES_INFO[RES[e.pays - 1]].name} `), 'at the start of each of its owner\'s turns.'));
      if (mine && BUILDINGS[e.type].trains.length) info.append(h('div', { class: 'muted' }, e.trally ? 'Recruits walk out on the flagged side. Right-click another tile to change it (the station itself: anywhere).' : 'Right-click a tile to choose which side its recruits walk out.'));
    } else {
      if (mine && e.q && e.q.length) {
        const q = h('div', { class: 'queue' });
        e.q.forEach((code, i) => q.append(h('button', { class: 'q-item' + (i === 0 ? ' first' : ''), title: 'Cancel ' + itemName(code) + ' (refunds the cost)', onmousedown: (ev) => { cmd({ c: 'cq', bid: e.id, i }); sfx('click'); ev.preventDefault(); } },
          h('img', { src: itemIcon(code, col), draggable: 'false', alt: '' }), i === 0 && h('div', { class: 'q-prog' }, h('div', { style: `width:${e.qpct}%` })))));
        info.append(h('div', { class: 'sel-desc' }, (e.q[0][0] === 'u' ? 'Training ' : 'Researching ') + itemName(e.q[0]) + ` (${e.qpct}%)`), q);
      } else {
        if (S.atk) info.append(statLine({ hp: mh, atk: S.atk, shots: S.shots + (S.garrison ? Math.min(GARRISON_MAX_SHOTS, Math.floor((e.inside || 0) / GARRISON_PER_SHOT)) : 0), armor: S.armor, parmor: S.parmor, range: S.range }) || '');
        info.append(h('div', { class: 'sel-desc' }, S.desc || ''));
        if (mine && (BUILDINGS[e.type].trains.length)) info.append(h('div', { class: 'muted' }, 'Right-click the map to set where new units gather.'));
      }
      if (e.inside > 0) info.append(h('div', { class: 'sel-desc' }, h('b', null, `Sheltering ${e.inside} Prep Cook${e.inside === 1 ? '' : 's'}`), mine ? ' — press All clear to send them back to work' : ''));
    }
    if (mine && e.type === 'market' && e.prog >= 100) info.append(marketGrid(!G.tb || TAC.myTurn()));
    panel.replaceChildren(h('div', { class: 'sel-one' }, h('img', { class: 'sel-ico', src: iconURL(e.kind === K_UNIT ? 'unit' : 'building', e.type, 160, col), draggable: 'false', alt: '' }), info));
    return;
  }
  // many
  const grid = h('div', { class: 'sel-grid' });
  const shown = sel.slice(0, 40);
  for (const e of shown) {
    const col = e.owner >= 0 ? playerColor(e.owner) : '#999';
    grid.append(h('button', { class: 'sel-cell', title: (statsOf(e) || {}).name || e.type,
      onmousedown: (ev) => { if (ev.shiftKey) G.sel.delete(e.id); else setSelection([e]); refreshAll(true); ev.preventDefault(); } },
      h('img', { src: iconURL(e.kind === K_UNIT ? 'unit' : 'building', e.type, 96, col), draggable: 'false', alt: '' }), bar(e.hp / maxHp(e), 'mini')));
  }
  panel.replaceChildren(h('div', { class: 'sel-many' }, h('div', { class: 'sel-count' }, sel.length + ' selected' + (sel.length > 40 ? ' (showing 40)' : '')), grid));
}

/** The trading table at a Farmers Market: rows = what you hand over (100 of it), columns = what you get back. */
function marketGrid(enabled) {
  const me = G.ps[G.me], f = G.market || { food: 1, wood: 1, spice: 1, salt: 1 };
  const trade = (give, get, n) => { cmd({ c: 'mkt', give, get, n }); sfx('click'); };
  const head = h('div', { class: 'mk-row mk-head' }, h('span', { class: 'mk-lbl muted' }, `Give ${MARKET.lot} ↓   get →`),
    ...RES.map((r) => h('span', { class: 'mk-cell head', title: RES_INFO[r].name }, img('res', r, 'mk-i', null, 48))));
  const rows = RES.map((give) => h('div', { class: 'mk-row' },
    h('span', { class: 'mk-lbl' }, img('res', give, 'mk-i', null, 48), RES_INFO[give].name),
    ...RES.map((get) => {
      if (give === get) return h('span', { class: 'mk-cell none' }, '·');
      const q = marketQuote(f, give, get), poor = me.res[give] < MARKET.lot;
      return h('button', { class: 'mk-cell', disabled: !enabled || poor,
        title: !enabled ? 'Wait for your turn' : poor ? `You need ${MARKET.lot} ${RES_INFO[give].name}` : `${MARKET.lot} ${RES_INFO[give].name} → ${q} ${RES_INFO[get].name} (Shift-click: five times)`,
        onmousedown: (ev) => { if (ev.button === 0 && enabled && !poor) trade(give, get, ev.shiftKey ? 5 : 1); ev.preventDefault(); } }, '+' + q);
    })));
  return h('div', { class: 'market' }, head, ...rows,
    h('div', { class: 'muted' }, 'Prices are shared by everyone: what is sold gets cheaper, what is bought gets dearer, and they drift back. The market keeps a cut.'));
}

// ------------------------------------------------- quick bar (above the minimap)
let heroSig = '';
function refreshHero() {
  const box = $('heropanel');
  if (G.me < 0) { if (heroSig !== 'spec') { heroSig = 'spec'; box.replaceChildren(); } return; }
  const me = G.ps[G.me], P = G.players[G.me], C = COMMANDERS[P.commander], kit = kitOf(C), A = kit.ability;
  const hero = me.heroId ? G.ents.get(me.heroId) : null;
  const tb = !!G.tb, ctf = !!G.ctf, U = kit.ultimate, unit = '';
  // in a turn-based match the server counts cooldowns in turns
  const cd = tb ? me.abilityReady : Math.max(0, Math.ceil((me.abilityReady - G.tick) / G.tickRate));
  const ucd = tb ? me.ultReady : Math.max(0, Math.ceil((me.ultReady - G.tick) / G.tickRate));
  const back = hero ? 0 : tb ? me.heroRespawn : Math.max(0, Math.ceil((me.heroRespawn - G.tick) / G.tickRate));
  const idle = tb ? TAC.readyUnits().length : G.units.reduce((n, e) => n + (e.owner === G.me && e.type === 'cook' && e.st === 0 ? 1 : 0), 0);
  const lunch = !tb && G.tick < me.lunchUntil, locked = ctf ? G.tick < G.ctf.ultUnlock * G.tickRate : me.age < ULT_AGE;
  const need = ctf && me.level < CTF.level.max ? ctfLevelNeed(me.level) : 0, xpFrac = need ? Math.min(1, me.xp / need) : 1;
  const sig = [hero ? Math.ceil(hero.hp / 4) : 'x', cd, ucd, locked, back, idle, lunch, me.alive, me.bell, G.mode && G.mode.type === 'ping', tb && G.tb.cur, ctf && G.follow, ctf && me.level, ctf && Math.floor(xpFrac * 40)].join('|');
  if (sig === heroSig) return;
  heroSig = sig;
  if (!me.alive) { box.replaceChildren(); return; }
  const ready = hero && cd === 0, uready = hero && !locked && ucd === 0;
  const wait = (n) => (tb ? `in ${turnsText(n)}` : `in ${n}s`);
  const tip = (node) => ({ onmouseenter: (ev) => showTip(node(), ev.currentTarget), onmouseleave: hideTip });
  const press = (fn) => (ev) => { if (ev.button === 0) fn(ev); ev.preventDefault(); };
  box.replaceChildren(...[
    h('button', { class: 'qbtn' + (G.mode && G.mode.type === 'ping' ? ' on' : ''), onmousedown: press(() => { G.mode = { type: 'ping' }; sfx('click'); heroSig = ''; }),
      ...tip(() => simpleTip('Ping the map', labelOf('ping'), 'Then click the map or the minimap: your team sees and hears a marker there.', 'Shortcut: hold Alt and click anywhere.')) },
      img('ui', 'ping', 'q-ico', myColor())),
    ctf && h('button', { class: 'qbtn' + (G.follow ? ' on' : ''), onmousedown: press(() => { hooks.toggleFollow(); sfx('click'); heroSig = ''; }),
      ...tip(() => simpleTip(G.follow ? 'Camera follows your hero' : 'Free camera', labelOf('follow'), 'Click to switch. With the camera locked, the map scrolls with your hero.')) },
      img('ui', 'follow', 'q-ico', myColor())),
    !tb && !ctf && h('button', { class: 'qbtn' + (me.bell ? ' alarm' : ''), onmousedown: press(() => { hooks.toggleBell(); sfx('click'); }),
      ...tip(() => simpleTip(me.bell ? 'All clear' : 'Ring the bell', labelOf('bell'), me.bell ? 'Your Prep Cooks come out and go back to the jobs they had.' : 'All Prep Cooks shelter inside the nearest Kitchen HQ until you give the all-clear.')) },
      img('ui', me.bell ? 'allclear' : 'bell', 'q-ico')),
    !tb && !ctf && h('button', { class: 'qbtn', onmousedown: press(() => hooks.selectArmy()), ...tip(() => simpleTip('Select your whole army', labelOf('army'))) }, img('ui', 'attack', 'q-ico')),
    ctf ? null : tb
      ? h('button', { class: 'qbtn' + (idle ? ' warn' : ''), onmousedown: press(() => hooks.selectIdle()),
        ...tip(() => simpleTip(idle ? `${idle} unit${idle === 1 ? '' : 's'} can still act` : TAC.myTurn() ? 'Every unit has acted' : 'Waiting for your turn', labelOf('idle'), 'Click to jump to the next unit with something left to do this turn.')) },
        img('ui', 'next', 'q-ico', myColor()), idle ? h('span', { class: 'q-badge' }, idle) : null)
      : h('button', { class: 'qbtn' + (idle ? ' warn' : ''), onmousedown: press(() => hooks.selectIdle()),
        ...tip(() => simpleTip(idle ? `${idle} idle Prep Cook${idle === 1 ? '' : 's'}` : 'No idle Prep Cooks', labelOf('idle'), 'Click to select the next one.')) },
        img('unit', 'cook', 'q-ico', myColor()), idle ? h('span', { class: 'q-badge' }, idle) : null),
    h('button', { class: 'qbtn abil ult' + (uready ? ' ready' : '') + (locked ? ' locked' : ''),
      onmousedown: press(() => {
        if (uready && (!tb || TAC.myTurn())) { cmd({ c: 'ul' }); sfx('click'); }
        else { note(locked ? (ctf ? `${U.name} unlocks at ${CTF.ultUnlockMin}:00` : `${U.name} unlocks in the ${AGE_NAMES[ULT_AGE]}`) : !hero ? 'Your commander is down' : ucd > 0 ? `${U.name} is ready ${wait(ucd)}` : 'Wait for your turn', 'warn'); sfx('error'); }
      }),
      ...tip(() => h('div', null, h('div', { class: 'tt-title' }, U.name, h('span', { class: 'tt-key' }, labelOf('ultimate'))), h('div', { class: 'tt-sub' }, `Ultimate · ${cdText(U, true)}`), h('div', { class: 'tt-desc' }, abilText(U)),
        locked && h('div', { class: 'tt-why' }, ctf ? `Unlocks at ${CTF.ultUnlockMin}:00` : `Unlocks in the ${AGE_NAMES[ULT_AGE]}`))) },
      img('ability', U.key, 'q-ico'), locked ? img('ui', 'lock', 'q-lock') : !uready && hero ? h('span', { class: 'q-cd' }, ucd + unit) : null),
    h('button', { class: 'qbtn abil' + (ready ? ' ready' : '') + (lunch ? ' lit' : ''),
      onmousedown: press(() => { if (ready && (!tb || TAC.myTurn())) { cmd({ c: 'ab' }); sfx('click'); } else { note(!hero ? 'Your commander is down' : cd > 0 ? `${A.name} is ready ${wait(cd)}` : 'Wait for your turn', 'warn'); sfx('error'); } }),
      ...tip(() => h('div', null, h('div', { class: 'tt-title' }, A.name, h('span', { class: 'tt-key' }, labelOf('ability'))), h('div', { class: 'tt-sub' }, `Commander ability · ${cdText(A)}`), h('div', { class: 'tt-desc' }, abilText(A)), h('div', { class: 'tt-hint' }, `Aura · ${C.aura.name}: ${abilText(C.aura)}`))) },
      img('ability', A.key, 'q-ico'), !ready && hero ? h('span', { class: 'q-cd' }, cd + unit) : null),
    h('button', { class: 'qbtn hero' + (hero ? '' : ' down'), onmousedown: press((ev) => hooks.selectHero(ev.detail > 1)),
      ...tip(() => ctf
        ? simpleTip(`${C.name} · level ${me.level}`, labelOf('hero'), (hero ? `${Math.max(0, Math.round(hero.hp))} / ${maxHp(hero)} health. ` : `Back at your kitchen ${wait(back)}: a good moment to shop. `)
          + (need ? `${Math.floor(me.xp)} / ${need} XP to level ${me.level + 1}. XP comes in every second, and faster for minions, takedowns and captures.` : 'Top level reached.'), 'Double-click to jump there.')
        : simpleTip(C.name, labelOf('hero'), hero ? 'Click to select your commander; double-click to jump there.' : `Back at the Kitchen HQ ${wait(back)}.`)) },
      img('commander', P.commander, 'q-ico', null, 96), hero ? bar(hero.hp / maxHp(hero), 'mini') : h('span', { class: 'q-cd' }, back || '…'),
      ctf && h('span', { class: 'q-lvl', title: 'Hero level' }, me.level),
      ctf && h('span', { class: 'q-xp' }, h('i', { style: `width:${Math.round(xpFrac * 100)}%` })))].filter(Boolean));
}

// -------------------------------------------------------------------- top bar
function refreshTop() {
  if (G.ctf) {                                                   // capture the flag: Tips, the clock and the score
    const me = G.me >= 0 ? G.ps[G.me] : null, t = me ? String(me.res.food) : '–';
    if (resEls.tips.children[1].textContent !== t) resEls.tips.children[1].textContent = t;
    const left = Math.max(0, G.ctf.timeLimit - G.tick / G.tickRate);
    const clock = (G.ctf.sudden ? 'SUDDEN DEATH ' : left > 0 ? fmtClock(left) + ' left' : '') + (G.paused ? '  PAUSED' : '');
    if (resEls.clock.textContent !== clock) resEls.clock.textContent = clock;
    const age = G.me < 0 ? 'Spectating' : `${COMMANDERS[G.players[G.me].commander].name}`;
    if (resEls.age.textContent !== age) resEls.age.textContent = age;
    const ping = G.net && G.net.ping ? Math.round(G.net.ping) + ' ms' : '';
    if (resEls.ping.textContent !== ping) resEls.ping.textContent = ping;
    return;
  }
  if (G.me >= 0) {
    const me = G.ps[G.me];
    RES.forEach((r, i) => {
      const t = String(me.res[r]); if (resEls[r].textContent !== t) resEls[r].textContent = t;
      const inc = G.tb ? '+' + (me.income[i] || 0) : ''; if (resEls[r + 'Inc'].textContent !== inc) resEls[r + 'Inc'].textContent = inc;       // turn-based: what the next turn pays
    });
    const pop = `${me.pop}/${me.cap}`;
    if (resEls.pop.textContent !== pop) { resEls.pop.textContent = pop; resEls.pop.classList.toggle('full', me.pop >= me.cap); }
    const researching = me.pending.find((k) => k.startsWith('age'));
    const age = `${AGE_SHORT[me.age]} · ${AGE_NAMES[me.age]}` + (researching ? '  →  advancing…' : '');
    if (resEls.age.textContent !== age) resEls.age.textContent = age;
  } else if (resEls.age.textContent !== 'Spectating') { resEls.age.textContent = 'Spectating'; for (const r of RES) { resEls[r].textContent = '–'; resEls[r + 'Inc'].textContent = ''; } resEls.pop.textContent = '–'; }
  const secs = Math.floor(G.tick / G.tickRate);
  const clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + (G.paused ? '  PAUSED' : '');
  if (resEls.clock.textContent !== clock) resEls.clock.textContent = clock;
  const ping = G.net && G.net.ping ? Math.round(G.net.ping) + ' ms' : '';
  if (resEls.ping.textContent !== ping) resEls.ping.textContent = ping;
}

// --------------------------------------------------------------- player list
let plSig = '';
function refreshPlayers() {
  const list = realPlayers();
  const sig = list.map(([p, i]) => p.name + G.ps[i].age + G.ps[i].alive + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '+' : '') + (G.ctf ? G.ps[i].caps + ':' + G.ps[i].heroKills + ':' + G.ps[i].deaths + ':' + G.ps[i].level + (G.ps[i].heroId ? '' : 'x') : '')).join('|') + (G.tb ? G.tb.cur + ':' + G.tb.team + ':' + G.tb.ended : '');
  if (sig === plSig) return;
  plSig = sig;
  const teams = new Set(list.map(([p]) => p.team)).size;
  if (G.ctf) {
    const sorted = list.slice().sort((a, b) => a[0].team - b[0].team || b[1] - a[1]);
    $('players').replaceChildren(...sorted.map(([p, i]) => h('div', { class: 'pl' + (G.ps[i].alive ? '' : ' out') + (i === G.me ? ' me' : '') + (G.ps[i].heroId ? '' : ' down'), style: `border-color:${teamHex(p.team)}` },
      h('span', { class: 'dot', style: `background:${colorHex(p.color)}` }),
      h('span', { class: 'pl-name' }, p.name),
      h('span', { class: 'pl-team', title: COMMANDERS[p.commander].name }, COMMANDERS[p.commander].title),
      h('span', { class: 'pl-lvl', title: 'Hero level' }, 'Lv ' + G.ps[i].level),
      h('span', { class: 'pl-age', title: 'captures · hero kills / deaths' }, `${G.ps[i].caps}⚑ ${G.ps[i].heroKills || 0}/${G.ps[i].deaths}`))));
    return;
  }
  $('players').replaceChildren(...list.map(([p, i]) => h('div', { class: 'pl' + (G.ps[i].alive ? '' : ' out') + (i === G.me ? ' me' : '') + (G.tb && TAC.playing(i) && !TAC.ended(i) && !G.over ? ' turn' : '') },
    h('span', { class: 'dot', style: `background:${colorHex(p.color)}` }),
    h('span', { class: 'pl-name' }, p.name),
    teams < list.length && h('span', { class: 'pl-team' }, 'T' + p.team),
    h('span', { class: 'pl-age', title: COMMANDERS[p.commander].name + ' · ' + AGE_NAMES[G.ps[i].age] }, G.ps[i].alive ? AGE_SHORT[G.ps[i].age] + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '↑' : '') : 'out'))));
}

// ------------------------------------------------- turn bar (turn-based matches)
let turnSig = '';
function refreshTurn() {
  const box = $('turnbar');
  if (!G.tb) { if (turnSig !== 'off') { turnSig = 'off'; box.classList.add('hidden'); box.replaceChildren(); } return; }
  const tb = G.tb, P = G.players[tb.cur], my = TAC.myTurn(), team = tb.team >= 0;
  const left = tb.deadline && !G.over ? Math.max(0, Math.ceil((tb.deadline - G.tick) / (G.tickRate * (Number(G.opts.speed) || 1)))) : -1;
  const n = my ? TAC.readyUnits().length : 0;
  const sig = [tb.n, tb.cur, tb.team, tb.ended, left, n, G.over ? 1 : 0, my, G.paused].join('|');
  if (sig === turnSig) return;
  if (my && left === 10 && !turnSig.startsWith('off')) { note('10 seconds left in your turn', 'warn'); sfx('turn_other'); }
  turnSig = sig;
  box.classList.remove('hidden'); box.classList.toggle('mine', my);
  box.replaceChildren(...[
    h('span', { class: 'tb-round' }, 'Round ' + tb.n + (tb.limit ? ' of ' + tb.limit : '')),
    h('span', { class: 'dot', style: `background:${colorHex(P.color)}` }),
    h('span', { class: 'tb-who' }, G.over ? 'Match over' : team
      ? (my ? "Your team's turn" : TAC.playing(G.me) ? 'Waiting for your team-mates…' : `${realPlayers().filter(([q]) => q.team === tb.team).map(([q]) => q.name).join(' & ')} ${realPlayers().filter(([q]) => q.team === tb.team).length > 1 ? 'are' : 'is'} playing…`)
      : my ? 'Your turn' : tb.cur === G.me ? 'Your turn' : `${P.name}${P.bot ? ' (bot)' : ''} is playing…`),
    left >= 0 && h('span', { class: 'tb-time' + (left <= 10 ? ' low' : '') }, fmtTime(left)),
    my && h('span', { class: 'tb-left' }, n ? `${n} unit${n === 1 ? '' : 's'} can still act` : 'everyone has acted'),
    my && h('button', { class: 'btn small primary', title: 'Hand over to the next kitchen', onmousedown: (ev) => { if (ev.button === 0 && TAC.endTurn()) sfx('endturn'); ev.preventDefault(); } }, `End turn (${labelOf('endTurn')})`)].filter(Boolean));
}

// ------------------------------------------------- score bar (capture the flag)
let scoreSig = '';
const teamLabel = (team) => { const p = G.players.find((q) => q.team === team && !q.neutral); return p ? (realPlayers().filter(([q]) => q.team === team).length > 1 ? PLAYER_COLORS[p.color % PLAYER_COLORS.length].name : p.name) : 'Team ' + team; };
function refreshScore() {
  const box = $('scorebar');
  if (!G.ctf) { if (scoreSig !== 'off') { scoreSig = 'off'; box.classList.add('hidden'); box.replaceChildren(); } return; }
  const list = realPlayers(), teams = [...new Set(list.map(([p]) => p.team))];
  const capsOf = (t) => G.ctf.caps[t] || 0;
  const alive = (t) => list.some(([p, i]) => p.team === t && G.ps[i].alive);
  const left = Math.max(0, G.ctf.timeLimit - G.tick / G.tickRate);
  const me = G.me >= 0 ? G.ps[G.me] : null, back = me && me.alive && !me.heroId ? Math.max(0, Math.ceil((me.heroRespawn - G.tick) / G.tickRate)) : -1;
  const sig = teams.map((t) => t + ':' + capsOf(t) + (alive(t) ? '' : 'x')).join('|') + '|' + (G.ctf.sudden ? 'S' : Math.ceil(left)) + '|' + G.ctf.lvl + '|' + (G.over ? 1 : 0) + '|' + back;
  if (sig === scoreSig) return;
  scoreSig = sig;
  const myT = G.me >= 0 ? G.players[G.me].team : -1;
  const ffa = teams.length === list.length && list.length > 2;
  const chip = (t) => h('span', { class: 'sc-team' + (t === myT ? ' mine' : '') + (alive(t) ? '' : ' out'), style: `border-color:${teamHex(t)}` },
    h('span', { class: 'dot', style: `background:${teamHex(t)}` }), h('span', { class: 'sc-name' }, teamLabel(t)), h('b', { class: 'sc-caps' }, String(capsOf(t))));
  const order = teams.slice().sort((a, b) => capsOf(b) - capsOf(a) || a - b);
  const kids = [];
  if (teams.length === 2) {                                        // the classic read-out: Red 1 – 0 Blue
    const [a, b] = teams;
    kids.push(chip(a), h('span', { class: 'sc-vs' }, 'first to ' + G.ctf.capsToWin), chip(b));
  } else if (ffa) {                                                 // free for all: the top three, plus you
    const top = order.slice(0, 3); if (myT >= 0 && !top.includes(myT)) top.push(myT);
    kids.push(h('span', { class: 'tb-round' }, 'First to ' + G.ctf.capsToWin), ...top.map(chip));
  } else kids.push(h('span', { class: 'tb-round' }, 'First to ' + G.ctf.capsToWin), ...order.map(chip));
  kids.push(h('span', { class: 'tb-time' + (G.ctf.sudden || left <= 60 ? ' low' : '') }, G.over ? 'Match over' : G.ctf.sudden ? 'SUDDEN DEATH · next capture wins' : fmtClock(left)));
  if (G.ctf.lvl) kids.push(h('span', { class: 'tb-left', title: 'Wild minions grow tougher (and richer) every few minutes' }, 'minions lv ' + (G.ctf.lvl + 1)));
  if (back >= 0 && !G.over) kids.push(h('span', { class: 'tb-time low', title: 'Shop while you wait' }, back ? `You're down · back in ${back}s` : 'Back on your feet…'));
  box.classList.remove('hidden');
  box.replaceChildren(...kids);
}

export function refreshAll(force) {
  refreshSelection(force);
  refreshCard(force);
}

/** Called every frame; does the cheap bits each time and the heavier ones ~8x per second. */
export function updateHUD(now, force) {
  if (!force && now - lastSlow < 120) return;
  lastSlow = now;
  refreshTop();
  refreshHero();
  refreshTurn();
  refreshScore();
  refreshPlayers();
  refreshSelection(force);
  refreshCard(force);
  document.body.classList.toggle('placing', !!G.mode);
}

export function resetHUD() {
  cardSig = selSig = heroSig = plSig = turnSig = scoreSig = '';
  document.body.classList.toggle('tb', !!G.tb);
  document.body.classList.toggle('ctf', !!G.ctf);
  resEls.tips.classList.toggle('hidden', !G.ctf);
  for (const r of RES) resEls[r + 'Box'].classList.toggle('hidden', !!G.ctf);
  resEls.popBox.classList.toggle('hidden', !!G.ctf);
  $('chatlog').replaceChildren(); $('msgs').replaceChildren();
  closeOver(); toggleMenu(false);
  updateHUD(0, true);
}

// ----------------------------------------------------------------------- menu
const store = {
  get(k) { try { return localStorage.getItem('chefdoms.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('chefdoms.' + k, v); } catch { /* private mode */ } },
};
/** In full screen, ask the browser to hand Esc to the game instead of leaving full screen (Chrome and Edge, on localhost or https:
 *  holding Esc still leaves). Elsewhere F11 gives a full screen that Esc does not close. */
async function lockEscape() {
  try { if (document.fullscreenElement && navigator.keyboard && navigator.keyboard.lock) { await navigator.keyboard.lock(['Escape']); return true; } } catch { /* not allowed here */ }
  return false;
}
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) lockEscape().then((ok) => { if (!ok) note('Tip: in this browser Esc leaves full screen. F11 gives you a full screen that Esc cannot close.', 'warn'); }); });
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => note('This browser would not go full screen (try F11)', 'warn'));
  } catch { /* not supported */ }
}

export function toggleMenu(force) {
  const want = force === undefined ? !menuOpen : force;
  if (want === menuOpen) return false;
  menuOpen = want;
  const old = $('menu');
  if (old) old.remove();
  if (!want) return true;
  const host = G.cid === G.hostId, playing = G.me >= 0 && G.ps[G.me] && G.ps[G.me].alive && !G.over;
  const modal = h('div', { class: 'modal', id: 'menu', onmousedown: (ev) => { if (ev.target === modal) toggleMenu(false); } },
    h('div', { class: 'modal-box menu' },
      h('h2', null, 'Menu'),
      h('button', { class: 'btn', onclick: () => toggleMenu(false) }, 'Back to the kitchen'),
      soundControls(),
      h('div', { class: 'sound-box' }, ...mouseControls(false)),
      h('button', { class: 'btn', onclick: () => { toggleMenu(false); showControls(); } }, 'Controls & hotkeys'),
      h('button', { class: 'btn', onclick: () => { toggleFullscreen(); toggleMenu(false); } }, document.fullscreenElement ? 'Leave full screen' : 'Full screen (best for edge scrolling)'),
      host && !G.over && h('button', { class: 'btn', onclick: () => { send({ t: 'pause' }); toggleMenu(false); } }, G.paused ? 'Resume match' : 'Pause match'),
      G.over && h('button', { class: 'btn', onclick: () => { toggleMenu(false); showOver(G.over); } }, 'Show the scores again'),
      playing && h('button', { class: 'btn danger', onclick: () => { if (confirmTwice(modal.querySelector('.danger'), 'Really resign?')) { cmd({ c: 'rg' }); toggleMenu(false); } } }, 'Resign'),
      (host || G.over) && h('button', { class: 'btn danger', id: 'btn-end', onclick: (ev) => { if (G.over || confirmTwice(ev.target, 'End the match for everyone?')) { send({ t: 'end' }); toggleMenu(false); } } }, 'Return everyone to the lobby'),
      h('div', { class: 'muted', style: 'text-align:center' }, 'Chefdoms v' + VERSION)));
  document.body.append(modal);
  return true;
}
function confirmTwice(btn, text) {
  if (btn.dataset.armed === '1') return true;
  btn.dataset.armed = '1'; btn.textContent = text + ' Click again.';
  setTimeout(() => { btn.dataset.armed = '0'; }, 4000);
  return false;
}

/** Zoom sensitivity and double-click selection: in the menu and in Controls (both read and write the same setting). */
function mouseControls(wide) {
  let dbl = store.get('dblSelect') !== '0';
  const zsens = Number(store.get('zoomSens')) || 1;
  const pct = h('b', { class: 'vol-val' }, Math.round(zsens * 100) + '%');
  return [
    h('label', { class: 'vol' + (wide ? ' wide' : ''), title: 'How far one notch of the mouse wheel (or a zoom key) zooms' }, h('span', null, wide ? 'Zoom sensitivity' : 'Zoom'),
      h('input', { type: 'range', min: '20', max: '300', step: '10', value: String(Math.round(zsens * 100)), oninput: (ev) => { store.set('zoomSens', String(ev.target.value / 100)); hooks.setZoomSens(ev.target.value / 100); pct.textContent = ev.target.value + '%'; } }), pct),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: dbl ? '' : null, onchange: (ev) => { dbl = ev.target.checked; store.set('dblSelect', dbl ? '1' : '0'); hooks.setDblSelect(dbl); } }),
      h('span', null, h('b', null, 'Double-click selects all of a type'), wide ? [h('br'), h('span', { class: 'muted' }, 'Double-clicking a Prep Cook (or any unit or station) picks up every one of them on screen. Ctrl+click still does it when this is off.')] : null)),
  ];
}

function soundControls() {
  const slider = (label, get, set, test) => h('label', { class: 'vol' }, h('span', null, label),
    h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(get() * 100)), oninput: (ev) => { set(ev.target.value / 100); }, onchange: () => { if (test) sfx('built'); } }));
  const nowPlaying = h('div', { class: 'muted nowplaying' }, '');
  const upd = () => { if (!nowPlaying.isConnected) { clearInterval(iv); return; } const n = music.now(); nowPlaying.textContent = isMuted() ? 'Muted' : n ? '♪ ' + n : ''; };
  const iv = setInterval(upd, 500);
  setTimeout(upd, 0);
  return h('div', { class: 'sound-box' },
    slider('Effects', getSfxVolume, setSfxVolume, true),
    slider('Music', getMusicVolume, setMusicVolume, false),
    h('div', { class: 'row' },
      h('button', { class: 'btn small ghost', onclick: (ev) => { setMuted(!isMuted()); ev.target.textContent = isMuted() ? 'Unmute everything' : 'Mute everything'; } }, isMuted() ? 'Unmute everything' : 'Mute everything'),
      h('button', { class: 'btn small ghost', title: 'Skip to another piece', onclick: () => music.skip() }, 'Next track')),
    nowPlaying);
}

export function showSound() {
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal-box menu' }, h('h2', null, 'Sound & music'), soundControls(),
      h('p', { class: 'muted' }, 'Hosting? Drop your own tracks into the game\'s public/music folder and your own effects into public/sfx to replace the built-in ones.'),
      h('button', { class: 'btn primary', onclick: () => modal.remove() }, 'Done')));
  document.body.append(modal);
}

// --------------------------------------------------------- controls & hotkeys
export function showControls() {
  let listening = null;             // action id waiting for a key press
  const body = h('div', { class: 'keys-body' });
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) close(); } },
    h('div', { class: 'modal-box help' }, h('h2', null, 'Controls & hotkeys'), body));
  const onKey = (ev) => {
    if (!listening) return;
    ev.preventDefault(); ev.stopPropagation();
    const id = listening;
    if (/^(Shift|Control|Alt)(Left|Right)$/.test(ev.code)) return;          // (modifiers alone: wait for the real key)
    if (canBind(ev.code)) setKey(id, ev.code);
    else { note('The browser keeps that key for itself', 'warn'); return; }
    listening = null; modal.classList.remove('keys-open');
    draw();
  };
  const close = () => { window.removeEventListener('keydown', onKey, true); modal.remove(); };
  window.addEventListener('keydown', onKey, true);

  const keyBtn = (id) => h('button', { class: 'keybtn' + (listening === id ? ' wait' : '') + (keyOf(id) ? '' : ' unset'), title: 'Click, then press the new key (any key at all). Click again to cancel; right-click to leave it without a key.',
    onclick: () => { listening = listening === id ? null : id; modal.classList.toggle('keys-open', !!listening); draw(); },
    oncontextmenu: (ev) => { ev.preventDefault(); setKey(id, ''); listening = null; modal.classList.remove('keys-open'); draw(); } }, listening === id ? 'press a key…' : keyLabel(keyOf(id)) || '—');
  const draw = () => {
    const mouse = [
      ['Left-click / drag', 'Select a unit or box-select your army (double-click: all of that type on screen)'],
      ['Right-click', 'Smart order: move, attack, gather, build / repair, deliver to a Kitchen HQ or Pantry, or set a station\'s rally point'],
      ['Shift + order', 'Queue the order after the current one'],
      ['Alt + click', 'Ping that spot for your team (works on the minimap too)'],
      ['Screen edge · middle-drag', 'Move the camera · mouse wheel zooms · click the minimap to jump'],
      ['Ctrl or Shift + a group key', 'Save a control group · the key alone recalls it (twice: jump there)'],
    ];
    const turnRows = [
      ['Left-click', 'Select a unit or station · click a blue tile to move there · click a red enemy to attack it'],
      ['Right-click', 'Move or attack · a Barista tops up a friend · a Prep Cook repairs a station, helps on a building site, or builds a Pantry on a resource'],
      ['Each turn', 'Every unit may move once and then do one thing; attacking ends its turn, and the enemy hits back if it can reach. Catapults cannot move and fire in the same turn.'],
    ];
    const group = (name) => ACTIONS.filter((a) => a.group === name);
    const rows = (name) => h('table', { class: 'keytable' }, group(name).map((a) => h('tr', null, h('td', null, a.label), h('td', { class: 'kc' }, keyBtn(a.id)))));
    let edge = store.get('edge') !== '0';
    const speed = Number(store.get('camSpeed')) || 1;
    body.replaceChildren(
      h('div', { class: 'keys-cols' },
        h('div', null,
          h('h3', null, 'Camera'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: isWasd() ? '' : null, onchange: (ev) => { setWasd(ev.target.checked); listening = null; draw(); refreshCard(true); } }),
            h('span', null, h('b', null, 'W A S D moves the camera'), h('br'), h('span', { class: 'muted' }, 'The command card then uses Q E R T Y / F G H J K / Z X C V B.'))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: edge ? '' : null, onchange: (ev) => { edge = ev.target.checked; store.set('edge', edge ? '1' : '0'); hooks.setEdgeScroll(edge); } }),
            h('span', null, h('b', null, 'Edge scrolling'), h('br'), h('span', { class: 'muted' }, 'Push the pointer against a window edge to scroll. Full screen makes this much nicer.'))),
          h('label', { class: 'vol wide' }, h('span', null, 'Camera speed'),
            h('input', { type: 'range', min: '50', max: '220', step: '10', value: String(Math.round(speed * 100)), oninput: (ev) => { store.set('camSpeed', String(ev.target.value / 100)); hooks.setCamSpeed(ev.target.value / 100); } })),
          ...mouseControls(true),
          rows('Camera'),
          h('h3', null, 'Command card'),
          h('div', { class: 'keygrid' }, group('Command card').map((a) => keyBtn(a.id))),
          h('div', { class: 'muted' }, 'Same layout as the buttons at the bottom left of the screen.'),
          h('h3', null, 'Turn-based matches'),
          h('table', { class: 'keytable fixed' }, turnRows.map((r) => h('tr', null, h('td', { class: 'k' }, r[0]), h('td', null, r[1]))))),
        h('div', null,
          h('h3', null, 'Commands'), rows('Commands'),
          h('h3', null, 'Control groups'), h('div', { class: 'keygrid groups' }, group('Control groups').map((a) => h('label', { class: 'grpkey' }, h('span', null, a.label.replace('Control group ', '')), keyBtn(a.id)))),
          h('h3', null, 'Mouse and fixed keys'),
          h('table', { class: 'keytable fixed' }, mouse.map((r) => h('tr', null, h('td', { class: 'k' }, r[0]), h('td', null, r[1])))))),
      h('p', { class: 'muted' }, 'Every key can be changed: click it, then press the new one (right-click: no key). A key can only do one thing: giving it to another action takes it away from the old one. Goal of the game: destroy every enemy Kitchen HQ (or every station, if the host picked Conquest).'),
      h('div', { class: 'over-btns' },
        h('button', { class: 'btn', onclick: () => { resetKeys(); listening = null; draw(); } }, 'Reset keys to defaults'),
        h('button', { class: 'btn primary', onclick: close }, 'Done')));
  };
  draw();
  document.body.append(modal);
}
export const showHelp = showControls;

// ------------------------------------------------------------------ game over
const fmtTime = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
// One marker shape per player, so a line is never identified by colour alone.
const SHAPES = [
  (r) => `M${-r},0A${r},${r} 0 1,0 ${r},0A${r},${r} 0 1,0 ${-r},0Z`,
  (r) => `M${-r},${-r}H${r}V${r}H${-r}Z`,
  (r) => `M0,${-r * 1.15}L${r * 1.1},${r * 0.85}H${-r * 1.1}Z`,
  (r) => `M0,${-r * 1.25}L${r * 1.25},0L0,${r * 1.25}L${-r * 1.25},0Z`,
  (r) => `M0,${r * 1.15}L${r * 1.1},${-r * 0.85}H${-r * 1.1}Z`,
  (r) => { const a = r * 0.42, b = r * 1.15; return `M${-a},${-b}H${a}V${-a}H${b}V${a}H${a}V${b}H${-a}V${a}H${-b}V${-a}H${-a}Z`; },
  (r) => { let d = ''; for (let i = 0; i < 10; i++) { const R = i % 2 ? r * 0.55 : r * 1.3, an = -Math.PI / 2 + i * Math.PI / 5; d += (i ? 'L' : 'M') + (Math.cos(an) * R).toFixed(2) + ',' + (Math.sin(an) * R).toFixed(2); } return d + 'Z'; },
  (r) => { let d = ''; for (let i = 0; i < 6; i++) { const an = i * Math.PI / 3; d += (i ? 'L' : 'M') + (Math.cos(an) * r * 1.15).toFixed(2) + ',' + (Math.sin(an) * r * 1.15).toFixed(2); } return d + 'Z'; },
];
const marker = (i, r, color, extra) => s('path', { d: SHAPES[i % SHAPES.length](r), fill: color, ...extra });
const keySwatch = (i, color) => { const g = s('svg', { width: 26, height: 14, viewBox: '0 0 26 14', class: 'ch-key' }, s('line', { x1: 1, y1: 7, x2: 25, y2: 7, stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round' })); g.append(marker(i, 4, color, { transform: 'translate(13,7)', stroke: '#2a1d17', 'stroke-width': 1.5 })); return g; };

const METRICS = [
  ['score', 'Score'], ['army', 'Army size'], ['pop', 'Staff'], ['gathered', 'Ingredients gathered'], ['kills', 'Units defeated'],
];

/** Line chart of one statistic over the match, one line per player. */
function timelineChart(m) {
  const tl = m.timeline, players = m.summary, rounds = tl.unit === 'turn';
  const metrics = METRICS.map(([k, n]) => [k, (tl.labels || {})[k] || n]);
  const when = (t) => (rounds ? 'Round ' + t : fmtTime(t));
  let metric = 'score', asTable = false, focus = -1;
  const wrap = h('div', { class: 'chart' });
  const niceMax = (v) => { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const lastIdx = (p) => { const out = players[p].outAt; if (!out) return tl.t.length - 1; let k = 0; while (k + 1 < tl.t.length && tl.t[k + 1] <= out) k++; return k; };   // a line stops when its player is knocked out

  const draw = () => {
    const data = tl.series[metric];
    const W = 760, H = 300, L = 54, R = players.length <= 4 ? 118 : 20, T = 14, B = 30;
    const tMax = Math.max(1, tl.t[tl.t.length - 1]);
    let vMax = 0;
    for (const row of data) for (const v of row) if (v > vMax) vMax = v;
    vMax = niceMax(vMax);
    const X = (t) => L + (t / tMax) * (W - L - R), Y = (v) => H - B - (v / vMax) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-svg', role: 'img', 'aria-label': metrics.find((x) => x[0] === metric)[1] + (rounds ? ' by round' : ' over time') + ', one line per player' });
    for (let i = 0; i <= 4; i++) {                              // recessive horizontal grid + value labels
      const v = (vMax / 4) * i, y = Y(v);
      svg.append(s('line', { x1: L, y1: y, x2: W - R, y2: y, class: i ? 'ch-grid' : 'ch-axis' }));
      const tx = s('text', { x: L - 8, y: y + 4, class: 'ch-tick', 'text-anchor': 'end' }); tx.textContent = fmtNum(v); svg.append(tx);
    }
    if (rounds) {
      const step = [1, 2, 5, 10, 20, 50].find((x) => tMax / x <= 10) || 100;
      for (let r = 0; r <= tMax; r += step) { const tx = s('text', { x: X(r), y: H - B + 18, class: 'ch-tick', 'text-anchor': 'middle' }); tx.textContent = r ? String(r) : 'round 0'; svg.append(tx); }
    } else {
      const stepMin = [1, 2, 5, 10, 15, 20, 30].find((x) => tMax / 60 / x <= 8) || 60;
      for (let mm = 0; mm * 60 <= tMax; mm += stepMin) {
        const tx = s('text', { x: X(mm * 60), y: H - B + 18, class: 'ch-tick', 'text-anchor': 'middle' }); tx.textContent = mm + ' min'; svg.append(tx);
      }
    }
    const ends = [];
    players.forEach((p, i) => {
      const col = colorHex(p.color), n = lastIdx(i);
      let d = '';
      for (let k = 0; k <= n; k++) d += (k ? 'L' : 'M') + X(tl.t[k]).toFixed(1) + ',' + Y(data[i][k]).toFixed(1);
      const dim = focus >= 0 && focus !== i;
      const g = s('g', { opacity: dim ? 0.22 : 1 });
      g.append(s('path', { d, fill: 'none', stroke: col, 'stroke-width': focus === i ? 3 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const ex = X(tl.t[n]), ey = Y(data[i][n]);
      g.append(marker(i, 4.5, col, { transform: `translate(${ex.toFixed(1)},${ey.toFixed(1)})`, stroke: '#2a1d17', 'stroke-width': 2 }));
      svg.append(g);
      ends.push({ i, y: ey, v: data[i][n], name: p.name });
    });
    if (players.length <= 4) {                                   // few lines: name them where they end
      ends.sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
      for (const e of ends) { const tx = s('text', { x: W - R + 10, y: Math.min(H - B, e.y) + 4, class: 'ch-label' }); tx.textContent = `${e.name} ${fmtNum(e.v)}`; svg.append(tx); }
    }
    // hover: a hairline that snaps to the nearest sample, and one read-out for every player
    const hair = s('line', { y1: T, y2: H - B, class: 'ch-hair', visibility: 'hidden' });
    svg.append(hair);
    const tip = h('div', { class: 'ch-tip hidden' });
    const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
    const showAt = (k) => {
      hair.setAttribute('x1', X(tl.t[k])); hair.setAttribute('x2', X(tl.t[k])); hair.setAttribute('visibility', 'visible');
      const order = players.map((p, i) => i).filter((i) => k <= lastIdx(i)).sort((a, b) => data[b][k] - data[a][k]);
      tip.replaceChildren(h('div', { class: 'ch-tip-h' }, when(tl.t[k])),
        ...order.map((i) => h('div', { class: 'ch-tip-row' }, keySwatch(i, colorHex(players[i].color)), h('b', null, fmtNum(data[i][k])), h('span', null, players[i].name))));
      tip.classList.remove('hidden');
      const box = svg.getBoundingClientRect(), px = (X(tl.t[k]) / W) * box.width;
      tip.style.left = (px > box.width * 0.6 ? px - tip.offsetWidth - 14 : px + 14) + 'px';
      tip.style.top = '10px';
    };
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect(), t = ((ev.clientX - box.left) / box.width * W - L) / (W - L - R) * tMax;
      let k = 0;
      for (let j = 1; j < tl.t.length; j++) if (Math.abs(tl.t[j] - t) < Math.abs(tl.t[k] - t)) k = j;
      showAt(k);
    });
    hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); });
    svg.append(hit);

    const legend = h('div', { class: 'ch-legend' }, players.map((p, i) => h('button', { class: 'ch-leg' + (focus === i ? ' on' : ''), title: 'Click to highlight this line',
      onclick: () => { focus = focus === i ? -1 : i; draw(); } }, keySwatch(i, colorHex(p.color)), h('span', null, p.name))));
    let view;
    if (asTable) {
      const step = Math.max(1, Math.ceil(tl.t.length / 12)), idx = [];
      for (let k = 0; k < tl.t.length; k += step) idx.push(k);
      if (idx[idx.length - 1] !== tl.t.length - 1) idx.push(tl.t.length - 1);
      view = h('div', { class: 'ch-tablewrap' }, h('table', { class: 'score small' },
        h('tr', null, h('th', null, rounds ? 'Round' : 'Time'), players.map((p) => h('th', null, p.name))),
        idx.map((k) => h('tr', null, h('td', null, rounds ? tl.t[k] : fmtTime(tl.t[k])), players.map((p, i) => h('td', null, k <= lastIdx(i) ? fmtNum(data[i][k]) : '–'))))));
    } else view = h('div', { class: 'ch-plot' }, svg, tip);
    wrap.replaceChildren(
      h('div', { class: 'ch-filters' }, metrics.map(([key, name]) => h('button', { class: 'tab' + (metric === key ? ' on' : ''), onclick: () => { metric = key; draw(); } }, name)),
        h('button', { class: 'tab right' + (asTable ? ' on' : ''), onclick: () => { asTable = !asTable; draw(); } }, asTable ? 'Show the graph' : 'Show as a table')),
      view, legend);
  };
  draw();
  return wrap;
}

function hallTable(list, fresh) {
  if (!list || !list.length) return h('p', { class: 'muted' }, 'No scores yet. Finish a match against at least one other kitchen (it has to last a few minutes) and the humans in it land here.');
  return h('table', { class: 'score' },
    h('tr', null, ['#', 'Chef', 'Commander', 'Score', 'Result', 'Length', 'Match', 'Date'].map((t) => h('th', null, t))),
    list.map((e, i) => h('tr', { class: fresh && fresh.includes(e.id) ? 'won' : '' },
      h('td', null, i + 1), h('td', null, e.name, fresh && fresh.includes(e.id) && h('span', { class: 'tag ready' }, 'NEW')),
      h('td', null, (COMMANDERS[e.commander] || {}).name || e.commander), h('td', null, h('b', null, fmtNum(e.score))), h('td', null, e.won ? 'Won' : 'Lost'),
      h('td', null, fmtTime(e.minutes * 60)),
      h('td', null, (e.mode === 'turn' ? 'Turn-based, ' : e.mode === 'ctf' ? 'Capture the Flag, ' : '') + `${e.players} kitchens` + (e.bots ? `, ${e.bots} bot${e.bots === 1 ? '' : 's'}${e.hardest ? ' (up to ' + (BOT_LEVELS[e.hardest] || e.hardest) + ')' : ''}` : '')),
      h('td', null, e.date))));
}

/** Lobby button: the server's best scores. */
export function showHall(list) {
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal-box over' }, h('h2', null, 'Hall of Fame'),
      h('p', { class: 'muted' }, 'The best scores by human players on this server. Kept in highscores.json next to server.js.'),
      hallTable(list.slice(0, 20)), h('div', { class: 'over-btns' }, h('button', { class: 'btn primary', onclick: () => modal.remove() }, 'Close'))));
  document.body.append(modal);
}

export function showOver(m) {
  closeOver();
  const myT = G.me >= 0 ? G.players[G.me].team : -1;
  const title = G.me < 0 ? 'Match over' : m.team === myT ? 'Victory!' : 'Defeat';
  const winners = m.summary.filter((x) => x.team === m.team).map((x) => x.name).join(' & ');
  const total = (x) => (x.score ? x.score.total : 0);
  const rows = m.summary.slice().sort((a, b) => total(b) - total(a) || (b.team === m.team) - (a.team === m.team));
  const chef = (x) => h('td', { class: 'chef' }, h('span', { class: 'dot', style: `background:${colorHex(x.color)}` }), x.name, x.team === m.team && h('span', { class: 'tag host' }, 'WON'), x.bot && h('span', { class: 'tag bot' }, 'BOT'));
  const tr = (x, cells) => h('tr', { class: (x.team === m.team ? 'won' : '') + (x.idx === G.me ? ' me' : '') }, chef(x), cells.map((c) => h('td', null, c)));
  const sc = (x) => x.score || { military: 0, economy: 0, technology: 0, society: 0, total: 0 };
  const ctf = m.summary.some((x) => x.ctf);
  const itemCells = (x) => h('span', { class: 'items' }, ...ITEM_KEYS.map((k) => { const lv = (x.items || {})[k] | 0; return lv ? h('span', { class: 'item', title: CTF.items[k].name + ' ' + ['I', 'II', 'III'][lv - 1] }, h('img', { src: iconURL(CTF.items[k].icon[0], CTF.items[k].icon[1], 48, colorHex(x.color)), draggable: 'false', alt: '' }), h('b', null, ['I', 'II', 'III'][lv - 1])) : null; }));
  const tabs = ctf ? [
    ['Scores', () => h('div', null,
      h('table', { class: 'score' },
        h('tr', null, ['Chef', 'Hero', 'Level', 'Captures', 'Hero kills', 'Deaths', 'Minions', 'Tips earned', 'Items', 'Total'].map((t) => h('th', null, t))),
        rows.map((x) => tr(x, [COMMANDERS[x.commander].name, x.level || 1, x.caps, x.kills, x.deaths, x.minions, fmtNum(x.earned), itemCells(x), h('b', { class: 'total' }, fmtNum(sc(x).total))]))),
      h('p', { class: 'muted' }, 'Captures count 400 each · hero kills 60 · minions 4 · every item tier 40 · a quarter of the Tips earned'))],
  ] : [

    ['Scores', () => h('div', null,
      h('table', { class: 'score' },
        h('tr', null, ['Chef', 'Commander', 'Military', 'Economy', 'Technology', 'Society', 'Total'].map((t) => h('th', null, t))),
        rows.map((x) => tr(x, [COMMANDERS[x.commander].name, fmtNum(sc(x).military), fmtNum(sc(x).economy), fmtNum(sc(x).technology), fmtNum(sc(x).society), h('b', { class: 'total' }, fmtNum(sc(x).total))]))),
      h('p', { class: 'muted' }, 'Military: units defeated, stations razed, commanders felled · Economy: ingredients gathered · Technology: upgrades and ages · Society: stations built, staff trained, biggest brigade'))],
    ['Statistics', () => h('div', { class: 'ch-tablewrap' }, h('table', { class: 'score small' },
      h('tr', null, ['Chef', 'Age', 'Kills', 'Lost', 'Razed', 'Stations lost', 'Hero K / D', 'Trained', 'Built', 'Techs', 'Peak staff', 'Peak army', 'Produce', 'Wood', 'Spice', 'Salt', 'Out at'].map((t) => h('th', null, t))),
      rows.map((x) => { const r = x.res || {}; return tr(x, [AGE_SHORT[x.age], x.kills, x.lost, x.razed, x.bldgLost ?? '–', `${x.heroKills ?? 0} / ${x.heroDeaths ?? 0}`, x.trained ?? '–', x.built ?? '–', x.techs ?? '–', x.peakPop ?? '–', x.peakArmy ?? '–',
        fmtNum(r.food || 0), fmtNum(r.wood || 0), fmtNum(r.spice || 0), fmtNum(r.salt || 0), x.outAt ? (m.rounds ? 'round ' + x.outAt : fmtTime(x.outAt)) : '–']); })))],
  ];
  const capsBy = (team) => m.summary.filter((x) => x.team === team).reduce((n, x) => n + (x.caps || 0), 0);
  const runnerUp = ctf ? [...new Set(m.summary.map((x) => x.team))].filter((t) => t !== m.team).sort((a, b) => capsBy(b) - capsBy(a))[0] : undefined;
  if (m.timeline && m.timeline.t && m.timeline.t.length > 1) tabs.push(['Timeline', () => timelineChart(m)]);
  tabs.push(['Hall of Fame', () => h('div', null, hallTable(m.hof, m.fresh), h('p', { class: 'muted' }, 'Top scores by human players on this server (matches with two or more kitchens that last a few minutes).'))]);
  let cur = 0;
  const body = h('div', { class: 'over-body' }), bar2 = h('div', { class: 'tabs' });
  const draw = () => {
    bar2.replaceChildren(...tabs.map(([name], i) => h('button', { class: 'tab' + (i === cur ? ' on' : ''), onclick: () => { cur = i; draw(); sfx('click'); } }, name)));
    body.replaceChildren(tabs[cur][1]());
  };
  draw();
  const modal = h('div', { class: 'modal', id: 'over' },
    h('div', { class: 'modal-box over wide ' + (title === 'Victory!' ? 'win' : title === 'Defeat' ? 'loss' : '') },
      h('h1', null, title),
      h('p', { class: 'muted' }, (ctf ? (winners ? `${winners} ${winners.includes(' & ') ? 'take' : 'takes'} the flag ${capsBy(m.team)}–${runnerUp === undefined ? 0 : capsBy(runnerUp)}` : 'Nobody is left standing') : m.onScore ? `The round limit is up: ${winners || 'nobody'} ${winners.includes(' & ') ? 'win' : 'wins'} on points` : winners ? winners + (winners.includes(' & ') ? ' rule' : ' rules') + ' the kitchen' : 'Nobody is left standing')
        + (m.rounds ? ` after ${m.rounds} round${m.rounds === 1 ? '' : 's'} (${fmtTime(m.minutes * 60)}).` : ` after ${fmtTime(m.minutes * 60)}.`)),
      bar2, body,
      h('div', { class: 'over-btns' },
        h('button', { class: 'btn', onclick: closeOver }, 'Look around'),
        h('button', { class: 'btn primary', onclick: () => send({ t: 'end' }) }, 'Back to the lobby'))));
  document.body.append(modal);
}
function closeOver() { const o = $('over'); if (o) o.remove(); }

export function showEliminated() {
  note('Your kitchen has fallen. You can keep watching.', 'bad');
}
