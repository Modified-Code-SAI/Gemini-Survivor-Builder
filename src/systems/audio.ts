import type { SurfaceKind } from '../player/controller';

export interface SpatialAudioState {
  readonly windIntensity: number;
  readonly ruinProximity: number;
  readonly ruinPan: number;
  readonly rainIntensity?: number;
  readonly nightFactor?: number;
  readonly isSheltered?: boolean;
  readonly fireProximity?: number;
  readonly firePan?: number;
}

export interface FrontierAudio {
  unlock(): void;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  toggleMute(): boolean;
  playFootstep(surface: SurfaceKind, intensity: number): void;
  playJump(): void;
  playLand(surface: SurfaceKind): void;
  playAttackWhoosh(): void;
  playScavenge(): void;
  playItemUse(): void;
  playBottleThrow(): void;
  playGlassShatter(): void;
  playMeleeHit(heavy: boolean): void;
  playPlayerHurt(): void;
  playAlertSting(level: 'suspicious' | 'alert'): void;
  playThunder(intensity: number): void;
  playFlashlightClick(on: boolean): void;
  playStalkerSound(kind: 'prowl' | 'shriek' | 'recoil'): void;
  playBuildCamp(kind: 'campfire' | 'shelter'): void;
  update(elapsed: number, dt: number, spatial?: SpatialAudioState): void;
  dispose(): void;
}

function createNoiseBuffer(ctx: AudioContext, durationSec: number, brownFactor: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const frameCount = Math.floor(sampleRate * durationSec);
  const buffer = ctx.createBuffer(2, frameCount, sampleRate);

  for (let channel = 0; channel < 2; channel += 1) {
    const output = buffer.getChannelData(channel);
    let last = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + brownFactor * white) / (1 + brownFactor);
      output[i] = last * 3.1;
    }

    const fadeFrames = Math.min(Math.floor(sampleRate * 0.2), Math.floor(frameCount * 0.25));
    for (let i = 0; i < fadeFrames; i += 1) {
      const t = i / fadeFrames;
      const tailIndex = frameCount - fadeFrames + i;
      const headVal = output[i] ?? 0;
      const tailVal = output[tailIndex] ?? 0;
      output[tailIndex] = tailVal * (1 - t) + headVal * t;
    }
  }

  return buffer;
}

function createWhiteBurstBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, frameCount, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function safeDisconnect(node: AudioNode | null): void {
  if (!node) {
    return;
  }
  try {
    node.disconnect();
  } catch {
    // Ignore already-disconnected node
  }
}

export function createFrontierAudio(): FrontierAudio {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let windLowFilter: BiquadFilterNode | null = null;
  let windLowGain: GainNode | null = null;
  let windNeedleFilter: BiquadFilterNode | null = null;
  let windNeedleGain: GainNode | null = null;
  let windNeedlePanner: StereoPannerNode | null = null;
  let rainSource: AudioBufferSourceNode | null = null;
  let rainFilter: BiquadFilterNode | null = null;
  let rainGain: GainNode | null = null;
  let fireSource: AudioBufferSourceNode | null = null;
  let fireFilter: BiquadFilterNode | null = null;
  let fireGain: GainNode | null = null;
  let firePanner: StereoPannerNode | null = null;
  let noiseBurstBuffer: AudioBuffer | null = null;
  let thunderBuffer: AudioBuffer | null = null;
  let windSource: AudioBufferSourceNode | null = null;

  let muted = false;
  let initialized = false;
  let nextBirdCountdown = 6.5;
  let nextOwlCountdown = 8.0;
  let nextCricketCountdown = 2.8;
  let nextCreakCountdown = 5.0;
  let nextFireCrackleCountdown = 0.35;
  let windModAccum = 0.1;

  function teardownAudioGraph(): void {
    if (windSource) {
      try {
        windSource.stop();
      } catch {
        // Ignore source that was never started or already stopped
      }
      safeDisconnect(windSource);
      windSource = null;
    }
    if (rainSource) {
      try {
        rainSource.stop();
      } catch {
        // Ignore source that was never started or already stopped
      }
      safeDisconnect(rainSource);
      rainSource = null;
    }
    if (fireSource) {
      try {
        fireSource.stop();
      } catch {
        // Ignore source that was never started or already stopped
      }
      safeDisconnect(fireSource);
      fireSource = null;
    }
    safeDisconnect(windLowFilter);
    windLowFilter = null;
    safeDisconnect(windLowGain);
    windLowGain = null;
    safeDisconnect(windNeedleFilter);
    windNeedleFilter = null;
    safeDisconnect(windNeedleGain);
    windNeedleGain = null;
    safeDisconnect(windNeedlePanner);
    windNeedlePanner = null;
    safeDisconnect(rainFilter);
    rainFilter = null;
    safeDisconnect(rainGain);
    rainGain = null;
    safeDisconnect(fireFilter);
    fireFilter = null;
    safeDisconnect(fireGain);
    fireGain = null;
    safeDisconnect(firePanner);
    firePanner = null;
    safeDisconnect(masterGain);
    masterGain = null;
    noiseBurstBuffer = null;
    thunderBuffer = null;

    if (ctx) {
      const closing = ctx;
      ctx = null;
      void closing.close().catch(() => {
        // Ignore close rejection on already-closed context
      });
    }
    initialized = false;
  }

  function applyMasterGain(): void {
    if (!ctx || !masterGain) {
      return;
    }
    const target = muted ? 0 : 0.85;
    masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
  }

  function unlock(): void {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
      return;
    }

    if (!initialized) {
      try {
        ctx = new window.AudioContext();
        masterGain = ctx.createGain();
        masterGain.gain.value = muted ? 0 : 0.0001;
        masterGain.connect(ctx.destination);

        const windBuffer = createNoiseBuffer(ctx, 6.0, 0.045);
        const rainBuffer = createNoiseBuffer(ctx, 5.0, 0.34);
        const fireBuffer = createNoiseBuffer(ctx, 4.2, 0.085);
        noiseBurstBuffer = createWhiteBurstBuffer(ctx, 0.45);
        thunderBuffer = createNoiseBuffer(ctx, 2.8, 0.035);

        windSource = ctx.createBufferSource();
        windSource.buffer = windBuffer;
        windSource.loop = true;

        windLowFilter = ctx.createBiquadFilter();
        windLowFilter.type = 'lowpass';
        windLowFilter.frequency.value = 240;
        windLowFilter.Q.value = 0.7;

        windLowGain = ctx.createGain();
        windLowGain.gain.value = 0.24;

        windNeedleFilter = ctx.createBiquadFilter();
        windNeedleFilter.type = 'bandpass';
        windNeedleFilter.frequency.value = 820;
        windNeedleFilter.Q.value = 1.45;

        windNeedleGain = ctx.createGain();
        windNeedleGain.gain.value = 0.055;

        windNeedlePanner = ctx.createStereoPanner();
        windNeedlePanner.pan.value = 0;

        windSource.connect(windLowFilter);
        windLowFilter.connect(windLowGain);
        windLowGain.connect(masterGain);

        windSource.connect(windNeedleFilter);
        windNeedleFilter.connect(windNeedleGain);
        windNeedleGain.connect(windNeedlePanner);
        windNeedlePanner.connect(masterGain);

        // Continuous dynamic rain sheet muffled gently when sheltered under concrete ruins
        rainSource = ctx.createBufferSource();
        rainSource.buffer = rainBuffer;
        rainSource.loop = true;

        rainFilter = ctx.createBiquadFilter();
        rainFilter.type = 'lowpass';
        rainFilter.frequency.value = 2800;
        rainFilter.Q.value = 0.6;

        rainGain = ctx.createGain();
        rainGain.gain.value = 0.0001;

        rainSource.connect(rainFilter);
        rainFilter.connect(rainGain);
        rainGain.connect(masterGain);

        // Warm spatial campfire hearth bed (faded in smoothly by campfire proximity)
        fireSource = ctx.createBufferSource();
        fireSource.buffer = fireBuffer;
        fireSource.loop = true;

        fireFilter = ctx.createBiquadFilter();
        fireFilter.type = 'bandpass';
        fireFilter.frequency.value = 360;
        fireFilter.Q.value = 0.85;

        fireGain = ctx.createGain();
        fireGain.gain.value = 0.0001;

        firePanner = ctx.createStereoPanner();
        firePanner.pan.value = 0;

        fireSource.connect(fireFilter);
        fireFilter.connect(fireGain);
        fireGain.connect(firePanner);
        firePanner.connect(masterGain);

        windSource.start();
        rainSource.start();
        fireSource.start();
        initialized = true;
      } catch {
        // Close and clean up any partially allocated AudioContext/nodes on failure
        teardownAudioGraph();
        return;
      }
    }

    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Ignore resume rejection if not triggered by direct user gesture
      });
    }
    applyMasterGain();
  }

  function triggerDistantBird(): void {
    if (!ctx || !masterGain || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const baseFreq = 2450 + Math.random() * 1150;
    const noteCount = Math.random() > 0.45 ? 2 : 3;

    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() - 0.5) * 1.65;
    panner.connect(masterGain);

    for (let n = 0; n < noteCount; n += 1) {
      const start = now + n * (0.14 + Math.random() * 0.06);
      const dur = 0.11 + Math.random() * 0.08;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      const pitchShift = n === 0 ? 1 : 0.88 + Math.random() * 0.28;
      osc.frequency.setValueAtTime(baseFreq * pitchShift, start);
      osc.frequency.exponentialRampToValueAtTime(
        baseFreq * pitchShift * (0.86 + Math.random() * 0.22),
        start + dur,
      );

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.016 + Math.random() * 0.01, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(panner);

      const isFinalNote = n === noteCount - 1;
      osc.onended = () => {
        safeDisconnect(osc);
        safeDisconnect(gain);
        if (isFinalNote) {
          safeDisconnect(panner);
        }
      };

      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  }

  function triggerSpatialMetalCreak(proximity: number, pan: number): void {
    if (!ctx || !masterGain || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const duration = 0.65 + Math.random() * 0.65;
    const baseHz = 165 + Math.random() * 120;
    const level = Math.min(0.042, proximity * (0.024 + Math.random() * 0.018));

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-0.92, Math.min(0.92, pan));
    panner.connect(masterGain);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(baseHz * 1.9, now);
    filter.frequency.exponentialRampToValueAtTime(baseHz * 1.25, now + duration);
    filter.Q.value = 6.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(level, now + duration * 0.28);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(baseHz, now);
    oscA.frequency.exponentialRampToValueAtTime(baseHz * 0.84, now + duration);

    const oscB = ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.frequency.setValueAtTime(baseHz * 1.03, now);
    oscB.frequency.exponentialRampToValueAtTime(baseHz * 0.81, now + duration);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(panner);

    oscA.onended = () => {
      safeDisconnect(oscA);
    };
    oscB.onended = () => {
      safeDisconnect(oscB);
      safeDisconnect(filter);
      safeDisconnect(gain);
      safeDisconnect(panner);
    };

    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + duration + 0.04);
    oscB.stop(now + duration + 0.04);
  }

  function playFootstep(surface: SurfaceKind, intensity: number): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const vol = Math.min(1, Math.max(0.2, intensity));
    const jitter = 0.9 + Math.random() * 0.22;

    if (surface === 'puddle') {
      const splashSrc = ctx.createBufferSource();
      splashSrc.buffer = noiseBurstBuffer;

      const splashFilter = ctx.createBiquadFilter();
      splashFilter.type = 'bandpass';
      splashFilter.Q.value = 0.95;
      splashFilter.frequency.setValueAtTime(1150 * jitter, now);
      splashFilter.frequency.exponentialRampToValueAtTime(3200 * jitter, now + 0.045);
      splashFilter.frequency.exponentialRampToValueAtTime(980 * jitter, now + 0.19);

      const splashGain = ctx.createGain();
      splashGain.gain.setValueAtTime(0.0001, now);
      splashGain.gain.linearRampToValueAtTime(0.16 * vol, now + 0.012);
      splashGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);

      splashSrc.connect(splashFilter);
      splashFilter.connect(splashGain);
      splashGain.connect(masterGain);
      splashSrc.onended = () => {
        safeDisconnect(splashSrc);
        safeDisconnect(splashFilter);
        safeDisconnect(splashGain);
      };
      splashSrc.start(now);
      splashSrc.stop(now + 0.23);

      for (let d = 0; d < 2; d += 1) {
        const dropStart = now + 0.018 + d * 0.036;
        const dropOsc = ctx.createOscillator();
        const dropGain = ctx.createGain();
        dropOsc.type = 'sine';
        const f0 = (340 + d * 190) * jitter;
        dropOsc.frequency.setValueAtTime(f0, dropStart);
        dropOsc.frequency.exponentialRampToValueAtTime(f0 * 2.15, dropStart + 0.038);

        dropGain.gain.setValueAtTime(0.0001, dropStart);
        dropGain.gain.linearRampToValueAtTime(0.042 * vol, dropStart + 0.006);
        dropGain.gain.exponentialRampToValueAtTime(0.0001, dropStart + 0.045);

        dropOsc.connect(dropGain);
        dropGain.connect(masterGain);
        dropOsc.onended = () => {
          safeDisconnect(dropOsc);
          safeDisconnect(dropGain);
        };
        dropOsc.start(dropStart);
        dropOsc.stop(dropStart + 0.055);
      }

      const wetThud = ctx.createOscillator();
      const wetGain = ctx.createGain();
      wetThud.type = 'sine';
      wetThud.frequency.setValueAtTime(94 * jitter, now);
      wetThud.frequency.exponentialRampToValueAtTime(42 * jitter, now + 0.075);

      wetGain.gain.setValueAtTime(0.0001, now);
      wetGain.gain.linearRampToValueAtTime(0.095 * vol, now + 0.008);
      wetGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);

      wetThud.connect(wetGain);
      wetGain.connect(masterGain);
      wetThud.onended = () => {
        safeDisconnect(wetThud);
        safeDisconnect(wetGain);
      };
      wetThud.start(now);
      wetThud.stop(now + 0.1);
      return;
    }

    const thumpOsc = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thumpOsc.type = 'sine';
    const startHz = (surface === 'asphalt' ? 115 : 82) * jitter;
    const endHz = (surface === 'asphalt' ? 48 : 38) * jitter;
    thumpOsc.frequency.setValueAtTime(startHz, now);
    thumpOsc.frequency.exponentialRampToValueAtTime(endHz, now + 0.085);

    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.linearRampToValueAtTime((surface === 'asphalt' ? 0.14 : 0.11) * vol, now + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

    thumpOsc.connect(thumpGain);
    thumpGain.connect(masterGain);
    thumpOsc.onended = () => {
      safeDisconnect(thumpOsc);
      safeDisconnect(thumpGain);
    };
    thumpOsc.start(now);
    thumpOsc.stop(now + 0.11);

    const gritSrc = ctx.createBufferSource();
    gritSrc.buffer = noiseBurstBuffer;

    const gritFilter = ctx.createBiquadFilter();
    const gritGain = ctx.createGain();
    const gritDur = surface === 'asphalt' ? 0.075 : 0.125;

    if (surface === 'asphalt') {
      gritFilter.type = 'bandpass';
      gritFilter.frequency.value = 1850 * jitter;
      gritFilter.Q.value = 1.25;
      gritGain.gain.setValueAtTime(0.0001, now);
      gritGain.gain.linearRampToValueAtTime(0.095 * vol, now + 0.006);
      gritGain.gain.exponentialRampToValueAtTime(0.0001, now + gritDur);
    } else {
      gritFilter.type = 'bandpass';
      gritFilter.frequency.value = 690 * jitter;
      gritFilter.Q.value = 0.85;
      gritGain.gain.setValueAtTime(0.0001, now);
      gritGain.gain.linearRampToValueAtTime(0.075 * vol, now + 0.015);
      gritGain.gain.exponentialRampToValueAtTime(0.0001, now + gritDur);
    }

    gritSrc.connect(gritFilter);
    gritFilter.connect(gritGain);
    gritGain.connect(masterGain);
    gritSrc.onended = () => {
      safeDisconnect(gritSrc);
      safeDisconnect(gritFilter);
      safeDisconnect(gritGain);
    };
    gritSrc.start(now);
    gritSrc.stop(now + gritDur + 0.02);
  }

  function playJump(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const jitter = 0.92 + Math.random() * 0.16;

    // Subtle canvas jacket/gear rustle
    const rustleSrc = ctx.createBufferSource();
    rustleSrc.buffer = noiseBurstBuffer;

    const rustleFilter = ctx.createBiquadFilter();
    rustleFilter.type = 'bandpass';
    rustleFilter.Q.value = 1.1;
    rustleFilter.frequency.setValueAtTime(480 * jitter, now);
    rustleFilter.frequency.exponentialRampToValueAtTime(920 * jitter, now + 0.13);

    const rustleGain = ctx.createGain();
    rustleGain.gain.setValueAtTime(0.0001, now);
    rustleGain.gain.linearRampToValueAtTime(0.068, now + 0.024);
    rustleGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    rustleSrc.connect(rustleFilter);
    rustleFilter.connect(rustleGain);
    rustleGain.connect(masterGain);
    rustleSrc.onended = () => {
      safeDisconnect(rustleSrc);
      safeDisconnect(rustleFilter);
      safeDisconnect(rustleGain);
    };
    rustleSrc.start(now);
    rustleSrc.stop(now + 0.17);

    // Soft boot push-off impulse
    const pushOsc = ctx.createOscillator();
    const pushGain = ctx.createGain();
    pushOsc.type = 'sine';
    pushOsc.frequency.setValueAtTime(76 * jitter, now);
    pushOsc.frequency.exponentialRampToValueAtTime(132 * jitter, now + 0.06);

    pushGain.gain.setValueAtTime(0.0001, now);
    pushGain.gain.linearRampToValueAtTime(0.078, now + 0.01);
    pushGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

    pushOsc.connect(pushGain);
    pushGain.connect(masterGain);
    pushOsc.onended = () => {
      safeDisconnect(pushOsc);
      safeDisconnect(pushGain);
    };
    pushOsc.start(now);
    pushOsc.stop(now + 0.09);
  }

  function playLand(surface: SurfaceKind): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const jitter = 0.92 + Math.random() * 0.16;

    // Heavier grounded boot impact thud
    const thudOsc = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thudOsc.type = 'sine';
    thudOsc.frequency.setValueAtTime((surface === 'asphalt' ? 124 : 96) * jitter, now);
    thudOsc.frequency.exponentialRampToValueAtTime(34 * jitter, now + 0.13);

    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(surface === 'asphalt' ? 0.22 : 0.18, now + 0.009);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.145);

    thudOsc.connect(thudGain);
    thudGain.connect(masterGain);
    thudOsc.onended = () => {
      safeDisconnect(thudOsc);
      safeDisconnect(thudGain);
    };
    thudOsc.start(now);
    thudOsc.stop(now + 0.16);

    if (surface === 'puddle') {
      // Larger double-boot wet water splash + scattered droplets
      const splashSrc = ctx.createBufferSource();
      splashSrc.buffer = noiseBurstBuffer;

      const splashFilter = ctx.createBiquadFilter();
      splashFilter.type = 'bandpass';
      splashFilter.Q.value = 0.82;
      splashFilter.frequency.setValueAtTime(920 * jitter, now);
      splashFilter.frequency.exponentialRampToValueAtTime(3600 * jitter, now + 0.055);
      splashFilter.frequency.exponentialRampToValueAtTime(760 * jitter, now + 0.31);

      const splashGain = ctx.createGain();
      splashGain.gain.setValueAtTime(0.0001, now);
      splashGain.gain.linearRampToValueAtTime(0.24, now + 0.014);
      splashGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.33);

      splashSrc.connect(splashFilter);
      splashFilter.connect(splashGain);
      splashGain.connect(masterGain);
      splashSrc.onended = () => {
        safeDisconnect(splashSrc);
        safeDisconnect(splashFilter);
        safeDisconnect(splashGain);
      };
      splashSrc.start(now);
      splashSrc.stop(now + 0.36);

      for (let d = 0; d < 3; d += 1) {
        const dropStart = now + 0.02 + d * 0.042;
        const dropOsc = ctx.createOscillator();
        const dropGain = ctx.createGain();
        dropOsc.type = 'sine';
        const f0 = (310 + d * 185) * jitter;
        dropOsc.frequency.setValueAtTime(f0, dropStart);
        dropOsc.frequency.exponentialRampToValueAtTime(f0 * 2.25, dropStart + 0.042);

        dropGain.gain.setValueAtTime(0.0001, dropStart);
        dropGain.gain.linearRampToValueAtTime(0.055, dropStart + 0.007);
        dropGain.gain.exponentialRampToValueAtTime(0.0001, dropStart + 0.055);

        dropOsc.connect(dropGain);
        dropGain.connect(masterGain);
        dropOsc.onended = () => {
          safeDisconnect(dropOsc);
          safeDisconnect(dropGain);
        };
        dropOsc.start(dropStart);
        dropOsc.stop(dropStart + 0.068);
      }
      return;
    }

    // Gravel crunch (asphalt) or damp pine-duff compression (forest)
    const impactSrc = ctx.createBufferSource();
    impactSrc.buffer = noiseBurstBuffer;

    const impactFilter = ctx.createBiquadFilter();
    const impactGain = ctx.createGain();
    const impactDur = surface === 'asphalt' ? 0.13 : 0.175;

    impactFilter.type = 'bandpass';
    impactFilter.frequency.value = (surface === 'asphalt' ? 1750 : 560) * jitter;
    impactFilter.Q.value = surface === 'asphalt' ? 1.1 : 0.8;

    impactGain.gain.setValueAtTime(0.0001, now);
    impactGain.gain.linearRampToValueAtTime(surface === 'asphalt' ? 0.145 : 0.13, now + 0.01);
    impactGain.gain.exponentialRampToValueAtTime(0.0001, now + impactDur);

    impactSrc.connect(impactFilter);
    impactFilter.connect(impactGain);
    impactGain.connect(masterGain);
    impactSrc.onended = () => {
      safeDisconnect(impactSrc);
      safeDisconnect(impactFilter);
      safeDisconnect(impactGain);
    };
    impactSrc.start(now);
    impactSrc.stop(now + impactDur + 0.025);
  }

  function playAttackWhoosh(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const jitter = 0.94 + Math.random() * 0.12;

    // Punchy band-pass wind-slash sweep matching diagonal melee swing peak
    const whooshSrc = ctx.createBufferSource();
    whooshSrc.buffer = noiseBurstBuffer;

    const whooshFilter = ctx.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.Q.value = 2.35;
    whooshFilter.frequency.setValueAtTime(260 * jitter, now);
    whooshFilter.frequency.exponentialRampToValueAtTime(1420 * jitter, now + 0.085);
    whooshFilter.frequency.exponentialRampToValueAtTime(340 * jitter, now + 0.27);

    const whooshGain = ctx.createGain();
    whooshGain.gain.setValueAtTime(0.0001, now);
    whooshGain.gain.linearRampToValueAtTime(0.22, now + 0.075);
    whooshGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.29);

    whooshSrc.connect(whooshFilter);
    whooshFilter.connect(whooshGain);
    whooshGain.connect(masterGain);
    whooshSrc.onended = () => {
      safeDisconnect(whooshSrc);
      safeDisconnect(whooshFilter);
      safeDisconnect(whooshGain);
    };
    whooshSrc.start(now);
    whooshSrc.stop(now + 0.32);

    // Subtle low-end arm-torque air punch
    const torqueOsc = ctx.createOscillator();
    const torqueGain = ctx.createGain();
    torqueOsc.type = 'triangle';
    torqueOsc.frequency.setValueAtTime(155 * jitter, now + 0.02);
    torqueOsc.frequency.exponentialRampToValueAtTime(52 * jitter, now + 0.16);

    torqueGain.gain.setValueAtTime(0.0001, now + 0.02);
    torqueGain.gain.linearRampToValueAtTime(0.095, now + 0.06);
    torqueGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    torqueOsc.connect(torqueGain);
    torqueGain.connect(masterGain);
    torqueOsc.onended = () => {
      safeDisconnect(torqueOsc);
      safeDisconnect(torqueGain);
    };
    torqueOsc.start(now + 0.02);
    torqueOsc.stop(now + 0.2);
  }

  function playScavenge(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    // Canvas zipper / pack rummage double-rustle
    for (let i = 0; i < 2; i += 1) {
      const start = now + i * 0.11;
      const src = ctx.createBufferSource();
      src.buffer = noiseBurstBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.6;
      filter.frequency.setValueAtTime(i === 0 ? 1150 : 1650, start);
      filter.frequency.exponentialRampToValueAtTime(i === 0 ? 2400 : 880, start + 0.11);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.11 : 0.085, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      src.onended = () => {
        safeDisconnect(src);
        safeDisconnect(filter);
        safeDisconnect(gain);
      };
      src.start(start);
      src.stop(start + 0.15);
    }

    // Subtle tactile brass latch/zipper click
    const latchOsc = ctx.createOscillator();
    const latchGain = ctx.createGain();
    latchOsc.type = 'triangle';
    latchOsc.frequency.setValueAtTime(640, now + 0.05);
    latchOsc.frequency.exponentialRampToValueAtTime(290, now + 0.11);

    latchGain.gain.setValueAtTime(0.0001, now + 0.05);
    latchGain.gain.linearRampToValueAtTime(0.065, now + 0.058);
    latchGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    latchOsc.connect(latchGain);
    latchGain.connect(masterGain);
    latchOsc.onended = () => {
      safeDisconnect(latchOsc);
      safeDisconnect(latchGain);
    };
    latchOsc.start(now + 0.05);
    latchOsc.stop(now + 0.13);
  }

  function playItemUse(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    // Soft cloth rustle
    const rustle = ctx.createBufferSource();
    rustle.buffer = noiseBurstBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 980;
    filter.Q.value = 1.2;
    const rGain = ctx.createGain();
    rGain.gain.setValueAtTime(0.0001, now);
    rGain.gain.linearRampToValueAtTime(0.075, now + 0.03);
    rGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    rustle.connect(filter);
    filter.connect(rGain);
    rGain.connect(masterGain);
    rustle.onended = () => {
      safeDisconnect(rustle);
      safeDisconnect(filter);
      safeDisconnect(rGain);
    };
    rustle.start(now);
    rustle.stop(now + 0.2);

    // Warm subtle acoustic 2-note relief chime
    const notes: readonly number[] = [392, 523.25];
    for (let i = 0; i < notes.length; i += 1) {
      const freq = notes[i];
      if (!freq) continue;
      const start = now + i * 0.075;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.05, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.onended = () => {
        safeDisconnect(osc);
        safeDisconnect(gain);
      };
      osc.start(start);
      osc.stop(start + 0.26);
    }
  }

  function playBottleThrow(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBurstBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(480, now);
    filter.frequency.exponentialRampToValueAtTime(1450, now + 0.09);
    filter.frequency.exponentialRampToValueAtTime(620, now + 0.16);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.13, now + 0.045);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.onended = () => {
      safeDisconnect(src);
      safeDisconnect(filter);
      safeDisconnect(gain);
    };
    src.start(now);
    src.stop(now + 0.19);
  }

  function playGlassShatter(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const jitter = 0.94 + Math.random() * 0.14;

    // High-frequency glass shard scatter noise
    const shardSrc = ctx.createBufferSource();
    shardSrc.buffer = noiseBurstBuffer;

    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(3200 * jitter, now);
    hpFilter.Q.value = 0.9;

    const shardGain = ctx.createGain();
    shardGain.gain.setValueAtTime(0.0001, now);
    shardGain.gain.linearRampToValueAtTime(0.24, now + 0.008);
    shardGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);

    shardSrc.connect(hpFilter);
    hpFilter.connect(shardGain);
    shardGain.connect(masterGain);
    shardSrc.onended = () => {
      safeDisconnect(shardSrc);
      safeDisconnect(hpFilter);
      safeDisconnect(shardGain);
    };
    shardSrc.start(now);
    shardSrc.stop(now + 0.36);

    // Crystalline glass ringing clinks
    const clinkFreqs: readonly number[] = [2850, 3940, 5120, 3380];
    for (let i = 0; i < clinkFreqs.length; i += 1) {
      const f = clinkFreqs[i];
      if (!f) continue;
      const start = now + i * 0.022;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f * jitter, start);
      osc.frequency.exponentialRampToValueAtTime(f * jitter * 0.93, start + 0.14);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.068 - i * 0.01, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      osc.connect(gain);
      gain.connect(masterGain);
      osc.onended = () => {
        safeDisconnect(osc);
        safeDisconnect(gain);
      };
      osc.start(start);
      osc.stop(start + 0.18);
    }
  }

  function playMeleeHit(heavy: boolean): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const jitter = 0.93 + Math.random() * 0.14;

    // Visceral low punch impact thud
    const thudOsc = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thudOsc.type = 'sine';
    thudOsc.frequency.setValueAtTime((heavy ? 148 : 128) * jitter, now);
    thudOsc.frequency.exponentialRampToValueAtTime((heavy ? 30 : 40) * jitter, now + (heavy ? 0.19 : 0.13));

    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(heavy ? 0.34 : 0.26, now + 0.008);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + (heavy ? 0.21 : 0.15));

    thudOsc.connect(thudGain);
    thudGain.connect(masterGain);
    thudOsc.onended = () => {
      safeDisconnect(thudOsc);
      safeDisconnect(thudGain);
    };
    thudOsc.start(now);
    thudOsc.stop(now + (heavy ? 0.23 : 0.17));

    // Crisp impact crack
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = noiseBurstBuffer;

    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.value = (heavy ? 1350 : 1750) * jitter;
    crackFilter.Q.value = 1.1;

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, now);
    crackGain.gain.linearRampToValueAtTime(heavy ? 0.24 : 0.18, now + 0.006);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    crackSrc.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(masterGain);
    crackSrc.onended = () => {
      safeDisconnect(crackSrc);
      safeDisconnect(crackFilter);
      safeDisconnect(crackGain);
    };
    crackSrc.start(now);
    crackSrc.stop(now + 0.13);
  }

  function playPlayerHurt(): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;

    // Heavy muffled body hit + sub rumble
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'triangle';
    subOsc.frequency.setValueAtTime(98, now);
    subOsc.frequency.exponentialRampToValueAtTime(28, now + 0.28);

    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(0.32, now + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

    subOsc.connect(subGain);
    subGain.connect(masterGain);
    subOsc.onended = () => {
      safeDisconnect(subOsc);
      safeDisconnect(subGain);
    };
    subOsc.start(now);
    subOsc.stop(now + 0.34);

    const hitSrc = ctx.createBufferSource();
    hitSrc.buffer = noiseBurstBuffer;

    const hitFilter = ctx.createBiquadFilter();
    hitFilter.type = 'lowpass';
    hitFilter.frequency.setValueAtTime(620, now);
    hitFilter.frequency.exponentialRampToValueAtTime(160, now + 0.2);

    const hitGain = ctx.createGain();
    hitGain.gain.setValueAtTime(0.0001, now);
    hitGain.gain.linearRampToValueAtTime(0.22, now + 0.01);
    hitGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    hitSrc.connect(hitFilter);
    hitFilter.connect(hitGain);
    hitGain.connect(masterGain);
    hitSrc.onended = () => {
      safeDisconnect(hitSrc);
      safeDisconnect(hitFilter);
      safeDisconnect(hitGain);
    };
    hitSrc.start(now);
    hitSrc.stop(now + 0.24);
  }

  function playAlertSting(level: 'suspicious' | 'alert'): void {
    if (!ctx || !masterGain || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const dur = level === 'alert' ? 0.95 : 0.72;
    const baseHz = level === 'alert' ? 82.4 : 92.5;
    const upperHz = level === 'alert' ? 116.54 : 138.59; // Dark tritone vs tense fifth/minor swell
    const peakGain = level === 'alert' ? 0.14 : 0.085;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(level === 'alert' ? 540 : 340, now);
    filter.frequency.exponentialRampToValueAtTime(level === 'alert' ? 980 : 520, now + dur * 0.35);
    filter.frequency.exponentialRampToValueAtTime(190, now + dur);
    filter.Q.value = 1.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + (level === 'alert' ? 0.07 : 0.18));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const oscLow = ctx.createOscillator();
    oscLow.type = 'sawtooth';
    oscLow.frequency.setValueAtTime(baseHz, now);
    oscLow.frequency.exponentialRampToValueAtTime(baseHz * 0.96, now + dur);

    const oscHigh = ctx.createOscillator();
    oscHigh.type = 'triangle';
    oscHigh.frequency.setValueAtTime(upperHz, now);
    oscHigh.frequency.exponentialRampToValueAtTime(upperHz * (level === 'alert' ? 1.03 : 0.98), now + dur);

    oscLow.connect(filter);
    oscHigh.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    oscLow.onended = () => {
      safeDisconnect(oscLow);
    };
    oscHigh.onended = () => {
      safeDisconnect(oscHigh);
      safeDisconnect(filter);
      safeDisconnect(gain);
    };

    oscLow.start(now);
    oscHigh.start(now);
    oscLow.stop(now + dur + 0.03);
    oscHigh.stop(now + dur + 0.03);
  }

  function triggerDistantOwl(): void {
    if (!ctx || !masterGain || muted || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    const baseHz = 295 + Math.random() * 48;
    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() - 0.5) * 1.7;
    panner.connect(masterGain);

    // Classic Pacific Northwest 3-note barred-owl nocturnal hoot
    const offsets: ReadonlyArray<readonly [number, number, number]> = [
      [0.0, 0.28, 1.0],
      [0.42, 0.22, 0.96],
      [0.74, 0.42, 0.84],
    ];
    for (let i = 0; i < offsets.length; i += 1) {
      const tuple = offsets[i];
      if (!tuple) continue;
      const [delay, dur, pitchMul] = tuple;
      const start = now + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseHz * pitchMul, start);
      osc.frequency.exponentialRampToValueAtTime(baseHz * pitchMul * 0.92, start + dur);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.022, start + 0.055);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(panner);
      const isLast = i === offsets.length - 1;
      osc.onended = () => {
        safeDisconnect(osc);
        safeDisconnect(gain);
        if (isLast) {
          safeDisconnect(panner);
        }
      };
      osc.start(start);
      osc.stop(start + dur + 0.03);
    }
  }

  function triggerNightCricket(): void {
    if (!ctx || !masterGain || muted || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    const freq = 4120 + Math.random() * 480;
    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() - 0.5) * 1.65;
    panner.connect(masterGain);

    const pulses = 3;
    for (let p = 0; p < pulses; p += 1) {
      const start = now + p * 0.058;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.009, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.042);

      osc.connect(gain);
      gain.connect(panner);
      const isLast = p === pulses - 1;
      osc.onended = () => {
        safeDisconnect(osc);
        safeDisconnect(gain);
        if (isLast) {
          safeDisconnect(panner);
        }
      };
      osc.start(start);
      osc.stop(start + 0.05);
    }
  }

  function playThunder(intensity: number): void {
    if (!ctx || !masterGain || !thunderBuffer || muted || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    const amp = Math.min(1, Math.max(0.25, intensity));

    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() - 0.5) * 1.1;
    panner.connect(masterGain);

    const src = ctx.createBufferSource();
    src.buffer = thunderBuffer;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(420 * amp + 140, now);
    lp.frequency.exponentialRampToValueAtTime(160, now + 0.45);
    lp.frequency.exponentialRampToValueAtTime(62, now + 2.5);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.32 * amp, now + 0.08);
    gain.gain.linearRampToValueAtTime(0.18 * amp, now + 0.52);
    gain.gain.linearRampToValueAtTime(0.22 * amp, now + 0.82);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.65);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(panner);

    src.onended = () => {
      safeDisconnect(src);
      safeDisconnect(lp);
      safeDisconnect(gain);
      safeDisconnect(panner);
    };
    src.start(now);
    src.stop(now + 2.75);
  }

  function playFlashlightClick(on: boolean): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;

    // Crisp mechanical switch detent click
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(on ? 1680 : 1240, now);
    osc.frequency.exponentialRampToValueAtTime(on ? 620 : 420, now + 0.028);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

    osc.connect(gain);
    gain.connect(masterGain);
    osc.onended = () => {
      safeDisconnect(osc);
      safeDisconnect(gain);
    };
    osc.start(now);
    osc.stop(now + 0.04);

    const snap = ctx.createBufferSource();
    snap.buffer = noiseBurstBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = on ? 2600 : 1900;
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.0001, now);
    sGain.gain.linearRampToValueAtTime(0.085, now + 0.002);
    sGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);

    snap.connect(hp);
    hp.connect(sGain);
    sGain.connect(masterGain);
    snap.onended = () => {
      safeDisconnect(snap);
      safeDisconnect(hp);
      safeDisconnect(sGain);
    };
    snap.start(now);
    snap.stop(now + 0.035);
  }

  function playStalkerSound(kind: 'prowl' | 'shriek' | 'recoil'): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;

    if (kind === 'prowl') {
      // Eerie dry-wood / hollow jaw rattle clicking through the pines
      const panner = ctx.createStereoPanner();
      panner.pan.value = (Math.random() - 0.5) * 1.25;
      panner.connect(masterGain);

      const clicks = 3;
      for (let c = 0; c < clicks; c += 1) {
        const start = now + c * (0.09 + Math.random() * 0.04);
        const src = ctx.createBufferSource();
        src.buffer = noiseBurstBuffer;

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(640 + c * 185 + Math.random() * 90, start);
        bp.Q.value = 7.5;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(0.11, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.065);

        src.connect(bp);
        bp.connect(g);
        g.connect(panner);
        const isLast = c === clicks - 1;
        src.onended = () => {
          safeDisconnect(src);
          safeDisconnect(bp);
          safeDisconnect(g);
          if (isLast) {
            safeDisconnect(panner);
          }
        };
        src.start(start);
        src.stop(start + 0.08);
      }
      return;
    }

    if (kind === 'recoil') {
      // Light-blinded hollow hiss & startled low predator groan
      const hissSrc = ctx.createBufferSource();
      hissSrc.buffer = noiseBurstBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2.6;
      bp.frequency.setValueAtTime(1480, now);
      bp.frequency.exponentialRampToValueAtTime(340, now + 0.42);
      const hGain = ctx.createGain();
      hGain.gain.setValueAtTime(0.0001, now);
      hGain.gain.linearRampToValueAtTime(0.18, now + 0.025);
      hGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.43);

      hissSrc.connect(bp);
      bp.connect(hGain);
      hGain.connect(masterGain);
      hissSrc.onended = () => {
        safeDisconnect(hissSrc);
        safeDisconnect(bp);
        safeDisconnect(hGain);
      };
      hissSrc.start(now);
      hissSrc.stop(now + 0.44);

      const groan = ctx.createOscillator();
      const gFilter = ctx.createBiquadFilter();
      const gGain = ctx.createGain();
      groan.type = 'sawtooth';
      groan.frequency.setValueAtTime(215, now);
      groan.frequency.exponentialRampToValueAtTime(86, now + 0.55);
      gFilter.type = 'lowpass';
      gFilter.frequency.value = 540;
      gGain.gain.setValueAtTime(0.0001, now);
      gGain.gain.linearRampToValueAtTime(0.13, now + 0.04);
      gGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);

      groan.connect(gFilter);
      gFilter.connect(gGain);
      gGain.connect(masterGain);
      groan.onended = () => {
        safeDisconnect(groan);
        safeDisconnect(gFilter);
        safeDisconnect(gGain);
      };
      groan.start(now);
      groan.stop(now + 0.6);
      return;
    }

    // 'shriek': chilling hollow forest predator shriek on aggro
    const dur = 0.85;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3.2;
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(1420, now + 0.22);
    filter.frequency.exponentialRampToValueAtTime(360, now + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.17, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(260, now);
    oscA.frequency.exponentialRampToValueAtTime(640, now + 0.2);
    oscA.frequency.exponentialRampToValueAtTime(175, now + dur);

    const oscB = ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.setValueAtTime(274, now);
    oscB.frequency.exponentialRampToValueAtTime(682, now + 0.22);
    oscB.frequency.exponentialRampToValueAtTime(162, now + dur);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    oscA.onended = () => {
      safeDisconnect(oscA);
    };
    oscB.onended = () => {
      safeDisconnect(oscB);
      safeDisconnect(filter);
      safeDisconnect(gain);
    };
    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + dur + 0.03);
    oscB.stop(now + dur + 0.03);
  }

  function triggerFireCrackle(proximity: number, pan: number): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;
    const prox = Math.max(0, Math.min(1, proximity));
    const clampedPan = Math.max(-0.92, Math.min(0.92, pan));

    const panner = ctx.createStereoPanner();
    panner.pan.value = clampedPan;
    panner.connect(masterGain);

    const pops = Math.random() > 0.55 ? 2 : 1;
    for (let i = 0; i < pops; i += 1) {
      const start = now + i * (0.032 + Math.random() * 0.048);
      const dur = 0.022 + Math.random() * 0.028;

      const src = ctx.createBufferSource();
      src.buffer = noiseBurstBuffer;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2400 + Math.random() * 2600, start);
      bp.Q.value = 2.6 + Math.random() * 2.2;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(prox * (0.075 + Math.random() * 0.065), start + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      src.connect(bp);
      bp.connect(gain);
      gain.connect(panner);

      const isFinalPop = i === pops - 1;
      src.onended = () => {
        safeDisconnect(src);
        safeDisconnect(bp);
        safeDisconnect(gain);
        if (isFinalPop) {
          safeDisconnect(panner);
        }
      };

      src.start(start);
      src.stop(start + dur + 0.015);
    }

    // Occasional cedar-sap woody snap undertone
    if (Math.random() > 0.52) {
      const popOsc = ctx.createOscillator();
      const popGain = ctx.createGain();
      const popPanner = ctx.createStereoPanner();
      popPanner.pan.value = clampedPan;
      popOsc.type = 'triangle';
      const baseHz = 360 + Math.random() * 280;
      popOsc.frequency.setValueAtTime(baseHz, now);
      popOsc.frequency.exponentialRampToValueAtTime(baseHz * 0.42, now + 0.026);

      popGain.gain.setValueAtTime(0.0001, now);
      popGain.gain.linearRampToValueAtTime(prox * 0.048, now + 0.003);
      popGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

      popOsc.connect(popGain);
      popGain.connect(popPanner);
      popPanner.connect(masterGain);
      popOsc.onended = () => {
        safeDisconnect(popOsc);
        safeDisconnect(popGain);
        safeDisconnect(popPanner);
      };
      popOsc.start(now);
      popOsc.stop(now + 0.04);
    }
  }

  function playBuildCamp(kind: 'campfire' | 'shelter'): void {
    if (!ctx || !masterGain || !noiseBurstBuffer || muted || ctx.state !== 'running') {
      return;
    }

    const now = ctx.currentTime;

    if (kind === 'campfire') {
      // Crisp flint-and-steel double spark click
      for (let s = 0; s < 2; s += 1) {
        const start = now + s * 0.088;
        const sparkOsc = ctx.createOscillator();
        const sparkGain = ctx.createGain();
        sparkOsc.type = 'triangle';
        sparkOsc.frequency.setValueAtTime(s === 0 ? 3150 : 3520, start);
        sparkOsc.frequency.exponentialRampToValueAtTime(1180, start + 0.024);

        sparkGain.gain.setValueAtTime(0.0001, start);
        sparkGain.gain.linearRampToValueAtTime(0.085, start + 0.002);
        sparkGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.03);

        sparkOsc.connect(sparkGain);
        sparkGain.connect(masterGain);
        sparkOsc.onended = () => {
          safeDisconnect(sparkOsc);
          safeDisconnect(sparkGain);
        };
        sparkOsc.start(start);
        sparkOsc.stop(start + 0.038);

        const grit = ctx.createBufferSource();
        grit.buffer = noiseBurstBuffer;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 3400;
        const gGain = ctx.createGain();
        gGain.gain.setValueAtTime(0.0001, start);
        gGain.gain.linearRampToValueAtTime(0.11, start + 0.002);
        gGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.032);

        grit.connect(hp);
        hp.connect(gGain);
        gGain.connect(masterGain);
        grit.onended = () => {
          safeDisconnect(grit);
          safeDisconnect(hp);
          safeDisconnect(gGain);
        };
        grit.start(start);
        grit.stop(start + 0.042);
      }

      // Warm rushing dry-kindling ignition whoosh
      const ignStart = now + 0.14;
      const whooshSrc = ctx.createBufferSource();
      whooshSrc.buffer = noiseBurstBuffer;

      const whooshFilter = ctx.createBiquadFilter();
      whooshFilter.type = 'bandpass';
      whooshFilter.Q.value = 1.25;
      whooshFilter.frequency.setValueAtTime(220, ignStart);
      whooshFilter.frequency.exponentialRampToValueAtTime(980, ignStart + 0.16);
      whooshFilter.frequency.exponentialRampToValueAtTime(320, ignStart + 0.42);

      const whooshGain = ctx.createGain();
      whooshGain.gain.setValueAtTime(0.0001, ignStart);
      whooshGain.gain.linearRampToValueAtTime(0.24, ignStart + 0.12);
      whooshGain.gain.exponentialRampToValueAtTime(0.0001, ignStart + 0.44);

      whooshSrc.connect(whooshFilter);
      whooshFilter.connect(whooshGain);
      whooshGain.connect(masterGain);
      whooshSrc.onended = () => {
        safeDisconnect(whooshSrc);
        safeDisconnect(whooshFilter);
        safeDisconnect(whooshGain);
      };
      whooshSrc.start(ignStart);
      whooshSrc.stop(ignStart + 0.44);

      // Subtle warm low flame bloom
      const bloomOsc = ctx.createOscillator();
      const bloomGain = ctx.createGain();
      bloomOsc.type = 'sine';
      bloomOsc.frequency.setValueAtTime(118, ignStart);
      bloomOsc.frequency.exponentialRampToValueAtTime(58, ignStart + 0.34);

      bloomGain.gain.setValueAtTime(0.0001, ignStart);
      bloomGain.gain.linearRampToValueAtTime(0.11, ignStart + 0.06);
      bloomGain.gain.exponentialRampToValueAtTime(0.0001, ignStart + 0.36);

      bloomOsc.connect(bloomGain);
      bloomGain.connect(masterGain);
      bloomOsc.onended = () => {
        safeDisconnect(bloomOsc);
        safeDisconnect(bloomGain);
      };
      bloomOsc.start(ignStart);
      bloomOsc.stop(ignStart + 0.39);
      return;
    }

    // 'shelter': two heavy timber-post thuds into soil + crisp olive-canvas tarp snap
    for (let t = 0; t < 2; t += 1) {
      const start = now + t * 0.18;
      const thudOsc = ctx.createOscillator();
      const thudGain = ctx.createGain();
      thudOsc.type = 'triangle';
      thudOsc.frequency.setValueAtTime(t === 0 ? 132 : 114, start);
      thudOsc.frequency.exponentialRampToValueAtTime(38, start + 0.14);

      thudGain.gain.setValueAtTime(0.0001, start);
      thudGain.gain.linearRampToValueAtTime(0.24, start + 0.009);
      thudGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      thudOsc.connect(thudGain);
      thudGain.connect(masterGain);
      thudOsc.onended = () => {
        safeDisconnect(thudOsc);
        safeDisconnect(thudGain);
      };
      thudOsc.start(start);
      thudOsc.stop(start + 0.18);

      const knockSrc = ctx.createBufferSource();
      knockSrc.buffer = noiseBurstBuffer;
      const knockBp = ctx.createBiquadFilter();
      knockBp.type = 'bandpass';
      knockBp.frequency.value = t === 0 ? 480 : 410;
      knockBp.Q.value = 1.9;
      const knockGain = ctx.createGain();
      knockGain.gain.setValueAtTime(0.0001, start);
      knockGain.gain.linearRampToValueAtTime(0.15, start + 0.006);
      knockGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.095);

      knockSrc.connect(knockBp);
      knockBp.connect(knockGain);
      knockGain.connect(masterGain);
      knockSrc.onended = () => {
        safeDisconnect(knockSrc);
        safeDisconnect(knockBp);
        safeDisconnect(knockGain);
      };
      knockSrc.start(start);
      knockSrc.stop(start + 0.11);
    }

    const tarpStart = now + 0.34;
    const tarpSrc = ctx.createBufferSource();
    tarpSrc.buffer = noiseBurstBuffer;
    const tarpBp = ctx.createBiquadFilter();
    tarpBp.type = 'bandpass';
    tarpBp.Q.value = 1.3;
    tarpBp.frequency.setValueAtTime(860, tarpStart);
    tarpBp.frequency.exponentialRampToValueAtTime(2150, tarpStart + 0.08);
    tarpBp.frequency.exponentialRampToValueAtTime(640, tarpStart + 0.24);

    const tarpGain = ctx.createGain();
    tarpGain.gain.setValueAtTime(0.0001, tarpStart);
    tarpGain.gain.linearRampToValueAtTime(0.17, tarpStart + 0.045);
    tarpGain.gain.exponentialRampToValueAtTime(0.0001, tarpStart + 0.26);

    tarpSrc.connect(tarpBp);
    tarpBp.connect(tarpGain);
    tarpGain.connect(masterGain);
    tarpSrc.onended = () => {
      safeDisconnect(tarpSrc);
      safeDisconnect(tarpBp);
      safeDisconnect(tarpGain);
    };
    tarpSrc.start(tarpStart);
    tarpSrc.stop(tarpStart + 0.28);
  }

  return {
    unlock,
    isMuted(): boolean {
      return muted;
    },
    setMuted(nextMuted: boolean): void {
      muted = nextMuted;
      applyMasterGain();
    },
    toggleMute(): boolean {
      muted = !muted;
      if (!muted && !initialized) {
        unlock();
      } else {
        applyMasterGain();
      }
      return muted;
    },
    playFootstep,
    playJump,
    playLand,
    playAttackWhoosh,
    playScavenge,
    playItemUse,
    playBottleThrow,
    playGlassShatter,
    playMeleeHit,
    playPlayerHurt,
    playAlertSting,
    playThunder,
    playFlashlightClick,
    playStalkerSound,
    playBuildCamp,
    update(elapsed: number, dt: number, spatial?: SpatialAudioState): void {
      if (!ctx || ctx.state !== 'running' || muted) {
        return;
      }

      const rain = Math.max(0, Math.min(1, spatial?.rainIntensity ?? 0));
      const night = Math.max(0, Math.min(1, spatial?.nightFactor ?? 0));
      const sheltered = spatial?.isSheltered === true;
      const fireProx = Math.max(0, Math.min(1, spatial?.fireProximity ?? 0));
      const firePan = Math.max(-0.92, Math.min(0.92, spatial?.firePan ?? 0));

      windModAccum += dt;
      if (windModAccum >= 0.1) {
        windModAccum = 0;
        const gust = spatial
          ? spatial.windIntensity
          : 0.5 + 0.35 * Math.sin(elapsed * 0.23) + 0.15 * Math.sin(elapsed * 0.61 + 1.3);
        const shelterAtten = sheltered ? 0.62 : 1.0;
        if (windLowFilter) {
          windLowFilter.frequency.setTargetAtTime(
            (190 + gust * 165) * (sheltered ? 0.72 : 1),
            ctx.currentTime,
            0.25,
          );
        }
        if (windNeedleFilter && windNeedleGain) {
          windNeedleFilter.frequency.setTargetAtTime(620 + gust * 510, ctx.currentTime, 0.25);
          windNeedleGain.gain.setTargetAtTime(
            (0.03 + gust * 0.062) * shelterAtten,
            ctx.currentTime,
            0.25,
          );
        }
        if (windNeedlePanner) {
          const breezePan = Math.sin(elapsed * 0.19) * 0.42;
          windNeedlePanner.pan.setTargetAtTime(breezePan, ctx.currentTime, 0.35);
        }

        // Dynamic rain sheet: crisp falling rain outdoors, warm muffled shelter acoustics indoors
        if (rainFilter && rainGain) {
          const cutoff = sheltered ? 460 + rain * 280 : 2500 + rain * 2400;
          const level = rain < 0.01 ? 0.0001 : rain * (sheltered ? 0.12 : 0.21);
          rainFilter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.22);
          rainGain.gain.setTargetAtTime(level, ctx.currentTime, 0.22);
        }

        // Spatial campfire warm hearth rumble & stereo pan
        if (fireFilter && fireGain && firePanner) {
          const flicker = 0.5 + 0.5 * Math.sin(elapsed * 4.3 + Math.sin(elapsed * 1.9));
          fireFilter.frequency.setTargetAtTime(
            310 + flicker * 110 + fireProx * 120,
            ctx.currentTime,
            0.14,
          );
          const targetFireGain = fireProx < 0.01 ? 0.0001 : fireProx * (0.14 + flicker * 0.045);
          fireGain.gain.setTargetAtTime(targetFireGain, ctx.currentTime, 0.18);
          firePanner.pan.setTargetAtTime(firePan, ctx.currentTime, 0.16);
        }
      }

      if (fireProx > 0.05) {
        nextFireCrackleCountdown -= dt;
        if (nextFireCrackleCountdown <= 0) {
          triggerFireCrackle(fireProx, firePan);
          nextFireCrackleCountdown = 0.16 + Math.random() * 0.48;
        }
      } else if (nextFireCrackleCountdown > 0.25) {
        nextFireCrackleCountdown = 0.25;
      }

      // Daytime forest birds give way to nocturnal owls & forest crickets after dusk
      if (night <= 0.45) {
        if (rain < 0.7) {
          nextBirdCountdown -= dt;
          if (nextBirdCountdown <= 0) {
            triggerDistantBird();
            nextBirdCountdown = 10 + Math.random() * 12;
          }
        }
      } else {
        nextOwlCountdown -= dt;
        if (nextOwlCountdown <= 0) {
          triggerDistantOwl();
          nextOwlCountdown = 11 + Math.random() * 14;
        }
        if (rain < 0.5) {
          nextCricketCountdown -= dt;
          if (nextCricketCountdown <= 0) {
            triggerNightCricket();
            nextCricketCountdown = 2.6 + Math.random() * 4.2;
          }
        }
      }

      if (spatial && spatial.ruinProximity > 0.15) {
        nextCreakCountdown -= dt;
        if (nextCreakCountdown <= 0) {
          triggerSpatialMetalCreak(spatial.ruinProximity, spatial.ruinPan);
          nextCreakCountdown = 6.5 + Math.random() * 7.5;
        }
      }
    },
    dispose(): void {
      teardownAudioGraph();
    },
  };
}
