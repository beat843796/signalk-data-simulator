import * as fs from 'fs';
import * as path from 'path';

export type GeneratorValue = number | string | { [k: string]: unknown };

export type GeneratorConfig =
  | ConstantConfig
  | SineConfig
  | RandomWalkConfig
  | LinearRampConfig
  | StringCycleConfig
  | GpsTrackConfig;

export interface ConstantConfig {
  type: 'constant';
  value: number | string;
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
  /* false / true (=forward) preserved for back-compat. 'pingpong' reflects at the ends. */
  loop?: boolean | 'pingpong';
}

export interface StringCycleConfig {
  type: 'stringCycle';
  values: string[];
  periodSec: number;
}

export interface GpsTrackConfig {
  type: 'gpsTrack';
  field: 'position' | 'sog' | 'cog';
  /* 1 = real time. 60 means 1 wall-second covers 1 track-minute. */
  timeScale?: number;
}

export interface Generator {
  next(nowMs: number): GeneratorValue;
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
    case 'stringCycle':
      return new StringCycleGen(cfg, startMs);
    case 'gpsTrack':
      return new GpsTrackGen(cfg, startMs);
  }
}

class ConstantGen implements Generator {
  constructor(private readonly cfg: ConstantConfig) {}
  next(): GeneratorValue {
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
    if (this.cfg.loop === 'pingpong') {
      const cycle = Math.floor(frac);
      const f = frac - cycle;
      frac = cycle % 2 === 0 ? f : 1 - f;
    } else if (this.cfg.loop) {
      frac = frac - Math.floor(frac);
    } else if (frac > 1) {
      frac = 1;
    } else if (frac < 0) {
      frac = 0;
    }
    return this.cfg.from + (this.cfg.to - this.cfg.from) * frac;
  }
}

class StringCycleGen implements Generator {
  constructor(private readonly cfg: StringCycleConfig, private readonly startMs: number) {}
  next(nowMs: number): string {
    const n = this.cfg.values.length;
    if (n === 0) return '';
    const period = Math.max(0.001, this.cfg.periodSec);
    const elapsed = (nowMs - this.startMs) / 1000;
    const idx = ((Math.floor(elapsed / period) % n) + n) % n;
    return this.cfg.values[idx] ?? '';
  }
}

/* ---------- GPS track playback ---------- */

interface TrackPoint {
  tMs: number; /* milliseconds since track start */
  lat: number;
  lon: number;
  speedKn: number;
}

interface Track {
  points: TrackPoint[];
  durationMs: number;
}

let trackCache: Track | null = null;

function loadTrack(): Track {
  if (trackCache) return trackCache;
  const file = path.join(__dirname, '..', 'data', 'longest_trip.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    points: { time: string; lat: number; lon: number; speedKn: number }[];
  };
  if (!raw.points || raw.points.length === 0) {
    throw new Error(`gpsTrack: no points in ${file}`);
  }
  const t0 = parseUtc(raw.points[0]!.time);
  const points: TrackPoint[] = raw.points.map((p) => ({
    tMs: parseUtc(p.time) - t0,
    lat: p.lat,
    lon: p.lon,
    speedKn: p.speedKn
  }));
  trackCache = {
    points,
    durationMs: points[points.length - 1]!.tMs
  };
  return trackCache;
}

class GpsTrackGen implements Generator {
  constructor(private readonly cfg: GpsTrackConfig, private readonly startMs: number) {
    /* warm the cache so file errors surface at start, not on first tick */
    loadTrack();
  }
  next(nowMs: number): GeneratorValue {
    const track = loadTrack();
    const scale = this.cfg.timeScale ?? 1;
    const elapsedMs = (nowMs - this.startMs) * scale;
    const dur = track.durationMs;
    const pts = track.points;
    if (dur <= 0) {
      const p = pts[0]!;
      return projectField(this.cfg.field, p, p, 0, +1);
    }
    /* ping-pong: cycle 0 = forward, 1 = reverse, 2 = forward, ... */
    const phase = elapsedMs / dur;
    const cycle = Math.floor(phase);
    const frac = phase - cycle;
    const reversed = ((cycle % 2) + 2) % 2 === 1;
    const targetMs = (reversed ? 1 - frac : frac) * dur;
    const direction = reversed ? -1 : +1;

    /* binary search for the segment containing targetMs */
    let lo = 0;
    let hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.tMs <= targetMs) lo = mid;
      else hi = mid;
    }
    const a = pts[lo]!;
    const b = pts[Math.min(lo + 1, pts.length - 1)]!;
    const span = b.tMs - a.tMs || 1;
    const f = Math.max(0, Math.min(1, (targetMs - a.tMs) / span));
    return projectField(this.cfg.field, a, b, f, direction);
  }
}

function projectField(
  field: GpsTrackConfig['field'],
  a: TrackPoint,
  b: TrackPoint,
  f: number,
  direction: number
): GeneratorValue {
  if (field === 'position') {
    return {
      latitude: a.lat + (b.lat - a.lat) * f,
      longitude: a.lon + (b.lon - a.lon) * f
    };
  }
  if (field === 'sog') {
    const kn = a.speedKn + (b.speedKn - a.speedKn) * f;
    return Math.max(0, kn) * 0.514444; /* knots → m/s */
  }
  /* cog: bearing along the playback direction */
  const from = direction > 0 ? a : b;
  const to = direction > 0 ? b : a;
  return bearingRad(from.lat, from.lon, to.lat, to.lon);
}

function bearingRad(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x);
  return (theta + 2 * Math.PI) % (2 * Math.PI);
}

/* "YYYY-MM-DD HH:MM:SS" -> epoch ms (UTC) */
function parseUtc(s: string): number {
  const [d, t] = s.split(' ');
  return Date.parse(`${d}T${t}Z`);
}

/* Box–Muller standard-normal sample. */
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
        value: {}
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
        loop: {
          anyOf: [
            { type: 'boolean' },
            { type: 'string', enum: ['pingpong'] }
          ],
          default: false,
          description: 'false/true=forward repeat; "pingpong" reflects at ends'
        }
      },
      required: ['type', 'from', 'to', 'durationSec']
    },
    {
      title: 'String cycle',
      properties: {
        type: { type: 'string', const: 'stringCycle' },
        values: { type: 'array', items: { type: 'string' }, minItems: 1 },
        periodSec: { type: 'number', minimum: 0.001 }
      },
      required: ['type', 'values', 'periodSec']
    },
    {
      title: 'GPS track playback',
      properties: {
        type: { type: 'string', const: 'gpsTrack' },
        field: { type: 'string', enum: ['position', 'sog', 'cog'] },
        timeScale: {
          type: 'number',
          minimum: 0.001,
          default: 1,
          description: 'Real-time multiplier; 60 = 1 wall-sec per track-minute'
        }
      },
      required: ['type', 'field']
    }
  ]
};
