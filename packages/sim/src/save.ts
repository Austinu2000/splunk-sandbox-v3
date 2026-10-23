import { resolveHost } from './hosts/profile';
import { reloadDeployServer, restartSplunk, startSplunk, stopSplunk } from './hosts/running';
import { startLicenseHistory } from './ingest/license';
import {
  attachAiAssessment,
  logAction,
  saveNotes,
  startInterview,
  submitInterview,
  takeHint,
} from './interview/engine';
import { nested, type Mutation } from './journal';
import {
  closeTicket,
  configureScenarios,
  ScenarioError,
  startScenario,
  type Scenario,
} from './scenario/engine';
import { applyFsEntry } from './vfs/build';
import { createWorld, setClock, tickWorld, type World } from './world';

/**
 * Save and load. A save is the seed, the fleet size, how far the clock had run, and the journal
 * of user changes; loading creates a fresh world from the seed and replays the journal tick by
 * tick, so the result is the same world, not an approximation of it.
 */
export const SAVE_VERSION = 1;

export interface SavedWorld {
  version: typeof SAVE_VERSION;
  seed: string;
  fleetSize: number;
  tick: number;
  speed: number;
  paused: boolean;
  journal: Mutation[];
}

export class SaveError extends Error {}

export function saveWorld(world: World): SavedWorld {
  return {
    version: SAVE_VERSION,
    seed: world.config.seed,
    fleetSize: world.config.fleetSize,
    tick: world.clock.tick,
    speed: world.clock.speed,
    paused: world.clock.paused,
    journal: structuredClone(world.journal.log),
  };
}

function host(world: World, name: string) {
  const p = resolveHost(world, name);
  if (!p) throw new SaveError(`The save refers to an unknown host: ${name}`);
  return p;
}

function apply(world: World, m: Mutation): void {
  switch (m.k) {
    case 'fs':
      return applyFsEntry(world, m.host, m.path, m.entry);
    case 'svc': {
      const p = host(world, m.host);
      if (m.op === 'stop') return stopSplunk(world, p);
      if (m.op === 'start') return startSplunk(world, p);
      if (m.op === 'restart') return restartSplunk(world, p);
      return reloadDeployServer(world, p, m.cls);
    }
    case 'login':
      world.hosts.lastLogin.set(m.host, world.clock.now);
      return;
    case 'license.start':
      return startLicenseHistory(world);
    case 'scenario.start':
      void startScenario(world, m.id);
      return;
    case 'ticket.close':
      void closeTicket(world, m.id, m.note);
      return;
    case 'action':
      void logAction(world, { kind: m.kind, text: m.text, host: m.host, user: m.user }, m.wall);
      return;
    case 'interview.start':
      void startInterview(world, m.opts, m.wall);
      return;
    case 'interview.hint':
      void takeHint(world, m.id, m.wall);
      return;
    case 'interview.notes':
      void saveNotes(world, m.id, m.notes);
      return;
    case 'interview.submit':
      void submitInterview(world, m.id, m.answer, m.wall);
      return;
    case 'interview.ai':
      void attachAiAssessment(world, m.id, { ai: m.ai, aiError: m.aiError });
      return;
  }
}

/** Rebuild a saved world. `onProgress` reports the fraction of ticks replayed. */
export function loadWorld(
  saved: SavedWorld,
  definitions: Scenario[],
  onProgress?: (fraction: number) => void,
): World {
  if (saved.version !== SAVE_VERSION) throw new SaveError(`Unsupported save version ${saved.version}`);
  const world = createWorld({ seed: saved.seed, fleetSize: saved.fleetSize });
  configureScenarios(world, definitions);
  const step = (to: number) => {
    if (to < world.clock.tick) throw new SaveError('The save journal is out of order');
    while (world.clock.tick < to) {
      tickWorld(world, Math.min(60, to - world.clock.tick));
      onProgress?.(world.clock.tick / Math.max(1, saved.tick));
    }
  };
  nested(world, () => {
    for (const m of saved.journal) {
      step(m.t);
      try {
        apply(world, m);
      } catch (e) {
        if (e instanceof ScenarioError || e instanceof SaveError)
          throw new SaveError(`Could not replay this save at tick ${m.t} (${m.k}): ${e.message}`);
        throw e;
      }
    }
    step(saved.tick);
  });
  world.journal.log = structuredClone(saved.journal);
  setClock(world, { speed: saved.speed, paused: saved.paused });
  return world;
}
