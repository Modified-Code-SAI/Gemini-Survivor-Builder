import { describe, expect, it } from 'vitest';
import { getTerrainHeight, type Obstacle } from '../world/terrain';
import { createBuildingSystem } from './building';
import type { LootBundle } from './survival';
import { createThreatSystem, type SiegeStatus } from './threats';

describe('threat AI, Night/Storm base sieges, structure-bashing & ballistic arrows', () => {
  it('triggers Wave 1 base siege, converges hostiles onto the base, and bashes built structures', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    building.setActive(true);

    // Build a 2-piece outpost (foundation + timber wall) around (-12, 0)
    const pY = getTerrainHeight(-12, 4);
    building.setSelectedKind('foundation');
    building.updateGhost(-12, pY, 4, 0, 0, -1, true);
    const f1 = building.tryPlaceCurrent(() => true);
    expect(f1.ok).toBe(true);

    building.setSelectedKind('wall');
    building.updateGhost(f1.x, f1.y, f1.z + 2.4, 0, 0, -1, true);
    const wall = building.tryPlaceCurrent(() => true);
    expect(wall.ok).toBe(true);

    const anchor = { x: 0, z: 0 };
    expect(building.getBaseAnchor(anchor)).toBe(true);

    const siegeEvents: Array<{ kind: 'started' | 'repelled'; wave: number; hostiles: number }> = [];
    let bashCount = 0;

    const threats = createThreatSystem({
      obstacles,
      getSupportHeight: (x, z, curY) =>
        Math.max(getTerrainHeight(x, z), building.getFloorHeightAt(x, z, curY) ?? -Infinity),
      onStructureBashed: () => {
        bashCount += 1;
      },
      onSiegeEvent: (kind, wave, hostiles) => {
        siegeEvents.push({ kind, wave, hostiles });
      },
    });

    expect(threats.triggerSiegeWave(anchor.x, anchor.z)).toBe(true);
    expect(siegeEvents).toEqual([{ kind: 'started', wave: 1, hostiles: 3 }]);

    const status: SiegeStatus = {
      active: false,
      wave: 0,
      remainingHostiles: 0,
      cooldownRemaining: 0,
    };
    threats.getSiegeStatus(status);
    expect(status.active).toBe(true);
    expect(status.wave).toBe(1);
    expect(status.remainingHostiles).toBe(3);

    // Simulate 12 seconds at 30 Hz so converging siege hostiles reach the wall and bash it!
    // Keep player safely far away so attackers target the built structures first.
    for (let step = 0; step < 360 && bashCount === 0; step += 1) {
      threats.update(1 / 30, step / 30, {
        playerX: 40,
        playerY: getTerrainHeight(40, 20),
        playerZ: 20,
        playerVisibility: 0,
        playerNoiseRadius: 0,
        playerDead: false,
        nightFactor: 1,
        rainIntensity: 0.8,
        baseAnchor: anchor,
        findNearestStructure: building.findNearestAttackableStructure,
        damageStructure: building.damageStructure,
        checkArrowStructureHit: building.checkArrowStructureHit,
      });
    }

    expect(bashCount).toBeGreaterThan(0);

    threats.dispose();
    building.dispose();
  });

  it('flies ballistic arrows through open window_wall embrasures to down Raiders and awards siege repel loot', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    building.setActive(true);

    // gas_patrol spawns deterministically at (5.6, terrainY, -14.5)
    // Place a Window Wall directly between shooter (5.6, -7.5) and gas_patrol (5.6, -14.5)
    const wallY = getTerrainHeight(5.6, -11.5);
    building.hydrate([
      { id: 'bp_win', kind: 'window_wall', x: 5.6, y: wallY, z: -11.5, yaw: 0 },
    ]);

    const arrowHits: Array<{
      hitEnemy: boolean;
      downed: boolean;
      isMonster: boolean;
      headshot: boolean;
      loot?: LootBundle;
    }> = [];
    const siegeEvents: Array<{
      kind: 'started' | 'repelled';
      wave: number;
      hostiles: number;
      reward?: LootBundle;
    }> = [];

    const threats = createThreatSystem({
      obstacles,
      onArrowHit: (hitEnemy, downed, isMonster, headshot, loot) => {
        arrowHits.push({ hitEnemy, downed, isMonster, headshot, loot });
      },
      onSiegeEvent: (kind, wave, hostiles, rewardLoot) => {
        siegeEvents.push({ kind, wave, hostiles, reward: rewardLoot });
      },
    });

    const raiderObj = threats.root.children[0];
    expect(raiderObj).toBeDefined();
    if (!raiderObj) {
      return;
    }

    // 1. Fire an arrow through the open window_wall embrasure (y ~ wallY + 1.55) into gas_patrol
    const startX = 5.6;
    const startY = wallY + 1.62;
    const startZ = -9.5;
    const targetY = raiderObj.position.y + 1.55;
    const dx = raiderObj.position.x - startX;
    const dy = targetY - startY + 0.08;
    const dz = raiderObj.position.z - startZ;

    expect(threats.shootArrow(startX, startY, startZ, dx, dy, dz)).toBe(true);
    for (let step = 0; step < 30; step += 1) {
      threats.update(1 / 60, step / 60, {
        playerX: 40,
        playerY: 0,
        playerZ: 25,
        playerVisibility: 0,
        playerNoiseRadius: 0,
        playerDead: false,
        checkArrowStructureHit: building.checkArrowStructureHit,
      });
    }

    expect(arrowHits.some((h) => h.hitEnemy)).toBe(true);

    // 2. Fire an arrow into the SOLID lower sill of the window_wall (y = wallY + 0.5) -> sticks in structure
    const hitsBeforeSill = arrowHits.length;
    expect(threats.shootArrow(5.6, wallY + 0.55, -9.5, 0, 0.02, -1)).toBe(true);
    for (let step = 0; step < 25; step += 1) {
      threats.update(1 / 60, (30 + step) / 60, {
        playerX: 40,
        playerY: 0,
        playerZ: 25,
        playerVisibility: 0,
        playerNoiseRadius: 0,
        playerDead: false,
        checkArrowStructureHit: building.checkArrowStructureHit,
      });
    }
    expect(arrowHits.length).toBeGreaterThan(hitsBeforeSill);
    expect(arrowHits[arrowHits.length - 1]?.hitEnemy).toBe(false);

    // 3. Trigger Wave 1 siege and shoot down all 3 rallied hostiles -> triggers repelled event with reward loot!
    expect(threats.triggerSiegeWave(-10, 0)).toBe(true);
    for (let idx = 0; idx < 3; idx += 1) {
      const target = threats.root.children[idx];
      if (!target) {
        continue;
      }
      // 3 crisp headshots guarantees downing both 100-HP Raiders and 140-HP Hollow Stalker
      for (let shot = 0; shot < 3; shot += 1) {
        const tx = target.position.x;
        const ty = target.position.y + 1.55;
        const tz = target.position.z;
        threats.shootArrow(tx, ty + 0.02, tz + 2.5, 0, 0, -1);
        for (let step = 0; step < 12; step += 1) {
          threats.update(1 / 60, 2 + idx + shot * 0.2 + step / 60, {
            playerX: 40,
            playerY: 0,
            playerZ: 25,
            playerVisibility: 0,
            playerNoiseRadius: 0,
            playerDead: false,
          });
        }
      }
    }

    const repelled = siegeEvents.find((e) => e.kind === 'repelled');
    expect(repelled).toBeDefined();
    expect(repelled?.wave).toBe(1);
    expect(repelled?.hostiles).toBe(0);
    expect(repelled?.reward).toEqual({ scrap: 3, wood: 3, arrows: 4 });

    const finalStatus: SiegeStatus = {
      active: true,
      wave: 0,
      remainingHostiles: 99,
      cooldownRemaining: 0,
    };
    threats.getSiegeStatus(finalStatus);
    expect(finalStatus.active).toBe(false);
    expect(finalStatus.remainingHostiles).toBe(0);
    expect(finalStatus.cooldownRemaining).toBeGreaterThan(100);

    threats.dispose();
    building.dispose();
  });

  it('prevents vertical melee hits across 2-story watchtower decks and redirects ground hostiles to bash structures', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });

    // Place 1st-story ground wall right beside gas_patrol spawn (5.6, -14.5)
    const groundX = 5.6;
    const groundZ = -14.5;
    const groundY = getTerrainHeight(groundX, groundZ);
    building.hydrate([
      { id: 'bp_tower_wall', kind: 'wall', x: groundX, y: groundY, z: groundZ - 1.4, yaw: 0 },
    ]);

    let playerHits = 0;
    let bashCount = 0;
    const threats = createThreatSystem({
      obstacles,
      getSupportHeight: (x, z, curY) =>
        Math.max(getTerrainHeight(x, z), building.getFloorHeightAt(x, z, curY) ?? -Infinity),
      onPlayerHit: () => {
        playerHits += 1;
      },
      onStructureBashed: () => {
        bashCount += 1;
      },
    });

    const raiderObj = threats.root.children[0];
    expect(raiderObj).toBeDefined();
    if (!raiderObj) {
      return;
    }

    const elevatedY = raiderObj.position.y + 3.04;

    // 1. Player standing 3.04 m overhead on a 2nd-story deck CANNOT melee ground enemies beneath them
    const overheadSwing = threats.tryPlayerMeleeHit(
      raiderObj.position.x,
      raiderObj.position.z + 0.8,
      0,
      -1,
      false,
      undefined,
      elevatedY,
    );
    expect(overheadSwing.hit).toBe(false);

    // 2. Simulate 6 seconds with player directly overhead on the 2nd story and full visibility/noise:
    // ground enemy MUST NOT melee-hit the player through the ceiling and MUST bash the ground wall instead!
    for (let step = 0; step < 180; step += 1) {
      threats.update(1 / 30, step / 30, {
        playerX: raiderObj.position.x,
        playerY: elevatedY,
        playerZ: raiderObj.position.z + 0.5,
        playerVisibility: 1,
        playerNoiseRadius: 10,
        playerDead: false,
        findNearestStructure: building.findNearestAttackableStructure,
        damageStructure: building.damageStructure,
      });
    }

    expect(playerHits).toBe(0);
    expect(bashCount).toBeGreaterThan(0);

    // 3. When standing on the same floor elevation, player melee hits normally
    const sameFloorSwing = threats.tryPlayerMeleeHit(
      raiderObj.position.x,
      raiderObj.position.z + 0.9,
      0,
      -1,
      false,
      undefined,
      raiderObj.position.y,
    );
    expect(sameFloorSwing.hit).toBe(true);

    threats.dispose();
    building.dispose();
  });
});
