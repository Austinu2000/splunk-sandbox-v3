import type { FastifyInstance } from 'fastify';
import { MC_VIEWS, type McView, type McViewDto } from '@sandbox/shared';
import { dsClients, dsOverview, monitoringConsole, type DsClientQuery, type World } from '@sandbox/sim';

/** Monitoring Console and Forwarder Management: read-only views of the world, computed on request. */
export function registerConsoles(app: FastifyInstance, world: World): void {
  // Several browser tabs polling the same view within one tick share one computation.
  const cache = new Map<McView, { tick: number; dto: McViewDto }>();

  app.get<{ Params: { view: McView } }>(
    '/api/mc/:view',
    {
      schema: {
        params: {
          type: 'object',
          required: ['view'],
          properties: { view: { type: 'string', enum: [...MC_VIEWS] } },
        },
      },
    },
    async (req) => {
      const hit = cache.get(req.params.view);
      if (hit && hit.tick === world.clock.tick) return hit.dto;
      const dto = monitoringConsole(world, req.params.view);
      cache.set(req.params.view, { tick: world.clock.tick, dto });
      return dto;
    },
  );

  app.get('/api/ds/overview', async () => dsOverview(world));

  app.get<{ Querystring: DsClientQuery }>(
    '/api/ds/clients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            q: { type: 'string', maxLength: 64 },
            serverClass: { type: 'string', maxLength: 128 },
            unmatched: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => dsClients(world, req.query),
  );
}
