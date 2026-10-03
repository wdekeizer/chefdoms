// ============================================================================
//  All the HTML user interface: lobby, in-game HUD, command card, tooltips,
//  chat, notifications, menus and the end-of-match screen.
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, selected, setSelection, cmd, send, statsOf, maxHp } from './state.js';
import * as SPR from './sprites.js';
import {
  BUILDINGS, TECHS, COMMANDERS, COMMANDER_KEYS, RES, RES_INFO, AGE_NAMES, AGE_SHORT, OPTIONS, PLAYER_COLORS,
  BOT_LEVELS, BOT_NOTES, MAX_PLAYERS, MAP_SIZES, mapSizeFor, NODES, trainList, techCost, techTime, computeStats,
} from '/game/data.js';
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

let hooks = { selectHero() {}, selectIdle() {}, selectArmy() {}, stop() {}, leaveToLobby() {}, setEdgeScroll() {} };
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

  $('lobby-opts').replaceChildren(...Object.keys(OPTIONS).map((k) => h('label', { class: 'opt' }, h('span', null, OPTIONS[k].label),
    h('select', { disabled: !host, onchange: (ev) => send({ t: 'opt', k, v: ev.target.value }) },
      Object.keys(OPTIONS[k].choices).map((v) => h('option', { value: v, selected: String(L.opts[k]) === v }, OPTIONS[k].choices[v]))))));
  const nSeats = L.slots.filter(Boolean).length, real = mapSizeFor(L.opts.mapSize, Math.max(1, nSeats));
  $('lobby-mapnote').textContent = `With ${nSeats} kitchen${nSeats === 1 ? '' : 's'} this match plays on the ${OPTIONS.mapSize.choices[real].replace(' (cozy)', '')} map (${MAP_SIZES[real]}×${MAP_SIZES[real]} tiles).`;

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
    h('div', { class: 'cd-row' }, img('unit', C.hero, 'ico', '#e2403a'), h('div', null, h('b', null, hero.name), ` · ${hero.hp} HP, ${hero.atk} attack` + (hero.range ? `, range ${hero.range}` : ', melee'), h('br'), h('span', { class: 'muted' }, `Aura · ${C.aura.name}: ${C.aura.desc}`))),
    h('div', { class: 'cd-row' }, img('ability', C.ability.key, 'ico'), h('div', null, h('b', null, C.ability.name), ` (every ${C.ability.cd}s)`, h('br'), h('span', { class: 'muted' }, C.ability.desc))),
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
const GRID = 'QWERTASDFGZXCVB';
const BUILD_ORDER = ['house', 'pantry', 'garden', 'grill', 'sauce', 'garage', 'lab', 'workshop', 'tower', 'restaurant', 'hq'];
let card = new Array(15).fill(null), cardSig = '', selSig = '', hoverCard = -1;
let cardBtns = [], resEls = {}, lastSlow = 0, menuOpen = false;

function buildStatic() {
  // top bar
  const res = RES.map((r) => { const v = h('span', { class: 'res-v' }, '0'); resEls[r] = v; return h('div', { class: 'res', title: RES_INFO[r].name }, img('res', r, 'res-i', null, 64), v); });
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
      h('img', { class: 'c-ico', draggable: 'false', alt: '' }), h('span', { class: 'c-key' }, GRID[i]), h('span', { class: 'c-badge' }));
    cardBtns.push(b); cc.append(b);
  }

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
function costRow(cost, time, pop) {
  const me = G.ps[G.me];
  const parts = [];
  for (const r of RES) if (cost && cost[r]) parts.push(h('span', { class: 'tt-c' + (me && me.res[r] < cost[r] ? ' lack' : '') }, img('res', r, 'tt-i', null, 64), cost[r]));
  if (pop) parts.push(h('span', { class: 'tt-c' }, img('res', 'pop', 'tt-i', null, 64), pop));
  if (time) parts.push(h('span', { class: 'tt-c time' }, Math.round(time) + 's'));
  return parts.length ? h('div', { class: 'tt-cost' }, ...parts) : null;
}
function statLine(S) {
  if (!S || S.hp === undefined) return null;
  const bits = [`HP ${S.hp}`];
  if (S.atk) bits.push(`Attack ${S.atk}`);
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
  let x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  let y = r.top - hh - 10;
  if (y < 8) y = r.bottom + 10;
  tt.style.left = x + 'px'; tt.style.top = y + 'px';
}
function hideTip() { $('tooltip').classList.add('hidden'); }
function showCardTip() {
  const c = card[hoverCard];
  if (!c) { hideTip(); return; }
  showTip(h('div', null,
    h('div', { class: 'tt-title' }, c.title, h('span', { class: 'tt-key' }, GRID[hoverCard])),
    c.sub && h('div', { class: 'tt-sub' }, c.sub),
    costRow(c.cost, c.time, c.pop),
    h('div', { class: 'tt-desc' }, c.desc),
    statLine(c.stats),
    !c.ok && h('div', { class: 'tt-why' }, c.why),
    c.hint && h('div', { class: 'tt-hint' }, c.hint)), cardBtns[hoverCard]);
}

// --------------------------------------------------------------- command card
const canAfford = (cost) => { const me = G.ps[G.me]; for (const r in cost) if (me.res[r] < cost[r]) return false; return true; };
const lacking = (cost) => { const me = G.ps[G.me]; return RES.filter((r) => cost[r] && me.res[r] < cost[r]).map((r) => RES_INFO[r].name); };

function buildCard() {
  card = new Array(15).fill(null);
  if (G.me < 0 || G.over) return;
  const me = G.ps[G.me];
  if (!me || !me.alive) return;
  const sel = selected().filter((e) => e.owner === G.me);
  if (!sel.length) return;
  const st = me.stats, cmdKey = G.players[G.me].commander;
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
      card[14] = stop;
    } else {
      card[5] = { icon: ['ui', 'attack'], title: 'Attack-move', desc: 'Then left-click a spot: your units walk there and fight anything hostile on the way.', ok: true, active: G.mode && G.mode.type === 'amove', run: () => { G.mode = { type: 'amove' }; } };
      card[6] = stop;
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
  let j = i === 0 ? 0 : i <= 5 ? 5 : 10;
  for (const key of BUILDINGS[b0.type].techs) {
    if (j >= 15) break;
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
export function cardKey(letter, shift) {
  const i = GRID.indexOf(letter);
  if (i < 0) return false;
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
    b.className = 'cbtn' + (c.ok ? '' : ' locked') + (c.active ? ' active' : '') + (c.pending ? ' pending' : '') + (c.cost && !canAfford(c.cost) ? ' poor' : '');
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
    : sel.length === 1 ? [sel[0].id, sel[0].hp, sel[0].prog, sel[0].qpct, (sel[0].q || []).join(), sel[0].amount, sel[0].carry, sel[0].owner >= 0 ? G.ps[sel[0].owner].sig : ''].join('|')
      : sel.map((e) => e.id + ':' + Math.ceil(e.hp / 5)).join(',');
  if (sig === selSig && !force) return;
  selSig = sig;

  if (!sel.length) {
    if (G.me < 0) { panel.replaceChildren(h('div', { class: 'sel-empty' }, h('b', null, 'Spectating'), h('div', { class: 'muted' }, 'You can see the whole map. Click anything to inspect it.'))); return; }
    const C = COMMANDERS[G.players[G.me].commander];
    panel.replaceChildren(h('div', { class: 'sel-one' }, img('commander', G.players[G.me].commander, 'sel-ico', null, 160),
      h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, C.name, h('span', { class: 'sel-role' }, C.title)),
        h('ul', { class: 'sel-bonus' }, C.bonuses.map((b) => h('li', null, b))),
        h('div', { class: 'muted' }, 'Drag to select units · right-click to give orders · H jumps to your Kitchen HQ'))));
    return;
  }
  if (sel.length === 1) {
    const e = sel[0];
    if (e.kind === K_NODE) {
      const N = NODES[e.type];
      panel.replaceChildren(h('div', { class: 'sel-one' }, h('div', { class: 'sel-ico res-big' }, img('res', N.res, 'sel-resico', null, 128)),
        h('div', { class: 'sel-info' }, h('div', { class: 'sel-name' }, N.name), h('div', null, `${e.amount} ${RES_INFO[N.res].name} left`), h('div', { class: 'muted' }, 'Right-click it with Prep Cooks selected to gather.'))));
      return;
    }
    const S = statsOf(e) || {}, col = colorHex(G.players[e.owner].color), mh = maxHp(e), mine = e.owner === G.me;
    const head = h('div', { class: 'sel-name' }, S.name || e.type, h('span', { class: 'sel-role' }, e.kind === K_UNIT ? S.role : mine ? '' : G.players[e.owner].name),
      !mine && e.kind === K_UNIT && h('span', { class: 'sel-owner', style: `color:${col}` }, G.players[e.owner].name));
    const info = h('div', { class: 'sel-info' }, head, h('div', { class: 'sel-hp' }, bar(e.hp / mh), h('span', null, `${Math.max(0, e.hp)} / ${mh}`)));
    if (e.kind === K_UNIT) {
      info.append(statLine(S) || '');
      if (e.type.startsWith('hero_')) {
        const C = COMMANDERS[G.players[e.owner].commander];
        info.append(h('div', { class: 'sel-desc' }, h('b', null, C.aura.name + ': '), C.aura.desc), h('div', { class: 'sel-desc' }, h('b', null, C.ability.name + ': '), C.ability.desc));
      } else info.append(h('div', { class: 'sel-desc' }, S.desc || ''));
      if (e.carry) info.append(h('div', { class: 'sel-desc' }, 'Carrying ' + RES_INFO[RES[e.carry - 1]].name));
    } else if (e.prog < 100) {
      info.append(h('div', { class: 'sel-desc' }, `Under construction: ${e.prog}%`), mine ? h('div', { class: 'muted' }, 'Right-click it with Prep Cooks to speed things up.') : '');
    } else {
      if (mine && e.q && e.q.length) {
        const q = h('div', { class: 'queue' });
        e.q.forEach((code, i) => q.append(h('button', { class: 'q-item' + (i === 0 ? ' first' : ''), title: 'Cancel ' + itemName(code) + ' (refunds the cost)', onmousedown: (ev) => { cmd({ c: 'cq', bid: e.id, i }); sfx('click'); ev.preventDefault(); } },
          h('img', { src: itemIcon(code, col), draggable: 'false', alt: '' }), i === 0 && h('div', { class: 'q-prog' }, h('div', { style: `width:${e.qpct}%` })))));
        info.append(h('div', { class: 'sel-desc' }, (e.q[0][0] === 'u' ? 'Training ' : 'Researching ') + itemName(e.q[0]) + ` (${e.qpct}%)`), q);
      } else {
        if (S.atk) info.append(statLine({ hp: mh, atk: S.atk, armor: S.armor, parmor: S.parmor, range: S.range }) || '');
        info.append(h('div', { class: 'sel-desc' }, S.desc || ''));
        if (mine && (BUILDINGS[e.type].trains.length)) info.append(h('div', { class: 'muted' }, 'Right-click the map to set where new units gather.'));
      }
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

// ----------------------------------------------------------------- hero panel
let heroSig = '';
function refreshHero() {
  const box = $('heropanel');
  if (G.me < 0) { if (heroSig !== 'spec') { heroSig = 'spec'; box.replaceChildren(); } return; }
  const me = G.ps[G.me], P = G.players[G.me], C = COMMANDERS[P.commander], A = C.ability;
  const hero = me.heroId ? G.ents.get(me.heroId) : null;
  const cd = Math.max(0, Math.ceil((me.abilityReady - G.tick) / G.tickRate));
  const back = hero ? 0 : Math.max(0, Math.ceil((me.heroRespawn - G.tick) / G.tickRate));
  const idle = G.units.reduce((n, e) => n + (e.owner === G.me && e.type === 'cook' && e.st === 0 ? 1 : 0), 0);
  const lunch = G.tick < me.lunchUntil;
  const sig = [hero ? Math.ceil(hero.hp / 4) : 'x', cd, back, idle, lunch, me.alive].join('|');
  if (sig === heroSig) return;
  heroSig = sig;
  if (!me.alive) { box.replaceChildren(); return; }
  const ready = hero && cd === 0;
  box.replaceChildren(
    h('button', { class: 'hero-btn' + (hero ? '' : ' down'), title: C.name + ' — click to select (` key), double-click to jump there', onmousedown: (ev) => { hooks.selectHero(ev.detail > 1); ev.preventDefault(); } },
      img('commander', P.commander, 'hero-face', null, 128), hero ? bar(hero.hp / maxHp(hero), 'mini') : h('div', { class: 'hero-back' }, back ? back + 's' : '…')),
    h('button', { class: 'abil-btn' + (ready ? ' ready' : '') + (lunch ? ' lit' : ''), onmousedown: (ev) => { if (ready) { cmd({ c: 'ab' }); sfx('click'); } else { note(hero ? `${A.name} is ready in ${cd}s` : 'Your commander is down', 'warn'); sfx('error'); } ev.preventDefault(); },
      onmouseenter: (ev) => showTip(h('div', null, h('div', { class: 'tt-title' }, A.name, h('span', { class: 'tt-key' }, 'SPACE')), h('div', { class: 'tt-sub' }, `Commander ability · ${A.cd}s cooldown`), h('div', { class: 'tt-desc' }, A.desc), h('div', { class: 'tt-hint' }, `Aura · ${C.aura.name}: ${C.aura.desc}`)), ev.currentTarget), onmouseleave: hideTip },
      img('ability', A.key, 'abil-ico'), h('span', { class: 'abil-cd' }, !hero ? '' : cd ? cd : 'SPACE')),
    h('button', { class: 'side-btn' + (idle ? ' warn' : ''), title: 'Select the next idle Prep Cook ( . )', onmousedown: (ev) => { hooks.selectIdle(); ev.preventDefault(); } }, img('unit', 'cook', 'side-ico', myColor()), h('span', null, idle ? idle + ' idle' : 'All busy')),
    h('button', { class: 'side-btn', title: 'Select your whole army ( , )', onmousedown: (ev) => { hooks.selectArmy(); ev.preventDefault(); } }, img('ui', 'attack', 'side-ico'), h('span', null, 'Army')));
}

// -------------------------------------------------------------------- top bar
function refreshTop() {
  if (G.me >= 0) {
    const me = G.ps[G.me];
    for (const r of RES) { const t = String(me.res[r]); if (resEls[r].textContent !== t) resEls[r].textContent = t; }
    const pop = `${me.pop}/${me.cap}`;
    if (resEls.pop.textContent !== pop) { resEls.pop.textContent = pop; resEls.pop.classList.toggle('full', me.pop >= me.cap); }
    const researching = me.pending.find((k) => k.startsWith('age'));
    const age = `${AGE_SHORT[me.age]} · ${AGE_NAMES[me.age]}` + (researching ? '  →  advancing…' : '');
    if (resEls.age.textContent !== age) resEls.age.textContent = age;
  } else if (resEls.age.textContent !== 'Spectating') { resEls.age.textContent = 'Spectating'; for (const r of RES) resEls[r].textContent = '–'; resEls.pop.textContent = '–'; }
  const secs = Math.floor(G.tick / G.tickRate);
  const clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + (G.paused ? '  PAUSED' : '');
  if (resEls.clock.textContent !== clock) resEls.clock.textContent = clock;
  const ping = G.net && G.net.ping ? Math.round(G.net.ping) + ' ms' : '';
  if (resEls.ping.textContent !== ping) resEls.ping.textContent = ping;
}

// --------------------------------------------------------------- player list
let plSig = '';
function refreshPlayers() {
  const sig = G.players.map((p, i) => p.name + G.ps[i].age + G.ps[i].alive + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '+' : '')).join('|');
  if (sig === plSig) return;
  plSig = sig;
  const teams = new Set(G.players.map((p) => p.team)).size;
  $('players').replaceChildren(...G.players.map((p, i) => h('div', { class: 'pl' + (G.ps[i].alive ? '' : ' out') + (i === G.me ? ' me' : '') },
    h('span', { class: 'dot', style: `background:${colorHex(p.color)}` }),
    h('span', { class: 'pl-name' }, p.name),
    teams < G.players.length && h('span', { class: 'pl-team' }, 'T' + p.team),
    h('span', { class: 'pl-age', title: COMMANDERS[p.commander].name + ' · ' + AGE_NAMES[G.ps[i].age] }, G.ps[i].alive ? AGE_SHORT[G.ps[i].age] + (G.ps[i].pending.some((k) => k.startsWith('age')) ? '↑' : '') : 'out'))));
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
  refreshPlayers();
  refreshSelection(force);
  refreshCard(force);
  document.body.classList.toggle('placing', !!G.mode);
}

export function resetHUD() {
  cardSig = selSig = heroSig = plSig = '';
  $('chatlog').replaceChildren(); $('msgs').replaceChildren();
  closeOver(); toggleMenu(false);
  updateHUD(0, true);
}

// ----------------------------------------------------------------------- menu
export function toggleMenu(force) {
  const want = force === undefined ? !menuOpen : force;
  if (want === menuOpen) return false;
  menuOpen = want;
  const old = $('menu');
  if (old) old.remove();
  if (!want) return true;
  const host = G.cid === G.hostId, playing = G.me >= 0 && G.ps[G.me] && G.ps[G.me].alive && !G.over;
  let edge = localStorage.getItem('chefdoms.edge') !== '0';
  const modal = h('div', { class: 'modal', id: 'menu', onmousedown: (ev) => { if (ev.target === modal) toggleMenu(false); } },
    h('div', { class: 'modal-box menu' },
      h('h2', null, 'Menu'),
      h('button', { class: 'btn', onclick: () => toggleMenu(false) }, 'Back to the kitchen'),
      soundControls(),
      h('button', { class: 'btn', onclick: (ev) => { edge = !edge; localStorage.setItem('chefdoms.edge', edge ? '1' : '0'); hooks.setEdgeScroll(edge); ev.target.textContent = 'Edge scrolling: ' + (edge ? 'on' : 'off'); } }, 'Edge scrolling: ' + (edge ? 'on' : 'off')),
      h('button', { class: 'btn', onclick: () => { toggleMenu(false); showHelp(); } }, 'Controls'),
      host && !G.over && h('button', { class: 'btn', onclick: () => { send({ t: 'pause' }); toggleMenu(false); } }, G.paused ? 'Resume match' : 'Pause match'),
      playing && h('button', { class: 'btn danger', onclick: () => { if (confirmTwice(modal.querySelector('.danger'), 'Really resign?')) { cmd({ c: 'rg' }); toggleMenu(false); } } }, 'Resign'),
      (host || G.over) && h('button', { class: 'btn danger', id: 'btn-end', onclick: (ev) => { if (G.over || confirmTwice(ev.target, 'End the match for everyone?')) { send({ t: 'end' }); toggleMenu(false); } } }, 'Return everyone to the lobby')));
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
    h('button', { class: 'btn small ghost', onclick: (ev) => { setMuted(!isMuted()); ev.target.textContent = isMuted() ? 'Unmute everything' : 'Mute everything'; } }, isMuted() ? 'Unmute everything' : 'Mute everything'),
    nowPlaying);
}

export function showSound() {
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal-box menu' }, h('h2', null, 'Sound & music'), soundControls(),
      h('p', { class: 'muted' }, 'Hosting? Drop your own tracks into the game\'s public/music folder and your own effects into public/sfx to replace the built-in ones.'),
      h('button', { class: 'btn primary', onclick: () => modal.remove() }, 'Done')));
  document.body.append(modal);
}

export function showHelp() {
  const rows = [
    ['Left-click / drag', 'Select a unit or box-select your army (double-click: all of that type on screen)'],
    ['Right-click', 'Smart order: move, attack, gather, build/repair, or set a station\'s rally point'],
    ['Shift + order', 'Queue the order after the current one'],
    ['Q W E R T / A S D F G / Z X C V B', 'Buttons of the command card (same layout as on screen)'],
    ['A then click', 'Attack-move (army selected)'],
    ['Space', 'Commander ability'],
    ['` (key under Esc)', 'Select your commander (twice: jump there)'],
    ['H', 'Select your Kitchen HQ (twice: jump there)'],
    ['.  and  ,', 'Next idle Prep Cook · select the whole army'],
    ['Tab', 'Jump to the last "under attack" alert'],
    ['Ctrl or Shift + 1…9', 'Save a control group · press the number to recall it (twice: jump there)'],
    ['Arrow keys / screen edge / middle-drag', 'Move the camera · mouse wheel zooms · click the minimap to jump'],
    ['Delete', 'Remove the selected units or stations (Shift+Delete for a Kitchen HQ)'],
    ['Enter / Shift+Enter', 'Chat with everyone / with your team'],
    ['Esc · F10 · P', 'Cancel · menu · pause (host only)'],
  ];
  const modal = h('div', { class: 'modal', onmousedown: (ev) => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal-box help' }, h('h2', null, 'Controls'),
      h('table', null, rows.map((r) => h('tr', null, h('td', { class: 'k' }, r[0]), h('td', null, r[1])))),
      h('p', { class: 'muted' }, 'Goal: destroy every enemy Kitchen HQ (or every station, if the host picked Conquest). Gather Produce, Firewood, Spice and Salt with Prep Cooks, build Break Rooms for more staff, advance through the ages, and keep your commander alive: their aura and ability win fights.'),
      h('button', { class: 'btn primary', onclick: () => modal.remove() }, 'Got it')));
  document.body.append(modal);
}

// ------------------------------------------------------------------ game over
export function showOver(m) {
  closeOver();
  const myT = G.me >= 0 ? G.players[G.me].team : -1;
  const title = G.me < 0 ? 'Match over' : m.team === myT ? 'Victory!' : 'Defeat';
  const winners = m.summary.filter((s) => s.team === m.team).map((s) => s.name).join(' & ');
  const rows = m.summary.slice().sort((a, b) => (b.team === m.team) - (a.team === m.team) || b.kills - a.kills);
  const modal = h('div', { class: 'modal', id: 'over' },
    h('div', { class: 'modal-box over ' + (title === 'Victory!' ? 'win' : title === 'Defeat' ? 'loss' : '') },
      h('h1', null, title),
      h('p', { class: 'muted' }, (winners ? winners + (winners.includes(' & ') ? ' rule' : ' rules') + ' the kitchen' : 'Nobody is left standing') + ` after ${Math.floor(m.minutes)}:${String(Math.floor((m.minutes % 1) * 60)).padStart(2, '0')}.`),
      h('table', { class: 'score' },
        h('tr', null, ['Chef', 'Commander', 'Age', 'Defeated', 'Lost', 'Stations razed', 'Gathered'].map((t) => h('th', null, t))),
        rows.map((s) => h('tr', { class: s.team === m.team ? 'won' : '' },
          h('td', null, h('span', { class: 'dot', style: `background:${colorHex(s.color)}` }), s.name),
          h('td', null, COMMANDERS[s.commander].name), h('td', null, AGE_SHORT[s.age]), h('td', null, s.kills), h('td', null, s.lost), h('td', null, s.razed), h('td', null, s.gathered)))),
      h('div', { class: 'over-btns' },
        h('button', { class: 'btn', onclick: closeOver }, 'Look around'),
        h('button', { class: 'btn primary', onclick: () => send({ t: 'end' }) }, 'Back to the lobby'))));
  document.body.append(modal);
}
function closeOver() { const o = $('over'); if (o) o.remove(); }

export function showEliminated() {
  note('Your kitchen has fallen. You can keep watching.', 'bad');
}
