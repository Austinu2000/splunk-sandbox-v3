import { z } from 'zod';
import { parse } from 'yaml';
import type { ScenarioDto, TicketDto } from '@sandbox/shared';
import type { World } from '../world';
import { resolveHost } from '../hosts/profile';
import { hostFs } from '../vfs/build';
import { ROOT } from '../vfs/vfs';
import { setting } from '../conf/merge';
import { reloadDeployServer, restartSplunk, runningConf } from '../hosts/running';
import { HEALTH_STATES } from '@sandbox/shared';
import { summarizeFleet } from '../fleet/query';
import { parsingQueueBlocked } from '../derive/state';
import { mergesWithPrevious } from '../spl/data';
import { BLOCKED, OFFLINE } from '../fleet/tables';
import { forwarderInputs } from '../hosts/inputs';
import { licenseStatus } from '../ingest/license';
import { extractTime, parseConfig } from '../ingest/parsing';
import { projectedSkips } from '../scheduler';
import { clusterPeers } from '../hosts/cluster';
import { splunkdRunning } from '../hosts/profile';

const confCheck = z
  .object({
    host: z.string().min(1),
    conf: z.string().regex(/^[a-z]+$/),
    stanza: z.string(),
    key: z.string(),
    equals: z.string(),
  })
  .strict();
const fleetCheck = z
  .object({
    site: z.string().optional(),
    serverClass: z.string().optional(),
    health: z.enum(HEALTH_STATES),
    /** At most this percentage of the scope may be in `health`. */
    maxPct: z.number().min(0).max(100),
  })
  .strict();
const queueCheck = z.object({ host: z.string().min(1), blocked: z.boolean() }).strict();
const breakingCheck = z
  .object({ host: z.string().min(1), sourcetype: z.string().min(1), separate: z.boolean() })
  .strict();

const licenseCheck = z.object({ maxProjectedPct: z.number().positive() }).strict();
const timestampCheck = z
  .object({
    /** A forwarder whose events of this sourcetype are sampled. */
    host: z.string().min(1),
    sourcetype: z.string().min(1),
    maxSkewSeconds: z.number().nonnegative(),
  })
  .strict();
const hostCheck = z.object({ host: z.string().min(1) }).strict();
const collectingCheck = z.object({ host: z.string().min(1), source: z.string().startsWith('/') }).strict();
const schedulerCheck = z
  .object({
    host: z.string().min(1),
    maxSkipped: z.number().int().nonnegative(),
    minutes: z.number().int().positive().max(240),
  })
  .strict();

/**
 * Fix checks describe outcomes (the fleet recovered, the queue drains, events stay separate) so any
 * correct fix passes. `effectiveConf` remains for checks that really are about one setting.
 */
export type FixCheck =
  | { all: FixCheck[] }
  | { any: FixCheck[] }
  | { effectiveConf: z.infer<typeof confCheck> }
  | { fleet: z.infer<typeof fleetCheck> }
  | { parsingQueue: z.infer<typeof queueCheck> }
  | { eventBreaking: z.infer<typeof breakingCheck> }
  | { license: z.infer<typeof licenseCheck> }
  | { timestamps: z.infer<typeof timestampCheck> }
  | { forwarderDelivering: z.infer<typeof hostCheck> }
  | { collecting: z.infer<typeof collectingCheck> }
  | { scheduler: z.infer<typeof schedulerCheck> };
const check: z.ZodType<FixCheck> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(check).min(1) }).strict(),
    z.object({ any: z.array(check).min(1) }).strict(),
    z.object({ effectiveConf: confCheck }).strict(),
    z.object({ fleet: fleetCheck }).strict(),
    z.object({ parsingQueue: queueCheck }).strict(),
    z.object({ eventBreaking: breakingCheck }).strict(),
    z.object({ license: licenseCheck }).strict(),
    z.object({ timestamps: timestampCheck }).strict(),
    z.object({ forwarderDelivering: hostCheck }).strict(),
    z.object({ collecting: collectingCheck }).strict(),
    z.object({ scheduler: schedulerCheck }).strict(),
  ]),
);

const confChange = z
  .object({
    host: z.string(),
    path: z.string().regex(/^\/opt\/splunk(?:forwarder)?\/etc\/.+\.conf$/),
    stanza: z.string(),
    set: z.record(z.string()).default({}),
    unset: z.array(z.string()).default([]),
    /** none: the file changes on disk only (e.g. the cluster manager's copy of the bundle). */
    apply: z.enum(['restart', 'deploy-server', 'none']),
  })
  .strict();
/** Ownership/permissions of an existing file outside Splunk's config (takes effect immediately). */
const fileChange = z
  .object({
    host: z.string(),
    file: z.string().regex(/^\/[\w./-]+$/),
    mode: z.string().regex(/^0?[0-7]{3}$/),
    owner: z
      .string()
      .regex(/^[a-z_][\w-]*$/)
      .optional(),
    group: z
      .string()
      .regex(/^[a-z_][\w-]*$/)
      .optional(),
  })
  .strict();
type Change = z.infer<typeof confChange> | z.infer<typeof fileChange>;
const changePath = (c: Change) => ('path' in c ? c.path : c.file);

/** A misleading but harmless log line written while the incident is open. */
const redHerring = z
  .object({
    host: z.string().min(1),
    file: z.enum(['splunkd', 'messages']),
    level: z.enum(['INFO', 'WARN', 'ERROR']).default('WARN'),
    component: z.string().regex(/^[\w:.-]+$/),
    message: z.string().min(1),
    everyMinutes: z.number().positive().max(240).default(5),
  })
  .strict();
export type RedHerring = z.infer<typeof redHerring>;

const schema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** What the user sees: the symptom, never the cause. */
    title: z.string().min(1),
    /** The root cause, for authors and the debrief. Not sent to the browser. */
    summary: z.string().min(1),
    topics: z.array(z.string()),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    /** Incidents start when the user asks, unless a file opts in to a scheduled start. */
    trigger: z
      .union([
        z.object({ onDemand: z.literal(true) }).strict(),
        z.object({ afterMinutes: z.number().nonnegative() }).strict(),
      ])
      .default({ onDemand: true }),
    ticket: z
      .object({
        requester: z.string(),
        persona: z.string(),
        urgency: z.enum(['low', 'medium', 'high']),
        text: z.string(),
      })
      .strict(),
    /** Applied in order; several changes may edit the same file. Each host is restarted/reloaded once. */
    changes: z.array(z.union([confChange, fileChange])).min(1),
    clues: z.array(z.string()),
    redHerrings: z.array(redHerring).default([]),
    fixChecks: check,
    recovery: z.object({ seconds: z.number().nonnegative().max(3600) }).strict(),
  })
  .strict();
export type Scenario = z.infer<typeof schema>;
export interface InjectedLine extends RedHerring {
  ticketId: string;
  from: number;
}

export interface ScenarioState {
  definitions: Scenario[];
  tickets: TicketDto[];
  /** Red-herring lines being written into host logs while their ticket is open. */
  injected: InjectedLine[];
}
export class ScenarioError extends Error {}

export function parseScenario(text: string): Scenario {
  return schema.parse(parse(text));
}

/** Edits a stanza while preserving unrelated settings and comments. */
export function patchConf(
  text: string,
  stanza: string,
  values: Record<string, string>,
  unset: string[] = [],
): string {
  const lines = text.split(/\r?\n/);
  let inStanza = false,
    found = false,
    insertAt = lines.length;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]/.exec(lines[i]!);
    if (header) {
      inStanza = header[1]!.trim() === stanza;
      if (inStanza) {
        found = true;
        insertAt = i + 1;
      }
      continue;
    }
    if (!inStanza) continue;
    const key = /^\s*([^#=]+?)\s*=/.exec(lines[i]!)?.[1];
    if (key && unset.includes(key)) {
      lines.splice(i--, 1);
      continue;
    }
    insertAt = i + 1;
    if (key && Object.hasOwn(values, key)) {
      lines[i] = `${key} = ${values[key]}`;
      seen.add(key);
    }
  }
  if (!found) {
    lines.push(`[${stanza}]`);
    insertAt = lines.length;
  }
  lines.splice(
    insertAt,
    0,
    ...Object.entries(values)
      .filter(([key]) => !seen.has(key))
      .map(([key, value]) => `${key} = ${value}`),
  );
  return lines.join('\n') + (lines.at(-1) === '' ? '' : '\n');
}

export function configureScenarios(world: World, definitions: Scenario[]): void {
  const ids = new Set<string>();
  for (const s of definitions) {
    if (ids.has(s.id)) throw new ScenarioError(`Duplicate scenario: ${s.id}`);
    ids.add(s.id);
    for (const c of s.changes) {
      if ('file' in c) {
        const p = resolveHost(world, c.host);
        if (!p || p.os !== 'linux' || c.file.split('/').includes('..'))
          throw new ScenarioError(`Invalid file change: ${c.host}:${c.file}`);
        if (hostFs(world, p).findNode(c.file)?.type !== 'file')
          throw new ScenarioError(`Missing file: ${c.file}`);
        continue;
      }
      const p = resolveHost(world, c.host);
      if (!p?.splunk || (c.apply === 'deploy-server' && p.role !== 'deployment_server'))
        throw new ScenarioError(`Invalid scenario host/application: ${c.host}`);
      if (
        c.path.split('/').some((part) => part === '..' || part === '.') ||
        !c.path.startsWith(`${p.splunk.home}/etc/`)
      )
        throw new ScenarioError('Invalid config path');
      const fs = hostFs(world, p);
      if (fs.findNode(c.path.slice(0, c.path.lastIndexOf('/')))?.type !== 'dir')
        throw new ScenarioError(`Missing config directory: ${c.path}`);
      if (fs.findNode(c.path)?.type === 'dir')
        throw new ScenarioError(`Config path is a directory: ${c.path}`);
    }
    for (const r of s.redHerrings) {
      const p = resolveHost(world, r.host);
      if (!p || (r.file === 'splunkd' && !p.splunk) || p.os !== 'linux')
        throw new ScenarioError(`Invalid red-herring host: ${r.host}`);
    }
  }
  world.scenarios.definitions = definitions;
}

export function fixed(world: World, c: FixCheck): boolean {
  if ('all' in c) return c.all.every((x) => fixed(world, x));
  if ('any' in c) return c.any.some((x) => fixed(world, x));
  if ('fleet' in c) {
    const { site, serverClass, health, maxPct } = c.fleet;
    const s = summarizeFleet(world, { site, serverClass });
    return s.total > 0 && (s.byHealth[health] / s.total) * 100 <= maxPct;
  }
  if ('parsingQueue' in c) {
    const p = resolveHost(world, c.parsingQueue.host);
    return !!p && parsingQueueBlocked(world, p, world.clock.now) === c.parsingQueue.blocked;
  }
  if ('eventBreaking' in c) {
    // Two consecutive single-line events: does this receiver keep the second one separate?
    const { host, sourcetype, separate } = c.eventBreaking;
    const p = resolveHost(world, host);
    const sample = `${new Date(world.clock.now).toISOString()} INFO  [main] c.example.Probe - sample event`;
    return !!p && !mergesWithPrevious(world, p, sourcetype, world.clock.now, sample) === separate;
  }
  if ('license' in c) return licenseStatus(world).projectedPct <= c.license.maxProjectedPct;
  if ('timestamps' in c) {
    // The newest event the forwarder wrote: does every running indexer stamp it near its write time?
    const { host, sourcetype, maxSkewSeconds } = c.timestamps;
    const p = resolveHost(world, host);
    const input = p && forwarderInputs(world, p).collected.find((x) => x.sourcetype === sourcetype);
    const entry = input?.log.entries(world.clock.now - 10 * 60_000, world.clock.now).at(-1);
    if (!entry) return false;
    const [t, raw] = entry;
    return clusterPeers(world)
      .filter((idx) => splunkdRunning(world, idx))
      .every(
        (idx) =>
          Math.abs((extractTime(parseConfig(world, idx, sourcetype, t), raw) ?? t) - t) <=
          maxSkewSeconds * 1000,
      );
  }
  if ('forwarderDelivering' in c) {
    const row = resolveHost(world, c.forwarderDelivering.host)?.fleetRow;
    return row !== undefined && world.fleet.health[row] !== BLOCKED && world.fleet.health[row] !== OFFLINE;
  }
  if ('collecting' in c) {
    const p = resolveHost(world, c.collecting.host);
    return !!p && forwarderInputs(world, p).collected.some((x) => x.source === c.collecting.source);
  }
  if ('scheduler' in c) {
    const p = resolveHost(world, c.scheduler.host);
    return !!p?.splunk && projectedSkips(world, p, c.scheduler.minutes) <= c.scheduler.maxSkipped;
  }
  const e = c.effectiveConf,
    p = resolveHost(world, e.host);
  return !!p?.splunk && setting(runningConf(world, p, e.conf), e.stanza, e.key) === e.equals;
}

export function startScenario(world: World, id: string): TicketDto {
  const s = world.scenarios.definitions.find((s) => s.id === id);
  if (!s) throw new ScenarioError('Unknown scenario');
  if (world.scenarios.tickets.some((t) => t.scenarioId === id))
    throw new ScenarioError('Scenario already started in this session');
  const active = world.scenarios.tickets.filter((t) => t.status !== 'closed');
  if (active.length >= 2)
    throw new ScenarioError('Close an active ticket before starting another incident (maximum 2)');
  if (
    active.some((t) =>
      world.scenarios.definitions
        .find((d) => d.id === t.scenarioId)!
        .changes.some((c) =>
          s.changes.some((next) => c.host === next.host && changePath(c) === changePath(next)),
        ),
    )
  )
    throw new ScenarioError('An active incident uses the same config file');
  // Prepare all writes before applying any changes; edits to one file accumulate.
  const texts = new Map<string, { host: string; path: string; text: string }>();
  for (const c of s.changes) {
    if (!('path' in c)) continue;
    const key = `${c.host}:${c.path}`;
    const fs = hostFs(world, resolveHost(world, c.host)!);
    const old = texts.get(key)?.text ?? (fs.findNode(c.path) ? fs.readFile(c.path, ROOT) : '');
    texts.set(key, { host: c.host, path: c.path, text: patchConf(old, c.stanza, c.set, c.unset) });
  }
  for (const { host, path, text } of texts.values()) {
    const fs = hostFs(world, resolveHost(world, host)!);
    const created = !fs.findNode(path);
    fs.writeFile(path, text, ROOT);
    // A new file belongs to whoever owns the directory (the splunk user), as if they had written it.
    const dir = fs.findNode(path.slice(0, path.lastIndexOf('/')))!;
    if (created) fs.setMeta(path, { owner: dir.owner, group: dir.group, mode: 0o600 }, ROOT);
  }
  for (const c of s.changes) {
    if (!('file' in c)) continue;
    const fs = hostFs(world, resolveHost(world, c.host)!);
    fs.setMeta(
      c.file,
      { mode: parseInt(c.mode, 8), ...(c.owner && { owner: c.owner }), ...(c.group && { group: c.group }) },
      ROOT,
    );
  }
  const applied = new Set<string>();
  for (const c of s.changes) {
    if (!('apply' in c) || c.apply === 'none' || applied.has(`${c.host}:${c.apply}`)) continue;
    applied.add(`${c.host}:${c.apply}`);
    const p = resolveHost(world, c.host)!;
    if (c.apply === 'deploy-server') reloadDeployServer(world, p);
    else restartSplunk(world, p);
  }
  const ticket: TicketDto = {
    id: `INC-${String(world.scenarios.tickets.length + 1).padStart(4, '0')}`,
    scenarioId: id,
    title: s.title,
    ...s.ticket,
    openedAt: world.clock.now,
    status: 'open',
  };
  world.scenarios.tickets.push(ticket);
  for (const r of s.redHerrings)
    world.scenarios.injected.push({ ...r, ticketId: ticket.id, from: world.clock.now });
  return ticket;
}

export function updateScenarios(world: World): void {
  for (const s of world.scenarios.definitions) {
    if (
      'afterMinutes' in s.trigger &&
      world.clock.now >= world.config.startTime + s.trigger.afterMinutes * 60_000 &&
      !world.scenarios.tickets.some((t) => t.scenarioId === s.id)
    ) {
      try {
        startScenario(world, s.id);
      } catch (e) {
        if (!(e instanceof ScenarioError)) throw e;
      }
    }
  }
  refreshTickets(world);
}
export function refreshTickets(world: World): void {
  for (const t of world.scenarios.tickets) {
    if (t.status === 'closed') continue;
    const s = world.scenarios.definitions.find((s) => s.id === t.scenarioId)!;
    if (!fixed(world, s.fixChecks)) {
      t.status = 'open';
      t.symptomSeen = true;
      delete t.fixedAt;
      continue;
    }
    // Outcome checks pass before a change has rolled out (forwarders pick it up at their next
    // check-in), so a ticket can only count as fixed after its symptom has actually appeared.
    if (!t.symptomSeen) {
      t.status = 'open';
      continue;
    }
    t.fixedAt ??= world.clock.now;
    t.status = world.clock.now - t.fixedAt >= s.recovery.seconds * 1000 ? 'resolved' : 'recovering';
  }
}
export function closeTicket(world: World, id: string, note: string): TicketDto {
  refreshTickets(world);
  const t = world.scenarios.tickets.find((t) => t.id === id);
  if (!t) throw new ScenarioError('Unknown ticket');
  if (t.status !== 'resolved')
    throw new ScenarioError('Verify the fix and wait for recovery before closing this ticket');
  if (!note.trim() || note.length > 4000)
    throw new ScenarioError('Write a resolution note (1–4000 characters)');
  t.status = 'closed';
  t.closedAt = world.clock.now;
  t.resolutionNote = note.trim();
  return t;
}
export function scenarioCatalog(world: World): ScenarioDto[] {
  // Only the symptom-level fields: the summary, changes and fix checks would give the answer away.
  return world.scenarios.definitions.map(({ id, title, topics, difficulty }) => ({
    id,
    title,
    topics,
    difficulty,
  }));
}
