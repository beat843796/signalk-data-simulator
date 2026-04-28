# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A SignalK Node Server plugin that emits synthetic deltas at configurable per-path intervals. Built because the bundled NMEA2000/NMEA0183 sample-data sources only update at 1–2 Hz, which is too coarse for downstream testing — this plugin can drive any path at intervals down to ~10 ms.

It is **not** a standalone process: the plugin loads inside `signalk-server` and publishes via `app.handleMessage(...)`, so all auth, connection, and dispatch concerns are the host server's.

## Commands

- `npm run build` — compile TypeScript (`src/` → `dist/`, CommonJS).
- `npm run watch` — incremental rebuild while editing.
- `npm run clean` — delete `dist/`.
- No test runner is wired up. Smoke-test the compiled output by `require('./dist/index.js')(fakeApp)` and calling `start({ paths: [...] })` with a stub `handleMessage`.

## Installing into a local signalk-server

From a checkout of `signalk-server`:

```
npm install /absolute/path/to/signalk-data-simulator
```

…then enable the plugin in the SignalK admin UI and configure paths. The `prepare` script runs `tsc`, so an `npm install <path>` against a fresh clone will produce `dist/` automatically.

## Architecture

Two source files; keep it that way unless the surface grows.

**`src/generators.ts`** — pure data-generation layer, zero SignalK coupling.
- `GeneratorConfig` is a discriminated union (`constant | sine | randomWalk | linearRamp`).
- `Generator` interface is one method: `next(nowMs: number): number`. Stateful generators (random walk) hold their own state; stateless ones (sine, ramp, constant) close over config + `startMs`.
- `createGenerator(cfg, startMs)` is the only factory — switch on `cfg.type`.
- `generatorSchema` is a JSON Schema fragment (`oneOf` over the four variants) consumed by the plugin's admin-UI schema. **It must stay in sync with `GeneratorConfig`** — when adding a generator type, update both the union *and* the `oneOf` array, in this file.

**`src/index.ts`** — SignalK plugin shell + scheduler + default config.
- Default export is `(app: ServerAPI) => Plugin`; compiled with `export = pluginFactory` so it lands as CommonJS `module.exports = factory`, which is what `signalk-server` requires.
- `start(config)` reads `config.paths`, instantiates one `Generator` per entry, and creates one `setInterval` per path. Each tick calls `gen.next(now)` and publishes via `app.handleMessage(PLUGIN_ID, { updates: [{ timestamp, values: [{ path, value }] }] })`.
- `stop()` clears all timers. Timers are kept in a single array; replace it on stop, never reuse across restarts.
- `MIN_INTERVAL_MS = 10` is the floor for `intervalMs` — Node `setInterval` below ~5 ms gets unreliable and the SignalK server has its own delta-fanout overhead. Raise this if profiling shows the fanout is the bottleneck.
- `DEFAULT_PATHS` is the out-of-the-box config — 15 paths sized for a small/medium sailboat under way (speeds m/s, angles rad, temperature K per SignalK 1.8.2). It is wired into the schema's `default` (so the admin UI pre-populates it on first enable) **and** used as a runtime fallback when `config.paths` is missing. An explicit empty array `paths: []` is honored as "disable all output" — only `undefined` triggers the fallback. When extending defaults, keep both intervals and ranges realistic; this is also the de-facto smoke test (see scripts/test in commit history).

## Delta contract (do not drift from this)

`app.handleMessage` expects (per `@signalk/server-api`):

```ts
handleMessage(pluginId: string, msg: Partial<Delta>, skVersion?: SKVersion): void
type Delta  = { context?: Context; updates: Update[] }
type Update = { timestamp?, source?, $source?, ... } & ({ values: PathValue[] } | { meta: Meta[] })
type PathValue = { path: Path; value: Value }   // Value: number | string | boolean | object | null
```

`Path`, `Timestamp`, etc. are branded strings — we cast at the emit site (`as never`) rather than constructing brand wrappers, since the plugin schema already validates inputs.

## Extending

- **New generator type:** add a config interface to the union in `generators.ts`, add a `class XGen implements Generator`, add the case to `createGenerator`, append the variant to `generatorSchema.oneOf`.
- **Non-scalar paths (e.g. `navigation.position` = `{latitude, longitude}`):** the `Generator.next` return type is currently `number`. Widen to `number | object` and add a position generator; the rest of the pipeline already passes `value` through unchanged.
- **Coordinated multi-path scenarios** (e.g. SOG + COG + position evolving together): out of scope for the per-path design. If added, introduce a separate "scenario" layer that owns its own timer and emits multiple `PathValue`s per tick — don't try to bolt cross-path coupling onto `Generator`.
