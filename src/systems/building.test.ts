import { describe, expect, it } from 'vitest';
import { getTerrainHeight, resolveHorizontalCollision, type Obstacle } from '../world/terrain';
import {
  createBuildingSystem,
  FOUNDATION_DECK_THICKNESS,
  PIECE_SIZE,
  WALL_HEIGHT,
} from './building';
import { createSurvivalState } from './survival';

describe('snap-together modular base building system', () => {
  it('snaps foundations edge-to-edge, snaps walls/doorways/roofs cleanly, and toggles doorway colliders', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });

    building.setActive(true);
    building.setSelectedKind('foundation');

    // Place Foundation #1 near (-12, 0)
    const p1Y = getTerrainHeight(-12, 4);
    building.updateGhost(-12, p1Y, 4, 0, 0, -1, true);
    const f1 = building.tryPlaceCurrent(() => true);
    expect(f1.ok).toBe(true);
    expect(building.getPieceCount()).toBe(1);
    expect(obstacles.length).toBe(0); // Walkable floor deck has no blocking horizontal collider

    // Floor height check over Foundation #1
    const floorY = building.getFloorHeightAt(f1.x, f1.z);
    expect(floorY).not.toBeNull();
    expect(floorY).toBeCloseTo(f1.y + FOUNDATION_DECK_THICKNESS, 4);
    expect(building.getFloorHeightAt(f1.x + 6, f1.z)).toBeNull();

    // Place Foundation #2 aiming near east edge of Foundation #1 -> snaps exactly +PIECE_SIZE in X and matches Y!
    building.updateGhost(f1.x - 1.2, f1.y, f1.z, 1, 0, 0, true);
    const f2 = building.tryPlaceCurrent(() => true);
    expect(f2.ok).toBe(true);
    expect(f2.x).toBeCloseTo(f1.x + PIECE_SIZE, 3);
    expect(f2.z).toBeCloseTo(f1.z, 3);
    expect(f2.y).toBeCloseTo(f1.y, 4);

    // Snap a Timber Wall to the north (-Z) edge of Foundation #1
    building.setSelectedKind('wall');
    building.updateGhost(f1.x, f1.y, f1.z + 2.4, 0, 0, -1, true);
    const wall = building.tryPlaceCurrent(() => true);
    expect(wall.ok).toBe(true);
    expect(wall.x).toBeCloseTo(f1.x, 3);
    expect(wall.z).toBeCloseTo(f1.z - PIECE_SIZE * 0.5, 3);
    expect(wall.y).toBeCloseTo(f1.y + FOUNDATION_DECK_THICKNESS, 4);
    expect(obstacles.length).toBe(1);

    // Snap a Timber Doorway to the south (+Z) edge of Foundation #1
    building.setSelectedKind('doorway');
    building.updateGhost(f1.x, f1.y, f1.z - 2.4, 0, 0, 1, true);
    const door = building.tryPlaceCurrent(() => true);
    expect(door.ok).toBe(true);
    expect(door.id).toBeDefined();
    expect(door.z).toBeCloseTo(f1.z + PIECE_SIZE * 0.5, 3);
    // Doorway adds 2 jamb OBBs + 1 closed-door OBB -> total 1 + 3 = 4
    expect(obstacles.length).toBe(4);

    // Closed door blocks walking right through the center opening (real PLAYER_RADIUS = 0.44)
    const probeClosed = { x: door.x, z: door.z };
    expect(resolveHorizontalCollision(probeClosed, 0.44, obstacles)).toBe(true);

    // Open door removes center door OBB while keeping the two flanking jambs intact
    const opened = building.toggleDoor(door.id ?? '');
    expect(opened).toBe(true);
    expect(obstacles.length).toBe(3);
    const probeOpen = { x: door.x, z: door.z };
    expect(resolveHorizontalCollision(probeOpen, 0.44, obstacles)).toBe(false);

    // Close door restores center door OBB
    expect(building.toggleDoor(door.id ?? '')).toBe(false);
    expect(obstacles.length).toBe(4);

    // Snap Plank Roof onto Foundation #1 -> provides overhead cabin shelter!
    building.setSelectedKind('roof');
    building.updateGhost(f1.x, f1.y, f1.z + 3.9, 0, 0, -1, true);
    const roof = building.tryPlaceCurrent(() => true);
    expect(roof.ok).toBe(true);
    expect(roof.x).toBeCloseTo(f1.x, 3);
    expect(roof.z).toBeCloseTo(f1.z, 3);
    expect(roof.y).toBeCloseTo(f1.y + FOUNDATION_DECK_THICKNESS + WALL_HEIGHT, 4);
    expect(building.isInsideBuiltShelter(f1.x, f1.z)).toBe(true);
    expect(building.isInsideBuiltShelter(f1.x + 8, f1.z + 8)).toBe(false);

    building.dispose();
    expect(obstacles.length).toBe(0);
  });

  it('supports defensive spikes, storage stash, workbench prompts, 50% dismantle refunds, and save/hydrate', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: (x, z) => Math.hypot(x - 10, z - 10) < 2,
    });
    building.setActive(true);

    // Reject placement inside a puddle
    building.setSelectedKind('spikes');
    building.updateGhost(10, 0, 13.9, 0, 0, -1, true);
    const wetResult = building.tryPlaceCurrent(() => true);
    expect(wetResult.ok).toBe(false);
    expect(wetResult.reason).toBe('puddle');

    // Place Defensive Spikes on dry ground at (-14, 0)
    building.updateGhost(-14, 0, 3.9, 0, 0, -1, true);
    const spikes = building.tryPlaceCurrent(() => true);
    expect(spikes.ok).toBe(true);
    expect(building.checkSpikeHit(spikes.x, spikes.z + 0.35, 0.44)).toBe(true);
    expect(building.checkSpikeHit(spikes.x + 5, spikes.z + 5, 0.44)).toBe(false);

    // Place Workbench & Storage Crate and verify interact prompts + stash transfer
    building.setSelectedKind('workbench');
    building.updateGhost(-18, 0, 3.9, 0, 0, -1, true);
    const bench = building.tryPlaceCurrent(() => true);
    expect(bench.ok).toBe(true);
    const benchPrompt = building.getInteractTarget(bench.x, bench.z + 1.4, 0, -1);
    expect(benchPrompt?.kind).toBe('workbench');

    building.setSelectedKind('storage');
    building.updateGhost(-22, 0, 3.9, 0, 0, -1, true);
    const crate = building.tryPlaceCurrent(() => true);
    expect(crate.ok).toBe(true);
    const cratePrompt = building.getInteractTarget(crate.x, crate.z + 1.3, 0, -1);
    expect(cratePrompt?.kind).toBe('storage');

    const survival = createSurvivalState();
    survival.addLoot({ wood: 6, stone: 4, rations: 2 });
    const dep = building.depositOrWithdrawStorage(survival);
    expect(dep.action).toBe('deposited');
    expect(building.getStorageStash().wood).toBe(3);
    expect(building.getStorageStash().rations).toBe(1);
    expect(survival.inventory.rations).toBe(1);

    // Serialize -> Reset -> Hydrate restores all 3 pieces, colliders, and stash
    const saved = building.serialize();
    expect(saved.pieces.length).toBe(3);
    expect(obstacles.length).toBe(3);

    building.reset();
    expect(building.getPieceCount()).toBe(0);
    expect(obstacles.length).toBe(0);

    building.hydrate(saved.pieces, saved.stash);
    expect(building.getPieceCount()).toBe(3);
    expect(obstacles.length).toBe(3);
    expect(building.getStorageStash().wood).toBe(3);

    // Dismantle Workbench along look ray -> removes collider & refunds 50% rounded up (2W, 1St, 1Sc)
    const dismantle = building.tryDismantleLookedAt(
      bench.x,
      bench.y + 0.6,
      bench.z + 2.5,
      0,
      0,
      -1,
    );
    expect(dismantle.ok).toBe(true);
    expect(dismantle.kind).toBe('workbench');
    expect(dismantle.refund).toEqual({ wood: 2, stone: 1, scrap: 1 });
    expect(building.getPieceCount()).toBe(2);
    expect(obstacles.length).toBe(2);

    building.dispose();
    expect(obstacles.length).toBe(0);
  });

  it('handles rotated 45/90-deg snapping, rotated doorway traversal, freestanding wall roofs, and instant duplicate rejection', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    building.setActive(true);

    // Rotate 45 degrees (PI/4) and place Foundation #1
    building.setSelectedKind('foundation');
    building.rotateGhost(Math.PI * 0.25);
    building.updateGhost(-16, 0, 8, 0, 0, -1, true);
    const rotF1 = building.tryPlaceCurrent(() => true);
    expect(rotF1.ok).toBe(true);

    // Immediate back-to-back tryPlaceCurrent without calling updateGhost MUST fail cleanly
    const dupClick = building.tryPlaceCurrent(() => true);
    expect(dupClick.ok).toBe(false);
    expect(building.getPieceCount()).toBe(1);

    // Rotated getFloorHeightAt succeeds inside rotated diamond footprint & fails outside
    expect(building.getFloorHeightAt(rotF1.x + 1.0, rotF1.z - 1.0)).not.toBeNull();
    expect(building.getFloorHeightAt(rotF1.x + 2.4, rotF1.z)).toBeNull();

    // Rotate 90 degrees total on a separate foundation & test rotated wall + doorway + roof + spikes
    building.reset();
    building.setActive(true);
    building.setSelectedKind('foundation');
    building.rotateGhost(Math.PI * 0.5);
    building.updateGhost(-16, 0, 8, 0, 0, -1, true);
    const f90 = building.tryPlaceCurrent(() => true);
    expect(f90.ok).toBe(true);

    // Snap Doorway onto rotated foundation edge & confirm open traversal at PLAYER_RADIUS = 0.44
    building.setSelectedKind('doorway');
    building.updateGhost(f90.x - 2.4, f90.y, f90.z, 1, 0, 0, true);
    const d90 = building.tryPlaceCurrent(() => true);
    expect(d90.ok).toBe(true);
    expect(resolveHorizontalCollision({ x: d90.x, z: d90.z }, 0.44, obstacles)).toBe(true);
    expect(building.toggleDoor(d90.id ?? '')).toBe(true);
    expect(resolveHorizontalCollision({ x: d90.x, z: d90.z }, 0.44, obstacles)).toBe(false);

    // Snap Roof onto rotated foundation & confirm rotated isInsideBuiltShelter
    building.setSelectedKind('roof');
    building.updateGhost(f90.x, f90.y, f90.z + 3.9, 0, 0, -1, true);
    const r90 = building.tryPlaceCurrent(() => true);
    expect(r90.ok).toBe(true);
    expect(building.isInsideBuiltShelter(f90.x, f90.z)).toBe(true);

    // Rotated Defensive Spikes (inherits 90-deg userYaw -> spans along world Z!) hit check along rotated local axis
    building.setSelectedKind('spikes');
    building.updateGhost(-24, 0, 8, 0, 0, -1, true);
    const s90 = building.tryPlaceCurrent(() => true);
    expect(s90.ok).toBe(true);
    expect(building.checkSpikeHit(s90.x, s90.z + 1.1, 0.44)).toBe(true);
    expect(building.checkSpikeHit(s90.x + 1.1, s90.z, 0.44)).toBe(false);

    // Freestanding wall + Roof snapping onto wall top offset inward along wall normal
    building.reset();
    building.setActive(true);
    building.setSelectedKind('wall');
    building.updateGhost(-20, 0, 4, 0, 0, -1, true);
    const freeWall = building.tryPlaceCurrent(() => true);
    expect(freeWall.ok).toBe(true);

    building.setSelectedKind('roof');
    building.updateGhost(freeWall.x, freeWall.y, freeWall.z + 5.2, 0, 0, -1, true);
    const wallRoof = building.tryPlaceCurrent(() => true);
    expect(wallRoof.ok).toBe(true);
    expect(wallRoof.y).toBeCloseTo(freeWall.y + WALL_HEIGHT, 4);
    expect(Math.abs(wallRoof.z - freeWall.z)).toBeCloseTo(PIECE_SIZE * 0.5, 3);

    building.dispose();
    expect(obstacles.length).toBe(0);
  });
});
