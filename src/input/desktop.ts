import * as THREE from 'three';

export class DesktopControls {
  yaw = 0.72;
  pitch = 0.96;
  dist = 1.7;
  readonly target = new THREE.Vector3(0, 0.95, -0.45);
  readonly pointer = new THREE.Vector2(0, 0);
  private readonly keys = new Set<string>();
  private dragging = false;
  private dragButton = -1;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;
  additive = false;
  box: { x: number; y: number; w: number; h: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('pointerdown', (ev) => this.onDown(ev));
    window.addEventListener('pointermove', (ev) => this.onMove(ev));
    window.addEventListener('pointerup', (ev) => this.onUp(ev));
    window.addEventListener('keydown', (ev) => {
      this.keys.add(ev.code);
      this.additive = ev.shiftKey;
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(ev.code)) ev.preventDefault();
    });
    window.addEventListener('keyup', (ev) => {
      this.keys.delete(ev.code);
      this.additive = ev.shiftKey;
    });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(ev.deltaY * 0.001), 0.7, 4.4);
    }, { passive: false });
  }

  onPrimaryUp: (additive: boolean, dragged: boolean, rect: { x: number; y: number; w: number; h: number } | null) => void = () => {};
  onSecondary: () => void = () => {};
  onKey: (ev: KeyboardEvent) => void = () => {};

  bindKeys(): void {
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) {
        if (!(ev.code.startsWith('Digit') && ev.ctrlKey)) return;
      }
      this.onKey(ev);
    });
  }

  update(dt: number): void {
    const speed = this.dist * 0.85;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.keys.has('ArrowUp')) this.target.addScaledVector(forward, speed * dt);
    if (this.keys.has('ArrowDown')) this.target.addScaledVector(forward, -speed * dt);
    if (this.keys.has('ArrowRight')) this.target.addScaledVector(right, speed * dt);
    if (this.keys.has('ArrowLeft')) this.target.addScaledVector(right, -speed * dt);
    if (this.keys.has('KeyQ')) this.yaw += dt * 0.8;
    if (this.keys.has('KeyE')) this.yaw -= dt * 0.8;
    const cos = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + cos * Math.sin(this.yaw) * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + cos * Math.cos(this.yaw) * this.dist,
    );
    this.camera.lookAt(this.target);
  }

  ray(target: THREE.Ray): THREE.Ray {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    target.copy(this.raycaster.ray);
    return target;
  }

  private onDown(ev: PointerEvent): void {
    this.dragging = true;
    this.dragButton = ev.button;
    this.startX = ev.clientX;
    this.startY = ev.clientY;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    this.moved = false;
    this.track(ev);
  }

  private onMove(ev: PointerEvent): void {
    this.track(ev);
    if (!this.dragging) return;
    const dx = ev.clientX - this.lastX;
    const dy = ev.clientY - this.lastY;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    if (Math.hypot(ev.clientX - this.startX, ev.clientY - this.startY) > 5) this.moved = true;
    if (this.dragButton === 0 && this.moved) {
      this.box = {
        x: Math.min(this.startX, ev.clientX),
        y: Math.min(this.startY, ev.clientY),
        w: Math.abs(ev.clientX - this.startX),
        h: Math.abs(ev.clientY - this.startY),
      };
    }
    if (this.dragButton === 1 || (this.dragButton === 0 && ev.shiftKey && ev.altKey)) {
      this.yaw -= dx * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, 0.35, 1.25);
    } else if (this.dragButton === 2 && ev.buttons === 2 && ev.shiftKey) {
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.target.addScaledVector(right, -dx * 0.002 * this.dist);
      this.target.addScaledVector(forward, dy * 0.002 * this.dist);
    }
  }

  private onUp(ev: PointerEvent): void {
    if (!this.dragging || ev.button !== this.dragButton) return;
    this.dragging = false;
    if (this.dragButton === 0) {
      const rect = this.moved
        ? {
            x: Math.min(this.startX, ev.clientX),
            y: Math.min(this.startY, ev.clientY),
            w: Math.abs(ev.clientX - this.startX),
            h: Math.abs(ev.clientY - this.startY),
          }
        : null;
      this.onPrimaryUp(ev.shiftKey, this.moved, rect);
    } else if (this.dragButton === 2 && !this.moved) {
      this.onSecondary();
    }
    this.box = null;
    this.dragButton = -1;
  }

  private track(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }
}
