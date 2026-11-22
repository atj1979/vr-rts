/** JavaScript twins of the Wasm navigator. Keep the numerics aligned with src/wasm/assembly/nav.ts. */

export interface PathCell {
  x: number;
  z: number;
}

const ORTHO = 10;
const DIAG = 14;

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [ORTHO, ORTHO, ORTHO, ORTHO, DIAG, DIAG, DIAG, DIAG];

export function findPathCells(blocked: Uint8Array, w: number, h: number, sx: number, sz: number, gx: number, gz: number): Int32Array {
  if (sx < 0 || sz < 0 || gx < 0 || gz < 0 || sx >= w || sz >= h || gx >= w || gz >= h) return new Int32Array(0);
  if (blocked[sz * w + sx] !== 0 || blocked[gz * w + gx] !== 0) return new Int32Array(0);
  if (sx === gx && sz === gz) return Int32Array.of(sx, sz);

  const size = w * h;
  const gScore = new Int32Array(size);
  const came = new Int32Array(size);
  gScore.fill(0x7fffffff);
  came.fill(-1);
  const startI = sz * w + sx;
  const goalI = gz * w + gx;
  gScore[startI] = 0;

  const heapI: number[] = [];
  const heapF: number[] = [];
  const push = (index: number, g: number) => {
    const x = index % w;
    const z = (index / w) | 0;
    heapI.push(index);
    heapF.push(g + heuristic(x, z, gx, gz));
    siftUp(heapI, heapF, heapI.length - 1);
  };
  push(startI, 0);

  let expansions = 0;
  const limit = size * 4;
  while (heapI.length && expansions < limit) {
    const curI = pop(heapI, heapF);
    const curG = gScore[curI];
    if (curI === goalI) break;
    expansions++;
    const cx = curI % w;
    const cz = (curI / w) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d];
      const nz = cz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      if (blocked[nz * w + nx] !== 0) continue;
      if (DX[d] !== 0 && DZ[d] !== 0) {
        if (blocked[cz * w + nx] !== 0 || blocked[nz * w + cx] !== 0) continue;
      }
      const ni = nz * w + nx;
      const ng = curG + COST[d];
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = curI;
        push(ni, ng);
      }
    }
  }

  if (gScore[goalI] === 0x7fffffff) return new Int32Array(0);
  const rev: number[] = [];
  let cursor = goalI;
  let guard = 0;
  while (cursor !== -1 && guard++ < size + 2) {
    rev.push(cursor);
    if (cursor === startI) break;
    cursor = came[cursor];
  }
  rev.reverse();
  const out = new Int32Array(rev.length * 2);
  for (let i = 0; i < rev.length; i++) {
    out[i * 2] = rev[i] % w;
    out[i * 2 + 1] = (rev[i] / w) | 0;
  }
  return out;
}

export function flowField(blocked: Uint8Array, w: number, h: number, gx: number, gz: number): Uint8Array {
  const size = w * h;
  const out = new Uint8Array(size);
  out.fill(255);
  if (gx < 0 || gz < 0 || gx >= w || gz >= h || blocked[gz * w + gx] !== 0) return out;
  const cost = new Int32Array(size);
  cost.fill(0x7fffffff);
  const goalI = gz * w + gx;
  cost[goalI] = 0;
  const heapI: number[] = [goalI];
  const heapF: number[] = [0];
  while (heapI.length) {
    const curI = pop(heapI, heapF);
    const curG = cost[curI];
    const cx = curI % w;
    const cz = (curI / w) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d];
      const nz = cz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      if (blocked[nz * w + nx] !== 0) continue;
      if (DX[d] !== 0 && DZ[d] !== 0) {
        if (blocked[cz * w + nx] !== 0 || blocked[nz * w + cx] !== 0) continue;
      }
      const ni = nz * w + nx;
      const ng = curG + COST[d];
      if (ng < cost[ni]) {
        cost[ni] = ng;
        heapI.push(ni);
        heapF.push(ng);
        siftUp(heapI, heapF, heapI.length - 1);
      }
    }
  }
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (blocked[i] !== 0 || cost[i] === 0x7fffffff || (x === gx && z === gz)) {
        out[i] = 255;
        continue;
      }
      let best = cost[i];
      let bestD = 255;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d];
        const nz = z + DZ[d];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        if (blocked[nz * w + nx] !== 0) continue;
        if (DX[d] !== 0 && DZ[d] !== 0) {
          if (blocked[z * w + nx] !== 0 || blocked[nz * w + x] !== 0) continue;
        }
        const c = cost[nz * w + nx];
        if (c < best) {
          best = c;
          bestD = d;
        }
      }
      out[i] = bestD;
    }
  }
  return out;
}

export function traceFlow(dirs: Uint8Array, w: number, h: number, sx: number, sz: number): Int32Array {
  if (sx < 0 || sz < 0 || sx >= w || sz >= h) return new Int32Array(0);
  const max = w * h;
  const xs: number[] = [];
  const zs: number[] = [];
  let x = sx;
  let z = sz;
  for (let guard = 0; guard < max; guard++) {
    xs.push(x);
    zs.push(z);
    const d = dirs[z * w + x];
    if (d === 255 || d === undefined) break;
    const nx = x + DX[d];
    const nz = z + DZ[d];
    if (nx < 0 || nz < 0 || nx >= w || nz >= h) break;
    x = nx;
    z = nz;
  }
  const out = new Int32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i];
    out[i * 2 + 1] = zs[i];
  }
  return out;
}

/** Visible cells (2) decay to explored (1), then sight circles are stamped visible. */
export function updateFog(
  fog: Uint8Array,
  w: number,
  h: number,
  cx: Int32Array,
  cz: Int32Array,
  radii: Float32Array,
): Uint8Array {
  const next = new Uint8Array(fog);
  for (let i = 0; i < next.length; i++) if (next[i] === 2) next[i] = 1;
  const count = cx.length;
  for (let n = 0; n < count; n++) {
    const r = radii[n];
    const r2 = r * r;
    const ri = Math.ceil(r);
    const cxi = cx[n];
    const czi = cz[n];
    for (let dz = -ri; dz <= ri; dz++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const x = cxi + dx;
        const z = czi + dz;
        if (x < 0 || z < 0 || x >= w || z >= h) continue;
        next[z * w + x] = 2;
      }
    }
  }
  return next;
}

/** Pairwise overlap push. `out[i*2]` / `out[i*2+1]` is the separation vector for unit i. */
export function separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array {
  const n = xs.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (radii[i] <= 0) continue;
    let sx = 0;
    let sz = 0;
    for (let j = 0; j < n; j++) {
      if (i === j || radii[j] <= 0) continue;
      const ox = xs[i] - xs[j];
      const oz = zs[i] - zs[j];
      const d = Math.hypot(ox, oz);
      const min = radii[i] + radii[j];
      if (d > 0.0001 && d < min) {
        const push = (min - d) / min;
        sx += (ox / d) * push;
        sz += (oz / d) * push;
      }
    }
    out[i * 2] = sx;
    out[i * 2 + 1] = sz;
  }
  return out;
}

/**
 * Slide each mover toward its waypoint, mixing in separation.
 * Returns n*4 floats: x, z, yaw, stuck (1 if progress stalled).
 */
export function integrate(
  blocked: Uint8Array,
  w: number,
  h: number,
  xs: Float32Array,
  zs: Float32Array,
  txs: Float32Array,
  tzs: Float32Array,
  sepX: Float32Array,
  sepZ: Float32Array,
  speeds: Float32Array,
  dt: number,
): Float32Array {
  const n = xs.length;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const step = integrateOne(blocked, w, h, xs[i], zs[i], txs[i], tzs[i], sepX[i], sepZ[i], speeds[i], dt);
    out[i * 4] = step[0];
    out[i * 4 + 1] = step[1];
    out[i * 4 + 2] = step[2];
    out[i * 4 + 3] = step[3];
  }
  return out;
}

export function integrateOne(
  blocked: Uint8Array,
  w: number,
  h: number,
  x: number,
  z: number,
  tx: number,
  tz: number,
  sepX: number,
  sepZ: number,
  speed: number,
  dt: number,
): Float32Array {
  let dx = tx - x;
  let dz = tz - z;
  let dist = Math.hypot(dx, dz);
  if (dist < 0.0001) dist = 1;
  dx /= dist;
  dz /= dist;
  let vx = dx + sepX * 1.7;
  let vz = dz + sepZ * 1.7;
  const vl = Math.hypot(vx, vz) || 1;
  vx = (vx / vl) * speed;
  vz = (vz / vl) * speed;
  let nx = x + vx * dt;
  let nz = z + vz * dt;
  const walk = (px: number, pz: number) => {
    const cx = Math.floor(px);
    const cz = Math.floor(pz);
    if (cx < 0 || cz < 0 || cx >= w || cz >= h) return false;
    return blocked[cz * w + cx] === 0;
  };
  if (!walk(nx, nz)) {
    if (walk(nx, z)) nz = z;
    else if (walk(x, nz)) nx = x;
    else return Float32Array.of(x, z, Math.atan2(vx, vz), 1);
  }
  const moved = Math.hypot(nx - x, nz - z);
  const stuck = moved < speed * dt * 0.2 ? 1 : 0;
  return Float32Array.of(nx, nz, Math.atan2(vx, vz), stuck);
}

export function smoothPath(cells: PathCell[], blocked: (x: number, z: number) => boolean): PathCell[] {
  if (cells.length <= 2) return cells;
  const out: PathCell[] = [cells[0]];
  let anchor = 0;
  while (anchor < cells.length - 1) {
    let farthest = anchor + 1;
    for (let i = cells.length - 1; i > anchor + 1; i--) {
      if (lineClear(cells[anchor], cells[i], blocked)) {
        farthest = i;
        break;
      }
    }
    out.push(cells[farthest]);
    anchor = farthest;
  }
  return out;
}

function lineClear(a: PathCell, b: PathCell, blocked: (x: number, z: number) => boolean): boolean {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(dist * 2));
  let px = a.x;
  let pz = a.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const z = Math.round(a.z + (b.z - a.z) * t);
    if (blocked(x, z)) return false;
    if (x !== px && z !== pz) {
      if (blocked(x, pz) || blocked(px, z)) return false;
    }
    px = x;
    pz = z;
  }
  return true;
}

function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return ORTHO * (dx + dz) + (DIAG - ORTHO * 2) * Math.min(dx, dz);
}

function siftUp(heapI: number[], heapF: number[], i: number): void {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p] <= heapF[i]) break;
    const ti = heapI[p];
    heapI[p] = heapI[i];
    heapI[i] = ti;
    const tf = heapF[p];
    heapF[p] = heapF[i];
    heapF[i] = tf;
    i = p;
  }
}

function pop(heapI: number[], heapF: number[]): number {
  const top = heapI[0];
  const lastI = heapI.pop()!;
  const lastF = heapF.pop()!;
  if (heapI.length) {
    heapI[0] = lastI;
    heapF[0] = lastF;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < heapF.length && heapF[l] < heapF[s]) s = l;
      if (r < heapF.length && heapF[r] < heapF[s]) s = r;
      if (s === i) break;
      const ti = heapI[s];
      heapI[s] = heapI[i];
      heapI[i] = ti;
      const tf = heapF[s];
      heapF[s] = heapF[i];
      heapF[i] = tf;
      i = s;
    }
  }
  return top;
}
