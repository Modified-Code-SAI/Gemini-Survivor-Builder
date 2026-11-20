# Overgrown Frontier — Project Rules (`AGENTS.md`)

A gritty, realistic 3D over-the-shoulder open-world survival browser game blending dense pine wilderness with overgrown post-apocalyptic city ruins (Three.js + TypeScript + Vite).

## Build Commands

- **Install dependencies:** `npm install`
- **Dev server:** `npm run dev`
- **Production build:** `npm run build`
- **Type check:** `npm run typecheck` (`tsc --noEmit`)
- **Lint:** `npm run lint` (`eslint src`)
- **Unit tests:** `npm test` (`vitest run`)
- **Full verification suite:** `npm run verify` (`npm run typecheck && npm run lint && npm test && npm run build`)

## Conventions

- **Stack:** Vite + TypeScript (strict mode) + Three.js + Vitest + ESLint.
- **Directory Structure:**
  - `src/engine/` — Renderer, lighting, post-processing, camera, game loop (fixed-timestep physics + interpolated render).
  - `src/world/` — Terrain, procedural/modular environment (forest, cracked highway, overgrown ruins, foliage, sky/fog, weather).
  - `src/player/` — Over-the-shoulder controller, movement (walk/sprint/crouch), third-person avatar, input handling.
  - `src/systems/` — Survival meters, scavenging, stealth, audio, AI threats.
  - `public/assets/` — Custom `.glb`/`.gltf` Blender models, PBR textures, and audio (tracked with Git LFS).
- **Visual Standards:** PBR materials (`MeshStandardMaterial` / `MeshPhysicalMaterial`), ACES Filmic tone mapping, soft shadow maps, atmospheric fog, golden-hour lighting, and clean HiDPI canvas scaling.
- **Mandatory Single-Edit Verification Rule:** After every single file edit, immediately run the project's full verification suite (`npm run verify`) and report `PASS` or `FAIL` before touching any other file or proceeding to the next step. Never batch unverified edits.

## Do-Not Rules

- **Do NOT** use untyped `any` or suppress TypeScript errors with `@ts-ignore` / `@ts-expect-error`.
- **Do NOT** allocate `THREE.Vector3`, `THREE.Quaternion`, or `THREE.Matrix4` objects inside per-frame `update()` loops (reuse pre-allocated scratch vectors).
- **Do NOT** ship flat/unlit primitive placeholder visuals when realistic PBR materials, procedural textures, and lighting are required.
- **Do NOT** commit `node_modules/`, `dist/`, or un-LFS'd large binary `.blend`/`.glb` assets without `.gitattributes` LFS rules.
- **Do NOT** batch multiple unverified code edits.

## Definition of Done

- `npm run verify` (`typecheck`, `lint`, `test`, `build`) passes with zero errors and zero warnings.
- Live visual verification in the built-in browser confirms smooth 3D rendering, responsive over-the-shoulder controls, and zero console/WebGL errors.
- Diff reviewed by the isolated read-only `reviewer` subagent against all Do-Not Rules.
