# Overgrown Frontier — Living Project Status

> **Cross-Chat Memory Anchor:** Read this file first at the start of any new conversation, and update it whenever completing features, bugfixes, merges, or deployments.

## Quick Links & Environments

- **GitHub Repository:** `https://github.com/Modified-Code-SAI/Gemini-Survivor-Builder`
- **Live Playable Tester URL (GitHub Pages):** `https://modified-code-sai.github.io/Gemini-Survivor-Builder/`
  - Served from orphan branch `gh-pages` (`7ef2d4c` — v0.1.0 vertical slice). **Keep untouched for external playtesters until explicit user sign-off.**
- **Local Dev Server:** `http://localhost:5173/` (`npm run dev -- --port 5173`)
- **Full Quality Gate:** `npm run verify` (`npm run typecheck && npm run lint && npm test && npm run build`)

## Active Branches & Commits

| Branch | Commit / Tag | Scope & Health |
| --- | --- | --- |
| `main` | `985b73d` (`v0.1.0-vertical-slice`) | Stable Milestones 1–4 vertical slice, 15 Git LFS binary assets (`33 MB`), `30/30` Vitest tests passing. |
| `gh-pages` | `7ef2d4c` | Orphan branch serving compiled `dist/` + `.nojekyll` with direct non-LFS binary assets on GitHub Pages. |
| `feat/modular-building` *(active)* | `ac9cf8e` + Playtest Polish & Option A Asset Pass *(uncommitted)* | **Phase 1 — Full Survival Builder Expansion + Playtest Polish & Option A Asset Pass** complete, `41/41` Vitest tests passing across `9` files, both `Overgrown Frontier` and `C:\GameDev` isolated `reviewer`s APPROVED, live browser verification PASS at `http://localhost:5173/` with all `9` GLBs + `10` textures loading `200 OK` and `0` JS/WebGL errors. |

## What Is Shipped on `feat/modular-building` (Phase 1)

1. **Physical Tool Harvesting & Natural Forest (`src/world/environment.ts`, `src/systems/harvest.ts`):**
   - Removed the 14 artificial tan-banded trees (`blazeRingGeo`) completely; ALL playable valley forest trees across all 5 species (Douglas Fir, Sitka Spruce, Broad Pine, Red Alder, Dead Snag inside `|x| <= 54, z in [-88, 34]`) are now choppable directly out of their GPU `InstancedMesh` batches (per-hit recoil shake, 3 Axe chops -> `10 Wood`, 4-slot pre-allocated species-accurate `YXZ` falling-tree pool, instanced cut wood stumps with `r in [0.28, 0.42] < 0.55` LOS cap).
   - **10 mossy Pacific Northwest granite outcrops** (`HARVEST_ROCK_SPECS`; 3 Pickaxe strikes -> `9 Stone + 1 Scrap`, stone-shard burst pool, shrink-on-hit, collider removed on shatter), with `depletedHarvestIds` persistence cap raised to `320`.

2. **Upright Sculpted Tools & Tool-Specific MoCap Swings (`src/player/controller.ts`, `survivor.glb`, `felling_axe.glb`, `pickaxe.glb`):**
   - Authored AAA PBR `felling_axe.glb` (`625 KB`) and `pickaxe.glb` (`624 KB`) via Blender 5.2.4 LTS, switchable via `[4]` Felling Axe, `[5]` Pickaxe, and `[6]` / `[Q]` Bare Fists, and mounted upright on `hand_R` with calibrated forward-blade grip (`HAND_TOOL_GRIP_QUATERNION`).
   - Baked two new MoCap-grounded clips into `survivor.glb` (`17` clips total): horizontal-diagonal lumberjack `axe_swing` and overhead-downward `pickaxe_swing`, strictly gating bare-fist punches to `[6]`.

3. **Sculpted Animated Pacific Northwest Wildlife (`src/systems/wildlife.ts`, `whitetail_deer.glb`, `pacific_raven.glb`):**
   - Generated via SDXL + Hunyuan3D-2 and rigged/animated in Blender 5.2.4 LTS — `whitetail_deer.glb` (`824 KB`, 26 bones, `SkeletonUtils.clone`, clean buck/doe `Antlers` toggle, `idle_graze`/`alert`/`trot`/`gallop`) and `pacific_raven.glb` (`800 KB`, 14 bones, `glide`/`flap`).

4. **Snap-Together Modular Base Building (`src/systems/building.ts`):**
   - `[Tab]` toggles **Build Mode** with translucent `#build-bar`, live green/red ghost preview (`excludeFromGtao = true`), `[1–7]` / scroll wheel selection, `[R]` 45° rotate, `[Click / F / Enter]` place, and `[X]` 50% rounded-up dismantle refund (`t in [2.2, 9.0]`).
   - **7 Modular Pieces** (max 64):
     - `Foundation` (`4W 1St`) — edge-to-edge `3.0 m` snapping, `2.6 m` sloped hillside piers, elevated floor support (`getSupportHeight`) shared across player, Raiders, and Hollow Stalker.
     - `Wall` (`3W`) & `Doorway` (`3W 1Sc`) — single-story solid foundation-edge snapping; Doorway features animated hinged door leaf toggled via `[E]` that dynamically removes/restores its center OBB collider.
     - `Roof` (`3W`) — snaps onto foundation bays or freestanding wall tops; `isInsideBuiltShelter()` shields from rainstorms, restores warmth, and muffles rain audio.
     - `Defensive Spikes` (`2W 1Sc`) — damages (`18 HP`), staggers (`0.38 s`), and pushes back Raiders and Hollow Stalkers on contact, dropping loot if lethal.
     - `Storage Crate` (`3W 1Sc`) — zero-modal smart deposit/withdraw via `[E]`.
     - `Workbench` (`4W 2St 2Sc`) — `[E]` crafts active recipe (`[Z]` switches: `Field Ration`, `Medkit`, `Hand Warmer`, `Glass Bottle`).

5. **Persistent Save/Load (`src/systems/persistence.ts`):**
   - Versioned `localStorage` schema (`overgrown_frontier_save_v1`) persisting player position/yaw (clamped to `WORLD_BOUNDS`), time of day, survival vitals & inventory, built pieces & door states, storage stash, campfires & lean-to shelters, looted caches, and depleted harvest nodes (`depletedHarvestIds <= 320`).
   - Auto-saves on major state mutations, every `20 s`, and on `beforeunload`; `[F5]` manual Quick Save; start overlay shows **Continue Saved World** + **Reset World** whenever a save exists.

6. **Chrome Pointer-Lock Hardening (`src/player/controller.ts`):**
   - `wasPointerLocked` guard prevents Chrome pointer-lock cooldown or focus bounce from re-opening the pause menu.
   - Smooth mouse-drag look fallback when unlocked (`buttons & 1 || buttons & 2`), plus short-click (`< 5 px`) unlocked canvas placement in Build Mode alongside `[F]` and `[Enter]`.

## Current Verification Baseline

- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 errors)
- `npm run lint` (`eslint src`): **PASS** (0 errors, 0 warnings)
- `npm test` (`vitest run`): **PASS** (9 test files, `41/41` tests)
- `npm run build` (`vite build`): **PASS** (42 modules bundled cleanly)

## Current Next Step

- **Ready for user's follow-up hands-on playtest** on `feat/modular-building` at `http://localhost:5173/`.
- Next decision options once tested:
  1. Commit the Phase 1 Playtest Polish & Option A Asset Pass changes on `feat/modular-building` (and apply any further tuning requested).
  2. Merge `feat/modular-building` -> `main` and publish updated build to `gh-pages` (using `.agents/skills/deploy-gh-pages/SKILL.md`, only on explicit user approval).
  3. Begin **Phase 2** (structural wall/door health & repair hammer, active Night & Storm Base Sieges, Workbench weapon/gear progression, multi-story stairs) — see `docs/ROADMAP.md`.
