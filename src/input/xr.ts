import * as THREE from 'three';

export interface XrPointer {
  id: number;
  ray: THREE.Ray;
  down: boolean;
  up: boolean;
  additive: boolean;
}

interface HandJoints {
  [name: string]: THREE.Object3D | undefined;
}

/**
 * Controller rays, grip / fist grabs, and pinch clicks.
 * Controller meshes are procedural boxes — no downloaded controller models.
 */
export class XrRig {
  readonly pointers: XrPointer[] = [];
  readonly panel: THREE.Mesh;
  grabbing = false;
  private readonly controllers: THREE.Group[] = [];
  private readonly grips: THREE.Group[] = [];
  private readonly hands: THREE.Group[] = [];
  private readonly rays: THREE.Line[] = [];
  private readonly prev = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly curr = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly wasGrab = [false, false];
  private readonly pinchWas = [false, false];
  private readonly selectWas = [false, false];
  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly table: THREE.Object3D,
    canvas: HTMLCanvasElement,
  ) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28, 0.28),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
    );
    this.panel.name = 'wrist-panel';
    this.panel.renderOrder = 10;
    this.panel.visible = false;
    scene.add(this.panel);
    const gripMat = new THREE.MeshStandardMaterial({ color: '#d9c7a4', roughness: 0.45, metalness: 0.35 });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: i === 0 ? 0xf0c27a : 0x9ad7ff }));
      line.scale.z = 2.2;
      line.name = 'aim';
      controller.add(line);
      scene.add(controller);
      const grip = renderer.xr.getControllerGrip(i);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.08), gripMat);
      box.position.z = -0.02;
      grip.add(box);
      scene.add(grip);
      const hand = renderer.xr.getHand(i);
      scene.add(hand);
      this.controllers.push(controller);
      this.grips.push(grip);
      this.hands.push(hand);
      this.rays.push(line);
      this.pointers.push({ id: i, ray: new THREE.Ray(), down: false, up: false, additive: false });
    }
  }

  get texture(): THREE.CanvasTexture {
    return (this.panel.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture;
  }

  update(): void {
    const presenting = this.renderer.xr.isPresenting;
    for (const line of this.rays) line.visible = presenting;
    for (const grip of this.grips) grip.visible = presenting;
    this.panel.visible = presenting;
    if (!presenting) {
      this.grabbing = false;
      return;
    }
    const session = this.renderer.xr.getSession();
    const grabs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const pointer = this.pointers[i];
      pointer.down = false;
      pointer.up = false;
      pointer.additive = false;
      const source = session?.inputSources[i];
      const hand = source?.hand;
      const pad = source?.gamepad ?? null;
      const useHand = !!hand && !pad;
      if (useHand) this.poseHand(i, pointer);
      else this.poseController(i, pointer, pad);
      const grip = (!useHand && !!pad?.buttons[1]?.pressed) || (useHand && this.fist(i));
      if (grip) grabs.push(i);
      if (pad?.buttons[4]?.pressed || pad?.buttons[5]?.pressed) pointer.additive = true;
    }
    this.applyGrab(grabs);
    this.placePanel();
    this.texture.needsUpdate = true;
  }

  private poseController(i: number, pointer: XrPointer, pad: Gamepad | null): void {
    const controller = this.controllers[i];
    controller.updateWorldMatrix(true, false);
    pointer.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    pointer.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    const pressed = !!pad?.buttons[0]?.pressed;
    pointer.down = pressed && !this.selectWas[i];
    pointer.up = !pressed && this.selectWas[i];
    this.selectWas[i] = pressed;
    this.curr[i].copy(pointer.ray.origin);
  }

  private poseHand(i: number, pointer: XrPointer): void {
    const joints = (this.hands[i] as THREE.Group & { joints?: HandJoints }).joints;
    const tip = joints?.['index-finger-tip'];
    const mid = joints?.['index-finger-phalanx-proximal'] ?? joints?.['index-finger-phalanx-intermediate'];
    if (!tip?.visible || !mid?.visible) return;
    tip.getWorldPosition(pointer.ray.origin);
    mid.getWorldPosition(this.tmp);
    pointer.ray.direction.copy(pointer.ray.origin).sub(this.tmp).normalize();
    const thumb = joints?.['thumb-tip'];
    let pinch = false;
    if (thumb?.visible) {
      thumb.getWorldPosition(this.tmpB);
      pinch = this.tmpB.distanceTo(pointer.ray.origin) < 0.02;
    }
    pointer.down = pinch && !this.pinchWas[i];
    pointer.up = !pinch && this.pinchWas[i];
    this.pinchWas[i] = pinch;
    const wrist = joints?.['wrist'];
    if (wrist?.visible) wrist.getWorldPosition(this.curr[i]);
    else this.curr[i].copy(pointer.ray.origin);
  }

  private fist(i: number): boolean {
    const joints = (this.hands[i] as THREE.Group & { joints?: HandJoints }).joints;
    const wrist = joints?.['wrist'];
    if (!wrist?.visible) return false;
    wrist.getWorldPosition(this.tmp);
    let total = 0;
    let n = 0;
    for (const name of ['middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip']) {
      const tip = joints?.[name];
      if (!tip?.visible) return false;
      tip.getWorldPosition(this.tmpB);
      total += this.tmp.distanceTo(this.tmpB);
      n++;
    }
    return n === 3 && total / 3 < 0.11;
  }

  private applyGrab(ids: number[]): void {
    this.grabbing = ids.length > 0;
    if (ids.length === 1) {
      const i = ids[0];
      if (this.wasGrab[i]) this.table.position.add(this.curr[i].clone().sub(this.prev[i]));
    } else if (ids.length === 2) {
      const a = this.curr[ids[0]];
      const b = this.curr[ids[1]];
      const pa = this.prev[ids[0]];
      const pb = this.prev[ids[1]];
      if (this.wasGrab[ids[0]] && this.wasGrab[ids[1]]) {
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const prevMid = pa.clone().add(pb).multiplyScalar(0.5);
        this.table.position.add(mid.clone().sub(prevMid));
        const ang = Math.atan2(b.z - a.z, b.x - a.x);
        const prevAng = Math.atan2(pb.z - pa.z, pb.x - pa.x);
        let delta = ang - prevAng;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        this.rotateAround(mid, delta);
        const dist = a.distanceTo(b);
        const prevDist = pa.distanceTo(pb);
        if (prevDist > 0.08) {
          const ratio = THREE.MathUtils.clamp(dist / prevDist, 0.8, 1.2);
          const next = THREE.MathUtils.clamp(this.table.scale.x * ratio, 0.012, 0.09);
          this.scaleAround(mid, next / this.table.scale.x);
        }
      }
    }
    for (let i = 0; i < 2; i++) {
      this.wasGrab[i] = ids.includes(i);
      this.prev[i].copy(this.curr[i]);
    }
  }

  private rotateAround(point: THREE.Vector3, yaw: number): void {
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const offset = this.table.position.clone().sub(point).applyQuaternion(this.q);
    this.table.position.copy(point).add(offset);
    this.table.quaternion.premultiply(this.q);
  }

  private scaleAround(point: THREE.Vector3, scalar: number): void {
    const offset = this.table.position.clone().sub(point).multiplyScalar(scalar);
    this.table.position.copy(point).add(offset);
    this.table.scale.multiplyScalar(scalar);
  }

  private placePanel(): void {
    const session = this.renderer.xr.getSession();
    let left = 0;
    session?.inputSources.forEach((source, index) => {
      if (source.handedness === 'left') left = index;
    });
    const anchor = this.controllers[left];
    if (anchor.parent && this.panel.parent !== anchor) anchor.add(this.panel);
    this.panel.position.set(0.02, -0.02, 0.05);
    this.panel.rotation.set(-1.15, 0.5, 0.35);
    anchor.updateWorldMatrix(true, true);
  }
}
