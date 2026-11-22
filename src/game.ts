import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { BUILDING_STATS, UNIT_STATS, type BuildingKind, type UnitKind } from './sim/defs.ts';
import { Opponent } from './sim/ai.ts';
import { Simulation } from './sim/sim.ts';
import { loadRegistry } from './assets/registry.ts';
import { loadNative } from './wasm/native.ts';
import { Sfx } from './audio/sfx.ts';
import { DesktopControls } from './input/desktop.ts';
import { pickMap, rayToMap, type PickHit } from './input/pick.ts';
import { XrRig } from './input/xr.ts';
import { Battlefield } from './render/view.ts';
import { Hud, type HudAction } from './ui/hud.ts';

const _worldRay = new THREE.Ray();
const _mapRay = new THREE.Ray();
const _proj = new THREE.Vector3();

export async function boot(root: HTMLElement): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.className = 'view';
  root.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.xr.enabled = true;
  renderer.xr.setFramebufferScaleFactor(1);
  renderer.xr.setReferenceSpaceType('local-floor');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#12151c');
  scene.fog = new THREE.Fog('#12151c', 7, 18);
  scene.add(new THREE.HemisphereLight('#d7e6ff', '#6d5a44', 1.15));
  const sun = new THREE.DirectionalLight('#fff3df', 1.45);
  sun.position.set(6, 10, 3);
  scene.add(sun);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(5, 48),
    new THREE.MeshStandardMaterial({ color: '#191c22', roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.04, 50);
  const hud = new Hud(root);
  const help = document.createElement('div');
  help.className = 'help';
  help.innerHTML = 'Left click select · drag a box · right click command<br>Arrows pan · wheel zoom · Q/E orbit · middle-drag turn<br>B/N build · C/D/F train · S stop · H hold · Space home · V reset table<br>VR: trigger select/command · grip or fist grabs the table · pinch clicks';
  hud.root.appendChild(help);

  const [backend, assets] = await Promise.all([loadNative(), loadRegistry()]);
  let sim = new Simulation(1979);
  let ai = new Opponent();
  const view = new Battlefield(scene, sim, assets);
  const sfx = new Sfx();
  const desktop = new DesktopControls(canvas, camera);
  const xr = new XrRig(renderer, scene, view.table, hud.vrCanvas);
  const session = new Match(renderer, camera, sim, ai, view, hud, sfx, desktop, xr);
  hud.onAction = (id) => session.action(id);
  hud.onMinimap = (x, z) => session.focusMap(x, z);
  desktop.onPrimaryUp = (additive, dragged, rect) => session.primaryUp(additive, dragged, rect);
  desktop.onSecondary = () => session.secondary();
  desktop.onKey = (ev) => session.key(ev);
  desktop.bindKeys();

  const vrButton = VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking', 'local-floor'] });
  document.body.appendChild(vrButton);
  renderer.xr.addEventListener('sessionstart', () => {
    hud.setVr(true);
    view.setVr(true);
    sfx.resume();
  });
  renderer.xr.addEventListener('sessionend', () => {
    hud.setVr(false);
    view.setVr(false);
  });
  window.addEventListener('pointerdown', () => sfx.resume(), { once: false });
  window.addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let prev = -1;
  renderer.setAnimationLoop((time) => {
    const dt = prev < 0 ? 0.016 : Math.min(0.05, (time - prev) / 1000);
    prev = time;
    if (!renderer.xr.isPresenting) desktop.update(dt);
    xr.update();
    session.frame(dt);
    hud.update(session.sim, session.selected, backend);
    xr.texture.needsUpdate = true;
    renderer.render(scene, camera);
  });
}

class Match {
  selected = new Set<number>();
  build: BuildingKind | null = null;
  hover: PickHit | null = null;
  private groups: number[][] = [[], [], []];
  private xrPress = new Map<number, { x: number; z: number; hud: HudAction | null; moved: boolean }>();
  private raycaster = new THREE.Raycaster();
  private marquee: THREE.LineLoop;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
    public sim: Simulation,
    public ai: Opponent,
    private readonly view: Battlefield,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly desktop: DesktopControls,
    private readonly xr: XrRig,
  ) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.marquee = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xf0c27a }));
    this.marquee.visible = false;
    this.marquee.frustumCulled = false;
    this.view.mapRoot.add(this.marquee);
  }

  frame(dt: number): void {
    this.hover = this.renderer.xr.isPresenting ? this.xrHover() : this.desktopHover();
    if (!this.xr.grabbing) this.consumeXr();
    this.hud.marquee(this.desktop.box);
    this.updateGhost();
    if (this.sim.winner === null) {
      this.ai.update(this.sim, dt);
      this.sim.update(dt);
      this.consumeEvents();
    }
    this.view.update(dt, this.selected);
  }

  primaryUp(additive: boolean, dragged: boolean, rect: { x: number; y: number; w: number; h: number } | null): void {
    if (dragged && rect) {
      this.selectScreen(rect, additive);
      this.sfx.select();
      return;
    }
    const hit = this.hover;
    if (this.build) {
      if (hit && (hit.kind === 'ground' || hit.kind === 'node' || hit.kind === 'unit')) this.tryPlace(hit.x, hit.z);
      return;
    }
    if (hit && (hit.kind === 'unit' || hit.kind === 'building')) {
      this.pickEntity(hit.id, additive);
      return;
    }
    if (!additive) this.selected.clear();
  }

  secondary(): void {
    if (this.build) {
      this.build = null;
      this.view.showGhost(null, 0, 0, false);
      return;
    }
    this.issue(this.hover);
  }

  key(ev: KeyboardEvent): void {
    if (ev.code === 'Escape') {
      this.build = null;
      this.selected.clear();
      return;
    }
    if (ev.code === 'KeyB') this.action('armory');
    else if (ev.code === 'KeyN') this.action('waystation');
    else if (ev.code === 'KeyC') this.action('courier');
    else if (ev.code === 'KeyD') this.action('dart');
    else if (ev.code === 'KeyF') this.action('rampart');
    else if (ev.code === 'KeyS') this.action('stop');
    else if (ev.code === 'KeyH') this.action('hold');
    else if (ev.code === 'Space') this.focusHome();
    else if (ev.code === 'KeyV') this.resetTable();
    else if (ev.code.startsWith('Digit')) {
      const index = Number(ev.code.slice(5)) - 1;
      if (index < 0 || index > 2) return;
      if (ev.ctrlKey) this.groups[index] = [...this.selected];
      else this.selected = new Set(this.groups[index].filter((id) => this.alive(id)));
    }
  }

  action(id: HudAction): void {
    if (id === 'restart') {
      this.restart();
      return;
    }
    if (id === 'armory' || id === 'waystation') {
      this.build = this.build === id ? null : id;
      this.sfx.select();
      return;
    }
    if (id === 'stop') {
      this.sim.stop(0, this.playerUnits());
      return;
    }
    if (id === 'hold') {
      this.sim.hold(0, this.playerUnits());
      return;
    }
    const kind = id as UnitKind;
    const stat = UNIT_STATS[kind];
    const preferred = [...this.selected].find((n) => this.sim.buildingById(n)?.kind === stat.builtAt);
    const result = this.sim.train(0, kind, preferred);
    if (!result.ok) this.hud.toast(result.reason ?? 'Cannot train');
    else this.sfx.command();
  }

  focusMap(x: number, z: number): void {
    this.desktop.target.copy(this.view.worldPoint(x, 0.3, z));
  }

  private restart(): void {
    this.sim = new Simulation((Math.random() * 1e9) | 0);
    this.ai = new Opponent();
    this.view.bind(this.sim);
    this.selected.clear();
    this.build = null;
    this.sfx.select();
  }

  private desktopHover(): PickHit | null {
    this.desktop.ray(_worldRay);
    rayToMap(_worldRay, this.view.mapRoot, _mapRay);
    return pickMap(this.sim, _mapRay);
  }

  private xrHover(): PickHit | null {
    let best: PickHit | null = null;
    for (const pointer of this.xr.pointers) {
      rayToMap(pointer.ray, this.view.mapRoot, _mapRay);
      const hit = pickMap(this.sim, _mapRay);
      if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
  }

  private consumeXr(): void {
    for (const pointer of this.xr.pointers) {
      const hudHit = this.panelAction(pointer.ray);
      if (pointer.down) {
        const hit = this.hitFrom(pointer.ray);
        this.xrPress.set(pointer.id, {
          x: hit?.x ?? 0,
          z: hit?.z ?? 0,
          hud: hudHit,
          moved: false,
        });
      }
      const press = this.xrPress.get(pointer.id);
      if (press && !press.hud) {
        const hit = this.hitFrom(pointer.ray);
        if (hit && Math.hypot(hit.x - press.x, hit.z - press.z) > 0.75) {
          press.moved = true;
          this.showMapMarquee(press.x, press.z, hit.x, hit.z);
        }
      }
      if (!pointer.up) continue;
      const done = this.xrPress.get(pointer.id);
      this.xrPress.delete(pointer.id);
      this.marquee.visible = false;
      if (!done) continue;
      if (done.hud) {
        this.action(done.hud);
        continue;
      }
      const hit = this.hitFrom(pointer.ray);
      if (done.moved && hit) {
        this.selectMap(done.x, done.z, hit.x, hit.z, pointer.additive);
        this.sfx.select();
        continue;
      }
      if (this.build && hit) {
        this.tryPlace(hit.x, hit.z);
        continue;
      }
      if (hit && (hit.kind === 'unit' || hit.kind === 'building') && this.owns(hit)) {
        this.pickEntity(hit.id, pointer.additive);
        continue;
      }
      if (this.playerUnits().length) this.issue(hit);
      else if (!pointer.additive) this.selected.clear();
    }
  }

  private panelAction(ray: THREE.Ray): HudAction | null {
    this.raycaster.ray.copy(ray);
    const hit = this.raycaster.intersectObject(this.xr.panel, false)[0];
    if (!hit?.uv) return null;
    return this.hud.hitVr(hit.uv.x, hit.uv.y);
  }

  private hitFrom(ray: THREE.Ray): PickHit | null {
    rayToMap(ray, this.view.mapRoot, _mapRay);
    return pickMap(this.sim, _mapRay);
  }

  private updateGhost(): void {
    if (!this.build || !this.hover) {
      this.view.showGhost(null, 0, 0, false);
      return;
    }
    const stat = BUILDING_STATS[this.build];
    const cx = Math.floor(this.hover.x) - Math.floor((stat?.w ?? 2) / 2);
    const cz = Math.floor(this.hover.z) - Math.floor((stat?.h ?? 2) / 2);
    const ok = this.sim.placementError(0, this.build, cx, cz) === null;
    this.view.showGhost(this.build, cx, cz, ok);
  }

  private tryPlace(x: number, z: number): void {
    if (!this.build) return;
    const stat = BUILDING_STATS[this.build];
    const cx = Math.floor(x) - Math.floor(stat.w / 2);
    const cz = Math.floor(z) - Math.floor(stat.h / 2);
    const helpers = this.playerUnits().filter((id) => this.sim.unitById(id)?.kind === 'courier');
    const result = this.sim.place(0, this.build, cx, cz, helpers);
    if (!result.ok) this.hud.toast(result.reason ?? 'Cannot build there');
    else {
      this.sfx.place();
      this.build = null;
    }
  }

  private issue(hit: PickHit | null): void {
    const units = this.playerUnits();
    if (!hit) return;
    if (!units.length) {
      if (hit.kind === 'ground') {
        for (const id of this.selected) {
          const building = this.sim.buildingById(id);
          if (building?.alive && building.owner === 0) this.sim.setRally(id, hit.x, hit.z);
        }
      }
      return;
    }
    if ((hit.kind === 'unit' || hit.kind === 'building') && !this.owns(hit)) {
      this.sim.command(0, units, { type: 'attack', targetId: hit.id });
    } else if (hit.kind === 'node') {
      this.sim.command(0, units, { type: 'gather', nodeId: hit.id, x: hit.x, z: hit.z });
    } else if (hit.kind === 'building' && this.owns(hit)) {
      const building = this.sim.buildingById(hit.id);
      if (building && building.buildLeft > 0) {
        this.sim.command(0, units, { type: 'assist', buildingId: building.id, x: hit.x, z: hit.z });
      } else {
        this.sim.command(0, units, { type: 'move', x: hit.x, z: hit.z, attackMove: true });
      }
    } else {
      this.sim.command(0, units, { type: 'move', x: hit.x, z: hit.z, attackMove: true });
    }
    this.sfx.command();
    this.view.addPing(hit.x, hit.z);
  }

  private pickEntity(id: number, additive: boolean): void {
    if (additive && this.selected.has(id)) this.selected.delete(id);
    else if (additive) this.selected.add(id);
    else this.selected = new Set([id]);
    this.sfx.select();
  }

  private selectScreen(rect: { x: number; y: number; w: number; h: number }, additive: boolean): void {
    const ids: number[] = [];
    const width = window.innerWidth;
    const height = window.innerHeight;
    const inside = (x: number, y: number, z: number) => {
      this.view.worldPoint(x, y, z, _proj);
      _proj.project(this.camera);
      const sx = (_proj.x * 0.5 + 0.5) * width;
      const sy = (-_proj.y * 0.5 + 0.5) * height;
      return sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h;
    };
    for (const unit of this.sim.units) {
      if (!unit.alive || unit.owner !== 0) continue;
      if (inside(unit.x, this.sim.sampleHeight(unit.x, unit.z), unit.z)) ids.push(unit.id);
    }
    for (const building of this.sim.buildings) {
      if (!building.alive || building.owner !== 0) continue;
      const stat = BUILDING_STATS[building.kind];
      if (inside(building.cx + stat.w / 2, 1, building.cz + stat.h / 2)) ids.push(building.id);
    }
    if (!additive) this.selected.clear();
    for (const id of ids) this.selected.add(id);
  }

  private selectMap(x0: number, z0: number, x1: number, z1: number, additive: boolean): void {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    if (!additive) this.selected.clear();
    for (const unit of this.sim.units) {
      if (!unit.alive || unit.owner !== 0) continue;
      if (unit.x >= minX && unit.x <= maxX && unit.z >= minZ && unit.z <= maxZ) this.selected.add(unit.id);
    }
  }

  private showMapMarquee(x0: number, z0: number, x1: number, z1: number): void {
    const y = 0.2;
    const pos = this.marquee.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, x0, y, z0);
    pos.setXYZ(1, x1, y, z0);
    pos.setXYZ(2, x1, y, z1);
    pos.setXYZ(3, x0, y, z1);
    pos.needsUpdate = true;
    this.marquee.visible = true;
  }

  private consumeEvents(): void {
    for (const event of this.sim.events) {
      if (event.type === 'attack' && event.ranged && (event.owner === 0 || this.sim.cellVisible(0, event.x, event.z))) {
        this.view.addBolt(event.x, event.z, event.tx, event.tz, event.owner);
        if (event.owner === 0) this.sfx.hit();
      } else if (event.type === 'attack' && event.owner === 0) this.sfx.hit();
      else if (event.type === 'gather' && event.owner === 0) this.sfx.gather();
      else if (event.type === 'underAttack') {
        this.hud.toast('Umbra is pressing the claim');
        this.sfx.alarm();
      } else if (event.type === 'buildComplete' && event.owner === 0) this.sfx.ready();
      else if (event.type === 'trainComplete' && event.owner === 0) this.sfx.ready();
      else if (event.type === 'win') {
        if (event.winner === 0) this.sfx.win();
        else this.sfx.lose();
      }
    }
  }

  private playerUnits(): number[] {
    return [...this.selected].filter((id) => {
      const unit = this.sim.unitById(id);
      return !!unit && unit.alive && unit.owner === 0;
    });
  }

  private owns(hit: PickHit): boolean {
    return (hit.kind === 'unit' || hit.kind === 'building') && hit.owner === 0;
  }

  private alive(id: number): boolean {
    return !!this.sim.unitById(id)?.alive || !!this.sim.buildingById(id)?.alive;
  }

  private focusHome(): void {
    const foundry = this.sim.buildings.find((b) => b.alive && b.owner === 0 && b.kind === 'foundry');
    if (!foundry) return;
    this.focusMap(foundry.cx + 1.5, foundry.cz + 1.5);
  }

  private resetTable(): void {
    this.view.table.position.set(0, 0.92, -0.45);
    this.view.table.rotation.set(0, 0, 0);
    this.view.table.quaternion.identity();
    this.view.table.scale.setScalar(0.04);
    this.desktop.yaw = 0.72;
    this.desktop.pitch = 0.96;
    this.desktop.dist = 1.7;
    this.desktop.target.set(0, 0.95, -0.45);
  }
}
