import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HERO_TREE_COORDS,
  type ChoppableForestController,
  type ChoppableTreeTarget,
} from '../world/environment';
import {
  getRoadCenterX,
  getTerrainHeight,
  SPAWN_POINT,
  WORLD_BOUNDS,
  type Obstacle,
} from '../world/terrain';
import { createHarvestSystem, HARVEST_ROCK_SPECS } from './harvest';

interface MockForestTree extends ChoppableTreeTarget {
  hitsRemaining: number;
  depleted: boolean;
  readonly standingObstacle: Obstacle;
  readonly stumpObstacle: Obstacle;
}

function createForestHarness(obstacles: Obstacle[]): {
  readonly controller: ChoppableForestController;
  readonly trees: readonly MockForestTree[];
  readonly getShakeCount: (id: string) => number;
} {
  const specs: ReadonlyArray<readonly [string, number, number, number]> = [
    ['forest_tree_0', -6.9, 9.8, 0.34],
    ['forest_tree_1', -12.6, 12.6, 0.56],
    ['forest_tree_2', -8.6, -22.5, 0.42],
  ];

  const trees: MockForestTree[] = [];
  const treeMap = new Map<string, MockForestTree>();
  const shakeCounts = new Map<string, number>();

  for (const [id, x, z, standingRadius] of specs) {
    const standingObstacle: Obstacle = { kind: 'circle', x, z, radius: standingRadius };
    const stumpRadius = Math.min(0.42, Math.max(0.28, standingRadius * 0.72));
    const stumpObstacle: Obstacle = { kind: 'circle', x, z, radius: stumpRadius };
    obstacles.push(standingObstacle);

    const entry: MockForestTree = {
      id,
      x,
      z,
      terrainY: getTerrainHeight(x, z),
      radius: standingRadius,
      hitsRemaining: 3,
      depleted: false,
      standingObstacle,
      stumpObstacle,
    };
    trees.push(entry);
    treeMap.set(id, entry);
  }

  function swapObs(liveObstacles: Obstacle[], removeObs: Obstacle, addObs: Obstacle): void {
    const idx = liveObstacles.indexOf(removeObs);
    if (idx >= 0) {
      liveObstacles[idx] = addObs;
    } else if (!liveObstacles.includes(addObs)) {
      liveObstacles.push(addObs);
    }
  }

  function resetFelled(liveObstacles: Obstacle[]): void {
    for (const tree of trees) {
      if (tree.depleted) {
        swapObs(liveObstacles, tree.stumpObstacle, tree.standingObstacle);
      }
      tree.hitsRemaining = 3;
      tree.depleted = false;
    }
  }

  const controller: ChoppableForestController = {
    getTargets(): readonly ChoppableTreeTarget[] {
      return trees;
    },
    shakeTree(id: string): void {
      const tree = treeMap.get(id);
      if (!tree || tree.depleted) {
        return;
      }
      shakeCounts.set(id, (shakeCounts.get(id) ?? 0) + 1);
    },
    chopTree(id: string, _dirX: number, _dirZ: number, liveObstacles: Obstacle[]) {
      const tree = treeMap.get(id);
      if (!tree || tree.depleted) {
        return { hit: false, depleted: false, woodYield: 0, hitY: 0 };
      }
      tree.hitsRemaining = Math.max(0, tree.hitsRemaining - 1);
      const hitY = tree.terrainY + 1.15;
      if (tree.hitsRemaining > 0) {
        shakeCounts.set(id, (shakeCounts.get(id) ?? 0) + 1);
        return { hit: true, depleted: false, woodYield: 2, hitY };
      }
      tree.depleted = true;
      swapObs(liveObstacles, tree.standingObstacle, tree.stumpObstacle);
      return { hit: true, depleted: true, woodYield: 6, hitY };
    },
    getRemainingCount(): number {
      return trees.filter((t) => !t.depleted).length;
    },
    getTotalCount(): number {
      return trees.length;
    },
    serializeFelledIds(): string[] {
      return trees.filter((t) => t.depleted).map((t) => t.id);
    },
    hydrateFelledIds(ids: readonly string[], liveObstacles: Obstacle[]): void {
      resetFelled(liveObstacles);
      const idSet = new Set(ids);
      for (const tree of trees) {
        if (idSet.has(tree.id)) {
          tree.hitsRemaining = 0;
          tree.depleted = true;
          swapObs(liveObstacles, tree.standingObstacle, tree.stumpObstacle);
        }
      }
    },
    resetFelled,
  };

  return {
    controller,
    trees,
    getShakeCount: (id: string) => shakeCounts.get(id) ?? 0,
  };
}

describe('harvestable forest timber & stone outcrop system', () => {
  it('places all 10 stone outcrops clear of the highway, spawn, landmarks, boulders, caches, hero trees, and each other', () => {
    expect(HARVEST_ROCK_SPECS.length).toBe(10);
    expect(HARVEST_ROCK_SPECS.every((n) => n.kind === 'rock')).toBe(true);

    const scavengeAndBoulders: ReadonlyArray<readonly [number, number]> = [
      [SPAWN_POINT.x, SPAWN_POINT.z],
      [-4.2, 7.2],
      [-5.8, 3.4],
      [5.4, 9.8],
      [4.5, 5.1],
      [0.65, -1.95],
      [10.4, -3.5],
      [10.2, -10.4],
      [-0.9, -43.2],
      [-5.8, 12.1],
      [-4.6, 8.8],
      [-7.9, 1.2],
      [8.2, 6.4],
      [9.4, -15.5],
      [-8.4, -14.2],
      [-5.6, -24.5],
      [7.5, -28.0],
      [6.15, 2.45],
      [7.25, 10.4],
      [-1.65, -4.1],
      [2.55, -21.5],
      [-2.9, -43.5],
    ];

    for (const node of HARVEST_ROCK_SPECS) {
      expect(node.x).toBeGreaterThan(WORLD_BOUNDS.minX + 2);
      expect(node.x).toBeLessThan(WORLD_BOUNDS.maxX - 2);
      expect(node.z).toBeGreaterThan(WORLD_BOUNDS.minZ + 2);
      expect(node.z).toBeLessThan(WORLD_BOUNDS.maxZ - 2);

      // Clear of asphalt highway
      expect(Math.abs(node.x - getRoadCenterX(node.z))).toBeGreaterThanOrEqual(4.4);

      // Clear of Left Bunker footprint (-9.6, 4.0) & Gas Station pad (12.6, -6.8)
      const inBunker = node.x > -13.6 && node.x < -5.4 && node.z > -1.2 && node.z < 9.2;
      const inGasPad = node.x > 5.8 && node.x < 17.8 && node.z > -15.2 && node.z < 1.6;
      expect(inBunker).toBe(false);
      expect(inGasPad).toBe(false);

      for (const [ox, oz] of scavengeAndBoulders) {
        expect(Math.hypot(node.x - ox, node.z - oz)).toBeGreaterThanOrEqual(2.5);
      }

      // Clear of all hero vista trees (including the foreground Red Alder at -6.9, 9.8)
      expect(Math.hypot(node.x - -6.9, node.z - 9.8)).toBeGreaterThanOrEqual(2.6);
      for (const [hx, hz] of HERO_TREE_COORDS) {
        expect(Math.hypot(node.x - hx, node.z - hz)).toBeGreaterThanOrEqual(2.6);
      }
    }

    // Verify no two stone outcrops crowd one another
    for (let i = 0; i < HARVEST_ROCK_SPECS.length; i += 1) {
      const a = HARVEST_ROCK_SPECS[i];
      for (let j = i + 1; j < HARVEST_ROCK_SPECS.length; j += 1) {
        const b = HARVEST_ROCK_SPECS[j];
        if (a && b) {
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2.6);
        }
      }
    }
  });

  it('chops integrated forest trees with axe, mines rocks with pickaxe, swaps stump colliders <0.55, round-trips persistence, and has zero tan blaze rings', () => {
    const obstacles: Obstacle[] = [];
    const harness = createForestHarness(obstacles);
    const harvest = createHarvestSystem({ obstacles, forest: harness.controller });

    // 3 forest trees + 10 mossy stone outcrops = 13 obstacles & total targets
    expect(obstacles.length).toBe(13);
    expect(harvest.getCounts()).toEqual({ remainingTrees: 3, remainingRocks: 10, total: 13 });

    // Verify ZERO tan surveyor blaze-ring material (0xa4793c) or legacy tree nodes exist in harvest.root
    let foundTanBlaze = false;
    harvest.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial && m.color.getHex() === 0xa4793c) {
            foundTanBlaze = true;
          }
        }
      }
    });
    expect(foundTanBlaze).toBe(false);

    const tree = harness.trees[1];
    const rock = HARVEST_ROCK_SPECS[0];
    expect(tree).toBeDefined();
    expect(rock).toBeDefined();
    if (!tree || !rock) {
      return;
    }

    // Wrong tool on forest tree (pickaxe) must reject without loot and shake the tree
    const wrongTree = harvest.tryHarvestHit(tree.x, tree.z + 1.6, 0, -1, 'pickaxe');
    expect(wrongTree.hit).toBe(true);
    expect(wrongTree.wrongTool).toBe(true);
    expect(wrongTree.neededTool).toBe('axe');
    expect(wrongTree.kind).toBe('tree');
    expect(wrongTree.depleted).toBe(false);
    expect(wrongTree.loot).toBeUndefined();
    expect(harness.getShakeCount(tree.id)).toBe(1);

    // 3 Axe chops fell the forest tree for +2, +2, +6 = 10 Wood and swap standing -> stump collider (< 0.55)
    const chop1 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop1.hit).toBe(true);
    expect(chop1.wrongTool).toBe(false);
    expect(chop1.kind).toBe('tree');
    expect(chop1.depleted).toBe(false);
    expect(chop1.loot).toEqual({ wood: 2 });

    const chop2 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop2.loot).toEqual({ wood: 2 });
    expect(chop2.depleted).toBe(false);

    const chop3 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop3.depleted).toBe(true);
    expect(chop3.loot).toEqual({ wood: 6 });
    expect((chop1.loot?.wood ?? 0) + (chop2.loot?.wood ?? 0) + (chop3.loot?.wood ?? 0)).toBe(10);
    expect(harvest.getCounts().remainingTrees).toBe(2);
    expect(obstacles.length).toBe(13);

    // Standing trunk collider (>= 0.55) was swapped for low stump collider strictly < 0.55 (LOS invariant)
    expect(obstacles).not.toContain(tree.standingObstacle);
    expect(obstacles).toContain(tree.stumpObstacle);
    expect(tree.stumpObstacle.kind).toBe('circle');
    if (tree.stumpObstacle.kind === 'circle') {
      expect(tree.stumpObstacle.radius).toBeLessThan(0.55);
    }

    // Advance wood-chip bursts cleanly
    for (let i = 0; i < 20; i += 1) {
      harvest.update(1 / 30);
    }

    // Wrong tool on rock (axe) must be rejected
    const wrongRock = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'axe');
    expect(wrongRock.hit).toBe(true);
    expect(wrongRock.wrongTool).toBe(true);
    expect(wrongRock.neededTool).toBe('pickaxe');

    // 3 Pickaxe strikes shatter the outcrop for 2 + 2 + (5 Stone + 1 Scrap) = 9 Stone + 1 Scrap
    const mine1 = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe');
    const mine2 = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe');
    const shatter = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe');
    expect(mine1.loot).toEqual({ stone: 2 });
    expect(mine2.loot).toEqual({ stone: 2 });
    expect(shatter.depleted).toBe(true);
    expect(shatter.loot).toEqual({ stone: 5, scrap: 1 });
    expect((mine1.loot?.stone ?? 0) + (mine2.loot?.stone ?? 0) + (shatter.loot?.stone ?? 0)).toBe(9);
    expect(harvest.getCounts().remainingRocks).toBe(9);
    expect(obstacles.length).toBe(12);

    // Serialize -> Reset -> Hydrate round-trip restores both felled forest trees and shattered rocks cleanly
    const depletedIds = harvest.serializeDepletedIds();
    expect(depletedIds).toContain(tree.id);
    expect(depletedIds).toContain(rock.id);
    expect(depletedIds.length).toBe(2);

    harvest.reset();
    expect(harvest.getCounts()).toEqual({ remainingTrees: 3, remainingRocks: 10, total: 13 });
    expect(obstacles.length).toBe(13);
    expect(obstacles).toContain(tree.standingObstacle);
    expect(obstacles).not.toContain(tree.stumpObstacle);

    harvest.hydrateDepletedIds(depletedIds);
    expect(harvest.getCounts()).toEqual({ remainingTrees: 2, remainingRocks: 9, total: 13 });
    expect(obstacles.length).toBe(12);
    expect(obstacles).toContain(tree.stumpObstacle);
    expect(obstacles).not.toContain(tree.standingObstacle);

    harvest.dispose();
    // 3 forest tree obstacles remain owned by environment; all 10 rock obstacles removed cleanly
    expect(obstacles.length).toBe(3);
  });
});
