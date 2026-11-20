import * as THREE from 'three';
import { getTerrainHeight } from '../world/terrain';
import { getWorldTextureAtlas } from '../world/textures';
import type { LootBundle } from './survival';

export type ContainerVisualKind = 'pack' | 'crate' | 'duffel' | 'medcase' | 'toolbox';

export interface ScavengePromptTarget {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly distance: number;
}

export interface ScavengeResult {
  readonly id: string;
  readonly label: string;
  readonly loot: LootBundle;
}

export interface ScavengeStats {
  readonly looted: number;
  readonly total: number;
}

export interface ScavengeSystem {
  readonly root: THREE.Group;
  update(elapsed: number, playerX: number, playerZ: number): void;
  getPromptTarget(
    playerX: number,
    playerZ: number,
    lookDirX: number,
    lookDirZ: number,
  ): ScavengePromptTarget | null;
  scavengeTarget(id: string): ScavengeResult | null;
  getStats(): ScavengeStats;
  reset(): void;
  dispose(): void;
}

interface ScavengeSpec {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly rotY: number;
  readonly visual: ContainerVisualKind;
  readonly loot: LootBundle;
  readonly onGasPad?: boolean;
}

interface ScavengeNode {
  readonly spec: ScavengeSpec;
  readonly baseY: number;
  readonly group: THREE.Group;
  readonly lid: THREE.Object3D;
  readonly lidClosedRotX: number;
  readonly lidClosedPosY: number;
  readonly glint: THREE.Sprite;
  readonly glintMat: THREE.SpriteMaterial;
  readonly glintBaseY: number;
  looted: boolean;
}

const SCAVENGE_SPECS: readonly ScavengeSpec[] = [
  {
    id: 'overlook_pack',
    label: 'Overlook Hiker Pack',
    x: -4.2,
    z: 7.2,
    rotY: 0.52,
    visual: 'pack',
    loot: { rations: 1, bottles: 2, scrap: 1 },
  },
  {
    id: 'bunker_crate',
    label: 'Bunker Supply Crate',
    x: -5.8,
    z: 3.4,
    rotY: 0.26,
    visual: 'crate',
    loot: { medkits: 1, warmers: 1, scrap: 2 },
  },
  {
    id: 'fore_sedan_trunk',
    label: 'Wrecked Sedan Trunk',
    x: 5.4,
    z: 9.8,
    rotY: -0.92,
    visual: 'duffel',
    loot: { rations: 1, bottles: 1, scrap: 2 },
  },
  {
    id: 'van_cargo',
    label: 'Overgrown Van Cargo',
    x: 4.5,
    z: 5.1,
    rotY: -0.58,
    visual: 'crate',
    loot: { medkits: 1, bottles: 2, scrap: 2 },
  },
  {
    id: 'mid_sedan_cache',
    label: 'Roadside Sedan Cache',
    x: 0.65,
    z: -1.95,
    rotY: 0.82,
    visual: 'pack',
    loot: { rations: 1, bottles: 2, scrap: 1 },
  },
  {
    id: 'gas_med_cabinet',
    label: 'Gas Station Med Cabinet',
    x: 10.4,
    z: -3.5,
    rotY: -0.14,
    visual: 'medcase',
    loot: { medkits: 2, warmers: 1, scrap: 2 },
    onGasPad: true,
  },
  {
    id: 'gas_tool_chest',
    label: 'Gas Station Tool Chest',
    x: 10.2,
    z: -10.4,
    rotY: -0.14,
    visual: 'toolbox',
    loot: { warmers: 1, bottles: 2, scrap: 3 },
    onGasPad: true,
  },
  {
    id: 'milepost_stash',
    label: 'Milepost 42 Supply Stash',
    x: -0.9,
    z: -43.2,
    rotY: 0.34,
    visual: 'crate',
    loot: { rations: 2, medkits: 1, warmers: 1, scrap: 4 },
  },
];

const INTERACT_RANGE = 2.7;
const INTERACT_RANGE_SQ = INTERACT_RANGE * INTERACT_RANGE;
const GLINT_RANGE = 9.0;
const GLINT_RANGE_SQ = GLINT_RANGE * GLINT_RANGE;

function createGlintTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size * 0.5;
    const cy = size * 0.5;
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, size * 0.48);
    grad.addColorStop(0, 'rgba(255, 240, 195, 0.95)');
    grad.addColorStop(0.24, 'rgba(232, 185, 102, 0.58)');
    grad.addColorStop(0.55, 'rgba(214, 152, 66, 0.16)');
    grad.addColorStop(1, 'rgba(214, 152, 66, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Subtle crisp 4-point specular glint core
    ctx.strokeStyle = 'rgba(255, 246, 214, 0.85)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy);
    ctx.lineTo(cx + 22, cy);
    ctx.moveTo(cx, cy - 22);
    ctx.lineTo(cx, cy + 22);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates 8 grounded, diegetically glinting 3D scavenging containers distributed across Old Route 9.
 */
export function createScavengeSystem(): ScavengeSystem {
  const root = new THREE.Group();
  const atlas = getWorldTextureAtlas();

  const localGeometries: THREE.BufferGeometry[] = [];
  const localMaterials: THREE.Material[] = [];
  const glintTexture = createGlintTexture();

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    localGeometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    localMaterials.push(m);
    return m;
  };

  // Shared PBR container materials referencing the world texture atlas (atlas owns its textures)
  const oliveCanvasMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: atlas.fabricOlive.map,
      normalMap: atlas.fabricOlive.normalMap,
      roughnessMap: atlas.fabricOlive.roughnessMap,
      color: 0x8e967c,
      roughness: 0.94,
      metalness: 0.04,
    }),
  );
  const darkStrapMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2b241d,
      roughness: 0.88,
      metalness: 0.1,
    }),
  );
  const crateMetalMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: atlas.rustVan.map,
      normalMap: atlas.rustVan.normalMap,
      roughnessMap: atlas.rustVan.roughnessMap,
      color: 0x8d8774,
      roughness: 0.86,
      metalness: 0.28,
    }),
  );
  const redToolboxMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: atlas.rustDark.map,
      normalMap: atlas.rustDark.normalMap,
      roughnessMap: atlas.rustDark.roughnessMap,
      color: 0x9c3d2d,
      roughness: 0.72,
      metalness: 0.36,
    }),
  );
  const medWhiteMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: atlas.concrete.map,
      normalMap: atlas.concrete.normalMap,
      color: 0xd6d2c6,
      roughness: 0.7,
      metalness: 0.12,
    }),
  );
  const medCrossMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x992620,
      roughness: 0.65,
      metalness: 0.05,
    }),
  );
  const bottleGlassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x4b6e49,
      roughness: 0.24,
      metalness: 0.15,
    }),
  );

  // Reusable container geometries
  const packBodyGeo = trackGeo(new THREE.BoxGeometry(0.46, 0.56, 0.28));
  const packFlapGeo = trackGeo(new THREE.BoxGeometry(0.48, 0.14, 0.3));
  const bedrollGeo = trackGeo(new THREE.CylinderGeometry(0.085, 0.085, 0.48, 10));
  bedrollGeo.rotateZ(Math.PI * 0.5);

  const crateBodyGeo = trackGeo(new THREE.BoxGeometry(0.76, 0.42, 0.48));
  const crateLidGeo = trackGeo(new THREE.BoxGeometry(0.8, 0.08, 0.52));
  const crateBandGeo = trackGeo(new THREE.BoxGeometry(0.07, 0.44, 0.5));

  const duffelBodyGeo = trackGeo(new THREE.CylinderGeometry(0.2, 0.21, 0.72, 10));
  duffelBodyGeo.rotateZ(Math.PI * 0.5);
  const duffelFlapGeo = trackGeo(new THREE.BoxGeometry(0.54, 0.08, 0.24));

  const medBodyGeo = trackGeo(new THREE.BoxGeometry(0.48, 0.32, 0.22));
  const medLidGeo = trackGeo(new THREE.BoxGeometry(0.5, 0.07, 0.24));
  const medCrossHGeo = trackGeo(new THREE.BoxGeometry(0.16, 0.045, 0.02));
  const medCrossVGeo = trackGeo(new THREE.BoxGeometry(0.045, 0.16, 0.02));

  const toolBodyGeo = trackGeo(new THREE.BoxGeometry(0.62, 0.34, 0.32));
  const toolLidGeo = trackGeo(new THREE.BoxGeometry(0.64, 0.08, 0.34));
  const bottleGeo = trackGeo(new THREE.CylinderGeometry(0.036, 0.042, 0.24, 8));

  const nodes: ScavengeNode[] = [];
  // Horizontal top elevation of the right gas station concrete pad (origin y - 0.22 + pad 0.15 + half-height 0.225)
  const gasPadTopY = getTerrainHeight(12.6, -6.8) + 0.155;

  for (let i = 0; i < SCAVENGE_SPECS.length; i += 1) {
    const spec = SCAVENGE_SPECS[i];
    if (!spec) {
      continue;
    }

    const terrainY = getTerrainHeight(spec.x, spec.z);
    const baseY = spec.onGasPad ? Math.max(terrainY, gasPadTopY) : terrainY;
    const group = new THREE.Group();
    group.position.set(spec.x, baseY, spec.z);
    group.rotation.y = spec.rotY;

    let lid: THREE.Object3D;
    let lidClosedRotX = 0;
    let lidClosedPosY = 0;
    let glintBaseY = 0.72;

    if (spec.visual === 'pack') {
      const body = new THREE.Mesh(packBodyGeo, oliveCanvasMat);
      body.position.set(0, 0.28, 0);
      body.rotation.x = -0.24;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const bedroll = new THREE.Mesh(bedrollGeo, darkStrapMat);
      bedroll.position.set(0, 0.1, 0.16);
      bedroll.castShadow = true;
      group.add(bedroll);

      const flap = new THREE.Mesh(packFlapGeo, darkStrapMat);
      flap.position.set(0, 0.56, -0.04);
      flap.rotation.x = -0.2;
      flap.castShadow = true;
      group.add(flap);
      lid = flap;
      lidClosedRotX = -0.2;
      lidClosedPosY = 0.56;

      // Glass bottle peeking beside the hiker pack
      const bottle = new THREE.Mesh(bottleGeo, bottleGlassMat);
      bottle.position.set(0.32, 0.12, 0.08);
      bottle.rotation.z = 0.14;
      bottle.castShadow = true;
      group.add(bottle);

      glintBaseY = 0.84;
    } else if (spec.visual === 'duffel') {
      const body = new THREE.Mesh(duffelBodyGeo, oliveCanvasMat);
      body.position.set(0, 0.2, 0);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const flap = new THREE.Mesh(duffelFlapGeo, darkStrapMat);
      flap.position.set(0, 0.38, 0);
      flap.castShadow = true;
      group.add(flap);
      lid = flap;
      lidClosedRotX = 0;
      lidClosedPosY = 0.38;
      glintBaseY = 0.68;
    } else if (spec.visual === 'medcase') {
      const body = new THREE.Mesh(medBodyGeo, medWhiteMat);
      body.position.set(0, 0.16, 0);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const crossH = new THREE.Mesh(medCrossHGeo, medCrossMat);
      crossH.position.set(0, 0.17, 0.115);
      group.add(crossH);
      const crossV = new THREE.Mesh(medCrossVGeo, medCrossMat);
      crossV.position.set(0, 0.17, 0.115);
      group.add(crossV);

      const cap = new THREE.Mesh(medLidGeo, medWhiteMat);
      cap.position.set(0, 0.34, 0);
      cap.castShadow = true;
      group.add(cap);
      lid = cap;
      lidClosedRotX = 0;
      lidClosedPosY = 0.34;
      glintBaseY = 0.66;
    } else if (spec.visual === 'toolbox') {
      const body = new THREE.Mesh(toolBodyGeo, redToolboxMat);
      body.position.set(0, 0.17, 0);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const cap = new THREE.Mesh(toolLidGeo, darkStrapMat);
      cap.position.set(0, 0.37, 0);
      cap.castShadow = true;
      group.add(cap);
      lid = cap;
      lidClosedRotX = 0;
      lidClosedPosY = 0.37;
      glintBaseY = 0.72;
    } else {
      const body = new THREE.Mesh(crateBodyGeo, crateMetalMat);
      body.position.set(0, 0.21, 0);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      for (const bx of [-0.24, 0.24]) {
        const band = new THREE.Mesh(crateBandGeo, darkStrapMat);
        band.position.set(bx, 0.21, 0);
        group.add(band);
      }

      const cap = new THREE.Mesh(crateLidGeo, crateMetalMat);
      cap.position.set(0, 0.45, 0);
      cap.castShadow = true;
      cap.receiveShadow = true;
      group.add(cap);
      lid = cap;
      lidClosedRotX = 0;
      lidClosedPosY = 0.45;
      glintBaseY = 0.78;
    }

    const glintMat = trackMat(
      new THREE.SpriteMaterial({
        map: glintTexture,
        color: 0xffdf96,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const glint = new THREE.Sprite(glintMat);
    glint.position.set(0, glintBaseY, 0);
    glint.scale.set(0.42, 0.42, 1);
    glint.visible = false;
    glint.userData['excludeFromGtao'] = true;
    group.add(glint);

    root.add(group);
    nodes.push({
      spec,
      baseY,
      group,
      lid,
      lidClosedRotX,
      lidClosedPosY,
      glint,
      glintMat,
      glintBaseY,
      looted: false,
    });
  }

  let lootedCount = 0;

  // Pre-allocated mutable prompt & stats objects (ZERO per-frame allocations!)
  const scratchPrompt = {
    id: '',
    label: '',
    x: 0,
    z: 0,
    distance: 0,
  };
  const scratchStats = {
    looted: 0,
    total: nodes.length,
  };

  function update(elapsed: number, playerX: number, playerZ: number): void {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) {
        continue;
      }
      if (node.looted) {
        if (node.glint.visible) {
          node.glint.visible = false;
          node.glintMat.opacity = 0;
        }
        continue;
      }

      const dx = node.spec.x - playerX;
      const dz = node.spec.z - playerZ;
      const distSq = dx * dx + dz * dz;

      if (distSq <= GLINT_RANGE_SQ) {
        const dist = Math.sqrt(distSq);
        const fade = 1 - dist / GLINT_RANGE;
        const pulse = 0.65 + 0.35 * Math.sin(elapsed * 2.8 + i * 1.37);
        node.glint.visible = true;
        node.glintMat.opacity = Math.min(0.85, fade * 1.15 * pulse);
        node.glint.position.y = node.glintBaseY + Math.sin(elapsed * 2.1 + i) * 0.045;
        const s = 0.34 + pulse * 0.14;
        node.glint.scale.set(s, s, 1);
      } else if (node.glint.visible) {
        node.glint.visible = false;
        node.glintMat.opacity = 0;
      }
    }
  }

  function getPromptTarget(
    playerX: number,
    playerZ: number,
    lookDirX: number,
    lookDirZ: number,
  ): ScavengePromptTarget | null {
    let bestNode: ScavengeNode | null = null;
    let bestScore = Infinity;
    let bestDist = Infinity;

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || node.looted) {
        continue;
      }
      const dx = node.spec.x - playerX;
      const dz = node.spec.z - playerZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > INTERACT_RANGE_SQ) {
        continue;
      }
      const dist = Math.sqrt(distSq);
      let lookBonus = 0;
      if (dist > 0.05) {
        const dot = (dx * lookDirX + dz * lookDirZ) / dist;
        lookBonus = (dot < -1 ? -1 : dot > 1 ? 1 : dot) * 0.65;
      }
      const score = dist - lookBonus;
      if (score < bestScore) {
        bestScore = score;
        bestDist = dist;
        bestNode = node;
      }
    }

    if (!bestNode) {
      return null;
    }
    scratchPrompt.id = bestNode.spec.id;
    scratchPrompt.label = bestNode.spec.label;
    scratchPrompt.x = bestNode.spec.x;
    scratchPrompt.z = bestNode.spec.z;
    scratchPrompt.distance = bestDist;
    return scratchPrompt;
  }

  function scavengeTarget(id: string): ScavengeResult | null {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || node.spec.id !== id || node.looted) {
        continue;
      }
      node.looted = true;
      lootedCount += 1;
      node.glint.visible = false;
      node.glintMat.opacity = 0;
      // Visually open/offset the lid to show the cache has been searched
      node.lid.rotation.x = node.lidClosedRotX - 1.15;
      node.lid.position.y = node.lidClosedPosY + 0.04;
      node.lid.visible = node.spec.visual === 'crate' || node.spec.visual === 'toolbox';
      return {
        id: node.spec.id,
        label: node.spec.label,
        loot: node.spec.loot,
      };
    }
    return null;
  }

  function getStats(): ScavengeStats {
    scratchStats.looted = lootedCount;
    scratchStats.total = nodes.length;
    return scratchStats;
  }

  function reset(): void {
    lootedCount = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) {
        continue;
      }
      node.looted = false;
      node.lid.rotation.x = node.lidClosedRotX;
      node.lid.position.y = node.lidClosedPosY;
      node.lid.visible = true;
      node.glint.visible = false;
      node.glintMat.opacity = 0;
    }
  }

  function dispose(): void {
    for (let i = 0; i < localGeometries.length; i += 1) {
      localGeometries[i]?.dispose();
    }
    for (let i = 0; i < localMaterials.length; i += 1) {
      localMaterials[i]?.dispose();
    }
    glintTexture.dispose();
    root.clear();
  }

  return {
    root,
    update,
    getPromptTarget,
    scavengeTarget,
    getStats,
    reset,
    dispose,
  };
}
