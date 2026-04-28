export type GeneratorConfig =
  | ConstantConfig
  | SineConfig
  | RandomWalkConfig
  | LinearRampConfig;

export interface ConstantConfig {
  type: 'constant';
  value: number;
}

export interface SineConfig {
  type: 'sine';
  mean: number;
  amplitude: number;
  periodSec: number;
  phaseSec?: number;
}

export interface RandomWalkConfig {
  type: 'randomWalk';
  initial: number;
  stepStdDev: number;
  min?: number;
  max?: number;
}

export interface LinearRampConfig {
  type: 'linearRamp';
  from: number;
  to: number;
  durationSec: number;
  loop?: boolean;
}

export interface Generator {
  next(nowMs: number): number;
}

export function createGenerator(cfg: GeneratorConfig, startMs: number): Generator {
  switch (cfg.type) {
    case 'constant':
      return new ConstantGen(cfg);
    case 'sine':
      return new SineGen(cfg, startMs);
    case 'randomWalk':
      return new RandomWalkGen(cfg, startMs);
    case 'linearRamp':
      return new LinearRampGen(cfg, startMs);
  }
}

class ConstantGen implements Generator {
  constructor(private readonly cfg: ConstantConfig) {}
  next(): number {
    return this.cfg.value;
  }
}

class SineGen implements Generator {
  constructor(private readonly cfg: SineConfig, private readonly startMs: number) {}
  next(nowMs: number): number {
    const t = (nowMs - this.startMs) / 1000 + (this.cfg.phaseSec ?? 0);
    return this.cfg.mean + this.cfg.amplitude * Math.sin((2 * Math.PI * t) / this.cfg.periodSec);
  }
}

class RandomWalkGen implements Generator {
  private value: number;
  private lastMs: number;
  constructor(private readonly cfg: RandomWalkConfig, startMs: number) {
    this.value = cfg.initial;
    this.lastMs = startMs;
  }
  next(nowMs: number): number {
    const dt = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    this.value += gaussian() * this.cfg.stepStdDev * Math.sqrt(dt);
    if (this.cfg.min !== undefined && this.value < this.cfg.min) this.value = this.cfg.min;
    if (this.cfg.max !== undefined && this.value > this.cfg.max) this.value = this.cfg.max;
    return this.value;
  }
}

class LinearRampGen implements Generator {
  constructor(private readonly cfg: LinearRampConfig, private readonly startMs: number) {}
  next(nowMs: number): number {
    const elapsed = (nowMs - this.startMs) / 1000;
    const dur = this.cfg.durationSec;
    let frac = dur > 0 ? elapsed / dur : 1;
    if (this.cfg.loop) {
      frac = frac - Math.floor(frac);
    } else if (frac > 1) {
      frac = 1;
    } else if (frac < 0) {
      frac = 0;
    }
    return this.cfg.from + (this.cfg.to - this.cfg.from) * frac;
  }
}

// Box–Muller standard-normal sample.
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const generatorSchema = {
  type: 'object',
  title: 'Generator',
  required: ['type'],
  oneOf: [
    {
      title: 'Constant',
      properties: {
        type: { type: 'string', const: 'constant' },
        value: { type: 'number' }
      },
      required: ['type', 'value']
    },
    {
      title: 'Sine wave',
      properties: {
        type: { type: 'string', const: 'sine' },
        mean: { type: 'number' },
        amplitude: { type: 'number' },
        periodSec: { type: 'number', minimum: 0.001 },
        phaseSec: { type: 'number', default: 0 }
      },
      required: ['type', 'mean', 'amplitude', 'periodSec']
    },
    {
      title: 'Random walk (Brownian)',
      properties: {
        type: { type: 'string', const: 'randomWalk' },
        initial: { type: 'number' },
        stepStdDev: {
          type: 'number',
          description: 'Standard deviation per √second (units of value/√s)'
        },
        min: { type: 'number' },
        max: { type: 'number' }
      },
      required: ['type', 'initial', 'stepStdDev']
    },
    {
      title: 'Linear ramp',
      properties: {
        type: { type: 'string', const: 'linearRamp' },
        from: { type: 'number' },
        to: { type: 'number' },
        durationSec: { type: 'number', minimum: 0.001 },
        loop: { type: 'boolean', default: false }
      },
      required: ['type', 'from', 'to', 'durationSec']
    }
  ]
};
