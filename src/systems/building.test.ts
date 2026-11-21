import { describe, expect, it } from 'vitest';
import { getTerrainHeight, resolveHorizontalCollision, type Obstacle } from '../world/terrain';
import {
  BUILD_MAX_HP,
  createBuildingSystem,
  FOUNDATION_DECK_THICKNESS,
  PIECE_SIZE,
  WALL_HEIGHT,
  type StructureTargetProbe,
} from './building';
import { hasLineOfSight } from './stealth';
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

  it('supports 2-story watchtowers with stairs, upper decks, height-banded 2nd-story walls, and arrow-passable window walls', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    building.setActive(true);

    // 1. Place 1st-story Foundation
    building.setSelectedKind('foundation');
    const pY = getTerrainHeight(-12, 4);
    building.updateGhost(-12, pY, 4, 0, 0, -1, true);
    const f1 = building.tryPlaceCurrent(() => true);
    expect(f1.ok).toBe(true);
    const firstFloorY = f1.y + FOUNDATION_DECK_THICKNESS;

    // 2. Place 1st-story Doorway on south (+Z) edge and open it
    building.setSelectedKind('doorway');
    building.updateGhost(f1.x, firstFloorY, f1.z - 2.4, 0, 0, 1, true);
    const door1 = building.tryPlaceCurrent(() => true);
    expect(door1.ok).toBe(true);
    expect(building.toggleDoor(door1.id ?? '')).toBe(true);

    // 3. Snap Timber Stairs onto Foundation #1 (climbs from +Z to -Z)
    building.setSelectedKind('stairs');
    building.updateGhost(f1.x, firstFloorY, f1.z + 3.9, 0, 0, -1, true);
    const stairs = building.tryPlaceCurrent(() => true);
    expect(stairs.ok).toBe(true);
    expect(stairs.x).toBeCloseTo(f1.x, 3);
    expect(stairs.z).toBeCloseTo(f1.z, 3);
    expect(stairs.y).toBeCloseTo(firstFloorY, 4);

    // 4. Snap Upper Floor Deck #1 past the top of the stairs (-Z by PIECE_SIZE)
    building.setSelectedKind('upper_floor');
    building.updateGhost(f1.x, firstFloorY, f1.z + 0.9, 0, 0, -1, true);
    const uf1 = building.tryPlaceCurrent(() => true);
    expect(uf1.ok).toBe(true);
    expect(uf1.x).toBeCloseTo(f1.x, 3);
    expect(uf1.z).toBeCloseTo(f1.z - PIECE_SIZE, 3);
    expect(uf1.y).toBeCloseTo(firstFloorY + WALL_HEIGHT, 4);
    const secondFloorY = uf1.y + FOUNDATION_DECK_THICKNESS;

    // 5. Snap Upper Floor Deck #2 directly over Foundation #1 bay
    building.updateGhost(f1.x, firstFloorY, f1.z + 3.9, 0, 0, -1, true);
    const uf2 = building.tryPlaceCurrent(() => true);
    expect(uf2.ok).toBe(true);
    expect(uf2.x).toBeCloseTo(f1.x, 3);
    expect(uf2.z).toBeCloseTo(f1.z, 3);
    expect(uf2.y).toBeCloseTo(firstFloorY + WALL_HEIGHT, 4);

    // Smooth stair climb via getFloorHeightAt(..., currentY)
    const stairBot = building.getFloorHeightAt(f1.x, f1.z + 1.4, firstFloorY);
    const stairMid = building.getFloorHeightAt(f1.x, f1.z, firstFloorY + 1.2);
    const stairTop = building.getFloorHeightAt(f1.x, f1.z - 1.4, firstFloorY + 2.4);
    const upperDeck = building.getFloorHeightAt(uf1.x, uf1.z, stairTop ?? firstFloorY + 2.8);
    expect(stairBot).not.toBeNull();
    expect(stairMid).not.toBeNull();
    expect(stairTop).not.toBeNull();
    expect(stairMid ?? -Infinity).toBeGreaterThan((stairBot ?? Infinity) + 1.0);
    expect(stairTop ?? -Infinity).toBeGreaterThan((stairMid ?? Infinity) + 1.0);
    expect(upperDeck).toBeCloseTo(secondFloorY, 4);

    // Standing on 1st floor underneath Upper Floor Deck #2 stays on 1st floor (does NOT jump to 2nd floor!)
    const underDeck = building.getFloorHeightAt(f1.x + 1.45, f1.z, firstFloorY);
    expect(underDeck).toBeCloseTo(firstFloorY, 4);

    // Upper Floor Deck shelters 1st floor beneath it, while open 2nd floor is unsheltered until Roof placed
    expect(building.isInsideBuiltShelter(f1.x, f1.z, firstFloorY)).toBe(true);
    expect(building.isInsideBuiltShelter(uf1.x, uf1.z, secondFloorY)).toBe(false);

    // 6. Place 2nd-story solid Wall directly above the open 1st-story doorway!
    building.setSelectedKind('wall');
    building.updateGhost(uf2.x, secondFloorY, uf2.z - 2.4, 0, 0, 1, true);
    const wall2 = building.tryPlaceCurrent(() => true);
    expect(wall2.ok).toBe(true);
    expect(wall2.z).toBeCloseTo(door1.z, 3);
    expect(wall2.y).toBeCloseTo(secondFloorY, 4);

    // Height-banded OBB: 1st-story actor passes cleanly through open doorway under 2nd-story wall;
    // 2nd-story actor IS blocked by the 2nd-story wall!
    expect(resolveHorizontalCollision({ x: door1.x, z: door1.z }, 0.44, obstacles, firstFloorY)).toBe(
      false,
    );
    expect(resolveHorizontalCollision({ x: wall2.x, z: wall2.z }, 0.44, obstacles, secondFloorY)).toBe(
      true,
    );

    // 7. Place 2nd-story Window Wall on north (-Z) edge of Upper Floor #1
    building.setSelectedKind('window_wall');
    building.updateGhost(uf1.x, secondFloorY, uf1.z + 2.4, 0, 0, -1, true);
    const winWall = building.tryPlaceCurrent(() => true);
    expect(winWall.ok).toBe(true);
    expect(winWall.y).toBeCloseTo(secondFloorY, 4);

    // Arrows pass cleanly through window embrasure (|lx| < 0.72, ly in (1.05, 2.15)) & hit solid frame/wall
    expect(building.checkArrowStructureHit(winWall.x, winWall.y + 1.6, winWall.z)).toBe(false);
    expect(building.checkArrowStructureHit(winWall.x, winWall.y + 0.5, winWall.z)).toBe(true);
    expect(building.checkArrowStructureHit(winWall.x, winWall.y + 2.5, winWall.z)).toBe(true);
    expect(building.checkArrowStructureHit(winWall.x + 1.1, winWall.y + 1.6, winWall.z)).toBe(true);
    expect(building.checkArrowStructureHit(wall2.x, wall2.y + 1.6, wall2.z)).toBe(true);

    // 8. Cap 2nd-story Upper Floor #1 with Roof -> 2nd floor now sheltered
    building.setSelectedKind('roof');
    building.updateGhost(uf1.x, secondFloorY, uf1.z + 3.9, 0, 0, -1, true);
    const roof2 = building.tryPlaceCurrent(() => true);
    expect(roof2.ok).toBe(true);
    expect(roof2.y).toBeCloseTo(secondFloorY + WALL_HEIGHT, 4);
    expect(building.isInsideBuiltShelter(uf1.x, uf1.z, secondFloorY)).toBe(true);

    building.dispose();
    expect(obstacles.length).toBe(0);
  });

  it('tracks structural HP damage, repair hammer restoration, collapse cleanup, spike wear, and damaged HP persistence', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    building.setActive(true);

    // Place a Timber Wall & Defensive Spikes (2 pieces -> base anchor active)
    building.setSelectedKind('wall');
    building.updateGhost(-16, 0, 4, 0, 0, -1, true);
    const wall = building.tryPlaceCurrent(() => true);
    expect(wall.ok).toBe(true);
    expect(wall.id).toBeDefined();

    building.setSelectedKind('spikes');
    building.updateGhost(-12, 0, 4, 0, 0, -1, true);
    const spikes = building.tryPlaceCurrent(() => true);
    expect(spikes.ok).toBe(true);
    expect(obstacles.length).toBe(2);

    const anchor = { x: 0, z: 0 };
    expect(building.getBaseAnchor(anchor)).toBe(true);
    expect(anchor.x).toBeCloseTo((wall.x + spikes.x) * 0.5, 3);

    const probe: StructureTargetProbe = { id: '', kind: 'wall', x: 0, y: 0, z: 0, radius: 0 };
    expect(building.findNearestAttackableStructure(wall.x, wall.z + 2, 6, probe)).toBe(true);
    expect(probe.id).toBe(wall.id);

    // Damage wall -> getRepairTarget detects it -> tryRepairStructure spends 1 Wood & restores +45 HP
    const dmg1 = building.damageStructure(wall.id ?? '', 70);
    expect(dmg1.hit).toBe(true);
    expect(dmg1.destroyed).toBe(false);
    expect(dmg1.remainingHp).toBe(BUILD_MAX_HP.wall - 70);
    building.update(0.1);

    const repairProbe = building.getRepairTarget(wall.x, wall.y, wall.z + 1.8, 0, -1);
    expect(repairProbe).not.toBeNull();
    expect(repairProbe?.id).toBe(wall.id);
    expect(repairProbe?.hp).toBe(BUILD_MAX_HP.wall - 70);

    const survival = createSurvivalState();
    const noWoodRepair = building.tryRepairStructure(wall.x, wall.y, wall.z + 1.8, 0, -1, survival);
    expect(noWoodRepair.ok).toBe(false);
    expect(noWoodRepair.reason).toBe('resources');

    survival.addLoot({ wood: 2 });
    const repaired = building.tryRepairStructure(wall.x, wall.y, wall.z + 1.8, 0, -1, survival);
    expect(repaired.ok).toBe(true);
    expect(repaired.hp).toBe(BUILD_MAX_HP.wall - 25);
    expect(survival.inventory.wood).toBe(1);

    // Serialize -> Reset -> Hydrate preserves exact damaged HP
    const saved = building.serialize();
    const savedWall = saved.pieces.find((p) => p.id === wall.id);
    expect(savedWall?.hp).toBe(BUILD_MAX_HP.wall - 25);
    building.reset();
    building.hydrate(saved.pieces, saved.stash);
    const hydratedTarget = building.getRepairTarget(wall.x, wall.y, wall.z + 1.8, 0, -1);
    expect(hydratedTarget?.hp).toBe(BUILD_MAX_HP.wall - 25);

    // Lethal damage destroys wall and removes its OBB collider cleanly
    const lethal = building.damageStructure(wall.id ?? '', 200);
    expect(lethal.hit).toBe(true);
    expect(lethal.destroyed).toBe(true);
    expect(lethal.remainingHp).toBe(0);
    expect(building.getPieceCount()).toBe(1);
    expect(obstacles.length).toBe(1);

    // Spike durability wear: 8 triggers (8 * 14 = 112 >= 100) wear out and destroy spikes cleanly
    for (let hit = 0; hit < 8; hit += 1) {
      expect(building.checkSpikeHit(spikes.x, spikes.z + 0.35, 0.44)).toBe(true);
    }
    expect(building.getPieceCount()).toBe(0);
    expect(obstacles.length).toBe(0);
    expect(building.checkSpikeHit(spikes.x, spikes.z + 0.35, 0.44)).toBe(false);

    building.dispose();
  });

  it('enforces multi-story vertical isolation for attack targeting, stacked doors/workbenches, spikes, LOS, and fractional HP saves', () => {
    const obstacles: Obstacle[] = [];
    const building = createBuildingSystem({
      obstacles,
      isInsidePuddle: () => false,
    });
    const baseX = -14;
    const baseZ = 4;
    const groundY = getTerrainHeight(baseX, baseZ);
    const firstFloorY = groundY + FOUNDATION_DECK_THICKNESS;
    const upperDeckY = firstFloorY + WALL_HEIGHT;
    const secondFloorY = upperDeckY + FOUNDATION_DECK_THICKNESS;

    // Hydrate a compact 2-story watchtower with stacked doorways, 2nd-story walls/workbench/crate, and ground spikes
    building.hydrate([
      { id: 'bp_1', kind: 'foundation', x: baseX, y: groundY, z: baseZ, yaw: 0 },
      {
        id: 'bp_2',
        kind: 'doorway',
        x: baseX,
        y: firstFloorY,
        z: baseZ + PIECE_SIZE * 0.5,
        yaw: 0,
        doorOpen: true,
      },
      { id: 'bp_3', kind: 'upper_floor', x: baseX, y: upperDeckY, z: baseZ, yaw: 0 },
      {
        id: 'bp_4',
        kind: 'doorway',
        x: baseX,
        y: secondFloorY,
        z: baseZ + PIECE_SIZE * 0.5,
        yaw: 0,
        doorOpen: false,
      },
      {
        id: 'bp_5',
        kind: 'wall',
        x: baseX,
        y: secondFloorY,
        z: baseZ - PIECE_SIZE * 0.5,
        yaw: 0,
      },
      {
        id: 'bp_6',
        kind: 'window_wall',
        x: baseX + PIECE_SIZE * 0.5,
        y: secondFloorY,
        z: baseZ,
        yaw: Math.PI * 0.5,
      },
      { id: 'bp_7', kind: 'workbench', x: baseX, y: firstFloorY, z: baseZ - 0.5, yaw: 0 },
      { id: 'bp_8', kind: 'storage', x: baseX, y: secondFloorY, z: baseZ - 0.5, yaw: 0 },
      { id: 'bp_9', kind: 'spikes', x: baseX, y: groundY, z: baseZ + PIECE_SIZE, yaw: 0 },
    ]);

    // 1. Ground-level findNearestAttackableStructure skips ALL 2nd-story structures (wall/window_wall/storage)
    // even at distance 0, resolving strictly to 1st-story pieces; 2nd-story actor targets 2nd-story pieces!
    const probe: StructureTargetProbe = { id: '', kind: 'wall', x: 0, y: 0, z: 0, radius: 0 };
    expect(
      building.findNearestAttackableStructure(baseX, baseZ - PIECE_SIZE * 0.5, 0.6, probe, groundY),
    ).toBe(false);
    expect(
      building.findNearestAttackableStructure(
        baseX + PIECE_SIZE * 0.5,
        baseZ,
        0.6,
        probe,
        groundY,
      ),
    ).toBe(false);
    expect(
      building.findNearestAttackableStructure(baseX, baseZ - PIECE_SIZE * 0.5, 2.5, probe, groundY),
    ).toBe(true);
    expect(['bp_1', 'bp_7']).toContain(probe.id);
    expect(
      building.findNearestAttackableStructure(
        baseX,
        baseZ - PIECE_SIZE * 0.5,
        0.6,
        probe,
        secondFloorY,
      ),
    ).toBe(true);
    expect(probe.id).toBe('bp_5');

    // 2. Stacked 1st-story vs 2nd-story doorways & workbench/storage resolve strictly by playerY!
    const door1Target = building.getInteractTarget(
      baseX,
      baseZ + PIECE_SIZE * 0.5 + 1.2,
      0,
      -1,
      firstFloorY,
    );
    expect(door1Target?.id).toBe('bp_2');
    expect(door1Target?.doorOpen).toBe(true);

    const door2Target = building.getInteractTarget(
      baseX,
      baseZ + PIECE_SIZE * 0.5 + 1.2,
      0,
      -1,
      secondFloorY,
    );
    expect(door2Target?.id).toBe('bp_4');
    expect(door2Target?.doorOpen).toBe(false);

    const bench1Target = building.getInteractTarget(baseX, baseZ + 0.5, 0, -1, firstFloorY);
    expect(bench1Target?.id).toBe('bp_7');
    expect(bench1Target?.kind).toBe('workbench');

    const crate2Target = building.getInteractTarget(baseX, baseZ + 0.5, 0, -1, secondFloorY);
    expect(crate2Target?.id).toBe('bp_8');
    expect(crate2Target?.kind).toBe('storage');

    // 3. Ground spikes impale ground actor but NEVER hit an actor walking 3 m overhead on the 2nd story
    expect(building.checkSpikeHit(baseX, baseZ + PIECE_SIZE + 0.2, 0.44, secondFloorY)).toBe(false);
    expect(building.checkSpikeHit(baseX, baseZ + PIECE_SIZE + 0.2, 0.44, groundY)).toBe(true);

    // 4. Height-aware LOS sees through open 1st-story doorway under closed 2nd-story doorway,
    // while 2nd-story eye height IS blocked by the closed 2nd-story door!
    expect(
      hasLineOfSight(
        baseX,
        baseZ + PIECE_SIZE * 0.5 + 1.5,
        baseX,
        baseZ + PIECE_SIZE * 0.5 - 1.5,
        obstacles,
        firstFloorY + 1.55,
      ),
    ).toBe(true);
    expect(
      hasLineOfSight(
        baseX,
        baseZ + PIECE_SIZE * 0.5 + 1.5,
        baseX,
        baseZ + PIECE_SIZE * 0.5 - 1.5,
        obstacles,
        secondFloorY + 1.55,
      ),
    ).toBe(false);

    // 5. Fractional positive HP (< 0.5) serializes as at least 1 HP (never 0)
    building.damageStructure('bp_5', BUILD_MAX_HP.wall - 0.3);
    const saved = building.serialize();
    const savedWall = saved.pieces.find((p) => p.id === 'bp_5');
    expect(savedWall?.hp).toBe(1);

    building.dispose();
  });
});
