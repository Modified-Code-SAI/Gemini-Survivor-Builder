export interface LootBundle {
  readonly rations?: number;
  readonly medkits?: number;
  readonly warmers?: number;
  readonly bottles?: number;
  readonly scrap?: number;
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
  update(dt: number, input: SurvivalUpdateInput): void;
  canSprint(): boolean;
  canJump(): boolean;
  consumeJumpStamina(): boolean;
  canAttack(): boolean;
  consumeAttackStamina(): boolean;
  applyDamage(amount: number): number;
  addLoot(bundle: LootBundle): void;
  spendScrap(amount: number): boolean;
  craftFieldRation(): boolean;
  useRation(): boolean;
  useMedkit(): boolean;
  useWarmer(): boolean;
  consumeBottle(): boolean;
  reviveAtCamp(): void;
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
 * Deterministic player survival vitals, exhaustion hysteresis, and scavenging inventory manager.
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
  };

  function syncExhaustionState(): void {
    if (vitals.stamina < STAMINA_EXHAUST_THRESHOLD) {
      vitals.exhausted = true;
    } else if (vitals.exhausted && vitals.stamina >= STAMINA_RECOVER_THRESHOLD) {
      vitals.exhausted = false;
    }
  }

  function applyDamage(amount: number): number {
    if (vitals.isDead || !Number.isFinite(amount) || amount <= 0) {
      return 0;
    }
    const prev = vitals.health;
    vitals.health = clampVital(vitals.health - amount);
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

    // 4. Exposure / starvation health tick
    if (vitals.hunger <= 0 || vitals.warmth <= 0) {
      applyDamage(EXPOSURE_HEALTH_DRAIN * dt);
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

  function consumeBottle(): boolean {
    if (vitals.isDead || inventory.bottles <= 0) {
      return false;
    }
    inventory.bottles -= 1;
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
  }

  return {
    vitals,
    inventory,
    update,
    canSprint,
    canJump,
    consumeJumpStamina,
    canAttack,
    consumeAttackStamina,
    applyDamage,
    addLoot,
    spendScrap,
    craftFieldRation,
    useRation,
    useMedkit,
    useWarmer,
    consumeBottle,
    reviveAtCamp,
    reset,
  };
}
