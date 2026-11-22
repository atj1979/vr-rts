import {
  BUILDING_STATS,
  FACTIONS,
  MAP_H,
  MAP_W,
  RESOURCE_LABEL,
  UNIT_STATS,
  type BuildingKind,
} from '../sim/defs.ts';
import type { Building, Simulation, Unit } from '../sim/sim.ts';

export type HudAction = 'armory' | 'waystation' | 'courier' | 'dart' | 'rampart' | 'stop' | 'hold' | 'restart';

interface ButtonBox {
  id: HudAction;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Hud {
  readonly root: HTMLElement;
  readonly vrCanvas: HTMLCanvasElement;
  onAction: (id: HudAction) => void = () => {};
  onMinimap: (x: number, z: number) => void = () => {};
  private toastEl: HTMLElement;
  private toastUntil = 0;
  private banner: HTMLElement;
  private selectionEl: HTMLElement;
  private minimap: HTMLCanvasElement;
  private vrButtons: ButtonBox[] = [];
  private vrCtx: CanvasRenderingContext2D | null;
  private bannerShown = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <header class="topbar">
        <div class="crest" aria-hidden="true"></div>
        <div>
          <div class="title">Glassreach</div>
          <div class="subtitle">Lumen Foundry</div>
        </div>
        <div class="stocks" id="stocks"></div>
        <div class="backend" id="backend"></div>
      </header>
      <div id="toast" class="toast"></div>
      <div id="banner" class="banner hidden"></div>
      <aside class="side">
        <canvas id="minimap" width="168" height="168"></canvas>
        <div id="selection" class="selection">Nothing selected</div>
      </aside>
      <footer class="dock" id="dock"></footer>
      <div id="marquee" class="marquee"></div>
    `;
    parent.appendChild(this.root);
    this.toastEl = this.root.querySelector('#toast') as HTMLElement;
    this.banner = this.root.querySelector('#banner') as HTMLElement;
    this.selectionEl = this.root.querySelector('#selection') as HTMLElement;
    this.minimap = this.root.querySelector('#minimap') as HTMLCanvasElement;
    this.vrCanvas = document.createElement('canvas');
    this.vrCanvas.width = 512;
    this.vrCanvas.height = 512;
    this.vrCtx = this.vrCanvas.getContext('2d');
    this.buildDock();
    this.minimap.addEventListener('pointerdown', (ev) => {
      const rect = this.minimap.getBoundingClientRect();
      const u = (ev.clientX - rect.left) / rect.width;
      const v = (ev.clientY - rect.top) / rect.height;
      this.onMinimap(u * MAP_W, v * MAP_H);
    });
  }

  setVr(active: boolean): void {
    this.root.classList.toggle('vr', active);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    this.toastUntil = performance.now() + 2200;
  }

  marquee(rect: { x: number; y: number; w: number; h: number } | null): void {
    const el = this.root.querySelector('#marquee') as HTMLElement;
    if (!rect || rect.w < 2 || rect.h < 2) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }

  update(sim: Simulation, selected: ReadonlySet<number>, backend: string): void {
    if (performance.now() > this.toastUntil) this.toastEl.classList.remove('show');
    const stock = sim.players[0];
    const crew = `${sim.crewUsed(0)}/${sim.crewMax(0)}`;
    const stocks = this.root.querySelector('#stocks') as HTMLElement;
    stocks.innerHTML = `
      <span><i class="shard"></i> ${RESOURCE_LABEL.shard} <b>${Math.floor(stock.shard)}</b></span>
      <span><i class="flux"></i> ${RESOURCE_LABEL.flux} <b>${Math.floor(stock.flux)}</b></span>
      <span>Crew <b>${crew}</b></span>`;
    (this.root.querySelector('#backend') as HTMLElement).textContent = backend === 'wasm' ? 'navigator · wasm' : 'navigator · js';
    this.selectionEl.innerHTML = describeSelection(sim, selected);
    this.drawMinimap(sim);
    this.drawWrist(sim, selected, backend);
    if (sim.winner === null) {
      this.banner.classList.add('hidden');
      this.bannerShown = false;
      return;
    }
    if (this.bannerShown) return;
    this.bannerShown = true;
    this.banner.classList.remove('hidden');
    const won = sim.winner === 0;
    this.banner.innerHTML = `<h2>${won ? 'The mesa is yours' : 'Foundry shattered'}</h2><p>${won ? 'Umbra Compact has lost its claim.' : 'Lumen Foundry fell.'}</p><button type="button" data-action="restart">New skirmish</button>`;
    this.banner.querySelector('button')?.addEventListener('click', () => this.onAction('restart'), { once: true });
  }

  hitVr(u: number, v: number): HudAction | null {
    const x = u * this.vrCanvas.width;
    const y = (1 - v) * this.vrCanvas.height;
    for (const button of this.vrButtons) {
      if (x >= button.x && y >= button.y && x <= button.x + button.w && y <= button.y + button.h) return button.id;
    }
    return null;
  }

  private buildDock(): void {
    const dock = this.root.querySelector('#dock') as HTMLElement;
    const buttons: { id: HudAction; label: string; cost: string; hint: string }[] = [
      { id: 'armory', label: 'Armory', cost: `${BUILDING_STATS.armory.shard} / ${BUILDING_STATS.armory.flux}`, hint: 'B' },
      { id: 'waystation', label: 'Waystation', cost: `${BUILDING_STATS.waystation.shard}`, hint: 'N' },
      { id: 'courier', label: 'Courier', cost: `${UNIT_STATS.courier.shard}`, hint: 'C' },
      { id: 'dart', label: 'Dart', cost: `${UNIT_STATS.dart.shard} / ${UNIT_STATS.dart.flux}`, hint: 'D' },
      { id: 'rampart', label: 'Rampart', cost: `${UNIT_STATS.rampart.shard} / ${UNIT_STATS.rampart.flux}`, hint: 'F' },
      { id: 'stop', label: 'Stop', cost: 'clear orders', hint: 'S' },
      { id: 'hold', label: 'Hold', cost: 'stand ground', hint: 'H' },
    ];
    for (const button of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cmd';
      el.innerHTML = `<span>${button.label}</span><small>${button.cost}</small><kbd>${button.hint}</kbd>`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onAction(button.id);
      });
      dock.appendChild(el);
    }
  }

  private drawMinimap(sim: Simulation): void {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;
    const w = this.minimap.width;
    const fog = sim.fog[0];
    const img = ctx.createImageData(w, w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const gx = Math.min(MAP_W - 1, Math.floor((x / w) * MAP_W));
        const gz = Math.min(MAP_H - 1, Math.floor((y / w) * MAP_H));
        const state = fog[gz * MAP_W + gx];
        const o = (y * w + x) * 4;
        if (state === 0) {
          img.data[o] = 12;
          img.data[o + 1] = 14;
          img.data[o + 2] = 20;
        } else if (state === 1) {
          img.data[o] = 48;
          img.data[o + 1] = 52;
          img.data[o + 2] = 46;
        } else {
          img.data[o] = 186;
          img.data[o + 1] = 170;
          img.data[o + 2] = 130;
        }
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const dot = (x: number, z: number, color: string, r: number) => {
      ctx.fillStyle = color;
      ctx.fillRect((x / MAP_W) * w - r, (z / MAP_H) * w - r, r * 2, r * 2);
    };
    for (const node of sim.nodes) {
      if (!sim.footprintExplored(0, node.cx, node.cz, 2, 2) || node.amount <= 0) continue;
      dot(node.cx + 1, node.cz + 1, node.kind === 'shard' ? '#7ef0e4' : '#ff7ad9', 2);
    }
    for (const building of sim.buildings) {
      if (!building.alive) continue;
      if (building.owner !== 0 && !sim.ghosts.has(building.id)) continue;
      const stat = BUILDING_STATS[building.kind];
      dot(building.cx + stat.w / 2, building.cz + stat.h / 2, FACTIONS[building.owner].color, 3);
    }
    for (const unit of sim.units) {
      if (!unit.alive) continue;
      if (unit.owner !== 0 && !sim.cellVisible(0, unit.x, unit.z)) continue;
      dot(unit.x, unit.z, FACTIONS[unit.owner].color, 1.5);
    }
  }

  private drawWrist(sim: Simulation, selected: ReadonlySet<number>, backend: string): void {
    const ctx = this.vrCtx;
    if (!ctx) return;
    const w = this.vrCanvas.width;
    const h = this.vrCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(16, 18, 24, 0.92)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(227, 155, 58, 0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#f4efe4';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.fillText('GLASSREACH', 36, 52);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#7ef0e4';
    ctx.fillText(`${Math.floor(sim.players[0].shard)} shardglass`, 36, 92);
    ctx.fillStyle = '#ff9adf';
    ctx.fillText(`${Math.floor(sim.players[0].flux)} fluxwell`, 250, 92);
    ctx.fillStyle = '#f4efe4';
    ctx.fillText(`crew ${sim.crewUsed(0)}/${sim.crewMax(0)}`, 36, 124);
    ctx.fillStyle = '#9aa3ad';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(backend === 'wasm' ? 'wasm navigator' : 'js navigator', 320, 124);
    const labels: { id: HudAction; label: string }[] = [
      { id: 'armory', label: 'Armory' },
      { id: 'waystation', label: 'Waystation' },
      { id: 'courier', label: 'Courier' },
      { id: 'dart', label: 'Dart' },
      { id: 'rampart', label: 'Rampart' },
      { id: 'stop', label: 'Stop' },
      { id: 'hold', label: 'Hold' },
    ];
    this.vrButtons = [];
    labels.forEach((button, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = 36 + col * 230;
      const y = 150 + row * 78;
      this.vrButtons.push({ id: button.id, x, y, w: 210, h: 64 });
      ctx.fillStyle = '#2a241c';
      roundRect(ctx, x, y, 210, 64, 12);
      ctx.fill();
      ctx.strokeStyle = '#e39b3a';
      ctx.stroke();
      ctx.fillStyle = '#f4efe4';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(button.label, x + 16, y + 40);
    });
    ctx.fillStyle = '#c9d0d6';
    ctx.font = '18px system-ui, sans-serif';
    const text = describeSelection(sim, selected).replace(/<[^>]+>/g, ' ');
    ctx.fillText(text.slice(0, 42), 36, 470);
  }
}

function describeSelection(sim: Simulation, selected: ReadonlySet<number>): string {
  if (!selected.size) return 'Nothing selected. Point at your own glass.';
  const units: Unit[] = [];
  const buildings: Building[] = [];
  for (const id of selected) {
    const unit = sim.unitById(id);
    if (unit?.alive) units.push(unit);
    const building = sim.buildingById(id);
    if (building?.alive) buildings.push(building);
  }
  if (units.length === 1 && !buildings.length) {
    const unit = units[0];
    const stat = UNIT_STATS[unit.kind];
    return `<b>${stat.label}</b> · ${FACTIONS[unit.owner].short}<br>${Math.ceil(unit.hp)} / ${stat.hp} · ${stat.blurb}`;
  }
  if (buildings.length === 1 && !units.length) {
    const building = buildings[0];
    const stat = BUILDING_STATS[building.kind];
    const queue = building.queue.map((item) => UNIT_STATS[item.kind].label).join(', ');
    const progress = building.buildLeft > 0 ? `<br>Raising… ${Math.ceil(building.buildLeft)}s` : '';
    return `<b>${stat.label}</b> · ${FACTIONS[building.owner].short}<br>${Math.ceil(building.hp)} / ${stat.hp}${queue ? `<br>Queue: ${queue}` : ''}${progress}`;
  }
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(UNIT_STATS[unit.kind].label, (counts.get(UNIT_STATS[unit.kind].label) ?? 0) + 1);
  for (const building of buildings) {
    const label = BUILDING_STATS[building.kind as BuildingKind].label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => `${n} ${name}`).join(' · ') || 'Selection empty';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
