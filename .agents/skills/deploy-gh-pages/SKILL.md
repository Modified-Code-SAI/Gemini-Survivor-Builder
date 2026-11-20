---
name: deploy-gh-pages
description: Safely builds and publishes Overgrown Frontier to the orphan gh-pages branch for GitHub Pages without Git LFS pointer corruption. Invoke ONLY after explicit user confirmation to publish a live tester build.
---

# Deploy Overgrown Frontier to GitHub Pages (`gh-pages`)

## Safety Gate (MANDATORY)

- **NEVER** execute a `gh-pages` push or overwrite `main` without **explicit user confirmation**. External playtesters actively play `https://modified-code-sai.github.io/Gemini-Survivor-Builder/`.
- **NEVER** include `.gitattributes` on the `gh-pages` branch. GitHub Pages serves raw repository blobs and **does NOT dereference Git LFS pointers**; committing `.gitattributes` onto `gh-pages` turns every `.glb` and `.jpg` into a 130-byte text pointer and breaks 3D loading.
- **NEVER** push changes under `.github/workflows/` using the host Windows GCM token unless `workflow` OAuth scope has been explicitly added (use this direct orphan `gh-pages` workflow instead).

## Step-by-Step Safe Publish Procedure

### 1. Verify Clean Production Build

Run the full verification suite on the approved branch (typically `main` after merging the approved feature branch):

```powershell
Set-Location "C:\Users\austi\.gemini\antigravity\scratch\overgrown-frontier"
npm run verify
```

Confirm:
- `tsc --noEmit`: 0 errors
- `eslint src`: 0 errors / 0 warnings
- `vitest run`: all tests PASS
- `vite build`: `dist/` generated cleanly with `base: './'`
- Verify `dist/assets/survivor.glb` is a real binary (`> 1 MB`, NOT a ~130-byte LFS pointer!). If any file in `public/assets/` is an LFS pointer, run `git lfs pull` and re-run `npm run verify`.

### 2. Stage Orphan `gh-pages` Snapshot in an Isolated Temporary Worktree

Use a temporary worktree outside the repo so the active working tree and `.gitattributes` are completely untouched:

```powershell
$repo = "C:\Users\austi\.gemini\antigravity\scratch\overgrown-frontier"
$stage = Join-Path $env:TEMP "overgrown-frontier-gh-pages"

if (Test-Path $stage) {
  git -C $repo worktree remove --force $stage 2>$null
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
git -C $repo branch -D gh-pages-staging 2>$null

# Create detached orphan worktree for gh-pages snapshot
git -C $repo worktree add --detach $stage HEAD
Set-Location $stage
git checkout --orphan gh-pages-staging
git rm -rf .

# Copy compiled production bundle WITHOUT .gitattributes so binary assets store directly
Copy-Item -Path "$repo\dist\*" -Destination $stage -Recurse -Force
New-Item -Path "$stage\.nojekyll" -ItemType File -Force | Out-Null

# Confirm ZERO .gitattributes and ZERO LFS pointers in staging
if (Test-Path "$stage\.gitattributes") { Remove-Item "$stage\.gitattributes" -Force }
git -c filter.lfs.smudge= -c filter.lfs.clean= -c filter.lfs.process= add -A

# Sanity check that every staged .glb blob is a real multi-MB binary (> 1,000,000 bytes, not a ~130-byte LFS pointer)
git ls-files -s -- "assets/*.glb" | ForEach-Object { $p = $_ -split '\s+'; "$($p[3]) : $(git cat-file -s $p[1]) bytes" }
```

### 3. Commit & Publish to `gh-pages`

```powershell
git commit -m "chore(deploy): publish verified Overgrown Frontier build to gh-pages"
git push --force origin gh-pages-staging:gh-pages
```

### 4. Clean Up Temporary Worktree

```powershell
Set-Location $repo
git worktree remove --force $stage
git branch -D gh-pages-staging 2>$null
```

### 5. Verify Live GitHub Pages Delivery (`200 OK` & Real Binary Payload)

Wait ~30–60 seconds for GitHub Pages CDN rollout, then verify:

```powershell
$page = Invoke-WebRequest -Uri "https://modified-code-sai.github.io/Gemini-Survivor-Builder/" -UseBasicParsing
$glb = Invoke-WebRequest -Uri "https://modified-code-sai.github.io/Gemini-Survivor-Builder/assets/survivor.glb" -Method Head -UseBasicParsing
Write-Output "HTML Status: $($page.StatusCode)"
Write-Output "GLB Status: $($glb.StatusCode) | Content-Length: $($glb.Headers['Content-Length']) bytes"
```

Confirm:
- HTML returns `200`.
- `survivor.glb` returns `200` and `Content-Length > 1000000` (proving a real binary GLB, not an LFS pointer).
- Update `docs/STATUS.md` with the new `gh-pages` commit hash and published version details.
