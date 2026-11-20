# Overgrown Frontier — Design Pillars & Expansion Roadmap

## Vision

A grounded, atmospheric Pacific Northwest post-apocalyptic survival-builder running natively in the browser (`Three.js` + `TypeScript` + `WebGL2`). Blending the moody, rain-slicked storytelling of *The Last of Us* with the tactile snap-building and nocturnal siege tension of *Valheim* and *The Forest*.

---

## 4 Locked Design Pillars

1. **Snap-Together Modular Base Building** (*Valheim* / *The Forest* style)
   - Live green/red ghost previews, magnetic snapping (`Foundation`, `Wall`, `Doorway` with functional hinged door, `Roof`, `Defensive Spikes`, `Storage Crate`, `Workbench`), elevated decks over sloped hillside terrain, and roofed shelter that genuinely blocks rain and restores warmth.
2. **Physical Tool Harvesting**
   - Diegetic right-hand survival tools (**Felling Axe** for photorealistic Pacific Northwest timber pines -> Wood, **Survival Pickaxe** for mossy granite outcrops -> Stone + bonus Scrap) alongside scavenging abandoned wrecks and supply caches.
3. **Handcrafted Connected Biomes**
   - Seamless exploration expanding outward from **Old Route 9 (Cedar Ridge Overlook)** into **Flooded Industrial Docks**, **Dense Pine Overstory**, and **Subterranean Maintenance Tunnels** — each with distinct landmarks, hazards, loot tables, and acoustics.
4. **Dynamic Night & Storm Base Sieges**
   - Patrolling Raiders and nocturnal **Hollow Stalkers** dynamically probe, flank, and siege player bases during darkness and storms — creating high-stakes defense loops around fortified walls, doors, spikes, spotlights, and campfire repellent rings.

---

## Completed Foundation (Vertical Slice — `main` @ `v0.1.0-vertical-slice`)

- **Milestone 1:** Reclaimed Pacific Northwest Highway 9 valley, 5 botanical tree species, GTAO + ACES Filmic + volumetric sun rays, reflective rain puddles, 34-bone MoCap-animated survivor.
- **Milestone 2:** Survival vitals (HP, Stamina, Hunger, Warmth), fern stealth & crouch concealment, 8 scavengeable caches, distraction glass bottles, patrolling MoCap Raiders, upper/lower-body split-masked punches & throws.
- **Milestone 3 ("The Living Night"):** Dynamic 24-hour sky/sun/moon/fog cycle, rolling Pacific rainstorms with GPU rainfield & thunder, volumetric chest-mounted tactical flashlight, ambient wildlife (ravens, deer, fireflies), and original signature monster **The Hollow Stalker**.
- **Milestone 4 ("Survive & Build Your Camp"):** Craftable stone-ring Campfires (storm-proof warmth, healing, ration cooking, Stalker repellent, spatial crackling fire audio) and timber-and-canvas Lean-To Shelters (overhead cover + persistent Camp Respawn).

---

## 4-Phase Full Survival-Builder Expansion

### Phase 1 — Physical Harvesting, Modular Building & Persistence *(COMPLETE on `feat/modular-building`)*

- [x] Switchable 3D right-hand **Felling Axe**, **Pickaxe**, and **Bare Fists** (`[4/5/6/Q]`).
- [x] 14 photorealistic alpha-cutout Douglas Fir harvest trees & 10 mossy granite stone outcrops with wood-chip/stone-shard bursts, `YXZ` felling animation, stumps, and collider updates.
- [x] `[Tab]` Snap-Together Modular Base Building with 7 pieces (`Foundation`, `Wall`, `Doorway`, `Roof`, `Defensive Spikes`, `Storage Crate`, `Workbench`), live ghost preview, `[R]` rotate, `[X]` 50% dismantle refund, hinged door collider toggling, elevated floor support, and roofed shelter integration.
- [x] Versioned `localStorage` Save/Load (`overgrown_frontier_save_v1`), auto-save, `[F5]` Quick Save, `Continue Saved World` & `Reset World`.
- [x] Chrome Pointer-Lock hardening (`wasPointerLocked` guard, drag-to-look fallback, unlocked click/`[F]`/`[Enter]` placement).

### Phase 2 — Base Sieges, Structural Durability, Multi-Story & Gear Progression *(NEXT — Planned)*

- [ ] **Structural Health & Repair Hammer:** Assign HP to built walls, doorways, spikes, and workbenches; add visual damage states (cracks/scorch/lean) and a craftable **Repair Hammer** to mend structures with Wood/Stone.
- [ ] **Active Night & Storm Base Sieges:** Trigger periodic nocturnal/storm siege waves where Raiders & Hollow Stalkers converge on active campfires/bases, bash closed doors and walls, and test spike perimeters.
- [ ] **Workbench Weapons & Gear Progression:** Expand Workbench crafting to unlock **Compound Bow + Craftable Arrows**, **Reinforced Steel Axe/Pickaxe** (faster harvesting + higher melee damage), **Upgraded High-Capacity Flashlight**, and **Improvised Scrap Armor**.
- [ ] **Multi-Story Building:** Add **Timber Stairs / Ramp**, **Upper Floor Deck**, **Window Wall**, and vertical-band collision so 2nd-story walls never block 1st-story open doorways.

### Phase 3 — Connected Biome II: Flooded Industrial Docks *(Planned)*

- [ ] Seamless northern/western coastal transition off Highway 9 into rusted shipping yards, weathered container stacks, dockside gantries, and tidal shallows.
- [ ] New environmental hazards (contaminated bilge water, foghorns, slick metal catwalks) and craftable **Water Filtration Gear** + industrial salvage components.
- [ ] Dedicated dockside raider outpost and high-value supply caches.

### Phase 4 — Deep Wilderness, Subterranean Tunnels & Endgame Loop *(Planned)*

- [ ] **Dense Pine Overstory:** High-elevation old-growth timber ridge, watchtower landmark, denser Hollow Stalker stalking grounds, and storm lightning strikes.
- [ ] **Subterranean Maintenance Tunnels:** Pitch-black highway drainage & utility bunker network requiring flashlight discipline, flare/lantern crafting, and close-quarters stealth.
- [ ] **Rival Factions & Vehicle Restoration Endgame:** Multi-part salvage & repair chain to restore an abandoned frontier truck/sedan as the ultimate long-term survival milestone.
