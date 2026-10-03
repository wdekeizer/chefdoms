// ============================================================================
//  Mouse and keyboard: selection, right-click orders, building placement,
//  camera control, control groups and hotkeys.
// ============================================================================
import { G, K_UNIT, K_BLDG, K_NODE, canSee, isAlly, selected, setSelection, cmd, send, statsOf, maxHp } from './state.js';
import { screenToWorld, zoomBy, canPlaceLocal, view } from './render.js';
import { BUILDINGS, TILE } from '/game/data.js';
import { sfx } from './audio.js';

const keys = {};
let hooks = { selection() {}, cardKey() { return false; }, openChat() {}, toggleMenu() {}, note() {} };
let canvas = null;
let pan = null;                 // middle-mouse camera drag
let lastClick = { id: 0, t: 0 };
let lastTap = { code: '', t: 0 };
let edgeScroll = true;

export function setEdgeScroll(v) { edgeScroll = !!v; }
export const mark = (x, y, color) => G.marks.push({ x, y, t0: performance.now(), color });

function centerOn(x, y) { G.cam.x = x; G.cam.y = y; }

// -------------------------------------------------------------------- picking
export function pickEntity(wx, wy) {
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

// ------------------------------------------------------------- right-click
export function contextCommand(wx, wy, shift) {
  const own = selected().filter((e) => e.owner === G.me);
  if (!own.length || G.me < 0) return;
  const units = own.filter((e) => e.kind === K_UNIT), bl = own.filter((e) => e.kind === K_BLDG);
  const target = pickEntity(wx, wy);
  const tx = Math.floor(wx), ty = Math.floor(wy);
  const tileIdx = tx >= 0 && ty >= 0 && tx < G.w && ty < G.h ? ty * G.w + tx : -1;
  const isTree = tileIdx >= 0 && G.tiles[tileIdx] === TILE.TREE && G.fogExp[tileIdx] === 1;
  const q = shift ? 1 : 0;
  const idsOf = (list) => list.map((e) => e.id);

  if (!units.length) {                       // stations selected: set the rally point
    if (!bl.length) return;
    const o = { c: 'ry', bids: idsOf(bl), x: wx, y: wy };
    if (target && (target.kind === K_NODE || (target.kind === K_BLDG && target.owner === G.me))) o.tid = target.id;
    else if (isTree) o.tree = tileIdx;
    cmd(o); mark(wx, wy, '#ffffff'); sfx('move');
    return;
  }
  const cooks = units.filter((e) => e.type === 'cook'), others = units.filter((e) => e.type !== 'cook');
  const moveTo = (list) => { if (list.length) cmd({ c: 'mv', ids: idsOf(list), x: wx, y: wy, q }); };

  if (target) {
    if (target.kind !== K_NODE && !isAlly(target.owner)) {
      cmd({ c: 'at', ids: idsOf(units), tid: target.id, q });
      mark(target.rx, target.ry, '#ff5a4d'); sfx('attack');
      return;
    }
    if (target.kind === K_NODE) {
      if (cooks.length) cmd({ c: 'ga', ids: idsOf(cooks), tid: target.id, q });
      moveTo(others);
      mark(target.x, target.y, '#ffe45c'); sfx('move');
      return;
    }
    if (target.kind === K_BLDG) {
      if (cooks.length) {
        const full = target.hp >= maxHp(target);
        if (target.type === 'garden' && target.prog >= 100 && full && target.owner === G.me) cmd({ c: 'ga', ids: idsOf(cooks), tid: target.id, q });
        else if (target.prog < 100 || !full) cmd({ c: 'ba', ids: idsOf(cooks), tid: target.id, q });
        else moveTo(cooks);
      }
      moveTo(others);
      mark(target.x, target.y, '#ffe45c'); sfx('move');
      return;
    }
    if (target.kind === K_UNIT) {             // a friendly unit: baristas top it up, everyone else walks over
      const healers = units.filter((e) => (statsOf(e) || {}).heal > 0 && e.id !== target.id);
      if (healers.length && target.hp < maxHp(target)) {
        cmd({ c: 'hl', ids: idsOf(healers), tid: target.id, q });
        moveTo(units.filter((e) => !healers.includes(e)));
        mark(target.rx, target.ry, '#7dff8a'); sfx('move');
        return;
      }
    }
  }
  if (isTree && cooks.length) {
    cmd({ c: 'ga', ids: idsOf(cooks), tree: tileIdx, q });
    moveTo(others);
    mark(tx + 0.5, ty + 0.5, '#ffe45c'); sfx('move');
    return;
  }
  cmd({ c: 'mv', ids: idsOf(units), x: wx, y: wy, q });
  mark(wx, wy, '#8dff6a'); sfx('move');
}

function attackMoveTo(wx, wy, shift) {
  const units = selected().filter((e) => e.owner === G.me && e.kind === K_UNIT);
  if (!units.length) return;
  const target = pickEntity(wx, wy);
  if (target && target.kind !== K_NODE && !isAlly(target.owner)) cmd({ c: 'at', ids: units.map((e) => e.id), tid: target.id, q: shift ? 1 : 0 });
  else cmd({ c: 'am', ids: units.map((e) => e.id), x: wx, y: wy, q: shift ? 1 : 0 });
  mark(wx, wy, '#ff5a4d'); sfx('attack');
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
    const same = (e.kind === K_UNIT ? G.units : G.bldgs).filter((x) => x.owner === G.me && x.type === e.type && inView(x));
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
  let list = G.units.filter((e) => e.owner === G.me && e.rx >= ax && e.rx <= bx && e.ry - 0.35 >= ay - 0.4 && e.ry - 0.35 <= by + 0.1);
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
  const idle = G.units.filter((e) => e.owner === G.me && e.type === 'cook' && e.st === 0).sort((a, b) => a.id - b.id);
  if (!idle.length) { hooks.note('No idle Prep Cooks'); return; }
  const cur = selected();
  const last = cur.length === 1 ? cur[0].id : 0;
  const e = idle.find((x) => x.id > last) || idle[0];
  setSelection([e]); centerOn(e.rx, e.ry);
  hooks.selection();
}
export function selectArmy() {
  const list = G.units.filter((e) => e.owner === G.me && e.type !== 'cook');
  if (list.length) { setSelection(list); hooks.selection(); }
}
function selectHQ(center) {
  const hq = G.bldgs.filter((e) => e.owner === G.me && e.type === 'hq');
  if (!hq.length) return;
  setSelection([hq[0]]);
  if (center) centerOn(hq[0].x, hq[0].y);
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
  keys[ev.code] = true;
  const now = performance.now();
  const double = lastTap.code === ev.code && now - lastTap.t < 350;
  if (!ev.repeat) lastTap = { code: ev.code, t: now };

  if (/^Digit[0-9]$/.test(ev.code)) {
    const d = ev.code.slice(5);
    if (ev.ctrlKey || ev.shiftKey || ev.altKey) { G.groups[d] = [...G.sel]; hooks.note('Group ' + d + ' set'); }
    else if (G.groups[d]) {
      const list = G.groups[d].map((id) => G.ents.get(id)).filter(Boolean);
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
      break;
    case 'Delete': case 'Backspace': deleteSelected(ev.shiftKey); break;
    case 'Enter': case 'NumpadEnter': hooks.openChat(ev.shiftKey); ev.preventDefault(); break;
    case 'Space': cmd({ c: 'ab' }); ev.preventDefault(); break;
    case 'Backquote': selectHero(double); break;
    case 'KeyH': selectHQ(double); break;
    case 'Period': selectIdleCook(); break;
    case 'Comma': selectArmy(); break;
    case 'F10': hooks.toggleMenu(); ev.preventDefault(); break;
    case 'KeyP': if (G.cid === G.hostId) send({ t: 'pause' }); break;
    case 'Equal': case 'NumpadAdd': zoomBy(1, window.innerWidth / 2, window.innerHeight / 2); break;
    case 'Minus': case 'NumpadSubtract': zoomBy(-1, window.innerWidth / 2, window.innerHeight / 2); break;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': ev.preventDefault(); break;
    case 'Tab': case 'KeyJ':                     // jump to the last "under attack" alert
      if (G.lastAlert) centerOn(G.lastAlert.x, G.lastAlert.y);
      ev.preventDefault();
      break;
    default:
      if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) { if (hooks.cardKey(ev.key.toUpperCase(), ev.shiftKey)) ev.preventDefault(); }
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
  if (ev.button === 1) { pan = { x: ev.clientX, y: ev.clientY, cx: G.cam.x, cy: G.cam.y }; ev.preventDefault(); return; }
  if (ev.button === 2) {
    if (G.mode) { G.mode = null; return; }
    contextCommand(wx, wy, ev.shiftKey);
    return;
  }
  if (ev.button !== 0) return;
  const mode = G.mode;
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
  if (G.sel.size) sfx('select');
  hooks.selection();
}

/** Called every frame: keyboard / edge scrolling, and keep the mouse's world position fresh. */
export function updateInput(dt) {
  if (G.phase !== 'game') return;
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  let dx = 0, dy = 0;
  if (!typing) {
    if (keys.ArrowLeft) dx -= 1;
    if (keys.ArrowRight) dx += 1;
    if (keys.ArrowUp) dy -= 1;
    if (keys.ArrowDown) dy += 1;
  }
  if (edgeScroll && G.mouse.onPage && !pan && document.hasFocus()) {
    const m = 6, x = G.mouse.x, y = G.mouse.y;
    if (x <= m) dx -= 1; else if (x >= window.innerWidth - m - 1) dx += 1;
    if (y <= m) dy -= 1; else if (y >= window.innerHeight - m - 1) dy += 1;
  }
  if (dx || dy) {
    const speed = (1100 * view.dpr) / G.cam.scale;         // tiles per second
    const len = Math.hypot(dx, dy);
    G.cam.x += (dx / len) * speed * dt; G.cam.y += (dy / len) * speed * dt;
  }
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
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; pan = null; G.drag = null; G.mouse.onPage = false; });
  document.documentElement.addEventListener('mouseleave', () => { G.mouse.onPage = false; G.mouse.inside = false; });
  document.documentElement.addEventListener('mouseenter', () => { G.mouse.onPage = true; });
  window.addEventListener('mousemove', () => { G.mouse.onPage = true; });
}
