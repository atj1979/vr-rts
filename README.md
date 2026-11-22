# Glassreach

A tabletop VR real-time strategy skirmish. Two foundries — **Lumen** and **Umbra** — contest a glass mesa for **Shardglass** and **Fluxwell**. The battlefield is a diorama you can pick up, turn, and lean over.

Everything you see and hear is generated in the repo: three.js geometry, canvas textures, and WebAudio tones. No third-party models, textures, sounds, or font files.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173/vr-rts/` (the Vite `base` is `/vr-rts/`, matching GitHub Pages).

```bash
npm test
npm run build
npm run preview
```

`npm test` and `npm run build` both compile the AssemblyScript navigator before the simulation checks and the Vite bundle. The GitHub Actions runner does not need a separate toolchain install.

Production site, once Pages is pointed at Actions: <https://atj1979.github.io/vr-rts/>

## Desktop controls

| Input | Action |
| --- | --- |
| Left click | Select a unit or building. Click empty ground to clear. |
| Shift + click | Add or remove from the selection |
| Drag left | Box-select your units and buildings |
| Right click | Move, attack-move, gather, or assist a construction. Combat units attack-move. Couriers gather from a node. |
| B / N | Place an Armory or a Waystation. Left click confirms, right click or Esc cancels. |
| C / D / F | Train Courier, Dart, Rampart from a finished Foundry or Armory |
| S / H | Stop, or hold (no chase) |
| 1–3 / Ctrl+1–3 | Recall or save a control group |
| Arrow keys | Pan |
| Q / E | Orbit |
| Mouse wheel | Zoom |
| Middle drag | Turn the camera |
| Shift + right drag | Pan |
| Space | Look at your Foundry |
| V | Reset the table and camera |
| Minimap click | Move the camera |

The bottom dock has the same build and train orders.

## VR controls

Enter VR with the on-page button. The session asks for `local-floor` and optional hand-tracking. Tested target: Meta Quest browser and any WebXR browser. Desktop mouse and keyboard stay available for development.

| Input | Action |
| --- | --- |
| Point + trigger | Select, box-select if you drag, or command the current selection |
| Grip (either hand) | Grab the table. One hand slides and yaws it. Two hands also scale it. |
| Fist (hand tracking) | Same grab as grip. Close the middle, ring, and pinky toward the wrist. |
| Pinch (hand tracking) | Same as the trigger: thumb to index tip. |
| A / B or X / Y | Add to the selection |
| Wrist panel | Resources, crew, and the build / train / stop buttons. Point the other hand at it and pull the trigger. |

The table sits about waist height. Scale is clamped so the mesa stays a tabletop, not a room.

## What this slice plays

- 40×40 mesa, procedural height, cliffs that block movement, two starting Foundries
- Shardglass and Fluxwell nodes. Couriers haul loads back to a Foundry or Waystation
- Foundry trains Couriers. Armory trains Darts (long glass lance) and Ramparts (slow bulwark)
- Placement checks slope, occupancy, explored fog, and cost. Buildings finish on their own; Couriers sent to the site speed them up
- Crew cap from finished buildings
- Fog of war: unexplored, explored, visible. Enemy units hide outside vision. Buildings you have seen leave a ghost until you look again
- Grid A* plus a Dijkstra flow field when several units share a goal, then separation and slide-along-walls movement
- Umbra gathers, raises an Armory, pushes a Waystation toward the middle, and attack-moves once it has a squad
- Destroy the enemy Foundry to win. Lose yours and the mesa is gone

## What runs in Wasm

The hot numeric kernel is an AssemblyScript module (`src/wasm/assembly/nav.ts`), compiled by `asc` to `src/wasm/pkg/nav.wasm` during `npm run build` / `npm test`. `src/wasm/native.ts` is the typed wrapper.

In Wasm:

- Grid A* pathfinding
- Dijkstra flow fields and traces
- Fog decay and sight-circle stamps
- Pairwise separation
- Movement integration (waypoint steering, separation, blocked-cell slide)

Orders, combat, training, building placement, and the AI stay in TypeScript. If the module fails to compile or instantiate, the same functions in `src/sim/kernels.ts` run instead and the match still starts. The HUD corner reads `navigator · wasm` or `navigator · js`.

## Deploy

`.github/workflows/pages.yml` builds on pull requests and, on `main`, uploads `dist/` with `actions/upload-pages-artifact` and deploys it with `actions/deploy-pages`.

One manual step on the repository:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Push to `main` (or run the workflow). The first deploy may ask a maintainer to approve the `github-pages` environment.

The Vite base is `/vr-rts/`. Do not change it unless the Pages URL changes.

## Asset swap

See [docs/ASSETS.md](docs/ASSETS.md). Drop a `.glb` at the manifest path and the loader uses it. Until then every id is a procedural mesh with the same attachments.
