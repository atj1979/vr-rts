import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ATTACHMENTS, type AttachmentMap } from '../sim/defs.ts';
import { hullMaterial, teamMaterial } from '../render/materials.ts';

function tagged(geo: THREE.BufferGeometry, mask: number, part: number): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  geo.setAttribute('teamMask', new THREE.BufferAttribute(new Float32Array(count).fill(mask), 1));
  geo.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(count).fill(part), 1));
  return geo;
}

function xform(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
): THREE.BufferGeometry {
  const g = geo.clone();
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ)),
      new THREE.Vector3(sx, sy, sz),
    ),
  );
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geo = mergeGeometries(parts, false);
  if (!geo) throw new Error('Failed to merge placeholder geometry');
  geo.computeBoundingSphere();
  return geo;
}

function empty(parent: THREE.Object3D, name: string, at: [number, number, number]): void {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.set(at[0], at[1], at[2]);
  parent.add(node);
}

function attach(parent: THREE.Object3D, id: string): void {
  const map = ATTACHMENTS[id];
  empty(parent, 'muzzle', map.muzzle);
  empty(parent, 'carry', map.carry);
  empty(parent, 'selection_ring', map.selection_ring);
}

/** Low-poly unit mesh, origin on the ground, facing +Z. */
export function unitGeometry(id: string): THREE.BufferGeometry {
  if (id === 'dart') return dart();
  if (id === 'rampart') return rampart();
  return courier();
}

function courier(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const leg = new THREE.CylinderGeometry(0.035, 0.05, 0.38, 5);
  parts.push(tagged(xform(leg, 0.12, 0.19, 0.08, 1, 1, 1, 0.35, 0, 0.4), 0, 1));
  parts.push(tagged(xform(leg, -0.12, 0.19, 0.08, 1, 1, 1, 0.35, 0, -0.4), 0, 2));
  parts.push(tagged(xform(leg, 0, 0.18, -0.12, 1, 1, 1, -0.45, 0, 0), 0, 1));
  parts.push(tagged(xform(new THREE.SphereGeometry(0.16, 8, 6), 0, 0.52, 0), 1, 0));
  parts.push(tagged(xform(new THREE.SphereGeometry(0.09, 8, 6), 0, 0.74, 0.06), 1, 0));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.16, 0.12, 0.18), 0.2, 0.48, 0.02), 0, 4));
  parts.push(tagged(xform(new THREE.ConeGeometry(0.05, 0.16, 5), 0, 0.62, 0.22, 1, 1, 1, Math.PI / 2, 0, 0), 1, 3));
  return merge(parts);
}

function dart(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tagged(xform(new THREE.ConeGeometry(0.12, 0.85, 6), 0, 0.28, 0.1, 1, 1, 1, Math.PI / 2, 0, 0), 0, 0));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.34, 0.03, 0.22), 0, 0.3, -0.05), 1, 0));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.08, 0.14, 0.2), 0, 0.22, -0.22), 0, 1));
  parts.push(tagged(xform(new THREE.SphereGeometry(0.06, 6, 5), 0, 0.32, 0.48), 1, 3));
  return merge(parts);
}

function rampart(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tagged(xform(new THREE.BoxGeometry(0.62, 0.28, 0.48), 0, 0.28, 0), 0, 0));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.5, 0.36, 0.08), 0, 0.42, 0.28), 1, 0));
  parts.push(tagged(xform(new THREE.CylinderGeometry(0.1, 0.12, 0.16, 6), 0, 0.52, -0.02), 1, 3));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.1, 0.16, 0.12), -0.22, 0.1, 0.12), 0, 1));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.1, 0.16, 0.12), 0.22, 0.1, 0.12), 0, 2));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.1, 0.16, 0.12), -0.22, 0.1, -0.16), 0, 2));
  parts.push(tagged(xform(new THREE.BoxGeometry(0.1, 0.16, 0.12), 0.22, 0.1, -0.16), 0, 1));
  return merge(parts);
}

export function structureTemplate(id: string, team: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  if (id === 'foundry') foundry(group, team);
  else if (id === 'armory') armory(group, team);
  else if (id === 'waystation') waystation(group, team);
  else if (id === 'fluxwell') fluxwell(group);
  else shardglass(group);
  attach(group, id in ATTACHMENTS ? id : 'shardglass');
  return group;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, y = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

function foundry(group: THREE.Group, team: THREE.Color): void {
  const hull = hullMaterial();
  const color = teamMaterial(team);
  mesh(new THREE.CylinderGeometry(1.15, 1.35, 0.35, 8), hull, group, 0.18);
  mesh(new THREE.CylinderGeometry(0.42, 0.7, 1.7, 8), hull, group, 1.15);
  mesh(new THREE.TorusGeometry(0.62, 0.06, 6, 10), color, group, 1.55).rotation.x = Math.PI / 2;
  mesh(new THREE.OctahedronGeometry(0.18, 0), color, group, 2.15);
}

function armory(group: THREE.Group, team: THREE.Color): void {
  const hull = hullMaterial();
  const color = teamMaterial(team);
  mesh(new THREE.BoxGeometry(2.4, 0.7, 2.2), hull, group, 0.35);
  mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.2, 6, 1, false, 0, Math.PI), hull, group, 1.05).rotation.z = Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.28, 0.7, 0.28), color, group, 1.45).position.x = 0.7;
  mesh(new THREE.BoxGeometry(1.6, 0.12, 0.12), color, group, 0.78).position.z = 1.05;
}

function waystation(group: THREE.Group, team: THREE.Color): void {
  const hull = hullMaterial();
  const color = teamMaterial(team);
  mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.22, 8), hull, group, 0.11);
  mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.15, 6), hull, group, 0.75);
  mesh(new THREE.SphereGeometry(0.16, 8, 6), color, group, 1.4);
  mesh(new THREE.TorusGeometry(0.55, 0.035, 5, 10), color, group, 0.28).rotation.x = Math.PI / 2;
}

function shardglass(group: THREE.Group): void {
  const crystal = new THREE.MeshStandardMaterial({
    name: 'shardglass',
    color: new THREE.Color('#8ef6ee'),
    emissive: new THREE.Color('#1a8f8a'),
    emissiveIntensity: 0.45,
    roughness: 0.18,
    metalness: 0.08,
  });
  const spots: [number, number, number, number][] = [
    [0, 0.45, 0, 0.28],
    [0.28, 0.32, 0.12, 0.18],
    [-0.22, 0.28, -0.08, 0.16],
    [0.05, 0.55, -0.22, 0.14],
    [-0.08, 0.22, 0.26, 0.12],
  ];
  for (const [x, y, z, s] of spots) {
    const m = mesh(new THREE.OctahedronGeometry(s, 0), crystal, group, y);
    m.position.x = x;
    m.position.z = z;
    m.rotation.y = x * 2;
  }
}

function fluxwell(group: THREE.Group): void {
  const ring = new THREE.MeshStandardMaterial({
    name: 'fluxwell',
    color: new THREE.Color('#ff7ad9'),
    emissive: new THREE.Color('#8a2468'),
    emissiveIntensity: 0.55,
    roughness: 0.25,
    metalness: 0.2,
  });
  const core = mesh(new THREE.TorusGeometry(0.42, 0.07, 6, 12), ring, group, 0.16);
  core.rotation.x = Math.PI / 2;
  mesh(new THREE.SphereGeometry(0.14, 8, 6), ring, group, 0.55);
  mesh(new THREE.CylinderGeometry(0.03, 0.08, 0.7, 6), ring, group, 0.45);
}

export function attachmentMap(id: string): AttachmentMap {
  return ATTACHMENTS[id] ?? ATTACHMENTS.courier;
}
