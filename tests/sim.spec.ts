import { readFileSync } from 'node:fs';
import { BUILDING_STATS, UNIT_STATS, footprintOf } from '../src/sim/defs.ts';
import { findPathCells, flowField, separate, updateFog } from '../src/sim/kernels.ts';
import { Opponent } from '../src/sim/ai.ts';
import { Simulation } from '../src/sim/sim.ts';
import { getNative, loadNative, useJsBackend } from '../src/wasm/native.ts';

let failed = 0;

function check(cond: boolean, message: string): void {
  if (!cond) {
    failed++;
    console.error('FAIL', message);
  }
}

const sim = new Simulation(1979);
check(sim.nodes.length >= 8, 'resource nodes placed');
check(sim.units.filter((u) => u.kind === 'courier').length === 8, 'both claims start with couriers');
const route = sim.debugPath(8, 8, 30, 30);
check(route.length > 1, 'a route crosses the mesa');
check(route[route.length - 1].x === 30 && route[route.length - 1].z === 30, 'route ends on the goal');
check(sim.cellVisible(0, 6, 6), 'foundry reveals nearby ground');
check(!sim.cellVisible(0, 20, 20), 'the middle starts unexplored');

const foundry = sim.buildings.find((b) => b.owner === 0 && b.kind === 'foundry');
check(!!foundry && !sim.isWalkable(foundry.cx, foundry.cz), 'foundry footprint blocks movement');

const shardBefore = sim.players[0].shard;
for (let i = 0; i < 300; i++) sim.update(0.1);
check(sim.players[0].shard > shardBefore, 'couriers return shardglass');

const spot = sim.findBuildSite(0, 'armory', 8, 10);
check(!!spot, 'player can find an armory pad');
if (spot) {
  const placed = sim.place(0, 'armory', spot.x, spot.z);
  check(placed.ok, 'armory placement spends resources and reserves the pad');
  check(sim.placementError(0, 'armory', spot.x, spot.z) !== null, 'the pad is no longer free');
}

const enemy = sim.buildings.find((b) => b.owner === 1 && b.kind === 'foundry');
if (enemy) {
  sim.debugDamage(enemy.id, 99999);
  check(sim.winner === 0, 'destroying the Umbra foundry wins');
}

const loss = new Simulation(1979);
const own = loss.buildings.find((b) => b.owner === 0 && b.kind === 'foundry');
if (own) {
  loss.debugDamage(own.id, 99999);
  check(loss.winner === 1, 'losing the Lumen foundry loses');
}

const long = new Simulation(1979);
const opponent = new Opponent();
for (let i = 0; i < 800; i++) {
  opponent.update(long, 0.1);
  long.update(0.1);
}
const aiBuildings = long.buildings.filter((b) => b.owner === 1 && b.alive && b.kind !== 'foundry').length;
const aiArmy = long.units.filter((u) => u.owner === 1 && u.alive && u.kind !== 'courier').length;
check(long.players[1].shard < 360 || aiBuildings > 0 || aiArmy > 0, 'Umbra spends, builds, or trains');

for (const [id, stat] of Object.entries(BUILDING_STATS)) {
  const fp = footprintOf(id);
  check(fp[0] === stat.w && fp[1] === stat.h, `${id} footprint matches sidecar contract`);
}
for (const id of Object.keys(UNIT_STATS)) {
  const fp = footprintOf(id);
  check(fp[0] === 1 && fp[1] === 1, `${id} footprint is one cell`);
  const sidecar = JSON.parse(readFileSync(`public/assets/units/${id}/${id}.json`, 'utf8')) as {
    footprint: number[];
    boundingRadius: number;
    attachments: { muzzle: number[]; carry: number[]; selection_ring: number[] };
    lods: string[];
  };
  check(sidecar.footprint[0] === 1 && sidecar.footprint[1] === 1, `${id} sidecar footprint`);
  check(sidecar.lods.includes(`${id}_lod0`) && sidecar.lods.includes(`${id}_lod1`), `${id} lod suffixes`);
  check(!!sidecar.attachments.muzzle && !!sidecar.attachments.carry && !!sidecar.attachments.selection_ring, `${id} attachments`);
}

const blocked = new Uint8Array(12 * 8);
for (let z = 0; z < 8; z++) blocked[z * 12 + 5] = 1;
blocked[3 * 12 + 5] = 0;
const jsPath = findPathCells(blocked, 12, 8, 1, 1, 9, 6);
const loaded = await loadNative();
check(loaded === 'wasm', 'AssemblyScript module instantiated');
const nav = getNative();
nav.uploadBlocked(blocked, 12, 8);
const wasmPath = nav.findPath(1, 1, 9, 6);
check(jsPath.length === wasmPath.length && [...jsPath].every((value, i) => value === wasmPath[i]), 'wasm A* matches JS');
const jsFlow = flowField(blocked, 12, 8, 9, 6);
const wasmFlow = nav.flowField(9, 6);
let flowDiff = 0;
for (let i = 0; i < jsFlow.length; i++) if (jsFlow[i] !== wasmFlow[i]) flowDiff++;
check(flowDiff === 0, 'wasm flow field matches JS');
const fog = new Uint8Array(12 * 8);
fog[0] = 2;
const centersX = Int32Array.of(2);
const centersZ = Int32Array.of(2);
const radii = Float32Array.of(2.5);
const jsFog = updateFog(fog, 12, 8, centersX, centersZ, radii);
const wasmFog = nav.updateFog(fog, 12, 8, centersX, centersZ, radii);
check(jsFog.every((value, i) => value === wasmFog[i]), 'wasm fog matches JS');
const xs = Float32Array.of(0, 0.2, 4);
const zs = Float32Array.of(0, 0.15, 4);
const rad = Float32Array.of(0.5, 0.5, 0.3);
const jsSep = separate(xs, zs, rad);
const wasmSep = nav.separate(xs, zs, rad);
let sep = 0;
for (let i = 0; i < jsSep.length; i++) sep = Math.max(sep, Math.abs(jsSep[i] - wasmSep[i]));
check(sep < 1e-4, 'wasm separation matches JS within f32 error');
useJsBackend();

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('sim checks passed');
