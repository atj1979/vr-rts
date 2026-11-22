import * as THREE from 'three';
import {
  BUILDING_STATS,
  MAP_H,
  MAP_W,
  type Owner,
  type ResourceKind,
} from '../sim/defs.ts';
import type { Simulation } from '../sim/sim.ts';

export type PickHit =
  | { kind: 'unit'; id: number; owner: Owner; t: number; x: number; z: number }
  | { kind: 'building'; id: number; owner: Owner; t: number; x: number; z: number }
  | { kind: 'node'; id: number; resource: ResourceKind; t: number; x: number; z: number }
  | { kind: 'ground'; t: number; x: number; z: number; y: number };

const _ray = new THREE.Ray();

export function rayToMap(ray: THREE.Ray, mapRoot: THREE.Object3D, target: THREE.Ray = _ray): THREE.Ray {
  mapRoot.updateWorldMatrix(true, false);
  const inv = _inv.copy(mapRoot.matrixWorld).invert();
  _origin.copy(ray.origin).applyMatrix4(inv);
  _dir.copy(ray.direction).transformDirection(inv).normalize();
  target.set(_origin, _dir);
  return target;
}

export function pickMap(sim: Simulation, ray: THREE.Ray): PickHit | null {
  let best: PickHit | null = null;
  const consider = (hit: PickHit) => {
    if (hit.t > 0 && (!best || hit.t < best.t)) best = hit;
  };

  for (const unit of sim.units) {
    const visible = unit.owner === 0 || sim.cellVisible(0, unit.x, unit.z);
    if (unit.alive && !visible) continue;
    if (!unit.alive && !unit.deathVisible) continue;
    const y = sim.sampleHeight(unit.x, unit.z) + 0.45;
    const radius = unit.kind === 'rampart' ? 0.7 : 0.55;
    const t = raySphere(ray, unit.x, y, unit.z, radius);
    if (t !== null) consider({ kind: 'unit', id: unit.id, owner: unit.owner, t, x: unit.x, z: unit.z });
  }

  for (const building of sim.buildings) {
    if (!building.alive || building.owner !== 0) continue;
    const hit = buildingHit(ray, building.cx, building.cz, building.kind, building.owner, building.id);
    if (hit) consider(hit);
  }
  for (const ghost of sim.ghosts.values()) {
    const live = sim.buildingById(ghost.id);
    if (live?.alive && live.owner === 0) continue;
    const seen = live?.alive || sim.ghosts.has(ghost.id);
    if (!seen) continue;
    const stat = BUILDING_STATS[ghost.kind];
    if (!live?.alive && sim.footprintVisible(0, ghost.cx, ghost.cz, stat.w, stat.h)) continue;
    const hit = buildingHit(ray, ghost.cx, ghost.cz, ghost.kind, ghost.owner, ghost.id);
    if (hit) consider(hit);
  }

  for (const node of sim.nodes) {
    if (node.amount <= 0) continue;
    if (!sim.footprintExplored(0, node.cx, node.cz, 2, 2)) continue;
    const t = rayAabb(ray, node.cx, 0, node.cz, node.cx + 2, 1.1, node.cz + 2);
    if (t !== null) {
      consider({
        kind: 'node',
        id: node.id,
        resource: node.kind,
        t,
        x: node.cx + 1,
        z: node.cz + 1,
      });
    }
  }

  const ground = marchGround(sim, ray);
  if (ground) consider(ground);
  return best;
}

function buildingHit(
  ray: THREE.Ray,
  cx: number,
  cz: number,
  kind: keyof typeof BUILDING_STATS,
  owner: Owner,
  id: number,
): PickHit | null {
  const stat = BUILDING_STATS[kind];
  const top = kind === 'foundry' ? 2.3 : kind === 'armory' ? 1.5 : 1.5;
  const t = rayAabb(ray, cx, 0, cz, cx + stat.w, top, cz + stat.h);
  if (t === null) return null;
  return { kind: 'building', id, owner, t, x: cx + stat.w / 2, z: cz + stat.h / 2 };
}

function marchGround(sim: Simulation, ray: THREE.Ray): PickHit | null {
  let prevY = ray.origin.y;
  let prevT = 0;
  for (let t = 0.15; t < 90; t += 0.3) {
    const x = ray.origin.x + ray.direction.x * t;
    const y = ray.origin.y + ray.direction.y * t;
    const z = ray.origin.z + ray.direction.z * t;
    if (x < -1 || z < -1 || x > MAP_W + 1 || z > MAP_H + 1) {
      if (t > 4) break;
      prevY = y;
      prevT = t;
      continue;
    }
    const h = sim.sampleHeight(clamp(x, 0, MAP_W), clamp(z, 0, MAP_H));
    if (prevY >= h && y <= h) {
      const span = prevY - y || 1;
      const u = (prevY - h) / span;
      const hitT = prevT + (t - prevT) * u;
      return {
        kind: 'ground',
        t: hitT,
        x: ray.origin.x + ray.direction.x * hitT,
        z: ray.origin.z + ray.direction.z * hitT,
        y: h,
      };
    }
    prevY = y;
    prevT = t;
  }
  return null;
}

function raySphere(ray: THREE.Ray, cx: number, cy: number, cz: number, radius: number): number | null {
  const ox = ray.origin.x - cx;
  const oy = ray.origin.y - cy;
  const oz = ray.origin.z - cz;
  const b = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > 0.02) return t0;
  const t1 = -b + s;
  return t1 > 0.02 ? t1 : null;
}

function rayAabb(
  ray: THREE.Ray,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number | null {
  const inv = (v: number) => (Math.abs(v) < 1e-8 ? 1e8 * Math.sign(v || 1) : 1 / v);
  const ix = inv(ray.direction.x);
  const iy = inv(ray.direction.y);
  const iz = inv(ray.direction.z);
  let tmin = (x0 - ray.origin.x) * ix;
  let tmax = (x1 - ray.origin.x) * ix;
  if (tmin > tmax) [tmin, tmax] = [tmax, tmin];
  let tymin = (y0 - ray.origin.y) * iy;
  let tymax = (y1 - ray.origin.y) * iy;
  if (tymin > tymax) [tymin, tymax] = [tymax, tymin];
  if (tmin > tymax || tymin > tmax) return null;
  if (tymin > tmin) tmin = tymin;
  if (tymax < tmax) tmax = tymax;
  let tzmin = (z0 - ray.origin.z) * iz;
  let tzmax = (z1 - ray.origin.z) * iz;
  if (tzmin > tzmax) [tzmin, tzmax] = [tzmax, tzmin];
  if (tmin > tzmax || tzmin > tmax) return null;
  if (tzmin > tmin) tmin = tzmin;
  if (tmin > 0.02) return tmin;
  return tmax > 0.02 ? tmax : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const _inv = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
