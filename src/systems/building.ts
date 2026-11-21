import * as THREE from 'three';
import {
  clamp,
  createObbObstacle,
  getTerrainHeight,
  WORLD_BOUNDS,
  type Obstacle,
  type ObstacleObb,
  type Vec2Like,
} from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import type { LootBundle, ResourceCost, SurvivalState } from './survival';

export type BuildPieceKind =
  | 'foundation'
  | 'wall'
  | 'window_wall'
  | 'doorway'
  | 'roof'
  | 'stairs'
  | 'upper_floor'
  | 'spikes'
  | 'storage'
  | 'workbench';

export const BUILD_PIECE_ORDER: readonly BuildPieceKind[] = [
  'foundation',
  'wall',
  'window_wall',
  'doorway',
  'roof',
  'stairs',
  'upper_floor',
  'spikes',
  'storage',
  'workbench',
];

export interface BuildRecipe {
  readonly kind: BuildPieceKind;
  readonly label: string;
  readonly shortLabel: string;
  readonly cost: ResourceCost;
}

export const BUILD_RECIPES: Readonly<Record<BuildPieceKind, BuildRecipe>> = {
  foundation: {
    kind: 'foundation',
    label: 'Wood Foundation',
    shortLabel: 'Foundation',
    cost: { wood: 4, stone: 1 },
  },
  wall: {
    kind: 'wall',
    label: 'Timber Wall',
    shortLabel: 'Wall',
    cost: { wood: 3 },
  },
  window_wall: {
    kind: 'window_wall',
    label: 'Window Wall',
    shortLabel: 'Window',
    cost: { wood: 3 },
  },
  doorway: {
    kind: 'doorway',
    label: 'Timber Doorway',
    shortLabel: 'Doorway',
    cost: { wood: 3, scrap: 1 },
  },
  roof: {
    kind: 'roof',
    label: 'Plank Roof',
    shortLabel: 'Roof',
    cost: { wood: 3 },
  },
  stairs: {
    kind: 'stairs',
    label: 'Timber Stairs',
    shortLabel: 'Stairs',
    cost: { wood: 4, stone: 1 },
  },
  upper_floor: {
    kind: 'upper_floor',
    label: 'Upper Floor Deck',
    shortLabel: 'Upper Deck',
    cost: { wood: 3, stone: 1 },
  },
  spikes: {
    kind: 'spikes',
    label: 'Defensive Spikes',
    shortLabel: 'Spikes',
    cost: { wood: 2, scrap: 1 },
  },
  storage: {
    kind: 'storage',
    label: 'Storage Crate',
    shortLabel: 'Storage',
    cost: { wood: 3, scrap: 1 },
  },
  workbench: {
    kind: 'workbench',
    label: 'Workbench',
    shortLabel: 'Workbench',
    cost: { wood: 4, stone: 2, scrap: 2 },
  },
};

export const BUILD_MAX_HP: Readonly<Record<BuildPieceKind, number>> = {
  foundation: 180,
  wall: 140,
  window_wall: 120,
  doorway: 130,
  roof: 110,
  stairs: 130,
  upper_floor: 150,
  spikes: 100,
  storage: 120,
  workbench: 120,
};

export const PIECE_SIZE = 3.0;
export const WALL_HEIGHT = 2.8;
export const FOUNDATION_DECK_THICKNESS = 0.24;
export const MAX_BUILD_PIECES = 96;

const SNAP_RADIUS = 2.4;
const HALF_PIECE = PIECE_SIZE * 0.5;
const STAIR_PITCH = Math.atan2(WALL_HEIGHT, PIECE_SIZE);
const SPIKE_TRIGGER_WEAR = 14;
const REPAIR_WOOD_COST: ResourceCost = { wood: 1 };
const REPAIR_HP_GAIN = 45;
const BURST_SLOT_COUNT = 4;
const BURST_PARTICLES_PER_SLOT = 14;

export interface SavedBuildPiece {
  readonly id: string;
  readonly kind: BuildPieceKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly doorOpen?: boolean;
  readonly hp?: number;
}

export interface StorageStash {
  wood: number;
  stone: number;
  scrap: number;
  rations: number;
  medkits: number;
  warmers: number;
  bottles: number;
}

export interface BuildInteractTarget {
  readonly id: string;
  readonly kind: 'door' | 'workbench' | 'storage';
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly doorOpen?: boolean;
}

export interface StructureTargetProbe {
  id: string;
  kind: BuildPieceKind;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface StructureDamageResult {
  readonly hit: boolean;
  readonly destroyed: boolean;
  readonly kind?: BuildPieceKind;
  readonly label?: string;
  readonly remainingHp: number;
  readonly maxHp: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BuildRepairTarget {
  readonly id: string;
  readonly kind: BuildPieceKind;
  readonly label: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BuildRepairResult {
  readonly ok: boolean;
  readonly reason?: 'none' | 'resources';
  readonly id?: string;
  readonly kind?: BuildPieceKind;
  readonly label?: string;
  readonly hp?: number;
  readonly maxHp?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

export interface BuildPlacementResult {
  readonly ok: boolean;
  readonly reason?: 'limit' | 'puddle' | 'blocked' | 'overlap' | 'resources' | 'inactive';
  readonly id?: string;
  readonly kind: BuildPieceKind;
  readonly cost: ResourceCost;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface DismantleResult {
  readonly ok: boolean;
  readonly kind?: BuildPieceKind;
  readonly label?: string;
  readonly refund?: LootBundle;
}

export interface StorageTransferResult {
  readonly action: 'deposited' | 'withdrew' | 'empty';
  readonly summary: string;
}

export interface BuildingSystemOptions {
  readonly obstacles: Obstacle[];
  readonly isInsidePuddle: (x: number, z: number) => boolean;
}

export interface BuildingSystem {
  readonly root: THREE.Group;
  isActive(): boolean;
  setActive(active: boolean): void;
  getSelectedKind(): BuildPieceKind;
  setSelectedKind(kind: BuildPieceKind): void;
  cycleSelectedKind(delta: number): BuildPieceKind;
  rotateGhost(stepRad?: number): void;
  updateGhost(
    playerX: number,
    playerY: number,
    playerZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
    canAfford: boolean,
  ): void;
  tryPlaceCurrent(hasResources: (cost: ResourceCost) => boolean): BuildPlacementResult;
  tryDismantleLookedAt(
    originX: number,
    originY: number,
    originZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
  ): DismantleResult;
  toggleDoor(id: string): boolean | null;
  getFloorHeightAt(x: number, z: number, currentY?: number): number | null;
  isInsideBuiltShelter(x: number, z: number, actorY?: number): boolean;
  checkArrowStructureHit(x: number, y: number, z: number): boolean;
  getInteractTarget(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    playerY?: number,
  ): BuildInteractTarget | null;
  checkSpikeHit(x: number, z: number, radius: number, actorY?: number): boolean;
  getBaseAnchor(out: Vec2Like): boolean;
  findNearestAttackableStructure(
    x: number,
    z: number,
    maxRange: number,
    out: StructureTargetProbe,
    actorY?: number,
  ): boolean;
  damageStructure(id: string, amount: number): StructureDamageResult;
  getRepairTarget(
    playerX: number,
    playerY: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): BuildRepairTarget | null;
  tryRepairStructure(
    playerX: number,
    playerY: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    survival: SurvivalState,
  ): BuildRepairResult;
  getStorageStash(): Readonly<StorageStash>;
  depositOrWithdrawStorage(survival: SurvivalState): StorageTransferResult;
  getPieceCount(): number;
  update(dt: number): void;
  serialize(): {
    readonly pieces: SavedBuildPiece[];
    readonly stash: Readonly<StorageStash>;
  };
  hydrate(pieces: readonly SavedBuildPiece[], stash?: Partial<StorageStash>): void;
  reset(): void;
  dispose(): void;
}

interface PlacedBuildPiece {
  readonly id: string;
  readonly kind: BuildPieceKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly cos: number;
  readonly sin: number;
  readonly group: THREE.Group;
  readonly addedObstacles: Obstacle[];
  readonly doorPivot: THREE.Group | null;
  readonly doorClosedObstacle: ObstacleObb | null;
  readonly primaryTimberMeshes: THREE.Mesh[];
  readonly leanDir: 1 | -1;
  readonly maxHp: number;
  hp: number;
  wearTier: 0 | 1 | 2;
  shakeTimer: number;
  doorOpen: boolean;
  doorAngle: number;
}

interface BurstSlot {
  readonly points: THREE.Points;
  readonly mat: THREE.PointsMaterial;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly posAttr: THREE.BufferAttribute;
  active: boolean;
  age: number;
  duration: number;
}

function sanitizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function isValidPieceKind(kind: string): kind is BuildPieceKind {
  return (
    kind === 'foundation' ||
    kind === 'wall' ||
    kind === 'window_wall' ||
    kind === 'doorway' ||
    kind === 'roof' ||
    kind === 'stairs' ||
    kind === 'upper_floor' ||
    kind === 'spikes' ||
    kind === 'storage' ||
    kind === 'workbench'
  );
}

function isWallEdgeKind(kind: BuildPieceKind): boolean {
  return kind === 'wall' || kind === 'window_wall' || kind === 'doorway';
}

function isElevatedOverheadKind(kind: BuildPieceKind): boolean {
  return kind === 'roof' || kind === 'upper_floor';
}

function getPieceCenterOffsetY(kind: BuildPieceKind): number {
  if (isWallEdgeKind(kind)) {
    return WALL_HEIGHT * 0.5;
  }
  if (kind === 'stairs') {
    return WALL_HEIGHT * 0.5;
  }
  if (kind === 'foundation' || kind === 'upper_floor' || kind === 'roof') {
    return 0.14;
  }
  return 0.55;
}

function getStructureAttackRadius(kind: BuildPieceKind): number {
  if (
    kind === 'wall' ||
    kind === 'window_wall' ||
    kind === 'doorway' ||
    kind === 'foundation' ||
    kind === 'upper_floor' ||
    kind === 'stairs' ||
    kind === 'roof'
  ) {
    return 1.55;
  }
  if (kind === 'spikes') {
    return 1.35;
  }
  if (kind === 'workbench') {
    return 1.0;
  }
  return 0.8;
}

function isCircleBlockedByWorldObstacles(
  x: number,
  z: number,
  radius: number,
  obstacles: readonly Obstacle[],
  builtObstacles: ReadonlySet<Obstacle>,
  obbOnly: boolean,
): boolean {
  for (let i = 0; i < obstacles.length; i += 1) {
    const obs = obstacles[i];
    if (!obs || builtObstacles.has(obs)) {
      continue;
    }
    if (obbOnly && obs.kind !== 'obb') {
      continue;
    }
    if (obs.kind === 'circle') {
      const dx = x - obs.x;
      const dz = z - obs.z;
      const minD = radius + obs.radius;
      if (dx * dx + dz * dz < minD * minD) {
        return true;
      }
    } else if (obs.kind === 'box') {
      const cx = clamp(x, obs.minX, obs.maxX);
      const cz = clamp(z, obs.minZ, obs.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) {
        return true;
      }
    } else {
      const relX = x - obs.x;
      const relZ = z - obs.z;
      const lx = relX * obs.cos - relZ * obs.sin;
      const lz = relX * obs.sin + relZ * obs.cos;
      const cx = clamp(lx, -obs.halfWidth, obs.halfWidth);
      const cz = clamp(lz, -obs.halfDepth, obs.halfDepth);
      const dx = lx - cx;
      const dz = lz - cz;
      if (dx * dx + dz * dz < radius * radius) {
        return true;
      }
    }
  }
  return false;
}

export function createBuildingSystem(options: BuildingSystemOptions): BuildingSystem {
  const { obstacles, isInsidePuddle } = options;
  const root = new THREE.Group();
  root.name = 'ModularBaseBuilding';

  const atlas = typeof document !== 'undefined' ? getWorldTextureAtlas() : null;

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMats.push(m);
    return m;
  };

  // Shared PBR timber, wear-tier timber, stone, iron & ghost preview materials
  // (borrows atlas textures cleanly — NEVER disposes shared atlas textures)
  const timberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8f6b48,
      roughness: 0.9,
      metalness: 0.03,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
      roughnessMap: atlas?.pineBark.roughnessMap ?? null,
    }),
  );
  const timberDamagedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6f5135,
      roughness: 0.94,
      metalness: 0.04,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
      roughnessMap: atlas?.pineBark.roughnessMap ?? null,
    }),
  );
  const timberCriticalMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x453120,
      roughness: 0.97,
      metalness: 0.05,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
      roughnessMap: atlas?.pineBark.roughnessMap ?? null,
    }),
  );
  const darkTimberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x5c442e,
      roughness: 0.93,
      metalness: 0.03,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
    }),
  );
  const stoneTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x797f77,
      roughness: 0.92,
      metalness: 0.04,
      map: atlas?.mossyRock.map ?? null,
      normalMap: atlas?.mossyRock.normalMap ?? null,
      roughnessMap: atlas?.mossyRock.roughnessMap ?? null,
    }),
  );
  const ironMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x594c45,
      roughness: 0.72,
      metalness: 0.56,
      map: atlas?.rustDark.map ?? null,
      normalMap: atlas?.rustDark.normalMap ?? null,
    }),
  );
  const benchCanvasMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6c7258,
      roughness: 0.92,
      metalness: 0.02,
      map: atlas?.fabricOlive.map ?? null,
      normalMap: atlas?.fabricOlive.normalMap ?? null,
    }),
  );

  const ghostMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x4be08a,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );

  // Shared modular piece geometries (ZERO per-placement geometry allocations!)
  // Foundation (3.0 x 0.24 x 3.0 deck + 4 deep slope piers) & Upper Floor Deck
  const deckGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, FOUNDATION_DECK_THICKNESS, PIECE_SIZE));
  const deckBeamGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE + 0.04, 0.14, 0.14));
  const pierGeo = trackGeo(new THREE.BoxGeometry(0.28, 2.6, 0.28));
  const pierFootingGeo = trackGeo(new THREE.BoxGeometry(0.38, 0.3, 0.38));
  const upperJoistGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE - 0.08, 0.16, 0.14));

  // Wall (3.0 x 2.8 x 0.22)
  const wallPanelGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, WALL_HEIGHT, 0.18));
  const wallPostGeo = trackGeo(new THREE.BoxGeometry(0.22, WALL_HEIGHT, 0.24));
  const wallRailGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, 0.16, 0.24));
  const wallBraceGeo = trackGeo(new THREE.BoxGeometry(0.14, 3.2, 0.12));

  // Window Wall (3.0 x 2.8 framing open 1.5m x 1.1m embrasure at y in [1.05, 2.15])
  const winSillGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, 1.05, 0.18));
  const winLintelGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, 0.65, 0.18));
  const winJambGeo = trackGeo(new THREE.BoxGeometry(0.75, 1.1, 0.18));
  const winTrimGeo = trackGeo(new THREE.BoxGeometry(1.62, 0.09, 0.28));
  const winSideTrimGeo = trackGeo(new THREE.BoxGeometry(0.09, 1.14, 0.26));

  // Doorway (left/right jambs + top lintel + hinged door leaf)
  const jambGeo = trackGeo(new THREE.BoxGeometry(0.9, WALL_HEIGHT, 0.2));
  const lintelGeo = trackGeo(new THREE.BoxGeometry(1.24, 0.68, 0.22));
  const doorLeafGeo = trackGeo(new THREE.BoxGeometry(1.18, 2.08, 0.11));
  const hingeStrapGeo = trackGeo(new THREE.BoxGeometry(0.54, 0.07, 0.14));
  const doorHandleGeo = trackGeo(new THREE.BoxGeometry(0.08, 0.18, 0.18));

  // Roof (3.18 x 0.18 x 3.18 overhanging deck + rafters)
  const roofDeckGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE + 0.18, 0.16, PIECE_SIZE + 0.18));
  const roofRafterGeo = trackGeo(new THREE.BoxGeometry(0.14, 0.18, PIECE_SIZE + 0.06));
  const roofTrimGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE + 0.22, 0.1, 0.14));

  // Timber Stairs (climbs WALL_HEIGHT = 2.8m from z=+1.5 to z=-1.5)
  const stairDiagLen = Math.hypot(PIECE_SIZE, WALL_HEIGHT) + 0.08;
  const stairStringerGeo = trackGeo(new THREE.BoxGeometry(0.16, 0.24, stairDiagLen));
  const stairTreadGeo = trackGeo(new THREE.BoxGeometry(2.46, 0.09, 0.34));
  const stairPostGeo = trackGeo(new THREE.BoxGeometry(0.12, 1.04, 0.12));
  const stairRailGeo = trackGeo(new THREE.BoxGeometry(0.1, 0.1, stairDiagLen));

  // Defensive Spikes barricade
  const spikeBaseGeo = trackGeo(new THREE.CylinderGeometry(0.14, 0.16, 2.45, 8));
  spikeBaseGeo.rotateZ(Math.PI * 0.5);
  const spikeStakeGeo = trackGeo(new THREE.ConeGeometry(0.068, 1.48, 7));
  const spikeBandGeo = trackGeo(new THREE.CylinderGeometry(0.165, 0.165, 0.09, 8));
  spikeBandGeo.rotateZ(Math.PI * 0.5);

  // Storage Crate
  const crateBodyGeo = trackGeo(new THREE.BoxGeometry(1.12, 0.56, 0.64));
  const crateLidGeo = trackGeo(new THREE.BoxGeometry(1.18, 0.11, 0.68));
  const crateBandGeo = trackGeo(new THREE.BoxGeometry(0.08, 0.68, 0.7));
  const crateClaspGeo = trackGeo(new THREE.BoxGeometry(0.14, 0.14, 0.08));

  // Workbench
  const benchTopGeo = trackGeo(new THREE.BoxGeometry(1.64, 0.1, 0.78));
  const benchShelfGeo = trackGeo(new THREE.BoxGeometry(1.48, 0.06, 0.64));
  const benchLegGeo = trackGeo(new THREE.BoxGeometry(0.1, 0.88, 0.1));
  const benchBackGeo = trackGeo(new THREE.BoxGeometry(1.62, 0.52, 0.06));
  const benchViseGeo = trackGeo(new THREE.BoxGeometry(0.24, 0.16, 0.2));
  const benchMatGeo = trackGeo(new THREE.BoxGeometry(0.56, 0.025, 0.42));

  // Pre-allocated 4-slot pooled splinter & repair-spark burst system (ZERO per-frame heap allocations!)
  const burstSlots: BurstSlot[] = [];
  for (let s = 0; s < BURST_SLOT_COUNT; s += 1) {
    const positions = new Float32Array(BURST_PARTICLES_PER_SLOT * 3);
    const velocities = new Float32Array(BURST_PARTICLES_PER_SLOT * 3);
    const geo = trackGeo(new THREE.BufferGeometry());
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    const mat = trackMat(
      new THREE.PointsMaterial({
        color: 0x9e754c,
        size: 0.14,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const points = new THREE.Points(geo, mat);
    points.visible = false;
    points.frustumCulled = false;
    points.userData['excludeFromGtao'] = true;
    root.add(points);
    burstSlots.push({
      points,
      mat,
      positions,
      velocities,
      posAttr,
      active: false,
      age: 0,
      duration: 0.55,
    });
  }

  let burstSeed = 17;
  function nextBurstRand(): number {
    burstSeed = (burstSeed * 1664525 + 1013904223) >>> 0;
    return burstSeed / 4294967296;
  }

  function spawnBurst(
    x: number,
    y: number,
    z: number,
    colorHex: number,
    speedScale: number,
  ): void {
    let slot = burstSlots[0];
    if (!slot) {
      return;
    }
    let bestAge = -1;
    for (let i = 0; i < burstSlots.length; i += 1) {
      const candidate = burstSlots[i];
      if (!candidate) {
        continue;
      }
      if (!candidate.active) {
        slot = candidate;
        break;
      }
      if (candidate.age > bestAge) {
        bestAge = candidate.age;
        slot = candidate;
      }
    }

    slot.active = true;
    slot.age = 0;
    slot.duration = 0.55;
    slot.mat.color.setHex(colorHex);
    slot.mat.opacity = 0.92;
    slot.points.visible = true;

    for (let i = 0; i < BURST_PARTICLES_PER_SLOT; i += 1) {
      const idx = i * 3;
      const angle = nextBurstRand() * Math.PI * 2;
      const horiz = (0.9 + nextBurstRand() * 2.4) * speedScale;
      const up = (1.6 + nextBurstRand() * 2.8) * speedScale;
      slot.positions[idx] = x + (nextBurstRand() - 0.5) * 0.45;
      slot.positions[idx + 1] = y + (nextBurstRand() - 0.5) * 0.4;
      slot.positions[idx + 2] = z + (nextBurstRand() - 0.5) * 0.45;
      slot.velocities[idx] = Math.cos(angle) * horiz;
      slot.velocities[idx + 1] = up;
      slot.velocities[idx + 2] = Math.sin(angle) * horiz;
    }
    slot.posAttr.needsUpdate = true;
  }

  function populatePieceVisuals(
    group: THREE.Group,
    kind: BuildPieceKind,
    isGhost: boolean,
    primaryTimberOut?: THREE.Mesh[],
  ): THREE.Group | null {
    const mainWood = isGhost ? ghostMat : timberMat;
    const frameWood = isGhost ? ghostMat : darkTimberMat;
    const stone = isGhost ? ghostMat : stoneTrimMat;
    const metal = isGhost ? ghostMat : ironMat;
    const cloth = isGhost ? ghostMat : benchCanvasMat;

    const addMesh = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      px: number,
      py: number,
      pz: number,
      rx = 0,
      ry = 0,
      rz = 0,
      parent: THREE.Object3D = group,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(px, py, pz);
      if (rx !== 0 || ry !== 0 || rz !== 0) {
        mesh.rotation.set(rx, ry, rz);
      }
      if (isGhost) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 8;
        mesh.userData['excludeFromGtao'] = true;
      } else {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (primaryTimberOut && mat === timberMat) {
          primaryTimberOut.push(mesh);
        }
      }
      parent.add(mesh);
      return mesh;
    };

    if (kind === 'foundation') {
      addMesh(deckGeo, mainWood, 0, FOUNDATION_DECK_THICKNESS * 0.5, 0);
      addMesh(deckBeamGeo, frameWood, 0, FOUNDATION_DECK_THICKNESS - 0.04, -HALF_PIECE + 0.07);
      addMesh(deckBeamGeo, frameWood, 0, FOUNDATION_DECK_THICKNESS - 0.04, HALF_PIECE - 0.07);
      for (const sx of [-1.28, 1.28]) {
        for (const sz of [-1.28, 1.28]) {
          addMesh(pierGeo, frameWood, sx, -1.25, sz);
          addMesh(pierFootingGeo, stone, sx, -0.06, sz);
        }
      }
      return null;
    }

    if (kind === 'upper_floor') {
      addMesh(deckGeo, mainWood, 0, FOUNDATION_DECK_THICKNESS * 0.5, 0);
      addMesh(deckBeamGeo, frameWood, 0, FOUNDATION_DECK_THICKNESS - 0.04, -HALF_PIECE + 0.07);
      addMesh(deckBeamGeo, frameWood, 0, FOUNDATION_DECK_THICKNESS - 0.04, HALF_PIECE - 0.07);
      for (const jz of [-1.2, 0, 1.2]) {
        addMesh(upperJoistGeo, frameWood, 0, -0.06, jz);
      }
      return null;
    }

    if (kind === 'wall') {
      addMesh(wallPanelGeo, mainWood, 0, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, -HALF_PIECE + 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, HALF_PIECE - 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallRailGeo, frameWood, 0, 0.08, 0);
      addMesh(wallRailGeo, frameWood, 0, WALL_HEIGHT - 0.08, 0);
      addMesh(wallBraceGeo, frameWood, 0, WALL_HEIGHT * 0.5, 0.04, 0, 0, 0.78);
      return null;
    }

    if (kind === 'window_wall') {
      // Bottom sill (y: 0..1.05), top lintel (y: 2.15..2.80), flanking jamb panels (x in [-1.5,-0.75], [+0.75,+1.5])
      addMesh(winSillGeo, mainWood, 0, 0.525, 0);
      addMesh(winLintelGeo, mainWood, 0, 2.475, 0);
      addMesh(winJambGeo, mainWood, -1.125, 1.6, 0);
      addMesh(winJambGeo, mainWood, 1.125, 1.6, 0);
      addMesh(wallPostGeo, frameWood, -HALF_PIECE + 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, HALF_PIECE - 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallRailGeo, frameWood, 0, 0.08, 0);
      addMesh(wallRailGeo, frameWood, 0, WALL_HEIGHT - 0.08, 0);
      addMesh(winTrimGeo, frameWood, 0, 1.05, 0);
      addMesh(winTrimGeo, frameWood, 0, 2.15, 0);
      addMesh(winSideTrimGeo, frameWood, -0.75, 1.6, 0);
      addMesh(winSideTrimGeo, frameWood, 0.75, 1.6, 0);
      return null;
    }

    if (kind === 'doorway') {
      addMesh(jambGeo, mainWood, -1.05, WALL_HEIGHT * 0.5, 0);
      addMesh(jambGeo, mainWood, 1.05, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, -HALF_PIECE + 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, HALF_PIECE - 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(lintelGeo, frameWood, 0, WALL_HEIGHT - 0.34, 0);

      const doorPivot = new THREE.Group();
      doorPivot.position.set(-0.59, 0, 0);
      addMesh(doorLeafGeo, frameWood, 0.59, 1.05, 0, 0, 0, 0, doorPivot);
      addMesh(hingeStrapGeo, metal, 0.28, 1.65, 0, 0, 0, 0, doorPivot);
      addMesh(hingeStrapGeo, metal, 0.28, 0.45, 0, 0, 0, 0, doorPivot);
      addMesh(doorHandleGeo, metal, 1.02, 1.02, 0, 0, 0, 0, doorPivot);
      group.add(doorPivot);
      return doorPivot;
    }

    if (kind === 'roof') {
      addMesh(roofDeckGeo, mainWood, 0, 0.1, 0);
      for (const rx of [-1.25, 0, 1.25]) {
        addMesh(roofRafterGeo, frameWood, rx, -0.05, 0);
      }
      addMesh(roofTrimGeo, frameWood, 0, 0.16, -HALF_PIECE - 0.04);
      addMesh(roofTrimGeo, frameWood, 0, 0.16, HALF_PIECE + 0.04);
      return null;
    }

    if (kind === 'stairs') {
      // Two diagonal side stringers climbing from local z = +1.5 (y = 0) to local z = -1.5 (y = 2.8)
      addMesh(stairStringerGeo, frameWood, -1.28, WALL_HEIGHT * 0.5, 0, STAIR_PITCH, 0, 0);
      addMesh(stairStringerGeo, frameWood, 1.28, WALL_HEIGHT * 0.5, 0, STAIR_PITCH, 0, 0);
      for (let step = 0; step < 10; step += 1) {
        const t = (step + 0.5) / 10;
        const ty = t * WALL_HEIGHT;
        const tz = HALF_PIECE - t * PIECE_SIZE;
        addMesh(stairTreadGeo, mainWood, 0, ty, tz);
      }
      // Side handrail posts & slanted top rails
      for (const sx of [-1.34, 1.34]) {
        addMesh(stairPostGeo, frameWood, sx, 0.52, 1.34);
        addMesh(stairPostGeo, frameWood, sx, WALL_HEIGHT * 0.5 + 0.52, 0);
        addMesh(stairPostGeo, frameWood, sx, WALL_HEIGHT + 0.52, -1.34);
        addMesh(stairRailGeo, frameWood, sx, WALL_HEIGHT * 0.5 + 1.0, 0, STAIR_PITCH, 0, 0);
      }
      return null;
    }

    if (kind === 'spikes') {
      addMesh(spikeBaseGeo, frameWood, 0, 0.16, 0);
      addMesh(spikeBandGeo, metal, -0.95, 0.16, 0);
      addMesh(spikeBandGeo, metal, 0.95, 0.16, 0);
      for (let i = 0; i < 6; i += 1) {
        const sx = -1.0 + i * 0.4;
        const forwardTilt = i % 2 === 0 ? -0.56 : 0.56;
        addMesh(spikeStakeGeo, mainWood, sx, 0.64, forwardTilt > 0 ? 0.18 : -0.18, forwardTilt, 0, 0);
      }
      return null;
    }

    if (kind === 'storage') {
      addMesh(crateBodyGeo, mainWood, 0, 0.28, 0);
      addMesh(crateLidGeo, frameWood, 0, 0.615, 0);
      addMesh(crateBandGeo, metal, -0.44, 0.34, 0);
      addMesh(crateBandGeo, metal, 0.44, 0.34, 0);
      addMesh(crateClaspGeo, metal, 0, 0.54, 0.33);
      return null;
    }

    // Workbench
    addMesh(benchTopGeo, mainWood, 0, 0.9, 0);
    addMesh(benchShelfGeo, frameWood, 0, 0.3, 0);
    for (const sx of [-0.72, 0.72]) {
      for (const sz of [-0.31, 0.31]) {
        addMesh(benchLegGeo, frameWood, sx, 0.44, sz);
      }
    }
    addMesh(benchBackGeo, frameWood, 0, 1.2, -0.36);
    addMesh(benchViseGeo, metal, -0.62, 0.98, 0.32);
    addMesh(benchMatGeo, cloth, 0.18, 0.96, 0.02);
    return null;
  }

  // Pre-built ghost preview container (1 child per piece kind, toggled cleanly with ZERO allocations!)
  const ghostRoot = new THREE.Group();
  ghostRoot.visible = false;
  root.add(ghostRoot);

  const ghostByKind: Record<BuildPieceKind, THREE.Group> = {
    foundation: new THREE.Group(),
    wall: new THREE.Group(),
    window_wall: new THREE.Group(),
    doorway: new THREE.Group(),
    roof: new THREE.Group(),
    stairs: new THREE.Group(),
    upper_floor: new THREE.Group(),
    spikes: new THREE.Group(),
    storage: new THREE.Group(),
    workbench: new THREE.Group(),
  };
  for (let i = 0; i < BUILD_PIECE_ORDER.length; i += 1) {
    const kind = BUILD_PIECE_ORDER[i];
    if (!kind) {
      continue;
    }
    const g = ghostByKind[kind];
    populatePieceVisuals(g, kind, true);
    g.visible = kind === 'foundation';
    ghostRoot.add(g);
  }

  const pieces: PlacedBuildPiece[] = [];
  const builtObstacles = new Set<Obstacle>();
  const storageStash: StorageStash = {
    wood: 0,
    stone: 0,
    scrap: 0,
    rations: 0,
    medkits: 0,
    warmers: 0,
    bottles: 0,
  };

  let active = false;
  let selectedKind: BuildPieceKind = 'foundation';
  let userYaw = 0;
  let nextPieceSeq = 1;

  // Live pre-allocated ghost, interact & repair state (ZERO per-frame object allocations!)
  let ghostX = 0;
  let ghostY = 0;
  let ghostZ = 0;
  let ghostYaw = 0;
  let ghostSnappedOnDeck = false;
  let ghostValid = false;
  let ghostFailReason: 'limit' | 'puddle' | 'blocked' | 'overlap' | undefined;

  const scratchInteractTarget: {
    id: string;
    kind: 'door' | 'workbench' | 'storage';
    label: string;
    x: number;
    z: number;
    doorOpen?: boolean;
  } = {
    id: '',
    kind: 'door',
    label: '',
    x: 0,
    z: 0,
  };

  const scratchRepairTarget: {
    id: string;
    kind: BuildPieceKind;
    label: string;
    hp: number;
    maxHp: number;
    x: number;
    y: number;
    z: number;
  } = {
    id: '',
    kind: 'wall',
    label: '',
    hp: 0,
    maxHp: 0,
    x: 0,
    y: 0,
    z: 0,
  };

  function getPieceBaseLean(p: PlacedBuildPiece): number {
    const rawTilt =
      p.wearTier === 0 ? 0 : p.wearTier === 1 ? 0.022 * p.leanDir : 0.052 * p.leanDir;
    const scale =
      p.kind === 'foundation' || p.kind === 'upper_floor' || p.kind === 'stairs' ? 0.35 : 1.0;
    return rawTilt * scale;
  }

  function syncPieceWearVisuals(p: PlacedBuildPiece): void {
    const ratio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    const nextTier: 0 | 1 | 2 = ratio < 0.35 ? 2 : ratio < 0.7 ? 1 : 0;
    if (nextTier !== p.wearTier) {
      p.wearTier = nextTier;
      const mat =
        nextTier === 2 ? timberCriticalMat : nextTier === 1 ? timberDamagedMat : timberMat;
      for (let i = 0; i < p.primaryTimberMeshes.length; i += 1) {
        const mesh = p.primaryTimberMeshes[i];
        if (mesh) {
          mesh.material = mat;
        }
      }
    }
    if (p.shakeTimer <= 0) {
      p.group.rotation.z = getPieceBaseLean(p);
      p.group.rotation.x = 0;
    }
  }

  function syncGhostVisibility(): void {
    ghostRoot.visible = active;
    for (let i = 0; i < BUILD_PIECE_ORDER.length; i += 1) {
      const k = BUILD_PIECE_ORDER[i];
      if (k) {
        ghostByKind[k].visible = k === selectedKind;
      }
    }
  }

  function hasDuplicateOverlap(
    kind: BuildPieceKind,
    x: number,
    y: number,
    z: number,
  ): boolean {
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      const dx = p.x - x;
      const dz = p.z - z;
      const dXZ = Math.hypot(dx, dz);
      const dY = Math.abs(p.y - y);

      if (kind === 'foundation' && p.kind === 'foundation' && dXZ < 1.2) {
        return true;
      }
      if (isWallEdgeKind(kind) && isWallEdgeKind(p.kind) && dXZ < 0.55 && dY < 0.8) {
        return true;
      }
      if (
        isElevatedOverheadKind(kind) &&
        isElevatedOverheadKind(p.kind) &&
        dXZ < 1.1 &&
        dY < 0.8
      ) {
        return true;
      }
      if (kind === 'stairs' && p.kind === 'stairs' && dXZ < 1.2 && dY < 1.2) {
        return true;
      }
      if (
        (kind === 'spikes' || kind === 'storage' || kind === 'workbench') &&
        (p.kind === 'spikes' || p.kind === 'storage' || p.kind === 'workbench' || p.kind === 'stairs') &&
        dXZ < 0.95 &&
        dY < 0.9
      ) {
        return true;
      }
      if (
        (kind === 'storage' || kind === 'workbench' || kind === 'spikes') &&
        isWallEdgeKind(p.kind) &&
        dXZ < 0.55 &&
        dY < 1.2
      ) {
        return true;
      }
    }
    return false;
  }

  function getFloorHeightAt(x: number, z: number, currentY?: number): number | null {
    let bestY: number | null = null;
    const maxAllowedY = currentY !== undefined ? currentY + 1.05 : Infinity;
    const deckHalfSpan = HALF_PIECE + 0.08;
    const stairHalfX = HALF_PIECE - 0.08;
    const stairHalfZ = HALF_PIECE + 0.14;

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      if (p.kind === 'foundation' || p.kind === 'upper_floor') {
        const relX = x - p.x;
        const relZ = z - p.z;
        const lx = relX * p.cos - relZ * p.sin;
        const lz = relX * p.sin + relZ * p.cos;
        if (Math.abs(lx) <= deckHalfSpan && Math.abs(lz) <= deckHalfSpan) {
          const deckTop = p.y + FOUNDATION_DECK_THICKNESS;
          if (deckTop <= maxAllowedY && (bestY === null || deckTop > bestY)) {
            bestY = deckTop;
          }
        }
      } else if (p.kind === 'stairs') {
        const relX = x - p.x;
        const relZ = z - p.z;
        const lx = relX * p.cos - relZ * p.sin;
        const lz = relX * p.sin + relZ * p.cos;
        if (Math.abs(lx) <= stairHalfX && Math.abs(lz) <= stairHalfZ) {
          const t = clamp((HALF_PIECE - lz) / PIECE_SIZE, 0, 1);
          const stairY = p.y + t * WALL_HEIGHT + 0.08;
          if (stairY <= maxAllowedY && (bestY === null || stairY > bestY)) {
            bestY = stairY;
          }
        }
      }
    }
    return bestY;
  }

  function isInsideBuiltShelter(x: number, z: number, actorY?: number): boolean {
    const halfSpan = HALF_PIECE + 0.15;
    const refY = actorY !== undefined ? actorY : getTerrainHeight(x, z);
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || !isElevatedOverheadKind(p.kind)) {
        continue;
      }
      if (p.y <= refY + 0.8) {
        continue;
      }
      const relX = x - p.x;
      const relZ = z - p.z;
      const lx = relX * p.cos - relZ * p.sin;
      const lz = relX * p.sin + relZ * p.cos;
      if (Math.abs(lx) <= halfSpan && Math.abs(lz) <= halfSpan) {
        return true;
      }
    }
    return false;
  }

  function checkArrowStructureHit(x: number, y: number, z: number): boolean {
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      const relX = x - p.x;
      const relZ = z - p.z;
      const lx = relX * p.cos - relZ * p.sin;
      const lz = relX * p.sin + relZ * p.cos;
      const ly = y - p.y;

      if (p.kind === 'wall') {
        if (Math.abs(lx) <= HALF_PIECE && Math.abs(lz) <= 0.22 && ly >= 0 && ly <= WALL_HEIGHT) {
          return true;
        }
      } else if (p.kind === 'window_wall') {
        if (Math.abs(lx) <= HALF_PIECE && Math.abs(lz) <= 0.22 && ly >= 0 && ly <= WALL_HEIGHT) {
          // Open shooting embrasure: |localX| < 0.72 and localY in (1.05, 2.15) lets arrows fly through!
          if (Math.abs(lx) < 0.72 && ly > 1.05 && ly < 2.15) {
            continue;
          }
          return true;
        }
      } else if (p.kind === 'doorway') {
        if (Math.abs(lx) <= HALF_PIECE && Math.abs(lz) <= 0.22 && ly >= 0 && ly <= WALL_HEIGHT) {
          if (p.doorOpen && Math.abs(lx) < 0.6 && ly < 2.12) {
            continue;
          }
          return true;
        }
      } else if (p.kind === 'foundation' || p.kind === 'upper_floor') {
        if (
          Math.abs(lx) <= HALF_PIECE &&
          Math.abs(lz) <= HALF_PIECE &&
          ly >= -0.08 &&
          ly <= FOUNDATION_DECK_THICKNESS + 0.06
        ) {
          return true;
        }
      } else if (p.kind === 'roof') {
        if (
          Math.abs(lx) <= HALF_PIECE + 0.1 &&
          Math.abs(lz) <= HALF_PIECE + 0.1 &&
          ly >= -0.1 &&
          ly <= 0.24
        ) {
          return true;
        }
      } else if (p.kind === 'spikes') {
        if (Math.abs(lx) <= 1.25 && Math.abs(lz) <= 0.35 && ly >= 0 && ly <= 1.15) {
          return true;
        }
      } else if (p.kind === 'storage') {
        if (Math.abs(lx) <= 0.62 && Math.abs(lz) <= 0.38 && ly >= 0 && ly <= 0.72) {
          return true;
        }
      } else if (p.kind === 'workbench') {
        if (Math.abs(lx) <= 0.86 && Math.abs(lz) <= 0.44 && ly >= 0 && ly <= 1.48) {
          return true;
        }
      }
    }
    return false;
  }

  function computePlacementValidation(
    kind: BuildPieceKind,
    x: number,
    y: number,
    z: number,
    onFoundationDeck: boolean,
  ): 'limit' | 'puddle' | 'blocked' | 'overlap' | undefined {
    if (pieces.length >= MAX_BUILD_PIECES) {
      return 'limit';
    }
    if (
      x < WORLD_BOUNDS.minX + 2 ||
      x > WORLD_BOUNDS.maxX - 2 ||
      z < WORLD_BOUNDS.minZ + 2 ||
      z > WORLD_BOUNDS.maxZ - 2
    ) {
      return 'blocked';
    }
    if (hasDuplicateOverlap(kind, x, y, z)) {
      return 'overlap';
    }
    const elevated = isElevatedOverheadKind(kind);
    if (!elevated && !onFoundationDeck && isInsidePuddle(x, z)) {
      return 'puddle';
    }
    const probeRadius =
      kind === 'foundation' || kind === 'stairs' ? 0.85 : elevated ? 0.6 : 0.45;
    const obbOnly = elevated;
    if (isCircleBlockedByWorldObstacles(x, z, probeRadius, obstacles, builtObstacles, obbOnly)) {
      return 'blocked';
    }
    return undefined;
  }

  function updateGhost(
    playerX: number,
    playerY: number,
    playerZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
    canAfford: boolean,
  ): void {
    const horizLen = Math.hypot(aimX, aimZ);
    const dirX = horizLen > 1e-4 ? aimX / horizLen : 0;
    const dirZ = horizLen > 1e-4 ? aimZ / horizLen : -1;
    const reach = clamp(3.9 + aimY * 2.4, 2.6, 5.4);
    const rawX = clamp(playerX + dirX * reach, WORLD_BOUNDS.minX + 2.2, WORLD_BOUNDS.maxX - 2.2);
    const rawZ = clamp(playerZ + dirZ * reach, WORLD_BOUNDS.minZ + 2.2, WORLD_BOUNDS.maxZ - 2.2);
    const groundY = getTerrainHeight(rawX, rawZ);

    let bestX = rawX;
    let bestY = groundY;
    let bestZ = rawZ;
    let bestYaw = userYaw;
    let snappedOnDeck = false;

    if (selectedKind === 'foundation') {
      bestY = groundY + 0.16;
      let bestDist = SNAP_RADIUS;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || p.kind !== 'foundation') {
          continue;
        }
        for (let e = 0; e < 4; e += 1) {
          const lx = e === 0 ? PIECE_SIZE : e === 1 ? -PIECE_SIZE : 0;
          const lz = e === 2 ? PIECE_SIZE : e === 3 ? -PIECE_SIZE : 0;
          const cx = p.x + lx * p.cos + lz * p.sin;
          const cz = p.z - lx * p.sin + lz * p.cos;
          const d = Math.hypot(cx - rawX, cz - rawZ);
          if (d < bestDist && !hasDuplicateOverlap('foundation', cx, p.y, cz)) {
            bestDist = d;
            bestX = cx;
            bestY = p.y;
            bestZ = cz;
            bestYaw = p.yaw;
          }
        }
      }
    } else if (isWallEdgeKind(selectedKind)) {
      // Snap cleanly to all 4 outer edges of BOTH 1st-story foundations AND 2nd-story upper floors (max 2 stories)
      const desiredWallY = playerY + Math.max(0, aimY) * 2.2;
      let bestScore = Infinity;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || (p.kind !== 'foundation' && p.kind !== 'upper_floor')) {
          continue;
        }
        const wallY = p.y + FOUNDATION_DECK_THICKNESS;
        for (let e = 0; e < 4; e += 1) {
          let lx = 0;
          let lz = 0;
          let edgeYaw = p.yaw;
          if (e === 0) {
            lz = -HALF_PIECE;
            edgeYaw = p.yaw;
          } else if (e === 1) {
            lz = HALF_PIECE;
            edgeYaw = p.yaw + Math.PI;
          } else if (e === 2) {
            lx = -HALF_PIECE;
            edgeYaw = p.yaw + Math.PI * 0.5;
          } else {
            lx = HALF_PIECE;
            edgeYaw = p.yaw - Math.PI * 0.5;
          }
          const cx = p.x + lx * p.cos + lz * p.sin;
          const cz = p.z - lx * p.sin + lz * p.cos;
          const dXZ = Math.hypot(cx - rawX, cz - rawZ);
          if (dXZ < SNAP_RADIUS && !hasDuplicateOverlap(selectedKind, cx, wallY, cz)) {
            const score = dXZ + Math.abs(wallY - desiredWallY) * 0.65;
            if (score < bestScore) {
              bestScore = score;
              bestX = cx;
              bestY = wallY;
              bestZ = cz;
              bestYaw = edgeYaw;
              snappedOnDeck = true;
            }
          }
        }
      }
    } else if (selectedKind === 'stairs') {
      // Snap onto 1st-story foundation top (90-deg aligned to foundation + userYaw) or sit cleanly on terrain
      bestY = groundY;
      let bestDist = SNAP_RADIUS;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || p.kind !== 'foundation') {
          continue;
        }
        const stairY = p.y + FOUNDATION_DECK_THICKNESS;
        const d = Math.hypot(p.x - rawX, p.z - rawZ);
        if (d < bestDist && !hasDuplicateOverlap('stairs', p.x, stairY, p.z)) {
          const relYaw = userYaw - p.yaw;
          const quarterStep = Math.round(relYaw / (Math.PI * 0.5)) * (Math.PI * 0.5);
          bestDist = d;
          bestX = p.x;
          bestY = stairY;
          bestZ = p.z;
          bestYaw = p.yaw + quarterStep;
          snappedOnDeck = true;
        }
      }
    } else if (selectedKind === 'upper_floor') {
      // Snap onto 1st-story foundation bay tops, top of stairs (+3m along stair forward -Z),
      // edge-to-edge next to existing upper_floor, OR 1st-story wall tops
      bestY = groundY + WALL_HEIGHT;
      const snapLimit = SNAP_RADIUS + 0.6;
      let bestDist = snapLimit;

      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p) {
          continue;
        }
        if (p.kind === 'foundation') {
          const ufY = p.y + FOUNDATION_DECK_THICKNESS + WALL_HEIGHT;
          const d = Math.hypot(p.x - rawX, p.z - rawZ);
          if (d < bestDist && !hasDuplicateOverlap('upper_floor', p.x, ufY, p.z)) {
            bestDist = d;
            bestX = p.x;
            bestY = ufY;
            bestZ = p.z;
            bestYaw = p.yaw;
            snappedOnDeck = true;
          }
        } else if (p.kind === 'stairs') {
          // Local (0, -PIECE_SIZE) sits seamlessly past the top stair tread at z = -1.5
          const cx = p.x - PIECE_SIZE * p.sin;
          const cz = p.z - PIECE_SIZE * p.cos;
          const ufY = p.y + WALL_HEIGHT;
          const d = Math.hypot(cx - rawX, cz - rawZ);
          if (d < bestDist && !hasDuplicateOverlap('upper_floor', cx, ufY, cz)) {
            bestDist = d;
            bestX = cx;
            bestY = ufY;
            bestZ = cz;
            bestYaw = p.yaw;
            snappedOnDeck = true;
          }
        } else if (p.kind === 'upper_floor') {
          for (let e = 0; e < 4; e += 1) {
            const lx = e === 0 ? PIECE_SIZE : e === 1 ? -PIECE_SIZE : 0;
            const lz = e === 2 ? PIECE_SIZE : e === 3 ? -PIECE_SIZE : 0;
            const cx = p.x + lx * p.cos + lz * p.sin;
            const cz = p.z - lx * p.sin + lz * p.cos;
            const d = Math.hypot(cx - rawX, cz - rawZ);
            if (d < bestDist && !hasDuplicateOverlap('upper_floor', cx, p.y, cz)) {
              bestDist = d;
              bestX = cx;
              bestY = p.y;
              bestZ = cz;
              bestYaw = p.yaw;
              snappedOnDeck = true;
            }
          }
        }
      }

      if (!snappedOnDeck) {
        for (let i = 0; i < pieces.length; i += 1) {
          const p = pieces[i];
          if (!p || !isWallEdgeKind(p.kind)) {
            continue;
          }
          // Only snap upper_floor onto 1st-story walls (keep max 2 stories)
          if (p.y > getTerrainHeight(p.x, p.z) + WALL_HEIGHT * 0.8) {
            continue;
          }
          const ufY = p.y + WALL_HEIGHT;
          for (let side = -1; side <= 1; side += 2) {
            const cx = p.x + side * HALF_PIECE * p.sin;
            const cz = p.z + side * HALF_PIECE * p.cos;
            const d = Math.hypot(cx - rawX, cz - rawZ);
            if (d < bestDist && !hasDuplicateOverlap('upper_floor', cx, ufY, cz)) {
              bestDist = d;
              bestX = cx;
              bestY = ufY;
              bestZ = cz;
              bestYaw = p.yaw;
              snappedOnDeck = true;
            }
          }
        }
      }
    } else if (selectedKind === 'roof') {
      bestY = groundY + WALL_HEIGHT;
      const desiredRoofY = playerY + WALL_HEIGHT;
      const snapLimit = SNAP_RADIUS + 0.6;
      let bestScore = Infinity;
      let snappedRoof = false;

      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || (p.kind !== 'foundation' && p.kind !== 'upper_floor')) {
          continue;
        }
        const roofY = p.y + FOUNDATION_DECK_THICKNESS + WALL_HEIGHT;
        const d = Math.hypot(p.x - rawX, p.z - rawZ);
        if (d < snapLimit && !hasDuplicateOverlap('roof', p.x, roofY, p.z)) {
          const score = d + Math.abs(roofY - desiredRoofY) * 0.45;
          if (score < bestScore) {
            bestScore = score;
            bestX = p.x;
            bestY = roofY;
            bestZ = p.z;
            bestYaw = p.yaw;
            snappedOnDeck = true;
            snappedRoof = true;
          }
        }
      }
      // Fallback: snap roof onto freestanding wall/window_wall/doorway top offset inward along local Z normal
      if (!snappedRoof) {
        let bestWallDist = snapLimit;
        for (let i = 0; i < pieces.length; i += 1) {
          const p = pieces[i];
          if (!p || !isWallEdgeKind(p.kind)) {
            continue;
          }
          const roofY = p.y + WALL_HEIGHT;
          for (let side = -1; side <= 1; side += 2) {
            const cx = p.x + side * HALF_PIECE * p.sin;
            const cz = p.z + side * HALF_PIECE * p.cos;
            const d = Math.hypot(cx - rawX, cz - rawZ);
            if (d < bestWallDist && !hasDuplicateOverlap('roof', cx, roofY, cz)) {
              bestWallDist = d;
              bestX = cx;
              bestY = roofY;
              bestZ = cz;
              bestYaw = p.yaw;
              snappedOnDeck = true;
            }
          }
        }
      }
    } else {
      // Spikes, Storage Crate, Workbench: seat cleanly onto 1st- or 2nd-story floor decks
      const floorY = getFloorHeightAt(rawX, rawZ, playerY);
      if (floorY !== null && floorY >= groundY) {
        bestY = floorY;
        snappedOnDeck = true;
      } else {
        bestY = groundY;
      }
    }

    ghostX = bestX;
    ghostY = bestY;
    ghostZ = bestZ;
    ghostYaw = bestYaw;
    ghostSnappedOnDeck = snappedOnDeck;

    ghostFailReason = computePlacementValidation(
      selectedKind,
      ghostX,
      ghostY,
      ghostZ,
      ghostSnappedOnDeck,
    );
    ghostValid = ghostFailReason === undefined;

    ghostRoot.position.set(ghostX, ghostY, ghostZ);
    ghostRoot.rotation.y = ghostYaw;
    ghostMat.color.setHex(ghostValid && canAfford ? 0x4be08a : 0xe05548);
  }

  function addObstacleTracked(obs: Obstacle, bucket: Obstacle[]): void {
    obstacles.push(obs);
    builtObstacles.add(obs);
    bucket.push(obs);
  }

  function removeObstacleTracked(obs: Obstacle): void {
    const idx = obstacles.indexOf(obs);
    if (idx >= 0) {
      obstacles.splice(idx, 1);
    }
    builtObstacles.delete(obs);
  }

  function createPlacedPiece(
    id: string,
    kind: BuildPieceKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    initialDoorOpen: boolean,
    initialHp?: number,
  ): PlacedBuildPiece {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    const primaryTimberMeshes: THREE.Mesh[] = [];
    const doorPivot = populatePieceVisuals(group, kind, false, primaryTimberMeshes);
    root.add(group);

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const addedObstacles: Obstacle[] = [];
    let doorClosedObstacle: ObstacleObb | null = null;

    if (kind === 'wall' || kind === 'window_wall') {
      addObstacleTracked(
        createObbObstacle(x, z, PIECE_SIZE - 0.08, 0.28, yaw, y, y + WALL_HEIGHT),
        addedObstacles,
      );
    } else if (kind === 'doorway') {
      // Left & right structural wall jambs stay solid; center door obstacle toggles open/closed!
      const lxLeft = -1.05;
      const lxRight = 1.05;
      addObstacleTracked(
        createObbObstacle(
          x + lxLeft * cos,
          z - lxLeft * sin,
          0.88,
          0.28,
          yaw,
          y,
          y + WALL_HEIGHT,
        ),
        addedObstacles,
      );
      addObstacleTracked(
        createObbObstacle(
          x + lxRight * cos,
          z - lxRight * sin,
          0.88,
          0.28,
          yaw,
          y,
          y + WALL_HEIGHT,
        ),
        addedObstacles,
      );
      doorClosedObstacle = createObbObstacle(x, z, 1.24, 0.24, yaw, y, y + WALL_HEIGHT);
      if (!initialDoorOpen) {
        obstacles.push(doorClosedObstacle);
        builtObstacles.add(doorClosedObstacle);
      }
      if (doorPivot) {
        doorPivot.rotation.y = initialDoorOpen ? 1.55 : 0;
      }
    } else if (kind === 'spikes') {
      addObstacleTracked(createObbObstacle(x, z, 2.35, 0.56, yaw, y, y + 1.4), addedObstacles);
    } else if (kind === 'storage') {
      addObstacleTracked(createObbObstacle(x, z, 1.16, 0.68, yaw, y, y + 1.4), addedObstacles);
    } else if (kind === 'workbench') {
      addObstacleTracked(createObbObstacle(x, z, 1.66, 0.78, yaw, y, y + 1.4), addedObstacles);
    }

    const maxHp = BUILD_MAX_HP[kind];
    const hp =
      typeof initialHp === 'number' && Number.isFinite(initialHp) && initialHp > 0
        ? clamp(initialHp, 1, maxHp)
        : maxHp;
    const leanDir: 1 | -1 = (pieces.length & 1) === 0 ? 1 : -1;

    const piece: PlacedBuildPiece = {
      id,
      kind,
      x,
      y,
      z,
      yaw,
      cos,
      sin,
      group,
      addedObstacles,
      doorPivot,
      doorClosedObstacle,
      primaryTimberMeshes,
      leanDir,
      maxHp,
      hp,
      wearTier: 0,
      shakeTimer: 0,
      doorOpen: initialDoorOpen,
      doorAngle: initialDoorOpen ? 1.55 : 0,
    };
    syncPieceWearVisuals(piece);
    pieces.push(piece);
    return piece;
  }

  function removePieceAtIndex(idx: number): PlacedBuildPiece | null {
    const piece = pieces[idx];
    if (!piece) {
      return null;
    }
    for (let i = 0; i < piece.addedObstacles.length; i += 1) {
      const obs = piece.addedObstacles[i];
      if (obs) {
        removeObstacleTracked(obs);
      }
    }
    if (piece.doorClosedObstacle) {
      removeObstacleTracked(piece.doorClosedObstacle);
    }
    piece.group.removeFromParent();
    pieces.splice(idx, 1);
    return piece;
  }

  function tryPlaceCurrent(hasResources: (cost: ResourceCost) => boolean): BuildPlacementResult {
    const recipe = BUILD_RECIPES[selectedKind];
    if (!active) {
      return {
        ok: false,
        reason: 'inactive',
        kind: selectedKind,
        cost: recipe.cost,
        x: ghostX,
        y: ghostY,
        z: ghostZ,
      };
    }
    const liveValidation = computePlacementValidation(
      selectedKind,
      ghostX,
      ghostY,
      ghostZ,
      ghostSnappedOnDeck,
    );
    if (!ghostValid || liveValidation !== undefined || pieces.length >= MAX_BUILD_PIECES) {
      ghostFailReason = liveValidation ?? ghostFailReason ?? 'blocked';
      ghostValid = false;
      return {
        ok: false,
        reason: ghostFailReason,
        kind: selectedKind,
        cost: recipe.cost,
        x: ghostX,
        y: ghostY,
        z: ghostZ,
      };
    }
    if (!hasResources(recipe.cost)) {
      return {
        ok: false,
        reason: 'resources',
        kind: selectedKind,
        cost: recipe.cost,
        x: ghostX,
        y: ghostY,
        z: ghostZ,
      };
    }

    const id = `bp_${nextPieceSeq}`;
    nextPieceSeq += 1;
    createPlacedPiece(id, selectedKind, ghostX, ghostY, ghostZ, ghostYaw, false);
    // Invalidate cached ghost immediately so rapid double-clicks never stack duplicates before next frame
    ghostValid = false;
    ghostFailReason = 'overlap';

    return {
      ok: true,
      id,
      kind: selectedKind,
      cost: recipe.cost,
      x: ghostX,
      y: ghostY,
      z: ghostZ,
    };
  }

  function tryDismantleLookedAt(
    originX: number,
    originY: number,
    originZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
  ): DismantleResult {
    const len = Math.hypot(aimX, aimY, aimZ) || 1;
    const dx = aimX / len;
    const dy = aimY / len;
    const dz = aimZ / len;

    let bestIdx = -1;
    let bestT = 9.0;

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      const centerOffsetY = getPieceCenterOffsetY(p.kind);
      const hitRadius =
        p.kind === 'foundation' || p.kind === 'upper_floor' || p.kind === 'roof' || p.kind === 'stairs'
          ? 1.75
          : isWallEdgeKind(p.kind)
            ? 1.55
            : p.kind === 'storage'
              ? 0.9
              : 1.2;

      const ox = p.x - originX;
      const oy = p.y + centerOffsetY - originY;
      const oz = p.z - originZ;
      const t = ox * dx + oy * dy + oz * dz;
      if (t < 2.2 || t > bestT) {
        continue;
      }
      const perpX = ox - dx * t;
      const perpY = oy - dy * t;
      const perpZ = oz - dz * t;
      const perpSq = perpX * perpX + perpY * perpY + perpZ * perpZ;
      if (perpSq <= hitRadius * hitRadius) {
        bestT = t;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) {
      return { ok: false };
    }

    const removed = removePieceAtIndex(bestIdx);
    if (!removed) {
      return { ok: false };
    }

    const recipe = BUILD_RECIPES[removed.kind];
    const woodRefund = recipe.cost.wood ? Math.ceil(recipe.cost.wood * 0.5) : 0;
    const stoneRefund = recipe.cost.stone ? Math.ceil(recipe.cost.stone * 0.5) : 0;
    const scrapRefund = recipe.cost.scrap ? Math.ceil(recipe.cost.scrap * 0.5) : 0;

    return {
      ok: true,
      kind: removed.kind,
      label: recipe.label,
      refund: {
        wood: woodRefund > 0 ? woodRefund : undefined,
        stone: stoneRefund > 0 ? stoneRefund : undefined,
        scrap: scrapRefund > 0 ? scrapRefund : undefined,
      },
    };
  }

  function toggleDoor(id: string): boolean | null {
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.id !== id || p.kind !== 'doorway') {
        continue;
      }
      p.doorOpen = !p.doorOpen;
      if (p.doorClosedObstacle) {
        if (p.doorOpen) {
          removeObstacleTracked(p.doorClosedObstacle);
        } else if (!builtObstacles.has(p.doorClosedObstacle)) {
          obstacles.push(p.doorClosedObstacle);
          builtObstacles.add(p.doorClosedObstacle);
        }
      }
      return p.doorOpen;
    }
    return null;
  }

  function getInteractTarget(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    playerY?: number,
  ): BuildInteractTarget | null {
    const fLen = Math.hypot(fwdX, fwdZ) || 1;
    const nx = fwdX / fLen;
    const nz = fwdZ / fLen;

    let bestPiece: PlacedBuildPiece | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || (p.kind !== 'doorway' && p.kind !== 'workbench' && p.kind !== 'storage')) {
        continue;
      }
      if (playerY !== undefined && Math.abs(p.y - playerY) > 1.8) {
        continue;
      }
      const dx = p.x - playerX;
      const dz = p.z - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = p.kind === 'doorway' ? 2.55 : 2.65;
      if (dist > maxDist) {
        continue;
      }
      const dot = dist > 1e-4 ? (dx * nx + dz * nz) / dist : 1;
      if (dot < 0.1) {
        continue;
      }
      const score = dist - dot * 0.6;
      if (score < bestScore) {
        bestScore = score;
        bestPiece = p;
      }
    }

    if (!bestPiece) {
      return null;
    }
    scratchInteractTarget.id = bestPiece.id;
    scratchInteractTarget.x = bestPiece.x;
    scratchInteractTarget.z = bestPiece.z;
    if (bestPiece.kind === 'doorway') {
      scratchInteractTarget.kind = 'door';
      scratchInteractTarget.label = bestPiece.doorOpen ? 'Close Door' : 'Open Door';
      scratchInteractTarget.doorOpen = bestPiece.doorOpen;
      return scratchInteractTarget;
    }
    scratchInteractTarget.doorOpen = undefined;
    if (bestPiece.kind === 'workbench') {
      scratchInteractTarget.kind = 'workbench';
      scratchInteractTarget.label = 'Craft at Workbench';
      return scratchInteractTarget;
    }
    scratchInteractTarget.kind = 'storage';
    scratchInteractTarget.label = 'Stash / Take Supplies';
    return scratchInteractTarget;
  }

  function damageStructure(id: string, amount: number): StructureDamageResult {
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        hit: false,
        destroyed: false,
        remainingHp: 0,
        maxHp: 0,
        x: 0,
        y: 0,
        z: 0,
      };
    }

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.id !== id) {
        continue;
      }
      const label = BUILD_RECIPES[p.kind].label;
      const hitY = p.y + getPieceCenterOffsetY(p.kind);
      p.hp = Math.max(0, p.hp - amount);

      if (p.hp <= 0) {
        const px = p.x;
        const py = p.y;
        const pz = p.z;
        const pKind = p.kind;
        const pMaxHp = p.maxHp;
        removePieceAtIndex(i);
        spawnBurst(px, hitY, pz, 0x8f6642, 1.35);
        return {
          hit: true,
          destroyed: true,
          kind: pKind,
          label,
          remainingHp: 0,
          maxHp: pMaxHp,
          x: px,
          y: py,
          z: pz,
        };
      }

      p.shakeTimer = 0.24;
      syncPieceWearVisuals(p);
      spawnBurst(p.x, hitY, p.z, 0xa87d52, 0.9);
      return {
        hit: true,
        destroyed: false,
        kind: p.kind,
        label,
        remainingHp: p.hp,
        maxHp: p.maxHp,
        x: p.x,
        y: p.y,
        z: p.z,
      };
    }

    return {
      hit: false,
      destroyed: false,
      remainingHp: 0,
      maxHp: 0,
      x: 0,
      y: 0,
      z: 0,
    };
  }

  function checkSpikeHit(x: number, z: number, radius: number, actorY?: number): boolean {
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.kind !== 'spikes') {
        continue;
      }
      if (actorY !== undefined && Math.abs(p.y - actorY) > 1.6) {
        continue;
      }
      const relX = x - p.x;
      const relZ = z - p.z;
      const lx = relX * p.cos - relZ * p.sin;
      const lz = relX * p.sin + relZ * p.cos;
      if (Math.abs(lx) <= 1.28 + radius && Math.abs(lz) <= 0.42 + radius) {
        damageStructure(p.id, SPIKE_TRIGGER_WEAR);
        return true;
      }
    }
    return false;
  }

  function getBaseAnchor(out: Vec2Like): boolean {
    if (pieces.length < 2) {
      return false;
    }
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (p) {
        sumX += p.x;
        sumZ += p.z;
      }
    }
    out.x = sumX / pieces.length;
    out.z = sumZ / pieces.length;
    return true;
  }

  function findNearestAttackableStructure(
    x: number,
    z: number,
    maxRange: number,
    out: StructureTargetProbe,
    actorY?: number,
  ): boolean {
    let bestPiece: PlacedBuildPiece | null = null;
    let bestDistSq = maxRange * maxRange;

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      // Filter ALL piece kinds against vertical melee reach so ground units never target 2nd-story structures
      const refY = actorY !== undefined ? actorY : getTerrainHeight(p.x, p.z);
      if (p.y > refY + 1.8) {
        continue;
      }
      if (actorY !== undefined && p.y + getPieceCenterOffsetY(p.kind) < actorY - 0.6) {
        continue;
      }
      const dx = p.x - x;
      const dz = p.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        bestPiece = p;
      }
    }

    if (!bestPiece) {
      return false;
    }
    out.id = bestPiece.id;
    out.kind = bestPiece.kind;
    out.x = bestPiece.x;
    out.y = bestPiece.y;
    out.z = bestPiece.z;
    out.radius = getStructureAttackRadius(bestPiece.kind);
    return true;
  }

  function findBestRepairPiece(
    playerX: number,
    playerY: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): PlacedBuildPiece | null {
    const fLen = Math.hypot(fwdX, fwdZ) || 1;
    const nx = fwdX / fLen;
    const nz = fwdZ / fLen;

    let bestPiece: PlacedBuildPiece | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.hp >= p.maxHp) {
        continue;
      }
      const dx = p.x - playerX;
      const dz = p.z - playerZ;
      const dist = Math.hypot(dx, dz);
      if (dist > 3.3) {
        continue;
      }
      const centerY = p.y + getPieceCenterOffsetY(p.kind);
      if (Math.abs(centerY - (playerY + 1.0)) > 3.4) {
        continue;
      }
      const dot = dist > 1e-4 ? (dx * nx + dz * nz) / dist : 1;
      if (dist > 1.35 && dot < 0.15) {
        continue;
      }
      const score = dist - dot * 0.7;
      if (score < bestScore) {
        bestScore = score;
        bestPiece = p;
      }
    }
    return bestPiece;
  }

  function getRepairTarget(
    playerX: number,
    playerY: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): BuildRepairTarget | null {
    const bestPiece = findBestRepairPiece(playerX, playerY, playerZ, fwdX, fwdZ);
    if (!bestPiece) {
      return null;
    }
    scratchRepairTarget.id = bestPiece.id;
    scratchRepairTarget.kind = bestPiece.kind;
    scratchRepairTarget.label = BUILD_RECIPES[bestPiece.kind].label;
    scratchRepairTarget.hp = bestPiece.hp;
    scratchRepairTarget.maxHp = bestPiece.maxHp;
    scratchRepairTarget.x = bestPiece.x;
    scratchRepairTarget.y = bestPiece.y;
    scratchRepairTarget.z = bestPiece.z;
    return scratchRepairTarget;
  }

  function tryRepairStructure(
    playerX: number,
    playerY: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    survival: SurvivalState,
  ): BuildRepairResult {
    const target = findBestRepairPiece(playerX, playerY, playerZ, fwdX, fwdZ);
    if (!target) {
      return { ok: false, reason: 'none' };
    }
    const label = BUILD_RECIPES[target.kind].label;
    if (!survival.spendResources(REPAIR_WOOD_COST)) {
      return {
        ok: false,
        reason: 'resources',
        id: target.id,
        kind: target.kind,
        label,
        hp: target.hp,
        maxHp: target.maxHp,
        x: target.x,
        y: target.y,
        z: target.z,
      };
    }

    target.hp = Math.min(target.maxHp, target.hp + REPAIR_HP_GAIN);
    target.shakeTimer = 0;
    syncPieceWearVisuals(target);
    spawnBurst(target.x, target.y + getPieceCenterOffsetY(target.kind), target.z, 0xf4c561, 0.85);
    return {
      ok: true,
      id: target.id,
      kind: target.kind,
      label,
      hp: target.hp,
      maxHp: target.maxHp,
      x: target.x,
      y: target.y,
      z: target.z,
    };
  }

  function depositOrWithdrawStorage(survival: SurvivalState): StorageTransferResult {
    const inv = survival.inventory;

    // 1. If survivor is missing emergency consumables and crate has them, withdraw 1 of each needed item
    const withdrawRations = inv.rations === 0 && storageStash.rations > 0 ? 1 : 0;
    const withdrawMedkits = inv.medkits === 0 && storageStash.medkits > 0 ? 1 : 0;
    const withdrawWarmers = inv.warmers === 0 && storageStash.warmers > 0 ? 1 : 0;
    const withdrawBottles = inv.bottles === 0 && storageStash.bottles > 0 ? 1 : 0;
    if (withdrawRations + withdrawMedkits + withdrawWarmers + withdrawBottles > 0) {
      storageStash.rations -= withdrawRations;
      storageStash.medkits -= withdrawMedkits;
      storageStash.warmers -= withdrawWarmers;
      storageStash.bottles -= withdrawBottles;
      survival.addLoot({
        rations: withdrawRations,
        medkits: withdrawMedkits,
        warmers: withdrawWarmers,
        bottles: withdrawBottles,
      });
      const parts: string[] = [];
      if (withdrawRations) parts.push('+1 Ration');
      if (withdrawMedkits) parts.push('+1 Medkit');
      if (withdrawWarmers) parts.push('+1 Warmer');
      if (withdrawBottles) parts.push('+1 Bottle');
      return { action: 'withdrew', summary: `Took from Crate · ${parts.join(' · ')}` };
    }

    // 2. Deposit spare materials & surplus supplies while keeping 1 emergency consumable on survivor
    const depWood = inv.wood >= 4 ? Math.min(4, Math.floor(inv.wood * 0.5)) : inv.wood > 0 ? inv.wood : 0;
    const depStone = inv.stone >= 4 ? Math.min(4, Math.floor(inv.stone * 0.5)) : inv.stone > 0 ? inv.stone : 0;
    const depScrap = inv.scrap >= 2 ? Math.min(2, Math.floor(inv.scrap * 0.5)) : 0;
    const depRations = inv.rations > 1 ? 1 : 0;
    const depMedkits = inv.medkits > 1 ? 1 : 0;
    const depWarmers = inv.warmers > 1 ? 1 : 0;
    const depBottles = inv.bottles > 2 ? 1 : 0;

    if (depWood + depStone + depScrap + depRations + depMedkits + depWarmers + depBottles > 0) {
      const bundle: LootBundle = {
        wood: depWood,
        stone: depStone,
        scrap: depScrap,
        rations: depRations,
        medkits: depMedkits,
        warmers: depWarmers,
        bottles: depBottles,
      };
      if (survival.takeInventory(bundle)) {
        storageStash.wood += depWood;
        storageStash.stone += depStone;
        storageStash.scrap += depScrap;
        storageStash.rations += depRations;
        storageStash.medkits += depMedkits;
        storageStash.warmers += depWarmers;
        storageStash.bottles += depBottles;
        const parts: string[] = [];
        if (depWood) parts.push(`${depWood} Wood`);
        if (depStone) parts.push(`${depStone} Stone`);
        if (depScrap) parts.push(`${depScrap} Scrap`);
        if (depRations) parts.push(`${depRations} Ration`);
        if (depMedkits) parts.push(`${depMedkits} Medkit`);
        if (depWarmers) parts.push(`${depWarmers} Warmer`);
        if (depBottles) parts.push(`${depBottles} Bottle`);
        return { action: 'deposited', summary: `Stashed in Crate · ${parts.join(' · ')}` };
      }
    }

    // 3. Otherwise withdraw all stored items back to survivor
    const totalStored =
      storageStash.wood +
      storageStash.stone +
      storageStash.scrap +
      storageStash.rations +
      storageStash.medkits +
      storageStash.warmers +
      storageStash.bottles;
    if (totalStored > 0) {
      const taken: LootBundle = {
        wood: storageStash.wood,
        stone: storageStash.stone,
        scrap: storageStash.scrap,
        rations: storageStash.rations,
        medkits: storageStash.medkits,
        warmers: storageStash.warmers,
        bottles: storageStash.bottles,
      };
      survival.addLoot(taken);
      const parts: string[] = [];
      if (storageStash.wood) parts.push(`+${storageStash.wood} Wood`);
      if (storageStash.stone) parts.push(`+${storageStash.stone} Stone`);
      if (storageStash.scrap) parts.push(`+${storageStash.scrap} Scrap`);
      if (storageStash.rations) parts.push(`+${storageStash.rations} Ration`);
      if (storageStash.medkits) parts.push(`+${storageStash.medkits} Medkit`);
      if (storageStash.warmers) parts.push(`+${storageStash.warmers} Warmer`);
      if (storageStash.bottles) parts.push(`+${storageStash.bottles} Bottle`);
      storageStash.wood = 0;
      storageStash.stone = 0;
      storageStash.scrap = 0;
      storageStash.rations = 0;
      storageStash.medkits = 0;
      storageStash.warmers = 0;
      storageStash.bottles = 0;
      return { action: 'withdrew', summary: `Retrieved Crate · ${parts.join(' · ')}` };
    }

    return { action: 'empty', summary: 'Storage Crate Empty' };
  }

  function update(dt: number): void {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    const rate = Math.min(1, safeDt * 11);

    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      if (p.doorPivot) {
        const targetAngle = p.doorOpen ? 1.55 : 0;
        if (Math.abs(p.doorAngle - targetAngle) > 0.002) {
          p.doorAngle += (targetAngle - p.doorAngle) * rate;
          p.doorPivot.rotation.y = p.doorAngle;
        } else if (p.doorAngle !== targetAngle) {
          p.doorAngle = targetAngle;
          p.doorPivot.rotation.y = targetAngle;
        }
      }
      if (p.shakeTimer > 0) {
        p.shakeTimer = Math.max(0, p.shakeTimer - safeDt);
        const baseLean = getPieceBaseLean(p);
        if (p.shakeTimer > 0) {
          const decay = p.shakeTimer / 0.24;
          const vib = Math.sin(p.shakeTimer * 78) * 0.032 * decay;
          p.group.rotation.z = baseLean + vib;
          p.group.rotation.x = Math.cos(p.shakeTimer * 62) * 0.018 * decay;
        } else {
          p.group.rotation.z = baseLean;
          p.group.rotation.x = 0;
        }
      }
    }

    for (let s = 0; s < burstSlots.length; s += 1) {
      const slot = burstSlots[s];
      if (!slot || !slot.active) {
        continue;
      }
      slot.age += safeDt;
      if (slot.age >= slot.duration) {
        slot.active = false;
        slot.points.visible = false;
        slot.mat.opacity = 0;
        continue;
      }
      for (let i = 0; i < BURST_PARTICLES_PER_SLOT; i += 1) {
        const idx = i * 3;
        const vy = (slot.velocities[idx + 1] ?? 0) - 9.8 * safeDt;
        slot.velocities[idx + 1] = vy;
        slot.positions[idx] = (slot.positions[idx] ?? 0) + (slot.velocities[idx] ?? 0) * safeDt;
        slot.positions[idx + 1] = (slot.positions[idx + 1] ?? 0) + vy * safeDt;
        slot.positions[idx + 2] =
          (slot.positions[idx + 2] ?? 0) + (slot.velocities[idx + 2] ?? 0) * safeDt;
      }
      slot.mat.opacity = (1 - slot.age / slot.duration) * 0.92;
      slot.posAttr.needsUpdate = true;
    }
  }

  function clearAllPieces(): void {
    for (let i = pieces.length - 1; i >= 0; i -= 1) {
      removePieceAtIndex(i);
    }
    for (let s = 0; s < burstSlots.length; s += 1) {
      const slot = burstSlots[s];
      if (slot) {
        slot.active = false;
        slot.points.visible = false;
        slot.mat.opacity = 0;
      }
    }
    nextPieceSeq = 1;
    storageStash.wood = 0;
    storageStash.stone = 0;
    storageStash.scrap = 0;
    storageStash.rations = 0;
    storageStash.medkits = 0;
    storageStash.warmers = 0;
    storageStash.bottles = 0;
  }

  function serialize(): {
    readonly pieces: SavedBuildPiece[];
    readonly stash: Readonly<StorageStash>;
  } {
    const savedPieces: SavedBuildPiece[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p) {
        continue;
      }
      const hpField = p.hp < p.maxHp ? { hp: Math.max(1, Math.round(p.hp)) } : {};
      savedPieces.push(
        p.kind === 'doorway'
          ? {
              id: p.id,
              kind: p.kind,
              x: p.x,
              y: p.y,
              z: p.z,
              yaw: p.yaw,
              doorOpen: p.doorOpen,
              ...hpField,
            }
          : {
              id: p.id,
              kind: p.kind,
              x: p.x,
              y: p.y,
              z: p.z,
              yaw: p.yaw,
              ...hpField,
            },
      );
    }
    return {
      pieces: savedPieces,
      stash: { ...storageStash },
    };
  }

  function hydrate(savedPieces: readonly SavedBuildPiece[], stash?: Partial<StorageStash>): void {
    clearAllPieces();
    const limit = Math.min(savedPieces.length, MAX_BUILD_PIECES);
    let maxSeq = 0;
    for (let i = 0; i < limit; i += 1) {
      const sp = savedPieces[i];
      if (
        !sp ||
        !isValidPieceKind(sp.kind) ||
        !Number.isFinite(sp.x) ||
        !Number.isFinite(sp.y) ||
        !Number.isFinite(sp.z) ||
        !Number.isFinite(sp.yaw)
      ) {
        continue;
      }
      const id = typeof sp.id === 'string' && sp.id.length > 0 ? sp.id : `bp_${i + 1}`;
      const match = /^bp_(\d+)$/.exec(id);
      if (match && match[1]) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > maxSeq) {
          maxSeq = parsed;
        }
      }
      createPlacedPiece(id, sp.kind, sp.x, sp.y, sp.z, sp.yaw, sp.doorOpen === true, sp.hp);
    }
    nextPieceSeq = Math.max(maxSeq + 1, pieces.length + 1);

    if (stash) {
      storageStash.wood = sanitizeCount(stash.wood);
      storageStash.stone = sanitizeCount(stash.stone);
      storageStash.scrap = sanitizeCount(stash.scrap);
      storageStash.rations = sanitizeCount(stash.rations);
      storageStash.medkits = sanitizeCount(stash.medkits);
      storageStash.warmers = sanitizeCount(stash.warmers);
      storageStash.bottles = sanitizeCount(stash.bottles);
    }
  }

  function reset(): void {
    active = false;
    selectedKind = 'foundation';
    userYaw = 0;
    ghostValid = false;
    ghostFailReason = undefined;
    syncGhostVisibility();
    clearAllPieces();
  }

  function dispose(): void {
    clearAllPieces();
    for (let i = 0; i < ownedGeos.length; i += 1) {
      ownedGeos[i]?.dispose();
    }
    for (let i = 0; i < ownedMats.length; i += 1) {
      ownedMats[i]?.dispose();
    }
    root.clear();
  }

  return {
    root,
    isActive(): boolean {
      return active;
    },
    setActive(nextActive: boolean): void {
      active = nextActive;
      ghostValid = false;
      syncGhostVisibility();
    },
    getSelectedKind(): BuildPieceKind {
      return selectedKind;
    },
    setSelectedKind(kind: BuildPieceKind): void {
      selectedKind = kind;
      ghostValid = false;
      syncGhostVisibility();
    },
    cycleSelectedKind(delta: number): BuildPieceKind {
      const idx = BUILD_PIECE_ORDER.indexOf(selectedKind);
      const len = BUILD_PIECE_ORDER.length;
      const nextIdx = (((idx >= 0 ? idx : 0) + (delta >= 0 ? 1 : -1)) % len + len) % len;
      const next = BUILD_PIECE_ORDER[nextIdx];
      if (next) {
        selectedKind = next;
      }
      ghostValid = false;
      syncGhostVisibility();
      return selectedKind;
    },
    rotateGhost(stepRad = Math.PI * 0.25): void {
      userYaw = (userYaw + stepRad) % (Math.PI * 2);
      ghostValid = false;
    },
    updateGhost,
    tryPlaceCurrent,
    tryDismantleLookedAt,
    toggleDoor,
    getFloorHeightAt,
    isInsideBuiltShelter,
    checkArrowStructureHit,
    getInteractTarget,
    checkSpikeHit,
    getBaseAnchor,
    findNearestAttackableStructure,
    damageStructure,
    getRepairTarget,
    tryRepairStructure,
    getStorageStash(): Readonly<StorageStash> {
      return storageStash;
    },
    depositOrWithdrawStorage,
    getPieceCount(): number {
      return pieces.length;
    },
    update,
    serialize,
    hydrate,
    reset,
    dispose,
  };
}
