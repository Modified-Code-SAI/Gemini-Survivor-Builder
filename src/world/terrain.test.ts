import { describe, expect, it } from 'vitest';
import {
  clampToWorldBounds,
  createObbObstacle,
  getRoadCenterX,
  getRoadFactor,
  getTerrainHeight,
  getTerrainNormal,
  resolveHorizontalCollision,
  smoothstep,
  SPAWN_POINT,
  WORLD_BOUNDS,
  type Obstacle,
} from './terrain';

describe('terrain math and collision', () => {
  it('returns finite continuous heights across the playable frontier', () => {
    for (let x = WORLD_BOUNDS.minX; x <= WORLD_BOUNDS.maxX; x += 8) {
      for (let z = WORLD_BOUNDS.minZ; z <= WORLD_BOUNDS.maxZ; z += 8) {
        const h0 = getTerrainHeight(x, z);
        const hX = getTerrainHeight(x + 0.25, z);
        const hZ = getTerrainHeight(x, z + 0.25);

        expect(Number.isFinite(h0)).toBe(true);
        expect(Math.abs(hX - h0)).toBeLessThan(0.6);
        expect(Math.abs(hZ - h0)).toBeLessThan(0.6);
      }
    }
  });

  it('forms a descending valley road flanked by elevated forest ridges', () => {
    const roadNearSpawn = getTerrainHeight(getRoadCenterX(14), 14);
    const roadDownValley = getTerrainHeight(getRoadCenterX(-65), -65);
    expect(roadNearSpawn).toBeGreaterThan(roadDownValley);

    const midRoadX = getRoadCenterX(-20);
    const midRoadY = getTerrainHeight(midRoadX, -20);
    const leftRidgeY = getTerrainHeight(midRoadX - 36, -20);
    const rightRidgeY = getTerrainHeight(midRoadX + 36, -20);

    expect(leftRidgeY).toBeGreaterThan(midRoadY + 4);
    expect(rightRidgeY).toBeGreaterThan(midRoadY + 4);
  });

  it('elevates the spawn overlook ledge slightly above the adjacent highway', () => {
    const spawnY = getTerrainHeight(SPAWN_POINT.x, SPAWN_POINT.z);
    const adjacentRoadY = getTerrainHeight(getRoadCenterX(SPAWN_POINT.z), SPAWN_POINT.z);
    expect(spawnY).toBeGreaterThan(adjacentRoadY + 0.2);
  });

  it('distinguishes highway roadbed from surrounding pine forest', () => {
    const zSamples = [18, 4, -12, -45, -75];
    for (const z of zSamples) {
      const centerX = getRoadCenterX(z);
      expect(getRoadFactor(centerX, z)).toBeCloseTo(1, 4);
      expect(getRoadFactor(centerX + 2.5, z)).toBeGreaterThan(0.95);
      expect(getRoadFactor(centerX + 12, z)).toBe(0);
      expect(getRoadFactor(centerX - 12, z)).toBe(0);
    }
  });

  it('computes normalized upward-facing terrain normals without allocation', () => {
    const normal = { x: 0, y: 0, z: 0 };
    getTerrainNormal(SPAWN_POINT.x, SPAWN_POINT.z, normal);
    const len = Math.hypot(normal.x, normal.y, normal.z);
    expect(len).toBeCloseTo(1, 5);
    expect(normal.y).toBeGreaterThan(0.5);
  });

  it('pushes actors out of circle, box, and oriented box obstacles in-place', () => {
    const obstacles: Obstacle[] = [
      { kind: 'circle', x: 0, z: 0, radius: 1.5 },
      { kind: 'box', minX: 10, maxX: 14, minZ: -2, maxZ: 2 },
      createObbObstacle(-10, -10, 4, 2, Math.PI * 0.25),
    ];

    const posA = { x: 0.9, z: 0 };
    const hitA = resolveHorizontalCollision(posA, 0.5, obstacles);
    expect(hitA).toBe(true);
    expect(Math.hypot(posA.x, posA.z)).toBeGreaterThanOrEqual(1.99);

    const posB = { x: 10.1, z: 0 };
    const hitB = resolveHorizontalCollision(posB, 0.5, obstacles);
    expect(hitB).toBe(true);
    expect(posB.x).toBeLessThanOrEqual(9.51);

    const posC = { x: -10.2, z: -9.8 };
    const hitC = resolveHorizontalCollision(posC, 0.5, obstacles);
    expect(hitC).toBe(true);
    const distFromObbCenter = Math.hypot(posC.x + 10, posC.z + 10);
    expect(distFromObbCenter).toBeGreaterThan(1.2);
  });

  it('clamps horizontal positions to WORLD_BOUNDS with margin', () => {
    const pos = { x: 999, z: -999 };
    clampToWorldBounds(pos, 1.0);
    expect(pos.x).toBe(WORLD_BOUNDS.maxX - 1.0);
    expect(pos.z).toBe(WORLD_BOUNDS.minZ + 1.0);

    const negPos = { x: -999, z: 999 };
    clampToWorldBounds(negPos, 0.5);
    expect(negPos.x).toBe(WORLD_BOUNDS.minX + 0.5);
    expect(negPos.z).toBe(WORLD_BOUNDS.maxZ - 0.5);
  });

  it('guards degenerate smoothstep edges against NaN', () => {
    expect(smoothstep(5, 5, 4)).toBe(0);
    expect(smoothstep(5, 5, 5)).toBe(1);
    expect(smoothstep(5, 5, 6)).toBe(1);
  });

  it('aligns createObbObstacle rotation with Three.js right-handed rotation.y', () => {
    // Box of width=6 along X, depth=1 along Z, rotated +90 deg CCW around +Y -> long axis lies along -Z/+Z
    const rotated = [createObbObstacle(0, 0, 6, 1, Math.PI * 0.5)];
    const alongNewLongAxis = { x: 0, z: -2.2 };
    expect(resolveHorizontalCollision(alongNewLongAxis, 0.4, rotated)).toBe(true);

    const alongNewShortAxis = { x: 2.2, z: 0 };
    expect(resolveHorizontalCollision(alongNewShortAxis, 0.4, rotated)).toBe(false);
  });

  it('respects vertical-band minY/maxY bounds on OBB, box, and circle obstacles', () => {
    const secondStoryWall = createObbObstacle(0, 0, 3.0, 0.3, 0, 2.8, 5.6);
    const secondStoryBox: Obstacle = {
      kind: 'box',
      minX: 8,
      maxX: 11,
      minZ: -0.5,
      maxZ: 0.5,
      minY: 2.8,
      maxY: 5.6,
    };
    const secondStoryPillar: Obstacle = {
      kind: 'circle',
      x: -8,
      z: 0,
      radius: 0.6,
      minY: 2.8,
      maxY: 5.6,
    };
    const obstacles: Obstacle[] = [secondStoryWall, secondStoryBox, secondStoryPillar];

    // Ground floor actor (y = 0 -> span [0.16, 1.72]) passes cleanly underneath all 3
    expect(resolveHorizontalCollision({ x: 0, z: 0.1 }, 0.44, obstacles, 0)).toBe(false);
    expect(resolveHorizontalCollision({ x: 9.5, z: 0 }, 0.44, obstacles, 0)).toBe(false);
    expect(resolveHorizontalCollision({ x: -8, z: 0.2 }, 0.44, obstacles, 0)).toBe(false);

    // 2nd-story actor (y = 2.8 -> span [2.96, 4.52]) collides with all 3
    const obbHitPos = { x: 0, z: 0.1 };
    expect(resolveHorizontalCollision(obbHitPos, 0.44, obstacles, 2.8)).toBe(true);
    expect(Math.abs(obbHitPos.z)).toBeGreaterThanOrEqual(0.58);

    expect(resolveHorizontalCollision({ x: 9.5, z: 0 }, 0.44, obstacles, 2.8)).toBe(true);
    expect(resolveHorizontalCollision({ x: -8, z: 0.2 }, 0.44, obstacles, 2.8)).toBe(true);

    // Roof actor above 2nd-story wall (y = 5.6 -> span [5.76, 7.32]) passes cleanly overhead
    expect(resolveHorizontalCollision({ x: 0, z: 0.1 }, 0.44, obstacles, 5.6)).toBe(false);
    expect(resolveHorizontalCollision({ x: 9.5, z: 0 }, 0.44, obstacles, 5.6)).toBe(false);
    expect(resolveHorizontalCollision({ x: -8, z: 0.2 }, 0.44, obstacles, 5.6)).toBe(false);

    // Legacy 3-argument call without actorY still collides for backward compatibility
    expect(resolveHorizontalCollision({ x: 0, z: 0.1 }, 0.44, obstacles)).toBe(true);
    expect(resolveHorizontalCollision({ x: 9.5, z: 0 }, 0.44, obstacles)).toBe(true);
    expect(resolveHorizontalCollision({ x: -8, z: 0.2 }, 0.44, obstacles)).toBe(true);
  });
});
