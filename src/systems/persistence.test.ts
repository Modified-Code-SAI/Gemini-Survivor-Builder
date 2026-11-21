import { describe, expect, it } from 'vitest';
import {
  clearWorldSave,
  hasSavedWorld,
  loadWorldFromStorage,
  SAVE_STORAGE_KEY,
  saveWorldToStorage,
  type StorageLike,
  type WorldSaveData,
} from './persistence';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

describe('world persistence system', () => {
  it('saves, loads, and clears complete WorldSaveData round-trips cleanly', () => {
    const store = createMemoryStorage();
    expect(hasSavedWorld(store)).toBe(false);
    expect(loadWorldFromStorage(store)).toBeNull();

    const sample: WorldSaveData = {
      version: 1,
      savedAt: 1730000000000,
      player: { x: -10.5, z: 6.2, yaw: 0.45 },
      timeHours: 21.5,
      survival: {
        vitals: { health: 84, stamina: 92, hunger: 68, warmth: 79 },
        inventory: {
          rations: 2,
          medkits: 1,
          warmers: 1,
          bottles: 3,
          scrap: 5,
          wood: 14,
          stone: 9,
          arrows: 8,
        },
        gear: {
          hasCompoundBow: true,
          hasRepairHammer: true,
          reinforcedTools: false,
          upgradedFlashlight: true,
          scrapArmor: false,
        },
      },
      builtPieces: [
        { id: 'bp_1', kind: 'foundation', x: -12, y: 0.3, z: 4, yaw: 0 },
        { id: 'bp_2', kind: 'doorway', x: -12, y: 0.54, z: 5.5, yaw: Math.PI, doorOpen: true, hp: 92 },
        { id: 'bp_3', kind: 'stairs', x: -12, y: 0.54, z: 4, yaw: 0 },
        { id: 'bp_4', kind: 'upper_floor', x: -12, y: 3.34, z: 1, yaw: 0 },
        { id: 'bp_5', kind: 'window_wall', x: -12, y: 3.58, z: -0.5, yaw: 0, hp: 74 },
      ],
      storageStash: {
        wood: 6,
        stone: 4,
        scrap: 2,
        rations: 1,
        medkits: 0,
        warmers: 0,
        bottles: 1,
      },
      camp: {
        campfires: [{ x: -8.2, z: 5.4 }],
        shelters: [{ x: -7.5, z: 8.8, yaw: 0.4 }],
      },
      lootedCacheIds: ['overlook_pack', 'bunker_crate'],
      depletedHarvestIds: ['tree_overlook_w1', 'rock_overlook_w1'],
    };

    expect(saveWorldToStorage(sample, store)).toBe(true);
    expect(hasSavedWorld(store)).toBe(true);

    const loaded = loadWorldFromStorage(store);
    expect(loaded).toEqual(sample);

    // Verify >64 (80) depletedHarvestIds and >64 (72) builtPieces round-trip cleanly
    const manyDepletedIds = Array.from({ length: 80 }, (_, idx) => `forest_tree_${idx}`);
    const manyBuiltPieces = Array.from({ length: 72 }, (_, idx) => ({
      id: `bp_${idx + 1}`,
      kind: 'foundation' as const,
      x: -20 + (idx % 9) * 3,
      y: 0.3,
      z: -10 + Math.floor(idx / 9) * 3,
      yaw: 0,
    }));
    const expandedSample: WorldSaveData = {
      ...sample,
      builtPieces: manyBuiltPieces,
      depletedHarvestIds: manyDepletedIds,
    };
    expect(saveWorldToStorage(expandedSample, store)).toBe(true);
    const loadedExpanded = loadWorldFromStorage(store);
    expect(loadedExpanded?.depletedHarvestIds).toEqual(manyDepletedIds);
    expect(loadedExpanded?.depletedHarvestIds.length).toBe(80);
    expect(loadedExpanded?.builtPieces.length).toBe(72);

    // Verify legacy Phase 1 JSON save (missing arrows & gear) hydrates with safe 0 / false defaults
    store.setItem(
      SAVE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1730000000000,
        player: { x: -4, z: 10, yaw: 0.2 },
        timeHours: 14.25,
        survival: {
          vitals: { health: 95, stamina: 100, hunger: 88, warmth: 92 },
          inventory: {
            rations: 1,
            medkits: 0,
            warmers: 1,
            bottles: 2,
            scrap: 3,
            wood: 10,
            stone: 4,
          },
        },
        builtPieces: [{ id: 'bp_1', kind: 'foundation', x: -6, y: 0.2, z: 8, yaw: 0 }],
        storageStash: { wood: 0, stone: 0, scrap: 0, rations: 0, medkits: 0, warmers: 0, bottles: 0 },
        camp: { campfires: [], shelters: [] },
        lootedCacheIds: ['overlook_pack'],
        depletedHarvestIds: ['forest_tree_0'],
      }),
    );
    const loadedLegacy = loadWorldFromStorage(store);
    expect(loadedLegacy).not.toBeNull();
    expect(loadedLegacy?.survival.inventory.arrows).toBe(0);
    expect(loadedLegacy?.survival.gear).toEqual({
      hasCompoundBow: false,
      hasRepairHammer: false,
      reinforcedTools: false,
      upgradedFlashlight: false,
      scrapArmor: false,
    });

    clearWorldSave(store);
    expect(hasSavedWorld(store)).toBe(false);
    expect(loadWorldFromStorage(store)).toBeNull();
  });

  it('rejects malformed JSON, wrong schema versions, and handles throwing storage safely', () => {
    const store = createMemoryStorage();

    store.setItem(SAVE_STORAGE_KEY, '{corrupted_json');
    expect(loadWorldFromStorage(store)).toBeNull();

    store.setItem(SAVE_STORAGE_KEY, JSON.stringify({ version: 2, player: { x: 0, z: 0, yaw: 0 } }));
    expect(loadWorldFromStorage(store)).toBeNull();

    store.setItem(
      SAVE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        player: { x: 'bad', z: 0, yaw: 0 },
        timeHours: 12,
      }),
    );
    expect(loadWorldFromStorage(store)).toBeNull();

    const failingStorage: StorageLike = {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
      setItem(): void {
        throw new Error('QuotaExceededError');
      },
      removeItem(): void {
        throw new Error('SecurityError');
      },
    };
    expect(loadWorldFromStorage(failingStorage)).toBeNull();
    expect(hasSavedWorld(failingStorage)).toBe(false);
    expect(() => clearWorldSave(failingStorage)).not.toThrow();
  });
});
