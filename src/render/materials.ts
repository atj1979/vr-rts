import * as THREE from 'three';

const compiled: { uniforms: { uTime: { value: number } } }[] = [];

/** Lit unit material. White vertices in `teamMask` take the per-instance team color. */
export function createUnitMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#9aa3ad'),
    roughness: 0.46,
    metalness: 0.4,
    emissive: new THREE.Color('#000000'),
    emissiveIntensity: 1,
  });
  material.customProgramCacheKey = () => 'glassreach-unit-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    compiled.push(shader as unknown as { uniforms: { uTime: { value: number } } });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float teamMask;
attribute float partId;
attribute vec3 aAnim;
attribute vec3 aTeam;
uniform float uTime;
varying float vTeamMask;
varying vec3 vTeamColor;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float st = aAnim.y;
float moving = step(0.5, st) * (1.0 - step(1.5, st));
float attacking = step(1.5, st) * (1.0 - step(2.5, st));
float working = step(2.5, st);
float swing = sin(uTime * 9.0 + aAnim.x);
transformed.y += sin(uTime * 8.0 + aAnim.x) * (0.04 * moving + 0.012);
float legL = step(0.5, partId) * (1.0 - step(1.5, partId));
float legR = step(1.5, partId) * (1.0 - step(2.5, partId));
transformed.z += (legL - legR) * swing * 0.16 * moving;
float nose = step(2.5, partId) * (1.0 - step(3.5, partId));
transformed.z += nose * attacking * abs(sin(uTime * 16.0 + aAnim.x)) * 0.14;
float arm = step(3.5, partId);
transformed.y += arm * working * sin(uTime * 7.0 + aAnim.x) * 0.07;
vTeamMask = teamMask;
vTeamColor = aTeam;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vTeamMask;
varying vec3 vTeamColor;`,
      )
      .replace('#include <color_fragment>', 'diffuseColor.rgb = mix(diffuseColor.rgb, vTeamColor, vTeamMask);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vTeamColor * vTeamMask * 0.32;`,
      );
  };
  return material;
}

export function setUnitTime(time: number): void {
  for (const shader of compiled) shader.uniforms.uTime.value = time;
}

export function hullMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'hull',
    color: new THREE.Color('#8e98a3'),
    roughness: 0.52,
    metalness: 0.62,
  });
}

export function teamMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'team_color',
    color: color.clone(),
    roughness: 0.4,
    metalness: 0.35,
    emissive: color.clone(),
    emissiveIntensity: 0.22,
  });
}

export function paintTeam(root: THREE.Object3D, color: THREE.Color, ghost: boolean): void {
  const tint = color.clone();
  if (ghost) tint.lerp(new THREE.Color('#6d7690'), 0.72);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      if (std.name !== 'team_color' || !std.color) continue;
      std.color.copy(tint);
      if (std.emissive) {
        std.emissive.copy(tint);
        std.emissiveIntensity = ghost ? 0.05 : 0.22;
      }
    }
  });
}
