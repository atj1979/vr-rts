/** Glassreach rules data. Original setting — not derived from any existing RTS. */

export const MAP_W = 40;
export const MAP_H = 40;

export type Owner = 0 | 1;
export type ResourceKind = 'shard' | 'flux';
export type UnitKind = 'courier' | 'dart' | 'rampart';
export type BuildingKind = 'foundry' | 'armory' | 'waystation';
export type AnimName = 'idle' | 'walk' | 'run' | 'attack' | 'death' | 'build' | 'gather' | 'work';

export interface FactionInfo {
  id: string;
  name: string;
  short: string;
  /** sRGB hex */
  color: string;
}

export const FACTIONS: readonly [FactionInfo, FactionInfo] = [
  { id: 'lumen', name: 'Lumen Foundry', short: 'Lumen', color: '#e39b3a' },
  { id: 'umbra', name: 'Umbra Compact', short: 'Umbra', color: '#7d6bff' },
];

export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  shard: 'Shardglass',
  flux: 'Fluxwell',
};

export interface UnitStat {
  label: string;
  blurb: string;
  hp: number;
  speed: number;
  damage: number;
  range: number;
  cooldown: number;
  sight: number;
  crew: number;
  shard: number;
  flux: number;
  train: number;
  radius: number;
  /** Trained from this building. */
  builtAt: BuildingKind;
}

export interface BuildingStat {
  label: string;
  blurb: string;
  hp: number;
  sight: number;
  w: number;
  h: number;
  shard: number;
  flux: number;
  build: number;
  crew: number;
  dropoff: boolean;
  placeable: boolean;
}

export const UNIT_STATS: Record<UnitKind, UnitStat> = {
  courier: {
    label: 'Courier',
    blurb: 'Hauls Shardglass and Fluxwell back to a Foundry or Waystation.',
    hp: 48,
    speed: 3.35,
    damage: 4,
    range: 1.2,
    cooldown: 1.05,
    sight: 7,
    crew: 1,
    shard: 40,
    flux: 0,
    train: 6,
    radius: 0.34,
    builtAt: 'foundry',
  },
  dart: {
    label: 'Dart',
    blurb: 'Light skirmisher. A long glass lance, thin armor, quick feet.',
    hp: 72,
    speed: 4.5,
    damage: 9,
    range: 4.6,
    cooldown: 0.72,
    sight: 8,
    crew: 1,
    shard: 55,
    flux: 25,
    train: 8,
    radius: 0.32,
    builtAt: 'armory',
  },
  rampart: {
    label: 'Rampart',
    blurb: 'Walking bulwark. Slow, thick-plated, brutal up close.',
    hp: 220,
    speed: 2.05,
    damage: 20,
    range: 1.45,
    cooldown: 1.2,
    sight: 6,
    crew: 2,
    shard: 110,
    flux: 60,
    train: 12,
    radius: 0.48,
    builtAt: 'armory',
  },
};

export const BUILDING_STATS: Record<BuildingKind, BuildingStat> = {
  foundry: {
    label: 'Foundry',
    blurb: 'Heart of a claim. Trains Couriers and takes deliveries. Lose it and the mesa is lost.',
    hp: 1500,
    sight: 12,
    w: 3,
    h: 3,
    shard: 0,
    flux: 0,
    build: 0,
    crew: 12,
    dropoff: true,
    placeable: false,
  },
  armory: {
    label: 'Armory',
    blurb: 'Kiln-hall that forges Darts and Ramparts. Expands your crew allotment.',
    hp: 820,
    sight: 8,
    w: 3,
    h: 3,
    shard: 150,
    flux: 50,
    build: 12,
    crew: 8,
    dropoff: false,
    placeable: true,
  },
  waystation: {
    label: 'Waystation',
    blurb: 'Forward drop-off and lookout. Park one beside a distant vein.',
    hp: 540,
    sight: 10,
    w: 2,
    h: 2,
    shard: 100,
    flux: 0,
    build: 9,
    crew: 4,
    dropoff: true,
    placeable: true,
  },
};

export const START_SHARD = 360;
export const START_FLUX = 120;
export const CARRY: Record<ResourceKind, number> = { shard: 10, flux: 8 };
export const GATHER_TIME = 1.35;
export const NODE_AMOUNT: Record<ResourceKind, number> = { shard: 4200, flux: 2800 };
export const QUEUE_LIMIT = 5;
export const FOG_VISIBLE = 2;
export const FOG_EXPLORED = 1;
export const FOG_UNKNOWN = 0;

/** Asset ids match folders under public/assets. */
export const UNIT_KINDS: readonly UnitKind[] = ['courier', 'dart', 'rampart'];
export const BUILDING_KINDS: readonly BuildingKind[] = ['foundry', 'armory', 'waystation'];

export interface AttachmentMap {
  muzzle: [number, number, number];
  carry: [number, number, number];
  selection_ring: [number, number, number];
}

/** Model-space offsets for procedural placeholders. Real glTFs override these via sidecar. */
export const ATTACHMENTS: Record<string, AttachmentMap> = {
  courier: {
    muzzle: [0, 0.62, 0.28],
    carry: [0.24, 0.5, 0.02],
    selection_ring: [0, 0.03, 0],
  },
  dart: {
    muzzle: [0, 0.42, 0.72],
    carry: [0, 0.4, 0],
    selection_ring: [0, 0.03, 0],
  },
  rampart: {
    muzzle: [0, 0.55, 0.62],
    carry: [0, 0.45, 0],
    selection_ring: [0, 0.03, 0],
  },
  foundry: {
    muzzle: [0, 1.6, 0],
    carry: [0, 0.4, 1.2],
    selection_ring: [0, 0.04, 0],
  },
  armory: {
    muzzle: [0, 0.9, 1.3],
    carry: [0, 0.4, 0],
    selection_ring: [0, 0.04, 0],
  },
  waystation: {
    muzzle: [0, 1.35, 0],
    carry: [0, 0.35, 0.7],
    selection_ring: [0, 0.04, 0],
  },
  shardglass: {
    muzzle: [0, 0.8, 0],
    carry: [0, 0.55, 0.35],
    selection_ring: [0, 0.03, 0],
  },
  fluxwell: {
    muzzle: [0, 0.9, 0],
    carry: [0, 0.4, 0.4],
    selection_ring: [0, 0.03, 0],
  },
};

export function assetCategory(id: string): 'units' | 'buildings' | 'resources' {
  if (id === 'courier' || id === 'dart' || id === 'rampart') return 'units';
  if (id === 'shardglass' || id === 'fluxwell') return 'resources';
  return 'buildings';
}

export function footprintOf(id: string): [number, number] {
  if (id in BUILDING_STATS) {
    const b = BUILDING_STATS[id as BuildingKind];
    return [b.w, b.h];
  }
  if (id === 'shardglass' || id === 'fluxwell') return [2, 2];
  return [1, 1];
}

export function boundingRadiusOf(id: string): number {
  if (id in UNIT_STATS) return UNIT_STATS[id as UnitKind].radius;
  if (id in BUILDING_STATS) {
    const b = BUILDING_STATS[id as BuildingKind];
    return Math.hypot(b.w, b.h) * 0.5;
  }
  return 0.9;
}
