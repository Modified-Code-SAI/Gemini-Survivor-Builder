export interface Vec2Like {
  x: number;
  z: number;
}

export interface WorldBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface ObstacleCircle {
  readonly kind: 'circle';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

export interface ObstacleBox {
  readonly kind: 'box';
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface ObstacleObb {
  readonly kind: 'obb';
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly cos: number;
  readonly sin: number;
}

export type Obstacle = ObstacleCircle | ObstacleBox | ObstacleObb;

export const WORLD_BOUNDS: WorldBounds = {
  minX: -52,
  maxX: 52,
  minZ: -86,
  maxZ: 32,
};

export const SPAWN_POINT: Readonly<Vec2Like> = {
  x: -1.65,
  z: 14.3,
};

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1;
  }
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Center X coordinate of the cracked valley highway at a given Z coordinate.
 * Near spawn (z ~ +14), the road sits slightly right of x=0 so the survivor on the
 * left concrete overlook views the yellow center line leading straight into the mist.
 */
export function getRoadCenterX(z: number): number {
  const macroCurve = Math.sin((z + 18) * 0.026) * 2.55;
  const microBend = Math.cos(z * 0.055) * 0.55;
  const foregroundShift = smoothstep(-8, 22, z) * 0.95;
  return macroCurve + microBend + foregroundShift;
}

/**
 * Analytical derivative d(roadCenterX)/dz for tangent orientation along the highway.
 */
export function getRoadTangentAngle(z: number): number {
  const eps = 0.25;
  const dx = getRoadCenterX(z - eps) - getRoadCenterX(z + eps);
  const dz = -2 * eps;
  return Math.atan2(dx, dz);
}

/**
 * Returns 1.0 on the asphalt roadbed, smoothly tapering to 0.0 on the forest floor.
 */
export function getRoadFactor(x: number, z: number): number {
  const distFromCenter = Math.abs(x - getRoadCenterX(z));
  return 1 - smoothstep(3.35, 6.2, distFromCenter);
}

/**
 * Base elevation of the highway roadbed sloping gently down into the misty valley (-Z).
 */
export function getRoadBaseHeight(z: number): number {
  const valleySlope = smoothstep(-95, 28, z) * 3.85 - 3.3;
  const gentleRoll = Math.sin(z * 0.045) * 0.18 + Math.cos(z * 0.09) * 0.07;
  return valleySlope + gentleRoll;
}

/**
 * Subtle raised concrete/asphalt overlook shelf at spawn (-1.65, 14.3)
 * mirroring the foreground rocky ledge overlooking the cracked highway.
 */
function getOverlookBoost(x: number, z: number): number {
  const dx = (x + 2.35) / 2.2;
  const dz = (z - 15.1) / 3.4;
  const radial = Math.sqrt(dx * dx + dz * dz);
  return (1 - smoothstep(0.62, 1.32, radial)) * 0.52;
}

/**
 * Deterministic multi-octave organic forest terrain relief (zero allocations).
 */
function forestRelief(x: number, z: number): number {
  const n1 = Math.sin(x * 0.062 + z * 0.041) * Math.cos(z * 0.053 - x * 0.027);
  const n2 = Math.sin(x * 0.145 - z * 0.118 + 1.4) * 0.42;
  const n3 = Math.cos(x * 0.29 + z * 0.24 - 0.8) * 0.16;
  return n1 * 0.95 + n2 + n3;
}

/**
 * Pure deterministic terrain heightfield in meters.
 * Forms a Pacific Northwest wooded canyon with a gently descending cracked highway
 * through the valley floor and elevated pine-covered ridges on both flanks.
 */
export function getTerrainHeight(x: number, z: number): number {
  const roadCenter = getRoadCenterX(z);
  const distFromRoad = Math.abs(x - roadCenter);
  const roadFactor = getRoadFactor(x, z);
  const baseRoadY = getRoadBaseHeight(z);

  // Flanking canyon ridges rising smoothly on left (-X) and right (+X)
  const ridgeStart = Math.max(0, distFromRoad - 6.0);
  const ridgeRamp = smoothstep(0, 48, ridgeStart);
  const sideAsymmetry = x < roadCenter ? 1.14 : 0.96;

  // Keep a flatter clearing pocket around the right-side gas station ruin (x ~ 11, z ~ -7)
  // and the left-side concrete bunker ruin (x ~ -11, z ~ 4) so ruins sit solidly on ground.
  const gasStationDist = Math.hypot((x - 11.8) * 0.72, (z + 7.5) * 0.65);
  const gasPadFlatten = 1 - smoothstep(4.5, 11.5, gasStationDist);

  const bunkerDist = Math.hypot((x + 11.2) * 0.78, (z - 4.2) * 0.75);
  const bunkerPadFlatten = 1 - smoothstep(3.5, 9.0, bunkerDist);

  const ruinFlatten = Math.max(gasPadFlatten * 0.82, bunkerPadFlatten * 0.65);

  const ridgeElevation = (ridgeRamp * ridgeRamp * 15.5 + ridgeStart * 0.085) * sideAsymmetry;
  const organicNoise = forestRelief(x, z) * (1 - roadFactor * 0.92);

  // Subtle asphalt wear/heave on the cracked roadbed
  const roadMicroWear = (Math.sin(x * 0.85 + z * 0.45) * 0.025 + Math.cos(z * 1.1) * 0.015) * roadFactor;

  const naturalHeight =
    baseRoadY +
    ridgeElevation * (1 - roadFactor) * (1 - ruinFlatten) +
    organicNoise * (0.65 + ridgeRamp * 1.8) * (1 - ruinFlatten * 0.7) +
    roadMicroWear;

  return naturalHeight + getOverlookBoost(x, z);
}

/**
 * Surface normal approximation via central finite differences.
 * Mutates caller-provided output components to avoid heap allocations.
 */
export function getTerrainNormal(
  x: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  const eps = 0.35;
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);

  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const invLen = 1 / Math.hypot(nx, ny, nz);

  out.x = nx * invLen;
  out.y = ny * invLen;
  out.z = nz * invLen;
}

/**
 * Clamps a horizontal position in-place to the playable frontier valley bounds.
 */
export function clampToWorldBounds(
  pos: Vec2Like,
  margin = 0,
  bounds: WorldBounds = WORLD_BOUNDS,
): void {
  pos.x = clamp(pos.x, bounds.minX + margin, bounds.maxX - margin);
  pos.z = clamp(pos.z, bounds.minZ + margin, bounds.maxZ - margin);
}

/**
 * Resolves horizontal circle-vs-obstacle collisions in-place with zero allocations.
 * Runs two passes so corner overlaps between adjacent obstacles settle cleanly.
 */
export function resolveHorizontalCollision(
  pos: Vec2Like,
  actorRadius: number,
  obstacles: readonly Obstacle[],
  bounds: WorldBounds = WORLD_BOUNDS,
): boolean {
  let collided = false;

  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < obstacles.length; i += 1) {
      const obs = obstacles[i];
      if (!obs) {
        continue;
      }

      if (obs.kind === 'circle') {
        const dx = pos.x - obs.x;
        const dz = pos.z - obs.z;
        const minDist = actorRadius + obs.radius;
        const distSq = dx * dx + dz * dz;

        if (distSq < minDist * minDist) {
          collided = true;
          if (distSq > 1e-8) {
            const dist = Math.sqrt(distSq);
            const push = (minDist - dist) / dist;
            pos.x += dx * push;
            pos.z += dz * push;
          } else {
            pos.x += minDist;
          }
        }
      } else if (obs.kind === 'box') {
        const closestX = clamp(pos.x, obs.minX, obs.maxX);
        const closestZ = clamp(pos.z, obs.minZ, obs.maxZ);
        const dx = pos.x - closestX;
        const dz = pos.z - closestZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < actorRadius * actorRadius) {
          collided = true;
          if (distSq > 1e-8) {
            const dist = Math.sqrt(distSq);
            const push = (actorRadius - dist) / dist;
            pos.x += dx * push;
            pos.z += dz * push;
          } else {
            // Actor center is strictly inside the box — push out along shallowest axis
            const penLeft = pos.x - obs.minX;
            const penRight = obs.maxX - pos.x;
            const penBack = pos.z - obs.minZ;
            const penFront = obs.maxZ - pos.z;
            const minPen = Math.min(penLeft, penRight, penBack, penFront);
            if (minPen === penLeft) {
              pos.x = obs.minX - actorRadius;
            } else if (minPen === penRight) {
              pos.x = obs.maxX + actorRadius;
            } else if (minPen === penBack) {
              pos.z = obs.minZ - actorRadius;
            } else {
              pos.z = obs.maxZ + actorRadius;
            }
          }
        }
      } else {
        // Oriented bounding box in XZ plane (matches Three.js Object3D.rotation.y):
        // Local-to-world: wx = lx * cos + lz * sin, wz = -lx * sin + lz * cos
        // World-to-local: lx = relX * cos - relZ * sin, lz = relX * sin + relZ * cos
        const relX = pos.x - obs.x;
        const relZ = pos.z - obs.z;
        const localX = relX * obs.cos - relZ * obs.sin;
        const localZ = relX * obs.sin + relZ * obs.cos;

        const clampedX = clamp(localX, -obs.halfWidth, obs.halfWidth);
        const clampedZ = clamp(localZ, -obs.halfDepth, obs.halfDepth);
        const dx = localX - clampedX;
        const dz = localZ - clampedZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < actorRadius * actorRadius) {
          collided = true;
          let pushLocalX = 0;
          let pushLocalZ = 0;

          if (distSq > 1e-8) {
            const dist = Math.sqrt(distSq);
            const push = (actorRadius - dist) / dist;
            pushLocalX = dx * push;
            pushLocalZ = dz * push;
          } else {
            const penX = obs.halfWidth - Math.abs(localX);
            const penZ = obs.halfDepth - Math.abs(localZ);
            if (penX < penZ) {
              pushLocalX = (localX >= 0 ? 1 : -1) * (penX + actorRadius);
            } else {
              pushLocalZ = (localZ >= 0 ? 1 : -1) * (penZ + actorRadius);
            }
          }

          pos.x += pushLocalX * obs.cos + pushLocalZ * obs.sin;
          pos.z += -pushLocalX * obs.sin + pushLocalZ * obs.cos;
        }
      }
    }

    const beforeX = pos.x;
    const beforeZ = pos.z;
    clampToWorldBounds(pos, actorRadius, bounds);
    if (pos.x !== beforeX || pos.z !== beforeZ) {
      collided = true;
    }
  }

  return collided;
}

/**
 * Helper for creating an oriented box obstacle from center, full width/depth, and Y rotation.
 * `rotationY` uses the exact Three.js right-handed `Object3D.rotation.y` convention (radians CCW around +Y).
 */
export function createObbObstacle(
  x: number,
  z: number,
  width: number,
  depth: number,
  rotationY: number,
): ObstacleObb {
  return {
    kind: 'obb',
    x,
    z,
    halfWidth: width * 0.5,
    halfDepth: depth * 0.5,
    cos: Math.cos(rotationY),
    sin: Math.sin(rotationY),
  };
}
