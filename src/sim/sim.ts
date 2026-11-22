import {
  BUILDING_STATS,
  CARRY,
  FOG_VISIBLE,
  GATHER_TIME,
  MAP_H,
  MAP_W,
  QUEUE_LIMIT,
  START_FLUX,
  START_SHARD,
  UNIT_STATS,
  type BuildingKind,
  type Owner,
  type ResourceKind,
  type UnitKind,
} from './defs.ts';
import { generateMap, sampleHeight, type TerrainMap } from './map.ts';
import { smoothPath, type PathCell } from './kernels.ts';
import { getNative, nativeGeneration } from '../wasm/native.ts';

export interface Unit {
  id: number;
  kind: UnitKind;
  owner: Owner;
  x: number;
  z: number;
  hp: number;
  yaw: number;
  order: Order | null;
  path: { x: number; z: number }[];
  pathI: number;
  carry: { kind: ResourceKind; amount: number } | null;
  gatherT: number;
  attackT: number;
  anim: 'idle' | 'walk' | 'attack' | 'gather' | 'build' | 'death';
  animPhase: number;
  alive: boolean;
  deathT: number;
  /** Human could see this unit on the frame it died, so the sink plays. */
  deathVisible: boolean;
  stuckT: number;
  hold: boolean;
  flash: number;
  needsPath: boolean;
  pathGoalX: number;
  pathGoalZ: number;
  repathCd: number;
  sepX: number;
  sepZ: number;
  moving: boolean;
  moveX: number;
  moveZ: number;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  owner: Owner;
  cx: number;
  cz: number;
  hp: number;
  buildLeft: number;
  buildTotal: number;
  queue: { kind: UnitKind; left: number }[];
  alive: boolean;
  rallyX: number;
  rallyZ: number;
  flash: number;
}

export interface ResourceNode {
  id: number;
  kind: ResourceKind;
  cx: number;
  cz: number;
  amount: number;
  initial: number;
}

export interface BuildingGhost {
  id: number;
  kind: BuildingKind;
  owner: Owner;
  cx: number;
  cz: number;
}

export type Order =
  | { type: 'move'; x: number; z: number; attackMove: boolean }
  | { type: 'attack'; targetId: number; resume: Order | null }
  | { type: 'gather'; nodeId: number }
  | { type: 'build'; buildingId: number };

export type SimEvent =
  | { type: 'deliver'; owner: Owner; kind: ResourceKind; amount: number }
  | { type: 'attack'; owner: Owner; x: number; z: number; tx: number; tz: number; ranged: boolean }
  | { type: 'death'; owner: Owner; kind: string; x: number; z: number }
  | { type: 'buildComplete'; owner: Owner; kind: BuildingKind }
  | { type: 'trainComplete'; owner: Owner; kind: UnitKind }
  | { type: 'underAttack'; owner: Owner }
  | { type: 'win'; winner: Owner }
  | { type: 'gather'; owner: Owner };

export interface PlayerStock {
  shard: number;
  flux: number;
}

export type CommandIntent =
  | { type: 'move'; x: number; z: number; attackMove: boolean }
  | { type: 'attack'; targetId: number }
  | { type: 'gather'; nodeId: number; x: number; z: number }
  | { type: 'assist'; buildingId: number; x: number; z: number };

/**
 * Authoritative skirmish state. No rendering, no DOM.
 * Coordinates are meters on the mesa; one cell is 1 m.
 */
export class Simulation {
  readonly map: TerrainMap;
  readonly units: Unit[] = [];
  readonly buildings: Building[] = [];
  readonly nodes: ResourceNode[] = [];
  readonly players: [PlayerStock, PlayerStock] = [
    { shard: START_SHARD, flux: START_FLUX },
    { shard: START_SHARD, flux: START_FLUX },
  ];
  /** 0 unknown, 1 explored, 2 visible. Index z * MAP_W + x. */
  readonly fog: [Uint8Array, Uint8Array] = [
    new Uint8Array(MAP_W * MAP_H),
    new Uint8Array(MAP_W * MAP_H),
  ];
  /** Enemy structures the human has seen. Removed once the footprint is visible and empty. */
  readonly ghosts = new Map<number, BuildingGhost>();
  events: SimEvent[] = [];
  winner: Owner | null = null;
  time = 0;
  fogSerial = 0;

  private nextId = 1;
  private blocked: Uint8Array;
  private lastFog = -1;
  private fogDirty = true;
  private lastAlert = -100;
  private spawnSalt = 0;
  private gridSerial = 0;
  private uploadedSerial = -1;
  private nativeGen = -1;

  constructor(seed = 1979) {
    this.map = generateMap(seed);
    this.blocked = this.map.terrainBlocked.slice();
    for (const site of this.map.sites.nodes) {
      this.nodes.push({
        id: this.nextId++,
        kind: site.kind,
        cx: site.x,
        cz: site.z,
        amount: site.amount,
        initial: site.amount,
      });
    }
    this.addBuilding(0, 'foundry', this.map.sites.playerFoundry.x, this.map.sites.playerFoundry.z, 0);
    this.addBuilding(1, 'foundry', this.map.sites.aiFoundry.x, this.map.sites.aiFoundry.z, 0);
    this.rebuildBlocked();
    this.spawnStartingCouriers(0);
    this.spawnStartingCouriers(1);
    this.updateFog(true);
    this.bootEconomy(0);
    this.bootEconomy(1);
  }

  update(dt: number): void {
    this.events = [];
    if (this.winner !== null) return;
    const step = Math.min(Math.max(dt, 0), 0.05);
    this.time += step;
    this.syncGrid();
    this.flushPaths(8);
    this.computeSeparation();
    this.updateBuildings(step);
    for (const unit of this.units) {
      unit.moving = false;
      if (!unit.alive) {
        unit.deathT += step;
        unit.anim = 'death';
        continue;
      }
      this.stepUnit(unit, step);
    }
    this.syncGrid();
    this.applyMotion(step);
    this.updateFog(false);
    this.checkWin();
    this.cullUnits();
  }

  crewUsed(owner: Owner): number {
    let n = 0;
    for (const unit of this.units) {
      if (unit.alive && unit.owner === owner) n += UNIT_STATS[unit.kind].crew;
    }
    for (const building of this.buildings) {
      if (!building.alive || building.owner !== owner) continue;
      for (const item of building.queue) n += UNIT_STATS[item.kind].crew;
    }
    return n;
  }

  crewMax(owner: Owner): number {
    let n = 0;
    for (const building of this.buildings) {
      if (building.alive && building.owner === owner && building.buildLeft <= 0) {
        n += BUILDING_STATS[building.kind].crew;
      }
    }
    return n;
  }

  sampleHeight(x: number, z: number): number {
    return sampleHeight(this.map.heights, x, z);
  }

  isWalkable(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) return false;
    return this.blocked[z * MAP_W + x] === 0;
  }

  fogAt(owner: Owner, x: number, z: number): number {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= MAP_W || cz >= MAP_H) return 0;
    return this.fog[owner][cz * MAP_W + cx];
  }

  cellVisible(owner: Owner, x: number, z: number): boolean {
    return this.fogAt(owner, x, z) === FOG_VISIBLE;
  }

  footprintVisible(owner: Owner, cx: number, cz: number, w: number, h: number): boolean {
    for (let z = cz; z < cz + h; z++) {
      for (let x = cx; x < cx + w; x++) {
        if (this.fogAt(owner, x, z) === FOG_VISIBLE) return true;
      }
    }
    return false;
  }

  footprintExplored(owner: Owner, cx: number, cz: number, w: number, h: number): boolean {
    for (let z = cz; z < cz + h; z++) {
      for (let x = cx; x < cx + w; x++) {
        if (this.fogAt(owner, x, z) === 0) return false;
      }
    }
    return true;
  }

  placementError(owner: Owner, kind: BuildingKind, cx: number, cz: number): string | null {
    const stat = BUILDING_STATS[kind];
    if (!stat.placeable) return 'That structure is not built by hand.';
    if (cx < 0 || cz < 0 || cx + stat.w > MAP_W || cz + stat.h > MAP_H) return 'Off the mesa.';
    for (let z = cz; z < cz + stat.h; z++) {
      for (let x = cx; x < cx + stat.w; x++) {
        if (this.map.terrainBlocked[z * MAP_W + x]) return 'Ground is too steep.';
        if (this.structureAt(x, z)) return 'Blocked.';
      }
    }
    if (!this.footprintExplored(owner, cx, cz, stat.w, stat.h)) return 'Unexplored ground.';
    for (const unit of this.units) {
      if (!unit.alive) continue;
      const ux = Math.floor(unit.x);
      const uz = Math.floor(unit.z);
      if (ux >= cx && ux < cx + stat.w && uz >= cz && uz < cz + stat.h) return 'A unit is standing there.';
    }
    const stock = this.players[owner];
    if (stock.shard < stat.shard || stock.flux < stat.flux) return 'Not enough resources.';
    return null;
  }

  place(owner: Owner, kind: BuildingKind, cx: number, cz: number, assistants: number[] = []): { ok: boolean; reason?: string; id?: number } {
    const reason = this.placementError(owner, kind, cx, cz);
    if (reason) return { ok: false, reason };
    const stat = BUILDING_STATS[kind];
    this.players[owner].shard -= stat.shard;
    this.players[owner].flux -= stat.flux;
    const building = this.addBuilding(owner, kind, cx, cz, stat.build);
    this.rebuildBlocked();
    this.fogDirty = true;
    for (const id of assistants) {
      const unit = this.unitById(id);
      if (!unit || !unit.alive || unit.owner !== owner || unit.kind !== 'courier') continue;
      unit.order = { type: 'build', buildingId: building.id };
      unit.hold = false;
      this.clearPath(unit);
    }
    return { ok: true, id: building.id };
  }

  train(owner: Owner, kind: UnitKind, preferredBuildingId?: number): { ok: boolean; reason?: string } {
    const stat = UNIT_STATS[kind];
    const building = this.pickProduction(owner, stat.builtAt, preferredBuildingId);
    if (!building) return { ok: false, reason: `No finished ${BUILDING_STATS[stat.builtAt].label}.` };
    if (building.queue.length >= QUEUE_LIMIT) return { ok: false, reason: 'Queue is full.' };
    if (this.crewUsed(owner) + stat.crew > this.crewMax(owner)) {
      return { ok: false, reason: 'Crew limit — an Armory or Waystation raises it.' };
    }
    const stock = this.players[owner];
    if (stock.shard < stat.shard || stock.flux < stat.flux) return { ok: false, reason: 'Not enough resources.' };
    stock.shard -= stat.shard;
    stock.flux -= stat.flux;
    building.queue.push({ kind, left: stat.train });
    return { ok: true };
  }

  command(owner: Owner, unitIds: number[], intent: CommandIntent): void {
    for (const id of unitIds) {
      const unit = this.unitById(id);
      if (!unit || !unit.alive || unit.owner !== owner) continue;
      unit.hold = false;
      if (intent.type === 'attack') {
        unit.order = { type: 'attack', targetId: intent.targetId, resume: null };
      } else if (intent.type === 'gather') {
        unit.order =
          unit.kind === 'courier'
            ? { type: 'gather', nodeId: intent.nodeId }
            : { type: 'move', x: intent.x, z: intent.z, attackMove: true };
      } else if (intent.type === 'assist') {
        unit.order =
          unit.kind === 'courier'
            ? { type: 'build', buildingId: intent.buildingId }
            : { type: 'move', x: intent.x, z: intent.z, attackMove: true };
      } else {
        unit.order = {
          type: 'move',
          x: intent.x,
          z: intent.z,
          attackMove: unit.kind !== 'courier' && intent.attackMove,
        };
      }
      this.clearPath(unit);
    }
  }

  stop(owner: Owner, unitIds: number[]): void {
    for (const id of unitIds) {
      const unit = this.unitById(id);
      if (!unit || unit.owner !== owner || !unit.alive) continue;
      unit.order = null;
      unit.hold = false;
      this.clearPath(unit);
    }
  }

  hold(owner: Owner, unitIds: number[]): void {
    for (const id of unitIds) {
      const unit = this.unitById(id);
      if (!unit || unit.owner !== owner || !unit.alive) continue;
      unit.order = null;
      unit.hold = true;
      this.clearPath(unit);
    }
  }

  setRally(buildingId: number, x: number, z: number): void {
    const building = this.buildingById(buildingId);
    if (!building || !building.alive) return;
    building.rallyX = x;
    building.rallyZ = z;
  }

  findBuildSite(owner: Owner, kind: BuildingKind, preferX: number, preferZ: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let radius = 2; radius <= 16; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const x = Math.round(preferX + dx);
          const z = Math.round(preferZ + dz);
          if (this.placementError(owner, kind, x, z)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = { x, z };
          }
        }
      }
      if (best && radius >= 4) break;
    }
    return best;
  }

  hasStructure(owner: Owner, kind: BuildingKind, includeConstruction: boolean): boolean {
    return this.buildings.some(
      (b) => b.alive && b.owner === owner && b.kind === kind && (includeConstruction || b.buildLeft <= 0),
    );
  }

  unitById(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  buildingById(id: number): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  nodeById(id: number): ResourceNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  combatantById(id: number): Unit | Building | undefined {
    return this.unitById(id) ?? this.buildingById(id);
  }

  /** Test hook. */
  debugDamage(id: number, amount: number): void {
    const unit = this.unitById(id);
    if (unit) {
      this.damage(unit, amount, null);
      return;
    }
    const building = this.buildingById(id);
    if (building) this.damage(building, amount, null);
  }

  /** Test hook. */
  debugPath(sx: number, sz: number, gx: number, gz: number): PathCell[] {
    this.syncGrid();
    const packed = getNative().findPath(sx, sz, gx, gz);
    const cells: PathCell[] = [];
    for (let i = 0; i < packed.length; i += 2) cells.push({ x: packed[i], z: packed[i + 1] });
    return smoothPath(cells, (x, z) => !this.isWalkable(x, z));
  }

  private spawnStartingCouriers(owner: Owner): void {
    const foundry = this.buildings.find((b) => b.owner === owner && b.kind === 'foundry');
    if (!foundry) return;
    const spots = this.adjacentCells(foundry.cx, foundry.cz, 3, 3);
    for (let i = 0; i < 4; i++) {
      const spot = spots[i % Math.max(1, spots.length)] ?? { x: foundry.cx, z: foundry.cz + 3 };
      const unit = this.addUnit(owner, 'courier', spot.x + 0.5, spot.z + 0.5);
      const awayX = owner === 0 ? 1 : -1;
      const awayZ = owner === 0 ? 1 : -1;
      unit.yaw = Math.atan2(awayX, awayZ);
    }
  }

  private bootEconomy(owner: Owner): void {
    const couriers = this.units.filter((u) => u.alive && u.owner === owner && u.kind === 'courier');
    const anchor = couriers[0] ?? { x: 8, z: 8 };
    const shards = this.nodes
      .filter((n) => n.kind === 'shard')
      .sort((a, b) => this.nodeDist(anchor.x, anchor.z, a) - this.nodeDist(anchor.x, anchor.z, b));
    const flux = this.nodes
      .filter((n) => n.kind === 'flux')
      .sort((a, b) => this.nodeDist(anchor.x, anchor.z, a) - this.nodeDist(anchor.x, anchor.z, b))[0];
    couriers.forEach((courier, index) => {
      if (index === 0 && flux) courier.order = { type: 'gather', nodeId: flux.id };
      else if (shards.length) courier.order = { type: 'gather', nodeId: shards[index % shards.length].id };
    });
  }

  private updateBuildings(dt: number): void {
    for (const building of this.buildings) {
      if (!building.alive) continue;
      building.flash = Math.max(0, building.flash - dt);
      if (building.buildLeft > 0) {
        const assistants = this.countAssistants(building);
        building.buildLeft -= dt * (1 + Math.min(3, assistants));
        if (building.buildLeft <= 0) {
          building.buildLeft = 0;
          this.events.push({ type: 'buildComplete', owner: building.owner, kind: building.kind });
          this.fogDirty = true;
          for (const unit of this.units) {
            if (unit.order?.type === 'build' && unit.order.buildingId === building.id) {
              const node = this.nearestNode(unit.x, unit.z);
              unit.order = node ? { type: 'gather', nodeId: node.id } : null;
              this.clearPath(unit);
            }
          }
        }
        continue;
      }
      if (!building.queue.length) continue;
      const item = building.queue[0];
      item.left -= dt;
      if (item.left <= 0) {
        building.queue.shift();
        this.spawnTrained(building, item.kind);
        this.events.push({ type: 'trainComplete', owner: building.owner, kind: item.kind });
      }
    }
  }

  private countAssistants(building: Building): number {
    const stat = BUILDING_STATS[building.kind];
    const center = this.centerOf(building.cx, building.cz, stat.w, stat.h);
    let n = 0;
    for (const unit of this.units) {
      if (!unit.alive || unit.order?.type !== 'build' || unit.order.buildingId !== building.id) continue;
      if (Math.hypot(unit.x - center.x, unit.z - center.z) < Math.max(stat.w, stat.h) + 1.5) n++;
    }
    return n;
  }

  private stepUnit(unit: Unit, dt: number): void {
    const stats = UNIT_STATS[unit.kind];
    unit.attackT = Math.max(0, unit.attackT - dt);
    unit.flash = Math.max(0, unit.flash - dt);
    unit.animPhase += dt;
    unit.repathCd = Math.max(0, unit.repathCd - dt);
    unit.anim = 'idle';

    for (let pass = 0; pass < 2; pass++) {
      const order = unit.order;
      if (!order) {
        if (unit.carry) {
          this.returnCargo(unit);
          return;
        }
        if (!unit.hold && unit.kind !== 'courier') {
          const foe = this.nearestFoe(unit, stats.range + 0.4);
          if (foe) unit.order = { type: 'attack', targetId: foe.id, resume: null };
        }
        return;
      }

      if (order.type === 'move') {
        if (order.attackMove && !unit.hold && unit.kind !== 'courier') {
          const foe = this.nearestFoe(unit, stats.sight);
          if (foe) {
            unit.order = { type: 'attack', targetId: foe.id, resume: order };
            continue;
          }
        }
        this.seek(unit, order.x, order.z);
        if (Math.hypot(order.x - unit.x, order.z - unit.z) < 0.3) {
          unit.order = null;
          unit.path = [];
          unit.anim = 'idle';
        }
        return;
      }

      if (order.type === 'attack') {
        const target = this.combatantById(order.targetId);
        if (!target || !target.alive) {
          unit.order = order.resume;
          this.clearPath(unit);
          continue;
        }
        const point = this.aimPoint(target);
        const dist = this.distanceTo(unit, target);
        if (dist > stats.range) {
          this.seek(unit, point.x, point.z);
        } else {
          unit.path = [];
          unit.yaw = Math.atan2(point.x - unit.x, point.z - unit.z);
          unit.anim = 'attack';
          if (unit.attackT <= 0) {
            unit.attackT = stats.cooldown;
            this.damage(target, stats.damage, unit);
            this.events.push({
              type: 'attack',
              owner: unit.owner,
              x: unit.x,
              z: unit.z,
              tx: point.x,
              tz: point.z,
              ranged: stats.range > 2,
            });
          }
        }
        return;
      }

      if (order.type === 'gather') {
        this.stepGather(unit, order.nodeId, dt);
        return;
      }

      const building = this.buildingById(order.buildingId);
      if (!building || !building.alive || building.buildLeft <= 0) {
        const node = this.nearestNode(unit.x, unit.z);
        unit.order = unit.kind === 'courier' && node ? { type: 'gather', nodeId: node.id } : null;
        this.clearPath(unit);
        continue;
      }
      const stat = BUILDING_STATS[building.kind];
      const stand = this.approachPoint(building.cx, building.cz, stat.w, stat.h, unit.x, unit.z);
      if (Math.hypot(stand.x - unit.x, stand.z - unit.z) > 0.8) {
        this.seek(unit, stand.x, stand.z);
      } else {
        unit.path = [];
        unit.anim = 'build';
        const center = this.centerOf(building.cx, building.cz, stat.w, stat.h);
        unit.yaw = Math.atan2(center.x - unit.x, center.z - unit.z);
      }
      return;
    }
  }

  private stepGather(unit: Unit, nodeId: number, dt: number): void {
    if (unit.carry) {
      this.returnCargo(unit);
      return;
    }
    let node = this.nodeById(nodeId);
    if (!node || node.amount <= 0) {
      const alt = this.nearestNode(unit.x, unit.z, node?.kind);
      if (!alt) {
        unit.order = null;
        return;
      }
      unit.order = { type: 'gather', nodeId: alt.id };
      this.clearPath(unit);
      node = alt;
    }
    const stand = this.approachPoint(node.cx, node.cz, 2, 2, unit.x, unit.z);
    if (Math.hypot(stand.x - unit.x, stand.z - unit.z) > 0.65) {
      unit.gatherT = GATHER_TIME;
      this.seek(unit, stand.x, stand.z);
      return;
    }
    unit.path = [];
    unit.anim = 'gather';
    unit.yaw = Math.atan2(node.cx + 1 - unit.x, node.cz + 1 - unit.z);
    unit.gatherT -= dt;
    if (unit.gatherT > 0) return;
    const take = Math.min(CARRY[node.kind], node.amount);
    if (take <= 0) return;
    node.amount -= take;
    unit.carry = { kind: node.kind, amount: take };
    unit.gatherT = GATHER_TIME;
    this.events.push({ type: 'gather', owner: unit.owner });
  }

  private returnCargo(unit: Unit): void {
    if (!unit.carry) return;
    const drop = this.nearestDropoff(unit.owner, unit.x, unit.z);
    if (!drop) {
      unit.anim = 'idle';
      return;
    }
    const stat = BUILDING_STATS[drop.kind];
    const stand = this.approachPoint(drop.cx, drop.cz, stat.w, stat.h, unit.x, unit.z);
    if (Math.hypot(stand.x - unit.x, stand.z - unit.z) > 0.7) {
      this.seek(unit, stand.x, stand.z);
      return;
    }
    const stock = this.players[unit.owner];
    if (unit.carry.kind === 'shard') stock.shard += unit.carry.amount;
    else stock.flux += unit.carry.amount;
    this.events.push({
      type: 'deliver',
      owner: unit.owner,
      kind: unit.carry.kind,
      amount: unit.carry.amount,
    });
    unit.carry = null;
    unit.path = [];
  }

  private seek(unit: Unit, x: number, z: number): void {
    const changed = Math.hypot(unit.pathGoalX - x, unit.pathGoalZ - z) > 0.75;
    if (changed) {
      unit.pathGoalX = x;
      unit.pathGoalZ = z;
      unit.needsPath = true;
      unit.path = [];
      unit.pathI = 0;
    }
    if (!unit.path.length && !unit.needsPath) unit.needsPath = true;
    if (unit.path.length) this.follow(unit);
    else unit.anim = 'idle';
  }

  private follow(unit: Unit): void {
    let guard = 0;
    while (unit.pathI < unit.path.length && guard++ < 4) {
      const wp = unit.path[unit.pathI];
      if (Math.hypot(wp.x - unit.x, wp.z - unit.z) < 0.18) unit.pathI++;
      else break;
    }
    if (unit.pathI >= unit.path.length) {
      unit.path = [];
      return;
    }
    const wp = unit.path[unit.pathI];
    unit.moving = true;
    unit.moveX = wp.x;
    unit.moveZ = wp.z;
    unit.anim = 'walk';
  }

  private flushPaths(budget: number): void {
    const pending: Unit[] = [];
    for (const unit of this.units) {
      if (unit.alive && unit.needsPath) pending.push(unit);
    }
    const groups = new Map<string, Unit[]>();
    for (const unit of pending) {
      const goal = this.nearestWalkable(Math.floor(unit.pathGoalX), Math.floor(unit.pathGoalZ));
      const key = goal ? `${goal.x},${goal.z}` : 'none';
      const list = groups.get(key);
      if (list) list.push(unit);
      else groups.set(key, [unit]);
    }
    let used = 0;
    for (const [key, group] of groups) {
      if (key === 'none') {
        for (const unit of group) {
          unit.needsPath = false;
          unit.path = [];
        }
        continue;
      }
      const comma = key.indexOf(',');
      const gx = Number(key.slice(0, comma));
      const gz = Number(key.slice(comma + 1));
      const dirs = group.length >= 3 ? getNative().flowField(gx, gz) : null;
      for (const unit of group) {
        if (used >= budget) break;
        used++;
        unit.needsPath = false;
        const start = this.nearestWalkable(Math.floor(unit.x), Math.floor(unit.z));
        if (!start) {
          unit.path = [];
          continue;
        }
        const packed = dirs ? getNative().traceFlow(dirs, start.x, start.z) : getNative().findPath(start.x, start.z, gx, gz);
        this.applyPackedPath(unit, packed, gx, gz);
      }
    }
  }

  private applyPackedPath(unit: Unit, packed: Int32Array, gx: number, gz: number): void {
    const count = packed.length >> 1;
    if (count === 0) {
      unit.path = [];
      return;
    }
    const endX = packed[(count - 1) * 2];
    const endZ = packed[(count - 1) * 2 + 1];
    if (endX !== gx || endZ !== gz) {
      unit.path = [];
      return;
    }
    const raw: PathCell[] = [];
    for (let i = 0; i < count; i++) raw.push({ x: packed[i * 2], z: packed[i * 2 + 1] });
    const cells = smoothPath(raw, (x, z) => !this.isWalkable(x, z));
    unit.path = cells.map((cell, index) => {
      const last = index === cells.length - 1;
      if (last && cell.x === Math.floor(unit.pathGoalX) && cell.z === Math.floor(unit.pathGoalZ)) {
        return { x: unit.pathGoalX, z: unit.pathGoalZ };
      }
      return { x: cell.x + 0.5, z: cell.z + 0.5 };
    });
    unit.pathI = 0;
    if (unit.path.length && Math.hypot(unit.path[0].x - unit.x, unit.path[0].z - unit.z) < 0.2) unit.pathI = 1;
  }

  private computeSeparation(): void {
    const alive: Unit[] = [];
    for (const unit of this.units) {
      unit.sepX = 0;
      unit.sepZ = 0;
      if (unit.alive) alive.push(unit);
    }
    const n = alive.length;
    if (!n) return;
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    const radii = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = alive[i].x;
      zs[i] = alive[i].z;
      radii[i] = UNIT_STATS[alive[i].kind].radius + 0.06;
    }
    const out = getNative().separate(xs, zs, radii);
    for (let i = 0; i < n; i++) {
      alive[i].sepX = out[i * 2];
      alive[i].sepZ = out[i * 2 + 1];
    }
  }

  private applyMotion(dt: number): void {
    const movers: Unit[] = [];
    for (const unit of this.units) if (unit.alive && unit.moving) movers.push(unit);
    if (!movers.length) return;
    const n = movers.length;
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    const txs = new Float32Array(n);
    const tzs = new Float32Array(n);
    const sx = new Float32Array(n);
    const sz = new Float32Array(n);
    const speeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const unit = movers[i];
      xs[i] = unit.x;
      zs[i] = unit.z;
      txs[i] = unit.moveX;
      tzs[i] = unit.moveZ;
      sx[i] = unit.sepX;
      sz[i] = unit.sepZ;
      speeds[i] = UNIT_STATS[unit.kind].speed;
    }
    const out = getNative().integrate(xs, zs, txs, tzs, sx, sz, speeds, dt);
    for (let i = 0; i < n; i++) {
      const unit = movers[i];
      const nx = out[i * 4];
      const nz = out[i * 4 + 1];
      const yaw = out[i * 4 + 2];
      const stuck = out[i * 4 + 3] > 0.5;
      const unmoved = Math.abs(nx - unit.x) < 1e-4 && Math.abs(nz - unit.z) < 1e-4;
      if (stuck && unmoved) {
        unit.stuckT += dt;
        if (unit.stuckT > 0.45 && unit.repathCd <= 0) {
          unit.needsPath = true;
          unit.repathCd = 0.45;
          unit.stuckT = 0;
        }
        unit.moving = false;
        continue;
      }
      if (stuck) {
        unit.stuckT += dt;
        if (unit.stuckT > 0.55 && unit.repathCd <= 0) {
          unit.needsPath = true;
          unit.path = [];
          unit.repathCd = 0.5;
          unit.stuckT = 0;
        }
      } else unit.stuckT = 0;
      unit.x = nx;
      unit.z = nz;
      unit.yaw = yaw;
      unit.anim = 'walk';
      unit.moving = false;
    }
  }

  private syncGrid(): void {
    const gen = nativeGeneration();
    if (this.uploadedSerial === this.gridSerial && this.nativeGen === gen) return;
    getNative().uploadBlocked(this.blocked, MAP_W, MAP_H);
    this.uploadedSerial = this.gridSerial;
    this.nativeGen = gen;
  }

  private damage(target: Unit | Building, amount: number, attacker: Unit | null): void {
    if (!target.alive || this.winner !== null) return;
    target.hp -= amount;
    target.flash = 0.14;
    if (target.owner === 0 && attacker && attacker.owner === 1 && this.time - this.lastAlert > 12) {
      this.lastAlert = this.time;
      this.events.push({ type: 'underAttack', owner: 0 });
    }
    if (target.hp > 0) return;
    target.hp = 0;
    target.alive = false;
    const point = this.aimPoint(target);
    if (this.isUnit(target)) {
      target.deathT = 0;
      target.deathVisible = target.owner === 0 || this.cellVisible(0, target.x, target.z);
      target.anim = 'death';
      target.order = null;
    } else {
      const refund = target.queue;
      for (const item of refund) {
        const stat = UNIT_STATS[item.kind];
        this.players[target.owner].shard += stat.shard;
        this.players[target.owner].flux += stat.flux;
      }
      target.queue = [];
      this.rebuildBlocked();
      this.fogDirty = true;
    }
    this.events.push({ type: 'death', owner: target.owner, kind: target.kind, x: point.x, z: point.z });
    if (!this.isUnit(target) && target.kind === 'foundry') this.checkWin();
  }

  private checkWin(): void {
    if (this.winner !== null) return;
    const lumen = this.buildings.some((b) => b.alive && b.owner === 0 && b.kind === 'foundry');
    const umbra = this.buildings.some((b) => b.alive && b.owner === 1 && b.kind === 'foundry');
    if (lumen && !umbra) {
      this.winner = 0;
      this.events.push({ type: 'win', winner: 0 });
    } else if (umbra && !lumen) {
      this.winner = 1;
      this.events.push({ type: 'win', winner: 1 });
    }
  }

  private updateFog(force: boolean): void {
    if (!force && !this.fogDirty && this.time - this.lastFog < 0.25) return;
    this.lastFog = this.time;
    this.fogDirty = false;
    this.fogSerial++;
    for (const owner of [0, 1] as const) {
      const xs: number[] = [];
      const zs: number[] = [];
      const rs: number[] = [];
      for (const unit of this.units) {
        if (!unit.alive || unit.owner !== owner) continue;
        xs.push(Math.floor(unit.x));
        zs.push(Math.floor(unit.z));
        rs.push(UNIT_STATS[unit.kind].sight);
      }
      for (const building of this.buildings) {
        if (!building.alive || building.owner !== owner) continue;
        const stat = BUILDING_STATS[building.kind];
        const center = this.centerOf(building.cx, building.cz, stat.w, stat.h);
        xs.push(Math.floor(center.x));
        zs.push(Math.floor(center.z));
        rs.push(stat.sight);
      }
      const next = getNative().updateFog(
        this.fog[owner],
        MAP_W,
        MAP_H,
        Int32Array.from(xs),
        Int32Array.from(zs),
        Float32Array.from(rs),
      );
      this.fog[owner].set(next);
    }
    this.refreshGhosts();
  }

  private refreshGhosts(): void {
    const seen = new Set<number>();
    for (const building of this.buildings) {
      if (!building.alive || building.owner === 0) continue;
      const stat = BUILDING_STATS[building.kind];
      if (!this.footprintVisible(0, building.cx, building.cz, stat.w, stat.h)) continue;
      this.ghosts.set(building.id, {
        id: building.id,
        kind: building.kind,
        owner: building.owner,
        cx: building.cx,
        cz: building.cz,
      });
      seen.add(building.id);
    }
    for (const [id, ghost] of this.ghosts) {
      const stat = BUILDING_STATS[ghost.kind];
      const looking = this.footprintVisible(0, ghost.cx, ghost.cz, stat.w, stat.h);
      if (looking && !seen.has(id)) this.ghosts.delete(id);
    }
  }

  private cullUnits(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const unit = this.units[i];
      if (!unit.alive && unit.deathT > 1.25) this.units.splice(i, 1);
    }
  }

  private addBuilding(owner: Owner, kind: BuildingKind, cx: number, cz: number, buildTime: number): Building {
    const stat = BUILDING_STATS[kind];
    const center = this.centerOf(cx, cz, stat.w, stat.h);
    const rallyZ = owner === 0 ? cz + stat.h + 0.6 : cz - 0.6;
    const building: Building = {
      id: this.nextId++,
      kind,
      owner,
      cx,
      cz,
      hp: stat.hp,
      buildLeft: buildTime,
      buildTotal: Math.max(buildTime, 0.001),
      queue: [],
      alive: true,
      rallyX: center.x,
      rallyZ,
      flash: 0,
    };
    this.buildings.push(building);
    return building;
  }

  private addUnit(owner: Owner, kind: UnitKind, x: number, z: number): Unit {
    const unit: Unit = {
      id: this.nextId++,
      kind,
      owner,
      x,
      z,
      hp: UNIT_STATS[kind].hp,
      yaw: 0,
      order: null,
      path: [],
      pathI: 0,
      carry: null,
      gatherT: GATHER_TIME,
      attackT: 0,
      anim: 'idle',
      animPhase: this.nextId * 0.37,
      alive: true,
      deathT: 0,
      deathVisible: true,
      stuckT: 0,
      hold: false,
      flash: 0,
      needsPath: false,
      pathGoalX: x,
      pathGoalZ: z,
      repathCd: 0,
      sepX: 0,
      sepZ: 0,
      moving: false,
      moveX: x,
      moveZ: z,
    };
    this.units.push(unit);
    return unit;
  }

  private spawnTrained(building: Building, kind: UnitKind): void {
    const spot =
      this.nearestWalkable(Math.floor(building.rallyX), Math.floor(building.rallyZ)) ??
      this.adjacentCells(building.cx, building.cz, BUILDING_STATS[building.kind].w, BUILDING_STATS[building.kind].h)[0] ??
      { x: building.cx, z: building.cz };
    const salt = (this.spawnSalt++ % 7) * 0.04;
    const unit = this.addUnit(building.owner, kind, spot.x + 0.35 + salt, spot.z + 0.35);
    const center = this.centerOf(
      building.cx,
      building.cz,
      BUILDING_STATS[building.kind].w,
      BUILDING_STATS[building.kind].h,
    );
    unit.yaw = Math.atan2(unit.x - center.x, unit.z - center.z);
  }

  private pickProduction(owner: Owner, kind: BuildingKind, preferred?: number): Building | undefined {
    if (preferred !== undefined) {
      const chosen = this.buildingById(preferred);
      if (
        chosen &&
        chosen.alive &&
        chosen.owner === owner &&
        chosen.kind === kind &&
        chosen.buildLeft <= 0 &&
        chosen.queue.length < QUEUE_LIMIT
      ) {
        return chosen;
      }
    }
    let best: Building | undefined;
    let bestQueue = Infinity;
    for (const building of this.buildings) {
      if (!building.alive || building.owner !== owner || building.kind !== kind || building.buildLeft > 0) continue;
      if (building.queue.length >= QUEUE_LIMIT) continue;
      if (building.queue.length < bestQueue) {
        best = building;
        bestQueue = building.queue.length;
      }
    }
    return best;
  }

  private nearestFoe(unit: Unit, radius: number): Unit | Building | null {
    let best: Unit | Building | null = null;
    let bestD = radius;
    for (const other of this.units) {
      if (!other.alive || other.owner === unit.owner) continue;
      const d = Math.hypot(other.x - unit.x, other.z - unit.z);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    for (const building of this.buildings) {
      if (!building.alive || building.owner === unit.owner) continue;
      const d = this.distanceTo(unit, building);
      if (d < bestD) {
        bestD = d;
        best = building;
      }
    }
    return best;
  }

  private nearestNode(x: number, z: number, prefer?: ResourceKind): ResourceNode | null {
    let best: ResourceNode | null = null;
    let bestD = Infinity;
    for (const node of this.nodes) {
      if (node.amount <= 0) continue;
      if (prefer && node.kind !== prefer) continue;
      const d = this.nodeDist(x, z, node);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    if (best || !prefer) return best;
    return this.nearestNode(x, z);
  }

  private nearestDropoff(owner: Owner, x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const building of this.buildings) {
      if (!building.alive || building.owner !== owner || building.buildLeft > 0) continue;
      if (!BUILDING_STATS[building.kind].dropoff) continue;
      const stat = BUILDING_STATS[building.kind];
      const d = distToRect(x, z, building.cx, building.cz, stat.w, stat.h);
      if (d < bestD) {
        bestD = d;
        best = building;
      }
    }
    return best;
  }

  private distanceTo(unit: Unit, target: Unit | Building): number {
    if (this.isUnit(target)) return Math.hypot(target.x - unit.x, target.z - unit.z);
    const stat = BUILDING_STATS[target.kind];
    return distToRect(unit.x, unit.z, target.cx, target.cz, stat.w, stat.h);
  }

  private aimPoint(target: Unit | Building): { x: number; z: number } {
    if (this.isUnit(target)) return { x: target.x, z: target.z };
    const stat = BUILDING_STATS[target.kind];
    return this.centerOf(target.cx, target.cz, stat.w, stat.h);
  }

  private approachPoint(cx: number, cz: number, w: number, h: number, fromX: number, fromZ: number): { x: number; z: number } {
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let z = cz - 1; z <= cz + h; z++) {
      for (let x = cx - 1; x <= cx + w; x++) {
        const inside = x >= cx && x < cx + w && z >= cz && z < cz + h;
        if (inside || !this.isWalkable(x, z)) continue;
        const wx = x + 0.5;
        const wz = z + 0.5;
        const d = (wx - fromX) * (wx - fromX) + (wz - fromZ) * (wz - fromZ);
        if (d < bestD) {
          bestD = d;
          best = { x: wx, z: wz };
        }
      }
    }
    return best ?? { x: fromX, z: fromZ };
  }

  private adjacentCells(cx: number, cz: number, w: number, h: number): { x: number; z: number }[] {
    const cells: { x: number; z: number; d: number }[] = [];
    const center = this.centerOf(cx, cz, w, h);
    for (let z = cz - 1; z <= cz + h; z++) {
      for (let x = cx - 1; x <= cx + w; x++) {
        const inside = x >= cx && x < cx + w && z >= cz && z < cz + h;
        if (inside || !this.isWalkable(x, z)) continue;
        const toward = (x + 0.5 - center.x) * (MAP_W / 2 - center.x) + (z + 0.5 - center.z) * (MAP_H / 2 - center.z);
        cells.push({ x, z, d: -toward });
      }
    }
    cells.sort((a, b) => a.d - b.d);
    return cells;
  }

  private nearestWalkable(x: number, z: number): { x: number; z: number } | null {
    if (this.isWalkable(x, z)) return { x, z };
    for (let r = 1; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (this.isWalkable(nx, nz)) return { x: nx, z: nz };
        }
      }
    }
    return null;
  }

  private structureAt(x: number, z: number): boolean {
    for (const node of this.nodes) {
      if (x >= node.cx && x < node.cx + 2 && z >= node.cz && z < node.cz + 2) return true;
    }
    for (const building of this.buildings) {
      if (!building.alive) continue;
      const stat = BUILDING_STATS[building.kind];
      if (x >= building.cx && x < building.cx + stat.w && z >= building.cz && z < building.cz + stat.h) return true;
    }
    return false;
  }

  private rebuildBlocked(): void {
    this.blocked.set(this.map.terrainBlocked);
    for (const node of this.nodes) {
      for (let z = 0; z < 2; z++) {
        for (let x = 0; x < 2; x++) this.blocked[(node.cz + z) * MAP_W + node.cx + x] = 1;
      }
    }
    for (const building of this.buildings) {
      if (!building.alive) continue;
      const stat = BUILDING_STATS[building.kind];
      for (let z = 0; z < stat.h; z++) {
        for (let x = 0; x < stat.w; x++) this.blocked[(building.cz + z) * MAP_W + building.cx + x] = 1;
      }
    }
    this.gridSerial++;
  }

  private clearPath(unit: Unit): void {
    unit.path = [];
    unit.pathI = 0;
    unit.needsPath = false;
    unit.pathGoalX = Number.NaN;
    unit.pathGoalZ = Number.NaN;
    unit.stuckT = 0;
  }

  private nodeDist(x: number, z: number, node: ResourceNode): number {
    return distToRect(x, z, node.cx, node.cz, 2, 2);
  }

  private centerOf(cx: number, cz: number, w: number, h: number): { x: number; z: number } {
    return { x: cx + w / 2, z: cz + h / 2 };
  }

  private isUnit(target: Unit | Building): target is Unit {
    return target.kind === 'courier' || target.kind === 'dart' || target.kind === 'rampart';
  }
}

function distToRect(px: number, pz: number, x: number, z: number, w: number, h: number): number {
  const dx = Math.max(x - px, 0, px - (x + w));
  const dz = Math.max(z - pz, 0, pz - (z + h));
  return Math.hypot(dx, dz);
}
