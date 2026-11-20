import * as THREE from 'three';
import { collectMaterialTextures, loadOptionalGlbAsset } from '../world/assetLoader';
import {
  clamp,
  getRoadFactor,
  getTerrainHeight,
  resolveHorizontalCollision,
  SPAWN_POINT,
  type Obstacle,
  type Vec2Like,
} from '../world/terrain';
import { getWorldTextureAtlas, type PbrTextureSet } from '../world/textures';

export type PlayerStance =
  | 'standing'
  | 'sprinting'
  | 'crouching'
  | 'airborne'
  | 'attacking'
  | 'throwing';
export type SurfaceKind = 'asphalt' | 'forest' | 'puddle';

export interface PlayerControllerOptions {
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly canvas: HTMLCanvasElement;
  readonly obstacles: readonly Obstacle[];
  readonly isInsidePuddle?: (x: number, z: number) => boolean;
  readonly canSprint?: () => boolean;
  readonly canJump?: () => boolean;
  readonly canAttack?: () => boolean;
  readonly canThrowBottle?: () => boolean;
  readonly onFootstep?: (surface: SurfaceKind, intensity: number) => void;
  readonly onJump?: () => void;
  readonly onLand?: (surface: SurfaceKind) => void;
  readonly onAttackStart?: () => void;
  readonly onAttack?: () => void;
  readonly onAttackHitWindow?: (x: number, z: number, fwdX: number, fwdZ: number) => void;
  readonly onInteract?: () => void;
  readonly onThrowBottle?: () => void;
  readonly onThrowEmpty?: () => void;
  readonly onThrowRelease?: (
    originX: number,
    originY: number,
    originZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
  ) => void;
  readonly onQuickUse?: (slot: 1 | 2 | 3) => void;
  readonly onToggleFlashlight?: () => void;
  readonly onAdvanceTime?: () => void;
  readonly onToggleStorm?: () => void;
  readonly onBuildCampfire?: () => void;
  readonly onBuildShelter?: () => void;
  readonly onStanceChange?: (stance: PlayerStance) => void;
  readonly onPointerLockChange?: (locked: boolean) => void;
}

export interface PlayerController {
  readonly root: THREE.Group;
  readonly position: THREE.Vector3;
  isPointerLocked(): boolean;
  requestPointerLock(): void;
  setInputEnabled(enabled: boolean): void;
  setFlashlightActive(active: boolean): void;
  getFlashlightTransform(outOrigin: THREE.Vector3, outDir: THREE.Vector3): void;
  getStance(): PlayerStance;
  getCameraYaw(): number;
  getForwardXZ(out: Vec2Like): void;
  getCameraAimDir(out: THREE.Vector3): void;
  isSprinting(): boolean;
  isCrouching(): boolean;
  isMoving(): boolean;
  triggerHitShake(intensity: number): void;
  resetToSpawn(targetX?: number, targetZ?: number): void;
  update(dt: number, elapsed: number): void;
  updateCamera(dt: number): void;
  dispose(): void;
}

interface SurvivorRig {
  readonly root: THREE.Group;
  readonly hips: THREE.Group;
  readonly torso: THREE.Group;
  readonly chestUpper: THREE.Group;
  readonly head: THREE.Group;
  readonly leftArm: THREE.Group;
  readonly leftForearm: THREE.Group;
  readonly rightArm: THREE.Group;
  readonly rightForearm: THREE.Group;
  readonly axePivot: THREE.Group;
  readonly leftLeg: THREE.Group;
  readonly leftCalf: THREE.Group;
  readonly leftBoot: THREE.Group;
  readonly rightLeg: THREE.Group;
  readonly rightCalf: THREE.Group;
  readonly rightBoot: THREE.Group;
  dispose(): void;
}

interface GlbSurvivorState {
  readonly wrapper: THREE.Group;
  readonly scene: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly idleAction: THREE.AnimationAction | null;
  readonly walkAction: THREE.AnimationAction | null;
  readonly jogAction: THREE.AnimationAction | null;
  readonly runAction: THREE.AnimationAction | null;
  readonly crouchIdleAction: THREE.AnimationAction | null;
  readonly crouchWalkAction: THREE.AnimationAction | null;
  readonly idleLowerAction: THREE.AnimationAction | null;
  readonly walkLowerAction: THREE.AnimationAction | null;
  readonly jogLowerAction: THREE.AnimationAction | null;
  readonly runLowerAction: THREE.AnimationAction | null;
  readonly crouchIdleLowerAction: THREE.AnimationAction | null;
  readonly crouchWalkLowerAction: THREE.AnimationAction | null;
  readonly jumpStartAction: THREE.AnimationAction | null;
  readonly jumpAirAction: THREE.AnimationAction | null;
  readonly jumpLandAction: THREE.AnimationAction | null;
  readonly attackRightAction: THREE.AnimationAction | null;
  readonly attackRightUpperAction: THREE.AnimationAction | null;
  readonly attackLeftAction: THREE.AnimationAction | null;
  readonly attackLeftUpperAction: THREE.AnimationAction | null;
  readonly throwAction: THREE.AnimationAction | null;
  readonly throwUpperAction: THREE.AnimationAction | null;
  wIdle: number;
  wWalk: number;
  wJog: number;
  wRun: number;
  wCrouchIdle: number;
  wCrouchWalk: number;
  wJumpStart: number;
  wJumpAir: number;
  wJumpLand: number;
  wAttackRight: number;
  wAttackLeft: number;
  wThrow: number;
}

const LOWER_BODY_BONES = new Set<string>([
  'root',
  'pelvis',
  'thigh_L',
  'thigh_twist_L',
  'shin_L',
  'foot_L',
  'toe_L',
  'thigh_R',
  'thigh_twist_R',
  'shin_R',
  'foot_R',
  'toe_R',
]);

function filterClipByBodyRegion(
  clip: THREE.AnimationClip | null,
  suffix: string,
  keepLower: boolean,
): THREE.AnimationClip | null {
  if (!clip) {
    return null;
  }
  const filteredTracks: THREE.KeyframeTrack[] = [];
  for (let i = 0; i < clip.tracks.length; i += 1) {
    const track = clip.tracks[i];
    if (!track) {
      continue;
    }
    const dotIdx = track.name.lastIndexOf('.');
    const pathPart = dotIdx >= 0 ? track.name.slice(0, dotIdx) : track.name;
    const slashIdx = pathPart.lastIndexOf('/');
    const nodeName = slashIdx >= 0 ? pathPart.slice(slashIdx + 1) : pathPart;
    if (LOWER_BODY_BONES.has(nodeName) === keepLower) {
      filteredTracks.push(track);
    }
  }
  if (filteredTracks.length === 0) {
    return null;
  }
  return new THREE.AnimationClip(`${clip.name}_${suffix}`, clip.duration, filteredTracks);
}

function findUniqueClip(
  clips: readonly THREE.AnimationClip[],
  exactName: string,
  used: Set<THREE.AnimationClip>,
  allowSubstringFallback = false,
  excludeSubstrings: readonly string[] = [],
): THREE.AnimationClip | null {
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    if (clip && !used.has(clip) && clip.name.toLowerCase() === exactName) {
      used.add(clip);
      return clip;
    }
  }
  if (allowSubstringFallback) {
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      if (!clip || used.has(clip)) {
        continue;
      }
      const lower = clip.name.toLowerCase();
      if (!lower.includes(exactName)) {
        continue;
      }
      let excluded = false;
      for (let j = 0; j < excludeSubstrings.length; j += 1) {
        const bad = excludeSubstrings[j];
        if (bad && lower.includes(bad)) {
          excluded = true;
          break;
        }
      }
      if (!excluded) {
        used.add(clip);
        return clip;
      }
    }
  }
  return null;
}

const L_THIGH = 0.42;
const L_SHIN = 0.42;
const HIP_LEG_OFFSET = 0.04;
const BOOT_SOLE_HEIGHT = 0.088;

function disposeObject3DTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((node: THREE.Object3D) => {
    if (node instanceof THREE.SkinnedMesh && node.skeleton) {
      skeletons.add(node.skeleton);
    }
    if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
      if (node.geometry instanceof THREE.BufferGeometry) {
        geometries.add(node.geometry);
      }
      const mat = node.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          if (m instanceof THREE.Material) {
            materials.add(m);
            collectMaterialTextures(m, textures);
          }
        }
      } else if (mat instanceof THREE.Material) {
        materials.add(mat);
        collectMaterialTextures(mat, textures);
      }
    }
  });
  for (const s of skeletons) {
    s.dispose();
  }
  for (const t of textures) {
    t.dispose();
  }
  for (const g of geometries) {
    g.dispose();
  }
  for (const m of materials) {
    m.dispose();
  }
}

/**
 * Vertex-sculpted adult human cranium, brow ridge, nose bridge, cheekbones, and jaw
 * with baked subtle weathered skin + short rugged beard/stubble shading.
 */
function createSculptedHeadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.11, 24, 20);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }

  const colors = new Float32Array(pos.count * 3);
  const skinBase = new THREE.Color(0xc29172);
  const skinShadow = new THREE.Color(0x9b6e55);
  const beardTone = new THREE.Color(0x4a392d);
  const col = new THREE.Color();

  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Adult cranial proportions: narrower width, elongated vertical facial plane
    x *= 0.87;
    y *= 1.13;
    z *= 0.99;

    // Taper lower jaw & pull chin subtly forward (-Z is face direction)
    if (y < -0.015) {
      const jawT = clamp((-y - 0.015) / 0.11, 0, 1);
      x *= 1 - jawT * 0.34;
      if (z < 0) {
        z -= jawT * 0.015;
      } else {
        // Taper under back skull smoothly toward neck
        z *= 1 - jawT * 0.24;
      }
    }

    // Subtle brow ridge & eye-socket recess on front face (-Z)
    if (z < -0.04) {
      const browFactor = Math.exp(-Math.pow((y - 0.032) / 0.018, 2)) * (1 - Math.min(1, Math.abs(x) / 0.075));
      z -= browFactor * 0.01;

      const eyeBand = Math.exp(-Math.pow((y - 0.012) / 0.016, 2));
      const eyeSide = Math.exp(-Math.pow((Math.abs(x) - 0.034) / 0.018, 2));
      z += eyeBand * eyeSide * 0.011;

      // Sculpted nose bridge
      const noseBand = Math.exp(-Math.pow((y + 0.002) / 0.025, 2));
      const noseCenter = Math.exp(-Math.pow(x / 0.016, 2));
      z -= noseBand * noseCenter * 0.019;
    }

    // Back skull occiput curve
    if (z > 0.03 && y > -0.02) {
      z += Math.exp(-Math.pow((y - 0.025) / 0.055, 2)) * 0.012;
    }

    pos.setXYZ(i, x, y, z);

    // Weathered facial tonal shading: shadowed eye sockets, dark brows, cheek contour & full short beard
    col.copy(skinBase);
    const eyeSocketDark =
      z < -0.042
        ? Math.exp(-Math.pow((y - 0.014) / 0.018, 2)) *
          Math.exp(-Math.pow((Math.abs(x) - 0.034) / 0.024, 2)) *
          0.62
        : 0;
    const browDark =
      z < -0.045
        ? Math.exp(-Math.pow((y - 0.036) / 0.01, 2)) *
          (1 - clamp(Math.abs(x) / 0.072, 0, 1)) *
          0.72
        : 0;
    const underJawShadow = y < -0.062 ? clamp((-y - 0.062) / 0.055, 0, 1) * 0.5 : 0;
    col.lerp(skinShadow, clamp(eyeSocketDark + underJawShadow, 0, 0.78));
    col.lerp(beardTone, clamp(browDark, 0, 0.72));

    // Rugged short weathered beard & sideburn stubble along jaw, chin, upper lip & lower cheeks
    if (y < -0.01 && z < 0.032) {
      const beardMask = clamp((-y - 0.01) / 0.035, 0, 1) * clamp((0.032 - z) / 0.055, 0, 1);
      const mustacheMask =
        z < -0.065 ? Math.exp(-Math.pow((y + 0.028) / 0.014, 2)) * (1 - clamp(Math.abs(x) / 0.045, 0, 1)) : 0;
      col.lerp(beardTone, clamp(Math.max(beardMask * 0.78, mustacheMask * 0.75), 0, 0.85));
    }

    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Weathered ribbed knit survival watch cap / beanie with folded cuff rim and knit rib creases.
 */
function createKnitBeanieGeometry(): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.114, -0.012), // Folded lower knit cuff bottom
    new THREE.Vector2(0.122, 0.008), // Folded cuff outer bulge
    new THREE.Vector2(0.121, 0.042), // Upper edge of folded cuff
    new THREE.Vector2(0.114, 0.048), // Step inward to crown body
    new THREE.Vector2(0.112, 0.088),
    new THREE.Vector2(0.095, 0.124),
    new THREE.Vector2(0.058, 0.146),
    new THREE.Vector2(0.0, 0.154), // Rounded knit crown apex
  ];
  const geo = new THREE.LatheGeometry(profile, 28);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }
  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);
    const angle = Math.atan2(z, x);
    // Vertical ribbed knit texture ridges + slight relaxed slouch toward back (+Z)
    const rib = Math.sin(angle * 22) * 0.0028 * (y < 0.05 ? 1.35 : 0.85);
    x = x * 0.92 + Math.cos(angle) * rib;
    z = z * 1.03 + Math.sin(angle) * rib + clamp(y / 0.15, 0, 1) * 0.016;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Multi-layered tousled dark-brown hair shell with organic wavy lock ridges
 * covering crown, side temples, and full layered nape facing the third-person camera.
 */
function createSculptedHairGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.119, 24, 18);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }

  const colors = new Float32Array(pos.count * 3);
  const hairDark = new THREE.Color(0x211812);
  const hairMid = new THREE.Color(0x37281e);
  const col = new THREE.Color();

  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    x *= 0.91;
    y *= 1.07;
    z *= 1.03;

    // Carve open the front face cleanly while preserving hairline, temples, sideburns & full back nape
    const isFrontFace = z < -0.028 && y < 0.048;
    if (isFrontFace) {
      // Pull front lower face vertices inward cleanly behind the sculpted face
      const pull = clamp((-z - 0.028) / 0.05, 0, 1) * clamp((0.048 - y) / 0.055, 0, 1);
      x *= 1 - pull * 0.42;
      z += pull * 0.052;
      y += pull * 0.025;
    }

    // Extend tousled layered hair down the back nape & slightly messy crown wave ridges
    if (z > -0.01 && y > -0.075) {
      const wave =
        Math.sin(x * 68 + y * 24) * 0.0055 +
        Math.cos(z * 54 - y * 36) * 0.0045 +
        Math.sin((x + z) * 95) * 0.0025;
      const radial = Math.hypot(x, z);
      if (radial > 0.01) {
        x += (x / radial) * wave;
        z += (z / radial) * wave;
      }
      y += wave * 0.6;
    }

    // Taper nape smoothly into collar line
    if (z > 0.02 && y < -0.03) {
      const napeT = clamp((-y - 0.03) / 0.09, 0, 1);
      x *= 1 - napeT * 0.25;
      z += napeT * 0.008;
    }

    pos.setXYZ(i, x, y, z);

    const highlight =
      0.5 + 0.35 * Math.sin(x * 58 + y * 30) + 0.15 * clamp((y + 0.04) / 0.14, 0, 1);
    col.copy(hairDark).lerp(hairMid, clamp(highlight, 0, 1));
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Contoured athletic survivor jacket torso built with LatheGeometry + vertex shaping
 * (flared draped hem over hips, tapered waist, broad chest/lats, natural spine curve, and fabric folds).
 */
function createAnatomicalTorsoGeometry(): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.195, -0.06), // Flared jacket bottom hem over hips
    new THREE.Vector2(0.188, 0.02),
    new THREE.Vector2(0.168, 0.12), // Tapered athletic waist
    new THREE.Vector2(0.182, 0.24),
    new THREE.Vector2(0.212, 0.37), // Broad chest / lats
    new THREE.Vector2(0.222, 0.46), // Shoulder deltoid line
    new THREE.Vector2(0.165, 0.53), // Trapezius slope
    new THREE.Vector2(0.1, 0.565), // Neck collar base
  ];
  const geo = new THREE.LatheGeometry(profile, 22);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }

  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);

    // Oval human torso cross-section (wider side-to-side, flatter front-to-back)
    x *= 1.12;
    z *= 0.67;

    // Natural subtle lumbar curve & proud chest contour
    const spineShift = Math.sin(((y + 0.06) / 0.62) * Math.PI) * -0.016;
    z += spineShift;

    // Subtle vertical cloth folds along the jacket hem & waist
    const angle = Math.atan2(z, x);
    const fold = Math.sin(angle * 7 + y * 14) * 0.0055 * (1 - clamp((y - 0.1) / 0.35, 0, 1));
    x += Math.cos(angle) * fold;
    z += Math.sin(angle) * fold;

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  return geo;
}

/**
 * Rounded organic canvas rucksack body (soft sculpted pack contours instead of a flat cube).
 */
function createRoundedPackGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, 6, 8, 5);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = x / hw;
    const ny = y / hh;
    const nz = z / hd;
    const r = Math.hypot(nx, ny, nz);
    const round = 1 - Math.max(0, r - 0.92) * 0.24;
    // Slight realistic gravity bulge near bottom-back of loaded pack
    const bulge = z > 0 ? Math.max(0, -ny + 0.3) * 0.022 : 0;
    pos.setXYZ(i, x * round, y * round, z * round + bulge);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tapered anatomical trouser/sleeve segment with organic muscular curve & subtle fabric creasing.
 */
function createOrganicLimbGeometry(
  rTop: number,
  rMid: number,
  rBottom: number,
  length: number,
  scaleZ = 1.04,
): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(rBottom, -length),
    new THREE.Vector2(rBottom * 1.04, -length * 0.8),
    new THREE.Vector2(rMid, -length * 0.45),
    new THREE.Vector2(rTop * 1.03, -length * 0.16),
    new THREE.Vector2(rTop, 0),
  ];
  const geo = new THREE.LatheGeometry(profile, 14);
  const pos = geo.attributes.position;
  if (!pos) {
    return geo;
  }
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i) * scaleZ;
    const angle = Math.atan2(z, x);
    const crease = Math.sin(angle * 4 + y * 22) * 0.0028;
    pos.setXYZ(i, x + Math.cos(angle) * crease, y, z + Math.sin(angle) * crease);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Curved ergonomic hardwood hickory axe handle + forged beveled steel felling axe head.
 */
function createAxeGeometries(): {
  readonly handleGeo: THREE.BufferGeometry;
  readonly headGeo: THREE.BufferGeometry;
} {
  // Subtle ergonomic S-curved hickory shaft
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.014, -0.22, 0),
    new THREE.Vector3(-0.006, 0.05, 0),
    new THREE.Vector3(-0.01, 0.38, 0),
    new THREE.Vector3(0.004, 0.72, 0),
  ]);
  const handleGeo = new THREE.TubeGeometry(curve, 16, 0.019, 10, false);

  // Beveled felling axe blade silhouette extruded cleanly along Z
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0.042, 0.042); // Blunt poll top
  bladeShape.lineTo(0.042, -0.042); // Blunt poll bottom
  bladeShape.lineTo(-0.032, -0.048); // Eye throat bottom
  bladeShape.quadraticCurveTo(-0.105, -0.068, -0.155, -0.088); // Lower blade beard
  bladeShape.quadraticCurveTo(-0.175, 0, -0.152, 0.078); // Curved cutting edge
  bladeShape.quadraticCurveTo(-0.095, 0.055, -0.032, 0.046); // Upper throat
  bladeShape.closePath();

  const headGeo = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.032,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 2,
  });
  headGeo.translate(0, 0.69, -0.016);
  headGeo.computeVertexNormals();

  return { handleGeo, headGeo };
}

function buildSurvivorRig(fabricOlive: PbrTextureSet): SurvivorRig {
  const root = new THREE.Group();

  // Photorealistic woven olive canvas field jacket material (fabric_olive.jpg + normalMap + roughnessMap!)
  const jacketMat = new THREE.MeshStandardMaterial({
    color: 0xd0d4c6,
    map: fabricOlive.map,
    normalMap: fabricOlive.normalMap,
    normalScale: new THREE.Vector2(1.05, 1.05),
    roughnessMap: fabricOlive.roughnessMap,
    roughness: 1.0,
    metalness: 0.02,
  });
  const jacketDarkMat = new THREE.MeshStandardMaterial({
    color: 0x848b78,
    map: fabricOlive.map,
    normalMap: fabricOlive.normalMap,
    normalScale: new THREE.Vector2(0.95, 0.95),
    roughnessMap: fabricOlive.roughnessMap,
    roughness: 1.0,
    metalness: 0.02,
  });
  const henleyMat = new THREE.MeshStandardMaterial({
    color: 0x262925,
    roughness: 0.94,
    metalness: 0.02,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: 0x7b7e72,
    map: fabricOlive.map,
    normalMap: fabricOlive.normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap: fabricOlive.roughnessMap,
    roughness: 1.0,
    metalness: 0.02,
  });
  const packMat = new THREE.MeshStandardMaterial({
    color: 0xbcb394,
    map: fabricOlive.map,
    normalMap: fabricOlive.normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    roughnessMap: fabricOlive.roughnessMap,
    roughness: 1.0,
    metalness: 0.03,
  });
  const leatherMat = new THREE.MeshStandardMaterial({
    color: 0x2d2016,
    roughness: 0.66,
    metalness: 0.09,
  });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0x9c7b3e,
    roughness: 0.36,
    metalness: 0.82,
  });
  const bootSoleMat = new THREE.MeshStandardMaterial({
    color: 0x171513,
    roughness: 0.94,
    metalness: 0.04,
  });
  const matRollMat = new THREE.MeshStandardMaterial({
    color: 0x454c4e,
    roughness: 0.84,
    metalness: 0.04,
  });
  const headSkinMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.74,
    metalness: 0.02,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xb78769,
    roughness: 0.76,
    metalness: 0.02,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.06,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x624024,
    roughness: 0.78,
    metalness: 0.05,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x3b4044,
    roughness: 0.38,
    metalness: 0.82,
  });
  const patchMat = new THREE.MeshStandardMaterial({
    color: 0x80613c,
    roughness: 0.88,
    metalness: 0.02,
  });

  const geometries: THREE.BufferGeometry[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };
  const makeMesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const standingHipY = HIP_LEG_OFFSET + BOOT_SOLE_HEIGHT + L_THIGH + L_SHIN;
  const hips = new THREE.Group();
  hips.position.set(0, standingHipY, 0);
  root.add(hips);

  // Contoured anatomical pelvis + leather utility belt + brass buckle
  const pelvis = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.175, 0.168, 0.19, 16)),
    pantsMat,
    0,
    0,
    0,
  );
  pelvis.scale.set(1.12, 1, 0.72);
  hips.add(pelvis);

  const belt = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.184, 0.184, 0.05, 16)),
    leatherMat,
    0,
    0.072,
    0,
  );
  belt.scale.set(1.12, 1, 0.74);
  hips.add(belt);
  hips.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.055, 0.058, 0.025)), brassMat, 0, 0.072, -0.142));

  // Anatomical sculpted torso & weathered olive field jacket
  const torso = new THREE.Group();
  torso.position.set(0, 0.085, 0);
  hips.add(torso);

  const chestUpper = new THREE.Group();
  torso.add(chestUpper);

  const torsoMesh = makeMesh(trackGeo(createAnatomicalTorsoGeometry()), jacketMat, 0, 0, 0);
  chestUpper.add(torsoMesh);

  // Shoulder yoke & turned-down field jacket collar with dark inner henley shirt
  const shoulderYoke = makeMesh(
    trackGeo(new THREE.CapsuleGeometry(0.095, 0.3, 8, 12)),
    jacketMat,
    0,
    0.475,
    0.005,
  );
  shoulderYoke.rotation.z = Math.PI * 0.5;
  shoulderYoke.scale.set(0.95, 1, 0.88);
  chestUpper.add(shoulderYoke);

  const collarOuter = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.098, 0.125, 0.09, 14)),
    jacketDarkMat,
    0,
    0.56,
    0.012,
  );
  collarOuter.scale.set(1.06, 1, 0.96);
  chestUpper.add(collarOuter);
  chestUpper.add(
    makeMesh(trackGeo(new THREE.CylinderGeometry(0.076, 0.085, 0.075, 12)), henleyMat, 0, 0.575, 0.002),
  );

  // Front jacket storm flap & dual bellows chest pockets
  chestUpper.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.052, 0.48, 0.02)), jacketDarkMat, 0, 0.25, -0.15));
  for (const px of [-0.1, 0.1]) {
    chestUpper.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.11, 0.12, 0.025)), jacketDarkMat, px, 0.34, -0.148));
    chestUpper.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.12, 0.13, 0.028)), jacketDarkMat, px * 1.12, 0.08, -0.145));
  }

  // Contoured padded backpack shoulder straps hugging deltoids + chest sternum strap
  for (const sx of [-0.148, 0.148]) {
    const strapTop = makeMesh(trackGeo(new THREE.CapsuleGeometry(0.026, 0.2, 6, 8)), leatherMat, sx, 0.45, 0.02);
    strapTop.rotation.x = 0.72;
    strapTop.scale.set(1.2, 1, 0.72);
    chestUpper.add(strapTop);

    const strapFront = makeMesh(trackGeo(new THREE.BoxGeometry(0.044, 0.34, 0.024)), leatherMat, sx, 0.28, -0.145);
    chestUpper.add(strapFront);
  }
  chestUpper.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.28, 0.026, 0.024)), leatherMat, 0, 0.34, -0.152));
  chestUpper.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.036, 0.032, 0.03)), brassMat, 0, 0.34, -0.156));

  // Detailed multi-compartment canvas survival rucksack (+Z is back of survivor)
  const backpack = new THREE.Group();
  backpack.position.set(0, 0.295, 0.215);
  chestUpper.add(backpack);

  backpack.add(makeMesh(trackGeo(createRoundedPackGeometry(0.34, 0.44, 0.18)), packMat, 0, 0, 0));
  const packLid = makeMesh(trackGeo(createRoundedPackGeometry(0.35, 0.13, 0.19)), packMat, 0, 0.185, 0.01);
  packLid.rotation.x = 0.12;
  backpack.add(packLid);

  // Gusseted rear & side utility pockets + leather cinch straps & brass buckles
  backpack.add(makeMesh(trackGeo(createRoundedPackGeometry(0.13, 0.16, 0.085)), packMat, -0.09, -0.095, 0.1));
  backpack.add(makeMesh(trackGeo(createRoundedPackGeometry(0.13, 0.16, 0.085)), packMat, 0.09, -0.095, 0.1));
  backpack.add(makeMesh(trackGeo(createRoundedPackGeometry(0.06, 0.19, 0.11)), packMat, 0.18, -0.04, 0.01));

  for (const sx of [-0.088, 0.088]) {
    backpack.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.026, 0.42, 0.024)), leatherMat, sx, 0.02, 0.096));
    backpack.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.034, 0.034, 0.03)), brassMat, sx, -0.03, 0.102));
  }

  // Rolled dark-charcoal sleeping bedroll strapped cleanly beneath pack
  const sleepingMat = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.068, 0.068, 0.43, 16)),
    matRollMat,
    0,
    -0.25,
    0.02,
  );
  sleepingMat.rotation.z = Math.PI * 0.5;
  backpack.add(sleepingMat);
  for (const sx of [-0.115, 0.115]) {
    const strap = makeMesh(
      trackGeo(new THREE.TorusGeometry(0.071, 0.011, 6, 16)),
      leatherMat,
      sx,
      -0.25,
      0.02,
    );
    strap.rotation.y = Math.PI * 0.5;
    backpack.add(strap);
  }

  // Detailed slung walnut-stock hunting rifle along left flank of pack
  const rifleGroup = new THREE.Group();
  rifleGroup.position.set(-0.22, 0.04, 0.015);
  rifleGroup.rotation.set(0.04, 0, 0.045);
  // Buttstock, grip & wooden forestock
  rifleGroup.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.042, 0.34, 0.082)), woodMat, 0, -0.3, 0.008));
  rifleGroup.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.038, 0.28, 0.056)), woodMat, 0, 0.01, 0));
  // Blued steel receiver, bolt & long barrel with front sight
  rifleGroup.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.04, 0.14, 0.052)), steelMat, 0, -0.05, -0.012));
  rifleGroup.add(makeMesh(trackGeo(new THREE.CylinderGeometry(0.013, 0.017, 0.62, 10)), steelMat, 0, 0.32, -0.012));
  rifleGroup.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.008, 0.028, 0.022)), steelMat, 0, 0.61, -0.024));
  backpack.add(rifleGroup);

  // Anatomical sculpted head, folded fleece neck gaiter, ears, tousled nape hair & ribbed watch cap
  const head = new THREE.Group();
  head.position.set(0, 0.585, -0.004);
  chestUpper.add(head);

  const neck = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.056, 0.072, 0.125, 14)),
    skinMat,
    0,
    0.045,
    0.005,
  );
  head.add(neck);

  // Folded dark charcoal fleece neck gaiter bridging the field-jacket collar & lower jaw
  const neckGaiter = makeMesh(
    trackGeo(new THREE.CylinderGeometry(0.073, 0.088, 0.082, 16)),
    henleyMat,
    0,
    0.032,
    0.004,
  );
  neckGaiter.scale.set(1.04, 1, 0.98);
  head.add(neckGaiter);

  const sculptedHead = makeMesh(trackGeo(createSculptedHeadGeometry()), headSkinMat, 0, 0.185, -0.008);
  head.add(sculptedHead);

  // Subtle sculpted ears on left & right of skull
  const earGeo = trackGeo(new THREE.SphereGeometry(0.026, 8, 8));
  for (const side of [-1, 1]) {
    const ear = makeMesh(earGeo, skinMat, side * 0.095, 0.175, 0.004);
    ear.scale.set(0.42, 1.15, 0.72);
    ear.rotation.y = side * 0.22;
    head.add(ear);
  }

  // Multi-layered tousled dark-brown hair peeking cleanly below the beanie cuff at temples & nape
  const hairShell = makeMesh(trackGeo(createSculptedHairGeometry()), hairMat, 0, 0.19, -0.004);
  head.add(hairShell);

  // Weathered ribbed charcoal-olive survival watch cap / beanie seated snugly over the crown
  const beanie = makeMesh(trackGeo(createKnitBeanieGeometry()), jacketDarkMat, 0, 0.205, 0.004);
  beanie.rotation.x = -0.14;
  head.add(beanie);

  // Anatomical sculpted arms & hands (palm + curled fingers + thumb)
  const createArm = (
    side: -1 | 1,
  ): { shoulder: THREE.Group; forearm: THREE.Group; handPivot: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.268, 0.478, 0);
    chestUpper.add(shoulder);

    // Rounded deltoid cap
    const deltoid = makeMesh(trackGeo(new THREE.SphereGeometry(0.068, 12, 10)), jacketMat, 0, -0.012, 0);
    deltoid.scale.set(0.96, 1.08, 0.94);
    shoulder.add(deltoid);

    // Tapered sculpted bicep/tricep field-jacket sleeve
    shoulder.add(
      makeMesh(trackGeo(createOrganicLimbGeometry(0.064, 0.058, 0.05, 0.275)), jacketMat, 0, 0, 0),
    );

    if (side === 1) {
      shoulder.add(
        makeMesh(trackGeo(new THREE.BoxGeometry(0.014, 0.07, 0.058)), patchMat, 0.06, -0.09, 0),
      );
    }

    const forearm = new THREE.Group();
    forearm.position.set(0, -0.272, 0);
    shoulder.add(forearm);

    // Sculpted elbow fold & tapered forearm sleeve + buttoned wrist cuff
    forearm.add(makeMesh(trackGeo(new THREE.SphereGeometry(0.05, 10, 8)), jacketDarkMat, 0, 0, 0));
    forearm.add(
      makeMesh(trackGeo(createOrganicLimbGeometry(0.052, 0.047, 0.04, 0.245)), jacketMat, 0, 0, 0),
    );
    forearm.add(
      makeMesh(trackGeo(new THREE.CylinderGeometry(0.044, 0.042, 0.042, 12)), jacketDarkMat, 0, -0.238, 0),
    );

    const handPivot = new THREE.Group();
    handPivot.position.set(0, -0.265, 0);
    forearm.add(handPivot);

    // Sculpted anatomical hand: palm, curled finger grip & opposing thumb
    const palm = makeMesh(trackGeo(new THREE.BoxGeometry(0.042, 0.072, 0.066)), skinMat, 0, -0.032, -0.004);
    handPivot.add(palm);

    const fingers = makeMesh(
      trackGeo(new THREE.CapsuleGeometry(0.022, 0.034, 6, 8)),
      skinMat,
      -side * 0.014,
      -0.064,
      -0.012,
    );
    fingers.rotation.x = Math.PI * 0.5;
    handPivot.add(fingers);

    const thumb = makeMesh(
      trackGeo(new THREE.CapsuleGeometry(0.013, 0.032, 4, 6)),
      skinMat,
      -side * 0.024,
      -0.032,
      -0.032,
    );
    thumb.rotation.set(0.45, 0, side * 0.55);
    handPivot.add(thumb);

    return { shoulder, forearm, handPivot };
  };

  const leftArmRig = createArm(-1);
  const rightArmRig = createArm(1);

  // Iconic curved hardwood felling axe gripped cleanly in right hand
  // Use 'XZY' Euler order so R_y rolls the blade around the shaft first, then R_z cants outward, then R_x pitches back
  const axePivot = new THREE.Group();
  axePivot.rotation.order = 'XZY';
  axePivot.position.set(-0.012, -0.045, -0.008);
  rightArmRig.handPivot.add(axePivot);

  const axeGeos = createAxeGeometries();
  axePivot.add(makeMesh(trackGeo(axeGeos.handleGeo), woodMat, 0, 0, 0));
  axePivot.add(makeMesh(trackGeo(axeGeos.headGeo), steelMat, 0, 0, 0));

  // Anatomical tapered cargo legs + strapped holster + multi-part laced hiking boots
  const createLeg = (
    side: -1 | 1,
  ): { hip: THREE.Group; calf: THREE.Group; boot: THREE.Group } => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.108, -HIP_LEG_OFFSET, 0);
    hips.add(hip);

    // Sculpted thigh cargo pants
    hip.add(
      makeMesh(trackGeo(createOrganicLimbGeometry(0.094, 0.084, 0.07, L_THIGH, 1.08)), pantsMat, 0, 0, 0),
    );

    if (side === 1) {
      // Strapped leather drop-leg tactical holster on right thigh
      hip.add(makeMesh(trackGeo(createRoundedPackGeometry(0.06, 0.175, 0.115)), leatherMat, 0.084, -0.155, 0.008));
      const legStrap = makeMesh(trackGeo(new THREE.TorusGeometry(0.085, 0.011, 6, 16)), leatherMat, 0, -0.155, 0);
      legStrap.rotation.x = Math.PI * 0.5;
      hip.add(legStrap);
    } else {
      hip.add(makeMesh(trackGeo(createRoundedPackGeometry(0.038, 0.145, 0.112)), jacketDarkMat, -0.078, -0.18, 0));
    }

    const calf = new THREE.Group();
    calf.position.set(0, -L_THIGH, 0);
    hip.add(calf);

    // Sculpted knee crease + tapered muscular calf trousers + cuffed ankle above boot
    const kneeCap = makeMesh(trackGeo(new THREE.SphereGeometry(0.07, 12, 10)), jacketDarkMat, 0, -0.012, -0.01);
    kneeCap.scale.set(0.95, 1.05, 1.0);
    calf.add(kneeCap);

    calf.add(
      makeMesh(trackGeo(createOrganicLimbGeometry(0.072, 0.068, 0.056, L_SHIN * 0.82, 1.06)), pantsMat, 0, 0, 0),
    );
    // Leather boot ankle shaft & padded collar
    calf.add(
      makeMesh(trackGeo(new THREE.CylinderGeometry(0.062, 0.064, L_SHIN * 0.28, 12)), leatherMat, 0, -L_SHIN * 0.86, 0),
    );

    const boot = new THREE.Group();
    boot.position.set(0, -L_SHIN, 0);
    calf.add(boot);

    // Multi-part sculpted leather hiking boot: vamp, rounded toe box, heel counter, lace ridge & lugged outsole
    boot.add(makeMesh(trackGeo(createRoundedPackGeometry(0.114, 0.058, 0.215)), leatherMat, 0, -0.03, -0.04));

    const toeCap = makeMesh(trackGeo(new THREE.SphereGeometry(0.056, 12, 10)), leatherMat, 0, -0.038, -0.138);
    toeCap.scale.set(1.0, 0.66, 1.15);
    boot.add(toeCap);

    // Subtle crisscross leather lacing vamp ridge
    boot.add(makeMesh(trackGeo(new THREE.BoxGeometry(0.044, 0.038, 0.09)), bootSoleMat, 0, -0.008, -0.07));

    // Thick treaded rubber sole touching exactly -BOOT_SOLE_HEIGHT
    boot.add(
      makeMesh(
        trackGeo(new THREE.BoxGeometry(0.122, 0.03, 0.265)),
        bootSoleMat,
        0,
        -BOOT_SOLE_HEIGHT + 0.015,
        -0.052,
      ),
    );

    return { hip, calf, boot };
  };

  const leftLegRig = createLeg(-1);
  const rightLegRig = createLeg(1);

  return {
    root,
    hips,
    torso,
    chestUpper,
    head,
    leftArm: leftArmRig.shoulder,
    leftForearm: leftArmRig.forearm,
    rightArm: rightArmRig.shoulder,
    rightForearm: rightArmRig.forearm,
    axePivot,
    leftLeg: leftLegRig.hip,
    leftCalf: leftLegRig.calf,
    leftBoot: leftLegRig.boot,
    rightLeg: rightLegRig.hip,
    rightCalf: rightLegRig.calf,
    rightBoot: rightLegRig.boot,
    dispose(): void {
      for (const g of geometries) {
        g.dispose();
      }
      jacketMat.dispose();
      jacketDarkMat.dispose();
      henleyMat.dispose();
      pantsMat.dispose();
      packMat.dispose();
      leatherMat.dispose();
      brassMat.dispose();
      bootSoleMat.dispose();
      matRollMat.dispose();
      headSkinMat.dispose();
      skinMat.dispose();
      hairMat.dispose();
      woodMat.dispose();
      steelMat.dispose();
      patchMat.dispose();
    },
  };
}

function lerpAngle(current: number, target: number, alpha: number): number {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return current + diff * alpha;
}

function angleDelta(from: number, to: number): number {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return diff;
}

function createLensGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size * 0.5;
    const grad = ctx.createRadialGradient(cx, cx, 1, cx, cx, cx);
    grad.addColorStop(0, 'rgba(255, 248, 224, 0.95)');
    grad.addColorStop(0.32, 'rgba(255, 228, 168, 0.45)');
    grad.addColorStop(1, 'rgba(255, 210, 128, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface ChestFlashlightProp {
  readonly group: THREE.Group;
  readonly lensAnchor: THREE.Object3D;
  setActive(active: boolean): void;
  dispose(): void;
}

/**
 * Compact angled-head tactical military flashlight clipped to the survivor's right chest strap.
 * Local axes match upright actor convention (+X right, +Y up, -Z forward lens).
 */
function createChestFlashlightProp(): ChestFlashlightProp {
  const group = new THREE.Group();
  group.name = 'ChestTacticalFlashlight';

  const geometries: THREE.BufferGeometry[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x222628,
    roughness: 0.48,
    metalness: 0.72,
  });
  const clipMat = new THREE.MeshStandardMaterial({
    color: 0x16191a,
    roughness: 0.62,
    metalness: 0.58,
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x262e32,
    emissive: new THREE.Color('#ffebc0'),
    emissiveIntensity: 0,
    roughness: 0.14,
    metalness: 0.22,
  });

  // Vertical anodized barrel
  const barrel = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.021, 0.021, 0.125, 10)), bodyMat);
  barrel.castShadow = true;
  group.add(barrel);

  // Knurled tail cap
  const tailCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.023, 0.022, 0.018, 10)), clipMat);
  tailCap.position.set(0, -0.068, 0);
  group.add(tailCap);

  // Rear strap clip bracket hugging the chest harness
  const strapClip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.016, 0.088, 0.022)), clipMat);
  strapClip.position.set(0, -0.004, 0.022);
  group.add(strapClip);

  // Right-angle tactical head bezel pointing straight forward (-Z)
  const bezelGeo = trackGeo(new THREE.CylinderGeometry(0.025, 0.022, 0.036, 12));
  bezelGeo.rotateX(-Math.PI * 0.5);
  const bezel = new THREE.Mesh(bezelGeo, bodyMat);
  bezel.position.set(0, 0.044, -0.026);
  bezel.castShadow = true;
  group.add(bezel);

  // Front LED emitter lens facing -Z
  const lensGeo = trackGeo(new THREE.CircleGeometry(0.02, 12));
  lensGeo.rotateY(Math.PI);
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(0, 0.044, -0.045);
  group.add(lens);

  // Soft additive bezel bloom halo visible when switched ON
  const glowTex = createLensGlowTexture();
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.position.set(0, 0.044, -0.056);
  glowSprite.scale.set(0.15, 0.15, 1);
  glowSprite.visible = false;
  glowSprite.userData['excludeFromGtao'] = true;
  group.add(glowSprite);

  const lensAnchor = new THREE.Object3D();
  lensAnchor.position.set(0, 0.044, -0.068);
  group.add(lensAnchor);

  return {
    group,
    lensAnchor,
    setActive(active: boolean): void {
      lensMat.emissiveIntensity = active ? 3.2 : 0;
      glowSprite.visible = active;
    },
    dispose(): void {
      group.removeFromParent();
      for (let i = 0; i < geometries.length; i += 1) {
        geometries[i]?.dispose();
      }
      bodyMat.dispose();
      clipMat.dispose();
      lensMat.dispose();
      glowMat.dispose();
      glowTex.dispose();
    },
  };
}

export function createPlayerController(options: PlayerControllerOptions): PlayerController {
  const {
    camera,
    scene,
    canvas,
    obstacles,
    isInsidePuddle,
    canSprint,
    canJump,
    canAttack,
    canThrowBottle,
    onFootstep,
    onJump,
    onLand,
    onAttackStart,
    onAttack,
    onAttackHitWindow,
    onInteract,
    onThrowBottle,
    onThrowEmpty,
    onThrowRelease,
    onQuickUse,
    onToggleFlashlight,
    onAdvanceTime,
    onToggleStorm,
    onBuildCampfire,
    onBuildShelter,
    onStanceChange,
    onPointerLockChange,
  } = options;

  const atlas = getWorldTextureAtlas();
  const rig = buildSurvivorRig(atlas.fabricOlive);
  const root = rig.root;
  const startY = getTerrainHeight(SPAWN_POINT.x, SPAWN_POINT.z);
  const position = new THREE.Vector3(SPAWN_POINT.x, startY, SPAWN_POINT.z);
  root.position.copy(position);
  scene.add(root);

  const chestFlashlight = createChestFlashlightProp();
  chestFlashlight.group.position.set(0.142, 0.34, -0.175);
  rig.chestUpper.add(chestFlashlight.group);

  let disposed = false;
  let proceduralRigDisposed = false;
  let glbState: GlbSurvivorState | null = null;
  let flashlightActive = false;

  // Opening over-the-shoulder overlook framing matching concept.jpg
  let cameraYaw = -0.035;
  let cameraPitch = -0.045;
  let characterYaw = -0.06;

  let inputEnabled = false;
  let pointerLocked = false;
  let crouchToggled = false;
  let crouchBlend = 0;
  let sprintCameraBlend = 0;
  let axeShoulderBlend = 1;
  let stridePhase = 0;
  let prevStrideSign = 0;
  let currentSpeed = 0;
  let smoothedActualSpeed = 0;
  let currentStance: PlayerStance = 'standing';
  let lastSprinting = false;
  let lastCrouching = false;
  let hitShake = 0;
  let hitShakePhase = 0;

  // MoCap speed-matched locomotion, jump physics & melee attack timers (zero per-frame allocations)
  const PLAYER_RADIUS = 0.44;
  const SLOW_WALK_SPEED = 1.72;
  const WALK_SPEED = 3.45;
  const SPRINT_SPEED = 5.8;
  const CROUCH_SPEED = 1.82;
  const ACCEL_RATE = 13;
  const DECEL_RATE = 11;
  const JUMP_VELOCITY = 4.1;
  const GRAVITY = 17.8;
  const JUMP_START_TIME_SCALE = 1.55;
  const JUMP_LAND_TIME_SCALE = 1.65;
  const ATTACK_RIGHT_TIME_SCALE = 1.35;
  const ATTACK_LEFT_TIME_SCALE = 1.24;
  const ATTACK_DURATION = 0.74;
  const ATTACK_COOLDOWN = 0.76;
  const ATTACK_WHOOSH_TIME = 0.19;
  const THROW_TIME_SCALE = 1.42;
  const THROW_DURATION = 0.68;
  const THROW_COOLDOWN = 0.72;
  const THROW_RELEASE_TIME = 0.34;

  let groundedY = startY;
  let smoothedCamY = startY;
  let airHeight = 0;
  let airElapsed = 0;
  let verticalVelocity = 0;
  let isAirborne = false;
  let jumpLandTimer = 0;
  let airVelX = 0;
  let airVelZ = 0;
  let lastMoveDirX = 0;
  let lastMoveDirZ = -1;
  let bankAngle = 0;

  let attackTimer = 0;
  let attackCooldown = 0;
  let attackElapsed = 0;
  let attackWhooshPending = false;
  let attackCameraImpulse = 0;
  let nextPunchLeft = false;
  let activeAttackIsLeft = false;

  let throwTimer = 0;
  let throwCooldown = 0;
  let throwElapsed = 0;
  let throwReleasePending = false;

  void loadOptionalGlbAsset('survivor').then((loaded) => {
    if (!loaded) {
      return;
    }
    if (disposed) {
      disposeObject3DTree(loaded.scene);
      return;
    }

    const wrapper = new THREE.Group();
    // Convert glTF +Z forward into controller -Z forward so survivor faces straight down Highway 9
    wrapper.rotation.y = Math.PI;
    wrapper.add(loaded.scene);

    const mixer = new THREE.AnimationMixer(loaded.scene);
    const clips = loaded.animations;
    const usedClips = new Set<THREE.AnimationClip>();

    // Match compound & directional names cleanly so standing clips never alias variants
    const crouchIdleClip = findUniqueClip(clips, 'crouch_idle', usedClips, true);
    const crouchWalkClip = findUniqueClip(clips, 'crouch_walk', usedClips, true);
    let idleClip = findUniqueClip(clips, 'idle', usedClips, true, ['crouch']);
    const walkClip = findUniqueClip(clips, 'walk', usedClips, true, ['crouch', 'back', 'strafe']);
    const jogClip = findUniqueClip(clips, 'jog', usedClips, true, ['crouch', 'back', 'strafe']);
    const runClip = findUniqueClip(clips, 'run', usedClips, true, ['crouch', 'back', 'strafe']);
    const jumpStartClip = findUniqueClip(clips, 'jump_start', usedClips, true);
    const jumpAirClip = findUniqueClip(clips, 'jump_air', usedClips, true);
    const jumpLandClip = findUniqueClip(clips, 'jump_land', usedClips, true);
    const legacyJumpClip = !jumpStartClip ? findUniqueClip(clips, 'jump', usedClips, true) : null;
    const attackLeftClip = findUniqueClip(clips, 'attack_left', usedClips, true);
    const attackRightClip = findUniqueClip(clips, 'attack', usedClips, true, ['left']);
    const throwClip = findUniqueClip(clips, 'throw', usedClips, true);
    if (!idleClip) {
      const firstUnused = clips.find((c) => !usedClips.has(c)) ?? null;
      if (firstUnused) {
        usedClips.add(firstUnused);
        idleClip = firstUnused;
      }
    }

    const setupLoopAction = (
      clip: THREE.AnimationClip | null,
      initialWeight: number,
    ): THREE.AnimationAction | null => {
      if (!clip) {
        return null;
      }
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(initialWeight);
      action.play();
      return action;
    };

    const setupOneShotAction = (clip: THREE.AnimationClip | null): THREE.AnimationAction | null => {
      if (!clip) {
        return null;
      }
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0);
      return action;
    };

    const idleAction = setupLoopAction(idleClip, 1);
    const walkAction = setupLoopAction(walkClip, 0);
    const jogAction = setupLoopAction(jogClip, 0);
    const runAction = setupLoopAction(runClip, 0);
    const crouchIdleAction = setupLoopAction(crouchIdleClip, 0);
    const crouchWalkAction = setupLoopAction(crouchWalkClip, 0);
    // Load-time lower-body locomotion & upper-body combat/throw twin clips for zero foot-sliding
    const idleLowerAction = setupLoopAction(filterClipByBodyRegion(idleClip, 'lower', true), 0);
    const walkLowerAction = setupLoopAction(filterClipByBodyRegion(walkClip, 'lower', true), 0);
    const jogLowerAction = setupLoopAction(filterClipByBodyRegion(jogClip, 'lower', true), 0);
    const runLowerAction = setupLoopAction(filterClipByBodyRegion(runClip, 'lower', true), 0);
    const crouchIdleLowerAction = setupLoopAction(
      filterClipByBodyRegion(crouchIdleClip, 'lower', true),
      0,
    );
    const crouchWalkLowerAction = setupLoopAction(
      filterClipByBodyRegion(crouchWalkClip, 'lower', true),
      0,
    );
    const jumpStartAction = setupOneShotAction(jumpStartClip ?? legacyJumpClip);
    const jumpAirAction = setupLoopAction(jumpAirClip, 0);
    const jumpLandAction = setupOneShotAction(jumpLandClip);
    const attackRightAction = setupOneShotAction(attackRightClip);
    const attackRightUpperAction = setupOneShotAction(
      filterClipByBodyRegion(attackRightClip, 'upper', false),
    );
    const attackLeftAction = setupOneShotAction(attackLeftClip);
    const attackLeftUpperAction = setupOneShotAction(
      filterClipByBodyRegion(attackLeftClip, 'upper', false),
    );
    const throwAction = setupOneShotAction(throwClip);
    const throwUpperAction = setupOneShotAction(filterClipByBodyRegion(throwClip, 'upper', false));

    mixer.update(0);
    wrapper.updateMatrixWorld(true);

    // Verify ground contact on frame 0 of Idle so boots sit flush at y = 0
    const bounds = new THREE.Box3().setFromObject(wrapper);
    if (Number.isFinite(bounds.min.y) && Math.abs(bounds.min.y) > 0.004) {
      wrapper.position.y = -bounds.min.y;
    }
    wrapper.updateMatrixWorld(true);

    // Detach visible chest flashlight cleanly before clearing procedural rig, then mount onto spine_03
    chestFlashlight.group.removeFromParent();
    const chestBone =
      loaded.scene.getObjectByName('spine_03') ??
      loaded.scene.getObjectByName('chest') ??
      loaded.scene.getObjectByName('spine_02');
    if (chestBone) {
      const boneWorldQuat = new THREE.Quaternion();
      const boneWorldScale = new THREE.Vector3(1, 1, 1);
      chestBone.getWorldQuaternion(boneWorldQuat);
      chestBone.getWorldScale(boneWorldScale);
      const localStrapPos = chestBone.worldToLocal(new THREE.Vector3(0.11, 1.36, -0.245));
      chestFlashlight.group.position.copy(localStrapPos);
      chestFlashlight.group.quaternion.copy(boneWorldQuat).invert();
      const invScale =
        Number.isFinite(boneWorldScale.x) && boneWorldScale.x > 1e-4 ? 1 / boneWorldScale.x : 1;
      chestFlashlight.group.scale.setScalar(invScale);
      chestBone.add(chestFlashlight.group);
    } else {
      chestFlashlight.group.position.set(0.11, 1.36, -0.245);
      chestFlashlight.group.rotation.set(0, 0, 0);
      chestFlashlight.group.scale.setScalar(1);
    }

    // Resume any in-flight airborne, landing, throw, or melee action seamlessly if GLB loads mid-action
    if (isAirborne && jumpStartAction) {
      jumpStartAction.reset();
      jumpStartAction.setLoop(THREE.LoopOnce, 1);
      jumpStartAction.clampWhenFinished = true;
      jumpStartAction.timeScale = JUMP_START_TIME_SCALE;
      jumpStartAction.time = Math.min(
        airElapsed * JUMP_START_TIME_SCALE,
        jumpStartAction.getClip().duration,
      );
      jumpStartAction.play();
    } else if (jumpLandTimer > 0 && jumpLandAction) {
      jumpLandAction.reset();
      jumpLandAction.setLoop(THREE.LoopOnce, 1);
      jumpLandAction.clampWhenFinished = true;
      jumpLandAction.timeScale = JUMP_LAND_TIME_SCALE;
      jumpLandAction.play();
    } else if (throwTimer > 0 && throwAction) {
      const throwTime = Math.min(throwElapsed * THROW_TIME_SCALE, throwAction.getClip().duration);
      throwAction.reset();
      throwAction.setLoop(THREE.LoopOnce, 1);
      throwAction.clampWhenFinished = true;
      throwAction.timeScale = THROW_TIME_SCALE;
      throwAction.time = throwTime;
      throwAction.play();
      if (throwUpperAction) {
        throwUpperAction.reset();
        throwUpperAction.setLoop(THREE.LoopOnce, 1);
        throwUpperAction.clampWhenFinished = true;
        throwUpperAction.timeScale = THROW_TIME_SCALE;
        throwUpperAction.time = Math.min(throwTime, throwUpperAction.getClip().duration);
        throwUpperAction.play();
      }
    } else if (attackTimer > 0) {
      const useLeft = activeAttackIsLeft && attackLeftAction !== null;
      const activeAction = useLeft ? attackLeftAction : attackRightAction;
      const activeUpperAction = useLeft ? attackLeftUpperAction : attackRightUpperAction;
      if (activeAction) {
        const scale = useLeft ? ATTACK_LEFT_TIME_SCALE : ATTACK_RIGHT_TIME_SCALE;
        const atkTime = Math.min(attackElapsed * scale, activeAction.getClip().duration);
        activeAction.reset();
        activeAction.setLoop(THREE.LoopOnce, 1);
        activeAction.clampWhenFinished = true;
        activeAction.timeScale = scale;
        activeAction.time = atkTime;
        activeAction.play();
        if (activeUpperAction) {
          activeUpperAction.reset();
          activeUpperAction.setLoop(THREE.LoopOnce, 1);
          activeUpperAction.clampWhenFinished = true;
          activeUpperAction.timeScale = scale;
          activeUpperAction.time = Math.min(atkTime, activeUpperAction.getClip().duration);
          activeUpperAction.play();
        }
      }
    }

    if (!proceduralRigDisposed) {
      root.clear();
      rig.dispose();
      proceduralRigDisposed = true;
    }
    root.add(wrapper);
    if (!chestFlashlight.group.parent) {
      root.add(chestFlashlight.group);
    }
    glbState = {
      wrapper,
      scene: loaded.scene,
      mixer,
      idleAction,
      walkAction,
      jogAction,
      runAction,
      crouchIdleAction,
      crouchWalkAction,
      idleLowerAction,
      walkLowerAction,
      jogLowerAction,
      runLowerAction,
      crouchIdleLowerAction,
      crouchWalkLowerAction,
      jumpStartAction,
      jumpAirAction,
      jumpLandAction,
      attackRightAction,
      attackRightUpperAction,
      attackLeftAction,
      attackLeftUpperAction,
      throwAction,
      throwUpperAction,
      wIdle: 1,
      wWalk: 0,
      wJog: 0,
      wRun: 0,
      wCrouchIdle: 0,
      wCrouchWalk: 0,
      wJumpStart: 0,
      wJumpAir: 0,
      wJumpLand: 0,
      wAttackRight: 0,
      wAttackLeft: 0,
      wThrow: 0,
    };
  });

  const keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    walkSlow: false,
    crouchHold: false,
  };

  // Pre-allocated scratch structures (ZERO per-frame math allocations!)
  const scratchPos2D: Vec2Like = { x: position.x, z: position.z };
  const scratchCamProbe2D: Vec2Like = { x: 0, z: 0 };
  const scratchCamTarget = new THREE.Vector3();
  const scratchCamDesired = new THREE.Vector3();
  const scratchCamCurrent = new THREE.Vector3();
  const scratchLookAt = new THREE.Vector3();
  const scratchRight = new THREE.Vector3();
  const scratchBack = new THREE.Vector3();

  const initCameraTransform = (): void => {
    const cosY = Math.cos(cameraYaw);
    const sinY = Math.sin(cameraYaw);
    const cosP = Math.cos(cameraPitch);
    const sinP = Math.sin(cameraPitch);

    scratchRight.set(cosY, 0, -sinY);
    scratchBack.set(sinY * cosP, -sinP, cosY * cosP);

    const shoulderOffset = 0.68;
    const pivotHeight = 1.58;
    const camDistance = 3.15;

    scratchCamTarget.set(
      position.x + scratchRight.x * shoulderOffset,
      position.y + pivotHeight,
      position.z + scratchRight.z * shoulderOffset,
    );
    scratchCamCurrent.set(
      scratchCamTarget.x + scratchBack.x * camDistance,
      scratchCamTarget.y + scratchBack.y * camDistance,
      scratchCamTarget.z + scratchBack.z * camDistance,
    );
    scratchLookAt.set(
      scratchCamTarget.x - scratchBack.x * 18,
      scratchCamTarget.y - scratchBack.y * 18 - 0.52,
      scratchCamTarget.z - scratchBack.z * 18,
    );
    camera.position.copy(scratchCamCurrent);
    camera.lookAt(scratchLookAt);
  };
  initCameraTransform();

  const triggerJump = (): void => {
    if (!inputEnabled || isAirborne || (canJump && !canJump())) {
      return;
    }
    // Jumping cleanly exits crouch and interrupts any swing or bottle windup (bottle not consumed yet)
    crouchToggled = false;
    attackTimer = 0;
    attackWhooshPending = false;
    throwTimer = 0;
    throwReleasePending = false;

    // Reconcile elevation against terrain before launching so fast uphill sprints never start underground
    const launchGroundY = getTerrainHeight(position.x, position.z);
    if (position.y < launchGroundY) {
      position.y = launchGroundY;
      groundedY = launchGroundY;
    }

    isAirborne = true;
    verticalVelocity = JUMP_VELOCITY;
    airHeight = 0;
    airElapsed = 0;
    jumpLandTimer = 0;

    if (glbState) {
      glbState.wJumpLand = 0;
      glbState.wAttackRight = 0;
      glbState.wAttackLeft = 0;
      glbState.wThrow = 0;
      if (glbState.jumpLandAction) {
        glbState.jumpLandAction.stop();
        glbState.jumpLandAction.setEffectiveWeight(0);
      }
      if (glbState.attackRightAction) {
        glbState.attackRightAction.stop();
        glbState.attackRightAction.setEffectiveWeight(0);
      }
      if (glbState.attackRightUpperAction) {
        glbState.attackRightUpperAction.stop();
        glbState.attackRightUpperAction.setEffectiveWeight(0);
      }
      if (glbState.attackLeftAction) {
        glbState.attackLeftAction.stop();
        glbState.attackLeftAction.setEffectiveWeight(0);
      }
      if (glbState.attackLeftUpperAction) {
        glbState.attackLeftUpperAction.stop();
        glbState.attackLeftUpperAction.setEffectiveWeight(0);
      }
      if (glbState.throwAction) {
        glbState.throwAction.stop();
        glbState.throwAction.setEffectiveWeight(0);
      }
      if (glbState.throwUpperAction) {
        glbState.throwUpperAction.stop();
        glbState.throwUpperAction.setEffectiveWeight(0);
      }
      if (glbState.jumpStartAction) {
        glbState.jumpStartAction.reset();
        glbState.jumpStartAction.setLoop(THREE.LoopOnce, 1);
        glbState.jumpStartAction.clampWhenFinished = true;
        glbState.jumpStartAction.enabled = true;
        glbState.jumpStartAction.timeScale = JUMP_START_TIME_SCALE;
        glbState.jumpStartAction.play();
      }
    }
    if (onJump) {
      onJump();
    }
  };

  const triggerAttack = (): void => {
    if (
      !inputEnabled ||
      isAirborne ||
      attackCooldown > 0 ||
      throwTimer > 0 ||
      (canAttack && !canAttack())
    ) {
      return;
    }
    activeAttackIsLeft = nextPunchLeft;
    nextPunchLeft = !nextPunchLeft;

    attackTimer = ATTACK_DURATION;
    attackCooldown = ATTACK_COOLDOWN;
    attackElapsed = 0;
    attackWhooshPending = true;
    if (onAttackStart) {
      onAttackStart();
    }

    if (glbState) {
      const useLeft = activeAttackIsLeft && glbState.attackLeftAction !== null;
      const activeAction = useLeft ? glbState.attackLeftAction : glbState.attackRightAction;
      const activeUpperAction = useLeft
        ? glbState.attackLeftUpperAction
        : glbState.attackRightUpperAction;
      const otherAction = useLeft ? glbState.attackRightAction : glbState.attackLeftAction;
      const otherUpperAction = useLeft
        ? glbState.attackRightUpperAction
        : glbState.attackLeftUpperAction;
      if (otherAction) {
        otherAction.stop();
        otherAction.setEffectiveWeight(0);
      }
      if (otherUpperAction) {
        otherUpperAction.stop();
        otherUpperAction.setEffectiveWeight(0);
      }
      if (useLeft) {
        glbState.wAttackRight = 0;
      } else {
        glbState.wAttackLeft = 0;
      }
      const scale = useLeft ? ATTACK_LEFT_TIME_SCALE : ATTACK_RIGHT_TIME_SCALE;
      if (activeAction) {
        activeAction.reset();
        activeAction.setLoop(THREE.LoopOnce, 1);
        activeAction.clampWhenFinished = true;
        activeAction.enabled = true;
        activeAction.timeScale = scale;
        activeAction.play();
      }
      if (activeUpperAction) {
        activeUpperAction.reset();
        activeUpperAction.setLoop(THREE.LoopOnce, 1);
        activeUpperAction.clampWhenFinished = true;
        activeUpperAction.enabled = true;
        activeUpperAction.timeScale = scale;
        activeUpperAction.play();
      }
    }
  };

  const triggerThrow = (): void => {
    if (!inputEnabled || isAirborne || throwTimer > 0 || throwCooldown > 0 || attackTimer > 0) {
      return;
    }
    if (canThrowBottle && !canThrowBottle()) {
      if (onThrowEmpty) {
        onThrowEmpty();
      }
      return;
    }

    throwTimer = THROW_DURATION;
    throwCooldown = THROW_COOLDOWN;
    throwElapsed = 0;
    throwReleasePending = true;

    if (glbState?.throwAction) {
      glbState.throwAction.reset();
      glbState.throwAction.setLoop(THREE.LoopOnce, 1);
      glbState.throwAction.clampWhenFinished = true;
      glbState.throwAction.enabled = true;
      glbState.throwAction.timeScale = THROW_TIME_SCALE;
      glbState.throwAction.play();
      if (glbState.throwUpperAction) {
        glbState.throwUpperAction.reset();
        glbState.throwUpperAction.setLoop(THREE.LoopOnce, 1);
        glbState.throwUpperAction.clampWhenFinished = true;
        glbState.throwUpperAction.enabled = true;
        glbState.throwUpperAction.timeScale = THROW_TIME_SCALE;
        glbState.throwUpperAction.play();
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!inputEnabled) {
      return;
    }
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        if (event.code === 'ArrowUp') event.preventDefault();
        keys.forward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        if (event.code === 'ArrowDown') event.preventDefault();
        keys.backward = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        if (event.code === 'ArrowLeft') event.preventDefault();
        keys.left = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        if (event.code === 'ArrowRight') event.preventDefault();
        keys.right = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        keys.sprint = true;
        break;
      case 'AltLeft':
      case 'AltRight':
        event.preventDefault();
        keys.walkSlow = true;
        break;
      case 'ControlLeft':
      case 'ControlRight':
        keys.crouchHold = true;
        break;
      case 'KeyC':
        if (!event.repeat && !isAirborne) {
          crouchToggled = !crouchToggled;
        }
        break;
      case 'Space':
        event.preventDefault();
        if (!event.repeat) {
          triggerJump();
        }
        break;
      case 'KeyF':
        event.preventDefault();
        if (!event.repeat) {
          triggerAttack();
        }
        break;
      case 'KeyE':
        if (!event.repeat && onInteract) {
          onInteract();
        }
        break;
      case 'KeyG':
        if (!event.repeat) {
          triggerThrow();
        }
        break;
      case 'Digit1':
        if (!event.repeat && onQuickUse) {
          onQuickUse(1);
        }
        break;
      case 'Digit2':
        if (!event.repeat && onQuickUse) {
          onQuickUse(2);
        }
        break;
      case 'Digit3':
        if (!event.repeat && onQuickUse) {
          onQuickUse(3);
        }
        break;
      case 'KeyL':
        if (!event.repeat && onToggleFlashlight) {
          onToggleFlashlight();
        }
        break;
      case 'KeyT':
        if (!event.repeat && onAdvanceTime) {
          onAdvanceTime();
        }
        break;
      case 'KeyY':
        if (!event.repeat && onToggleStorm) {
          onToggleStorm();
        }
        break;
      case 'KeyB':
        if (!event.repeat && onBuildCampfire) {
          onBuildCampfire();
        }
        break;
      case 'KeyV':
        if (!event.repeat && onBuildShelter) {
          onBuildShelter();
        }
        break;
      default:
        break;
    }
  };

  const handleKeyUp = (event: KeyboardEvent): void => {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        keys.forward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        keys.backward = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        keys.left = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        keys.right = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        keys.sprint = false;
        break;
      case 'AltLeft':
      case 'AltRight':
        keys.walkSlow = false;
        break;
      case 'ControlLeft':
      case 'ControlRight':
        keys.crouchHold = false;
        break;
      default:
        break;
    }
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!pointerLocked || !inputEnabled) {
      return;
    }
    const clampedX = clamp(event.movementX, -150, 150);
    const clampedY = clamp(event.movementY, -150, 150);
    const sensitivity = 0.0022;
    cameraYaw -= clampedX * sensitivity;
    cameraPitch = clamp(cameraPitch - clampedY * sensitivity, -0.64, 0.54);
  };

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button === 0 && inputEnabled && pointerLocked) {
      triggerAttack();
    }
  };

  const handlePointerLockChange = (): void => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) {
      keys.forward = false;
      keys.backward = false;
      keys.left = false;
      keys.right = false;
      keys.sprint = false;
      keys.walkSlow = false;
      keys.crouchHold = false;
    }
    if (onPointerLockChange) {
      onPointerLockChange(pointerLocked);
    }
  };

  const handleBlur = (): void => {
    keys.forward = false;
    keys.backward = false;
    keys.left = false;
    keys.right = false;
    keys.sprint = false;
    keys.walkSlow = false;
    keys.crouchHold = false;
  };

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mousedown', handleMouseDown);
  window.addEventListener('blur', handleBlur);
  document.addEventListener('pointerlockchange', handlePointerLockChange);

  function updateStance(next: PlayerStance): void {
    if (next !== currentStance) {
      currentStance = next;
      if (onStanceChange) {
        onStanceChange(next);
      }
    }
  }

  function resolveFootstepSurface(x: number, z: number): SurfaceKind {
    if (isInsidePuddle && isInsidePuddle(x, z)) {
      return 'puddle';
    }
    return getRoadFactor(x, z) > 0.45 ? 'asphalt' : 'forest';
  }

  function updateCamera(dt: number): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.05);
    const isSprinting = currentStance === 'sprinting';
    sprintCameraBlend += ((isSprinting ? 1 : 0) - sprintCameraBlend) * Math.min(1, safeDt * 6.5);

    const targetFov = 54 + sprintCameraBlend * 7.5 + attackCameraImpulse * 1.4;
    if (Math.abs(camera.fov - targetFov) > 0.04) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, safeDt * 10);
      camera.updateProjectionMatrix();
    }

    // Smooth vertical camera follow during jump arc so airborne height never snaps
    const camYFollowRate = isAirborne ? 10.5 : 16;
    smoothedCamY += (position.y - smoothedCamY) * Math.min(1, safeDt * camYFollowRate);

    const sinYaw = Math.sin(cameraYaw);
    const cosYaw = Math.cos(cameraYaw);
    const cosP = Math.cos(cameraPitch);
    const sinP = Math.sin(cameraPitch);
    scratchRight.set(cosYaw, 0, -sinYaw);
    scratchBack.set(sinYaw * cosP, -sinP, cosYaw * cosP);

    // Decay hit trauma camera shake smoothly (zero allocations)
    let shakeOffsetX = 0;
    let shakeOffsetY = 0;
    if (hitShake > 0.001) {
      hitShakePhase += safeDt * 42;
      const amp = hitShake * hitShake * 0.16;
      shakeOffsetX = Math.sin(hitShakePhase * 1.37) * amp;
      shakeOffsetY = Math.cos(hitShakePhase * 1.93) * amp * 0.75;
      hitShake = Math.max(0, hitShake - safeDt * 2.8);
    }

    const shoulderOffset = 0.68 - crouchBlend * 0.08 + attackCameraImpulse * 0.05 + shakeOffsetX;
    const pivotHeight = 1.58 - crouchBlend * 0.42 - attackCameraImpulse * 0.04 + shakeOffsetY;
    const desiredDist =
      3.15 + sprintCameraBlend * 0.28 - crouchBlend * 0.24 - attackCameraImpulse * 0.14;

    scratchCamTarget.set(
      position.x + scratchRight.x * shoulderOffset,
      smoothedCamY + pivotHeight,
      position.z + scratchRight.z * shoulderOffset,
    );

    let safeDist = desiredDist;
    const probeSteps = 8;
    for (let s = 1; s <= probeSteps; s += 1) {
      const dist = (desiredDist * s) / probeSteps;
      const px = scratchCamTarget.x + scratchBack.x * dist;
      const py = scratchCamTarget.y + scratchBack.y * dist;
      const pz = scratchCamTarget.z + scratchBack.z * dist;

      scratchCamProbe2D.x = px;
      scratchCamProbe2D.z = pz;
      const hitObs = resolveHorizontalCollision(scratchCamProbe2D, 0.3, obstacles);
      const probeGroundY = getTerrainHeight(px, pz);

      if (hitObs || py < probeGroundY + 0.3) {
        safeDist = Math.max(0.35, dist - 0.25);
        break;
      }
    }

    scratchCamDesired.set(
      scratchCamTarget.x + scratchBack.x * safeDist,
      scratchCamTarget.y + scratchBack.y * safeDist,
      scratchCamTarget.z + scratchBack.z * safeDist,
    );

    const camGroundY = getTerrainHeight(scratchCamDesired.x, scratchCamDesired.z);
    if (scratchCamDesired.y < camGroundY + 0.36) {
      scratchCamDesired.y = camGroundY + 0.36;
    }

    const camSmooth = Math.min(1, safeDt * 18);
    scratchCamCurrent.lerp(scratchCamDesired, camSmooth);
    camera.position.copy(scratchCamCurrent);

    scratchLookAt.set(
      scratchCamTarget.x - scratchBack.x * 18,
      scratchCamTarget.y - scratchBack.y * 18 - 0.52,
      scratchCamTarget.z - scratchBack.z * 18,
    );
    camera.lookAt(scratchLookAt);
  }

  return {
    root,
    position,
    isPointerLocked(): boolean {
      return pointerLocked;
    },
    requestPointerLock(): void {
      if (document.pointerLockElement !== canvas) {
        try {
          const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          if (result && typeof result.catch === 'function') {
            result.catch(() => {
              // Ignore user-cancelled pointer lock rejections cleanly
            });
          }
        } catch {
          // Pointer lock unsupported or blocked cleanly
        }
      }
    },
    setInputEnabled(enabled: boolean): void {
      inputEnabled = enabled;
      if (!enabled) {
        handleBlur();
      }
    },
    setFlashlightActive(active: boolean): void {
      flashlightActive = active;
      chestFlashlight.setActive(active);
    },
    getFlashlightTransform(outOrigin: THREE.Vector3, outDir: THREE.Vector3): void {
      chestFlashlight.lensAnchor.updateWorldMatrix(true, false);
      chestFlashlight.lensAnchor.getWorldPosition(outOrigin);
      // Beam physically follows survivor chest facing with subtle ±12.5 deg aim lead
      const leadYaw = clamp(angleDelta(characterYaw, cameraYaw), -0.22, 0.22);
      const beamYaw = characterYaw + leadYaw;
      const beamPitch = clamp(cameraPitch, -0.6, 0.48);
      const cosP = Math.cos(beamPitch);
      outDir.set(-Math.sin(beamYaw) * cosP, Math.sin(beamPitch), -Math.cos(beamYaw) * cosP);
    },
    getStance(): PlayerStance {
      return currentStance;
    },
    getCameraYaw(): number {
      return cameraYaw;
    },
    getForwardXZ(out: Vec2Like): void {
      out.x = -Math.sin(characterYaw);
      out.z = -Math.cos(characterYaw);
    },
    getCameraAimDir(out: THREE.Vector3): void {
      const cosP = Math.cos(cameraPitch);
      out.set(-Math.sin(cameraYaw) * cosP, Math.sin(cameraPitch), -Math.cos(cameraYaw) * cosP);
    },
    isSprinting(): boolean {
      return lastSprinting;
    },
    isCrouching(): boolean {
      return lastCrouching;
    },
    isMoving(): boolean {
      return smoothedActualSpeed > 0.25;
    },
    triggerHitShake(intensity: number): void {
      hitShake = clamp(Math.max(hitShake, intensity), 0, 1.2);
    },
    resetToSpawn(targetX?: number, targetZ?: number): void {
      const spawnX = targetX ?? SPAWN_POINT.x;
      const spawnZ = targetZ ?? SPAWN_POINT.z;
      const resetY = getTerrainHeight(spawnX, spawnZ);
      position.set(spawnX, resetY, spawnZ);
      flashlightActive = false;
      chestFlashlight.setActive(false);
      groundedY = resetY;
      smoothedCamY = resetY;
      airHeight = 0;
      airElapsed = 0;
      verticalVelocity = 0;
      isAirborne = false;
      jumpLandTimer = 0;
      airVelX = 0;
      airVelZ = 0;
      lastMoveDirX = 0;
      lastMoveDirZ = -1;
      bankAngle = 0;
      attackTimer = 0;
      attackCooldown = 0;
      attackElapsed = 0;
      attackWhooshPending = false;
      attackCameraImpulse = 0;
      nextPunchLeft = false;
      activeAttackIsLeft = false;
      throwTimer = 0;
      throwCooldown = 0;
      throwElapsed = 0;
      throwReleasePending = false;
      crouchToggled = false;
      crouchBlend = 0;
      sprintCameraBlend = 0;
      currentSpeed = 0;
      smoothedActualSpeed = 0;
      lastSprinting = false;
      lastCrouching = false;
      hitShake = 0;
      stridePhase = 0;
      prevStrideSign = 0;
      cameraYaw = -0.035;
      cameraPitch = -0.045;
      characterYaw = -0.06;
      handleBlur();

      root.position.copy(position);
      root.rotation.y = characterYaw;
      if (glbState) {
        glbState.wrapper.rotation.z = 0;
        glbState.wIdle = 1;
        glbState.wWalk = 0;
        glbState.wJog = 0;
        glbState.wRun = 0;
        glbState.wCrouchIdle = 0;
        glbState.wCrouchWalk = 0;
        glbState.wJumpStart = 0;
        glbState.wJumpAir = 0;
        glbState.wJumpLand = 0;
        glbState.wAttackRight = 0;
        glbState.wAttackLeft = 0;
        glbState.wThrow = 0;
        if (glbState.idleLowerAction) {
          glbState.idleLowerAction.setEffectiveWeight(0);
        }
        if (glbState.walkLowerAction) {
          glbState.walkLowerAction.setEffectiveWeight(0);
        }
        if (glbState.jogLowerAction) {
          glbState.jogLowerAction.setEffectiveWeight(0);
        }
        if (glbState.runLowerAction) {
          glbState.runLowerAction.setEffectiveWeight(0);
        }
        if (glbState.crouchIdleLowerAction) {
          glbState.crouchIdleLowerAction.setEffectiveWeight(0);
        }
        if (glbState.crouchWalkLowerAction) {
          glbState.crouchWalkLowerAction.setEffectiveWeight(0);
        }
        if (glbState.jumpStartAction) {
          glbState.jumpStartAction.stop();
          glbState.jumpStartAction.setEffectiveWeight(0);
        }
        if (glbState.jumpAirAction) {
          glbState.jumpAirAction.setEffectiveWeight(0);
        }
        if (glbState.jumpLandAction) {
          glbState.jumpLandAction.stop();
          glbState.jumpLandAction.setEffectiveWeight(0);
        }
        if (glbState.attackRightAction) {
          glbState.attackRightAction.stop();
          glbState.attackRightAction.setEffectiveWeight(0);
        }
        if (glbState.attackRightUpperAction) {
          glbState.attackRightUpperAction.stop();
          glbState.attackRightUpperAction.setEffectiveWeight(0);
        }
        if (glbState.attackLeftAction) {
          glbState.attackLeftAction.stop();
          glbState.attackLeftAction.setEffectiveWeight(0);
        }
        if (glbState.attackLeftUpperAction) {
          glbState.attackLeftUpperAction.stop();
          glbState.attackLeftUpperAction.setEffectiveWeight(0);
        }
        if (glbState.throwAction) {
          glbState.throwAction.stop();
          glbState.throwAction.setEffectiveWeight(0);
        }
        if (glbState.throwUpperAction) {
          glbState.throwUpperAction.stop();
          glbState.throwUpperAction.setEffectiveWeight(0);
        }
      }
      updateStance('standing');
      initCameraTransform();
    },
    update(dt: number, elapsed: number): void {
      const prevX = position.x;
      const prevZ = position.z;
      const prevCharacterYaw = characterYaw;

      if (attackCooldown > 0) {
        attackCooldown = Math.max(0, attackCooldown - dt);
      }
      if (throwCooldown > 0) {
        throwCooldown = Math.max(0, throwCooldown - dt);
      }
      if (jumpLandTimer > 0) {
        jumpLandTimer = Math.max(0, jumpLandTimer - dt);
      }

      if (attackTimer > 0) {
        attackElapsed += dt;
        attackTimer = Math.max(0, attackTimer - dt);
        if (attackWhooshPending && attackElapsed >= ATTACK_WHOOSH_TIME) {
          attackWhooshPending = false;
          if (onAttack) {
            onAttack();
          }
          if (onAttackHitWindow) {
            onAttackHitWindow(position.x, position.z, -Math.sin(characterYaw), -Math.cos(characterYaw));
          }
        }
        // Subtle tactile shoulder-camera micro-impulse peaking across the punch arc
        if (attackElapsed >= 0.14 && attackElapsed <= 0.48) {
          const u = (attackElapsed - 0.14) / 0.34;
          const s = Math.sin(u * Math.PI);
          attackCameraImpulse = s * s;
        } else {
          attackCameraImpulse = 0;
        }
      } else {
        attackCameraImpulse = 0;
      }

      if (throwTimer > 0) {
        throwElapsed += dt;
        throwTimer = Math.max(0, throwTimer - dt);
        // Align torso cleanly along camera aim throughout the bottle throw
        characterYaw = lerpAngle(characterYaw, cameraYaw, Math.min(1, dt * 14));
        if (throwReleasePending && throwElapsed >= THROW_RELEASE_TIME) {
          throwReleasePending = false;
          const sinChar = Math.sin(characterYaw);
          const cosChar = Math.cos(characterYaw);
          const fwdX = -sinChar;
          const fwdZ = -cosChar;
          const rightX = cosChar;
          const rightZ = -sinChar;
          const relX = position.x + rightX * 0.28 + fwdX * 0.52;
          const relY = position.y + 1.5 - crouchBlend * 0.36;
          const relZ = position.z + rightZ * 0.28 + fwdZ * 0.52;
          const cosP = Math.cos(cameraPitch);
          const aimX = -Math.sin(cameraYaw) * cosP;
          const aimY = Math.sin(cameraPitch);
          const aimZ = -Math.cos(cameraYaw) * cosP;
          if (onThrowRelease) {
            onThrowRelease(relX, relY, relZ, aimX, aimY, aimZ);
          } else if (onThrowBottle) {
            onThrowBottle();
          }
        }
      }

      const moveForward = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
      const moveRight = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      const hasInput = inputEnabled && (moveForward !== 0 || moveRight !== 0);
      const sprintAllowed = !canSprint || canSprint();

      // Sprinting while moving forward automatically breaks toggle-crouch into an athletic run
      if (
        hasInput &&
        keys.sprint &&
        sprintAllowed &&
        !isAirborne &&
        throwTimer <= 0 &&
        moveForward >= 0 &&
        !keys.crouchHold
      ) {
        crouchToggled = false;
      }

      const isCrouching = !isAirborne && (crouchToggled || keys.crouchHold);
      const isSprinting =
        hasInput &&
        keys.sprint &&
        sprintAllowed &&
        !isCrouching &&
        !isAirborne &&
        attackTimer <= 0 &&
        throwTimer <= 0 &&
        moveForward >= 0;
      lastSprinting = isSprinting;
      lastCrouching = isCrouching;

      if (isAirborne) {
        updateStance('airborne');
      } else if (throwTimer > 0) {
        updateStance('throwing');
      } else if (attackTimer > 0) {
        updateStance('attacking');
      } else if (isCrouching) {
        updateStance('crouching');
      } else if (isSprinting) {
        updateStance('sprinting');
      } else {
        updateStance('standing');
      }

      const targetCrouch = isCrouching ? 1 : 0;
      crouchBlend += (targetCrouch - crouchBlend) * Math.min(1, dt * 10);

      const actionSpeedScale = attackTimer > 0 ? 0.72 : throwTimer > 0 ? 0.78 : 1;
      const baseLocomotionSpeed = isCrouching
        ? CROUCH_SPEED
        : isSprinting
          ? SPRINT_SPEED
          : keys.walkSlow
            ? SLOW_WALK_SPEED
            : WALK_SPEED;
      const targetSpeed = !hasInput ? 0 : baseLocomotionSpeed * actionSpeedScale;

      const sinYaw = Math.sin(cameraYaw);
      const cosYaw = Math.cos(cameraYaw);
      let lungeDispX = 0;
      let lungeDispZ = 0;
      let turnInPlaceSpeed = 0;

      if (isAirborne) {
        // Carry launch horizontal momentum with subtle mid-air steering control
        let desiredAirX = 0;
        let desiredAirZ = 0;
        if (hasInput) {
          const inputLen = Math.hypot(moveForward, moveRight);
          const normF = moveForward / inputLen;
          const normR = moveRight / inputLen;
          const dirX = -sinYaw * normF + cosYaw * normR;
          const dirZ = -cosYaw * normF - sinYaw * normR;
          const airMaxSpeed = Math.max(WALK_SPEED, currentSpeed);
          desiredAirX = dirX * airMaxSpeed;
          desiredAirZ = dirZ * airMaxSpeed;
          const targetCharYaw = Math.atan2(-dirX, -dirZ);
          characterYaw = lerpAngle(characterYaw, targetCharYaw, Math.min(1, dt * 5));
        }
        const airSteer = Math.min(1, dt * (hasInput ? 3.2 : 0.85));
        airVelX += (desiredAirX - airVelX) * airSteer;
        airVelZ += (desiredAirZ - airVelZ) * airSteer;

        scratchPos2D.x = position.x + airVelX * dt;
        scratchPos2D.z = position.z + airVelZ * dt;
        resolveHorizontalCollision(scratchPos2D, PLAYER_RADIUS, obstacles);
        position.x = scratchPos2D.x;
        position.z = scratchPos2D.z;
      } else {
        // Weighted linear acceleration (13 m/s^2) and natural decelerating stop-step (11 m/s^2)
        const rate = targetSpeed >= currentSpeed ? ACCEL_RATE : DECEL_RATE;
        const maxSpeedDelta = rate * dt;
        currentSpeed += clamp(targetSpeed - currentSpeed, -maxSpeedDelta, maxSpeedDelta);
        if (!hasInput && currentSpeed < 0.02) {
          currentSpeed = 0;
        }

        if (hasInput) {
          const inputLen = Math.hypot(moveForward, moveRight);
          const normF = moveForward / inputLen;
          const normR = moveRight / inputLen;

          const dirX = -sinYaw * normF + cosYaw * normR;
          const dirZ = -cosYaw * normF - sinYaw * normR;

          lastMoveDirX = dirX;
          lastMoveDirZ = dirZ;
          airVelX = dirX * currentSpeed;
          airVelZ = dirZ * currentSpeed;

          scratchPos2D.x = position.x + airVelX * dt;
          scratchPos2D.z = position.z + airVelZ * dt;
          resolveHorizontalCollision(scratchPos2D, PLAYER_RADIUS, obstacles);

          position.x = scratchPos2D.x;
          position.z = scratchPos2D.z;

          const targetCharYaw = Math.atan2(-dirX, -dirZ);
          if (throwTimer <= 0) {
            if (attackTimer > 0 && moveForward > 0) {
              characterYaw = lerpAngle(characterYaw, cameraYaw, Math.min(1, dt * 10));
            } else {
              characterYaw = lerpAngle(characterYaw, targetCharYaw, Math.min(1, dt * 11));
            }
          }
        } else {
          // Retain last direction while decelerating so survivor naturally takes a stop-step (jog -> walk -> idle)
          if (currentSpeed > 0) {
            airVelX = lastMoveDirX * currentSpeed;
            airVelZ = lastMoveDirZ * currentSpeed;
            scratchPos2D.x = position.x + airVelX * dt;
            scratchPos2D.z = position.z + airVelZ * dt;
          } else {
            airVelX = 0;
            airVelZ = 0;
            scratchPos2D.x = position.x;
            scratchPos2D.z = position.z;
          }
          const hitStopWall = resolveHorizontalCollision(scratchPos2D, PLAYER_RADIUS, obstacles);
          const postLocoX = scratchPos2D.x;
          const postLocoZ = scratchPos2D.z;
          position.x = postLocoX;
          position.z = postLocoZ;
          if (hitStopWall && currentSpeed > 0) {
            currentSpeed = Math.max(0, currentSpeed - DECEL_RATE * dt * 2.5);
          }

          if (attackTimer > 0) {
            // Snappily align torso toward camera aim and step physically into stationary brawling punches
            characterYaw = lerpAngle(characterYaw, cameraYaw, Math.min(1, dt * 18));
            if (attackElapsed >= 0.05 && attackElapsed <= 0.27) {
              const lungeU = (attackElapsed - 0.05) / 0.22;
              const lungeSpeed = Math.sin(lungeU * Math.PI) * 1.65;
              scratchPos2D.x = position.x - Math.sin(characterYaw) * lungeSpeed * dt;
              scratchPos2D.z = position.z - Math.cos(characterYaw) * lungeSpeed * dt;
              resolveHorizontalCollision(scratchPos2D, PLAYER_RADIUS, obstacles);
              lungeDispX = scratchPos2D.x - postLocoX;
              lungeDispZ = scratchPos2D.z - postLocoZ;
              position.x = scratchPos2D.x;
              position.z = scratchPos2D.z;
            }
          } else if (flashlightActive && throwTimer <= 0) {
            // Turn survivor smoothly with the camera while scanning with the chest flashlight
            const yawGap = Math.abs(angleDelta(characterYaw, cameraYaw));
            characterYaw = lerpAngle(characterYaw, cameraYaw, Math.min(1, dt * 8.5));
            if (yawGap > 0.09) {
              turnInPlaceSpeed = Math.min(1.0, yawGap * 2.4) * 0.55;
            }
          }
        }
      }

      // Exclude stationary punch step-in lunge from locomotion speed so full-body boxing footwork stays planted
      const actualDisp = Math.hypot(position.x - prevX - lungeDispX, position.z - prevZ - lungeDispZ);
      const instantActualSpeed = dt > 1e-5 ? actualDisp / dt : 0;
      smoothedActualSpeed += (instantActualSpeed - smoothedActualSpeed) * Math.min(1, dt * 16);

      // Vertical terrain follow & ballistic jump physics
      const targetGroundY = getTerrainHeight(position.x, position.z);
      if (isAirborne) {
        airElapsed += dt;
        verticalVelocity -= GRAVITY * dt;
        position.y += verticalVelocity * dt;
        airHeight = position.y - targetGroundY;

        if (airHeight <= 0) {
          position.y = targetGroundY;
          groundedY = targetGroundY;
          airHeight = 0;
          verticalVelocity = 0;
          isAirborne = false;
          jumpLandTimer = airElapsed >= 0.16 ? 0.3 : 0.16;
          prevStrideSign = Math.sin(stridePhase);

          if (glbState?.jumpLandAction) {
            glbState.jumpLandAction.reset();
            glbState.jumpLandAction.setLoop(THREE.LoopOnce, 1);
            glbState.jumpLandAction.clampWhenFinished = true;
            glbState.jumpLandAction.enabled = true;
            glbState.jumpLandAction.timeScale = JUMP_LAND_TIME_SCALE;
            glbState.jumpLandAction.play();
          }

          // Carry horizontal landing momentum into natural ground deceleration
          const landHorizSpeed = Math.hypot(airVelX, airVelZ);
          currentSpeed = Math.min(SPRINT_SPEED, landHorizSpeed);
          if (landHorizSpeed > 0.05) {
            lastMoveDirX = airVelX / landHorizSpeed;
            lastMoveDirZ = airVelZ / landHorizSpeed;
          }

          if (onLand && airElapsed >= 0.08) {
            onLand(resolveFootstepSurface(position.x, position.z));
          }
          airElapsed = 0;
        }
      } else {
        groundedY += (targetGroundY - groundedY) * Math.min(1, dt * 18);
        position.y = groundedY;
        airHeight = 0;
      }

      root.position.copy(position);
      root.rotation.y = characterYaw;

      // Natural centripetal body lean while banking around turns on the ground
      const yawVel = dt > 1e-5 ? angleDelta(prevCharacterYaw, characterYaw) / dt : 0;
      const targetBank =
        isAirborne || smoothedActualSpeed < 0.25
          ? 0
          : clamp(-yawVel * (smoothedActualSpeed / SPRINT_SPEED) * 0.045, -0.11, 0.11);
      bankAngle += (targetBank - bankAngle) * Math.min(1, dt * 8);

      // Drive surface-reactive footsteps synced to real MoCap gait cadences (suppressed in air & landing absorb)
      const speedNorm = clamp(smoothedActualSpeed / WALK_SPEED, 0, 1.8);
      const isMovingOnGround = !isAirborne && jumpLandTimer <= 0 && instantActualSpeed > 0.35;
      const strideRate = isCrouching
        ? 6.2
        : smoothedActualSpeed > 4.2
          ? 10.4
          : smoothedActualSpeed > 2.3
            ? 8.4
            : 6.4;

      if (isMovingOnGround) {
        stridePhase += dt * strideRate;
        const strideSine = Math.sin(stridePhase);
        if (
          ((prevStrideSign <= 0 && strideSine > 0) || (prevStrideSign >= 0 && strideSine < 0)) &&
          onFootstep
        ) {
          const surface = resolveFootstepSurface(position.x, position.z);
          const intensity = isCrouching
            ? 0.38
            : smoothedActualSpeed > 4.2
              ? 1.0
              : smoothedActualSpeed > 2.3
                ? 0.72
                : 0.52;
          onFootstep(surface, intensity);
        }
        prevStrideSign = strideSine;
      } else {
        prevStrideSign = Math.sin(stridePhase);
      }

      // Drive continuous 4-tier optical MoCap AnimationMixer state machine (zero per-frame allocations)
      if (glbState) {
        glbState.wrapper.rotation.z = bankAngle;

        const standFactor = 1 - crouchBlend;
        const crouchFactor = crouchBlend;
        const s = smoothedActualSpeed;
        // Blend subtle foot-pivot walk weight while turning in place with chest flashlight
        const animSpeed = Math.max(s, turnInPlaceSpeed);

        // Continuous standing speed-curve weights: 0 -> 1.70 (idle->walk) -> 3.45 (walk->jog) -> 5.80 (jog->run)
        let tStandIdle = 0;
        let tStandWalk = 0;
        let tStandJog = 0;
        let tStandRun = 0;

        if (animSpeed <= 1.7) {
          const u = clamp(animSpeed / 1.7, 0, 1);
          tStandIdle = 1 - u;
          tStandWalk = u;
        } else if (glbState.jogAction) {
          if (animSpeed <= 3.45) {
            const u = clamp((animSpeed - 1.7) / (3.45 - 1.7), 0, 1);
            tStandWalk = 1 - u;
            tStandJog = u;
          } else {
            const u = clamp((animSpeed - 3.45) / (5.8 - 3.45), 0, 1);
            tStandJog = 1 - u;
            tStandRun = u;
          }
        } else {
          // Graceful fallback for custom GLBs omitting a dedicated 'jog' clip
          const u = clamp((animSpeed - 1.7) / (5.8 - 1.7), 0, 1);
          tStandWalk = 1 - u;
          tStandRun = u;
        }

        const crouchMoveRatio = clamp(animSpeed / CROUCH_SPEED, 0, 1);

        let tIdle = standFactor * tStandIdle;
        let tWalk = standFactor * tStandWalk;
        let tJog = standFactor * tStandJog;
        let tRun = standFactor * tStandRun;
        let tCrouchIdle = crouchFactor * (1 - crouchMoveRatio);
        let tCrouchWalk = crouchFactor * crouchMoveRatio;

        // Safely redistribute target weights if a fallback GLB omits any optional locomotion clip
        if (!glbState.walkAction) {
          tIdle += tWalk;
          tWalk = 0;
        }
        if (!glbState.jogAction) {
          if (glbState.walkAction) {
            tWalk += tJog;
          } else {
            tIdle += tJog;
          }
          tJog = 0;
        }
        if (!glbState.runAction) {
          if (glbState.jogAction) {
            tJog += tRun;
          } else if (glbState.walkAction) {
            tWalk += tRun;
          } else {
            tIdle += tRun;
          }
          tRun = 0;
        }
        if (!glbState.crouchIdleAction) {
          tIdle += tCrouchIdle;
          tCrouchIdle = 0;
        }
        if (!glbState.crouchWalkAction) {
          if (glbState.crouchIdleAction) {
            tCrouchIdle += tCrouchWalk;
          } else if (glbState.walkAction) {
            tWalk += tCrouchWalk;
          } else {
            tIdle += tCrouchWalk;
          }
          tCrouchWalk = 0;
        }

        const locoAlpha = 1 - Math.exp(-10 * dt);
        glbState.wIdle += (tIdle - glbState.wIdle) * locoAlpha;
        glbState.wWalk += (tWalk - glbState.wWalk) * locoAlpha;
        glbState.wJog += (tJog - glbState.wJog) * locoAlpha;
        glbState.wRun += (tRun - glbState.wRun) * locoAlpha;
        glbState.wCrouchIdle += (tCrouchIdle - glbState.wCrouchIdle) * locoAlpha;
        glbState.wCrouchWalk += (tCrouchWalk - glbState.wCrouchWalk) * locoAlpha;

        const locoSum =
          glbState.wIdle +
          glbState.wWalk +
          glbState.wJog +
          glbState.wRun +
          glbState.wCrouchIdle +
          glbState.wCrouchWalk;
        if (locoSum > 1e-5) {
          const invSum = 1 / locoSum;
          glbState.wIdle *= invSum;
          glbState.wWalk *= invSum;
          glbState.wJog *= invSum;
          glbState.wRun *= invSum;
          glbState.wCrouchIdle *= invSum;
          glbState.wCrouchWalk *= invSum;
        } else {
          glbState.wIdle = 1;
        }

        // True 3-phase jump weights: jump_start (launch/tuck) -> jump_air (hang loop) -> jump_land (absorb)
        let targetJumpStart = 0;
        let targetJumpAir = 0;
        let targetJumpLand = 0;

        if (isAirborne) {
          if (glbState.jumpStartAction && glbState.jumpAirAction) {
            if (airElapsed < 0.4 && verticalVelocity > -1.0) {
              targetJumpStart = 1;
            } else {
              targetJumpAir = 1;
            }
          } else if (glbState.jumpAirAction) {
            targetJumpAir = 1;
          } else if (glbState.jumpStartAction) {
            targetJumpStart = 1;
          }
        } else if (jumpLandTimer > 0) {
          const landFade = clamp(jumpLandTimer / 0.14, 0, 1);
          if (glbState.jumpLandAction) {
            targetJumpLand = landFade;
          } else if (glbState.jumpStartAction) {
            targetJumpStart = landFade;
          }
        }

        const jsAlpha = 1 - Math.exp(-(targetJumpStart > glbState.wJumpStart ? 22 : 12) * dt);
        glbState.wJumpStart += (targetJumpStart - glbState.wJumpStart) * jsAlpha;
        if (glbState.wJumpStart < 0.001 && targetJumpStart === 0) glbState.wJumpStart = 0;

        const jaAlpha = 1 - Math.exp(-(targetJumpAir > glbState.wJumpAir ? 14 : 18) * dt);
        glbState.wJumpAir += (targetJumpAir - glbState.wJumpAir) * jaAlpha;
        if (glbState.wJumpAir < 0.001 && targetJumpAir === 0) glbState.wJumpAir = 0;

        const jlAlpha = 1 - Math.exp(-(targetJumpLand > glbState.wJumpLand ? 24 : 12) * dt);
        glbState.wJumpLand += (targetJumpLand - glbState.wJumpLand) * jlAlpha;
        if (glbState.wJumpLand < 0.001 && targetJumpLand === 0) glbState.wJumpLand = 0;

        // Alternating right-cross & left-jab punch envelopes (~0.09s ramp-in, 0.20s recovery)
        let targetAttackRight = 0;
        let targetAttackLeft = 0;
        if (attackTimer > 0 && !isAirborne) {
          const fadeIn = clamp(attackElapsed / 0.09, 0, 1);
          const fadeOut = clamp(attackTimer / 0.2, 0, 1);
          const atkEnv = Math.min(fadeIn, fadeOut);
          if (activeAttackIsLeft && glbState.attackLeftAction) {
            targetAttackLeft = atkEnv;
          } else if (glbState.attackRightAction) {
            targetAttackRight = atkEnv;
          }
        }
        const attackAlpha = 1 - Math.exp(-22 * dt);
        glbState.wAttackRight += (targetAttackRight - glbState.wAttackRight) * attackAlpha;
        if (glbState.wAttackRight < 0.001 && targetAttackRight === 0) glbState.wAttackRight = 0;
        glbState.wAttackLeft += (targetAttackLeft - glbState.wAttackLeft) * attackAlpha;
        if (glbState.wAttackLeft < 0.001 && targetAttackLeft === 0) glbState.wAttackLeft = 0;

        // Overhand bottle-throw envelope (~0.08s ramp-in, 0.16s follow-through blend-out)
        let targetThrow = 0;
        if (glbState.throwAction && throwTimer > 0 && !isAirborne) {
          const fadeIn = clamp(throwElapsed / 0.08, 0, 1);
          const fadeOut = clamp(throwTimer / 0.16, 0, 1);
          targetThrow = Math.min(fadeIn, fadeOut);
        }
        const throwAlpha = 1 - Math.exp(-22 * dt);
        glbState.wThrow += (targetThrow - glbState.wThrow) * throwAlpha;
        if (glbState.wThrow < 0.001 && targetThrow === 0) glbState.wThrow = 0;

        // Exact upper-body / lower-body split masking so moving punches/throws stride cleanly with zero foot-sliding
        const rawJumpSum = glbState.wJumpStart + glbState.wJumpAir + glbState.wJumpLand;
        const invJump = rawJumpSum > 1 ? 1 / rawJumpSum : 1;
        const effJumpStart = glbState.wJumpStart * invJump;
        const effJumpAir = glbState.wJumpAir * invJump;
        const effJumpLand = glbState.wJumpLand * invJump;
        const jumpSum = Math.min(1, rawJumpSum);

        const airSuppress = Math.max(0, 1 - jumpSum);
        let cRight = glbState.wAttackRight * airSuppress;
        let cLeft = glbState.wAttackLeft * airSuppress;
        let cThrow = glbState.wThrow * airSuppress;
        const rawCombatSum = cRight + cLeft + cThrow;
        if (rawCombatSum > airSuppress && rawCombatSum > 1e-6) {
          const combatNorm = airSuppress / rawCombatSum;
          cRight *= combatNorm;
          cLeft *= combatNorm;
          cThrow *= combatNorm;
        }
        const combatSum = cRight + cLeft + cThrow;

        const hasLowerLoco =
          glbState.idleLowerAction !== null || glbState.walkLowerAction !== null;
        const moveMask = hasLowerLoco ? clamp((s - 0.3) / 1.05, 0, 1) : 0;
        const rightMask = glbState.attackRightUpperAction ? moveMask : 0;
        const leftMask = glbState.attackLeftUpperAction ? moveMask : 0;
        const throwMask = glbState.throwUpperAction ? moveMask : 0;

        const fullLocoScale = Math.max(0, 1 - jumpSum - combatSum);
        const lowerLocoScale = cRight * rightMask + cLeft * leftMask + cThrow * throwMask;

        if (glbState.idleAction) {
          glbState.idleAction.setEffectiveWeight(glbState.wIdle * fullLocoScale);
          if (glbState.idleLowerAction) {
            glbState.idleLowerAction.time = glbState.idleAction.time;
            glbState.idleLowerAction.timeScale = glbState.idleAction.timeScale;
            glbState.idleLowerAction.setEffectiveWeight(glbState.wIdle * lowerLocoScale);
          }
        }
        if (glbState.walkAction) {
          const walkScale =
            s <= 1.7 ? clamp(s / 1.67, 0.68, 1.22) : clamp(s / 1.67, 0.85, 1.35);
          glbState.walkAction.timeScale = walkScale;
          glbState.walkAction.setEffectiveWeight(glbState.wWalk * fullLocoScale);
          if (glbState.walkLowerAction) {
            glbState.walkLowerAction.time = glbState.walkAction.time;
            glbState.walkLowerAction.timeScale = walkScale;
            glbState.walkLowerAction.setEffectiveWeight(glbState.wWalk * lowerLocoScale);
          }
        }
        if (glbState.jogAction) {
          const jogScale = clamp(s / 3.6, 0.78, 1.2);
          glbState.jogAction.timeScale = jogScale;
          glbState.jogAction.setEffectiveWeight(glbState.wJog * fullLocoScale);
          if (glbState.jogLowerAction) {
            glbState.jogLowerAction.time = glbState.jogAction.time;
            glbState.jogLowerAction.timeScale = jogScale;
            glbState.jogLowerAction.setEffectiveWeight(glbState.wJog * lowerLocoScale);
          }
        }
        if (glbState.runAction) {
          const runScale = clamp(s / 5.79, 0.82, 1.18);
          glbState.runAction.timeScale = runScale;
          glbState.runAction.setEffectiveWeight(glbState.wRun * fullLocoScale);
          if (glbState.runLowerAction) {
            glbState.runLowerAction.time = glbState.runAction.time;
            glbState.runLowerAction.timeScale = runScale;
            glbState.runLowerAction.setEffectiveWeight(glbState.wRun * lowerLocoScale);
          }
        }
        if (glbState.crouchIdleAction) {
          glbState.crouchIdleAction.setEffectiveWeight(glbState.wCrouchIdle * fullLocoScale);
          if (glbState.crouchIdleLowerAction) {
            glbState.crouchIdleLowerAction.time = glbState.crouchIdleAction.time;
            glbState.crouchIdleLowerAction.timeScale = glbState.crouchIdleAction.timeScale;
            glbState.crouchIdleLowerAction.setEffectiveWeight(glbState.wCrouchIdle * lowerLocoScale);
          }
        }
        if (glbState.crouchWalkAction) {
          const crouchWalkScale = clamp(s / 1.81, 0.65, 1.25);
          glbState.crouchWalkAction.timeScale = crouchWalkScale;
          glbState.crouchWalkAction.setEffectiveWeight(glbState.wCrouchWalk * fullLocoScale);
          if (glbState.crouchWalkLowerAction) {
            glbState.crouchWalkLowerAction.time = glbState.crouchWalkAction.time;
            glbState.crouchWalkLowerAction.timeScale = crouchWalkScale;
            glbState.crouchWalkLowerAction.setEffectiveWeight(glbState.wCrouchWalk * lowerLocoScale);
          }
        }
        if (glbState.jumpStartAction) {
          glbState.jumpStartAction.setEffectiveWeight(effJumpStart);
        }
        if (glbState.jumpAirAction) {
          glbState.jumpAirAction.setEffectiveWeight(effJumpAir);
        }
        if (glbState.jumpLandAction) {
          glbState.jumpLandAction.setEffectiveWeight(effJumpLand);
        }
        if (glbState.attackRightAction) {
          glbState.attackRightAction.setEffectiveWeight(cRight * (1 - rightMask));
        }
        if (glbState.attackRightUpperAction) {
          glbState.attackRightUpperAction.setEffectiveWeight(cRight * rightMask);
        }
        if (glbState.attackLeftAction) {
          glbState.attackLeftAction.setEffectiveWeight(cLeft * (1 - leftMask));
        }
        if (glbState.attackLeftUpperAction) {
          glbState.attackLeftUpperAction.setEffectiveWeight(cLeft * leftMask);
        }
        if (glbState.throwAction) {
          glbState.throwAction.setEffectiveWeight(cThrow * (1 - throwMask));
        }
        if (glbState.throwUpperAction) {
          glbState.throwUpperAction.setEffectiveWeight(cThrow * throwMask);
        }

        glbState.mixer.update(dt);
        return;
      }

      if (proceduralRigDisposed) {
        return;
      }

      const swing = Math.sin(stridePhase) * clamp(speedNorm, 0, 1.3);
      const liftL = Math.max(0, Math.cos(stridePhase)) * clamp(speedNorm, 0, 1.2);
      const liftR = Math.max(0, -Math.cos(stridePhase)) * clamp(speedNorm, 0, 1.2);
      const breathe = Math.sin(elapsed * 2.05) * 0.011;
      const idleWeightShift = Math.sin(elapsed * 0.68) * 0.012 * (1 - clamp(speedNorm, 0, 1));
      const bob = isAirborne ? 0 : Math.abs(Math.sin(stridePhase)) * 0.042 * clamp(speedNorm, 0, 1.25);
      const jumpTuck = isAirborne ? clamp(airHeight * 1.4, 0.25, 1) : 0;

      // Exact trigonometric hip height keeps hiking boots grounded cleanly at y = 0 in standing & crouch!
      const crouchHipAngle = crouchBlend * 0.64;
      const crouchKneeBend = -crouchBlend * 1.18;
      const groundedLegSpanY =
        L_THIGH * Math.cos(crouchHipAngle) + L_SHIN * Math.cos(crouchHipAngle + crouchKneeBend);
      rig.hips.position.set(
        idleWeightShift,
        HIP_LEG_OFFSET + BOOT_SOLE_HEIGHT + groundedLegSpanY + bob + breathe * 0.25,
        0,
      );
      rig.hips.rotation.y = swing * 0.065;
      rig.hips.rotation.z = idleWeightShift * 1.1;

      const attackPhase = attackTimer > 0 ? clamp(attackElapsed / ATTACK_DURATION, 0, 1) : 0;
      const attackSlash =
        attackTimer > 0 ? Math.sin(clamp((attackPhase - 0.12) / 0.55, 0, 1) * Math.PI) : 0;
      const throwPhase = throwTimer > 0 ? clamp(throwElapsed / THROW_DURATION, 0, 1) : 0;
      const throwArc = throwTimer > 0 ? Math.sin(throwPhase * Math.PI) : 0;
      const punchSideSign = activeAttackIsLeft ? -1 : 1;

      // Living upper-chest breathing lift & counter-rotating torso twist during walk/sprint/attack/throw
      rig.chestUpper.position.y = breathe * 0.35;
      rig.torso.rotation.x = -(
        crouchBlend * 0.32 +
        (isSprinting ? 0.16 : 0.03) * clamp(speedNorm, 0, 1) +
        attackSlash * 0.24 +
        throwArc * 0.18
      );
      rig.torso.rotation.y =
        -swing * 0.11 +
        (attackTimer > 0 ? (-0.32 + attackSlash * 0.85) * punchSideSign : 0) +
        (throwTimer > 0 ? -0.45 + throwPhase * 0.95 : 0);
      rig.torso.rotation.z = -idleWeightShift * 0.8;

      // Subtle living head gaze tracking camera orientation gently
      const lookYawOffset = clamp(angleDelta(characterYaw, cameraYaw), -0.34, 0.34);
      const idleLook = Math.sin(elapsed * 0.42) * 0.035 * (1 - clamp(speedNorm, 0, 1));
      rig.head.rotation.x =
        crouchBlend * 0.22 -
        rig.torso.rotation.x * 0.45 +
        clamp(cameraPitch * 0.35, -0.2, 0.2) +
        breathe * 0.4;
      rig.head.rotation.y = lookYawOffset * 0.45 + idleLook;

      // Leg gait + jump tuck + ankle boot counter-pitch keeping soles flat
      const legAmp = isCrouching ? 0.36 : isSprinting ? 0.64 : 0.46;
      const leftHipRot = swing * legAmp + crouchHipAngle + jumpTuck * 0.48;
      const rightHipRot = -swing * legAmp + crouchHipAngle + jumpTuck * 0.26;
      const leftKneeRot = -(liftL * 0.68) + crouchKneeBend - jumpTuck * 0.82;
      const rightKneeRot = -(liftR * 0.68) + crouchKneeBend - jumpTuck * 0.58;

      rig.leftLeg.rotation.x = leftHipRot;
      rig.rightLeg.rotation.x = rightHipRot;
      rig.leftCalf.rotation.x = leftKneeRot;
      rig.rightCalf.rotation.x = rightKneeRot;
      rig.leftBoot.rotation.x = -(leftHipRot + leftKneeRot) * 0.85;
      rig.rightBoot.rotation.x = -(rightHipRot + rightKneeRot) * 0.85;

      // Left arm natural swing, or left jab when activeAttackIsLeft
      const armAmp = isCrouching ? 0.24 : isSprinting ? 0.64 : 0.36;
      if (attackTimer > 0 && activeAttackIsLeft) {
        rig.leftArm.rotation.x = 1.5 - attackSlash * 2.05;
        rig.leftArm.rotation.z = -0.28 + attackSlash * 0.52;
        rig.leftForearm.rotation.x = 0.68 - attackSlash * 0.45;
      } else {
        rig.leftArm.rotation.x = -swing * armAmp + 0.06 + jumpTuck * 0.55 - attackSlash * 0.35;
        rig.leftArm.rotation.z = -0.09 - breathe * 0.35 - jumpTuck * 0.24;
        rig.leftForearm.rotation.x = 0.24 + Math.max(0, -swing) * 0.34 + crouchBlend * 0.22;
      }

      // Right arm: resting axe, right cross punch, or overhand bottle throw arc
      const wantAxeOnShoulder =
        !isSprinting && !isCrouching && !isAirborne && attackTimer <= 0 && throwTimer <= 0;
      axeShoulderBlend += ((wantAxeOnShoulder ? 1 : 0) - axeShoulderBlend) * Math.min(1, dt * 7);

      const carryArmX = swing * armAmp + 0.14 + jumpTuck * 0.48;
      const carryArmZ = 0.1 + breathe * 0.3 + jumpTuck * 0.22;
      const carryForearmX = 0.34 + Math.max(0, swing) * 0.28 + crouchBlend * 0.2;
      const carryForearmZ = 0;

      const shoulderArmX = 0.28 + swing * 0.05 + breathe * 0.2;
      const shoulderArmZ = 0.14;
      const shoulderForearmX = 2.55 - swing * 0.04;
      const shoulderForearmZ = 0;

      if (throwTimer > 0) {
        // Overhand right-arm throw: windup back -> forward whip release -> follow-through
        rig.rightArm.rotation.x = -0.8 + throwPhase * 2.55;
        rig.rightArm.rotation.z = 0.28 - throwArc * 0.22;
        rig.rightForearm.rotation.x = 0.95 - throwPhase * 0.72;
        rig.rightForearm.rotation.z = 0;
        rig.axePivot.rotation.set(1.25, 0.08, 0.12);
      } else if (attackTimer > 0 && !activeAttackIsLeft) {
        rig.rightArm.rotation.x = 1.65 - attackSlash * 2.15;
        rig.rightArm.rotation.z = 0.35 - attackSlash * 0.65;
        rig.rightForearm.rotation.x = 0.72 - attackSlash * 0.42;
        rig.rightForearm.rotation.z = 0;
        rig.axePivot.rotation.set(1.25 - attackSlash * 0.4, 0.08, 0.12);
      } else {
        rig.rightArm.rotation.x = carryArmX + (shoulderArmX - carryArmX) * axeShoulderBlend;
        rig.rightArm.rotation.z = carryArmZ + (shoulderArmZ - carryArmZ) * axeShoulderBlend;
        rig.rightForearm.rotation.x =
          carryForearmX + (shoulderForearmX - carryForearmX) * axeShoulderBlend;
        rig.rightForearm.rotation.z =
          carryForearmZ + (shoulderForearmZ - carryForearmZ) * axeShoulderBlend;

        const shoulderAxeX = -1.61;
        const shoulderAxeY = Math.PI * 0.5;
        const shoulderAxeZ = -0.22;
        const carryAxeX = 1.32;
        const carryAxeY = 0.08;
        const carryAxeZ = 0.12;

        rig.axePivot.rotation.set(
          carryAxeX + (shoulderAxeX - carryAxeX) * axeShoulderBlend,
          carryAxeY + (shoulderAxeY - carryAxeY) * axeShoulderBlend,
          carryAxeZ + (shoulderAxeZ - carryAxeZ) * axeShoulderBlend,
        );
      }
    },
    updateCamera,
    dispose(): void {
      disposed = true;
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      scene.remove(root);
      // Dispose chest flashlight once after detaching so GLB/procedural cleanup never double-disposes it
      chestFlashlight.dispose();
      if (glbState) {
        glbState.mixer.stopAllAction();
        glbState.mixer.uncacheRoot(glbState.scene);
        disposeObject3DTree(glbState.wrapper);
        glbState = null;
      }
      if (!proceduralRigDisposed) {
        rig.dispose();
        proceduralRigDisposed = true;
      }
      root.clear();
    },
  };
}
