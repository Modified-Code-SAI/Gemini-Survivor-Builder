import * as THREE from 'three';

export interface PbrTextureSet {
  readonly map: THREE.CanvasTexture;
  readonly normalMap: THREE.CanvasTexture;
  readonly roughnessMap: THREE.CanvasTexture;
}

export interface AlphaFoliageTextureSet {
  readonly map: THREE.CanvasTexture;
  readonly normalMap: THREE.CanvasTexture;
}

export interface WorldTextureAtlas {
  readonly highway: PbrTextureSet;
  readonly forestFloor: PbrTextureSet;
  readonly concrete: PbrTextureSet;
  readonly mossyRock: PbrTextureSet;
  readonly rustVan: PbrTextureSet;
  readonly rustSedan: PbrTextureSet;
  readonly rustDark: PbrTextureSet;
  readonly pineBark: PbrTextureSet;
  readonly fabricOlive: PbrTextureSet;
  readonly pineBough: AlphaFoliageTextureSet;
  readonly ivyCurtain: AlphaFoliageTextureSet;
  readonly fernFrond: AlphaFoliageTextureSet;
  dispose(): void;
}

interface CanvasTriple {
  readonly colorCanvas: HTMLCanvasElement;
  readonly colorCtx: CanvasRenderingContext2D;
  readonly normalCanvas: HTMLCanvasElement;
  readonly normalCtx: CanvasRenderingContext2D;
  readonly roughCanvas: HTMLCanvasElement;
  readonly roughCtx: CanvasRenderingContext2D;
}

interface FoliageCanvasPair {
  readonly colorCanvas: HTMLCanvasElement;
  readonly colorCtx: CanvasRenderingContext2D;
  readonly normalCanvas: HTMLCanvasElement;
  readonly normalCtx: CanvasRenderingContext2D;
}

function createCanvas2D(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for PBR texture pipeline');
  }
  return { canvas, ctx };
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  isColor: boolean,
  repeatX = 1,
  repeatY = 1,
  wrapS: THREE.Wrapping = THREE.RepeatWrapping,
  wrapT: THREE.Wrapping = THREE.RepeatWrapping,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = wrapS;
  tex.wrapT = wrapT;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function fillFlatNormal(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#8080ff';
  ctx.fillRect(0, 0, w, h);
}

/**
 * Computes a tangent-space RGB normal map via 3x3 Sobel gradients on pixel luminance
 * and an aligned micro-roughness map where crevices/moss/rust pits stay matte while
 * smoother aggregate/painted areas catch subtle golden-hour grazing highlights.
 */
function deriveNormalAndRoughnessFromCanvas(
  sourceCtx: CanvasRenderingContext2D,
  normalCtx: CanvasRenderingContext2D,
  roughCtx: CanvasRenderingContext2D | null,
  normalStrength: number,
  roughMin: number,
  roughMax: number,
  invertRoughness: boolean,
  tileable: boolean,
  rustRoughBoost = false,
): void {
  const w = sourceCtx.canvas.width;
  const h = sourceCtx.canvas.height;
  const srcData = sourceCtx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);

  for (let i = 0; i < w * h; i += 1) {
    const idx = i * 4;
    const r = srcData[idx] ?? 0;
    const g = srcData[idx + 1] ?? 0;
    const b = srcData[idx + 2] ?? 0;
    lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const normalImg = normalCtx.createImageData(w, h);
  const nOut = normalImg.data;
  const roughImg = roughCtx ? roughCtx.createImageData(w, h) : null;
  const rOut = roughImg ? roughImg.data : null;

  const sampleLum = (x: number, y: number): number => {
    let sx = x;
    let sy = y;
    if (tileable) {
      sx = ((x % w) + w) % w;
      sy = ((y % h) + h) % h;
    } else {
      sx = x < 0 ? 0 : x >= w ? w - 1 : x;
      sy = y < 0 ? 0 : y >= h ? h - 1 : y;
    }
    return lum[sy * w + sx] ?? 0.5;
  };

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const pIdx = y * w + x;
      const outIdx = pIdx * 4;
      const alpha = srcData[outIdx + 3] ?? 255;

      if (alpha < 20) {
        nOut[outIdx] = 128;
        nOut[outIdx + 1] = 128;
        nOut[outIdx + 2] = 255;
        nOut[outIdx + 3] = 255;
        continue;
      }

      const tl = sampleLum(x - 1, y - 1);
      const t = sampleLum(x, y - 1);
      const tr = sampleLum(x + 1, y - 1);
      const l = sampleLum(x - 1, y);
      const r = sampleLum(x + 1, y);
      const bl = sampleLum(x - 1, y + 1);
      const b = sampleLum(x, y + 1);
      const br = sampleLum(x + 1, y + 1);

      // 3x3 Sobel derivatives
      const dX = tr + 2 * r + br - (tl + 2 * l + bl);
      const dY = bl + 2 * b + br - (tl + 2 * t + tr);

      let nx = -dX * normalStrength;
      let ny = dY * normalStrength;
      let nz = 1.0;
      const invLen = 1 / Math.hypot(nx, ny, nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      nOut[outIdx] = Math.round((nx * 0.5 + 0.5) * 255);
      nOut[outIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nOut[outIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nOut[outIdx + 3] = 255;

      if (rOut) {
        const cLum = lum[pIdx] ?? 0.5;
        const gradMag = Math.min(1, Math.hypot(dX, dY) * 1.6);
        let roughVal = invertRoughness ? 1 - cLum : cLum;
        // Crevices and strong edges stay rougher; damp dark patches can reflect more softly
        roughVal = Math.min(1, Math.max(0, roughVal * 0.72 + gradMag * 0.28));

        if (rustRoughBoost) {
          const cr = (srcData[outIdx] ?? 0) / 255;
          const cg = (srcData[outIdx + 1] ?? 0) / 255;
          const cb = (srcData[outIdx + 2] ?? 0) / 255;
          // Detect warm oxidized orange-brown rust patches and push them matte rough
          const rustiness = Math.max(0, (cr - cb) * 2.2 - Math.max(0, cg - cr));
          roughVal = Math.min(1, roughVal + rustiness * 0.55);
        }

        const mapped = Math.round((roughMin + roughVal * (roughMax - roughMin)) * 255);
        rOut[outIdx] = mapped;
        rOut[outIdx + 1] = mapped;
        rOut[outIdx + 2] = mapped;
        rOut[outIdx + 3] = 255;
      }
    }
  }

  normalCtx.putImageData(normalImg, 0, 0);
  if (roughCtx && roughImg) {
    roughCtx.putImageData(roughImg, 0, 0);
  }
}

/**
 * Extracts crisp alpha from pitch-black (#000000) botanical scans and runs a
 * 3-pass RGB edge color dilation so hardware mipmaps never produce dark outlines.
 */
function extractBotanicalAlphaAndDilate(
  colorCtx: CanvasRenderingContext2D,
  normalCtx: CanvasRenderingContext2D,
  thresholdLow: number,
  thresholdHigh: number,
  normalStrength: number,
): void {
  const w = colorCtx.canvas.width;
  const h = colorCtx.canvas.height;
  const img = colorCtx.getImageData(0, 0, w, h);
  const data = img.data;
  const pixelCount = w * h;

  const filled = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const idx = i * 4;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const score = maxC + chroma * 0.65;

    const t = Math.max(0, Math.min(1, (score - thresholdLow) / (thresholdHigh - thresholdLow)));
    const alpha = Math.round(t * 255);
    data[idx + 3] = alpha;

    if (alpha >= 115) {
      filled[i] = 1;
      // Gently de-darken semi-edge pixels previously premultiplied against black backdrop
      if (t < 0.98 && t > 0.15) {
        const boost = Math.min(1.65, 1 / Math.max(0.45, t));
        data[idx] = Math.min(255, Math.round(r * boost));
        data[idx + 1] = Math.min(255, Math.round(g * boost));
        data[idx + 2] = Math.min(255, Math.round(b * boost));
      }
    }
  }

  // 3-pass RGB neighbor dilation into transparent pixels to prevent black mipmap fringes
  const nextFilled = new Uint8Array(pixelCount);
  const srcCopy = new Uint8ClampedArray(data.length);

  for (let pass = 0; pass < 3; pass += 1) {
    srcCopy.set(data);
    nextFilled.set(filled);

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pIdx = y * w + x;
        if (filled[pIdx] === 1) {
          continue;
        }

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let count = 0;

        for (let oy = -1; oy <= 1; oy += 1) {
          const ny = y + oy;
          if (ny < 0 || ny >= h) {
            continue;
          }
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox;
            if (nx < 0 || nx >= w || (ox === 0 && oy === 0)) {
              continue;
            }
            const nIdx = ny * w + nx;
            if (filled[nIdx] === 1) {
              const nOff = nIdx * 4;
              sumR += srcCopy[nOff] ?? 0;
              sumG += srcCopy[nOff + 1] ?? 0;
              sumB += srcCopy[nOff + 2] ?? 0;
              count += 1;
            }
          }
        }

        if (count > 0) {
          const outOff = pIdx * 4;
          data[outOff] = Math.round(sumR / count);
          data[outOff + 1] = Math.round(sumG / count);
          data[outOff + 2] = Math.round(sumB / count);
          nextFilled[pIdx] = 1;
        }
      }
    }

    filled.set(nextFilled);
  }

  colorCtx.putImageData(img, 0, 0);
  deriveNormalAndRoughnessFromCanvas(
    colorCtx,
    normalCtx,
    null,
    normalStrength,
    0.75,
    0.95,
    false,
    false,
    false,
  );
}

/**
 * Composites chipped, faded double-yellow highway center stripes & subtle mossy edges
 * directly onto the photorealistic asphalt canvas while letting deep dark cracks
 * break cleanly through the painted lines.
 */
function compositeHighwayMarkings(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const paintYellow = (cxFrac: number, halfW: number, baseAlpha: number, rCol: number, gCol: number, bCol: number): void => {
    const cx = Math.floor(w * cxFrac);
    const minX = Math.max(0, cx - halfW);
    const maxX = Math.min(w - 1, cx + halfW);

    for (let y = 0; y < h; y += 1) {
      const wearWave =
        0.58 + 0.24 * Math.sin(y * 0.031 + cxFrac * 18) + 0.18 * Math.cos(y * 0.079 - cxFrac * 9);
      for (let x = minX; x <= maxX; x += 1) {
        const edgeDist = Math.abs(x - cx) / Math.max(1, halfW);
        const edgeSoft = 1 - Math.max(0, (edgeDist - 0.65) / 0.35);
        const idx = (y * w + x) * 4;
        const sr = data[idx] ?? 0;
        const sg = data[idx + 1] ?? 0;
        const sb = data[idx + 2] ?? 0;
        const lum = (0.299 * sr + 0.587 * sg + 0.114 * sb) / 255;

        // Deep asphalt cracks (lum < 0.20) & mossy green patches break cleanly through the road paint!
        const crackMask = Math.max(0, Math.min(1, (lum - 0.16) / 0.16));
        const mossMask = Math.max(0, Math.min(1, 1 - Math.max(0, (sg - sr) / 28)));
        const grain = 0.78 + 0.22 * Math.sin(x * 1.9 + y * 0.7);
        const blend = Math.max(0, Math.min(0.86, baseAlpha * wearWave * edgeSoft * crackMask * mossMask * grain));

        data[idx] = Math.round(sr * (1 - blend) + rCol * blend);
        data[idx + 1] = Math.round(sg * (1 - blend) + gCol * blend);
        data[idx + 2] = Math.round(sb * (1 - blend) + bCol * blend);
      }
    }
  };

  // Faded weathered double-yellow centerlines + worn shoulder edge markings
  paintYellow(0.476, 5, 0.78, 198, 152, 54);
  paintYellow(0.524, 5, 0.78, 198, 152, 54);
  paintYellow(0.145, 4, 0.28, 165, 162, 146);
  paintYellow(0.855, 4, 0.28, 165, 162, 146);

  // Subtle dark-moss road shoulder feathering at outermost 14% margins
  for (let y = 0; y < h; y += 1) {
    const edgeNoise = Math.sin(y * 0.024) * 0.03 + Math.cos(y * 0.067) * 0.02;
    for (let x = 0; x < w; x += 1) {
      const u = x / w;
      const distEdge = Math.min(u, 1 - u);
      const borderWidth = 0.14 + edgeNoise;
      if (distEdge >= borderWidth) {
        continue;
      }
      const t = 1 - distEdge / borderWidth;
      const blend = t * t * 0.72;
      const idx = (y * w + x) * 4;
      const sr = data[idx] ?? 0;
      const sg = data[idx + 1] ?? 0;
      const sb = data[idx + 2] ?? 0;
      data[idx] = Math.round(sr * (1 - blend) + 46 * blend);
      data[idx + 1] = Math.round(sg * (1 - blend) + 58 * blend);
      data[idx + 2] = Math.round(sb * (1 - blend) + 25 * blend);
    }
  }

  ctx.putImageData(img, 0, 0);
}

/**
 * Applies a realistic weathered paint/oxidation tint onto a photographic rust metal canvas.
 */
function tintRustCanvas(
  ctx: CanvasRenderingContext2D,
  rMul: number,
  gMul: number,
  bMul: number,
  warmRustBoost: number,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  for (let i = 0; i < w * h; i += 1) {
    const idx = i * 4;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const isRust = r > b + 24 ? 1 : 0;

    if (isRust) {
      data[idx] = Math.min(255, Math.round(r * (1 + warmRustBoost * 0.12)));
      data[idx + 1] = Math.min(255, Math.round(g * (1 + warmRustBoost * 0.04)));
      data[idx + 2] = Math.min(255, Math.round(b * 0.94));
    } else {
      data[idx] = Math.min(255, Math.round(r * rMul));
      data[idx + 1] = Math.min(255, Math.round(g * gMul));
      data[idx + 2] = Math.min(255, Math.round(b * bMul));
    }
  }

  ctx.putImageData(img, 0, 0);
}

function createPbrSlot(
  width: number,
  height: number,
  fallbackHex: string,
  fallbackRoughHex: string,
  repeatX: number,
  repeatY: number,
  wrapS: THREE.Wrapping = THREE.RepeatWrapping,
  wrapT: THREE.Wrapping = THREE.RepeatWrapping,
): { set: PbrTextureSet; canvases: CanvasTriple } {
  const color = createCanvas2D(width, height);
  const normal = createCanvas2D(width, height);
  const rough = createCanvas2D(width, height);

  color.ctx.fillStyle = fallbackHex;
  color.ctx.fillRect(0, 0, width, height);
  fillFlatNormal(normal.ctx, width, height);
  rough.ctx.fillStyle = fallbackRoughHex;
  rough.ctx.fillRect(0, 0, width, height);

  const map = finalizeTexture(color.canvas, true, repeatX, repeatY, wrapS, wrapT);
  const normalMap = finalizeTexture(normal.canvas, false, repeatX, repeatY, wrapS, wrapT);
  const roughnessMap = finalizeTexture(rough.canvas, false, repeatX, repeatY, wrapS, wrapT);

  return {
    set: {
      map,
      normalMap,
      roughnessMap,
    },
    canvases: {
      colorCanvas: color.canvas,
      colorCtx: color.ctx,
      normalCanvas: normal.canvas,
      normalCtx: normal.ctx,
      roughCanvas: rough.canvas,
      roughCtx: rough.ctx,
    },
  };
}

function createFoliageSlot(
  width: number,
  height: number,
  fallbackHex: string,
  wrapS: THREE.Wrapping,
  wrapT: THREE.Wrapping,
): { set: AlphaFoliageTextureSet; canvases: FoliageCanvasPair } {
  const color = createCanvas2D(width, height);
  const normal = createCanvas2D(width, height);

  // Subtle dark botanical fallback during ~30ms photo decode
  color.ctx.clearRect(0, 0, width, height);
  color.ctx.fillStyle = fallbackHex;
  color.ctx.fillRect(width * 0.2, height * 0.1, width * 0.6, height * 0.8);
  fillFlatNormal(normal.ctx, width, height);

  const map = finalizeTexture(color.canvas, true, 1, 1, wrapS, wrapT);
  const normalMap = finalizeTexture(normal.canvas, false, 1, 1, wrapS, wrapT);

  return {
    set: {
      map,
      normalMap,
    },
    canvases: {
      colorCanvas: color.canvas,
      colorCtx: color.ctx,
      normalCanvas: normal.canvas,
      normalCtx: normal.ctx,
    },
  };
}

function loadPhotoImage(url: string, onLoad: (img: HTMLImageElement) => void): void {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    onLoad(img);
  };
  img.onerror = () => {
    // Keep clean dark synchronous fallback if asset path is unavailable in tests
  };
  img.src = url;
}

let cachedAtlas: WorldTextureAtlas | null = null;

export function getWorldTextureAtlas(): WorldTextureAtlas {
  if (cachedAtlas) {
    return cachedAtlas;
  }

  let disposed = false;

  const highwaySlot = createPbrSlot(
    512,
    1024,
    '#2e312f',
    '#c8c8c8',
    1,
    1,
    THREE.ClampToEdgeWrapping,
    THREE.RepeatWrapping,
  );
  const forestSlot = createPbrSlot(512, 512, '#2b281e', '#e2e2e2', 26, 26);
  const concreteSlot = createPbrSlot(512, 512, '#64645c', '#d8d8d8', 2, 2);
  const mossyRockSlot = createPbrSlot(512, 512, '#444b3c', '#dcdcdc', 2, 2);
  const rustVanSlot = createPbrSlot(512, 512, '#4a514c', '#b4b4b4', 1, 1);
  const rustSedanSlot = createPbrSlot(512, 512, '#5a4e40', '#c0c0c0', 1, 1);
  const rustDarkSlot = createPbrSlot(512, 512, '#3d4543', '#c8c8c8', 1, 1);
  const pineBarkSlot = createPbrSlot(512, 512, '#2d2119', '#e6e6e6', 1, 3);
  const fabricOliveSlot = createPbrSlot(512, 512, '#485038', '#dcdcdc', 3, 3);

  const pineBoughSlot = createFoliageSlot(
    512,
    512,
    '#25391c',
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
  );
  const ivySlot = createFoliageSlot(
    512,
    512,
    '#283d1b',
    THREE.RepeatWrapping,
    THREE.ClampToEdgeWrapping,
  );
  const fernSlot = createFoliageSlot(
    512,
    512,
    '#2d461d',
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
  );

  const markPbrDirty = (set: PbrTextureSet): void => {
    set.map.needsUpdate = true;
    set.normalMap.needsUpdate = true;
    set.roughnessMap.needsUpdate = true;
  };

  const markFoliageDirty = (set: AlphaFoliageTextureSet): void => {
    set.map.needsUpdate = true;
    set.normalMap.needsUpdate = true;
  };

  // 1. Cracked mossy asphalt + weathered double-yellow highway center stripes
  loadPhotoImage('./textures/asphalt.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = highwaySlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    colorCtx.drawImage(img, 0, 512, 512, 512);
    compositeHighwayMarkings(colorCtx);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 2.8, 0.56, 0.96, true, true);
    markPbrDirty(highwaySlot.set);
  });

  // 2. Pacific Northwest pine-needle forest floor
  loadPhotoImage('./textures/forest_floor.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = forestSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 3.0, 0.78, 0.99, true, true);
    markPbrDirty(forestSlot.set);
  });

  // 3. Crumbling rain-streaked mossy concrete
  loadPhotoImage('./textures/concrete.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = concreteSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 2.6, 0.68, 0.97, true, true);
    markPbrDirty(concreteSlot.set);
  });

  // 4. Moss-covered volcanic Pacific Northwest boulder stone
  loadPhotoImage('./textures/mossy_rock.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = mossyRockSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 3.4, 0.64, 0.98, true, true);
    markPbrDirty(mossyRockSlot.set);
  });

  // 5. Three weathered oxidized vehicle rust metal variants derived from rust_metal.jpg
  loadPhotoImage('./textures/rust_metal.jpg', (img) => {
    if (disposed) {
      return;
    }
    // Variant A: Faded olive-slate van
    rustVanSlot.canvases.colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(
      rustVanSlot.canvases.colorCtx,
      rustVanSlot.canvases.normalCtx,
      rustVanSlot.canvases.roughCtx,
      2.9,
      0.46,
      0.95,
      true,
      true,
      true,
    );
    markPbrDirty(rustVanSlot.set);

    // Variant B: Oxidized burnt-taupe / weathered sienna sedan
    rustSedanSlot.canvases.colorCtx.drawImage(img, 0, 0, 512, 512);
    tintRustCanvas(rustSedanSlot.canvases.colorCtx, 1.18, 0.98, 0.82, 1.25);
    deriveNormalAndRoughnessFromCanvas(
      rustSedanSlot.canvases.colorCtx,
      rustSedanSlot.canvases.normalCtx,
      rustSedanSlot.canvases.roughCtx,
      3.1,
      0.5,
      0.96,
      true,
      true,
      true,
    );
    markPbrDirty(rustSedanSlot.set);

    // Variant C: Deep weathered muted-teal / slate wreck
    rustDarkSlot.canvases.colorCtx.drawImage(img, 0, 0, 512, 512);
    tintRustCanvas(rustDarkSlot.canvases.colorCtx, 0.78, 0.92, 0.96, 1.0);
    deriveNormalAndRoughnessFromCanvas(
      rustDarkSlot.canvases.colorCtx,
      rustDarkSlot.canvases.normalCtx,
      rustDarkSlot.canvases.roughCtx,
      3.1,
      0.52,
      0.96,
      true,
      true,
      true,
    );
    markPbrDirty(rustDarkSlot.set);
  });

  // 6. Deeply furrowed Douglas-fir bark
  loadPhotoImage('./textures/pine_bark.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = pineBarkSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 3.8, 0.82, 0.99, true, true);
    markPbrDirty(pineBarkSlot.set);
  });

  // 7. Rugged woven olive survivor field-jacket canvas
  loadPhotoImage('./textures/fabric_olive.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx, roughCtx } = fabricOliveSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    deriveNormalAndRoughnessFromCanvas(colorCtx, normalCtx, roughCtx, 2.2, 0.78, 0.98, false, true);
    markPbrDirty(fabricOliveSlot.set);
  });

  // 8. Isolated botanical Douglas-fir pine bough (anti-fringed alpha + 3-pass dilation + normalMap)
  loadPhotoImage('./textures/pine_branch.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx } = pineBoughSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    extractBotanicalAlphaAndDilate(colorCtx, normalCtx, 14, 42, 2.4);
    markFoliageDirty(pineBoughSlot.set);
  });

  // 9. Isolated botanical cascading English ivy curtains
  loadPhotoImage('./textures/ivy_vines.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx } = ivySlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    extractBotanicalAlphaAndDilate(colorCtx, normalCtx, 15, 44, 2.2);
    markFoliageDirty(ivySlot.set);
  });

  // 10. Isolated botanical western sword fern frond
  loadPhotoImage('./textures/fern_frond.jpg', (img) => {
    if (disposed) {
      return;
    }
    const { colorCtx, normalCtx } = fernSlot.canvases;
    colorCtx.drawImage(img, 0, 0, 512, 512);
    extractBotanicalAlphaAndDilate(colorCtx, normalCtx, 15, 44, 2.1);
    markFoliageDirty(fernSlot.set);
  });

  const pbrSets: PbrTextureSet[] = [
    highwaySlot.set,
    forestSlot.set,
    concreteSlot.set,
    mossyRockSlot.set,
    rustVanSlot.set,
    rustSedanSlot.set,
    rustDarkSlot.set,
    pineBarkSlot.set,
    fabricOliveSlot.set,
  ];
  const foliageSets: AlphaFoliageTextureSet[] = [
    pineBoughSlot.set,
    ivySlot.set,
    fernSlot.set,
  ];

  cachedAtlas = {
    highway: highwaySlot.set,
    forestFloor: forestSlot.set,
    concrete: concreteSlot.set,
    mossyRock: mossyRockSlot.set,
    rustVan: rustVanSlot.set,
    rustSedan: rustSedanSlot.set,
    rustDark: rustDarkSlot.set,
    pineBark: pineBarkSlot.set,
    fabricOlive: fabricOliveSlot.set,
    pineBough: pineBoughSlot.set,
    ivyCurtain: ivySlot.set,
    fernFrond: fernSlot.set,
    dispose(): void {
      disposed = true;
      for (const set of pbrSets) {
        set.map.dispose();
        set.normalMap.dispose();
        set.roughnessMap.dispose();
      }
      for (const set of foliageSets) {
        set.map.dispose();
        set.normalMap.dispose();
      }
      cachedAtlas = null;
    },
  };

  return cachedAtlas;
}
