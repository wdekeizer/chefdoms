// ============================================================================
//  Mouse and keyboard: selection, right-click orders, building placement,
//  camera control, control groups, pings and hotkeys (see keys.js for the
//  bindings, which players can change).
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, canSee, isAlly, selected, setSelection, cmd, send, statsOf, maxHp } from './state.js';
import { screenToWorld, zoomBy, canPlaceLocal, view } from './render.js';
import { BUILDINGS, TILE, FORMATIONS } from '/game/data.js';
import { sfx } from './audio.js';
import { actionOf, keyOf, labelOf } from './keys.js';
import * as TAC from './tactics.js';

const keys = {};
let hooks = { selection() {}, cardKey() { return false; }, openChat() {}, toggleMenu() {}, note() {}, unitSound() {} };
let canvas = null;
let pan = null;                 // middle-mouse camera drag
let lastClick = { id: 0, t: 0 };
let lastTap = { code: '', t: 0 };
let edgeScroll = true;
let camSpeed = 1;               // multiplier from the Controls menu
let leftAt = 0;                 // when the pointer last left the page (it keeps scrolling for a moment)

const EDGE_X = 10, EDGE_TOP = 8, EDGE_BOTTOM = 6;   // px from each window edge that scroll the camera (narrow where the HUD has buttons)
const CAM_PX_PER_S = 1500;      // camera speed in screen pixels per second at 100%

export function setEdgeScroll(v) { edgeScroll = !!v; }
export function setCamSpeed(v) { camSpeed = Math.max(0.4, Math.min(2.5, Number(v) || 1)); }
export const mark = (x, y, color) => G.marks.push({ x, y, t0: performance.now(), color });

function centerOn(x, y, unlock) { if (unlock && G.follow) toggleFollow(false); G.cam.x = x; G.cam.y = y; }

/** Capture the flag: lock the camera on your hero (it scrolls with the hero) or free it again. */
export function toggleFollow(v) {
  const on = v === undefined ? !G.follow : !!v;
  if (on === G.follow) return;
  G.follow = on;
  if (on) { const h = myHeroEnt(); if (h) { G.cam.x = h.rx; G.cam.y = h.ry; } }
  hooks.note(on ? `Camera locked on your hero (${labelOf('follow')} frees it)` : `Free camera (${labelOf('follow')} locks it on your hero)`);
  hooks.selection();
}
const myHeroEnt = () => { const p = G.me >= 0 ? G.ps[G.me] : null; return p && p.heroId ? G.ents.get(p.heroId) : null; };

// -------------------------------------------------------------------- picking
/** The unit, station or resource under a map position (units first). */
export function pickEntity(wx, wy) {
  if (G.tb) return TAC.pickTile(wx, wy);          // on the tactics grid a click means a tile
  let best = null, bd = 1;
  for (const e of G.units) {
    if (!canSee(e)) continue;
    const k = e.type.startsWith('hero_') ? 1.35 : 1;
    const dx = (wx - e.rx) / Math.max(0.42, e.r * 1.35 * k), dy = (wy - (e.ry - 0.42 * k)) / (0.58 * k);
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) return best;
  const tx = Math.floor(wx), ty = Math.floor(wy);
  if (tx < 0 || ty < 0 || tx >= G.w || ty >= G.h) return null;
  const e = G.ents.get(G.occ[ty * G.w + tx]);
  if (e && canSee(e)) return e;
  if (ty + 1 < G.h) {                       // station art rises above its footprint
    const b = G.ents.get(G.occ[(ty + 1) * G.w + tx]);
    if (b && b.kind === K_BLDG && b.type !== 'garden' && canSee(b) && wy > b.ty - 0.55) return b;
  }
  return null;
}

/**
 * What a Prep Cook could work on at a map position, ignoring any units standing there:
 * { ent } for a resource node or one of your stations, { tree: tileIndex } for a tree, or null.
 * A tree's crown hangs over the tile behind it, so the lower three quarters of that tile count as the tree.
 */
export function pickWork(wx, wy) {
  const tx = Math.floor(wx), ty = Math.floor(wy);
  if (tx < 0 || ty < 0 || tx >= G.w || ty >= G.h) return null;
  const i = ty * G.w + tx;
  const e = G.ents.get(G.occ[i]);
  if (e && canSee(e) && (e.kind === K_NODE || (e.kind === K_BLDG && isAlly(e.owner)))) return { ent: e };
  if (G.tiles[i] === TILE.TREE && G.fogExp[i] === 1) return { tree: i };
  if (ty + 1 < G.h && wy - ty > 0.25) {
    const j = i + G.w;
    if (G.tiles[j] === TILE.TREE && G.fogExp[j] === 1 && !G.occ[i]) return { tree: j };
  }
  return null;
}

/** What the cursor should say about the thing under it: '' | 'attack' | 'gather' | 'build' | 'drop'. Also fills G.hover / G.hoverTree. */
export function hoverIntent(wx, wy) {
  if (G.tb) return TAC.hover(wx, wy);
  G.hoverTree = -1;
  const e = pickEntity(wx, wy);
  G.hover = e ? e.id : 0;
  const own = G.me >= 0 ? selected().filter((x) => x.owner === G.me && x.kind === K_UNIT) : [];
  if (!own.length) return e ? 'point' : '';
  if (e && e.kind !== K_NODE && !isAlly(e.owner)) return 'attack';
  if (!own.some((x) => x.type === 'cook')) return e ? 'point' : '';
  const w = pickWork(wx, wy);
  if (!w) return e ? 'point' : '';
  if (w.tree !== undefined) { G.hover = 0; G.hoverTree = w.tree; return 'gather'; }
  const t = w.ent;
  G.hover = t.id;
  if (t.kind === K_NODE) return 'gather';
  if (t.owner !== G.me && t.prog >= 100 && t.hp >= maxHp(t)) return 'point';
  if (t.prog < 100 || t.hp < maxHp(t)) return 'build';
  if (t.type === 'garden') return 'gather';
  return (statsOf(t) || {}).dropoff && own.some((x) => x.type === 'cook' && x.carry) ? 'drop' : 'point';
}

// ------------------------------------------------------------- right-click
export function contextCommand(wx, wy, shift) {
  if (G.tb) { TAC.click(wx, wy, true); return; }
  const own = selected().filter((e) => e.owner === G.me);
  if (!own.length || G.me < 0) return;
  const units = own.filter((e) => e.kind === K_UNIT), bl = own.filter((e) => e.kind === K_BLDG);
  let target = pickEntity(wx, wy);
  const q = shift ? 1 : 0;
  const idsOf = (list) => list.map((e) => e.id);

  if (!units.length) {                       // stations selected: set the rally point
    if (!bl.length) return;
    const o = { c: 'ry', bids: idsOf(bl), x: wx, y: wy };
    const w = pickWork(wx, wy);
    if (target && (target.kind === K_NODE || (target.kind === K_BLDG && target.owner === G.me))) o.tid = target.id;
    else if (w && w.tree !== undefined) o.tree = w.tree;
    else if (w && w.ent.kind === K_NODE) o.tid = w.ent.id;
    cmd(o); mark(wx, wy, '#ffffff'); sfx('move');
    return;
  }
  const cooks = units.filter((e) => e.type === 'cook'), others = units.filter((e) => e.type !== 'cook');
  const army = others.length > 1 ? G.formation : 0;
  const moveTo = (list) => { if (list.length) cmd({ c: 'mv', ids: idsOf(list), x: wx, y: wy, q, f: list === others || !cooks.length ? army : 0 }); };
  const ack = (kind) => hooks.unitSound(units, kind);

  if (target && target.kind !== K_NODE && !isAlly(target.owner)) {
    cmd({ c: 'at', ids: idsOf(units), tid: target.id, q });
    const tx = target.kind === K_UNIT ? target.rx : target.x, ty = target.kind === K_UNIT ? target.ry : target.y;
    mark(tx, ty, '#ff5a4d');
    G.fx.push({ kind: 'atkmark', x: tx, y: ty, t0: performance.now(), dur: 650 });
    ack('attack');
    return;
  }
  // Prep Cooks care about what is on the ground, not about a colleague who happens to stand in front of it
  const work = cooks.length ? pickWork(wx, wy) : null;
  if (work && (!target || target.kind === K_UNIT || target === work.ent)) {
    if (work.tree !== undefined) {
      cmd({ c: 'ga', ids: idsOf(cooks), tree: work.tree, q });
      moveTo(others);
      mark((work.tree % G.w) + 0.5, ((work.tree / G.w) | 0) + 0.5, '#ffe45c'); ack('gather');
      return;
    }
    target = work.ent;
  }
  if (target) {
    if (target.kind === K_NODE) {
      if (cooks.length) cmd({ c: 'ga', ids: idsOf(cooks), tid: target.id, q });
      moveTo(others);
      mark(target.x, target.y, '#ffe45c'); ack(cooks.length ? 'gather' : 'move');
      return;
    }
    if (target.kind === K_BLDG) {
      if (cooks.length) {
        const full = target.hp >= maxHp(target), mine = target.owner === G.me, done = target.prog >= 100;
        if (target.type === 'garden' && done && full && mine) cmd({ c: 'ga', ids: idsOf(cooks), tid: target.id, q });
        else if (!done || !full) cmd({ c: 'ba', ids: idsOf(cooks), tid: target.id, q });
        else if (mine && (statsOf(target) || {}).dropoff) cmd({ c: 'dr', ids: idsOf(cooks), tid: target.id, q });     // bank what they carry
        else moveTo(cooks);
      }
      moveTo(others);
      mark(target.x, target.y, '#ffe45c'); ack(cooks.length && (target.prog < 100 || target.hp < maxHp(target)) ? 'build' : 'move');
      return;
    }
    if (target.kind === K_UNIT) {             // a friendly unit: baristas top it up, everyone else walks over
      const healers = units.filter((e) => (statsOf(e) || {}).heal > 0 && e.id !== target.id);
      if (healers.length && target.hp < maxHp(target)) {
        cmd({ c: 'hl', ids: idsOf(healers), tid: target.id, q });
        const rest = units.filter((e) => !healers.includes(e));
        if (rest.length) cmd({ c: 'mv', ids: idsOf(rest), x: wx, y: wy, q });
        mark(target.rx, target.ry, '#7dff8a'); ack('move');
        return;
      }
    }
  }
  cmd({ c: 'mv', ids: idsOf(units), x: wx, y: wy, q, f: cooks.length ? 0 : army });
  mark(wx, wy, '#8dff6a'); ack('move');
}

function attackMoveTo(wx, wy, shift) {
  const units = selected().filter((e) => e.owner === G.me && e.kind === K_UNIT);
  if (!units.length) return;
  const target = pickEntity(wx, wy);
  const army = units.filter((e) => e.type !== 'cook').length > 1 ? G.formation : 0;
  if (target && target.kind !== K_NODE && !isAlly(target.owner)) cmd({ c: 'at', ids: units.map((e) => e.id), tid: target.id, q: shift ? 1 : 0 });
  else cmd({ c: 'am', ids: units.map((e) => e.id), x: wx, y: wy, q: shift ? 1 : 0, f: army });
  mark(wx, wy, '#ff5a4d');
  G.fx.push({ kind: 'atkmark', x: wx, y: wy, t0: performance.now(), dur: 650 });
  hooks.unitSound(units, 'attack');
}

/** Tell the team to look at a spot on the map. */
export function pingAt(wx, wy) {
  if (G.me < 0 || G.over) return;
  send({ t: 'mp', x: Math.round(wx * 10) / 10, y: Math.round(wy * 10) / 10 });
}

/** Choose the formation the army uses from now on, and form up on the spot. */
export function setFormation(f, reform = true) {
  G.formation = Math.max(0, Math.min(FORMATIONS.length - 1, f | 0));
  try { localStorage.setItem('chefdoms.formation', String(G.formation)); } catch { /* private mode */ }
  const ids = selected().filter((e) => e.owner === G.me && e.kind === K_UNIT && e.type !== 'cook').map((e) => e.id);
  if (reform && G.formation > 0 && ids.length > 1) cmd({ c: 'fm', ids, f: G.formation });
}

export function toggleBell() {
  const me = G.ps[G.me];
  if (!me || !me.alive || G.tb) return;
  cmd({ c: 'bell', on: me.bell ? 0 : 1 });
}

// ------------------------------------------------------------------ selection
function inView(e) {
  const [x0, y0] = screenToWorld(0, 0), [x1, y1] = screenToWorld(window.innerWidth, window.innerHeight);
  return e.rx >= x0 && e.rx <= x1 && e.ry >= y0 && e.ry <= y1;
}

function clickSelect(wx, wy, ev) {
  const e = pickEntity(wx, wy);
  const now = performance.now();
  if (!e) { if (!ev.shiftKey) G.sel.clear(); return; }
  const dbl = (e.id === lastClick.id && now - lastClick.t < 350) || ev.ctrlKey;
  lastClick = { id: e.id, t: now };
  if (dbl && e.owner === G.me) {                // everything of this type on screen
    const same = (e.kind === K_UNIT ? G.units : G.bldgs).filter((x) => x.owner === G.me && x.type === e.type && canSee(x) && inView(x));
    if (ev.shiftKey) for (const x of same) G.sel.add(x.id); else setSelection(same);
    return;
  }
  if (ev.shiftKey && e.owner === G.me) {
    const cur = selected();
    if (cur.length && cur.every((x) => x.owner === G.me && x.kind === e.kind)) {
      if (G.sel.has(e.id)) G.sel.delete(e.id); else G.sel.add(e.id);
      return;
    }
  }
  setSelection([e]);
}

function boxSelect(d, shift) {
  const [ax, ay] = screenToWorld(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
  const [bx, by] = screenToWorld(Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
  let list = G.units.filter((e) => e.owner === G.me && canSee(e) && e.rx >= ax && e.rx <= bx && e.ry - 0.35 >= ay - 0.4 && e.ry - 0.35 <= by + 0.1);
  if (list.length) {
    // a mixed drag takes the army and leaves the prep cooks working
    if (list.some((e) => e.type !== 'cook')) list = list.filter((e) => e.type !== 'cook');
  } else {
    list = G.bldgs.filter((e) => e.owner === G.me && e.x >= ax && e.x <= bx && e.y >= ay && e.y <= by);
    if (list.length) { const t = list[0].type; list = list.filter((e) => e.type === t); }
  }
  if (!list.length) { if (!shift) G.sel.clear(); return; }
  if (shift && selected().every((e) => e.owner === G.me && e.kind === list[0].kind)) for (const e of list) G.sel.add(e.id);
  else setSelection(list);
}

// ----------------------------------------------------------------- hot keys
export function selectHero(center) {
  const p = G.ps[G.me];
  const h = p && p.heroId ? G.ents.get(p.heroId) : null;
  if (!h) return;
  setSelection([h]);
  if (center) centerOn(h.rx, h.ry);
  hooks.selection();
}
export function selectIdleCook() {
  if (G.tb) { const e = TAC.nextUnit(); if (e) centerOn(e.rx, e.ry); return; }      // turn-based: the next unit that can still act
  const idle = G.units.filter((e) => e.owner === G.me && e.type === 'cook' && e.st === 0).sort((a, b) => a.id - b.id);
  if (!idle.length) { hooks.note('No idle Prep Cooks'); return; }
  const cur = selected();
  const last = cur.length === 1 ? cur[0].id : 0;
  const e = idle.find((x) => x.id > last) || idle[0];
  setSelection([e]); centerOn(e.rx, e.ry);
  hooks.selection();
}
export function selectArmy() {
  if (G.tb) return;
  const list = G.units.filter((e) => e.owner === G.me && e.type !== 'cook' && canSee(e));
  if (list.length) { setSelection(list); hooks.selection(); }
}
export function selectHQ(center) {
  const hq = G.bldgs.filter((e) => e.owner === G.me && e.type === 'hq');
  if (!hq.length) return;
  const cur = selected(), i = cur.length === 1 ? hq.indexOf(cur[0]) : -1;
  const pick = center ? hq[Math.max(0, i)] : hq[(i + 1) % hq.length];      // press again to cycle through several HQs
  setSelection([pick]);
  if (center) centerOn(pick.x, pick.y);
  hooks.selection();
}
export function deleteSelected(force) {
  const ids = selected().filter((e) => e.owner === G.me && (force || e.type !== 'hq')).map((e) => e.id);
  if (ids.length) cmd({ c: 'dl', ids });
}
export function stopSelected() {
  const ids = selected().filter((e) => e.owner === G.me && e.kind === K_UNIT).map((e) => e.id);
  if (ids.length) cmd({ c: 'st', ids });
}

function onKeyDown(ev) {
  if (G.phase !== 'game') return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
  if (document.querySelector('.modal.keys-open')) return;          // the Controls screen is listening for a new key
  keys[ev.code] = true;
  if (ev.key === 'Alt') { ev.preventDefault(); return; }           // Alt+click pings; don't let the browser grab the menu bar
  const now = performance.now();
  const double = lastTap.code === ev.code && now - lastTap.t < 350;
  if (!ev.repeat) lastTap = { code: ev.code, t: now };

  if (/^Digit[0-9]$/.test(ev.code)) {
    const d = ev.code.slice(5);
    if (ev.ctrlKey || ev.shiftKey || ev.altKey) { G.groups[d] = [...G.sel]; hooks.note('Group ' + d + ' set'); }
    else if (G.groups[d]) {
      const list = G.groups[d].map((id) => G.ents.get(id)).filter((e) => e && canSee(e));
      if (list.length) {
        setSelection(list);
        if (double) { let x = 0, y = 0; for (const e of list) { x += e.rx; y += e.ry; } centerOn(x / list.length, y / list.length); }
        hooks.selection();
      }
    }
    ev.preventDefault();
    return;
  }
  switch (ev.code) {
    case 'Escape':
      if (G.mode) G.mode = null; else if (!hooks.toggleMenu(false)) { G.sel.clear(); hooks.selection(); }
      return;
    case 'Delete': case 'Backspace': deleteSelected(ev.shiftKey); return;
    case 'Enter': case 'NumpadEnter': hooks.openChat(ev.shiftKey); ev.preventDefault(); return;
    case 'F10': hooks.toggleMenu(); ev.preventDefault(); return;
    case 'NumpadAdd': zoomBy(1, window.innerWidth / 2, window.innerHeight / 2); return;
    case 'NumpadSubtract': zoomBy(-1, window.innerWidth / 2, window.innerHeight / 2); return;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': ev.preventDefault(); return;
  }
  if (ev.ctrlKey || ev.metaKey) return;                            // leave browser shortcuts alone
  const act = actionOf(ev.code);
  if (!act) return;
  ev.preventDefault();
  if (act.startsWith('cam')) return;                               // held keys are read every frame in updateInput
  if (ev.repeat && act !== 'zoomIn' && act !== 'zoomOut') return;
  if (act.startsWith('card')) { hooks.cardKey(+act.slice(4), ev.shiftKey); return; }
  switch (act) {
    case 'ability': cmd({ c: 'ab' }); break;
    case 'ultimate': cmd({ c: 'ul' }); break;
    case 'endTurn': if (G.tb) { if (TAC.endTurn()) sfx('endturn'); hooks.selection(); } break;
    case 'hero': selectHero(double); break;
    case 'hq': selectHQ(double); break;
    case 'idle': selectIdleCook(); break;
    case 'army': selectArmy(); break;
    case 'alert': if (G.lastAlert) centerOn(G.lastAlert.x, G.lastAlert.y, true); break;
    case 'follow': if (G.ctf && G.me >= 0) toggleFollow(); break;
    case 'ping': if (G.me >= 0) G.mode = { type: 'ping' }; break;
    case 'bell': toggleBell(); break;
    case 'formation': if (G.tb) break; setFormation((G.formation + 1) % FORMATIONS.length); hooks.note('Formation: ' + FORMATIONS[G.formation].name); hooks.selection(); break;
    case 'pause': if (G.cid === G.hostId) send({ t: 'pause' }); break;
    case 'zoomIn': zoomBy(1, window.innerWidth / 2, window.innerHeight / 2); break;
    case 'zoomOut': zoomBy(-1, window.innerWidth / 2, window.innerHeight / 2); break;
  }
}

// -------------------------------------------------------------------- mouse
function updateMouse(ev) {
  G.mouse.x = ev.clientX; G.mouse.y = ev.clientY;
  G.mouse.inside = ev.target === canvas;
  [G.mouse.wx, G.mouse.wy] = screenToWorld(ev.clientX, ev.clientY);
}

function onMouseDown(ev) {
  if (G.phase !== 'game') return;
  updateMouse(ev);
  if (document.activeElement && document.activeElement.blur && document.activeElement.tagName === 'INPUT') document.activeElement.blur();
  const { wx, wy } = G.mouse;
  if (ev.button === 1) { if (G.follow) toggleFollow(false); pan = { x: ev.clientX, y: ev.clientY, cx: G.cam.x, cy: G.cam.y }; ev.preventDefault(); return; }
  if (ev.button === 2) {
    if (G.mode) { G.mode = null; return; }
    contextCommand(wx, wy, ev.shiftKey);
    return;
  }
  if (ev.button !== 0) return;
  const mode = G.mode;
  if (ev.altKey || (mode && mode.type === 'ping')) {                 // Alt+click (or the ping key, then click)
    pingAt(wx, wy);
    if (mode && mode.type === 'ping' && !ev.shiftKey) G.mode = null;
    ev.preventDefault();
    return;
  }
  if (G.tb) { TAC.click(wx, wy, false); return; }
  if (mode && mode.type === 'place') {
    const B = BUILDINGS[mode.b];
    const tx = Math.round(wx - B.size / 2), ty = Math.round(wy - B.size / 2);
    if (!canPlaceLocal(mode.b, tx, ty)) { sfx('error'); hooks.note("Can't build there"); return; }
    const ids = selected().filter((e) => e.owner === G.me && e.type === 'cook').map((e) => e.id);
    if (!ids.length) { G.mode = null; return; }
    cmd({ c: 'bp', ids, b: mode.b, tx, ty, q: ev.shiftKey ? 1 : 0 });
    sfx('place');
    if (!ev.shiftKey) G.mode = null;
    return;
  }
  if (mode && mode.type === 'amove') {
    attackMoveTo(wx, wy, ev.shiftKey);
    if (!ev.shiftKey) G.mode = null;
    return;
  }
  G.drag = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY };
}

function onMouseMove(ev) {
  updateMouse(ev);
  G.mouse.onPage = true;
  if (pan) {
    G.cam.x = pan.cx - (ev.clientX - pan.x) * view.dpr / G.cam.scale;
    G.cam.y = pan.cy - (ev.clientY - pan.y) * view.dpr / G.cam.scale;
  }
  if (G.drag) { G.drag.x1 = ev.clientX; G.drag.y1 = ev.clientY; }
}

function onMouseUp(ev) {
  if (ev.button === 1) { pan = null; return; }
  if (ev.button !== 0 || !G.drag) return;
  const d = G.drag;
  G.drag = null;
  if (G.phase !== 'game') return;
  if (Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) < 7) {
    const [wx, wy] = screenToWorld(d.x0, d.y0);
    clickSelect(wx, wy, ev);
  } else boxSelect(d, ev.shiftKey);
  const sel = selected();
  if (sel.length) hooks.unitSound(sel, 'select');
  hooks.selection();
}

/** Called every frame: keyboard / edge scrolling, and keep the mouse's world position fresh. */
export function updateInput(dt) {
  if (G.phase !== 'game') return;
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  let dx = 0, dy = 0;
  if (!typing) {
    if (keys.ArrowLeft || keys[keyOf('camLeft')]) dx -= 1;
    if (keys.ArrowRight || keys[keyOf('camRight')]) dx += 1;
    if (keys.ArrowUp || keys[keyOf('camUp')]) dy -= 1;
    if (keys.ArrowDown || keys[keyOf('camDown')]) dy += 1;
  }
  // The pointer at (or just past) a window edge scrolls. In a browser window the pointer easily
  // overshoots the edge, so it keeps counting for a moment after it has left the page.
  const lingering = !G.mouse.onPage && performance.now() - leftAt < 2500;
  if (edgeScroll && !pan && !G.drag && document.hasFocus() && (G.mouse.onPage || lingering)) {
    const x = G.mouse.x, y = G.mouse.y;
    if (x <= EDGE_X) dx -= 1; else if (x >= window.innerWidth - EDGE_X - 1) dx += 1;
    if (y <= EDGE_TOP) dy -= 1; else if (y >= window.innerHeight - EDGE_BOTTOM - 1) dy += 1;
  }
  if (G.follow && G.ctf) {                                           // capture the flag: the camera rides along with the hero
    const h = myHeroEnt();
    if (h) {
      const k = Math.min(1, dt * 9);
      G.cam.vx = Math.sign(h.rx - G.cam.x); G.cam.vy = Math.sign(h.ry - G.cam.y);
      G.cam.x += (h.rx - G.cam.x) * k; G.cam.y += (h.ry - G.cam.y) * k;
    } else { G.cam.vx = 0; G.cam.vy = 0; }
    [G.mouse.wx, G.mouse.wy] = screenToWorld(G.mouse.x, G.mouse.y);
    return;
  }
  if (dx || dy) {
    const speed = (CAM_PX_PER_S * camSpeed * view.dpr) / G.cam.scale;         // tiles per second
    const len = Math.hypot(dx, dy);
    G.cam.x += (dx / len) * speed * dt; G.cam.y += (dy / len) * speed * dt;
    G.cam.vx = dx; G.cam.vy = dy;                // which way we are heading (the renderer prepares terrain ahead)
  } else { G.cam.vx = 0; G.cam.vy = 0; }
  [G.mouse.wx, G.mouse.wy] = screenToWorld(G.mouse.x, G.mouse.y);
}

export function initInput(cv, h) {
  canvas = cv; hooks = { ...hooks, ...h };
  cv.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  cv.addEventListener('wheel', (ev) => { if (G.phase === 'game') { zoomBy(ev.deltaY < 0 ? 1 : -1, ev.clientX, ev.clientY); ev.preventDefault(); } }, { passive: false });
  window.addEventListener('contextmenu', (ev) => { if (G.phase === 'game') ev.preventDefault(); });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (ev) => { keys[ev.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; pan = null; G.drag = null; G.mouse.onPage = false; leftAt = 0; });
  document.documentElement.addEventListener('mouseleave', (ev) => {
    G.mouse.onPage = false; G.mouse.inside = false;
    // remember where it went out, so that edge keeps scrolling briefly
    G.mouse.x = Math.max(0, Math.min(window.innerWidth - 1, ev.clientX)); G.mouse.y = Math.max(0, Math.min(window.innerHeight - 1, ev.clientY));
    leftAt = performance.now();
  });
  document.documentElement.addEventListener('mouseenter', () => { G.mouse.onPage = true; });
}
