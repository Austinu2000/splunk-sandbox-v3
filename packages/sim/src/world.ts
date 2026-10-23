import type { WorldInfo } from '@sandbox/shared';
import { defaultWorldConfig, validateConfig, type WorldConfig } from './config';
import { FleetAggregates } from './fleet/aggregates';
import { generateFleet } from './fleet/generate';
import { backgroundRates, evolveFleet } from './fleet/health';
import { HealthHistory } from './fleet/history';
import { allocFleet, type FleetTables } from './fleet/tables';
import { generateInfra, type InfraNode } from './infra';
import type { OverlayEntry } from './vfs/vfs';
import { hashString, Rng } from './rng';

export interface WorldClock {
  /** Sim epoch ms. Always startTime + tick * tickMs. */
  now: number;
  tick: number;
  /** Wall-clock pacing only; never affects simulation results. */
  speed: number;
  paused: boolean;
}

export interface World {
  config: WorldConfig;
  rng: Rng;
  seedHash: number;
  clock: WorldClock;
  fleet: FleetTables;
  aggregates: FleetAggregates;
  history: HealthHistory;
  infra: InfraNode[];
  /** Version strings indexed by fleet.version: approved versions first, then drift versions. */
  versions: string[];
  hosts: HostRuntime;
}

/** Per-host state created by user activity. Generated content is never stored, only changes to it. */
export interface HostRuntime {
  /** hostname → path → change on top of the generated filesystem. */
  fsOverlay: Map<string, Map<string, OverlayEntry>>;
  /** hostname → sim time of the user's last SSH login. */
  lastLogin: Map<string, number>;
}

export function createWorld(overrides: Partial<WorldConfig> = {}): World {
  const config = defaultWorldConfig(overrides);
  validateConfig(config);
  const world: World = {
    config,
    rng: new Rng(config.seed),
    seedHash: hashString(config.seed),
    clock: { now: config.startTime, tick: 0, speed: 1, paused: false },
    fleet: allocFleet(0),
    aggregates: new FleetAggregates(config.sites.length, config.serverClasses.length),
    history: new HealthHistory(1),
    infra: generateInfra(config),
    versions: [...config.approvedVersions.map((v) => v.version), ...config.driftVersions],
    hosts: { fsOverlay: new Map(), lastLogin: new Map() },
  };
  generateFleet(world);
  world.aggregates = FleetAggregates.fromScan(world.fleet, config.sites.length, config.serverClasses.length);
  world.history = new HealthHistory(historyCapacity(world));
  return world;
}

/** Room for about 4x the expected background transitions over the retention window. */
function historyCapacity(world: World): number {
  const { pRecover } = backgroundRates(world);
  const ticks = world.config.historyRetentionMs / world.config.tickMs;
  const expected = 2 * world.config.fleetSize * world.config.background.unhealthyRate * pRecover * ticks;
  return Math.ceil(expected * 4) + 4096;
}

/** Advances the simulation by `n` ticks. Results depend only on the seed and the tick number. */
export function tickWorld(world: World, n = 1): void {
  for (let k = 0; k < n; k++) {
    const tick = world.clock.tick + 1;
    const now = world.config.startTime + tick * world.config.tickMs;
    world.clock.tick = tick;
    world.clock.now = now;
    evolveFleet(world, world.rng.fork('tick', tick), now);
    world.history.prune(now - world.config.historyRetentionMs);
  }
}

export function setClock(world: World, patch: { speed?: number; paused?: boolean }): void {
  if (patch.speed !== undefined) world.clock.speed = patch.speed;
  if (patch.paused !== undefined) world.clock.paused = patch.paused;
}

export function worldInfo(world: World): WorldInfo {
  const { config, clock } = world;
  return {
    seed: config.seed,
    fleetSize: config.fleetSize,
    now: clock.now,
    tick: clock.tick,
    tickMs: config.tickMs,
    speed: clock.speed,
    paused: clock.paused,
    sites: config.sites.map((s) => ({ id: s.id, name: s.name })),
    serverClasses: config.serverClasses.map((c) => ({ id: c.id, os: c.os })),
    infra: world.infra.map(({ hostname, role, site, ip, status }) => ({ hostname, role, site, ip, status })),
  };
}
