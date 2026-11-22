// AssemblyScript navigator. Integer A* / flow fields mirror src/sim/kernels.ts.
// Neighbor order is part of the contract: E W S N SE NE SW NW.

const ORTHO: i32 = 10;
const DIAG: i32 = 14;

let grid = new Uint8Array(0);
let gridW: i32 = 0;
let gridH: i32 = 0;

function dirX(d: i32): i32 {
  if (d == 0) return 1;
  if (d == 1) return -1;
  if (d == 2) return 0;
  if (d == 3) return 0;
  if (d == 4) return 1;
  if (d == 5) return 1;
  if (d == 6) return -1;
  return -1;
}

function dirZ(d: i32): i32 {
  if (d == 0) return 0;
  if (d == 1) return 0;
  if (d == 2) return 1;
  if (d == 3) return -1;
  if (d == 4) return 1;
  if (d == 5) return -1;
  if (d == 6) return 1;
  return -1;
}

function dirCost(d: i32): i32 {
  return d < 4 ? ORTHO : DIAG;
}

function heuristic(ax: i32, az: i32, bx: i32, bz: i32): i32 {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dz = az > bz ? az - bz : bz - az;
  const mn = dx < dz ? dx : dz;
  return ORTHO * (dx + dz) + (DIAG - ORTHO * 2) * mn;
}

function inb(x: i32, z: i32): bool {
  return x >= 0 && z >= 0 && x < gridW && z < gridH;
}

function blockedAt(x: i32, z: i32): bool {
  return grid[z * gridW + x] != 0;
}

export function uploadBlocked(blocked: Uint8Array, w: i32, h: i32): void {
  if (grid.length != blocked.length) grid = new Uint8Array(blocked.length);
  for (let i = 0; i < blocked.length; i++) grid[i] = blocked[i];
  gridW = w;
  gridH = h;
}

function siftUp(heapI: Int32Array, heapF: Int32Array, count: i32, i: i32): void {
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

function pop(heapI: Int32Array, heapF: Int32Array, count: i32): i32 {
  const top = heapI[0];
  const last = count - 1;
  if (last > 0) {
    heapI[0] = heapI[last];
    heapF[0] = heapF[last];
    let i: i32 = 0;
    const n = last;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < n && heapF[l] < heapF[s]) s = l;
      if (r < n && heapF[r] < heapF[s]) s = r;
      if (s == i) break;
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

export function findPath(sx: i32, sz: i32, gx: i32, gz: i32): Int32Array {
  if (!inb(sx, sz) || !inb(gx, gz)) return new Int32Array(0);
  if (blockedAt(sx, sz) || blockedAt(gx, gz)) return new Int32Array(0);
  if (sx == gx && sz == gz) {
    const only = new Int32Array(2);
    only[0] = sx;
    only[1] = sz;
    return only;
  }
  const size = gridW * gridH;
  const gScore = new Int32Array(size);
  const came = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    gScore[i] = 0x7fffffff;
    came[i] = -1;
  }
  const startI = sz * gridW + sx;
  const goalI = gz * gridW + gx;
  gScore[startI] = 0;
  const cap = size * 2;
  const heapI = new Int32Array(cap);
  const heapF = new Int32Array(cap);
  let count: i32 = 0;
  heapI[0] = startI;
  heapF[0] = heuristic(sx, sz, gx, gz);
  count = 1;

  let expansions: i32 = 0;
  const limit = size * 4;
  while (count > 0 && expansions < limit) {
    const curI = pop(heapI, heapF, count);
    count--;
    const curG = gScore[curI];
    if (curI == goalI) break;
    expansions++;
    const cx = curI % gridW;
    const cz = curI / gridW;
    for (let d: i32 = 0; d < 8; d++) {
      const nx = cx + dirX(d);
      const nz = cz + dirZ(d);
      if (!inb(nx, nz) || blockedAt(nx, nz)) continue;
      if (dirX(d) != 0 && dirZ(d) != 0) {
        if (blockedAt(nx, cz) || blockedAt(cx, nz)) continue;
      }
      const ni = nz * gridW + nx;
      const ng = curG + dirCost(d);
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = curI;
        if (count >= cap) break;
        heapI[count] = ni;
        heapF[count] = ng + heuristic(nx, nz, gx, gz);
        count++;
        siftUp(heapI, heapF, count, count - 1);
      }
    }
  }

  if (gScore[goalI] == 0x7fffffff) return new Int32Array(0);
  const rev = new Int32Array(size);
  let n: i32 = 0;
  let cursor = goalI;
  let guard: i32 = 0;
  while (cursor != -1 && guard < size + 2) {
    rev[n] = cursor;
    n++;
    if (cursor == startI) break;
    cursor = came[cursor];
    guard++;
  }
  const out = new Int32Array(n * 2);
  for (let i: i32 = 0; i < n; i++) {
    const cell = rev[n - 1 - i];
    out[i * 2] = cell % gridW;
    out[i * 2 + 1] = cell / gridW;
  }
  return out;
}

export function flowField(gx: i32, gz: i32): Uint8Array {
  const size = gridW * gridH;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = 255;
  if (!inb(gx, gz) || blockedAt(gx, gz)) return out;
  const cost = new Int32Array(size);
  for (let i = 0; i < size; i++) cost[i] = 0x7fffffff;
  const goalI = gz * gridW + gx;
  cost[goalI] = 0;
  const cap = size * 2;
  const heapI = new Int32Array(cap);
  const heapF = new Int32Array(cap);
  let count: i32 = 1;
  heapI[0] = goalI;
  heapF[0] = 0;
  while (count > 0) {
    const curI = pop(heapI, heapF, count);
    count--;
    const curG = cost[curI];
    const cx = curI % gridW;
    const cz = curI / gridW;
    for (let d: i32 = 0; d < 8; d++) {
      const nx = cx + dirX(d);
      const nz = cz + dirZ(d);
      if (!inb(nx, nz) || blockedAt(nx, nz)) continue;
      if (dirX(d) != 0 && dirZ(d) != 0) {
        if (blockedAt(nx, cz) || blockedAt(cx, nz)) continue;
      }
      const ni = nz * gridW + nx;
      const ng = curG + dirCost(d);
      if (ng < cost[ni]) {
        cost[ni] = ng;
        if (count >= cap) break;
        heapI[count] = ni;
        heapF[count] = ng;
        count++;
        siftUp(heapI, heapF, count, count - 1);
      }
    }
  }
  for (let z: i32 = 0; z < gridH; z++) {
    for (let x: i32 = 0; x < gridW; x++) {
      const i = z * gridW + x;
      if (blockedAt(x, z) || cost[i] == 0x7fffffff || (x == gx && z == gz)) {
        out[i] = 255;
        continue;
      }
      let best = cost[i];
      let bestD: i32 = 255;
      for (let d: i32 = 0; d < 8; d++) {
        const nx = x + dirX(d);
        const nz = z + dirZ(d);
        if (!inb(nx, nz) || blockedAt(nx, nz)) continue;
        if (dirX(d) != 0 && dirZ(d) != 0) {
          if (blockedAt(nx, z) || blockedAt(x, nz)) continue;
        }
        const c = cost[nz * gridW + nx];
        if (c < best) {
          best = c;
          bestD = d;
        }
      }
      out[i] = u8(bestD);
    }
  }
  return out;
}

export function traceFlow(dirs: Uint8Array, sx: i32, sz: i32): Int32Array {
  if (!inb(sx, sz)) return new Int32Array(0);
  const max = gridW * gridH;
  const xs = new Int32Array(max);
  const zs = new Int32Array(max);
  let n: i32 = 0;
  let x = sx;
  let z = sz;
  let guard: i32 = 0;
  while (guard < max) {
    xs[n] = x;
    zs[n] = z;
    n++;
    const d: i32 = dirs[z * gridW + x];
    if (d == 255) break;
    const nx = x + dirX(d);
    const nz = z + dirZ(d);
    if (!inb(nx, nz)) break;
    x = nx;
    z = nz;
    guard++;
  }
  const out = new Int32Array(n * 2);
  for (let i: i32 = 0; i < n; i++) {
    out[i * 2] = xs[i];
    out[i * 2 + 1] = zs[i];
  }
  return out;
}

export function updateFog(fog: Uint8Array, w: i32, h: i32, cx: Int32Array, cz: Int32Array, radii: Float32Array): Uint8Array {
  const next = new Uint8Array(fog.length);
  for (let i = 0; i < fog.length; i++) {
    const v = fog[i];
    next[i] = v == 2 ? 1 : v;
  }
  const count = cx.length;
  for (let n = 0; n < count; n++) {
    const r = radii[n];
    const r2 = r * r;
    const ri = i32(Math.ceil(r));
    const cxi = cx[n];
    const czi = cz[n];
    for (let dz: i32 = -ri; dz <= ri; dz++) {
      for (let dx: i32 = -ri; dx <= ri; dx++) {
        if (f32(dx * dx + dz * dz) > r2) continue;
        const x = cxi + dx;
        const z = czi + dz;
        if (x < 0 || z < 0 || x >= w || z >= h) continue;
        next[z * w + x] = 2;
      }
    }
  }
  return next;
}

export function separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array {
  const n = xs.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (radii[i] <= 0) continue;
    let sx: f32 = 0;
    let sz: f32 = 0;
    for (let j = 0; j < n; j++) {
      if (i == j || radii[j] <= 0) continue;
      const ox = xs[i] - xs[j];
      const oz = zs[i] - zs[j];
      const d = Mathf.sqrt(ox * ox + oz * oz);
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

export function integrate(
  xs: Float32Array,
  zs: Float32Array,
  txs: Float32Array,
  tzs: Float32Array,
  sepX: Float32Array,
  sepZ: Float32Array,
  speeds: Float32Array,
  dt: f32,
): Float32Array {
  const n = xs.length;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const step = stepUnit(xs[i], zs[i], txs[i], tzs[i], sepX[i], sepZ[i], speeds[i], dt);
    out[i * 4] = step[0];
    out[i * 4 + 1] = step[1];
    out[i * 4 + 2] = step[2];
    out[i * 4 + 3] = step[3];
  }
  return out;
}

function stepUnit(x: f32, z: f32, tx: f32, tz: f32, sepX: f32, sepZ: f32, speed: f32, dt: f32): Float32Array {
  let dx = tx - x;
  let dz = tz - z;
  let dist = Mathf.sqrt(dx * dx + dz * dz);
  if (dist < 0.0001) dist = 1;
  dx /= dist;
  dz /= dist;
  let vx = dx + sepX * 1.7;
  let vz = dz + sepZ * 1.7;
  let vl = Mathf.sqrt(vx * vx + vz * vz);
  if (vl < 0.0001) vl = 1;
  vx = (vx / vl) * speed;
  vz = (vz / vl) * speed;
  let nx = x + vx * dt;
  let nz = z + vz * dt;
  const out = new Float32Array(4);
  if (!walkable(nx, nz)) {
    if (walkable(nx, z)) nz = z;
    else if (walkable(x, nz)) nx = x;
    else {
      out[0] = x;
      out[1] = z;
      out[2] = f32(Math.atan2(vx, vz));
      out[3] = 1;
      return out;
    }
  }
  const moved = Mathf.sqrt((nx - x) * (nx - x) + (nz - z) * (nz - z));
  out[0] = nx;
  out[1] = nz;
  out[2] = f32(Math.atan2(vx, vz));
  out[3] = moved < speed * dt * 0.2 ? 1 : 0;
  return out;
}

function walkable(px: f32, pz: f32): bool {
  const cx = i32(Math.floor(px));
  const cz = i32(Math.floor(pz));
  if (!inb(cx, cz)) return false;
  return grid[cz * gridW + cx] == 0;
}
