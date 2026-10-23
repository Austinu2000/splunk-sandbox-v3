import Fastify, { type FastifyInstance } from 'fastify';
import { CLOCK_SPEEDS, HEALTH_STATES, type FleetFilter, type HostSortKey } from '@sandbox/shared';
import { FilterError, listHosts, setClock, summarizeFleet, worldInfo, type World } from '@sandbox/sim';

const filterProps = {
  site: { type: 'string' },
  serverClass: { type: 'string' },
  health: { type: 'string', enum: [...HEALTH_STATES] },
  os: { type: 'string', enum: ['windows', 'linux'] },
  q: { type: 'string', maxLength: 64 },
} as const;

type FilterQuery = FleetFilter;
type HostsQuery = FilterQuery & { offset?: number; limit?: number; sort?: HostSortKey; dir?: 'asc' | 'desc' };

function toFilter(q: FilterQuery): FleetFilter {
  const { site, serverClass, health, os, q: text } = q;
  return { site, serverClass, health, os, q: text };
}

export function buildApp(world: World, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof FilterError || err.validation) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/world', async () => worldInfo(world));

  app.post<{ Body: { paused?: boolean; speed?: number } }>(
    '/api/world/clock',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { paused: { type: 'boolean' }, speed: { type: 'number', enum: [...CLOCK_SPEEDS] } },
        },
      },
    },
    async (req) => {
      setClock(world, req.body);
      return worldInfo(world);
    },
  );

  app.get<{ Querystring: FilterQuery }>(
    '/api/fleet/summary',
    { schema: { querystring: { type: 'object', properties: filterProps } } },
    async (req) => summarizeFleet(world, toFilter(req.query)),
  );

  app.get<{ Querystring: HostsQuery }>(
    '/api/fleet/hosts',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...filterProps,
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            sort: { type: 'string', enum: ['hostname', 'lastPhoneHome', 'health', 'site'], default: 'hostname' },
            dir: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          },
        },
      },
    },
    async (req) => {
      const { offset, limit, sort, dir } = req.query;
      return listHosts(world, toFilter(req.query), { offset, limit, sort, dir });
    },
  );

  return app;
}
