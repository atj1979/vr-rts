import * as THREE from 'three';
import { BUILDING_STATS, FACTIONS, MAP_H, MAP_W, UNIT_KINDS, UNIT_STATS, type UnitKind } from '../sim/defs.ts';
import type { Simulation, Unit } from '../sim/sim.ts';
import type { GameAsset } from '../assets/registry.ts';
import { createUnitMaterial, paintTeam, setUnitTime } from './materials.ts';

const MAX = 180;
const TEAM = [new THREE.Color(FACTIONS[0].color), new THREE.Color(FACTIONS[1].color)];
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _color = new THREE.Color();
const _white = new THREE.Color('#ffffff');

interface UnitBatch {
  kind: UnitKind;
  mesh: THREE.InstancedMesh;
  anim: THREE.InstancedBufferAttribute;
  team: THREE.InstancedBufferAttribute;
  skinned: { root: THREE.Object3D; mixer: THREE.AnimationMixer; action: string }[];
  asset: GameAsset;
}

interface Bolt {
  x: number;
  z: number;
  tx: number;
  tz: number;
  life: number;
  color: number;
}

interface Ping {
  x: number;
  z: number;
  life: number;
}

export class Battlefield {
  readonly table = new THREE.Group();
  readonly mapRoot = new THREE.Group();
  private sim: Simulation;
  private batches = new Map<UnitKind, UnitBatch>();
  private buildings = new Map<number, THREE.Group>();
  private nodeMeshes = new Map<number, THREE.Object3D>();
  private fogMesh: THREE.Mesh | null = null;
  private fogColors: Float32Array | null = null;
  private rings: THREE.InstancedMesh;
  private bars: THREE.InstancedMesh;
  private carries: THREE.InstancedMesh;
  private boltsMesh: THREE.InstancedMesh;
  private pingsMesh: THREE.InstancedMesh;
  private ghost: THREE.Group | null = null;
  private bolts: Bolt[] = [];
  private pings: Ping[] = [];
  private time = 0;
  private fogSeen = -1;
  private vr = false;

  constructor(
    scene: THREE.Scene,
    sim: Simulation,
    private readonly assets: Map<string, GameAsset>,
  ) {
    this.sim = sim;
    this.table.name = 'table';
    this.table.position.set(0, 0.92, -0.45);
    this.table.scale.setScalar(0.04);
    scene.add(this.table);
    this.mapRoot.position.set(-MAP_W / 2, 0, -MAP_H / 2);
    this.table.add(this.mapRoot);
    this.dressTable();
    this.rings = this.makeInstances(new THREE.RingGeometry(0.42, 0.55, 14), new THREE.MeshBasicMaterial({ color: '#f4efe4', side: THREE.DoubleSide }), 96);
    this.bars = this.makeInstances(new THREE.PlaneGeometry(1, 0.12), new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide }), 80);
    this.carries = this.makeInstances(new THREE.OctahedronGeometry(0.1, 0), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.4, roughness: 0.2 }), 80);
    this.boltsMesh = this.makeInstances(new THREE.OctahedronGeometry(0.08, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 48);
    this.pingsMesh = this.makeInstances(new THREE.RingGeometry(0.15, 0.28, 12), new THREE.MeshBasicMaterial({ color: '#f0c27a', transparent: true, opacity: 0.9, side: THREE.DoubleSide }), 12);
    this.orientFlat(this.rings);
    this.orientFlat(this.bars);
    this.orientFlat(this.pingsMesh);
    for (const kind of UNIT_KINDS) this.batches.set(kind, this.makeBatch(kind));
    this.rebuildMap();
  }

  bind(sim: Simulation): void {
    this.sim = sim;
    this.fogSeen = -1;
    this.rebuildMap();
    for (const group of this.buildings.values()) this.mapRoot.remove(group);
    this.buildings.clear();
    if (this.ghost) {
      this.mapRoot.remove(this.ghost);
      this.ghost = null;
    }
  }

  setVr(vr: boolean): void {
    this.vr = vr;
  }

  worldPoint(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    return this.mapRoot.localToWorld(target.set(x, y, z));
  }

  addBolt(x: number, z: number, tx: number, tz: number, owner: number): void {
    this.bolts.push({ x, z, tx, tz, life: 0.22, color: owner });
    if (this.bolts.length > 40) this.bolts.shift();
  }

  addPing(x: number, z: number): void {
    this.pings.push({ x, z, life: 0.6 });
  }

  showGhost(kind: string | null, cx: number, cz: number, ok: boolean): void {
    if (!kind) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const asset = this.assets.get(kind);
    if (!this.ghost || this.ghost.name !== kind) {
      if (this.ghost) this.mapRoot.remove(this.ghost);
      this.ghost = asset ? asset.structure(TEAM[0]) : new THREE.Group();
      this.ghost.name = kind;
      this.ghost.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = mats.map((mat) => {
          const clone = mat.clone();
          clone.transparent = true;
          clone.opacity = 0.55;
          return clone;
        });
      });
      this.mapRoot.add(this.ghost);
    }
    const stat = BUILDING_STATS[kind as keyof typeof BUILDING_STATS];
    const w = stat?.w ?? 2;
    const h = stat?.h ?? 2;
    this.ghost.visible = true;
    this.ghost.position.set(cx + w / 2, this.sim.sampleHeight(cx + w / 2, cz + h / 2), cz + h / 2);
    paintTeam(this.ghost, ok ? new THREE.Color('#8ee08a') : new THREE.Color('#ff6b6b'), false);
  }

  update(dt: number, selected: ReadonlySet<number>): void {
    this.time += dt;
    setUnitTime(this.time);
    this.syncFog();
    this.syncUnits(selected);
    this.syncBuildings(selected);
    this.syncNodes();
    this.syncFx(dt);
  }

  private rebuildMap(): void {
    const oldTerrain = this.mapRoot.getObjectByName('terrain');
    if (oldTerrain) this.mapRoot.remove(oldTerrain);
    if (this.fogMesh) this.mapRoot.remove(this.fogMesh);
    for (const mesh of this.nodeMeshes.values()) this.mapRoot.remove(mesh);
    this.nodeMeshes.clear();

    this.mapRoot.add(buildTerrain(this.sim));
    const fog = buildFog(this.sim);
    this.fogMesh = fog.mesh;
    this.fogColors = fog.colors;
    this.mapRoot.add(fog.mesh);
    for (const node of this.sim.nodes) {
      const asset = this.assets.get(node.kind === 'shard' ? 'shardglass' : 'fluxwell');
      const group = asset ? asset.structure(TEAM[0]) : new THREE.Group();
      group.position.set(node.cx + 1, this.sim.sampleHeight(node.cx + 1, node.cz + 1), node.cz + 1);
      this.mapRoot.add(group);
      this.nodeMeshes.set(node.id, group);
    }
    this.fogSeen = -1;
  }

  private syncFog(): void {
    if (!this.fogMesh || !this.fogColors || this.fogSeen === this.sim.fogSerial) return;
    this.fogSeen = this.sim.fogSerial;
    const fog = this.sim.fog[0];
    const colors = this.fogColors;
    for (let i = 0; i < fog.length; i++) {
      const state = fog[i];
      let r = 0.02;
      let g = 0.025;
      let b = 0.04;
      let a = 0.94;
      if (state === 2) a = 0;
      else if (state === 1) {
        r = 0.05;
        g = 0.07;
        b = 0.1;
        a = 0.5;
      }
      const o = i * 16;
      for (let v = 0; v < 4; v++) {
        colors[o + v * 4] = r;
        colors[o + v * 4 + 1] = g;
        colors[o + v * 4 + 2] = b;
        colors[o + v * 4 + 3] = a;
      }
    }
    const attr = this.fogMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private syncUnits(selected: ReadonlySet<number>): void {
    const buckets = new Map<UnitKind, Unit[]>();
    for (const kind of UNIT_KINDS) buckets.set(kind, []);
    for (const unit of this.sim.units) {
      if (unit.alive && unit.owner !== 0 && !this.sim.cellVisible(0, unit.x, unit.z)) continue;
      if (!unit.alive && !unit.deathVisible) continue;
      buckets.get(unit.kind)?.push(unit);
    }
    let ring = 0;
    let bar = 0;
    let carry = 0;
    for (const [kind, list] of buckets) {
      const batch = this.batches.get(kind);
      if (!batch) continue;
      const count = Math.min(list.length, MAX);
      if (batch.asset.skinnedTemplate) this.syncSkinned(batch, list, count);
      batch.mesh.count = batch.asset.skinnedTemplate ? 0 : count;
      for (let i = 0; i < count; i++) {
        const unit = list[i];
        const y = this.sim.sampleHeight(unit.x, unit.z);
        const sink = unit.alive ? 0 : Math.min(1, unit.deathT / 1.2);
        _pos.set(unit.x, y - sink * 0.45, unit.z);
        _quat.setFromAxisAngle(_up, unit.yaw);
        const s = (unit.alive ? 1 : Math.max(0.05, 1 - sink)) * (unit.kind === 'rampart' ? 1.55 : 1.7);
        _scale.setScalar(s);
        _matrix.compose(_pos, _quat, _scale);
        if (!batch.asset.skinnedTemplate) {
          batch.mesh.setMatrixAt(i, _matrix);
          const team = TEAM[unit.owner];
          _color.copy(team);
          if (unit.flash > 0) _color.lerp(_white, Math.min(1, unit.flash / 0.14));
          batch.team.setXYZ(i, _color.r, _color.g, _color.b);
          const state = unit.anim === 'walk' ? 1 : unit.anim === 'attack' ? 2 : unit.anim === 'gather' || unit.anim === 'build' ? 3 : 0;
          batch.anim.setXYZ(i, unit.animPhase, state, 0);
        }
        if (selected.has(unit.id) && ring < 80) {
          _pos.y = y + 0.05;
          _scale.set(unit.kind === 'rampart' ? 1.15 : 0.85, 1, unit.kind === 'rampart' ? 1.15 : 0.85);
          _quat.identity();
          _matrix.compose(_pos, _quat, _scale);
          this.rings.setMatrixAt(ring, _matrix);
          this.rings.setColorAt(ring, unit.owner === 0 ? TEAM[0] : TEAM[1]);
          ring++;
        }
        if ((selected.has(unit.id) || unit.hp < UNIT_STATS[kind].hp) && unit.alive && bar < 80) {
          const frac = Math.max(0.05, unit.hp / UNIT_STATS[kind].hp);
          _pos.set(unit.x, y + 0.9, unit.z);
          _scale.set(0.7 * frac, 1, 1);
          _quat.identity();
          _matrix.compose(_pos, _quat, _scale);
          this.bars.setMatrixAt(bar, _matrix);
          this.bars.setColorAt(bar, _color.setRGB(1 - frac, frac, 0.25));
          bar++;
        }
        if (unit.carry && carry < 80) {
          const at = batch.asset.sidecar.attachments.carry;
          _pos.set(at[0], at[1], at[2]).applyQuaternion(_quat.setFromAxisAngle(_up, unit.yaw));
          _pos.x += unit.x;
          _pos.y += y;
          _pos.z += unit.z;
          _scale.setScalar(1);
          _matrix.compose(_pos, _quat, _scale);
          this.carries.setMatrixAt(carry, _matrix);
          this.carries.setColorAt(carry, unit.carry.kind === 'shard' ? _color.set('#7ef0e4') : _color.set('#ff7ad9'));
          carry++;
        }
      }
      if (!batch.asset.skinnedTemplate) {
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.anim.needsUpdate = true;
        batch.team.needsUpdate = true;
      }
    }
    this.rings.count = ring;
    this.bars.count = bar;
    this.carries.count = carry;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    this.carries.instanceMatrix.needsUpdate = true;
    if (this.carries.instanceColor) this.carries.instanceColor.needsUpdate = true;
  }

  private syncSkinned(batch: UnitBatch, list: Unit[], count: number): void {
    const template = batch.asset.skinnedTemplate;
    if (!template) return;
    while (batch.skinned.length < count && batch.skinned.length < 24) {
      const root = template.clone(true);
      root.traverse((obj) => {
        const named = obj.name;
        if (named.endsWith('_lod0')) obj.visible = !this.vr;
        if (named.endsWith('_lod1')) obj.visible = this.vr;
      });
      const mixer = new THREE.AnimationMixer(root);
      this.mapRoot.add(root);
      batch.skinned.push({ root, mixer, action: '' });
    }
    for (let i = 0; i < batch.skinned.length; i++) {
      const slot = batch.skinned[i];
      const unit = list[i];
      slot.root.visible = i < count && i < 24;
      if (!slot.root.visible || !unit) continue;
      const y = this.sim.sampleHeight(unit.x, unit.z);
      slot.root.position.set(unit.x, y, unit.z);
      slot.root.rotation.y = unit.yaw;
      paintTeam(slot.root, TEAM[unit.owner], false);
      const clipName = unit.anim === 'walk' ? 'walk' : unit.anim;
      if (slot.action !== clipName) {
        slot.mixer.stopAllAction();
        const clip = THREE.AnimationClip.findByName(batch.asset.clips, clipName) || batch.asset.clips[0];
        if (clip) slot.mixer.clipAction(clip).play();
        slot.action = clipName;
      }
      slot.mixer.update(1 / 72);
    }
  }

  private syncBuildings(selected: ReadonlySet<number>): void {
    const wanted = new Set<number>();
    const draw = (id: number, kind: string, owner: number, cx: number, cz: number, progress: number, ghost: boolean) => {
      wanted.add(id);
      let group = this.buildings.get(id);
      if (!group) {
        const asset = this.assets.get(kind);
        group = asset ? asset.structure(TEAM[owner] ?? TEAM[0]) : new THREE.Group();
        this.mapRoot.add(group);
        this.buildings.set(id, group);
      }
      const stat = BUILDING_STATS[kind as keyof typeof BUILDING_STATS];
      const w = stat?.w ?? 2;
      const h = stat?.h ?? 2;
      const y = this.sim.sampleHeight(cx + w / 2, cz + h / 2);
      group.position.set(cx + w / 2, y, cz + h / 2);
      group.scale.set(1, 0.2 + 0.8 * progress, 1);
      paintTeam(group, TEAM[owner] ?? TEAM[0], ghost);
      if (selected.has(id) && this.rings.count < 96) {
        const idx = this.rings.count;
        _pos.set(cx + w / 2, y + 0.08, cz + h / 2);
        _quat.identity();
        _scale.set(w * 0.55, 1, h * 0.55);
        _matrix.compose(_pos, _quat, _scale);
        this.rings.setMatrixAt(idx, _matrix);
        this.rings.setColorAt(idx, TEAM[owner] ?? TEAM[0]);
        this.rings.count = idx + 1;
        this.rings.instanceMatrix.needsUpdate = true;
        if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
      }
    };
    for (const building of this.sim.buildings) {
      if (!building.alive || building.owner !== 0) continue;
      const total = Math.max(0.001, building.buildTotal);
      draw(building.id, building.kind, building.owner, building.cx, building.cz, 1 - building.buildLeft / total, false);
    }
    for (const ghost of this.sim.ghosts.values()) {
      const live = this.sim.buildingById(ghost.id);
      const stat = BUILDING_STATS[ghost.kind];
      const visible = this.sim.footprintVisible(0, ghost.cx, ghost.cz, stat.w, stat.h);
      if (live?.alive) {
        const total = Math.max(0.001, live.buildTotal);
        draw(live.id, live.kind, live.owner, live.cx, live.cz, 1 - live.buildLeft / total, !visible);
      } else if (!visible) {
        draw(ghost.id, ghost.kind, ghost.owner, ghost.cx, ghost.cz, 1, true);
      }
    }
    for (const [id, group] of this.buildings) {
      if (wanted.has(id)) continue;
      this.mapRoot.remove(group);
      this.buildings.delete(id);
    }
  }

  private syncNodes(): void {
    for (const node of this.sim.nodes) {
      const mesh = this.nodeMeshes.get(node.id);
      if (!mesh) continue;
      const frac = node.initial > 0 ? node.amount / node.initial : 0;
      mesh.visible = frac > 0.01 && this.sim.footprintExplored(0, node.cx, node.cz, 2, 2);
      const s = 0.35 + 0.65 * frac;
      mesh.scale.setScalar(s);
    }
  }

  private syncFx(dt: number): void {
    let boltCount = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      bolt.life -= dt;
      if (bolt.life <= 0) {
        this.bolts.splice(i, 1);
        continue;
      }
      const u = 1 - bolt.life / 0.22;
      const x = bolt.x + (bolt.tx - bolt.x) * u;
      const z = bolt.z + (bolt.tz - bolt.z) * u;
      const y = this.sim.sampleHeight(x, z) + 0.45;
      _pos.set(x, y, z);
      _quat.identity();
      _scale.setScalar(1);
      _matrix.compose(_pos, _quat, _scale);
      this.boltsMesh.setMatrixAt(boltCount, _matrix);
      this.boltsMesh.setColorAt(boltCount, bolt.color === 0 ? _color.set('#ffd27a') : _color.set('#c4b6ff'));
      boltCount++;
    }
    this.boltsMesh.count = boltCount;
    this.boltsMesh.instanceMatrix.needsUpdate = true;
    if (this.boltsMesh.instanceColor) this.boltsMesh.instanceColor.needsUpdate = true;

    let pingCount = 0;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i];
      ping.life -= dt;
      if (ping.life <= 0) {
        this.pings.splice(i, 1);
        continue;
      }
      const y = this.sim.sampleHeight(ping.x, ping.z) + 0.08;
      const s = 1 + (0.6 - ping.life);
      _pos.set(ping.x, y, ping.z);
      _quat.identity();
      _scale.setScalar(s);
      _matrix.compose(_pos, _quat, _scale);
      this.pingsMesh.setMatrixAt(pingCount, _matrix);
      pingCount++;
    }
    this.pingsMesh.count = pingCount;
    this.pingsMesh.instanceMatrix.needsUpdate = true;
  }

  private makeBatch(kind: UnitKind): UnitBatch {
    const asset = this.assets.get(kind);
    const geo = asset?.geometry ?? new THREE.BoxGeometry(0.4, 0.4, 0.4);
    if (!geo.getAttribute('teamMask')) {
      const n = geo.getAttribute('position').count;
      geo.setAttribute('teamMask', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
      geo.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(n), 1));
    }
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    const team = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    anim.setUsage(THREE.DynamicDrawUsage);
    team.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', anim);
    geo.setAttribute('aTeam', team);
    const mesh = new THREE.InstancedMesh(geo, createUnitMaterial(), MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mapRoot.add(mesh);
    return {
      kind,
      mesh,
      anim,
      team,
      skinned: [],
      asset: asset ?? {
        id: kind,
        source: 'procedural',
        sidecar: {
          id: kind,
          footprint: [1, 1],
          boundingRadius: 0.4,
          attachments: { muzzle: [0, 0.4, 0.3], carry: [0.2, 0.4, 0], selection_ring: [0, 0.02, 0] },
          lods: [],
          animations: [],
        },
        geometry: geo,
        skinnedTemplate: null,
        clips: [],
        structure: () => new THREE.Group(),
      },
    };
  }

  private makeInstances(geo: THREE.BufferGeometry, mat: THREE.Material, max: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mapRoot.add(mesh);
    return mesh;
  }

  private orientFlat(mesh: THREE.InstancedMesh): void {
    mesh.geometry.rotateX(-Math.PI / 2);
  }

  private dressTable(): void {
    const ceramic = new THREE.MeshStandardMaterial({ color: '#2a2723', roughness: 0.78, metalness: 0.08 });
    const lip = new THREE.MeshStandardMaterial({ color: '#d9c7a4', roughness: 0.42, metalness: 0.18 });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(MAP_W + 3.2, 7.5, MAP_H + 3.2), ceramic);
    plinth.position.set(0, -3.75, 0);
    this.table.add(plinth);
    const frame = (w: number, d: number, x: number, z: number) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.28, d), lip);
      bar.position.set(x, 0.08, z);
      this.table.add(bar);
    };
    const o = MAP_W / 2 + 1.15;
    frame(MAP_W + 3.4, 0.55, 0, -o);
    frame(MAP_W + 3.4, 0.55, 0, o);
    frame(0.55, MAP_H + 2.4, -o, 0);
    frame(0.55, MAP_H + 2.4, o, 0);
    for (const [x, z, color] of [
      [-o, -o, '#e39b3a'],
      [o, -o, '#7d6bff'],
      [-o, o, '#7ecfc4'],
      [o, o, '#e39b3a'],
    ] as const) {
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 8, 6),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.3 }),
      );
      lamp.position.set(x, 0.45, z);
      this.table.add(lamp);
    }
  }
}

function buildTerrain(sim: Simulation): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP_W, MAP_H, MAP_W, MAP_H);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const low = new THREE.Color('#5f8d86');
  const mid = new THREE.Color('#d2c09a');
  const high = new THREE.Color('#f4ecdc');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + MAP_W / 2;
    const z = pos.getZ(i) + MAP_H / 2;
    const h = sim.sampleHeight(x, z);
    pos.setY(i, h);
    const t = Math.min(1, h / 1.15);
    _color.copy(low).lerp(mid, Math.min(1, t * 1.35)).lerp(high, Math.max(0, (t - 0.55) / 0.45));
    colors[i * 3] = _color.r;
    colors[i * 3 + 1] = _color.g;
    colors[i * 3 + 2] = _color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map: gridTexture(),
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    }),
  );
  mesh.name = 'terrain';
  mesh.position.set(MAP_W / 2, 0, MAP_H / 2);
  return mesh;
}

function buildFog(sim: Simulation): { mesh: THREE.Mesh; colors: Float32Array } {
  const positions: number[] = [];
  const colors = new Float32Array(MAP_W * MAP_H * 16);
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      const y00 = sim.sampleHeight(x, z) + 0.07;
      const y10 = sim.sampleHeight(x + 1, z) + 0.07;
      const y01 = sim.sampleHeight(x, z + 1) + 0.07;
      const y11 = sim.sampleHeight(x + 1, z + 1) + 0.07;
      positions.push(x, y00, z, x + 1, y10, z, x + 1, y11, z + 1, x, y01, z + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geo.setIndex(quadIndex(MAP_W * MAP_H));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }),
  );
  mesh.name = 'fog';
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh, colors };
}

function quadIndex(quads: number): THREE.BufferAttribute {
  const index = new Uint32Array(quads * 6);
  for (let i = 0; i < quads; i++) {
    const v = i * 4;
    index[i * 6] = v;
    index[i * 6 + 1] = v + 1;
    index[i * 6 + 2] = v + 2;
    index[i * 6 + 3] = v;
    index[i * 6 + 4] = v + 2;
    index[i * 6 + 5] = v + 3;
  }
  return new THREE.BufferAttribute(index, 1);
}

function gridTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  ctx.fillStyle = '#f3efe6';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3500; i++) {
    ctx.fillStyle = `rgba(90, 70, 40, ${Math.random() * 0.07})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  ctx.strokeStyle = 'rgba(80, 64, 40, 0.28)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= MAP_W; i++) {
    const p = (i / MAP_W) * 512;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(512, p);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
