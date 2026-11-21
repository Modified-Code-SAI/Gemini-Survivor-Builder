import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface OptionalGlbSlotOptions {
  readonly scale?: number;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly manifest?: Readonly<Record<string, string>>;
}

export interface LoadedGlbAsset {
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
}

/**
 * Registry of sculpted & textured Blender/Hunyuan3D .glb assets placed under public/assets/.
 */
export const DEFAULT_GLB_SLOT_MANIFEST: Readonly<Record<string, string>> = {
  survivor: './assets/survivor.glb',
  raider: './assets/raider.glb',
  hollow_stalker: './assets/hollow_stalker.glb',
  overgrown_van: './assets/rusted_van.glb',
  abandoned_sedan: './assets/rusted_sedan.glb',
  felling_axe: './assets/felling_axe.glb',
  pickaxe: './assets/pickaxe.glb',
  whitetail_deer: './assets/whitetail_deer.glb',
  pacific_raven: './assets/pacific_raven.glb',
  repair_hammer: './assets/repair_hammer.glb',
  compound_bow: './assets/compound_bow.glb',
  arrow: './assets/arrow.glb',
};

let sharedLoader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
  }
  return sharedLoader;
}

function tuneLoadedMaterial(mat: THREE.Material): void {
  if (mat instanceof THREE.MeshStandardMaterial) {
    mat.envMapIntensity = 0.78;
    mat.roughness = Math.max(0.45, mat.roughness);
    mat.needsUpdate = true;
  }
}

function configureLoadedGroup(
  gltf: GLTF,
  options: OptionalGlbSlotOptions,
): LoadedGlbAsset {
  const root = gltf.scene;
  const scale = options.scale ?? 1;
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  if (scale !== 1) {
    root.scale.setScalar(scale);
  }

  root.traverse((node: THREE.Object3D) => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = castShadow;
      node.receiveShadow = receiveShadow;
      if (node instanceof THREE.SkinnedMesh) {
        // Prevent animated skeletal bounding-sphere frustum pop-out during walk/crouch
        node.frustumCulled = false;
      }
      const mat = node.material;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i += 1) {
          const item = mat[i];
          if (item instanceof THREE.Material) {
            tuneLoadedMaterial(item);
          }
        }
      } else if (mat instanceof THREE.Material) {
        tuneLoadedMaterial(mat);
      }
    }
  });

  return {
    scene: root,
    animations: gltf.animations,
  };
}

/**
 * Collects all textures owned by a standard/physical/basic Three.js material into a target Set.
 */
export function collectMaterialTextures(
  mat: THREE.Material,
  out: Set<THREE.Texture>,
): void {
  if (mat instanceof THREE.MeshStandardMaterial) {
    if (mat.map) out.add(mat.map);
    if (mat.normalMap) out.add(mat.normalMap);
    if (mat.roughnessMap) out.add(mat.roughnessMap);
    if (mat.metalnessMap) out.add(mat.metalnessMap);
    if (mat.aoMap) out.add(mat.aoMap);
    if (mat.emissiveMap) out.add(mat.emissiveMap);
    if (mat.bumpMap) out.add(mat.bumpMap);
    if (mat.alphaMap) out.add(mat.alphaMap);
    if (mat.lightMap) out.add(mat.lightMap);
    if (mat.displacementMap) out.add(mat.displacementMap);
    if (mat instanceof THREE.MeshPhysicalMaterial) {
      if (mat.clearcoatMap) out.add(mat.clearcoatMap);
      if (mat.clearcoatRoughnessMap) out.add(mat.clearcoatRoughnessMap);
      if (mat.clearcoatNormalMap) out.add(mat.clearcoatNormalMap);
      if (mat.sheenColorMap) out.add(mat.sheenColorMap);
      if (mat.sheenRoughnessMap) out.add(mat.sheenRoughnessMap);
      if (mat.specularIntensityMap) out.add(mat.specularIntensityMap);
      if (mat.specularColorMap) out.add(mat.specularColorMap);
      if (mat.transmissionMap) out.add(mat.transmissionMap);
      if (mat.thicknessMap) out.add(mat.thicknessMap);
      if (mat.iridescenceMap) out.add(mat.iridescenceMap);
      if (mat.iridescenceThicknessMap) out.add(mat.iridescenceThicknessMap);
      if (mat.anisotropyMap) out.add(mat.anisotropyMap);
    }
  } else if (mat instanceof THREE.MeshBasicMaterial) {
    if (mat.map) out.add(mat.map);
    if (mat.alphaMap) out.add(mat.alphaMap);
    if (mat.aoMap) out.add(mat.aoMap);
    if (mat.lightMap) out.add(mat.lightMap);
    if (mat.specularMap) out.add(mat.specularMap);
  }
}

/**
 * Loads a .glb/.gltf model and its embedded animation clips from a concrete URL,
 * returning null cleanly if loading fails.
 */
export async function loadGlbAsset(
  url: string,
  options: OptionalGlbSlotOptions = {},
): Promise<LoadedGlbAsset | null> {
  const loader = getLoader();
  try {
    const gltf = await loader.loadAsync(url);
    return configureLoadedGroup(gltf, options);
  } catch {
    return null;
  }
}

/**
 * Resolves an optional Blender .glb slot from the asset manifest, preserving glTF animations.
 */
export async function loadOptionalGlbAsset(
  slotKey: string,
  options: OptionalGlbSlotOptions = {},
): Promise<LoadedGlbAsset | null> {
  const manifest = options.manifest ?? DEFAULT_GLB_SLOT_MANIFEST;
  const url = manifest[slotKey];
  if (!url) {
    return null;
  }
  return loadGlbAsset(url, options);
}

/**
 * Loads a .glb/.gltf scene root from a concrete URL, returning null cleanly if loading fails.
 */
export async function loadGlbModel(
  url: string,
  options: OptionalGlbSlotOptions = {},
): Promise<THREE.Group | null> {
  const asset = await loadGlbAsset(url, options);
  return asset ? asset.scene : null;
}

/**
 * Resolves an optional Blender .glb slot scene root from the asset manifest.
 */
export async function loadOptionalGlbSlot(
  slotKey: string,
  options: OptionalGlbSlotOptions = {},
): Promise<THREE.Group | null> {
  const asset = await loadOptionalGlbAsset(slotKey, options);
  return asset ? asset.scene : null;
}
