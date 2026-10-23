// Types shared by the server and the web UI. Keep this file free of runtime dependencies.

export const HEALTH_STATES = [
  'healthy',
  'stale_phonehome',
  'blocked_queue',
  'offline',
  'version_drift',
  'wrong_serverclass',
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export type UnhealthyState = Exclude<HealthState, 'healthy'>;

export const HEALTH_LABELS: Record<HealthState, string> = {
  healthy: 'Healthy',
  stale_phonehome: 'Stale phone-home',
  blocked_queue: 'Blocked queue',
  offline: 'Offline',
  version_drift: 'Version drift',
  wrong_serverclass: 'Wrong server class',
};

export type OsFamily = 'windows' | 'linux';

export type DeploymentClientStatus = 'connected' | 'not_phoning_home' | 'mismatched';

export interface ForwarderRecord {
  hostname: string;
  ip: string;
  os: OsFamily;
  site: string;
  serverClass: string;
  /** The server class the deployment server actually maps this client to. */
  assignedServerClass: string;
  version: string;
  outputGroup: string;
  health: HealthState;
  healthSince: number;
  deploymentClientStatus: DeploymentClientStatus;
  lastPhoneHome: number;
  queueFillPct: number;
  throughputKBps: number;
}

export interface FleetFilter {
  site?: string;
  serverClass?: string;
  health?: HealthState;
  os?: OsFamily;
  /** Case-insensitive hostname substring. */
  q?: string;
}

export type HealthCounts = Record<HealthState, number>;

export interface GroupSummary {
  id: string;
  name: string;
  total: number;
  byHealth: HealthCounts;
}

export interface FleetSummary {
  at: number;
  total: number;
  byHealth: HealthCounts;
  bySite: GroupSummary[];
  byServerClass: GroupSummary[];
}

export type HostSortKey = 'hostname' | 'lastPhoneHome' | 'health' | 'site';

export interface HostPage {
  total: number;
  offset: number;
  limit: number;
  rows: ForwarderRecord[];
}

export type InfraRole =
  | 'indexer'
  | 'search_head'
  | 'deployment_server'
  | 'cluster_manager'
  | 'license_manager'
  | 'heavy_forwarder';

export interface InfraNodeInfo {
  hostname: string;
  role: InfraRole;
  site: string;
  ip: string;
  status: 'up' | 'down' | 'restarting';
}

export interface WorldInfo {
  seed: string;
  fleetSize: number;
  now: number;
  tick: number;
  tickMs: number;
  speed: number;
  paused: boolean;
  sites: { id: string; name: string }[];
  serverClasses: { id: string; os: OsFamily }[];
  infra: InfraNodeInfo[];
}

export const CLOCK_SPEEDS = [1, 5, 30] as const;
export type ClockSpeed = (typeof CLOCK_SPEEDS)[number];
