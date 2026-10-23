import { readFileSync, readdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  closeTicket,
  configureScenarios,
  parseScenario,
  refreshTickets,
  scenarioCatalog,
  startScenario,
  type World,
} from '@sandbox/sim';

/** Trusted local scenario files only; request paths never reach the real filesystem. */
export function registerScenarios(app: FastifyInstance, world: World): void {
  if (!world.scenarios.definitions.length) {
    const dir = new URL('../../../scenarios/', import.meta.url);
    configureScenarios(
      world,
      readdirSync(dir)
        .filter((n) => n.endsWith('.yaml'))
        .sort()
        .map((n) => parseScenario(readFileSync(new URL(n, dir), 'utf8'))),
    );
  }
  app.get('/api/scenarios', async () => scenarioCatalog(world));
  app.get('/api/tickets', async () => {
    refreshTickets(world);
    return world.scenarios.tickets;
  });
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/start', async (req) =>
    startScenario(world, req.params.id),
  );
  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/api/tickets/:id/close',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['note'],
          properties: { note: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (req) => closeTicket(world, req.params.id, req.body.note),
  );
}
