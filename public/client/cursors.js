// ============================================================================
//  Mouse cursors drawn at start-up (no image files): a sword for attacking, a
//  basket for gathering, a hammer for building, an arrow for delivering and a
//  beacon for pinging. cursorFor(kind) returns a CSS `cursor` value.
// ============================================================================
const SIZE = 32;
const cache = {};

function make(draw, hx, hy, fallback) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const c = cv.getContext('2d');
  c.lineJoin = c.lineCap = 'round';
  draw(c);
  return `url(${cv.toDataURL()}) ${hx} ${hy}, ${fallback}`;
}
/** Stroke the current path twice: a dark outline, then the colour. */
function line(c, col, w) { c.strokeStyle = '#1b1411'; c.lineWidth = w + 3; c.stroke(); c.strokeStyle = col; c.lineWidth = w; c.stroke(); }
function shape(c, col) { c.fillStyle = col; c.fill(); c.strokeStyle = '#1b1411'; c.lineWidth = 1.5; c.stroke(); }

const DRAW = {
  // blade from the top-left (the tip is the hot spot) down to a red grip
  attack: [(c) => {
    c.beginPath(); c.moveTo(2, 2); c.lineTo(9, 4); c.lineTo(22, 17); c.lineTo(17, 22); c.lineTo(4, 9); c.closePath(); shape(c, '#eef3f5');
    c.beginPath(); c.moveTo(5, 5); c.lineTo(18, 18); c.strokeStyle = '#9fb0b8'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.moveTo(14, 25); c.lineTo(25, 14); line(c, '#f0b41c', 3);
    c.beginPath(); c.moveTo(21, 21); c.lineTo(28, 28); line(c, '#e2403a', 4);
  }, 2, 2, 'crosshair'],
  gather: [(c) => {
    c.beginPath(); c.arc(16, 15, 8, Math.PI, 0); line(c, '#b98443', 2.5);
    c.beginPath(); c.moveTo(5, 15); c.lineTo(27, 15); c.lineTo(24, 28); c.lineTo(8, 28); c.closePath(); shape(c, '#cf9f58');
    c.beginPath(); c.moveTo(7, 20); c.lineTo(25, 20); c.moveTo(8, 24); c.lineTo(24, 24); c.strokeStyle = '#a5743a'; c.lineWidth = 1.2; c.stroke();
    c.beginPath(); c.moveTo(1, 1); c.lineTo(10, 4); c.lineTo(4, 10); c.closePath(); shape(c, '#ffe45c');
  }, 1, 1, 'pointer'],
  build: [(c) => {
    c.beginPath(); c.moveTo(12, 12); c.lineTo(27, 27); line(c, '#b88146', 4);
    c.save(); c.translate(10, 10); c.rotate(-Math.PI / 4);
    c.beginPath(); c.rect(-8, -5, 16, 10); shape(c, '#9aa7b0'); c.restore();
    c.beginPath(); c.moveTo(1, 1); c.lineTo(8, 2); c.lineTo(2, 8); c.closePath(); shape(c, '#ffe45c');
  }, 1, 1, 'pointer'],
  drop: [(c) => {
    c.beginPath(); c.moveTo(12, 2); c.lineTo(20, 2); c.lineTo(20, 10); c.lineTo(25, 10); c.lineTo(16, 20); c.lineTo(7, 10); c.lineTo(12, 10); c.closePath(); shape(c, '#57d657');
    c.beginPath(); c.moveTo(5, 21); c.lineTo(27, 21); c.lineTo(24, 30); c.lineTo(8, 30); c.closePath(); shape(c, '#cf9f58');
  }, 16, 20, 'pointer'],
  ping: [(c) => {
    c.beginPath(); c.arc(16, 16, 12, 0, Math.PI * 2); line(c, '#f0b41c', 3);
    c.beginPath(); c.arc(16, 16, 5, 0, Math.PI * 2); shape(c, '#f0b41c');
    c.beginPath(); c.moveTo(16, 0); c.lineTo(16, 6); c.moveTo(16, 26); c.lineTo(16, 32); c.moveTo(0, 16); c.lineTo(6, 16); c.moveTo(26, 16); c.lineTo(32, 16); line(c, '#fff8ea', 1.5);
  }, 16, 16, 'crosshair'],
};

/** CSS cursor for: '' (default) | 'point' | 'attack' | 'gather' | 'build' | 'drop' | 'ping' | 'place'. */
export function cursorFor(kind) {
  if (!kind) return 'default';
  if (kind === 'point') return 'pointer';
  if (kind === 'place') return 'crosshair';
  if (!DRAW[kind]) return 'default';
  if (!cache[kind]) { const [draw, hx, hy, fb] = DRAW[kind]; try { cache[kind] = make(draw, hx, hy, fb); } catch { cache[kind] = fb; } }
  return cache[kind];
}
