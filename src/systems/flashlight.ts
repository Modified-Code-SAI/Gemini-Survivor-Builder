import * as THREE from 'three';
import type { GraphicsQuality } from '../engine/renderer';

export interface FlashlightSystem {
  toggle(): boolean;
  isOn(): boolean;
  getBattery(): number;
  setUpgraded(upgraded: boolean): void;
  isUpgraded(): boolean;
  getBeamExposure(targetX: number, targetY: number, targetZ: number): number;
  setQuality(quality: GraphicsQuality): void;
  update(
    dt: number,
    elapsed: number,
    originX: number,
    originY: number,
    originZ: number,
    aimX: number,
    aimY: number,
    aimZ: number,
    fogBoost: number,
  ): void;
  reset(): void;
  dispose(): void;
}

const CONE_LENGTH = 16;
const SPOT_ANGLE = 0.45;
const UPGRADED_CONE_RADIUS_SCALE = 1.18;
const UPGRADED_SPOT_ANGLE = Math.atan(Math.tan(SPOT_ANGLE) * UPGRADED_CONE_RADIUS_SCALE);
const CONE_RADIUS = CONE_LENGTH * Math.tan(SPOT_ANGLE) * 0.92;
const BASE_INTENSITY = 28;
const BASE_DISTANCE = 38;
const UPGRADED_INTENSITY_SCALE = 1.35;
const UPGRADED_DISTANCE_SCALE = 1.35;
const BATTERY_DRAIN_PER_SEC = 1.5;
const BATTERY_RECHARGE_PER_SEC = 5.5;
const UPGRADED_DRAIN_SCALE = 0.5;
const UPGRADED_RECHARGE_SCALE = 1.5;
const MIN_REACTIVATE_BATTERY = 8;
const BEAM_EXPOSURE_RANGE = 24;
const UPGRADED_EXPOSURE_SCALE = 1.3;

const CONE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vViewPos;
  varying float vAxial;

  void main() {
    vAxial = clamp(position.z / ${CONE_LENGTH.toFixed(1)}, 0.0, 1.0);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPos.xyz;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const CONE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormalView;
  varying vec3 vViewPos;
  varying float vAxial;

  void main() {
    float ndotv = abs(dot(normalize(vNormalView), normalize(-vViewPos)));
    // Soft Fresnel roll-off eliminates hard cone polygon silhouettes from every angle
    float edgeSoft = pow(max(0.0, ndotv), 1.9);
    float nearFade = smoothstep(0.0, 0.075, vAxial);
    float farFade = pow(max(0.0, 1.0 - vAxial), 1.8);
    float alpha = edgeSoft * nearFade * farFade * uOpacity;
    if (alpha <= 0.002) {
      discard;
    }
    gl_FragColor = vec4(uColor, alpha);
  }
`;

function clampVal(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createFlashlightSystem(
  scene: THREE.Scene,
  initialQuality: GraphicsQuality,
): FlashlightSystem {
  const spotLight = new THREE.SpotLight('#fff2d6', 0, BASE_DISTANCE, SPOT_ANGLE, 0.62, 1.5);
  spotLight.castShadow = initialQuality === 'high';
  spotLight.shadow.mapSize.set(1024, 1024);
  spotLight.shadow.camera.near = 0.28;
  spotLight.shadow.camera.far = BASE_DISTANCE;
  spotLight.shadow.bias = -0.00045;
  spotLight.shadow.normalBias = 0.032;
  spotLight.shadow.focus = 1;
  spotLight.visible = false;

  scene.add(spotLight);
  scene.add(spotLight.target);

  // Volumetric cone mesh: apex at (0, 0, 0), expanding cleanly along +Z for Object3D.lookAt()
  const coneGeo = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 28, 1, true);
  coneGeo.rotateX(-Math.PI * 0.5);
  coneGeo.translate(0, 0, CONE_LENGTH * 0.5);

  const coneUniforms = {
    uColor: { value: new THREE.Color('#ffeed0') },
    uOpacity: { value: 0 },
  };
  const coneMat = new THREE.ShaderMaterial({
    vertexShader: CONE_VERTEX_SHADER,
    fragmentShader: CONE_FRAGMENT_SHADER,
    uniforms: coneUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });

  const coneMesh = new THREE.Mesh(coneGeo, coneMat);
  coneMesh.visible = false;
  coneMesh.frustumCulled = false;
  coneMesh.renderOrder = 3;
  coneMesh.userData['excludeFromGtao'] = true;
  scene.add(coneMesh);

  let active = false;
  let upgraded = false;
  let battery = 100;
  let flickerFactor = 1;
  let initialized = false;

  // Pre-allocated scratch vectors (ZERO per-frame allocations)
  const currentPos = new THREE.Vector3();
  const currentAim = new THREE.Vector3(0, 0, -1);
  const desiredAim = new THREE.Vector3(0, 0, -1);
  const targetPoint = new THREE.Vector3();

  const cosOuterBase = Math.cos(SPOT_ANGLE * 1.04);
  const cosInnerBase = Math.cos(SPOT_ANGLE * 0.52);
  const cosOuterUpgraded = Math.cos(UPGRADED_SPOT_ANGLE * 1.04);
  const cosInnerUpgraded = Math.cos(UPGRADED_SPOT_ANGLE * 0.52);

  function applyUpgradeProfile(): void {
    const dist = upgraded ? BASE_DISTANCE * UPGRADED_DISTANCE_SCALE : BASE_DISTANCE;
    spotLight.distance = dist;
    spotLight.angle = upgraded ? UPGRADED_SPOT_ANGLE : SPOT_ANGLE;
    spotLight.shadow.camera.far = dist;
    spotLight.shadow.camera.updateProjectionMatrix();
    coneMesh.scale.set(
      upgraded ? UPGRADED_CONE_RADIUS_SCALE : 1,
      upgraded ? UPGRADED_CONE_RADIUS_SCALE : 1,
      upgraded ? 1.25 : 1,
    );
  }

  return {
    toggle(): boolean {
      if (active) {
        active = false;
        spotLight.visible = false;
        spotLight.intensity = 0;
        coneMesh.visible = false;
        return false;
      }
      if (battery < MIN_REACTIVATE_BATTERY) {
        return false;
      }
      active = true;
      return true;
    },
    isOn(): boolean {
      return active;
    },
    getBattery(): number {
      return battery;
    },
    setUpgraded(nextUpgraded: boolean): void {
      if (upgraded === nextUpgraded) {
        return;
      }
      upgraded = nextUpgraded;
      applyUpgradeProfile();
    },
    isUpgraded(): boolean {
      return upgraded;
    },
    getBeamExposure(targetX: number, targetY: number, targetZ: number): number {
      if (!active || flickerFactor <= 0.05) {
        return 0;
      }
      const dx = targetX - currentPos.x;
      const dy = targetY - currentPos.y;
      const dz = targetZ - currentPos.z;
      const maxRange = upgraded ? BEAM_EXPOSURE_RANGE * 1.25 : BEAM_EXPOSURE_RANGE;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 0.04 || distSq > maxRange * maxRange) {
        return 0;
      }
      const dist = Math.sqrt(distSq);
      const invDist = 1 / dist;
      const dot = (dx * currentAim.x + dy * currentAim.y + dz * currentAim.z) * invDist;
      const cosOuter = upgraded ? cosOuterUpgraded : cosOuterBase;
      const cosInner = upgraded ? cosInnerUpgraded : cosInnerBase;
      if (dot <= cosOuter) {
        return 0;
      }
      const coneAtten = clampVal((dot - cosOuter) / Math.max(0.001, cosInner - cosOuter), 0, 1);
      const distAtten = Math.pow(Math.max(0, 1 - dist / maxRange), 1.15);
      const exposureScale = upgraded ? UPGRADED_EXPOSURE_SCALE : 1.0;
      return clampVal(coneAtten * distAtten * flickerFactor * exposureScale, 0, 1);
    },
    setQuality(quality: GraphicsQuality): void {
      const wantShadow = quality === 'high';
      if (spotLight.castShadow !== wantShadow) {
        spotLight.castShadow = wantShadow;
        if (!wantShadow && spotLight.shadow.map) {
          spotLight.shadow.map.dispose();
          spotLight.shadow.map = null;
        }
      }
    },
    update(
      dt: number,
      elapsed: number,
      originX: number,
      originY: number,
      originZ: number,
      aimX: number,
      aimY: number,
      aimZ: number,
      fogBoost: number,
    ): void {
      const safeDt = Math.max(0, Math.min(dt, 0.1));

      if (active) {
        const drainRate = BATTERY_DRAIN_PER_SEC * (upgraded ? UPGRADED_DRAIN_SCALE : 1.0);
        battery = Math.max(0, battery - drainRate * safeDt);
        if (battery <= 0) {
          active = false;
        }
      } else {
        const rechargeRate =
          BATTERY_RECHARGE_PER_SEC * (upgraded ? UPGRADED_RECHARGE_SCALE : 1.0);
        battery = Math.min(100, battery + rechargeRate * safeDt);
      }

      desiredAim.set(aimX, aimY, aimZ);
      if (desiredAim.lengthSq() < 1e-6) {
        desiredAim.set(0, 0, -1);
      } else {
        desiredAim.normalize();
      }

      if (!initialized) {
        currentPos.set(originX, originY, originZ);
        currentAim.copy(desiredAim);
        initialized = true;
      } else {
        // Tactile shoulder-mounted inertial lag on flashlight aim
        const posAlpha = 1 - Math.exp(-22 * safeDt);
        const aimAlpha = 1 - Math.exp(-15 * safeDt);
        currentPos.x += (originX - currentPos.x) * posAlpha;
        currentPos.y += (originY - currentPos.y) * posAlpha;
        currentPos.z += (originZ - currentPos.z) * posAlpha;
        currentAim.lerp(desiredAim, aimAlpha).normalize();
      }

      if (!active) {
        flickerFactor = 0;
        spotLight.visible = false;
        spotLight.intensity = 0;
        coneMesh.visible = false;
        return;
      }

      // Natural electrical low-battery sputter below 14%
      if (battery < 14) {
        const lowRatio = 1 - battery / 14;
        const wave =
          Math.sin(elapsed * 37.0) * 0.5 +
          Math.sin(elapsed * 71.3 + 1.4) * 0.32 +
          Math.cos(elapsed * 19.7) * 0.18;
        const drop = wave < -0.25 + lowRatio * 0.45 ? 0.18 : 1.0;
        flickerFactor = clampVal(0.45 + 0.55 * drop - lowRatio * 0.2, 0.12, 1.0);
      } else {
        flickerFactor = 1.0;
      }

      targetPoint.set(
        currentPos.x + currentAim.x * 14,
        currentPos.y + currentAim.y * 14,
        currentPos.z + currentAim.z * 14,
      );

      spotLight.visible = true;
      spotLight.position.copy(currentPos);
      spotLight.target.position.copy(targetPoint);
      spotLight.target.updateMatrixWorld();
      spotLight.intensity =
        BASE_INTENSITY * (upgraded ? UPGRADED_INTENSITY_SCALE : 1.0) * flickerFactor;

      // Subtle volumetric mist beam intensifies organically in darkness, fog, and rain
      const clampedFogBoost = clampVal(fogBoost, 0, 1.5);
      const coneOpacity = (0.045 + clampedFogBoost * 0.125) * flickerFactor;
      coneUniforms.uOpacity.value = coneOpacity;
      coneMesh.visible = coneOpacity > 0.008;
      coneMesh.position.copy(currentPos);
      coneMesh.lookAt(targetPoint);
    },
    reset(): void {
      active = false;
      if (upgraded) {
        upgraded = false;
        applyUpgradeProfile();
      }
      battery = 100;
      flickerFactor = 1;
      initialized = false;
      spotLight.visible = false;
      spotLight.intensity = 0;
      coneMesh.visible = false;
      coneUniforms.uOpacity.value = 0;
    },
    dispose(): void {
      scene.remove(spotLight);
      scene.remove(spotLight.target);
      scene.remove(coneMesh);
      if (spotLight.shadow.map) {
        spotLight.shadow.map.dispose();
        spotLight.shadow.map = null;
      }
      spotLight.dispose();
      coneGeo.dispose();
      coneMat.dispose();
    },
  };
}
