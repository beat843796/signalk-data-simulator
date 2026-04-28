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

interface Options {
  paths?: PathConfig[];
}

const PLUGIN_ID = 'signalk-data-simulator';
const MIN_INTERVAL_MS = 10;

// Defaults aimed at a small/medium sailboat under way.
// Units follow SignalK 1.8.2: speeds m/s, angles rad, temperature K, distances m.
const DEFAULT_PATHS: PathConfig[] = [
  {
    path: 'navigation.speedThroughWater',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 2.5, stepStdDev: 0.15, min: 0, max: 8 }
  },
  {
    path: 'navigation.speedOverGround',
    intervalMs: 50,
    generator: { type: 'randomWalk', initial: 2.7, stepStdDev: 0.15, min: 0, max: 8 }
  },
  {
    path: 'navigation.courseOverGroundTrue',
    intervalMs: 50,
    generator: { type: 'sine', mean: 1.5708, amplitude: 0.0873, periodSec: 120 }
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
            values: [{ path: pc.path as never, value }]
          }
        ]
      });
    }, interval);
  };

  return {
    id: PLUGIN_ID,
    name: 'SignalK Data Simulator',
    description:
      'Emits synthetic SignalK deltas at per-path intervals (down to ~10ms) using configurable generators (constant, sine, randomWalk, linearRamp).',

    schema: () => ({
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          title: 'Simulated paths',
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
        }
      }
    }),

    statusMessage: () => statusText,

    start(config) {
      const opts = (config ?? {}) as Options;
      // Missing `paths` falls back to defaults; an explicit empty array disables all output.
      const paths = opts.paths ?? DEFAULT_PATHS;
      const startMs = Date.now();

      for (const pc of paths) {
        if (!pc?.path || !pc?.generator) continue;
        timers.push(startPath(pc, startMs));
      }

      statusText =
        paths.length === 0
          ? 'No paths configured'
          : `Simulating ${paths.length} path(s)`;
    },

    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      statusText = 'Stopped';
    }
  };
};

export = pluginFactory;
