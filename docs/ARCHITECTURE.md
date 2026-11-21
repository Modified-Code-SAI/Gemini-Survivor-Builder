# Overgrown Frontier — Codebase, Asset & Save Architecture

## Tech Stack

- **Renderer / 3D Engine:** Three.js `^0.174.0` (WebGL2, ACES Filmic tone mapping, `EffectComposer`, `GTAOPass`, `UnrealBloomPass`, custom HDR GLSL sky & volumetric sun shaders)
- **Language & Tooling:** TypeScript `^5.8.2` (strict mode, zero `any`, zero `@ts-*`), Vite `^6.2.1` (`base: './'`), Vitest `^3.0.8`, ESLint `^9.22.0`
- **Audio:** Zero-dependency procedural Web Audio synthesizer (`AudioContext`, filtered noise loops, stereo panning, one-shot SFX with strict `onended` node cleanup)

---

## Module Map (`src/` & `index.html`)

### Shell & Entry Point

| File | Responsibility |
| --- | --- |
| `index.html` | Translucent cinematic start overlay (`Continue Saved World`, `Reset World`, Graphics/Audio toggles), minimal TLOU-inspired survival HUD (vitals, `#hud-armor` & `#hud-siege` wave banner, supply/arrow & 5-tool belt with `.locked` states, 10-slot `#build-bar`, `#workbench-bar`, center interact/repair/toast prompts), game-over overlay, `no-cache` headers. |
| `src/main.ts` | Fixed-timestep (`1/60 s`, max 4 substeps) simulation loop, shared live `worldObstacles` array, multi-story `getSupportHeight(x, z, currentY?)`, startup `localStorage` hydration, Workbench 10-recipe progression + `syncGearSystems()`, Bow/Hammer/Siege wiring, auto-save (`20 s` + state mutations + `beforeunload`), dirty-checked DOM HUD updates (zero DOM thrash), and full GPU/Audio/listener disposal. |

### Engine (`src/engine/`)

| File | Responsibility |
| --- | --- |
| `src/engine/renderer.ts` | WebGL2 renderer setup, `high`/`medium` quality scaling, PCF soft shadow maps, procedural GLSL atmospheric sky dome (`dir.xz / (dir.y + 0.35)` zenith-safe starfield), dynamic sun/moon/hemisphere/bounce lighting, screen-space `VOLUMETRIC_SUN_SHADER` shafts, `GTAOPass` (respecting `userData['excludeFromGtao'] = true`), `UnrealBloomPass`, and crisp resize/dispose lifecycle. |

### World (`src/world/`)

| File | Responsibility |
| --- | --- |
| `src/world/terrain.ts` | Deterministic highway spline (`getRoadCenterX`, `getRoadFactor`, `getRoadBaseHeight`), valley relief heightfield (`getTerrainHeight`), `WORLD_BOUNDS`, `SPAWN_POINT`, height-banded `createObbObstacle(..., minY?, maxY?)`, and zero-allocation 2-pass `resolveHorizontalCollision(..., actorY?, actorHeight?)` (circles, AABBs, OBBs). |
| `src/world/terrain.test.ts` | 10 unit tests validating terrain determinism, road curve, bounds clamping, circle/box/OBB collision math, and height-banded multi-story vertical isolation. |
| `src/world/textures.ts` | Singleton `getWorldTextureAtlas()` loading 10 real photographic `.jpg` sources (`public/textures/`) into procedural PBR `CanvasTexture` triplets (`map`, `normalMap`, `roughnessMap`) plus alpha-cutout foliage textures (`pineBough`, `ivyCurtain`, `fernFrond`). Owned centrally — never double-disposed by systems. |
| `src/world/assetLoader.ts` | Optional `GLTFLoader` pipeline with `DEFAULT_GLB_SLOT_MANIFEST` slot mapping (`survivor`, `raider`, `hollow_stalker`, `overgrown_van`, `abandoned_sedan`, `felling_axe`, `pickaxe`, `whitetail_deer`, `pacific_raven`, `repair_hammer`, `compound_bow`, `arrow`) and `collectMaterialTextures` cleanup helper. |
| `src/world/environment.ts` | Reclaimed Highway 9 environment: cracked asphalt road, 7 rainwater puddles (2 foreground real-time `Reflector` planar mirrors + 5 distant Fresnel puddles) all synced to `AtmosphereSnapshot`, Left Bunker & Gas Station concrete ruins, 5 rusted vehicles (GLB-upgradable with swaying ivy curtains & GTAO-excluded fallback glass), utility poles (GTAO-excluded wire spans), 5-species Pacific Northwest forest with `ChoppableForestController` (`forest` — every playable tree inside `\|x\| <= 54, z in [-88, 34]` choppable directly out of GPU `InstancedMesh` batches with `hitPower` support, per-hit shake, 4-slot `YXZ` topple pool, and instanced cut stumps `r in [0.28, 0.42] < 0.55`), ferns, boulders, mist cards, and spatial ruin metal-creak anchors. |

### Player (`src/player/`)

| File | Responsibility |
| --- | --- |
| `src/player/controller.ts` | Over-the-shoulder camera with height-banded collision probing & hit trauma shake, 34-bone `survivor.glb` 18-clip MoCap mixer (speed-matched `walk`/`jog`/`run`/`crouch`, 3-phase jump, load-time upper/lower-body split-masked `axe_swing`, `pickaxe_swing`, `bow_shoot`, bare-fist punches, and bottle throws with strict tool-vs-fist routing), physical chest-strap angled tactical flashlight (`spine_03`), async-loaded `felling_axe.glb` / `pickaxe.glb` (with `setReinforcedTools` metallic steel sheen) / `repair_hammer.glb` on `hand_R`, async-loaded `compound_bow.glb` on `hand_L` with calibrated carry-to-aim quaternion slerp (`BOW_CARRY_QUATERNION` -> `BOW_AIM_QUATERNION`), multi-story `getSupportHeight(..., currentY?)`, 10-slot Build Mode & tool/siege keybinds, and Chrome pointer-lock hardening. |
| `src/player/controller.test.ts` | 3 unit tests validating `resolveAttackClipKind` routing (axe/pickaxe/hammer/bow/fists), `HAND_TOOL_GRIP_QUATERNION` / `HAND_TOOL_GRIP_OFFSET`, and unit-length `BOW_CARRY_QUATERNION` / `BOW_AIM_QUATERNION` smooth slerp arc (`30°–65°`). |

### Systems (`src/systems/`) — `51` Total Vitest Tests Across `10` Files

| File | Tests | Responsibility |
| --- | --- | --- |
| `survival.ts` | `survival.test.ts` (10) | HP, Stamina (exhaustion lock hysteresis), Hunger, Warmth, inventory (`rations`, `medkits`, `warmers`, `bottles`, `arrows`, `scrap`, `wood`, `stone`), 5 persistent `SurvivalGear` unlocks (`hasCompoundBow`, `hasRepairHammer`, `reinforcedTools`, `upgradedFlashlight`, `scrapArmor` `-38%` combat damage), 10 `WORKBENCH_RECIPES`, `isRecipeOwned`, `consumeArrow`, `reviveAtCamp`, `serialize`/`hydrate`. |
| `harvest.ts` | `harvest.test.ts` (3) | Delegates full-forest tree chopping to `FrontierEnvironment.forest` and manages 10 mossy granite outcrops (`HARVEST_ROCK_SPECS`), supporting `EquippedTool` (`axe`/`pickaxe`/`fists`/`bow`/`hammer`) and `reinforced` 2-hit accelerated harvesting (`hitPower = 2`), pooled chip/shard bursts, and combined `serializeDepletedIds`/`hydrateDepletedIds`. |
| `building.ts` | `building.test.ts` (6) | `[Tab]` 10-piece multi-story snap-together building (`Foundation`, `Wall`, `Window Wall`, `Doorway`, `Roof`, `Stairs`, `Upper Floor Deck`, `Spikes`, `Storage`, `Workbench`, max `96`), height-banded OBBs, `BUILD_MAX_HP` durability + worn timber visuals/lean/shake + 4-slot splinter/repair burst pool, `checkArrowStructureHit` (passing through `window_wall` embrasures & open doors), vertically isolated `getFloorHeightAt`, `isInsideBuiltShelter`, `getInteractTarget`, `checkSpikeHit` (with wear), `findNearestAttackableStructure`, `damageStructure`, `getRepairTarget`, `tryRepairStructure`, `[X]` 50% dismantle, `serialize`/`hydrate` (clamping positive damaged HP `>= 1`). |
| `camp.ts` | `camp.test.ts` (3) | Craftable stone-ring Campfires (GLSL flame & rising spark shaders, `r = 0.54` non-occluding collider, warmth/cooking/Stalker-repel radii, zero-alloc `getNearestCampfire` siege fallback anchor) and timber/canvas Lean-To Shelters (overhead cover + custom Camp Respawn), `serialize`/`hydrate`. |
| `scavenge.ts` | — | 8 handcrafted roadside loot caches with proximity glints, animated lid-open state, `serializeLootedIds`/`hydrateLootedIds`. |
| `stealth.ts` | `stealth.test.ts` (5) | Visibility & acoustic noise radius calculation (fern concealment, crouch, night, rain, flashlight penalty), `isInsideShelter`, and height-aware `hasLineOfSight(..., eyeY?)` (`MIN_OCCLUDING_CIRCLE_RADIUS = 0.55`). |
| `threats.ts` | `threats.test.ts` (3) | 4-actor hostile pool (3 patrolling/sieging MoCap Raiders incl. `ridge_skirmisher` + nocturnal **Hollow Stalker**), Night & Storm Base Siege Director (`triggerSiegeWave`, `getSiegeStatus`, wave-repel loot), structure-bashing AI, vertical melee isolation (`<= 1.75 m` in `update` & `tryPlayerMeleeHit`), 12-slot pooled substepped ballistic arrows (`shootArrow` + async `arrow.glb`, headshots/unaware crits), pooled throwable bottles, flashlight recoil, campfire retreat, and spike hits. |
| `atmosphere.ts` | `atmosphere.test.ts` (6) | 24-hour day/night clock (`dawn`, `morning`, `afternoon`, `golden_hour`, `dusk`, `night`), rolling storms (`clear`/`overcast`/`rain`/`storm`), lightning & thunder triggers, and monotonic phase-integrated GPU `RainField`. |
| `flashlight.ts` | — | Volumetric cone beam shader (`excludeFromGtao = true`), `SpotLight`, battery drain & auto-recharge, `setUpgraded(enabled)` (`2×` battery endurance, wider beam angle/reach & intensity), and `getBeamExposure` for Stalker counterplay. |
| `wildlife.ts` | — | Async-loaded sculpted & animated `pacific_raven.glb` circling ravens (`glide`/`flap`) and `whitetail_deer.glb` obstacle-aware forest buck & doe (`SkeletonUtils.clone`, `Antlers` visibility toggle, `idle_graze`/`alert`/`trot`/`gallop`) with instant procedural fallbacks, plus nocturnal fireflies (`excludeFromGtao = true`, `pow()` base-guarded). |
| `persistence.ts` | `persistence.test.ts` (2) | Strict zero-`any` runtime-validated `localStorage` save/load (`overgrown_frontier_save_v1`) with `WORLD_BOUNDS` clamping, backward-compatible Phase 2 defaults (`arrows`, `gear`, piece `hp`), array caps (`builtPieces <= 96`, `depletedHarvestIds <= 320`), and quota/private-mode safety. |
| `audio.ts` | — | Procedural Web Audio: dynamic wind/rain/shelter acoustics, thunder, spatial metal creaks, footsteps, combat/bottle/Stalker/campfire/harvest/build SFX, plus Phase 2 `playBowShoot`, `playArrowImpact`, `playRepairHammer`, `playStructureBash`, and `playSiegeHorn`. |

---

## 3D Asset & MoCap Pipeline Inventory

### Staged Runtime Assets (Tracked via Git LFS on `main` & Feature Branches)

- **3D GLB Models (`public/assets/` — 12 total):**
  - `survivor.glb` (`4.07 MB`) — 34-bone twist-rigged survivor with 2-joint fist-curl fingers and 18 baked 24 fps optical MoCap/authored clips (`idle`, `walk`, `jog`, `run`, `walk_back`, `strafe_left`, `strafe_right`, `crouch_idle`, `crouch_walk`, `attack`, `attack_left`, `axe_swing`, `pickaxe_swing`, `bow_shoot`, `jump_start`, `jump_air`, `jump_land`, `throw`).
  - `felling_axe.glb` (`625 KB`) & `pickaxe.glb` (`624 KB`) — AAA sculpted PBR handheld harvesting tools (`origin=(0,0,0)` leather grip, `+Y` shaft, `-Z` cutting blade / front pick spike).
  - `repair_hammer.glb` (`390 KB`) — AAA sculpted PBR framing repair hammer (`+Y` hickory haft, `-Z` waffle bell, `+Z` curved rip claw).
  - `compound_bow.glb` (`475 KB`) — AAA sculpted PBR survival compound bow (`origin=(0,0,0)` left-hand grip, `+Y` vertical limbs/cams, `-Z` forward riser, `+Z` taut bowstring).
  - `arrow.glb` (`120 KB`) — AAA sculpted PBR broadhead hunting arrow (`-Z` forward flight axis, tri-vane fletching).
  - `whitetail_deer.glb` (`824 KB`) — 26-bone rigged & animated Pacific Northwest whitetail deer (`DeerBody` + toggleable `Antlers`, `idle_graze`, `alert`, `trot`, `gallop`).
  - `pacific_raven.glb` (`800 KB`) — 14-bone rigged & animated Pacific Northwest raven (`glide`, `flap`).
  - `raider.glb` (`3.36 MB`) — 32-bone MoCap hostile scavenger raider (`idle`, `walk`, `jog`, `run`, `attack`, `hit`, `death`).
  - `hollow_stalker.glb` (`4.10 MB`) — 34-bone sculpted original forest predator (`idle`, `walk`, `jog`, `run`, `attack`, `hit`, `death`).
  - `rusted_van.glb` (`5.52 MB`) & `rusted_sedan.glb` (`5.32 MB`) — Sculpted abandoned Pacific Northwest highway wrecks.
- **PBR Source Textures (`public/textures/`):** `asphalt.jpg`, `concrete.jpg`, `fabric_olive.jpg`, `fern_frond.jpg`, `forest_floor.jpg`, `ivy_vines.jpg`, `mossy_rock.jpg`, `pine_bark.jpg`, `pine_branch.jpg`, `rust_metal.jpg` (10 photographic maps).

### External Blender AAA Asset & Retargeting Scripts (Host Library)

- Survivor: `C:\GameDev\assets\library\frontier_survivor\retarget_mocap_survivor_aaa.py`
- Survival Tools (Felling Axe & Pickaxe): `C:\GameDev\assets\library\frontier_tools\build_survival_tools_aaa.py`
- Phase 2 Weapons & Tools (Repair Hammer, Compound Bow & Broadhead Arrow): `C:\GameDev\assets\library\frontier_tools\build_phase2_weapons_aaa.py`
- Whitetail Deer: `C:\GameDev\assets\library\whitetail_deer\rig_animate_deer_aaa.py`
- Pacific Raven: `C:\GameDev\assets\library\pacific_raven\rig_animate_raven_aaa.py`
- Raider: `C:\GameDev\assets\library\frontier_raider\retarget_mocap_raider_aaa.py`
- Hollow Stalker: `C:\GameDev\assets\library\hollow_stalker\retarget_mocap_stalker_aaa.py`
- Raw optical MoCap inbox: `C:\GameDev\assets\inbox\`

---

## Player Controls & Keybindings

| Category | Input | Action |
| --- | --- | --- |
| **Movement** | `W A S D` / Arrows | Move |
| | `Mouse` / Drag | Orbit & aim camera (Pointer Lock or drag-to-look fallback) |
| | `Alt` (hold) | Slow walk |
| | `Shift` (hold) | Sprint |
| | `C` / `Ctrl` | Toggle / Hold crouch (stealth) |
| | `Space` | Jump |
| **Tools & Combat** | `4` / `5` / `6` | Equip Felling Axe / Pickaxe / Bare Fists (outside Build Mode) |
| | `7` / `8` | Equip crafted Compound Bow / Repair Hammer (outside Build Mode) |
| | `Q` | Cycle smoothly through currently owned tools |
| | `Click` / `F` | Melee attack, stealth takedown, chop timber, mine stone, repair damaged structure (Hammer), or loose broadhead arrow (Bow) |
| | `G` | Throw distraction glass bottle |
| **Build Mode** | `Tab` | Toggle Snap-Together Modular Build Mode |
| | `1`–`9`, `0` / `Scroll` | Select 10 modular pieces (`Foundation`, `Wall`, `Window Wall`, `Doorway`, `Roof`, `Stairs`, `Upper Floor`, `Spikes`, `Storage`, `Workbench`) |
| | `R` | Rotate ghost preview (`45°` increments) |
| | `Click` / `F` / `Enter` | Place snapped piece |
| | `X` | Dismantle looked-at piece (`50%` rounded-up refund) |
| **Interact & Camp** | `E` | Context action: Scavenge cache / Open-Close Door (on current story) / Craft at Workbench / Stash-Withdraw Crate / Cook Ration at Campfire |
| | `Z` | Cycle Workbench crafting recipe across 10 consumables & gear upgrades (auto-skips owned unlocks) |
| | `1` / `2` / `3` | Quick-use Field Ration / Medkit / Hand Warmer (outside Build Mode) |
| | `B` / `V` | Build quick Campfire (`2 Scrap`) / Lean-To Shelter (`4 Scrap`, sets Camp Respawn) |
| **Siege, Sky & Save** | `N` | Manually rally / trigger an active Base Siege Wave (for testing or extra loot) |
| | `L` | Toggle chest-mounted tactical flashlight |
| | `T` / `Y` | Advance time-of-day phase / Toggle Pacific rainstorm |
| | `M` | Mute / Unmute audio |
| | `F5` | Manual Quick Save to `localStorage` |
| | `R` (dead) / `Esc` | Respawn / Pause to overlay |

---

## Persistent Save Schema (`overgrown_frontier_save_v1`)

Stored as JSON in `window.localStorage` under `SAVE_STORAGE_KEY = 'overgrown_frontier_save_v1'` (`src/systems/persistence.ts`, fully backward-compatible with Phase 1 v1 saves):

- `version`: `1` (strictly validated; unknown versions rejected safely)
- `savedAt`: Unix epoch ms
- `player`: `{ x, z, yaw }` (`x`/`z` clamped inside `WORLD_BOUNDS` ±1 m on load)
- `timeHours`: `0..24` normalized clock hour
- `survival`:
  - `vitals`: `{ health, stamina, hunger, warmth }`
  - `inventory`: `{ rations, medkits, warmers, bottles, scrap, wood, stone, arrows? }` (legacy saves default `arrows` to `0`)
  - `gear?`: `{ hasCompoundBow, hasRepairHammer, reinforcedTools, upgradedFlashlight, scrapArmor }` (legacy saves default all flags to `false`)
- `builtPieces`: `SavedBuildPiece[]` (capped at `96`; supports all 10 piece kinds incl. `window_wall`, `stairs`, `upper_floor`; preserves `doorOpen` on doorways and optional damaged `hp >= 1`)
- `storageStash`: `{ wood, stone, scrap, rations, medkits, warmers, bottles }`
- `camp`: `{ campfires: { x, z }[], shelters: { x, z, yaw }[] }` (capped at `16` each)
- `lootedCacheIds`: `string[]` (capped at `32`)
- `depletedHarvestIds`: `string[]` (capped at `320`)
