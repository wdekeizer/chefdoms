// ============================================================================
//  Hotkeys: every action has a default key, players can rebind any of them in
//  Menu → Controls, and the choice is remembered in this browser.
//
//  Two presets: the classic one (arrow keys move the camera; the command card
//  uses Q W E R T / A S D F G / Z X C V B) and "WASD camera", which gives
//  W A S D to the camera and shifts the command card to
//  Q E R T Y / F G H J K / Z X C V B.
// ============================================================================
const GRID_CLASSIC = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'];
const GRID_WASD = ['KeyQ', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'];

/** id, label, classic default, WASD-preset default, group. '' = no key. */
export const ACTIONS = [
  ['camUp', 'Camera up (extra key)', '', 'KeyW', 'Camera'],
  ['camLeft', 'Camera left (extra key)', '', 'KeyA', 'Camera'],
  ['camDown', 'Camera down (extra key)', '', 'KeyS', 'Camera'],
  ['camRight', 'Camera right (extra key)', '', 'KeyD', 'Camera'],
  ['zoomIn', 'Zoom in', 'Equal', 'Equal', 'Camera'],
  ['zoomOut', 'Zoom out', 'Minus', 'Minus', 'Camera'],
  ['follow', 'Lock / free the camera on your hero (capture the flag)', 'KeyY', 'Semicolon', 'Camera'],
  ['ability', 'Commander ability', 'Space', 'Space', 'Commands'],
  ['ultimate', 'Commander ultimate (from the Bistro Age)', 'KeyO', 'KeyO', 'Commands'],
  ['endTurn', 'End your turn (turn-based mode)', 'KeyI', 'KeyI', 'Commands'],
  ['hero', 'Select commander (twice: jump there)', 'Backquote', 'Backquote', 'Commands'],
  ['hq', 'Select Kitchen HQ (twice: jump there)', 'KeyH', 'KeyN', 'Commands'],
  ['idle', 'Next idle Prep Cook (turn-based: next unit that can act)', 'Period', 'Period', 'Commands'],
  ['army', 'Select the whole army', 'Comma', 'Comma', 'Commands'],
  ['alert', 'Jump to the last alert or ping', 'Tab', 'Tab', 'Commands'],
  ['ping', 'Ping the map for your team (then click)', 'KeyM', 'KeyM', 'Commands'],
  ['bell', 'Ring / silence the HQ bell', 'KeyU', 'KeyU', 'Commands'],
  ['formation', 'Next formation', 'KeyL', 'KeyL', 'Commands'],
  ['pause', 'Pause (host only)', 'KeyP', 'KeyP', 'Commands'],
  ...GRID_CLASSIC.map((code, i) => ['card' + i, `Command card: row ${((i / 5) | 0) + 1}, button ${(i % 5) + 1}`, code, GRID_WASD[i], 'Command card']),
].map(([id, label, def, wasd, group]) => ({ id, label, def, wasd, group }));

const store = {
  get(k) { try { return localStorage.getItem('chefdoms.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('chefdoms.' + k, v); } catch { /* private mode */ } },
};

let wasd = store.get('wasd') === '1';
let custom = {};                      // action id -> code, only for keys the player changed
try { const j = JSON.parse(store.get('keys') || '{}'); if (j && typeof j === 'object') custom = j; } catch { /* keep defaults */ }
let byCode = new Map();
const listeners = [];

function rebuild() {
  byCode = new Map();
  for (const a of ACTIONS) { const c = keyOf(a.id); if (c) byCode.set(c, a.id); }
  for (const fn of listeners) fn();
}
function save() { store.set('keys', JSON.stringify(custom)); store.set('wasd', wasd ? '1' : '0'); rebuild(); }

const actionById = (id) => ACTIONS.find((a) => a.id === id);
/** The key code currently bound to an action ('' if none). */
export function keyOf(id) {
  if (Object.prototype.hasOwnProperty.call(custom, id)) return custom[id];
  const a = actionById(id);
  return a ? (wasd ? a.wasd : a.def) : '';
}
/** The action a key code triggers, or undefined. */
export const actionOf = (code) => byCode.get(code);
export const isWasd = () => wasd;
/** Switch preset. Keys the player set by hand are dropped, so the preset is consistent. */
export function setWasd(on) { wasd = !!on; custom = {}; save(); }
export function resetKeys() { custom = {}; save(); }
/** Bind `code` to an action; whatever used that key before loses it. */
export function setKey(id, code) {
  if (!actionById(id)) return;
  if (code) for (const a of ACTIONS) if (a.id !== id && keyOf(a.id) === code) custom[a.id] = '';
  custom[id] = code;
  for (const k of Object.keys(custom)) { const b = actionById(k); if (!b || custom[k] === (wasd ? b.wasd : b.def)) delete custom[k]; }   // same as the preset = not custom
  save();
}
export function onKeysChanged(fn) { listeners.push(fn); }

const NAMES = {
  Space: 'Space', Backquote: '`', Period: '.', Comma: ',', Tab: 'Tab', Equal: '=', Minus: '-', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Insert: 'Ins', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', CapsLock: 'Caps', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
};
/** Short printable name of a key code: 'KeyQ' -> 'Q', 'Digit1' -> '1', 'Space' -> 'Space'. */
export function keyLabel(code) {
  if (!code) return '';
  if (NAMES[code]) return NAMES[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit(\d)$/.exec(code); if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code); if (m) return 'Num ' + m[1];
  return code;
}
export const labelOf = (id) => keyLabel(keyOf(id));

/** Keys that cannot be rebound because the game uses them for fixed things. */
const RESERVED = /^(Escape|Enter|NumpadEnter|Delete|Backspace|F\d+|Digit\d|Arrow(Up|Down|Left|Right)|Meta(Left|Right)|OS(Left|Right))$/;
export const canBind = (code) => !!code && !RESERVED.test(code);

rebuild();
