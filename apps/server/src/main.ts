import { createWorld } from '@sandbox/sim';
import { aiGradingEnabled, AI_MODEL } from './aiGrader';
import { buildApp } from './app';
import { SimTicker } from './ticker';

// Local only (CLAUDE.md rule 6): never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.SANDBOX_PORT ?? 5174);
const seed = process.env.SANDBOX_SEED ?? 'sandbox';
const fleetSize = process.env.SANDBOX_FLEET_SIZE ? Number(process.env.SANDBOX_FLEET_SIZE) : undefined;

const started = performance.now();
const world = createWorld({ seed, ...(fleetSize ? { fleetSize } : {}) });
const { app, onTick } = buildApp(world, { logger: true });
const ticker = new SimTicker(world, onTick);

await app.listen({ host: HOST, port: PORT });
ticker.start();
app.log.info(
  `World "${seed}" with ${world.fleet.size} forwarders ready in ${Math.round(performance.now() - started)} ms`,
);
app.log.info(
  aiGradingEnabled()
    ? `Interview answers will also be graded by Claude (${AI_MODEL}); unset ANTHROPIC_API_KEY to stay offline`
    : 'Claude grading is off (set ANTHROPIC_API_KEY to enable); interviews are graded offline',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    ticker.stop();
    await app.close();
    process.exit(0);
  });
}
