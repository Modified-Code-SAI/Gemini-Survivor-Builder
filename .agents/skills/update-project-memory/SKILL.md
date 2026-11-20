---
name: update-project-memory
description: Updates Overgrown Frontier's persistent cross-chat project memory files (docs/STATUS.md, docs/ROADMAP.md, docs/ARCHITECTURE.md, docs/DECISIONS_AND_LESSONS.md) at the end of any feature, milestone, bugfix, merge, or deployment so future conversations stay 100% accurate.
---

# Update Overgrown Frontier Project Memory

Invoke this skill whenever you complete a feature, resolve a significant bug or architectural regression, merge branches, publish to `gh-pages`, or finish a milestone phase.

## Mandatory Rules

- Obey the **Single-Edit Verification Rule** (`npm run verify` -> `PASS` immediately after each individual file edit).
- Keep every memory document **concise, factual, and grounded in actual repository files and git commits** (never copy unverified paths, speculative features, or stale test counts).
- Keep `AGENTS.md` strictly concise (target `< 10 KB`, hard ceiling `24 KB`). Put detailed architecture, roadmaps, and lessons in `docs/`, not `AGENTS.md`.

## File-by-File Update Checklist

### 1. `docs/STATUS.md` *(Update on EVERY feature, bugfix, merge, or deploy)*

- Check current branch & latest commit hashes (`git branch -vv`, `git log -n 3 --oneline`).
- Update the **Active Branches & Commits** table (`main`, `gh-pages`, active feature branch).
- Update **What Is Shipped** bullet list with newly verified gameplay/engineering changes.
- Update **Current Verification Baseline** (`typecheck`, `lint`, exact Vitest test-file and test-case counts, Vite production module count).
- Update **Current Next Step** so the very next chat knows immediately what is pending user feedback or ready to start.

### 2. `docs/ROADMAP.md` *(Update when completing phase items or reprioritizing)*

- Check off completed `[x]` checklist items under the active phase.
- Move completed phases clearly into the shipped history if merged to `main`.
- Record any user-approved scope changes without altering the **4 Locked Design Pillars** unless explicitly requested by the user.

### 3. `docs/ARCHITECTURE.md` *(Update when adding/renaming modules, assets, controls, or save fields)*

- Verify actual filenames under `src/` and `public/` before editing.
- Add new source modules, unit test counts, 3D `.glb` / texture assets, keybindings, or `overgrown_frontier_save_v*` schema fields accurately.

### 4. `docs/DECISIONS_AND_LESSONS.md` *(Update whenever solving a tricky bug or locking an engineering invariant)*

- Append a concise bullet under the appropriate section (**Git/Pages**, **3D Rigging/MoCap**, **Three.js Rendering/Shaders**, or **Gameplay/Physics/Browser**) stating:
  1. The concrete root cause / pitfall encountered.
  2. The permanent invariant future chats must preserve.

## Verification

After updating each doc file individually:
1. Run `npm run verify` and confirm `PASS`.
2. Verify `git status --short` shows only intended files and zero lingering background processes.
