import { BLOCKED, HEALTHY, OFFLINE, STALE, WRONG_CLASS } from '../fleet/tables';
import { throughputKBps } from '../fleet/health';
import { CLASS_INPUTS, CLASS_LOG_FILE, classSourcetypes, NIX_INPUTS } from '../hosts/apps';
import { DOMAIN, buildFor, splunkVersion, type HostProfile } from '../hosts/profile';
import { NO_CLASS, rowOutputs, targetStatus, parsingQueueBlocked, parsingQueueKB } from '../derive/state';
import { hashString, mix32, unit } from '../rng';
import type { World } from '../world';
import { isoTs, splunkTs, syslogTs } from './format';

/** One log event: its time and raw text (multi-line for Windows events). */
export type Entry = [time: number, raw: string];

/**
 * A log whose content is a pure function of the world and a time range. The same generator answers
 * `cat`, `tail -f` and searches, so the terminal and search can never disagree.
 */
export interface LogSource {
  /** How much history a full read of the file shows. */
  windowMs: number;
  /** Events with timestamps in (t0, t1], oldest first. */
  entries(t0: number, t1: number): Entry[];
  /** File view: the raw text of entries, split into lines. */
  lines(t0: number, t1: number): string[];
  /**
   * Search pushdown: for a lowercase search token, a bitmask of health states (1 << state) in which
   * this source can produce it, or null if it can appear any time. Lets a fleet-wide search for
   * "blocked" skip hosts that were never blocked, without changing the results.
   */
  gate?(token: string): number | null;
}

function source(
  windowMs: number,
  entries: (t0: number, t1: number) => Entry[],
  gate?: LogSource['gate'],
): LogSource {
  return {
    windowMs,
    entries,
    lines: (t0, t1) => entries(t0, t1).flatMap((e) => e[1].split('\n')),
    gate,
  };
}

/** Calls fn for every t = phase + k*period with t0 < t <= t1. */
function periodic(
  t0: number,
  t1: number,
  period: number,
  phase: number,
  fn: (t: number, k: number) => void,
): void {
  let k = Math.floor((t0 - phase) / period) + 1;
  for (let t = phase + k * period; t <= t1; k++, t = phase + k * period) fn(t, k);
}

export interface Timeline {
  stateAt(t: number): number;
  transitions: { time: number; from: number; to: number }[];
}

export function hostTimeline(world: World, p: HostProfile, t0: number): Timeline {
  if (p.fleetRow === undefined) {
    // Infrastructure nodes: up unless the user stopped splunkd; transitions come from service events.
    const events = (world.hosts.services.get(p.hostname)?.events ?? []).filter((e) => e.kind !== 'reload');
    const transitions = events
      .filter((e) => e.time > t0)
      .map((e) => ({
        time: e.time,
        from: e.kind === 'stop' ? HEALTHY : OFFLINE,
        to: e.kind === 'stop' ? OFFLINE : HEALTHY,
      }));
    return {
      transitions,
      stateAt(t) {
        const last = events.filter((e) => e.time <= t).at(-1);
        return last?.kind === 'stop' ? OFFLINE : HEALTHY;
      },
    };
  }
  return world.history.timeline(p.fleetRow, t0, world.fleet.health[p.fleetRow]!);
}

/** Bitmask of the states a host was in at any point in (t0, t1]. */
export function statesIn(tl: Timeline, t0: number, t1: number): number {
  let mask = 1 << tl.stateAt(t0);
  for (const tr of tl.transitions) if (tr.time > t0 && tr.time <= t1) mask |= (1 << tr.from) | (1 << tr.to);
  return mask;
}

const bit = (...states: number[]) => states.reduce((m, s) => m | (1 << s), 0);

const tid = (p: HostProfile, salt: number) => 1000 + (mix32(p.hash, salt) % 60000);

interface Target {
  name: string;
  ip: string | null;
  port: number;
  reachable: boolean;
}

/** The forwarder's running output group and servers, from the derived (running) config. */
function forwarderTarget(world: World, p: HostProfile) {
  const cls = world.config.serverClasses[world.fleet.serverClass[p.fleetRow!]!]!;
  const out = rowOutputs(world, p.fleetRow!);
  const targets: Target[] = out.servers.map((s) => {
    const t = targetStatus(world, s);
    return { name: s.split(':')[0]!, ip: t.host?.ip ?? null, port: t.port, reachable: t.reachable };
  });
  const live = targets.filter((t) => t.reachable);
  return { cls, group: out.groups[0] ?? 'default-autolb-group', targets, live };
}

/** The server a healthy forwarder is connected to during 30 s period k (autoLB rotates). */
function connected(f: ReturnType<typeof forwarderTarget>, p: HostProfile, k: number): Target | null {
  const pool = f.live.length ? f.live : f.targets.filter((t) => t.ip);
  return pool.length ? pool[(k + (p.hash & 1)) % pool.length]! : null;
}

/** For a forwarder: the indexer that receives its event at time t (the splunk_server field). */
export function receivingIndexer(world: World, p: HostProfile): (t: number) => string | null {
  if (p.fleetRow === undefined) return () => null;
  const fwd = forwarderTarget(world, p);
  return (t) => connected(fwd, p, Math.floor((t - (p.hash % 30_000)) / 30_000))?.name ?? null;
}

/** Time of the forwarder's last metrics.log batch at or before t (they come every 30 s). */
export function lastMetricsTime(p: HostProfile, t: number): number {
  const phase = mix32(p.hash, 0x33) % 30_000;
  return Math.floor((t - phase) / 30_000) * 30_000 + phase;
}

function startupLines(world: World, p: HostProfile, t: number): string[] {
  const v = splunkVersion(world, p)!;
  const ts = splunkTs(t);
  return [
    `${ts} INFO  loader [${tid(p, 1)} MainThread] - Splunkd starting (build ${buildFor(v)}).`,
    `${ts} INFO  loader [${tid(p, 1)} MainThread] - System info: Linux, ${p.hostname}, ${p.distro.kernel}, #1 SMP PREEMPT_DYNAMIC, x86_64.`,
    `${ts} INFO  loader [${tid(p, 1)} MainThread] - Detected ${p.cpus} (virtual) CPUs, ${p.cpus} CPU cores, and ${p.memMB}MB RAM`,
    `${ts} INFO  ServerConfig [${tid(p, 1)} MainThread] - My GUID is ${p.splunk!.guid}`,
  ];
}

function shutdownLines(p: HostProfile, t: number): string[] {
  const ts = splunkTs(t);
  return [
    `${ts} INFO  ShutdownHandler [${tid(p, 2)} Shutdown] - Shutting down splunkd`,
    `${ts} INFO  ShutdownHandler [${tid(p, 2)} Shutdown] - shutting down level "ShutdownLevel_Begin"`,
    `${ts} INFO  ShutdownHandler [${tid(p, 2)} Shutdown] - shutting down level "ShutdownLevel_Tailing"`,
    `${ts} INFO  ShutdownHandler [${tid(p, 2)} Shutdown] - shutting down level "ShutdownLevel_TcpOutput"`,
    `${ts} INFO  loader [${tid(p, 1)} MainThread] - Shutdown complete.`,
  ];
}

type Injected = World['scenarios']['injected'][number];

function hasInjected(world: World, p: HostProfile, file: Injected['file']): boolean {
  return world.scenarios.injected.some((r) => r.host === p.hostname && r.file === file);
}

/** Red-herring lines from open incidents: every N minutes from the incident start until its ticket closes. */
function injectedEntries(
  world: World,
  p: HostProfile,
  file: Injected['file'],
  t0: number,
  t1: number,
  format: (t: number, r: Injected) => string,
): Entry[] {
  const out: Entry[] = [];
  for (const r of world.scenarios.injected) {
    if (r.host !== p.hostname || r.file !== file) continue;
    const until = world.scenarios.tickets.find((t) => t.id === r.ticketId)?.closedAt ?? Infinity;
    const period = r.everyMinutes * 60_000;
    periodic(Math.max(t0, r.from), Math.min(t1, until), period, (r.from + 7_000) % period, (t) =>
      out.push([t, format(t, r)]),
    );
  }
  return out;
}

const byTime = (entries: Entry[]) => entries.sort((a, b) => a[0] - b[0]);

const ms = (p: HostProfile, t: number, salt: number) => mix32(p.hash, Math.floor(t / 1000), salt) % 1000;

/** Words that only appear in a forwarder's splunkd.log while it is in particular states. */
const FORWARDER_SPLUNKD_GATES: Record<string, number> = {
  blocked: bit(BLOCKED),
  blocked_seconds: bit(BLOCKED),
  paused: bit(BLOCKED),
  autoloadbalancedconnectionstrategy: bit(BLOCKED),
  cooked: bit(BLOCKED),
  resolve: bit(BLOCKED),
  tailreader: bit(BLOCKED),
  error: bit(BLOCKED),
  warn: bit(BLOCKED, STALE),
  httppubsubconnection: bit(STALE),
  pubsubsvr: bit(STALE),
  phonehome: bit(STALE),
  not_connected: bit(STALE),
  shutdownhandler: bit(OFFLINE),
  shutting: bit(OFFLINE),
  loader: bit(OFFLINE),
  deployedapplication: bit(WRONG_CLASS),
  installing: bit(WRONG_CLASS),
  removing: bit(WRONG_CLASS),
};

export function splunkdLog(world: World, p: HostProfile): LogSource {
  const entries = (t0: number, t1: number): Entry[] => {
    const out: Entry[] = [];
    const tl = hostTimeline(world, p, t0);
    const push = (t: number, line: string) => out.push([t, `${splunkTs(t)} ${line}`]);

    for (const tr of tl.transitions) {
      if (tr.time <= t0 || tr.time > t1) continue;
      if (tr.to === OFFLINE) shutdownLines(p, tr.time).forEach((l) => out.push([tr.time, l]));
      if (tr.from === OFFLINE) startupLines(world, p, tr.time).forEach((l) => out.push([tr.time, l]));
      if (tr.to === WRONG_CLASS && p.fleetRow !== undefined) {
        const assignedIdx = world.fleet.assignedClass[p.fleetRow]!;
        const thread = `${tid(p, 3)} HttpClientPollingThread_${p.splunk!.guid}`;
        if (assignedIdx === NO_CLASS) {
          const own = CLASS_INPUTS[world.config.serverClasses[world.fleet.serverClass[p.fleetRow]!]!.id]!.app;
          push(
            tr.time + 2000,
            `INFO  DeployedApplication [${thread}] - Removing app=${own} at='${p.splunk!.home}/etc/apps/${own}'`,
          );
          continue;
        }
        const assigned = world.config.serverClasses[assignedIdx]!;
        const app = CLASS_INPUTS[assigned.id]!.app;
        push(
          tr.time + 2000,
          `INFO  DeployedApplication [${thread}] - Checksum mismatch 0 <> ${mix32(p.hash, tr.time) % 99999} for app=${app}. Will reload from='ds01.${DOMAIN}:8089/services/streams/deployment?name=default:${assigned.id}:${app}'`,
        );
        push(
          tr.time + 2400,
          `INFO  DeployedApplication [${thread}] - Installing app=${app} to='${p.splunk!.home}/etc/apps/${app}'`,
        );
      }
    }

    for (const e of world.hosts.services.get(p.hostname)?.events ?? []) {
      if (e.kind !== 'reload' || e.time <= t0 || e.time > t1) continue;
      const thread = `${tid(p, 9)} TcpChannelThread`;
      push(
        e.time,
        `INFO  DeploymentServer [${thread}] - Reload requested (splunk reload deploy-server${e.detail ? ` -class ${e.detail}` : ''}); re-reading serverclass.conf and ${p.splunk!.home}/etc/deployment-apps`,
      );
      for (const [cls, n] of Object.entries(e.matches ?? {}))
        push(
          e.time + 1,
          `INFO  DeploymentServer [${thread}] - serverClass=${cls} matches ${n} client${n === 1 ? '' : 's'}`,
        );
    }

    if (p.fleetRow !== undefined) forwarderSplunkd(world, p, tl, t0, t1, push);
    else enterpriseSplunkd(world, p, tl, t0, t1, push);
    out.push(
      ...injectedEntries(
        world,
        p,
        'splunkd',
        t0,
        t1,
        (t, r) =>
          `${splunkTs(t)} ${r.level.padEnd(5)} ${r.component} [${tid(p, 11)} ${r.component}Thread] - ${r.message}`,
      ),
    );
    return byTime(out);
  };
  // Injected red-herring lines can contain any word, so gating is off for hosts that have them.
  const gate =
    p.fleetRow === undefined
      ? undefined
      : (token: string) =>
          hasInjected(world, p, 'splunkd') ? null : (FORWARDER_SPLUNKD_GATES[token] ?? null);
  return source(6 * 3_600_000, entries, gate);
}

function forwarderSplunkd(
  world: World,
  p: HostProfile,
  tl: Timeline,
  t0: number,
  t1: number,
  push: (t: number, line: string) => void,
): void {
  const fwd = forwarderTarget(world, p);
  const { group } = fwd;
  const phase = p.hash % 30_000;

  periodic(t0, t1, 30_000, phase, (t, k) => {
    const state = tl.stateAt(t);
    if (state === OFFLINE) return;
    const target = connected(fwd, p, k);
    if (state === BLOCKED) {
      const since = tl.transitions.filter((x) => x.to === BLOCKED && x.time <= t).at(-1)?.time;
      const secs = since === undefined ? 30 + (k % 50) * 30 : Math.round((t - since) / 1000);
      // When the running outputs can't reach anything, say why for each configured server.
      if (!fwd.live.length) {
        if (!fwd.targets.length)
          push(
            t - 300,
            `WARN  TcpOutputProc [${tid(p, 4)} TcpOutEloop] - No servers are configured for the default output group; events will queue until outputs.conf is fixed.`,
          );
        for (const tg of fwd.targets)
          push(
            t - 200,
            tg.ip
              ? `WARN  AutoLoadBalancedConnectionStrategy [${tid(p, 4)} TcpOutEloop] - Cooked connection to ip=${tg.ip}:${tg.port} timed out`
              : `ERROR TcpOutputProc [${tid(p, 4)} TcpOutEloop] - Unable to resolve host='${tg.name}'; skipping server ${tg.name}:${tg.port}`,
          );
      }
      push(
        t,
        `WARN  TcpOutputProc [${tid(p, 4)} TcpOutEloop] - The TCP output processor has paused the data flow. Forwarding to host_dest=${target?.ip ?? fwd.targets[0]?.name ?? 'none'} inside output group ${group} from host_src=${p.hostname} has been blocked for blocked_seconds=${secs}. This can stall the data flow towards indexing and other network outputs. Review the receiving system's health in the Splunk Monitoring Console. It is probably not accepting data.`,
      );
      push(
        t + 150,
        `WARN  TailReader [${tid(p, 5)} tailreader0] - Could not send data to output queue (parsingQueue), retrying...`,
      );
    } else if (target) {
      push(
        t + ms(p, t, 1),
        `INFO  TcpOutputProc [${tid(p, 4)} TcpOutEloop] - Found currently active indexer. Connected to idx=${target.ip}:${target.port}:0, reuse=1.`,
      );
    }
  });

  periodic(t0, t1, world.config.phoneHomeIntervalMs, p.hash % world.config.phoneHomeIntervalMs, (t) => {
    if (tl.stateAt(t) !== STALE) return;
    push(
      t,
      `WARN  HttpPubSubConnection [${tid(p, 6)} HttpClientPollingThread_${p.splunk!.guid}] - Unable to parse message from PubSubSvr: `,
    );
    push(
      t + 5,
      `INFO  DC:DeploymentClient [${tid(p, 6)} PhonehomeThread] - channel=deploymentServer/phoneHome/default Will retry sending phonehome to DS; err=not_connected`,
    );
  });

  // Ordinary noise: file rotation picked up by the tailing processor.
  const files = ['/var/log/messages', '/var/log/secure', ...monitoredPaths(world, p)];
  periodic(t0, t1, 60_000, p.hash % 60_000, (t, k) => {
    const st = tl.stateAt(t);
    if (st === OFFLINE || st === BLOCKED) return;
    if (unit(p.hash, k, 0x11) < 0.03) {
      const f = files[mix32(p.hash, k) % files.length]!;
      push(
        t,
        `INFO  WatchedFile [${tid(p, 5)} tailreader0] - Will begin reading at offset=0 for file='${f}'.`,
      );
    }
  });
}

function monitoredPaths(world: World, p: HostProfile): string[] {
  const assigned = world.fleet.assignedClass[p.fleetRow!]!;
  if (assigned === NO_CLASS) return [];
  const file = CLASS_LOG_FILE[world.config.serverClasses[assigned]!.id];
  return file ? [file] : [];
}

function enterpriseSplunkd(
  world: World,
  p: HostProfile,
  tl: Timeline,
  t0: number,
  t1: number,
  push: (t: number, line: string) => void,
): void {
  const role = p.role;
  periodic(t0, t1, 60_000, p.hash % 60_000, (t, k) => {
    if (tl.stateAt(t) === OFFLINE) return;
    const r = unit(p.hash, k, 0x21);
    if (role === 'indexer') {
      const site = world.config.sites.find((s) => s.id === p.site)!;
      const src = `10.${site.subnet}.${64 + (mix32(p.hash, k) % 120)}.${mix32(p.hash, k, 2) % 250}`;
      if (r < 0.35)
        push(
          t + ms(p, t, 2),
          `INFO  TcpInputProc [${tid(p, 7)} FwdDataReceiverThread] - Connection in cooked mode from src=${src}:${40000 + (mix32(p.hash, k, 3) % 20000)}`,
        );
      if (unit(p.hash, k, 0x22) < 0.06) {
        const idx = ['os', 'app', 'network', 'main'][mix32(p.hash, k, 4) % 4]!;
        const n = 100 + (k % 900);
        push(
          t + ms(p, t, 3),
          `INFO  HotBucketRoller [${tid(p, 8)} indexerPipe_0] - finished moving hot to warm bucket=/opt/splunk/var/lib/splunk/${idx}/db/hot_v1_${n} idx=${idx} from=hot_v1_${n} to=db_${Math.floor(t / 1000)}_${Math.floor(t / 1000) - 86_000}_${n}_${p.splunk!.guid} size=786432000 caller=size_exceeded _maxHotBucketSize=786432000 (750MB), bucketSize=786436096 (750MB)`,
        );
      }
    } else if (role === 'deployment_server') {
      if (r < 0.25) {
        const row = mix32(p.hash, k, 5) % world.fleet.size;
        push(
          t + ms(p, t, 4),
          `INFO  ClientSessionsManager [${tid(p, 9)} TcpChannelThread] - Adding client: ip=10.${world.config.sites[world.fleet.site[row]!]!.subnet}.${((row + 16384) >> 8) & 255}.${(row + 16384) & 255} uts=linux-x86_64 id=connection_${row}_8089 name=${row.toString(16).toUpperCase()}`,
        );
      }
      if (unit(p.hash, k, 0x23) < 0.02)
        push(
          t + 400,
          `INFO  DeploymentMetrics [${tid(p, 9)} DeploymentMetricsThread] - num_clients=${world.fleet.size} num_apps=${world.config.serverClasses.length + 7}`,
        );
    } else if (r < 0.1) {
      push(
        t + ms(p, t, 5),
        `INFO  TailReader [${tid(p, 5)} tailreader0] - Batch input finished reading file='/opt/splunk/var/spool/splunk/tracker.log'`,
      );
    }
  });
}

export function metricsLog(world: World, p: HostProfile): LogSource {
  const entries = (t0: number, t1: number): Entry[] => {
    const out: Entry[] = [];
    const tl = hostTimeline(world, p, t0);
    const phase = mix32(p.hash, 0x33) % 30_000;
    const fwd = p.fleetRow !== undefined ? forwarderTarget(world, p) : null;
    periodic(t0, t1, 30_000, phase, (t, k) => {
      const state = tl.stateAt(t);
      if (state === OFFLINE) return;
      const pre = `${splunkTs(t)} INFO  Metrics - `;
      const push = (l: string) => out.push([t, pre + l]);
      if (fwd) forwarderMetrics(world, p, fwd, t, k, state, push);
      else enterpriseMetrics(world, p, t, k, push);
    });
    return out;
  };
  // Metrics lines are always INFO, and only blocked queues say "blocked".
  const gate = (token: string) =>
    token === 'warn' || token === 'error'
      ? 0
      : token === 'blocked' && p.fleetRow !== undefined
        ? bit(BLOCKED)
        : null;
  return source(2 * 3_600_000, entries, gate);
}

function queueLine(name: string, maxKb: number, fill: number, blocked: boolean): string {
  const kb = Math.round(maxKb * fill);
  const n = Math.round(kb * 3.1);
  return `group=queue, name=${name}, ${blocked ? 'blocked=true, ' : ''}max_size_kb=${maxKb}, current_size_kb=${kb}, current_size=${n}, largest_size=${Math.max(n, Math.round(n * 1.3) + 1)}, smallest_size=0`;
}

function forwarderMetrics(
  world: World,
  p: HostProfile,
  fwd: ReturnType<typeof forwarderTarget>,
  t: number,
  k: number,
  state: number,
  push: (l: string) => void,
) {
  const row = p.fleetRow!;
  const { cls, group } = fwd;
  const blocked = state === BLOCKED;
  const kbps = throughputKBps(world, row, t, state);
  const eps = Math.round(kbps * 4.2 * 10) / 10;
  const uptimeS = Math.max(1, (t - p.bootTime) / 1000);
  const fill = blocked ? 1 : unit(p.hash, k, 0x41) * 0.08;
  push(
    `group=thruput, name=thruput, instantaneous_kbps=${kbps.toFixed(3)}, instantaneous_eps=${eps.toFixed(3)}, average_kbps=${(cls.baseThroughputKBps * 0.98).toFixed(3)}, total_k_processed=${Math.round(cls.baseThroughputKBps * uptimeS)}, kb=${(kbps * 30).toFixed(3)}, ev=${Math.round(eps * 30)}, load_average=${(unit(p.hash, k, 0x42) * 1.5).toFixed(2)}`,
  );
  push(queueLine('parsingqueue', 512, fill, blocked));
  push(queueLine(`tcpout_${group}`, 500, fill, blocked));
  const target = connected(fwd, p, k);
  if (!blocked && target) {
    push(
      `group=tcpout_connections, name=${group}:${target.ip}:${target.port}:0, sourcePort=${40000 + (p.hash % 20000)}, destIp=${target.ip}, destPort=${target.port}, _tcp_Bps=${Math.round(kbps * 1024)}, _tcp_KBps=${kbps.toFixed(2)}, _tcp_avg_thruput=${(cls.baseThroughputKBps * 0.98).toFixed(2)}, _tcp_Kprocessed=${Math.round(kbps * 30)}, _tcp_eps=${(eps / 4).toFixed(2)}, kb=${(kbps * 30).toFixed(2)}`,
    );
  }
  const assigned = world.fleet.assignedClass[row]!;
  const sts =
    assigned === NO_CLASS
      ? NIX_INPUTS.map((i) => i.sourcetype)
      : classSourcetypes(world.config.serverClasses[assigned]!.id, cls.os);
  sts.forEach((st, i) => {
    const share = i === 0 ? 0.7 : 0.3 / Math.max(1, sts.length - 1);
    const sk = kbps * share;
    push(
      `group=per_sourcetype_thruput, series="${st}", kbps=${sk.toFixed(3)}, eps=${(eps * share).toFixed(3)}, kb=${(sk * 30).toFixed(3)}, ev=${Math.round(eps * share * 30)}, avg_age=${(unit(p.hash, k, i) * 2).toFixed(3)}, max_age=${1 + (mix32(p.hash, k, i) % 4)}`,
    );
  });
}

function enterpriseMetrics(world: World, p: HostProfile, t: number, k: number, push: (l: string) => void) {
  const isIdx = p.role === 'indexer';
  const queues = isIdx
    ? ['parsingqueue', 'aggqueue', 'typingqueue', 'indexqueue']
    : ['parsingqueue', 'aggqueue'];
  for (const [i, q] of queues.entries())
    push(
      queueLine(
        q,
        isIdx ? parsingQueueKB(world, p, t) : 512,
        parsingQueueBlocked(world, p, t) ? 1 : unit(p.hash, k, 0x50 + i) * 0.12,
        parsingQueueBlocked(world, p, t),
      ),
    );
  if (isIdx) {
    const kbps = parsingQueueBlocked(world, p, t) ? 0 : 2400 + unit(p.hash, k, 0x55) * 1200;
    push(
      `group=thruput, name=index_thruput, instantaneous_kbps=${kbps.toFixed(3)}, instantaneous_eps=${(kbps * 3.8).toFixed(3)}, average_kbps=3000.000, total_k_processed=${Math.round(3000 * ((t - p.bootTime) / 1000))}, kb=${(kbps * 30).toFixed(3)}, ev=${Math.round(kbps * 3.8 * 30)}, load_average=${(4 + unit(p.hash, k, 0x56) * 6).toFixed(2)}`,
    );
  } else {
    push(
      `group=thruput, name=thruput, instantaneous_kbps=${(2 + unit(p.hash, k, 0x57) * 3).toFixed(3)}, load_average=${(unit(p.hash, k, 0x58) * 2).toFixed(2)}`,
    );
  }
}

/** /var/log/messages: cron, sessions, time sync. */
export function messagesLog(world: World, p: HostProfile): LogSource {
  return source(24 * 3_600_000, (t0, t1) => {
    const out: Entry[] = [];
    periodic(t0, t1, 3_600_000, 61_000, (t) =>
      out.push([
        t,
        `${syslogTs(t)} ${p.hostname} CROND[${10000 + (mix32(p.hash, t) % 50000)}]: (root) CMD (run-parts /etc/cron.hourly)`,
      ]),
    );
    periodic(t0, t1, 60_000, p.hash % 60_000, (t, k) => {
      const r = unit(p.hash, k, 0x61);
      if (r < 0.03)
        out.push([
          t,
          `${syslogTs(t)} ${p.hostname} chronyd[812]: Selected source 10.10.0.2 (ntp1.${DOMAIN})`,
        ]);
      else if (r < 0.06)
        out.push([
          t,
          `${syslogTs(t)} ${p.hostname} systemd[1]: Started Session ${1000 + (k % 9000)} of User root.`,
        ]);
      else if (r < 0.07) out.push([t, `${syslogTs(t)} ${p.hostname} systemd[1]: Starting dnf makecache...`]);
    });
    out.push(
      ...injectedEntries(
        world,
        p,
        'messages',
        t0,
        t1,
        (t, r) =>
          `${syslogTs(t)} ${p.hostname} ${r.component}[${2000 + (mix32(p.hash, 0x17) % 30000)}]: ${r.message}`,
      ),
    );
    return byTime(out);
  });
}

/** /var/log/secure: sshd noise from the bastion and the occasional scanner. */
export function secureLog(world: World, p: HostProfile): LogSource {
  void world;
  return source(24 * 3_600_000, (t0, t1) => {
    const out: Entry[] = [];
    periodic(t0, t1, 60_000, (p.hash >> 3) % 60_000, (t, k) => {
      const r = unit(p.hash, k, 0x71);
      const pid = 20000 + (mix32(p.hash, k) % 40000);
      if (r < 0.02) {
        out.push([
          t,
          `${syslogTs(t)} ${p.hostname} sshd[${pid}]: Accepted publickey for splunk from 10.10.0.5 port ${40000 + (k % 20000)} ssh2: ED25519 SHA256:q1R0bVv8f0+5mKjv9ZtFv2rXl3c`,
        ]);
        out.push([
          t,
          `${syslogTs(t)} ${p.hostname} sshd[${pid}]: pam_unix(sshd:session): session opened for user splunk(uid=1001) by (uid=0)`,
        ]);
      } else if (r < 0.03) {
        out.push([
          t,
          `${syslogTs(t)} ${p.hostname} sshd[${pid}]: Connection closed by authenticating user root 10.99.4.17 port ${50000 + (k % 9000)} [preauth]`,
        ]);
      }
    });
    return out;
  });
}

/** Application log for the class's monitored input (app, nginx, mysql, syslog relay): one event per 30 s. */
export function appLog(world: World, p: HostProfile, classId: string): LogSource {
  void world;
  const salt = hashString(classId);
  return source(2 * 3_600_000, (t0, t1) => {
    const out: Entry[] = [];
    // Events are emitted at t + jitter; walk one extra period back so jittered events near t0 are kept.
    periodic(t0 - 30_000, t1, 30_000, p.hash % 30_000, (t, k) => {
      const r = unit(p.hash, k, salt);
      const n = mix32(p.hash, k, salt);
      const t2 = t + (n % 30_000);
      if (t2 <= t0 || t2 > t1) return;
      if (classId === 'linux_app') {
        const level = r < 0.03 ? 'ERROR' : r < 0.1 ? 'WARN ' : 'INFO ';
        const msg =
          level === 'ERROR'
            ? `c.example.orders.PaymentClient - Payment gateway timeout after 3000ms orderId=${n % 900000}`
            : level === 'WARN '
              ? `c.example.orders.InventoryCache - Cache miss ratio high: ${(0.3 + r).toFixed(2)}`
              : `c.example.orders.OrderController - GET /api/orders/${n % 900000} 200 ${12 + (n % 80)}ms`;
        out.push([t2, `${isoTs(t2)} ${level} [http-nio-8080-exec-${1 + (n % 12)}] ${msg}`]);
      } else if (classId === 'linux_web') {
        const status = r < 0.02 ? 502 : r < 0.06 ? 404 : 200;
        out.push([
          t2,
          `10.${(n >> 8) & 255}.${n & 255}.${(n >> 16) & 255} - - [${accessTs(t2)}] "GET /shop/item/${n % 5000} HTTP/1.1" ${status} ${200 + (n % 9000)} "-" "Mozilla/5.0"`,
        ]);
      } else if (classId === 'linux_db') {
        if (r < 0.3)
          out.push([
            t2,
            `${isoTs(t2)} ${n % 900} [Note] [MY-010914] [Server] Aborted connection ${n % 99999} to db: 'orders' user: 'app' host: '10.10.70.${n % 250}' (Got timeout reading communication packets).`,
          ]);
      } else {
        out.push([
          t2,
          `${syslogTs(t2)} edge-fw01 %ASA-6-302013: Built inbound TCP connection ${n} for outside:203.0.113.${n % 250}/443 to inside:10.10.70.${(n >> 4) % 250}/${1024 + (n % 60000)}`,
        ]);
      }
    });
    return byTime(out);
  });
}

/** Apache/nginx access log time: 23/Oct/2026:08:00:21 +0000 */
function accessTs(t: number): string {
  const d = new Date(t);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())}/${M}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

/** Windows Security/System events for Windows forwarders (multi-line, as WinEventLog renders them). */
export function winEventLog(
  world: World,
  p: HostProfile,
  logName: 'Security' | 'System' | 'Application' | 'Directory Service',
): LogSource {
  void world;
  const salt = hashString(logName);
  const period = logName === 'Security' ? 120_000 : 600_000;
  return source(24 * 3_600_000, (t0, t1) => {
    const out: Entry[] = [];
    periodic(t0, t1, period, mix32(p.hash, salt) % period, (t, k) => {
      const n = mix32(p.hash, k, salt);
      const [code, category, message, type] =
        logName === 'Security'
          ? n % 10 === 0
            ? ['4625', 'Logon', 'An account failed to log on.', 'Audit Failure']
            : ['4624', 'Logon', 'An account was successfully logged on.', 'Audit Success']
          : logName === 'System'
            ? ['7036', 'None', 'The Windows Update service entered the running state.', 'Information']
            : logName === 'Directory Service'
              ? [
                  '1644',
                  'Field Engineering',
                  'Internal event: A client issued a search operation.',
                  'Information',
                ]
              : ['1000', 'None', 'Application started.', 'Information'];
      const d = new Date(t);
      const h12 = d.getUTCHours() % 12 || 12;
      const stamp = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()} ${String(h12).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
      out.push([
        t,
        [
          stamp,
          `LogName=${logName}`,
          `EventCode=${code}`,
          `EventType=0`,
          `ComputerName=${p.fqdn}`,
          `SourceName=${logName === 'Security' ? 'Microsoft Windows security auditing.' : 'Service Control Manager'}`,
          `Type=${type}`,
          `RecordNumber=${1_000_000 + k}`,
          `Keywords=${type}`,
          `TaskCategory=${category}`,
          `OpCode=Info`,
          `Message=${message}`,
        ].join('\n'),
      ]);
    });
    return out;
  });
}

/** Static-ish logs that only get a few lines: splunkd-utility.log, audit.log, health.log. */
export function smallLog(world: World, p: HostProfile, kind: 'utility' | 'audit' | 'health'): LogSource {
  void world;
  return source(7 * 86_400_000, (t0, t1) => {
    const boot = p.bootTime + 45_000;
    const out: Entry[] = [];
    if (kind === 'utility' && boot > t0 && boot <= t1)
      out.push([
        boot,
        `${splunkTs(boot)} INFO  ServerConfig - Found no hostname options in server.conf. Will attempt to use default for now.`,
      ]);
    if (kind === 'audit')
      periodic(t0, t1, 3_600_000, p.hash % 3_600_000, (t) =>
        out.push([
          t,
          `${splunkTs(t)} Audit:[timestamp=${splunkTs(t)}, user=splunk-system-user, action=search, info=granted ][n/a]`,
        ]),
      );
    if (kind === 'health')
      periodic(t0, t1, 600_000, p.hash % 600_000, (t) =>
        out.push([
          t,
          `${splunkTs(t)} INFO  PeriodicHealthReporter - feature="TailReader-0" color=green due_to_stanza="feature:batchreader" node_type=feature node_path=splunkd.file_monitor_input.tailreader-0`,
        ]),
      );
    return out;
  });
}
