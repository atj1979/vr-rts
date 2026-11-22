import { BUILDING_STATS, UNIT_STATS, type UnitKind } from './defs.ts';
import type { Simulation, Unit } from './sim.ts';

/** Skirmish opponent for Umbra Compact. Gathers, raises an Armory, then marches. */
export class Opponent {
  private thinkIn = 0.8;
  private marching = false;

  update(sim: Simulation, dt: number): void {
    if (sim.winner !== null) return;
    this.thinkIn -= dt;
    if (this.thinkIn > 0) return;
    this.thinkIn = 1.2;
    this.defend(sim);
    this.economy(sim);
    this.army(sim);
    this.assault(sim);
  }

  private economy(sim: Simulation): void {
    const couriers = this.alive(sim, 'courier');
    if (couriers.length < 7) sim.train(1, 'courier');
    this.balanceFlux(sim, couriers);
    if (!sim.hasStructure(1, 'armory', true) && this.canAffordBuilding(sim, 'armory')) {
      const foundry = sim.buildings.find((b) => b.alive && b.owner === 1 && b.kind === 'foundry');
      if (foundry) {
        const spot = sim.findBuildSite(1, 'armory', foundry.cx - 5, foundry.cz - 1);
        if (spot) sim.place(1, 'armory', spot.x, spot.z);
      }
    }
    const armoryUp = sim.hasStructure(1, 'armory', false);
    if (armoryUp && !sim.hasStructure(1, 'waystation', true) && this.canAffordBuilding(sim, 'waystation') && couriers.length >= 6) {
      const spot = sim.findBuildSite(1, 'waystation', 24, 24);
      if (spot) {
        const id = sim.place(1, 'waystation', spot.x, spot.z).id;
        if (id !== undefined) {
          const spare = couriers.filter((u) => !u.carry).slice(0, 2).map((u) => u.id);
          sim.command(1, spare, { type: 'assist', buildingId: id, x: spot.x, z: spot.z });
        }
      }
    }
    this.sendToMiddle(sim, couriers);
  }

  private balanceFlux(sim: Simulation, couriers: Unit[]): void {
    if (sim.players[1].flux > 80) return;
    const onFlux = couriers.filter((u) => this.gatheringKind(sim, u) === 'flux').length;
    if (onFlux >= 2) return;
    const flux = this.nearestNode(sim, 'flux');
    if (!flux) return;
    const donor = couriers.find((u) => !u.carry && this.gatheringKind(sim, u) === 'shard');
    if (!donor) return;
    sim.command(1, [donor.id], { type: 'gather', nodeId: flux.id, x: flux.cx + 1, z: flux.cz + 1 });
  }

  private sendToMiddle(sim: Simulation, couriers: Unit[]): void {
    if (couriers.length < 6) return;
    const middle = sim.nodes
      .filter((n) => n.amount > 0 && n.cx > 14 && n.cx < 28 && n.cz > 14 && n.cz < 28)
      .sort((a, b) => b.amount - a.amount)[0];
    if (!middle) return;
    const already = couriers.some((u) => u.order?.type === 'gather' && u.order.nodeId === middle.id);
    if (already) return;
    const donor = couriers.find((u) => !u.carry && u.order?.type === 'gather');
    if (!donor) return;
    sim.command(1, [donor.id], { type: 'gather', nodeId: middle.id, x: middle.cx + 1, z: middle.cz + 1 });
  }

  private army(sim: Simulation): void {
    const darts = this.alive(sim, 'dart').length;
    const ramparts = this.alive(sim, 'rampart').length;
    if (darts + ramparts >= 8) return;
    if (sim.crewUsed(1) >= sim.crewMax(1)) return;
    if (ramparts * 2 < darts && sim.players[1].shard >= UNIT_STATS.rampart.shard && sim.players[1].flux >= UNIT_STATS.rampart.flux) {
      sim.train(1, 'rampart');
      return;
    }
    if (sim.players[1].shard >= UNIT_STATS.dart.shard && sim.players[1].flux >= UNIT_STATS.dart.flux) {
      sim.train(1, 'dart');
    }
  }

  private assault(sim: Simulation): void {
    const fighters = [...this.alive(sim, 'dart'), ...this.alive(sim, 'rampart')];
    if (!this.marching && (fighters.length >= 6 || (sim.time > 150 && fighters.length >= 4))) this.marching = true;
    if (!this.marching) return;
    const foundry = sim.buildings.find((b) => b.alive && b.owner === 0 && b.kind === 'foundry');
    if (!foundry) return;
    const stat = BUILDING_STATS.foundry;
    const x = foundry.cx + stat.w / 2;
    const z = foundry.cz + stat.h / 2;
    const idle = fighters.filter((u) => !u.order || (u.order.type === 'move' && !u.order.attackMove)).map((u) => u.id);
    if (idle.length) sim.command(1, idle, { type: 'move', x, z, attackMove: true });
  }

  private defend(sim: Simulation): void {
    const foundry = sim.buildings.find((b) => b.alive && b.owner === 1 && b.kind === 'foundry');
    if (!foundry) return;
    const cx = foundry.cx + 1.5;
    const cz = foundry.cz + 1.5;
    let threat: { id: number; d: number } | null = null;
    for (const unit of sim.units) {
      if (!unit.alive || unit.owner !== 0) continue;
      const d = Math.hypot(unit.x - cx, unit.z - cz);
      if (d < 10 && (!threat || d < threat.d)) threat = { id: unit.id, d };
    }
    if (!threat) return;
    const guards = [...this.alive(sim, 'dart'), ...this.alive(sim, 'rampart')]
      .filter((u) => !u.order || u.order.type === 'move')
      .map((u) => u.id);
    if (guards.length) sim.command(1, guards, { type: 'attack', targetId: threat.id });
  }

  private alive(sim: Simulation, kind: UnitKind): Unit[] {
    return sim.units.filter((u) => u.alive && u.owner === 1 && u.kind === kind);
  }

  private canAffordBuilding(sim: Simulation, kind: 'armory' | 'waystation'): boolean {
    const stat = BUILDING_STATS[kind];
    return sim.players[1].shard >= stat.shard && sim.players[1].flux >= stat.flux;
  }

  private gatheringKind(sim: Simulation, unit: Unit): 'shard' | 'flux' | null {
    if (unit.order?.type !== 'gather') return null;
    return sim.nodeById(unit.order.nodeId)?.kind ?? null;
  }

  private nearestNode(sim: Simulation, kind: 'shard' | 'flux') {
    const anchor = sim.buildings.find((b) => b.owner === 1 && b.kind === 'foundry');
    const ax = anchor ? anchor.cx : 30;
    const az = anchor ? anchor.cz : 30;
    let best: Simulation['nodes'][number] | null = null;
    let bestD = Infinity;
    for (const node of sim.nodes) {
      if (node.kind !== kind || node.amount <= 0) continue;
      const d = (node.cx - ax) * (node.cx - ax) + (node.cz - az) * (node.cz - az);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    return best;
  }
}
