# Overgrown Frontier — Architectural Decisions & Hard-Won Lessons

> Permanent engineering invariants established during Milestones 1–4 and Phase 1. Future chats must respect every invariant below unless explicitly redesigned with full verification.

---

## 1. Git, Branching, Git LFS & GitHub Pages Invariants

- **Branch Protection for Playtesters:** `main` (`v0.1.0-vertical-slice`) and `gh-pages` (live tester demo) MUST NEVER be overwritten or force-pushed without explicit user confirmation. Always build and verify new work on feature branches (currently `feat/modular-building`).
- **Git LFS vs. GitHub Pages Direct Blobs:**
  - `main` and feature branches track `.glb`, `.gltf`, `.blend`, `.fbx`, `.png`, `.jpg`, `.hdr`, `.exr`, `.wav`, `.ogg`, `.mp3` via Git LFS in `.gitattributes`.
  - **GitHub Pages does NOT dereference Git LFS pointers.** Therefore `gh-pages` MUST remain an orphan branch **WITHOUT `.gitattributes`**, containing compiled `dist/` contents, `.nojekyll`, and direct non-LFS binary assets under `assets/` and `textures/`. See `.agents/skills/deploy-gh-pages/SKILL.md`.
- **Windows Git Credential Manager OAuth Scope:** The cached host GCM token carries `repo` scope but **NOT `workflow` scope** — pushing edits under `.github/workflows/` will be rejected by GitHub. Keep the GitHub Actions workflow template safely at `docs/github-pages-deploy.yml` until a token with `workflow` scope is granted.
- **Git Commit Identity:** Configured locally to `ModifiedCode <294345752+Modified-Code-SAI@users.noreply.github.com>`.
- **Relative Asset Paths:** `vite.config.ts` MUST keep `base: './'` so `./assets/*.glb` and `./textures/*.jpg` resolve identically on localhost, custom domains, and `/Gemini-Survivor-Builder/` GitHub Pages URLs.

---

## 2. 3D Character Rigging & Optical MoCap Invariants

- **Real Optical MoCap Only:** All playable survivor, raider, and Hollow Stalker locomotion, combat, and jump clips are baked from real optical motion capture (`C:\GameDev\assets\inbox\`) via our Blender AAA retargeting scripts (`C:\GameDev\assets\library\...`). **Never replace character animation with procedural sine-wave puppets.**
- **Collinear Swing-Twist Decomposition:** Twist bones (`upperarm_twist`, `forearm_twist`) MUST be solved using exact collinear swing-twist decomposition (`swing_only = swing(u0, new_shaft); axial_twist = full_w @ swing_only^-1`) paired with full 3×3 orthonormal palm/arm basis alignment to eliminate mid-bicep and mid-forearm S-kinks.
- **Articulated Hands & Split-Body Masking:** `survivor.glb` uses a 34-bone skeleton with 2-joint fist-curl fingers (`fingers_01_L/R`, `fingers_02_L/R`). Load-time lower-body / upper-body clip splitting in `src/player/controller.ts` blends upper-body punches and bottle throws seamlessly over lower-body running/jogging/walking with zero leg freezing or foot sliding.
- **GLB Bone Attachments:** Always detach reusable props (`chestFlashlight` on `spine_03`, `handTools` on `hand_R`) from the procedural fallback rig before disposing the fallback rig, compensate parent bone world scale cleanly (`invScale = 1 / boneWorldScale.x`), and dispose each prop **once** in `player.dispose()`.

---

## 3. Three.js r174 WebGL2 Rendering & Shader Invariants

- **GTAO Exclusion for Transparent / Additive Effects:** `GTAOPass` renders its depth/normal pass across scene meshes; transparent, additive, or `depthWrite: false` objects (campfire flames, rising sparks, build ghost previews, wood chips/stone shards, flashlight volumetric cones, chest lens glow, fireflies, scavenge glints, Stalker eye embers, status sprites) MUST set `mesh.userData['excludeFromGtao'] = true` so they never cast dark halo artifacts.
- **GLSL `pow()` NaN Guard (ANGLE / WebGL2):** Passing a slightly negative base into `pow(x, y)` in GLSL yields `NaN`, which blooms into permanent black square tiles inside `UnrealBloomPass`. Always clamp every `pow()` base with `max(0.0, x)` or `clamp(x, 0.0, 1.0)`.
- **Singularity-Free Sky Zenith:** Never use `atan(dir.x, dir.z)` directly at the zenith (`dir.y -> 1`) in starfield/sky shaders; use stereographic/projected coordinates `(dir.xz / (dir.y + 0.35)) * 125.0`.
- **Monotonic Rain Phase Integration:** Never multiply raw `uTime` by a changing fall-speed uniform inside the rain vertex shader (decreasing speed causes raindrops to fly upward!). Always integrate `uFallPhase` and `uWindPhase` monotonically on CPU (`dt`-accumulated).
- **Screen-Space Volumetric Sun Shafts:** Keep the HDR screen-space `VOLUMETRIC_SUN_SHADER` pipeline; never revert to static 2D god-ray billboard planes.
- **Reflective Puddle Atmosphere Sync:** All 7 rainwater puddles (2 foreground `Reflector` planar mirrors + 5 distant Fresnel puddles) must stay synced to `AtmosphereSnapshot` sky/fog/night tints so puddles never glow sunset-orange at midnight.
- **Single-Owner Texture Atlas Disposal:** `getWorldTextureAtlas()` owns all shared PBR `CanvasTexture` instances. Feature systems (`camp.ts`, `harvest.ts`, `building.ts`, `threats.ts`, `scavenge.ts`, `controller.ts`) dispose ONLY their own created `BufferGeometry` and `Material` objects — **never** dispose borrowed atlas textures.
- **Photorealistic Harvest Trees:** Harvestable timber pines reuse `createDouglasFirCanopyGeometry()` + `atlas.pineBough` (`alphaTest: 0.38`, `vertexColors: true`, `DoubleSide`) so they blend seamlessly with the surrounding forest rather than standing out as stylized `ConeGeometry` props.

---

## 4. Gameplay, Physics, Performance & Browser Invariants

- **Zero Per-Frame Heap Allocations:** Never allocate `new THREE.Vector3()`, `Quaternion`, `Matrix4`, `Color`, or transient return objects inside `update()`, `updateCamera()`, `render()`, `frame()`, or high-frequency HUD queries (e.g., `building.getInteractTarget` reuses `scratchInteractTarget`).
- **Line-of-Sight vs. Low Colliders:** `stealth.ts` treats circular obstacles with `radius >= MIN_OCCLUDING_CIRCLE_RADIUS (0.55)` as opaque sightline pillars. Keep low ground obstacles (campfire rings `r = 0.54`, cut tree stumps `r = 0.34`) strictly `< 0.55` so enemies do not lose LOS behind ankle-high stones or stumps.
- **Spatial Placement Clearances:** All `HARVEST_NODE_SPECS` must maintain `>= 2.6 m` clearance from `HERO_TREE_COORDS`, foreground Red Alder `(-6.9, 9.8)`, pairwise harvest nodes, landmarks, vehicles, boulders, and scavenge caches, and `>= 4.4 m` from `getRoadCenterX(z)`. `environment.ts` enforces a `2.8 m` radial exclusion around every harvest node during procedural pine generation.
- **Arbitrary-Azimuth Tree Toppling:** Tree `mainPivot` uses `rotation.order = 'YXZ'` and `rotation.set(fallAngle, fallYaw, 0)` so diagonal falls tilt cleanly in a single vertical plane away from the survivor with zero roll skew.
- **Unified Support Height & Dry Decks:** `getSupportHeight(x, z)` (`max(getTerrainHeight, building.getFloorHeightAt)`) is shared by the player controller, Raiders, Hollow Stalker, and thrown bottles; player puddle-footstep audio and chill checks mask puddles whenever `building.getFloorHeightAt(x, z) !== null`.
- **Hysteretic Campfire Repellent:** The Hollow Stalker uses dedicated `fireFleeTimer (1.6 s)` and `fireRecoilCooldown (6.5 s)` (separate from flashlight `recoilCooldown`) so it bounds cleanly away into the pines instead of vibrating on the `7.8 m` campfire perimeter.
- **Phase 1 Single-Story Building Scope:** Walls and doorways snap cleanly to foundation edges and terrain only (no floating 2nd-story wall stacking over 1st-story open doorways until Phase 2 adds stairs & vertical-band collision). `tryPlaceCurrent` always re-validates live constraints and immediately invalidates `ghostValid` to prevent duplicate-click stacking.
- **Chrome Pointer-Lock Hardening:** `controller.ts` gates `onPointerLockChange(false)` behind `wasPointerLocked` so Chrome's pointer-lock cooldown or focus bounce never slams `#start-overlay` back up; drag-to-look (`buttons & 1 || buttons & 2`), unlocked short-click (`< 25 px²`) Build Mode placement, and `[F]` / `[Enter]` placement ensure smooth play even without pointer lock.
- **Tamper-Resistant Persistence:** `persistence.ts` validates all fields via strict `unknown` narrowing (zero `any`), clamps `player.x`/`player.z` inside `WORLD_BOUNDS`, and caps all loaded arrays (`builtPieces <= 64`, `depletedHarvestIds <= 64`, `lootedCacheIds <= 32`, `campfires/shelters <= 16`).
