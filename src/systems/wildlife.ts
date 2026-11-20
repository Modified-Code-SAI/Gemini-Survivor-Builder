import * as THREE from 'three';
import {
  clamp,
  getRoadCenterX,
  getTerrainHeight,
  resolveHorizontalCollision,
  type Obstacle,
  type Vec2Like,
} from '../world/terrain';

export interface WildlifeSystem {
  readonly root: THREE.Group;
  update(
    dt: number,
    elapsed: number,
    playerX: number,
    playerZ: number,
    playerNoiseRadius: number,
    nightFactor: number,
    rainIntensity: number,
  ): void;
  onDisturbance(x: number, z: number, radius: number): void;
  reset(): void;
  dispose(): void;
}

interface RavenAgent {
  readonly root: THREE.Group;
  readonly leftWing: THREE.Group;
  readonly rightWing: THREE.Group;
  readonly centerX: number;
  readonly centerZ: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly baseAltitude: number;
  readonly angularSpeed: number;
  readonly initialAngle: number;
  angle: number;
  flapPhase: number;
  flareTimer: number;
}

type DeerState = 'grazing' | 'alert' | 'fleeing' | 'returning';

interface DeerAgent {
  readonly root: THREE.Group;
  readonly bodyGroup: THREE.Group;
  readonly neckPivot: THREE.Group;
  readonly tailPivot: THREE.Group;
  readonly legFL: THREE.Group;
  readonly legFR: THREE.Group;
  readonly legBL: THREE.Group;
  readonly legBR: THREE.Group;
  readonly homeX: number;
  readonly homeZ: number;
  readonly homeYaw: number;
  x: number;
  z: number;
  yaw: number;
  state: DeerState;
  stateTimer: number;
  grazePhase: number;
  gaitPhase: number;
  speed: number;
  fleeX: number;
  fleeZ: number;
  alertTargetX: number;
  alertTargetZ: number;
  calmTimer: number;
  fleeElapsed: number;
  returnElapsed: number;
  blockedTimer: number;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function lerpAngle(current: number, target: number, alpha: number): number {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return current + diff * alpha;
}

const FIREFLY_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  attribute float aPhase;
  attribute float aSize;
  varying float vGlow;

  void main() {
    vec3 drift = vec3(
      sin(uTime * 0.65 + aPhase * 6.2831) * 0.85,
      sin(uTime * 1.12 + aPhase * 11.7) * 0.34,
      cos(uTime * 0.58 + aPhase * 9.1) * 0.85
    );
    vec3 worldPos = position + drift;
    vec4 mvPos = modelViewMatrix * vec4(worldPos, 1.0);
    float dist = max(0.8, -mvPos.z);

    // Organic bioluminescent pulse cycle (soft dark pause -> golden-chartreuse flash)
    float pulseWave = 0.5 + 0.5 * sin(uTime * (1.8 + fract(aPhase * 7.3) * 1.4) + aPhase * 31.4);
    float pulse = pow(pulseWave, 2.4);
    float distFade = (1.0 - smoothstep(18.0, 42.0, dist)) * smoothstep(0.6, 2.4, dist);
    vGlow = pulse * distFade * uIntensity;

    gl_PointSize = clamp((aSize * 34.0) / dist, 1.5, 11.0);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FIREFLY_FRAGMENT_SHADER = /* glsl */ `
  varying float vGlow;

  void main() {
    if (vGlow <= 0.008) {
      discard;
    }
    vec2 centered = gl_PointCoord - vec2(0.5);
    float r = length(centered);
    if (r > 0.5) {
      discard;
    }
    float core = pow(1.0 - r * 2.0, 2.0);
    vec3 warmChartreuse = mix(vec3(0.62, 0.94, 0.28), vec3(1.0, 0.95, 0.54), core);
    gl_FragColor = vec4(warmChartreuse, core * vGlow * 0.92);
  }
`;

export function createWildlifeSystem(obstacles: readonly Obstacle[]): WildlifeSystem {
  const root = new THREE.Group();
  root.name = 'PacificNorthwestWildlife';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };
  const trackMat = <T extends THREE.Material>(mat: T): T => {
    materials.push(mat);
    return mat;
  };

  // --- 1. Six Gliding Forest Ravens circling high above the valley pines ---
  const ravenMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x16191e,
      roughness: 0.72,
      metalness: 0.14,
    }),
  );
  const ravenBodyGeo = trackGeo(new THREE.CapsuleGeometry(0.085, 0.34, 4, 7));
  ravenBodyGeo.rotateX(Math.PI * 0.5);
  const ravenHeadGeo = trackGeo(new THREE.SphereGeometry(0.072, 6, 6));
  const ravenBeakGeo = trackGeo(new THREE.ConeGeometry(0.028, 0.12, 5));
  ravenBeakGeo.rotateX(-Math.PI * 0.5);
  const ravenTailGeo = trackGeo(new THREE.BoxGeometry(0.18, 0.018, 0.24));
  const ravenInnerWingGeo = trackGeo(new THREE.BoxGeometry(0.42, 0.02, 0.24));
  const ravenOuterWingGeo = trackGeo(new THREE.BoxGeometry(0.36, 0.016, 0.16));

  const ravenSpecs: ReadonlyArray<
    readonly [number, number, number, number, number, number, number]
  > = [
    [-6, -12, 18, 22, 22.5, 0.17, 0.4],
    [4, -22, 22, 18, 25.0, -0.14, 2.1],
    [-10, -28, 20, 26, 20.5, 0.15, 3.8],
    [12, -8, 16, 20, 24.0, -0.16, 5.1],
    [-2, 2, 19, 15, 27.5, 0.13, 1.3],
    [8, -36, 24, 20, 19.5, -0.18, 4.4],
  ];

  const ravens: RavenAgent[] = [];
  for (let i = 0; i < ravenSpecs.length; i += 1) {
    const spec = ravenSpecs[i];
    if (!spec) {
      continue;
    }
    const [cx, cz, rx, rz, alt, angSpeed, initAngle] = spec;
    const ravenGroup = new THREE.Group();

    const body = new THREE.Mesh(ravenBodyGeo, ravenMat);
    ravenGroup.add(body);

    const head = new THREE.Mesh(ravenHeadGeo, ravenMat);
    head.position.set(0, 0.03, -0.22);
    ravenGroup.add(head);

    const beak = new THREE.Mesh(ravenBeakGeo, ravenMat);
    beak.position.set(0, 0.02, -0.32);
    ravenGroup.add(beak);

    const tail = new THREE.Mesh(ravenTailGeo, ravenMat);
    tail.position.set(0, 0.01, 0.26);
    ravenGroup.add(tail);

    const makeWing = (side: -1 | 1): THREE.Group => {
      const wingPivot = new THREE.Group();
      wingPivot.position.set(side * 0.05, 0.02, -0.02);
      const inner = new THREE.Mesh(ravenInnerWingGeo, ravenMat);
      inner.position.set(side * 0.21, 0, 0.01);
      wingPivot.add(inner);

      const outer = new THREE.Mesh(ravenOuterWingGeo, ravenMat);
      outer.position.set(side * 0.56, -0.02, 0.06);
      outer.rotation.y = -side * 0.24;
      wingPivot.add(outer);
      return wingPivot;
    };

    const leftWing = makeWing(-1);
    const rightWing = makeWing(1);
    ravenGroup.add(leftWing);
    ravenGroup.add(rightWing);
    ravenGroup.scale.setScalar(1.15);

    root.add(ravenGroup);
    ravens.push({
      root: ravenGroup,
      leftWing,
      rightWing,
      centerX: cx,
      centerZ: cz,
      radiusX: rx,
      radiusZ: rz,
      baseAltitude: alt,
      angularSpeed: angSpeed,
      initialAngle: initAngle,
      angle: initAngle,
      flapPhase: i * 1.7,
      flareTimer: 0,
    });
  }

  // --- 2. Two Grazing & Skittish Pacific Northwest Whitetail Deer ---
  const deerCoatMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x7b5c42,
      roughness: 0.86,
      metalness: 0.02,
    }),
  );
  const deerBellyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd9d2c5,
      roughness: 0.9,
      metalness: 0.01,
    }),
  );
  const deerDarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1d1916,
      roughness: 0.65,
      metalness: 0.06,
    }),
  );
  const antlerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xbcae94,
      roughness: 0.78,
      metalness: 0.04,
    }),
  );

  const deerTorsoGeo = trackGeo(new THREE.CapsuleGeometry(0.24, 0.66, 6, 10));
  deerTorsoGeo.rotateX(Math.PI * 0.5);
  const deerChestGeo = trackGeo(new THREE.SphereGeometry(0.23, 8, 8));
  const deerBellyGeo = trackGeo(new THREE.CapsuleGeometry(0.16, 0.54, 4, 8));
  deerBellyGeo.rotateX(Math.PI * 0.5);
  const deerNeckGeo = trackGeo(new THREE.CylinderGeometry(0.088, 0.135, 0.44, 8));
  deerNeckGeo.translate(0, 0.2, 0);
  const deerHeadGeo = trackGeo(new THREE.SphereGeometry(0.11, 8, 8));
  deerHeadGeo.scale(0.82, 0.86, 1.38);
  const deerSnoutGeo = trackGeo(new THREE.CylinderGeometry(0.042, 0.072, 0.17, 7));
  // -PI/2 maps narrow top (+Y) forward along controller -Z
  deerSnoutGeo.rotateX(-Math.PI * 0.5);
  const deerNoseGeo = trackGeo(new THREE.SphereGeometry(0.036, 6, 6));
  const deerEyeGeo = trackGeo(new THREE.SphereGeometry(0.018, 6, 6));
  const deerEarGeo = trackGeo(new THREE.ConeGeometry(0.048, 0.16, 6));
  const deerAntlerMainGeo = trackGeo(new THREE.CylinderGeometry(0.012, 0.02, 0.28, 5));
  deerAntlerMainGeo.translate(0, 0.14, 0);
  const deerAntlerTineGeo = trackGeo(new THREE.CylinderGeometry(0.008, 0.013, 0.14, 5));
  deerAntlerTineGeo.translate(0, 0.07, 0);
  const deerTailGeo = trackGeo(new THREE.ConeGeometry(0.068, 0.24, 6));
  deerTailGeo.rotateX(Math.PI);
  deerTailGeo.translate(0, -0.1, 0);
  const deerUpperLegGeo = trackGeo(new THREE.CylinderGeometry(0.058, 0.042, 0.42, 7));
  deerUpperLegGeo.translate(0, -0.21, 0);
  const deerLowerLegGeo = trackGeo(new THREE.CylinderGeometry(0.036, 0.028, 0.44, 6));
  deerLowerLegGeo.translate(0, -0.62, 0);
  const deerHoofGeo = trackGeo(new THREE.CylinderGeometry(0.032, 0.036, 0.07, 6));
  deerHoofGeo.translate(0, -0.84, 0);

  const buildDeer = (
    homeX: number,
    homeZ: number,
    homeYaw: number,
    hasAntlers: boolean,
  ): DeerAgent => {
    const deerRoot = new THREE.Group();
    const bodyGroup = new THREE.Group();
    bodyGroup.position.set(0, 0.88, 0);
    deerRoot.add(bodyGroup);

    const torso = new THREE.Mesh(deerTorsoGeo, deerCoatMat);
    torso.castShadow = true;
    torso.receiveShadow = true;
    bodyGroup.add(torso);

    const chest = new THREE.Mesh(deerChestGeo, deerCoatMat);
    chest.position.set(0, -0.02, -0.32);
    chest.castShadow = true;
    bodyGroup.add(chest);

    const belly = new THREE.Mesh(deerBellyGeo, deerBellyMat);
    belly.position.set(0, -0.13, 0.02);
    bodyGroup.add(belly);

    // Articulated neck + head + ears (+ forked PNW buck antlers on buck)
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 0.06, -0.38);
    bodyGroup.add(neckPivot);

    const neck = new THREE.Mesh(deerNeckGeo, deerCoatMat);
    // Negative X rotation angles neck top forward (-Z) toward headGroup
    neck.rotation.x = -0.28;
    neck.castShadow = true;
    neckPivot.add(neck);

    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.42, -0.12);
    neckPivot.add(headGroup);

    const head = new THREE.Mesh(deerHeadGeo, deerCoatMat);
    head.castShadow = true;
    headGroup.add(head);

    const snout = new THREE.Mesh(deerSnoutGeo, deerCoatMat);
    snout.position.set(0, -0.03, -0.15);
    headGroup.add(snout);

    const nose = new THREE.Mesh(deerNoseGeo, deerDarkMat);
    nose.position.set(0, -0.028, -0.235);
    headGroup.add(nose);

    for (const side of [-1, 1] as const) {
      const eye = new THREE.Mesh(deerEyeGeo, deerDarkMat);
      eye.position.set(side * 0.072, 0.022, -0.06);
      headGroup.add(eye);

      const ear = new THREE.Mesh(deerEarGeo, deerCoatMat);
      ear.position.set(side * 0.085, 0.11, 0.04);
      ear.rotation.set(0.18, 0, -side * 0.55);
      headGroup.add(ear);

      if (hasAntlers) {
        const antlerBase = new THREE.Group();
        antlerBase.position.set(side * 0.045, 0.08, 0.01);
        antlerBase.rotation.set(-0.22, 0, -side * 0.36);
        const beam = new THREE.Mesh(deerAntlerMainGeo, antlerMat);
        beam.castShadow = true;
        antlerBase.add(beam);

        const tine1 = new THREE.Mesh(deerAntlerTineGeo, antlerMat);
        tine1.position.set(0, 0.13, 0);
        tine1.rotation.set(0.55, 0, side * 0.28);
        antlerBase.add(tine1);

        const tine2 = new THREE.Mesh(deerAntlerTineGeo, antlerMat);
        tine2.position.set(0, 0.22, 0);
        tine2.rotation.set(-0.32, 0, -side * 0.35);
        antlerBase.add(tine2);

        headGroup.add(antlerBase);
      }
    }

    // Iconic flicking white-flag tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.08, 0.44);
    bodyGroup.add(tailPivot);
    const tailMesh = new THREE.Mesh(deerTailGeo, deerBellyMat);
    tailPivot.add(tailMesh);

    const makeLeg = (lx: number, lz: number): THREE.Group => {
      const leg = new THREE.Group();
      leg.position.set(lx, 0.0, lz);
      const upper = new THREE.Mesh(deerUpperLegGeo, deerCoatMat);
      upper.castShadow = true;
      leg.add(upper);
      const lower = new THREE.Mesh(deerLowerLegGeo, deerCoatMat);
      lower.castShadow = true;
      leg.add(lower);
      const hoof = new THREE.Mesh(deerHoofGeo, deerDarkMat);
      leg.add(hoof);
      bodyGroup.add(leg);
      return leg;
    };

    const legFL = makeLeg(-0.13, -0.29);
    const legFR = makeLeg(0.13, -0.29);
    const legBL = makeLeg(-0.14, 0.31);
    const legBR = makeLeg(0.14, 0.31);

    const spawnProbe: Vec2Like = { x: homeX, z: homeZ };
    resolveHorizontalCollision(spawnProbe, 0.65, obstacles);

    const startY = getTerrainHeight(spawnProbe.x, spawnProbe.z);
    deerRoot.position.set(spawnProbe.x, startY, spawnProbe.z);
    deerRoot.rotation.y = homeYaw;
    root.add(deerRoot);

    return {
      root: deerRoot,
      bodyGroup,
      neckPivot,
      tailPivot,
      legFL,
      legFR,
      legBL,
      legBR,
      homeX: spawnProbe.x,
      homeZ: spawnProbe.z,
      homeYaw,
      x: spawnProbe.x,
      z: spawnProbe.z,
      yaw: homeYaw,
      state: 'grazing',
      stateTimer: 4,
      grazePhase: hasAntlers ? 0.5 : 2.3,
      gaitPhase: 0,
      speed: 0,
      fleeX: spawnProbe.x,
      fleeZ: spawnProbe.z,
      alertTargetX: spawnProbe.x,
      alertTargetZ: spawnProbe.z,
      calmTimer: 0,
      fleeElapsed: 0,
      returnElapsed: 0,
      blockedTimer: 0,
    };
  };

  const deerList: DeerAgent[] = [
    buildDeer(-18.0, -12.0, -0.85, true),
    buildDeer(16.0, -34.0, 2.25, false),
  ];

  // --- 3. 90 Bioluminescent Night Fireflies drifting over roadside ferns & meadows ---
  const fireflyCount = 90;
  const ffPositions = new Float32Array(fireflyCount * 3);
  const ffPhases = new Float32Array(fireflyCount);
  const ffSizes = new Float32Array(fireflyCount);
  const rng = createSeededRng(912837);

  for (let i = 0; i < fireflyCount; i += 1) {
    const fz = -46 + rng() * 62;
    const roadX = getRoadCenterX(fz);
    const side = rng() < 0.5 ? -1 : 1;
    // Cluster organically along misty fern verges & meadow edges flanking Old Route 9
    const fx = roadX + side * (4.2 + rng() * 17.5);
    const fy = getTerrainHeight(fx, fz) + 0.45 + rng() * 1.9;
    ffPositions[i * 3] = fx;
    ffPositions[i * 3 + 1] = fy;
    ffPositions[i * 3 + 2] = fz;
    ffPhases[i] = rng();
    ffSizes[i] = 1.6 + rng() * 1.8;
  }

  const ffGeo = trackGeo(new THREE.BufferGeometry());
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPositions, 3));
  ffGeo.setAttribute('aPhase', new THREE.BufferAttribute(ffPhases, 1));
  ffGeo.setAttribute('aSize', new THREE.BufferAttribute(ffSizes, 1));

  const ffUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
  };
  const ffMat = trackMat(
    new THREE.ShaderMaterial({
      vertexShader: FIREFLY_VERTEX_SHADER,
      fragmentShader: FIREFLY_FRAGMENT_SHADER,
      uniforms: ffUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  const fireflies = new THREE.Points(ffGeo, ffMat);
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  fireflies.userData['excludeFromGtao'] = true;
  root.add(fireflies);

  // Pre-allocated collision probe (ZERO per-frame allocations)
  const scratchPos2D: Vec2Like = { x: 0, z: 0 };

  function spookDeer(deer: DeerAgent, threatX: number, threatZ: number): void {
    const dx = deer.x - threatX;
    const dz = deer.z - threatZ;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;

    // Bound deeper into the flanking pine forest away from the highway and obstacles
    let targetX = clamp(deer.x + dirX * 18, -44, 44);
    const targetZ = clamp(deer.z + dirZ * 18, -56, 16);
    const roadX = getRoadCenterX(targetZ);
    if (Math.abs(targetX - roadX) < 9.5) {
      targetX = roadX + (targetX >= roadX ? 11.5 : -11.5);
      targetX = clamp(targetX, -44, 44);
    }

    scratchPos2D.x = targetX;
    scratchPos2D.z = targetZ;
    resolveHorizontalCollision(scratchPos2D, 0.85, obstacles);

    deer.fleeX = clamp(scratchPos2D.x, -44, 44);
    deer.fleeZ = clamp(scratchPos2D.z, -56, 16);
    deer.alertTargetX = threatX;
    deer.alertTargetZ = threatZ;
    deer.fleeElapsed = 0;
    deer.blockedTimer = 0;
    if (deer.state === 'grazing' || deer.state === 'returning') {
      deer.state = 'alert';
      deer.stateTimer = 0.42;
    } else if (deer.state === 'fleeing') {
      deer.calmTimer = 0;
    }
  }

  return {
    root,
    onDisturbance(x: number, z: number, radius: number): void {
      const effectiveR = Math.max(8, radius);
      for (let i = 0; i < ravens.length; i += 1) {
        const raven = ravens[i];
        if (!raven) {
          continue;
        }
        const dist = Math.hypot(raven.root.position.x - x, raven.root.position.z - z);
        if (dist < effectiveR + 28) {
          raven.flareTimer = Math.max(raven.flareTimer, 3.2 + (i % 3) * 0.6);
        }
      }

      for (let i = 0; i < deerList.length; i += 1) {
        const deer = deerList[i];
        if (!deer) {
          continue;
        }
        const dist = Math.hypot(deer.x - x, deer.z - z);
        if (dist < effectiveR + 8) {
          spookDeer(deer, x, z);
        }
      }
    },
    update(
      dt: number,
      elapsed: number,
      playerX: number,
      playerZ: number,
      playerNoiseRadius: number,
      nightFactor: number,
      rainIntensity: number,
    ): void {
      const safeDt = Math.max(0, Math.min(dt, 0.1));

      // 1. Update circling valley ravens (glide + rhythmic flaps + disturbance flares)
      for (let i = 0; i < ravens.length; i += 1) {
        const raven = ravens[i];
        if (!raven) {
          continue;
        }
        if (raven.flareTimer > 0) {
          raven.flareTimer = Math.max(0, raven.flareTimer - safeDt);
        }
        const flareBoost = raven.flareTimer > 0 ? 1.55 : 1.0;
        const prevX = raven.centerX + Math.cos(raven.angle) * raven.radiusX;
        const prevZ = raven.centerZ + Math.sin(raven.angle) * raven.radiusZ;

        raven.angle += raven.angularSpeed * flareBoost * safeDt;
        const nextX = raven.centerX + Math.cos(raven.angle) * raven.radiusX;
        const nextZ = raven.centerZ + Math.sin(raven.angle) * raven.radiusZ;

        const climbOffset = raven.flareTimer > 0 ? Math.sin(Math.min(1, raven.flareTimer) * Math.PI * 0.5) * 3.5 : 0;
        const bobY = Math.sin(elapsed * 0.65 + i * 1.4) * 1.35 + climbOffset;
        const groundY = getTerrainHeight(nextX, nextZ);
        raven.root.position.set(nextX, Math.max(groundY + 12, raven.baseAltitude + bobY), nextZ);

        const vx = nextX - prevX;
        const vz = nextZ - prevZ;
        if (vx * vx + vz * vz > 1e-8) {
          raven.root.rotation.y = Math.atan2(-vx, -vz);
        }
        raven.root.rotation.z = raven.angularSpeed > 0 ? -0.24 : 0.24;

        // Alternate lazy soaring glides with rapid bursts of wingbeats
        const glideCycle = Math.sin(elapsed * 0.45 + i * 2.1);
        const isFlapping = raven.flareTimer > 0 || glideCycle > 0.22;
        const flapRate = raven.flareTimer > 0 ? 15.5 : 8.5;
        raven.flapPhase += safeDt * (isFlapping ? flapRate : 1.5);
        const wingAngle = isFlapping
          ? Math.sin(raven.flapPhase) * (raven.flareTimer > 0 ? 0.72 : 0.52)
          : 0.14 + Math.sin(raven.flapPhase) * 0.04;
        raven.leftWing.rotation.z = wingAngle;
        raven.rightWing.rotation.z = -wingAngle;
      }

      // 2. Update whitetail deer grazing, alerting, fleeing, and returning cleanly
      for (let i = 0; i < deerList.length; i += 1) {
        const deer = deerList[i];
        if (!deer) {
          continue;
        }
        const distPlayer = Math.hypot(deer.x - playerX, deer.z - playerZ);
        const spookDist = Math.max(9.5, Math.min(18, 10.5 + playerNoiseRadius * 0.65));

        if (distPlayer < spookDist && (deer.state === 'grazing' || deer.state === 'returning')) {
          spookDeer(deer, playerX, playerZ);
        } else if (distPlayer < 8.5 && deer.state === 'fleeing') {
          spookDeer(deer, playerX, playerZ);
        }

        let targetSpeed = 0;
        let boundLift = 0;
        // Right-handed X rotations for -Z facing: negative lowers head forward / raises tail up-back
        let neckPitch = -0.06;
        let tailLift = -0.12;

        if (deer.state === 'grazing') {
          deer.grazePhase += safeDt * 0.72;
          const nibble = Math.sin(deer.grazePhase);
          // Periodically lower head forward into ferns (-0.95) then raise gently to scan horizon
          neckPitch = nibble > -0.2 ? -0.95 + Math.sin(elapsed * 3.8 + i) * 0.08 : -0.06;
          tailLift = -0.12 + Math.sin(elapsed * 2.2 + i) * 0.05;
        } else if (deer.state === 'alert') {
          deer.stateTimer -= safeDt;
          const lookYaw = Math.atan2(-(deer.alertTargetX - deer.x), -(deer.alertTargetZ - deer.z));
          deer.yaw = lerpAngle(deer.yaw, lookYaw, Math.min(1, safeDt * 12));
          neckPitch = 0.16;
          tailLift = -2.05;
          if (deer.stateTimer <= 0) {
            deer.state = 'fleeing';
            deer.calmTimer = 0;
            deer.fleeElapsed = 0;
          }
        } else if (deer.state === 'fleeing') {
          const toX = deer.fleeX - deer.x;
          const toZ = deer.fleeZ - deer.z;
          const distGoal = Math.hypot(toX, toZ);
          tailLift = -2.2 + Math.sin(elapsed * 14) * 0.14;
          neckPitch = -0.1;

          if (distGoal > 1.4 && deer.fleeElapsed < 6.5) {
            deer.fleeElapsed += safeDt;
            targetSpeed = 5.8;
            const fleeYaw = Math.atan2(-toX, -toZ);
            deer.yaw = lerpAngle(deer.yaw, fleeYaw, Math.min(1, safeDt * 9));
          } else {
            deer.calmTimer += safeDt;
            neckPitch = 0.12;
            tailLift = -0.45;
            if (deer.calmTimer > 14 && distPlayer > 20) {
              deer.state = 'returning';
              deer.returnElapsed = 0;
            }
          }
        } else {
          // Returning calmly to meadow home (capped so obstacles can never soft-lock return)
          const toX = deer.homeX - deer.x;
          const toZ = deer.homeZ - deer.z;
          const distHome = Math.hypot(toX, toZ);
          tailLift = -0.18;
          neckPitch = -0.06;
          if (distHome > 0.9 && deer.returnElapsed < 14.0) {
            deer.returnElapsed += safeDt;
            targetSpeed = 2.1;
            const homeDirYaw = Math.atan2(-toX, -toZ);
            deer.yaw = lerpAngle(deer.yaw, homeDirYaw, Math.min(1, safeDt * 6));
          } else {
            deer.state = 'grazing';
            deer.yaw = lerpAngle(deer.yaw, deer.homeYaw, Math.min(1, safeDt * 4));
          }
        }

        deer.speed += (targetSpeed - deer.speed) * Math.min(1, safeDt * 7.5);
        if (deer.speed > 0.05) {
          const prevX = deer.x;
          const prevZ = deer.z;
          let moveX = -Math.sin(deer.yaw);
          let moveZ = -Math.cos(deer.yaw);
          if (deer.blockedTimer > 0) {
            deer.blockedTimer = Math.max(0, deer.blockedTimer - safeDt);
            const sideX = -moveZ;
            const sideZ = moveX;
            moveX = moveX * 0.45 + sideX * 0.89;
            moveZ = moveZ * 0.45 + sideZ * 0.89;
          }
          scratchPos2D.x = deer.x + moveX * deer.speed * safeDt;
          scratchPos2D.z = deer.z + moveZ * deer.speed * safeDt;
          const hitObs = resolveHorizontalCollision(scratchPos2D, 0.58, obstacles);
          deer.x = clamp(scratchPos2D.x, -46, 46);
          deer.z = clamp(scratchPos2D.z, -60, 20);
          const actualMove = Math.hypot(deer.x - prevX, deer.z - prevZ);
          if (hitObs && actualMove < deer.speed * safeDt * 0.35) {
            deer.blockedTimer = 0.65;
          }
        }

        const strideAmp = clamp(deer.speed / 5.2, 0, 1);
        if (strideAmp > 0.04) {
          deer.gaitPhase += safeDt * (deer.speed > 3.5 ? 11.5 : 6.4);
          const legSwing = Math.sin(deer.gaitPhase) * (0.28 + strideAmp * 0.58);
          if (deer.speed > 3.5) {
            // Bounding gallop gait: forelegs & hindlegs pair rhythmically
            const boundCos = Math.cos(deer.gaitPhase);
            deer.legFL.rotation.x = legSwing;
            deer.legFR.rotation.x = legSwing * 0.92;
            deer.legBL.rotation.x = -legSwing;
            deer.legBR.rotation.x = -legSwing * 0.92;
            boundLift = Math.max(0, boundCos) * 0.34 * strideAmp;
          } else {
            // Calm diagonal trot gait
            deer.legFL.rotation.x = legSwing;
            deer.legBR.rotation.x = legSwing;
            deer.legFR.rotation.x = -legSwing;
            deer.legBL.rotation.x = -legSwing;
            boundLift = Math.abs(Math.sin(deer.gaitPhase)) * 0.06 * strideAmp;
          }
        } else {
          const relax = Math.min(1, safeDt * 8);
          deer.legFL.rotation.x *= 1 - relax;
          deer.legFR.rotation.x *= 1 - relax;
          deer.legBL.rotation.x *= 1 - relax;
          deer.legBR.rotation.x *= 1 - relax;
        }

        const groundY = getTerrainHeight(deer.x, deer.z);
        deer.root.position.set(deer.x, groundY + boundLift, deer.z);
        deer.root.rotation.y = deer.yaw;
        deer.neckPivot.rotation.x += (neckPitch - deer.neckPivot.rotation.x) * Math.min(1, safeDt * 6);
        deer.tailPivot.rotation.x += (tailLift - deer.tailPivot.rotation.x) * Math.min(1, safeDt * 10);
      }

      // 3. Bioluminescent night fireflies emerge softly at dusk/night when rain is light
      const nightGlow = clamp((nightFactor - 0.2) / 0.55, 0, 1);
      const rainSuppress = clamp(1 - (rainIntensity - 0.15) / 0.5, 0, 1);
      const ffStrength = nightGlow * rainSuppress;
      ffUniforms.uTime.value = elapsed;
      ffUniforms.uIntensity.value = ffStrength;
      fireflies.visible = ffStrength > 0.01;
    },
    reset(): void {
      for (let i = 0; i < ravens.length; i += 1) {
        const raven = ravens[i];
        if (!raven) {
          continue;
        }
        raven.angle = raven.initialAngle;
        raven.flareTimer = 0;
      }
      for (let i = 0; i < deerList.length; i += 1) {
        const deer = deerList[i];
        if (!deer) {
          continue;
        }
        deer.x = deer.homeX;
        deer.z = deer.homeZ;
        deer.yaw = deer.homeYaw;
        deer.state = 'grazing';
        deer.speed = 0;
        deer.calmTimer = 0;
        deer.fleeElapsed = 0;
        deer.returnElapsed = 0;
        deer.blockedTimer = 0;
        deer.root.position.set(deer.homeX, getTerrainHeight(deer.homeX, deer.homeZ), deer.homeZ);
        deer.root.rotation.y = deer.homeYaw;
        deer.neckPivot.rotation.x = -0.06;
        deer.tailPivot.rotation.x = -0.12;
      }
      ffUniforms.uIntensity.value = 0;
      fireflies.visible = false;
    },
    dispose(): void {
      for (let i = 0; i < geometries.length; i += 1) {
        geometries[i]?.dispose();
      }
      for (let i = 0; i < materials.length; i += 1) {
        materials[i]?.dispose();
      }
      root.clear();
    },
  };
}
