# Overgrown Frontier — Living Project Status

> **Cross-Chat Memory Anchor:** Read this file first at the start of any new conversation, and update it whenever completing features, bugfixes, merges, or deployments.

## Quick Links & Environments

- **GitHub Repository:** `https://github.com/Modified-Code-SAI/Gemini-Survivor-Builder`
- **Live Playable Tester URL (GitHub Pages):** `https://modified-code-sai.github.io/Gemini-Survivor-Builder/`
  - Served from orphan branch `gh-pages` (`db4559b` — Phase 1 + Option A Asset Pass). **Keep untouched for external playtesters until explicit user sign-off.**
- **Local Dev Server:** `http://localhost:5173/` (`npm run dev -- --port 5173`)
- **Full Quality Gate:** `npm run verify` (`npm run typecheck && npm run lint && npm test && npm run build`)

## Active Branches & Commits

| Branch | Commit / Tag | Scope & Health |
| --- | --- | --- |
| `main` | `c83eec1` | Phase 1 + Playtest Polish & Option A Asset Pass merged cleanly (`41/41` tests at merge). |
| `gh-pages` | `db4559b` | Live tester build at `https://modified-code-sai.github.io/Gemini-Survivor-Builder/` (Phase 1 + Option A, all 9 direct non-LFS `.glb` assets verified `200 OK`). **Keep untouched until explicit user sign-off.** |
| `feat/phase2-base-sieges` *(active)* | `c83eec1` + Full Phase 2 *(uncommitted)* | **Full Phase 2 — Base Sieges, Structural Durability, Multi-Story & Gear Progression** complete, `10` test files / `51/51` Vitest tests passing, both `Overgrown Frontier` and `C:\GameDev` isolated `reviewer`s APPROVED, live browser playtest verified at `http://localhost:5173/` (`12` GLBs + `10` textures `200 OK`, `0` JS/WebGL errors). |

## What Is Shipped on `feat/phase2-base-sieges` (Phase 2)

1. **Multi-Story Building, Height-Banded Collision & Vertical Isolation (`src/world/terrain.ts`, `src/systems/building.ts`, `src/systems/stealth.ts`, `src/systems/threats.ts`):**
   - Expanded `[Tab]` Build Mode to **10 modular pieces** (`#build-slot-0..9`, `[1–9, 0]` / scroll wheel, cap raised to `96`): `Foundation`, `Wall`, `Window Wall` (arrow-passable shooting embrasure), `Doorway`, `Roof`, `Timber Stairs` (smooth continuous climb ramp), `Upper Floor Deck` (shelters 1st floor beneath it & supports 2nd-story walls/roofs), `Defensive Spikes`, `Storage Crate`, and `Workbench`.
   - Added height-banded `minY`/`maxY` bounds on `ObstacleCircle`/`ObstacleBox`/`ObstacleObb` in `resolveHorizontalCollision(..., actorY)` and height-aware `hasLineOfSight(..., eyeY)` so 2nd-story walls/closed doors never block 1st-story open doorways or ground AI sightlines.
   - Enforced full multi-story vertical isolation across `getFloorHeightAt(..., currentY)`, `isInsideBuiltShelter(..., actorY)`, `getInteractTarget(..., playerY)`, `checkSpikeHit(..., actorY)`, `findNearestAttackableStructure(..., actorY)`, `threats.update` melee reach (`<= 1.75 m`), and `tryPlayerMeleeHit(..., playerY)`.

2. **Structural Durability, Visual Wear & Repair Hammer (`src/systems/building.ts`, `src/player/controller.ts`, `repair_hammer.glb`):**
   - Assigned per-piece durability (`BUILD_MAX_HP`: Foundation `240`, Wall/Upper Floor `180`, Window Wall `150`, Doorway/Stairs `160`, Roof `140`, Spikes `100` with `14` wear per hit, Workbench `130`, Storage `120`) with live worn timber visual darkening, damage tilt/lean, hit shake, splinter/repair burst pool, collapse obstacle cleanup, and persistent damaged HP (`Math.max(1, Math.round(p.hp))`).
   - Authored AAA PBR `repair_hammer.glb` (`390 KB`, `[8]`) with priority damaged-structure repair swings (`1 Wood` -> `+45 HP`), `playRepairHammer()` SFX, and contextual damaged-structure HP/repair HUD prompts.

3. **Night & Storm Base Sieges & Structure-Bashing AI (`src/systems/threats.ts`, `src/systems/audio.ts`, `index.html`, `src/main.ts`):**
   - Added 4th hostile (`ridge_skirmisher`) and Night/Storm Siege Director (auto-triggers after `16 s` of deep night/storm near any built base or campfire anchor, plus `[N]` manual rally trigger) rallying escalating 3–4 hostile waves with pulsing top-center `#hud-siege` banner, war/repel horn SFX (`playSiegeHorn`), and wave-repel loot rewards (`3 Scrap, 3 Wood, 4 Arrows`).
   - Upgraded Raiders & Hollow Stalker to bash blocking ground-level built structures (`playStructureBash`, structure-breached toast & persistence) whenever chasing/sieging behind fortifications or below a 2nd-story watchtower defender.

4. **Workbench Weapons & Gear Progression (`src/systems/survival.ts`, `src/systems/harvest.ts`, `src/systems/flashlight.ts`, `src/player/controller.ts`, `compound_bow.glb`, `arrow.glb`, `survivor.glb`):**
   - Expanded Workbench crafting (`[Z]` cycles, auto-skipping owned one-time unlocks) to **10 recipes**: consumables (`Field Ration`, `Medkit`, `Hand Warmer`, `Glass Bottle`, `4x Broadhead Arrows`) + 5 persistent gear unlocks (`Repair Hammer`, `Compound Bow`, `Reinforced Steel Tools`, `Upgraded Flashlight`, `Improvised Scrap Armor`).
   - Authored AAA PBR `compound_bow.glb` (`475 KB`, `[7]`, mounted on `hand_L` with calibrated carry-to-aim quaternion slerp), `arrow.glb` (`120 KB`, 12-slot pooled substepped ballistic arrows flying through `window_wall` embrasures with headshot/unaware crits & subtle `3.5 m` stealth noise), and baked the 18th MoCap clip (`bow_shoot`) into `survivor.glb` (`4.07 MB`).
   - **Reinforced Steel Tools** upgrade Felling Axe & Pickaxe visuals (`Steel Axe`/`Steel Pick`), speed up harvesting to 2 hits (`hitPower = 2`), and boost tool melee damage to `52`; **Upgraded Flashlight** doubles battery endurance & widens beam reach; **Scrap Armor** reduces incoming combat damage by `38%` (`#hud-armor` badge).
   - Backward-compatible v1 save persistence (`overgrown_frontier_save_v1`) stores `builtPieces` (up to `96`, with optional `hp`), `inventory.arrows`, and `survival.gear`.

## Current Verification Baseline

- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 errors)
- `npm run lint` (`eslint src`): **PASS** (0 errors, 0 warnings)
- `npm test` (`vitest run`): **PASS** (`10` test files, `51/51` tests)
- `npm run build` (`vite build`): **PASS** (`42` modules bundled cleanly)

## Current Next Step

- **Ready for user's hands-on playtest** on Full Phase 2 (`feat/phase2-base-sieges` at `http://localhost:5173/`).
- Next decision options once playtested:
  1. Apply any requested Phase 2 combat/siege/building tuning, then commit on `feat/phase2-base-sieges`.
  2. Merge `feat/phase2-base-sieges` -> `main` and publish updated build to `gh-pages` (using `.agents/skills/deploy-gh-pages/SKILL.md`, only on explicit user approval).
  3. Begin **Phase 3 — Connected Biome II: Flooded Industrial Docks** (see `docs/ROADMAP.md`).
