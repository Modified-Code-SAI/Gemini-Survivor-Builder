import { clamp, WORLD_BOUNDS } from '../world/terrain';
import type { BuildPieceKind, SavedBuildPiece, StorageStash } from './building';
import type { SavedCampfire, SavedCampState, SavedShelter } from './camp';
import type { SurvivalSnapshot } from './survival';

export const SAVE_STORAGE_KEY = 'overgrown_frontier_save_v1';

export interface WorldSaveData {
  readonly version: 1;
  readonly savedAt: number;
  readonly player: {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
  };
  readonly timeHours: number;
  readonly survival: SurvivalSnapshot;
  readonly builtPieces: readonly SavedBuildPiece[];
  readonly storageStash: Readonly<StorageStash>;
  readonly camp: SavedCampState;
  readonly lootedCacheIds: readonly string[];
  readonly depletedHarvestIds: readonly string[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access restriction (private mode / sandboxed iframe)
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function isBuildPieceKind(value: unknown): value is BuildPieceKind {
  return (
    value === 'foundation' ||
    value === 'wall' ||
    value === 'window_wall' ||
    value === 'doorway' ||
    value === 'roof' ||
    value === 'stairs' ||
    value === 'upper_floor' ||
    value === 'spikes' ||
    value === 'storage' ||
    value === 'workbench'
  );
}

function readStringArray(value: unknown, maxLen: number): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length && out.length < maxLen; i += 1) {
    const item: unknown = value[i];
    if (typeof item === 'string' && item.length > 0 && item.length <= 80) {
      out.push(item);
    }
  }
  return out;
}

function parseWorldSaveData(raw: unknown): WorldSaveData | null {
  if (!isRecord(raw) || raw['version'] !== 1) {
    return null;
  }

  const savedAt = readFiniteNumber(raw['savedAt']) ?? Date.now();
  const timeHours = readFiniteNumber(raw['timeHours']);
  const playerRec = raw['player'];
  const survivalRec = raw['survival'];
  const campRec = raw['camp'];

  if (timeHours === null || !isRecord(playerRec) || !isRecord(survivalRec) || !isRecord(campRec)) {
    return null;
  }

  const px = readFiniteNumber(playerRec['x']);
  const pz = readFiniteNumber(playerRec['z']);
  const pyaw = readFiniteNumber(playerRec['yaw']);
  if (px === null || pz === null || pyaw === null) {
    return null;
  }

  const vitalsRec = survivalRec['vitals'];
  const invRec = survivalRec['inventory'];
  if (!isRecord(vitalsRec) || !isRecord(invRec)) {
    return null;
  }
  const health = readFiniteNumber(vitalsRec['health']);
  const stamina = readFiniteNumber(vitalsRec['stamina']);
  const hunger = readFiniteNumber(vitalsRec['hunger']);
  const warmth = readFiniteNumber(vitalsRec['warmth']);
  if (health === null || stamina === null || hunger === null || warmth === null) {
    return null;
  }

  const rawPieces = raw['builtPieces'];
  if (!Array.isArray(rawPieces)) {
    return null;
  }
  const builtPieces: SavedBuildPiece[] = [];
  for (let i = 0; i < rawPieces.length && builtPieces.length < 96; i += 1) {
    const p: unknown = rawPieces[i];
    if (!isRecord(p) || !isBuildPieceKind(p['kind'])) {
      continue;
    }
    const id = typeof p['id'] === 'string' && p['id'].length > 0 ? p['id'] : `bp_${i + 1}`;
    const x = readFiniteNumber(p['x']);
    const y = readFiniteNumber(p['y']);
    const z = readFiniteNumber(p['z']);
    const yaw = readFiniteNumber(p['yaw']);
    if (x === null || y === null || z === null || yaw === null) {
      continue;
    }
    const rawHp = readFiniteNumber(p['hp']);
    const hpField = rawHp !== null && rawHp > 0 ? { hp: rawHp } : {};
    builtPieces.push(
      p['kind'] === 'doorway'
        ? { id, kind: p['kind'], x, y, z, yaw, doorOpen: p['doorOpen'] === true, ...hpField }
        : { id, kind: p['kind'], x, y, z, yaw, ...hpField },
    );
  }

  const stashRec = raw['storageStash'];
  const storageStash: StorageStash = isRecord(stashRec)
    ? {
        wood: readNonNegInt(stashRec['wood']),
        stone: readNonNegInt(stashRec['stone']),
        scrap: readNonNegInt(stashRec['scrap']),
        rations: readNonNegInt(stashRec['rations']),
        medkits: readNonNegInt(stashRec['medkits']),
        warmers: readNonNegInt(stashRec['warmers']),
        bottles: readNonNegInt(stashRec['bottles']),
      }
    : { wood: 0, stone: 0, scrap: 0, rations: 0, medkits: 0, warmers: 0, bottles: 0 };

  const rawCampfires = campRec['campfires'];
  const rawShelters = campRec['shelters'];
  if (!Array.isArray(rawCampfires) || !Array.isArray(rawShelters)) {
    return null;
  }
  const campfires: SavedCampfire[] = [];
  for (let i = 0; i < rawCampfires.length && campfires.length < 16; i += 1) {
    const f: unknown = rawCampfires[i];
    if (!isRecord(f)) {
      continue;
    }
    const x = readFiniteNumber(f['x']);
    const z = readFiniteNumber(f['z']);
    if (x !== null && z !== null) {
      campfires.push({ x, z });
    }
  }
  const shelters: SavedShelter[] = [];
  for (let i = 0; i < rawShelters.length && shelters.length < 16; i += 1) {
    const s: unknown = rawShelters[i];
    if (!isRecord(s)) {
      continue;
    }
    const x = readFiniteNumber(s['x']);
    const z = readFiniteNumber(s['z']);
    const yaw = readFiniteNumber(s['yaw']);
    if (x !== null && z !== null && yaw !== null) {
      shelters.push({ x, z, yaw });
    }
  }

  const lootedCacheIds = readStringArray(raw['lootedCacheIds'], 32);
  const depletedHarvestIds = readStringArray(raw['depletedHarvestIds'], 320);
  if (!lootedCacheIds || !depletedHarvestIds) {
    return null;
  }

  const gearRec = survivalRec['gear'];
  const gear = isRecord(gearRec)
    ? {
        hasCompoundBow: gearRec['hasCompoundBow'] === true,
        hasRepairHammer: gearRec['hasRepairHammer'] === true,
        reinforcedTools: gearRec['reinforcedTools'] === true,
        upgradedFlashlight: gearRec['upgradedFlashlight'] === true,
        scrapArmor: gearRec['scrapArmor'] === true,
      }
    : {
        hasCompoundBow: false,
        hasRepairHammer: false,
        reinforcedTools: false,
        upgradedFlashlight: false,
        scrapArmor: false,
      };

  return {
    version: 1,
    savedAt,
    player: {
      x: clamp(px, WORLD_BOUNDS.minX + 1, WORLD_BOUNDS.maxX - 1),
      z: clamp(pz, WORLD_BOUNDS.minZ + 1, WORLD_BOUNDS.maxZ - 1),
      yaw: pyaw,
    },
    timeHours: ((timeHours % 24) + 24) % 24,
    survival: {
      vitals: { health, stamina, hunger, warmth },
      inventory: {
        rations: readNonNegInt(invRec['rations']),
        medkits: readNonNegInt(invRec['medkits']),
        warmers: readNonNegInt(invRec['warmers']),
        bottles: readNonNegInt(invRec['bottles']),
        scrap: readNonNegInt(invRec['scrap']),
        wood: readNonNegInt(invRec['wood']),
        stone: readNonNegInt(invRec['stone']),
        arrows: readNonNegInt(invRec['arrows']),
      },
      gear,
    },
    builtPieces,
    storageStash,
    camp: { campfires, shelters },
    lootedCacheIds,
    depletedHarvestIds,
  };
}

export function saveWorldToStorage(
  data: WorldSaveData,
  storage: StorageLike | null = getDefaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function loadWorldFromStorage(
  storage: StorageLike | null = getDefaultStorage(),
): WorldSaveData | null {
  if (!storage) {
    return null;
  }
  try {
    const rawText = storage.getItem(SAVE_STORAGE_KEY);
    if (!rawText) {
      return null;
    }
    const parsed: unknown = JSON.parse(rawText);
    return parseWorldSaveData(parsed);
  } catch {
    return null;
  }
}

export function clearWorldSave(storage: StorageLike | null = getDefaultStorage()): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(SAVE_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors cleanly
  }
}

export function hasSavedWorld(storage: StorageLike | null = getDefaultStorage()): boolean {
  return loadWorldFromStorage(storage) !== null;
}
