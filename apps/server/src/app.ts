import { registerScenarios } from './scenarios';
import Fastify, { type FastifyInstance } from 'fastify';
import { CLOCK_SPEEDS, HEALTH_STATES, type FleetFilter, type HostSortKey } from '@sandbox/shared';
import {
  FilterError,
  ScenarioError,
  listHosts,
  setClock,
  sshRoster,
  summarizeFleet,
  worldInfo,
  type World,
} from '@sandbox/sim';
import { aiGradingEnabled, createAiGrader, type AiGrader } from './aiGrader';
import { registerConsoles } from './consoles';
import { registerInterview } from './interview';
import { registerSearch } from './search';
import { registerTerminal } from './terminal';

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

export interface SandboxApp {
  app: FastifyInstance;
  /** Call after each simulation tick so live terminal programs (tail -f) update. */
  onTick(): void;
}

export interface AppOptions {
  logger?: boolean;
  /** Claude grading for interviews; defaults to on only when ANTHROPIC_API_KEY is set. */
  aiGrader?: AiGrader | null;
}

export function buildApp(world: World, opts: AppOptions = {}): SandboxApp {
  const app = Fastify({ logger: opts.logger ?? false });
  const terminals = registerTerminal(app, world);
  registerSearch(app, world);
  registerScenarios(app, world);
  registerConsoles(app, world);
  registerInterview(
    app,
    world,
    opts.aiGrader !== undefined ? opts.aiGrader : aiGradingEnabled() ? createAiGrader() : null,
  );

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof ScenarioError || err instanceof FilterError || err.validation)
      return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/world', async () => worldInfo(world));

  app.get('/api/hosts/roster', async () => sshRoster(world));

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
            sort: {
              type: 'string',
              enum: ['hostname', 'lastPhoneHome', 'health', 'site'],
              default: 'hostname',
            },
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

  return { app, onTick: () => terminals.tickAll() };
}
