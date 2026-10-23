import { deployedApps } from '../derive/state';
import { hostname as fleetHostname } from '../fleet/query';
import { BLOCKED, OFFLINE } from '../fleet/tables';
import { CLASS_INPUTS, CLASS_LOG_FILE } from '../hosts/apps';
import { resolveHost, type HostProfile } from '../hosts/profile';
import {
  appLog,
  hostTimeline,
  messagesLog,
  metricsLog,
  receivingIndexer,
  secureLog,
  smallLog,
  splunkdLog,
  statesIn,
  winEventLog,
  type LogSource,
  type Timeline,
} from '../logs/sources';
import type { World } from '../world';
import type { RunContext } from './commands';
import { Row, type SplEvent } from './row';
import { allowed, type Pushdown } from './search';

/**
 * The indexed-event view of the world. Events are generated on demand from the same log sources the
 * terminal reads, then filtered by what actually reached an indexer: nothing while a forwarder is
 * offline, and nothing from a blocked forwarder until it unblocks (then the backlog arrives).
 */

export const INDEXES = ['_internal', '_audit', 'os', 'app', 'network', 'main'] as const;

export interface ScanSource {
  index: string;
  sourcetype: string;
  source: string;
  log: LogSource;
  /** host override (syslog relays set host from the file path, like host_segment). */
  host?: string;
}

const isInternal = (idx: string) => idx.startsWith('_');

/** Indexes a search reads: explicit index= patterns, else the default (non-internal) indexes. */
export function indexAllowed(pd: Pushdown, idx: string): boolean {
  const pats = [...(pd.fields.get('index') ?? []), ...(pd.fields.get('index|or') ?? [])];
  if (!pats.length) return !isInternal(idx);
  // `index=*` means every non-internal index, as in Splunk; internal indexes need an explicit `_` pattern.
  if (isInternal(idx) && !pats.some((p) => p.startsWith('_'))) return false;
  return allowed(pd, 'index', idx);
}

export function hostSources(world: World, p: HostProfile, wantData: boolean): ScanSource[] {
  const out: ScanSource[] = [];
  if (p.splunk) {
    const win = p.splunk.home.includes('\\');
    const logDir = win ? `${p.splunk.home}\\var\\log\\splunk\\` : `${p.splunk.home}/var/log/splunk/`;
    out.push(
      {
        index: '_internal',
        sourcetype: 'splunkd',
        source: `${logDir}splunkd.log`,
        log: splunkdLog(world, p),
      },
      {
        index: '_internal',
        sourcetype: 'splunkd',
        source: `${logDir}metrics.log`,
        log: metricsLog(world, p),
      },
      {
        index: '_internal',
        sourcetype: 'splunkd',
        source: `${logDir}health.log`,
        log: smallLog(world, p, 'health'),
      },
      {
        index: '_audit',
        sourcetype: 'audittrail',
        source: `${logDir}audit.log`,
        log: smallLog(world, p, 'audit'),
      },
    );
  }
  if (!wantData || p.fleetRow === undefined) return out;

  // Business data follows the apps the deployment server actually gave this forwarder.
  const row = p.fleetRow;
  const apps = deployedApps(world, p);
  const own = world.config.serverClasses[world.fleet.serverClass[row]!]!;
  if (own.os === 'linux' && apps.includes('Splunk_TA_nix')) {
    out.push(
      { index: 'os', sourcetype: 'syslog', source: '/var/log/messages', log: messagesLog(world, p) },
      { index: 'os', sourcetype: 'linux_secure', source: '/var/log/secure', log: secureLog(world, p) },
    );
  }
  const assigned = world.fleet.assignedClass[row]!;
  const assignedCls = world.config.serverClasses[assigned];
  if (!assignedCls) return out;
  for (const input of CLASS_INPUTS[assignedCls.id]!.inputs) {
    if (input.stanza.startsWith('WinEventLog://')) {
      if (own.os !== 'windows') continue;
      const name = input.stanza.slice('WinEventLog://'.length) as 'Security';
      out.push({
        index: input.index,
        sourcetype: input.sourcetype,
        source: `WinEventLog:${name}`,
        log: winEventLog(world, p, name),
      });
    } else if (input.stanza.startsWith('monitor://')) {
      // The monitored file only exists on hosts of the class it belongs to.
      const file = CLASS_LOG_FILE[own.id];
      if (assignedCls.id !== own.id || !file) continue;
      const segment = Number(input.extra?.host_segment);
      out.push({
        index: input.index,
        sourcetype: input.sourcetype,
        source: file,
        log: appLog(world, p, own.id),
        host: segment ? file.split('/')[segment] : undefined,
      });
    }
  }
  return out;
}

const fleetNames = new WeakMap<World, string[]>();

function allHostnames(world: World): string[] {
  let names = fleetNames.get(world);
  if (!names) {
    names = [];
    for (let r = 0; r < world.fleet.size; r++) names.push(fleetHostname(world, r));
    fleetNames.set(world, names);
  }
  return [...world.infra.map((n) => n.hostname), ...names];
}

/** Host profiles a search could touch, filtered by any host= constraint before profiles are built. */
export function candidateHosts(world: World, pd: Pushdown): HostProfile[] {
  const hostPats = pd.fields.has('host') || pd.fields.has('host|or');
  const out: HostProfile[] = [];
  for (const name of allHostnames(world)) {
    // Syslog relays stay candidates: their events carry the device's name as host (host_segment).
    if (hostPats && !allowed(pd, 'host', name) && !name.includes('-syslog-')) continue;
    const p = resolveHost(world, name);
    if (p) out.push(p);
  }
  return out;
}

/** Was the event at time t delivered to an indexer by now? */
export function delivered(tl: Timeline, t: number): boolean {
  const s = tl.stateAt(t);
  if (s === OFFLINE) return false;
  if (s !== BLOCKED) return true;
  return tl.transitions.some((tr) => tr.from === BLOCKED && tr.time > t);
}

/** Which indexer stored a host's event at time t (built once per host per scan). */
function indexerFor(world: World, p: HostProfile): (t: number) => string {
  if (p.role === 'indexer') return () => p.hostname;
  const site = world.infra.find((n) => n.role === 'indexer' && n.site === p.site)?.hostname ?? 'idx01';
  let fwd: ((t: number) => string | null) | null = null;
  return (t) => {
    if (p.fleetRow === undefined) return site;
    fwd ??= receivingIndexer(world, p);
    return fwd(t)?.replace(/\..*$/, '') ?? site;
  };
}

export interface ScanLimits {
  maxScan: number;
  maxMs: number;
}

export interface ScanStats {
  scanned: number;
  hosts: number;
  sources: number;
  truncated: false | 'scan' | 'time';
}

/**
 * Generates and filters events for (earliest, latest]. Calls onRow for each event passing `filter`;
 * returning false from onRow stops the scan.
 */
export function scanEvents(
  ctx: RunContext,
  pd: Pushdown,
  filter: (row: Row) => boolean,
  onRow: (row: Row) => boolean | void,
  limits: ScanLimits,
  clock: () => number,
): ScanStats {
  const { world, earliest, latest } = ctx;
  const stats: ScanStats = { scanned: 0, hosts: 0, sources: 0, truncated: false };
  const started = clock();
  const wantData = INDEXES.some((i) => !i.startsWith('_') && indexAllowed(pd, i));
  const tokens = pd.tokens;

  for (const p of candidateHosts(world, pd)) {
    const sources = hostSources(world, p, wantData).filter(
      (s) =>
        indexAllowed(pd, s.index) &&
        allowed(pd, 'sourcetype', s.sourcetype) &&
        allowed(pd, 'source', s.source) &&
        allowed(pd, 'host', s.host ?? p.hostname),
    );
    if (!sources.length) continue;
    const tl = hostTimeline(world, p, earliest);
    const states = statesIn(tl, earliest, latest);
    const serverAt = indexerFor(world, p);
    let touched = false;
    for (const s of sources) {
      // Gate pushdown: skip sources that cannot contain a required word given this host's states.
      if (
        s.log.gate &&
        tokens.some((tok) => {
          const mask = s.log.gate!(tok);
          return mask !== null && (mask & states) === 0;
        })
      )
        continue;
      touched = true;
      stats.sources++;
      const entries = s.log.entries(earliest, latest);
      stats.scanned += entries.length;
      for (const [t, raw] of entries) {
        if (p.fleetRow !== undefined && !delivered(tl, t)) continue;
        const ev: SplEvent = {
          time: t,
          raw,
          host: s.host ?? p.hostname,
          source: s.source,
          sourcetype: s.sourcetype,
          index: s.index,
          splunk_server: () => serverAt(t),
        };
        const row = new Row(ev);
        if (filter(row) && onRow(row) === false) return stats;
      }
      if (stats.scanned > limits.maxScan) {
        stats.truncated = 'scan';
        return stats;
      }
      if (clock() - started > limits.maxMs) {
        stats.truncated = 'time';
        return stats;
      }
    }
    if (touched) stats.hosts++;
  }
  return stats;
}
