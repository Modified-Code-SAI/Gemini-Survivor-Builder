import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { GraphicsQuality } from '../engine/renderer';
import type { AtmosphereSnapshot } from '../systems/atmosphere';
import { collectMaterialTextures, loadOptionalGlbSlot } from './assetLoader';
import {
  createObbObstacle,
  getRoadCenterX,
  getRoadFactor,
  getRoadTangentAngle,
  getTerrainHeight,
  smoothstep,
  SPAWN_POINT,
  type Obstacle,
} from './terrain';
import { getWorldTextureAtlas, type PbrTextureSet } from './textures';

export interface SpatialRuinCue {
  readonly proximity: number;
  readonly sourceX: number;
  readonly sourceZ: number;
}

export interface FrontierEnvironment {
  readonly root: THREE.Group;
  readonly obstacles: readonly Obstacle[];
  isInsidePuddle(x: number, z: number): boolean;
  getWindIntensity(elapsed: number): number;
  sampleRuinMetalProximity(x: number, z: number, out: { proximity: number; sourceX: number; sourceZ: number }): void;
  update(elapsed: number, dt: number, atmosphere?: AtmosphereSnapshot): void;
  setQuality(quality: GraphicsQuality): void;
  dispose(): void;
}

interface SwayItem {
  readonly mesh: THREE.Object3D;
  readonly baseRotX: number;
  readonly baseRotZ: number;
  readonly phase: number;
  readonly amp: number;
}

interface MistCard {
  readonly mesh: THREE.Mesh;
  readonly baseX: number;
  readonly phase: number;
  readonly driftAmp: number;
}

interface PuddleZone {
  readonly x: number;
  readonly z: number;
  readonly rx: number;
  readonly rz: number;
}

interface MirrorPuddlePair {
  readonly reflector: Reflector;
  readonly fallback: THREE.Mesh;
  readonly timeUniform: { value: number };
  readonly sunDirUniform: { value: THREE.Vector3 };
  readonly fogColorUniform: { value: THREE.Color };
  readonly fogDensityUniform: { value: number };
  readonly reflectStrengthUniform: { value: number };
  readonly nightFactorUniform: { value: number };
  readonly cloudCoverUniform: { value: number };
}

interface WindUniforms {
  readonly uWindTime: { value: number };
  readonly uWindStrength: { value: number };
}

type WindMode = 'pine' | 'fern' | 'grass';

/**
 * Custom GLSL shader for real-time planar mirror rainwater puddles (Three.js Reflector).
 * Reflects actual 3D pines, golden sunset clouds, utility poles, and crumbling concrete ruins
 * with animated wind ripples, Fresnel water depth, warm sun glints, and strict 0.0 edge fade.
 */
const PLANAR_MIRROR_PUDDLE_VERTEX = /* glsl */ `
  uniform mat4 textureMatrix;
  attribute float aEdge;
  varying vec4 vReflectUv;
  varying vec3 vWorldPos;
  varying float vEdge;

  void main() {
    vEdge = aEdge;
    vReflectUv = textureMatrix * vec4(position, 1.0);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PLANAR_MIRROR_PUDDLE_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uReflectStrength;
  uniform float uNightFactor;
  uniform float uCloudCover;

  varying vec4 vReflectUv;
  varying vec3 vWorldPos;
  varying float vEdge;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.1 + vec2(11.3, 23.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float rimFade = 1.0 - smoothstep(0.82, 1.0, vEdge);
    if (rimFade <= 0.001) {
      discard;
    }

    float edgeNoise = (fbm(vWorldPos.xz * 1.55) - 0.5) * 0.26;
    float d = vEdge + edgeNoise;
    if (d > 1.0) {
      discard;
    }

    float waterMask = (1.0 - smoothstep(0.64, 0.82, d)) * rimFade;
    float dampRing = (1.0 - smoothstep(0.74, 1.0, d)) * rimFade;

    // Wind-driven surface micro-ripples perturbing live planar reflection UV and normal
    vec2 p = vWorldPos.xz;
    float r1 = sin(p.x * 4.8 + p.y * 3.2 + uTime * 1.45) * cos(p.y * 5.4 - uTime * 0.95);
    float r2 = sin(p.x * 9.2 - p.y * 7.1 - uTime * 1.85) * 0.45;
    vec2 ripple = vec2(r1 + r2, r1 - r2);
    vec3 N = normalize(vec3(ripple.x * 0.017, 1.0, ripple.y * 0.017));

    vec4 projUv = vReflectUv;
    projUv.xy += ripple * 0.011 * projUv.w;
    // Attenuate reflection energy so shallow puddles read as glossy dark rainwater rather than chalky cream
    vec3 reflColor = texture2DProj(tDiffuse, projUv).rgb * 0.64;

    vec3 viewVec = cameraPosition - vWorldPos;
    float viewDist = length(viewVec);
    vec3 V = viewVec / max(0.001, viewDist);
    vec3 R = reflect(-V, N);
    vec3 sunDir = normalize(uSunDir);

    // Physical Schlick Fresnel: dark translucent wet asphalt at steep angles, rich dark-pine & sky mirror at grazing angles
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = mix(0.08, 0.92, pow(1.0 - ndotv, 3.8)) * uReflectStrength;

    // Sun/moon specular sparkles attenuated cleanly during night & heavy storm clouds
    float stormCover = clamp((uCloudCover - 0.25) / 0.75, 0.0, 1.0);
    float glintAtten = (1.0 - uNightFactor * 0.88) * (1.0 - stormCover * 0.72);
    vec3 glintTint = mix(vec3(1.0, 0.82, 0.48), vec3(0.58, 0.72, 0.96), uNightFactor);
    float sunAlign = max(dot(R, sunDir), 0.0);
    float sunGlint = pow(sunAlign, 120.0) * 1.9 + pow(sunAlign, 22.0) * 0.28;
    reflColor += glintTint * sunGlint * glintAtten;

    // Linear-space dark wet smoky asphalt & shallow rainwater bed (darkens cleanly into midnight slate)
    vec3 wetAsphalt = mix(vec3(0.018, 0.020, 0.017), vec3(0.005, 0.007, 0.011), uNightFactor);
    vec3 darkWaterBed = mix(vec3(0.026, 0.029, 0.024), vec3(0.008, 0.011, 0.017), uNightFactor);
    vec3 waterColor = mix(darkWaterBed, reflColor, clamp(fresnel, 0.0, 0.94));

    vec3 finalColor = mix(wetAsphalt, waterColor, waterMask);
    // Steep viewing angles stay semi-translucent (0.48..0.64) so cracked asphalt & yellow stripes peek subtly beneath
    float waterAlpha = mix(0.50, 0.93, clamp(fresnel, 0.0, 1.0));
    float alpha = max(dampRing * 0.50, waterMask * waterAlpha) * rimFade;

    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
    finalColor = mix(finalColor, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Fallback/distant rainwater puddle shader (analytical sunset sky + cloud + forest Fresnel mirror
 * with strict 0.0 perimeter rim fade and linear-space matched exponential fog).
 */
const PUDDLE_VERTEX_SHADER = /* glsl */ `
  attribute float aEdge;
  varying float vEdge;
  varying vec3 vWorldPos;

  void main() {
    vEdge = aEdge;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PUDDLE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uReflectStrength;
  uniform float uNightFactor;
  uniform float uCloudCover;

  varying float vEdge;
  varying vec3 vWorldPos;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.1 + vec2(11.3, 23.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float rimFade = 1.0 - smoothstep(0.84, 1.0, vEdge);
    if (rimFade <= 0.001) {
      discard;
    }

    float edgeNoise = (fbm(vWorldPos.xz * 1.45) - 0.5) * 0.28;
    float d = vEdge + edgeNoise;
    if (d > 1.0) {
      discard;
    }

    float waterMask = (1.0 - smoothstep(0.66, 0.84, d)) * rimFade;
    float dampRing = (1.0 - smoothstep(0.76, 1.0, d)) * rimFade;

    vec2 p = vWorldPos.xz;
    float r1 = sin(p.x * 4.2 + p.y * 2.8 + uTime * 1.35) * cos(p.y * 5.1 - uTime * 0.9);
    float r2 = sin(p.x * 8.6 - p.y * 6.4 - uTime * 1.75) * 0.5;
    vec3 N = normalize(vec3((r1 + r2) * 0.018, 1.0, (r1 - r2) * 0.018));

    vec3 viewVec = cameraPosition - vWorldPos;
    float viewDist = length(viewVec);
    vec3 V = viewVec / max(0.001, viewDist);
    vec3 R = reflect(-V, N);
    vec3 sunDir = normalize(uSunDir);

    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = mix(0.07, 0.90, pow(1.0 - ndotv, 4.0)) * uReflectStrength;

    float stormCover = clamp((uCloudCover - 0.25) / 0.75, 0.0, 1.0);
    float rUp = clamp(R.y, 0.0, 1.0);

    vec3 dayHorizon = mix(vec3(0.58, 0.36, 0.14), vec3(0.14, 0.17, 0.21), stormCover * 0.85);
    vec3 dayMid = mix(vec3(0.28, 0.19, 0.11), vec3(0.09, 0.11, 0.14), stormCover * 0.85);
    vec3 dayZenith = mix(vec3(0.04, 0.07, 0.08), vec3(0.03, 0.04, 0.06), stormCover * 0.8);

    vec3 nightHorizon = vec3(0.022, 0.036, 0.068);
    vec3 nightMid = vec3(0.011, 0.019, 0.042);
    vec3 nightZenith = vec3(0.004, 0.008, 0.018);

    vec3 skyHorizon = mix(dayHorizon, nightHorizon, uNightFactor);
    vec3 skyMid = mix(dayMid, nightMid, uNightFactor);
    vec3 skyZenith = mix(dayZenith, nightZenith, uNightFactor);

    vec3 reflSky = mix(skyHorizon, skyMid, smoothstep(0.0, 0.25, rUp));
    reflSky = mix(reflSky, skyZenith, smoothstep(0.2, 0.78, rUp));

    vec2 cUv = R.xz / (rUp + 0.26) * 0.95 + vec2(uTime * 0.003, 0.0);
    float cloud = smoothstep(0.42, 0.76, fbm(cUv * 1.6));
    vec3 dayCloud = mix(vec3(0.66, 0.46, 0.20), vec3(0.12, 0.14, 0.18), stormCover * 0.88);
    vec3 nightCloud = vec3(0.025, 0.038, 0.064);
    reflSky = mix(reflSky, mix(dayCloud, nightCloud, uNightFactor), cloud * 0.38);

    float sideCanopy = smoothstep(0.24, 0.64, abs(R.x)) * (1.0 - smoothstep(0.18, 0.55, rUp));
    vec3 canopySilhouette = mix(vec3(0.014, 0.022, 0.012), vec3(0.004, 0.007, 0.009), uNightFactor);
    reflSky = mix(reflSky, canopySilhouette, sideCanopy * 0.82);

    float sunVis = (1.0 - uNightFactor * 0.90) * (1.0 - stormCover * 0.78);
    float sunAlign = max(dot(R, sunDir), 0.0);
    float sunGlow = pow(sunAlign, 18.0) * 0.65;
    float sunGlint = pow(sunAlign, 110.0) * 1.55;
    vec3 glowTint = mix(vec3(1.0, 0.66, 0.24), vec3(0.45, 0.60, 0.88), uNightFactor);
    vec3 glintTint = mix(vec3(1.0, 0.86, 0.54), vec3(0.62, 0.76, 0.96), uNightFactor);
    reflSky += (glowTint * sunGlow + glintTint * sunGlint) * sunVis;

    vec3 wetAsphalt = mix(vec3(0.018, 0.020, 0.017), vec3(0.005, 0.007, 0.011), uNightFactor);
    vec3 darkWaterBed = mix(vec3(0.026, 0.029, 0.024), vec3(0.008, 0.011, 0.017), uNightFactor);
    vec3 waterColor = mix(darkWaterBed, reflSky, clamp(fresnel, 0.0, 0.94));

    vec3 finalColor = mix(wetAsphalt, waterColor, waterMask);
    float waterAlpha = mix(0.48, 0.92, clamp(fresnel, 0.0, 1.0));
    float alpha = max(dampRing * 0.50, waterMask * waterAlpha) * rimFade;

    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
    finalColor = mix(finalColor, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Injects lightweight GPU vertex wind waves onto instanced foliage materials
 * (Douglas-fir boughs, sword ferns, wild grass) with zero per-frame CPU overhead.
 */
function injectGpuWind(
  material: THREE.MeshStandardMaterial,
  windUniforms: WindUniforms,
  mode: WindMode,
  amplitude: number,
  frequency: number,
): void {
  material.customProgramCacheKey = () =>
    `frontier_wind_${mode}_${amplitude.toFixed(4)}_${frequency.toFixed(2)}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uWindTime'] = windUniforms.uWindTime;
    shader.uniforms['uWindStrength'] = windUniforms.uWindStrength;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
        #include <common>
        uniform float uWindTime;
        uniform float uWindStrength;
      `,
    );

    let weightSnippet: string;
    if (mode === 'pine') {
      // Anchor trunk root & inner bough base; sway outer branch tips and upper spires
      weightSnippet = 'float windWeight = clamp(uv.y, 0.0, 1.0) * smoothstep(0.18, 0.96, position.y);';
    } else if (mode === 'fern') {
      // Anchor stem base at rosette center (uv.y = 0); ripple outer arching frond tips
      weightSnippet = 'float windWeight = clamp(uv.y * uv.y, 0.0, 1.0);';
    } else {
      // Anchor grass blade roots at y = 0; bend upper tips smoothly in gusts
      weightSnippet = 'float gw = clamp(position.y * 2.2, 0.0, 1.0); float windWeight = gw * gw;';
    }

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
        #include <begin_vertex>
        {
          vec4 windBasePos = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            windBasePos = instanceMatrix * windBasePos;
          #endif
          vec4 windWorldPos = modelMatrix * windBasePos;
          ${weightSnippet}
          float gustEnvelope = 0.55 + 0.45 * sin(uWindTime * 0.58 - windWorldPos.x * 0.042 - windWorldPos.z * 0.036);
          float mainWave = sin(uWindTime * ${frequency.toFixed(2)} + windWorldPos.x * 0.24 + windWorldPos.z * 0.19);
          float flutter = cos(uWindTime * ${(frequency * 1.95).toFixed(2)} + windWorldPos.x * 0.61 - windWorldPos.z * 0.52) * 0.34;
          float disp = (mainWave + flutter) * gustEnvelope * uWindStrength * ${amplitude.toFixed(4)} * windWeight;
          transformed.x += disp;
          transformed.z += disp * 0.62;
          transformed.y -= abs(disp) * 0.18;
        }
      `,
    );
  };
}

function disposeObject3D(
  root: THREE.Object3D,
  excludeMaterials?: ReadonlySet<THREE.Material>,
): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();

  root.traverse((node: THREE.Object3D) => {
    if (node instanceof THREE.SkinnedMesh && node.skeleton) {
      skeletons.add(node.skeleton);
    }
    if (node instanceof Reflector) {
      node.dispose();
      if (node.geometry instanceof THREE.BufferGeometry) {
        geometries.add(node.geometry);
      }
      return;
    }
    if (node instanceof THREE.InstancedMesh) {
      node.dispose();
    }
    if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
      if (node.geometry instanceof THREE.BufferGeometry) {
        geometries.add(node.geometry);
      }
      const mat = node.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          if (m instanceof THREE.Material && !excludeMaterials?.has(m)) {
            materials.add(m);
            collectMaterialTextures(m, textures);
          }
        }
      } else if (mat instanceof THREE.Material && !excludeMaterials?.has(mat)) {
        materials.add(mat);
        collectMaterialTextures(mat, textures);
      }
    }
  });

  for (const skel of skeletons) {
    skel.dispose();
  }
  for (const tex of textures) {
    tex.dispose();
  }
  for (const geo of geometries) {
    geo.dispose();
  }
  for (const mat of materials) {
    mat.dispose();
  }
}

/**
 * Clones a loaded GLB hierarchy sharing BufferGeometries and textures while cloning materials
 * to apply a subtle per-instance weathered color tint.
 */
function applyTintedMaterials(root: THREE.Object3D, tintHex: number, cloneMaterials: boolean): void {
  const tint = new THREE.Color(tintHex);
  const clonedMap = new Map<THREE.Material, THREE.Material>();

  const mapMaterial = (mat: THREE.Material): THREE.Material => {
    if (!cloneMaterials) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.multiply(tint);
      }
      return mat;
    }
    const existing = clonedMap.get(mat);
    if (existing) {
      return existing;
    }
    const copy = mat.clone();
    if (copy instanceof THREE.MeshStandardMaterial) {
      copy.color.multiply(tint);
    }
    clonedMap.set(mat, copy);
    return copy;
  };

  root.traverse((node: THREE.Object3D) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const mat = node.material;
    if (Array.isArray(mat)) {
      node.material = mat.map((m) => (m instanceof THREE.Material ? mapMaterial(m) : m));
    } else if (mat instanceof THREE.Material) {
      node.material = mapMaterial(mat);
    }
  });
}

function disposeChildrenAndPruneSway(
  parent: THREE.Object3D,
  swayItems: SwayItem[],
  sharedMaterials: ReadonlySet<THREE.Material>,
): void {
  const removed = new Set<THREE.Object3D>();
  const geometries = new Set<THREE.BufferGeometry>();
  const localMaterials = new Set<THREE.Material>();

  parent.traverse((node: THREE.Object3D) => {
    if (node === parent) {
      return;
    }
    removed.add(node);
    if (node instanceof THREE.InstancedMesh) {
      node.dispose();
    }
    if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
      if (node.geometry instanceof THREE.BufferGeometry) {
        geometries.add(node.geometry);
      }
      const mat = node.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          if (m instanceof THREE.Material && !sharedMaterials.has(m)) {
            localMaterials.add(m);
          }
        }
      } else if (mat instanceof THREE.Material && !sharedMaterials.has(mat)) {
        localMaterials.add(mat);
      }
    }
  });

  for (let i = swayItems.length - 1; i >= 0; i -= 1) {
    const item = swayItems[i];
    if (item && removed.has(item.mesh)) {
      swayItems.splice(i, 1);
    }
  }

  parent.clear();
  for (const geo of geometries) {
    geo.dispose();
  }
  for (const mat of localMaterials) {
    mat.dispose();
  }
}

function createStandardMaterial(
  textures: PbrTextureSet,
  options: {
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    vertexColors?: boolean;
    polygonOffset?: boolean;
    side?: THREE.Side;
  } = {},
): THREE.MeshStandardMaterial {
  const ns = options.normalScale ?? 1.15;
  return new THREE.MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(ns, ns),
    roughnessMap: textures.roughnessMap,
    roughness: options.roughness ?? 1.0,
    metalness: options.metalness ?? 0.04,
    vertexColors: options.vertexColors ?? false,
    polygonOffset: options.polygonOffset ?? false,
    polygonOffsetFactor: options.polygonOffset ? -1 : 0,
    polygonOffsetUnits: options.polygonOffset ? -2 : 0,
    side: options.side ?? THREE.FrontSide,
  });
}

type TreeSpecies = 'douglas_fir' | 'spruce' | 'broad_pine' | 'alder' | 'dead_snag';

interface TreeClusterAnchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly heightScale: number;
}

interface TrunkBuilderBuffers {
  readonly positions: number[];
  readonly uvs: number[];
  readonly colors: number[] | null;
  readonly indices: number[];
}

/**
 * Appends a smooth, parallel-transported tapered wooden trunk or curved branch tube
 * with outward-facing CCW winding and optional base root-buttress fluting.
 */
function appendTaperedLimb(
  buf: TrunkBuilderBuffers,
  points: ReadonlyArray<readonly [number, number, number, number]>,
  radialSegs: number,
  uvScaleV: number,
  fluteAmp = 0,
  fluteLobes = 5,
  flutePhase = 0,
  capTip = false,
  colorFn?: (t: number, y: number, radialAngle: number) => readonly [number, number, number],
): void {
  const n = points.length;
  if (n < 2) {
    return;
  }

  const baseVertex = buf.positions.length / 3;
  const stride = radialSegs + 1;

  let prevUx = 1;
  let prevUy = 0;
  let prevUz = 0;
  let arcLen = 0;

  for (let i = 0; i < n; i += 1) {
    const curr = points[i];
    if (!curr) {
      continue;
    }
    const [px, py, pz, baseR] = curr;
    const t = i / (n - 1);

    if (i > 0) {
      const prev = points[i - 1];
      if (prev) {
        arcLen += Math.hypot(px - prev[0], py - prev[1], pz - prev[2]);
      }
    }

    const pPrev = points[Math.max(0, i - 1)] ?? curr;
    const pNext = points[Math.min(n - 1, i + 1)] ?? curr;
    let tx = pNext[0] - pPrev[0];
    let ty = pNext[1] - pPrev[1];
    let tz = pNext[2] - pPrev[2];
    const tLen = Math.hypot(tx, ty, tz);
    if (tLen > 1e-6) {
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;
    } else {
      tx = 0;
      ty = 1;
      tz = 0;
    }

    let ux: number;
    let uy: number;
    let uz: number;
    if (i === 0) {
      const refX = Math.abs(ty) < 0.9 ? 0 : 1;
      const refY = Math.abs(ty) < 0.9 ? 1 : 0;
      const refZ = 0;
      // U = normalize(ref x T)
      ux = refY * tz - refZ * ty;
      uy = refZ * tx - refX * tz;
      uz = refX * ty - refY * tx;
    } else {
      // Parallel transport previous U perpendicular to T
      const dot = prevUx * tx + prevUy * ty + prevUz * tz;
      ux = prevUx - tx * dot;
      uy = prevUy - ty * dot;
      uz = prevUz - tz * dot;
    }

    let uLen = Math.hypot(ux, uy, uz);
    if (uLen < 1e-5) {
      const refX = Math.abs(ty) < 0.9 ? 0 : 1;
      const refY = Math.abs(ty) < 0.9 ? 1 : 0;
      ux = refY * tz;
      uy = -refX * tz;
      uz = refX * ty - refY * tx;
      uLen = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
    prevUx = ux;
    prevUy = uy;
    prevUz = uz;

    // V = T x U so that U x V = T (right-handed outward winding)
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;

    const flareFade = i === 0 ? 1.0 : i === 1 ? 0.36 : 0.0;
    const vCoord = arcLen * uvScaleV;

    for (let s = 0; s <= radialSegs; s += 1) {
      const frac = s / radialSegs;
      const theta = frac * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const lobe =
        fluteAmp > 0 && flareFade > 0
          ? 1 + fluteAmp * flareFade * Math.cos(theta * fluteLobes + flutePhase)
          : 1;
      const r = Math.max(0.001, baseR * lobe);

      const dx = cosT * ux + sinT * vx;
      const dy = cosT * uy + sinT * vy;
      const dz = cosT * uz + sinT * vz;

      buf.positions.push(px + dx * r, py + dy * r, pz + dz * r);
      buf.uvs.push(frac, vCoord);
      if (buf.colors) {
        if (colorFn) {
          const [cr, cg, cb] = colorFn(t, py, theta);
          buf.colors.push(cr, cg, cb);
        } else {
          buf.colors.push(1, 1, 1);
        }
      }
    }
  }

  for (let i = 0; i < n - 1; i += 1) {
    const rowA = baseVertex + i * stride;
    const rowB = rowA + stride;
    for (let s = 0; s < radialSegs; s += 1) {
      const a = rowA + s;
      const b = a + 1;
      const c = rowB + s;
      const d = c + 1;
      buf.indices.push(a, b, c, b, d, c);
    }
  }

  if (capTip) {
    const last = points[n - 1];
    if (last) {
      const tipIdx = buf.positions.length / 3;
      const topRow = baseVertex + (n - 1) * stride;
      buf.positions.push(last[0], last[1], last[2]);
      buf.uvs.push(0.5, arcLen * uvScaleV);
      if (buf.colors) {
        if (colorFn) {
          const [cr, cg, cb] = colorFn(1, last[1], 0);
          buf.colors.push(cr, cg, cb);
        } else {
          buf.colors.push(1, 1, 1);
        }
      }
      for (let s = 0; s < radialSegs; s += 1) {
        buf.indices.push(tipIdx, topRow + s, topRow + s + 1);
      }
    }
  }
}

function finalizeTrunkGeometry(buf: TrunkBuilderBuffers): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uvs, 2));
  if (buf.colors) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  }
  geo.setIndex(buf.indices);
  geo.computeVertexNormals();
  return geo;
}

interface FoliageCardBuffers {
  readonly positions: number[];
  readonly uvs: number[];
  readonly colors: number[];
  readonly indices: number[];
}

function appendCurvedBoughCard(
  buf: FoliageCardBuffers,
  originX: number,
  originY: number,
  originZ: number,
  yaw: number,
  length: number,
  halfWidth: number,
  archRise: number,
  tipDroop: number,
  roll: number,
  innerShade: number,
  outerShade: number,
  tintR: number,
  tintG: number,
  tintB: number,
): void {
  const vOffset = buf.positions.length / 3;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  // Stem base sits at uv.y = 0 (branch anchor), outer tip at uv.y = 1 (wind-swept edge)
  const rows: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [0.0, 0.018, halfWidth * 0.44, 0.0, innerShade],
    [0.48, archRise, halfWidth * 1.04, 0.5, (innerShade + outerShade) * 0.54],
    [1.0, tipDroop, halfWidth * 0.74, 1.0, outerShade],
  ];

  for (const [tDist, dy, hw, vCoord, shade] of rows) {
    const dist = tDist * length;
    for (const side of [-1, 1]) {
      const localSide = side * hw;
      const lx = localSide * cosR;
      const ly = originY + dy + localSide * sinR;
      const lz = dist;

      const wx = originX + lx * cosY + lz * sinY;
      const wz = originZ - lx * sinY + lz * cosY;

      buf.positions.push(wx, ly, wz);
      buf.uvs.push(side === -1 ? 0 : 1, vCoord);
      buf.colors.push(tintR * shade, tintG * shade, tintB * shade);
    }
  }

  buf.indices.push(vOffset, vOffset + 1, vOffset + 2);
  buf.indices.push(vOffset + 1, vOffset + 3, vOffset + 2);
  buf.indices.push(vOffset + 2, vOffset + 3, vOffset + 4);
  buf.indices.push(vOffset + 3, vOffset + 5, vOffset + 4);
}

function finalizeFoliageGeometry(buf: FoliageCardBuffers): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  geo.setIndex(buf.indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Archetype 1: Towering Old-Growth Douglas Fir trunk with flared root buttresses
 * and self-pruned bare weathered lower dead-branch stubs below the green crown.
 */
function createDouglasFirTrunkGeometry(): THREE.BufferGeometry {
  const buf: TrunkBuilderBuffers = { positions: [], uvs: [], colors: null, indices: [] };

  appendTaperedLimb(
    buf,
    [
      [0.0, 0.0, 0.0, 0.036],
      [0.002, 0.09, -0.001, 0.027],
      [0.005, 0.24, -0.002, 0.023],
      [0.004, 0.44, 0.003, 0.018],
      [-0.002, 0.64, 0.005, 0.013],
      [-0.005, 0.81, 0.003, 0.008],
      [-0.004, 0.94, 0.001, 0.0035],
    ],
    7,
    2.4,
    0.26,
    5,
    0.4,
    true,
  );

  // 5 weathered lower dead-branch stubs jutting asymmetrically beneath the lower green crown
  const stubs: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.145, 0.35, 0.078, -0.018],
    [0.195, 2.48, 0.092, -0.022],
    [0.242, 4.42, 0.086, -0.016],
    [0.285, 1.38, 0.072, -0.012],
    [0.328, 3.55, 0.068, -0.01],
  ];
  for (const [sy, yaw, len, droop] of stubs) {
    const cx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    appendTaperedLimb(
      buf,
      [
        [cx * 0.012, sy, cz * 0.012, 0.0075],
        [cx * len * 0.55, sy + droop * 0.4 + 0.006, cz * len * 0.55, 0.0048],
        [cx * len, sy + droop, cz * len, 0.0022],
      ],
      4,
      2.6,
      0,
      0,
      0,
      true,
    );
  }

  return finalizeTrunkGeometry(buf);
}

/**
 * Archetype 1 Canopy: Asymmetrical towering Pacific Northwest Douglas-fir crown
 * rising cleanly above the bare lower dead-branch stubs.
 */
function createDouglasFirCanopyGeometry(): THREE.BufferGeometry {
  const rng = createRng(74129);
  const buf: FoliageCardBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  const whorls = 9;
  for (let w = 0; w < whorls; w += 1) {
    const t = w / (whorls - 1);
    const yBase = 0.27 + t * 0.66;
    const envelope = Math.pow(1 - t, 0.74);
    const boughCount = w < 4 ? 7 : w < 7 ? 6 : 5;
    const baseYawOffset = w * 0.79;

    for (let b = 0; b < boughCount; b += 1) {
      // Leave occasional natural wind-pruned crown gaps
      if (w > 0 && w < 7 && rng() < 0.09) {
        continue;
      }
      const yaw = baseYawOffset + (b / boughCount) * Math.PI * 2 + (rng() - 0.5) * 0.42;
      const lenJitter = 0.74 + rng() * 0.48;
      const boughLen = (0.048 + envelope * 0.172) * lenJitter;
      const halfWidth = boughLen * (0.5 + rng() * 0.19);
      const archRise = (0.012 + (1 - t) * 0.016) * (0.7 + rng() * 0.5);
      const tipDroop = -0.048 * (1 - t * 1.15) + (rng() - 0.5) * 0.018;
      const roll = (b % 2 === 0 ? 1 : -1) * (0.28 + rng() * 0.36);

      const innerShade = 0.45 + t * 0.22;
      const outerShade = 0.85 + t * 0.28 + (rng() - 0.5) * 0.12;

      appendCurvedBoughCard(
        buf,
        0,
        yBase + (rng() - 0.5) * 0.028,
        0,
        yaw,
        boughLen,
        halfWidth,
        archRise,
        tipDroop,
        roll,
        innerShade,
        outerShade,
        0.84,
        0.95,
        0.78,
      );
    }

    if (w < 7) {
      for (let s = 0; s < 3; s += 1) {
        const yaw = baseYawOffset + (s / 3) * Math.PI * 2 + 0.55 + (rng() - 0.5) * 0.28;
        const boughLen = (0.04 + envelope * 0.132) * (0.85 + rng() * 0.32);
        appendCurvedBoughCard(
          buf,
          0,
          yBase + 0.018,
          0,
          yaw,
          boughLen,
          boughLen * 0.55,
          0.022,
          -0.068 * (1 - t * 0.72),
          (s % 2 === 0 ? 1 : -1) * 0.82,
          0.42 + t * 0.2,
          0.78 + t * 0.25,
          0.82,
          0.93,
          0.76,
        );
      }
    }
  }

  // 2 crossed vertical feathery crown-spire cards at apex (y = 0.86..1.05)
  for (let c = 0; c < 2; c += 1) {
    const vOffset = buf.positions.length / 3;
    const yaw = c * Math.PI * 0.5 + 0.35;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const hw = 0.054;
    const y0 = 0.86;
    const y1 = 1.05;

    const corners: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [-hw, y0, 0, 0, 0.74],
      [hw, y0, 1, 0, 0.74],
      [-hw * 0.82, y1, 0, 1, 1.08],
      [hw * 0.82, y1, 1, 1, 1.08],
    ];
    for (const [lx, ly, u, v, sh] of corners) {
      buf.positions.push(lx * cosY, ly, -lx * sinY);
      buf.uvs.push(u, v);
      buf.colors.push(0.86 * sh, 0.96 * sh, 0.78 * sh);
    }
    buf.indices.push(vOffset, vOffset + 1, vOffset + 2);
    buf.indices.push(vOffset + 1, vOffset + 3, vOffset + 2);
  }

  return finalizeFoliageGeometry(buf);
}

/**
 * Archetype 2: Slender Mountain Spruce / Western Red Cedar spire trunk
 * with subtle root buttress flare and slender graceful sway.
 */
function createSpruceTrunkGeometry(): THREE.BufferGeometry {
  const buf: TrunkBuilderBuffers = { positions: [], uvs: [], colors: null, indices: [] };

  appendTaperedLimb(
    buf,
    [
      [0.0, 0.0, 0.0, 0.03],
      [-0.002, 0.1, 0.002, 0.021],
      [-0.004, 0.28, 0.004, 0.017],
      [-0.001, 0.52, 0.002, 0.013],
      [0.004, 0.74, -0.003, 0.008],
      [0.003, 0.96, -0.002, 0.0028],
    ],
    6,
    2.6,
    0.2,
    4,
    0.9,
    true,
  );

  // 3 short drooping basal twig stubs near the skirt
  const skirtStubs: ReadonlyArray<readonly [number, number, number]> = [
    [0.09, 0.9, 0.052],
    [0.12, 3.1, 0.058],
    [0.145, 5.0, 0.048],
  ];
  for (const [sy, yaw, len] of skirtStubs) {
    const cx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    appendTaperedLimb(
      buf,
      [
        [cx * 0.01, sy, cz * 0.01, 0.0055],
        [cx * len, sy - 0.018, cz * len, 0.002],
      ],
      4,
      2.4,
      0,
      0,
      0,
      true,
    );
  }

  return finalizeTrunkGeometry(buf);
}

/**
 * Archetype 2 Canopy: Tall, narrow, steeply drooping Mountain Spruce / Western Red Cedar
 * feathery spire starting low on the trunk with cooler blue-spruce tones & wind-sheared gaps.
 */
function createSpruceCanopyGeometry(): THREE.BufferGeometry {
  const rng = createRng(91823);
  const buf: FoliageCardBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  const whorls = 11;
  for (let w = 0; w < whorls; w += 1) {
    const t = w / (whorls - 1);
    const yBase = 0.13 + t * 0.82;
    const envelope = Math.pow(1 - t, 0.92);
    const boughCount = w < 6 ? 6 : w < 9 ? 5 : 4;
    const baseYawOffset = w * 0.87;

    for (let b = 0; b < boughCount; b += 1) {
      // Irregular wind-sheared asymmetry
      if (w > 1 && w < 9 && rng() < 0.12) {
        continue;
      }
      const yaw = baseYawOffset + (b / boughCount) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      const lenJitter = 0.78 + rng() * 0.38;
      // Narrower, tapering silhouette compared to Douglas fir
      const boughLen = (0.036 + envelope * 0.128) * lenJitter;
      const halfWidth = boughLen * (0.48 + rng() * 0.18);
      const archRise = 0.005 + (1 - t) * 0.007;
      // Pronounced cascading spruce droop
      const tipDroop = -0.068 * (1 - t * 0.85) + (rng() - 0.5) * 0.015;
      const roll = (b % 2 === 0 ? 1 : -1) * (0.34 + rng() * 0.4);

      const innerShade = 0.4 + t * 0.24;
      const outerShade = 0.8 + t * 0.28 + (rng() - 0.5) * 0.12;

      appendCurvedBoughCard(
        buf,
        0,
        yBase + (rng() - 0.5) * 0.022,
        0,
        yaw,
        boughLen,
        halfWidth,
        archRise,
        tipDroop,
        roll,
        innerShade,
        outerShade,
        0.72,
        0.92,
        0.88,
      );
    }

    if (w < 8) {
      for (let s = 0; s < 2; s += 1) {
        const yaw = baseYawOffset + s * Math.PI + 0.64 + (rng() - 0.5) * 0.3;
        const boughLen = (0.032 + envelope * 0.105) * (0.85 + rng() * 0.3);
        appendCurvedBoughCard(
          buf,
          0,
          yBase + 0.015,
          0,
          yaw,
          boughLen,
          boughLen * 0.54,
          0.01,
          -0.082 * (1 - t * 0.74),
          (s % 2 === 0 ? 1 : -1) * 0.9,
          0.38 + t * 0.2,
          0.74 + t * 0.26,
          0.7,
          0.9,
          0.86,
        );
      }
    }
  }

  // Tall narrow pointed needle-spire apex (y = 0.89..1.09)
  for (let c = 0; c < 2; c += 1) {
    const vOffset = buf.positions.length / 3;
    const yaw = c * Math.PI * 0.5 + 0.22;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const hw = 0.04;
    const y0 = 0.89;
    const y1 = 1.09;

    const corners: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [-hw, y0, 0, 0, 0.7],
      [hw, y0, 1, 0, 0.7],
      [-hw * 0.58, y1, 0, 1, 1.08],
      [hw * 0.58, y1, 1, 1, 1.08],
    ];
    for (const [lx, ly, u, v, sh] of corners) {
      buf.positions.push(lx * cosY, ly, -lx * sinY);
      buf.uvs.push(u, v);
      buf.colors.push(0.74 * sh, 0.94 * sh, 0.9 * sh);
    }
    buf.indices.push(vOffset, vOffset + 1, vOffset + 2);
    buf.indices.push(vOffset + 1, vOffset + 3, vOffset + 2);
  }

  return finalizeFoliageGeometry(buf);
}

// Shared exact limb-tip crown pad coordinates for Archetype 3 (Broad Gnarled Ponderosa Pine)
const BROAD_PINE_CLUSTERS: ReadonlyArray<TreeClusterAnchor> = [
  { x: 0.095, y: 0.9, z: 0.045, radius: 0.165, heightScale: 0.09 },
  { x: -0.115, y: 0.84, z: -0.06, radius: 0.155, heightScale: 0.085 },
  { x: 0.185, y: 0.73, z: -0.045, radius: 0.135, heightScale: 0.075 },
  { x: -0.178, y: 0.66, z: 0.068, radius: 0.13, heightScale: 0.072 },
  { x: 0.015, y: 0.78, z: -0.145, radius: 0.138, heightScale: 0.076 },
];

/**
 * Archetype 3: Curved, gnarled old-growth Ponderosa pine trunk splitting into
 * an asymmetrical forked Y-crown with spreading sculptural upper boughs.
 */
function createBroadPineTrunkGeometry(): THREE.BufferGeometry {
  const buf: TrunkBuilderBuffers = { positions: [], uvs: [], colors: null, indices: [] };

  // Stout curved main lower trunk up to primary fork at y = 0.48
  appendTaperedLimb(
    buf,
    [
      [0.0, 0.0, 0.0, 0.044],
      [0.008, 0.12, -0.005, 0.032],
      [0.019, 0.27, -0.009, 0.027],
      [0.011, 0.42, -0.003, 0.023],
      [0.005, 0.49, 0.0, 0.02],
    ],
    7,
    2.2,
    0.28,
    5,
    0.2,
    true,
  );

  // Fork A: Dominant ascending gnarled limb -> cluster 0 (0.095, 0.90, 0.045)
  appendTaperedLimb(
    buf,
    [
      [0.005, 0.46, 0.0, 0.018],
      [0.046, 0.62, 0.018, 0.0145],
      [0.088, 0.77, 0.038, 0.0105],
      [0.095, 0.9, 0.045, 0.005],
    ],
    6,
    2.4,
    0,
    0,
    0,
    true,
  );

  // Sub-limb off Fork A -> cluster 2 (0.185, 0.73, -0.045)
  appendTaperedLimb(
    buf,
    [
      [0.046, 0.62, 0.018, 0.0115],
      [0.122, 0.675, -0.014, 0.008],
      [0.185, 0.73, -0.045, 0.004],
    ],
    5,
    2.5,
    0,
    0,
    0,
    true,
  );

  // Fork B: Spreading opposite gnarled limb -> cluster 1 (-0.115, 0.84, -0.06)
  appendTaperedLimb(
    buf,
    [
      [0.005, 0.47, 0.0, 0.0165],
      [-0.052, 0.61, -0.024, 0.013],
      [-0.098, 0.73, -0.048, 0.0092],
      [-0.115, 0.84, -0.06, 0.0046],
    ],
    6,
    2.4,
    0,
    0,
    0,
    true,
  );

  // Sub-limb off Fork B -> cluster 3 (-0.178, 0.66, 0.068)
  appendTaperedLimb(
    buf,
    [
      [-0.048, 0.59, -0.02, 0.011],
      [-0.118, 0.62, 0.026, 0.0076],
      [-0.178, 0.66, 0.068, 0.0038],
    ],
    5,
    2.5,
    0,
    0,
    0,
    true,
  );

  // Fork C: Back-reaching spreading pine limb -> cluster 4 (0.015, 0.78, -0.145)
  appendTaperedLimb(
    buf,
    [
      [0.007, 0.51, -0.004, 0.0125],
      [0.014, 0.65, -0.078, 0.0086],
      [0.015, 0.78, -0.145, 0.0042],
    ],
    5,
    2.5,
    0,
    0,
    0,
    true,
  );

  // 2 rugged bare lower knotty branch stubs
  appendTaperedLimb(
    buf,
    [
      [0.018, 0.28, -0.009, 0.0095],
      [0.075, 0.295, 0.036, 0.0056],
      [0.112, 0.278, 0.058, 0.0026],
    ],
    4,
    2.6,
    0,
    0,
    0,
    true,
  );
  appendTaperedLimb(
    buf,
    [
      [0.013, 0.37, -0.005, 0.0085],
      [-0.054, 0.39, 0.032, 0.0046],
      [-0.088, 0.378, 0.048, 0.0024],
    ],
    4,
    2.6,
    0,
    0,
    0,
    true,
  );

  return finalizeTrunkGeometry(buf);
}

/**
 * Archetype 3 Canopy: Open, chunky flat-topped Ponderosa pine needle clouds clustered
 * directly around each forked upper limb tip so sunlight streams through the branches.
 */
function createBroadPineCanopyGeometry(): THREE.BufferGeometry {
  const rng = createRng(52487);
  const buf: FoliageCardBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  for (let cIdx = 0; cIdx < BROAD_PINE_CLUSTERS.length; cIdx += 1) {
    const cluster = BROAD_PINE_CLUSTERS[cIdx];
    if (!cluster) {
      continue;
    }

    // Two overlapping flat-topped tiers per limb pad
    for (let tier = 0; tier < 2; tier += 1) {
      const yLayer = cluster.y + (tier === 0 ? -0.016 : 0.026);
      const count = tier === 0 ? 7 : 5;
      const tierScale = tier === 0 ? 1.0 : 0.74;
      const baseYaw = cIdx * 1.15 + tier * 0.58;

      for (let b = 0; b < count; b += 1) {
        const yaw = baseYaw + (b / count) * Math.PI * 2 + (rng() - 0.5) * 0.45;
        const len = cluster.radius * tierScale * (0.76 + rng() * 0.42);
        const halfWidth = len * (0.54 + rng() * 0.22);
        const archRise = cluster.heightScale * (0.42 + rng() * 0.34);
        // Flat-topped Ponderosa pads sweep gently outward rather than drooping sharply
        const tipDroop = (tier === 0 ? -0.012 : 0.012) + (rng() - 0.5) * 0.022;
        const roll = (b % 2 === 0 ? 1 : -1) * (0.22 + rng() * 0.34);

        const innerShade = 0.52 + tier * 0.18;
        const outerShade = 0.92 + tier * 0.18 + (rng() - 0.5) * 0.12;

        appendCurvedBoughCard(
          buf,
          cluster.x + (rng() - 0.5) * 0.022,
          yLayer + (rng() - 0.5) * 0.018,
          cluster.z + (rng() - 0.5) * 0.022,
          yaw,
          len,
          halfWidth,
          archRise,
          tipDroop,
          roll,
          innerShade,
          outerShade,
          0.95,
          0.99,
          0.74,
        );
      }
    }

    // Crossed crowning needle tufts on top of each pad
    for (let k = 0; k < 2; k += 1) {
      const yaw = cIdx * 0.9 + k * Math.PI * 0.5 + 0.3;
      appendCurvedBoughCard(
        buf,
        cluster.x,
        cluster.y + 0.02,
        cluster.z,
        yaw,
        cluster.radius * 0.58,
        cluster.radius * 0.38,
        cluster.heightScale * 0.72,
        cluster.heightScale * 0.35,
        (k === 0 ? 1 : -1) * 0.65,
        0.68,
        1.08,
        0.97,
        1.0,
        0.75,
      );
    }
  }

  return finalizeFoliageGeometry(buf);
}

// Shared exact branch-tip cluster anchors for Archetype 4 (Pacific Northwest Red Alder)
const ALDER_CLUSTERS: ReadonlyArray<TreeClusterAnchor> = [
  { x: 0.01, y: 0.88, z: 0.02, radius: 0.21, heightScale: 0.17 },
  { x: 0.165, y: 0.78, z: 0.075, radius: 0.185, heightScale: 0.15 },
  { x: -0.17, y: 0.74, z: 0.06, radius: 0.185, heightScale: 0.15 },
  { x: -0.075, y: 0.76, z: -0.165, radius: 0.18, heightScale: 0.145 },
  { x: 0.125, y: 0.68, z: -0.145, radius: 0.165, heightScale: 0.135 },
  { x: -0.215, y: 0.58, z: -0.065, radius: 0.15, heightScale: 0.125 },
  { x: 0.195, y: 0.57, z: 0.145, radius: 0.145, heightScale: 0.12 },
];

/**
 * Archetype 4: Pacific Northwest Red Alder / Woodland Birch multi-branching trunk
 * with smooth mottled pale silver-grey lichen bark and mossy root collar vertex tinting.
 */
function createAlderTrunkGeometry(): THREE.BufferGeometry {
  const buf: TrunkBuilderBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  const alderBarkColor = (_t: number, y: number, angle: number): readonly [number, number, number] => {
    // Mossy damp olive-grey near ground root collar, brightening into mottled silver-grey upper limbs
    const mossMix = Math.max(0, 1 - y / 0.18);
    const mottle = 0.93 + 0.09 * Math.sin(y * 28 + angle * 2.0);
    const r = (1.02 - mossMix * 0.34) * mottle;
    const g = (1.01 - mossMix * 0.24) * mottle;
    const b = (0.97 - mossMix * 0.38) * mottle;
    return [r, g, b];
  };

  // Sinuous deciduous lower trunk splitting low around y = 0.34
  appendTaperedLimb(
    buf,
    [
      [0.0, 0.0, 0.0, 0.032],
      [-0.008, 0.1, 0.006, 0.023],
      [-0.004, 0.22, 0.011, 0.02],
      [0.004, 0.34, 0.008, 0.0175],
    ],
    7,
    2.1,
    0.22,
    4,
    0.7,
    true,
    alderBarkColor,
  );

  // Branch 1: Central ascending crown leader -> cluster 0 (0.01, 0.88, 0.02)
  appendTaperedLimb(
    buf,
    [
      [0.004, 0.32, 0.008, 0.014],
      [0.024, 0.52, 0.018, 0.0108],
      [-0.008, 0.71, 0.025, 0.0074],
      [0.01, 0.88, 0.02, 0.0036],
    ],
    5,
    2.4,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Branch 2: Right-front graceful limb -> cluster 1 (0.165, 0.78, 0.075)
  appendTaperedLimb(
    buf,
    [
      [0.004, 0.33, 0.008, 0.013],
      [0.072, 0.5, 0.044, 0.0098],
      [0.132, 0.65, 0.066, 0.0066],
      [0.165, 0.78, 0.075, 0.0034],
    ],
    5,
    2.4,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Sub-branch off Branch 2 -> cluster 6 (0.195, 0.57, 0.145)
  appendTaperedLimb(
    buf,
    [
      [0.072, 0.49, 0.044, 0.008],
      [0.138, 0.535, 0.098, 0.0054],
      [0.195, 0.57, 0.145, 0.0028],
    ],
    4,
    2.5,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Branch 3: Left-front wide fork -> cluster 2 (-0.17, 0.74, 0.06)
  appendTaperedLimb(
    buf,
    [
      [0.0, 0.31, 0.009, 0.013],
      [-0.078, 0.48, 0.036, 0.0095],
      [-0.136, 0.62, 0.052, 0.0064],
      [-0.17, 0.74, 0.06, 0.0032],
    ],
    5,
    2.4,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Sub-branch off Branch 3 -> cluster 5 (-0.215, 0.58, -0.065)
  appendTaperedLimb(
    buf,
    [
      [-0.078, 0.47, 0.034, 0.0082],
      [-0.152, 0.53, -0.018, 0.0054],
      [-0.215, 0.58, -0.065, 0.0028],
    ],
    4,
    2.5,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Branch 4: Back-left ascending limb -> cluster 3 (-0.075, 0.76, -0.165)
  appendTaperedLimb(
    buf,
    [
      [0.002, 0.34, 0.006, 0.012],
      [-0.036, 0.53, -0.076, 0.0088],
      [-0.075, 0.76, -0.165, 0.0034],
    ],
    5,
    2.4,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  // Branch 5: Back-right spreading limb -> cluster 4 (0.125, 0.68, -0.145)
  appendTaperedLimb(
    buf,
    [
      [0.01, 0.39, 0.002, 0.011],
      [0.07, 0.54, -0.072, 0.0076],
      [0.125, 0.68, -0.145, 0.0032],
    ],
    5,
    2.4,
    0,
    0,
    0,
    true,
    alderBarkColor,
  );

  return finalizeTrunkGeometry(buf);
}

/**
 * Archetype 4 Canopy: Airy, rounded deciduous broadleaf crown built from crossed
 * arched foliage clusters around each alder limb tip with warm olive-gold sunlit tips.
 */
function createAlderCanopyGeometry(): THREE.BufferGeometry {
  const rng = createRng(38611);
  const buf: FoliageCardBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  const addLeafClusterCard = (
    cx: number,
    cy: number,
    cz: number,
    yaw: number,
    pitch: number,
    width: number,
    height: number,
    innerShade: number,
    outerShade: number,
    autumnBlend: number,
  ): void => {
    const vOffset = buf.positions.length / 3;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    const uBase = rng() * 0.45;
    const uSpan = 0.55;
    const hw = width * 0.5;

    // 3-row gently domed broadleaf spray card (uv.y = 0 anchored near branch, uv.y = 1 flutters in wind)
    const rows: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [-height * 0.16, 0.0, hw * 0.72, 0.06, innerShade],
      [height * 0.34, height * 0.14, hw * 1.05, 0.52, (innerShade + outerShade) * 0.55],
      [height * 0.88, -height * 0.05, hw * 0.78, 0.96, outerShade],
    ];

    // Blend sage-olive deciduous green toward golden late-summer amber on sunlit outer crowns
    const tintR = 0.96 + autumnBlend * 0.24;
    const tintG = 1.02 + autumnBlend * 0.04;
    const tintB = 0.64 - autumnBlend * 0.22;

    for (const [along, cup, halfW, vCoord, shade] of rows) {
      for (const side of [-1, 1]) {
        const lx = side * halfW;
        const lyLocal = along * cosP - cup * sinP;
        const lzLocal = along * sinP + cup * cosP;

        const wx = cx + lx * cosY + lzLocal * sinY;
        const wy = cy + lyLocal;
        const wz = cz - lx * sinY + lzLocal * cosY;

        buf.positions.push(wx, wy, wz);
        buf.uvs.push(side === -1 ? uBase : uBase + uSpan, vCoord);
        buf.colors.push(tintR * shade, tintG * shade, tintB * shade);
      }
    }

    buf.indices.push(vOffset, vOffset + 1, vOffset + 2);
    buf.indices.push(vOffset + 1, vOffset + 3, vOffset + 2);
    buf.indices.push(vOffset + 2, vOffset + 3, vOffset + 4);
    buf.indices.push(vOffset + 3, vOffset + 5, vOffset + 4);
  };

  for (let cIdx = 0; cIdx < ALDER_CLUSTERS.length; cIdx += 1) {
    const cluster = ALDER_CLUSTERS[cIdx];
    if (!cluster) {
      continue;
    }

    const sprays = cIdx === 0 ? 7 : 6;
    for (let s = 0; s < sprays; s += 1) {
      const angle = (s / sprays) * Math.PI * 2 + cIdx * 0.8 + (rng() - 0.5) * 0.5;
      const radialOff = cluster.radius * (0.12 + rng() * 0.34);
      const sx = cluster.x + Math.sin(angle) * radialOff;
      const sy = cluster.y + (rng() - 0.42) * cluster.heightScale * 0.72;
      const sz = cluster.z + Math.cos(angle) * radialOff;

      const cardW = cluster.radius * (0.98 + rng() * 0.36);
      const cardH = cluster.heightScale * (1.12 + rng() * 0.36);
      const pitch = 0.28 + rng() * 0.58;
      const heightRatio = Math.max(0, Math.min(1, (sy - 0.45) / 0.55));
      const innerShade = 0.5 + heightRatio * 0.22;
      const outerShade = 0.88 + heightRatio * 0.28 + (rng() - 0.5) * 0.12;
      const autumnBlend = 0.22 + heightRatio * 0.55 + (rng() - 0.5) * 0.2;

      addLeafClusterCard(
        sx,
        sy,
        sz,
        angle + (rng() - 0.5) * 0.55,
        pitch,
        cardW,
        cardH,
        innerShade,
        outerShade,
        Math.max(0, Math.min(1, autumnBlend)),
      );
    }
  }

  return finalizeFoliageGeometry(buf);
}

/**
 * Archetype 5: Weathered, bleached driftwood-grey lightning-broken dead pine snag
 * with exposed flared roots, jagged splintered top, and crooked bare skeletal limbs (no canopy).
 */
function createDeadSnagTrunkGeometry(): THREE.BufferGeometry {
  const buf: TrunkBuilderBuffers = { positions: [], uvs: [], colors: [], indices: [] };

  const snagWoodColor = (t: number, y: number, angle: number): readonly [number, number, number] => {
    // Dark damp decayed base transitioning into sun-bleached bone-silver upper driftwood
    const baseDark = Math.max(0, 1 - y / 0.2);
    const grain = 0.92 + 0.1 * Math.sin(angle * 4.0 + y * 14.0);
    const bleach = 0.84 + t * 0.24;
    const r = (bleach - baseDark * 0.32) * grain;
    const g = (bleach * 0.98 - baseDark * 0.33) * grain;
    const b = (bleach * 0.94 - baseDark * 0.35) * grain;
    return [r, g, b];
  };

  // Twisted weathered main dead trunk ending in a snapped jagged crown at y = 0.86
  appendTaperedLimb(
    buf,
    [
      [0.0, 0.0, 0.0, 0.04],
      [-0.005, 0.11, 0.004, 0.028],
      [-0.011, 0.28, 0.008, 0.024],
      [-0.006, 0.48, 0.002, 0.02],
      [0.008, 0.68, -0.008, 0.016],
      [0.014, 0.85, -0.012, 0.0115],
    ],
    7,
    2.5,
    0.32,
    5,
    1.1,
    true,
    snagWoodColor,
  );

  // Two jagged lightning-splintered crown prongs at the snapped top (y = 0.82..0.97)
  appendTaperedLimb(
    buf,
    [
      [0.011, 0.82, -0.011, 0.0082],
      [0.028, 0.91, -0.018, 0.0044],
      [0.036, 0.97, -0.021, 0.0014],
    ],
    4,
    2.8,
    0,
    0,
    0,
    true,
    snagWoodColor,
  );
  appendTaperedLimb(
    buf,
    [
      [0.012, 0.82, -0.01, 0.0068],
      [-0.006, 0.89, -0.002, 0.0036],
      [-0.014, 0.93, 0.004, 0.0014],
    ],
    4,
    2.8,
    0,
    0,
    0,
    true,
    snagWoodColor,
  );

  // 6 crooked bare skeletal limbs jutting asymmetrically at varying angles
  const limbs: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>> = [
    [
      [-0.008, 0.34, 0.006, 0.0105],
      [0.056, 0.375, 0.044, 0.0068],
      [0.106, 0.362, 0.072, 0.0032],
    ],
    [
      [-0.007, 0.45, 0.003, 0.0115],
      [-0.078, 0.495, -0.038, 0.0076],
      [-0.138, 0.54, -0.052, 0.0044],
      [-0.168, 0.525, -0.062, 0.0022],
    ],
    // Broken secondary twig off the big left skeletal limb
    [
      [-0.078, 0.495, -0.038, 0.0056],
      [-0.095, 0.565, 0.012, 0.0024],
    ],
    [
      [0.001, 0.57, -0.003, 0.011],
      [0.072, 0.625, -0.052, 0.0072],
      [0.132, 0.69, -0.078, 0.0038],
      [0.152, 0.725, -0.088, 0.0018],
    ],
    // Secondary upward crooked fork off right upper limb
    [
      [0.072, 0.625, -0.052, 0.0054],
      [0.094, 0.695, -0.004, 0.0022],
    ],
    [
      [0.006, 0.66, -0.007, 0.0095],
      [-0.052, 0.715, 0.058, 0.0058],
      [-0.094, 0.76, 0.092, 0.0024],
    ],
    [
      [0.011, 0.75, -0.01, 0.0085],
      [0.068, 0.805, 0.042, 0.0046],
      [0.098, 0.835, 0.06, 0.002],
    ],
    [
      [0.012, 0.79, -0.011, 0.0078],
      [-0.044, 0.84, -0.058, 0.0036],
      [-0.072, 0.865, -0.082, 0.0018],
    ],
  ];

  for (const limb of limbs) {
    appendTaperedLimb(buf, limb, 4, 2.7, 0, 0, 0, true, snagWoodColor);
  }

  return finalizeTrunkGeometry(buf);
}

/**
 * 7-frond arching western sword fern cluster.
 * UV v = t puts the stem base (v = 0) at the rosette center and the pointed apex (v = 1)
 * arching gracefully outward (matching fern_frond.jpg orientation).
 */
function createFernClusterGeometry(): THREE.BufferGeometry {
  const fronds = 7;
  const segsY = 5;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let vertexOffset = 0;
  for (let f = 0; f < fronds; f += 1) {
    const yaw = (f / fronds) * Math.PI * 2 + (f % 2) * 0.22;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const length = 0.86 + (f % 3) * 0.17;
    const halfWidth = 0.34;
    const archHeight = 0.36 + (f % 2) * 0.12;

    for (let s = 0; s <= segsY; s += 1) {
      const t = s / segsY;
      const forward = t * length;
      const up = Math.sin(t * Math.PI * 0.84) * archHeight + 0.02;
      const w = halfWidth * (0.86 + Math.sin(t * Math.PI) * 0.2);

      for (const side of [-1, 1]) {
        const lx = side * w;
        const lz = forward;
        const wx = lx * cosY + lz * sinY;
        const wz = -lx * sinY + lz * cosY;
        positions.push(wx, up, wz);
        uvs.push(side === -1 ? 0 : 1, t);
      }
    }

    for (let s = 0; s < segsY; s += 1) {
      const row0 = vertexOffset + s * 2;
      const row1 = row0 + 2;
      indices.push(row0, row0 + 1, row1);
      indices.push(row0 + 1, row1 + 1, row1);
    }
    vertexOffset += (segsY + 1) * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createGrassTuftGeometry(): THREE.BufferGeometry {
  const blades = 7;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rng = createRng(44921);

  let vIdx = 0;
  for (let b = 0; b < blades; b += 1) {
    const yaw = (b / blades) * Math.PI * 2 + rng() * 0.45;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const h = 0.24 + rng() * 0.28;
    const lean = 0.11 + rng() * 0.16;
    const w = 0.022 + rng() * 0.014;
    const ox = (rng() - 0.5) * 0.22;
    const oz = (rng() - 0.5) * 0.22;

    const pts: ReadonlyArray<readonly [number, number, number, number, number, number, number, number]> = [
      [-w, 0, 0, 0, 0, 0.12, 0.16, 0.08],
      [w, 0, 0, 1, 0, 0.12, 0.16, 0.08],
      [-w * 0.62, h * 0.55, lean * 0.4, 0, 0.55, 0.22, 0.31, 0.13],
      [w * 0.62, h * 0.55, lean * 0.4, 1, 0.55, 0.22, 0.31, 0.13],
      [0, h, lean, 0.5, 1, 0.34, 0.43, 0.19],
    ];

    for (const [lx, ly, lz, u, v, cr, cg, cb] of pts) {
      const wx = ox + lx * cosY + lz * sinY;
      const wz = oz - lx * sinY + lz * cosY;
      positions.push(wx, ly, wz);
      uvs.push(u, v);
      colors.push(cr, cg, cb);
    }

    indices.push(vIdx, vIdx + 1, vIdx + 2);
    indices.push(vIdx + 1, vIdx + 3, vIdx + 2);
    indices.push(vIdx + 2, vIdx + 3, vIdx + 4);
    vIdx += 5;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createMistTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(
      size * 0.5,
      size * 0.5,
      size * 0.06,
      size * 0.5,
      size * 0.5,
      size * 0.5,
    );
    grad.addColorStop(0, 'rgba(242, 224, 184, 0.44)');
    grad.addColorStop(0.45, 'rgba(218, 200, 162, 0.2)');
    grad.addColorStop(1, 'rgba(190, 178, 148, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds an irregular multi-ring puddle geometry in local XY plane (normal +Z)
 * for Three.js Reflector planar mirror puddles.
 */
function createPlanarPuddleGeometry(
  radiusX: number,
  radiusZ: number,
  seed: number,
): THREE.BufferGeometry {
  const rings = 5;
  const sectors = 32;
  const positions: number[] = [];
  const edges: number[] = [];
  const indices: number[] = [];

  positions.push(0, 0, 0);
  edges.push(0);

  for (let r = 1; r <= rings; r += 1) {
    const rt = r / rings;
    for (let s = 0; s < sectors; s += 1) {
      const a = (s / sectors) * Math.PI * 2;
      const lobe =
        1 +
        Math.sin(a * 2 + seed) * 0.26 +
        Math.cos(a * 3 - seed * 1.4) * 0.16 +
        Math.sin(a * 5 + seed * 0.7) * 0.08;
      const lx = Math.cos(a) * radiusX * lobe * rt;
      const ly = Math.sin(a) * radiusZ * lobe * rt;
      positions.push(lx, ly, 0);
      edges.push(rt);
    }
  }

  // CCW in XY plane -> faces +Z (which becomes +Y after rotateX(-PI/2))
  for (let s = 0; s < sectors; s += 1) {
    const next = (s + 1) % sectors;
    indices.push(0, 1 + s, 1 + next);
  }

  for (let r = 0; r < rings - 1; r += 1) {
    const innerStart = 1 + r * sectors;
    const outerStart = innerStart + sectors;
    for (let s = 0; s < sectors; s += 1) {
      const next = (s + 1) % sectors;
      const i0 = innerStart + s;
      const i1 = innerStart + next;
      const o0 = outerStart + s;
      const o1 = outerStart + next;
      indices.push(i0, o0, i1);
      indices.push(i1, o0, o1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createConformingPuddleGeometry(
  centerX: number,
  centerZ: number,
  radiusX: number,
  radiusZ: number,
  seed: number,
): THREE.BufferGeometry {
  const rings = 5;
  const sectors = 32;
  const positions: number[] = [];
  const edges: number[] = [];
  const indices: number[] = [];

  positions.push(0, getTerrainHeight(centerX, centerZ) + 0.056, 0);
  edges.push(0);

  for (let r = 1; r <= rings; r += 1) {
    const rt = r / rings;
    for (let s = 0; s < sectors; s += 1) {
      const a = (s / sectors) * Math.PI * 2;
      const lobe =
        1 +
        Math.sin(a * 2 + seed) * 0.26 +
        Math.cos(a * 3 - seed * 1.4) * 0.16 +
        Math.sin(a * 5 + seed * 0.7) * 0.08;
      const lx = Math.cos(a) * radiusX * lobe * rt;
      const lz = Math.sin(a) * radiusZ * lobe * rt;
      const wy = getTerrainHeight(centerX + lx, centerZ + lz) + 0.056;
      positions.push(lx, wy, lz);
      edges.push(rt);
    }
  }

  for (let s = 0; s < sectors; s += 1) {
    const next = (s + 1) % sectors;
    indices.push(0, 1 + next, 1 + s);
  }

  for (let r = 0; r < rings - 1; r += 1) {
    const innerStart = 1 + r * sectors;
    const outerStart = innerStart + sectors;
    for (let s = 0; s < sectors; s += 1) {
      const next = (s + 1) % sectors;
      const i0 = innerStart + s;
      const i1 = innerStart + next;
      const o0 = outerStart + s;
      const o1 = outerStart + next;
      indices.push(i0, i1, o0);
      indices.push(i1, o1, o0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildTerrainMesh(forestMat: THREE.MeshStandardMaterial): THREE.Mesh {
  const width = 200;
  const depth = 200;
  const segsX = 148;
  const segsZ = 148;
  const centerZ = -30;

  const geo = new THREE.PlaneGeometry(width, depth, segsX, segsZ);
  geo.rotateX(-Math.PI * 0.5);

  const pos = geo.attributes.position;
  if (!pos) {
    return new THREE.Mesh(geo, forestMat);
  }

  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  const mossColor = new THREE.Color('#7f9458');
  const duffColor = new THREE.Color('#706652');
  const shoulderColor = new THREE.Color('#636b52');
  const ridgeColor = new THREE.Color('#4c5740');

  for (let i = 0; i < pos.count; i += 1) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i) + centerZ;
    const wy = getTerrainHeight(wx, wz);
    pos.setXYZ(i, wx, wy, wz);

    const rf = getRoadFactor(wx, wz);
    const patch = 0.5 + 0.5 * Math.sin(wx * 0.19 + wz * 0.13) * Math.cos(wz * 0.21 - wx * 0.08);
    const ridgeMask = smoothstep(2.5, 11.0, wy);

    col.copy(duffColor).lerp(mossColor, patch * 0.7);
    col.lerp(shoulderColor, rf * 0.82);
    col.lerp(ridgeColor, ridgeMask * 0.48);

    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, forestMat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildHighwayRibbon(highwayMat: THREE.MeshStandardMaterial): THREE.Mesh {
  const zStart = 34;
  const zEnd = -112;
  const lengthSegs = 160;
  const widthSegs = 8;
  const roadHalfWidth = 4.35;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz <= lengthSegs; iz += 1) {
    const tz = iz / lengthSegs;
    const z = zStart + (zEnd - zStart) * tz;
    const cx = getRoadCenterX(z);
    const vCoord = (zStart - z) / 14.5;

    for (let ix = 0; ix <= widthSegs; ix += 1) {
      const tx = ix / widthSegs;
      const offsetX = (tx - 0.5) * 2 * roadHalfWidth;
      const wx = cx + offsetX;
      const edgeTaper = smoothstep(0.76, 1.0, Math.abs(tx - 0.5) * 2);
      const lift = 0.042 * (1 - edgeTaper * 1.45);
      const wy = getTerrainHeight(wx, z) + lift;

      positions.push(wx, wy, z);
      uvs.push(tx, vCoord);
    }
  }

  const rowStride = widthSegs + 1;
  for (let iz = 0; iz < lengthSegs; iz += 1) {
    for (let ix = 0; ix < widthSegs; ix += 1) {
      const a = iz * rowStride + ix;
      const b = a + 1;
      const c = a + rowStride;
      const d = c + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, highwayMat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildOverlookLedge(
  concreteMat: THREE.MeshStandardMaterial,
  mossRockMat: THREE.MeshStandardMaterial,
  rebarMat: THREE.MeshStandardMaterial,
): THREE.Group {
  const group = new THREE.Group();
  const baseX = SPAWN_POINT.x;
  const baseZ = SPAWN_POINT.z;
  const topY = getTerrainHeight(baseX, baseZ);

  const slabShape = new THREE.Shape();
  slabShape.moveTo(-2.3, -2.0);
  slabShape.lineTo(1.25, -1.65);
  slabShape.lineTo(1.58, -0.55);
  slabShape.lineTo(1.18, 0.45);
  slabShape.lineTo(1.42, 1.25);
  slabShape.lineTo(0.25, 2.05);
  slabShape.lineTo(-1.95, 2.2);
  slabShape.lineTo(-2.55, 0.35);
  slabShape.closePath();

  const slabGeo = new THREE.ExtrudeGeometry(slabShape, {
    depth: 0.44,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.05,
    bevelSegments: 2,
  });
  slabGeo.rotateX(Math.PI * 0.5);
  slabGeo.computeVertexNormals();

  const slab = new THREE.Mesh(slabGeo, concreteMat);
  slab.position.set(baseX - 0.18, topY - 0.045, baseZ + 0.15);
  slab.rotation.z = -0.015;
  slab.castShadow = false;
  slab.receiveShadow = true;
  group.add(slab);

  // Exposed rusted steel rebar rods poking out from the fractured concrete drop-off lip
  const rebarGeo = new THREE.CylinderGeometry(0.013, 0.015, 0.52, 6);
  const rebarOffsets: ReadonlyArray<readonly [number, number, number, number]> = [
    [1.36, -0.18, -0.78, 1.48],
    [1.18, -0.22, -0.22, 1.62],
    [1.26, -0.19, 0.58, 1.38],
    [0.92, -0.21, -1.42, 1.24],
  ];
  for (const [rx, ry, rz, rotZ] of rebarOffsets) {
    const rod = new THREE.Mesh(rebarGeo, rebarMat);
    rod.position.set(baseX + rx, topY + ry, baseZ + rz);
    rod.rotation.set(0.12, 0.25, rotZ);
    rod.castShadow = true;
    group.add(rod);
  }

  // Shattered broken concrete/stone fragments along the crumbling drop-off
  const fragments: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [baseX + 1.55, baseZ - 0.45, 0.58, 0.24, 0.42],
    [baseX + 1.38, baseZ - 1.55, 0.44, 0.2, 0.35],
    [baseX + 0.85, baseZ - 2.25, 0.52, 0.22, 0.48],
    [baseX - 1.9, baseZ - 1.85, 0.72, 0.34, 0.62],
  ];
  for (let i = 0; i < fragments.length; i += 1) {
    const frag = fragments[i];
    if (!frag) {
      continue;
    }
    const [fx, fz, sx, sy, sz] = frag;
    const chunk = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 1), mossRockMat);
    chunk.scale.set(sx * 1.4, sy * 1.4, sz * 1.4);
    chunk.position.set(fx, getTerrainHeight(fx, fz) + sy * 0.28, fz);
    chunk.rotation.set(i * 0.6, i * 1.1, 0.2);
    chunk.castShadow = true;
    chunk.receiveShadow = true;
    group.add(chunk);
  }

  return group;
}

function buildGasStationRuin(
  concreteMat: THREE.MeshStandardMaterial,
  darkInteriorMat: THREE.MeshStandardMaterial,
  rustMat: THREE.MeshStandardMaterial,
  rebarMat: THREE.MeshStandardMaterial,
  ivyMat: THREE.MeshStandardMaterial,
  mossMat: THREE.MeshStandardMaterial,
  obstacles: Obstacle[],
  swayItems: SwayItem[],
): THREE.Group {
  const ruin = new THREE.Group();
  const originX = 12.6;
  const originZ = -6.8;
  const groundY = getTerrainHeight(originX, originZ) - 0.22;
  ruin.position.set(originX, groundY, originZ);
  ruin.rotation.y = -0.14;

  const pad = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.45, 15.2), concreteMat);
  pad.position.set(-1.1, 0.15, 0);
  pad.receiveShadow = true;
  ruin.add(pad);

  const buildingW = 5.4;
  const buildingH = 7.4;
  const buildingD = 12.8;
  const bldgX = 1.65;

  const core = new THREE.Mesh(
    new THREE.BoxGeometry(buildingW - 0.55, buildingH - 0.5, buildingD - 0.65),
    darkInteriorMat,
  );
  core.position.set(bldgX + 0.12, buildingH * 0.5, 0);
  ruin.add(core);

  const frontX = bldgX - buildingW * 0.5 + 0.22;
  const addWall = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    rotZ = 0,
  ): void => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), concreteMat);
    wall.position.set(x, y, z);
    wall.rotation.z = rotZ;
    wall.castShadow = true;
    wall.receiveShadow = true;
    ruin.add(wall);
  };

  addWall(frontX, 0.9, 0, 0.48, 1.8, buildingD);
  addWall(frontX, 3.85, 0, 0.54, 1.05, buildingD + 0.15);
  addWall(frontX, 6.85, 0, 0.62, 1.2, buildingD + 0.22, 0.015);

  const pierZs = [-6.0, -2.9, 0.2, 3.3, 6.0];
  for (const pz of pierZs) {
    addWall(frontX, buildingH * 0.5, pz, 0.56, buildingH, 0.85);
  }

  addWall(bldgX + buildingW * 0.5 - 0.22, buildingH * 0.5, 0, 0.48, buildingH, buildingD);
  addWall(bldgX, buildingH * 0.5, -buildingD * 0.5 + 0.22, buildingW, buildingH, 0.5);
  addWall(bldgX, buildingH * 0.5, buildingD * 0.5 - 0.22, buildingW, buildingH, 0.5);

  const roofCap = new THREE.Mesh(
    new THREE.BoxGeometry(buildingW + 0.3, 0.42, buildingD + 0.3),
    concreteMat,
  );
  roofCap.position.set(bldgX, buildingH + 0.1, 0);
  roofCap.castShadow = true;
  roofCap.receiveShadow = true;
  ruin.add(roofCap);

  const roofMoss = new THREE.Mesh(
    new THREE.BoxGeometry(buildingW * 0.88, 0.24, buildingD * 0.92),
    mossMat,
  );
  roofMoss.position.set(bldgX - 0.1, buildingH + 0.32, 0.1);
  ruin.add(roofMoss);

  // Exposed rusted rebar jutting out of crumbling upper parapet & canopy edge
  const rebarGeo = new THREE.CylinderGeometry(0.018, 0.02, 0.9, 6);
  for (let i = 0; i < 6; i += 1) {
    const rod = new THREE.Mesh(rebarGeo, rebarMat);
    rod.position.set(frontX - 0.45, buildingH + 0.15, -4.5 + i * 1.8);
    rod.rotation.set(0.15, 0, 1.38 + (i % 2) * 0.22);
    ruin.add(rod);
  }

  const canopyX = -3.05;
  const canopyY = 3.72;
  const canopyW = 5.2;
  const canopyD = 12.6;
  const canopySlab = new THREE.Mesh(new THREE.BoxGeometry(canopyW, 0.48, canopyD), concreteMat);
  canopySlab.position.set(canopyX, canopyY, 0);
  canopySlab.rotation.z = 0.022;
  canopySlab.castShadow = true;
  canopySlab.receiveShadow = true;
  ruin.add(canopySlab);

  const canopyFascia = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.68, canopyD + 0.1),
    concreteMat,
  );
  canopyFascia.position.set(canopyX - canopyW * 0.5 + 0.12, canopyY + 0.08, 0);
  canopyFascia.castShadow = true;
  canopyFascia.receiveShadow = true;
  ruin.add(canopyFascia);

  const canopyMoss = new THREE.Mesh(
    new THREE.BoxGeometry(canopyW * 0.92, 0.22, canopyD * 0.94),
    mossMat,
  );
  canopyMoss.position.set(canopyX, canopyY + 0.28, 0);
  canopyMoss.rotation.z = 0.022;
  ruin.add(canopyMoss);

  const columnPositions: ReadonlyArray<readonly [number, number]> = [
    [-4.9, -4.8],
    [-4.9, -1.6],
    [-4.9, 1.6],
    [-4.9, 4.8],
  ];
  const cosR = Math.cos(ruin.rotation.y);
  const sinR = Math.sin(ruin.rotation.y);

  for (const [cx, cz] of columnPositions) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.46, 3.7, 0.46), concreteMat);
    col.position.set(cx, 1.85, cz);
    col.castShadow = true;
    col.receiveShadow = true;
    ruin.add(col);

    const wx = originX + cx * cosR + cz * sinR;
    const wz = originZ - cx * sinR + cz * cosR;
    obstacles.push({ kind: 'circle', x: wx, z: wz, radius: 0.42 });
  }

  const island = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.24, 5.2), concreteMat);
  island.position.set(-2.9, 0.42, 0.2);
  island.receiveShadow = true;
  ruin.add(island);

  for (const pz of [-1.2, 1.5]) {
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.68, 1.48, 0.52), rustMat);
    pump.position.set(-2.9, 1.24, pz);
    pump.rotation.z = pz < 0 ? 0.06 : -0.04;
    pump.castShadow = true;
    pump.receiveShadow = true;
    ruin.add(pump);
  }

  const vineConfigs: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [-5.68, 2.55, -3.8, 3.8, 3.0, Math.PI * 0.5],
    [-5.72, 2.38, -0.3, 4.1, 3.3, Math.PI * 0.5],
    [-5.68, 2.62, 3.6, 3.9, 2.9, Math.PI * 0.5],
    [-3.1, 2.6, 6.38, 4.9, 2.8, 0],
    [frontX - 0.38, 5.45, -4.0, 3.9, 3.9, Math.PI * 0.5],
    [frontX - 0.4, 5.2, 0.5, 4.5, 4.3, Math.PI * 0.5],
    [frontX - 0.36, 5.55, 4.1, 3.5, 3.6, Math.PI * 0.5],
    [bldgX - 0.4, 4.9, 6.52, 4.8, 4.6, 0],
  ];

  for (let i = 0; i < vineConfigs.length; i += 1) {
    const cfg = vineConfigs[i];
    if (!cfg) {
      continue;
    }
    const [vx, vy, vz, vw, vh, rotY] = cfg;
    const vineGeo = new THREE.PlaneGeometry(vw, vh, 2, 3);
    vineGeo.translate(0, -vh * 0.5, 0);
    const vine = new THREE.Mesh(vineGeo, ivyMat);
    vine.position.set(vx, vy + vh * 0.5, vz);
    vine.rotation.y = rotY;
    vine.castShadow = true;
    ruin.add(vine);

    swayItems.push({
      mesh: vine,
      baseRotX: 0,
      baseRotZ: 0,
      phase: i * 1.17,
      amp: 0.048,
    });
  }

  const bldgWorldX = originX + bldgX * cosR;
  const bldgWorldZ = originZ - bldgX * sinR;
  obstacles.push(
    createObbObstacle(bldgWorldX, bldgWorldZ, buildingW + 0.4, buildingD + 0.4, ruin.rotation.y),
  );

  const islandWorldX = originX + -2.9 * cosR + 0.2 * sinR;
  const islandWorldZ = originZ - -2.9 * sinR + 0.2 * cosR;
  obstacles.push(createObbObstacle(islandWorldX, islandWorldZ, 1.35, 5.3, ruin.rotation.y));

  return ruin;
}

function buildLeftBunkerRuin(
  concreteMat: THREE.MeshStandardMaterial,
  darkInteriorMat: THREE.MeshStandardMaterial,
  rebarMat: THREE.MeshStandardMaterial,
  ivyMat: THREE.MeshStandardMaterial,
  mossMat: THREE.MeshStandardMaterial,
  obstacles: Obstacle[],
  swayItems: SwayItem[],
): THREE.Group {
  const bunker = new THREE.Group();
  const originX = -9.6;
  const originZ = 4.0;
  const groundY = getTerrainHeight(originX, originZ) - 0.32;
  bunker.position.set(originX, groundY, originZ);
  bunker.rotation.y = 0.26;

  const w = 5.4;
  const h = 4.3;
  const d = 8.2;

  const interior = new THREE.Mesh(new THREE.BoxGeometry(w - 0.8, h - 0.5, d - 0.9), darkInteriorMat);
  interior.position.set(-0.2, h * 0.5, 0);
  bunker.add(interior);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.85, 0.72, d + 0.75), concreteMat);
  roof.position.set(0.15, h, 0);
  roof.rotation.z = -0.02;
  roof.castShadow = true;
  roof.receiveShadow = true;
  bunker.add(roof);

  const mossCap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.25, 0.35, d + 0.25), mossMat);
  mossCap.position.set(0.05, h + 0.44, 0);
  bunker.add(mossCap);

  const faceX = w * 0.5 - 0.2;
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.65, h, 2.5), concreteMat);
  leftWall.position.set(faceX, h * 0.5, -2.85);
  leftWall.castShadow = true;
  leftWall.receiveShadow = true;
  bunker.add(leftWall);

  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.65, h, 2.7), concreteMat);
  rightWall.position.set(faceX, h * 0.5, 2.75);
  rightWall.castShadow = true;
  rightWall.receiveShadow = true;
  bunker.add(rightWall);

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.35, 3.2), concreteMat);
  lintel.position.set(faceX, h - 0.85, -0.05);
  lintel.castShadow = true;
  lintel.receiveShadow = true;
  bunker.add(lintel);

  const backWall = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, d), concreteMat);
  backWall.position.set(-w * 0.5 + 0.25, h * 0.5, 0);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  bunker.add(backWall);

  const southWall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.65), concreteMat);
  southWall.position.set(0, h * 0.5, d * 0.5 - 0.25);
  southWall.castShadow = true;
  southWall.receiveShadow = true;
  bunker.add(southWall);

  const northWall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.65), concreteMat);
  northWall.position.set(0, h * 0.5, -d * 0.5 + 0.25);
  northWall.castShadow = true;
  northWall.receiveShadow = true;
  bunker.add(northWall);

  // Rusted rebar protruding from crumbling roof lip
  const rebarGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.72, 6);
  for (let i = 0; i < 4; i += 1) {
    const rod = new THREE.Mesh(rebarGeo, rebarMat);
    rod.position.set(faceX + 0.45, h + 0.1, -2.4 + i * 1.6);
    rod.rotation.set(0.1, 0, -1.42 - (i % 2) * 0.18);
    bunker.add(rod);
  }

  const vines: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [faceX + 0.42, h + 0.15, -2.0, 3.4, 2.9, Math.PI * 0.5],
    [faceX + 0.42, h + 0.1, 2.1, 3.3, 2.7, Math.PI * 0.5],
    [0.4, h + 0.15, d * 0.5 + 0.34, 4.3, 2.9, 0],
  ];
  for (let i = 0; i < vines.length; i += 1) {
    const cfg = vines[i];
    if (!cfg) {
      continue;
    }
    const [vx, vy, vz, vw, vh, rotY] = cfg;
    const geo = new THREE.PlaneGeometry(vw, vh, 2, 2);
    geo.translate(0, -vh * 0.5, 0);
    const mesh = new THREE.Mesh(geo, ivyMat);
    mesh.position.set(vx, vy, vz);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    bunker.add(mesh);
    swayItems.push({
      mesh,
      baseRotX: 0,
      baseRotZ: 0,
      phase: 3.1 + i * 1.4,
      amp: 0.042,
    });
  }

  obstacles.push(createObbObstacle(originX, originZ, w + 0.5, d + 0.5, bunker.rotation.y));
  return bunker;
}

interface VehicleRig {
  readonly root: THREE.Group;
  readonly bodyGroup: THREE.Group;
}

function buildAbandonedVan(
  bodyMat: THREE.MeshStandardMaterial,
  darkMat: THREE.MeshStandardMaterial,
  glassMat: THREE.MeshPhysicalMaterial,
  tireMat: THREE.MeshStandardMaterial,
  rebarMat: THREE.MeshStandardMaterial,
  mossMat: THREE.MeshStandardMaterial,
  ivyMat: THREE.MeshStandardMaterial,
  x: number,
  z: number,
  rotY: number,
  obstacles: Obstacle[],
  swayItems: SwayItem[],
): VehicleRig {
  const van = new THREE.Group();
  const y = getTerrainHeight(x, z);
  van.position.set(x, y - 0.06, z);
  van.rotation.set(0.035, rotY, -0.06);

  const bodyGroup = new THREE.Group();
  van.add(bodyGroup);

  const length = 4.95;
  const width = 2.02;

  // Sculpted lower body + beveled side waist trim + multi-part sloped nose hood (fallback until GLB loads)
  const lower = new THREE.Mesh(new THREE.BoxGeometry(width, 0.86, length), bodyMat);
  lower.position.set(0, 0.8, 0);
  lower.castShadow = true;
  lower.receiveShadow = true;
  bodyGroup.add(lower);

  const beltTrim = new THREE.Mesh(new THREE.BoxGeometry(width + 0.05, 0.1, length * 0.96), rebarMat);
  beltTrim.position.set(0, 1.18, 0.05);
  bodyGroup.add(beltTrim);

  const noseLower = new THREE.Mesh(new THREE.BoxGeometry(width * 0.95, 0.58, 0.92), bodyMat);
  noseLower.position.set(0, 0.72, -length * 0.5 - 0.28);
  noseLower.castShadow = true;
  bodyGroup.add(noseLower);

  const noseHood = new THREE.Mesh(new THREE.BoxGeometry(width * 0.9, 0.16, 1.04), bodyMat);
  noseHood.position.set(0, 1.07, -length * 0.5 - 0.18);
  noseHood.rotation.x = 0.24;
  noseHood.castShadow = true;
  bodyGroup.add(noseHood);

  // Recessed slatted radiator grille & twin circular headlight buckets
  const grille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.72, 0.34, 0.08), darkMat);
  grille.position.set(0, 0.76, -length * 0.5 - 0.73);
  bodyGroup.add(grille);
  for (let s = -1; s <= 1; s += 1) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(width * 0.68, 0.03, 0.09), rebarMat);
    slat.position.set(0, 0.76 + s * 0.09, -length * 0.5 - 0.74);
    bodyGroup.add(slat);
  }

  for (const hx of [-width * 0.35, width * 0.35]) {
    const headlight = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12), darkMat);
    headlight.rotation.x = Math.PI * 0.5;
    headlight.position.set(hx, 0.8, -length * 0.5 - 0.73);
    bodyGroup.add(headlight);
  }

  // Dark hollow cabin interior + angled cracked dusty windshield
  const cabinCore = new THREE.Mesh(new THREE.BoxGeometry(width - 0.28, 0.8, length * 0.84), darkMat);
  cabinCore.position.set(0, 1.62, 0.2);
  bodyGroup.add(cabinCore);

  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.82, 0.78), glassMat);
  windshield.position.set(0, 1.61, -1.94);
  windshield.rotation.x = -0.34;
  windshield.rotation.y = Math.PI;
  bodyGroup.add(windshield);

  // Beveled multi-layer roof cap + roof rails + A/B/C/D pillars
  const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.12, 0.15, length * 0.86), bodyMat);
  roof.position.set(0, 2.04, 0.22);
  roof.castShadow = true;
  roof.receiveShadow = true;
  bodyGroup.add(roof);

  const roofCrown = new THREE.Mesh(new THREE.BoxGeometry(width - 0.38, 0.09, length * 0.78), bodyMat);
  roofCrown.position.set(0, 2.14, 0.24);
  bodyGroup.add(roofCrown);

  // Side mirror stubs
  for (const mx of [-width * 0.54, width * 0.54]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.07), rebarMat);
    mirror.position.set(mx, 1.48, -1.52);
    bodyGroup.add(mirror);
  }

  const pillarCoords: ReadonlyArray<readonly [number, number, number]> = [
    [-width * 0.44, -1.86, -0.32],
    [width * 0.44, -1.86, -0.32],
    [-width * 0.45, -0.45, 0],
    [width * 0.45, -0.45, 0],
    [-width * 0.45, 1.15, 0],
    [width * 0.45, 1.15, 0],
    [-width * 0.45, 2.32, 0.08],
    [width * 0.45, 2.32, 0.08],
  ];
  for (const [px, pz, tiltX] of pillarCoords) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.86, 0.15), bodyMat);
    pillar.position.set(px, 1.63, pz);
    pillar.rotation.x = tiltX;
    pillar.castShadow = true;
    bodyGroup.add(pillar);
  }

  // Sculpted double rear cargo doors, shattered recessed rear windows, tail lights & license recess
  const rearZ = length * 0.5;
  const rearUpperLeft = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.86, 0.14), bodyMat);
  rearUpperLeft.position.set(-width * 0.45, 1.62, rearZ - 0.07);
  bodyGroup.add(rearUpperLeft);

  const rearUpperRight = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.86, 0.14), bodyMat);
  rearUpperRight.position.set(width * 0.45, 1.62, rearZ - 0.07);
  bodyGroup.add(rearUpperRight);

  const rearCenterPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.86, 0.14), bodyMat);
  rearCenterPost.position.set(0, 1.62, rearZ - 0.07);
  bodyGroup.add(rearCenterPost);

  const rearTopHeader = new THREE.Mesh(new THREE.BoxGeometry(width - 0.08, 0.16, 0.15), bodyMat);
  rearTopHeader.position.set(0, 1.98, rearZ - 0.07);
  bodyGroup.add(rearTopHeader);

  const doorSeam = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.48, 0.04), darkMat);
  doorSeam.position.set(0, 1.18, rearZ + 0.01);
  bodyGroup.add(doorSeam);

  const doorHandle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.055, 0.05), rebarMat);
  doorHandle.position.set(-0.18, 1.06, rearZ + 0.025);
  bodyGroup.add(doorHandle);

  const plateRecess = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.03), darkMat);
  plateRecess.position.set(-0.46, 0.86, rearZ + 0.015);
  bodyGroup.add(plateRecess);

  for (const wx of [-width * 0.23, width * 0.23]) {
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.56, 0.06), darkMat);
    winFrame.position.set(wx, 1.62, rearZ - 0.08);
    bodyGroup.add(winFrame);
  }
  const rearGlassShard = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.46), glassMat);
  rearGlassShard.position.set(width * 0.23, 1.62, rearZ - 0.03);
  bodyGroup.add(rearGlassShard);

  const tailLightMat = new THREE.MeshStandardMaterial({
    color: 0x561a14,
    roughness: 0.42,
    metalness: 0.12,
  });
  for (const tx of [-width * 0.43, width * 0.43]) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.08), darkMat);
    housing.position.set(tx, 0.86, rearZ + 0.01);
    bodyGroup.add(housing);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.28, 0.06), tailLightMat);
    lens.position.set(tx, 0.86, rearZ + 0.035);
    bodyGroup.add(lens);
  }

  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.2, 0.2), rebarMat);
  frontBumper.position.set(0, 0.46, -length * 0.5 - 0.74);
  frontBumper.castShadow = true;
  bodyGroup.add(frontBumper);

  const rearStepBumper = new THREE.Mesh(new THREE.BoxGeometry(width + 0.16, 0.22, 0.28), rebarMat);
  rearStepBumper.position.set(0, 0.45, rearZ + 0.14);
  rearStepBumper.castShadow = true;
  bodyGroup.add(rearStepBumper);

  const wheelGeo = new THREE.CylinderGeometry(0.41, 0.41, 0.28, 16);
  wheelGeo.rotateZ(Math.PI * 0.5);
  const hubGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.3, 12);
  hubGeo.rotateZ(Math.PI * 0.5);
  const archGeo = new THREE.TorusGeometry(0.48, 0.07, 6, 14, Math.PI);
  archGeo.rotateY(Math.PI * 0.5);

  const wheelPos: ReadonlyArray<readonly [number, number]> = [
    [-width * 0.47, -1.52],
    [width * 0.47, -1.52],
    [-width * 0.47, 1.56],
    [width * 0.47, 1.56],
  ];
  for (const [wx, wz] of wheelPos) {
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.position.set(wx, 0.34, wz);
    wheel.castShadow = true;
    bodyGroup.add(wheel);

    const hub = new THREE.Mesh(hubGeo, rebarMat);
    hub.position.set(wx, 0.34, wz);
    bodyGroup.add(hub);

    const arch = new THREE.Mesh(archGeo, bodyMat);
    arch.position.set(wx + (wx < 0 ? -0.04 : 0.04), 0.42, wz);
    bodyGroup.add(arch);
  }

  const mossBlanket = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.22, 2.7), mossMat);
  mossBlanket.position.set(0, 2.2, 0.88);
  mossBlanket.rotation.z = 0.04;
  mossBlanket.castShadow = true;
  bodyGroup.add(mossBlanket);

  // Swaying botanical English ivy curtains mounted directly on van root so they drape cleanly
  // across the sculpted rusted_van.glb (4.50 m long x 2.35 m wide x 1.95 m tall at 0.90 scale)
  const vanCurtains: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [-1.13, 1.92, 0.55, 2.35, 1.45, -Math.PI * 0.5],
    [1.13, 1.92, 0.62, 2.25, 1.38, Math.PI * 0.5],
    [-0.56, 1.9, 2.26, 0.86, 0.95, 0],
    [0.62, 1.9, 2.26, 0.68, 0.68, 0],
  ];
  for (let i = 0; i < vanCurtains.length; i += 1) {
    const cfg = vanCurtains[i];
    if (!cfg) {
      continue;
    }
    const [vx, vy, vz, vw, vh, ry] = cfg;
    const geo = new THREE.PlaneGeometry(vw, vh, 2, 2);
    geo.translate(0, -vh * 0.5, 0);
    const curtain = new THREE.Mesh(geo, ivyMat);
    curtain.position.set(vx, vy, vz);
    curtain.rotation.y = ry;
    curtain.castShadow = true;
    van.add(curtain);
    swayItems.push({
      mesh: curtain,
      baseRotX: 0,
      baseRotZ: 0,
      phase: 6.2 + i * 0.9,
      amp: 0.036,
    });
  }

  // Tightened to match the 0.90-scaled rusted_van.glb footprint (2.35 m wide x 4.50 m long)
  obstacles.push(createObbObstacle(x, z, 2.38, 4.65, rotY));
  return { root: van, bodyGroup };
}

function buildAbandonedSedan(
  bodyMat: THREE.MeshStandardMaterial,
  darkMat: THREE.MeshStandardMaterial,
  glassMat: THREE.MeshPhysicalMaterial,
  tireMat: THREE.MeshStandardMaterial,
  rebarMat: THREE.MeshStandardMaterial,
  mossMat: THREE.MeshStandardMaterial,
  x: number,
  z: number,
  rotY: number,
  tiltZ: number,
  obstacles: Obstacle[],
  addMossCover = true,
): VehicleRig {
  const car = new THREE.Group();
  const y = getTerrainHeight(x, z);
  car.position.set(x, y - 0.07, z);
  car.rotation.set(0.025, rotY, tiltZ);

  const bodyGroup = new THREE.Group();
  car.add(bodyGroup);

  const length = 4.48;
  const width = 1.84;

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(width, 0.62, length * 0.92), bodyMat);
  chassis.position.set(0, 0.62, 0.04);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  bodyGroup.add(chassis);

  const frontNose = new THREE.Mesh(new THREE.BoxGeometry(width * 0.94, 0.5, 0.46), bodyMat);
  frontNose.position.set(0, 0.56, -length * 0.5 + 0.14);
  frontNose.castShadow = true;
  bodyGroup.add(frontNose);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(width * 0.88, 0.13, 1.5), bodyMat);
  hood.position.set(0, 0.94, -1.4);
  hood.rotation.x = 0.12;
  hood.castShadow = true;
  bodyGroup.add(hood);

  const trunk = new THREE.Mesh(new THREE.BoxGeometry(width * 0.88, 0.14, 1.06), bodyMat);
  trunk.position.set(0, 0.95, 1.62);
  trunk.rotation.x = -0.07;
  trunk.castShadow = true;
  bodyGroup.add(trunk);

  // Slatted front grille + headlight sockets
  const grille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.56, 0.24, 0.06), darkMat);
  grille.position.set(0, 0.62, -length * 0.5 - 0.09);
  bodyGroup.add(grille);
  const grilleBar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.54, 0.03, 0.08), rebarMat);
  grilleBar.position.set(0, 0.62, -length * 0.5 - 0.1);
  bodyGroup.add(grilleBar);

  for (const hx of [-width * 0.36, width * 0.36]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.07), darkMat);
    lamp.position.set(hx, 0.65, -length * 0.5 - 0.08);
    bodyGroup.add(lamp);
  }

  const cabinCore = new THREE.Mesh(new THREE.BoxGeometry(width * 0.74, 0.54, 1.72), darkMat);
  cabinCore.position.set(0, 1.2, 0.15);
  bodyGroup.add(cabinCore);

  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.78, 0.72), glassMat);
  windshield.position.set(0, 1.24, -0.78);
  windshield.rotation.x = -0.68;
  windshield.rotation.y = Math.PI;
  bodyGroup.add(windshield);

  const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.76, 0.66), glassMat);
  rearGlass.position.set(0, 1.24, 1.08);
  rearGlass.rotation.x = -0.64;
  bodyGroup.add(rearGlass);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(width * 0.8, 0.11, 1.64), bodyMat);
  roof.position.set(0, 1.5, 0.16);
  roof.castShadow = true;
  roof.receiveShadow = true;
  bodyGroup.add(roof);

  const roofCrown = new THREE.Mesh(new THREE.BoxGeometry(width * 0.68, 0.07, 1.48), bodyMat);
  roofCrown.position.set(0, 1.56, 0.16);
  bodyGroup.add(roofCrown);

  const pillarSpecs: ReadonlyArray<readonly [number, number, number]> = [
    [-width * 0.39, -0.74, -0.58],
    [width * 0.39, -0.74, -0.58],
    [-width * 0.4, 0.16, 0],
    [width * 0.4, 0.16, 0],
    [-width * 0.39, 1.06, 0.54],
    [width * 0.39, 1.06, 0.54],
  ];
  for (const [px, pz, tiltX] of pillarSpecs) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.74, 0.11), bodyMat);
    pillar.position.set(px, 1.21, pz);
    pillar.rotation.x = tiltX;
    pillar.castShadow = true;
    bodyGroup.add(pillar);
  }

  for (const bz of [-length * 0.5 - 0.1, length * 0.5 + 0.06]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(width + 0.08, 0.16, 0.18), rebarMat);
    bumper.position.set(0, 0.4, bz);
    bodyGroup.add(bumper);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.24, 14);
  wheelGeo.rotateZ(Math.PI * 0.5);
  const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.26, 10);
  hubGeo.rotateZ(Math.PI * 0.5);
  const archGeo = new THREE.TorusGeometry(0.41, 0.06, 6, 14, Math.PI);
  archGeo.rotateY(Math.PI * 0.5);

  const wheels: ReadonlyArray<readonly [number, number]> = [
    [-width * 0.46, -1.35],
    [width * 0.46, -1.35],
    [-width * 0.46, 1.38],
    [width * 0.46, 1.38],
  ];
  for (const [wx, wz] of wheels) {
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.position.set(wx, 0.3, wz);
    wheel.castShadow = true;
    bodyGroup.add(wheel);

    const hub = new THREE.Mesh(hubGeo, rebarMat);
    hub.position.set(wx, 0.3, wz);
    bodyGroup.add(hub);

    const arch = new THREE.Mesh(archGeo, bodyMat);
    arch.position.set(wx + (wx < 0 ? -0.04 : 0.04), 0.36, wz);
    bodyGroup.add(arch);
  }

  if (addMossCover) {
    const hoodMoss = new THREE.Mesh(new THREE.BoxGeometry(width * 0.64, 0.1, 1.08), mossMat);
    hoodMoss.position.set(0.14, 1.02, -1.26);
    hoodMoss.rotation.x = 0.11;
    hoodMoss.rotation.z = 0.04;
    bodyGroup.add(hoodMoss);

    const roofMoss = new THREE.Mesh(new THREE.BoxGeometry(width * 0.66, 0.09, 1.12), mossMat);
    roofMoss.position.set(-0.08, 1.61, 0.22);
    bodyGroup.add(roofMoss);
  }

  obstacles.push(createObbObstacle(x, z, width + 0.25, length + 0.3, rotY));
  return { root: car, bodyGroup };
}

function buildDistantMountainRing(): THREE.Group {
  const group = new THREE.Group();
  const rng = createRng(90911);

  const layers: ReadonlyArray<{
    readonly radius: number;
    readonly baseHeight: number;
    readonly peakHeight: number;
    readonly color: number;
    readonly seedOffset: number;
  }> = [
    { radius: 132, baseHeight: -8, peakHeight: 42, color: 0x3b4837, seedOffset: 1.2 },
    { radius: 184, baseHeight: -10, peakHeight: 68, color: 0x566253, seedOffset: 4.7 },
    { radius: 245, baseHeight: -12, peakHeight: 96, color: 0x777d6b, seedOffset: 8.3 },
  ];

  for (const layer of layers) {
    const segs = 96;
    const positions: number[] = [];
    const indices: number[] = [];
    let firstTopY = 0;

    for (let i = 0; i <= segs; i += 1) {
      const t = i / segs;
      const angle = t * Math.PI * 2;
      const x = Math.cos(angle) * layer.radius;
      const z = Math.sin(angle) * layer.radius - 28;

      const dirToNorth = -Math.sin(angle);
      const valleyDip = 1 - smoothstep(0.86, 1.0, dirToNorth) * 0.42;

      let topY: number;
      if (i === segs) {
        topY = firstTopY;
      } else {
        const ridge =
          0.5 +
          0.3 * Math.sin(angle * 7 + layer.seedOffset) +
          0.22 * Math.cos(angle * 13 - layer.seedOffset * 1.6) +
          0.14 * Math.sin(angle * 23 + rng() * 0.25);
        topY = layer.baseHeight + Math.max(8, ridge * layer.peakHeight * valleyDip);
        if (i === 0) {
          firstTopY = topY;
        }
      }

      positions.push(x, layer.baseHeight - 16, z);
      positions.push(x, topY, z);
    }

    for (let i = 0; i < segs; i += 1) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: layer.color,
      roughness: 0.98,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const ridgeMesh = new THREE.Mesh(geo, mat);
    group.add(ridgeMesh);
  }

  return group;
}

function buildUtilityPoles(
  barkMat: THREE.MeshStandardMaterial,
  wireMat: THREE.LineBasicMaterial,
  obstacles: Obstacle[],
): THREE.Group {
  const group = new THREE.Group();
  const poleZs = [5.5, -14.5, -34.5, -54.5, -74.5];
  const crossarmTipsLeft: THREE.Vector3[] = [];
  const crossarmTipsRight: THREE.Vector3[] = [];

  for (let i = 0; i < poleZs.length; i += 1) {
    const pz = poleZs[i];
    if (pz === undefined) {
      continue;
    }
    const px = getRoadCenterX(pz) + 5.9 + (i === 0 ? 1.8 : 0);
    const py = getTerrainHeight(px, pz);
    const poleH = 8.4;

    const poleGroup = new THREE.Group();
    poleGroup.position.set(px, py - 0.2, pz);
    poleGroup.rotation.set(
      (i % 2 === 0 ? 1 : -1) * 0.04,
      getRoadTangentAngle(pz),
      0.055 - i * 0.018,
    );

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, poleH, 8), barkMat);
    shaft.position.y = poleH * 0.5;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    poleGroup.add(shaft);

    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.14, 0.14), barkMat);
    arm.position.set(0, poleH - 0.65, 0);
    arm.castShadow = true;
    poleGroup.add(arm);

    group.add(poleGroup);
    poleGroup.updateMatrixWorld(true);

    const tipL = new THREE.Vector3(-0.85, poleH - 0.58, 0).applyMatrix4(poleGroup.matrixWorld);
    const tipR = new THREE.Vector3(0.85, poleH - 0.58, 0).applyMatrix4(poleGroup.matrixWorld);
    crossarmTipsLeft.push(tipL);
    crossarmTipsRight.push(tipR);

    obstacles.push({ kind: 'circle', x: px, z: pz, radius: 0.28 });
  }

  const addWireSpan = (points: readonly THREE.Vector3[]): void => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i];
      const p1 = points[i + 1];
      if (!p0 || !p1) {
        continue;
      }
      const mid = new THREE.Vector3(
        (p0.x + p1.x) * 0.5,
        (p0.y + p1.y) * 0.5 - 1.45,
        (p0.z + p1.z) * 0.5,
      );
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(14));
      const line = new THREE.Line(geo, wireMat);
      group.add(line);
    }
  };
  addWireSpan(crossarmTipsLeft);
  addWireSpan(crossarmTipsRight);

  return group;
}

export function createFrontierEnvironment(
  initialQuality: GraphicsQuality = 'high',
  sunDirection: THREE.Vector3 = new THREE.Vector3(0.46, 0.25, -0.85).normalize(),
): FrontierEnvironment {
  const atlas = getWorldTextureAtlas();
  const root = new THREE.Group();
  const obstacles: Obstacle[] = [];
  const swayItems: SwayItem[] = [];
  const mistCards: MistCard[] = [];
  const mirrorPuddles: MirrorPuddlePair[] = [];
  let disposed = false;

  // Shared GPU wind uniforms driving pine canopies, sword ferns, wild grass & ivy in unison
  const windUniforms: WindUniforms = {
    uWindTime: { value: 0 },
    uWindStrength: { value: 1.0 },
  };

  // Photorealistic PBR materials with tangent-space Sobel normalMap + aligned roughnessMap
  const forestMat = createStandardMaterial(atlas.forestFloor, {
    roughness: 1.0,
    metalness: 0.02,
    normalScale: 1.2,
    vertexColors: true,
  });
  const highwayMat = createStandardMaterial(atlas.highway, {
    roughness: 1.0,
    metalness: 0.04,
    normalScale: 1.25,
    polygonOffset: true,
  });
  const concreteMat = createStandardMaterial(atlas.concrete, {
    roughness: 1.0,
    metalness: 0.03,
    normalScale: 1.2,
  });
  const mossRockMat = createStandardMaterial(atlas.mossyRock, {
    roughness: 1.0,
    metalness: 0.03,
    normalScale: 1.4,
  });
  const darkInteriorMat = new THREE.MeshStandardMaterial({
    color: 0x0c100d,
    roughness: 0.98,
    metalness: 0,
  });
  const crackedGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0x161c18,
    roughness: 0.24,
    metalness: 0.12,
    clearcoat: 0.85,
    clearcoatRoughness: 0.2,
    transparent: true,
    opacity: 0.74,
    side: THREE.DoubleSide,
  });
  const mossMat = createStandardMaterial(atlas.forestFloor, {
    color: 0x67803c,
    roughness: 1.0,
    metalness: 0.01,
    normalScale: 1.25,
  });
  const rustVanMat = createStandardMaterial(atlas.rustVan, {
    roughness: 1.0,
    metalness: 0.36,
    normalScale: 1.3,
  });
  const rustSedanMat = createStandardMaterial(atlas.rustSedan, {
    roughness: 1.0,
    metalness: 0.34,
    normalScale: 1.35,
  });
  const rustDarkMat = createStandardMaterial(atlas.rustDark, {
    roughness: 1.0,
    metalness: 0.32,
    normalScale: 1.35,
  });
  const rebarMat = new THREE.MeshStandardMaterial({
    color: 0x4b2e1e,
    roughness: 0.86,
    metalness: 0.58,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c1a,
    roughness: 0.92,
    metalness: 0.05,
  });
  const barkMat = createStandardMaterial(atlas.pineBark, {
    roughness: 1.0,
    metalness: 0.01,
    normalScale: 1.45,
  });
  const alderBarkMat = new THREE.MeshStandardMaterial({
    color: 0xa6a398,
    normalMap: atlas.pineBark.normalMap,
    normalScale: new THREE.Vector2(0.48, 0.48),
    roughnessMap: atlas.pineBark.roughnessMap,
    roughness: 0.94,
    metalness: 0.01,
    vertexColors: true,
  });
  const snagBarkMat = new THREE.MeshStandardMaterial({
    color: 0x999488,
    normalMap: atlas.pineBark.normalMap,
    normalScale: new THREE.Vector2(1.65, 1.65),
    roughnessMap: atlas.pineBark.roughnessMap,
    roughness: 0.98,
    metalness: 0.01,
    vertexColors: true,
  });

  // Real botanical alpha-cutout foliage materials + GPU vertex wind simulation
  const pineBoughMat = new THREE.MeshStandardMaterial({
    map: atlas.pineBough.map,
    normalMap: atlas.pineBough.normalMap,
    normalScale: new THREE.Vector2(0.95, 0.95),
    alphaTest: 0.38,
    roughness: 0.86,
    metalness: 0.02,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  injectGpuWind(pineBoughMat, windUniforms, 'pine', 0.013, 1.35);

  const alderCanopyMat = new THREE.MeshStandardMaterial({
    map: atlas.ivyCurtain.map,
    normalMap: atlas.ivyCurtain.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    alphaTest: 0.34,
    roughness: 0.78,
    metalness: 0.02,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  injectGpuWind(alderCanopyMat, windUniforms, 'pine', 0.017, 1.62);

  const ivyMat = new THREE.MeshStandardMaterial({
    map: atlas.ivyCurtain.map,
    normalMap: atlas.ivyCurtain.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    alphaTest: 0.36,
    roughness: 0.82,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });

  const fernMat = new THREE.MeshStandardMaterial({
    map: atlas.fernFrond.map,
    normalMap: atlas.fernFrond.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    alphaTest: 0.34,
    roughness: 0.78,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  injectGpuWind(fernMat, windUniforms, 'fern', 0.055, 2.15);

  const grassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.01,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  injectGpuWind(grassMat, windUniforms, 'grass', 0.068, 2.55);

  const wireMat = new THREE.LineBasicMaterial({
    color: 0x20211d,
    transparent: true,
    opacity: 0.72,
  });

  // Linear-space fog color accurately matching Three.js FogExp2('#b9a279')
  const linearFogColor = new THREE.Color('#b9a279');

  const puddleUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDirection.clone() },
    uFogColor: { value: linearFogColor.clone() },
    uFogDensity: { value: 0.0108 },
    uReflectStrength: { value: 1.0 },
    uNightFactor: { value: 0.0 },
    uCloudCover: { value: 0.25 },
  };
  const puddleMat = new THREE.ShaderMaterial({
    vertexShader: PUDDLE_VERTEX_SHADER,
    fragmentShader: PUDDLE_FRAGMENT_SHADER,
    uniforms: puddleUniforms,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -5,
  });

  const sharedMaterials = new Set<THREE.Material>([
    forestMat,
    highwayMat,
    concreteMat,
    mossRockMat,
    darkInteriorMat,
    crackedGlassMat,
    mossMat,
    rustVanMat,
    rustSedanMat,
    rustDarkMat,
    rebarMat,
    tireMat,
    barkMat,
    alderBarkMat,
    snagBarkMat,
    pineBoughMat,
    alderCanopyMat,
    ivyMat,
    fernMat,
    grassMat,
    wireMat,
    puddleMat,
  ]);

  // 1. Displaced terrain, cracked highway, foreground concrete overlook & distant mountain ring
  root.add(buildTerrainMesh(forestMat));
  root.add(buildHighwayRibbon(highwayMat));
  root.add(buildOverlookLedge(concreteMat, mossRockMat, rebarMat));
  root.add(buildDistantMountainRing());

  // 2. Rainwater puddles: 2 foreground hero REAL-TIME planar mirror puddles (Reflector) + 5 distant Fresnel puddles
  const puddleSpecs: ReadonlyArray<readonly [number, number, number, number, number, boolean]> = [
    [2.15, 9.6, 1.55, 2.35, 1.1, true],
    [1.45, 6.2, 1.25, 1.85, 2.4, true],
    [0.25, 2.5, 1.05, 1.35, 3.8, false],
    [2.35, -1.6, 1.35, 1.9, 5.2, false],
    [0.55, -8.2, 1.2, 1.65, 6.7, false],
    [1.8, -16.4, 1.45, 2.1, 8.1, false],
    [0.1, -28.5, 1.6, 2.2, 9.4, false],
  ];
  const puddleZones: PuddleZone[] = [];
  const foliageExclusionZones: PuddleZone[] = [];

  // Prevent nested reflection recursion and skip reflection renders during GTAO override passes
  let isRenderingReflection = false;

  for (const [px, pz, rx, rz, seed, usePlanarMirror] of puddleSpecs) {
    const roadX = getRoadCenterX(pz) + (px - 1.3);
    puddleZones.push({ x: roadX, z: pz, rx: rx * 1.05, rz: rz * 1.05 });
    foliageExclusionZones.push({ x: roadX, z: pz, rx: rx * 1.38 + 0.45, rz: rz * 1.38 + 0.45 });

    const conformingGeo = createConformingPuddleGeometry(roadX, pz, rx, rz, seed);
    const fallbackPuddle = new THREE.Mesh(conformingGeo, puddleMat);
    fallbackPuddle.position.set(roadX, 0, pz);
    fallbackPuddle.userData['excludeFromGtao'] = true;
    root.add(fallbackPuddle);

    if (usePlanarMirror) {
      const planarGeo = createPlanarPuddleGeometry(rx, rz, seed);
      const timeUniform = { value: 0 };
      const sunDirUniform = { value: sunDirection.clone() };
      const fogColorUniform = { value: linearFogColor.clone() };
      const fogDensityUniform = { value: 0.0108 };
      const reflectStrengthUniform = { value: 1.0 };
      const nightFactorUniform = { value: 0.0 };
      const cloudCoverUniform = { value: 0.25 };

      const reflector = new Reflector(planarGeo, {
        textureWidth: 512,
        textureHeight: 512,
        clipBias: 0.004,
        multisample: 0,
        shader: {
          name: 'FrontierMirrorPuddleShader',
          uniforms: {
            color: { value: null },
            tDiffuse: { value: null },
            textureMatrix: { value: null },
            uTime: timeUniform,
            uSunDir: sunDirUniform,
            uFogColor: fogColorUniform,
            uFogDensity: fogDensityUniform,
            uReflectStrength: reflectStrengthUniform,
            uNightFactor: nightFactorUniform,
            uCloudCover: cloudCoverUniform,
          },
          vertexShader: PLANAR_MIRROR_PUDDLE_VERTEX,
          fragmentShader: PLANAR_MIRROR_PUDDLE_FRAGMENT,
        },
      });

      const mat = reflector.material;
      if (mat instanceof THREE.ShaderMaterial) {
        mat.transparent = true;
        mat.depthWrite = false;
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -3;
        mat.polygonOffsetUnits = -5;
        // Re-bind live uniform references because Reflector clones shader.uniforms
        const clonedTime = mat.uniforms['uTime'];
        const clonedSunDir = mat.uniforms['uSunDir'];
        const clonedFogC = mat.uniforms['uFogColor'];
        const clonedFogD = mat.uniforms['uFogDensity'];
        const clonedRefl = mat.uniforms['uReflectStrength'];
        const clonedNight = mat.uniforms['uNightFactor'];
        const clonedCloud = mat.uniforms['uCloudCover'];

        // Align mirror plane flush with local road slope and sample max road micro-wear across footprint
        const hFront = getTerrainHeight(roadX, pz - 1.2);
        const hBack = getTerrainHeight(roadX, pz + 1.2);
        const slopePitch = Math.atan2(hFront - hBack, 2.4);
        const slopeSin = Math.sin(slopePitch);
        const centerH = getTerrainHeight(roadX, pz);

        let maxLiftAbovePlane = 0;
        const sampleOffsets: ReadonlyArray<readonly [number, number]> = [
          [0, 0],
          [-rx * 0.55, 0],
          [rx * 0.55, 0],
          [0, -rz * 0.55],
          [0, rz * 0.55],
        ];
        for (const [ox, oz] of sampleOffsets) {
          const groundH = getTerrainHeight(roadX + ox, pz + oz);
          const planeH = centerH + -oz * slopeSin;
          const excess = groundH - planeH;
          if (excess > maxLiftAbovePlane) {
            maxLiftAbovePlane = excess;
          }
        }

        reflector.position.set(roadX, centerH + maxLiftAbovePlane + 0.058, pz);
        reflector.rotation.set(-Math.PI * 0.5 + slopePitch, 0, 0);
        reflector.userData['excludeFromGtao'] = true;

        const origBeforeRender = reflector.onBeforeRender;
        reflector.onBeforeRender = function guardedBeforeRender(
          r: THREE.WebGLRenderer,
          s: THREE.Scene,
          c: THREE.Camera,
          g: THREE.BufferGeometry,
          m: THREE.Material,
          grp: THREE.Group,
        ): void {
          if (s.overrideMaterial !== null || isRenderingReflection) {
            return;
          }
          isRenderingReflection = true;
          try {
            origBeforeRender.call(this, r, s, c, g, m, grp);
          } finally {
            isRenderingReflection = false;
          }
        };

        root.add(reflector);
        mirrorPuddles.push({
          reflector,
          fallback: fallbackPuddle,
          timeUniform: clonedTime ? (clonedTime as { value: number }) : timeUniform,
          sunDirUniform: clonedSunDir ? (clonedSunDir as { value: THREE.Vector3 }) : sunDirUniform,
          fogColorUniform: clonedFogC ? (clonedFogC as { value: THREE.Color }) : fogColorUniform,
          fogDensityUniform: clonedFogD ? (clonedFogD as { value: number }) : fogDensityUniform,
          reflectStrengthUniform: clonedRefl
            ? (clonedRefl as { value: number })
            : reflectStrengthUniform,
          nightFactorUniform: clonedNight ? (clonedNight as { value: number }) : nightFactorUniform,
          cloudCoverUniform: clonedCloud ? (clonedCloud as { value: number }) : cloudCoverUniform,
        });
      }
    }
  }

  const isInsidePuddleFootstep = (x: number, z: number): boolean => {
    for (let i = 0; i < puddleZones.length; i += 1) {
      const zone = puddleZones[i];
      if (!zone) {
        continue;
      }
      const nx = (x - zone.x) / zone.rx;
      const nz = (z - zone.z) / zone.rz;
      if (nx * nx + nz * nz < 1.0) {
        return true;
      }
    }
    return false;
  };

  const isInsideFoliageExclusion = (x: number, z: number): boolean => {
    for (let i = 0; i < foliageExclusionZones.length; i += 1) {
      const zone = foliageExclusionZones[i];
      if (!zone) {
        continue;
      }
      const nx = (x - zone.x) / zone.rx;
      const nz = (z - zone.z) / zone.rz;
      if (nx * nx + nz * nz < 1.0) {
        return true;
      }
    }
    return false;
  };

  // 3. Overgrown roadside ruins (Right gas station + Left retaining bunker)
  const gasStation = buildGasStationRuin(
    concreteMat,
    darkInteriorMat,
    rustDarkMat,
    rebarMat,
    ivyMat,
    mossMat,
    obstacles,
    swayItems,
  );
  root.add(gasStation);

  const leftBunker = buildLeftBunkerRuin(
    concreteMat,
    darkInteriorMat,
    rebarMat,
    ivyMat,
    mossMat,
    obstacles,
    swayItems,
  );
  root.add(leftBunker);

  // 4. Sculpted abandoned rusted vehicles
  const vanRig = buildAbandonedVan(
    rustVanMat,
    darkInteriorMat,
    crackedGlassMat,
    tireMat,
    rebarMat,
    mossMat,
    ivyMat,
    6.15,
    2.45,
    -0.58,
    obstacles,
    swayItems,
  );
  root.add(vanRig.root);

  const sedanMid = buildAbandonedSedan(
    rustSedanMat,
    darkInteriorMat,
    crackedGlassMat,
    tireMat,
    rebarMat,
    mossMat,
    -1.65,
    -4.1,
    0.82,
    -0.04,
    obstacles,
    true,
  );
  root.add(sedanMid.root);

  const sedanDistant = buildAbandonedSedan(
    rustDarkMat,
    darkInteriorMat,
    crackedGlassMat,
    tireMat,
    rebarMat,
    mossMat,
    2.55,
    -21.5,
    -0.46,
    0.05,
    obstacles,
    true,
  );
  root.add(sedanDistant.root);

  const sedanForeRight = buildAbandonedSedan(
    rustDarkMat,
    darkInteriorMat,
    crackedGlassMat,
    tireMat,
    rebarMat,
    mossMat,
    7.25,
    10.4,
    -0.92,
    -0.08,
    obstacles,
    true,
  );
  root.add(sedanForeRight.root);

  const sedanFar = buildAbandonedSedan(
    rustSedanMat,
    darkInteriorMat,
    crackedGlassMat,
    tireMat,
    rebarMat,
    mossMat,
    -2.9,
    -43.5,
    0.34,
    -0.03,
    obstacles,
    false,
  );
  root.add(sedanFar.root);

  // Spatial acoustic anchors for faint rusty wind creaks near the gas station & wrecked vehicles
  const metalCreakAnchors: ReadonlyArray<readonly [number, number, number]> = [
    [11.2, -6.5, 18.0],
    [6.15, 2.45, 11.5],
    [-1.65, -4.1, 10.5],
    [-9.6, 4.0, 12.0],
  ];

  // Async sculpted Hunyuan3D + Blender .glb replacement (preserving sway ivy, world transform & OBB colliders)
  void loadOptionalGlbSlot('overgrown_van').then((loaded) => {
    if (!loaded) {
      return;
    }
    if (disposed) {
      disposeObject3D(loaded);
      return;
    }
    disposeChildrenAndPruneSway(vanRig.bodyGroup, swayItems, sharedMaterials);
    const wrapper = new THREE.Group();
    wrapper.rotation.y = -Math.PI * 0.5;
    wrapper.scale.setScalar(0.9);
    wrapper.position.y = -0.04;
    wrapper.add(loaded);
    vanRig.bodyGroup.add(wrapper);
  });

  const sedanSlots: ReadonlyArray<{ readonly rig: VehicleRig; readonly tint: number }> = [
    { rig: sedanMid, tint: 0xffffff },
    { rig: sedanDistant, tint: 0xd6cec4 },
    { rig: sedanForeRight, tint: 0xbfc6c2 },
    { rig: sedanFar, tint: 0xdcc6b0 },
  ];

  void loadOptionalGlbSlot('abandoned_sedan').then((loaded) => {
    if (!loaded) {
      return;
    }
    if (disposed) {
      disposeObject3D(loaded);
      return;
    }
    // Clone and tint slots 1..N from the untouched original material BEFORE tinting slot 0
    for (let i = sedanSlots.length - 1; i >= 0; i -= 1) {
      const entry = sedanSlots[i];
      if (!entry) {
        continue;
      }
      disposeChildrenAndPruneSway(entry.rig.bodyGroup, swayItems, sharedMaterials);
      const instance = i === 0 ? loaded : loaded.clone(true);
      applyTintedMaterials(instance, entry.tint, i > 0);
      const wrapper = new THREE.Group();
      wrapper.rotation.y = Math.PI * 0.5;
      wrapper.scale.setScalar(0.96);
      wrapper.position.y = -0.04;
      wrapper.add(instance);
      entry.rig.bodyGroup.add(wrapper);
    }
  });

  // 5. Tilted wooden utility poles receding down the right edge of the highway
  root.add(buildUtilityPoles(barkMat, wireMat, obstacles));

  // 6. Diverse 5-archetype Pacific Northwest forest (Douglas Fir, Sitka Spruce, Broad Pine, Red Alder, Dead Snag)
  const rng = createRng(135791);
  interface TreePlacement {
    readonly species: TreeSpecies;
    readonly x: number;
    readonly z: number;
    readonly height: number;
    readonly widthScaleX: number;
    readonly widthScaleZ: number;
    readonly leanX: number;
    readonly leanZ: number;
    readonly yaw: number;
    readonly tint: number;
    readonly barkShift: number;
    readonly hueShift: number;
  }

  const trees: TreePlacement[] = [];

  // Foreground golden-olive Red Alder framing the left foreground vista clear of the bunker OBB, boulders, and hiker pack
  trees.push({
    species: 'alder',
    x: -6.9,
    z: 9.8,
    height: 7.4,
    widthScaleX: 1.08,
    widthScaleZ: 0.98,
    leanX: 0.03,
    leanZ: -0.02,
    yaw: 0.55,
    tint: 1.06,
    barkShift: 1.02,
    hueShift: 0.55,
  });

  // Hand-curated multi-species hero vista framing Old Route 9 from spawn down the valley
  const heroTreeCoords: ReadonlyArray<readonly [number, number, number, TreeSpecies]> = [
    [-12.6, 12.6, 21.5, 'douglas_fir'],
    [-15.2, 8.8, 23.2, 'spruce'],
    [-15.4, 1.4, 18.8, 'broad_pine'],
    [-9.6, -4.4, 11.4, 'alder'],
    [-11.8, -12.0, 22.4, 'douglas_fir'],
    [-8.6, -22.5, 13.8, 'dead_snag'],
    [13.4, 12.6, 21.8, 'spruce'],
    [17.0, 5.4, 18.2, 'broad_pine'],
    [18.8, -4.5, 24.6, 'douglas_fir'],
    [15.8, -16.8, 10.8, 'alder'],
    [10.4, -26.0, 19.8, 'spruce'],
  ];
  for (const [tx, tz, th, species] of heroTreeCoords) {
    const baseW =
      species === 'broad_pine'
        ? 1.02 + rng() * 0.24
        : species === 'spruce'
          ? 0.84 + rng() * 0.22
          : 0.92 + rng() * 0.26;
    const asym = 0.91 + rng() * 0.18;
    const leanAmp = species === 'dead_snag' ? 0.11 : 0.06;
    trees.push({
      species,
      x: tx,
      z: tz,
      height: th,
      widthScaleX: baseW * asym,
      widthScaleZ: baseW * (2.0 - asym),
      leanX: (rng() - 0.5) * leanAmp,
      leanZ: (rng() - 0.5) * leanAmp,
      yaw: rng() * Math.PI * 2,
      tint: 0.86 + rng() * 0.28,
      barkShift: 0.9 + rng() * 0.2,
      hueShift: rng(),
    });
  }

  const maxTrees = 265;
  let attempts = 0;
  while (trees.length < maxTrees && attempts < 2400) {
    attempts += 1;
    const tx = (rng() - 0.5) * 140;
    const tz = -104 + rng() * 140;
    const roadX = getRoadCenterX(tz);
    const distRoad = Math.abs(tx - roadX);

    const minClearance = tz < -52 ? 5.6 : 7.5;
    if (distRoad < minClearance) {
      continue;
    }
    if (Math.hypot(tx - 12.6, tz + 6.8) < 9.5) {
      continue;
    }
    if (Math.hypot(tx + 9.6, tz - 4.0) < 6.8) {
      continue;
    }
    if (tx < -4.0 && tx > -12.0 && tz > 5.0 && tz < 13.0) {
      continue;
    }
    if (Math.hypot(tx - SPAWN_POINT.x, tz - SPAWN_POINT.z) < 5.6) {
      continue;
    }

    let tooClose = false;
    for (let j = 0; j < trees.length; j += 1) {
      const other = trees[j];
      if (other && Math.hypot(tx - other.x, tz - other.z) < 3.5) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }

    const rollSpecies = rng();
    let species: TreeSpecies;
    let height: number;
    let baseW: number;
    if (rollSpecies < 0.32) {
      species = 'douglas_fir';
      height = 13.5 + rng() * 11.5;
      baseW = 0.86 + rng() * 0.34;
    } else if (rollSpecies < 0.58) {
      species = 'spruce';
      height = 13.0 + rng() * 12.5;
      baseW = 0.78 + rng() * 0.3;
    } else if (rollSpecies < 0.78) {
      species = 'broad_pine';
      height = 11.5 + rng() * 9.5;
      baseW = 0.94 + rng() * 0.36;
    } else if (rollSpecies < 0.92) {
      species = 'alder';
      height = 6.8 + rng() * 6.2;
      baseW = 0.92 + rng() * 0.34;
    } else {
      species = 'dead_snag';
      height = 7.5 + rng() * 8.0;
      baseW = 0.85 + rng() * 0.3;
    }

    const asym = 0.9 + rng() * 0.2;
    const leanAmp = species === 'dead_snag' ? 0.13 : species === 'broad_pine' ? 0.085 : 0.065;
    trees.push({
      species,
      x: tx,
      z: tz,
      height,
      widthScaleX: baseW * asym,
      widthScaleZ: baseW * (2.0 - asym),
      leanX: (rng() - 0.5) * leanAmp,
      leanZ: (rng() - 0.5) * leanAmp,
      yaw: rng() * Math.PI * 2,
      tint: 0.76 + rng() * 0.36,
      barkShift: 0.88 + rng() * 0.24,
      hueShift: rng(),
    });
  }

  const buckets: Record<TreeSpecies, TreePlacement[]> = {
    douglas_fir: [],
    spruce: [],
    broad_pine: [],
    alder: [],
    dead_snag: [],
  };
  for (let i = 0; i < trees.length; i += 1) {
    const t = trees[i];
    if (t) {
      buckets[t.species].push(t);
    }
  }

  interface SpeciesBuildConfig {
    readonly species: TreeSpecies;
    readonly createTrunk: () => THREE.BufferGeometry;
    readonly createCanopy: (() => THREE.BufferGeometry) | null;
    readonly trunkMaterial: THREE.MeshStandardMaterial;
    readonly canopyMaterial: THREE.MeshStandardMaterial | null;
    readonly trunkCollisionRatio: number;
  }

  const speciesConfigs: ReadonlyArray<SpeciesBuildConfig> = [
    {
      species: 'douglas_fir',
      createTrunk: createDouglasFirTrunkGeometry,
      createCanopy: createDouglasFirCanopyGeometry,
      trunkMaterial: barkMat,
      canopyMaterial: pineBoughMat,
      trunkCollisionRatio: 0.025,
    },
    {
      species: 'spruce',
      createTrunk: createSpruceTrunkGeometry,
      createCanopy: createSpruceCanopyGeometry,
      trunkMaterial: barkMat,
      canopyMaterial: pineBoughMat,
      trunkCollisionRatio: 0.021,
    },
    {
      species: 'broad_pine',
      createTrunk: createBroadPineTrunkGeometry,
      createCanopy: createBroadPineCanopyGeometry,
      trunkMaterial: barkMat,
      canopyMaterial: pineBoughMat,
      trunkCollisionRatio: 0.03,
    },
    {
      species: 'alder',
      createTrunk: createAlderTrunkGeometry,
      createCanopy: createAlderCanopyGeometry,
      trunkMaterial: alderBarkMat,
      canopyMaterial: alderCanopyMat,
      trunkCollisionRatio: 0.023,
    },
    {
      species: 'dead_snag',
      createTrunk: createDeadSnagTrunkGeometry,
      createCanopy: null,
      trunkMaterial: snagBarkMat,
      canopyMaterial: null,
      trunkCollisionRatio: 0.027,
    },
  ];

  const dummy = new THREE.Object3D();
  const instColor = new THREE.Color();

  for (const cfg of speciesConfigs) {
    const list = buckets[cfg.species];
    if (list.length === 0) {
      continue;
    }

    const trunkGeo = cfg.createTrunk();
    const trunkInst = new THREE.InstancedMesh(trunkGeo, cfg.trunkMaterial, list.length);
    trunkInst.castShadow = true;
    trunkInst.receiveShadow = true;

    const canopyInst =
      cfg.createCanopy && cfg.canopyMaterial
        ? new THREE.InstancedMesh(cfg.createCanopy(), cfg.canopyMaterial, list.length)
        : null;
    if (canopyInst) {
      canopyInst.castShadow = true;
      canopyInst.receiveShadow = true;
    }

    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      if (!t) {
        continue;
      }
      const baseY = getTerrainHeight(t.x, t.z) - 0.35;
      const scaleX = t.height * t.widthScaleX;
      const scaleZ = t.height * t.widthScaleZ;

      // Trunk & canopy share the exact same transform so forked limbs & foliage clouds align identically
      dummy.position.set(t.x, baseY, t.z);
      dummy.rotation.set(t.leanX, t.yaw, t.leanZ);
      dummy.scale.set(scaleX, t.height, scaleZ);
      dummy.updateMatrix();
      trunkInst.setMatrixAt(i, dummy.matrix);

      // Species-distinct organic bark tinting
      if (cfg.species === 'douglas_fir') {
        instColor.setRGB(1.02 * t.barkShift, 0.9 * t.barkShift, 0.8 * t.barkShift);
      } else if (cfg.species === 'spruce') {
        instColor.setRGB(0.82 * t.barkShift, 0.82 * t.barkShift, 0.84 * t.barkShift);
      } else if (cfg.species === 'broad_pine') {
        instColor.setRGB(1.22 * t.barkShift, 1.0 * t.barkShift, 0.8 * t.barkShift);
      } else if (cfg.species === 'alder') {
        instColor.setRGB(0.96 * t.barkShift, 0.97 * t.barkShift, 0.94 * t.barkShift);
      } else {
        instColor.setRGB(0.94 * t.barkShift, 0.93 * t.barkShift, 0.9 * t.barkShift);
      }
      trunkInst.setColorAt(i, instColor);

      if (canopyInst) {
        canopyInst.setMatrixAt(i, dummy.matrix);
        if (cfg.species === 'douglas_fir') {
          instColor.setRGB(0.86 * t.tint, 0.96 * t.tint, 0.82 * t.tint);
        } else if (cfg.species === 'spruce') {
          instColor.setRGB(0.74 * t.tint, 0.93 * t.tint, 0.9 * t.tint);
        } else if (cfg.species === 'broad_pine') {
          instColor.setRGB(0.98 * t.tint, 1.0 * t.tint, 0.76 * t.tint);
        } else {
          // Red Alder: warm olive-sage to golden late-summer foliage accent
          const gold = t.hueShift;
          instColor.setRGB(
            (0.92 + gold * 0.24) * t.tint,
            (0.98 + gold * 0.06) * t.tint,
            (0.68 - gold * 0.22) * t.tint,
          );
        }
        canopyInst.setColorAt(i, instColor);
      }

      if (Math.abs(t.x) <= 50 && t.z >= -86 && t.z <= 32) {
        const avgScaleXZ = (scaleX + scaleZ) * 0.5;
        const radius = Math.max(0.32, Math.min(0.84, avgScaleXZ * cfg.trunkCollisionRatio));
        obstacles.push({ kind: 'circle', x: t.x, z: t.z, radius });
      }
    }

    trunkInst.instanceMatrix.needsUpdate = true;
    if (trunkInst.instanceColor) {
      trunkInst.instanceColor.needsUpdate = true;
    }
    root.add(trunkInst);

    if (canopyInst) {
      canopyInst.instanceMatrix.needsUpdate = true;
      if (canopyInst.instanceColor) {
        canopyInst.instanceColor.needsUpdate = true;
      }
      root.add(canopyInst);
    }
  }

  // 7. Dense instanced western sword ferns (real botanical photo + corrected UVs + GPU wind!)
  const fernMax = 450;
  const fernGeo = createFernClusterGeometry();
  const fernInst = new THREE.InstancedMesh(fernGeo, fernMat, fernMax);
  fernInst.receiveShadow = true;

  let fernPlaced = 0;
  let fernTry = 0;
  while (fernPlaced < fernMax && fernTry < 3600) {
    fernTry += 1;
    const isHeroForeground = fernPlaced < 195;
    const fx = isHeroForeground ? (rng() - 0.5) * 30 : (rng() - 0.5) * 86;
    const fz = isHeroForeground ? -18 + rng() * 38 : -72 + rng() * 98;

    if (isInsideFoliageExclusion(fx, fz)) {
      continue;
    }
    const distRoad = Math.abs(fx - getRoadCenterX(fz));
    if (distRoad < 2.45 && rng() < 0.9) {
      continue;
    }
    if (Math.hypot(fx - SPAWN_POINT.x, fz - SPAWN_POINT.z) < 1.35) {
      continue;
    }
    if (Math.hypot(fx - 13.8, fz + 6.8) < 4.5) {
      continue;
    }

    const fy = getTerrainHeight(fx, fz) - 0.03;
    const scale = 0.68 + rng() * 0.84;
    dummy.position.set(fx, fy, fz);
    dummy.rotation.set((rng() - 0.5) * 0.16, rng() * Math.PI * 2, (rng() - 0.5) * 0.16);
    dummy.scale.set(scale, scale * (0.85 + rng() * 0.32), scale);
    dummy.updateMatrix();
    fernInst.setMatrixAt(fernPlaced, dummy.matrix);

    const gShade = 0.78 + rng() * 0.32;
    instColor.setRGB(0.88 * gShade, 0.96 * gShade, 0.74 * gShade);
    fernInst.setColorAt(fernPlaced, instColor);
    fernPlaced += 1;
  }
  fernInst.count = fernPlaced;
  fernInst.instanceMatrix.needsUpdate = true;
  if (fernInst.instanceColor) {
    fernInst.instanceColor.needsUpdate = true;
  }
  root.add(fernInst);

  // 8. Fine wild grass & road-crack weeds with GPU wind waves
  const grassMax = 680;
  const grassGeo = createGrassTuftGeometry();
  const grassInst = new THREE.InstancedMesh(grassGeo, grassMat, grassMax);
  grassInst.receiveShadow = true;

  let grassPlaced = 0;
  let grassTry = 0;
  while (grassPlaced < grassMax && grassTry < 4400) {
    grassTry += 1;
    const isNearRoad = grassPlaced < 340;
    const gz = isNearRoad ? -42 + rng() * 64 : -74 + rng() * 100;
    const gx = isNearRoad
      ? getRoadCenterX(gz) + (rng() - 0.5) * 16.5
      : (rng() - 0.5) * 76;

    if (isInsideFoliageExclusion(gx, gz)) {
      continue;
    }
    const distRoad = Math.abs(gx - getRoadCenterX(gz));
    if (distRoad < 2.6 && rng() < 0.78) {
      continue;
    }
    if (Math.hypot(gx - SPAWN_POINT.x, gz - SPAWN_POINT.z) < 1.15) {
      continue;
    }

    const gy = getTerrainHeight(gx, gz) + (distRoad < 3.6 ? 0.02 : -0.02);
    const scale = distRoad < 3.0 ? 0.55 + rng() * 0.5 : 0.78 + rng() * 0.72;
    dummy.position.set(gx, gy, gz);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.set(scale, scale * (0.8 + rng() * 0.45), scale);
    dummy.updateMatrix();
    grassInst.setMatrixAt(grassPlaced, dummy.matrix);

    const dryMix = rng();
    instColor.setRGB(0.62 + dryMix * 0.22, 0.72 + dryMix * 0.16, 0.44 + dryMix * 0.12);
    grassInst.setColorAt(grassPlaced, instColor);
    grassPlaced += 1;
  }
  grassInst.count = grassPlaced;
  grassInst.instanceMatrix.needsUpdate = true;
  if (grassInst.instanceColor) {
    grassInst.instanceColor.needsUpdate = true;
  }
  root.add(grassInst);

  // 9. High-detail rugged displaced mossy boulders (mossy_rock.jpg + normalMap) & fallen logs
  const boulderGeo = new THREE.IcosahedronGeometry(1, 2);
  const bPos = boulderGeo.attributes.position;
  if (bPos) {
    for (let i = 0; i < bPos.count; i += 1) {
      const vx = bPos.getX(i);
      const vy = bPos.getY(i);
      const vz = bPos.getZ(i);
      const crag1 = Math.sin(vx * 3.1 + vy * 2.7) * Math.cos(vz * 3.4) * 0.19;
      const crag2 = Math.cos(vx * 6.8 - vz * 5.2 + vy * 4.3) * 0.08;
      const n = 0.84 + crag1 + crag2;
      bPos.setXYZ(i, vx * n, vy * n * 0.74, vz * n);
    }
    boulderGeo.computeVertexNormals();
  }

  const boulderSpecs: ReadonlyArray<readonly [number, number, number, number]> = [
    [-5.8, 12.1, 1.35, 0.9],
    [-4.6, 8.8, 0.95, 1.7],
    [-7.9, 1.2, 1.45, 2.5],
    [8.2, 6.4, 1.1, 0.4],
    [9.4, -15.5, 1.65, 3.1],
    [-8.4, -14.2, 1.5, 1.2],
    [-5.6, -24.5, 1.15, 2.2],
    [7.5, -28.0, 1.3, 0.8],
  ];
  for (const [bx, bz, bs, rot] of boulderSpecs) {
    const rock = new THREE.Mesh(boulderGeo, mossRockMat);
    rock.position.set(bx, getTerrainHeight(bx, bz) + bs * 0.24, bz);
    rock.rotation.set(rot * 0.2, rot, 0.12);
    rock.scale.set(bs * 1.15, bs * 0.82, bs);
    rock.castShadow = true;
    rock.receiveShadow = true;
    root.add(rock);
    obstacles.push({ kind: 'circle', x: bx, z: bz, radius: bs * 0.9 });
  }

  const logSpecs: ReadonlyArray<readonly [number, number, number, number]> = [
    [-6.6, -7.8, 4.6, 0.65],
    [9.2, 14.4, 5.2, -0.82],
    [-11.2, -20.5, 5.8, 1.1],
  ];
  for (const [lx, lz, len, rot] of logSpecs) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, len, 10), barkMat);
    log.position.set(lx, getTerrainHeight(lx, lz) + 0.18, lz);
    log.rotation.set(Math.PI * 0.5, 0, rot);
    log.castShadow = true;
    log.receiveShadow = true;
    root.add(log);
  }

  // 10. Soft golden valley mist ribbons with camera-distance proximity & grazing-angle fade
  //     so players can never walk through or glimpse edge-on paper-thin mist slices.
  const mistTexture = createMistTexture();
  let baseMistOpacity = 0.42;
  const mistUniforms = {
    uMap: { value: mistTexture },
    uOpacity: { value: 0.42 },
    uTint: { value: new THREE.Color().setRGB(0.71, 0.62, 0.45) },
    uTintMix: { value: 0.0 },
  };
  const mistMat = new THREE.ShaderMaterial({
    uniforms: mistUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uOpacity;
      uniform vec3 uTint;
      uniform float uTintMix;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vec4 texel = texture2D(uMap, vUv);
        vec3 viewVec = cameraPosition - vWorldPos;
        float dist = length(viewVec);
        vec3 viewDir = viewVec / max(0.001, dist);

        // Fade to zero before camera gets within 14m, and fade smoothly when viewed near edge-on
        float distFade = smoothstep(14.0, 28.0, dist);
        float angleFade = smoothstep(0.18, 0.62, abs(dot(normalize(vWorldNormal), viewDir)));
        float alpha = texel.a * uOpacity * distFade * angleFade;
        if (alpha <= 0.002) {
          discard;
        }

        // mistTexture uses SRGBColorSpace so hardware sampling already outputs linear HDR values
        float lum = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
        vec3 tinted = mix(texel.rgb, uTint * (0.55 + lum * 0.95), uTintMix);
        gl_FragColor = vec4(tinted, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const mistGeo = new THREE.PlaneGeometry(34, 15);
  const mistPositions: ReadonlyArray<readonly [number, number, number]> = [
    [-4, 4.0, -48],
    [6, 4.6, -64],
    [-2, 5.4, -80],
    [8, 6.2, -96],
    [-12, 5.8, -104],
  ];
  for (let i = 0; i < mistPositions.length; i += 1) {
    const mp = mistPositions[i];
    if (!mp) {
      continue;
    }
    const [mx, my, mz] = mp;
    const card = new THREE.Mesh(mistGeo, mistMat);
    card.position.set(mx, getTerrainHeight(mx, mz) + my, mz);
    card.userData['excludeFromGtao'] = true;
    root.add(card);
    mistCards.push({
      mesh: card,
      baseX: mx,
      phase: i * 1.7,
      driftAmp: 3.4,
    });
  }

  function getWindIntensity(elapsed: number): number {
    return 0.52 + 0.34 * Math.sin(elapsed * 0.28) + 0.14 * Math.sin(elapsed * 0.71 + 1.1);
  }

  function sampleRuinMetalProximity(
    x: number,
    z: number,
    out: { proximity: number; sourceX: number; sourceZ: number },
  ): void {
    let bestProx = 0;
    let bestX = 11.2;
    let bestZ = -6.5;
    for (let i = 0; i < metalCreakAnchors.length; i += 1) {
      const anchor = metalCreakAnchors[i];
      if (!anchor) {
        continue;
      }
      const [ax, az, radius] = anchor;
      const d = Math.hypot(x - ax, z - az);
      if (d < radius) {
        const prox = 1 - d / radius;
        if (prox > bestProx) {
          bestProx = prox;
          bestX = ax;
          bestZ = az;
        }
      }
    }
    out.proximity = bestProx;
    out.sourceX = bestX;
    out.sourceZ = bestZ;
  }

  let isHighQuality = initialQuality === 'high';

  function setQuality(quality: GraphicsQuality): void {
    const high = quality === 'high';
    isHighQuality = high;
    fernInst.count = high ? fernPlaced : Math.floor(fernPlaced * 0.58);
    grassInst.count = high ? grassPlaced : Math.floor(grassPlaced * 0.52);
    baseMistOpacity = high ? 0.42 : 0.28;
    mistUniforms.uOpacity.value = baseMistOpacity;
    puddleUniforms.uReflectStrength.value = high ? 1.0 : 0.85;
    puddleUniforms.uFogDensity.value = high ? 0.0108 : 0.012;

    for (let i = 0; i < mirrorPuddles.length; i += 1) {
      const pair = mirrorPuddles[i];
      if (!pair) {
        continue;
      }
      pair.reflector.visible = high;
      pair.fallback.visible = !high;
      pair.fogDensityUniform.value = high ? 0.0108 : 0.012;
      pair.reflectStrengthUniform.value = high ? 1.0 : 0.85;
    }
  }

  setQuality(initialQuality);

  return {
    root,
    obstacles,
    isInsidePuddle: isInsidePuddleFootstep,
    getWindIntensity,
    sampleRuinMetalProximity,
    update(elapsed: number, _dt: number, atmosphere?: AtmosphereSnapshot): void {
      const windBoost = atmosphere ? atmosphere.windBoost : 1.0;
      const rainIntensity = atmosphere ? atmosphere.rainIntensity : 0;

      const windGust = getWindIntensity(elapsed);
      windUniforms.uWindTime.value = elapsed;
      windUniforms.uWindStrength.value = (0.72 + windGust * 0.65) * windBoost;

      if (atmosphere) {
        mistUniforms.uTint.value.copy(atmosphere.mistColor);
        mistUniforms.uTintMix.value = 1.0;
      }
      mistUniforms.uOpacity.value = baseMistOpacity * (1 + Math.max(0, rainIntensity) * 0.35);

      puddleUniforms.uTime.value = elapsed;
      if (atmosphere) {
        const syncedFogDensity = atmosphere.fogDensity * (isHighQuality ? 1.0 : 1.11);
        puddleUniforms.uFogColor.value.copy(atmosphere.fogColor);
        puddleUniforms.uFogDensity.value = syncedFogDensity;
        puddleUniforms.uSunDir.value.copy(atmosphere.lightDir);
        puddleUniforms.uNightFactor.value = atmosphere.nightFactor;
        puddleUniforms.uCloudCover.value = atmosphere.cloudCover;

        for (let i = 0; i < mirrorPuddles.length; i += 1) {
          const pair = mirrorPuddles[i];
          if (pair) {
            pair.timeUniform.value = elapsed;
            pair.fogColorUniform.value.copy(atmosphere.fogColor);
            pair.fogDensityUniform.value = syncedFogDensity;
            pair.sunDirUniform.value.copy(atmosphere.lightDir);
            pair.nightFactorUniform.value = atmosphere.nightFactor;
            pair.cloudCoverUniform.value = atmosphere.cloudCover;
          }
        }
      } else {
        for (let i = 0; i < mirrorPuddles.length; i += 1) {
          const pair = mirrorPuddles[i];
          if (pair) {
            pair.timeUniform.value = elapsed;
          }
        }
      }

      // Synchronize hanging ivy curtain sway with the traveling forest wind gusts & storm gales
      const ivyGustMul = (0.7 + windGust * 0.75) * windBoost;
      for (let i = 0; i < swayItems.length; i += 1) {
        const item = swayItems[i];
        if (!item) {
          continue;
        }
        const wave =
          Math.sin(elapsed * 1.25 + item.phase) +
          Math.sin(elapsed * 2.25 + item.phase * 0.7) * 0.35;
        item.mesh.rotation.x = item.baseRotX + wave * item.amp * ivyGustMul;
        item.mesh.rotation.z = item.baseRotZ + wave * item.amp * 0.45 * ivyGustMul;
      }

      for (let i = 0; i < mistCards.length; i += 1) {
        const card = mistCards[i];
        if (!card) {
          continue;
        }
        card.mesh.position.x = card.baseX + Math.sin(elapsed * 0.09 + card.phase) * card.driftAmp;
      }
    },
    setQuality,
    dispose(): void {
      disposed = true;
      disposeObject3D(root, sharedMaterials);
      for (const mat of sharedMaterials) {
        mat.dispose();
      }
      mistTexture.dispose();
      atlas.dispose();
    },
  };
}
