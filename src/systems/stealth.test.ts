import { describe, expect, it } from 'vitest';
import { createObbObstacle, type Obstacle } from '../world/terrain';
import {
  computeStealthFactor,
  hasLineOfSight,
  isInsideShelter,
  isPointInVisionCone,
} from './stealth';

describe('stealth, shelter & line-of-sight utilities', () => {
  it('conceals a crouching survivor off-road in ferns while exposing open-road movement', () => {
    const concealed = computeStealthFactor({
      x: -7.5,
      z: -6.0,
      isCrouching: true,
      isMoving: false,
      isSprinting: false,
      roadFactor: 0.05,
      inPuddle: false,
    });
    expect(concealed.isConcealed).toBe(true);
    expect(concealed.visibility).toBeCloseTo(0.28, 3);
    expect(concealed.noiseRadius).toBe(0);

    const crouchSneak = computeStealthFactor({
      x: -7.5,
      z: -6.0,
      isCrouching: true,
      isMoving: true,
      isSprinting: false,
      roadFactor: 0.1,
      inPuddle: false,
    });
    expect(crouchSneak.isConcealed).toBe(true);
    expect(crouchSneak.noiseRadius).toBe(2.5);

    const exposedSprint = computeStealthFactor({
      x: 1.0,
      z: -5.0,
      isCrouching: false,
      isMoving: true,
      isSprinting: true,
      roadFactor: 1.0,
      inPuddle: false,
    });
    expect(exposedSprint.isConcealed).toBe(false);
    expect(exposedSprint.visibility).toBe(1.0);
    expect(exposedSprint.noiseRadius).toBe(16.0);

    const puddleSplash = computeStealthFactor({
      x: 2.0,
      z: 9.6,
      isCrouching: false,
      isMoving: true,
      isSprinting: false,
      roadFactor: 1.0,
      inPuddle: true,
    });
    expect(puddleSplash.noiseRadius).toBe(13.0);
  });

  it('blocks line-of-sight through rotated OBB vehicles, boxes, and large boulders while ignoring thin trees', () => {
    const vanObb = createObbObstacle(0, 0, 2.4, 4.6, Math.PI * 0.25);
    const thinPine: Obstacle = { kind: 'circle', x: 0, z: 0, radius: 0.34 };
    const largeBoulder: Obstacle = { kind: 'circle', x: 0, z: 0, radius: 1.1 };
    const wallBox: Obstacle = { kind: 'box', minX: -1, maxX: 1, minZ: -0.5, maxZ: 0.5 };

    // Blocked by rotated OBB vehicle
    expect(hasLineOfSight(-5, 0, 5, 0, [vanObb])).toBe(false);
    // Clear well beside rotated OBB vehicle
    expect(hasLineOfSight(-5, 5, 5, 5, [vanObb])).toBe(true);

    // Thin tree trunk (< 0.55 m radius) does not blind AI
    expect(hasLineOfSight(-4, 0, 4, 0, [thinPine])).toBe(true);
    // Large boulder (>= 0.55 m radius) blocks LOS
    expect(hasLineOfSight(-4, 0, 4, 0, [largeBoulder])).toBe(false);

    // Box wall blocks LOS when crossed and stays clear around it
    expect(hasLineOfSight(0, -4, 0, 4, [wallBox])).toBe(false);
    expect(hasLineOfSight(3, -4, 3, 4, [wallBox])).toBe(true);
  });

  it('evaluates horizontal vision cones accurately under -Z forward yaw convention', () => {
    const halfFov = (55 * Math.PI) / 180;

    // Facing -Z (yaw = 0)
    expect(isPointInVisionCone(0, 0, 0, 0, -10, 18, halfFov)).toBe(true);
    expect(isPointInVisionCone(0, 0, 0, 5, -10, 18, halfFov)).toBe(true);
    expect(isPointInVisionCone(0, 0, 0, 0, 5, 18, halfFov)).toBe(false);
    expect(isPointInVisionCone(0, 0, 0, 0, -20, 18, halfFov)).toBe(false);

    // Facing -X (yaw = +PI/2 -> fwd = (-sin(PI/2), -cos(PI/2)) = (-1, 0))
    expect(isPointInVisionCone(0, 0, Math.PI * 0.5, -12, 1, 18, halfFov)).toBe(true);
    expect(isPointInVisionCone(0, 0, Math.PI * 0.5, 12, 0, 18, halfFov)).toBe(false);
  });

  it('detects sheltered concrete ruins vs exposed valley highway', () => {
    // Left retaining bunker interior & doorway overhang
    expect(isInsideShelter(-9.6, 4.0)).toBe(true);
    expect(isInsideShelter(-5.8, 3.6)).toBe(true);

    // Right gas station concrete canopy
    expect(isInsideShelter(9.8, -6.5)).toBe(true);
    expect(isInsideShelter(11.0, -3.5)).toBe(true);

    // Open highway & overlook spawn are exposed
    expect(isInsideShelter(-1.65, 14.3)).toBe(false);
    expect(isInsideShelter(0.8, -12.0)).toBe(false);
  });

  it('lowers visibility in darkness, exposes survivor with flashlight on, and masks footsteps in rain', () => {
    const dayCrouch = computeStealthFactor({
      x: -7.5,
      z: -6.0,
      isCrouching: true,
      isMoving: false,
      isSprinting: false,
      roadFactor: 0.05,
      inPuddle: false,
      nightFactor: 0,
      rainIntensity: 0,
      flashlightOn: false,
    });

    const nightCrouch = computeStealthFactor({
      x: -7.5,
      z: -6.0,
      isCrouching: true,
      isMoving: false,
      isSprinting: false,
      roadFactor: 0.05,
      inPuddle: false,
      nightFactor: 1.0,
      rainIntensity: 0,
      flashlightOn: false,
    });
    expect(nightCrouch.isConcealed).toBe(true);
    expect(nightCrouch.visibility).toBeCloseTo(dayCrouch.visibility * 0.58, 3);

    const nightFlashlight = computeStealthFactor({
      x: -7.5,
      z: -6.0,
      isCrouching: true,
      isMoving: false,
      isSprinting: false,
      roadFactor: 0.05,
      inPuddle: false,
      nightFactor: 1.0,
      rainIntensity: 0,
      flashlightOn: true,
    });
    expect(nightFlashlight.isConcealed).toBe(false);
    expect(nightFlashlight.visibility).toBeCloseTo(0.96, 3);

    const stormSprint = computeStealthFactor({
      x: 1.0,
      z: -5.0,
      isCrouching: false,
      isMoving: true,
      isSprinting: true,
      roadFactor: 1.0,
      inPuddle: false,
      nightFactor: 0.5,
      rainIntensity: 1.0,
      flashlightOn: false,
    });
    expect(stormSprint.noiseRadius).toBeCloseTo(16.0 * 0.72, 3);
  });
});
