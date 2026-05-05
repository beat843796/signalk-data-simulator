import type { Plugin, ServerAPI } from '@signalk/server-api';
import {
  createGenerator,
  Generator,
  GeneratorConfig,
  generatorSchema
} from './generators';

interface PathConfig {
  path: string;
  intervalMs: number;
  generator: GeneratorConfig;
}

interface AutopilotConfig {
  enabled: boolean;
  changePeriodSec: number;
  emitIntervalMs: number;
}

interface GpsConfig {
  enabled: boolean;
  timeScale: number;
  emitIntervalMs: number;
}

interface EnginesConfig {
  count: number;
}

interface TankSpec {
  capacityL: number;
}

interface TanksConfig {
  cycleSec: number;
  fuel: TankSpec[];
  freshWater: TankSpec[];
  wasteWater: TankSpec[];
  blackWater: TankSpec[];
}

interface Options {
  paths?: PathConfig[];
  autopilot?: AutopilotConfig;
  gps?: GpsConfig;
  engines?: EnginesConfig;
  tanks?: TanksConfig;
}

const PLUGIN_ID = 'signalk-data-simulator';
const MIN_INTERVAL_MS = 10;
const AP_STANDARD_STATES = ['auto', 'standby', 'wind', 'route'];

/* Defaults aimed at a small/medium sailboat under way.
   Units follow SignalK 1.8.2: speeds m/s, angles rad, temperature K, distances m.
   nav.speedOverGround and nav.courseOverGroundTrue are intentionally OMITTED here
   because the GPS-track section produces them when enabled. */
const DEFAULT_PATHS: PathConfig[] = [
  {
    path: 'navigation.speedThroughWater',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 2.5, stepStdDev: 0.15, min: 0, max: 8 }
  },
  {
    path: 'navigation.headingMagnetic',
    intervalMs: 50,
    generator: { type: 'sine', mean: 1.5184, amplitude: 0.0873, periodSec: 120, phaseSec: 5 }
  },
  {
    path: 'navigation.magneticVariation',
    intervalMs: 1000,
    generator: { type: 'constant', value: 0.0524 }
  },
  {
    path: 'navigation.trip',
    intervalMs: 1000,
    generator: { type: 'linearRamp', from: 0, to: 18000, durationSec: 3600, loop: false }
  },
  {
    path: 'navigation.log',
    intervalMs: 1000,
    generator: { type: 'linearRamp', from: 1000000, to: 1018000, durationSec: 3600, loop: false }
  },
  {
    path: 'environment.water.temperature',
    intervalMs: 1000,
    generator: { type: 'randomWalk', initial: 288.15, stepStdDev: 0.02, min: 283, max: 293 }
  },
  {
    path: 'environment.wind.speedApparent',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 7, stepStdDev: 0.5, min: 0, max: 20 }
  },
  {
    path: 'environment.wind.angleApparent',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 0.7, stepStdDev: 0.05, min: -3.1416, max: 3.1416 }
  },
  {
    path: 'environment.wind.speedTrue',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 6, stepStdDev: 0.4, min: 0, max: 20 }
  },
  {
    path: 'environment.depth.belowTransducer',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 15, stepStdDev: 0.3, min: 2, max: 50 }
  },
  {
    path: 'environment.depth.transducerToKeel',
    intervalMs: 5000,
    generator: { type: 'constant', value: 0.5 }
  },
  {
    path: 'environment.depth.belowKeel',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 14.5, stepStdDev: 0.3, min: 1.5, max: 49.5 }
  },
  {
    path: 'steering.rudderAngle',
    intervalMs: 50,
    generator: { type: 'sine', mean: 0, amplitude: 0.0873, periodSec: 8 }
  }
];

const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: true,
  changePeriodSec: 10,
  emitIntervalMs: 1000
};

const DEFAULT_GPS: GpsConfig = {
  enabled: true,
  timeScale: 60,
  emitIntervalMs: 1000
};

const DEFAULT_ENGINES: EnginesConfig = {
  count: 1
};

const DEFAULT_TANKS: TanksConfig = {
  cycleSec: 7200,
  fuel: [{ capacityL: 200 }],
  freshWater: [{ capacityL: 300 }],
  wasteWater: [{ capacityL: 80 }],
  blackWater: [{ capacityL: 80 }]
};

/* ---------- Section expanders: turn config sugar into PathConfig entries ---------- */

function expandAutopilot(cfg: AutopilotConfig): PathConfig[] {
  if (!cfg.enabled) return [];
  const period = Math.max(0.1, cfg.changePeriodSec);
  const emitMs = Math.max(MIN_INTERVAL_MS, cfg.emitIntervalMs);
  return [
    {
      path: 'steering.autopilot.state',
      intervalMs: emitMs,
      generator: { type: 'stringCycle', values: AP_STANDARD_STATES, periodSec: period }
    },
    {
      path: 'steering.autopilot.target.headingMagnetic',
      intervalMs: 500,
      generator: { type: 'sine', mean: 0, amplitude: 0.8, periodSec: 60 }
    },
    {
      path: 'steering.autopilot.target.headingTrue',
      intervalMs: 500,
      generator: { type: 'sine', mean: 0, amplitude: 1.0, periodSec: 60 }
    },
    {
      path: 'steering.autopilot.target.windAngleApparent',
      intervalMs: 500,
      generator: { type: 'sine', mean: 0, amplitude: 0.6, periodSec: 60 }
    }
  ];
}

function expandGps(cfg: GpsConfig): PathConfig[] {
  if (!cfg.enabled) return [];
  const ms = Math.max(MIN_INTERVAL_MS, cfg.emitIntervalMs);
  const ts = Math.max(0.001, cfg.timeScale);
  return [
    {
      path: 'navigation.position',
      intervalMs: ms,
      generator: { type: 'gpsTrack', field: 'position', timeScale: ts }
    },
    {
      path: 'navigation.speedOverGround',
      intervalMs: ms,
      generator: { type: 'gpsTrack', field: 'sog', timeScale: ts }
    },
    {
      path: 'navigation.courseOverGroundTrue',
      intervalMs: ms,
      generator: { type: 'gpsTrack', field: 'cog', timeScale: ts }
    }
  ];
}

function expandEngines(cfg: EnginesConfig): PathConfig[] {
  const out: PathConfig[] = [];
  const n = Math.max(0, Math.floor(cfg.count));
  /* 1-based numeric IDs: matches conventional UI display ("Engine 1") and
     the spec's own examples (FreshWater_2, Port_Engine) which imply 1-based. */
  for (let i = 0; i < n; i++) {
    const id = `${i + 1}`;
    const base = `propulsion.${id}`;
    out.push(
      {
        path: `${base}.revolutions`,
        intervalMs: 200,
        /* Hz; 33 Hz ≈ 2000 rpm cruise */
        generator: { type: 'randomWalk', initial: 33, stepStdDev: 0.5, min: 12, max: 45 }
      },
      {
        path: `${base}.temperature`,
        intervalMs: 1000,
        /* K; 355 K ≈ 82 °C */
        generator: { type: 'randomWalk', initial: 355, stepStdDev: 0.05, min: 290, max: 380 }
      },
      {
        path: `${base}.fuel.rate`,
        intervalMs: 1000,
        /* m³/s; 2.5e-6 ≈ 9 L/h cruise */
        generator: { type: 'randomWalk', initial: 2.5e-6, stepStdDev: 5e-8, min: 0, max: 5e-6 }
      },
      {
        path: `${base}.alternatorVoltage`,
        intervalMs: 1000,
        generator: { type: 'randomWalk', initial: 14.2, stepStdDev: 0.02, min: 11.5, max: 14.6 }
      },
      {
        path: `${base}.oilPressure`,
        intervalMs: 1000,
        /* Pa; 3.5e5 ≈ 50 psi */
        generator: { type: 'randomWalk', initial: 350000, stepStdDev: 500, min: 200000, max: 500000 }
      }
    );
  }
  return out;
}

function expandTanks(cfg: TanksConfig): PathConfig[] {
  const out: PathConfig[] = [];
  const cycle = Math.max(60, cfg.cycleSec);
  const drainTypes: Array<{ key: keyof TanksConfig; signalK: string }> = [
    { key: 'fuel', signalK: 'fuel' },
    { key: 'freshWater', signalK: 'freshWater' }
  ];
  const fillTypes: Array<{ key: keyof TanksConfig; signalK: string }> = [
    { key: 'wasteWater', signalK: 'wasteWater' },
    { key: 'blackWater', signalK: 'blackWater' }
  ];

  const addTank = (typePath: string, idx: number, capL: number, drains: boolean) => {
    const capM3 = capL / 1000;
    /* 1-based ID — see expandEngines for the rationale. */
    const base = `tanks.${typePath}.${idx + 1}`;
    /* drain tanks: full -> nearly empty -> back. fill tanks: empty -> nearly full -> back. */
    const fromLvl = drains ? 1.0 : 0.0;
    const toLvl = drains ? 0.05 : 0.95;
    out.push(
      {
        path: `${base}.capacity`,
        intervalMs: 10000,
        generator: { type: 'constant', value: capM3 }
      },
      {
        path: `${base}.currentLevel`,
        intervalMs: 1000,
        generator: { type: 'linearRamp', from: fromLvl, to: toLvl, durationSec: cycle, loop: 'pingpong' }
      },
      {
        path: `${base}.currentVolume`,
        intervalMs: 1000,
        generator: {
          type: 'linearRamp',
          from: fromLvl * capM3,
          to: toLvl * capM3,
          durationSec: cycle,
          loop: 'pingpong'
        }
      }
    );
  };

  for (const t of drainTypes) {
    const list = (cfg[t.key] as TankSpec[]) || [];
    list.forEach((spec, i) => addTank(t.signalK, i, spec.capacityL, true));
  }
  for (const t of fillTypes) {
    const list = (cfg[t.key] as TankSpec[]) || [];
    list.forEach((spec, i) => addTank(t.signalK, i, spec.capacityL, false));
  }
  return out;
}

const pluginFactory = (app: ServerAPI): Plugin => {
  const timers: NodeJS.Timeout[] = [];
  let statusText = 'Idle';

  const startPath = (pc: PathConfig, startMs: number): NodeJS.Timeout => {
    const gen: Generator = createGenerator(pc.generator, startMs);
    const interval = Math.max(MIN_INTERVAL_MS, pc.intervalMs);
    return setInterval(() => {
      const now = Date.now();
      const value = gen.next(now);
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            timestamp: new Date(now).toISOString() as never,
            values: [{ path: pc.path as never, value: value as never }]
          }
        ]
      });
    }, interval);
  };

  return {
    id: PLUGIN_ID,
    name: 'SignalK Data Simulator',
    description:
      'Emits synthetic SignalK deltas at per-path intervals (down to ~10ms) using configurable generators (constant, sine, randomWalk, linearRamp, stringCycle, gpsTrack). Bundled sections drive autopilot, GPS track playback, engines, and tanks.',

    schema: () => ({
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          title: 'Free-form simulated paths',
          description:
            'Each entry drives one SignalK path with its own update interval and generator.',
          default: DEFAULT_PATHS,
          items: {
            type: 'object',
            required: ['path', 'intervalMs', 'generator'],
            properties: {
              path: {
                type: 'string',
                title: 'SignalK path',
                description: 'e.g. navigation.speedOverGround, environment.wind.angleApparent'
              },
              intervalMs: {
                type: 'number',
                title: 'Update interval (ms)',
                default: 50,
                minimum: MIN_INTERVAL_MS
              },
              generator: generatorSchema
            }
          }
        },
        autopilot: {
          type: 'object',
          title: 'Autopilot simulator',
          description:
            'Cycles steering.autopilot.state through standard states and sweeps target headings/wind angle.',
          default: DEFAULT_AUTOPILOT,
          properties: {
            enabled: { type: 'boolean', default: true },
            changePeriodSec: {
              type: 'number',
              minimum: 0.1,
              default: 10,
              title: 'State change period (seconds)'
            },
            emitIntervalMs: {
              type: 'number',
              minimum: MIN_INTERVAL_MS,
              default: 1000,
              title: 'State emit interval (ms)'
            }
          }
        },
        gps: {
          type: 'object',
          title: 'GPS track playback',
          description:
            'Plays back a bundled real-world sailing trip. Emits navigation.position, speedOverGround, courseOverGroundTrue. Loops ping-pong at end.',
          default: DEFAULT_GPS,
          properties: {
            enabled: { type: 'boolean', default: true },
            timeScale: {
              type: 'number',
              minimum: 0.001,
              default: 60,
              title: 'Time scale',
              description: '1 = real time. 60 = 1 wall-second per track-minute.'
            },
            emitIntervalMs: {
              type: 'number',
              minimum: MIN_INTERVAL_MS,
              default: 1000,
              title: 'Emit interval (ms)'
            }
          }
        },
        engines: {
          type: 'object',
          title: 'Engines',
          description:
            'Generates propulsion.<id>.{revolutions,temperature,fuel.rate,alternatorVoltage,oilPressure} for each engine. IDs are 1-based: propulsion.1, propulsion.2, ...',
          default: DEFAULT_ENGINES,
          properties: {
            count: {
              type: 'integer',
              minimum: 0,
              default: 1,
              title: 'Number of engines'
            }
          }
        },
        tanks: {
          type: 'object',
          title: 'Tanks',
          description:
            'Generates tanks.<type>.<id>.{capacity,currentLevel,currentVolume}. IDs are 1-based: tanks.fuel.1, tanks.fuel.2, ... Drain tanks (fuel, freshWater) ramp full→empty→full; fill tanks (wasteWater, blackWater) ramp empty→full→empty.',
          default: DEFAULT_TANKS,
          properties: {
            cycleSec: {
              type: 'number',
              minimum: 60,
              default: 7200,
              title: 'Drain/fill cycle (seconds)',
              description: 'Time for one half of the ping-pong cycle.'
            },
            fuel: tankListSchema('Fuel tanks'),
            freshWater: tankListSchema('Fresh water tanks'),
            wasteWater: tankListSchema('Waste (grey) water tanks'),
            blackWater: tankListSchema('Black water tanks')
          }
        }
      }
    }),

    statusMessage: () => statusText,

    start(config) {
      const opts = (config ?? {}) as Options;
      const paths = opts.paths ?? DEFAULT_PATHS;
      const autopilot = { ...DEFAULT_AUTOPILOT, ...(opts.autopilot ?? {}) };
      const gps = { ...DEFAULT_GPS, ...(opts.gps ?? {}) };
      const engines = { ...DEFAULT_ENGINES, ...(opts.engines ?? {}) };
      const tanks = { ...DEFAULT_TANKS, ...(opts.tanks ?? {}) };

      const expanded: PathConfig[] = [
        ...paths,
        ...expandAutopilot(autopilot),
        ...expandGps(gps),
        ...expandEngines(engines),
        ...expandTanks(tanks)
      ];

      const startMs = Date.now();
      for (const pc of expanded) {
        if (!pc?.path || !pc?.generator) continue;
        timers.push(startPath(pc, startMs));
      }

      statusText =
        expanded.length === 0
          ? 'No paths configured'
          : `Simulating ${expanded.length} path(s)`;
      app.debug?.(
        `${PLUGIN_ID} started: paths=${paths.length} autopilot=${autopilot.enabled} ` +
          `gps=${gps.enabled} engines=${engines.count} tanks=${tankCount(tanks)}`
      );
    },

    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      statusText = 'Stopped';
    }
  };
};

function tankListSchema(title: string) {
  return {
    type: 'array',
    title,
    items: {
      type: 'object',
      required: ['capacityL'],
      properties: {
        capacityL: { type: 'number', minimum: 0, default: 100, title: 'Capacity (L)' }
      }
    }
  };
}

function tankCount(t: TanksConfig): number {
  return (
    (t.fuel?.length ?? 0) +
    (t.freshWater?.length ?? 0) +
    (t.wasteWater?.length ?? 0) +
    (t.blackWater?.length ?? 0)
  );
}

export = pluginFactory;
