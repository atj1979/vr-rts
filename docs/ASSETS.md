# Glassreach asset pipeline

Real models drop in later without code changes. Until a file exists, the game builds a procedural stand-in with the same id, footprint, and attachment names.

## Layout

```
public/assets/manifest.json
public/assets/<category>/<id>/<id>.glb
public/assets/<category>/<id>/<id>.json
public/assets/<category>/<id>/<id>_lod0.glb   (optional)
public/assets/<category>/<id>/<id>_lod1.glb   (optional)
```

`manifest.json` lists every id. Each entry has:

- `id`
- `category` — `units`, `buildings`, or `resources`
- `glb` — path relative to the site root (no leading slash)
- `sidecar` — path to `<id>.json`

Categories shipped in this slice: `courier`, `dart`, `rampart`, `foundry`, `armory`, `waystation`, `shardglass`, `fluxwell`.

## glTF contract

- glTF 2.0, `.glb`
- Y-up, meters, **1 grid cell = 1 meter** at full scale
- The model origin sits on the ground. The mesh faces **+Z**
- PBR metallic-roughness
- Team color is a material named exactly `team_color`. The game tints that material at runtime (amber for Lumen Foundry, violet for Umbra Compact). Other materials keep their authored color
- Animation clips, when present, use these lowercase names: `idle`, `walk`, `run`, `attack`, `death`, `build`, `gather`, `work`
- Empty nodes named `muzzle`, `carry`, and `selection_ring` mark projectile origin, the worker haul point, and the selection ring
- LOD: either extra files `<id>_lod0.glb` / `<id>_lod1.glb`, or nodes inside the main glb named `<id>_lod0` and `<id>_lod1`. Desktop prefers lod0. A WebXR session prefers lod1

The sidecar `<id>.json` repeats the gameplay facts the loader needs if it never opens the glb:

```json
{
  "id": "courier",
  "footprint": [1, 1],
  "boundingRadius": 0.34,
  "attachments": {
    "muzzle": [0, 0.62, 0.28],
    "carry": [0.24, 0.5, 0.02],
    "selection_ring": [0, 0.03, 0]
  },
  "lods": ["courier_lod0", "courier_lod1"],
  "animations": ["idle", "walk", "run", "attack", "death", "build", "gather", "work"]
}
```

`footprint` is width and depth in grid cells.

## How the registry chooses a mesh

`src/assets/registry.ts` fetches the manifest, then for each id:

1. Load the sidecar (or the built-in fallback if the fetch fails).
2. If `glb` is set, try `GLTFLoader`. A missing file rejects and is ignored.
3. A skinned glTF is cloned per unit (capped) and driven with `AnimationMixer`, including the lod node names above.
4. A static glTF is baked to one geometry. Vertices on a `team_color` material get a team mask so instancing can tint them.
5. Otherwise the procedural mesh from `src/assets/placeholders.ts` is used. It already has the team mask, part ids for the walk/attack shader, and the three attachment empties.

Instanced procedural units are the default. That keeps the draw count at one mesh per unit kind, which is the Quest budget this slice is aiming for.

Do not add downloaded models, textures, fonts, or audio. New art is either another procedural builder or a glb you author that follows this contract.
