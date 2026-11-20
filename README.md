# Overgrown Frontier

A third-person Pacific Northwest post-apocalyptic survival game built with **Three.js**, **TypeScript**, and **Vite** — running directly in the browser with WebGL2 PBR rendering, real-time GTAO, optical motion-capture animations, procedural Web Audio soundscapes, dynamic weather, and camp crafting.

## Features

- **Reclaimed Pacific Northwest Valley (Old Route 9):** Explore Cedar Ridge Overlook, fractured rain-slicked highway asphalt with real-time planar puddle reflections, overgrown rusted wrecks, a decaying roadside gas station, concrete bunker ruins, wind-swaying ferns, and five distinct tree species (Douglas Fir, Western Red Cedar, Ponderosa Pine, Red Alder, and weathered forest snags).
- **MoCap-Rigged Survivor & Tactile Controls:** 34-bone skeleton with smooth speed-matched locomotion (`Walk`, `Jog`, `Run`, `Crouch`), 3-phase jump arcs, upper/lower-body split-masked alternating punches and bottle throws, plus a physical **chest-strap angled tactical flashlight** that smoothly turns the survivor with your beam.
- **Stealth, Scavenging & Survival Vitals:** Manage **Health**, **Stamina**, **Hunger**, and **Warmth**. Stay hidden in roadside ferns, loot 8 scattered supply caches, throw glass bottles to distract patrolling **Raiders**, or close in for stealth takedowns.
- **The Living Night:** Seamless 24-hour day/night sky cycle (dawn, morning, afternoon, golden hour, dusk, starlit night), rolling Pacific Northwest rainstorms with GPU rainfields and thunder, ambient wildlife (circling ravens, startled forest deer, nocturnal fireflies), and an original nocturnal predator — **The Hollow Stalker** — that hunts in the dark and recoils from bright beam light and fire.
- **Survive & Build Your Camp:** Spend scavenged **Scrap** to construct stone-ring **Campfires** (storm-proof warmth, gentle healing, ration cooking, spatial crackling fire audio, and a protective Hollow Stalker repellent perimeter) and timber-and-canvas **Lean-To Shelters** (overhead weather shelter plus a persistent **Camp Respawn** point that preserves your scavenged supplies).

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| `Mouse` | Orbit / Aim camera (Pointer Lock) |
| `Alt` (hold) | Slow walk |
| `Shift` (hold) | Sprint |
| `C` / `Ctrl` | Toggle crouch (stealth) |
| `Space` | Jump |
| `Left Click` / `F` | Melee attack / Stealth takedown |
| `E` | Scavenge cache / Cook Warm Ration at campfire (1 Scrap) |
| `G` | Throw distraction bottle |
| `1` / `2` / `3` | Quick-use Field Ration / Medkit / Hand Warmer |
| `L` | Toggle chest-mounted tactical flashlight |
| `B` | Build Campfire ahead (2 Scrap, max 3) |
| `V` | Build Lean-To Shelter ahead (4 Scrap, max 2, sets Camp Respawn) |
| `T` | Advance time of day to next phase |
| `Y` | Toggle Pacific rainstorm |
| `M` | Mute / Unmute procedural Web Audio |
| `R` | Respawn (when downed) |
| `Esc` | Pause / Release mouse cursor |

## Getting Started

### Prerequisites

- **Node.js 20+** (Node 22 recommended)
- **npm 10+**
- A modern browser with **WebGL2** hardware acceleration enabled

### Local Development

```bash
npm install
npm run dev
```

Open the local Vite URL printed in your terminal (default `http://localhost:5173`) and click **Click to Explore**.

### Verification & Production Build

Run the full quality gate (TypeScript strict check, ESLint, Vitest unit suite, and Vite production bundle):

```bash
npm run verify
```

Individual scripts:

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `eslint src`
- `npm test` — `vitest run`
- `npm run build` — `vite build` (outputs static site into `dist/`)
- `npm run preview` — preview the production build locally

## Deploying to GitHub Pages

This repository includes an automated GitHub Pages workflow at `.github/workflows/deploy.yml`:

1. Push to the `main` branch (or trigger the workflow manually via **Actions -> Deploy to GitHub Pages -> Run workflow**).
2. In your GitHub repository settings, set **Settings -> Pages -> Source** to **GitHub Actions**.
3. Vite builds with relative asset paths (`base: './'`), so all `.glb` models in `public/assets/` resolve cleanly under both custom domains and `/<repo-name>/` project pages.

## Project Structure

```text
├── public/assets/           # Staged 3D GLB assets (survivor, raider, hollow_stalker, wrecks)
├── src/
│   ├── engine/renderer.ts   # WebGL2 renderer, ACES Filmic, GTAO, sky/sun/moon/fog pipeline
│   ├── player/controller.ts # Third-person controller, MoCap mixer, chest flashlight, camera
│   ├── world/
│   │   ├── terrain.ts       # Deterministic terrain heightfield, road spline, collision OBBs
│   │   ├── textures.ts      # Procedural PBR CanvasTexture atlas (albedo, normal, roughness)
│   │   ├── environment.ts   # PNW forest, 5 tree species, ruins, wrecks, reflective puddles
│   │   └── assetLoader.ts   # Optional GLB loader with SkeletonUtils cloning & cleanup
│   ├── systems/
│   │   ├── atmosphere.ts    # 24h day/night clock, storm controller, GPU rainfield
│   │   ├── flashlight.ts    # Volumetric cone beam & SpotLight battery system
│   │   ├── camp.ts          # Craftable Campfires & Lean-To Shelters, flame/spark shaders
│   │   ├── survival.ts      # Health, stamina, hunger, warmth, crafting & camp revival
│   │   ├── stealth.ts       # Visibility, noise radius, fern & shelter checks
│   │   ├── scavenge.ts      # 8 interactable loot caches & prompts
│   │   ├── threats.ts       # Patrolling Raiders, bottle distractions & Hollow Stalker AI
│   │   ├── wildlife.ts      # Ambient ravens, startled forest deer & nocturnal fireflies
│   │   └── audio.ts         # Procedural Web Audio wind, rain, thunder, foley & spatial fire
│   └── main.ts              # Fixed-timestep simulation loop, HUD wiring & lifecycle cleanup
└── .github/workflows/deploy.yml
```
