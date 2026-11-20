import { describe, expect, it } from 'vitest';
import { createAtmosphereSystem } from './atmosphere';

describe('atmosphere system', () => {
  it('starts at exact Golden Hour (17.6 / 5:36 PM) matching the opening vista', () => {
    const atmo = createAtmosphereSystem();
    const s = atmo.snapshot;

    expect(s.timeHours).toBeCloseTo(17.6, 4);
    expect(s.phase).toBe('golden_hour');
    expect(s.weather).toBe('clear');
    expect(atmo.getFormattedClock()).toBe('5:36 PM');
    expect(s.nightFactor).toBeCloseTo(0, 4);
    expect(s.volumetricStrength).toBeCloseTo(1, 3);
    expect(s.rainIntensity).toBe(0);
    expect(s.windBoost).toBe(1);
    expect(s.sunDir.x).toBeCloseTo(0.46, 2);
    expect(s.sunDir.y).toBeCloseTo(0.25, 2);
    expect(s.sunDir.z).toBeCloseTo(-0.85, 2);
  });

  it('wraps 24-hour clock cleanly across midnight', () => {
    const atmo = createAtmosphereSystem();
    atmo.setTimeHours(23.95);
    for (let i = 0; i < 20; i += 1) {
      atmo.update(0.1);
    }

    expect(atmo.snapshot.timeHours).toBeGreaterThanOrEqual(0);
    expect(atmo.snapshot.timeHours).toBeLessThan(24);
    expect(atmo.snapshot.timeHours).toBeLessThan(0.5);
    expect(atmo.snapshot.phase).toBe('night');
  });

  it('transitions smoothly from Golden Hour to cool moonlit Night with stable shadow elevation', () => {
    const atmo = createAtmosphereSystem();
    atmo.setTimeHours(23.2);
    const s = atmo.snapshot;

    expect(s.phase).toBe('night');
    expect(s.nightFactor).toBeGreaterThan(0.85);
    expect(s.volumetricStrength).toBeLessThan(0.02);
    expect(s.sunColor.b).toBeGreaterThan(s.sunColor.r);
    expect(s.lightDir.y).toBeGreaterThanOrEqual(0.159);
  });

  it('ramps rainIntensity, windBoost, and storm thunder when toggling storm', () => {
    let thunderCalls = 0;
    const atmo = createAtmosphereSystem({
      onThunder: () => {
        thunderCalls += 1;
      },
    });

    const stormWeather = atmo.toggleStorm();
    expect(stormWeather).toBe('storm');

    for (let i = 0; i < 80; i += 1) {
      atmo.update(0.1);
    }

    expect(atmo.snapshot.rainIntensity).toBeGreaterThan(0.85);
    expect(atmo.snapshot.windBoost).toBeGreaterThan(1.85);
    expect(atmo.snapshot.stormIntensity).toBeGreaterThan(0.85);
    expect(thunderCalls).toBeGreaterThanOrEqual(1);

    const clearWeather = atmo.toggleStorm();
    expect(clearWeather).toBe('clear');
    for (let i = 0; i < 80; i += 1) {
      atmo.update(0.1);
    }
    expect(atmo.snapshot.rainIntensity).toBeLessThan(0.02);
    expect(atmo.snapshot.windBoost).toBeLessThan(1.05);
  });

  it('cycles cleanly through all key time phases via advancePhase()', () => {
    const atmo = createAtmosphereSystem();
    expect(atmo.snapshot.phase).toBe('golden_hour');

    expect(atmo.advancePhase()).toBe('dusk');
    expect(atmo.advancePhase()).toBe('night');
    expect(atmo.advancePhase()).toBe('dawn');
    expect(atmo.advancePhase()).toBe('morning');
    expect(atmo.advancePhase()).toBe('golden_hour');
  });

  it('resets cleanly back to initial clear Golden Hour state', () => {
    const atmo = createAtmosphereSystem();
    atmo.setTimeHours(23.5);
    atmo.toggleStorm();
    for (let i = 0; i < 30; i += 1) {
      atmo.update(0.1);
    }

    atmo.reset();
    expect(atmo.snapshot.timeHours).toBeCloseTo(17.6, 4);
    expect(atmo.snapshot.phase).toBe('golden_hour');
    expect(atmo.snapshot.weather).toBe('clear');
    expect(atmo.snapshot.rainIntensity).toBe(0);
    expect(atmo.snapshot.windBoost).toBe(1);
    expect(atmo.snapshot.nightFactor).toBeCloseTo(0, 4);
  });
});
