# Overgrown Frontier — Project Rules (`AGENTS.md`)

A gritty, realistic 3D over-the-shoulder Pacific Northwest post-apocalyptic survival-builder browser game (**Three.js r174 + TypeScript + Vite 6 + WebGL2**).

---

## Cross-Chat Memory Protocol

1. **Start of every new chat:** Read [`docs/STATUS.md`](docs/STATUS.md) **first** to pick up active branches, latest verified state, and pending next steps.
2. **Before planning or editing code:** Consult [`docs/ROADMAP.md`](docs/ROADMAP.md) (4 locked design pillars & 4-phase plan), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (exact module, 3D asset, control & save map), and [`docs/DECISIONS_AND_LESSONS.md`](docs/DECISIONS_AND_LESSONS.md) (permanent technical invariants).
3. **End of every feature, milestone, bugfix, merge, or deploy:** Update `docs/STATUS.md` (and any impacted `docs/*.md` files) following `.agents/skills/update-project-memory/SKILL.md`.

---

## Branching & External Tester Protection

- **`main`** (`v0.1.0-vertical-slice`) and **`gh-pages`** (live tester build at `https://modified-code-sai.github.io/Gemini-Survivor-Builder/`) MUST stay stable for playtesters.
- **Never** merge into `main` or publish to `gh-pages` without explicit user approval. Build new features on dedicated feature branches (e.g., `feat/modular-building`).
- When explicitly asked to publish a live tester build, follow `.agents/skills/deploy-gh-pages/SKILL.md` (orphan `gh-pages` branch **without** `.gitattributes` so binary `.glb`/`.jpg` files upload directly rather than as Git LFS pointers).

---

## Build & Verification Commands

- **Install dependencies:** `npm install`
- **Local dev server:** `npm run dev -- --port 5173`
- **Type check:** `npm run typecheck` (`tsc --noEmit`)
- **Lint:** `npm run lint` (`eslint src`)
- **Unit tests:** `npm test` (`vitest run`)
- **Production build:** `npm run build` (`vite build`, `base: './'`)
- **Full verification suite:** `npm run verify` (`npm run typecheck && npm run lint && npm test && npm run build`)

---

## Directory Structure

- `index.html` — Cinematic translucent start overlay, minimal TLOU-inspired survival HUD, `#build-bar`, `#workbench-bar`, game-over overlay.
- `src/main.ts` — Fixed-timestep (`1/60 s`) simulation loop, shared `worldObstacles`, elevated `getSupportHeight`, `localStorage` persistence wiring, dirty-checked HUD sync, full disposal.
- `src/engine/` — WebGL2 PBR renderer, ACES Filmic, PCF shadows, `GTAOPass`, `UnrealBloomPass`, HDR sky & volumetric sun shafts (`renderer.ts`).
- `src/world/` — Deterministic terrain/road/OBB collision (`terrain.ts`), 5-species PNW forest/ruins/wrecks/reflective puddles (`environment.ts`), singleton `WorldTextureAtlas` (`textures.ts`), optional GLB loader (`assetLoader.ts`).
- `src/player/` — Over-the-shoulder controller, 34-bone MoCap mixer, chest flashlight, switchable Felling Axe/Pickaxe props, Chrome pointer-lock hardening (`controller.ts`).
- `src/systems/` — Survival vitals & crafting, harvesting, snap-together modular building, campfires & lean-tos, scavenging, stealth, Raider & Hollow Stalker AI, dynamic 24h sky/storms, volumetric flashlight, wildlife, `localStorage` persistence, procedural Web Audio, plus unit test suites (`*.test.ts`).
- `public/assets/` & `public/textures/` — Custom Blender/MoCap `.glb` assets and photographic `.jpg` PBR maps (tracked with Git LFS on `main` & feature branches).
- `docs/` — Persistent cross-chat memory (`STATUS.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `DECISIONS_AND_LESSONS.md`, `github-pages-deploy.yml`).
- `.agents/skills/` — Project-scoped Antigravity workflows (`deploy-gh-pages`, `update-project-memory`).
- `skills/` — Verification workflow (`skills/verify-build/SKILL.md`).
- `.gemini/` — Local agent governance config (`settings.json`, `agents/builder.md`, `agents/reviewer.md`).

---

## Mandatory Workflow & Subagent Governance

- **Rule 1 — Automatic Repo Bootstrapping:** Before writing or editing any code, verify `./AGENTS.md`, `./skills/`, and `./.gemini/agents/` exist in the repo root; if any are missing, immediately invoke `bootstrap-project`, output the file-by-file plan and acceptance checks, and stop for approval.
- **Rule 2 — Single-Edit Verification Rule (Zero Batching):** After **every single file creation or edit**, immediately run `npm run verify` and report `PASS` or `FAIL` before touching any other file or proceeding to the next step. Never batch unverified edits.
- **Rule 3 — Subagent Routing:** Route code implementation through `builder` and audit every completed diff through the isolated, read-only `reviewer` against all Do-Not Rules and `npm run verify` output.
- **Visual Standards:** PBR materials (`MeshStandardMaterial` / `MeshPhysicalMaterial`), real photographic/botanical textures, ACES Filmic tone mapping, soft shadow maps, atmospheric fog, and HiDPI canvas scaling.

---

## Do-Not Rules

- **Do NOT** use `any` or suppress TypeScript diagnostics (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`).
- **Do NOT** allocate `THREE.Vector3`, `Quaternion`, `Matrix4`, `Color`, or transient objects inside per-frame `update()`, `updateCamera()`, `render()`, or `frame()` paths — reuse pre-allocated scratch structs.
- **Do NOT** leave transparent, additive, or `depthWrite: false` meshes exposed to `GTAOPass` — always set `userData['excludeFromGtao'] = true`.
- **Do NOT** call GLSL `pow(x, y)` without guarding the base (`max(0.0, x)` or `clamp(...)`) — negative bases produce `NaN` black bloom tiles under ANGLE/WebGL2.
- **Do NOT** double-dispose shared `WorldTextureAtlas` textures from feature systems; dispose only geometries/materials owned by that system.
- **Do NOT** replace MoCap character clips with procedural sine-wave animations, or ship flat unlit primitives where realistic PBR/botanical assets belong.
- **Do NOT** commit `.gitattributes` to `gh-pages`, commit `node_modules/` or `dist/` to `main`/feature branches, push `.github/workflows/*` with the workflow-less GCM token, or leave dev servers / background tasks running.
- **Do NOT** batch multiple unverified edits.

---

## Definition of Done

- `npm run verify` (`typecheck`, `lint`, `test`, `build`) passes with `0` errors and `0` warnings after every individual edit.
- Isolated read-only `reviewer` audits and approves the diff against all Do-Not Rules and technical invariants in `docs/DECISIONS_AND_LESSONS.md`.
- Live browser verification confirms crisp WebGL2 rendering, smooth controls, and `0` console/network/WebGL errors.
- `docs/STATUS.md` reflects the latest verified branch state and next steps.
