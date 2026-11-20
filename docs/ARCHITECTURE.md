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
| `index.html` | Translucent cinematic start overlay (`Continue Saved World`, `Reset World`, Graphics/Audio toggles), minimal TLOU-inspired survival HUD (vitals, badges, supply/tool belt, `#build-bar`, `#workbench-bar`, center interact/toast prompts), game-over overlay, `no-cache` headers. |
| `src/main.ts` | Fixed-timestep (`1/60 s`, max 4 substeps) simulation loop, shared live `worldObstacles` array, elevated `getSupportHeight(x, z)`, startup `localStorage` hydration, auto-save (`20 s` + state mutations + `beforeunload`), dirty-checked DOM HUD updates (zero DOM thrash), and full GPU/Audio/listener disposal. |

### Engine (`src/engine/`)

| File | Responsibility |
| --- | --- |
| `src/engine/renderer.ts` | WebGL2 renderer setup, `high`/`medium` quality scaling, PCF soft shadow maps, procedural GLSL atmospheric sky dome (`dir.xz / (dir.y + 0.35)` zenith-safe starfield), dynamic sun/moon/hemisphere/bounce lighting, screen-space `VOLUMETRIC_SUN_SHADER` shafts, `GTAOPass` (respecting `userData['excludeFromGtao'] = true`), `UnrealBloomPass`, and crisp resize/dispose lifecycle. |

### World (`src/world/`)

| File | Responsibility |
| --- | --- |
| `src/world/terrain.ts` | Deterministic highway spline (`getRoadCenterX`, `getRoadFactor`, `getRoadBaseHeight`), valley relief heightfield (`getTerrainHeight`), `WORLD_BOUNDS`, `SPAWN_POINT`, `createObbObstacle`, and zero-allocation 2-pass `resolveHorizontalCollision` (circles, AABBs, OBBs). |
| `src/world/terrain.test.ts` | 9 unit tests validating terrain determinism, road curve, bounds clamping, and circle/box/OBB collision math. |
| `src/world/textures.ts` | Singleton `getWorldTextureAtlas()` loading 10 real photographic `.jpg` sources (`public/textures/`) into procedural PBR `CanvasTexture` triplets (`map`, `normalMap`, `roughnessMap`) plus alpha-cutout foliage textures (`pineBough`, `ivyCurtain`, `fernFrond`). Owned centrally — never double-disposed by systems. |
| `src/world/assetLoader.ts` | Optional `GLTFLoader` pipeline with `DEFAULT_GLB_SLOT_MANIFEST` slot mapping (`survivor`, `raider`, `hollow_stalker`, `overgrown_van`, `abandoned_sedan`) and `collectMaterialTextures` cleanup helper. |
| `src/world/environment.ts` | Reclaimed Highway 9 environment: cracked asphalt road, 7 rainwater puddles (2 foreground real-time `Reflector` planar mirrors + 5 distant Fresnel puddles) all synced to `AtmosphereSnapshot`, Left Bunker & Gas Station concrete ruins, 5 rusted vehicles (GLB-upgradable with swaying ivy curtains), utility poles, 5-species Pacific Northwest forest (`HERO_TREE_COORDS`, exported `createDouglasFirCanopyGeometry()`, `2.8 m` harvest-node exclusion), ferns, boulders, mist cards, and spatial ruin metal-creak anchors. |

### Player (`src/player/`)

| File | Responsibility |
| --- | --- |
| `src/player/controller.ts` | Over-the-shoulder camera with collision probing & hit trauma shake, 34-bone `survivor.glb` MoCap mixer (speed-matched `walk`/`jog`/`run`/`crouch`, 3-phase `jump_start`/`jump_air`/`jump_land`, load-time upper/lower-body split-masked punches & bottle throws), physical chest-strap angled tactical flashlight (`spine_03` mount + turn-with-light body alignment), switchable right-hand 3D Felling Axe / Pickaxe (`hand_R` mount), `getSupportHeight` foundation walking, Build Mode & tool keybinds, and Chrome pointer-lock hardening (`wasPointerLocked` + drag-to-look + unlocked click/F/Enter build placement). |

### Systems (`src/systems/`)

| File | Tests | Responsibility |
| --- | --- | --- |
| `survival.ts` | `survival.test.ts` (9) | HP, Stamina (exhaustion lock hysteresis), Hunger, Warmth (rain, night, puddle, shelter, campfire override + healing), inventory (`rations`, `medkits`, `warmers`, `bottles`, `scrap`, `wood`, `stone`), atomic `spendResources` / `takeInventory`, `WORKBENCH_RECIPES`, `reviveAtCamp`, `serialize`/`hydrate`. |
| `harvest.ts` | `harvest.test.ts` (2) | 14 photorealistic Douglas Fir timber pines (`HARVEST_NODE_SPECS`, 3 Axe chops -> `10 Wood`, `YXZ` topple fall, cut stump collider `r = 0.34`) & 10 mossy granite outcrops (3 Pickaxe hits -> `9 Stone + 1 Scrap`), wrong-tool hints, pooled chip/shard bursts, `serializeDepletedIds`/`hydrateDepletedIds`. |
| `building.ts` | `building.test.ts` (3) | `[Tab]` 7-piece snap-together modular building (`Foundation`, `Wall`, `Doorway`, `Roof`, `Spikes`, `Storage`, `Workbench`), zero-allocation green/red ghost preview, hinged door OBB toggling, `getFloorHeightAt`, `isInsideBuiltShelter`, `checkSpikeHit`, zero-modal `depositOrWithdrawStorage`, `[X]` dismantle with 50% rounded-up refund, `serialize`/`hydrate`. |
| `camp.ts` | `camp.test.ts` (3) | Craftable stone-ring Campfires (GLSL flame & rising spark shaders, `r = 0.54` non-occluding collider, warmth/cooking/Stalker-repel radii) and timber/canvas Lean-To Shelters (overhead cover + custom Camp Respawn), `serialize`/`hydrate`. |
| `scavenge.ts` | — | 8 handcrafted roadside loot caches with proximity glints, animated lid-open state, `serializeLootedIds`/`hydrateLootedIds`. |
| `stealth.ts` | `stealth.test.ts` (5) | Visibility & acoustic noise radius calculation (fern concealment, crouch, night, rain, flashlight penalty), `isInsideShelter`, and `hasLineOfSight` (`MIN_OCCLUDING_CIRCLE_RADIUS = 0.55`). |
| `threats.ts` | — | Patrolling MoCap Raiders (`raider.glb`, cloned via `SkeletonUtils.clone`) and nocturnal predator **The Hollow Stalker** (`hollow_stalker.glb`), vision cones, acoustic hearing, pooled throwable glass bottles & shatter bursts, flashlight recoil, hysteretic campfire retreat (`fireFleeTimer`), Defensive Spikes damage/stagger/loot, `getSupportHeight` deck footing. |
| `atmosphere.ts` | `atmosphere.test.ts` (6) | 24-hour day/night clock (`dawn`, `morning`, `afternoon`, `golden_hour`, `dusk`, `night`), rolling storms (`clear`/`overcast`/`rain`/`storm`), lightning & thunder triggers, and monotonic phase-integrated GPU `RainField`. |
| `flashlight.ts` | — | Volumetric cone beam shader (`excludeFromGtao = true`), `SpotLight`, battery drain & auto-recharge, and `getBeamExposure` for Stalker counterplay. |
| `wildlife.ts` | — | Ambient circling ravens, startled obstacle-aware forest deer, and nocturnal fireflies (`excludeFromGtao = true`). |
| `persistence.ts` | `persistence.test.ts` (2) | Strict zero-`any` runtime-validated `localStorage` save/load (`overgrown_frontier_save_v1`) with `WORLD_BOUNDS` clamping, array length caps, and quota/private-mode safety. |
| `audio.ts` | — | Procedural Web Audio: dynamic wind/rain/shelter acoustics, thunder, spatial metal creaks, footsteps (`asphalt`/`forest`/`puddle`), combat/bottle/Stalker SFX, continuous spatial campfire murmur + ember crackles, and wood-chop/rock-mine/build/dismantle/door/spike SFX. |

---

## 3D Asset & MoCap Pipeline Inventory

### Staged Runtime Assets (Tracked via Git LFS on `main`)

- **3D GLB Models (`public/assets/`):**
  - `survivor.glb` (`3.97 MB`) — 34-bone twist-rigged survivor with 2-joint fist-curl fingers and 15 baked 24 fps optical MoCap clips (`idle`, `walk`, `jog`, `run`, `walk_back`, `strafe_left`, `strafe_right`, `crouch_idle`, `crouch_walk`, `attack`, `attack_left`, `jump_start`, `jump_air`, `jump_land`, `throw`).
  - `raider.glb` (`3.36 MB`) — 32-bone MoCap hostile scavenger raider (`idle`, `walk`, `jog`, `run`, `attack`, `hit`, `death`).
  - `hollow_stalker.glb` (`4.10 MB`) — 34-bone sculpted original forest predator (`idle`, `walk`, `jog`, `run`, `attack`, `hit`, `death`).
  - `rusted_van.glb` (`5.52 MB`) & `rusted_sedan.glb` (`5.32 MB`) — Sculpted abandoned Pacific Northwest highway wrecks.
- **PBR Source Textures (`public/textures/`):** `asphalt.jpg`, `concrete.jpg`, `fabric_olive.jpg`, `fern_frond.jpg`, `forest_floor.jpg`, `ivy_vines.jpg`, `mossy_rock.jpg`, `pine_bark.jpg`, `pine_branch.jpg`, `rust_metal.jpg` (10 photographic maps).

### External Blender AAA Retargeting Scripts (Host Library)

- Survivor: `C:\GameDev\assets\library\frontier_survivor\retarget_mocap_survivor_aaa.py`
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
| **Tools & Combat** | `4` / `5` / `6` / `Q` | Equip Felling Axe / Pickaxe / Bare Fists (outside Build Mode) |
| | `Click` / `F` | Melee attack, stealth takedown, or chop timber / mine stone |
| | `G` | Throw distraction glass bottle |
| **Build Mode** | `Tab` | Toggle Snap-Together Modular Build Mode |
| | `1`–`7` / `Scroll` | Select piece (`Foundation`, `Wall`, `Doorway`, `Roof`, `Spikes`, `Storage`, `Workbench`) |
| | `R` | Rotate ghost preview (`45°` increments) |
| | `Click` / `F` / `Enter` | Place snapped piece |
| | `X` | Dismantle looked-at piece (`50%` rounded-up refund) |
| **Interact & Camp** | `E` | Context action: Scavenge cache / Open-Close Door / Craft at Workbench / Stash-Withdraw Crate / Cook Ration at Campfire |
| | `Z` | Cycle Workbench crafting recipe (`Ration`, `Medkit`, `Warmer`, `Bottle`) |
| | `1` / `2` / `3` | Quick-use Field Ration / Medkit / Hand Warmer (outside Build Mode) |
| | `B` / `V` | Build quick Campfire (`2 Scrap`) / Lean-To Shelter (`4 Scrap`, sets Camp Respawn) |
| **Atmosphere & Save** | `L` | Toggle chest-mounted tactical flashlight |
| | `T` / `Y` | Advance time-of-day phase / Toggle Pacific rainstorm |
| | `M` | Mute / Unmute audio |
| | `F5` | Manual Quick Save to `localStorage` |
| | `R` (dead) / `Esc` | Respawn / Pause to overlay |

---

## Persistent Save Schema (`overgrown_frontier_save_v1`)

Stored as JSON in `window.localStorage` under `SAVE_STORAGE_KEY = 'overgrown_frontier_save_v1'` (`src/systems/persistence.ts`):

- `version`: `1` (strictly validated; unknown versions rejected safely)
- `savedAt`: Unix epoch ms
- `player`: `{ x, z, yaw }` (`x`/`z` clamped inside `WORLD_BOUNDS` ±1 m on load)
- `timeHours`: `0..24` normalized clock hour
- `survival`: `{ vitals: { health, stamina, hunger, warmth }, inventory: { rations, medkits, warmers, bottles, scrap, wood, stone } }`
- `builtPieces`: `SavedBuildPiece[]` (capped at `64`; doorway preserves `doorOpen`)
- `storageStash`: `{ wood, stone, scrap, rations, medkits, warmers, bottles }`
- `camp`: `{ campfires: { x, z }[], shelters: { x, z, yaw }[] }` (capped at `16` each)
- `lootedCacheIds`: `string[]` (capped at `32`)
- `depletedHarvestIds`: `string[]` (capped at `64`)
