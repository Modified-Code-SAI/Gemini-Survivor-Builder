import * as THREE from 'three';
import {
  clamp,
  createObbObstacle,
  getTerrainHeight,
  WORLD_BOUNDS,
  type Obstacle,
  type ObstacleObb,
} from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import type { LootBundle, ResourceCost, SurvivalState } from './survival';

export type BuildPieceKind =
  | 'foundation'
  | 'wall'
  | 'doorway'
  | 'roof'
  | 'spikes'
  | 'storage'
  | 'workbench';

export const BUILD_PIECE_ORDER: readonly BuildPieceKind[] = [
  'foundation',
  'wall',
  'doorway',
  'roof',
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

export const PIECE_SIZE = 3.0;
export const WALL_HEIGHT = 2.8;
export const FOUNDATION_DECK_THICKNESS = 0.24;
export const MAX_BUILD_PIECES = 64;

const SNAP_RADIUS = 2.4;
const HALF_PIECE = PIECE_SIZE * 0.5;

export interface SavedBuildPiece {
  readonly id: string;
  readonly kind: BuildPieceKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly doorOpen?: boolean;
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
  getFloorHeightAt(x: number, z: number): number | null;
  isInsideBuiltShelter(x: number, z: number): boolean;
  getInteractTarget(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
  ): BuildInteractTarget | null;
  checkSpikeHit(x: number, z: number, radius: number): boolean;
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
  doorOpen: boolean;
  doorAngle: number;
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
    kind === 'doorway' ||
    kind === 'roof' ||
    kind === 'spikes' ||
    kind === 'storage' ||
    kind === 'workbench'
  );
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

  // Shared PBR timber, stone, iron & ghost preview materials
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
  // Foundation (3.0 x 0.24 x 3.0 deck + 4 deep slope piers)
  const deckGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, FOUNDATION_DECK_THICKNESS, PIECE_SIZE));
  const deckBeamGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE + 0.04, 0.14, 0.14));
  const pierGeo = trackGeo(new THREE.BoxGeometry(0.28, 2.6, 0.28));
  const pierFootingGeo = trackGeo(new THREE.BoxGeometry(0.38, 0.3, 0.38));

  // Wall (3.0 x 2.8 x 0.22)
  const wallPanelGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, WALL_HEIGHT, 0.18));
  const wallPostGeo = trackGeo(new THREE.BoxGeometry(0.22, WALL_HEIGHT, 0.24));
  const wallRailGeo = trackGeo(new THREE.BoxGeometry(PIECE_SIZE, 0.16, 0.24));
  const wallBraceGeo = trackGeo(new THREE.BoxGeometry(0.14, 3.2, 0.12));

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

  function populatePieceVisuals(
    group: THREE.Group,
    kind: BuildPieceKind,
    isGhost: boolean,
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

    if (kind === 'wall') {
      addMesh(wallPanelGeo, mainWood, 0, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, -HALF_PIECE + 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallPostGeo, frameWood, HALF_PIECE - 0.11, WALL_HEIGHT * 0.5, 0);
      addMesh(wallRailGeo, frameWood, 0, 0.08, 0);
      addMesh(wallRailGeo, frameWood, 0, WALL_HEIGHT - 0.08, 0);
      addMesh(wallBraceGeo, frameWood, 0, WALL_HEIGHT * 0.5, 0.04, 0, 0, 0.78);
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
    doorway: new THREE.Group(),
    roof: new THREE.Group(),
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

  // Live pre-allocated ghost & interaction state (ZERO per-frame object allocations!)
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
      if (
        (kind === 'wall' || kind === 'doorway') &&
        (p.kind === 'wall' || p.kind === 'doorway') &&
        dXZ < 0.55 &&
        dY < 0.8
      ) {
        return true;
      }
      if (kind === 'roof' && p.kind === 'roof' && dXZ < 1.1 && dY < 0.8) {
        return true;
      }
      if (
        (kind === 'spikes' || kind === 'storage' || kind === 'workbench') &&
        (p.kind === 'spikes' || p.kind === 'storage' || p.kind === 'workbench') &&
        dXZ < 0.95 &&
        dY < 0.9
      ) {
        return true;
      }
      if (
        (kind === 'storage' || kind === 'workbench' || kind === 'spikes') &&
        (p.kind === 'wall' || p.kind === 'doorway') &&
        dXZ < 0.55 &&
        dY < 1.2
      ) {
        return true;
      }
    }
    return false;
  }

  function getFloorHeightAt(x: number, z: number): number | null {
    let bestY: number | null = null;
    const halfSpan = HALF_PIECE + 0.08;
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.kind !== 'foundation') {
        continue;
      }
      const relX = x - p.x;
      const relZ = z - p.z;
      const lx = relX * p.cos - relZ * p.sin;
      const lz = relX * p.sin + relZ * p.cos;
      if (Math.abs(lx) <= halfSpan && Math.abs(lz) <= halfSpan) {
        const deckTop = p.y + FOUNDATION_DECK_THICKNESS;
        if (bestY === null || deckTop > bestY) {
          bestY = deckTop;
        }
      }
    }
    return bestY;
  }

  function isInsideBuiltShelter(x: number, z: number): boolean {
    const halfSpan = HALF_PIECE + 0.15;
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.kind !== 'roof') {
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
    if (kind !== 'roof' && !onFoundationDeck && isInsidePuddle(x, z)) {
      return 'puddle';
    }
    const probeRadius =
      kind === 'foundation' ? 0.85 : kind === 'roof' ? 0.6 : 0.45;
    const obbOnly = kind === 'roof';
    if (isCircleBlockedByWorldObstacles(x, z, probeRadius, obstacles, builtObstacles, obbOnly)) {
      return 'blocked';
    }
    return undefined;
  }

  function updateGhost(
    playerX: number,
    _playerY: number,
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
        // Check all 4 edge-adjacent snap bays around existing foundation
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
    } else if (selectedKind === 'wall' || selectedKind === 'doorway') {
      // Single-story solid snapping to all 4 outer foundation edges (never floats a wall over an open doorway)
      let bestDist = SNAP_RADIUS;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || p.kind !== 'foundation') {
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
          if (dXZ < bestDist && !hasDuplicateOverlap(selectedKind, cx, wallY, cz)) {
            bestDist = dXZ;
            bestX = cx;
            bestY = wallY;
            bestZ = cz;
            bestYaw = edgeYaw;
            snappedOnDeck = true;
          }
        }
      }
    } else if (selectedKind === 'roof') {
      bestY = groundY + WALL_HEIGHT;
      let bestDist = SNAP_RADIUS + 0.6;
      let snappedRoof = false;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[i];
        if (!p || p.kind !== 'foundation') {
          continue;
        }
        const roofY = p.y + FOUNDATION_DECK_THICKNESS + WALL_HEIGHT;
        const d = Math.hypot(p.x - rawX, p.z - rawZ);
        if (d < bestDist && !hasDuplicateOverlap('roof', p.x, roofY, p.z)) {
          bestDist = d;
          bestX = p.x;
          bestY = roofY;
          bestZ = p.z;
          bestYaw = p.yaw;
          snappedOnDeck = true;
          snappedRoof = true;
        }
      }
      // Fallback: snap roof onto freestanding wall/doorway top offset inward along its local Z normal
      if (!snappedRoof) {
        for (let i = 0; i < pieces.length; i += 1) {
          const p = pieces[i];
          if (!p || (p.kind !== 'wall' && p.kind !== 'doorway')) {
            continue;
          }
          const roofY = p.y + WALL_HEIGHT;
          for (let side = -1; side <= 1; side += 2) {
            const cx = p.x + side * HALF_PIECE * p.sin;
            const cz = p.z + side * HALF_PIECE * p.cos;
            const d = Math.hypot(cx - rawX, cz - rawZ);
            if (d < bestDist && !hasDuplicateOverlap('roof', cx, roofY, cz)) {
              bestDist = d;
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
      // Spikes, Storage Crate, Workbench: seat cleanly onto elevated foundation decks (never buried under terrain slopes)
      const floorY = getFloorHeightAt(rawX, rawZ);
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
  ): PlacedBuildPiece {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    const doorPivot = populatePieceVisuals(group, kind, false);
    root.add(group);

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const addedObstacles: Obstacle[] = [];
    let doorClosedObstacle: ObstacleObb | null = null;

    if (kind === 'wall') {
      addObstacleTracked(createObbObstacle(x, z, PIECE_SIZE - 0.08, 0.28, yaw), addedObstacles);
    } else if (kind === 'doorway') {
      // Left & right structural wall jambs stay solid; center door obstacle toggles open/closed!
      const lxLeft = -1.05;
      const lxRight = 1.05;
      addObstacleTracked(
        createObbObstacle(x + lxLeft * cos, z - lxLeft * sin, 0.88, 0.28, yaw),
        addedObstacles,
      );
      addObstacleTracked(
        createObbObstacle(x + lxRight * cos, z - lxRight * sin, 0.88, 0.28, yaw),
        addedObstacles,
      );
      doorClosedObstacle = createObbObstacle(x, z, 1.24, 0.24, yaw);
      if (!initialDoorOpen) {
        obstacles.push(doorClosedObstacle);
        builtObstacles.add(doorClosedObstacle);
      }
      if (doorPivot) {
        doorPivot.rotation.y = initialDoorOpen ? 1.55 : 0;
      }
    } else if (kind === 'spikes') {
      addObstacleTracked(createObbObstacle(x, z, 2.35, 0.56, yaw), addedObstacles);
    } else if (kind === 'storage') {
      addObstacleTracked(createObbObstacle(x, z, 1.16, 0.68, yaw), addedObstacles);
    } else if (kind === 'workbench') {
      addObstacleTracked(createObbObstacle(x, z, 1.66, 0.78, yaw), addedObstacles);
    }

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
      doorOpen: initialDoorOpen,
      doorAngle: initialDoorOpen ? 1.55 : 0,
    };
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
      const centerOffsetY =
        p.kind === 'wall' || p.kind === 'doorway'
          ? WALL_HEIGHT * 0.5
          : p.kind === 'foundation' || p.kind === 'roof'
            ? 0.12
            : 0.55;
      const hitRadius =
        p.kind === 'foundation' || p.kind === 'roof'
          ? 1.75
          : p.kind === 'wall' || p.kind === 'doorway'
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

  function checkSpikeHit(x: number, z: number, radius: number): boolean {
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || p.kind !== 'spikes') {
        continue;
      }
      const relX = x - p.x;
      const relZ = z - p.z;
      const lx = relX * p.cos - relZ * p.sin;
      const lz = relX * p.sin + relZ * p.cos;
      if (Math.abs(lx) <= 1.28 + radius && Math.abs(lz) <= 0.42 + radius) {
        return true;
      }
    }
    return false;
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
    const rate = Math.min(1, dt * 11);
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      if (!p || !p.doorPivot) {
        continue;
      }
      const targetAngle = p.doorOpen ? 1.55 : 0;
      if (Math.abs(p.doorAngle - targetAngle) > 0.002) {
        p.doorAngle += (targetAngle - p.doorAngle) * rate;
        p.doorPivot.rotation.y = p.doorAngle;
      } else if (p.doorAngle !== targetAngle) {
        p.doorAngle = targetAngle;
        p.doorPivot.rotation.y = targetAngle;
      }
    }
  }

  function clearAllPieces(): void {
    for (let i = pieces.length - 1; i >= 0; i -= 1) {
      removePieceAtIndex(i);
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
      savedPieces.push(
        p.kind === 'doorway'
          ? { id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw, doorOpen: p.doorOpen }
          : { id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw },
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
      createPlacedPiece(id, sp.kind, sp.x, sp.y, sp.z, sp.yaw, sp.doorOpen === true);
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
    getInteractTarget,
    checkSpikeHit,
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
