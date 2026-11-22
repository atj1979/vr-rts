import { MAP_H, MAP_W, NODE_AMOUNT, type ResourceKind } from './defs.ts';

export interface TerrainMap {
  w: number;
  h: number;
  /** Vertex heights, length (w+1)*(h+1), row = z. */
  heights: Float32Array;
  /** Terrain impassable (cliffs). Buildings/nodes are layered on later. */
  terrainBlocked: Uint8Array;
  sites: {
    playerFoundry: { x: number; z: number };
    aiFoundry: { x: number; z: number };
    nodes: { kind: ResourceKind; x: number; z: number; amount: number }[];
  };
}

const SLOPE_LIMIT = 0.5;

export function generateMap(seed: number): TerrainMap {
  const heights = new Float32Array((MAP_W + 1) * (MAP_H + 1));
  for (let z = 0; z <= MAP_H; z++) {
    for (let x = 0; x <= MAP_W; x++) {
      heights[z * (MAP_W + 1) + x] = rawHeight(x, z, seed);
    }
  }

  flattenDisc(heights, 6.5, 6.5, 6.5);
  flattenDisc(heights, MAP_W - 7.5, MAP_H - 7.5, 6.5);

  const terrainBlocked = new Uint8Array(MAP_W * MAP_H);
  recomputeBlocked(heights, terrainBlocked);

  const playerCell = { x: 5, z: 5 };
  const aiCell = { x: MAP_W - 8, z: MAP_H - 8 };
  carveCorridor(heights, terrainBlocked, playerCell.x + 1, playerCell.z + 1, aiCell.x + 1, aiCell.z + 1);

  const nodes = placeNodes(terrainBlocked, seed);

  return {
    w: MAP_W,
    h: MAP_H,
    heights,
    terrainBlocked,
    sites: {
      playerFoundry: playerCell,
      aiFoundry: aiCell,
      nodes,
    },
  };
}

export function sampleHeight(heights: Float32Array, x: number, z: number): number {
  const x0 = clamp(Math.floor(x), 0, MAP_W);
  const z0 = clamp(Math.floor(z), 0, MAP_H);
  const x1 = clamp(x0 + 1, 0, MAP_W);
  const z1 = clamp(z0 + 1, 0, MAP_H);
  const tx = x - Math.floor(x);
  const tz = z - Math.floor(z);
  const h00 = heights[z0 * (MAP_W + 1) + x0];
  const h10 = heights[z0 * (MAP_W + 1) + x1];
  const h01 = heights[z1 * (MAP_W + 1) + x0];
  const h11 = heights[z1 * (MAP_W + 1) + x1];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

function rawHeight(x: number, z: number, seed: number): number {
  const sx = seed * 0.017;
  const n = fbm(x * 0.085 + sx, z * 0.085 + sx * 1.7);
  let h = Math.pow(n, 1.2) * 1.25;
  const ridgeX = (x - MAP_W / 2) / 2.15;
  const ridge = Math.exp(-(ridgeX * ridgeX));
  const along = 0.62 + 0.28 * Math.sin(z * 0.42 + seed);
  const gapZ = (z - MAP_H * 0.48) / 3.2;
  const gap = Math.exp(-(gapZ * gapZ));
  h += ridge * along * (1 - gap * 0.92);
  const basin = Math.exp(-((x - 20) * (x - 20) + (z - 14) * (z - 14)) / 28);
  h -= basin * 0.28;
  return Math.max(0, h);
}

function flattenDisc(heights: Float32Array, cx: number, cz: number, radius: number): void {
  let sum = 0;
  let count = 0;
  for (let z = 0; z <= MAP_H; z++) {
    for (let x = 0; x <= MAP_W; x++) {
      if (Math.hypot(x - cx, z - cz) <= radius) {
        sum += heights[z * (MAP_W + 1) + x];
        count++;
      }
    }
  }
  const avg = count ? sum / count : 0.4;
  const r2 = radius + 1.5;
  for (let z = 0; z <= MAP_H; z++) {
    for (let x = 0; x <= MAP_W; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= radius) heights[z * (MAP_W + 1) + x] = avg;
      else if (d < r2) {
        const t = (d - radius) / (r2 - radius);
        const i = z * (MAP_W + 1) + x;
        heights[i] = avg * (1 - t) + heights[i] * t;
      }
    }
  }
}

function recomputeBlocked(heights: Float32Array, blocked: Uint8Array): void {
  blocked.fill(0);
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      const h00 = heights[z * (MAP_W + 1) + x];
      const h10 = heights[z * (MAP_W + 1) + x + 1];
      const h01 = heights[(z + 1) * (MAP_W + 1) + x];
      const h11 = heights[(z + 1) * (MAP_W + 1) + x + 1];
      const max = Math.max(h00, h10, h01, h11);
      const min = Math.min(h00, h10, h01, h11);
      if (max - min > SLOPE_LIMIT) blocked[z * MAP_W + x] = 1;
    }
  }
}

/** Guarantee a route between the two claims by flattening a ribbon if A* would fail. */
function carveCorridor(
  heights: Float32Array,
  blocked: Uint8Array,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): void {
  if (reachable(blocked, x0, z0, x1, z1)) return;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const z = Math.round(z0 + (z1 - z0) * t);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= MAP_W || cz >= MAP_H) continue;
        const h = heights[cz * (MAP_W + 1) + cx];
        heights[cz * (MAP_W + 1) + cx] = h;
        heights[cz * (MAP_W + 1) + cx + 1] = h;
        heights[(cz + 1) * (MAP_W + 1) + cx] = h;
        heights[(cz + 1) * (MAP_W + 1) + cx + 1] = h;
        blocked[cz * MAP_W + cx] = 0;
      }
    }
  }
}

function reachable(blocked: Uint8Array, x0: number, z0: number, x1: number, z1: number): boolean {
  const seen = new Uint8Array(MAP_W * MAP_H);
  const q: number[] = [z0 * MAP_W + x0];
  seen[z0 * MAP_W + x0] = 1;
  const goal = z1 * MAP_W + x1;
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    if (cur === goal) return true;
    const x = cur % MAP_W;
    const z = (cur / MAP_W) | 0;
    const nbs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dz] of nbs) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
      const ni = nz * MAP_W + nx;
      if (seen[ni] || blocked[ni]) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return false;
}

function placeNodes(blocked: Uint8Array, seed: number): TerrainMap['sites']['nodes'] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const wishes: { kind: ResourceKind; x: number; z: number }[] = [
    { kind: 'shard', x: 12, z: 6 },
    { kind: 'shard', x: 6, z: 13 },
    { kind: 'flux', x: 14, z: 13 },
    { kind: 'shard', x: MAP_W - 14, z: MAP_H - 8 },
    { kind: 'shard', x: MAP_W - 8, z: MAP_H - 15 },
    { kind: 'flux', x: MAP_W - 16, z: MAP_H - 15 },
    { kind: 'shard', x: 18, z: 18 },
    { kind: 'shard', x: 23, z: 16 },
    { kind: 'flux', x: 20, z: 22 },
    { kind: 'shard', x: 16, z: 24 },
  ];
  const placed: TerrainMap['sites']['nodes'] = [];
  const occupied = blocked.slice();
  for (const wish of wishes) {
    const spot = findPad(occupied, wish.x, wish.z, 2, rng);
    if (!spot) continue;
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) occupied[(spot.z + dz) * MAP_W + (spot.x + dx)] = 1;
    }
    placed.push({ kind: wish.kind, x: spot.x, z: spot.z, amount: NODE_AMOUNT[wish.kind] });
  }
  return placed;
}

function findPad(
  blocked: Uint8Array,
  x: number,
  z: number,
  size: number,
  rng: () => number,
): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;
  for (let dz = -8; dz <= 8; dz++) {
    for (let dx = -8; dx <= 8; dx++) {
      const cx = x + dx;
      const cz = z + dz;
      if (!padFree(blocked, cx, cz, size)) continue;
      const jitter = rng() * 0.35;
      const score = dx * dx + dz * dz + jitter;
      if (score < bestScore) {
        bestScore = score;
        best = { x: cx, z: cz };
      }
    }
  }
  return best;
}

function padFree(blocked: Uint8Array, x: number, z: number, size: number): boolean {
  if (x < 1 || z < 1 || x + size >= MAP_W - 1 || z + size >= MAP_H - 1) return false;
  for (let dz = -1; dz <= size; dz++) {
    for (let dx = -1; dx <= size; dx++) {
      const cx = x + dx;
      const cz = z + dz;
      if (cx < 0 || cz < 0 || cx >= MAP_W || cz >= MAP_H) return false;
      if (blocked[cz * MAP_W + cx]) return false;
    }
  }
  return true;
}

function fbm(x: number, y: number): number {
  let amp = 0.55;
  let sum = 0;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(fx, fy);
    norm += amp;
    amp *= 0.5;
    fx = fx * 2.03 + 11;
    fy = fy * 2.03 + 7;
  }
  return sum / norm;
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const v00 = hash2(x0, y0);
  const v10 = hash2(x0 + 1, y0);
  const v01 = hash2(x0, y0 + 1);
  const v11 = hash2(x0 + 1, y0 + 1);
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function hash2(ix: number, iy: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
