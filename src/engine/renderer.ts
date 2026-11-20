import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { AtmosphereSnapshot } from '../systems/atmosphere';

export type GraphicsQuality = 'high' | 'medium';

export interface EngineContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sunDirection: THREE.Vector3;
  getQuality(): GraphicsQuality;
  setQuality(quality: GraphicsQuality): void;
  resize(width: number, height: number): void;
  update(
    elapsed: number,
    focusX: number,
    focusY: number,
    focusZ: number,
    atmosphere?: AtmosphereSnapshot,
  ): void;
  render(): void;
  dispose(): void;
}

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDirection;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldDirection = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uHorizonColor;
  uniform vec3 uMidColor;
  uniform vec3 uZenithColor;
  uniform vec3 uMistColor;
  uniform float uCloudCover;
  uniform float uNightFactor;
  uniform float uLightningFlash;
  uniform float uTime;
  varying vec3 vWorldDirection;

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
    float value = 0.0;
    float amp = 0.52;
    for (int i = 0; i < 5; i++) {
      value += amp * noise2(p);
      p = p * 2.04 + vec2(17.1, 31.7);
      amp *= 0.48;
    }
    return value;
  }

  void main() {
    vec3 dir = normalize(vWorldDirection);
    float elev = clamp(dir.y, -0.35, 1.0);
    float upFactor = clamp(dir.y, 0.0, 1.0);
    float stormCover = clamp((uCloudCover - 0.25) / 0.75, 0.0, 1.0);

    vec3 groundHaze = mix(vec3(0.09, 0.12, 0.08), vec3(0.014, 0.02, 0.032), uNightFactor);
    vec3 sky = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.22, upFactor));
    sky = mix(sky, uZenithColor, smoothstep(0.16, 0.74, upFactor));
    sky = mix(groundHaze, sky, smoothstep(-0.12, 0.03, elev));

    // Directional solar Mie scatter + HDR sun disc (bit-exact at Golden Hour, smoothly dims at night/storm)
    vec3 sunN = normalize(uSunDir);
    float sunDot = max(dot(dir, sunN), 0.0);
    float dayVis = clamp(1.0 - uNightFactor * 1.35, 0.0, 1.0)
      * smoothstep(-0.04, 0.06, sunN.y)
      * (1.0 - stormCover * 0.68);
    float wideHalo = pow(sunDot, 4.5) * 0.32 * dayVis;
    float midGlow = pow(sunDot, 26.0) * 0.65 * dayVis;
    float sunDisc = smoothstep(0.9968, 0.9993, sunDot) * 2.8 * dayVis;

    sky += vec3(0.98, 0.72, 0.38) * wideHalo;
    sky += vec3(1.0, 0.84, 0.56) * midGlow;
    sky += vec3(1.0, 0.95, 0.80) * sunDisc;

    // Crisp procedural twinkling starfield + cool silver-blue moon disc & halo at night
    float moonVis = smoothstep(0.24, 0.82, uNightFactor) * (1.0 - stormCover * 0.72);
    if (moonVis > 0.01 && dir.y > 0.03) {
      if (dir.y > 0.04) {
        // Singularity-free upper-hemisphere projection prevents atan(0,0) NaN at zenith
        vec2 starUv = (dir.xz / (dir.y + 0.35)) * 125.0;
        vec2 cell = floor(starUv);
        vec2 f = fract(starUv) - 0.5;
        float h = hash21(cell);
        if (h > 0.968) {
          vec2 offset = vec2(hash21(cell + 19.7) - 0.5, hash21(cell + 43.1) - 0.5) * 0.58;
          float starDist = length(f - offset);
          float starPoint = smoothstep(0.15, 0.015, starDist);
          float twinkle = 0.65 + 0.35 * sin(uTime * (1.8 + h * 3.4) + h * 62.0);
          float horizonFade = smoothstep(0.04, 0.28, dir.y);
          vec3 starTint = mix(vec3(0.76, 0.86, 1.0), vec3(1.0, 0.94, 0.84), fract(h * 19.3));
          sky += starTint * starPoint * twinkle * horizonFade * moonVis * 1.15;
        }
      }

      vec3 moonN = normalize(uMoonDir);
      float moonAbove = smoothstep(-0.02, 0.08, moonN.y);
      float moonDot = max(dot(dir, moonN), 0.0);
      float moonHalo = (pow(moonDot, 10.0) * 0.12 + pow(moonDot, 64.0) * 0.24) * moonVis * moonAbove;
      float moonDisc = smoothstep(0.9985, 0.9994, moonDot) * 1.35 * moonVis * moonAbove;
      sky += vec3(0.62, 0.76, 0.96) * moonHalo;
      sky += vec3(0.84, 0.90, 1.0) * moonDisc;
    }

    // Stratified Pacific Northwest cloud banks transitioning smoothly from golden hour to stormy night
    if (dir.y > 0.015) {
      vec2 cloudUv = dir.xz / (dir.y + 0.24);
      cloudUv.x *= 0.82;
      cloudUv.y *= 1.65;
      float cloudDrift = 1.0 + stormCover * 1.35;
      cloudUv += vec2(uTime * 0.004 * cloudDrift, -uTime * 0.0018 * cloudDrift);

      float c1 = fbm(cloudUv * 1.35);
      float c2 = fbm(cloudUv * 2.9 - vec2(4.2, 1.9));
      float detail = c1 * 0.72 + c2 * 0.28;
      float edgeLo = mix(0.42, 0.18, stormCover);
      float edgeHi = mix(0.74, 0.56, stormCover);
      float cloudMask = smoothstep(edgeLo, edgeHi, detail);
      cloudMask *= smoothstep(0.02, 0.14, dir.y) * (1.0 - smoothstep(0.58, 0.96, dir.y) * 0.42);

      vec3 dayBelly = mix(vec3(0.40, 0.38, 0.35), vec3(0.16, 0.19, 0.23), stormCover);
      vec3 nightBelly = mix(vec3(0.032, 0.045, 0.074), vec3(0.018, 0.024, 0.038), stormCover);
      vec3 cloudBelly = mix(dayBelly, nightBelly, uNightFactor);

      vec3 dayRim = mix(vec3(0.95, 0.75, 0.46), vec3(1.0, 0.91, 0.70), pow(sunDot, 2.5));
      dayRim = mix(dayRim, vec3(0.36, 0.41, 0.47), stormCover * 0.75);
      vec3 nightRim = vec3(0.14, 0.20, 0.32) * (0.6 + 0.4 * max(dot(dir, normalize(uMoonDir)), 0.0));
      vec3 cloudRim = mix(dayRim, nightRim, uNightFactor);

      float rimMix = smoothstep(
        0.36,
        0.78,
        (1.0 - c1) * 0.55 + c2 * 0.45 + pow(sunDot, 2.0) * 0.42 * dayVis
      );
      vec3 cloudColor = mix(cloudBelly, cloudRim, rimMix);

      // Electric blue-white sheet lightning illuminating storm cloud undersides
      if (uLightningFlash > 0.004) {
        float flashPocket = smoothstep(0.35, 0.78, c2);
        cloudColor += vec3(0.62, 0.76, 1.0) * uLightningFlash * (0.28 + flashPocket * 0.65);
      }

      sky = mix(sky, cloudColor, cloudMask * mix(0.8, 0.94, stormCover));
    }

    // Valley horizon mist belt matching dynamic FogExp2
    float mistBand = exp(-abs(dir.y) * 11.0);
    vec3 mistSun = mix(uMistColor, vec3(0.94, 0.80, 0.54), pow(sunDot, 2.2) * dayVis);
    sky = mix(sky, mistSun, mistBand * (0.46 + stormCover * 0.16));

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const DUST_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uAnchor;
  uniform float uPixelRatio;
  attribute float aSeed;
  attribute float aSize;
  varying float vAlpha;

  void main() {
    vec3 boxSize = vec3(48.0, 11.0, 48.0);
    vec3 drift = vec3(
      sin(uTime * 0.22 + aSeed * 6.2831) * 1.15 + uTime * 0.22,
      sin(uTime * 0.34 + aSeed * 19.4) * 0.55 + uTime * 0.05,
      cos(uTime * 0.19 + aSeed * 11.3) * 1.15
    );

    vec3 rel = mod((position + drift) - (uAnchor - boxSize * 0.5), boxSize) - boxSize * 0.5;
    vec3 worldPos = uAnchor + rel;

    vec4 mvPos = modelViewMatrix * vec4(worldPos, 1.0);
    float dist = max(1.0, -mvPos.z);

    float fadeNear = smoothstep(1.2, 4.5, dist);
    float fadeFar = 1.0 - smoothstep(18.0, 34.0, dist);
    float twinkle = 0.62 + 0.38 * sin(uTime * 1.4 + aSeed * 42.0);
    vAlpha = fadeNear * fadeFar * twinkle * 0.52;

    gl_PointSize = clamp((aSize * uPixelRatio * 22.0) / dist, 1.2, 8.5);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const DUST_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uTint;
  uniform float uOpacityScale;
  varying float vAlpha;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float r = length(centered);
    if (r > 0.5) {
      discard;
    }
    float glow = pow(1.0 - r * 2.0, 2.2);
    float alpha = glow * vAlpha * uOpacityScale;
    if (alpha <= 0.002) {
      discard;
    }
    gl_FragColor = vec4(uTint, alpha);
  }
`;

/**
 * True screen-space crepuscular sun shafts (volumetric god-rays) marching radially toward the
 * projected 3D sun position in HDR linear space before OutputPass. Real 3D Douglas-fir branches,
 * trunks, and concrete ruins dynamically occlude sky luminance and cast living shafts as wind moves.
 */
const VOLUMETRIC_SUN_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunScreenPos: { value: new THREE.Vector2(0.65, 0.72) },
    uSunVisibility: { value: 0.0 },
    uExposure: { value: 0.24 },
    uSampleCount: { value: 24 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreenPos;
    uniform float uSunVisibility;
    uniform float uExposure;
    uniform int uSampleCount;
    varying vec2 vUv;

    // Interleaved Gradient Noise eliminates radial banding smoothly without shimmer
    float interleavedGradientNoise(vec2 pixelPos) {
      vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
      return fract(magic.z * fract(dot(pixelPos, magic.xy)));
    }

    void main() {
      vec4 baseTexel = texture2D(tDiffuse, vUv);
      if (uSunVisibility <= 0.002) {
        gl_FragColor = baseTexel;
        return;
      }

      vec2 toSun = uSunScreenPos - vUv;
      float distToSun = length(toSun);
      float clampedDist = min(distToSun, 0.72);
      vec2 rayDir = distToSun > 0.0001 ? (toSun / distToSun) : vec2(0.0);

      float countF = max(1.0, float(uSampleCount));
      vec2 deltaUv = (rayDir * clampedDist) / countF;
      float jitter = interleavedGradientNoise(gl_FragCoord.xy);
      vec2 sampleUv = vUv + deltaUv * jitter;

      float decay = 0.935;
      float illuminationDecay = 1.0;
      float accum = 0.0;

      for (int i = 0; i < 24; i++) {
        if (i >= uSampleCount) {
          break;
        }
        vec2 uvClamped = clamp(sampleUv, vec2(0.002), vec2(0.998));
        vec3 s = texture2D(tDiffuse, uvClamped).rgb;
        float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
        // Isolate bright golden sky openings against occluded dark pine canopy & concrete ruins
        float skyMask = smoothstep(0.76, 1.25, lum);
        // Subtle warmth bias so golden horizon scatter drives the crepuscular beams
        float warmth = clamp((s.r + s.g * 0.5) / max(0.05, s.b * 1.4), 0.5, 1.35);
        accum += skyMask * warmth * illuminationDecay;
        illuminationDecay *= decay;
        sampleUv += deltaUv;
      }

      accum /= countF;
      // Soft radial falloff away from sun screen position so beams melt organically into forest haze
      float radialFalloff = 1.0 - smoothstep(0.06, 1.02, distToSun);
      vec3 shaftColor = vec3(1.0, 0.78, 0.42) * accum * uExposure * uSunVisibility * radialFalloff;
      shaftColor = min(shaftColor, vec3(0.42));

      gl_FragColor = vec4(baseTexel.rgb + shaftColor, baseTexel.a);
    }
  `,
};

const FILMIC_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGrainAmount: { value: 0.017 },
    uVignetteAmount: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGrainAmount;
    uniform float uVignetteAmount;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 col = texel.rgb;

      // Subtle S-curve cinematic contrast deepening mossy shadows while preserving warm highlights
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 sCurve = col * col * (3.0 - 2.0 * col);
      col = mix(col, sCurve, 0.18);

      // Pacific Northwest split-tone grade: cool dark forest shadows, warm golden-amber dusk highlights
      vec3 shadowTint = vec3(0.95, 1.01, 0.97);
      vec3 highlightTint = vec3(1.04, 0.99, 0.91);
      col *= mix(shadowTint, highlightTint, smoothstep(0.18, 0.78, luma));

      // Subtle cinematic saturation refinement
      vec3 gray = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722)));
      col = mix(gray, col, 1.06);

      // Single clean organic lens edge vignette
      vec2 centered = vUv - vec2(0.5);
      float dist = length(centered * vec2(1.18, 1.0));
      float vig = 1.0 - smoothstep(0.45, 0.94, dist) * uVignetteAmount;
      col *= vig;

      // Fine animated film grain breaking up sky/fog banding
      float grain = (rand(vUv * 512.0 + vec2(fract(uTime * 1.7), fract(uTime * 2.3))) - 0.5) * uGrainAmount;
      col = clamp(col + vec3(grain), 0.0, 1.0);

      gl_FragColor = vec4(col, texel.a);
    }
  `,
};

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function shouldExcludeFromGtao(obj: THREE.Object3D): boolean {
  if (obj.userData['excludeFromGtao'] === true) {
    return true;
  }
  if (
    obj instanceof THREE.Mesh ||
    obj instanceof THREE.Points ||
    obj instanceof THREE.Line ||
    obj instanceof THREE.Sprite
  ) {
    const mat = obj.material;
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i += 1) {
        const m = mat[i];
        if (m && (m.transparent || !m.depthWrite)) {
          return true;
        }
      }
    } else if (mat instanceof THREE.Material) {
      return mat.transparent || !mat.depthWrite;
    }
  }
  return false;
}

export function createEngine(
  canvas: HTMLCanvasElement,
  initialQuality: GraphicsQuality = 'high',
): EngineContext {
  const initW = Math.max(1, window.innerWidth);
  const initH = Math.max(1, window.innerHeight);
  const initDpr = Math.min(window.devicePixelRatio || 1, initialQuality === 'high' ? 2 : 1.25);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Size renderer and HiDPI pixel ratio BEFORE creating EffectComposer so targets allocate at exact resolution
  renderer.setPixelRatio(initDpr);
  renderer.setSize(initW, initH, false);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2('#b9a279', 0.0108);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(54, initW / initH, 0.15, 460);

  // Low golden-hour sun ahead-right over the pine ridge and crumbling gas station
  const sunDirection = new THREE.Vector3(0.46, 0.25, -0.85).normalize();

  // Pre-allocated scratch vectors for screen-space volumetric sun projection (ZERO per-frame allocations!)
  const scratchSunWorld = new THREE.Vector3();
  const scratchSunNdc = new THREE.Vector3();
  const scratchCamForward = new THREE.Vector3();

  // Dynamic Pacific Northwest sky dome (defaults match exact Milestone 1/2 Golden Hour vista)
  const skyUniforms = {
    uSunDir: { value: sunDirection.clone() },
    uMoonDir: { value: new THREE.Vector3(-0.36, 0.42, -0.83).normalize() },
    uHorizonColor: { value: new THREE.Color().setRGB(0.92, 0.74, 0.45) },
    uMidColor: { value: new THREE.Color().setRGB(0.67, 0.56, 0.43) },
    uZenithColor: { value: new THREE.Color().setRGB(0.24, 0.32, 0.35) },
    uMistColor: { value: new THREE.Color().setRGB(0.71, 0.62, 0.45) },
    uCloudCover: { value: 0.25 },
    uNightFactor: { value: 0.0 },
    uLightningFlash: { value: 0.0 },
    uTime: { value: 0 },
  };
  const skyGeometry = new THREE.SphereGeometry(360, 40, 24);
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1;
  skyDome.userData['excludeFromGtao'] = true;
  scene.add(skyDome);

  // Physically accurate PMREM environment map from the golden-hour sky dome
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const envSkyMesh = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), skyMaterial);
  envScene.add(envSkyMesh);
  const envRenderTarget = pmremGenerator.fromScene(envScene, 0.03);
  scene.environment = envRenderTarget.texture;
  envSkyMesh.geometry.dispose();
  pmremGenerator.dispose();

  // Primary golden-hour directional sunlight with tuned shadow biases for crisp contact shadows
  const sunLight = new THREE.DirectionalLight('#ffd08a', 3.7);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 4;
  sunLight.shadow.camera.far = 155;
  const shadowExtent = 38;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.bias = -0.00055;
  sunLight.shadow.normalBias = 0.055;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Atmospheric hemisphere fill: warm amber dusk above, deep moody pine shadow beneath
  const hemiLight = new THREE.HemisphereLight('#d6bc8e', '#202e1d', 0.82);
  scene.add(hemiLight);

  // Subtle rim/bounce fill light preserving PBR detail in shadowed rock & foliage
  const bounceLight = new THREE.DirectionalLight('#7e9289', 0.42);
  bounceLight.position.set(-28, 16, 24);
  scene.add(bounceLight);

  // Drifting golden dust motes / forest pollen (GPU wrapped, zero CPU allocations per frame)
  const totalDustCount = 560;
  const mediumDustCount = 240;
  const dustPositions = new Float32Array(totalDustCount * 3);
  const dustSeeds = new Float32Array(totalDustCount);
  const dustSizes = new Float32Array(totalDustCount);
  const rng = createSeededRng(314159);

  for (let i = 0; i < totalDustCount; i += 1) {
    dustPositions[i * 3] = (rng() - 0.5) * 48;
    dustPositions[i * 3 + 1] = rng() * 11;
    dustPositions[i * 3 + 2] = (rng() - 0.5) * 48;
    dustSeeds[i] = rng();
    dustSizes[i] = 1.1 + rng() * 2.1;
  }

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(dustSeeds, 1));
  dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1));

  const dustAnchor = new THREE.Vector3();
  const dustDayTint = new THREE.Color().setRGB(1.0, 0.86, 0.54);
  const dustNightTint = new THREE.Color().setRGB(0.62, 0.74, 0.92);
  const dustTint = dustDayTint.clone();
  const dustUniforms = {
    uTime: { value: 0 },
    uAnchor: { value: dustAnchor },
    uPixelRatio: { value: initDpr },
    uTint: { value: dustTint },
    uOpacityScale: { value: 1.0 },
  };
  const dustMaterial = new THREE.ShaderMaterial({
    vertexShader: DUST_VERTEX_SHADER,
    fragmentShader: DUST_FRAGMENT_SHADER,
    uniforms: dustUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const dustPoints = new THREE.Points(dustGeometry, dustMaterial);
  dustPoints.frustumCulled = false;
  dustPoints.userData['excludeFromGtao'] = true;
  scene.add(dustPoints);

  // AAA Post-Processing Stack: RenderPass -> GTAOPass (High) -> UnrealBloomPass -> VolumetricSunPass -> OutputPass -> FilmicGrade
  let composer: EffectComposer | null = null;
  let gtaoPass: GTAOPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let volumetricSunPass: ShaderPass | null = null;
  let outputPass: OutputPass | null = null;
  let gradePass: ShaderPass | null = null;
  let useComposer = false;
  let gtaoVisibilityOverridden = false;

  // Pre-allocated scratch list & hoisted traverse visitor (zero per-frame allocations)
  const gtaoHiddenObjects: THREE.Object3D[] = [];
  const hideGtaoExcludedObject = (obj: THREE.Object3D): void => {
    if (obj.visible && shouldExcludeFromGtao(obj)) {
      obj.visible = false;
      gtaoHiddenObjects.push(obj);
    }
  };

  function disposePostProcessing(): void {
    if (gtaoPass) {
      gtaoPass.gtaoMaterial.dispose();
      gtaoPass.blendMaterial.dispose();
      gtaoPass.pdMaterial.dispose();
      gtaoPass.depthRenderMaterial.dispose();
      gtaoPass.copyMaterial.dispose();
      gtaoPass.normalMaterial.dispose();
      gtaoPass.dispose();
      gtaoPass = null;
    }
    if (bloomPass) {
      bloomPass.materialHighPassFilter.dispose();
      bloomPass.dispose();
      bloomPass = null;
    }
    if (volumetricSunPass) {
      volumetricSunPass.dispose();
      volumetricSunPass = null;
    }
    if (outputPass) {
      outputPass.dispose();
      outputPass = null;
    }
    if (gradePass) {
      gradePass.dispose();
      gradePass = null;
    }
    if (composer) {
      composer.dispose();
      composer = null;
    }
    gtaoHiddenObjects.length = 0;
    gtaoVisibilityOverridden = false;
  }

  try {
    composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const gtao = new GTAOPass(scene, camera, initW * initDpr, initH * initDpr);
    gtaoPass = gtao;
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.72;
    gtao.updateGtaoMaterial({
      radius: 0.55,
      distanceExponent: 1.5,
      thickness: 1.0,
      distanceFallOff: 1.0,
      scale: 1.15,
      samples: 12,
    });
    gtao.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 4,
      radiusExponent: 1.5,
      rings: 2,
      samples: 12,
    });

    // Exclude transparent, depthWrite=false, and tagged atmospheric/puddle objects from GTAO G-Buffer
    const origOverrideVisibility = gtao.overrideVisibility.bind(gtao);
    const origRestoreVisibility = gtao.restoreVisibility.bind(gtao);
    gtao.overrideVisibility = (): void => {
      origOverrideVisibility();
      gtaoVisibilityOverridden = true;
      gtaoHiddenObjects.length = 0;
      scene.traverse(hideGtaoExcludedObject);
    };
    gtao.restoreVisibility = (): void => {
      if (!gtaoVisibilityOverridden) {
        return;
      }
      for (let i = 0; i < gtaoHiddenObjects.length; i += 1) {
        const obj = gtaoHiddenObjects[i];
        if (obj) {
          obj.visible = true;
        }
      }
      gtaoHiddenObjects.length = 0;
      gtaoVisibilityOverridden = false;
      origRestoreVisibility();
    };

    composer.addPass(gtaoPass);

    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(initW * initDpr, initH * initDpr),
      0.26,
      0.65,
      0.85,
    );
    composer.addPass(bloomPass);

    // True screen-space volumetric crepuscular sun shafts running in HDR linear space before OutputPass
    volumetricSunPass = new ShaderPass(VOLUMETRIC_SUN_SHADER);
    composer.addPass(volumetricSunPass);

    outputPass = new OutputPass();
    composer.addPass(outputPass);

    gradePass = new ShaderPass(FILMIC_GRADE_SHADER);
    composer.addPass(gradePass);

    useComposer = true;
  } catch {
    disposePostProcessing();
    useComposer = false;
  }

  let currentQuality: GraphicsQuality = initialQuality;
  let volumetricStrength = 1.0;
  let activeLightDirX = sunDirection.x;
  let activeLightDirY = sunDirection.y;
  let activeLightDirZ = sunDirection.z;

  function applyQuality(quality: GraphicsQuality): void {
    currentQuality = quality;
    const isHigh = quality === 'high';
    const maxDpr = isHigh ? 2 : 1.25;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxDpr);
    renderer.setPixelRatio(pixelRatio);
    dustUniforms.uPixelRatio.value = pixelRatio;

    if (useComposer && composer) {
      composer.setPixelRatio(pixelRatio);
      if (gtaoPass) {
        gtaoPass.enabled = isHigh;
      }
      if (bloomPass) {
        bloomPass.strength = isHigh ? 0.26 : 0.16;
        bloomPass.radius = isHigh ? 0.65 : 0.52;
        bloomPass.threshold = isHigh ? 0.85 : 0.9;
      }
      if (volumetricSunPass) {
        const samplesUniform = volumetricSunPass.uniforms['uSampleCount'];
        if (samplesUniform) {
          samplesUniform.value = isHigh ? 24 : 12;
        }
        const exposureUniform = volumetricSunPass.uniforms['uExposure'];
        if (exposureUniform) {
          exposureUniform.value = isHigh ? 0.24 : 0.18;
        }
      }
      if (gradePass) {
        const grainUniform = gradePass.uniforms['uGrainAmount'];
        if (grainUniform) {
          grainUniform.value = isHigh ? 0.017 : 0.01;
        }
      }
    }

    const shadowSize = isHigh ? 2048 : 1024;
    if (sunLight.shadow.mapSize.x !== shadowSize) {
      sunLight.shadow.mapSize.set(shadowSize, shadowSize);
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
      sunLight.shadow.needsUpdate = true;
    }

    fog.density = isHigh ? 0.0108 : 0.012;
    dustGeometry.setDrawRange(0, isHigh ? totalDustCount : mediumDustCount);
  }

  function resize(width: number, height: number): void {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    camera.aspect = safeW / safeH;
    camera.updateProjectionMatrix();
    renderer.setSize(safeW, safeH, false);

    // EffectComposer.setSize automatically scales all passes by current pixelRatio
    if (useComposer && composer) {
      composer.setSize(safeW, safeH);
    }
  }

  function updateVolumetricSunUniforms(): void {
    if (!useComposer || !volumetricSunPass) {
      return;
    }
    camera.updateMatrixWorld();
    camera.getWorldDirection(scratchCamForward);
    const facingSun = scratchCamForward.dot(sunDirection);
    const facingFade = smoothstepScalar(0.05, 0.55, facingSun);

    let visibility = 0;
    if (facingFade > 0.001) {
      scratchSunWorld.copy(camera.position).addScaledVector(sunDirection, 140);
      scratchSunNdc.copy(scratchSunWorld).project(camera);
      const sunU = scratchSunNdc.x * 0.5 + 0.5;
      const sunV = scratchSunNdc.y * 0.5 + 0.5;

      const screenPosUniform = volumetricSunPass.uniforms['uSunScreenPos'];
      if (screenPosUniform && screenPosUniform.value instanceof THREE.Vector2) {
        screenPosUniform.value.set(sunU, sunV);
      }

      const offX = Math.max(0, Math.abs(sunU - 0.5) - 0.55);
      const offY = Math.max(0, Math.abs(sunV - 0.5) - 0.55);
      const screenFade = 1 - Math.min(1, Math.hypot(offX, offY) / 0.65);
      visibility = facingFade * screenFade * volumetricStrength;
    }

    const visUniform = volumetricSunPass.uniforms['uSunVisibility'];
    if (visUniform) {
      visUniform.value = visibility;
    }
  }

  applyQuality(initialQuality);
  resize(initW, initH);

  return {
    renderer,
    scene,
    camera,
    sunDirection,
    getQuality(): GraphicsQuality {
      return currentQuality;
    },
    setQuality(quality: GraphicsQuality): void {
      applyQuality(quality);
    },
    resize,
    update(
      elapsed: number,
      focusX: number,
      focusY: number,
      focusZ: number,
      atmosphere?: AtmosphereSnapshot,
    ): void {
      skyUniforms.uTime.value = elapsed;
      dustUniforms.uTime.value = elapsed;
      if (useComposer && gradePass) {
        const timeUniform = gradePass.uniforms['uTime'];
        if (timeUniform) {
          timeUniform.value = elapsed;
        }
      }

      if (atmosphere) {
        sunDirection.copy(atmosphere.sunDir);
        skyUniforms.uSunDir.value.copy(atmosphere.sunDir);
        skyUniforms.uMoonDir.value.copy(atmosphere.moonDir);
        skyUniforms.uHorizonColor.value.copy(atmosphere.skyHorizonColor);
        skyUniforms.uMidColor.value.copy(atmosphere.skyMidColor);
        skyUniforms.uZenithColor.value.copy(atmosphere.skyZenithColor);
        skyUniforms.uMistColor.value.copy(atmosphere.mistColor);
        skyUniforms.uCloudCover.value = atmosphere.cloudCover;
        skyUniforms.uNightFactor.value = atmosphere.nightFactor;
        skyUniforms.uLightningFlash.value = atmosphere.lightningFlash;

        sunLight.color.copy(atmosphere.sunColor);
        sunLight.intensity = atmosphere.sunIntensity;
        hemiLight.color.copy(atmosphere.hemiSkyColor);
        hemiLight.groundColor.copy(atmosphere.hemiGroundColor);
        hemiLight.intensity = atmosphere.hemiIntensity;
        bounceLight.intensity = atmosphere.bounceIntensity;

        fog.color.copy(atmosphere.fogColor);
        fog.density = atmosphere.fogDensity * (currentQuality === 'high' ? 1.0 : 1.11);
        renderer.toneMappingExposure = atmosphere.exposure;
        volumetricStrength = atmosphere.volumetricStrength;

        // Attenuate golden-hour PMREM IBL cleanly during night & heavy storm cloud cover
        const stormExcess = Math.max(0, Math.min(1, (atmosphere.cloudCover - 0.25) / 0.75));
        scene.environmentIntensity = Math.max(
          0.14,
          1.0 - atmosphere.nightFactor * 0.82 - stormExcess * 0.14,
        );

        dustTint.copy(dustDayTint).lerp(dustNightTint, atmosphere.nightFactor);
        dustUniforms.uOpacityScale.value =
          (1 - atmosphere.nightFactor * 0.45) * (1 - atmosphere.rainIntensity * 0.88);
        dustPoints.visible = dustUniforms.uOpacityScale.value > 0.03;

        activeLightDirX = atmosphere.lightDir.x;
        activeLightDirY = atmosphere.lightDir.y;
        activeLightDirZ = atmosphere.lightDir.z;
      } else {
        activeLightDirX = sunDirection.x;
        activeLightDirY = sunDirection.y;
        activeLightDirZ = sunDirection.z;
      }

      skyDome.position.copy(camera.position);
      dustAnchor.set(focusX, focusY + 3.4, focusZ);

      const snapX = Math.round(focusX * 2) * 0.5;
      const snapY = Math.round(focusY * 2) * 0.5;
      const snapZ = Math.round(focusZ * 2) * 0.5;

      sunLight.target.position.set(snapX, snapY, snapZ);
      sunLight.position.set(
        snapX + activeLightDirX * 74,
        snapY + activeLightDirY * 74,
        snapZ + activeLightDirZ * 74,
      );
      sunLight.target.updateMatrixWorld();
    },
    render(): void {
      if (useComposer && composer) {
        try {
          updateVolumetricSunUniforms();
          composer.render();
          return;
        } catch {
          // Restore full renderer & scene state cleanly before falling back to direct render
          scene.overrideMaterial = null;
          if (gtaoPass) {
            gtaoPass.restoreVisibility();
          }
          renderer.autoClear = true;
          renderer.setRenderTarget(null);
          disposePostProcessing();
          useComposer = false;
        }
      }
      renderer.render(scene, camera);
    },
    dispose(): void {
      disposePostProcessing();
      skyGeometry.dispose();
      skyMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      envRenderTarget.dispose();
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
      renderer.dispose();
    },
  };
}
