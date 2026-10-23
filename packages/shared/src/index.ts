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
  'indexer' | 'search_head' | 'deployment_server' | 'cluster_manager' | 'license_manager' | 'heavy_forwarder';

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

// ---------------------------------------------------------------- search (milestone 4)

export type ResultValue = string | number | null | string[];

export interface SearchRequestDto {
  search: string;
  earliest: string;
  latest: string;
}

export interface SearchEventDto {
  /** Epoch seconds. */
  time: number;
  raw: string;
  host: string;
  source: string;
  sourcetype: string;
  index: string;
  fields: Record<string, ResultValue>;
}

export interface FieldSummaryDto {
  name: string;
  count: number;
  distinct: number;
  numeric: boolean;
  top: { value: string; count: number }[];
}

export interface SearchMessageDto {
  type: 'info' | 'warn' | 'error';
  text: string;
}

export interface SearchJobDto {
  sid: string;
  search: string;
  /** Epoch ms of the resolved time range. */
  earliest: number;
  latest: number;
  status: 'done' | 'failed';
  kind: 'events' | 'statistics';
  eventCount: number;
  resultCount: number;
  scanCount: number;
  hostsScanned: number;
  truncated: boolean;
  runMs: number;
  messages: SearchMessageDto[];
  timeline: { time: number; count: number }[];
  timelineSpanMs: number;
  fields: FieldSummaryDto[];
  columns: string[];
  phases: { name: string; ms: number; rows: number }[];
}

export interface PageDto<T> {
  offset: number;
  total: number;
  items: T[];
}

export interface ScenarioDto {
  id: string;
  title: string;
  topics: string[];
  difficulty: 'easy' | 'medium' | 'hard';
}
export interface TicketDto {
  id: string;
  scenarioId: string;
  title: string;
  requester: string;
  persona: string;
  urgency: 'low' | 'medium' | 'high';
  text: string;
  openedAt: number;
  fixedAt?: number;
  closedAt?: number;
  status: 'open' | 'recovering' | 'resolved' | 'closed';
  resolutionNote?: string;
  /** The incident's fix checks have failed at least once (the symptom really appeared). */
  symptomSeen?: boolean;
}

// ---------------------------------------------------------------- Monitoring Console

export const MC_VIEWS = ['indexing', 'forwarders', 'license', 'scheduler'] as const;
export type McView = (typeof MC_VIEWS)[number];

export interface McStatDto {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
  hint?: string;
}

/** One dashboard panel: an SPL search run on the server (or a fleet query), with the SPL to open it in Search. */
export interface McPanelDto {
  id: string;
  title: string;
  /** line/area: a timechart (first column _time); table: rows as-is. */
  chart: 'line' | 'area' | 'table';
  unit?: string;
  search: string;
  earliest: string;
  latest: string;
  columns: string[];
  rows: Record<string, ResultValue>[];
  messages: SearchMessageDto[];
  /** Shown when there are no rows. */
  empty?: string;
}

export interface McViewDto {
  view: McView;
  generatedAt: number;
  stats: McStatDto[];
  panels: McPanelDto[];
}

// ---------------------------------------------------------------- Forwarder Management

export interface DsClientDto {
  hostname: string;
  ip: string;
  os: OsFamily;
  build: string;
  lastPhoneHome: number;
  health: HealthState;
  serverClasses: string[];
  apps: string[];
}

export interface DsServerClassDto {
  name: string;
  whitelist: string[];
  blacklist: string[];
  apps: string[];
  clients: number;
}

export interface DsAppDto {
  name: string;
  serverClasses: string[];
  clients: number;
  /** Whether a change saved on disk is waiting for `splunk reload deploy-server`. */
  pendingReload: boolean;
}

export interface DsOverviewDto {
  server: string;
  phoneHomeIntervalSeconds: number;
  totalClients: number;
  /** Clients that match no server class (so receive no apps). */
  unmatchedClients: number;
  serverClasses: DsServerClassDto[];
  apps: DsAppDto[];
}
