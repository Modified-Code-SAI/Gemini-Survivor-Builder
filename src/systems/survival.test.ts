import { describe, expect, it } from 'vitest';
import { createSurvivalState } from './survival';

describe('survival state system', () => {
  it('starts empty-handed at full vitals', () => {
    const survival = createSurvivalState();
    expect(survival.vitals.health).toBe(100);
    expect(survival.vitals.stamina).toBe(100);
    expect(survival.vitals.hunger).toBe(100);
    expect(survival.vitals.warmth).toBe(100);
    expect(survival.vitals.isDead).toBe(false);
    expect(survival.vitals.exhausted).toBe(false);
    expect(survival.vitals.sheltered).toBe(false);

    expect(survival.inventory.rations).toBe(0);
    expect(survival.inventory.medkits).toBe(0);
    expect(survival.inventory.warmers).toBe(0);
    expect(survival.inventory.bottles).toBe(0);
    expect(survival.inventory.scrap).toBe(0);
    expect(survival.inventory.wood).toBe(0);
    expect(survival.inventory.stone).toBe(0);
  });

  it('drains stamina when sprinting and enforces exhaustion lock hysteresis', () => {
    const survival = createSurvivalState();

    // Sprint 5.3s -> drains 95.4 stamina -> 4.6 (< 6 triggers exhausted)
    survival.update(5.3, {
      isSprinting: true,
      isMoving: true,
      isInPuddle: false,
      isSheltered: false,
    });
    expect(survival.vitals.stamina).toBeLessThan(6);
    expect(survival.vitals.exhausted).toBe(true);
    expect(survival.canSprint()).toBe(false);

    // Recovering idle for 0.6s (+13.2 -> ~17.8) stays locked under 22
    survival.update(0.6, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: false,
    });
    expect(survival.vitals.stamina).toBeGreaterThan(15);
    expect(survival.vitals.stamina).toBeLessThan(22);
    expect(survival.vitals.exhausted).toBe(true);
    expect(survival.canSprint()).toBe(false);

    // Recovering another 0.4s (+8.8 -> ~26.6 >= 22) clears exhaustion lock
    survival.update(0.4, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: false,
    });
    expect(survival.vitals.stamina).toBeGreaterThanOrEqual(22);
    expect(survival.vitals.exhausted).toBe(false);
    expect(survival.canSprint()).toBe(true);
  });

  it('consumes stamina for jump and attack actions and gates when insufficient', () => {
    const survival = createSurvivalState();
    expect(survival.canJump()).toBe(true);
    expect(survival.consumeJumpStamina()).toBe(true);
    expect(survival.vitals.stamina).toBeCloseTo(86, 5);

    expect(survival.canAttack()).toBe(true);
    expect(survival.consumeAttackStamina()).toBe(true);
    expect(survival.vitals.stamina).toBeCloseTo(73, 5);

    // Drain stamina down to 5 via sprinting -> exhausted blocks jump & attack
    survival.update(4, {
      isSprinting: true,
      isMoving: true,
      isInPuddle: false,
      isSheltered: false,
    });
    expect(survival.canJump()).toBe(false);
    expect(survival.consumeJumpStamina()).toBe(false);
    expect(survival.canAttack()).toBe(false);
    expect(survival.consumeAttackStamina()).toBe(false);
  });

  it('chills rapidly in rainwater puddles and warms back up inside concrete shelter', () => {
    const survival = createSurvivalState();

    // Standing in puddle for 10s drains 23 warmth
    survival.update(10, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: true,
      isSheltered: false,
    });
    expect(survival.vitals.warmth).toBeCloseTo(77, 4);
    expect(survival.vitals.sheltered).toBe(false);

    // Entering dry concrete shelter for 5s recovers +19 warmth
    survival.update(5, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: true,
    });
    expect(survival.vitals.sheltered).toBe(true);
    expect(survival.vitals.warmth).toBeCloseTo(96, 4);
  });

  it('applies exposure health drain at zero warmth/hunger and clamps death cleanly at 0', () => {
    const survival = createSurvivalState();

    // Step 44s in puddle (44 * 2.3 = 101.2 warmth drained -> warmth hits 0 on tick 44)
    for (let i = 0; i < 44; i += 1) {
      survival.update(1, {
        isSprinting: false,
        isMoving: false,
        isInPuddle: true,
        isSheltered: false,
      });
    }
    expect(survival.vitals.warmth).toBe(0);
    expect(survival.vitals.health).toBeCloseTo(97.5, 4);
    const hpAfterFreeze = survival.vitals.health;

    // 4s more at 0 warmth drains -10 health
    survival.update(4, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: true,
      isSheltered: false,
    });
    expect(survival.vitals.health).toBeCloseTo(hpAfterFreeze - 10, 4);

    // Lethal damage clamps health to 0 and locks isDead
    const dealt = survival.applyDamage(500);
    expect(dealt).toBeCloseTo(hpAfterFreeze - 10, 4);
    expect(survival.vitals.health).toBe(0);
    expect(survival.vitals.isDead).toBe(true);
    expect(survival.canSprint()).toBe(false);
    expect(survival.applyDamage(10)).toBe(0);
  });

  it('adds loot bundles, consumes quick-use supplies, and resets cleanly', () => {
    const survival = createSurvivalState();
    survival.addLoot({ rations: 1, medkits: 1, warmers: 1, bottles: 2, scrap: 3 });

    expect(survival.inventory).toEqual({
      rations: 1,
      medkits: 1,
      warmers: 1,
      bottles: 2,
      scrap: 3,
      wood: 0,
      stone: 0,
      arrows: 0,
    });

    // Lower vitals so item gains are directly observable
    survival.update(40, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: true,
      isSheltered: false,
    });
    survival.applyDamage(60);

    const hungerBefore = survival.vitals.hunger;
    const hpBeforeRation = survival.vitals.health;
    expect(survival.useRation()).toBe(true);
    expect(survival.inventory.rations).toBe(0);
    expect(survival.vitals.hunger).toBeCloseTo(Math.min(100, hungerBefore + 38), 4);
    expect(survival.vitals.health).toBeCloseTo(Math.min(100, hpBeforeRation + 8), 4);
    expect(survival.useRation()).toBe(false);

    const hpBeforeMedkit = survival.vitals.health;
    expect(survival.useMedkit()).toBe(true);
    expect(survival.inventory.medkits).toBe(0);
    expect(survival.vitals.health).toBeCloseTo(Math.min(100, hpBeforeMedkit + 45), 4);

    const warmthBeforeWarmer = survival.vitals.warmth;
    expect(survival.useWarmer()).toBe(true);
    expect(survival.inventory.warmers).toBe(0);
    expect(survival.vitals.warmth).toBeCloseTo(Math.min(100, warmthBeforeWarmer + 45), 4);

    expect(survival.consumeBottle()).toBe(true);
    expect(survival.inventory.bottles).toBe(1);
    expect(survival.consumeBottle()).toBe(true);
    expect(survival.inventory.bottles).toBe(0);
    expect(survival.consumeBottle()).toBe(false);

    survival.applyDamage(200);
    expect(survival.vitals.isDead).toBe(true);

    survival.reset();
    expect(survival.vitals.health).toBe(100);
    expect(survival.vitals.stamina).toBe(100);
    expect(survival.vitals.hunger).toBe(100);
    expect(survival.vitals.warmth).toBe(100);
    expect(survival.vitals.isDead).toBe(false);
    expect(survival.inventory.scrap).toBe(0);
  });

  it('accelerates open-air warmth chill in rainstorms & night air while shelter still restores warmth', () => {
    const survival = createSurvivalState();

    // 10s exposed to heavy rain (1.0) at night (1.0): (0.42 + 1.45 + 0.35) * 10 = 22.2 warmth lost -> 77.8
    survival.update(10, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: false,
      rainIntensity: 1.0,
      nightFactor: 1.0,
    });
    expect(survival.vitals.warmth).toBeCloseTo(77.8, 3);

    // Ducking into concrete shelter during the exact same stormy night restores warmth (+3.8/s * 5 = +19 -> 96.8)
    survival.update(5, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: true,
      rainIntensity: 1.0,
      nightFactor: 1.0,
    });
    expect(survival.vitals.sheltered).toBe(true);
    expect(survival.vitals.warmth).toBeCloseTo(96.8, 3);
  });

  it('rapidly warms and gently heals beside a campfire, crafts rations from scrap, and revives at camp keeping inventory', () => {
    const survival = createSurvivalState();
    survival.addLoot({ scrap: 5, bottles: 2 });

    // Chill & injure survivor in a stormy night first
    survival.update(20, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: false,
      rainIntensity: 1.0,
      nightFactor: 1.0,
    });
    survival.applyDamage(30);
    const hpBeforeFire = survival.vitals.health;
    const warmthBeforeFire = survival.vitals.warmth;
    expect(warmthBeforeFire).toBeLessThan(60);

    // Standing near a lit campfire overrides heavy rainstorm chill (+7.5/s warmth) and heals (+1.8/s HP)
    survival.update(5, {
      isSprinting: false,
      isMoving: false,
      isInPuddle: false,
      isSheltered: false,
      isNearFire: true,
      rainIntensity: 1.0,
      nightFactor: 1.0,
    });
    expect(survival.vitals.warmth).toBeCloseTo(Math.min(100, warmthBeforeFire + 37.5), 3);
    expect(survival.vitals.health).toBeCloseTo(Math.min(100, hpBeforeFire + 9.0), 3);

    // Spend scrap & cook field ration
    expect(survival.spendScrap(2)).toBe(true);
    expect(survival.inventory.scrap).toBe(3);
    expect(survival.craftFieldRation()).toBe(true);
    expect(survival.inventory.scrap).toBe(2);
    expect(survival.inventory.rations).toBe(1);
    expect(survival.spendScrap(5)).toBe(false);

    // Die then revive at Lean-To Camp: vitals restored while scavenged inventory stays intact
    survival.applyDamage(200);
    expect(survival.vitals.isDead).toBe(true);
    survival.reviveAtCamp();
    expect(survival.vitals.isDead).toBe(false);
    expect(survival.vitals.health).toBe(100);
    expect(survival.vitals.stamina).toBe(100);
    expect(survival.vitals.hunger).toBe(75);
    expect(survival.vitals.warmth).toBe(100);
    expect(survival.inventory.scrap).toBe(2);
    expect(survival.inventory.rations).toBe(1);
    expect(survival.inventory.bottles).toBe(2);
  });

  it('tracks wood & stone, enforces atomic spendResources, crafts workbench items, and serializes/hydrates cleanly', () => {
    const survival = createSurvivalState();
    survival.addLoot({ wood: 5, stone: 3, scrap: 4 });
    expect(survival.inventory.wood).toBe(5);
    expect(survival.inventory.stone).toBe(3);
    expect(survival.inventory.scrap).toBe(4);

    // Atomic rejection: insufficient stone must NOT deduct wood or scrap
    expect(survival.hasResources({ wood: 4, stone: 4, scrap: 1 })).toBe(false);
    expect(survival.spendResources({ wood: 4, stone: 4, scrap: 1 })).toBe(false);
    expect(survival.inventory.wood).toBe(5);
    expect(survival.inventory.stone).toBe(3);
    expect(survival.inventory.scrap).toBe(4);

    // Atomic spend succeeds when all resources are available
    expect(survival.hasResources({ wood: 2, stone: 1 })).toBe(true);
    expect(survival.spendResources({ wood: 2, stone: 1 })).toBe(true);
    expect(survival.inventory.wood).toBe(3);
    expect(survival.inventory.stone).toBe(2);

    // Workbench crafting recipes: ration (1W+1Sc), medkit (1W+2Sc), warmer (1St+1Sc), bottle (1St)
    expect(survival.craftItem('ration')).toBe(true); // W:2, St:2, Sc:3
    expect(survival.craftItem('medkit')).toBe(true); // W:1, St:2, Sc:1
    expect(survival.craftItem('warmer')).toBe(true); // W:1, St:1, Sc:0
    expect(survival.craftItem('bottle')).toBe(true); // W:1, St:0, Sc:0
    expect(survival.craftItem('medkit')).toBe(false); // No scrap left
    expect(survival.inventory.rations).toBe(1);
    expect(survival.inventory.medkits).toBe(1);
    expect(survival.inventory.warmers).toBe(1);
    expect(survival.inventory.bottles).toBe(1);

    // Serialize & hydrate round-trip with out-of-range sanitization
    survival.applyDamage(28);
    const snap = survival.serialize();
    const restored = createSurvivalState();
    restored.hydrate(snap);
    expect(restored.vitals.health).toBeCloseTo(72, 4);
    expect(restored.inventory).toEqual(survival.inventory);

    restored.hydrate({
      vitals: { health: 999, stamina: 2, hunger: -50, warmth: Number.NaN },
      inventory: {
        rations: -4,
        medkits: 2.9,
        warmers: Number.NaN,
        bottles: 1,
        scrap: 3,
        wood: 7,
        stone: 5,
      },
    });
    expect(restored.vitals.health).toBe(100);
    expect(restored.vitals.exhausted).toBe(true);
    expect(restored.vitals.hunger).toBe(0);
    expect(restored.vitals.warmth).toBe(100);
    expect(restored.inventory.rations).toBe(0);
    expect(restored.inventory.medkits).toBe(2);
    expect(restored.inventory.warmers).toBe(0);
    expect(restored.inventory.wood).toBe(7);
    expect(restored.inventory.stone).toBe(5);
  });

  it('crafts Phase 2 workbench gear & arrows, prevents double-crafting, mitigates combat damage with scrap armor, and hydrates legacy saves safely', () => {
    const survival = createSurvivalState();
    survival.addLoot({ wood: 20, stone: 20, scrap: 20 });

    // Arrows (+4) and consumeArrow
    expect(survival.isRecipeOwned('arrows')).toBe(false);
    expect(survival.craftItem('arrows')).toBe(true); // -1W -1St -> +4 arrows
    expect(survival.inventory.arrows).toBe(4);
    expect(survival.consumeArrow()).toBe(true);
    expect(survival.inventory.arrows).toBe(3);

    // Compound Bow unlocks bow + grants +6 starter arrows, and prevents double-craft without spending resources
    expect(survival.isRecipeOwned('compound_bow')).toBe(false);
    expect(survival.craftItem('compound_bow')).toBe(true); // -4W -2St -3Sc -> bow + 6 arrows
    expect(survival.gear.hasCompoundBow).toBe(true);
    expect(survival.isRecipeOwned('compound_bow')).toBe(true);
    expect(survival.inventory.arrows).toBe(9);

    const woodBeforeDup = survival.inventory.wood;
    const stoneBeforeDup = survival.inventory.stone;
    const scrapBeforeDup = survival.inventory.scrap;
    expect(survival.craftItem('compound_bow')).toBe(false);
    expect(survival.inventory.wood).toBe(woodBeforeDup);
    expect(survival.inventory.stone).toBe(stoneBeforeDup);
    expect(survival.inventory.scrap).toBe(scrapBeforeDup);
    expect(survival.inventory.arrows).toBe(9);

    // Remaining one-time gear recipes
    expect(survival.craftItem('repair_hammer')).toBe(true);
    expect(survival.gear.hasRepairHammer).toBe(true);
    expect(survival.craftItem('repair_hammer')).toBe(false);

    expect(survival.craftItem('reinforced_tools')).toBe(true);
    expect(survival.gear.reinforcedTools).toBe(true);
    expect(survival.craftItem('reinforced_tools')).toBe(false);

    expect(survival.craftItem('upgraded_flashlight')).toBe(true);
    expect(survival.gear.upgradedFlashlight).toBe(true);
    expect(survival.craftItem('upgraded_flashlight')).toBe(false);

    expect(survival.craftItem('scrap_armor')).toBe(true);
    expect(survival.gear.scrapArmor).toBe(true);
    expect(survival.craftItem('scrap_armor')).toBe(false);

    // Drain remaining arrows and verify empty gate
    for (let i = 0; i < 9; i += 1) {
      expect(survival.consumeArrow()).toBe(true);
    }
    expect(survival.inventory.arrows).toBe(0);
    expect(survival.consumeArrow()).toBe(false);

    // Scrap armor mitigates combat damage by 38% (20 -> 12.4) while leaving exposure damage unmitigated (20 -> 20)
    const combatDealt = survival.applyDamage(20);
    expect(combatDealt).toBeCloseTo(12.4, 5);
    expect(survival.vitals.health).toBeCloseTo(87.6, 5);

    const exposureDealt = survival.applyDamage(20, 'exposure');
    expect(exposureDealt).toBeCloseTo(20, 5);
    expect(survival.vitals.health).toBeCloseTo(67.6, 5);

    // Serialize -> reset -> hydrate round-trip preserves arrows and all 5 gear flags
    survival.addLoot({ arrows: 5 });
    const fullSnap = survival.serialize();
    survival.reset();
    expect(survival.inventory.arrows).toBe(0);
    expect(survival.gear).toEqual({
      hasCompoundBow: false,
      hasRepairHammer: false,
      reinforcedTools: false,
      upgradedFlashlight: false,
      scrapArmor: false,
    });

    survival.hydrate(fullSnap);
    expect(survival.inventory.arrows).toBe(5);
    expect(survival.gear).toEqual({
      hasCompoundBow: true,
      hasRepairHammer: true,
      reinforcedTools: true,
      upgradedFlashlight: true,
      scrapArmor: true,
    });

    // reviveAtCamp preserves crafted gear & arrows
    survival.applyDamage(500);
    expect(survival.vitals.isDead).toBe(true);
    survival.reviveAtCamp();
    expect(survival.vitals.isDead).toBe(false);
    expect(survival.inventory.arrows).toBe(5);
    expect(survival.gear.hasCompoundBow).toBe(true);
    expect(survival.gear.scrapArmor).toBe(true);

    // Hydrating a legacy Phase 1 snapshot without arrows or gear defaults cleanly to 0 / false
    survival.hydrate({
      vitals: { health: 90, stamina: 80, hunger: 70, warmth: 60 },
      inventory: {
        rations: 1,
        medkits: 0,
        warmers: 2,
        bottles: 1,
        scrap: 4,
        wood: 6,
        stone: 3,
      },
    });
    expect(survival.inventory.arrows).toBe(0);
    expect(survival.gear).toEqual({
      hasCompoundBow: false,
      hasRepairHammer: false,
      reinforcedTools: false,
      upgradedFlashlight: false,
      scrapArmor: false,
    });
  });
});
