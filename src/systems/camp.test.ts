import { describe, expect, it } from 'vitest';
import type { Obstacle, Vec2Like } from '../world/terrain';
import {
  CAMPFIRE_REPEL_RADIUS,
  CAMPFIRE_WARMTH_RADIUS,
  createCampSystem,
  MAX_CAMPFIRES,
  MAX_SHELTERS,
  type CampProximityInfo,
} from './camp';

describe('camp building & survival shelter system', () => {
  it('validates campfire placement against puddles, obstacles, overlaps, and limits, and reports warmth & repel radii', () => {
    const baseRock: Obstacle = { kind: 'circle', x: 5, z: -10, radius: 1.5 };
    const obstacles: Obstacle[] = [baseRock];
    const camp = createCampSystem({
      obstacles,
      isInsidePuddle: (x, z) => Math.hypot(x - 0, z - 0) < 1.5,
    });

    // Blocked by puddle at (0, 0)
    const puddleAttempt = camp.tryBuildCampfire(0, 1.85, 0, -1);
    expect(puddleAttempt.ok).toBe(false);
    expect(puddleAttempt.reason).toBe('puddle');

    // Blocked by solid boulder at (5, -10)
    const rockAttempt = camp.tryBuildCampfire(5, -8.15, 0, -1);
    expect(rockAttempt.ok).toBe(false);
    expect(rockAttempt.reason).toBe('blocked');

    // Succeeds on clear ground at (-4, -6)
    const first = camp.tryBuildCampfire(-4, -4.15, 0, -1);
    expect(first.ok).toBe(true);
    expect(first.x).toBeCloseTo(-4, 2);
    expect(first.z).toBeCloseTo(-6, 2);
    expect(obstacles.length).toBe(2);

    // Rejects overlapping campfire too close to existing fire
    const overlap = camp.tryBuildCampfire(-4, -5.0, 0, -1);
    expect(overlap.ok).toBe(false);
    expect(overlap.reason).toBe('overlap');

    // Proximity checks: cooking, warmth radius, and Stalker repel radius
    const prox: CampProximityInfo = {
      nearFire: false,
      inCampShelter: false,
      fireProximity: 0,
      fireX: 0,
      fireZ: 0,
      canCookAtFire: false,
    };
    camp.sampleProximity(-4, -4.2, prox);
    expect(prox.nearFire).toBe(true);
    expect(prox.canCookAtFire).toBe(true);
    expect(prox.fireProximity).toBeGreaterThan(0.7);

    camp.sampleProximity(-4, -6 + CAMPFIRE_WARMTH_RADIUS - 0.5, prox);
    expect(prox.nearFire).toBe(true);
    expect(prox.canCookAtFire).toBe(false);

    const repelPos: Vec2Like = { x: 0, z: 0 };
    expect(camp.getCampfireRepelPoint(-4, -6 + CAMPFIRE_REPEL_RADIUS - 0.5, repelPos)).toBe(true);
    expect(repelPos.x).toBeCloseTo(-4, 2);
    expect(repelPos.z).toBeCloseTo(-6, 2);
    expect(camp.getCampfireRepelPoint(-4, -6 + CAMPFIRE_REPEL_RADIUS + 1.0, repelPos)).toBe(false);

    // Enforces MAX_CAMPFIRES limit cleanly
    expect(camp.tryBuildCampfire(-12, -10, 0, -1).ok).toBe(true);
    expect(camp.tryBuildCampfire(-18, -16, 0, -1).ok).toBe(true);
    expect(camp.getCounts().campfires).toBe(MAX_CAMPFIRES);
    const overLimit = camp.tryBuildCampfire(-24, -22, 0, -1);
    expect(overLimit.ok).toBe(false);
    expect(overLimit.reason).toBe('limit');

    camp.dispose();
  });

  it('builds lean-to shelters, registers camp respawn point, and cleanly restores obstacles on reset()', () => {
    const initialObstacle: Obstacle = { kind: 'circle', x: 20, z: 20, radius: 1.0 };
    const obstacles: Obstacle[] = [initialObstacle];
    const camp = createCampSystem({
      obstacles,
      isInsidePuddle: () => false,
    });

    const respawn: Vec2Like = { x: 0, z: 0 };
    expect(camp.getCampRespawnPoint(respawn)).toBe(false);

    const built = camp.tryBuildShelter(-8, -14, 0, -1);
    expect(built.ok).toBe(true);
    expect(camp.getCounts().shelters).toBe(1);
    expect(obstacles.length).toBeGreaterThan(1);

    // Inside shelter footprint registers inCampShelter
    const prox: CampProximityInfo = {
      nearFire: false,
      inCampShelter: false,
      fireProximity: 0,
      fireX: 0,
      fireZ: 0,
      canCookAtFire: false,
    };
    camp.sampleProximity(built.x, built.z, prox);
    expect(prox.inCampShelter).toBe(true);

    // Respawn point stands cleanly in front of the open shelter entrance
    expect(camp.getCampRespawnPoint(respawn)).toBe(true);
    expect(Math.hypot(respawn.x - built.x, respawn.z - built.z)).toBeGreaterThan(1.2);
    expect(Math.hypot(respawn.x - built.x, respawn.z - built.z)).toBeLessThan(2.5);

    // Enforces MAX_SHELTERS
    expect(camp.tryBuildShelter(-16, -24, 0, -1).ok).toBe(true);
    expect(camp.getCounts().shelters).toBe(MAX_SHELTERS);
    expect(camp.tryBuildShelter(-24, -32, 0, -1).reason).toBe('limit');

    // Also add a campfire and confirm reset() clears structures AND removes all added colliders
    expect(camp.tryBuildCampfire(6, -18, 0, -1).ok).toBe(true);
    camp.update(1 / 60, 2.5);

    camp.reset();
    expect(camp.getCounts()).toEqual({ campfires: 0, shelters: 0 });
    expect(camp.getCampRespawnPoint(respawn)).toBe(false);
    expect(obstacles).toEqual([initialObstacle]);

    camp.dispose();
  });

  it('serializes and hydrates campfires & shelters with full warmth, shelter, respawn, and obstacle restoration', () => {
    const baseRock: Obstacle = { kind: 'circle', x: 25, z: 25, radius: 1.0 };
    const obstacles: Obstacle[] = [baseRock];
    const camp = createCampSystem({
      obstacles,
      isInsidePuddle: () => false,
    });

    const fire = camp.tryBuildCampfire(-10, -8, 0, -1);
    const shelter = camp.tryBuildShelter(-16, -8, 1, 0);
    expect(fire.ok).toBe(true);
    expect(shelter.ok).toBe(true);
    const expectedObstacleCount = obstacles.length;
    expect(expectedObstacleCount).toBe(5); // 1 base + 1 fire + 3 shelter rear posts

    const saved = camp.serialize();
    expect(saved.campfires.length).toBe(1);
    expect(saved.shelters.length).toBe(1);

    camp.reset();
    expect(obstacles).toEqual([baseRock]);
    expect(camp.getCounts()).toEqual({ campfires: 0, shelters: 0 });

    camp.hydrate(saved);
    expect(camp.getCounts()).toEqual({ campfires: 1, shelters: 1 });
    expect(obstacles.length).toBe(expectedObstacleCount);

    const prox: CampProximityInfo = {
      nearFire: false,
      inCampShelter: false,
      fireProximity: 0,
      fireX: 0,
      fireZ: 0,
      canCookAtFire: false,
    };
    camp.sampleProximity(fire.x, fire.z, prox);
    expect(prox.nearFire).toBe(true);
    expect(prox.canCookAtFire).toBe(true);

    camp.sampleProximity(shelter.x, shelter.z, prox);
    expect(prox.inCampShelter).toBe(true);

    const respawn: Vec2Like = { x: 0, z: 0 };
    expect(camp.getCampRespawnPoint(respawn)).toBe(true);
    expect(Math.hypot(respawn.x - shelter.x, respawn.z - shelter.z)).toBeGreaterThan(1.2);

    camp.dispose();
    expect(obstacles).toEqual([baseRock]);
  });
});
