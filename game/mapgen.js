// ============================================================================
//  Map generation. A seed fully determines the map.
//  Every player gets the same guaranteed pantry around their Kitchen HQ
//  (veggies, firewood, spice, salt); the middle of the map holds richer,
//  contested deposits.
// ============================================================================
import { TILE, makeRng } from './data.js';

function makeNoise(rng) {
  const seed = (rng() * 4294967296) >>> 0;
  const hash = (x, y) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x, y) => (noise(x, y) + 0.5 * noise(x * 2.03 + 11.7, y * 2.03 + 5.3) + 0.25 * noise(x * 4.1 + 3.1, y * 4.1 + 8.9)) / 1.75;
}

function quantile(arr, q) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];

/**
 * @returns {{w:number,h:number,tiles:Uint8Array,starts:{x:number,y:number,tx:number,ty:number}[],nodes:{type:string,tx:number,ty:number}[],seed:number}}
 */
export function generateMap(size, nPlayers, seed) {
  const rng = makeRng(seed);
  const w = size, h = size, N = w * h;
  const tiles = new Uint8Array(N);
  const nodeAt = new Uint8Array(N);
  let nodes = [];

  // --- terrain: forests and ponds from noise ---------------------------------
  const forest = makeNoise(rng), water = makeNoise(rng);
  const fv = new Float32Array(N), wv = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    fv[y * w + x] = forest(x / 7.5, y / 7.5);
    wv[y * w + x] = water(x / 12, y / 12);
  }
  const fThr = quantile(fv, 0.80), wThr = quantile(wv, 0.965);
  for (let i = 0; i < N; i++) tiles[i] = wv[i] > wThr ? TILE.WATER : fv[i] > fThr ? TILE.TREE : TILE.GRASS;

  // --- player start positions on a ring ---------------------------------------
  const c = size / 2, R = size * 0.33;
  const a0 = rng() * Math.PI * 2;
  const starts = [];
  for (let i = 0; i < nPlayers; i++) {
    const a = a0 + (i * Math.PI * 2) / nPlayers;
    const x = Math.round(c + Math.cos(a) * R), y = Math.round(c + Math.sin(a) * R);
    starts.push({ x, y, tx: x - 2, ty: y - 2 });
  }
  for (const s of starts) {
    for (let y = s.y - 11; y <= s.y + 11; y++) for (let x = s.x - 11; x <= s.x + 11; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) <= 10.2) tiles[y * w + x] = TILE.GRASS;
    }
  }

  // no puddles: ponds smaller than 6 tiles (e.g. what is left after clearing a base) are filled in
  {
    const seenW = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (tiles[i] !== TILE.WATER || seenW[i]) continue;
      const body = [i];
      seenW[i] = 1;
      for (let qi = 0; qi < body.length; qi++) {
        const cur = body[qi], cx = cur % w, cy = (cur / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX4[d], ny = cy + DY4[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (tiles[ni] === TILE.WATER && !seenW[ni]) { seenW[ni] = 1; body.push(ni); }
        }
      }
      if (body.length < 6) for (const t of body) tiles[t] = TILE.GRASS;
    }
  }

  const nearHQ = (x, y) => {
    for (const s of starts) if (Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) < 4.6) return true;
    return false;
  };
  const free = (x, y) => x >= 2 && y >= 2 && x < w - 2 && y < h - 2 && tiles[y * w + x] === TILE.GRASS && !nodeAt[y * w + x] && !nearHQ(x, y);

  // Grow a blob of `count` tiles around (cx,cy); `put(x,y)` places one.
  function blob(cx, cy, count, put, allow = free) {
    cx = Math.max(4, Math.min(w - 5, Math.round(cx)));
    cy = Math.max(4, Math.min(h - 5, Math.round(cy)));
    let seedTile = null;
    for (let r = 0; r <= 5 && !seedTile; r++) {
      for (let y = cy - r; y <= cy + r && !seedTile; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) === r && allow(x, y)) { seedTile = [x, y]; break; }
      }
    }
    if (!seedTile) return 0;
    const placed = [seedTile];
    put(seedTile[0], seedTile[1]);
    let guard = 0;
    while (placed.length < count && guard++ < count * 40) {
      const b = placed[(rng() * placed.length) | 0];
      const d = (rng() * 4) | 0;
      const nx = b[0] + DX4[d], ny = b[1] + DY4[d];
      if (allow(nx, ny)) { put(nx, ny); placed.push([nx, ny]); }
    }
    return placed.length;
  }
  const putNode = (type) => (x, y) => { nodeAt[y * w + x] = 1; nodes.push({ type, tx: x, ty: y }); };
  const putTree = (x, y) => { tiles[y * w + x] = TILE.TREE; };

  // --- each player's home pantry ----------------------------------------------
  const PLAN = [
    ['veg', 6, 6.6], ['tree', 16, 8.6], ['spice', 4, 9.0], ['tree', 16, 9.4],
    ['salt', 3, 10.4], ['veg', 5, 13.5], ['spice', 4, 14.5], ['tree', 22, 13.0],
  ];
  for (const s of starts) {
    const base = rng() * Math.PI * 2;
    const order = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = 7; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    PLAN.forEach(([type, count, dist], k) => {
      const ang = base + (order[k] * Math.PI * 2) / 8 + (rng() - 0.5) * 0.3;
      const x = s.x + Math.cos(ang) * dist, y = s.y + Math.sin(ang) * dist;
      if (type === 'tree') blob(x, y, count, putTree);
      else blob(x, y, count, putNode(type));
    });
  }

  // --- contested deposits in the middle ---------------------------------------
  const neutral = [];
  const farFromAll = (x, y, d) => starts.every((s) => Math.hypot(x - s.x, y - s.y) >= d) && neutral.every((n) => Math.hypot(x - n[0], y - n[1]) >= 9);
  blob(c + (rng() - 0.5) * 6, c + (rng() - 0.5) * 6, 8, putNode('spice'));
  neutral.push([c, c]);
  const want = nPlayers * 2 + 3;
  const kinds = [['salt', 5], ['veg', 6], ['spice', 6]];
  for (let k = 0, tries = 0; k < want && tries < 400; tries++) {
    const x = 6 + rng() * (w - 12), y = 6 + rng() * (h - 12);
    if (!farFromAll(x, y, 19)) continue;
    const [type, count] = kinds[k % kinds.length];
    if (blob(x, y, count, putNode(type))) { neutral.push([x, y]); k++; }
  }

  // --- make sure every base can reach every other base -------------------------
  const walk = (i) => tiles[i] === TILE.GRASS && !nodeAt[i];
  const flood = () => {
    const seen = new Uint8Array(N);
    const s0 = starts[0];
    const q = [(s0.y + 3) * w + s0.x];
    seen[q[0]] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi], cx = cur % w, cy = (cur / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d], ny = cy + DY4[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !walk(ni)) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  };
  const carve = (s) => {
    const x0 = s.x, y0 = s.y + 3;
    const steps = Math.ceil(Math.hypot(c - x0, c - y0) * 2);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((c - x0) * i) / steps), y = Math.round(y0 + ((c - y0) * i) / steps);
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
        if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        tiles[yy * w + xx] = TILE.GRASS; nodeAt[yy * w + xx] = 0;
      }
    }
  };
  let seen = flood();
  if (starts.some((s) => !seen[(s.y + 3) * w + s.x])) {
    for (const s of starts) carve(s);
    nodes = nodes.filter((n) => nodeAt[n.ty * w + n.tx]);
  }

  return { w, h, tiles, starts, nodes, seed };
}
