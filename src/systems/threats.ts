import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { collectMaterialTextures, loadOptionalGlbAsset } from '../world/assetLoader';
import {
  clamp,
  getTerrainHeight,
  resolveHorizontalCollision,
  type Obstacle,
  type Vec2Like,
} from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import { hasLineOfSight, isPointInVisionCone } from './stealth';
import type { LootBundle } from './survival';

export type RaiderState =
  | 'patrol'
  | 'suspicious'
  | 'investigate'
  | 'chase'
  | 'attack'
  | 'downed';

export type GlobalAlertLevel = 'unaware' | 'suspicious' | 'alert';

export interface ThreatsUpdateInput {
  readonly playerX: number;
  readonly playerY: number;
  readonly playerZ: number;
  readonly playerVisibility: number;
  readonly playerNoiseRadius: number;
  readonly playerDead: boolean;
  readonly nightFactor?: number;
  readonly rainIntensity?: number;
  readonly flashlightOn?: boolean;
  readonly getFlashlightExposure?: (x: number, y: number, z: number) => number;
  readonly getFireRepel?: (x: number, z: number, out: Vec2Like) => boolean;
}

export interface PlayerMeleeHitResult {
  readonly hit: boolean;
  readonly stealthTakedown: boolean;
  readonly downed: boolean;
  readonly isMonster?: boolean;
  readonly lootDropped?: LootBundle;
  readonly hitX: number;
  readonly hitZ: number;
}

export interface ThreatSystemOptions {
  readonly obstacles: readonly Obstacle[];
  readonly onPlayerHit?: (damage: number, sourceX: number, sourceZ: number) => void;
  readonly onBottleShatter?: (x: number, z: number) => void;
  readonly onAlertSting?: (level: 'suspicious' | 'alert') => void;
  readonly onStalkerSound?: (kind: 'prowl' | 'shriek' | 'recoil') => void;
}

export interface ThreatSystem {
  readonly root: THREE.Group;
  update(dt: number, elapsed: number, input: ThreatsUpdateInput): void;
  emitNoise(x: number, z: number, radius: number): void;
  tryPlayerMeleeHit(
    playerX: number,
    playerZ: number,
    forwardX: number,
    forwardZ: number,
    playerCrouching: boolean,
  ): PlayerMeleeHitResult;
  throwBottle(
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): boolean;
  getAlertState(): GlobalAlertLevel;
  getAliveCount(): number;
  reset(): void;
  dispose(): void;
}

interface RaiderSpec {
  readonly id: string;
  readonly isMonster: boolean;
  readonly maxHealth: number;
  readonly attackDamage: number;
  readonly patrolSpeed: number;
  readonly investigateSpeed: number;
  readonly chaseSpeed: number;
  readonly spawnX: number;
  readonly spawnZ: number;
  readonly spawnYaw: number;
  readonly waypoints: ReadonlyArray<readonly [number, number]>;
  readonly nightWaypoints?: ReadonlyArray<readonly [number, number]>;
  readonly dropLoot: LootBundle;
}

interface ProceduralRaiderRig {
  readonly root: THREE.Group;
  readonly torso: THREE.Group;
  readonly leftLeg: THREE.Group;
  readonly rightLeg: THREE.Group;
  readonly leftArm: THREE.Group;
  readonly rightArm: THREE.Group;
}

interface RaiderGlbRig {
  readonly wrapper: THREE.Group;
  readonly scene: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly idleAction: THREE.AnimationAction | null;
  readonly walkAction: THREE.AnimationAction | null;
  readonly jogAction: THREE.AnimationAction | null;
  readonly runAction: THREE.AnimationAction | null;
  readonly attackAction: THREE.AnimationAction | null;
  readonly hitAction: THREE.AnimationAction | null;
  readonly deathAction: THREE.AnimationAction | null;
  wIdle: number;
  wWalk: number;
  wJog: number;
  wRun: number;
  wAttack: number;
  wHit: number;
  wDeath: number;
}

interface RaiderActor {
  readonly spec: RaiderSpec;
  readonly root: THREE.Group;
  readonly visualPivot: THREE.Group;
  proceduralRig: ProceduralRaiderRig | null;
  glbRig: RaiderGlbRig | null;
  readonly eyeEmberGroup: THREE.Group | null;
  readonly statusSprite: THREE.Sprite;
  readonly statusMat: THREE.SpriteMaterial;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  hp: number;
  state: RaiderState;
  awareness: number;
  waypointIndex: number;
  waypointPause: number;
  investigateX: number;
  investigateZ: number;
  investigateTimer: number;
  loseSightTimer: number;
  attackCooldown: number;
  attackSwingTimer: number;
  attackHitDelivered: boolean;
  staggerTimer: number;
  staggerVelX: number;
  staggerVelZ: number;
  recoilCooldown: number;
  fireFleeTimer: number;
  fireFleeX: number;
  fireFleeZ: number;
  fireRecoilCooldown: number;
  prowlSoundCooldown: number;
  shriekCooldown: number;
  downProgress: number;
  stridePhase: number;
  blockedTimer: number;
}

interface PooledBottle {
  readonly mesh: THREE.Mesh;
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
}

interface ShatterBurst {
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.PointsMaterial;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  active: boolean;
  age: number;
}

const RAIDER_RADIUS = 0.44;
const RAIDER_VISION_RANGE = 18.0;
const STALKER_VISION_RANGE = 20.5;
const RAIDER_VISION_HALF_FOV = (55 * Math.PI) / 180;
const RAIDER_ATTACK_RANGE = 1.85;
const STALKER_ATTACK_RANGE = 2.05;
const RAIDER_ATTACK_CADENCE = 1.35;
const RAIDER_ATTACK_HIT_DELAY = 0.34;
const PLAYER_MELEE_RANGE = 2.3;
const PLAYER_MELEE_DAMAGE = 35;
const STALKER_STEALTH_AMBUSH_DAMAGE = 75;
const STALKER_FLASHLIGHT_RECOIL_COOLDOWN = 9.0;

const BOTTLE_POOL_SIZE = 3;
const BOTTLE_SPEED = 13.5;
const BOTTLE_GRAVITY = 16.0;
const BOTTLE_NOISE_RADIUS = 18.0;
const SHATTER_PARTICLE_COUNT = 14;
const SHATTER_DURATION = 0.65;

const RAIDER_SPECS: readonly RaiderSpec[] = [
  {
    id: 'gas_patrol',
    isMonster: false,
    maxHealth: 100,
    attackDamage: 22,
    patrolSpeed: 1.65,
    investigateSpeed: 2.25,
    chaseSpeed: 4.65,
    spawnX: 5.6,
    spawnZ: -14.5,
    spawnYaw: -0.65,
    waypoints: [
      [5.6, -14.5],
      [8.0, -9.8],
      [6.4, -3.2],
      [0.8, -12.5],
      [4.6, -20.5],
    ],
    dropLoot: { rations: 1, bottles: 1, scrap: 3 },
  },
  {
    id: 'milepost_guard',
    isMonster: false,
    maxHealth: 100,
    attackDamage: 22,
    patrolSpeed: 1.65,
    investigateSpeed: 2.25,
    chaseSpeed: 4.65,
    spawnX: -0.4,
    spawnZ: -33.5,
    spawnYaw: 2.6,
    waypoints: [
      [-0.4, -33.5],
      [1.8, -40.5],
      [-0.4, -46.8],
      [-3.6, -37.2],
      [0.6, -29.5],
    ],
    dropLoot: { medkits: 1, warmers: 1, scrap: 4 },
  },
  {
    // Original Signature Apex Predator: The Hollow Stalker
    id: 'hollow_stalker',
    isMonster: true,
    maxHealth: 140,
    attackDamage: 30,
    patrolSpeed: 1.85,
    investigateSpeed: 2.65,
    chaseSpeed: 5.4,
    spawnX: -8.2,
    spawnZ: -38.5,
    spawnYaw: 0.45,
    waypoints: [
      [-8.2, -38.5],
      [7.8, -36.0],
      [9.5, -26.5],
      [-8.2, -25.0],
      [-10.5, -34.0],
    ],
    nightWaypoints: [
      [-6.8, -28.0],
      [4.8, -21.5],
      [5.2, -10.5],
      [-4.2, -12.8],
      [-7.5, -33.0],
    ],
    dropLoot: { rations: 2, medkits: 2, scrap: 5 },
  },
];

function lerpAngle(current: number, target: number, alpha: number): number {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return current + diff * alpha;
}

function findUniqueClip(
  clips: readonly THREE.AnimationClip[],
  exactName: string,
  used: Set<THREE.AnimationClip>,
  allowSubstringFallback = false,
  excludeSubstrings: readonly string[] = [],
): THREE.AnimationClip | null {
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    if (clip && !used.has(clip) && clip.name.toLowerCase() === exactName) {
      used.add(clip);
      return clip;
    }
  }
  if (allowSubstringFallback) {
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      if (!clip || used.has(clip)) {
        continue;
      }
      const lower = clip.name.toLowerCase();
      if (!lower.includes(exactName)) {
        continue;
      }
      let excluded = false;
      for (let j = 0; j < excludeSubstrings.length; j += 1) {
        const bad = excludeSubstrings[j];
        if (bad && lower.includes(bad)) {
          excluded = true;
          break;
        }
      }
      if (!excluded) {
        used.add(clip);
        return clip;
      }
    }
  }
  return null;
}

function createStatusTexture(symbol: '?' | '!', strokeHex: string, glowRgba: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size * 0.5;
    const cy = size * 0.5;

    const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 52);
    grad.addColorStop(0, glowRgba);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, 34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 16, 13, 0.78)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = strokeHex;
    ctx.stroke();

    ctx.font = '700 46px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = strokeHex;
    ctx.fillText(symbol, cx, cy + 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function disposeObjectTree(
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

  for (const s of skeletons) {
    s.dispose();
  }
  for (const t of textures) {
    t.dispose();
  }
  for (const g of geometries) {
    g.dispose();
  }
  for (const m of materials) {
    m.dispose();
  }
}

function buildProceduralRaiderRig(
  coatMat: THREE.MeshStandardMaterial,
  scarfMat: THREE.MeshStandardMaterial,
  pantsMat: THREE.MeshStandardMaterial,
  bootMat: THREE.MeshStandardMaterial,
  skinMat: THREE.MeshStandardMaterial,
  weaponMat: THREE.MeshStandardMaterial,
): ProceduralRaiderRig {
  const root = new THREE.Group();

  const torso = new THREE.Group();
  torso.position.set(0, 0.96, 0);
  root.add(torso);

  // Tattered dark hooded coat & shoulder mantle
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.56, 0.26), coatMat);
  chest.position.set(0, 0.24, 0);
  chest.castShadow = true;
  chest.receiveShadow = true;
  torso.add(chest);

  const mantle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 0.26, 8), coatMat);
  mantle.position.set(0, 0.44, 0);
  mantle.castShadow = true;
  torso.add(mantle);

  // Faded crimson scavenger bandanna/scarf around neck
  const scarf = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.14, 10), scarfMat);
  scarf.position.set(0, 0.54, 0);
  torso.add(scarf);

  // Hooded head silhouette
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 10), skinMat);
  head.position.set(0, 0.68, -0.01);
  head.castShadow = true;
  torso.add(head);

  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.24, 10), coatMat);
  hood.position.set(0, 0.7, 0.025);
  hood.rotation.x = 0.12;
  hood.castShadow = true;
  torso.add(hood);

  // Articulated arms + rusted steel pipe in right hand
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.27, 0.46, 0);
  torso.add(leftArm);
  const leftArmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.58, 8), coatMat);
  leftArmMesh.position.set(0, -0.26, 0);
  leftArmMesh.castShadow = true;
  leftArm.add(leftArmMesh);

  const rightArm = new THREE.Group();
  rightArm.position.set(0.27, 0.46, 0);
  torso.add(rightArm);
  const rightArmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.58, 8), coatMat);
  rightArmMesh.position.set(0, -0.26, 0);
  rightArmMesh.castShadow = true;
  rightArm.add(rightArmMesh);

  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.78, 8), weaponMat);
  pipe.position.set(0.02, -0.52, -0.24);
  pipe.rotation.x = Math.PI * 0.42;
  pipe.castShadow = true;
  rightArm.add(pipe);

  // Articulated legs + heavy boots grounded cleanly at y = 0
  const buildLeg = (offsetX: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(offsetX, 0.94, 0);
    root.add(leg);

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.068, 0.8, 8), pantsMat);
    upper.position.set(0, -0.4, 0);
    upper.castShadow = true;
    upper.receiveShadow = true;
    leg.add(upper);

    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.14, 0.24), bootMat);
    boot.position.set(0, -0.87, -0.04);
    boot.castShadow = true;
    leg.add(boot);
    return leg;
  };

  const leftLeg = buildLeg(-0.115);
  const rightLeg = buildLeg(0.115);

  return { root, torso, leftLeg, rightLeg, leftArm, rightArm };
}

/**
 * Procedural gnarled dark-bark & antlered Hollow Stalker fallback rig used seamlessly
 * until public/assets/hollow_stalker.glb finishes loading.
 */
function buildProceduralStalkerRig(
  barkMat: THREE.MeshStandardMaterial,
  antlerMat: THREE.MeshStandardMaterial,
): ProceduralRaiderRig {
  const root = new THREE.Group();

  const torso = new THREE.Group();
  torso.position.set(0, 1.06, 0);
  root.add(torso);

  // Gaunt, hunched dark-bark thoracic frame & jagged dorsal spines
  const ribcage = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.14, 0.66, 7), barkMat);
  ribcage.position.set(0, 0.3, -0.02);
  ribcage.rotation.x = 0.16;
  ribcage.castShadow = true;
  ribcage.receiveShadow = true;
  torso.add(ribcage);

  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.2, 0.24), barkMat);
  shoulders.position.set(0, 0.56, -0.04);
  shoulders.castShadow = true;
  torso.add(shoulders);

  // Hollow stag-skull / bark mask head + asymmetric branching forest antlers
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 6), antlerMat);
  head.position.set(0, 0.8, -0.1);
  head.rotation.x = -Math.PI * 0.42;
  head.castShadow = true;
  torso.add(head);

  for (const side of [-1, 1] as const) {
    const mainAntler = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.032, 0.58, 5), antlerMat);
    mainAntler.position.set(side * 0.16, 1.04, -0.02);
    mainAntler.rotation.set(-0.22, 0, -side * 0.48);
    mainAntler.castShadow = true;
    torso.add(mainAntler);

    const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.02, 0.28, 5), antlerMat);
    tine.position.set(side * 0.28, 1.16, -0.06);
    tine.rotation.set(0.35, 0, -side * 0.2);
    torso.add(tine);
  }

  // Elongated clawed limbs
  const makeClawArm = (side: -1 | 1): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.31, 0.54, -0.04);
    torso.add(arm);

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.038, 0.84, 6), barkMat);
    upper.position.set(0, -0.4, 0);
    upper.castShadow = true;
    arm.add(upper);

    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.22, 5), antlerMat);
    claw.position.set(0, -0.88, -0.04);
    claw.rotation.x = Math.PI + 0.25;
    arm.add(claw);
    return arm;
  };

  const leftArm = makeClawArm(-1);
  const rightArm = makeClawArm(1);

  const makeStalkerLeg = (offsetX: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(offsetX, 1.04, 0);
    root.add(leg);

    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.048, 0.54, 6), barkMat);
    thigh.position.set(0, -0.26, -0.03);
    thigh.rotation.x = 0.12;
    thigh.castShadow = true;
    leg.add(thigh);

    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.032, 0.54, 6), barkMat);
    shin.position.set(0, -0.76, 0.02);
    shin.rotation.x = -0.14;
    shin.castShadow = true;
    leg.add(shin);

    return leg;
  };

  const leftLeg = makeStalkerLeg(-0.13);
  const rightLeg = makeStalkerLeg(0.13);

  return { root, torso, leftLeg, rightLeg, leftArm, rightArm };
}

/**
 * Manages patrolling hostile scavenger raiders and The Hollow Stalker apex predator
 * (vision cones, LOS occlusion, acoustic hearing, flashlight recoil, melee & stealth combat)
 * plus a zero-allocation throwable distraction bottle pool.
 */
export function createThreatSystem(options: ThreatSystemOptions): ThreatSystem {
  const { obstacles, onPlayerHit, onBottleShatter, onAlertSting, onStalkerSound } = options;

  const root = new THREE.Group();
  const atlas = getWorldTextureAtlas();

  // Shared materials for procedural fallback raiders & bottle pool (never disposed per-actor)
  const coatMat = new THREE.MeshStandardMaterial({
    map: atlas.fabricOlive.map,
    normalMap: atlas.fabricOlive.normalMap,
    color: 0x3b3d38,
    roughness: 0.94,
    metalness: 0.05,
  });
  const scarfMat = new THREE.MeshStandardMaterial({
    color: 0x7b2d24,
    roughness: 0.9,
    metalness: 0.02,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: 0x262825,
    roughness: 0.92,
    metalness: 0.04,
  });
  const bootMat = new THREE.MeshStandardMaterial({
    color: 0x1a1714,
    roughness: 0.88,
    metalness: 0.08,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0x7a6554,
    roughness: 0.82,
    metalness: 0.02,
  });
  const weaponMat = new THREE.MeshStandardMaterial({
    map: atlas.rustDark.map,
    normalMap: atlas.rustDark.normalMap,
    color: 0x6b4f41,
    roughness: 0.72,
    metalness: 0.55,
  });
  const bottleMat = new THREE.MeshStandardMaterial({
    color: 0x4b7748,
    roughness: 0.2,
    metalness: 0.16,
    transparent: true,
    opacity: 0.86,
  });
  const stalkerBarkMat = new THREE.MeshStandardMaterial({
    map: atlas.pineBark.map,
    normalMap: atlas.pineBark.normalMap,
    color: 0x3b352e,
    roughness: 0.94,
    metalness: 0.04,
  });
  const stalkerAntlerMat = new THREE.MeshStandardMaterial({
    color: 0x6f6556,
    roughness: 0.86,
    metalness: 0.05,
  });
  const stalkerEyeMat = new THREE.MeshBasicMaterial({
    color: 0xffa634,
  });

  const sharedProceduralMaterials = new Set<THREE.Material>([
    coatMat,
    scarfMat,
    pantsMat,
    bootMat,
    skinMat,
    weaponMat,
    bottleMat,
    stalkerBarkMat,
    stalkerAntlerMat,
    stalkerEyeMat,
  ]);

  const questionTex = createStatusTexture('?', '#e8b354', 'rgba(232, 179, 84, 0.36)');
  const alertTex = createStatusTexture('!', '#e54f44', 'rgba(229, 79, 68, 0.44)');

  let disposed = false;
  let globalAlert: GlobalAlertLevel = 'unaware';

  const actors: RaiderActor[] = [];

  for (let i = 0; i < RAIDER_SPECS.length; i += 1) {
    const spec = RAIDER_SPECS[i];
    if (!spec) {
      continue;
    }
    const actorRoot = new THREE.Group();
    const startY = getTerrainHeight(spec.spawnX, spec.spawnZ);
    actorRoot.position.set(spec.spawnX, startY, spec.spawnZ);
    actorRoot.rotation.y = spec.spawnYaw;

    const visualPivot = new THREE.Group();
    actorRoot.add(visualPivot);

    const proceduralRig = spec.isMonster
      ? buildProceduralStalkerRig(stalkerBarkMat, stalkerAntlerMat)
      : buildProceduralRaiderRig(coatMat, scarfMat, pantsMat, bootMat, skinMat, weaponMat);
    visualPivot.add(proceduralRig.root);

    // Eerie glowing amber eye embers on The Hollow Stalker visible through nighttime mist
    let eyeEmberGroup: THREE.Group | null = null;
    if (spec.isMonster) {
      eyeEmberGroup = new THREE.Group();
      eyeEmberGroup.position.set(0, 1.88, -0.17);
      const eyeGeo = new THREE.SphereGeometry(0.025, 8, 8);
      for (const side of [-1, 1] as const) {
        const ember = new THREE.Mesh(eyeGeo, stalkerEyeMat);
        ember.position.set(side * 0.058, 0, 0);
        ember.userData['excludeFromGtao'] = true;
        eyeEmberGroup.add(ember);
      }
      visualPivot.add(eyeEmberGroup);
    }

    const statusMat = new THREE.SpriteMaterial({
      map: questionTex,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const statusSprite = new THREE.Sprite(statusMat);
    statusSprite.position.set(0, spec.isMonster ? 2.48 : 2.22, 0);
    statusSprite.scale.set(0.44, 0.44, 1);
    statusSprite.visible = false;
    statusSprite.renderOrder = 20;
    statusSprite.userData['excludeFromGtao'] = true;
    actorRoot.add(statusSprite);

    root.add(actorRoot);
    actors.push({
      spec,
      root: actorRoot,
      visualPivot,
      proceduralRig,
      glbRig: null,
      eyeEmberGroup,
      statusSprite,
      statusMat,
      x: spec.spawnX,
      y: startY,
      z: spec.spawnZ,
      yaw: spec.spawnYaw,
      speed: 0,
      hp: spec.maxHealth,
      state: 'patrol',
      awareness: 0,
      waypointIndex: 1 % spec.waypoints.length,
      waypointPause: 1.0 + i * 0.7,
      investigateX: spec.spawnX,
      investigateZ: spec.spawnZ,
      investigateTimer: 0,
      loseSightTimer: 0,
      attackCooldown: 0,
      attackSwingTimer: 0,
      attackHitDelivered: false,
      staggerTimer: 0,
      staggerVelX: 0,
      staggerVelZ: 0,
      recoilCooldown: 0,
      fireFleeTimer: 0,
      fireFleeX: 0,
      fireFleeZ: 0,
      fireRecoilCooldown: 0,
      prowlSoundCooldown: 4.5,
      shriekCooldown: 0,
      downProgress: 0,
      stridePhase: i * 1.9,
      blockedTimer: 0,
    });
  }

  // Reusable async GLB loader for human raiders ('raider') and Hollow Stalker ('hollow_stalker')
  const loadGlbForMatchingActors = (slot: string, matchMonster: boolean): void => {
    void loadOptionalGlbAsset(slot).then((loaded) => {
      if (!loaded) {
        return;
      }
      if (disposed) {
        disposeObjectTree(loaded.scene);
        return;
      }

      const matchingActors = actors.filter((a) => a.spec.isMonster === matchMonster);
      if (matchingActors.length === 0) {
        disposeObjectTree(loaded.scene);
        return;
      }

      const clips = loaded.animations;
      const usedClips = new Set<THREE.AnimationClip>();
      const idleClip = findUniqueClip(clips, 'idle', usedClips, true, ['crouch']);
      const walkClip = findUniqueClip(clips, 'walk', usedClips, true, ['crouch', 'back', 'strafe']);
      const jogClip = findUniqueClip(clips, 'jog', usedClips, true, ['crouch', 'back', 'strafe']);
      const runClip = findUniqueClip(clips, 'run', usedClips, true, ['crouch', 'back', 'strafe']);
      const attackClip = findUniqueClip(clips, 'attack', usedClips, true);
      const hitClip = findUniqueClip(clips, 'hit', usedClips, true);
      const deathClip = findUniqueClip(clips, 'death', usedClips, true);
      const resolvedIdleClip = idleClip ?? clips.find((c) => !usedClips.has(c)) ?? null;

      // Iterate in reverse so SkeletonUtils.clone copies the untouched bind-pose scene before index 0 uses it
      for (let i = matchingActors.length - 1; i >= 0; i -= 1) {
        const actor = matchingActors[i];
        if (!actor) {
          continue;
        }

        const instanceScene = i === 0 ? loaded.scene : SkeletonUtils.clone(loaded.scene);
        instanceScene.traverse((node: THREE.Object3D) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            if (node instanceof THREE.SkinnedMesh) {
              node.frustumCulled = false;
            }
          }
        });

        const wrapper = new THREE.Group();
        // Convert glTF +Z forward into Three.js -Z forward convention
        wrapper.rotation.y = Math.PI;
        wrapper.add(instanceScene);

        const mixer = new THREE.AnimationMixer(instanceScene);

        const setupLoop = (
          clip: THREE.AnimationClip | null,
          weight: number,
        ): THREE.AnimationAction | null => {
          if (!clip) {
            return null;
          }
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.setEffectiveWeight(weight);
          action.play();
          return action;
        };

        const setupOneShot = (clip: THREE.AnimationClip | null): THREE.AnimationAction | null => {
          if (!clip) {
            return null;
          }
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          action.setEffectiveWeight(0);
          return action;
        };

        const idleAction = setupLoop(resolvedIdleClip, 1);
        const walkAction = setupLoop(walkClip, 0);
        const jogAction = setupLoop(jogClip, 0);
        const runAction = setupLoop(runClip, 0);
        const attackAction = setupOneShot(attackClip);
        const hitAction = setupOneShot(hitClip);
        const deathAction = setupOneShot(deathClip);

        mixer.update(0);
        wrapper.updateMatrixWorld(true);

        const bounds = new THREE.Box3().setFromObject(wrapper);
        if (Number.isFinite(bounds.min.y) && Math.abs(bounds.min.y) > 0.004) {
          wrapper.position.y = -bounds.min.y;
        }
        wrapper.updateMatrixWorld(true);

        if (actor.eyeEmberGroup) {
          const headBone = instanceScene.getObjectByName('head');
          if (headBone) {
            const headWorldPos = new THREE.Vector3();
            const headWorldScale = new THREE.Vector3(1, 1, 1);
            headBone.getWorldPosition(headWorldPos);
            headBone.getWorldScale(headWorldScale);

            const eyeY = headWorldPos.y + 0.075;
            const eyeZ = headWorldPos.z - 0.12;
            const leftLocal = headBone.worldToLocal(
              new THREE.Vector3(headWorldPos.x - 0.048, eyeY, eyeZ),
            );
            const rightLocal = headBone.worldToLocal(
              new THREE.Vector3(headWorldPos.x + 0.048, eyeY, eyeZ),
            );

            actor.eyeEmberGroup.removeFromParent();
            actor.eyeEmberGroup.position.set(0, 0, 0);
            actor.eyeEmberGroup.rotation.set(0, 0, 0);
            const invScale =
              Number.isFinite(headWorldScale.x) && headWorldScale.x > 1e-4
                ? 1 / headWorldScale.x
                : 1;
            const leftMesh = actor.eyeEmberGroup.children[0];
            const rightMesh = actor.eyeEmberGroup.children[1];
            if (leftMesh) {
              leftMesh.position.copy(leftLocal);
              leftMesh.scale.setScalar(invScale);
            }
            if (rightMesh) {
              rightMesh.position.copy(rightLocal);
              rightMesh.scale.setScalar(invScale);
            }
            headBone.add(actor.eyeEmberGroup);
          } else if (Number.isFinite(bounds.max.y) && Number.isFinite(bounds.min.y)) {
            const modelHeight = Math.max(1.5, bounds.max.y - bounds.min.y);
            actor.eyeEmberGroup.position.set(0, clamp(modelHeight * 0.87, 1.55, 2.08), -0.17);
          }
        }

        if (actor.proceduralRig) {
          actor.visualPivot.remove(actor.proceduralRig.root);
          disposeObjectTree(actor.proceduralRig.root, sharedProceduralMaterials);
          actor.proceduralRig = null;
        }

        let initIdleWeight = 1;
        let initDeathWeight = 0;
        if (actor.state === 'downed' && deathAction) {
          // Clear procedural tip-over transform and pose directly at the final frame of MoCap death
          actor.visualPivot.rotation.set(0, 0, 0);
          actor.visualPivot.position.set(0, 0, 0);
          initIdleWeight = 0;
          initDeathWeight = 1;
          if (idleAction) {
            idleAction.setEffectiveWeight(0);
          }
          deathAction.reset();
          deathAction.setLoop(THREE.LoopOnce, 1);
          deathAction.clampWhenFinished = true;
          deathAction.setEffectiveWeight(1);
          deathAction.time = deathAction.getClip().duration;
          deathAction.play();
          mixer.update(0);
        }

        actor.visualPivot.add(wrapper);
        actor.glbRig = {
          wrapper,
          scene: instanceScene,
          mixer,
          idleAction,
          walkAction,
          jogAction,
          runAction,
          attackAction,
          hitAction,
          deathAction,
          wIdle: initIdleWeight,
          wWalk: 0,
          wJog: 0,
          wRun: 0,
          wAttack: 0,
          wHit: 0,
          wDeath: initDeathWeight,
        };
      }
    });
  };

  loadGlbForMatchingActors('raider', false);
  loadGlbForMatchingActors('hollow_stalker', true);

  // Pre-allocated throwable bottle & glass-shatter particle burst pools (ZERO per-frame allocations!)
  const bottleGeo = new THREE.CylinderGeometry(0.036, 0.044, 0.25, 8);
  const bottles: PooledBottle[] = [];
  const shatterBursts: ShatterBurst[] = [];

  for (let i = 0; i < BOTTLE_POOL_SIZE; i += 1) {
    const mesh = new THREE.Mesh(bottleGeo, bottleMat);
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.userData['excludeFromGtao'] = true;
    root.add(mesh);
    bottles.push({
      mesh,
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
    });

    const positions = new Float32Array(SHATTER_PARTICLE_COUNT * 3);
    const velocities = new Float32Array(SHATTER_PARTICLE_COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xb7dfaf,
      size: 0.085,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    points.userData['excludeFromGtao'] = true;
    root.add(points);
    shatterBursts.push({
      points,
      geometry,
      material,
      positions,
      velocities,
      active: false,
      age: 0,
    });
  }

  let nextBottleSlot = 0;
  let nextBurstSlot = 0;

  // Pre-allocated scratch structs (ZERO per-frame allocations!)
  const scratchMovePos: Vec2Like = { x: 0, z: 0 };
  const scratchBottlePos: Vec2Like = { x: 0, z: 0 };
  const scratchFirePos: Vec2Like = { x: 0, z: 0 };

  function spawnShatterBurst(x: number, y: number, z: number): void {
    const burst = shatterBursts[nextBurstSlot];
    nextBurstSlot = (nextBurstSlot + 1) % shatterBursts.length;
    if (!burst) {
      return;
    }
    for (let p = 0; p < SHATTER_PARTICLE_COUNT; p += 1) {
      const idx = p * 3;
      burst.positions[idx] = x;
      burst.positions[idx + 1] = y + 0.06;
      burst.positions[idx + 2] = z;

      const angle = (p / SHATTER_PARTICLE_COUNT) * Math.PI * 2 + (p % 3) * 0.31;
      const horiz = 1.4 + ((p * 37) % 10) * 0.24;
      burst.velocities[idx] = Math.cos(angle) * horiz;
      burst.velocities[idx + 1] = 2.0 + ((p * 17) % 7) * 0.36;
      burst.velocities[idx + 2] = Math.sin(angle) * horiz;
    }
    const attr = burst.geometry.getAttribute('position');
    if (attr instanceof THREE.BufferAttribute) {
      attr.needsUpdate = true;
    }
    burst.active = true;
    burst.age = 0;
    burst.material.opacity = 0.92;
    burst.points.visible = true;
  }

  function emitNoise(x: number, z: number, radius: number): void {
    if (radius <= 0) {
      return;
    }
    let triggeredSuspicious = false;

    for (let i = 0; i < actors.length; i += 1) {
      const actor = actors[i];
      if (!actor || actor.state === 'downed') {
        continue;
      }
      // The Hollow Stalker has 1.25x sharper nocturnal hearing for footsteps and shattered glass
      const effectiveRadius = actor.spec.isMonster ? radius * 1.25 : radius;
      const dx = x - actor.x;
      const dz = z - actor.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > effectiveRadius * effectiveRadius) {
        continue;
      }

      // Active combatants already seeing the player stay locked; otherwise draw toward noise
      if (actor.state === 'chase' || actor.state === 'attack') {
        if (actor.loseSightTimer < 4.5) {
          actor.investigateX = x;
          actor.investigateZ = z;
        }
        continue;
      }

      const prevState = actor.state;
      actor.investigateX = x;
      actor.investigateZ = z;
      actor.investigateTimer = 8.0;
      actor.awareness = Math.max(actor.awareness, 0.58);
      actor.state = 'investigate';
      if (prevState === 'patrol') {
        triggeredSuspicious = true;
      }
    }

    if (triggeredSuspicious && globalAlert === 'unaware') {
      globalAlert = 'suspicious';
      if (onAlertSting) {
        onAlertSting('suspicious');
      }
    }
  }

  function throwBottle(
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): boolean {
    const bottle = bottles[nextBottleSlot];
    nextBottleSlot = (nextBottleSlot + 1) % bottles.length;
    if (!bottle) {
      return false;
    }
    const len = Math.hypot(dirX, dirY, dirZ);
    const invLen = len > 1e-5 ? 1 / len : 1;
    const nx = dirX * invLen;
    const ny = clamp(dirY * invLen + 0.24, -0.1, 0.72);
    const nz = dirZ * invLen;
    const arcInv = 1 / Math.hypot(nx, ny, nz);

    bottle.active = true;
    bottle.age = 0;
    bottle.x = originX;
    bottle.y = originY;
    bottle.z = originZ;
    bottle.vx = nx * arcInv * BOTTLE_SPEED;
    bottle.vy = ny * arcInv * BOTTLE_SPEED;
    bottle.vz = nz * arcInv * BOTTLE_SPEED;
    bottle.mesh.position.set(originX, originY, originZ);
    bottle.mesh.rotation.set(0.3, 0, 0);
    bottle.mesh.visible = true;
    return true;
  }

  function tryPlayerMeleeHit(
    playerX: number,
    playerZ: number,
    forwardX: number,
    forwardZ: number,
    playerCrouching: boolean,
  ): PlayerMeleeHitResult {
    let bestActor: RaiderActor | null = null;
    let bestDistSq = PLAYER_MELEE_RANGE * PLAYER_MELEE_RANGE;

    for (let i = 0; i < actors.length; i += 1) {
      const actor = actors[i];
      if (!actor || actor.state === 'downed') {
        continue;
      }
      const dx = actor.x - playerX;
      const dz = actor.z - playerZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestDistSq) {
        continue;
      }
      const dist = Math.sqrt(distSq);
      if (dist > 0.65) {
        const dot = (dx * forwardX + dz * forwardZ) / dist;
        if (dot < 0.3) {
          continue;
        }
      }
      bestDistSq = distSq;
      bestActor = actor;
    }

    if (!bestActor) {
      return {
        hit: false,
        stealthTakedown: false,
        downed: false,
        hitX: playerX,
        hitZ: playerZ,
      };
    }

    const toPlayerX = playerX - bestActor.x;
    const toPlayerZ = playerZ - bestActor.z;
    const toPlayerDist = Math.hypot(toPlayerX, toPlayerZ);
    const raiderFwdX = -Math.sin(bestActor.yaw);
    const raiderFwdZ = -Math.cos(bestActor.yaw);
    const dotFromRaiderFront =
      toPlayerDist > 1e-4 ? (toPlayerX * raiderFwdX + toPlayerZ * raiderFwdZ) / toPlayerDist : 1;

    const raiderUnaware =
      bestActor.state === 'patrol' ||
      bestActor.state === 'suspicious' ||
      bestActor.state === 'investigate';
    const isBehindRaider = dotFromRaiderFront < 0.15;
    const stealthTakedown = raiderUnaware && (playerCrouching || isBehindRaider);

    const damage = stealthTakedown
      ? bestActor.spec.isMonster
        ? STALKER_STEALTH_AMBUSH_DAMAGE
        : bestActor.spec.maxHealth
      : PLAYER_MELEE_DAMAGE;
    bestActor.hp = Math.max(0, bestActor.hp - damage);

    if (bestActor.hp <= 0) {
      bestActor.state = 'downed';
      bestActor.awareness = 0;
      bestActor.speed = 0;
      bestActor.statusSprite.visible = false;
      if (bestActor.eyeEmberGroup) {
        bestActor.eyeEmberGroup.visible = false;
      }
      if (bestActor.glbRig?.deathAction) {
        bestActor.glbRig.deathAction.reset();
        bestActor.glbRig.deathAction.setLoop(THREE.LoopOnce, 1);
        bestActor.glbRig.deathAction.clampWhenFinished = true;
        bestActor.glbRig.deathAction.timeScale = 1.15;
        bestActor.glbRig.deathAction.play();
      }
      return {
        hit: true,
        stealthTakedown,
        downed: true,
        isMonster: bestActor.spec.isMonster,
        lootDropped: bestActor.spec.dropLoot,
        hitX: bestActor.x,
        hitZ: bestActor.z,
      };
    }

    // Surviving threat staggers back briefly (interrupting any active swing) and alerts to chase
    const knockX = toPlayerDist > 1e-4 ? -toPlayerX / toPlayerDist : forwardX;
    const knockZ = toPlayerDist > 1e-4 ? -toPlayerZ / toPlayerDist : forwardZ;
    bestActor.staggerTimer = 0.42;
    bestActor.attackSwingTimer = 0;
    bestActor.attackHitDelivered = true;
    bestActor.staggerVelX = knockX * 2.4;
    bestActor.staggerVelZ = knockZ * 2.4;
    if (bestActor.glbRig) {
      bestActor.glbRig.wAttack = 0;
      if (bestActor.glbRig.attackAction) {
        bestActor.glbRig.attackAction.stop();
        bestActor.glbRig.attackAction.setEffectiveWeight(0);
      }
      if (bestActor.glbRig.hitAction) {
        bestActor.glbRig.hitAction.reset();
        bestActor.glbRig.hitAction.setLoop(THREE.LoopOnce, 1);
        bestActor.glbRig.hitAction.clampWhenFinished = true;
        bestActor.glbRig.hitAction.timeScale = 1.05;
        bestActor.glbRig.hitAction.play();
      }
    }
    bestActor.awareness = 1;
    bestActor.investigateX = playerX;
    bestActor.investigateZ = playerZ;
    bestActor.loseSightTimer = 6.0;
    const wasAlert = bestActor.state === 'chase' || bestActor.state === 'attack';
    bestActor.state = 'chase';
    if (!wasAlert && bestActor.spec.isMonster && bestActor.shriekCooldown <= 0) {
      bestActor.shriekCooldown = 14;
      if (onStalkerSound) {
        onStalkerSound('shriek');
      }
    }
    if (!wasAlert && globalAlert !== 'alert') {
      globalAlert = 'alert';
      if (onAlertSting) {
        onAlertSting('alert');
      }
    }

    return {
      hit: true,
      stealthTakedown,
      downed: false,
      isMonster: bestActor.spec.isMonster,
      hitX: bestActor.x,
      hitZ: bestActor.z,
    };
  }

  function updateRaiderAnimation(actor: RaiderActor, dt: number, elapsed: number): void {
    // Handle downed state: play full MoCap death collapse clip when available, or tip-over fallback
    if (actor.state === 'downed') {
      const glbRig = actor.glbRig;
      const deathAction = glbRig ? glbRig.deathAction : null;
      if (glbRig && deathAction) {
        const fade = 1 - Math.exp(-14 * dt);
        glbRig.wDeath += (1 - glbRig.wDeath) * fade;
        const locoScale = Math.max(0, 1 - glbRig.wDeath);
        if (glbRig.idleAction) glbRig.idleAction.setEffectiveWeight(glbRig.wIdle * locoScale);
        if (glbRig.walkAction) glbRig.walkAction.setEffectiveWeight(glbRig.wWalk * locoScale);
        if (glbRig.jogAction) glbRig.jogAction.setEffectiveWeight(glbRig.wJog * locoScale);
        if (glbRig.runAction) glbRig.runAction.setEffectiveWeight(glbRig.wRun * locoScale);
        if (glbRig.attackAction) glbRig.attackAction.setEffectiveWeight(0);
        if (glbRig.hitAction) glbRig.hitAction.setEffectiveWeight(0);
        deathAction.setEffectiveWeight(glbRig.wDeath);
        glbRig.mixer.update(dt);
        return;
      }

      actor.downProgress = Math.min(1, actor.downProgress + dt * 2.6);
      const ease = 1 - (1 - actor.downProgress) * (1 - actor.downProgress);
      actor.visualPivot.rotation.x = -Math.PI * 0.48 * ease;
      actor.visualPivot.position.y = 0.14 * ease;

      if (actor.glbRig) {
        actor.glbRig.wIdle *= Math.max(0, 1 - dt * 5);
        actor.glbRig.wWalk *= Math.max(0, 1 - dt * 5);
        actor.glbRig.wJog *= Math.max(0, 1 - dt * 5);
        actor.glbRig.wRun *= Math.max(0, 1 - dt * 5);
        actor.glbRig.wAttack *= Math.max(0, 1 - dt * 5);
        if (actor.glbRig.idleAction) actor.glbRig.idleAction.setEffectiveWeight(actor.glbRig.wIdle);
        if (actor.glbRig.walkAction) actor.glbRig.walkAction.setEffectiveWeight(actor.glbRig.wWalk);
        if (actor.glbRig.jogAction) actor.glbRig.jogAction.setEffectiveWeight(actor.glbRig.wJog);
        if (actor.glbRig.runAction) actor.glbRig.runAction.setEffectiveWeight(actor.glbRig.wRun);
        if (actor.glbRig.attackAction) {
          actor.glbRig.attackAction.setEffectiveWeight(actor.glbRig.wAttack);
        }
        actor.glbRig.mixer.update(dt * 0.4);
      }
      return;
    }

    actor.visualPivot.rotation.x = 0;
    actor.visualPivot.position.y = 0;

    if (actor.glbRig) {
      const rig = actor.glbRig;
      const s = actor.speed;

      let tIdle = 0;
      let tWalk = 0;
      let tJog = 0;
      let tRun = 0;

      if (s <= 1.65) {
        const u = clamp(s / 1.65, 0, 1);
        tIdle = 1 - u;
        tWalk = u;
      } else if (rig.jogAction) {
        if (s <= 3.4) {
          const u = clamp((s - 1.65) / (3.4 - 1.65), 0, 1);
          tWalk = 1 - u;
          tJog = u;
        } else {
          const u = clamp((s - 3.4) / (5.2 - 3.4), 0, 1);
          tJog = 1 - u;
          tRun = u;
        }
      } else {
        const u = clamp((s - 1.65) / (5.2 - 1.65), 0, 1);
        tWalk = 1 - u;
        tRun = u;
      }

      if (!rig.walkAction) {
        tIdle += tWalk;
        tWalk = 0;
      }
      if (!rig.jogAction) {
        if (rig.walkAction) tWalk += tJog;
        else tIdle += tJog;
        tJog = 0;
      }
      if (!rig.runAction) {
        if (rig.jogAction) tJog += tRun;
        else if (rig.walkAction) tWalk += tRun;
        else tIdle += tRun;
        tRun = 0;
      }

      const alpha = 1 - Math.exp(-9 * dt);
      rig.wIdle += (tIdle - rig.wIdle) * alpha;
      rig.wWalk += (tWalk - rig.wWalk) * alpha;
      rig.wJog += (tJog - rig.wJog) * alpha;
      rig.wRun += (tRun - rig.wRun) * alpha;

      const sum = rig.wIdle + rig.wWalk + rig.wJog + rig.wRun;
      if (sum > 1e-5) {
        const inv = 1 / sum;
        rig.wIdle *= inv;
        rig.wWalk *= inv;
        rig.wJog *= inv;
        rig.wRun *= inv;
      } else {
        rig.wIdle = 1;
      }

      const targetAtk = rig.attackAction && actor.attackSwingTimer > 0 ? 1 : 0;
      const atkAlpha = 1 - Math.exp(-16 * dt);
      rig.wAttack += (targetAtk - rig.wAttack) * atkAlpha;
      if (rig.wAttack < 0.001 && targetAtk === 0) {
        rig.wAttack = 0;
      }

      const targetHit = rig.hitAction && actor.staggerTimer > 0 ? 1 : 0;
      const hitAlpha = 1 - Math.exp(-22 * dt);
      rig.wHit += (targetHit - rig.wHit) * hitAlpha;
      if (rig.wHit < 0.001 && targetHit === 0) {
        rig.wHit = 0;
      }

      const overlaySum = rig.wAttack + rig.wHit;
      const effAtk = overlaySum > 1 ? rig.wAttack / overlaySum : rig.wAttack;
      const effHit = overlaySum > 1 ? rig.wHit / overlaySum : rig.wHit;
      const locoScale = Math.max(0, 1 - overlaySum);

      if (rig.idleAction) rig.idleAction.setEffectiveWeight(rig.wIdle * locoScale);
      if (rig.walkAction) {
        rig.walkAction.setEffectiveWeight(rig.wWalk * locoScale);
        rig.walkAction.timeScale = clamp(s / 1.67, 0.72, 1.3);
      }
      if (rig.jogAction) {
        rig.jogAction.setEffectiveWeight(rig.wJog * locoScale);
        rig.jogAction.timeScale = clamp(s / 3.6, 0.75, 1.25);
      }
      if (rig.runAction) {
        rig.runAction.setEffectiveWeight(rig.wRun * locoScale);
        rig.runAction.timeScale = clamp(s / 5.79, 0.8, 1.2);
      }
      if (rig.attackAction) {
        rig.attackAction.setEffectiveWeight(effAtk);
      }
      if (rig.hitAction) {
        rig.hitAction.setEffectiveWeight(effHit);
      }
      if (rig.deathAction) {
        rig.deathAction.setEffectiveWeight(0);
      }

      rig.mixer.update(dt);
      return;
    }

    // Procedural hooded-raider fallback animation
    if (actor.proceduralRig) {
      const pRig = actor.proceduralRig;
      if (actor.speed > 0.2) {
        actor.stridePhase += dt * (actor.speed > 3.2 ? 9.8 : 6.2);
      }
      const moveWeight = clamp(actor.speed / 2.2, 0, 1.2);
      const swing = Math.sin(actor.stridePhase) * moveWeight;
      pRig.leftLeg.rotation.x = swing * 0.52;
      pRig.rightLeg.rotation.x = -swing * 0.52;
      pRig.leftArm.rotation.x = -swing * 0.42 + 0.12;

      if (actor.attackSwingTimer > 0) {
        const swingU = 1 - clamp(actor.attackSwingTimer / 0.72, 0, 1);
        const strike = Math.sin(swingU * Math.PI);
        pRig.rightArm.rotation.x = 1.6 - strike * 2.2;
        pRig.torso.rotation.y = -0.25 + strike * 0.65;
      } else {
        pRig.rightArm.rotation.x = swing * 0.36 + 0.25;
        pRig.torso.rotation.y = -swing * 0.08 + Math.sin(elapsed * 1.4) * 0.03;
      }
    }
  }

  function update(dt: number, elapsed: number, input: ThreatsUpdateInput): void {
    const {
      playerX,
      playerZ,
      playerVisibility,
      playerNoiseRadius,
      playerDead,
      nightFactor = 0,
      rainIntensity = 0,
      flashlightOn = false,
      getFlashlightExposure,
      getFireRepel,
    } = input;
    const nocturnalHunt = nightFactor > 0.35 || rainIntensity > 0.4;

    // 1. Update pooled throwable distraction bottles & shatter bursts
    for (let i = 0; i < bottles.length; i += 1) {
      const b = bottles[i];
      if (!b || !b.active) {
        continue;
      }
      b.age += dt;
      b.vy -= BOTTLE_GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.mesh.position.set(b.x, b.y, b.z);
      b.mesh.rotation.x += dt * 9.5;
      b.mesh.rotation.z += dt * 6.2;

      const groundY = getTerrainHeight(b.x, b.z);
      scratchBottlePos.x = b.x;
      scratchBottlePos.z = b.z;
      const hitObstacle = resolveHorizontalCollision(scratchBottlePos, 0.14, obstacles);

      if (b.y <= groundY + 0.06 || hitObstacle || b.age > 3.5) {
        const hitX = hitObstacle ? scratchBottlePos.x : b.x;
        const hitZ = hitObstacle ? scratchBottlePos.z : b.z;
        const impactY = Math.max(getTerrainHeight(hitX, hitZ), b.y);
        b.active = false;
        b.mesh.visible = false;
        spawnShatterBurst(hitX, impactY, hitZ);
        emitNoise(hitX, hitZ, BOTTLE_NOISE_RADIUS);
        if (onBottleShatter) {
          onBottleShatter(hitX, hitZ);
        }
      }
    }

    for (let i = 0; i < shatterBursts.length; i += 1) {
      const burst = shatterBursts[i];
      if (!burst || !burst.active) {
        continue;
      }
      burst.age += dt;
      if (burst.age >= SHATTER_DURATION) {
        burst.active = false;
        burst.points.visible = false;
        burst.material.opacity = 0;
        continue;
      }
      for (let p = 0; p < SHATTER_PARTICLE_COUNT; p += 1) {
        const idx = p * 3;
        const vy = (burst.velocities[idx + 1] ?? 0) - 9.8 * dt;
        burst.velocities[idx + 1] = vy;
        burst.positions[idx] = (burst.positions[idx] ?? 0) + (burst.velocities[idx] ?? 0) * dt;
        burst.positions[idx + 1] = (burst.positions[idx + 1] ?? 0) + vy * dt;
        burst.positions[idx + 2] =
          (burst.positions[idx + 2] ?? 0) + (burst.velocities[idx + 2] ?? 0) * dt;
      }
      const attr = burst.geometry.getAttribute('position');
      if (attr instanceof THREE.BufferAttribute) {
        attr.needsUpdate = true;
      }
      burst.material.opacity = (1 - burst.age / SHATTER_DURATION) * 0.9;
    }

    // 2. Player movement sound hearing check
    if (!playerDead && playerNoiseRadius > 0.5) {
      emitNoise(playerX, playerZ, playerNoiseRadius);
    }

    // 3. Update each patrolling raider AI
    let highestAlert: GlobalAlertLevel = 'unaware';
    const prevGlobalAlert = globalAlert;

    for (let i = 0; i < actors.length; i += 1) {
      const actor = actors[i];
      if (!actor) {
        continue;
      }

      if (actor.state === 'downed') {
        updateRaiderAnimation(actor, dt, elapsed);
        continue;
      }

      if (actor.attackCooldown > 0) {
        actor.attackCooldown = Math.max(0, actor.attackCooldown - dt);
      }
      if (actor.attackSwingTimer > 0) {
        actor.attackSwingTimer = Math.max(0, actor.attackSwingTimer - dt);
      }
      if (actor.recoilCooldown > 0) {
        actor.recoilCooldown = Math.max(0, actor.recoilCooldown - dt);
      }
      if (actor.fireRecoilCooldown > 0) {
        actor.fireRecoilCooldown = Math.max(0, actor.fireRecoilCooldown - dt);
      }
      if (actor.fireFleeTimer > 0) {
        actor.fireFleeTimer = Math.max(0, actor.fireFleeTimer - dt);
      }
      if (actor.shriekCooldown > 0) {
        actor.shriekCooldown = Math.max(0, actor.shriekCooldown - dt);
      }

      // Stagger knockback recovery
      if (actor.staggerTimer > 0) {
        actor.staggerTimer = Math.max(0, actor.staggerTimer - dt);
        scratchMovePos.x = actor.x + actor.staggerVelX * dt;
        scratchMovePos.z = actor.z + actor.staggerVelZ * dt;
        resolveHorizontalCollision(scratchMovePos, RAIDER_RADIUS, obstacles);
        actor.x = scratchMovePos.x;
        actor.z = scratchMovePos.z;
        actor.staggerVelX *= Math.max(0, 1 - dt * 6);
        actor.staggerVelZ *= Math.max(0, 1 - dt * 6);
        actor.y = getTerrainHeight(actor.x, actor.z);
        actor.root.position.set(actor.x, actor.y, actor.z);
        actor.speed = 0;
        highestAlert = 'alert';
        updateRaiderAnimation(actor, dt, elapsed);
        continue;
      }

      // Vision perception, Hollow Stalker nocturnal instincts & flashlight recoil counterplay
      const dxToPlayer = playerX - actor.x;
      const dzToPlayer = playerZ - actor.z;
      const distToPlayer = Math.hypot(dxToPlayer, dzToPlayer);
      const visionRange = actor.spec.isMonster ? STALKER_VISION_RANGE : RAIDER_VISION_RANGE;
      const attackRange = actor.spec.isMonster ? STALKER_ATTACK_RANGE : RAIDER_ATTACK_RANGE;

      if (actor.spec.isMonster) {
        // Periodic eerie prowl wood-clicks while hunting within 28 m
        if (distToPlayer < 28 && !playerDead) {
          actor.prowlSoundCooldown -= dt;
          if (actor.prowlSoundCooldown <= 0) {
            actor.prowlSoundCooldown = actor.state === 'chase' ? 4.8 : 7.5 + ((i * 2.1) % 3.5);
            if (onStalkerSound) {
              onStalkerSound('prowl');
            }
          }
        }

        // Tactical flashlight beam blinds & recoils The Hollow Stalker briefly before it turns aggressive!
        if (
          flashlightOn &&
          getFlashlightExposure &&
          actor.recoilCooldown <= 0 &&
          !playerDead &&
          distToPlayer <= 16.0
        ) {
          const beamExposure = getFlashlightExposure(actor.x, actor.y + 1.55, actor.z);
          if (beamExposure > 0.52 && hasLineOfSight(playerX, playerZ, actor.x, actor.z, obstacles)) {
            actor.recoilCooldown = STALKER_FLASHLIGHT_RECOIL_COOLDOWN;
            actor.staggerTimer = 0.85;
            actor.attackSwingTimer = 0;
            actor.attackHitDelivered = true;
            const awayInv = distToPlayer > 1e-4 ? 1 / distToPlayer : 0;
            actor.staggerVelX = -dxToPlayer * awayInv * 1.9;
            actor.staggerVelZ = -dzToPlayer * awayInv * 1.9;
            actor.awareness = 1;
            actor.investigateX = playerX;
            actor.investigateZ = playerZ;
            actor.loseSightTimer = 7.0;
            actor.state = 'chase';
            if (actor.glbRig) {
              actor.glbRig.wAttack = 0;
              if (actor.glbRig.attackAction) {
                actor.glbRig.attackAction.stop();
                actor.glbRig.attackAction.setEffectiveWeight(0);
              }
              if (actor.glbRig.hitAction) {
                actor.glbRig.hitAction.reset();
                actor.glbRig.hitAction.setLoop(THREE.LoopOnce, 1);
                actor.glbRig.hitAction.clampWhenFinished = true;
                actor.glbRig.hitAction.timeScale = 0.88;
                actor.glbRig.hitAction.play();
              }
            }
            if (onStalkerSound) {
              onStalkerSound('recoil');
            }
            highestAlert = 'alert';
            updateRaiderAnimation(actor, dt, elapsed);
            continue;
          }
        }
      }

      let seesPlayer = false;

      if (!playerDead && distToPlayer <= visionRange) {
        const inCone = isPointInVisionCone(
          actor.x,
          actor.z,
          actor.yaw,
          playerX,
          playerZ,
          visionRange,
          RAIDER_VISION_HALF_FOV,
        );
        const closeExposed = distToPlayer < (actor.spec.isMonster ? 3.2 : 2.4) && playerVisibility > 0.55;
        if ((inCone || closeExposed) && hasLineOfSight(actor.x, actor.z, playerX, playerZ, obstacles)) {
          seesPlayer = true;
        }
      }

      if (seesPlayer) {
        const distFactor = clamp(1.35 - distToPlayer / visionRange, 0.25, 1.25);
        const fillRate = (0.55 + playerVisibility * 1.15) * distFactor * (actor.spec.isMonster ? 1.15 : 1);
        actor.awareness = clamp(actor.awareness + fillRate * dt, 0, 1);
        actor.investigateX = playerX;
        actor.investigateZ = playerZ;
        actor.loseSightTimer = actor.spec.isMonster ? 7.0 : 5.5;

        if (actor.awareness >= 1) {
          if (actor.state !== 'chase' && actor.state !== 'attack') {
            actor.state = 'chase';
            if (actor.spec.isMonster && actor.shriekCooldown <= 0) {
              actor.shriekCooldown = 14;
              if (onStalkerSound) {
                onStalkerSound('shriek');
              }
            }
          }
        } else if (actor.awareness >= 0.62) {
          if (actor.state === 'patrol' || actor.state === 'suspicious') {
            actor.state = 'investigate';
            actor.investigateTimer = 8.0;
          }
        } else if (actor.awareness >= 0.25 && actor.state === 'patrol') {
          actor.state = 'suspicious';
        }
      } else {
        if (actor.state === 'chase' || actor.state === 'attack') {
          actor.loseSightTimer -= dt;
          if (playerDead || actor.loseSightTimer <= 0) {
            actor.state = 'investigate';
            actor.investigateTimer = 8.0;
          }
        } else if (actor.state === 'suspicious') {
          actor.awareness = Math.max(0, actor.awareness - dt * 0.28);
          if (actor.awareness <= 0.04) {
            actor.awareness = 0;
            actor.state = 'patrol';
          }
        } else if (actor.state === 'investigate') {
          actor.awareness = Math.max(0.28, actor.awareness - dt * 0.14);
        } else {
          actor.awareness = Math.max(0, actor.awareness - dt * 0.25);
        }
      }

      // Movement & action execution per AI state
      let desiredMoveX = 0;
      let desiredMoveZ = 0;
      let moveSpeed = 0;

      // Campfire flames repel The Hollow Stalker back into the dark forest pines with clean hysteresis
      if (
        actor.spec.isMonster &&
        getFireRepel !== undefined &&
        getFireRepel(actor.x, actor.z, scratchFirePos)
      ) {
        actor.fireFleeTimer = 1.6;
        actor.fireFleeX = scratchFirePos.x;
        actor.fireFleeZ = scratchFirePos.z;
        actor.attackSwingTimer = 0;
        actor.attackHitDelivered = true;
        if (actor.glbRig) {
          actor.glbRig.wAttack = 0;
          if (actor.glbRig.attackAction) {
            actor.glbRig.attackAction.stop();
            actor.glbRig.attackAction.setEffectiveWeight(0);
          }
        }
        if (actor.state === 'attack') {
          actor.state = 'chase';
        }
        if (actor.fireRecoilCooldown <= 0) {
          actor.fireRecoilCooldown = 6.5;
          if (onStalkerSound) {
            onStalkerSound('recoil');
          }
        }
      }

      if (actor.fireFleeTimer > 0) {
        const awayX = actor.x - actor.fireFleeX;
        const awayZ = actor.z - actor.fireFleeZ;
        const awayDist = Math.hypot(awayX, awayZ);
        if (awayDist > 1e-4) {
          desiredMoveX = awayX / awayDist;
          desiredMoveZ = awayZ / awayDist;
        } else {
          desiredMoveX = 0;
          desiredMoveZ = -1;
        }
        moveSpeed = actor.spec.chaseSpeed * 0.86;
      } else if (actor.state === 'attack') {
        const lookYaw = Math.atan2(-dxToPlayer, -dzToPlayer);
        actor.yaw = lerpAngle(actor.yaw, lookYaw, Math.min(1, dt * 10));

        if (
          !actor.attackHitDelivered &&
          actor.attackSwingTimer > 0 &&
          actor.attackSwingTimer <= 0.72 - RAIDER_ATTACK_HIT_DELAY
        ) {
          actor.attackHitDelivered = true;
          if (!playerDead && distToPlayer <= attackRange + 0.55 && onPlayerHit) {
            onPlayerHit(actor.spec.attackDamage, actor.x, actor.z);
          }
        }

        if (actor.attackSwingTimer <= 0) {
          if (playerDead) {
            actor.state = 'patrol';
            actor.awareness = 0;
          } else {
            actor.state = 'chase';
          }
        }
      } else if (actor.state === 'chase') {
        const targetX = seesPlayer ? playerX : actor.investigateX;
        const targetZ = seesPlayer ? playerZ : actor.investigateZ;
        const toX = targetX - actor.x;
        const toZ = targetZ - actor.z;
        const dist = Math.hypot(toX, toZ);

        if (seesPlayer && !playerDead && distToPlayer <= attackRange && actor.attackCooldown <= 0) {
          actor.state = 'attack';
          actor.attackCooldown = RAIDER_ATTACK_CADENCE;
          actor.attackSwingTimer = 0.72;
          actor.attackHitDelivered = false;
          if (actor.glbRig?.attackAction) {
            actor.glbRig.attackAction.reset();
            actor.glbRig.attackAction.setLoop(THREE.LoopOnce, 1);
            actor.glbRig.attackAction.clampWhenFinished = true;
            actor.glbRig.attackAction.timeScale = 1.25;
            actor.glbRig.attackAction.play();
          }
        } else if (dist > 0.65) {
          desiredMoveX = toX / dist;
          desiredMoveZ = toZ / dist;
          moveSpeed =
            actor.spec.isMonster && !nocturnalHunt
              ? Math.min(actor.spec.chaseSpeed, 4.75)
              : actor.spec.chaseSpeed;
        }
      } else if (actor.state === 'investigate') {
        const toX = actor.investigateX - actor.x;
        const toZ = actor.investigateZ - actor.z;
        const dist = Math.hypot(toX, toZ);
        if (dist > 1.25) {
          desiredMoveX = toX / dist;
          desiredMoveZ = toZ / dist;
          moveSpeed = actor.spec.investigateSpeed;
          // Decay timer while traveling too so unreachable lures behind walls never soft-lock AI
          actor.investigateTimer -= dt * 0.55;
        } else {
          // Arrived at last known spot: scan left and right before returning to patrol
          actor.investigateTimer -= dt;
          actor.yaw += Math.sin(elapsed * 1.45 + i * 2) * dt * 0.75;
        }
        if (actor.investigateTimer <= 0) {
          actor.awareness = 0;
          actor.state = 'patrol';
          actor.waypointPause = 0.8;
        }
      } else if (actor.state === 'suspicious') {
        // Pause and turn cautiously toward spotted movement
        const lookYaw = Math.atan2(-(actor.investigateX - actor.x), -(actor.investigateZ - actor.z));
        actor.yaw = lerpAngle(actor.yaw, lookYaw, Math.min(1, dt * 5.5));
      } else {
        // Patrol waypoint loop (Hollow Stalker expands northward toward highway ruins at night or during storms)
        const activeWaypoints =
          actor.spec.isMonster && nocturnalHunt && actor.spec.nightWaypoints
            ? actor.spec.nightWaypoints
            : actor.spec.waypoints;
        const wpIdx = actor.waypointIndex % activeWaypoints.length;
        const wp = activeWaypoints[wpIdx];
        if (wp) {
          const toX = wp[0] - actor.x;
          const toZ = wp[1] - actor.z;
          const dist = Math.hypot(toX, toZ);
          if (dist < 0.85) {
            actor.waypointPause -= dt;
            if (actor.waypointPause <= 0) {
              actor.waypointIndex = (wpIdx + 1) % activeWaypoints.length;
              actor.waypointPause = 1.6 + ((i + actor.waypointIndex) % 3) * 0.65;
            }
          } else {
            desiredMoveX = toX / dist;
            desiredMoveZ = toZ / dist;
            moveSpeed = actor.spec.patrolSpeed;
          }
        }
      }

      if (moveSpeed > 0) {
        const prevActorX = actor.x;
        const prevActorZ = actor.z;

        // Gentle perpendicular slide if blocked by an obstacle
        if (actor.blockedTimer > 0) {
          actor.blockedTimer = Math.max(0, actor.blockedTimer - dt);
          const sideX = -desiredMoveZ;
          const sideZ = desiredMoveX;
          desiredMoveX = desiredMoveX * 0.45 + sideX * 0.89;
          desiredMoveZ = desiredMoveZ * 0.45 + sideZ * 0.89;
        }

        scratchMovePos.x = actor.x + desiredMoveX * moveSpeed * dt;
        scratchMovePos.z = actor.z + desiredMoveZ * moveSpeed * dt;
        const hitObs = resolveHorizontalCollision(scratchMovePos, RAIDER_RADIUS, obstacles);

        actor.x = scratchMovePos.x;
        actor.z = scratchMovePos.z;

        const actualMove = Math.hypot(actor.x - prevActorX, actor.z - prevActorZ);
        actor.speed = dt > 1e-5 ? actualMove / dt : 0;

        if (hitObs && actualMove < moveSpeed * dt * 0.35) {
          actor.blockedTimer = 0.55;
        }

        const targetYaw = Math.atan2(-desiredMoveX, -desiredMoveZ);
        actor.yaw = lerpAngle(actor.yaw, targetYaw, Math.min(1, dt * 7.5));
      } else {
        actor.speed += (0 - actor.speed) * Math.min(1, dt * 10);
      }

      actor.y = getTerrainHeight(actor.x, actor.z);
      actor.root.position.set(actor.x, actor.y, actor.z);
      actor.root.rotation.y = actor.yaw;

      // Diegetic world-space status indicator (? amber while suspicious/investigating, ! crimson when alerted)
      if (actor.state === 'chase' || actor.state === 'attack') {
        highestAlert = 'alert';
        if (actor.statusMat.map !== alertTex) {
          actor.statusMat.map = alertTex;
          actor.statusMat.needsUpdate = true;
        }
        actor.statusSprite.visible = true;
        actor.statusMat.opacity = 0.96;
        const pulse = 0.46 + Math.sin(elapsed * 8) * 0.05;
        actor.statusSprite.scale.set(pulse, pulse, 1);
      } else if (actor.awareness >= 0.14 || actor.state === 'suspicious' || actor.state === 'investigate') {
        if (highestAlert === 'unaware') {
          highestAlert = 'suspicious';
        }
        if (actor.statusMat.map !== questionTex) {
          actor.statusMat.map = questionTex;
          actor.statusMat.needsUpdate = true;
        }
        actor.statusSprite.visible = true;
        actor.statusMat.opacity = clamp(actor.awareness * 1.15, 0.35, 0.95);
        const s = 0.36 + actor.awareness * 0.12;
        actor.statusSprite.scale.set(s, s, 1);
      } else if (actor.statusSprite.visible) {
        actor.statusSprite.visible = false;
        actor.statusMat.opacity = 0;
      }

      updateRaiderAnimation(actor, dt, elapsed);
    }

    globalAlert = highestAlert;
    if (onAlertSting) {
      if (globalAlert === 'alert' && prevGlobalAlert !== 'alert') {
        onAlertSting('alert');
      } else if (globalAlert === 'suspicious' && prevGlobalAlert === 'unaware') {
        onAlertSting('suspicious');
      }
    }
  }

  function getAlertState(): GlobalAlertLevel {
    return globalAlert;
  }

  function getAliveCount(): number {
    let alive = 0;
    for (let i = 0; i < actors.length; i += 1) {
      const a = actors[i];
      if (a && a.state !== 'downed') {
        alive += 1;
      }
    }
    return alive;
  }

  function reset(): void {
    globalAlert = 'unaware';

    for (let i = 0; i < bottles.length; i += 1) {
      const b = bottles[i];
      if (b) {
        b.active = false;
        b.mesh.visible = false;
      }
    }
    for (let i = 0; i < shatterBursts.length; i += 1) {
      const burst = shatterBursts[i];
      if (burst) {
        burst.active = false;
        burst.points.visible = false;
        burst.material.opacity = 0;
      }
    }

    for (let i = 0; i < actors.length; i += 1) {
      const actor = actors[i];
      if (!actor) {
        continue;
      }
      const { spec } = actor;
      actor.x = spec.spawnX;
      actor.z = spec.spawnZ;
      actor.y = getTerrainHeight(spec.spawnX, spec.spawnZ);
      actor.yaw = spec.spawnYaw;
      actor.speed = 0;
      actor.hp = spec.maxHealth;
      actor.state = 'patrol';
      actor.awareness = 0;
      actor.waypointIndex = 1 % spec.waypoints.length;
      actor.waypointPause = 1.0 + i * 0.7;
      actor.investigateX = spec.spawnX;
      actor.investigateZ = spec.spawnZ;
      actor.investigateTimer = 0;
      actor.loseSightTimer = 0;
      actor.attackCooldown = 0;
      actor.attackSwingTimer = 0;
      actor.attackHitDelivered = false;
      actor.staggerTimer = 0;
      actor.staggerVelX = 0;
      actor.staggerVelZ = 0;
      actor.recoilCooldown = 0;
      actor.fireFleeTimer = 0;
      actor.fireFleeX = 0;
      actor.fireFleeZ = 0;
      actor.fireRecoilCooldown = 0;
      actor.prowlSoundCooldown = 4.5;
      actor.shriekCooldown = 0;
      actor.downProgress = 0;
      actor.blockedTimer = 0;
      if (actor.eyeEmberGroup) {
        actor.eyeEmberGroup.visible = true;
      }
      actor.visualPivot.rotation.set(0, 0, 0);
      actor.visualPivot.position.set(0, 0, 0);
      actor.root.position.set(actor.x, actor.y, actor.z);
      actor.root.rotation.y = actor.yaw;
      actor.statusSprite.visible = false;
      actor.statusMat.opacity = 0;

      if (actor.glbRig) {
        actor.glbRig.wIdle = 1;
        actor.glbRig.wWalk = 0;
        actor.glbRig.wJog = 0;
        actor.glbRig.wRun = 0;
        actor.glbRig.wAttack = 0;
        actor.glbRig.wHit = 0;
        actor.glbRig.wDeath = 0;
        if (actor.glbRig.idleAction) actor.glbRig.idleAction.setEffectiveWeight(1);
        if (actor.glbRig.walkAction) actor.glbRig.walkAction.setEffectiveWeight(0);
        if (actor.glbRig.jogAction) actor.glbRig.jogAction.setEffectiveWeight(0);
        if (actor.glbRig.runAction) actor.glbRig.runAction.setEffectiveWeight(0);
        if (actor.glbRig.attackAction) {
          actor.glbRig.attackAction.stop();
          actor.glbRig.attackAction.setEffectiveWeight(0);
        }
        if (actor.glbRig.hitAction) {
          actor.glbRig.hitAction.stop();
          actor.glbRig.hitAction.setEffectiveWeight(0);
        }
        if (actor.glbRig.deathAction) {
          actor.glbRig.deathAction.stop();
          actor.glbRig.deathAction.setEffectiveWeight(0);
        }
      }
    }
  }

  function dispose(): void {
    disposed = true;
    for (let i = 0; i < actors.length; i += 1) {
      const actor = actors[i];
      if (!actor) {
        continue;
      }
      if (actor.glbRig) {
        actor.glbRig.mixer.stopAllAction();
        actor.glbRig.mixer.uncacheRoot(actor.glbRig.scene);
      }
      actor.statusMat.dispose();
    }

    // disposeObjectTree disposes bottleGeo, shatter geometries/materials, procedural & GLB trees cleanly once
    disposeObjectTree(root, sharedProceduralMaterials);
    for (const mat of sharedProceduralMaterials) {
      mat.dispose();
    }
    questionTex.dispose();
    alertTex.dispose();
    root.clear();
  }

  return {
    root,
    update,
    emitNoise,
    tryPlayerMeleeHit,
    throwBottle,
    getAlertState,
    getAliveCount,
    reset,
    dispose,
  };
}
