import * as THREE from 'three';
import type { GraphicsQuality } from '../engine/renderer';

export type TimePhase = 'dawn' | 'morning' | 'afternoon' | 'golden_hour' | 'dusk' | 'night';
export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm';

export interface AtmosphereSnapshot {
  timeHours: number;
  phase: TimePhase;
  weather: WeatherKind;
  readonly sunDir: THREE.Vector3;
  readonly moonDir: THREE.Vector3;
  readonly lightDir: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly hemiSkyColor: THREE.Color;
  readonly hemiGroundColor: THREE.Color;
  readonly fogColor: THREE.Color;
  readonly skyHorizonColor: THREE.Color;
  readonly skyMidColor: THREE.Color;
  readonly skyZenithColor: THREE.Color;
  readonly mistColor: THREE.Color;
  sunIntensity: number;
  hemiIntensity: number;
  bounceIntensity: number;
  fogDensity: number;
  exposure: number;
  volumetricStrength: number;
  nightFactor: number;
  rainIntensity: number;
  stormIntensity: number;
  cloudCover: number;
  windBoost: number;
  lightningFlash: number;
}

export interface AtmosphereSystemOptions {
  readonly onThunder?: (intensity: number) => void;
}

export interface AtmosphereSystem {
  readonly snapshot: AtmosphereSnapshot;
  update(dt: number): AtmosphereSnapshot;
  advancePhase(): TimePhase;
  toggleStorm(): WeatherKind;
  setTimeHours(hours: number): void;
  getFormattedClock(): string;
  getPhaseLabel(): string;
  getWeatherLabel(): string;
  reset(): void;
}

export interface RainField {
  readonly mesh: THREE.LineSegments;
  setQuality(quality: GraphicsQuality): void;
  update(
    elapsed: number,
    focusX: number,
    focusY: number,
    focusZ: number,
    rainIntensity: number,
    windBoost: number,
    lightTint: THREE.Color,
  ): void;
  dispose(): void;
}

interface TimeKeyframe {
  readonly hour: number;
  readonly sunColor: THREE.Color;
  readonly hemiSkyColor: THREE.Color;
  readonly hemiGroundColor: THREE.Color;
  readonly fogColor: THREE.Color;
  readonly skyHorizonColor: THREE.Color;
  readonly skyMidColor: THREE.Color;
  readonly skyZenithColor: THREE.Color;
  readonly mistColor: THREE.Color;
  readonly sunIntensity: number;
  readonly hemiIntensity: number;
  readonly bounceIntensity: number;
  readonly fogDensity: number;
  readonly exposure: number;
  readonly volumetricStrength: number;
  readonly nightFactor: number;
}

function linearColor(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r, g, b);
}

const INITIAL_TIME_HOURS = 17.6;
// 24 in-game hours per 360 real seconds (~6 minutes full cycle)
const HOURS_PER_SECOND = 24 / 360;

const PHASE_CYCLE_HOURS: ReadonlyArray<number> = [17.6, 19.6, 23.2, 5.8, 10.0];

const MIDNIGHT_KEYFRAME: TimeKeyframe = {
  hour: 0.0,
  sunColor: new THREE.Color('#86a6d8'),
  hemiSkyColor: new THREE.Color('#253554'),
  hemiGroundColor: new THREE.Color('#0c1317'),
  fogColor: new THREE.Color('#131e30'),
  skyHorizonColor: linearColor(0.048, 0.072, 0.125),
  skyMidColor: linearColor(0.024, 0.04, 0.084),
  skyZenithColor: linearColor(0.008, 0.015, 0.036),
  mistColor: linearColor(0.072, 0.104, 0.165),
  sunIntensity: 0.78,
  hemiIntensity: 0.42,
  bounceIntensity: 0.16,
  fogDensity: 0.0138,
  exposure: 0.94,
  volumetricStrength: 0.0,
  nightFactor: 1.0,
};

const TIME_KEYFRAMES: ReadonlyArray<TimeKeyframe> = [
  MIDNIGHT_KEYFRAME,
  {
    hour: 4.5,
    sunColor: new THREE.Color('#8eaad4'),
    hemiSkyColor: new THREE.Color('#2c3c5c'),
    hemiGroundColor: new THREE.Color('#10181b'),
    fogColor: new THREE.Color('#1b273a'),
    skyHorizonColor: linearColor(0.08, 0.1, 0.16),
    skyMidColor: linearColor(0.04, 0.058, 0.11),
    skyZenithColor: linearColor(0.015, 0.025, 0.055),
    mistColor: linearColor(0.11, 0.14, 0.2),
    sunIntensity: 0.85,
    hemiIntensity: 0.46,
    bounceIntensity: 0.18,
    fogDensity: 0.0132,
    exposure: 0.96,
    volumetricStrength: 0.05,
    nightFactor: 0.88,
  },
  {
    hour: 6.0,
    sunColor: new THREE.Color('#ffb985'),
    hemiSkyColor: new THREE.Color('#c2a596'),
    hemiGroundColor: new THREE.Color('#1e2a1d'),
    fogColor: new THREE.Color('#a48d7a'),
    skyHorizonColor: linearColor(0.84, 0.58, 0.44),
    skyMidColor: linearColor(0.5, 0.46, 0.48),
    skyZenithColor: linearColor(0.18, 0.26, 0.38),
    mistColor: linearColor(0.62, 0.54, 0.48),
    sunIntensity: 2.55,
    hemiIntensity: 0.72,
    bounceIntensity: 0.34,
    fogDensity: 0.0124,
    exposure: 1.02,
    volumetricStrength: 0.82,
    nightFactor: 0.16,
  },
  {
    hour: 9.5,
    sunColor: new THREE.Color('#fff2d6'),
    hemiSkyColor: new THREE.Color('#bfd6ea'),
    hemiGroundColor: new THREE.Color('#253621'),
    fogColor: new THREE.Color('#a9b9b8'),
    skyHorizonColor: linearColor(0.76, 0.82, 0.82),
    skyMidColor: linearColor(0.42, 0.58, 0.72),
    skyZenithColor: linearColor(0.16, 0.32, 0.52),
    mistColor: linearColor(0.62, 0.68, 0.66),
    sunIntensity: 3.45,
    hemiIntensity: 0.96,
    bounceIntensity: 0.48,
    fogDensity: 0.0096,
    exposure: 1.02,
    volumetricStrength: 0.44,
    nightFactor: 0.0,
  },
  {
    hour: 14.2,
    sunColor: new THREE.Color('#ffeed0'),
    hemiSkyColor: new THREE.Color('#c8d8e4'),
    hemiGroundColor: new THREE.Color('#263720'),
    fogColor: new THREE.Color('#aeb9ae'),
    skyHorizonColor: linearColor(0.78, 0.8, 0.74),
    skyMidColor: linearColor(0.46, 0.58, 0.66),
    skyZenithColor: linearColor(0.18, 0.33, 0.48),
    mistColor: linearColor(0.64, 0.67, 0.6),
    sunIntensity: 3.55,
    hemiIntensity: 0.94,
    bounceIntensity: 0.46,
    fogDensity: 0.0098,
    exposure: 1.03,
    volumetricStrength: 0.38,
    nightFactor: 0.0,
  },
  {
    // Exact iconic Milestone 1/2 Golden Hour vista at 17.6 (5:36 PM)
    hour: 17.6,
    sunColor: new THREE.Color('#ffd08a'),
    hemiSkyColor: new THREE.Color('#d6bc8e'),
    hemiGroundColor: new THREE.Color('#202e1d'),
    fogColor: new THREE.Color('#b9a279'),
    skyHorizonColor: linearColor(0.92, 0.74, 0.45),
    skyMidColor: linearColor(0.67, 0.56, 0.43),
    skyZenithColor: linearColor(0.24, 0.32, 0.35),
    mistColor: linearColor(0.71, 0.62, 0.45),
    sunIntensity: 3.7,
    hemiIntensity: 0.82,
    bounceIntensity: 0.42,
    fogDensity: 0.0108,
    exposure: 1.04,
    volumetricStrength: 1.0,
    nightFactor: 0.0,
  },
  {
    hour: 19.6,
    sunColor: new THREE.Color('#e0865c'),
    hemiSkyColor: new THREE.Color('#6c6b86'),
    hemiGroundColor: new THREE.Color('#151d1a'),
    fogColor: new THREE.Color('#4d4b57'),
    skyHorizonColor: linearColor(0.46, 0.27, 0.22),
    skyMidColor: linearColor(0.2, 0.21, 0.3),
    skyZenithColor: linearColor(0.06, 0.09, 0.18),
    mistColor: linearColor(0.28, 0.25, 0.29),
    sunIntensity: 1.45,
    hemiIntensity: 0.56,
    bounceIntensity: 0.24,
    fogDensity: 0.0124,
    exposure: 0.98,
    volumetricStrength: 0.28,
    nightFactor: 0.54,
  },
  {
    hour: 21.4,
    sunColor: new THREE.Color('#88a8da'),
    hemiSkyColor: new THREE.Color('#273858'),
    hemiGroundColor: new THREE.Color('#0d1418'),
    fogColor: new THREE.Color('#162236'),
    skyHorizonColor: linearColor(0.056, 0.082, 0.14),
    skyMidColor: linearColor(0.028, 0.045, 0.092),
    skyZenithColor: linearColor(0.01, 0.018, 0.042),
    mistColor: linearColor(0.082, 0.114, 0.18),
    sunIntensity: 0.82,
    hemiIntensity: 0.44,
    bounceIntensity: 0.17,
    fogDensity: 0.0136,
    exposure: 0.94,
    volumetricStrength: 0.0,
    nightFactor: 0.96,
  },
  {
    ...MIDNIGHT_KEYFRAME,
    hour: 24.0,
  },
];

const WEATHER_ORDER: ReadonlyArray<WeatherKind> = ['clear', 'overcast', 'rain', 'storm', 'overcast'];

function clampVal(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapHours(h: number): number {
  const m = h % 24;
  return m < 0 ? m + 24 : m;
}

function classifyPhase(hours: number): TimePhase {
  if (hours >= 5.2 && hours < 7.6) {
    return 'dawn';
  }
  if (hours >= 7.6 && hours < 12.2) {
    return 'morning';
  }
  if (hours >= 12.2 && hours < 16.5) {
    return 'afternoon';
  }
  if (hours >= 16.5 && hours < 18.8) {
    return 'golden_hour';
  }
  if (hours >= 18.8 && hours < 20.6) {
    return 'dusk';
  }
  return 'night';
}

const WEATHER_TARGETS: Readonly<
  Record<
    WeatherKind,
    { readonly rain: number; readonly storm: number; readonly cloud: number; readonly wind: number }
  >
> = {
  clear: { rain: 0.0, storm: 0.0, cloud: 0.25, wind: 1.0 },
  overcast: { rain: 0.08, storm: 0.0, cloud: 0.68, wind: 1.24 },
  rain: { rain: 0.65, storm: 0.25, cloud: 0.86, wind: 1.58 },
  storm: { rain: 1.0, storm: 1.0, cloud: 0.98, wind: 2.05 },
};

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createAtmosphereSystem(options: AtmosphereSystemOptions = {}): AtmosphereSystem {
  const { onThunder } = options;
  const rng = createSeededRng(826419);

  // Pre-allocated scratch colors so update() allocates ZERO objects per frame
  const stormSlateFog = new THREE.Color('#2f3842');
  const stormSlateSky = linearColor(0.14, 0.17, 0.21);
  const stormSlateMist = linearColor(0.2, 0.24, 0.28);
  const lightningTint = new THREE.Color('#d8e8ff');

  let timeHours = INITIAL_TIME_HOURS;
  let weatherIndex = 0;
  let weatherKind: WeatherKind = 'clear';
  let weatherTimer = 72;

  let rainIntensity = 0;
  let stormIntensity = 0;
  let cloudCover = 0.25;
  let windBoost = 1.0;

  let lightningFlash = 0;
  let lightningTimer = 6.5;
  let pendingThunderDelay = -1;
  let pendingThunderIntensity = 0;

  const snapshot: AtmosphereSnapshot = {
    timeHours: INITIAL_TIME_HOURS,
    phase: 'golden_hour',
    weather: 'clear',
    sunDir: new THREE.Vector3(0.46, 0.25, -0.85).normalize(),
    moonDir: new THREE.Vector3(-0.36, 0.42, -0.83).normalize(),
    lightDir: new THREE.Vector3(0.46, 0.25, -0.85).normalize(),
    sunColor: new THREE.Color('#ffd08a'),
    hemiSkyColor: new THREE.Color('#d6bc8e'),
    hemiGroundColor: new THREE.Color('#202e1d'),
    fogColor: new THREE.Color('#b9a279'),
    skyHorizonColor: linearColor(0.92, 0.74, 0.45),
    skyMidColor: linearColor(0.67, 0.56, 0.43),
    skyZenithColor: linearColor(0.24, 0.32, 0.35),
    mistColor: linearColor(0.71, 0.62, 0.45),
    sunIntensity: 3.7,
    hemiIntensity: 0.82,
    bounceIntensity: 0.42,
    fogDensity: 0.0108,
    exposure: 1.04,
    volumetricStrength: 1.0,
    nightFactor: 0.0,
    rainIntensity: 0.0,
    stormIntensity: 0.0,
    cloudCover: 0.25,
    windBoost: 1.0,
    lightningFlash: 0.0,
  };

  function evaluateSnapshot(): AtmosphereSnapshot {
    const h = wrapHours(timeHours);
    snapshot.timeHours = h;
    snapshot.phase = classifyPhase(h);
    snapshot.weather = weatherKind;

    // Locate surrounding keyframes in TIME_KEYFRAMES
    let k0: TimeKeyframe = TIME_KEYFRAMES[0] ?? MIDNIGHT_KEYFRAME;
    let k1: TimeKeyframe = TIME_KEYFRAMES[TIME_KEYFRAMES.length - 1] ?? MIDNIGHT_KEYFRAME;
    for (let i = 0; i < TIME_KEYFRAMES.length - 1; i += 1) {
      const a = TIME_KEYFRAMES[i];
      const b = TIME_KEYFRAMES[i + 1];
      if (a && b && h >= a.hour && h <= b.hour) {
        k0 = a;
        k1 = b;
        break;
      }
    }

    const span = Math.max(0.0001, k1.hour - k0.hour);
    const rawT = clampVal((h - k0.hour) / span, 0, 1);
    // Smoothstep interpolation avoids harsh slope discontinuities across hours
    const t = rawT * rawT * (3 - 2 * rawT);

    snapshot.sunColor.copy(k0.sunColor).lerp(k1.sunColor, t);
    snapshot.hemiSkyColor.copy(k0.hemiSkyColor).lerp(k1.hemiSkyColor, t);
    snapshot.hemiGroundColor.copy(k0.hemiGroundColor).lerp(k1.hemiGroundColor, t);
    snapshot.fogColor.copy(k0.fogColor).lerp(k1.fogColor, t);
    snapshot.skyHorizonColor.copy(k0.skyHorizonColor).lerp(k1.skyHorizonColor, t);
    snapshot.skyMidColor.copy(k0.skyMidColor).lerp(k1.skyMidColor, t);
    snapshot.skyZenithColor.copy(k0.skyZenithColor).lerp(k1.skyZenithColor, t);
    snapshot.mistColor.copy(k0.mistColor).lerp(k1.mistColor, t);

    snapshot.sunIntensity = k0.sunIntensity + (k1.sunIntensity - k0.sunIntensity) * t;
    snapshot.hemiIntensity = k0.hemiIntensity + (k1.hemiIntensity - k0.hemiIntensity) * t;
    snapshot.bounceIntensity = k0.bounceIntensity + (k1.bounceIntensity - k0.bounceIntensity) * t;
    snapshot.fogDensity = k0.fogDensity + (k1.fogDensity - k0.fogDensity) * t;
    snapshot.exposure = k0.exposure + (k1.exposure - k0.exposure) * t;
    snapshot.volumetricStrength =
      k0.volumetricStrength + (k1.volumetricStrength - k0.volumetricStrength) * t;
    snapshot.nightFactor = k0.nightFactor + (k1.nightFactor - k0.nightFactor) * t;

    // Continuous 24h orbital sun & moon paths matching (0.46, 0.25, -0.85).normalize() at 17.6
    const cycleRad = ((h - 12.4) / 24) * Math.PI * 2;
    const rawSunY = clampVal(Math.cos(cycleRad) * 0.78 + 0.088, -0.85, 0.9);
    const sunHoriz = Math.sqrt(Math.max(0.0001, 1 - rawSunY * rawSunY));
    const sunX = Math.sin(cycleRad) * 0.486 * sunHoriz;
    const sunZ = -Math.sqrt(Math.max(0.01, sunHoriz * sunHoriz - sunX * sunX));
    snapshot.sunDir.set(sunX, rawSunY, sunZ).normalize();

    // Cool silver-blue moon arcs visibly above the northern/valley ridge throughout the night
    const rawMoonY = clampVal(-rawSunY * 0.76 + 0.14, -0.6, 0.78);
    const moonHoriz = Math.sqrt(Math.max(0.0001, 1 - rawMoonY * rawMoonY));
    const moonX = -Math.sin(cycleRad) * 0.44 * moonHoriz;
    const moonZ = -Math.sqrt(Math.max(0.04, moonHoriz * moonHoriz - moonX * moonX));
    snapshot.moonDir.set(moonX, rawMoonY, moonZ).normalize();

    // Directional shadow caster follows sun by day and moon by night (clamped y >= 0.16 for stable shadows)
    const moonBlend = clampVal((snapshot.nightFactor - 0.35) / 0.45, 0, 1);
    snapshot.lightDir.copy(snapshot.sunDir).lerp(snapshot.moonDir, moonBlend);
    if (snapshot.lightDir.y < 0.16) {
      snapshot.lightDir.y = 0.16;
    }
    snapshot.lightDir.normalize();

    // Weather atmosphere modulation: darker storm clouds, denser misty fog, muted sun shafts
    const overcastExcess = clampVal((cloudCover - 0.25) / 0.75, 0, 1);
    const stormFogBlend = overcastExcess * (0.46 * (1 - snapshot.nightFactor * 0.65));
    snapshot.fogColor.lerp(stormSlateFog, stormFogBlend);
    snapshot.skyHorizonColor.lerp(stormSlateSky, overcastExcess * 0.56 * (1 - snapshot.nightFactor * 0.5));
    snapshot.skyMidColor.lerp(stormSlateSky, overcastExcess * 0.48 * (1 - snapshot.nightFactor * 0.5));
    snapshot.mistColor.lerp(stormSlateMist, overcastExcess * 0.52 * (1 - snapshot.nightFactor * 0.5));

    snapshot.sunIntensity *= 1 - overcastExcess * 0.44 * (1 - snapshot.nightFactor * 0.45);
    snapshot.volumetricStrength *= Math.max(0, 1 - overcastExcess * 0.85);
    snapshot.fogDensity += overcastExcess * 0.002 + rainIntensity * 0.0048;

    // Brief sheet-lightning illumination during heavy PNW rainstorms
    if (lightningFlash > 0.005) {
      snapshot.sunIntensity += lightningFlash * 2.4;
      snapshot.hemiIntensity += lightningFlash * 0.75;
      snapshot.sunColor.lerp(lightningTint, clampVal(lightningFlash * 0.72, 0, 0.85));
      snapshot.hemiSkyColor.lerp(lightningTint, clampVal(lightningFlash * 0.55, 0, 0.7));
    }

    snapshot.rainIntensity = rainIntensity;
    snapshot.stormIntensity = stormIntensity;
    snapshot.cloudCover = cloudCover;
    snapshot.windBoost = windBoost;
    snapshot.lightningFlash = lightningFlash;

    return snapshot;
  }

  evaluateSnapshot();

  return {
    snapshot,
    update(dt: number): AtmosphereSnapshot {
      const safeDt = Math.max(0, Math.min(dt, 0.25));
      timeHours = wrapHours(timeHours + safeDt * HOURS_PER_SECOND);

      // Organic Pacific Northwest weather progression
      weatherTimer -= safeDt;
      if (weatherTimer <= 0) {
        weatherIndex = (weatherIndex + 1) % WEATHER_ORDER.length;
        weatherKind = WEATHER_ORDER[weatherIndex] ?? 'clear';
        weatherTimer = weatherKind === 'storm' ? 42 + rng() * 24 : 52 + rng() * 34;
      }

      const targets = WEATHER_TARGETS[weatherKind];
      const weatherAlpha = 1 - Math.exp(-safeDt * 0.85);
      rainIntensity += (targets.rain - rainIntensity) * weatherAlpha;
      stormIntensity += (targets.storm - stormIntensity) * weatherAlpha;
      cloudCover += (targets.cloud - cloudCover) * weatherAlpha;
      windBoost += (targets.wind - windBoost) * weatherAlpha;

      if (rainIntensity < 0.002 && targets.rain === 0) {
        rainIntensity = 0;
      }
      if (stormIntensity < 0.002 && targets.storm === 0) {
        stormIntensity = 0;
      }

      // Sheet lightning & delayed rolling thunder during storms
      if (lightningFlash > 0) {
        lightningFlash = Math.max(0, lightningFlash - safeDt * 3.8);
      }
      if (pendingThunderDelay >= 0) {
        pendingThunderDelay -= safeDt;
        if (pendingThunderDelay <= 0) {
          pendingThunderDelay = -1;
          if (onThunder) {
            onThunder(pendingThunderIntensity);
          }
        }
      }

      if (stormIntensity > 0.45) {
        lightningTimer -= safeDt;
        if (lightningTimer <= 0) {
          lightningFlash = 0.78 + rng() * 0.22;
          pendingThunderIntensity = clampVal(0.55 + stormIntensity * 0.45, 0.4, 1.0);
          pendingThunderDelay = 0.7 + rng() * 1.6;
          lightningTimer = 7.5 + rng() * 12.5;
        }
      } else {
        lightningTimer = Math.min(lightningTimer, 4.5);
      }

      return evaluateSnapshot();
    },
    advancePhase(): TimePhase {
      const h = wrapHours(timeHours);
      let nextHour: number = PHASE_CYCLE_HOURS[0] ?? INITIAL_TIME_HOURS;
      let bestDelta = 25;
      for (let i = 0; i < PHASE_CYCLE_HOURS.length; i += 1) {
        const candidate = PHASE_CYCLE_HOURS[i];
        if (candidate === undefined) {
          continue;
        }
        let delta = candidate - h;
        if (delta <= 0.45) {
          delta += 24;
        }
        if (delta < bestDelta) {
          bestDelta = delta;
          nextHour = candidate;
        }
      }
      timeHours = nextHour;
      evaluateSnapshot();
      return snapshot.phase;
    },
    toggleStorm(): WeatherKind {
      if (weatherKind === 'storm' || weatherKind === 'rain') {
        weatherKind = 'clear';
        weatherIndex = 0;
        weatherTimer = 72;
        lightningFlash = 0;
        pendingThunderDelay = -1;
      } else {
        weatherKind = 'storm';
        weatherIndex = 3;
        weatherTimer = 64;
        lightningTimer = 3.2;
      }
      evaluateSnapshot();
      return weatherKind;
    },
    setTimeHours(hours: number): void {
      timeHours = wrapHours(hours);
      evaluateSnapshot();
    },
    getFormattedClock(): string {
      const h = wrapHours(timeHours);
      const totalMinutes = Math.floor(h * 60) % (24 * 60);
      const hour24 = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;
      const suffix = hour24 >= 12 ? 'PM' : 'AM';
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const paddedMin = minute < 10 ? `0${minute}` : `${minute}`;
      return `${hour12}:${paddedMin} ${suffix}`;
    },
    getPhaseLabel(): string {
      switch (snapshot.phase) {
        case 'dawn':
          return 'Dawn';
        case 'morning':
          return 'Morning';
        case 'afternoon':
          return 'Afternoon';
        case 'golden_hour':
          return 'Golden Hour';
        case 'dusk':
          return 'Dusk';
        case 'night':
          return 'Night';
      }
    },
    getWeatherLabel(): string {
      switch (weatherKind) {
        case 'clear':
          return 'Clear';
        case 'overcast':
          return 'Overcast';
        case 'rain':
          return 'Rain';
        case 'storm':
          return 'Storm';
      }
    },
    reset(): void {
      timeHours = INITIAL_TIME_HOURS;
      weatherIndex = 0;
      weatherKind = 'clear';
      weatherTimer = 72;
      rainIntensity = 0;
      stormIntensity = 0;
      cloudCover = 0.25;
      windBoost = 1.0;
      lightningFlash = 0;
      lightningTimer = 6.5;
      pendingThunderDelay = -1;
      pendingThunderIntensity = 0;
      evaluateSnapshot();
    },
  };
}

const RAIN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uFallPhase;
  uniform float uWindPhase;
  uniform vec3 uAnchor;
  uniform float uRainIntensity;
  uniform float uWindLean;
  attribute float aSeed;
  attribute float aSpeed;
  attribute float aEndpoint;
  varying float vAlpha;

  void main() {
    vec3 boxSize = vec3(42.0, 20.0, 42.0);
    // Monotonically integrated phases prevent raindrops from reversing upward as storms subside
    vec3 drift = vec3(
      uWindPhase * 3.4,
      -aSpeed * uFallPhase,
      uWindPhase * 1.4
    );

    vec3 rel = mod((position + drift) - (uAnchor - boxSize * 0.5), boxSize) - boxSize * 0.5;
    vec3 worldPos = uAnchor + rel;

    // Stretch upper tail along incoming angled raindrop trajectory
    float streakLen = (0.48 + uRainIntensity * 0.44) * aEndpoint;
    worldPos.y += streakLen;
    worldPos.x -= streakLen * uWindLean * 0.34;
    worldPos.z -= streakLen * uWindLean * 0.14;

    vec4 mvPos = modelViewMatrix * vec4(worldPos, 1.0);
    float dist = max(0.8, -mvPos.z);

    float fadeNear = smoothstep(0.8, 2.6, dist);
    float fadeFar = 1.0 - smoothstep(14.0, 27.0, dist);
    float endAlpha = mix(0.92, 0.14, aEndpoint);
    float sparkle = 0.72 + 0.28 * sin(uTime * 18.0 + aSeed * 53.0);
    vAlpha = fadeNear * fadeFar * endAlpha * sparkle * uRainIntensity * 0.46;

    gl_Position = projectionMatrix * mvPos;
  }
`;

const RAIN_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLightTint;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.004) {
      discard;
    }
    vec3 tint = mix(vec3(0.58, 0.67, 0.78), uLightTint, 0.42);
    gl_FragColor = vec4(tint, vAlpha);
  }
`;

export function createRainField(initialQuality: GraphicsQuality): RainField {
  const highCount = 1400;
  const mediumCount = 700;
  const vertCount = highCount * 2;

  const positions = new Float32Array(vertCount * 3);
  const seeds = new Float32Array(vertCount);
  const speeds = new Float32Array(vertCount);
  const endpoints = new Float32Array(vertCount);

  const rng = createSeededRng(418273);
  for (let i = 0; i < highCount; i += 1) {
    const px = (rng() - 0.5) * 42;
    const py = rng() * 20;
    const pz = (rng() - 0.5) * 42;
    const seed = rng();
    const speed = 0.85 + rng() * 0.38;

    const v0 = i * 2;
    const v1 = v0 + 1;

    positions[v0 * 3] = px;
    positions[v0 * 3 + 1] = py;
    positions[v0 * 3 + 2] = pz;
    positions[v1 * 3] = px;
    positions[v1 * 3 + 1] = py;
    positions[v1 * 3 + 2] = pz;

    seeds[v0] = seed;
    seeds[v1] = seed;
    speeds[v0] = speed;
    speeds[v1] = speed;
    endpoints[v0] = 0;
    endpoints[v1] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aEndpoint', new THREE.BufferAttribute(endpoints, 1));
  geometry.setDrawRange(0, (initialQuality === 'high' ? highCount : mediumCount) * 2);

  const anchor = new THREE.Vector3();
  const lightTintUniform = new THREE.Color('#b8cbe0');
  const uniforms = {
    uTime: { value: 0 },
    uFallPhase: { value: 0 },
    uWindPhase: { value: 0 },
    uAnchor: { value: anchor },
    uRainIntensity: { value: 0 },
    uWindLean: { value: 0.2 },
    uLightTint: { value: lightTintUniform },
  };

  let prevElapsed = 0;
  let fallPhase = 0;
  let windPhase = 0;

  const material = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERTEX_SHADER,
    fragmentShader: RAIN_FRAGMENT_SHADER,
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.LineSegments(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 4;
  mesh.userData['excludeFromGtao'] = true;

  return {
    mesh,
    setQuality(quality: GraphicsQuality): void {
      geometry.setDrawRange(0, (quality === 'high' ? highCount : mediumCount) * 2);
    },
    update(
      elapsed: number,
      focusX: number,
      focusY: number,
      focusZ: number,
      rainIntensity: number,
      windBoost: number,
      lightTint: THREE.Color,
    ): void {
      const safeDt =
        elapsed <= 0 || elapsed < prevElapsed ? 0 : Math.min(0.05, elapsed - prevElapsed);
      prevElapsed = elapsed;
      if (elapsed === 0) {
        fallPhase = 0;
        windPhase = 0;
      }

      if (rainIntensity < 0.02) {
        mesh.visible = false;
        return;
      }

      const windLean = 0.14 + Math.max(0, windBoost - 1.0) * 0.42;
      fallPhase = (fallPhase + safeDt * (12.5 + rainIntensity * 6.5)) % 2000;
      windPhase = (windPhase + safeDt * windLean) % 2000;

      mesh.visible = true;
      uniforms.uTime.value = elapsed;
      uniforms.uFallPhase.value = fallPhase;
      uniforms.uWindPhase.value = windPhase;
      anchor.set(focusX, focusY + 5.5, focusZ);
      uniforms.uRainIntensity.value = rainIntensity;
      uniforms.uWindLean.value = windLean;
      lightTintUniform.copy(lightTint);
    },
    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
