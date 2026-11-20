import { describe, expect, it } from 'vitest';
import { HERO_TREE_COORDS } from '../world/environment';
import { getRoadCenterX, SPAWN_POINT, WORLD_BOUNDS, type Obstacle } from '../world/terrain';
import { createHarvestSystem, HARVEST_NODE_SPECS } from './harvest';

describe('harvestable timber & stone resource system', () => {
  it('places all 14 trees and 10 rocks clear of the highway, spawn, landmarks, boulders, and caches', () => {
    const trees = HARVEST_NODE_SPECS.filter((n) => n.kind === 'tree');
    const rocks = HARVEST_NODE_SPECS.filter((n) => n.kind === 'rock');
    expect(trees.length).toBe(14);
    expect(rocks.length).toBe(10);

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

    for (const node of HARVEST_NODE_SPECS) {
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

    // Also verify no two harvest nodes crowd one another
    for (let i = 0; i < HARVEST_NODE_SPECS.length; i += 1) {
      const a = HARVEST_NODE_SPECS[i];
      for (let j = i + 1; j < HARVEST_NODE_SPECS.length; j += 1) {
        const b = HARVEST_NODE_SPECS[j];
        if (a && b) {
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2.6);
        }
      }
    }
  });

  it('harvests trees with axe, mines rocks with pickaxe, rejects wrong tools, and updates obstacles cleanly', () => {
    const obstacles: Obstacle[] = [];
    const harvest = createHarvestSystem({ obstacles });
    expect(obstacles.length).toBe(24);
    expect(harvest.getCounts()).toEqual({ remainingTrees: 14, remainingRocks: 10, total: 24 });

    const tree = HARVEST_NODE_SPECS.find((n) => n.kind === 'tree');
    const rock = HARVEST_NODE_SPECS.find((n) => n.kind === 'rock');
    expect(tree).toBeDefined();
    expect(rock).toBeDefined();
    if (!tree || !rock) {
      return;
    }

    // Wrong tool on tree (pickaxe & fists) must not deplete tree or grant loot
    const wrongTree = harvest.tryHarvestHit(tree.x, tree.z + 1.5, 0, -1, 'pickaxe');
    expect(wrongTree.hit).toBe(true);
    expect(wrongTree.wrongTool).toBe(true);
    expect(wrongTree.neededTool).toBe('axe');
    expect(wrongTree.depleted).toBe(false);
    expect(wrongTree.loot).toBeUndefined();

    // 3 diagonal Axe chops fell the timber pine cleanly with YXZ topple rotation (zero Z roll skew)
    const chop1 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop1.hit).toBe(true);
    expect(chop1.wrongTool).toBe(false);
    expect(chop1.depleted).toBe(false);
    expect(chop1.loot).toEqual({ wood: 2 });

    const chop2 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop2.loot).toEqual({ wood: 2 });
    expect(chop2.depleted).toBe(false);

    const chop3 = harvest.tryHarvestHit(tree.x + 1.1, tree.z + 1.1, -0.707, -0.707, 'axe');
    expect(chop3.depleted).toBe(true);
    expect(chop3.loot).toEqual({ wood: 6 });
    expect(harvest.getCounts().remainingTrees).toBe(13);
    // Stump collider replaces standing trunk collider -> obstacle count remains 24
    expect(obstacles.length).toBe(24);

    // Advance topple partway & verify YXZ Euler order with pure fallAngle on X and zero Z roll
    for (let i = 0; i < 20; i += 1) {
      harvest.update(1 / 30);
    }
    const treeGroup = harvest.root.children[0];
    const fallPivot = treeGroup?.children[2];
    expect(fallPivot).toBeDefined();
    if (fallPivot) {
      expect(fallPivot.rotation.order).toBe('YXZ');
      expect(fallPivot.rotation.x).toBeGreaterThan(0.5);
      expect(fallPivot.rotation.z).toBe(0);
    }
    for (let i = 0; i < 40; i += 1) {
      harvest.update(1 / 30);
    }

    // Wrong tool on rock (axe) must be rejected
    const wrongRock = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'axe');
    expect(wrongRock.hit).toBe(true);
    expect(wrongRock.wrongTool).toBe(true);
    expect(wrongRock.neededTool).toBe('pickaxe');

    // 3 Pickaxe strikes shatter the outcrop for 2 + 2 + (5 Stone + 1 Scrap) and remove its collider
    expect(harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe').loot).toEqual({ stone: 2 });
    expect(harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe').loot).toEqual({ stone: 2 });
    const shatter = harvest.tryHarvestHit(rock.x, rock.z + 1.6, 0, -1, 'pickaxe');
    expect(shatter.depleted).toBe(true);
    expect(shatter.loot).toEqual({ stone: 5, scrap: 1 });
    expect(harvest.getCounts().remainingRocks).toBe(9);
    expect(obstacles.length).toBe(23);

    // Serialize -> Reset -> Hydrate round-trip restores exact depleted state & colliders
    const depletedIds = harvest.serializeDepletedIds();
    expect(depletedIds).toContain(tree.id);
    expect(depletedIds).toContain(rock.id);
    expect(depletedIds.length).toBe(2);

    harvest.reset();
    expect(harvest.getCounts()).toEqual({ remainingTrees: 14, remainingRocks: 10, total: 24 });
    expect(obstacles.length).toBe(24);

    harvest.hydrateDepletedIds(depletedIds);
    expect(harvest.getCounts()).toEqual({ remainingTrees: 13, remainingRocks: 9, total: 24 });
    expect(obstacles.length).toBe(23);

    harvest.dispose();
    expect(obstacles.length).toBe(0);
  });
});
