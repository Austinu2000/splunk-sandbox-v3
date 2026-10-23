import { BLOCKED, HEALTHY, OFFLINE, STALE, WRONG_CLASS } from '../fleet/tables';
import { throughputKBps } from '../fleet/health';
import {
  appsForClient,
  CLASS_INPUTS,
  CLASS_LOG_FILE,
  classSourcetypes,
  outputGroupName,
} from '../hosts/apps';
import { DOMAIN, buildFor, outputTargets, splunkVersion, type HostProfile } from '../hosts/profile';
import { hashString, mix32, unit } from '../rng';
import type { World } from '../world';
import { isoTs, splunkTs, syslogTs } from './format';

/**
 * A log file whose content is a pure function of the world and a time range.
 * The same generator answers `cat`, `tail -f` and, from milestone 4, searches.
 */
export interface LogSource {
  /** How much history a full read of the file shows. */
  windowMs: number;
  /** Lines with timestamps in (t0, t1], oldest first. */
  lines(t0: number, t1: number): string[];
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

interface Timeline {
  stateAt(t: number): number;
  transitions: { time: number; from: number; to: number }[];
}

function hostTimeline(world: World, p: HostProfile, t0: number): Timeline {
  if (p.fleetRow === undefined) {
    const s = p.infra?.status === 'up' || !p.infra ? HEALTHY : OFFLINE;
    return { stateAt: () => s, transitions: [] };
  }
  return world.history.timeline(p.fleetRow, t0, world.fleet.health[p.fleetRow]!);
}

const tid = (p: HostProfile, salt: number) => 1000 + (mix32(p.hash, salt) % 60000);

function forwarderTarget(world: World, p: HostProfile) {
  const cls = world.config.serverClasses[world.fleet.serverClass[p.fleetRow!]!]!;
  const kind = cls.outputs;
  const targets = outputTargets(world, p.site, kind);
  return { cls, group: outputGroupName(p.site, kind), targets };
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

/** Merges per-generator arrays of [time, line] and returns lines in time order. */
function sorted(entries: [number, string][]): string[] {
  return entries.sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

const ms = (p: HostProfile, t: number, salt: number) => mix32(p.hash, Math.floor(t / 1000), salt) % 1000;

export function splunkdLog(world: World, p: HostProfile): LogSource {
  return {
    windowMs: 6 * 3_600_000,
    lines(t0, t1) {
      const out: [number, string][] = [];
      const tl = hostTimeline(world, p, t0);
      const push = (t: number, line: string) => out.push([t, `${splunkTs(t)} ${line}`]);

      for (const tr of tl.transitions) {
        if (tr.time <= t0 || tr.time > t1) continue;
        if (tr.to === OFFLINE) shutdownLines(p, tr.time).forEach((l) => out.push([tr.time, l]));
        if (tr.from === OFFLINE) startupLines(world, p, tr.time).forEach((l) => out.push([tr.time, l]));
        if (tr.to === WRONG_CLASS && p.fleetRow !== undefined) {
          const assigned = world.config.serverClasses[world.fleet.assignedClass[p.fleetRow]!]!;
          const app = CLASS_INPUTS[assigned.id]!.app;
          push(
            tr.time + 2000,
            `INFO  DeployedApplication [${tid(p, 3)} HttpClientPollingThread_${p.splunk!.guid}] - Checksum mismatch 0 <> ${mix32(p.hash, tr.time) % 99999} for app=${app}. Will reload from='ds01.${DOMAIN}:8089/services/streams/deployment?name=default:${assigned.id}:${app}'`,
          );
          push(
            tr.time + 2400,
            `INFO  DeployedApplication [${tid(p, 3)} HttpClientPollingThread_${p.splunk!.guid}] - Installing app=${app} to='${p.splunk!.home}/etc/apps/${app}'`,
          );
        }
      }

      if (p.fleetRow !== undefined) forwarderSplunkd(world, p, tl, t0, t1, push);
      else enterpriseSplunkd(world, p, t0, t1, push);
      return sorted(out);
    },
  };
}

function forwarderSplunkd(
  world: World,
  p: HostProfile,
  tl: Timeline,
  t0: number,
  t1: number,
  push: (t: number, line: string) => void,
): void {
  const { group, targets } = forwarderTarget(world, p);
  const phase = p.hash % 30_000;

  periodic(t0, t1, 30_000, phase, (t, k) => {
    const state = tl.stateAt(t);
    if (state === OFFLINE) return;
    const target = targets[(k + (p.hash & 1)) % targets.length]!;
    if (state === BLOCKED) {
      const since = tl.transitions.filter((x) => x.to === BLOCKED && x.time <= t).at(-1)?.time;
      const secs = since === undefined ? 30 + (k % 50) * 30 : Math.round((t - since) / 1000);
      push(
        t,
        `WARN  TcpOutputProc [${tid(p, 4)} TcpOutEloop] - The TCP output processor has paused the data flow. Forwarding to host_dest=${target.ip} inside output group ${group} from host_src=${p.hostname} has been blocked for blocked_seconds=${secs}. This can stall the data flow towards indexing and other network outputs. Review the receiving system's health in the Splunk Monitoring Console. It is probably not accepting data.`,
      );
      push(
        t + 150,
        `WARN  TailReader [${tid(p, 5)} tailreader0] - Could not send data to output queue (parsingQueue), retrying...`,
      );
    } else {
      push(
        t + ms(p, t, 1),
        `INFO  TcpOutputProc [${tid(p, 4)} TcpOutEloop] - Found currently active indexer. Connected to idx=${target.ip}:9997:0, reuse=1.`,
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
  const file = CLASS_LOG_FILE[world.config.serverClasses[world.fleet.assignedClass[p.fleetRow!]!]!.id];
  return file ? [file] : [];
}

function enterpriseSplunkd(
  world: World,
  p: HostProfile,
  t0: number,
  t1: number,
  push: (t: number, line: string) => void,
): void {
  const role = p.role;
  periodic(t0, t1, 60_000, p.hash % 60_000, (t, k) => {
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
  return {
    windowMs: 2 * 3_600_000,
    lines(t0, t1) {
      const out: string[] = [];
      const tl = hostTimeline(world, p, t0);
      const phase = mix32(p.hash, 0x33) % 30_000;
      periodic(t0, t1, 30_000, phase, (t, k) => {
        const state = tl.stateAt(t);
        if (state === OFFLINE) return;
        const pre = `${splunkTs(t)} INFO  Metrics - `;
        if (p.fleetRow !== undefined) forwarderMetrics(world, p, t, k, state, (l) => out.push(pre + l));
        else enterpriseMetrics(p, t, k, (l) => out.push(pre + l));
      });
      return out;
    },
  };
}

function queueLine(name: string, maxKb: number, fill: number, blocked: boolean): string {
  const kb = Math.round(maxKb * fill);
  const n = Math.round(kb * 3.1);
  return `group=queue, name=${name}, ${blocked ? 'blocked=true, ' : ''}max_size_kb=${maxKb}, current_size_kb=${kb}, current_size=${n}, largest_size=${Math.max(n, Math.round(n * 1.3) + 1)}, smallest_size=0`;
}

function forwarderMetrics(
  world: World,
  p: HostProfile,
  t: number,
  k: number,
  state: number,
  push: (l: string) => void,
) {
  const row = p.fleetRow!;
  const { cls, group, targets } = forwarderTarget(world, p);
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
  if (!blocked) {
    const target = targets[(k + (p.hash & 1)) % targets.length]!;
    push(
      `group=tcpout_connections, name=${group}:${target.ip}:9997:0, sourcePort=${40000 + (p.hash % 20000)}, destIp=${target.ip}, destPort=9997, _tcp_Bps=${Math.round(kbps * 1024)}, _tcp_KBps=${kbps.toFixed(2)}, _tcp_avg_thruput=${(cls.baseThroughputKBps * 0.98).toFixed(2)}, _tcp_Kprocessed=${Math.round(kbps * 30)}, _tcp_eps=${(eps / 4).toFixed(2)}, kb=${(kbps * 30).toFixed(2)}`,
    );
  }
  const sts = classSourcetypes(world.config.serverClasses[world.fleet.assignedClass[row]!]!.id, cls.os);
  sts.forEach((st, i) => {
    const share = i === 0 ? 0.7 : 0.3 / Math.max(1, sts.length - 1);
    const sk = kbps * share;
    push(
      `group=per_sourcetype_thruput, series="${st}", kbps=${sk.toFixed(3)}, eps=${(eps * share).toFixed(3)}, kb=${(sk * 30).toFixed(3)}, ev=${Math.round(eps * share * 30)}, avg_age=${(unit(p.hash, k, i) * 2).toFixed(3)}, max_age=${1 + (mix32(p.hash, k, i) % 4)}`,
    );
  });
}

function enterpriseMetrics(p: HostProfile, t: number, k: number, push: (l: string) => void) {
  const isIdx = p.role === 'indexer';
  const queues = isIdx
    ? ['parsingqueue', 'aggqueue', 'typingqueue', 'indexqueue']
    : ['parsingqueue', 'aggqueue'];
  for (const [i, q] of queues.entries())
    push(queueLine(q, isIdx ? 6144 : 512, unit(p.hash, k, 0x50 + i) * 0.12, false));
  if (isIdx) {
    const kbps = 2400 + unit(p.hash, k, 0x55) * 1200;
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
  void world;
  return {
    windowMs: 24 * 3_600_000,
    lines(t0, t1) {
      const out: string[] = [];
      periodic(t0, t1, 3_600_000, 61_000, (t) =>
        out.push(
          `${syslogTs(t)} ${p.hostname} CROND[${10000 + (mix32(p.hash, t) % 50000)}]: (root) CMD (run-parts /etc/cron.hourly)`,
        ),
      );
      periodic(t0, t1, 60_000, p.hash % 60_000, (t, k) => {
        const r = unit(p.hash, k, 0x61);
        if (r < 0.03)
          out.push(`${syslogTs(t)} ${p.hostname} chronyd[812]: Selected source 10.10.0.2 (ntp1.${DOMAIN})`);
        else if (r < 0.06)
          out.push(
            `${syslogTs(t)} ${p.hostname} systemd[1]: Started Session ${1000 + (k % 9000)} of User root.`,
          );
        else if (r < 0.07) out.push(`${syslogTs(t)} ${p.hostname} systemd[1]: Starting dnf makecache...`);
      });
      return out.sort((a, b) => a.localeCompare(b));
    },
  };
}

/** /var/log/secure: sshd noise from the bastion and the occasional scanner. */
export function secureLog(world: World, p: HostProfile): LogSource {
  void world;
  return {
    windowMs: 24 * 3_600_000,
    lines(t0, t1) {
      const out: string[] = [];
      periodic(t0, t1, 60_000, (p.hash >> 3) % 60_000, (t, k) => {
        const r = unit(p.hash, k, 0x71);
        const pid = 20000 + (mix32(p.hash, k) % 40000);
        if (r < 0.02) {
          out.push(
            `${syslogTs(t)} ${p.hostname} sshd[${pid}]: Accepted publickey for splunk from 10.10.0.5 port ${40000 + (k % 20000)} ssh2: ED25519 SHA256:q1R0bVv8f0+5mKjv9ZtFv2rXl3c`,
          );
          out.push(
            `${syslogTs(t)} ${p.hostname} sshd[${pid}]: pam_unix(sshd:session): session opened for user splunk(uid=1001) by (uid=0)`,
          );
        } else if (r < 0.03) {
          out.push(
            `${syslogTs(t)} ${p.hostname} sshd[${pid}]: Connection closed by authenticating user root 10.99.4.17 port ${50000 + (k % 9000)} [preauth]`,
          );
        }
      });
      return out;
    },
  };
}

/** Application log for the class's monitored input (app, nginx, mysql, syslog relay). */
export function appLog(world: World, p: HostProfile, classId: string): LogSource {
  void world;
  const salt = hashString(classId);
  return {
    windowMs: 2 * 3_600_000,
    lines(t0, t1) {
      const out: string[] = [];
      periodic(t0, t1, 5_000, p.hash % 5_000, (t, k) => {
        const r = unit(p.hash, k, salt);
        const n = mix32(p.hash, k, salt);
        const t2 = t + (n % 5000);
        if (classId === 'linux_app') {
          const level = r < 0.02 ? 'ERROR' : r < 0.08 ? 'WARN ' : 'INFO ';
          const msg =
            level === 'ERROR'
              ? `c.example.orders.PaymentClient - Payment gateway timeout after 3000ms orderId=${n % 900000}`
              : level === 'WARN '
                ? `c.example.orders.InventoryCache - Cache miss ratio high: ${(0.3 + r).toFixed(2)}`
                : `c.example.orders.OrderController - GET /api/orders/${n % 900000} 200 ${12 + (n % 80)}ms`;
          out.push(`${isoTs(t2)} ${level} [http-nio-8080-exec-${1 + (n % 12)}] ${msg}`);
        } else if (classId === 'linux_web') {
          const status = r < 0.02 ? 502 : r < 0.06 ? 404 : 200;
          out.push(
            `10.${(n >> 8) & 255}.${n & 255}.${(n >> 16) & 255} - - [${new Date(t2).toUTCString()}] "GET /shop/item/${n % 5000} HTTP/1.1" ${status} ${200 + (n % 9000)} "-" "Mozilla/5.0"`,
          );
        } else if (classId === 'linux_db') {
          if (r < 0.2)
            out.push(
              `${isoTs(t2)} ${n % 900} [Note] [MY-010914] [Server] Aborted connection ${n % 99999} to db: 'orders' user: 'app' host: '10.10.70.${n % 250}' (Got timeout reading communication packets).`,
            );
        } else {
          out.push(
            `${syslogTs(t2)} edge-fw01 %ASA-6-302013: Built inbound TCP connection ${n} for outside:203.0.113.${n % 250}/443 to inside:10.10.70.${(n >> 4) % 250}/${1024 + (n % 60000)}`,
          );
        }
      });
      return out;
    },
  };
}

/** Static-ish logs that only get a few lines: splunkd-utility.log, audit.log, health.log. */
export function smallLog(world: World, p: HostProfile, kind: 'utility' | 'audit' | 'health'): LogSource {
  return {
    windowMs: 7 * 86_400_000,
    lines(t0, t1) {
      const boot = p.bootTime + 45_000;
      const out: string[] = [];
      if (kind === 'utility' && boot > t0 && boot <= t1)
        out.push(
          `${splunkTs(boot)} INFO  ServerConfig - Found no hostname options in server.conf. Will attempt to use default for now.`,
        );
      if (kind === 'audit')
        periodic(t0, t1, 3_600_000, p.hash % 3_600_000, (t) =>
          out.push(
            `${splunkTs(t)} Audit:[timestamp=${splunkTs(t)}, user=splunk-system-user, action=search, info=granted ][n/a]`,
          ),
        );
      if (kind === 'health')
        periodic(t0, t1, 600_000, p.hash % 600_000, (t) =>
          out.push(
            `${splunkTs(t)} INFO  PeriodicHealthReporter - feature="TailReader-0" color=green due_to_stanza="feature:batchreader" node_type=feature node_path=splunkd.file_monitor_input.tailreader-0`,
          ),
        );
      void world;
      return out;
    },
  };
}

/** Apps deployed on a forwarder right now, from its assigned server class. */
export function deployedApps(world: World, p: HostProfile): string[] {
  if (p.fleetRow === undefined) return [];
  const cls = world.config.serverClasses[world.fleet.assignedClass[p.fleetRow]!]!;
  return appsForClient(world, p.site, cls.id);
}
