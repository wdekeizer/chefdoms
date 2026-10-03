// ============================================================================
//  Grid pathfinding: A* (8-way, no corner cutting) + line-of-sight smoothing.
//  One Pathfinder instance is shared by the whole match and reuses its typed
//  arrays between searches, so a search allocates almost nothing.
// ============================================================================

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

function octile(dx, dy) {
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

export class Pathfinder {
  /** @param {Uint8Array} block  1 = impassable tile (kept up to date by the sim) */
  constructor(w, h, block) {
    this.w = w; this.h = h; this.block = block;
    const n = w * h;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 0;
    this.heap = [];
    this.searches = 0;
    this.expanded = 0;
  }

  isBlocked(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h || this.block[y * this.w + x] !== 0;
  }
  blockedAt(fx, fy) { return this.isBlocked(Math.floor(fx), Math.floor(fy)); }

  /** Nearest walkable tile to (x,y) within maxR rings, or null. */
  nearestFree(x, y, maxR) {
    x = Math.max(0, Math.min(this.w - 1, x)); y = Math.max(0, Math.min(this.h - 1, y));
    if (!this.block[y * this.w + x]) return [x, y];
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let yy = y - r; yy <= y + r; yy++) {
        for (let xx = x - r; xx <= x + r; xx++) {
          if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== r) continue;   // ring only
          if (this.isBlocked(xx, yy)) continue;
          const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
          if (d < bd) { bd = d; best = [xx, yy]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** True if a unit can walk the straight segment without clipping a blocked tile. */
  lineClear(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    const steps = Math.ceil(dist / 0.3);
    const R = 0.25;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      if (this.blockedAt(x - R, y - R) || this.blockedAt(x + R, y - R) ||
          this.blockedAt(x - R, y + R) || this.blockedAt(x + R, y + R)) return false;
    }
    return true;
  }

  _push(i) {
    const h = this.heap, f = this.f;
    let c = h.length;
    h.push(i);
    const fi = f[i];
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (f[h[p]] <= fi) break;
      h[c] = h[p]; c = p;
    }
    h[c] = i;
  }
  _pop() {
    const h = this.heap, f = this.f;
    const top = h[0];
    const last = h.pop();
    const n = h.length;
    if (n > 0) {
      const fl = f[last];
      let c = 0;
      for (;;) {
        let l = 2 * c + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && f[h[r]] < f[h[l]]) l = r;
        if (f[h[l]] >= fl) break;
        h[c] = h[l]; c = l;
      }
      h[c] = last;
    }
    return top;
  }

  /**
   * Find a path from (sx,sy) [float tile coords].
   *   goal = { x, y }            → walk to that point (nearest free tile if blocked)
   *   goal = { rect:[x0,y0,x1,y1] } → walk to any free tile touching that footprint
   * Returns { pts:[x,y,x,y,...], partial } or null when there is nowhere to go.
   * `partial` means the goal is unreachable and the path leads as close as possible.
   */
  find(sx, sy, goal) {
    const w = this.w, h = this.h, block = this.block;
    const stx = Math.max(0, Math.min(w - 1, Math.floor(sx)));
    const sty = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const rect = goal.rect || null;
    let gx = 0, gy = 0, px = 0, py = 0;
    let rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0;
    if (rect) {
      rx0 = rect[0] - 1; ry0 = rect[1] - 1; rx1 = rect[2] + 1; ry1 = rect[3] + 1;
    } else {
      px = goal.x; py = goal.y;
      gx = Math.max(0, Math.min(w - 1, Math.floor(px)));
      gy = Math.max(0, Math.min(h - 1, Math.floor(py)));
      if (block[gy * w + gx]) {
        const nf = this.nearestFree(gx, gy, 16);
        if (!nf) return null;
        gx = nf[0]; gy = nf[1]; px = gx + 0.5; py = gy + 0.5;
      }
      if (gx === stx && gy === sty) return { pts: [px, py], partial: false };
    }
    this.searches++;

    if (++this.gen > 0xfffffff0) { this.gen = 1; this.seen.fill(0); this.closed.fill(0); }
    const gen = this.gen;
    const g = this.g, f = this.f, parent = this.parent, seen = this.seen, closed = this.closed;
    const heap = this.heap; heap.length = 0;

    const H = rect
      ? (x, y) => octile(x < rx0 ? rx0 - x : x > rx1 ? x - rx1 : 0, y < ry0 ? ry0 - y : y > ry1 ? y - ry1 : 0)
      : (x, y) => octile(Math.abs(x - gx), Math.abs(y - gy));

    const start = sty * w + stx;
    g[start] = 0; parent[start] = -1; seen[start] = gen;
    let bestH = H(stx, sty), best = start, found = -1;
    f[start] = bestH;
    this._push(start);
    const limit = w * h;
    let expanded = 0;

    while (heap.length) {
      const cur = this._pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      const cx = cur % w, cy = (cur / w) | 0;
      if (rect ? (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) : (cx === gx && cy === gy)) { found = cur; break; }
      if (++expanded > limit) break;
      const gc = g[cur];
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (block[ni] || closed[ni] === gen) continue;
        if (d >= 4 && (block[cy * w + nx] || block[ny * w + cx])) continue;   // no cutting corners
        const ng = gc + (d >= 4 ? SQRT2 : 1);
        if (seen[ni] !== gen || ng < g[ni]) {
          g[ni] = ng; parent[ni] = cur; seen[ni] = gen;
          const hh = H(nx, ny);
          f[ni] = ng + hh;
          if (hh < bestH) { bestH = hh; best = ni; }
          this._push(ni);
        }
      }
    }
    this.expanded += expanded;

    const end = found >= 0 ? found : best;
    if (end === start) {
      // Already as close as we can get. For footprint goals nudge toward the target
      // inside the current tile so the caller's reach test succeeds.
      if (rect && found >= 0) return { pts: this._rectPoint(stx, sty, rect), partial: false };
      return null;
    }

    // reconstruct tile chain (start excluded)
    const chain = [];
    for (let c = end; c !== start && c !== -1; c = parent[c]) chain.push(c);
    chain.reverse();
    const n = chain.length;

    // string-pull: skip waypoints we can walk straight past
    const pts = [];
    let ax = sx, ay = sy, i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n) {
        const c = chain[j + 1];
        if (!this.lineClear(ax, ay, (c % w) + 0.5, ((c / w) | 0) + 0.5)) break;
        j++;
      }
      const c = chain[j];
      ax = (c % w) + 0.5; ay = ((c / w) | 0) + 0.5;
      pts.push(ax, ay);
      i = j + 1;
    }

    // replace the final tile centre with the precise goal point
    if (found >= 0) {
      const ex = end % w, ey = (end / w) | 0;
      if (rect) {
        const p = this._rectPoint(ex, ey, rect);
        pts[pts.length - 2] = p[0]; pts[pts.length - 1] = p[1];
      } else {
        pts[pts.length - 2] = px; pts[pts.length - 1] = py;
      }
    }
    return { pts, partial: found < 0 };
  }

  /** A point inside tile (tx,ty) pulled toward the footprint, with a little jitter so workers don't stack. */
  _rectPoint(tx, ty, rect) {
    const cx = tx + 0.5, cy = ty + 0.5;
    const qx = Math.max(rect[0], Math.min(rect[2] + 1, cx));
    const qy = Math.max(rect[1], Math.min(rect[3] + 1, cy));
    let dx = qx - cx, dy = qy - cy;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    let x = cx + dx * 0.22 + (Math.random() - 0.5) * 0.36;
    let y = cy + dy * 0.22 + (Math.random() - 0.5) * 0.36;
    x = Math.max(tx + 0.08, Math.min(tx + 0.92, x));
    y = Math.max(ty + 0.08, Math.min(ty + 0.92, y));
    return [x, y];
  }
}
