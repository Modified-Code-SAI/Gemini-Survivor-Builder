import * as THREE from 'three';
import { createDouglasFirCanopyGeometry } from '../world/environment';
import { getTerrainHeight, type Obstacle } from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import type { LootBundle } from './survival';

export type EquippedTool = 'axe' | 'pickaxe' | 'fists';
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
}

export interface HarvestSystem {
  readonly root: THREE.Group;
  tryHarvestHit(
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    tool: EquippedTool,
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

export const HARVEST_NODE_SPECS: readonly HarvestNodeSpec[] = [
  // 14 Harvestable Pacific Northwest Timber Pines (3 hits -> 2 + 2 + 6 = 10 Wood)
  { id: 'tree_overlook_w1', kind: 'tree', x: -8.8, z: 15.8, scale: 1.0, rotY: 0.4 },
  { id: 'tree_overlook_w2', kind: 'tree', x: -13.8, z: 16.4, scale: 1.08, rotY: 1.7 },
  { id: 'tree_overlook_e1', kind: 'tree', x: 13.2, z: 16.4, scale: 0.96, rotY: 2.5 },
  { id: 'tree_bunker_w1', kind: 'tree', x: -16.2, z: 5.4, scale: 1.12, rotY: 0.9 },
  { id: 'tree_bunker_n1', kind: 'tree', x: -14.6, z: -4.4, scale: 1.04, rotY: 3.1 },
  { id: 'tree_mid_w1', kind: 'tree', x: -9.4, z: -9.8, scale: 0.95, rotY: 4.2 },
  { id: 'tree_mid_w2', kind: 'tree', x: -14.8, z: -15.6, scale: 1.1, rotY: 5.1 },
  { id: 'tree_east_s1', kind: 'tree', x: 12.6, z: 6.2, scale: 1.02, rotY: 1.3 },
  { id: 'tree_gas_e1', kind: 'tree', x: 22.2, z: -5.2, scale: 1.08, rotY: 2.8 },
  { id: 'tree_gas_n1', kind: 'tree', x: 14.2, z: -19.6, scale: 1.05, rotY: 0.6 },
  { id: 'tree_valley_w1', kind: 'tree', x: -11.8, z: -26.5, scale: 1.06, rotY: 3.9 },
  { id: 'tree_valley_e1', kind: 'tree', x: 14.2, z: -27.4, scale: 0.98, rotY: 5.4 },
  { id: 'tree_north_w1', kind: 'tree', x: -11.4, z: -36.5, scale: 1.1, rotY: 2.1 },
  { id: 'tree_north_e1', kind: 'tree', x: 10.2, z: -37.2, scale: 1.0, rotY: 4.7 },

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

const MAX_HITS_PER_NODE = 3;
const TREE_STANDING_RADIUS = 0.46;
const TREE_STUMP_RADIUS = 0.34;
const ROCK_RADIUS = 0.68;
const HARVEST_REACH = 2.75;
const BURST_POOL_SIZE = 5;
const BURST_PARTICLES = 16;
const BURST_DURATION = 0.52;
const FALL_TARGET_ANGLE = 1.46;

interface HarvestNodeRuntime {
  readonly spec: HarvestNodeSpec;
  readonly group: THREE.Group;
  readonly mainPivot: THREE.Group;
  readonly baseY: number;
  readonly standingObstacle: Obstacle;
  readonly stumpObstacle: Obstacle | null;
  activeObstacle: Obstacle | null;
  hitsRemaining: number;
  depleted: boolean;
  shakeTimer: number;
  shakeDirX: number;
  shakeDirZ: number;
  falling: boolean;
  fallAngle: number;
  fallVel: number;
  fallYaw: number;
  fallLinger: number;
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
  const { obstacles } = options;
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

  // Shared PBR timber & stone materials (never double-disposing WorldTextureAtlas textures)
  const barkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x7b5c42,
      roughness: 0.94,
      metalness: 0.02,
      map: atlas?.pineBark.map ?? null,
      normalMap: atlas?.pineBark.normalMap ?? null,
      roughnessMap: atlas?.pineBark.roughnessMap ?? null,
    }),
  );
  const stumpCoreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc99f67,
      roughness: 0.86,
      metalness: 0.02,
    }),
  );
  const blazeMarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xa4793c,
      roughness: 0.92,
      metalness: 0.02,
      normalMap: atlas?.pineBark.normalMap ?? null,
    }),
  );
  const boughMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: atlas?.pineBough.map ?? null,
      normalMap: atlas?.pineBough.normalMap ?? null,
      normalScale: new THREE.Vector2(0.95, 0.95),
      alphaTest: 0.38,
      roughness: 0.86,
      metalness: 0.02,
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
  );
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

  // Shared geometries for harvestable Timber Pines (photorealistic alpha-cutout Douglas Fir canopy)
  const stumpGeo = trackGeo(new THREE.CylinderGeometry(0.28, 0.39, 0.48, 9));
  const stumpTopGeo = trackGeo(new THREE.CylinderGeometry(0.275, 0.275, 0.02, 9));
  const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.11, 0.28, 6.2, 9));
  const blazeRingGeo = trackGeo(new THREE.CylinderGeometry(0.258, 0.264, 0.075, 9));
  const canopyGeo = trackGeo(createDouglasFirCanopyGeometry());

  // Shared displaced granite rock geometries
  const rockMainGeo = trackGeo(createDisplacedRockGeometry(0.66, 1.7));
  const rockSideGeo = trackGeo(createDisplacedRockGeometry(0.42, 4.3));
  const rockShardGeo = trackGeo(createDisplacedRockGeometry(0.26, 7.1));

  const nodes: HarvestNodeRuntime[] = [];

  function setNodeObstacle(node: HarvestNodeRuntime, next: Obstacle | null): void {
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

  for (let i = 0; i < HARVEST_NODE_SPECS.length; i += 1) {
    const spec = HARVEST_NODE_SPECS[i];
    if (!spec) {
      continue;
    }
    const baseY = getTerrainHeight(spec.x, spec.z);
    const group = new THREE.Group();
    group.position.set(spec.x, baseY, spec.z);
    group.rotation.y = spec.rotY;

    if (spec.kind === 'tree') {
      // Permanent cut stump at ground base (revealed cleanly when felled)
      const stump = new THREE.Mesh(stumpGeo, barkMat);
      stump.position.set(0, 0.2, 0);
      stump.scale.setScalar(spec.scale);
      stump.castShadow = true;
      stump.receiveShadow = true;
      group.add(stump);

      const stumpTop = new THREE.Mesh(stumpTopGeo, stumpCoreMat);
      stumpTop.position.set(0, 0.435 * spec.scale, 0);
      stumpTop.scale.setScalar(spec.scale);
      stumpTop.receiveShadow = true;
      group.add(stumpTop);

      // Upper trunk & tiered Pacific pine boughs pivoted at stump cut height (YXZ order avoids diagonal topple skew)
      const mainPivot = new THREE.Group();
      mainPivot.rotation.order = 'YXZ';
      mainPivot.position.set(0, 0.42 * spec.scale, 0);
      mainPivot.scale.setScalar(spec.scale);

      const trunk = new THREE.Mesh(trunkGeo, barkMat);
      trunk.position.set(0, 3.05, 0);
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      mainPivot.add(trunk);

      // Subtle weathered ochre surveyor band so harvestable timber pines read naturally in the woods
      const blaze = new THREE.Mesh(blazeRingGeo, blazeMarkMat);
      blaze.position.set(0, 0.82, 0);
      mainPivot.add(blaze);

      const canopy = new THREE.Mesh(canopyGeo, boughMat);
      canopy.position.set(0, -0.15, 0);
      canopy.scale.set(7.8, 7.6, 7.8);
      canopy.castShadow = true;
      canopy.receiveShadow = true;
      mainPivot.add(canopy);

      group.add(mainPivot);
      root.add(group);

      const standingObstacle: Obstacle = {
        kind: 'circle',
        x: spec.x,
        z: spec.z,
        radius: TREE_STANDING_RADIUS * spec.scale,
      };
      const stumpObstacle: Obstacle = {
        kind: 'circle',
        x: spec.x,
        z: spec.z,
        radius: TREE_STUMP_RADIUS * spec.scale,
      };
      const runtime: HarvestNodeRuntime = {
        spec,
        group,
        mainPivot,
        baseY,
        standingObstacle,
        stumpObstacle,
        activeObstacle: null,
        hitsRemaining: MAX_HITS_PER_NODE,
        depleted: false,
        shakeTimer: 0,
        shakeDirX: 0,
        shakeDirZ: -1,
        falling: false,
        fallAngle: 0,
        fallVel: 0,
        fallYaw: 0,
        fallLinger: 0,
      };
      setNodeObstacle(runtime, standingObstacle);
      nodes.push(runtime);
    } else {
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
      const runtime: HarvestNodeRuntime = {
        spec,
        group,
        mainPivot,
        baseY,
        standingObstacle,
        stumpObstacle: null,
        activeObstacle: null,
        hitsRemaining: MAX_HITS_PER_NODE,
        depleted: false,
        shakeTimer: 0,
        shakeDirX: 0,
        shakeDirZ: -1,
        falling: false,
        fallAngle: 0,
        fallVel: 0,
        fallYaw: 0,
        fallLinger: 0,
      };
      setNodeObstacle(runtime, standingObstacle);
      nodes.push(runtime);
    }
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
  ): HarvestHitResult {
    const fLen = Math.hypot(fwdX, fwdZ) || 1;
    const nx = fwdX / fLen;
    const nz = fwdZ / fLen;

    let bestNode: HarvestNodeRuntime | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || node.depleted) {
        continue;
      }
      const dx = node.spec.x - playerX;
      const dz = node.spec.z - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxReach =
        HARVEST_REACH +
        (node.spec.kind === 'rock' ? ROCK_RADIUS : TREE_STANDING_RADIUS) * node.spec.scale * 0.45;
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
        bestNode = node;
      }
    }

    if (!bestNode) {
      return {
        hit: false,
        wrongTool: false,
        depleted: false,
        hitX: playerX,
        hitZ: playerZ,
      };
    }

    const neededTool: 'axe' | 'pickaxe' = bestNode.spec.kind === 'tree' ? 'axe' : 'pickaxe';
    const awayX = bestNode.spec.x - playerX;
    const awayZ = bestNode.spec.z - playerZ;
    const awayLen = Math.hypot(awayX, awayZ) || 1;

    if (tool !== neededTool) {
      bestNode.shakeTimer = 0.16;
      bestNode.shakeDirX = awayX / awayLen;
      bestNode.shakeDirZ = awayZ / awayLen;
      return {
        hit: true,
        wrongTool: true,
        neededTool,
        kind: bestNode.spec.kind,
        depleted: false,
        hitX: bestNode.spec.x,
        hitZ: bestNode.spec.z,
      };
    }

    bestNode.hitsRemaining = Math.max(0, bestNode.hitsRemaining - 1);
    bestNode.shakeTimer = 0.28;
    bestNode.shakeDirX = awayX / awayLen;
    bestNode.shakeDirZ = awayZ / awayLen;

    const burstY = bestNode.baseY + (bestNode.spec.kind === 'tree' ? 1.15 : 0.48);
    spawnChipBurst(bestNode.spec.x, burstY, bestNode.spec.z, bestNode.spec.kind);

    if (bestNode.hitsRemaining > 0) {
      if (bestNode.spec.kind === 'rock') {
        const shrink = 0.62 + 0.38 * (bestNode.hitsRemaining / MAX_HITS_PER_NODE);
        bestNode.mainPivot.scale.setScalar(bestNode.spec.scale * shrink);
      }
      const hitLoot: LootBundle = bestNode.spec.kind === 'tree' ? { wood: 2 } : { stone: 2 };
      return {
        hit: true,
        wrongTool: false,
        kind: bestNode.spec.kind,
        depleted: false,
        loot: hitLoot,
        hitX: bestNode.spec.x,
        hitZ: bestNode.spec.z,
      };
    }

    // Final strike: fell timber pine or shatter stone outcrop!
    bestNode.depleted = true;
    if (bestNode.spec.kind === 'tree') {
      bestNode.falling = true;
      bestNode.fallAngle = 0;
      bestNode.fallVel = 0.65;
      bestNode.fallLinger = 0;
      // Rotate relative to group's local Y so tree topples cleanly away from player
      bestNode.fallYaw = Math.atan2(awayX / awayLen, awayZ / awayLen) - bestNode.spec.rotY;
      setNodeObstacle(bestNode, bestNode.stumpObstacle);
      return {
        hit: true,
        wrongTool: false,
        kind: 'tree',
        depleted: true,
        loot: { wood: 6 },
        hitX: bestNode.spec.x,
        hitZ: bestNode.spec.z,
      };
    }

    bestNode.mainPivot.visible = false;
    setNodeObstacle(bestNode, null);
    return {
      hit: true,
      wrongTool: false,
      kind: 'rock',
      depleted: true,
      loot: { stone: 5, scrap: 1 },
      hitX: bestNode.spec.x,
      hitZ: bestNode.spec.z,
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

    // 2. Update hit shakes & smooth tree topple fall animation
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) {
        continue;
      }
      if (node.falling) {
        if (node.fallAngle < FALL_TARGET_ANGLE) {
          node.fallVel += 3.6 * dt;
          node.fallAngle = Math.min(FALL_TARGET_ANGLE, node.fallAngle + node.fallVel * dt);
          node.mainPivot.rotation.set(node.fallAngle, node.fallYaw, 0);
        } else {
          node.fallLinger += dt;
          if (node.fallLinger >= 2.2) {
            node.falling = false;
            node.mainPivot.visible = false;
          }
        }
        continue;
      }

      if (node.shakeTimer > 0) {
        node.shakeTimer = Math.max(0, node.shakeTimer - dt);
        const amp = (node.shakeTimer / 0.28) * (node.spec.kind === 'tree' ? 0.065 : 0.085);
        const osc = Math.sin(node.shakeTimer * 52);
        const localCos = Math.cos(node.spec.rotY);
        const localSin = Math.sin(node.spec.rotY);
        const lx = node.shakeDirX * localCos - node.shakeDirZ * localSin;
        const lz = node.shakeDirX * localSin + node.shakeDirZ * localCos;
        if (node.spec.kind === 'tree') {
          node.mainPivot.rotation.set(lz * amp * osc, 0, -lx * amp * osc);
        } else {
          node.mainPivot.position.set(lx * amp * osc * 0.6, 0, lz * amp * osc * 0.6);
        }
        if (node.shakeTimer <= 0) {
          node.mainPivot.rotation.set(0, 0, 0);
          node.mainPivot.position.set(0, node.spec.kind === 'tree' ? 0.42 * node.spec.scale : 0, 0);
        }
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

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) {
        continue;
      }
      node.hitsRemaining = MAX_HITS_PER_NODE;
      node.depleted = false;
      node.shakeTimer = 0;
      node.falling = false;
      node.fallAngle = 0;
      node.fallVel = 0;
      node.fallLinger = 0;
      node.mainPivot.visible = true;
      node.mainPivot.rotation.set(0, 0, 0);
      node.mainPivot.scale.setScalar(node.spec.scale);
      node.mainPivot.position.set(0, node.spec.kind === 'tree' ? 0.42 * node.spec.scale : 0, 0);
      setNodeObstacle(node, node.standingObstacle);
    }
  }

  function serializeDepletedIds(): string[] {
    const ids: string[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node && node.depleted) {
        ids.push(node.spec.id);
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
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || !idSet.has(node.spec.id)) {
        continue;
      }
      node.hitsRemaining = 0;
      node.depleted = true;
      node.falling = false;
      node.mainPivot.visible = false;
      setNodeObstacle(node, node.spec.kind === 'tree' ? node.stumpObstacle : null);
    }
  }

  function getCounts(): {
    readonly remainingTrees: number;
    readonly remainingRocks: number;
    readonly total: number;
  } {
    let remainingTrees = 0;
    let remainingRocks = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node && !node.depleted) {
        if (node.spec.kind === 'tree') remainingTrees += 1;
        else remainingRocks += 1;
      }
    }
    return { remainingTrees, remainingRocks, total: nodes.length };
  }

  function dispose(): void {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
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
