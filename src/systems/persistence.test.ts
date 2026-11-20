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
        },
      },
      builtPieces: [
        { id: 'bp_1', kind: 'foundation', x: -12, y: 0.3, z: 4, yaw: 0 },
        { id: 'bp_2', kind: 'doorway', x: -12, y: 0.54, z: 5.5, yaw: Math.PI, doorOpen: true },
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
