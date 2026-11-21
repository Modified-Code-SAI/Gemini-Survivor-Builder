export interface LootBundle {
  readonly rations?: number;
  readonly medkits?: number;
  readonly warmers?: number;
  readonly bottles?: number;
  readonly scrap?: number;
  readonly wood?: number;
  readonly stone?: number;
  readonly arrows?: number;
}

export interface ResourceCost {
  readonly wood?: number;
  readonly stone?: number;
  readonly scrap?: number;
}

export type CraftItemKind =
  | 'ration'
  | 'medkit'
  | 'warmer'
  | 'bottle'
  | 'arrows'
  | 'repair_hammer'
  | 'compound_bow'
  | 'reinforced_tools'
  | 'upgraded_flashlight'
  | 'scrap_armor';

export const WORKBENCH_RECIPES: Readonly<Record<CraftItemKind, ResourceCost>> = {
  ration: { wood: 1, scrap: 1 },
  medkit: { wood: 1, scrap: 2 },
  warmer: { stone: 1, scrap: 1 },
  bottle: { stone: 1 },
  arrows: { wood: 1, stone: 1 },
  repair_hammer: { wood: 2, stone: 1, scrap: 1 },
  compound_bow: { wood: 4, stone: 2, scrap: 3 },
  reinforced_tools: { wood: 2, stone: 3, scrap: 3 },
  upgraded_flashlight: { wood: 1, stone: 2, scrap: 3 },
  scrap_armor: { wood: 2, stone: 2, scrap: 4 },
};

export interface SurvivalGear {
  hasCompoundBow: boolean;
  hasRepairHammer: boolean;
  reinforcedTools: boolean;
  upgradedFlashlight: boolean;
  scrapArmor: boolean;
}

export interface SurvivalVitals {
  health: number;
  stamina: number;
  hunger: number;
  warmth: number;
  isDead: boolean;
  exhausted: boolean;
  sheltered: boolean;
}

export interface SurvivalInventory {
  rations: number;
  medkits: number;
  warmers: number;
  bottles: number;
  scrap: number;
  wood: number;
  stone: number;
  arrows: number;
}

export interface SurvivalSnapshotInventory {
  readonly rations: number;
  readonly medkits: number;
  readonly warmers: number;
  readonly bottles: number;
  readonly scrap: number;
  readonly wood: number;
  readonly stone: number;
  readonly arrows?: number;
}

export interface SurvivalSnapshot {
  readonly vitals: {
    readonly health: number;
    readonly stamina: number;
    readonly hunger: number;
    readonly warmth: number;
  };
  readonly inventory: SurvivalSnapshotInventory;
  readonly gear?: Readonly<SurvivalGear>;
}

export interface SurvivalUpdateInput {
  readonly isSprinting: boolean;
  readonly isMoving: boolean;
  readonly isInPuddle: boolean;
  readonly isSheltered: boolean;
  readonly isNearFire?: boolean;
  readonly rainIntensity?: number;
  readonly nightFactor?: number;
}

export interface SurvivalState {
  readonly vitals: Readonly<SurvivalVitals>;
  readonly inventory: Readonly<SurvivalInventory>;
  readonly gear: Readonly<SurvivalGear>;
  update(dt: number, input: SurvivalUpdateInput): void;
  canSprint(): boolean;
  canJump(): boolean;
  consumeJumpStamina(): boolean;
  canAttack(): boolean;
  consumeAttackStamina(): boolean;
  applyDamage(amount: number, source?: 'combat' | 'exposure'): number;
  addLoot(bundle: LootBundle): void;
  takeInventory(bundle: LootBundle): boolean;
  hasResources(cost: ResourceCost): boolean;
  spendResources(cost: ResourceCost): boolean;
  spendScrap(amount: number): boolean;
  craftFieldRation(): boolean;
  isRecipeOwned(kind: CraftItemKind): boolean;
  craftItem(kind: CraftItemKind): boolean;
  useRation(): boolean;
  useMedkit(): boolean;
  useWarmer(): boolean;
  consumeBottle(): boolean;
  consumeArrow(): boolean;
  reviveAtCamp(): void;
  serialize(): SurvivalSnapshot;
  hydrate(snapshot: SurvivalSnapshot): void;
  reset(): void;
}

const MAX_VITAL = 100;
const STAMINA_SPRINT_DRAIN = 18;
const STAMINA_IDLE_REGEN = 22;
const STAMINA_WALK_REGEN = 12;
const STAMINA_HUNGRY_REGEN_SCALE = 0.55;
const STAMINA_EXHAUST_THRESHOLD = 6;
const STAMINA_RECOVER_THRESHOLD = 22;
const JUMP_STAMINA_COST = 14;
const ATTACK_STAMINA_COST = 13;

const HUNGER_BASE_DRAIN = 0.5;
const HUNGER_SPRINT_DRAIN = 0.8;
const HUNGER_LOW_THRESHOLD = 20;

const WARMTH_OPEN_DRAIN = 0.42;
const WARMTH_RAIN_DRAIN = 1.45;
const WARMTH_NIGHT_DRAIN = 0.35;
const WARMTH_PUDDLE_DRAIN = 2.3;
const WARMTH_SHELTER_REGEN = 3.8;
const WARMTH_FIRE_REGEN = 7.5;
const FIRE_HEALTH_REGEN = 1.8;

const EXPOSURE_HEALTH_DRAIN = 2.5;
const SCRAP_ARMOR_COMBAT_DAMAGE_SCALE = 0.62;

function clampVital(value: number): number {
  return value < 0 ? 0 : value > MAX_VITAL ? MAX_VITAL : value;
}

function sanitizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Deterministic player survival vitals, exhaustion hysteresis, workbench gear unlocks,
 * and scavenging inventory manager.
 * Starts completely empty-handed so the survivor must sneak past threats and scavenge the valley.
 */
export function createSurvivalState(): SurvivalState {
  const vitals: SurvivalVitals = {
    health: MAX_VITAL,
    stamina: MAX_VITAL,
    hunger: MAX_VITAL,
    warmth: MAX_VITAL,
    isDead: false,
    exhausted: false,
    sheltered: false,
  };

  const inventory: SurvivalInventory = {
    rations: 0,
    medkits: 0,
    warmers: 0,
    bottles: 0,
    scrap: 0,
    wood: 0,
    stone: 0,
    arrows: 0,
  };

  const gear: SurvivalGear = {
    hasCompoundBow: false,
    hasRepairHammer: false,
    reinforcedTools: false,
    upgradedFlashlight: false,
    scrapArmor: false,
  };

  function syncExhaustionState(): void {
    if (vitals.stamina < STAMINA_EXHAUST_THRESHOLD) {
      vitals.exhausted = true;
    } else if (vitals.exhausted && vitals.stamina >= STAMINA_RECOVER_THRESHOLD) {
      vitals.exhausted = false;
    }
  }

  function applyDamage(amount: number, source: 'combat' | 'exposure' = 'combat'): number {
    if (vitals.isDead || !Number.isFinite(amount) || amount <= 0) {
      return 0;
    }
    const effectiveAmount =
      gear.scrapArmor && source !== 'exposure' ? amount * SCRAP_ARMOR_COMBAT_DAMAGE_SCALE : amount;
    const prev = vitals.health;
    vitals.health = clampVital(vitals.health - effectiveAmount);
    if (vitals.health <= 0) {
      vitals.health = 0;
      vitals.isDead = true;
    }
    return prev - vitals.health;
  }

  function update(dt: number, input: SurvivalUpdateInput): void {
    if (vitals.isDead || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    vitals.sheltered = input.isSheltered;

    // 1. Stamina drain & hunger-scaled recovery with exhaustion lock hysteresis
    const activelySprinting = input.isSprinting && !vitals.exhausted;
    if (activelySprinting) {
      vitals.stamina = clampVital(vitals.stamina - STAMINA_SPRINT_DRAIN * dt);
    } else {
      const baseRegen = input.isMoving ? STAMINA_WALK_REGEN : STAMINA_IDLE_REGEN;
      const hungerScale = vitals.hunger < HUNGER_LOW_THRESHOLD ? STAMINA_HUNGRY_REGEN_SCALE : 1;
      vitals.stamina = clampVital(vitals.stamina + baseRegen * hungerScale * dt);
    }
    syncExhaustionState();

    // 2. Hunger drain
    const hungerDrain = activelySprinting ? HUNGER_SPRINT_DRAIN : HUNGER_BASE_DRAIN;
    vitals.hunger = clampVital(vitals.hunger - hungerDrain * dt);

    // 3. Warmth balance (campfires override rain/cold & heal; concrete ruins & lean-tos protect; puddles & storms chill)
    if (input.isNearFire) {
      vitals.warmth = clampVital(vitals.warmth + WARMTH_FIRE_REGEN * dt);
      if (vitals.hunger > 25 && vitals.health < MAX_VITAL) {
        vitals.health = clampVital(vitals.health + FIRE_HEALTH_REGEN * dt);
      }
    } else if (input.isInPuddle) {
      vitals.warmth = clampVital(vitals.warmth - WARMTH_PUDDLE_DRAIN * dt);
    } else if (input.isSheltered) {
      vitals.warmth = clampVital(vitals.warmth + WARMTH_SHELTER_REGEN * dt);
    } else {
      const rain = Math.max(0, Math.min(1, input.rainIntensity ?? 0));
      const night = Math.max(0, Math.min(1, input.nightFactor ?? 0));
      const totalDrain = WARMTH_OPEN_DRAIN + rain * WARMTH_RAIN_DRAIN + night * WARMTH_NIGHT_DRAIN;
      vitals.warmth = clampVital(vitals.warmth - totalDrain * dt);
    }

    // 4. Exposure / starvation health tick (unmitigated by scrap armor)
    if (vitals.hunger <= 0 || vitals.warmth <= 0) {
      applyDamage(EXPOSURE_HEALTH_DRAIN * dt, 'exposure');
    }
  }

  function canSprint(): boolean {
    return !vitals.isDead && !vitals.exhausted && vitals.stamina > 0;
  }

  function canJump(): boolean {
    return !vitals.isDead && !vitals.exhausted && vitals.stamina >= JUMP_STAMINA_COST;
  }

  function consumeJumpStamina(): boolean {
    if (!canJump()) {
      return false;
    }
    vitals.stamina = clampVital(vitals.stamina - JUMP_STAMINA_COST);
    syncExhaustionState();
    return true;
  }

  function canAttack(): boolean {
    return !vitals.isDead && !vitals.exhausted && vitals.stamina >= ATTACK_STAMINA_COST;
  }

  function consumeAttackStamina(): boolean {
    if (!canAttack()) {
      return false;
    }
    vitals.stamina = clampVital(vitals.stamina - ATTACK_STAMINA_COST);
    syncExhaustionState();
    return true;
  }

  function addLoot(bundle: LootBundle): void {
    inventory.rations += sanitizeCount(bundle.rations);
    inventory.medkits += sanitizeCount(bundle.medkits);
    inventory.warmers += sanitizeCount(bundle.warmers);
    inventory.bottles += sanitizeCount(bundle.bottles);
    inventory.scrap += sanitizeCount(bundle.scrap);
    inventory.wood += sanitizeCount(bundle.wood);
    inventory.stone += sanitizeCount(bundle.stone);
    inventory.arrows += sanitizeCount(bundle.arrows);
  }

  function takeInventory(bundle: LootBundle): boolean {
    if (vitals.isDead) {
      return false;
    }
    const r = sanitizeCount(bundle.rations);
    const m = sanitizeCount(bundle.medkits);
    const wrm = sanitizeCount(bundle.warmers);
    const b = sanitizeCount(bundle.bottles);
    const sc = sanitizeCount(bundle.scrap);
    const wd = sanitizeCount(bundle.wood);
    const st = sanitizeCount(bundle.stone);
    const ar = sanitizeCount(bundle.arrows);
    if (r + m + wrm + b + sc + wd + st + ar === 0) {
      return false;
    }
    if (
      inventory.rations < r ||
      inventory.medkits < m ||
      inventory.warmers < wrm ||
      inventory.bottles < b ||
      inventory.scrap < sc ||
      inventory.wood < wd ||
      inventory.stone < st ||
      inventory.arrows < ar
    ) {
      return false;
    }
    inventory.rations -= r;
    inventory.medkits -= m;
    inventory.warmers -= wrm;
    inventory.bottles -= b;
    inventory.scrap -= sc;
    inventory.wood -= wd;
    inventory.stone -= st;
    inventory.arrows -= ar;
    return true;
  }

  function hasResources(cost: ResourceCost): boolean {
    const needWood = sanitizeCount(cost.wood);
    const needStone = sanitizeCount(cost.stone);
    const needScrap = sanitizeCount(cost.scrap);
    return (
      inventory.wood >= needWood &&
      inventory.stone >= needStone &&
      inventory.scrap >= needScrap
    );
  }

  function spendResources(cost: ResourceCost): boolean {
    if (vitals.isDead) {
      return false;
    }
    const needWood = sanitizeCount(cost.wood);
    const needStone = sanitizeCount(cost.stone);
    const needScrap = sanitizeCount(cost.scrap);
    if (needWood === 0 && needStone === 0 && needScrap === 0) {
      return false;
    }
    if (
      inventory.wood < needWood ||
      inventory.stone < needStone ||
      inventory.scrap < needScrap
    ) {
      return false;
    }
    inventory.wood -= needWood;
    inventory.stone -= needStone;
    inventory.scrap -= needScrap;
    return true;
  }

  function useRation(): boolean {
    if (vitals.isDead || inventory.rations <= 0) {
      return false;
    }
    inventory.rations -= 1;
    vitals.hunger = clampVital(vitals.hunger + 38);
    vitals.health = clampVital(vitals.health + 8);
    return true;
  }

  function useMedkit(): boolean {
    if (vitals.isDead || inventory.medkits <= 0) {
      return false;
    }
    inventory.medkits -= 1;
    vitals.health = clampVital(vitals.health + 45);
    return true;
  }

  function useWarmer(): boolean {
    if (vitals.isDead || inventory.warmers <= 0) {
      return false;
    }
    inventory.warmers -= 1;
    vitals.warmth = clampVital(vitals.warmth + 45);
    vitals.stamina = clampVital(vitals.stamina + 25);
    syncExhaustionState();
    return true;
  }

  function spendScrap(amount: number): boolean {
    const cost = sanitizeCount(amount);
    if (vitals.isDead || cost <= 0 || inventory.scrap < cost) {
      return false;
    }
    inventory.scrap -= cost;
    return true;
  }

  function craftFieldRation(): boolean {
    if (!spendScrap(1)) {
      return false;
    }
    inventory.rations += 1;
    return true;
  }

  function isRecipeOwned(kind: CraftItemKind): boolean {
    switch (kind) {
      case 'repair_hammer':
        return gear.hasRepairHammer;
      case 'compound_bow':
        return gear.hasCompoundBow;
      case 'reinforced_tools':
        return gear.reinforcedTools;
      case 'upgraded_flashlight':
        return gear.upgradedFlashlight;
      case 'scrap_armor':
        return gear.scrapArmor;
      case 'ration':
      case 'medkit':
      case 'warmer':
      case 'bottle':
      case 'arrows':
        return false;
      default: {
        const exhaustiveCheck: never = kind;
        return exhaustiveCheck;
      }
    }
  }

  function craftItem(kind: CraftItemKind): boolean {
    if (isRecipeOwned(kind)) {
      return false;
    }
    const recipe = WORKBENCH_RECIPES[kind];
    if (!spendResources(recipe)) {
      return false;
    }
    switch (kind) {
      case 'ration':
        inventory.rations += 1;
        break;
      case 'medkit':
        inventory.medkits += 1;
        break;
      case 'warmer':
        inventory.warmers += 1;
        break;
      case 'bottle':
        inventory.bottles += 1;
        break;
      case 'arrows':
        inventory.arrows += 4;
        break;
      case 'repair_hammer':
        gear.hasRepairHammer = true;
        break;
      case 'compound_bow':
        gear.hasCompoundBow = true;
        inventory.arrows += 6;
        break;
      case 'reinforced_tools':
        gear.reinforcedTools = true;
        break;
      case 'upgraded_flashlight':
        gear.upgradedFlashlight = true;
        break;
      case 'scrap_armor':
        gear.scrapArmor = true;
        break;
      default: {
        const exhaustiveCheck: never = kind;
        return exhaustiveCheck;
      }
    }
    return true;
  }

  function consumeBottle(): boolean {
    if (vitals.isDead || inventory.bottles <= 0) {
      return false;
    }
    inventory.bottles -= 1;
    return true;
  }

  function consumeArrow(): boolean {
    if (vitals.isDead || inventory.arrows <= 0) {
      return false;
    }
    inventory.arrows -= 1;
    return true;
  }

  function reviveAtCamp(): void {
    vitals.health = MAX_VITAL;
    vitals.stamina = MAX_VITAL;
    vitals.hunger = 75;
    vitals.warmth = MAX_VITAL;
    vitals.isDead = false;
    vitals.exhausted = false;
    vitals.sheltered = true;
  }

  function sanitizeVital(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return clampVital(value);
  }

  function serialize(): SurvivalSnapshot {
    return {
      vitals: {
        health: vitals.health,
        stamina: vitals.stamina,
        hunger: vitals.hunger,
        warmth: vitals.warmth,
      },
      inventory: {
        rations: inventory.rations,
        medkits: inventory.medkits,
        warmers: inventory.warmers,
        bottles: inventory.bottles,
        scrap: inventory.scrap,
        wood: inventory.wood,
        stone: inventory.stone,
        arrows: inventory.arrows,
      },
      gear: {
        hasCompoundBow: gear.hasCompoundBow,
        hasRepairHammer: gear.hasRepairHammer,
        reinforcedTools: gear.reinforcedTools,
        upgradedFlashlight: gear.upgradedFlashlight,
        scrapArmor: gear.scrapArmor,
      },
    };
  }

  function hydrate(snapshot: SurvivalSnapshot): void {
    vitals.health = sanitizeVital(snapshot.vitals.health, MAX_VITAL);
    vitals.stamina = sanitizeVital(snapshot.vitals.stamina, MAX_VITAL);
    vitals.hunger = sanitizeVital(snapshot.vitals.hunger, MAX_VITAL);
    vitals.warmth = sanitizeVital(snapshot.vitals.warmth, MAX_VITAL);
    vitals.isDead = vitals.health <= 0;
    vitals.exhausted = vitals.stamina < STAMINA_EXHAUST_THRESHOLD;
    vitals.sheltered = false;

    inventory.rations = sanitizeCount(snapshot.inventory.rations);
    inventory.medkits = sanitizeCount(snapshot.inventory.medkits);
    inventory.warmers = sanitizeCount(snapshot.inventory.warmers);
    inventory.bottles = sanitizeCount(snapshot.inventory.bottles);
    inventory.scrap = sanitizeCount(snapshot.inventory.scrap);
    inventory.wood = sanitizeCount(snapshot.inventory.wood);
    inventory.stone = sanitizeCount(snapshot.inventory.stone);
    inventory.arrows = sanitizeCount(snapshot.inventory.arrows);

    gear.hasCompoundBow = snapshot.gear?.hasCompoundBow === true;
    gear.hasRepairHammer = snapshot.gear?.hasRepairHammer === true;
    gear.reinforcedTools = snapshot.gear?.reinforcedTools === true;
    gear.upgradedFlashlight = snapshot.gear?.upgradedFlashlight === true;
    gear.scrapArmor = snapshot.gear?.scrapArmor === true;
  }

  function reset(): void {
    vitals.health = MAX_VITAL;
    vitals.stamina = MAX_VITAL;
    vitals.hunger = MAX_VITAL;
    vitals.warmth = MAX_VITAL;
    vitals.isDead = false;
    vitals.exhausted = false;
    vitals.sheltered = false;

    inventory.rations = 0;
    inventory.medkits = 0;
    inventory.warmers = 0;
    inventory.bottles = 0;
    inventory.scrap = 0;
    inventory.wood = 0;
    inventory.stone = 0;
    inventory.arrows = 0;

    gear.hasCompoundBow = false;
    gear.hasRepairHammer = false;
    gear.reinforcedTools = false;
    gear.upgradedFlashlight = false;
    gear.scrapArmor = false;
  }

  return {
    vitals,
    inventory,
    gear,
    update,
    canSprint,
    canJump,
    consumeJumpStamina,
    canAttack,
    consumeAttackStamina,
    applyDamage,
    addLoot,
    takeInventory,
    hasResources,
    spendResources,
    spendScrap,
    craftFieldRation,
    isRecipeOwned,
    craftItem,
    useRation,
    useMedkit,
    useWarmer,
    consumeBottle,
    consumeArrow,
    reviveAtCamp,
    serialize,
    hydrate,
    reset,
  };
}
