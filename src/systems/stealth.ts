import type { Obstacle } from '../world/terrain';

export interface StealthInput {
  readonly x: number;
  readonly z: number;
  readonly isCrouching: boolean;
  readonly isMoving: boolean;
  readonly isSprinting: boolean;
  readonly roadFactor: number;
  readonly inPuddle: boolean;
  readonly nightFactor?: number;
  readonly rainIntensity?: number;
  readonly flashlightOn?: boolean;
}

export interface StealthResult {
  visibility: number;
  noiseRadius: number;
  isConcealed: boolean;
}

const MIN_OCCLUDING_CIRCLE_RADIUS = 0.55;

/**
 * Returns true when (x, z) is sheltered under either of Old Route 9's concrete ruins:
 * - Left retaining bunker interior & overhanging concrete doorway alcove
 * - Right gas station concrete canopy & front ruin pad
 */
export function isInsideShelter(x: number, z: number): boolean {
  const inLeftBunker = x >= -13.0 && x <= -5.2 && z >= 0.4 && z <= 7.8;
  const inGasStation = x >= 6.9 && x <= 16.5 && z >= -13.1 && z <= -0.3;
  return inLeftBunker || inGasStation;
}

/**
 * Computes survivor visual exposure (0..1), acoustic noise radius (m), and foliage concealment.
 * Pass a pre-allocated `out` object inside per-frame loops for zero heap allocations.
 */
export function computeStealthFactor(
  input: StealthInput,
  out: StealthResult = { visibility: 1, noiseRadius: 0, isConcealed: false },
): StealthResult {
  const { isCrouching, isMoving, isSprinting, roadFactor, inPuddle } = input;
  const clampedRoad = roadFactor < 0 ? 0 : roadFactor > 1 ? 1 : roadFactor;
  const night = Math.max(0, Math.min(1, input.nightFactor ?? 0));
  const rain = Math.max(0, Math.min(1, input.rainIntensity ?? 0));
  const flashlightOn = input.flashlightOn === true;
  const inFoliageCover = clampedRoad < 0.35;

  const isConcealed = isCrouching && inFoliageCover && !isSprinting && !flashlightOn;

  let visibility: number;
  if (isSprinting) {
    visibility = 1.0;
  } else if (isCrouching) {
    if (inFoliageCover) {
      visibility = isMoving ? 0.34 : 0.28;
    } else {
      visibility = isMoving ? 0.66 : 0.58;
    }
  } else {
    visibility = 0.78 + clampedRoad * 0.22;
  }

  // Nighttime darkness conceals an unlit survivor, whereas an active flashlight acts as a beacon
  if (flashlightOn) {
    visibility = Math.min(1, Math.max(visibility, 0.78 + night * 0.18));
  } else {
    visibility *= 1 - night * 0.42;
  }

  let noiseRadius = 0;
  if (isMoving) {
    if (isSprinting) {
      noiseRadius = inPuddle ? 17.5 : 16.0;
    } else if (inPuddle) {
      noiseRadius = isCrouching ? 5.5 : 13.0;
    } else if (isCrouching) {
      noiseRadius = 2.5;
    } else {
      noiseRadius = clampedRoad > 0.45 ? 7.5 : 6.0;
    }
  }
  // Falling Pacific Northwest rain partially masks footstep acoustics
  noiseRadius *= 1 - rain * 0.28;

  out.visibility = visibility;
  out.noiseRadius = noiseRadius;
  out.isConcealed = isConcealed;
  return out;
}

function segmentIntersectsAabb(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-8) {
    if (ax < minX || ax > maxX) {
      return false;
    }
  } else {
    const invD = 1 / dx;
    let t1 = (minX - ax) * invD;
    let t2 = (maxX - ax) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) {
      return false;
    }
  }

  if (Math.abs(dz) < 1e-8) {
    if (az < minZ || az > maxZ) {
      return false;
    }
  } else {
    const invD = 1 / dz;
    let t1 = (minZ - az) * invD;
    let t2 = (maxZ - az) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) {
      return false;
    }
  }

  return tMax >= 0 && tMin <= 1;
}

function segmentIntersectsCircle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  radius: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-10) {
    const rx = ax - cx;
    const rz = az - cz;
    return rx * rx + rz * rz <= radius * radius;
  }
  let t = ((cx - ax) * dx + (cz - az) * dz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const closestX = ax + dx * t;
  const closestZ = az + dz * t;
  const distX = closestX - cx;
  const distZ = closestZ - cz;
  return distX * distX + distZ * distZ <= radius * radius;
}

/**
 * Fast zero-allocation 2D line-of-sight occlusion test against ruins, boulders, and wrecked vehicles.
 * Thin tree trunks and utility poles (radius < 0.55 m) are skipped so foliage trunks don't fully blind AI.
 */
export function hasLineOfSight(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  obstacles: readonly Obstacle[],
): boolean {
  for (let i = 0; i < obstacles.length; i += 1) {
    const obs = obstacles[i];
    if (!obs) {
      continue;
    }

    if (obs.kind === 'circle') {
      if (obs.radius < MIN_OCCLUDING_CIRCLE_RADIUS) {
        continue;
      }
      if (segmentIntersectsCircle(ax, az, bx, bz, obs.x, obs.z, obs.radius)) {
        return false;
      }
    } else if (obs.kind === 'box') {
      if (segmentIntersectsAabb(ax, az, bx, bz, obs.minX, obs.maxX, obs.minZ, obs.maxZ)) {
        return false;
      }
    } else {
      // Transform endpoints into OBB local space matching terrain.ts Object3D.rotation.y convention
      const relAx = ax - obs.x;
      const relAz = az - obs.z;
      const lax = relAx * obs.cos - relAz * obs.sin;
      const laz = relAx * obs.sin + relAz * obs.cos;

      const relBx = bx - obs.x;
      const relBz = bz - obs.z;
      const lbx = relBx * obs.cos - relBz * obs.sin;
      const lbz = relBx * obs.sin + relBz * obs.cos;

      if (
        segmentIntersectsAabb(
          lax,
          laz,
          lbx,
          lbz,
          -obs.halfWidth,
          obs.halfWidth,
          -obs.halfDepth,
          obs.halfDepth,
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Checks whether (targetX, targetZ) falls within an observer's horizontal vision cone.
 * Uses Three.js right-handed -Z forward yaw convention (fwdX = -sin(yaw), fwdZ = -cos(yaw)).
 */
export function isPointInVisionCone(
  eyeX: number,
  eyeZ: number,
  eyeYaw: number,
  targetX: number,
  targetZ: number,
  range: number,
  halfFovRad: number,
): boolean {
  if (range <= 0 || halfFovRad <= 0) {
    return false;
  }
  const dx = targetX - eyeX;
  const dz = targetZ - eyeZ;
  const distSq = dx * dx + dz * dz;
  if (distSq > range * range) {
    return false;
  }
  if (distSq < 1e-8) {
    return true;
  }
  const invDist = 1 / Math.sqrt(distSq);
  const fwdX = -Math.sin(eyeYaw);
  const fwdZ = -Math.cos(eyeYaw);
  const dot = (dx * fwdX + dz * fwdZ) * invDist;
  return dot >= Math.cos(halfFovRad);
}
