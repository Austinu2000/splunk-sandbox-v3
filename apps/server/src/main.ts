import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@sandbox/sim';
import { aiGradingEnabled, AI_MODEL } from './aiGrader';
import { buildApp } from './app';
import { SessionStore } from './store';
import { SimTicker } from './ticker';

// Local only (CLAUDE.md rule 6): never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.SANDBOX_PORT ?? 5174);
const seed = process.env.SANDBOX_SEED ?? 'sandbox';
const fleetSize = process.env.SANDBOX_FLEET_SIZE ? Number(process.env.SANDBOX_FLEET_SIZE) : undefined;
/** SQLite database for saved sessions, action logs and scores. */
const DB_PATH = process.env.SANDBOX_DB ?? fileURLToPath(new URL('../../../data/sandbox.db', import.meta.url));
const AUTOSAVE_MS = 60_000;

const started = performance.now();
mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new SessionStore(DB_PATH);
const world = createWorld({ seed, ...(fleetSize ? { fleetSize } : {}) });
const { app, live, onTick } = buildApp(world, { logger: true, store });
const ticker = new SimTicker(live, onTick);

await app.listen({ host: HOST, port: PORT });
ticker.start();
app.log.info(
  `World "${seed}" with ${world.fleet.size} forwarders ready in ${Math.round(performance.now() - started)} ms`,
);
app.log.info(`Sessions are saved in ${DB_PATH}`);
app.log.info(
  aiGradingEnabled()
    ? `Interview answers will also be graded by Claude (${AI_MODEL}); unset ANTHROPIC_API_KEY to stay offline`
    : 'Claude grading is off (set ANTHROPIC_API_KEY to enable); interviews are graded offline',
);

// Autosave: whenever the world has changes the last autosave doesn't have, and on shutdown.
let autosaved = { world: live.world, changes: 0 };
const autosave = () => {
  const w = live.world;
  const changes = w.journal.log.length;
  if (!changes || (autosaved.world === w && autosaved.changes === changes)) return;
  store.save(w, 'Autosave', 'autosave', Date.now());
  autosaved = { world: w, changes };
};
const timer = setInterval(() => {
  try {
    autosave();
  } catch (e) {
    app.log.error(e, 'Autosave failed');
  }
}, AUTOSAVE_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    ticker.stop();
    try {
      autosave();
    } catch (e) {
      app.log.error(e, 'Autosave failed');
    }
    await app.close();
    store.close();
    process.exit(0);
  });
}
