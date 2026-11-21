import * as THREE from 'three';
import { createEngine, type EngineContext, type GraphicsQuality } from './engine/renderer';
import { createPlayerController, type PlayerStance } from './player/controller';
import { createAtmosphereSystem, createRainField } from './systems/atmosphere';
import { createFrontierAudio } from './systems/audio';
import {
  BUILD_PIECE_ORDER,
  BUILD_RECIPES,
  createBuildingSystem,
  type BuildPieceKind,
} from './systems/building';
import {
  CAMPFIRE_SCRAP_COST,
  createCampSystem,
  SHELTER_SCRAP_COST,
  type CampProximityInfo,
} from './systems/camp';
import { createFlashlightSystem } from './systems/flashlight';
import { createHarvestSystem, type EquippedTool } from './systems/harvest';
import {
  clearWorldSave,
  loadWorldFromStorage,
  saveWorldToStorage,
  type WorldSaveData,
} from './systems/persistence';
import { createScavengeSystem } from './systems/scavenge';
import {
  computeStealthFactor,
  isInsideShelter,
  type StealthResult,
} from './systems/stealth';
import {
  createSurvivalState,
  WORKBENCH_RECIPES,
  type CraftItemKind,
  type LootBundle,
  type ResourceCost,
} from './systems/survival';
import { createThreatSystem } from './systems/threats';
import { createWildlifeSystem } from './systems/wildlife';
import { createFrontierEnvironment } from './world/environment';
import { getRoadFactor, getTerrainHeight, type Obstacle, type Vec2Like } from './world/terrain';

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return el as T;
}

function formatStanceLabel(stance: PlayerStance): string {
  switch (stance) {
    case 'standing':
      return 'Standing';
    case 'sprinting':
      return 'Running';
    case 'crouching':
      return 'Crouching';
    case 'airborne':
      return 'Airborne';
    case 'attacking':
      return 'Attacking';
    case 'throwing':
      return 'Throwing';
    default: {
      const exhaustiveCheck: never = stance;
      return exhaustiveCheck;
    }
  }
}

function formatLootSummary(loot: LootBundle): string {
  const parts: string[] = [];
  if (loot.rations) parts.push(`+${loot.rations} Ration${loot.rations > 1 ? 's' : ''}`);
  if (loot.medkits) parts.push(`+${loot.medkits} Medkit${loot.medkits > 1 ? 's' : ''}`);
  if (loot.warmers) parts.push(`+${loot.warmers} Warmer${loot.warmers > 1 ? 's' : ''}`);
  if (loot.bottles) parts.push(`+${loot.bottles} Bottle${loot.bottles > 1 ? 's' : ''}`);
  if (loot.wood) parts.push(`+${loot.wood} Wood`);
  if (loot.stone) parts.push(`+${loot.stone} Stone`);
  if (loot.scrap) parts.push(`+${loot.scrap} Scrap`);
  return parts.join(' · ');
}

function formatResourceCost(cost: ResourceCost): string {
  const parts: string[] = [];
  if (cost.wood) parts.push(`${cost.wood}W`);
  if (cost.stone) parts.push(`${cost.stone}St`);
  if (cost.scrap) parts.push(`${cost.scrap}Sc`);
  return parts.join(' ');
}

function formatBuildPieceError(
  kind: BuildPieceKind,
  reason?: 'limit' | 'puddle' | 'blocked' | 'overlap' | 'resources' | 'inactive',
): string {
  if (reason === 'resources') {
    const recipe = BUILD_RECIPES[kind];
    return `Need ${formatResourceCost(recipe.cost)} for ${recipe.shortLabel}`;
  }
  if (reason === 'limit') {
    return 'Max 64 Base Pieces Reached';
  }
  if (reason === 'puddle') {
    return 'Cannot Build in Standing Water';
  }
  if (reason === 'overlap') {
    return 'Position Already Occupied';
  }
  return 'Clear Ground Needed to Place';
}

const WORKBENCH_ORDER: readonly CraftItemKind[] = ['ration', 'medkit', 'warmer', 'bottle'];

function formatWorkbenchLabel(kind: CraftItemKind): string {
  const recipe = WORKBENCH_RECIPES[kind];
  const name =
    kind === 'ration'
      ? 'Field Ration'
      : kind === 'medkit'
        ? 'Medkit'
        : kind === 'warmer'
          ? 'Hand Warmer'
          : 'Glass Bottle';
  return `${name} (${formatResourceCost(recipe)})`;
}

function formatCampBuildError(
  kind: 'campfire' | 'shelter',
  reason?: 'limit' | 'puddle' | 'blocked' | 'overlap',
): string {
  if (reason === 'limit') {
    return kind === 'campfire' ? 'Max 3 Campfires Built' : 'Max 2 Shelters Built';
  }
  if (reason === 'puddle') {
    return 'Cannot Build in Standing Water';
  }
  if (reason === 'overlap') {
    return 'Too Close to Another Camp Structure';
  }
  return 'Clear Ground Needed Ahead';
}

function startOvergrownFrontier(): void {
  const canvas = requireElement<HTMLCanvasElement>('viewport');
  const startOverlay = requireElement<HTMLDivElement>('start-overlay');
  const hud = requireElement<HTMLDivElement>('hud');
  const reticle = requireElement<HTMLDivElement>('reticle');
  const damageFlash = requireElement<HTMLDivElement>('damage-flash');
  const webglError = requireElement<HTMLDivElement>('webgl-error');
  const btnExplore = requireElement<HTMLButtonElement>('btn-explore');
  const btnQuality = requireElement<HTMLButtonElement>('btn-quality');
  const btnAudio = requireElement<HTMLButtonElement>('btn-audio');
  const btnResetWorld = requireElement<HTMLButtonElement>('btn-reset-world');
  const hudQuality = requireElement<HTMLButtonElement>('hud-quality');
  const hudAudio = requireElement<HTMLButtonElement>('hud-audio');
  const hudStance = requireElement<HTMLDivElement>('hud-stance');
  const hudStealth = requireElement<HTMLDivElement>('hud-stealth');
  const hudShelter = requireElement<HTMLDivElement>('hud-shelter');
  const hudFire = requireElement<HTMLDivElement>('hud-fire');
  const hudCaches = requireElement<HTMLSpanElement>('hud-caches');
  const hudClock = requireElement<HTMLDivElement>('hud-clock');
  const hudLightLabel = requireElement<HTMLSpanElement>('hud-light-label');

  const barHealth = requireElement<HTMLDivElement>('bar-health');
  const barStamina = requireElement<HTMLDivElement>('bar-stamina');
  const barHunger = requireElement<HTMLDivElement>('bar-hunger');
  const barWarmth = requireElement<HTMLDivElement>('bar-warmth');
  const barLight = requireElement<HTMLDivElement>('bar-light');

  const scavengePrompt = requireElement<HTMLDivElement>('scavenge-prompt');
  const scavengePromptLabel = requireElement<HTMLSpanElement>('scavenge-prompt-label');
  const workbenchBar = requireElement<HTMLDivElement>('workbench-bar');
  const workbenchRecipeLabel = requireElement<HTMLSpanElement>('workbench-recipe-label');
  const buildBar = requireElement<HTMLDivElement>('build-bar');
  const buildSlots: readonly HTMLDivElement[] = [
    requireElement<HTMLDivElement>('build-slot-0'),
    requireElement<HTMLDivElement>('build-slot-1'),
    requireElement<HTMLDivElement>('build-slot-2'),
    requireElement<HTMLDivElement>('build-slot-3'),
    requireElement<HTMLDivElement>('build-slot-4'),
    requireElement<HTMLDivElement>('build-slot-5'),
    requireElement<HTMLDivElement>('build-slot-6'),
  ];
  const lootToast = requireElement<HTMLDivElement>('loot-toast');

  const slotRations = requireElement<HTMLDivElement>('slot-rations');
  const slotMedkits = requireElement<HTMLDivElement>('slot-medkits');
  const slotWarmers = requireElement<HTMLDivElement>('slot-warmers');
  const slotBottles = requireElement<HTMLDivElement>('slot-bottles');
  const slotWood = requireElement<HTMLDivElement>('slot-wood');
  const slotStone = requireElement<HTMLDivElement>('slot-stone');
  const slotScrap = requireElement<HTMLDivElement>('slot-scrap');
  const invRations = requireElement<HTMLSpanElement>('inv-rations');
  const invMedkits = requireElement<HTMLSpanElement>('inv-medkits');
  const invWarmers = requireElement<HTMLSpanElement>('inv-warmers');
  const invBottles = requireElement<HTMLSpanElement>('inv-bottles');
  const invWood = requireElement<HTMLSpanElement>('inv-wood');
  const invStone = requireElement<HTMLSpanElement>('inv-stone');
  const invScrap = requireElement<HTMLSpanElement>('inv-scrap');

  const toolAxeEl = requireElement<HTMLDivElement>('tool-axe');
  const toolPickaxeEl = requireElement<HTMLDivElement>('tool-pickaxe');
  const toolFistsEl = requireElement<HTMLDivElement>('tool-fists');

  const gameoverOverlay = requireElement<HTMLDivElement>('gameover-overlay');
  const gameoverReason = requireElement<HTMLParagraphElement>('gameover-reason');
  const btnRespawn = requireElement<HTMLButtonElement>('btn-respawn');

  let quality: GraphicsQuality = 'high';
  let exploring = false;
  let hasEnteredOnce = false;
  let hasSavedState = false;
  let gameOverShown = false;
  let lastDamageCause: 'raider' | 'exposure' = 'exposure';
  let damageFlashAlpha = 0;
  let toastTimer = 0;
  let autoSaveTimer = 0;
  let equippedTool: EquippedTool = 'axe';
  let workbenchRecipeIdx = 0;

  let engine: EngineContext;
  try {
    engine = createEngine(canvas, quality);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unable to initialize WebGL context.';
    webglError.textContent = `WebGL 3D rendering could not start on this browser or device (${reason}). Please enable hardware acceleration or use a WebGL2-capable browser.`;
    webglError.classList.add('visible');
    btnExplore.disabled = true;
    btnExplore.textContent = 'WebGL Unavailable';
    return;
  }

  const environment = createFrontierEnvironment(quality, engine.sunDirection);
  engine.scene.add(environment.root);

  // Shared live obstacle list so harvested nodes, camp structures & modular bases stay in lockstep
  const worldObstacles: Obstacle[] = environment.obstacles.slice();

  const audio = createFrontierAudio();
  const survival = createSurvivalState();
  const scavenge = createScavengeSystem();
  engine.scene.add(scavenge.root);

  const harvest = createHarvestSystem({
    obstacles: worldObstacles,
    forest: environment.forest,
  });
  engine.scene.add(harvest.root);

  const camp = createCampSystem({
    obstacles: worldObstacles,
    isInsidePuddle: environment.isInsidePuddle,
  });
  engine.scene.add(camp.root);

  const building = createBuildingSystem({
    obstacles: worldObstacles,
    isInsidePuddle: environment.isInsidePuddle,
  });
  engine.scene.add(building.root);

  const getSupportHeight = (x: number, z: number): number => {
    const terrainY = getTerrainHeight(x, z);
    const floorY = building.getFloorHeightAt(x, z);
    return floorY !== null && floorY > terrainY ? floorY : terrainY;
  };

  const wildlife = createWildlifeSystem(worldObstacles);
  engine.scene.add(wildlife.root);

  const rainField = createRainField(quality);
  engine.scene.add(rainField.mesh);

  const flashlight = createFlashlightSystem(engine.scene, quality);

  const atmosphere = createAtmosphereSystem({
    onThunder(intensity): void {
      if (exploring && !survival.vitals.isDead) {
        audio.playThunder(intensity);
        wildlife.onDisturbance(player.position.x, player.position.z, 34);
      }
    },
  });

  function showToast(message: string): void {
    lootToast.textContent = message;
    lootToast.classList.add('visible');
    toastTimer = 2.6;
  }

  const threats = createThreatSystem({
    obstacles: worldObstacles,
    getSupportHeight,
    onPlayerHit(damage): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      lastDamageCause = 'raider';
      survival.applyDamage(damage);
      audio.playPlayerHurt();
      player.triggerHitShake(0.85);
      damageFlashAlpha = 0.92;
    },
    onBottleShatter(x, z): void {
      audio.playGlassShatter();
      wildlife.onDisturbance(x, z, 22);
    },
    onAlertSting(level): void {
      if (exploring && !survival.vitals.isDead) {
        audio.playAlertSting(level);
      }
    },
    onStalkerSound(kind): void {
      if (exploring && !survival.vitals.isDead) {
        audio.playStalkerSound(kind);
      }
    },
    onSpikeHit(_x, _z, downed, isMonster, loot): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      audio.playSpikeHit();
      if (downed && loot) {
        survival.addLoot(loot);
        const targetName = isMonster ? 'Hollow Stalker' : 'Raider';
        showToast(`Spikes Downed ${targetName} · ${formatLootSummary(loot)}`);
        persistWorld();
      }
    },
  });
  engine.scene.add(threats.root);

  function persistWorld(showFeedback = false): void {
    const built = building.serialize();
    const saveData: WorldSaveData = {
      version: 1,
      savedAt: Date.now(),
      player: {
        x: player.position.x,
        z: player.position.z,
        yaw: player.getCameraYaw(),
      },
      timeHours: atmosphere.snapshot.timeHours,
      survival: survival.serialize(),
      builtPieces: built.pieces,
      storageStash: built.stash,
      camp: camp.serialize(),
      lootedCacheIds: scavenge.serializeLootedIds(),
      depletedHarvestIds: harvest.serializeDepletedIds(),
    };
    if (saveWorldToStorage(saveData)) {
      hasSavedState = true;
      btnResetWorld.style.display = 'inline-block';
      if (showFeedback) {
        showToast('World Saved');
      }
    }
  }

  function syncBuildBarUi(): void {
    const showBuild = building.isActive() && exploring && !survival.vitals.isDead;
    buildBar.classList.toggle('visible', showBuild);
    document.body.classList.toggle('build-mode-active', showBuild);
    const selected = building.getSelectedKind();
    for (let i = 0; i < BUILD_PIECE_ORDER.length; i += 1) {
      const kind = BUILD_PIECE_ORDER[i];
      const slotEl = buildSlots[i];
      if (!kind || !slotEl) {
        continue;
      }
      const affordable = survival.hasResources(BUILD_RECIPES[kind].cost);
      slotEl.classList.toggle('selected', kind === selected);
      slotEl.classList.toggle('unaffordable', !affordable);
    }
  }

  function selectTool(nextTool: EquippedTool, announce = false): void {
    equippedTool = nextTool;
    player.setEquippedTool(nextTool);
    toolAxeEl.classList.toggle('active', nextTool === 'axe');
    toolPickaxeEl.classList.toggle('active', nextTool === 'pickaxe');
    toolFistsEl.classList.toggle('active', nextTool === 'fists');
    if (announce) {
      const label =
        nextTool === 'axe'
          ? 'Felling Axe Equipped'
          : nextTool === 'pickaxe'
            ? 'Survival Pickaxe Equipped'
            : 'Bare Fists Equipped';
      showToast(label);
    }
  }

  function syncOverlayUi(): void {
    const qualityLabel = quality === 'high' ? 'High' : 'Medium';
    btnQuality.textContent = `Graphics: ${qualityLabel}`;
    hudQuality.textContent = qualityLabel;

    const audioLabel = audio.isMuted() ? 'Muted' : 'On';
    btnAudio.textContent = `Audio: ${audioLabel}`;
    hudAudio.textContent = audio.isMuted() ? 'Muted' : 'Audio On';
  }

  function enterExploration(): void {
    if (survival.vitals.isDead) {
      return;
    }
    audio.unlock();
    exploring = true;
    hasEnteredOnce = true;
    startOverlay.classList.add('hidden');
    gameoverOverlay.classList.remove('visible');
    hud.classList.add('active');
    btnExplore.textContent = 'Resume Exploring';
    player.setInputEnabled(true);
    player.requestPointerLock();
    syncOverlayUi();
    syncBuildBarUi();
  }

  function pauseToOverlay(): void {
    if (survival.vitals.isDead) {
      return;
    }
    exploring = false;
    building.setActive(false);
    startOverlay.classList.remove('hidden');
    hud.classList.remove('active');
    reticle.classList.remove('visible');
    buildBar.classList.remove('visible');
    workbenchBar.classList.remove('visible');
    document.body.classList.remove('build-mode-active');
    player.setInputEnabled(false);
    if (hasEnteredOnce) {
      btnExplore.textContent = 'Resume Exploring';
    } else if (hasSavedState) {
      btnExplore.textContent = 'Continue Saved World';
    }
  }

  function showGameOver(): void {
    gameOverShown = true;
    exploring = false;
    building.setActive(false);
    player.setInputEnabled(false);
    reticle.classList.remove('visible');
    scavengePrompt.classList.remove('visible');
    buildBar.classList.remove('visible');
    workbenchBar.classList.remove('visible');
    document.body.classList.remove('build-mode-active');

    if (document.pointerLockElement === canvas) {
      try {
        document.exitPointerLock();
      } catch {
        // Ignore exitPointerLock error cleanly
      }
    }

    if (lastDamageCause === 'raider') {
      gameoverReason.textContent = 'Overwhelmed by hostile threats on Old Route 9.';
    } else if (survival.vitals.warmth <= 0) {
      gameoverReason.textContent = 'Succumbed to hypothermia in the damp mountain night.';
    } else {
      gameoverReason.textContent = 'Collapsed from starvation along Highway 9.';
    }
    const hasCampRespawn = camp.getCampRespawnPoint(scratchCampSpawn);
    btnRespawn.textContent = hasCampRespawn ? 'Respawn at Camp (R)' : 'Respawn (R)';
    gameoverOverlay.classList.add('visible');
  }

  function respawn(): void {
    gameOverShown = false;
    lastDamageCause = 'exposure';
    damageFlashAlpha = 0;
    prevFlashBucket = 0;
    damageFlash.style.opacity = '0';

    const hasCampRespawn = camp.getCampRespawnPoint(scratchCampSpawn);
    flashlight.reset();
    prevSyncedLightOn = false;
    player.setFlashlightActive(false);
    threats.reset();

    if (hasCampRespawn) {
      survival.reviveAtCamp();
      player.resetToSpawn(scratchCampSpawn.x, scratchCampSpawn.z);
      camp.sampleProximity(player.position.x, player.position.z, scratchCampProx);
      rainField.update(
        elapsed,
        player.position.x,
        player.position.y,
        player.position.z,
        atmosphere.snapshot.rainIntensity,
        atmosphere.snapshot.windBoost,
        atmosphere.snapshot.fogColor,
      );
      gameoverOverlay.classList.remove('visible');
      persistWorld();
      showToast('Woke at Camp Lean-To Shelter');
      enterExploration();
      return;
    }

    clearWorldSave();
    hasSavedState = false;
    btnResetWorld.style.display = 'none';
    building.reset();
    camp.reset();
    harvest.reset();
    atmosphere.reset();
    wildlife.reset();
    survival.reset();
    scavenge.reset();
    player.resetToSpawn();
    camp.sampleProximity(player.position.x, player.position.z, scratchCampProx);
    rainField.update(
      0,
      player.position.x,
      player.position.y,
      player.position.z,
      0,
      1,
      atmosphere.snapshot.fogColor,
    );
    gameoverOverlay.classList.remove('visible');
    showToast('Respawned on Cedar Ridge Overlook');
    enterExploration();
  }

  function resetSavedWorldFromMenu(): void {
    clearWorldSave();
    hasSavedState = false;
    hasEnteredOnce = false;
    autoSaveTimer = 0;
    workbenchRecipeIdx = 0;
    prevWorkbenchRecipeKey = '';
    workbenchRecipeLabel.textContent = formatWorkbenchLabel(WORKBENCH_ORDER[0] ?? 'ration');
    btnResetWorld.style.display = 'none';
    btnExplore.textContent = 'Click to Explore';
    building.reset();
    camp.reset();
    harvest.reset();
    scavenge.reset();
    survival.reset();
    threats.reset();
    wildlife.reset();
    atmosphere.reset();
    flashlight.reset();
    prevSyncedLightOn = false;
    player.setFlashlightActive(false);
    selectTool('axe', false);
    player.resetToSpawn();
    camp.sampleProximity(player.position.x, player.position.z, scratchCampProx);
    syncSurvivalHud(FIXED_STEP);
    syncBuildBarUi();
    document.body.classList.remove('build-mode-active');
    showToast('World Reset · Fresh Frontier');
  }

  // Pre-allocated scratch structs (ZERO per-frame heap allocations!)
  const scratchRuinSample = { proximity: 0, sourceX: 0, sourceZ: 0 };
  const scratchSpatialAudio = {
    windIntensity: 0.5,
    ruinProximity: 0,
    ruinPan: 0,
    rainIntensity: 0,
    nightFactor: 0,
    isSheltered: false,
    fireProximity: 0,
    firePan: 0,
  };
  const scratchForward2D: Vec2Like = { x: 0, z: -1 };
  const scratchFlashOrigin = new THREE.Vector3();
  const scratchFlashDir = new THREE.Vector3(0, 0, -1);
  const scratchAimOrigin = new THREE.Vector3();
  const scratchAimDir = new THREE.Vector3(0, 0, -1);
  const scratchCampProx: CampProximityInfo = {
    nearFire: false,
    inCampShelter: false,
    fireProximity: 0,
    fireX: 0,
    fireZ: 0,
    canCookAtFire: false,
  };
  const scratchCampSpawn: Vec2Like = { x: 0, z: 0 };
  const scratchStealthResult: StealthResult = {
    visibility: 1,
    noiseRadius: 0,
    isConcealed: false,
  };
  const scratchStealthInput = {
    x: 0,
    z: 0,
    isCrouching: false,
    isMoving: false,
    isSprinting: false,
    roadFactor: 1,
    inPuddle: false,
    nightFactor: 0,
    rainIntensity: 0,
    flashlightOn: false,
  };
  const scratchSurvivalInput = {
    isSprinting: false,
    isMoving: false,
    isInPuddle: false,
    isSheltered: false,
    isNearFire: false,
    rainIntensity: 0,
    nightFactor: 0,
  };
  const scratchThreatInput = {
    playerX: 0,
    playerY: 0,
    playerZ: 0,
    playerVisibility: 1,
    playerNoiseRadius: 0,
    playerDead: false,
    nightFactor: 0,
    rainIntensity: 0,
    flashlightOn: false,
    getFlashlightExposure: flashlight.getBeamExposure,
    getFireRepel: camp.getCampfireRepelPoint,
    checkSpikeHit: building.checkSpikeHit,
  };

  let prevSyncedLightOn = false;

  const player = createPlayerController({
    camera: engine.camera,
    scene: engine.scene,
    canvas,
    obstacles: worldObstacles,
    isInsidePuddle: (x, z) => environment.isInsidePuddle(x, z) && building.getFloorHeightAt(x, z) === null,
    getSupportHeight,
    isBuildMode(): boolean {
      return building.isActive();
    },
    canSprint(): boolean {
      return survival.canSprint();
    },
    canJump(): boolean {
      return survival.canJump();
    },
    canAttack(): boolean {
      return survival.canAttack();
    },
    canThrowBottle(): boolean {
      return exploring && !survival.vitals.isDead && survival.inventory.bottles > 0;
    },
    onFootstep(surface, intensity): void {
      audio.playFootstep(surface, intensity);
    },
    onJump(): void {
      survival.consumeJumpStamina();
      audio.playJump();
    },
    onLand(surface): void {
      audio.playLand(surface);
      threats.emitNoise(player.position.x, player.position.z, surface === 'puddle' ? 14 : 9);
    },
    onAttackStart(): void {
      survival.consumeAttackStamina();
    },
    onAttack(): void {
      audio.playAttackWhoosh();
    },
    onAttackHitWindow(x, z, fwdX, fwdZ): void {
      const hitResult = threats.tryPlayerMeleeHit(x, z, fwdX, fwdZ, player.isCrouching());
      if (!hitResult.stealthTakedown) {
        threats.emitNoise(player.position.x, player.position.z, 7.5);
      }
      if (hitResult.hit) {
        audio.playMeleeHit(hitResult.stealthTakedown || hitResult.downed);
        player.triggerHitShake(hitResult.stealthTakedown ? 0.45 : 0.28);

        if (hitResult.lootDropped) {
          survival.addLoot(hitResult.lootDropped);
          const prefix = hitResult.isMonster
            ? 'Hollow Stalker Defeated'
            : hitResult.stealthTakedown
              ? 'Stealth Takedown'
              : 'Raider Downed';
          showToast(`${prefix} · ${formatLootSummary(hitResult.lootDropped)}`);
          persistWorld();
        } else if (hitResult.isMonster && hitResult.stealthTakedown) {
          showToast('Ambush Strike · Hollow Stalker Wounded');
        }
        return;
      }

      // If no enemy was struck, attempt physical timber/stone harvesting with equipped tool
      const harvestHit = harvest.tryHarvestHit(x, z, fwdX, fwdZ, equippedTool);
      if (!harvestHit.hit) {
        return;
      }
      if (harvestHit.wrongTool) {
        showToast(
          harvestHit.neededTool === 'axe'
            ? 'Equip Axe [4] to Chop Timber'
            : 'Equip Pickaxe [5] to Mine Stone',
        );
        return;
      }
      if (harvestHit.kind === 'tree') {
        audio.playWoodChop(harvestHit.depleted);
      } else {
        audio.playRockMine(harvestHit.depleted);
      }
      player.triggerHitShake(harvestHit.depleted ? 0.34 : 0.18);
      if (harvestHit.loot) {
        survival.addLoot(harvestHit.loot);
        const label = harvestHit.depleted
          ? harvestHit.kind === 'tree'
            ? 'Timber Felled'
            : 'Stone Shattered'
          : harvestHit.kind === 'tree'
            ? 'Timber Chopped'
            : 'Stone Mined';
        showToast(`${label} · ${formatLootSummary(harvestHit.loot)}`);
      }
      if (harvestHit.depleted) {
        persistWorld();
      }
    },
    onInteract(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      player.getForwardXZ(scratchForward2D);
      const target = scavenge.getPromptTarget(
        player.position.x,
        player.position.z,
        scratchForward2D.x,
        scratchForward2D.z,
      );
      if (target) {
        const res = scavenge.scavengeTarget(target.id);
        if (!res) {
          return;
        }
        survival.addLoot(res.loot);
        audio.playScavenge();
        showToast(`${res.label} · ${formatLootSummary(res.loot)}`);
        persistWorld();
        return;
      }

      const buildTarget = building.getInteractTarget(
        player.position.x,
        player.position.z,
        scratchForward2D.x,
        scratchForward2D.z,
      );
      if (buildTarget) {
        if (buildTarget.kind === 'door') {
          const isOpen = building.toggleDoor(buildTarget.id);
          if (isOpen !== null) {
            audio.playDoorToggle(isOpen);
            showToast(isOpen ? 'Door Opened' : 'Door Closed');
            persistWorld();
          }
          return;
        }
        if (buildTarget.kind === 'workbench') {
          const recipeKind = WORKBENCH_ORDER[workbenchRecipeIdx] ?? 'ration';
          if (survival.craftItem(recipeKind)) {
            audio.playItemUse();
            showToast(`Crafted ${formatWorkbenchLabel(recipeKind)}`);
            persistWorld();
          } else {
            showToast(`Need ${formatResourceCost(WORKBENCH_RECIPES[recipeKind])}`);
          }
          return;
        }
        const transfer = building.depositOrWithdrawStorage(survival);
        if (transfer.action !== 'empty') {
          audio.playScavenge();
          persistWorld();
        }
        showToast(transfer.summary);
        return;
      }

      camp.sampleProximity(player.position.x, player.position.z, scratchCampProx);
      if (!scratchCampProx.canCookAtFire) {
        return;
      }
      if (survival.craftFieldRation()) {
        audio.playItemUse();
        showToast('Cooked Warm Ration · +1 Ration');
        persistWorld();
      } else {
        showToast('Need 1 Scrap to Cook Ration');
      }
    },
    onThrowEmpty(): void {
      if (exploring && !survival.vitals.isDead) {
        showToast('No Bottles · Scavenge Packs & Wrecks');
      }
    },
    onThrowRelease(ox, oy, oz, ax, ay, az): void {
      if (!exploring || survival.vitals.isDead || !survival.consumeBottle()) {
        return;
      }
      threats.throwBottle(ox, oy, oz, ax, ay, az);
      audio.playBottleThrow();
    },
    onQuickUse(slot): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      if (slot === 1) {
        if (survival.useRation()) {
          audio.playItemUse();
          showToast('Ate Field Ration · +Hunger · +HP');
        } else {
          showToast('No Rations');
        }
      } else if (slot === 2) {
        if (survival.useMedkit()) {
          audio.playItemUse();
          showToast('Applied Medkit · +45 HP');
        } else {
          showToast('No Medkits');
        }
      } else {
        if (survival.useWarmer()) {
          audio.playItemUse();
          showToast('Activated Hand Warmer · +Warmth · +Stamina');
        } else {
          showToast('No Hand Warmers');
        }
      }
    },
    onToggleFlashlight(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      const wasOn = flashlight.isOn();
      const nowOn = flashlight.toggle();
      prevSyncedLightOn = nowOn;
      player.setFlashlightActive(nowOn);
      if (nowOn !== wasOn) {
        audio.playFlashlightClick(nowOn);
      } else if (!nowOn) {
        showToast('Flashlight Recharging');
      }
    },
    onAdvanceTime(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      atmosphere.advancePhase();
      showToast(`${atmosphere.getFormattedClock()} · ${atmosphere.getPhaseLabel()}`);
    },
    onToggleStorm(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      const nextWeather = atmosphere.toggleStorm();
      showToast(nextWeather === 'storm' ? 'Pacific Storm Rolling In' : 'Storm Clearing');
    },
    onBuildCampfire(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      if (survival.inventory.scrap < CAMPFIRE_SCRAP_COST) {
        showToast(`Need ${CAMPFIRE_SCRAP_COST} Scrap for Campfire`);
        return;
      }
      player.getForwardXZ(scratchForward2D);
      const res = camp.tryBuildCampfire(
        player.position.x,
        player.position.z,
        scratchForward2D.x,
        scratchForward2D.z,
      );
      if (!res.ok) {
        showToast(formatCampBuildError('campfire', res.reason));
        return;
      }
      survival.spendScrap(CAMPFIRE_SCRAP_COST);
      audio.playBuildCamp('campfire');
      showToast('Campfire Built · Warmth & Stalker Repellent');
      persistWorld();
    },
    onBuildShelter(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      if (survival.inventory.scrap < SHELTER_SCRAP_COST) {
        showToast(`Need ${SHELTER_SCRAP_COST} Scrap for Shelter`);
        return;
      }
      player.getForwardXZ(scratchForward2D);
      const res = camp.tryBuildShelter(
        player.position.x,
        player.position.z,
        scratchForward2D.x,
        scratchForward2D.z,
      );
      if (!res.ok) {
        showToast(formatCampBuildError('shelter', res.reason));
        return;
      }
      survival.spendScrap(SHELTER_SCRAP_COST);
      audio.playBuildCamp('shelter');
      showToast('Lean-To Shelter Built · Camp Respawn Set');
      persistWorld();
    },
    onToggleBuildMode(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      const nextActive = !building.isActive();
      building.setActive(nextActive);
      audio.playFlashlightClick(nextActive);
      syncBuildBarUi();
      showToast(
        nextActive
          ? 'Build Mode · [Click] Place · [R] Rotate · [X] Dismantle'
          : 'Exited Build Mode',
      );
    },
    onBuildPrimary(): void {
      if (!exploring || survival.vitals.isDead || !building.isActive()) {
        return;
      }
      const res = building.tryPlaceCurrent(survival.hasResources);
      if (!res.ok) {
        showToast(formatBuildPieceError(res.kind, res.reason));
        return;
      }
      survival.spendResources(res.cost);
      audio.playBuildPiece();
      syncBuildBarUi();
      persistWorld();
      showToast(`Built ${BUILD_RECIPES[res.kind].label}`);
    },
    onBuildRotate(): void {
      if (!exploring || survival.vitals.isDead || !building.isActive()) {
        return;
      }
      building.rotateGhost();
      audio.playFlashlightClick(true);
    },
    onBuildDismantle(): void {
      if (!exploring || survival.vitals.isDead || !building.isActive()) {
        return;
      }
      player.getCameraRay(scratchAimOrigin, scratchAimDir);
      const res = building.tryDismantleLookedAt(
        scratchAimOrigin.x,
        scratchAimOrigin.y,
        scratchAimOrigin.z,
        scratchAimDir.x,
        scratchAimDir.y,
        scratchAimDir.z,
      );
      if (!res.ok) {
        showToast('Aim at a Built Piece to Dismantle');
        return;
      }
      if (res.refund) {
        survival.addLoot(res.refund);
      }
      audio.playDismantle();
      syncBuildBarUi();
      persistWorld();
      const summary = res.refund ? ` · ${formatLootSummary(res.refund)}` : '';
      showToast(`Dismantled ${res.label ?? 'Structure'}${summary}`);
    },
    onBuildSelectIndex(index): void {
      if (!exploring || survival.vitals.isDead || !building.isActive()) {
        return;
      }
      const kind = BUILD_PIECE_ORDER[index];
      if (!kind) {
        return;
      }
      building.setSelectedKind(kind);
      syncBuildBarUi();
    },
    onBuildCycle(delta): void {
      if (!exploring || survival.vitals.isDead || !building.isActive()) {
        return;
      }
      building.cycleSelectedKind(delta);
      syncBuildBarUi();
    },
    onSelectTool(tool): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      selectTool(tool, true);
    },
    onCycleWorkbenchRecipe(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      workbenchRecipeIdx = (workbenchRecipeIdx + 1) % WORKBENCH_ORDER.length;
      const recipeKind = WORKBENCH_ORDER[workbenchRecipeIdx] ?? 'ration';
      workbenchRecipeLabel.textContent = formatWorkbenchLabel(recipeKind);
      showToast(`Workbench Recipe · ${formatWorkbenchLabel(recipeKind)}`);
    },
    onQuickSave(): void {
      if (!exploring || survival.vitals.isDead) {
        return;
      }
      persistWorld(true);
    },
    onStanceChange(stance): void {
      hudStance.textContent = formatStanceLabel(stance);
    },
    onPointerLockChange(locked): void {
      if (locked) {
        reticle.classList.add('visible');
      } else {
        reticle.classList.remove('visible');
        if (exploring && !survival.vitals.isDead) {
          pauseToOverlay();
        }
      }
    },
  });

  function toggleQuality(): void {
    quality = quality === 'high' ? 'medium' : 'high';
    engine.setQuality(quality);
    environment.setQuality(quality);
    rainField.setQuality(quality);
    flashlight.setQuality(quality);
    syncOverlayUi();
  }

  function toggleAudio(): void {
    audio.toggleMute();
    syncOverlayUi();
  }

  btnExplore.addEventListener('click', () => {
    enterExploration();
  });

  btnRespawn.addEventListener('click', () => {
    respawn();
  });

  btnQuality.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleQuality();
  });

  hudQuality.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleQuality();
  });

  btnAudio.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAudio();
  });

  btnResetWorld.addEventListener('click', (event) => {
    event.stopPropagation();
    resetSavedWorldFromMenu();
  });

  hudAudio.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAudio();
  });

  canvas.addEventListener('click', () => {
    if (exploring && !survival.vitals.isDead && !player.isPointerLocked()) {
      audio.unlock();
      player.requestPointerLock();
    }
  });

  const handleGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      return;
    }
    if (event.code === 'KeyM') {
      toggleAudio();
    } else if (event.code === 'KeyR' && survival.vitals.isDead) {
      respawn();
    } else if (event.code === 'Escape' && exploring && !player.isPointerLocked()) {
      pauseToOverlay();
    }
  };
  window.addEventListener('keydown', handleGlobalKeyDown);

  const handleResize = (): void => {
    engine.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', handleResize);

  syncOverlayUi();

  // Cached DOM state so HUD only writes when rounded values actually change (zero DOM thrash!)
  let prevHp = -1;
  let prevStamina = -1;
  let prevHunger = -1;
  let prevWarmth = -1;
  let prevExhausted = false;
  let prevCold = false;
  let prevSheltered = false;
  let prevNearFire = false;
  let prevStealthKey = '';
  let prevPromptId = '';
  let prevLooted = -1;
  let prevRations = -1;
  let prevMedkits = -1;
  let prevWarmers = -1;
  let prevBottles = -1;
  let prevWood = -1;
  let prevStone = -1;
  let prevScrap = -1;
  let prevWorkbenchOpen = false;
  let prevWorkbenchRecipeKey = '';
  let prevFlashBucket = -1;
  let prevClockMinute = -1;
  let prevClockPhase = '';
  let prevClockWeather = '';
  let prevLightPct = -1;
  let prevLightOn = false;
  let prevLightLow = false;

  function syncSurvivalHud(dt: number): void {
    const v = survival.vitals;
    const inv = survival.inventory;

    const hpPct = Math.round(v.health);
    if (hpPct !== prevHp) {
      prevHp = hpPct;
      barHealth.style.width = `${hpPct}%`;
    }

    const staPct = Math.round(v.stamina);
    if (staPct !== prevStamina) {
      prevStamina = staPct;
      barStamina.style.width = `${staPct}%`;
    }
    if (v.exhausted !== prevExhausted) {
      prevExhausted = v.exhausted;
      barStamina.classList.toggle('exhausted', v.exhausted);
    }

    const hngPct = Math.round(v.hunger);
    if (hngPct !== prevHunger) {
      prevHunger = hngPct;
      barHunger.style.width = `${hngPct}%`;
    }

    const wrmPct = Math.round(v.warmth);
    if (wrmPct !== prevWarmth) {
      prevWarmth = wrmPct;
      barWarmth.style.width = `${wrmPct}%`;
    }
    const isCold = v.warmth < 35;
    if (isCold !== prevCold) {
      prevCold = isCold;
      barWarmth.classList.toggle('cold', isCold);
    }

    if (v.sheltered !== prevSheltered) {
      prevSheltered = v.sheltered;
      hudShelter.classList.toggle('visible', v.sheltered);
    }

    if (scratchCampProx.nearFire !== prevNearFire) {
      prevNearFire = scratchCampProx.nearFire;
      hudFire.classList.toggle('visible', scratchCampProx.nearFire);
    }

    const alertState = threats.getAlertState();
    let stealthKey: string;
    if (alertState === 'alert') {
      stealthKey = 'detected';
    } else if (alertState === 'suspicious') {
      stealthKey = 'cautious';
    } else if (scratchStealthResult.isConcealed) {
      stealthKey = 'hidden';
    } else {
      stealthKey = 'exposed';
    }
    if (stealthKey !== prevStealthKey) {
      prevStealthKey = stealthKey;
      hudStealth.classList.remove('hidden-state', 'cautious-state', 'detected-state');
      if (stealthKey === 'detected') {
        hudStealth.textContent = 'Detected';
        hudStealth.classList.add('detected-state');
      } else if (stealthKey === 'cautious') {
        hudStealth.textContent = 'Cautious';
        hudStealth.classList.add('cautious-state');
      } else if (stealthKey === 'hidden') {
        hudStealth.textContent = 'Hidden';
        hudStealth.classList.add('hidden-state');
      } else {
        hudStealth.textContent = 'Exposed';
      }
    }

    if (inv.rations !== prevRations) {
      prevRations = inv.rations;
      invRations.textContent = String(inv.rations);
      slotRations.classList.toggle('empty', inv.rations <= 0);
    }
    if (inv.medkits !== prevMedkits) {
      prevMedkits = inv.medkits;
      invMedkits.textContent = String(inv.medkits);
      slotMedkits.classList.toggle('empty', inv.medkits <= 0);
    }
    if (inv.warmers !== prevWarmers) {
      prevWarmers = inv.warmers;
      invWarmers.textContent = String(inv.warmers);
      slotWarmers.classList.toggle('empty', inv.warmers <= 0);
    }
    if (inv.bottles !== prevBottles) {
      prevBottles = inv.bottles;
      invBottles.textContent = String(inv.bottles);
      slotBottles.classList.toggle('empty', inv.bottles <= 0);
    }
    let buildResourcesChanged = false;
    if (inv.wood !== prevWood) {
      prevWood = inv.wood;
      invWood.textContent = String(inv.wood);
      slotWood.classList.toggle('empty', inv.wood <= 0);
      buildResourcesChanged = true;
    }
    if (inv.stone !== prevStone) {
      prevStone = inv.stone;
      invStone.textContent = String(inv.stone);
      slotStone.classList.toggle('empty', inv.stone <= 0);
      buildResourcesChanged = true;
    }
    if (inv.scrap !== prevScrap) {
      prevScrap = inv.scrap;
      invScrap.textContent = String(inv.scrap);
      slotScrap.classList.toggle('empty', inv.scrap <= 0);
      buildResourcesChanged = true;
    }
    if (buildResourcesChanged && building.isActive()) {
      syncBuildBarUi();
    }

    const stats = scavenge.getStats();
    if (stats.looted !== prevLooted) {
      prevLooted = stats.looted;
      hudCaches.textContent = `${stats.looted}/${stats.total}`;
    }

    const snap = atmosphere.snapshot;
    const clockMinute = Math.floor(snap.timeHours * 60) % (24 * 60);
    if (
      clockMinute !== prevClockMinute ||
      snap.phase !== prevClockPhase ||
      snap.weather !== prevClockWeather
    ) {
      prevClockMinute = clockMinute;
      prevClockPhase = snap.phase;
      prevClockWeather = snap.weather;
      hudClock.textContent = `${atmosphere.getFormattedClock()} · ${atmosphere.getPhaseLabel()} · ${atmosphere.getWeatherLabel()}`;
    }

    const lightPct = Math.round(flashlight.getBattery());
    const lightOn = flashlight.isOn();
    const lightLow = lightPct < 15;
    if (lightPct !== prevLightPct) {
      prevLightPct = lightPct;
      barLight.style.width = `${lightPct}%`;
    }
    if (lightOn !== prevLightOn) {
      prevLightOn = lightOn;
      barLight.classList.toggle('active', lightOn);
      hudLightLabel.classList.toggle('active', lightOn);
    }
    if (lightLow !== prevLightLow) {
      prevLightLow = lightLow;
      barLight.classList.toggle('low', lightLow);
    }

    // Contextual [E] scavenge / door / workbench / storage / campfire cooking prompt
    player.getForwardXZ(scratchForward2D);
    const promptTarget =
      exploring && !v.isDead
        ? scavenge.getPromptTarget(
            player.position.x,
            player.position.z,
            scratchForward2D.x,
            scratchForward2D.z,
          )
        : null;
    const buildInteractTarget =
      !promptTarget && exploring && !v.isDead
        ? building.getInteractTarget(
            player.position.x,
            player.position.z,
            scratchForward2D.x,
            scratchForward2D.z,
          )
        : null;
    const showWorkbenchStrip = buildInteractTarget?.kind === 'workbench';
    const activeWorkbenchRecipe = WORKBENCH_ORDER[workbenchRecipeIdx] ?? 'ration';
    if (showWorkbenchStrip !== prevWorkbenchOpen) {
      prevWorkbenchOpen = showWorkbenchStrip;
      workbenchBar.classList.toggle('visible', showWorkbenchStrip);
    }
    if (showWorkbenchStrip && activeWorkbenchRecipe !== prevWorkbenchRecipeKey) {
      prevWorkbenchRecipeKey = activeWorkbenchRecipe;
      workbenchRecipeLabel.textContent = formatWorkbenchLabel(activeWorkbenchRecipe);
    }

    let nextPromptId = '';
    if (promptTarget) {
      nextPromptId = promptTarget.id;
    } else if (buildInteractTarget) {
      nextPromptId =
        buildInteractTarget.kind === 'door'
          ? `${buildInteractTarget.id}_${buildInteractTarget.doorOpen ? 'open' : 'closed'}`
          : buildInteractTarget.kind === 'workbench'
            ? `wb_${activeWorkbenchRecipe}`
            : buildInteractTarget.id;
    } else if (exploring && !v.isDead && scratchCampProx.canCookAtFire) {
      nextPromptId = inv.scrap >= 1 ? 'camp_cook_ready' : 'camp_cook_empty';
    }
    if (nextPromptId !== prevPromptId) {
      prevPromptId = nextPromptId;
      if (promptTarget) {
        scavengePromptLabel.textContent = `Search ${promptTarget.label}`;
        scavengePrompt.classList.add('visible');
      } else if (buildInteractTarget) {
        scavengePromptLabel.textContent =
          buildInteractTarget.kind === 'workbench'
            ? `Craft ${formatWorkbenchLabel(activeWorkbenchRecipe)}`
            : buildInteractTarget.label;
        scavengePrompt.classList.add('visible');
      } else if (nextPromptId === 'camp_cook_ready') {
        scavengePromptLabel.textContent = 'Cook Warm Ration (1 Scrap)';
        scavengePrompt.classList.add('visible');
      } else if (nextPromptId === 'camp_cook_empty') {
        scavengePromptLabel.textContent = 'Campfire · Need 1 Scrap to Cook';
        scavengePrompt.classList.add('visible');
      } else {
        scavengePrompt.classList.remove('visible');
      }
    }

    // Toast fade countdown
    if (toastTimer > 0) {
      toastTimer = Math.max(0, toastTimer - dt);
      if (toastTimer <= 0) {
        lootToast.classList.remove('visible');
      }
    }

    // Red damage vignette + low-HP edge warning
    if (damageFlashAlpha > 0) {
      damageFlashAlpha = Math.max(0, damageFlashAlpha - dt * 2.1);
    }
    const lowHpPulse = v.health < 30 && !v.isDead ? ((30 - v.health) / 30) * 0.42 : 0;
    const displayFlash = Math.min(1, Math.max(damageFlashAlpha, lowHpPulse));
    const flashBucket = Math.round(displayFlash * 25);
    if (flashBucket !== prevFlashBucket) {
      prevFlashBucket = flashBucket;
      damageFlash.style.opacity = (flashBucket / 25).toFixed(2);
    }

    if (v.isDead && !gameOverShown) {
      showGameOver();
    }
  }

  const FIXED_STEP = 1 / 60;
  let accumulator = 0;
  let elapsed = 0;
  let lastTimestamp = performance.now();
  let rafId = 0;

  const frame = (now: number): void => {
    rafId = window.requestAnimationFrame(frame);

    const rawDt = (now - lastTimestamp) * 0.001;
    lastTimestamp = now;
    const clampedDt = Math.min(Math.max(rawDt, 0), 0.05);

    accumulator += clampedDt;
    let substeps = 0;
    while (accumulator >= FIXED_STEP && substeps < 4) {
      elapsed += FIXED_STEP;
      const atmo =
        exploring && !survival.vitals.isDead
          ? atmosphere.update(FIXED_STEP)
          : atmosphere.snapshot;

      player.update(FIXED_STEP, elapsed);
      environment.update(elapsed, FIXED_STEP, atmo);
      harvest.update(FIXED_STEP);
      camp.update(FIXED_STEP, elapsed);
      building.update(FIXED_STEP);

      const px = player.position.x;
      const py = player.position.y;
      const pz = player.position.z;
      camp.sampleProximity(px, pz, scratchCampProx);
      const inPuddle = environment.isInsidePuddle(px, pz) && building.getFloorHeightAt(px, pz) === null;
      const sheltered =
        isInsideShelter(px, pz) ||
        scratchCampProx.inCampShelter ||
        building.isInsideBuiltShelter(px, pz);
      const roadFactor = getRoadFactor(px, pz);
      const isMoving = player.isMoving();
      const isSprinting = player.isSprinting();
      const isCrouching = player.isCrouching();

      if (building.isActive() && exploring && !survival.vitals.isDead) {
        player.getCameraAimDir(scratchAimDir);
        const activeRecipe = BUILD_RECIPES[building.getSelectedKind()];
        building.updateGhost(
          px,
          py,
          pz,
          scratchAimDir.x,
          scratchAimDir.y,
          scratchAimDir.z,
          survival.hasResources(activeRecipe.cost),
        );
      }

      if (exploring && !survival.vitals.isDead) {
        autoSaveTimer += FIXED_STEP;
        if (autoSaveTimer >= 20) {
          autoSaveTimer = 0;
          persistWorld();
        }
      }

      const camYaw = player.getCameraYaw();
      const rightX = Math.cos(camYaw);
      const rightZ = -Math.sin(camYaw);

      // Physical chest-strap tactical flashlight emits directly from the mounted lens
      player.getFlashlightTransform(scratchFlashOrigin, scratchFlashDir);
      const fogBoost =
        atmo.nightFactor * 0.85 +
        atmo.rainIntensity * 0.45 +
        Math.max(0, atmo.cloudCover - 0.25) * 0.2;
      const flashlightDt = exploring && !survival.vitals.isDead ? FIXED_STEP : 0;
      flashlight.update(
        flashlightDt,
        elapsed,
        scratchFlashOrigin.x,
        scratchFlashOrigin.y,
        scratchFlashOrigin.z,
        scratchFlashDir.x,
        scratchFlashDir.y,
        scratchFlashDir.z,
        fogBoost,
      );
      const lightOn = flashlight.isOn();
      if (lightOn !== prevSyncedLightOn) {
        prevSyncedLightOn = lightOn;
        player.setFlashlightActive(lightOn);
      }

      scratchStealthInput.x = px;
      scratchStealthInput.z = pz;
      scratchStealthInput.isCrouching = isCrouching;
      scratchStealthInput.isMoving = isMoving;
      scratchStealthInput.isSprinting = isSprinting;
      scratchStealthInput.roadFactor = roadFactor;
      scratchStealthInput.inPuddle = inPuddle;
      scratchStealthInput.nightFactor = atmo.nightFactor;
      scratchStealthInput.rainIntensity = atmo.rainIntensity;
      scratchStealthInput.flashlightOn = lightOn;
      computeStealthFactor(scratchStealthInput, scratchStealthResult);

      if (exploring && !survival.vitals.isDead) {
        const hpBeforeTick = survival.vitals.health;
        scratchSurvivalInput.isSprinting = isSprinting;
        scratchSurvivalInput.isMoving = isMoving;
        scratchSurvivalInput.isInPuddle = inPuddle;
        scratchSurvivalInput.isSheltered = sheltered;
        scratchSurvivalInput.isNearFire = scratchCampProx.nearFire;
        scratchSurvivalInput.rainIntensity = atmo.rainIntensity;
        scratchSurvivalInput.nightFactor = atmo.nightFactor;
        survival.update(FIXED_STEP, scratchSurvivalInput);
        if (survival.vitals.health < hpBeforeTick) {
          lastDamageCause = 'exposure';
        }
      }

      scavenge.update(elapsed, px, pz);

      scratchThreatInput.playerX = px;
      scratchThreatInput.playerY = py;
      scratchThreatInput.playerZ = pz;
      scratchThreatInput.playerVisibility = scratchStealthResult.visibility;
      scratchThreatInput.playerNoiseRadius = exploring ? scratchStealthResult.noiseRadius : 0;
      scratchThreatInput.playerDead = !exploring || survival.vitals.isDead;
      scratchThreatInput.nightFactor = atmo.nightFactor;
      scratchThreatInput.rainIntensity = atmo.rainIntensity;
      scratchThreatInput.flashlightOn = lightOn;
      threats.update(FIXED_STEP, elapsed, scratchThreatInput);

      wildlife.update(
        FIXED_STEP,
        elapsed,
        px,
        pz,
        exploring ? scratchStealthResult.noiseRadius : 0,
        atmo.nightFactor,
        atmo.rainIntensity,
      );

      rainField.update(elapsed, px, py, pz, atmo.rainIntensity, atmo.windBoost, atmo.fogColor);

      // Compute stereo pan toward nearest ruin/wreck & active campfire relative to listener right vector
      environment.sampleRuinMetalProximity(px, pz, scratchRuinSample);
      const dx = scratchRuinSample.sourceX - px;
      const dz = scratchRuinSample.sourceZ - pz;
      const dist = Math.hypot(dx, dz);
      const fireDx = scratchCampProx.fireX - px;
      const fireDz = scratchCampProx.fireZ - pz;
      const fireDist = Math.hypot(fireDx, fireDz);
      scratchSpatialAudio.windIntensity = environment.getWindIntensity(elapsed) * atmo.windBoost;
      scratchSpatialAudio.ruinProximity = scratchRuinSample.proximity;
      scratchSpatialAudio.ruinPan = dist > 0.01 ? (dx * rightX + dz * rightZ) / dist : 0;
      scratchSpatialAudio.rainIntensity = atmo.rainIntensity;
      scratchSpatialAudio.nightFactor = atmo.nightFactor;
      scratchSpatialAudio.isSheltered = sheltered;
      scratchSpatialAudio.fireProximity = scratchCampProx.fireProximity;
      scratchSpatialAudio.firePan =
        scratchCampProx.fireProximity > 0.01 && fireDist > 0.01
          ? (fireDx * rightX + fireDz * rightZ) / fireDist
          : 0;

      audio.update(elapsed, FIXED_STEP, scratchSpatialAudio);
      accumulator -= FIXED_STEP;
      substeps += 1;
    }

    syncSurvivalHud(clampedDt);
    player.updateCamera(clampedDt);
    engine.update(
      elapsed,
      player.position.x,
      player.position.y,
      player.position.z,
      atmosphere.snapshot,
    );
    engine.render();
  };

  // Hydrate any persisted world state from localStorage cleanly before first frame
  const savedWorld = loadWorldFromStorage();
  if (savedWorld) {
    survival.hydrate(savedWorld.survival);
    scavenge.hydrateLootedIds(savedWorld.lootedCacheIds);
    harvest.hydrateDepletedIds(savedWorld.depletedHarvestIds);
    camp.hydrate(savedWorld.camp);
    building.hydrate(savedWorld.builtPieces, savedWorld.storageStash);
    atmosphere.setTimeHours(savedWorld.timeHours);
    player.setPositionAndYaw(savedWorld.player.x, savedWorld.player.z, savedWorld.player.yaw);
    hasSavedState = true;
    btnExplore.textContent = 'Continue Saved World';
    btnResetWorld.style.display = 'inline-block';
  }
  selectTool('axe', false);

  player.update(FIXED_STEP, 0);
  environment.update(0, FIXED_STEP, atmosphere.snapshot);
  harvest.update(0);
  camp.update(FIXED_STEP, 0);
  building.update(0);
  camp.sampleProximity(player.position.x, player.position.z, scratchCampProx);
  scavenge.update(0, player.position.x, player.position.z);
  wildlife.update(0, 0, player.position.x, player.position.z, 0, 0, 0);
  syncSurvivalHud(FIXED_STEP);
  syncBuildBarUi();
  player.updateCamera(FIXED_STEP);
  engine.update(0, player.position.x, player.position.y, player.position.z, atmosphere.snapshot);
  engine.render();
  rafId = window.requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => {
    if (hasEnteredOnce && !survival.vitals.isDead) {
      persistWorld();
    }
    document.body.classList.remove('build-mode-active');
    window.cancelAnimationFrame(rafId);
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', handleGlobalKeyDown);
    player.dispose();
    building.dispose();
    harvest.dispose();
    camp.dispose();
    scavenge.dispose();
    threats.dispose();
    wildlife.dispose();
    flashlight.dispose();
    rainField.dispose();
    environment.dispose();
    audio.dispose();
    engine.dispose();
  });
}

startOvergrownFrontier();
