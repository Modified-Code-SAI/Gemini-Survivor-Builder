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
| `feat/modular-building` *(active)* | `a46413c` + project memory docs | **Phase 1 — Full Survival Builder Expansion** complete, `39/39` Vitest tests passing, isolated `reviewer` APPROVED, live browser playtest verified with `0` console/network errors. |

## What Is Shipped on `feat/modular-building` (Phase 1)

1. **Physical Tool Harvesting (`src/systems/harvest.ts`):**
   - Switchable visible 3D right-hand **Felling Axe** (`[4]`), **Survival Pickaxe** (`[5]`), and **Bare Fists** (`[6]` / `[Q]` cycle) mounted to `hand_R` on `survivor.glb` (and procedural fallback `axePivot`).
   - **14 photorealistic alpha-cutout Douglas Fir timber pines** (`createDouglasFirCanopyGeometry` + weathered ochre surveyor band; 3 Axe chops -> `10 Wood`, wood-chip burst pool, `YXZ` topple fall away from player leaving a cut stump & `r = 0.34` stump collider).
   - **10 mossy Pacific Northwest granite outcrops** (3 Pickaxe strikes -> `9 Stone + 1 Scrap`, stone-shard burst pool, shrink-on-hit, collider removed on shatter).
   - Guaranteed `>= 2.6 m` spatial clearance from all `HERO_TREE_COORDS`, procedural forest pines (`2.8 m` exclusion in `environment.ts`), highway, landmarks, vehicles, boulders, and caches.

2. **Snap-Together Modular Base Building (`src/systems/building.ts`):**
   - `[Tab]` toggles **Build Mode** with translucent `#build-bar`, live green/red ghost preview (`excludeFromGtao = true`), `[1–7]` / scroll wheel selection, `[R]` 45° rotate, `[Click / F / Enter]` place, and `[X]` 50% rounded-up dismantle refund (`t in [2.2, 9.0]`).
   - **7 Modular Pieces** (max 64):
     - `Foundation` (`4W 1St`) — edge-to-edge `3.0 m` snapping, `2.6 m` sloped hillside piers, elevated floor support (`getSupportHeight`) shared across player, Raiders, and Hollow Stalker.
     - `Wall` (`3W`) & `Doorway` (`3W 1Sc`) — single-story solid foundation-edge snapping; Doorway features animated hinged door leaf toggled via `[E]` that dynamically removes/restores its center OBB collider.
     - `Roof` (`3W`) — snaps onto foundation bays or freestanding wall tops; `isInsideBuiltShelter()` shields from rainstorms, restores warmth, and muffles rain audio.
     - `Defensive Spikes` (`2W 1Sc`) — damages (`18 HP`), staggers (`0.38 s`), and pushes back Raiders and Hollow Stalkers on contact, dropping loot if lethal.
     - `Storage Crate` (`3W 1Sc`) — zero-modal smart deposit/withdraw via `[E]`.
     - `Workbench` (`4W 2St 2Sc`) — `[E]` crafts active recipe (`[Z]` switches: `Field Ration`, `Medkit`, `Hand Warmer`, `Glass Bottle`).

3. **Persistent Save/Load (`src/systems/persistence.ts`):**
   - Versioned `localStorage` schema (`overgrown_frontier_save_v1`) persisting player position/yaw (clamped to `WORLD_BOUNDS`), time of day, survival vitals & inventory, built pieces & door states, storage stash, campfires & lean-to shelters, looted caches, and depleted harvest nodes.
   - Auto-saves on major state mutations, every `20 s`, and on `beforeunload`; `[F5]` manual Quick Save; start overlay shows **Continue Saved World** + **Reset World** whenever a save exists.

4. **Chrome Pointer-Lock Hardening (`src/player/controller.ts`):**
   - `wasPointerLocked` guard prevents Chrome pointer-lock cooldown or focus bounce from re-opening the pause menu.
   - Smooth mouse-drag look fallback when unlocked (`buttons & 1 || buttons & 2`), plus short-click (`< 5 px`) unlocked canvas placement in Build Mode alongside `[F]` and `[Enter]`.

## Current Verification Baseline

- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 errors)
- `npm run lint` (`eslint src`): **PASS** (0 errors, 0 warnings)
- `npm test` (`vitest run`): **PASS** (8 test files, `39/39` tests)
- `npm run build` (`vite build`): **PASS** (42 modules bundled cleanly)

## Current Next Step

- **Awaiting user's hands-on playtest feedback** on Phase 1 (`feat/modular-building` at `http://localhost:5173/`).
- Next decision options once tested:
  1. Apply any playtest tuning/tweaks on `feat/modular-building`.
  2. Merge `feat/modular-building` -> `main` and publish updated build to `gh-pages` (using `.agents/skills/deploy-gh-pages/SKILL.md`, only on explicit user approval).
  3. Begin **Phase 2** (structural wall/door health & repair hammer, active Night & Storm Base Sieges, Workbench weapon/gear progression, multi-story stairs) — see `docs/ROADMAP.md`.
