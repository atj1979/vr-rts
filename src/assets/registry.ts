import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ATTACHMENTS, type AttachmentMap } from '../sim/defs.ts';
import { attachmentMap, structureTemplate, unitGeometry } from './placeholders.ts';

export interface Sidecar {
  id: string;
  footprint: [number, number];
  boundingRadius: number;
  attachments: AttachmentMap;
  lods: string[];
  animations: string[];
}

export interface ManifestEntry {
  id: string;
  category: string;
  glb: string;
  sidecar: string;
}

export interface GameAsset {
  id: string;
  source: 'gltf' | 'procedural';
  sidecar: Sidecar;
  /** Static mesh used for instancing. Null when the glTF is skinned. */
  geometry: THREE.BufferGeometry | null;
  skinnedTemplate: THREE.Object3D | null;
  clips: THREE.AnimationClip[];
  structure: (team: THREE.Color) => THREE.Group;
}

const loader = new GLTFLoader();

export async function loadRegistry(): Promise<Map<string, GameAsset>> {
  const base = import.meta.env.BASE_URL;
  const assets = new Map<string, GameAsset>();
  let entries: ManifestEntry[] = [];
  try {
    const res = await fetch(`${base}assets/manifest.json`);
    if (res.ok) {
      const manifest = (await res.json()) as { assets: ManifestEntry[] };
      entries = manifest.assets;
    }
  } catch (err) {
    console.warn('Asset manifest unavailable; using procedural ids only.', err);
  }
  if (!entries.length) {
    entries = Object.keys(ATTACHMENTS).map((id) => ({
      id,
      category: 'procedural',
      glb: '',
      sidecar: '',
    }));
  }
  await Promise.all(entries.map(async (entry) => assets.set(entry.id, await resolveEntry(base, entry))));
  return assets;
}

async function resolveEntry(base: string, entry: ManifestEntry): Promise<GameAsset> {
  const sidecar = await loadSidecar(base, entry);
  let source: GameAsset['source'] = 'procedural';
  let geometry: THREE.BufferGeometry | null = isStructure(entry.id) ? null : unitGeometry(entry.id);
  let skinnedTemplate: THREE.Object3D | null = null;
  let clips: THREE.AnimationClip[] = [];
  if (entry.glb) {
    try {
      const gltf = await loader.loadAsync(`${base}${entry.glb}`);
      clips = gltf.animations ?? [];
      let skinned = false;
      gltf.scene.traverse((obj) => {
        if ((obj as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      });
      if (skinned) {
        skinnedTemplate = gltf.scene;
        source = 'gltf';
        geometry = null;
      } else {
        const baked = bakeStatic(gltf.scene);
        if (baked) {
          geometry = baked;
          source = 'gltf';
        }
      }
      copyAttachments(gltf.scene, sidecar);
    } catch {
      source = 'procedural';
    }
  }
  return {
    id: entry.id,
    source,
    sidecar,
    geometry,
    skinnedTemplate,
    clips,
    structure: (team) => structureTemplate(entry.id, team),
  };
}

async function loadSidecar(base: string, entry: ManifestEntry): Promise<Sidecar> {
  const fallback = fallbackSidecar(entry.id);
  if (!entry.sidecar) return fallback;
  try {
    const res = await fetch(`${base}${entry.sidecar}`);
    if (!res.ok) return fallback;
    const data = (await res.json()) as Sidecar;
    return {
      ...fallback,
      ...data,
      attachments: { ...fallback.attachments, ...data.attachments },
    };
  } catch {
    return fallback;
  }
}

function fallbackSidecar(id: string): Sidecar {
  const attachments = attachmentMap(id);
  return {
    id,
    footprint: id === 'foundry' || id === 'armory' ? [3, 3] : id === 'waystation' || id === 'shardglass' || id === 'fluxwell' ? [2, 2] : [1, 1],
    boundingRadius: attachments === ATTACHMENTS.rampart ? 0.48 : 0.4,
    attachments,
    lods: [`${id}_lod0`, `${id}_lod1`],
    animations: ['idle', 'walk', 'run', 'attack', 'death', 'build', 'gather', 'work'],
  };
}

function isStructure(id: string): boolean {
  return id === 'foundry' || id === 'armory' || id === 'waystation' || id === 'shardglass' || id === 'fluxwell';
}

function bakeStatic(root: THREE.Object3D): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    const count = geo.getAttribute('position').count;
    const mask = new Float32Array(count);
    const part = new Float32Array(count);
    const matName = materialName(mesh.material);
    const team = matName === 'team_color' ? 1 : 0;
    mask.fill(team);
    geo.setAttribute('teamMask', new THREE.BufferAttribute(mask, 1));
    geo.setAttribute('partId', new THREE.BufferAttribute(part, 1));
    parts.push(geo);
  });
  if (!parts.length) return null;
  if (parts.length === 1) {
    parts[0].computeBoundingSphere();
    return parts[0];
  }
  const merged = mergeGeometries(parts, false);
  merged?.computeBoundingSphere();
  return merged;
}

function materialName(material: THREE.Material | THREE.Material[]): string {
  const mat = Array.isArray(material) ? material[0] : material;
  return mat?.name ?? '';
}

function copyAttachments(root: THREE.Object3D, sidecar: Sidecar): void {
  for (const name of ['muzzle', 'carry', 'selection_ring'] as const) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    sidecar.attachments[name] = [node.position.x, node.position.y, node.position.z];
  }
}
