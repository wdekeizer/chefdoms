// ============================================================================
//  All the HTML user interface: lobby, in-game HUD, command card, tooltips,
//  chat, notifications, menus and the end-of-match screen.
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, selected, setSelection, cmd, send, statsOf, maxHp } from './state.js';
import * as SPR from './sprites.js';
import {
  BUILDINGS, TECHS, COMMANDERS, COMMANDER_KEYS, RES, RES_INFO, AGE_NAMES, AGE_SHORT, OPTIONS, PLAYER_COLORS,
  BOT_LEVELS, BOT_NOTES, MAX_PLAYERS, MAP_SIZES, mapSizeFor, NODES, trainList, techCost, techTime, computeStats,
  STANCES, FORMATIONS, GARRISON_PER_SHOT, GARRISON_MAX_SHOTS, VERSION,
  ULT_AGE, TB, tbUnit, tbBldg, tbTurns, tbCooldown, tbDamage,
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
const myColor = () => (G.me >= 0 ? colorHex(G.players[G.me].color) : '#999');
/** Are we looking at (or setting up) a turn-based match? Texts and numbers differ. */
const isTurn = () => (G.phase === 'game' ? !!G.tb : !!(G.lobby && G.lobby.opts.mode === 'turn'));
const turnsText = (n) => n + (n === 1 ? ' turn' : ' turns');
const abilText = (A) => (isTurn() && A.tb ? A.tb : A.desc);
const cdText = (A) => (isTurn() ? `every ${turnsText(tbCooldown(A.cd))}` : `every ${A.cd}s`);
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

let hooks = { selectHero() {}, selectIdle() {}, selectArmy() {}, stop() {}, leaveToLobby() {}, setEdgeScroll() {}, setCamSpeed() {}, setFormation() {}, toggleBell() {} };
export function initUI(hk) { hooks = { ...hooks, ...hk }; buildStatic(); }

// ============================================================================
//  LOBBY
// ============================================================================
const amHost = () => G.lobby && G.lobby.host === G.cid;
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
      h('button', { class: 'cmd-pick' + (canEdit ? '' : ' locked'), disabled: !canEdit, title: canEdit ? 'Choose a commander' : '', onclick: canEdit ? () => openCommanderPicker(s, edit) : null },
        C ? img('commander', s.commander, 'portrait', null, 128) : h('div', { class: 'portrait random' }, '?'),
        h('div', { class: 'cmd-pick-text' }, h('div', { class: 'cmd-name' }, C ? C.name : 'Random commander'), h('div', { class: 'cmd-title' }, C ? C.title : 'Surprise me'))),
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

  const turn = L.opts.mode === 'turn';
  $('lobby-opts').replaceChildren(...Object.keys(OPTIONS).filter((k) => turn || !k.startsWith('turn')).map((k) => h('label', { class: 'opt' + (k === 'mode' ? ' wide' : '') }, h('span', null, OPTIONS[k].label),
    h('select', { disabled: !host, 'data-opt': k, onchange: (ev) => send({ t: 'opt', k, v: ev.target.value }) },
      Object.keys(OPTIONS[k].choices).map((v) => h('option', { value: v, selected: String(L.opts[k]) === v }, OPTIONS[k].choices[v]))))));
  const nSeats = L.slots.filter(Boolean).length, real = mapSizeFor(L.opts.mapSize, Math.max(1, nSeats));
  $('lobby-mapnote').textContent = turn
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
  let cur = slot.commander === 'random' ? COMMANDER_KEYS[0] : slot.commander;
  const detail = h('div', { class: 'picker-detail' });
  const list = h('div', { class: 'picker-list' });
  const draw = () => {
    list.replaceChildren(
      ...COMMANDER_KEYS.map((k) => h('button', { class: 'picker-item' + (k === cur ? ' on' : ''), onclick: () => { cur = k; draw(); sfx('click'); } },
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
const BUILD_ORDER = ['house', 'pantry', 'garden', 'grill', 'sauce', 'garage', 'lab', 'workshop', 'tower', 'restaurant', 'hq'];
let card = new Array(15).fill(null), cardSig = '', selSig = '', hoverCard = -1;
let cardBtns = [], resEls = {}, lastSlow = 0, menuOpen = false;
const gridLabel = (i) => labelOf('card' + i);

function buildStatic() {
  // top bar
  const res = RES.map((r) => { const v = h('span', { class: 'res-v' }, '0'), inc = h('span', { class: 'res-inc' }, ''); resEls[r] = v; resEls[r + 'Inc'] = inc; return h('div', { class: 'res', title: RES_INFO[r].name }, img('res', r, 'res-i', null, 64), v, inc); });
  resEls.pop = h('span', { class: 'res-v' }, '0/0');
  resEls.age = h('span', null, '');
  resEls.clock = h('span', { class: 'clock' }, '0:00');
  resEls.ping = h('span', { class: 'ping' }, '');
  $('topbar').replaceChildren(
    h('div', { class: 'res-group' }, ...res, h('div', { class: 'res', title: 'Staff (population)' }, img('res', 'pop', 'res-i', null, 64), resEls.pop)),
    h('div', { class: 'age' }, resEls.age),
    h('div', { class: 'top-right' }, resEls.clock, resEls.ping, h('button', { class: 'btn small ghost', onclick: () => toggleMenu() }, 'Menu (F10)')));

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
  input.placeholder = team ? 'Message your team…' : 'Message everyone… (Shift+Enter for team chat)';
  $('chatbox').classList.remove('hidden');
  $('chatlog').classList.add('open');
  input.focus();
}
function closeChat() { $('chatbox').classList.add('hidden'); $('chatlog').classList.remove('open'); $('chat-input').blur(); }

// ------------------------------------------------------------------ tooltips
function costRow(cost, time, pop, turns) {
  const me = G.ps[G.me];
  const parts = [];
  for (const r of RES) if (cost && cost[r]) parts.push(h('span', { class: 'tt-c' + (me && me.res[r] < cost[r] ? ' lack' : '') }, img('res', r, 'tt-i', null, 64), cost[r]));
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
  if (!sel.length) return;
  const st = me.stats, cmdKey = G.players[G.me].commander;
  if (G.tb) { buildCardTurn(me, sel[0], st, cmdKey); return; }
  const units = sel.filter((e) => e.kind === K_UNIT), bl = sel.filter((e) => e.kind === K_BLDG);
  const stop = { icon: ['ui', 'stop'], title: 'Stop', desc: 'Drop whatever they are doing.', ok: true, run: () => hooks.stop() };
  if (units.length) {
    if (units.every((e) => e.type === 'cook')) {
      BUILD_ORDER.forEach((b, i) => {
        const S = st.bldgs[b];
        card[i] = {
          icon: ['building', b], title: S.name, desc: S.desc, cost: S.cost, time: S.time / st.misc.buildMul, ok: me.age >= S.age,
          why: `Requires the ${AGE_NAMES[S.age]}`, active: G.mode && G.mode.type === 'place' && G.mode.b === b,
          hint: 'Click to place. Hold Shift to place several.', stats: S.atk ? S : { hp: S.hp },
          run: () => { G.mode = { type: 'place', b }; },
        };
      });
      const carrying = units.some((e) => e.carry);
      card[12] = { icon: ['ui', 'drop'], title: 'Deliver', desc: 'Carry what they are holding to the nearest drop-off right now. (Right-clicking a Kitchen HQ or Pantry does the same.)', ok: carrying, why: 'Nobody here is carrying anything', run: () => cmd({ c: 'dr', ids: units.map((e) => e.id) }) };
      card[13] = bellCard(me);
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
  if (c.cost && !canAfford(c.cost)) { note('Not enough ' + lacking(c.cost).join(' and '), 'warn'); sfx('error'); return true; }
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
  const sig = sel.length === 0 ? 'none' + G.me
    : sel.length === 1 ? [sel[0].id, sel[0].hp, sel[0].prog, sel[0].qpct, (sel[0].q || []).join(), sel[0].amount, sel[0].carry, sel[0].sn, sel[0].inside, sel[0].owner >= 0 ? G.ps[sel[0].owner].sig : '', sel[0].left, sel[0].qleft, G.tb ? G.tb.cur : ''].join('|')
      : sel.map((e) => e.id + ':' + Math.ceil(e.hp / 5)).join(',');
  if (sig === selSig && !force) return;
  selSig = sig;

  if (!sel.length) {
    if (G.me < 0) { panel.replaceChildren(h('div', { class: 'sel-empty' }, h('b', null, 'Spectating'), h('div', { class: 'muted' }, 'You can see the whole map. Click anything to inspect it.'))); return; }
    const C = COMMANDERS[G.players[G.me].commander];
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
    const S = statsOf(e) || {}, col = colorHex(G.players[e.owner].color), mh = maxHp(e), mine = e.owner === G.me;
    const head = h('div', { class: 'sel-name' }, S.name || e.type, h('span', { class: 'sel-role' }, e.kind === K_UNIT ? S.role : mine ? '' : G.players[e.owner].name),
      !mine && e.kind === K_UNIT && h('span', { class: 'sel-owner', style: `color:${col}` }, G.players[e.owner].name));
    const info = h('div', { class: 'sel-info' }, head, h('div', { class: 'sel-hp' }, bar(e.hp / mh), h('span', null, `${Math.max(0, e.hp)} / ${mh}`)));
    if (e.kind === K_UNIT) {
      info.append(G.tb ? h('div', { class: 'tt-stats' }, tbUnitText(S)) : statLine(S) || '');
      if (G.tb) { const stt = TAC.statusOf(e); if (stt) info.append(h('div', { class: 'sel-turn' + (TAC.flagsOf(e) & (TAC.F_DONE | TAC.F_STUN) ? ' done' : '') }, stt)); }
      if (e.type.startsWith('hero_')) {
        const C = COMMANDERS[G.players[e.owner].commander];
        info.append(h('div', { class: 'sel-desc' }, h('b', null, C.aura.name + ': '), abilText(C.aura)), h('div', { class: 'sel-desc' }, h('b', null, C.ability.name + ': '), abilText(C.ability)));
      } else info.append(h('div', { class: 'sel-desc' }, S.desc || ''));
      if (e.carry) info.append(h('div', { class: 'sel-desc' }, 'Carrying ' + RES_INFO[RES[e.carry - 1]].name + (mine ? ' — right-click a Kitchen HQ or Pantry to deliver it' : '')));
      if (mine && e.type !== 'cook' && S.atk > 0 && !G.tb) info.append(h('div', { class: 'muted' }, 'Stance: ' + STANCES[e.sn || 0].name));
    } else if (e.prog < 100) {
      if (G.tb) info.append(h('div', { class: 'sel-desc' }, mine ? `Under construction: ${turnsText(e.left || 1)} left` : 'Under construction'), mine ? h('div', { class: 'muted' }, 'Right-click it with a Prep Cook to finish a turn sooner.') : '');
      else info.append(h('div', { class: 'sel-desc' }, `Under construction: ${e.prog}%`), mine ? h('div', { class: 'muted' }, 'Right-click it with Prep Cooks to speed things up.') : '');
    } else if (G.tb) {
      info.append(h('div', { class: 'tt-stats' }, tbBldgText(S)));
      if (mine && e.q && e.q.length) {
        const code = e.q[0];
        info.append(h('div', { class: 'sel-desc' }, (code[0] === 'u' ? 'Training ' : 'Researching ') + itemName(code) + `: ready in ${turnsText(e.qleft || 1)}`),
          h('div', { class: 'queue' }, h('button', { class: 'q-item first', title: 'Cancel ' + itemName(code) + ' (refunds the cost)', onmousedown: (ev) => { cmd({ c: 'cq', bid: e.id, i: 0 }); sfx('click'); ev.preventDefault(); } },
            h('img', { src: itemIcon(code, col), draggable: 'false', alt: '' }))));
      } else info.append(h('div', { class: 'sel-desc' }, TB.desc[e.type] || S.desc || ''));
      if (e.pays) info.append(h('div', { class: 'sel-desc' }, h('b', null, `Pays ${RES_INFO[RES[e.pays - 1]].name} `), 'at the start of each of its owner\'s turns.'));
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
    panel.replaceChildren(h('div', { class: 'sel-one' }, h('img', { class: 'sel-ico', src: iconURL(e.kind === K_UNIT ? 'unit' : 'building', e.type, 160, col), draggable: 'false', alt: '' }), info));
    return;
  }
  // many
  const grid = h('div', { class: 'sel-grid' });
  const shown = sel.slice(0, 40);
  for (const e of shown) {
    const col = e.owner >= 0 ? colorHex(G.players[e.owner].color) : '#999';
    grid.append(h('button', { class: 'sel-cell', title: (statsOf(e) || {}).name || e.type,
      onmousedown: (ev) => { if (ev.shiftKey) G.sel.delete(e.id); else setSelection([e]); refreshAll(true); ev.preventDefault(); } },
      h('img', { src: iconURL(e.kind === K_UNIT ? 'unit' : 'building', e.type, 96, col), draggable: 'false', alt: '' }), bar(e.hp / maxHp(e), 'mini')));
  }
  panel.replaceChildren(h('div', { class: 'sel-many' }, h('div', { class: 'sel-count' }, sel.length + ' selected' + (sel.length > 40 ? ' (showing 40)' : '')), grid));
}

// ------------------------------------------------- quick bar (above the minimap)
let heroSig = '';
function refreshHero() {
  const box = $('heropanel');
  if (G.me < 0) { if (heroSig !== 'spec') { heroSig = 'spec'; box.replaceChildren(); } return; }
  const me = G.ps[G.me], P = G.players[G.me], C = COMMANDERS[P.commander], A = C.ability;
  const hero = me.heroId ? G.ents.get(me.heroId) : null;
  const tb = !!G.tb, U = C.ultimate, unit = '';
  // in a turn-based match the server counts cooldowns in turns
  const cd = tb ? me.abilityReady : Math.max(0, Math.ceil((me.abilityReady - G.tick) / G.tickRate));
  const ucd = tb ? me.ultReady : Math.max(0, Math.ceil((me.ultReady - G.tick) / G.tickRate));
  const back = hero ? 0 : tb ? me.heroRespawn : Math.max(0, Math.ceil((me.heroRespawn - G.tick) / G.tickRate));
  const idle = tb ? TAC.readyUnits().length : G.units.reduce((n, e) => n + (e.owner === G.me && e.type === 'cook' && e.st === 0 ? 1 : 0), 0);
  const lunch = !tb && G.tick < me.lunchUntil, locked = me.age < ULT_AGE;
  const sig = [hero ? Math.ceil(hero.hp / 4) : 'x', cd, ucd, locked, back, idle, lunch, me.alive, me.bell, G.mode && G.mode.type === 'ping', tb && G.tb.cur].join('|');
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
    !tb && h('button', { class: 'qbtn' + (me.bell ? ' alarm' : ''), onmousedown: press(() => { hooks.toggleBell(); sfx('click'); }),
      ...tip(() => simpleTip(me.bell ? 'All clear' : 'Ring the bell', labelOf('bell'), me.bell ? 'Your Prep Cooks come out and go back to the jobs they had.' : 'All Prep Cooks shelter inside the nearest Kitchen HQ until you give the all-clear.')) },
      img('ui', me.bell ? 'allclear' : 'bell', 'q-ico')),
    !tb && h('button', { class: 'qbtn', onmousedown: press(() => hooks.selectArmy()), ...tip(() => simpleTip('Select your whole army', labelOf('army'))) }, img('ui', 'attack', 'q-ico')),
    tb
      ? h('button', { class: 'qbtn' + (idle ? ' warn' : ''), onmousedown: press(() => hooks.selectIdle()),
        ...tip(() => simpleTip(idle ? `${idle} unit${idle === 1 ? '' : 's'} can still act` : TAC.myTurn() ? 'Every unit has acted' : 'Waiting for your turn', labelOf('idle'), 'Click to jump to the next unit with something left to do this turn.')) },
        img('ui', 'next', 'q-ico', myColor()), idle ? h('span', { class: 'q-badge' }, idle) : null)
      : h('button', { class: 'qbtn' + (idle ? ' warn' : ''), onmousedown: press(() => hooks.selectIdle()),
        ...tip(() => simpleTip(idle ? `${idle} idle Prep Cook${idle === 1 ? '' : 's'}` : 'No idle Prep Cooks', labelOf('idle'), 'Click to select the next one.')) },
        img('unit', 'cook', 'q-ico', myColor()), idle ? h('span', { class: 'q-badge' }, idle) : null),
    h('button', { class: 'qbtn abil ult' + (uready ? ' ready' : '') + (locked ? ' locked' : ''),
      onmousedown: press(() => {
        if (uready && (!tb || TAC.myTurn())) { cmd({ c: 'ul' }); sfx('click'); }
        else { note(locked ? `${U.name} unlocks in the ${AGE_NAMES[ULT_AGE]}` : !hero ? 'Your commander is down' : ucd > 0 ? `${U.name} is ready ${wait(ucd)}` : 'Wait for your turn', 'warn'); sfx('error'); }
      }),
      ...tip(() => h('div', null, h('div', { class: 'tt-title' }, U.name, h('span', { class: 'tt-key' }, labelOf('ultimate'))), h('div', { class: 'tt-sub' }, `Ultimate · ${cdText(U)}`), h('div', { class: 'tt-desc' }, abilText(U)),
        locked && h('div', { class: 'tt-why' }, `Unlocks in the ${AGE_NAMES[ULT_AGE]}`))) },
      img('ability', U.key, 'q-ico'), locked ? img('ui', 'lock', 'q-lock') : !uready && hero ? h('span', { class: 'q-cd' }, ucd + unit) : null),
    h('button', { class: 'qbtn abil' + (ready ? ' ready' : '') + (lunch ? ' lit' : ''),
      onmousedown: press(() => { if (ready && (!tb || TAC.myTurn())) { cmd({ c: 'ab' }); sfx('click'); } else { note(!hero ? 'Your commander is down' : cd > 0 ? `${A.name} is ready ${wait(cd)}` : 'Wait for your turn', 'warn'); sfx('error'); } }),
      ...tip(() => h('div', null, h('div', { class: 'tt-title' }, A.name, h('span', { class: 'tt-key' }, labelOf('ability'))), h('div', { class: 'tt-sub' }, `Commander ability · ${cdText(A)}`), h('div', { class: 'tt-desc' }, abilText(A)), h('div', { class: 'tt-hint' }, `Aura · ${C.aura.name}: ${abilText(C.aura)}`))) },
      img('ability', A.key, 'q-ico'), !ready && hero ? h('span', { class: 'q-cd' }, cd + unit) : null),
    h('button', { class: 'qbtn hero' + (hero ? '' : ' down'), onmousedown: press((ev) => hooks.selectHero(ev.detail > 1)),
      ...tip(() => simpleTip(C.name, labelOf('hero'), hero ? 'Click to select your commander; double-click to jump there.' : `Back at the Kitchen HQ ${wait(back)}.`)) },
      img('commander', P.commander, 'q-ico', null, 96), hero ? bar(hero.hp / maxHp(hero), 'mini') : h('span', { class: 'q-cd' }, back || '…'))].filter(Boolean));
}

// -------------------------------------------------------------------- top bar
function refreshTop() {
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
  const sig = G.players.map((p, i) => p.name + G.ps[i].age + G.ps[i].alive + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '+' : '')).join('|') + (G.tb ? G.tb.cur : '');
  if (sig === plSig) return;
  plSig = sig;
  const teams = new Set(G.players.map((p) => p.team)).size;
  $('players').replaceChildren(...G.players.map((p, i) => h('div', { class: 'pl' + (G.ps[i].alive ? '' : ' out') + (i === G.me ? ' me' : '') + (G.tb && G.tb.cur === i && !G.over ? ' turn' : '') },
    h('span', { class: 'dot', style: `background:${colorHex(p.color)}` }),
    h('span', { class: 'pl-name' }, p.name),
    teams < G.players.length && h('span', { class: 'pl-team' }, 'T' + p.team),
    h('span', { class: 'pl-age', title: COMMANDERS[p.commander].name + ' · ' + AGE_NAMES[G.ps[i].age] }, G.ps[i].alive ? AGE_SHORT[G.ps[i].age] + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '↑' : '') : 'out'))));
}

// ------------------------------------------------- turn bar (turn-based matches)
let turnSig = '';
function refreshTurn() {
  const box = $('turnbar');
  if (!G.tb) { if (turnSig !== 'off') { turnSig = 'off'; box.classList.add('hidden'); box.replaceChildren(); } return; }
  const tb = G.tb, P = G.players[tb.cur], my = TAC.myTurn();
  const left = tb.deadline && !G.over ? Math.max(0, Math.ceil((tb.deadline - G.tick) / (G.tickRate * (Number(G.opts.speed) || 1)))) : -1;
  const n = my ? TAC.readyUnits().length : 0;
  const sig = [tb.n, tb.cur, left, n, G.over ? 1 : 0, my, G.paused].join('|');
  if (sig === turnSig) return;
  if (my && left === 10 && !turnSig.startsWith('off')) { note('10 seconds left in your turn', 'warn'); sfx('turn_other'); }
  turnSig = sig;
  box.classList.remove('hidden'); box.classList.toggle('mine', my);
  box.replaceChildren(...[
    h('span', { class: 'tb-round' }, 'Round ' + tb.n + (tb.limit ? ' of ' + tb.limit : '')),
    h('span', { class: 'dot', style: `background:${colorHex(P.color)}` }),
    h('span', { class: 'tb-who' }, G.over ? 'Match over' : my ? 'Your turn' : tb.cur === G.me ? 'Your turn' : `${P.name}${P.bot ? ' (bot)' : ''} is playing…`),
    left >= 0 && h('span', { class: 'tb-time' + (left <= 10 ? ' low' : '') }, fmtTime(left)),
    my && h('span', { class: 'tb-left' }, n ? `${n} unit${n === 1 ? '' : 's'} can still act` : 'everyone has acted'),
    my && h('button', { class: 'btn small primary', title: 'Hand over to the next kitchen', onmousedown: (ev) => { if (ev.button === 0 && TAC.endTurn()) sfx('endturn'); ev.preventDefault(); } }, `End turn (${labelOf('endTurn')})`)].filter(Boolean));
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
  refreshPlayers();
  refreshSelection(force);
  refreshCard(force);
  document.body.classList.toggle('placing', !!G.mode);
}

export function resetHUD() {
  cardSig = selSig = heroSig = plSig = turnSig = '';
  document.body.classList.toggle('tb', !!G.tb);
  $('chatlog').replaceChildren(); $('msgs').replaceChildren();
  closeOver(); toggleMenu(false);
  updateHUD(0, true);
}

// ----------------------------------------------------------------------- menu
const store = {
  get(k) { try { return localStorage.getItem('chefdoms.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('chefdoms.' + k, v); } catch { /* private mode */ } },
};
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
    if (ev.code === 'Escape') { /* keep the old key */ }
    else if (ev.code === 'Backspace' || ev.code === 'Delete') setKey(id, '');
    else if (canBind(ev.code)) setKey(id, ev.code);
    else { note('That key is reserved', 'warn'); return; }
    listening = null; modal.classList.remove('keys-open');
    draw();
  };
  const close = () => { window.removeEventListener('keydown', onKey, true); modal.remove(); };
  window.addEventListener('keydown', onKey, true);

  const keyBtn = (id) => h('button', { class: 'keybtn' + (listening === id ? ' wait' : '') + (keyOf(id) ? '' : ' unset'), title: 'Click, then press the new key (Backspace = no key, Esc = cancel)',
    onclick: () => { listening = listening === id ? null : id; modal.classList.toggle('keys-open', !!listening); draw(); } }, listening === id ? 'press a key…' : keyLabel(keyOf(id)) || '—');
  const draw = () => {
    const mouse = [
      ['Left-click / drag', 'Select a unit or box-select your army (double-click: all of that type on screen)'],
      ['Right-click', 'Smart order: move, attack, gather, build / repair, deliver to a Kitchen HQ or Pantry, or set a station\'s rally point'],
      ['Shift + order', 'Queue the order after the current one'],
      ['Alt + click', 'Ping that spot for your team (works on the minimap too)'],
      ['Arrow keys · screen edge · middle-drag', 'Move the camera · mouse wheel zooms · click the minimap to jump'],
      ['Ctrl or Shift + 1…9', 'Save a control group · press the number to recall it (twice: jump there)'],
      ['Delete', 'Remove the selected units or stations (Shift+Delete for a Kitchen HQ)'],
      ['Enter / Shift+Enter · Esc · F10', 'Chat with everyone / your team · cancel · menu'],
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
          rows('Camera'),
          h('h3', null, 'Command card'),
          h('div', { class: 'keygrid' }, group('Command card').map((a) => keyBtn(a.id))),
          h('div', { class: 'muted' }, 'Same layout as the buttons at the bottom left of the screen.'),
          h('h3', null, 'Turn-based matches'),
          h('table', { class: 'keytable fixed' }, turnRows.map((r) => h('tr', null, h('td', { class: 'k' }, r[0]), h('td', null, r[1]))))),
        h('div', null,
          h('h3', null, 'Commands'), rows('Commands'),
          h('h3', null, 'Mouse and fixed keys'),
          h('table', { class: 'keytable fixed' }, mouse.map((r) => h('tr', null, h('td', { class: 'k' }, r[0]), h('td', null, r[1])))))),
      h('p', { class: 'muted' }, 'Click a key to change it, then press the new one. A key can only do one thing: giving it to another action takes it away from the old one. Goal of the game: destroy every enemy Kitchen HQ (or every station, if the host picked Conquest).'),
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
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-svg', role: 'img', 'aria-label': METRICS.find((x) => x[0] === metric)[1] + (rounds ? ' by round' : ' over time') + ', one line per player' });
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
      h('div', { class: 'ch-filters' }, METRICS.map(([key, name]) => h('button', { class: 'tab' + (metric === key ? ' on' : ''), onclick: () => { metric = key; draw(); } }, name)),
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
      h('td', null, (e.mode === 'turn' ? 'Turn-based, ' : '') + `${e.players} kitchens` + (e.bots ? `, ${e.bots} bot${e.bots === 1 ? '' : 's'}${e.hardest ? ' (up to ' + (BOT_LEVELS[e.hardest] || e.hardest) + ')' : ''}` : '')),
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
  const tabs = [
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
      h('p', { class: 'muted' }, (m.onScore ? `The round limit is up: ${winners || 'nobody'} ${winners.includes(' & ') ? 'win' : 'wins'} on points` : winners ? winners + (winners.includes(' & ') ? ' rule' : ' rules') + ' the kitchen' : 'Nobody is left standing')
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
