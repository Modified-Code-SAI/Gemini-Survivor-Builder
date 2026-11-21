import * as THREE from 'three';
import type { ChoppableForestController, ChoppableTreeTarget } from '../world/environment';
import { getTerrainHeight, type Obstacle } from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import type { LootBundle } from './survival';

export type EquippedTool = 'axe' | 'pickaxe' | 'fists' | 'bow' | 'hammer';
export type HarvestNodeKind = 'tree' | 'rock';

export interface HarvestNodeSpec {
  readonly id: string;
  readonly kind: HarvestNodeKind;
  readonly x: number;
  readonly z: number;
  readonly scale: number;
  readonly rotY: number;
}

export interface HarvestHitResult {
  readonly hit: boolean;
  readonly wrongTool: boolean;
  readonly neededTool?: 'axe' | 'pickaxe';
  readonly kind?: HarvestNodeKind;
  readonly depleted: boolean;
  readonly loot?: LootBundle;
  readonly hitX: number;
  readonly hitZ: number;
}

export interface HarvestSystemOptions {
  readonly obstacles: Obstacle[];
  readonly forest?: ChoppableForestController;
}

export interface HarvestSystem {
  readonly root: THREE.Group;
  tryHarvestHit(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    tool: EquippedTool,
    reinforced?: boolean,
  ): HarvestHitResult;
  getCounts(): {
    readonly remainingTrees: number;
    readonly remainingRocks: number;
    readonly total: number;
  };
  serializeDepletedIds(): string[];
  hydrateDepletedIds(ids: readonly string[]): void;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export const HARVEST_ROCK_SPECS: readonly HarvestNodeSpec[] = [
  // 10 Harvestable Mossy Stone Outcrops (3 hits -> 2 + 2 + (5 Stone + 1 Scrap) = 9 Stone + 1 Scrap)
  { id: 'rock_overlook_w1', kind: 'rock', x: -9.4, z: 12.6, scale: 1.0, rotY: 0.8 },
  { id: 'rock_overlook_e1', kind: 'rock', x: 10.8, z: 9.2, scale: 0.95, rotY: 2.2 },
  { id: 'rock_bunker_sw', kind: 'rock', x: -18.6, z: 9.8, scale: 1.08, rotY: 3.5 },
  { id: 'rock_bunker_nw', kind: 'rock', x: -12.2, z: -1.8, scale: 0.94, rotY: 1.4 },
  { id: 'rock_mid_w1', kind: 'rock', x: -15.2, z: -11.4, scale: 1.04, rotY: 4.8 },
  { id: 'rock_east_s1', kind: 'rock', x: 14.8, z: 2.4, scale: 0.96, rotY: 5.5 },
  { id: 'rock_gas_e1', kind: 'rock', x: 19.6, z: -12.8, scale: 1.1, rotY: 0.3 },
  { id: 'rock_valley_w1', kind: 'rock', x: -13.8, z: -22.8, scale: 1.0, rotY: 2.9 },
  { id: 'rock_valley_e1', kind: 'rock', x: 11.4, z: -22.4, scale: 1.05, rotY: 3.7 },
  { id: 'rock_north_w1', kind: 'rock', x: -10.2, z: -32.6, scale: 1.02, rotY: 1.1 },
];

export const HARVEST_NODE_SPECS: readonly HarvestNodeSpec[] = HARVEST_ROCK_SPECS;

const MAX_HITS_PER_NODE = 3;
const ROCK_RADIUS = 0.68;
const HARVEST_REACH = 2.75;
const BURST_POOL_SIZE = 5;
const BURST_PARTICLES = 16;
const BURST_DURATION = 0.52;

interface RockNodeRuntime {
  readonly spec: HarvestNodeSpec;
  readonly group: THREE.Group;
  readonly mainPivot: THREE.Group;
  readonly baseY: number;
  readonly standingObstacle: Obstacle;
  activeObstacle: Obstacle | null;
  hitsRemaining: number;
  depleted: boolean;
  shakeTimer: number;
  shakeDirX: number;
  shakeDirZ: number;
}

interface ChipBurst {
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.PointsMaterial;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  active: boolean;
  age: number;
}

function createDisplacedRockGeometry(radius: number, seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes['position'];
  if (pos instanceof THREE.BufferAttribute) {
    for (let i = 0; i < pos.count; i += 1) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const n =
        1 +
        Math.sin(vx * 5.2 + seed) * 0.16 +
        Math.cos(vy * 4.7 - seed * 1.3) * 0.14 +
        Math.sin(vz * 5.8 + seed * 0.7) * 0.12;
      const flatBase = vy < -radius * 0.35 ? 0.55 : 1.0;
      pos.setXYZ(i, vx * n * 1.12, vy * n * 0.84 * flatBase, vz * n);
    }
    geo.computeVertexNormals();
  }
  return geo;
}

export function createHarvestSystem(options: HarvestSystemOptions): HarvestSystem {
  const { obstacles, forest } = options;
  const root = new THREE.Group();
  root.name = 'HarvestableResourceNodes';

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

  // Shared PBR stone materials (never double-disposing WorldTextureAtlas textures)
  const rockMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x80877f,
      roughness: 0.9,
      metalness: 0.05,
      map: atlas?.mossyRock.map ?? null,
      normalMap: atlas?.mossyRock.normalMap ?? null,
      roughnessMap: atlas?.mossyRock.roughnessMap ?? null,
    }),
  );
  const quartzVeinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8d938b,
      roughness: 0.82,
      metalness: 0.08,
      normalMap: atlas?.mossyRock.normalMap ?? null,
    }),
  );

  // Shared displaced granite rock geometries
  const rockMainGeo = trackGeo(createDisplacedRockGeometry(0.66, 1.7));
  const rockSideGeo = trackGeo(createDisplacedRockGeometry(0.42, 4.3));
  const rockShardGeo = trackGeo(createDisplacedRockGeometry(0.26, 7.1));

  const rockNodes: RockNodeRuntime[] = [];

  function setNodeObstacle(node: RockNodeRuntime, next: Obstacle | null): void {
    if (node.activeObstacle === next) {
      return;
    }
    if (node.activeObstacle) {
      const idx = obstacles.indexOf(node.activeObstacle);
      if (idx >= 0) {
        obstacles.splice(idx, 1);
      }
      node.activeObstacle = null;
    }
    if (next) {
      obstacles.push(next);
      node.activeObstacle = next;
    }
  }

  for (let i = 0; i < HARVEST_ROCK_SPECS.length; i += 1) {
    const spec = HARVEST_ROCK_SPECS[i];
    if (!spec) {
      continue;
    }
    const baseY = getTerrainHeight(spec.x, spec.z);
    const group = new THREE.Group();
    group.position.set(spec.x, baseY, spec.z);
    group.rotation.y = spec.rotY;

    const mainPivot = new THREE.Group();
    mainPivot.scale.setScalar(spec.scale);

    const mainBoulder = new THREE.Mesh(rockMainGeo, rockMat);
    mainBoulder.position.set(0, 0.36, 0);
    mainBoulder.castShadow = true;
    mainBoulder.receiveShadow = true;
    mainPivot.add(mainBoulder);

    const sideBoulder = new THREE.Mesh(rockSideGeo, rockMat);
    sideBoulder.position.set(0.46, 0.22, 0.24);
    sideBoulder.rotation.set(0.2, 1.1, -0.15);
    sideBoulder.castShadow = true;
    sideBoulder.receiveShadow = true;
    mainPivot.add(sideBoulder);

    const veinCluster = new THREE.Mesh(rockShardGeo, quartzVeinMat);
    veinCluster.position.set(-0.34, 0.26, -0.22);
    veinCluster.rotation.set(-0.25, 0.6, 0.35);
    veinCluster.castShadow = true;
    veinCluster.receiveShadow = true;
    mainPivot.add(veinCluster);

    group.add(mainPivot);
    root.add(group);

    const standingObstacle: Obstacle = {
      kind: 'circle',
      x: spec.x,
      z: spec.z,
      radius: ROCK_RADIUS * spec.scale,
    };
    const runtime: RockNodeRuntime = {
      spec,
      group,
      mainPivot,
      baseY,
      standingObstacle,
      activeObstacle: null,
      hitsRemaining: MAX_HITS_PER_NODE,
      depleted: false,
      shakeTimer: 0,
      shakeDirX: 0,
      shakeDirZ: -1,
    };
    setNodeObstacle(runtime, standingObstacle);
    rockNodes.push(runtime);
  }

  // Pre-allocated wood-chip & stone-shard burst pool (ZERO per-frame heap allocations!)
  const bursts: ChipBurst[] = [];
  for (let b = 0; b < BURST_POOL_SIZE; b += 1) {
    const positions = new Float32Array(BURST_PARTICLES * 3);
    const velocities = new Float32Array(BURST_PARTICLES * 3);
    const geometry = trackGeo(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = trackMat(
      new THREE.PointsMaterial({
        color: 0xd2a463,
        size: 0.1,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const points = new THREE.Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    points.userData['excludeFromGtao'] = true;
    root.add(points);
    bursts.push({
      points,
      geometry,
      material,
      positions,
      velocities,
      active: false,
      age: 0,
    });
  }

  let nextBurstSlot = 0;

  function spawnChipBurst(x: number, y: number, z: number, kind: HarvestNodeKind): void {
    const burst = bursts[nextBurstSlot];
    nextBurstSlot = (nextBurstSlot + 1) % bursts.length;
    if (!burst) {
      return;
    }
    burst.active = true;
    burst.age = 0;
    burst.points.visible = true;
    burst.material.opacity = 0.95;
    burst.material.color.setHex(kind === 'tree' ? 0xd2a463 : 0xa5ada8);

    for (let p = 0; p < BURST_PARTICLES; p += 1) {
      const idx = p * 3;
      const angle = (p / BURST_PARTICLES) * Math.PI * 2 + (p % 3) * 0.41;
      const spd = 1.45 + (p % 5) * 0.42;
      burst.positions[idx] = x + Math.cos(angle) * 0.14;
      burst.positions[idx + 1] = y + (p % 4) * 0.06;
      burst.positions[idx + 2] = z + Math.sin(angle) * 0.14;

      burst.velocities[idx] = Math.cos(angle) * spd;
      burst.velocities[idx + 1] = 2.0 + (p % 4) * 0.65;
      burst.velocities[idx + 2] = Math.sin(angle) * spd;
    }
    const attr = burst.geometry.getAttribute('position');
    if (attr instanceof THREE.BufferAttribute) {
      attr.needsUpdate = true;
    }
  }

  function tryHarvestHit(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    tool: EquippedTool,
    reinforced = false,
  ): HarvestHitResult {
    const fLen = Math.hypot(fwdX, fwdZ) || 1;
    const nx = fwdX / fLen;
    const nz = fwdZ / fLen;
    const hitPower = reinforced ? 2 : 1;

    let bestRock: RockNodeRuntime | null = null;
    let bestForestTree: ChoppableTreeTarget | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (!node || node.depleted) {
        continue;
      }
      const dx = node.spec.x - playerX;
      const dz = node.spec.z - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxReach = HARVEST_REACH + ROCK_RADIUS * node.spec.scale * 0.45;
      if (dist > maxReach) {
        continue;
      }
      const dot = dist > 1e-4 ? (dx * nx + dz * nz) / dist : 1;
      if (dot < 0.32) {
        continue;
      }
      const score = dist - dot * 0.7;
      if (score < bestScore) {
        bestScore = score;
        bestRock = node;
      }
    }

    if (forest) {
      const forestTrees = forest.getTargets();
      for (let i = 0; i < forestTrees.length; i += 1) {
        const tree = forestTrees[i];
        if (!tree || tree.depleted) {
          continue;
        }
        const dx = tree.x - playerX;
        const dz = tree.z - playerZ;
        const dist = Math.hypot(dx, dz);
        const maxReach = HARVEST_REACH + tree.radius * 0.45;
        if (dist > maxReach) {
          continue;
        }
        const dot = dist > 1e-4 ? (dx * nx + dz * nz) / dist : 1;
        if (dot < 0.32) {
          continue;
        }
        const score = dist - dot * 0.7;
        if (score < bestScore) {
          bestScore = score;
          bestForestTree = tree;
          bestRock = null;
        }
      }
    }

    if (bestForestTree && forest) {
      const awayX = bestForestTree.x - playerX;
      const awayZ = bestForestTree.z - playerZ;
      const awayLen = Math.hypot(awayX, awayZ) || 1;
      const dirX = awayX / awayLen;
      const dirZ = awayZ / awayLen;

      if (tool !== 'axe') {
        forest.shakeTree(bestForestTree.id, dirX, dirZ);
        return {
          hit: true,
          wrongTool: true,
          neededTool: 'axe',
          kind: 'tree',
          depleted: false,
          hitX: bestForestTree.x,
          hitZ: bestForestTree.z,
        };
      }

      const chopRes = forest.chopTree(bestForestTree.id, dirX, dirZ, obstacles, hitPower);
      if (!chopRes.hit) {
        return {
          hit: false,
          wrongTool: false,
          depleted: false,
          hitX: playerX,
          hitZ: playerZ,
        };
      }

      spawnChipBurst(bestForestTree.x, chopRes.hitY, bestForestTree.z, 'tree');
      return {
        hit: true,
        wrongTool: false,
        kind: 'tree',
        depleted: chopRes.depleted,
        loot: { wood: chopRes.woodYield },
        hitX: bestForestTree.x,
        hitZ: bestForestTree.z,
      };
    }

    if (!bestRock) {
      return {
        hit: false,
        wrongTool: false,
        depleted: false,
        hitX: playerX,
        hitZ: playerZ,
      };
    }

    const awayX = bestRock.spec.x - playerX;
    const awayZ = bestRock.spec.z - playerZ;
    const awayLen = Math.hypot(awayX, awayZ) || 1;

    if (tool !== 'pickaxe') {
      bestRock.shakeTimer = 0.16;
      bestRock.shakeDirX = awayX / awayLen;
      bestRock.shakeDirZ = awayZ / awayLen;
      return {
        hit: true,
        wrongTool: true,
        neededTool: 'pickaxe',
        kind: 'rock',
        depleted: false,
        hitX: bestRock.spec.x,
        hitZ: bestRock.spec.z,
      };
    }

    const prevRockHits = bestRock.hitsRemaining;
    bestRock.hitsRemaining = Math.max(0, prevRockHits - hitPower);
    bestRock.shakeTimer = 0.28;
    bestRock.shakeDirX = awayX / awayLen;
    bestRock.shakeDirZ = awayZ / awayLen;

    spawnChipBurst(bestRock.spec.x, bestRock.baseY + 0.48, bestRock.spec.z, 'rock');

    if (bestRock.hitsRemaining > 0) {
      const shrink = 0.62 + 0.38 * (bestRock.hitsRemaining / MAX_HITS_PER_NODE);
      bestRock.mainPivot.scale.setScalar(bestRock.spec.scale * shrink);
      return {
        hit: true,
        wrongTool: false,
        kind: 'rock',
        depleted: false,
        loot: { stone: hitPower * 2 },
        hitX: bestRock.spec.x,
        hitZ: bestRock.spec.z,
      };
    }

    // Final strike: shatter mossy stone outcrop cleanly (total 9 Stone + 1 Scrap regardless of hitPower)
    bestRock.depleted = true;
    bestRock.mainPivot.visible = false;
    setNodeObstacle(bestRock, null);
    const stoneAwardedSoFar = Math.max(0, MAX_HITS_PER_NODE - prevRockHits) * 2;
    const finalStone = Math.max(5, 9 - stoneAwardedSoFar);
    return {
      hit: true,
      wrongTool: false,
      kind: 'rock',
      depleted: true,
      loot: { stone: finalStone, scrap: 1 },
      hitX: bestRock.spec.x,
      hitZ: bestRock.spec.z,
    };
  }

  function update(dt: number): void {
    // 1. Update active wood-chip & stone-shard bursts
    for (let b = 0; b < bursts.length; b += 1) {
      const burst = bursts[b];
      if (!burst || !burst.active) {
        continue;
      }
      burst.age += dt;
      if (burst.age >= BURST_DURATION) {
        burst.active = false;
        burst.points.visible = false;
        burst.material.opacity = 0;
        continue;
      }
      for (let p = 0; p < BURST_PARTICLES; p += 1) {
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
      burst.material.opacity = (1 - burst.age / BURST_DURATION) * 0.95;
    }

    // 2. Update pickaxe hit shakes on stone outcrops
    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (!node || node.shakeTimer <= 0) {
        continue;
      }
      node.shakeTimer = Math.max(0, node.shakeTimer - dt);
      const amp = (node.shakeTimer / 0.28) * 0.085;
      const osc = Math.sin(node.shakeTimer * 52);
      const localCos = Math.cos(node.spec.rotY);
      const localSin = Math.sin(node.spec.rotY);
      const lx = node.shakeDirX * localCos - node.shakeDirZ * localSin;
      const lz = node.shakeDirX * localSin + node.shakeDirZ * localCos;
      node.mainPivot.position.set(lx * amp * osc * 0.6, 0, lz * amp * osc * 0.6);
      if (node.shakeTimer <= 0) {
        node.mainPivot.position.set(0, 0, 0);
      }
    }
  }

  function reset(): void {
    for (let b = 0; b < bursts.length; b += 1) {
      const burst = bursts[b];
      if (burst) {
        burst.active = false;
        burst.points.visible = false;
        burst.material.opacity = 0;
      }
    }

    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (!node) {
        continue;
      }
      node.hitsRemaining = MAX_HITS_PER_NODE;
      node.depleted = false;
      node.shakeTimer = 0;
      node.mainPivot.visible = true;
      node.mainPivot.rotation.set(0, 0, 0);
      node.mainPivot.scale.setScalar(node.spec.scale);
      node.mainPivot.position.set(0, 0, 0);
      setNodeObstacle(node, node.standingObstacle);
    }

    if (forest) {
      forest.resetFelled(obstacles);
    }
  }

  function serializeDepletedIds(): string[] {
    const ids: string[] = [];
    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (node && node.depleted) {
        ids.push(node.spec.id);
      }
    }
    if (forest) {
      const felledTreeIds = forest.serializeFelledIds();
      for (let i = 0; i < felledTreeIds.length; i += 1) {
        const treeId = felledTreeIds[i];
        if (treeId) {
          ids.push(treeId);
        }
      }
    }
    return ids;
  }

  function hydrateDepletedIds(ids: readonly string[]): void {
    reset();
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (!node || !idSet.has(node.spec.id)) {
        continue;
      }
      node.hitsRemaining = 0;
      node.depleted = true;
      node.mainPivot.visible = false;
      setNodeObstacle(node, null);
    }
    if (forest) {
      forest.hydrateFelledIds(ids, obstacles);
    }
  }

  function getCounts(): {
    readonly remainingTrees: number;
    readonly remainingRocks: number;
    readonly total: number;
  } {
    const remainingTrees = forest ? forest.getRemainingCount() : 0;
    let remainingRocks = 0;
    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (node && !node.depleted) {
        remainingRocks += 1;
      }
    }
    const total = rockNodes.length + (forest ? forest.getTotalCount() : 0);
    return { remainingTrees, remainingRocks, total };
  }

  function dispose(): void {
    for (let i = 0; i < rockNodes.length; i += 1) {
      const node = rockNodes[i];
      if (node) {
        setNodeObstacle(node, null);
      }
    }
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
    tryHarvestHit,
    getCounts,
    serializeDepletedIds,
    hydrateDepletedIds,
    update,
    reset,
    dispose,
  };
}
