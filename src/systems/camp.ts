import * as THREE from 'three';
import {
  getTerrainHeight,
  resolveHorizontalCollision,
  type Obstacle,
  type Vec2Like,
} from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';

export const CAMPFIRE_SCRAP_COST = 2;
export const SHELTER_SCRAP_COST = 4;
export const MAX_CAMPFIRES = 3;
export const MAX_SHELTERS = 2;
export const CAMPFIRE_WARMTH_RADIUS = 6.2;
export const CAMPFIRE_REPEL_RADIUS = 7.8;
export const CAMPFIRE_COOK_RADIUS = 2.8;
export const SHELTER_PROTECT_RADIUS = 3.2;

export interface CampBuildResult {
  readonly ok: boolean;
  readonly reason?: 'limit' | 'puddle' | 'blocked' | 'overlap';
  readonly x: number;
  readonly z: number;
}

export interface CampProximityInfo {
  nearFire: boolean;
  inCampShelter: boolean;
  fireProximity: number;
  fireX: number;
  fireZ: number;
  canCookAtFire: boolean;
}

export interface CampSystemOptions {
  readonly obstacles: Obstacle[];
  readonly isInsidePuddle: (x: number, z: number) => boolean;
}

export interface SavedCampfire {
  readonly x: number;
  readonly z: number;
}

export interface SavedShelter {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface SavedCampState {
  readonly campfires: SavedCampfire[];
  readonly shelters: SavedShelter[];
}

export interface CampSystem {
  readonly root: THREE.Group;
  tryBuildCampfire(playerX: number, playerZ: number, fwdX: number, fwdZ: number): CampBuildResult;
  tryBuildShelter(playerX: number, playerZ: number, fwdX: number, fwdZ: number): CampBuildResult;
  sampleProximity(x: number, z: number, out: CampProximityInfo): void;
  getNearestCampfire(x: number, z: number, maxDist: number, out?: Vec2Like): boolean;
  getCampfireRepelPoint(x: number, z: number, out: Vec2Like): boolean;
  getCampRespawnPoint(out: Vec2Like): boolean;
  getCounts(): { readonly campfires: number; readonly shelters: number };
  serialize(): SavedCampState;
  hydrate(state: SavedCampState): void;
  update(dt: number, elapsed: number): void;
  reset(): void;
  dispose(): void;
}

interface PlacedCampfire {
  readonly group: THREE.Group;
  readonly light: THREE.PointLight;
  readonly flameMat: THREE.ShaderMaterial;
  readonly sparkMat: THREE.ShaderMaterial;
  readonly x: number;
  readonly z: number;
  readonly phase: number;
  readonly addedObstacles: readonly Obstacle[];
}

interface PlacedShelter {
  readonly group: THREE.Group;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly respawnX: number;
  readonly respawnZ: number;
  readonly addedObstacles: readonly Obstacle[];
}

const FLAME_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 pos = position;
    // Sway upper flame tongues organically in forest draft while keeping ember base anchored
    float sway = sin(uTime * 7.8 + uPhase + pos.y * 6.5) * 0.055 + cos(uTime * 12.4 + uPhase * 1.7) * 0.025;
    float swayZ = cos(uTime * 6.9 + uPhase * 2.1 + pos.y * 5.2) * 0.045;
    float hMask = smoothstep(0.0, 0.9, vUv.y);
    pos.x += sway * hMask;
    pos.z += swayZ * hMask;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FLAME_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.5);
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

  void main() {
    vec2 uv = vUv;
    float cx = (uv.x - 0.5) * 2.0;
    float n1 = noise2(vec2(uv.x * 3.6 + uPhase, uv.y * 3.8 - uTime * 4.4));
    float n2 = noise2(vec2(uv.x * 7.2 - uPhase, uv.y * 6.5 - uTime * 7.2));
    float turb = n1 * 0.65 + n2 * 0.35;

    // Tapered teardrop flame silhouette eroded by upward-scrolling turbulence
    float width = mix(0.86, 0.08, pow(clamp(uv.y, 0.0, 1.0), 0.78));
    float dist = abs(cx + (turb - 0.5) * 0.32 * uv.y);
    float shape = 1.0 - smoothstep(width * 0.32, width, dist);
    float vFade = smoothstep(0.0, 0.14, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y + (turb - 0.5) * 0.25));
    float alpha = shape * vFade;
    if (alpha <= 0.02) {
      discard;
    }

    // Incandescent core -> golden amber -> deep fiery orange rim
    vec3 core = vec3(1.4, 1.15, 0.55);
    vec3 mid = vec3(1.15, 0.56, 0.12);
    vec3 outer = vec3(0.75, 0.18, 0.03);
    vec3 col = mix(outer, mid, smoothstep(0.15, 0.58, alpha));
    col = mix(col, core, smoothstep(0.52, 0.92, alpha * (1.0 - uv.y * 0.55)));

    gl_FragColor = vec4(col, alpha * 0.88);
  }
`;

const SPARK_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  attribute float aSeed;
  varying float vAlpha;

  void main() {
    float cycle = fract(uTime * (0.28 + aSeed * 0.24) + aSeed + uPhase * 0.17);
    float angle = aSeed * 6.2831 + uTime * (1.4 + aSeed * 1.6);
    float radius = (0.08 + aSeed * 0.22) * (0.5 + cycle * 1.1);

    vec3 pos = vec3(
      cos(angle) * radius,
      0.14 + cycle * 1.58,
      sin(angle) * radius
    );

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(0.8, -mvPos.z);
    vAlpha = smoothstep(0.0, 0.12, cycle) * (1.0 - smoothstep(0.58, 1.0, cycle));

    gl_PointSize = clamp((24.0 * (0.7 + aSeed * 0.6)) / dist, 1.5, 6.5);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SPARK_FRAGMENT_SHADER = /* glsl */ `
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.01) {
      discard;
    }
    vec2 centered = gl_PointCoord - vec2(0.5);
    float r = length(centered);
    if (r > 0.5) {
      discard;
    }
    float glow = pow(max(0.0, 1.0 - r * 2.0), 1.8);
    vec3 ember = mix(vec3(1.0, 0.38, 0.06), vec3(1.3, 0.92, 0.42), glow);
    gl_FragColor = vec4(ember, glow * vAlpha);
  }
`;

function createCrossedFlameGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vOffset = 0;

  const cards = 3;
  const hw = 0.28;
  const h = 0.72;
  for (let c = 0; c < cards; c += 1) {
    const yaw = (c / cards) * Math.PI;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    const pts: ReadonlyArray<readonly [number, number, number, number]> = [
      [-hw, 0.05, 0, 0],
      [hw, 0.05, 1, 0],
      [-hw * 0.92, 0.05 + h * 0.5, 0, 0.5],
      [hw * 0.92, 0.05 + h * 0.5, 1, 0.5],
      [-hw * 0.72, 0.05 + h, 0, 1],
      [hw * 0.72, 0.05 + h, 1, 1],
    ];
    for (const [lx, ly, u, v] of pts) {
      positions.push(lx * cosY, ly, -lx * sinY);
      uvs.push(u, v);
    }
    indices.push(vOffset, vOffset + 1, vOffset + 2);
    indices.push(vOffset + 1, vOffset + 3, vOffset + 2);
    indices.push(vOffset + 2, vOffset + 3, vOffset + 4);
    indices.push(vOffset + 3, vOffset + 5, vOffset + 4);
    vOffset += 6;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createSparkGeometry(count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    seeds[i] = (i + 0.5) / count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  return geo;
}

export function createCampSystem(options: CampSystemOptions): CampSystem {
  const { obstacles, isInsidePuddle } = options;
  const root = new THREE.Group();
  root.name = 'SurvivorCampStructures';

  const atlas = typeof document !== 'undefined' ? getWorldTextureAtlas() : null;

  const sharedGeos: THREE.BufferGeometry[] = [];
  const sharedMats: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    sharedGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    sharedMats.push(m);
    return m;
  };

  // Shared PBR camp materials borrowing read-only WorldTextureAtlas textures when in browser
  const stoneMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x7b7f76,
      map: atlas?.mossyRock.map ?? null,
      normalMap: atlas?.mossyRock.normalMap ?? null,
      roughnessMap: atlas?.mossyRock.roughnessMap ?? null,
      roughness: 0.94,
      metalness: 0.04,
    }),
  );
  const woodMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x7d654d,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
      roughnessMap: atlas?.pineBark.roughnessMap ?? null,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  const ashMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1b1918,
      roughness: 0.98,
      metalness: 0.02,
    }),
  );
  const emberMoundMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x26120c,
      emissive: new THREE.Color('#ff4808'),
      emissiveIntensity: 2.2,
      roughness: 0.9,
      metalness: 0.05,
    }),
  );
  const tarpMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x5c6449,
      map: atlas?.fabricOlive.map ?? null,
      normalMap: atlas?.fabricOlive.normalMap ?? null,
      roughnessMap: atlas?.fabricOlive.roughnessMap ?? null,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  const bedrollMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x87684b,
      map: atlas?.fabricOlive.map ?? null,
      normalMap: atlas?.fabricOlive.normalMap ?? null,
      roughness: 0.92,
      metalness: 0.02,
    }),
  );
  const blanketMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6b3a30,
      roughness: 0.94,
      metalness: 0.01,
    }),
  );

  // Shared geometries across all placed campfires & shelters
  const stoneGeo = trackGeo(new THREE.DodecahedronGeometry(0.145, 0));
  const ashGeo = trackGeo(new THREE.CylinderGeometry(0.46, 0.54, 0.045, 12));
  const logGeo = trackGeo(new THREE.CylinderGeometry(0.052, 0.066, 0.72, 7));
  const emberGeo = trackGeo(new THREE.DodecahedronGeometry(0.24, 1));
  const flameGeo = trackGeo(createCrossedFlameGeometry());
  const sparkGeo = trackGeo(createSparkGeometry(18));

  const frontPoleGeo = trackGeo(new THREE.CylinderGeometry(0.052, 0.068, 1.92, 7));
  const rearPoleGeo = trackGeo(new THREE.CylinderGeometry(0.048, 0.062, 1.02, 7));
  const ridgePoleGeo = trackGeo(new THREE.CylinderGeometry(0.046, 0.05, 2.66, 7));
  ridgePoleGeo.rotateZ(Math.PI * 0.5);
  const rafterGeo = trackGeo(new THREE.CylinderGeometry(0.036, 0.042, 2.18, 6));
  rafterGeo.rotateX(Math.PI * 0.5);
  const tarpGeo = trackGeo(new THREE.PlaneGeometry(2.6, 2.24, 4, 4));
  // Subtle organic cloth sag along tarp center
  const tarpPos = tarpGeo.getAttribute('position');
  if (tarpPos instanceof THREE.BufferAttribute) {
    for (let i = 0; i < tarpPos.count; i += 1) {
      const tx = tarpPos.getX(i);
      const ty = tarpPos.getY(i);
      const sag = (1 - (tx * tx) / 1.9) * (1 - (ty * ty) / 1.4) * -0.09;
      tarpPos.setZ(i, sag);
    }
    tarpGeo.computeVertexNormals();
  }
  const sideFlapGeo = trackGeo(new THREE.PlaneGeometry(1.72, 0.88));
  const slatGeo = trackGeo(new THREE.BoxGeometry(1.92, 0.045, 0.14));
  const runnerGeo = trackGeo(new THREE.BoxGeometry(0.09, 0.08, 1.06));
  const bedrollGeo = trackGeo(new THREE.CylinderGeometry(0.145, 0.145, 0.92, 10));
  bedrollGeo.rotateZ(Math.PI * 0.5);
  const blanketGeo = trackGeo(new THREE.BoxGeometry(1.42, 0.07, 0.78));

  const campfires: PlacedCampfire[] = [];
  const shelters: PlacedShelter[] = [];
  const scratchProbe: Vec2Like = { x: 0, z: 0 };
  let lastElapsed = 0;

  function hasCampOverlap(x: number, z: number, minDist: number): boolean {
    const minSq = minDist * minDist;
    for (let i = 0; i < campfires.length; i += 1) {
      const f = campfires[i];
      if (f) {
        const dx = f.x - x;
        const dz = f.z - z;
        if (dx * dx + dz * dz < minSq) {
          return true;
        }
      }
    }
    for (let i = 0; i < shelters.length; i += 1) {
      const s = shelters[i];
      if (s) {
        const dx = s.x - x;
        const dz = s.z - z;
        if (dx * dx + dz * dz < minSq) {
          return true;
        }
      }
    }
    return false;
  }

  function removeTrackedObstacles(added: readonly Obstacle[]): void {
    for (let i = 0; i < added.length; i += 1) {
      const obs = added[i];
      if (!obs) {
        continue;
      }
      const idx = obstacles.indexOf(obs);
      if (idx >= 0) {
        obstacles.splice(idx, 1);
      }
    }
  }

  function clearAllStructures(): void {
    for (let i = 0; i < campfires.length; i += 1) {
      const fire = campfires[i];
      if (!fire) {
        continue;
      }
      removeTrackedObstacles(fire.addedObstacles);
      fire.group.removeFromParent();
      fire.flameMat.dispose();
      fire.sparkMat.dispose();
      fire.light.dispose();
    }
    campfires.length = 0;

    for (let i = 0; i < shelters.length; i += 1) {
      const shelter = shelters[i];
      if (!shelter) {
        continue;
      }
      removeTrackedObstacles(shelter.addedObstacles);
      shelter.group.removeFromParent();
    }
    shelters.length = 0;
  }

  function tryBuildCampfire(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): CampBuildResult {
    const len = Math.hypot(fwdX, fwdZ) || 1;
    const fx = playerX + (fwdX / len) * 1.85;
    const fz = playerZ + (fwdZ / len) * 1.85;

    if (campfires.length >= MAX_CAMPFIRES) {
      return { ok: false, reason: 'limit', x: fx, z: fz };
    }
    if (isInsidePuddle(fx, fz)) {
      return { ok: false, reason: 'puddle', x: fx, z: fz };
    }
    if (hasCampOverlap(fx, fz, 2.5)) {
      return { ok: false, reason: 'overlap', x: fx, z: fz };
    }

    scratchProbe.x = fx;
    scratchProbe.z = fz;
    resolveHorizontalCollision(scratchProbe, 0.85, obstacles);
    const pushedDist = Math.hypot(scratchProbe.x - fx, scratchProbe.z - fz);
    if (pushedDist > 0.25) {
      return { ok: false, reason: 'blocked', x: fx, z: fz };
    }

    spawnCampfireAt(fx, fz);
    return { ok: true, x: fx, z: fz };
  }

  function spawnCampfireAt(fx: number, fz: number): void {
    const groundY = getTerrainHeight(fx, fz);
    const group = new THREE.Group();
    group.position.set(fx, groundY, fz);

    // Scorched dark ash pit
    const ashBed = new THREE.Mesh(ashGeo, ashMat);
    ashBed.position.set(0, 0.02, 0);
    ashBed.receiveShadow = true;
    group.add(ashBed);

    // Ring of 10 uneven mossy Pacific Northwest river stones
    const stoneCount = 10;
    for (let i = 0; i < stoneCount; i += 1) {
      const a = (i / stoneCount) * Math.PI * 2 + (i % 2) * 0.08;
      const r = 0.52 + ((i * 37) % 5) * 0.018;
      const stone = new THREE.Mesh(stoneGeo, stoneMat);
      stone.position.set(Math.cos(a) * r, 0.065, Math.sin(a) * r);
      stone.scale.set(
        0.95 + (i % 3) * 0.16,
        0.62 + ((i + 1) % 3) * 0.14,
        0.88 + ((i + 2) % 3) * 0.15,
      );
      stone.rotation.set(i * 0.4, a, i * 0.25);
      stone.castShadow = true;
      stone.receiveShadow = true;
      group.add(stone);
    }

    // 5 crossed split firewood logs stacked in a grounded campfire teepee/star lay
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2 + 0.22;
      const log = new THREE.Mesh(logGeo, woodMat);
      log.position.set(Math.cos(a) * 0.14, 0.17, Math.sin(a) * 0.14);
      log.rotation.order = 'YXZ';
      log.rotation.y = a;
      log.rotation.x = 0.92 + (i % 2) * 0.12;
      log.castShadow = true;
      log.receiveShadow = true;
      group.add(log);
    }

    // Glowing charred ember mound
    const emberMound = new THREE.Mesh(emberGeo, emberMoundMat);
    emberMound.position.set(0, 0.09, 0);
    emberMound.scale.set(1.15, 0.48, 1.15);
    group.add(emberMound);

    const phase = campfires.length * 2.35 + 0.6;

    // Multi-card flickering additive flame shader
    const flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERTEX_SHADER,
      fragmentShader: FLAME_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: lastElapsed },
        uPhase: { value: phase },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const flameMesh = new THREE.Mesh(flameGeo, flameMat);
    flameMesh.renderOrder = 5;
    flameMesh.userData['excludeFromGtao'] = true;
    group.add(flameMesh);

    // Rising embers & glowing ash sparks
    const sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERTEX_SHADER,
      fragmentShader: SPARK_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: lastElapsed },
        uPhase: { value: phase },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    sparkPoints.frustumCulled = false;
    sparkPoints.renderOrder = 6;
    sparkPoints.userData['excludeFromGtao'] = true;
    group.add(sparkPoints);

    // Warm crackling firelight illuminating nearby trees, ferns & camp
    const light = new THREE.PointLight('#ff8b3d', 8.5, 16, 1.7);
    light.position.set(0, 0.68, 0);
    light.castShadow = false;
    group.add(light);

    root.add(group);

    // Keep radius just below MIN_OCCLUDING_CIRCLE_RADIUS (0.55) so low fire stones never block AI sightlines
    const fireCollider: Obstacle = { kind: 'circle', x: fx, z: fz, radius: 0.54 };
    obstacles.push(fireCollider);

    campfires.push({
      group,
      light,
      flameMat,
      sparkMat,
      x: fx,
      z: fz,
      phase,
      addedObstacles: [fireCollider],
    });
  }

  function spawnShelterAt(sx: number, sz: number, shelterYaw: number): void {
    const groundY = getTerrainHeight(sx, sz);

    const group = new THREE.Group();
    group.position.set(sx, groundY - 0.08, sz);
    group.rotation.y = shelterYaw;

    // 4 lashed timber support posts (tall front opening at z = -0.82, low back at z = +0.88)
    for (const side of [-1, 1] as const) {
      const frontPost = new THREE.Mesh(frontPoleGeo, woodMat);
      frontPost.position.set(side * 1.18, 0.92, -0.82);
      frontPost.castShadow = true;
      frontPost.receiveShadow = true;
      group.add(frontPost);

      const rearPost = new THREE.Mesh(rearPoleGeo, woodMat);
      rearPost.position.set(side * 1.18, 0.48, 0.88);
      rearPost.castShadow = true;
      rearPost.receiveShadow = true;
      group.add(rearPost);
    }

    // Front high ridge beam & rear low eave beam
    const frontRidge = new THREE.Mesh(ridgePoleGeo, woodMat);
    frontRidge.position.set(0, 1.84, -0.82);
    frontRidge.castShadow = true;
    group.add(frontRidge);

    const rearBeam = new THREE.Mesh(ridgePoleGeo, woodMat);
    rearBeam.position.set(0, 0.95, 0.88);
    rearBeam.castShadow = true;
    group.add(rearBeam);

    // 3 sloped roof rafters spanning front ridge down to rear beam
    const roofPitch = Math.atan2(1.84 - 0.95, 1.7);
    for (const rx of [-1.14, 0, 1.14]) {
      const rafter = new THREE.Mesh(rafterGeo, woodMat);
      rafter.position.set(rx, 1.4, 0.03);
      rafter.rotation.x = roofPitch;
      rafter.castShadow = true;
      group.add(rafter);
    }

    // Sloped weathered olive-canvas rain tarp roof
    const tarp = new THREE.Mesh(tarpGeo, tarpMat);
    tarp.position.set(0, 1.44, 0.03);
    tarp.rotation.x = -Math.PI * 0.5 + roofPitch;
    tarp.castShadow = true;
    tarp.receiveShadow = true;
    group.add(tarp);

    // Side canvas windbreak flaps keeping driving Pacific Northwest rain out
    for (const side of [-1, 1] as const) {
      const flap = new THREE.Mesh(sideFlapGeo, tarpMat);
      flap.position.set(side * 1.2, 0.88, 0.04);
      flap.rotation.y = side * Math.PI * 0.5;
      flap.castShadow = true;
      flap.receiveShadow = true;
      group.add(flap);
    }

    // Raised rough-hewn timber sleeping pallet + rolled canvas bedroll & warm wool blanket
    for (const rx of [-0.62, 0.62]) {
      const runner = new THREE.Mesh(runnerGeo, woodMat);
      runner.position.set(rx, 0.08, 0.14);
      runner.castShadow = true;
      runner.receiveShadow = true;
      group.add(runner);
    }
    for (let s = 0; s < 6; s += 1) {
      const slat = new THREE.Mesh(slatGeo, woodMat);
      slat.position.set(0, 0.14, -0.3 + s * 0.175);
      slat.castShadow = true;
      slat.receiveShadow = true;
      group.add(slat);
    }

    const blanket = new THREE.Mesh(blanketGeo, blanketMat);
    blanket.position.set(-0.12, 0.195, 0.16);
    blanket.castShadow = true;
    blanket.receiveShadow = true;
    group.add(blanket);

    const bedroll = new THREE.Mesh(bedrollGeo, bedrollMat);
    bedroll.position.set(0.56, 0.28, 0.2);
    bedroll.rotation.y = 0.15;
    bedroll.castShadow = true;
    bedroll.receiveShadow = true;
    group.add(bedroll);

    root.add(group);

    // Add lightweight rear-post colliders while leaving the front tarp entrance wide open to step inside
    const cosY = Math.cos(shelterYaw);
    const sinY = Math.sin(shelterYaw);
    const postToWorld = (lx: number, lz: number): Obstacle => ({
      kind: 'circle',
      x: sx + lx * cosY + lz * sinY,
      z: sz - lx * sinY + lz * cosY,
      radius: 0.34,
    });
    const addedObstacles: Obstacle[] = [
      postToWorld(-1.18, 0.88),
      postToWorld(1.18, 0.88),
      postToWorld(0, 0.92),
    ];
    for (let i = 0; i < addedObstacles.length; i += 1) {
      const obs = addedObstacles[i];
      if (obs) {
        obstacles.push(obs);
      }
    }

    // Compute clean respawn point 1.65 m in front of the open shelter entrance
    const rawRespawnX = sx - sinY * 1.65;
    const rawRespawnZ = sz - cosY * 1.65;
    scratchProbe.x = rawRespawnX;
    scratchProbe.z = rawRespawnZ;
    resolveHorizontalCollision(scratchProbe, 0.5, obstacles);

    shelters.push({
      group,
      x: sx,
      z: sz,
      yaw: shelterYaw,
      respawnX: scratchProbe.x,
      respawnZ: scratchProbe.z,
      addedObstacles,
    });
  }

  function tryBuildShelter(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): CampBuildResult {
    const len = Math.hypot(fwdX, fwdZ) || 1;
    const dirX = fwdX / len;
    const dirZ = fwdZ / len;
    const sx = playerX + dirX * 2.55;
    const sz = playerZ + dirZ * 2.55;

    if (shelters.length >= MAX_SHELTERS) {
      return { ok: false, reason: 'limit', x: sx, z: sz };
    }
    if (isInsidePuddle(sx, sz)) {
      return { ok: false, reason: 'puddle', x: sx, z: sz };
    }
    if (hasCampOverlap(sx, sz, 3.2)) {
      return { ok: false, reason: 'overlap', x: sx, z: sz };
    }

    scratchProbe.x = sx;
    scratchProbe.z = sz;
    resolveHorizontalCollision(scratchProbe, 1.4, obstacles);
    const pushedDist = Math.hypot(scratchProbe.x - sx, scratchProbe.z - sz);
    if (pushedDist > 0.3) {
      return { ok: false, reason: 'blocked', x: sx, z: sz };
    }

    // Open front (-Z in shelter local space) faces back toward the survivor who built it
    const shelterYaw = Math.atan2(dirX, dirZ);
    spawnShelterAt(sx, sz, shelterYaw);
    return { ok: true, x: sx, z: sz };
  }

  return {
    root,
    tryBuildCampfire,
    tryBuildShelter,
    sampleProximity(x: number, z: number, out: CampProximityInfo): void {
      let bestFireDist = Infinity;
      let bestFireX = x;
      let bestFireZ = z;
      for (let i = 0; i < campfires.length; i += 1) {
        const f = campfires[i];
        if (!f) {
          continue;
        }
        const d = Math.hypot(x - f.x, z - f.z);
        if (d < bestFireDist) {
          bestFireDist = d;
          bestFireX = f.x;
          bestFireZ = f.z;
        }
      }

      const nearFire = bestFireDist <= CAMPFIRE_WARMTH_RADIUS;
      const canCookAtFire = bestFireDist <= CAMPFIRE_COOK_RADIUS;
      const fireProximity =
        bestFireDist < 12 ? Math.max(0, Math.min(1, 1 - bestFireDist / 12)) : 0;

      let inCampShelter = false;
      for (let i = 0; i < shelters.length; i += 1) {
        const s = shelters[i];
        if (s && Math.hypot(x - s.x, z - s.z) <= SHELTER_PROTECT_RADIUS) {
          inCampShelter = true;
          break;
        }
      }

      out.nearFire = nearFire;
      out.inCampShelter = inCampShelter;
      out.fireProximity = fireProximity;
      out.fireX = bestFireX;
      out.fireZ = bestFireZ;
      out.canCookAtFire = canCookAtFire;
    },
    getNearestCampfire(x: number, z: number, maxDist: number, out?: Vec2Like): boolean {
      let bestDistSq = maxDist * maxDist;
      let found: PlacedCampfire | null = null;
      for (let i = 0; i < campfires.length; i += 1) {
        const f = campfires[i];
        if (!f) {
          continue;
        }
        const dx = x - f.x;
        const dz = z - f.z;
        const dSq = dx * dx + dz * dz;
        if (dSq <= bestDistSq) {
          bestDistSq = dSq;
          found = f;
        }
      }
      if (!found) {
        return false;
      }
      if (out) {
        out.x = found.x;
        out.z = found.z;
      }
      return true;
    },
    getCampfireRepelPoint(x: number, z: number, out: Vec2Like): boolean {
      let bestDistSq = CAMPFIRE_REPEL_RADIUS * CAMPFIRE_REPEL_RADIUS;
      let found: PlacedCampfire | null = null;
      for (let i = 0; i < campfires.length; i += 1) {
        const f = campfires[i];
        if (!f) {
          continue;
        }
        const dx = x - f.x;
        const dz = z - f.z;
        const dSq = dx * dx + dz * dz;
        if (dSq <= bestDistSq) {
          bestDistSq = dSq;
          found = f;
        }
      }
      if (!found) {
        return false;
      }
      out.x = found.x;
      out.z = found.z;
      return true;
    },
    getCampRespawnPoint(out: Vec2Like): boolean {
      const latest = shelters[shelters.length - 1];
      if (!latest) {
        return false;
      }
      out.x = latest.respawnX;
      out.z = latest.respawnZ;
      resolveHorizontalCollision(out, 0.5, obstacles);
      return true;
    },
    getCounts(): { readonly campfires: number; readonly shelters: number } {
      return { campfires: campfires.length, shelters: shelters.length };
    },
    serialize(): SavedCampState {
      return {
        campfires: campfires.map((f) => ({ x: f.x, z: f.z })),
        shelters: shelters.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw })),
      };
    },
    hydrate(state: SavedCampState): void {
      clearAllStructures();
      const maxFires = Math.min(state.campfires.length, MAX_CAMPFIRES);
      for (let i = 0; i < maxFires; i += 1) {
        const fire = state.campfires[i];
        if (fire && Number.isFinite(fire.x) && Number.isFinite(fire.z)) {
          spawnCampfireAt(fire.x, fire.z);
        }
      }
      const maxShelters = Math.min(state.shelters.length, MAX_SHELTERS);
      for (let i = 0; i < maxShelters; i += 1) {
        const sh = state.shelters[i];
        if (sh && Number.isFinite(sh.x) && Number.isFinite(sh.z) && Number.isFinite(sh.yaw)) {
          spawnShelterAt(sh.x, sh.z, sh.yaw);
        }
      }
    },
    update(_dt: number, elapsed: number): void {
      lastElapsed = elapsed;
      if (campfires.length === 0) {
        return;
      }
      emberMoundMat.emissiveIntensity = 2.0 + Math.sin(elapsed * 5.2) * 0.35;
      for (let i = 0; i < campfires.length; i += 1) {
        const f = campfires[i];
        if (!f) {
          continue;
        }
        const uFlameTime = f.flameMat.uniforms['uTime'];
        if (uFlameTime) {
          uFlameTime.value = elapsed;
        }
        const uSparkTime = f.sparkMat.uniforms['uTime'];
        if (uSparkTime) {
          uSparkTime.value = elapsed;
        }
        // Organic warm wood-fire flicker
        const flicker =
          Math.sin(elapsed * 9.4 + f.phase) * 0.65 +
          Math.sin(elapsed * 17.8 + f.phase * 1.9) * 0.35 +
          Math.cos(elapsed * 5.1 + f.phase * 0.7) * 0.4;
        f.light.intensity = 8.5 + flicker * 1.25;
      }
    },
    reset(): void {
      lastElapsed = 0;
      clearAllStructures();
    },
    dispose(): void {
      clearAllStructures();
      for (let i = 0; i < sharedGeos.length; i += 1) {
        sharedGeos[i]?.dispose();
      }
      for (let i = 0; i < sharedMats.length; i += 1) {
        sharedMats[i]?.dispose();
      }
      root.clear();
    },
  };
}
